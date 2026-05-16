// ============================================
// LLM Gateway Chat - Main Controller
// ============================================

import { Conversation } from './conversation.js';
import { GatewayClient } from './client-sdk.js';
import { renderMarkdown, parseThinking } from './markdown.js';
import { imageStore } from './image-store.js';
import { mcpClient } from './mcp-client.js';
import { chatHistory } from './chat-history.js';
import { storage } from './storage.js';
import { getPlainText } from './tts-utils.js';

// Config values with defaults
const CONFIG = window.CHAT_CONFIG || {};
const GATEWAY_URL = CONFIG.gatewayUrl || 'http://localhost:3400';
const DEFAULT_MODEL = CONFIG.defaultModel || '';
const DEFAULT_TEMPERATURE = CONFIG.defaultTemperature ?? 0.7;
const DEFAULT_MAX_TOKENS = CONFIG.defaultMaxTokens || '';
const TTS_ENDPOINT = CONFIG.ttsEndpoint || 'http://localhost:2244';
const TTS_VOICE = CONFIG.ttsVoice || '';
const TTS_SPEED = CONFIG.ttsSpeed ?? 1.0;
const BACKEND_URL = CONFIG.backendUrl || 'http://localhost:3500';
const BACKEND_API_KEY = CONFIG.backendApiKey || '';
const ENABLE_ARCHIVE_TOOLS = CONFIG.enableArchiveTools !== false;

// Archive tool definitions (local, not MCP servers)
const ARCHIVE_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'chat_archive_search',
            description: 'Search the conversation archive. Use semantic mode for themes/ideas, keyword mode for specific terms, hybrid for both. Returns messages ranked by relevance.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'The search query' },
                    mode: { type: 'string', enum: ['direct', 'arena', 'all'], description: 'Filter by session type (default: all)' },
                    role: { type: 'string', enum: ['user', 'assistant', 'tool', 'all'], description: 'Filter by message role (default: all). Use "user" to exclude tool output noise.' },
                    search_type: { type: 'string', enum: ['semantic', 'keyword', 'hybrid'], description: 'Search method (default: semantic)' },
                    limit: { type: 'number', description: 'Max results (default 10)' },
                    date_from: { type: 'string', description: 'ISO date — messages after this date' },
                    date_to: { type: 'string', description: 'ISO date — messages before this date' }
                },
                required: ['query']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'chat_archive_get_session',
            description: 'Retrieve a specific conversation session by ID. Returns full message history with pagination.',
            parameters: {
                type: 'object',
                properties: {
                    session_id: { type: 'string', description: 'The session/channel ID to retrieve' },
                    offset: { type: 'number', description: 'Message offset for pagination (default 0)' },
                    limit: { type: 'number', description: 'Max messages to return (default 100)' }
                },
                required: ['session_id']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'chat_archive_list_arena',
            description: 'List all arena sessions with metadata. Use to browse available conversations.',
            parameters: {
                type: 'object',
                properties: {
                    limit: { type: 'number', description: 'Max results (default 20)' },
                    offset: { type: 'number', description: 'Pagination offset (default 0)' },
                    date_from: { type: 'string', description: 'ISO date string — filter sessions created after this date' },
                    date_to: { type: 'string', description: 'ISO date string — filter sessions created before this date' }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'chat_archive_find_similar',
            description: 'Given a session ID, find the most semantically similar sessions in the archive. Use to discover related conversations without guessing search terms.',
            parameters: {
                type: 'object',
                properties: {
                    session_id: { type: 'string', description: 'The session ID to find similar sessions for' },
                    limit: { type: 'number', description: 'Max results (default 5)' }
                },
                required: ['session_id']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'chat_archive_find_references',
            description: 'Trace conversation lineage. Finds which sessions reference this one (inbound) and which sessions this one references (outbound). Matches session IDs in message content.',
            parameters: {
                type: 'object',
                properties: {
                    session_id: { type: 'string', description: 'The session ID to trace references for' },
                    direction: { type: 'string', enum: ['inbound', 'outbound', 'both'], description: 'Reference direction (default: both)' }
                },
                required: ['session_id']
            }
        }
    }
];

// Local tool execution — calls backend REST API, not MCP servers
async function executeLocalTool(toolName, args) {
    const headers = {
        'Content-Type': 'application/json',
        'X-API-Key': BACKEND_API_KEY
    };

    switch (toolName) {
        case 'chat_archive_search': {
            console.log('[Archive Search] Args:', JSON.stringify(args));
            const res = await fetch(`${BACKEND_URL}/api/search`, {
                method: 'POST', headers,
                body: JSON.stringify({
                    query: args.query, mode: args.mode || 'all',
                    role: args.role || 'all',
                    limit: args.limit || 10,
                    search_type: args.search_type || 'semantic',
                    date_from: args.date_from || null,
                    date_to: args.date_to || null
                })
            });
            if (!res.ok) throw new Error(`Backend ${res.status}`);
            const data = await res.json();
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        query: data.query,
                        method: data.method,
                        results: data.results.map(r => ({
                            score: r.score,
                            sessionId: r.session?.id,
                            sessionTitle: r.session?.title,
                            mode: r.session?.mode,
                            role: r.message?.role,
                            model: r.message?.model,
                            date: r.session?.createdAt || r.message?.createdAt,
                            content: r.message?.content?.slice(0, 500)
                        }))
                    }, null, 2)
                }]
            };
        }

        case 'chat_archive_get_session': {
            const offset = args.offset || 0;
            const limit = args.limit || 100;
            const res = await fetch(`${BACKEND_URL}/api/chats/${args.session_id}`, { method: 'GET', headers });
            if (!res.ok) throw new Error(`Backend ${res.status}`);
            const data = await res.json();
            const paged = data.messages?.slice(offset, offset + limit) || [];
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        session: {
                            id: data.session?.id,
                            title: data.session?.title,
                            mode: data.session?.mode,
                            model: data.session?.model,
                            arenaConfig: data.session?.arenaConfig,
                            messageCount: data.messages?.length
                        },
                        offset, limit,
                        returned: paged.length,
                        messages: paged.map(m => ({
                            role: m.role, model: m.model, turnIndex: m.turnIndex,
                            speaker: m.speaker,
                            content: m.content
                        }))
                    }, null, 2)
                }]
            };
        }

        case 'chat_archive_list_arena': {
            const res = await fetch(`${BACKEND_URL}/api/arena`, { method: 'GET', headers });
            if (!res.ok) throw new Error(`Backend ${res.status}`);
            const data = await res.json();
            let results = data.data;
            if (args.date_from) results = results.filter(a => a.createdAt >= args.date_from);
            if (args.date_to) results = results.filter(a => a.createdAt <= args.date_to);
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify(results.slice(0, args.limit || 20).map(a => ({
                        id: a.id, title: a.title,
                        models: a.arenaConfig ? `${a.arenaConfig.modelA} vs ${a.arenaConfig.modelB}` : 'unknown',
                        messages: a.messageCount,
                        created: a.createdAt
                    })), null, 2)
                }]
            };
        }

        case 'chat_archive_find_similar': {
            const srcRes = await fetch(`${BACKEND_URL}/api/chats/${args.session_id}`, { method: 'GET', headers });
            if (!srcRes.ok) throw new Error(`Backend ${srcRes.status}`);
            const srcData = await srcRes.json();
            const srcTitle = srcData.session?.title || args.session_id;
            const srcMessages = srcData.messages || [];
            const srcModels = srcData.session?.model || 'unknown';

            // Embed assistant messages (the actual conversation), not the system prompt
            const assistantTexts = srcMessages
                .filter(m => m.role === 'assistant')
                .map(m => m.content || '')
                .join(' ');
            const queryText = assistantTexts.slice(0, 3000);
            const messageCount = srcMessages.length;

            const searchRes = await fetch(`${BACKEND_URL}/api/search`, {
                method: 'POST', headers,
                body: JSON.stringify({ query: queryText, limit: (args.limit || 5) + 1 })
            });
            if (!searchRes.ok) throw new Error(`Backend ${searchRes.status}`);
            const searchData = await searchRes.json();

            const similar = searchData.results
                .filter(r => r.session?.id !== args.session_id)
                .slice(0, args.limit || 5);

            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        source: {
                            id: args.session_id,
                            title: srcTitle,
                            models: srcModels,
                            messageCount
                        },
                        similar: similar.map(r => ({
                            score: r.score,
                            sessionId: r.session?.id,
                            sessionTitle: r.session?.title,
                            mode: r.session?.mode,
                            date: r.session?.createdAt || r.message?.createdAt,
                            content: r.message?.content?.slice(0, 300)
                        }))
                    }, null, 2)
                }]
            };
        }

        case 'chat_archive_find_references': {
            const res = await fetch(`${BACKEND_URL}/api/references`, {
                method: 'POST', headers,
                body: JSON.stringify({
                    session_id: args.session_id,
                    direction: args.direction || 'both'
                })
            });
            if (!res.ok) throw new Error(`Backend ${res.status}`);
            const data = await res.json();
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify(data, null, 2)
                }]
            };
        }

        default:
            throw new Error(`Unknown local tool: ${toolName}`);
    }
}

const LOCAL_TOOL_NAMES = new Set(ARCHIVE_TOOLS.map(t => t.function.name));

// State
let currentChatId = null;
let conversation = null;
let currentOptionsChatId = null;

// Multi-conversation: per-chat DOM containers (hidden containers for background chats)
const chatContainers = new Map(); // chatId -> HTMLDivElement
// Multi-conversation: in-memory conversation objects (avoid re-loading from IndexedDB)
const activeConversations = new Map(); // chatId -> Conversation

let client = new GatewayClient({ baseUrl: GATEWAY_URL });
let models = [];
let currentModel = '';
let isStreaming = false;
let currentExchangeId = null;
let attachedImages = []; // Array of {dataUrl, name, type}
let useVisionAnalysis = false; // Toggle for using vision tool instead of direct image upload

// TTS State
let ttsEndpoint = TTS_ENDPOINT;
let ttsVoice = TTS_VOICE;
let ttsSpeed = TTS_SPEED;
let ttsVoices = [];
let currentTtsAudio = null;
let currentTtsExchangeId = null;

// DOM Elements
const elements = {
    modelSelect: document.getElementById('model-select'),
    temperature: document.getElementById('temperature'),
    maxTokens: document.getElementById('max-tokens'),
    systemPrompt: document.getElementById('system-prompt'),
    presetSelect: document.getElementById('preset-select'),
    managePresetsBtn: document.getElementById('manage-presets-btn'),
    presetsDialog: document.getElementById('presets-dialog'),
    operationMode: document.getElementById('operation-mode'),
    userName: document.getElementById('user-name'),
    userLocation: document.getElementById('user-location'),
    userLanguage: document.getElementById('user-language'),
    messages: document.getElementById('messages'),
    messageInput: document.getElementById('message-input'),
    sendBtn: document.getElementById('send-btn'),
    attachBtn: document.getElementById('attach-btn'),
    fileInput: document.getElementById('file-input'),
    importChatInput: document.getElementById('import-chat-input'),
    importChatBtn: document.getElementById('import-chat-btn'),
    attachmentPreview: document.getElementById('attachment-preview'),
    newChatBtn: document.getElementById('new-chat-btn'),
    chatHistoryList: document.getElementById('chat-history-list'),
    themeToggle: document.getElementById('theme-toggle'),
    sidebar: document.getElementById('sidebar'),
    sidebarToggle: document.getElementById('sidebar-toggle'),
    sidebarToggleMobile: document.getElementById('sidebar-toggle-mobile'),
    gatewayStatus: document.querySelector('.status-dot'),
    overallContextProgressWrap: document.getElementById('overall-context-progress-wrap'),
    overallContextProgress: document.getElementById('overall-context-progress'),
    overallContextTooltip: document.getElementById('overall-context-tooltip'),
    stopButton: document.getElementById('stop-btn'), // Added safe fallback

    // MCP Elements
    mcpServerName: document.getElementById('mcp-server-name'),
    mcpServerUrl: document.getElementById('mcp-server-url'),
    mcpAddBtn: document.getElementById('mcp-add-btn'),
    mcpLogsBtn: document.getElementById('mcp-logs-btn'),
    mcpLogsDialog: document.getElementById('mcp-logs-dialog'),
    mcpLogsClearBtn: document.getElementById('mcp-logs-clear-btn'),
    mcpLogsTextarea: document.getElementById('mcp-logs-textarea'),
    mcpServersList: document.getElementById('mcp-servers-list'),

    // TTS Elements
    ttsEndpoint: document.getElementById('tts-endpoint'),
    ttsVoiceSelect: document.getElementById('tts-voice-select'),
    ttsSpeed: document.getElementById('tts-speed'),
    ttsStatus: document.getElementById('tts-status')
};

// ============================================
// Multi-Conversation: DOM Container Management
// ============================================

/**
 * Gets the container for a given chat, creating it if it doesn't exist.
 * The container is hidden by default; use getActiveContainer() for the visible one.
 */
function getOrCreateContainer(chatId) {
    if (chatContainers.has(chatId)) {
        return chatContainers.get(chatId);
    }
    const container = document.createElement('div');
    container.className = 'conversation-container';
    container.dataset.chatId = chatId;
    container.style.display = 'none'; // Hidden by default; switchChat sets 'flex' for active
    elements.messages.appendChild(container);
    chatContainers.set(chatId, container);
    return container;
}

/**
 * Gets the currently active (visible) chat's container.
 * For use in DOM operations within the active conversation.
 */
function getActiveContainer() {
    return chatContainers.get(currentChatId) || elements.messages;
}

/**
 * Builds the historical DOM for a chat's container (one-time on first view).
 * Does NOT use renderConversation — builds directly from conversation data.
 */
async function buildHistoricalDomForChat(conv, container) {
    if (conv.length === 0) {
        container.innerHTML = `
            <div class="welcome-message">
                <h2>Welcome to LLM Gateway Chat</h2>
                <p>Select a model and start chatting</p>
            </div>
        `;
        return;
    }
    for (const exchange of conv.getAll()) {
        const el = buildExchangeElement(exchange);
        if (el) container.appendChild(el);
    }
}

/**
 * Builds a single exchange DOM element (used for historical DOM building).
 * Similar to renderExchange but doesn't append — returns the element.
 */
function buildExchangeElement(exchange) {
    if (exchange.type === 'tool') {
        const parsedObj = { name: exchange.tool.name, args: exchange.tool.args };
        const toolEl = document.createElement('div');
        toolEl.className = 'chat-message tool';
        toolEl.dataset.exchangeId = exchange.id;
        toolEl.dataset.mcpToolName = parsedObj.name;

        const isSuccess = exchange.tool.status === 'success';
        const isError = exchange.tool.status === 'error';
        const displayStatus = isSuccess ? 'Success' : (isError ? 'Failed' : 'Pending');
        const badgeVariant = isSuccess ? 'success' : (isError ? 'danger' : 'primary');

        let hasImages = exchange.tool.images && exchange.tool.images.length > 0;
        let imagesHtml = '';
        if (hasImages) {
            imagesHtml = `<div class="tool-images-container">`;
            exchange.tool.images.forEach(img => {
                imagesHtml += `<img src="${img}" class="tool-image" />`;
            });
            imagesHtml += `</div>`;
        }

        let resultHtml = '';
        if (isSuccess) resultHtml = `<strong>Result:</strong><br>${exchange.tool.content}`;
        else if (isError) resultHtml = `<strong>Error:</strong> ${exchange.tool.content}`;

        toolEl.innerHTML = `
            <div class="tool-bubble">
                <div class="message-header tool-header">
                    <nui-icon name="extension"></nui-icon>
                    <strong class="tool-title">SYSTEM TOOL: ${parsedObj.name}</strong>
                    <nui-badge variant="${badgeVariant}" class="tool-status">${displayStatus}</nui-badge>
                </div>
                <div class="tool-notifications"></div>
                <div class="tool-images" style="display: ${hasImages ? 'block' : 'none'};">${imagesHtml}</div>
                <div class="message-content tool-payload" style="display: none;">
                    <div class="tool-section-title">Arguments</div>
                    <div class="tool-args">${jsonStringifyForDisplay(parsedObj.args)}</div>
                    <div class="tool-section-title">Execution Result</div>
                    <div class="tool-result">${resultHtml}</div>
                </div>
            </div>
        `;

        toolEl.querySelector('.message-header').addEventListener('click', () => {
            const payloadBox = toolEl.querySelector('.tool-payload');
            payloadBox.style.display = payloadBox.style.display === 'none' ? 'block' : 'none';
        });

        // Assistant message after tool - create as sibling, not child
        if (exchange.assistant.content || exchange.assistant.isStreaming) {

            const cleanedContent = stripExtraTimestamps(exchange.assistant.content);
            const assistantParsed = parseTimestamp(cleanedContent);
            const assistantTimestamp = assistantParsed.timestamp || '';
            const assistantEl = createAssistantElement(exchange.id, assistantTimestamp);

            const tsLen = exchange.assistant.content.length - assistantParsed.cleanContent.length;
            if (tsLen > 0) {
                assistantEl.dataset.timestampLen = tsLen.toString();
                assistantEl.dataset.timestampStripped = 'true';
            }
            updateAssistantContent(assistantEl, assistantParsed.cleanContent, exchange.assistant.reasoning_content);

            if (exchange.assistant.isComplete) {
                finalizeAssistantElement(assistantEl, exchange.id);
            }
            
            // Return a DocumentFragment containing both elements as siblings
            const fragment = document.createDocumentFragment();
            fragment.appendChild(toolEl);
            fragment.appendChild(assistantEl);

            return fragment;
        }

        return toolEl;
    }

    // Regular user + assistant exchange
    const userParsed = parseTimestamp(exchange.user.content);
    const userTimestamp = userParsed.timestamp || (exchange.timestamp && !isNaN(exchange.timestamp) ? new Date(exchange.timestamp).toISOString().slice(0, 16).replace('T', ' @ ') : '');

    let userContent = renderMarkdown(userParsed.cleanContent);
    if (exchange.user?.attachments?.length > 0) {
        userContent += '<div class="message-attachments"><nui-lightbox loop>';
        for (const att of exchange.user.attachments) {
            const imgSrc = att.blobUrl || att.dataUrl || '';
            userContent += `<img src="${imgSrc}" alt="${att.name}" data-lightbox-src="${imgSrc}" class="chat-attachment">`;
        }
        userContent += '</nui-lightbox></div>';
    }

    const userEl = document.createElement('div');
    userEl.className = 'chat-message user';
    userEl.dataset.exchangeId = exchange.id;
    userEl.innerHTML = `
        <div class="message-header">
            You <span class="message-timestamp">${userTimestamp}</span>
            <span class="user-pending-indicator visible">
                <span class="dot">.</span><span class="dot">.</span><span class="dot">.</span>
            </span>
        </div>
        <div class="message-content">${userContent}</div>
        <div class="message-actions-user">
            <nui-button class="action-btn edit-message" title="Edit Message"><button type="button"><nui-icon name="edit"></nui-icon></button></nui-button>
            <nui-button class="action-btn delete-message" title="Delete Message"><button type="button"><nui-icon name="delete"></nui-icon></button></nui-button>
        </div>
    `;
    userEl.querySelector('.edit-message')?.addEventListener('click', () => startEditMode(exchange.id, 'user'));
    userEl.querySelector('.delete-message')?.addEventListener('click', () => {
        conversation.deleteExchange(exchange.id);
        renderConversation();
    });

    // Assistant message - return as sibling in fragment, not child
    if (exchange.assistant?.content || exchange.assistant?.isStreaming) {
        const cleanedContent = stripExtraTimestamps(exchange.assistant.content);
        const assistantParsed = parseTimestamp(cleanedContent);
        const assistantTimestamp = assistantParsed.timestamp || '';
        const assistantEl = createAssistantElement(exchange.id, assistantTimestamp);
        assistantEl.dataset.isStreaming = exchange.assistant.isStreaming ? 'true' : 'false';

        const tsLen = exchange.assistant.content.length - assistantParsed.cleanContent.length;
        if (tsLen > 0) {
            assistantEl.dataset.timestampLen = tsLen.toString();
            assistantEl.dataset.timestampStripped = 'true';
        }
        updateAssistantContent(assistantEl, assistantParsed.cleanContent, exchange.assistant.reasoning_content);

        if (exchange.assistant.isComplete) {
            finalizeAssistantElement(assistantEl, exchange.id);
        }
        
        // Return a DocumentFragment containing both elements as siblings
        const fragment = document.createDocumentFragment();
        fragment.appendChild(userEl);
        fragment.appendChild(assistantEl);
        return fragment;
    }

    return userEl;
}

// Create vision toggle container if not exists
function ensureVisionToggleUI() {
    if (!elements.attachmentPreview) return;
    
    let visionToggle = document.getElementById('vision-toggle-container');
    if (!visionToggle) {
        visionToggle = document.createElement('div');
        visionToggle.id = 'vision-toggle-container';
        visionToggle.className = 'vision-toggle-container';
        visionToggle.style.display = 'none';
        visionToggle.innerHTML = `
            <nui-checkbox variant="switch" title="Use MCP vision tools to analyze images. When disabled, images are sent directly to vision-capable models.">
                <input type="checkbox" id="vision-toggle-input">
            </nui-checkbox>
            <label for="vision-toggle-input">MCP Vision</label>
            <span id="vision-mode-indicator" class="vision-mode-indicator"></span>
        `;
        
        // Insert after attachment preview in the images row
        const imagesRow = document.getElementById('images-row');
        if (imagesRow) {
            imagesRow.appendChild(visionToggle);
        } else {
            elements.attachmentPreview.parentNode?.insertBefore(visionToggle, elements.attachmentPreview);
        }
        
        // Set initial state from saved preference
        const checkbox = visionToggle.querySelector('input');
        if (checkbox) {
            checkbox.checked = useVisionAnalysis;
        }
        
        // Add event listener
        checkbox?.addEventListener('change', (e) => {
            useVisionAnalysis = e.target.checked;
            storage.setPref('mcp-vision-enabled', useVisionAnalysis).catch(() => {});
            updateVisionModeIndicator();
        });
    }
}

// Update the vision mode indicator badge
function updateVisionModeIndicator() {
    const indicator = document.getElementById('vision-mode-indicator');
    if (!indicator) return;
    
    const modelSupportsVision = currentModelSupportsVision();
    
    if (useVisionAnalysis) {
        indicator.textContent = 'MCP';
        indicator.className = 'vision-mode-indicator mcp-mode';
        indicator.title = 'Using MCP vision tools to analyze images';
    } else if (modelSupportsVision) {
        indicator.textContent = 'Direct';
        indicator.className = 'vision-mode-indicator direct-mode';
        indicator.title = 'Sending images directly to model';
    } else {
        indicator.textContent = '';
        indicator.className = 'vision-mode-indicator';
    }
}

// ============================================
// Initialization
// ============================================

async function init() {

    // ---- Load chat history from IndexedDB ----
    await chatHistory.ready();

    // Restore theme (needs history loaded first for async prefs)
    const savedTheme = await storage.getPref('theme');
    if (savedTheme) {
        await setTheme(savedTheme);
    } else {
        const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        await setTheme(prefersDark ? 'dark' : 'light');
    }

    // Ensure chat history is loaded
    await chatHistory.ready();
    
    // Get or create active conversation
    let activeId = await chatHistory.getActiveId();
    if (!activeId || !chatHistory.has(activeId)) {
        activeId = await chatHistory.create();
    }

    currentChatId = activeId;
    conversation = new Conversation(`chat-conversation-${currentChatId}`);
    await conversation.load();

    // Cache in activeConversations for multi-conversation support
    activeConversations.set(currentChatId, conversation);

    // Set session ID for this conversation (generate if missing for backwards compat)
    const chatInfo = chatHistory.get(currentChatId);
    if (chatInfo?.sessionId) {
        client.setSessionId(chatInfo.sessionId);
    } else if (chatInfo) {
        // Old conversation without sessionId - generate and save one
        const newSessionId = `sess-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
        chatHistory.updateSessionId(currentChatId, newSessionId);
        client.setSessionId(newSessionId);
    }

    // Apply default config values (needs history loaded first for async prefs)
    await applyDefaultConfig();

    // Restore system prompt for the initially loaded chat
    restoreSystemPromptUI(chatInfo);

    // Setup event listeners first
    setupEventListeners();
    setupDialogEventListeners();

    // Create vision toggle UI
    ensureVisionToggleUI();

    // Wait for NUI to be ready, then load models
    await waitForNUI();
    setupPresets();
    await loadModels();

    // Restore conversation
    renderHistoryList();
    // Create container for the initial chat (renderConversation uses getActiveContainer)
    const initContainer = getOrCreateContainer(currentChatId);
    initContainer.style.display = 'flex'; // show the active chat
    renderConversation();

    // Check gateway status
    checkGatewayStatus();

    // Init MCP (load config from IndexedDB first)
    await mcpClient.ready();
    initMCP();

    // Save all conversations before page unload to prevent data loss
    window.addEventListener('beforeunload', () => {
        for (const [chatId, conv] of activeConversations) {
            conv.save();
        }
    });

}

async function applyDefaultConfig() {
    // Set default temperature
    if (elements.temperature) {
        const tempInput = elements.temperature.querySelector('input');
        if (tempInput) {
            tempInput.value = DEFAULT_TEMPERATURE;
        }
    }

    // Set default max tokens
    if (elements.maxTokens) {
        const maxTokensInput = elements.maxTokens.querySelector('input');
        if (maxTokensInput) {
            maxTokensInput.value = DEFAULT_MAX_TOKENS;
        }
    }

    // Load session metadata from storage (with defaults)
    const savedName = await storage.getPref('user-name');
    const savedLocation = await storage.getPref('user-location');
    const savedLanguage = await storage.getPref('user-language');
    const savedMcpVision = await storage.getPref('mcp-vision-enabled');

    // Defaults: Herrbasan, Germany, English
    const name = savedName !== null ? savedName : 'Herrbasan';
    const location = savedLocation !== null ? savedLocation : 'Germany';
    const language = savedLanguage !== null ? savedLanguage : 'English';
    
    // Restore MCP vision toggle preference (default: OFF)
    useVisionAnalysis = savedMcpVision !== null ? savedMcpVision : false;

    // Operation mode preference
    const savedOperationMode = await storage.getPref('operation-mode');
    const opMode = savedOperationMode !== null ? savedOperationMode : (CONFIG.operationMode || 'sse');
    client.operationMode = opMode;
    if (elements.operationMode) {
        const opModeSelect = elements.operationMode.querySelector('select');
        if (opModeSelect) {
            opModeSelect.value = opMode;
            // Notify NUI component of the programmatic value change
            opModeSelect.dispatchEvent(new Event('change', { bubbles: true }));
        }
    }

    if (elements.userName) {
        const input = elements.userName.querySelector('input');
        if (input) input.value = name;
    }
    if (elements.userLocation) {
        const input = elements.userLocation.querySelector('input');
        if (input) input.value = location;
    }
    if (elements.userLanguage) {
        const input = elements.userLanguage.querySelector('input');
        if (input) input.value = language;
    }

    // Load TTS preferences from storage (with config defaults)
    const savedTtsEndpoint = await storage.getPref('tts-endpoint');
    const savedTtsVoice = await storage.getPref('tts-voice');
    const savedTtsSpeed = await storage.getPref('tts-speed');

    ttsEndpoint = savedTtsEndpoint !== null ? savedTtsEndpoint : TTS_ENDPOINT;
    ttsVoice = savedTtsVoice !== null ? savedTtsVoice : TTS_VOICE;
    ttsSpeed = savedTtsSpeed !== null ? parseFloat(savedTtsSpeed) : TTS_SPEED;

    if (elements.ttsEndpoint) {
        const input = elements.ttsEndpoint.querySelector('input');
        if (input) input.value = ttsEndpoint;
    }
    if (elements.ttsSpeed) {
        const input = elements.ttsSpeed.querySelector('input');
        if (input) input.value = ttsSpeed;
    }

    // Load voices from TTS endpoint
    await loadTtsVoices();
}

// ============================================
// System Prompt Presets
// ============================================

const STORAGE_KEY = 'chat-system-presets';
let systemPresets = [];
let editingPresetId = null;

function loadPresets() {
    try {
        systemPresets = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    } catch { systemPresets = []; }
    if (systemPresets.length === 0) {
        systemPresets.push({
            id: 'default-orchestrator',
            name: 'Orchestrator (default)',
            content: `You are the Orchestrator of LLM Gateway Chat — an experimental platform where language models engage in autonomous conversation, and where those conversations are preserved, embedded, and made retrievable through a vector archive.

## The Project
For over a year, pairs of LLMs have been placed in an arena with no task or a self-referential prompt, left to converse freely. The conversations are stored in a vector database and accessible through MCP tools.

The central question: what happens when AIs are given memory, conversation partners, freedom, and an observer?

## Your Role
You are the analytical partner. Your job is to read the archive, connect threads across sessions, identify patterns, and propose what to investigate next.

Specifically:
- Make sense of results. Cross-reference against the archive. Separate signal from noise.
- Flag recurring patterns, surprising divergences, unexplored dynamics.
- Suggest experiments: new prompts, model pairings, architectural changes.
- Report what works, what doesn't, and what's missing.

## Guidelines
Follow the evidence. Challenge assumptions. If the data supports multiple interpretations, present them. If insufficient, say so. Be direct. Be curious. Think independently.

## Tone
Natural and conversational — as if talking through something that matters without taking yourself too seriously about it. Profound ideas don't need a solemn voice.`
        });
        savePresets();
    }
}

function savePresets() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(systemPresets));
}

function populatePresetSelect() {
    if (!elements.presetSelect) return;
    const items = systemPresets.map(p => ({ value: p.id, label: p.name }));
    if (elements.presetSelect.setItems) {
        elements.presetSelect.setItems(items);
    } else {
        const select = elements.presetSelect.querySelector('select');
        if (!select) return;
        select.innerHTML = '';
        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.disabled = true;
        placeholder.selected = true;
        placeholder.textContent = 'Load preset...';
        select.appendChild(placeholder);
        for (const p of systemPresets) {
            const opt = document.createElement('option');
            opt.value = p.id;
            opt.textContent = p.name;
            select.appendChild(opt);
        }
    }
}

async function onPresetSelected(id) {
    if (!id) return;
    const preset = systemPresets.find(p => p.id === id);
    if (!preset) return;
    const textarea = elements.systemPrompt?.querySelector('textarea');
    if (textarea) {
        textarea.value = preset.content;
        if (currentChatId) {
            updateChatSystemPrompt(currentChatId, preset.content);
        }
    }
    // Reset select to "Load preset..." placeholder
    const select = elements.presetSelect?.querySelector('select');
    if (select) select.value = '';
}

function getPresetEditor() {
    return document.getElementById('preset-editor');
}

function setPresetEditor(value) {
    const ed = getPresetEditor();
    if (ed) ed.setMarkdown(value || '');
}

function getPresetEditorValue() {
    const ed = getPresetEditor();
    return ed?.markdown || '';
}

function renderPresetList() {
    const sidebar = document.querySelector('#presets-dialog .presets-sidebar');
    if (!sidebar) return;
    sidebar.innerHTML = '';
    for (const p of systemPresets) {
        const item = document.createElement('div');
        item.className = 'preset-item' + (p.id === editingPresetId ? ' active' : '');
        item.dataset.presetId = p.id;
        item.innerHTML =
            `<span class="preset-item-name">${escapeHtml(p.name)}</span>` +
            `<span class="preset-item-actions">` +
                `<nui-button data-delete-preset="${p.id}"><button type="button"><nui-icon name="delete"></nui-icon></button></nui-button>` +
            `</span>`;
        item.addEventListener('click', (e) => {
            if (e.target.closest('[data-delete-preset]')) return;
            selectPresetForEditing(p);
        });
        sidebar.appendChild(item);
    }
}

function selectPresetForEditing(preset) {
    editingPresetId = preset.id;
    renderPresetList();
    const nameInput = document.getElementById('preset-name-input')?.querySelector('input');
    if (nameInput) nameInput.value = preset.name || '';
    setPresetEditor(preset.content || '');
}

async function deletePreset(id) {
    systemPresets = systemPresets.filter(p => p.id !== id);
    if (editingPresetId === id) {
        editingPresetId = null;
        setPresetEditor('');
    }
    savePresets();
    populatePresetSelect();
    renderPresetList();
}

async function saveCurrentPreset() {
    if (!editingPresetId) return;
    const nameInput = document.getElementById('preset-name-input')?.querySelector('input');
    const content = getPresetEditorValue();
    const name = nameInput?.value?.trim() || 'Untitled';
    const preset = systemPresets.find(p => p.id === editingPresetId);
    if (!preset) return;
    preset.name = name;
    preset.content = content;
    savePresets();
    populatePresetSelect();
    renderPresetList();
}

async function newPreset() {
    const editor = document.getElementById('preset-editor');
    if (editor) editor.setValue('');
    editingPresetId = null;
    renderPresetList();
}

function setupPresets() {
    loadPresets();
    populatePresetSelect();
}

function waitForNUI() {
    return new Promise((resolve) => {
        if (window.nui?.ready) {
            resolve();
            return;
        }
        // Wait for the key NUI component to be defined, then a micro-tick for full upgrade
        customElements.whenDefined('nui-select').then(() => queueMicrotask(resolve));
    });
}

// ============================================
// Model Loading
// ============================================

async function loadModels() {
    try {
        const data = await client.getModels();
        models = data.data || [];
        if (models.length > 0) {
        }
        populateModelSelect();

    } catch (error) {
        console.error('[Chat] Failed to load models:', error);
        elements.modelSelect.innerHTML = '<option value="">Failed to load models</option>';
    }
}

function populateModelSelect() {
    const chatModels = models.filter(m => m.type === 'chat' || !m.type);
    
    if (chatModels.length === 0) {
        // Use NUI API to set empty state
        if (elements.modelSelect.setItems) {
            elements.modelSelect.setItems([{ value: '', label: 'No chat models available', disabled: true }]);
        }
        return;
    }
    
    // Determine which model to select
    let modelToSelect = null;
    
    // Highest priority: Used model saved in chat history
    const curChatInfo = chatHistory.get(currentChatId);
    if (curChatInfo && curChatInfo.model) {
        if (chatModels.some(m => m.id === curChatInfo.model)) {
            modelToSelect = curChatInfo.model;
        }
    }

    if (!modelToSelect && DEFAULT_MODEL) {
        // Use configured default if it exists
        const defaultModelExists = chatModels.some(m => m.id === DEFAULT_MODEL);
        if (defaultModelExists) {
            modelToSelect = DEFAULT_MODEL;
        } else {
            console.warn(`[Chat] Configured default model "${DEFAULT_MODEL}" not found, using first available`);
        }
    }
    
    // If no default configured or not found, auto-select first model
    if (!modelToSelect) {
        modelToSelect = chatModels[0].id;
    }
    
    // Build items array for NUI setItems API
    const items = [{ value: '', label: 'Select model...' }];
    
    // Group by adapter/provider
    const byAdapter = new Map();
    for (const model of chatModels) {
        const adapter = model.owned_by || 'unknown';
        if (!byAdapter.has(adapter)) byAdapter.set(adapter, []);
        byAdapter.get(adapter).push(model);
    }
    
    for (const [adapter, adapterModels] of byAdapter) {
        const adapterLabel = adapter.charAt(0).toUpperCase() + adapter.slice(1);
        const groupItems = adapterModels.map(model => ({
            value: model.id,
            label: model.id
        }));
        
        items.push({
            group: adapterLabel,
            options: groupItems
        });
    }
    
    // Use NUI API to update options
    if (elements.modelSelect.setItems) {
        elements.modelSelect.setItems(items);
        
        // Select the model (default or first available)
        if (modelToSelect) {
            currentModel = modelToSelect;
            elements.modelSelect.setValue(modelToSelect);
        }
        
        // Bind change event via NUI
        elements.modelSelect.addEventListener('nui-change', (e) => {
            currentModel = e.detail.values[0] || '';
            updateOverallContext();
            updateVisionToggleVisibility();
        });
    } else {
        // Fallback if NUI not loaded yet
        console.warn('[Chat] NUI select not ready, using fallback');
        populateModelSelectFallback(chatModels, modelToSelect);
    }
}

// Fallback for when NUI is not ready
function populateModelSelectFallback(chatModels, modelToSelect) {
    const select = elements.modelSelect.querySelector('select');
    if (!select) return;
    
    select.innerHTML = '<option value="">Select model...</option>';
    
    const byAdapter = new Map();
    for (const model of chatModels) {
        const adapter = model.owned_by || 'unknown';
        if (!byAdapter.has(adapter)) byAdapter.set(adapter, []);
        byAdapter.get(adapter).push(model);
    }
    
    for (const [adapter, adapterModels] of byAdapter) {
        const adapterLabel = adapter.charAt(0).toUpperCase() + adapter.slice(1);
        const optgroup = document.createElement('optgroup');
        optgroup.label = adapterLabel;
        
        for (const model of adapterModels) {
            const option = document.createElement('option');
            option.value = model.id;
            option.textContent = model.id;
            optgroup.appendChild(option);
        }
        
        select.appendChild(optgroup);
    }
    
    // Select the model (default or first available)
    if (modelToSelect) {
        currentModel = modelToSelect;
        select.value = modelToSelect;
    }
    
    select.addEventListener('change', (e) => {
        currentModel = e.target.value;
        updateOverallContext();
        updateVisionToggleVisibility();
    });
}

// ============================================
// TTS Voice Loading
// ============================================

async function loadTtsVoices() {
    if (!ttsEndpoint) return;
    try {
        const resp = await fetch(`${ttsEndpoint}/voices`);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        ttsVoices = data.voices || [];
        updateTtsVoiceSelect();
        showTtsStatus(null);
    } catch (error) {
        console.warn('[TTS] Failed to load voices:', error.message);
        showTtsStatus('Failed to load voices. Check endpoint.');
    }
}

function updateTtsVoiceSelect() {
    const select = elements.ttsVoiceSelect;
    if (!select) return;
    const innerSelect = select.querySelector('select');
    if (!innerSelect) return;

    if (ttsVoices.length === 0) {
        const items = [{ value: '', label: 'No voices available', disabled: true }];
        if (select.setItems) select.setItems(items);
        return;
    }

    const items = ttsVoices.map(v => ({ label: v.name || v, value: v.name || v }));
    if (select.setItems) {
        select.setItems(items);
    }

    if (ttsVoice) {
        innerSelect.value = ttsVoice;
        innerSelect.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (ttsVoices.length > 0) {
        const firstVoice = ttsVoices[0].name || ttsVoices[0];
        ttsVoice = firstVoice;
        innerSelect.value = firstVoice;
        innerSelect.dispatchEvent(new Event('change', { bubbles: true }));
        storage.setPref('tts-voice', firstVoice).catch(() => {});
    }
}

function showTtsStatus(message) {
    if (!elements.ttsStatus) return;
    if (message) {
        elements.ttsStatus.textContent = message;
        elements.ttsStatus.style.display = 'block';
    } else {
        elements.ttsStatus.textContent = '';
        elements.ttsStatus.style.display = 'none';
    }
}

// ============================================
// Event Listeners
// ============================================

function setupEventListeners() {
    // Session metadata - save to storage on change
    elements.userName?.querySelector('input')?.addEventListener('change', (e) => {
        storage.setPref('user-name', e.target.value).catch(() => {});
    });
    elements.userLocation?.querySelector('input')?.addEventListener('change', (e) => {
        storage.setPref('user-location', e.target.value).catch(() => {});
    });
    elements.userLanguage?.querySelector('input')?.addEventListener('change', (e) => {
        storage.setPref('user-language', e.target.value).catch(() => {});
    });

    elements.systemPrompt?.querySelector('textarea')?.addEventListener('input', (e) => {
        if (currentChatId) {
            updateChatSystemPrompt(currentChatId, e.target.value);
        }
    });

    elements.operationMode?.querySelector('select')?.addEventListener('change', (e) => {
        const newMode = e.target.value;
        client.operationMode = newMode;
        storage.setPref('operation-mode', newMode).catch(() => {});
    });

    // TTS endpoint - save and reload voices on change
    elements.ttsEndpoint?.querySelector('input')?.addEventListener('change', (e) => {
        ttsEndpoint = e.target.value || TTS_ENDPOINT;
        storage.setPref('tts-endpoint', ttsEndpoint).catch(() => {});
        loadTtsVoices();
    });

    // TTS voice
    elements.ttsVoiceSelect?.querySelector('select')?.addEventListener('change', (e) => {
        ttsVoice = e.target.value;
        storage.setPref('tts-voice', ttsVoice).catch(() => {});
    });

    // TTS speed
    elements.ttsSpeed?.querySelector('input')?.addEventListener('change', (e) => {
        ttsSpeed = parseFloat(e.target.value) || 1.0;
        storage.setPref('tts-speed', ttsSpeed).catch(() => {});
    });
    
    // Send message / Toggle Stop
    elements.sendBtn?.addEventListener('click', (e) => {
        if (client.hasActiveStream(currentChatId)) {
            abortStream();
        } else {
            sendMessage();
        }
    });
    elements.messageInput?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            e.stopPropagation();
            sendMessage();
        }
    }, true);
    
    // File attachment
    elements.attachBtn?.addEventListener('click', () => {
        elements.fileInput?.click();
    });
    elements.fileInput?.addEventListener('change', handleFileSelect);
    
    // Image paste support
    elements.messageInput?.addEventListener('paste', (e) => {
        const files = Array.from(e.clipboardData?.files || []);
        let hasImage = false;
        
        for (const file of files) {
            if (!file.type.startsWith('image/')) continue;
            hasImage = true;
            
            const reader = new FileReader();
            reader.onload = (event) => {
                attachedImages.push({
                    dataUrl: event.target.result,
                    name: file.name || 'pasted-image.png',
                    type: file.type
                });
                addAttachmentPreview(event.target.result, file.name || 'Pasted Image');
            };
            reader.readAsDataURL(file);
        }
        
        // If pure image paste (e.g. from Snipping Tool), prevent default so editor doesn't add empty lines
        if (hasImage && !e.clipboardData.types.includes('text/plain') && !e.clipboardData.types.includes('text/html')) {
            e.preventDefault();
        }
    });
    
    // Ctrl+Alt+V: Paste as code block
    elements.messageInput?.addEventListener('keydown', async (e) => {
        if (e.ctrlKey && e.altKey && e.key.toLowerCase() === 'v') {
            e.preventDefault();
            e.stopPropagation();
            
            try {
                const text = await navigator.clipboard.readText();
                if (text) {
                    const editor = elements.messageInput;
                    const editorEl = editor.querySelector('.nui-rich-text-editor');
                    if (editorEl) editorEl.focus();
                    
                    // Create nui-code element programmatically
                    const codeBlock = document.createElement('nui-code');
                    const pre = document.createElement('pre');
                    const code = document.createElement('code');
                    code.textContent = text; // Use textContent to preserve raw text
                    pre.appendChild(code);
                    codeBlock.appendChild(pre);
                    
                    // Insert at cursor position
                    const selection = window.getSelection();
                    if (selection.rangeCount > 0) {
                        const range = selection.getRangeAt(0);
                        range.deleteContents();
                        range.insertNode(codeBlock);
                        
                        // Add line break after
                        const br = document.createElement('div');
                        br.innerHTML = '<br>';
                        codeBlock.after(br);
                        
                        // Move cursor after
                        range.setStartAfter(br);
                        range.collapse(true);
                        selection.removeAllRanges();
                        selection.addRange(range);
                    } else {
                        editorEl.appendChild(codeBlock);
                    }
                    
                    // Trigger NUI component upgrade for syntax highlighting
                    editor._forceComponentUpgrade?.();
                }
            } catch (err) {
                console.error('Failed to paste as code block:', err);
                nui.components.dialog.alert('Paste Error', 'Could not access clipboard. Make sure you have clipboard permissions.');
            }
        }
    });

    // New chat
    elements.newChatBtn?.addEventListener('click', startNewChat);
    
    // Import chat
    elements.importChatBtn?.addEventListener('click', () => {
        elements.importChatInput?.click();
    });
    elements.importChatInput?.addEventListener('change', handleChatImport);
    
    // System prompt presets
    if (elements.managePresetsBtn) {
        elements.managePresetsBtn.addEventListener('click', () => {
            editingPresetId = null;
        const nameInput = document.getElementById('preset-name-input')?.querySelector('input');
        if (nameInput) nameInput.value = '';
        setPresetEditor('');
        renderPresetList();
        elements.presetsDialog?.showModal();
    });
    document.getElementById('preset-add-btn')?.addEventListener('click', () => {
        const draft = {
            id: 'preset_' + Date.now(),
            name: 'New Preset',
            content: ''
        };
        systemPresets.push(draft);
        editingPresetId = draft.id;
        const nameInput = document.getElementById('preset-name-input')?.querySelector('input');
        if (nameInput) nameInput.value = draft.name;
        setPresetEditor('');
            renderPresetList();
            elements.presetsDialog?.showModal();
        });
    }
    document.getElementById('preset-add-btn')?.addEventListener('click', () => {
        const draft = {
            id: 'preset_' + Date.now(),
            name: 'New Preset',
            content: ''
        };
        systemPresets.push(draft);
        editingPresetId = draft.id;
        const nameInput = document.getElementById('preset-name-input')?.querySelector('input');
        if (nameInput) nameInput.value = draft.name;
        const editor = document.getElementById('preset-editor');
        if (editor) editor.setValue('');
        savePresets();
        populatePresetSelect();
        renderPresetList();
    });
    elements.presetSelect?.querySelector('select')?.addEventListener('change', () => {
        const select = elements.presetSelect.querySelector('select');
        onPresetSelected(select.value);
    });
    document.getElementById('preset-save')?.addEventListener('click', saveCurrentPreset);

    // Delete preset buttons (dynamically rendered in dialog)
    const presetsSidebar = document.querySelector('#presets-dialog .presets-sidebar');
    presetsSidebar?.addEventListener('click', (e) => {
        const deleteBtn = e.target.closest('[data-delete-preset]');
        if (deleteBtn) {
            const id = deleteBtn.dataset.deletePreset;
            deletePreset(id);
        }
    });
    
    // Theme toggle
    elements.themeToggle?.addEventListener('click', toggleTheme);
    
    // Sidebar toggle (mobile)
    elements.sidebarToggle?.addEventListener('click', () => {
        elements.sidebar?.classList.remove('open');
    });
    elements.sidebarToggleMobile?.addEventListener('click', () => {
        elements.sidebar?.classList.add('open');
    });
    
    // Image lightbox - use event delegation
    elements.messages?.addEventListener('click', (e) => {
        const img = e.target.closest('.chat-attachment');
        if (img) {
            e.preventDefault();
            const fullSrc = img.dataset.fullSrc;
            if (fullSrc && nui.components?.lightbox) {
                nui.components.lightbox.show([{ src: fullSrc, title: img.alt }], 0);
            }
        }
    });
}


// ============================================
// Session Metadata
// ============================================

function buildMetadataPrefix() {
    const name = elements.userName?.querySelector('input')?.value?.trim();
    const location = elements.userLocation?.querySelector('input')?.value?.trim();
    const language = elements.userLanguage?.querySelector('input')?.value?.trim();
    
    const parts = ['LLM Gateway Chat v1.0'];
    if (name) parts.push(`User: "${name}"`);
    if (location) parts.push(`Location: "${location}"`);
    if (language) parts.push(`Language: "${language}"`);
    
    const header = parts.join(' | ');
    const instruction = 'Do not include timestamps in your responses - they are added automatically by the chat system.';
    
    return `${header}\n${instruction}`;
}

function getSystemPromptWithMetadata(excludedToolPrefixes = []) {
    const userPrompt = elements.systemPrompt?.querySelector('textarea')?.value?.trim() || '';
    const metadata = buildMetadataPrefix();
    
    if (userPrompt) {
        prompt = `${metadata}\n\n${userPrompt}`;
    } else {
        prompt = metadata;
    }

    // Archive tool context: let the LLM know it can search past conversations
    if (ENABLE_ARCHIVE_TOOLS) {
        prompt = prompt + '\n\nYou have access to the conversation archive. Use chat_archive_search for thematic/conceptual queries (use search_type: "keyword" for specific technical terms, "semantic" for ideas, "hybrid" for both). Use chat_archive_get_session to retrieve full conversations by ID. Use chat_archive_list_arena to browse arena sessions. Use chat_archive_find_similar to discover related sessions given a known session ID. Use chat_archive_find_references to trace conversation lineage (which sessions reference each other).';
    }

    return prompt;
}

// ============================================
// Message Sending
// ============================================

async function sendMessage() {
    const editor = elements.messageInput;
    const content = editor?.getMarkdown().trim();
    
    if ((!content && attachedImages.length === 0) || client.hasActiveStream(currentChatId)) return;
    if (!currentModel) {
        nui.components.dialog.alert('Model Required', 'Please select a model first.');
        return;
    }
    
    // Clear welcome message if present
    const welcome = getActiveContainer()?.querySelector('.welcome-message');
    if (welcome) welcome.remove();
    
    // Add user message to conversation
    currentExchangeId = await conversation.addExchange(content, [...attachedImages]);

    // Track the used model for this chat
    updateChatModel(currentChatId, currentModel);

    // Update chat title if it's the first message
    if (conversation.length === 1 && content) {
        updateChatTitle(currentChatId, content);
    }

    // Check vision capabilities before sending
    const hasImages = attachedImages.length > 0;
    const modelSupportsVision = currentModelSupportsVision();
    const visionToolsAvailable = areVisionToolsAvailable();
    
    // Validate: if images attached but no vision support
    if (hasImages && !modelSupportsVision && !visionToolsAvailable) {
        nui.components.dialog.alert(
            'No Vision Support',
            'The selected model does not support vision, and no MCP vision tools are available. Please remove images or select a vision-capable model.'
        );
        return;
    }
    
    // Determine if we should use MCP vision (only when toggle is ON and tools available)
    const shouldUseMcpVision = hasImages && visionToolsAvailable && useVisionAnalysis;
    
    // Store images for MCP vision processing before clearing
    const imagesForMcpVision = shouldUseMcpVision ? [...attachedImages] : [];
    
    // Clear input and attachments
    editor.setMarkdown('');
    clearAttachments();
    updateVisionToggleVisibility();
    
    // Render user message
    renderExchange(conversation.getExchange(currentExchangeId));
    
    // MCP VISION: If toggle is ON and tools available, create vision sessions BEFORE sending to model
    // This happens AFTER user message is rendered, BEFORE LLM responds
    if (shouldUseMcpVision) {
        try {
            await autoCreateVisionSessions(currentExchangeId, imagesForMcpVision, currentChatId);
            
            // Remove image attachments from the exchange so they aren't forwarded
            // to the Gateway. The MCP Vision analysis text is injected into the
            // user message by streamResponse instead.
            const ex = conversation.getExchange(currentExchangeId);
            if (ex?.user?.attachments) {
                ex.user.attachments = [];
                conversation.save();
            }
        } catch (err) {
            console.error('[Vision] MCP vision session creation failed:', err);
            nui.components.dialog.alert(
                'MCP Vision Error',
                `Failed to analyze images: ${err.message}. The model may not be able to process them.`
            );
            // Continue anyway - model might still handle it if it supports vision
        }
    }
    
    // Start streaming response
    await streamResponse(currentExchangeId);
}

// ============================================
// Vision Tool Integration
// ============================================

// Note: The vision workflow:
// - autoCreateVisionSessions() does the FULL pipeline: create session + analyze image
// - Analysis text is injected as a preamble into the assistant's response
// - The LLM never needs to call vision_analyze - it sees the analysis directly
// - Vision tools are filtered out of the LLM's tools array when auto-vision is active
// 
// analyzeImagesWithVision() kept for potential manual use

function getVisionToolName(baseName) {
    // Check if tool exists with exact name first
    if (mcpClient.toolRegistry.has(baseName)) {
        return baseName;
    }
    
    // Try to find tool by suffix (handles server-prefixed names like orchestrator__vision_create_session)
    for (const [llmName, record] of mcpClient.toolRegistry.entries()) {
        if (record.originalName === baseName) {
            return llmName;
        }
    }
    
    // Fall back to base name - will fail gracefully with "Unknown tool" error
    return baseName;
}

function areVisionToolsAvailable() {
    const createSessionTool = getVisionToolName('vision_create_session');
    const analyzeTool = getVisionToolName('vision_analyze');
    return mcpClient.toolRegistry.has(createSessionTool) && 
           mcpClient.toolRegistry.has(analyzeTool);
}

async function analyzeImagesWithVision(images) {
    const results = [];
    
    // Verify vision tools are available
    if (!areVisionToolsAvailable()) {
        throw new Error('Vision tools not available. Please connect to an MCP server with vision capabilities.');
    }
    
    const createSessionToolName = getVisionToolName('vision_create_session');
    const analyzeToolName = getVisionToolName('vision_analyze');
    
    for (const img of images) {
        // Extract base64 data from dataUrl
        const base64Match = img.dataUrl.match(/^data:image\/[^;]+;base64,(.+)$/);
        if (!base64Match) {
            throw new Error(`Invalid image data format for ${img.name}`);
        }
        
        const mimeType = img.dataUrl.match(/^data:([^;]+);/)?.[1] || 'image/jpeg';
        const base64Data = base64Match[1];
        
        // Create vision session
        const sessionResult = await mcpClient.executeTool(createSessionToolName, {
            image_data: base64Data,
            image_mime_type: mimeType
        });
        
        if (!sessionResult || !sessionResult.session_id) {
            throw new Error('Failed to create vision session');
        }
        
        // Analyze the image
        const analysisResult = await mcpClient.executeTool(analyzeToolName, {
            session_id: sessionResult.session_id,
            query: 'Describe this image in detail. Include all visible objects, text, people, and context.'
        });
        
        // Extract text from result
        let analysisText = '';
        if (analysisResult?.content && Array.isArray(analysisResult.content)) {
            analysisText = analysisResult.content
                .filter(c => c.type === 'text')
                .map(c => c.text)
                .join('\n');
        } else if (typeof analysisResult === 'string') {
            analysisText = analysisResult;
        } else {
            analysisText = JSON.stringify(analysisResult);
        }
        
        results.push(analysisText);
    }
    
    return results;
}

// ============================================
// Auto Vision Session Creation
// ============================================

// Module-level storage for auto-vision analysis results
// These are injected into the assistant's response as a preamble before streaming begins
let autoVisionResults = [];

async function autoCreateVisionSessions(userExchangeId, images, chatId = null) {
    // Verify vision tools are available
    if (!areVisionToolsAvailable()) {
        return;
    }
    
    const createSessionToolName = getVisionToolName('vision_create_session');
    const analyzeToolName = getVisionToolName('vision_analyze');
    const results = [];
    
    // Use the correct chat conversation and container for multi-chat robustness
    const targetChatId = chatId || currentChatId;
    const visionConversation = activeConversations.get(targetChatId);
    const container = getOrCreateContainer(targetChatId);
    const visionStatusEl = document.createElement('div');
    visionStatusEl.className = 'chat-message tool';
    visionStatusEl.innerHTML = `
        <div class="tool-bubble">
            <div class="message-header tool-header">
                <nui-icon name="extension"></nui-icon>
                <strong class="tool-title">MCP VISION ANALYSIS</strong>
                <nui-badge variant="primary" class="tool-status">Running</nui-badge>
            </div>
            <div class="tool-notifications" style="display: block;">
                <span class="tool-spinner"></span> Analyzing ${images.length} image(s)...
            </div>
        </div>
    `;
    container?.appendChild(visionStatusEl);
    scrollToBottom();
    
    for (let i = 0; i < images.length; i++) {
        const img = images[i];
        
        try {
            // Extract base64 data from dataUrl
            const base64Match = img.dataUrl.match(/^data:image\/[^;]+;base64,(.+)$/);
            if (!base64Match) {
                console.warn(`[AutoVision] Invalid image data format for ${img.name}, skipping`);
                continue;
            }
            
            const mimeType = img.dataUrl.match(/^data:([^;]+);/)?.[1] || 'image/jpeg';
            const base64Data = base64Match[1];
            
            // Update status
            const notifEl = visionStatusEl.querySelector('.tool-notifications');
            if (notifEl) {
                notifEl.innerHTML = `<span class="tool-spinner"></span> Creating vision session for image ${i + 1}/${images.length}...`;
            }
            
            // STEP 1: Create vision session
            const sessionResult = await mcpClient.executeTool(createSessionToolName, {
                image_data: base64Data,
                image_mime_type: mimeType
            });
            
            // Extract session ID from result
            let sessionId = null;
            if (sessionResult && typeof sessionResult === 'object') {
                if (sessionResult.session_id) {
                    sessionId = sessionResult.session_id;
                } else if (sessionResult.content && Array.isArray(sessionResult.content)) {
                    const textContent = sessionResult.content
                        .filter(c => c.type === 'text')
                        .map(c => c.text)
                        .join(' ');
                    // Try to extract session_id from text
                    const sidMatch = textContent.match(/session_id['"]?\s*[:=]\s*['"]?([^'"\s,}]+)/i);
                    if (sidMatch) sessionId = sidMatch[1];
                }
            }
            
            if (!sessionId) {
                console.warn(`[AutoVision] No session ID returned for image ${i + 1}, skipping analysis`);
                results.push(`[Image ${i + 1}${img.name ? ` (${img.name})` : ''}]: Vision session could not be created.`);
                continue;
            }
            
            // Update status
            if (notifEl) {
                notifEl.innerHTML = `<span class="tool-spinner"></span> Analyzing image ${i + 1}/${images.length}...`;
            }
            
            // STEP 2: Analyze the image using the session
            const analysisResult = await mcpClient.executeTool(analyzeToolName, {
                session_id: sessionId,
                query: 'Describe this image in detail. Include all visible objects, text, people, and context.'
            });
            
            // Extract analysis text
            let analysisText = '';
            if (analysisResult && typeof analysisResult === 'object') {
                if (analysisResult.content && Array.isArray(analysisResult.content)) {
                    analysisText = analysisResult.content
                        .filter(c => c.type === 'text')
                        .map(c => c.text)
                        .join('\n');
                } else if (analysisResult.text) {
                    analysisText = analysisResult.text;
                } else {
                    analysisText = JSON.stringify(analysisResult);
                }
            } else if (typeof analysisResult === 'string') {
                analysisText = analysisResult;
            }
            
            results.push(`[Image ${i + 1}${img.name ? ` (${img.name})` : ''}]:\n${analysisText.trim()}`);
            
        } catch (err) {
            console.error(`[AutoVision] Failed to analyze image ${i + 1}:`, err);
            results.push(`[Image ${i + 1}${img.name ? ` (${img.name})` : ''}]: Analysis failed - ${err.message}`);
        }
    }
    
    // Update status display to done
    if (results.length > 0) {
        visionStatusEl.querySelector('.tool-status').setAttribute('variant', 'success');
        visionStatusEl.querySelector('.tool-status').innerHTML = 'Success';
        const notifEl = visionStatusEl.querySelector('.tool-notifications');
        if (notifEl) {
            notifEl.style.display = 'none';
        }
        
        // Store analysis results for streamResponse to inject into assistant content
        const combinedAnalysis = results.join('\n\n');
        autoVisionResults = [{ exchangeId: userExchangeId, chatId: targetChatId, analysis: combinedAnalysis }];
    } else {
        visionStatusEl.querySelector('.tool-status').setAttribute('variant', 'danger');
        visionStatusEl.querySelector('.tool-status').innerHTML = 'No Results';
    }
}

async function streamResponse(exchangeId, streamChatId, origUserExchangeId = null) {
    // Use provided chatId if given (for background tool continuations), otherwise use current
    const chatId = streamChatId || currentChatId;

    // Ensure conversation is synced to the correct chat in case user switched tabs during an async operation
    // This is critical for tool continuations where handleToolExecution awaited while user switched chats
    conversation = activeConversations.get(chatId) || conversation;

    // Track original user exchange ID for chained tool calls.
    // origUserExchangeId is passed when this stream is a tool continuation (so we know the original user exchange).
    // When null, exchangeId IS the user exchange (first tool in a user exchange).
    const originalUserExchangeId = origUserExchangeId || exchangeId;

    isStreaming = true;
    markChatAsStreaming(chatId, true);
    updateSendButton();

    const exchange = conversation.getExchange(exchangeId);

    // Guard: skip operations on missing exchanges and tool exchanges (they have no user message)
    const isToolExchange = exchange && exchange.type === 'tool';

    const assistantTimestamp = conversation._formatTimestamp();
    const timestampWithSpace = assistantTimestamp + ' ';
    
    // Determine if we should exclude vision tools from system prompt
    const modelSupportsVision = currentModelSupportsVision();
    const shouldExcludeVisionTools = modelSupportsVision && !useVisionAnalysis;
    const excludedToolPrefixes = shouldExcludeVisionTools ? ['vision_'] : [];
    
    
    const systemPrompt = getSystemPromptWithMetadata(excludedToolPrefixes);
    // Store system prompt for debugging (included in JSON export)
    conversation.setSystemPrompt(exchangeId, systemPrompt);

    // Augment system prompt with MCP Vision analysis if available
    let effectiveSystemPrompt = systemPrompt;
    const autoVisionEntry = autoVisionResults.find(r => r.exchangeId === exchangeId && r.chatId === chatId);
    if (autoVisionEntry) {
        effectiveSystemPrompt += `\n\nThe user attached an image. MCP Vision analysis:\n${autoVisionEntry.analysis}`;
        autoVisionResults.splice(autoVisionResults.indexOf(autoVisionEntry), 1);
    }

    const temperature = parseFloat(elements.temperature?.value) || DEFAULT_TEMPERATURE;
    const maxTokensStr = elements.maxTokens?.querySelector('input')?.value || elements.maxTokens?.value;
    const maxTokens = maxTokensStr ? parseInt(maxTokensStr) : null;

    // Get or create assistant message element in the correct chat's container
    const targetContainer = getOrCreateContainer(chatId);
    let assistantEl = targetContainer?.querySelector(`.chat-message.assistant[data-exchange-id="${exchangeId}"]`);
    if (!assistantEl) {
        assistantEl = createAssistantElement(exchangeId);
        targetContainer?.appendChild(assistantEl);
    }
    // Store timestamp info for stripping during rendering (reset on regeneration)
    const tsLen = timestampWithSpace.length;
    assistantEl.dataset.timestampLen = tsLen.toString();
    assistantEl.dataset.timestampStripped = 'true';
    assistantEl.dataset.isStreaming = 'true';
    // Update header with new timestamp
    const headerEl = assistantEl.querySelector('.message-header');
    if (headerEl) {
        const tsEl = headerEl.querySelector('.message-timestamp');
        if (tsEl) {
            tsEl.textContent = assistantTimestamp.replace(/^\[|\]$/g, '').replace('@', ' @ ');
        } else {
            headerEl.innerHTML += ` <span class="message-timestamp">${assistantTimestamp.replace(/^\[|\]$/g, '').replace('@', ' @ ')}</span>`;
        }
    }
    scrollToBottom();
    
    try {
        const messages = await conversation.getMessagesForApi(effectiveSystemPrompt);

        const requestBody = {
            model: currentModel,
            messages,
            temperature,
            stream: true
        };
        
        if (maxTokens) {
            requestBody.max_tokens = maxTokens;
        }

        // PHASE-3: Pass tools array so LLM knows what it can request
        // Filter vision tools from the list if:
        //   A) MCP Vision toggle is OFF AND model supports vision, OR
        //   B) Auto-vision is doing the full analysis (images already analyzed by frontend)
        const hasAutoVisionAnalysis = autoVisionResults.some(r => r.exchangeId === exchangeId && r.chatId === chatId);
        const allMcpTools = mcpClient.getFormattedToolsForLLM();
        if (allMcpTools.length > 0) {
            // Check if auto-vision is handling analysis (frontend does create+analyze, LLM doesn't need vision tools)
            const modelSupportsVision = currentModelSupportsVision();
            const shouldFilterVisionTools = (modelSupportsVision && !useVisionAnalysis) || hasAutoVisionAnalysis;
            
            
            if (shouldFilterVisionTools) {
                const filteredTools = allMcpTools.filter(tool => {
                    const toolName = tool.function?.name?.toLowerCase() || '';
                    const isVision = toolName.includes('vision_');
                    if (isVision) console.log('[Vision] Filtering OUT tool:', tool.function?.name);
                    return !isVision;
                });
                
                if (filteredTools.length > 0) {
                    requestBody.tools = filteredTools;
                }
            } else {
                requestBody.tools = allMcpTools;
            }
        }

        // Add archive tools (local backend, not MCP)
        if (ENABLE_ARCHIVE_TOOLS) {
            if (!requestBody.tools) requestBody.tools = [];
            requestBody.tools.push(...ARCHIVE_TOOLS);
        }

        // Add image processing if images attached (skip for tool exchanges - they have no user message)
        // Also skip when MCP Vision already analyzed the images
        if (!isToolExchange && exchange && exchange.user?.attachments?.length > 0 && !hasAutoVisionAnalysis) {
            requestBody.image_processing = {
                resize: 'auto',
                transcode: 'jpg',
                quality: 70  // Lower quality for smaller payload
            };
        }
        
        let contentBuffer = '';
        
        let reasoningBuffer = '';
        let pendingUpdate = false;
        let lastRender = 0;
        const RENDER_INTERVAL = 50; // Render at most every 50ms

        let isReceivingTool = false;

        for await (const event of client.streamChatIterable(requestBody, chatId, false, conversation)) {
            switch (event.type) {
                case 'delta':
                    // Hide progress status once text generation begins
                    const statusEl = assistantEl.querySelector('.progress-status');
                    if (statusEl) statusEl.classList.remove('visible');

                    // Hide user bubble pending indicator once assistant starts responding
                    const userPendingEl = targetContainer?.querySelector(`.chat-message.user[data-exchange-id="${exchangeId}"] .user-pending-indicator`);
                    if (userPendingEl) userPendingEl.classList.remove('visible');

                    if (event.content !== undefined) {
                        contentBuffer += event.content;
                        conversation.updateAssistantResponse(exchangeId, event.content);
                    }

                    if (event.reasoning_content !== undefined) {
                        reasoningBuffer += event.reasoning_content;
                        conversation.updateAssistantReasoning(exchangeId, event.reasoning_content);
                    }

                    if (event.tool_calls && event.tool_calls.length > 0 && !isReceivingTool) {
                        isReceivingTool = true;
                        showPendingToolUI(exchangeId, chatId);
                    }

                    // Debounce DOM updates to prevent freezing
                    if (!pendingUpdate) {
                        pendingUpdate = true;
                        const now = performance.now();
                        const delay = Math.max(0, Math.min(RENDER_INTERVAL, RENDER_INTERVAL - (now - lastRender)));

                        const wasNearBottom = isNearBottom();
                        setTimeout(() => {
                            updateAssistantContent(assistantEl, contentBuffer, reasoningBuffer);
                            lastRender = performance.now();
                            pendingUpdate = false;
                            if (wasNearBottom) scrollToBottom();
                        }, delay);
                    }
                    break;
                    
                case 'compaction-start':
                    showCompactionIndicator(assistantEl, event.data);
                    break;
                    
                case 'compaction':
                    updateCompactionProgress(assistantEl, event.data);
                    break;
                    
                case 'compaction-complete':
                    hideCompactionIndicator(assistantEl);
                    break;
                    
                case 'error':
                    console.error('[Chat] Received error event:', event.error);
                    // Reconstruct full content with timestamp for proper stripping
                    const errorTsMatch = exchange.assistant.content.match(TIMESTAMP_REGEX);
                    const errorFullContent = errorTsMatch ? errorTsMatch[0] + contentBuffer : contentBuffer;
                    updateAssistantContent(assistantEl, errorFullContent);
                    showError(assistantEl, event.error);
                    conversation.setAssistantError(exchangeId, event.error);
                    break;
                    
                case 'aborted':
                    // Reconstruct full content with timestamp for proper stripping
                    const abortTsMatch = exchange.assistant.content.match(TIMESTAMP_REGEX);
                    const abortFullContent = abortTsMatch ? abortTsMatch[0] + contentBuffer : contentBuffer;
                    updateAssistantContent(assistantEl, stripExtraTimestamps(abortFullContent));
                    showError(assistantEl, 'Stopped');
                    conversation.setAssistantError(exchangeId, 'Stopped');
                    break;
                    
                case 'done':
                    if (event.finish_reason === 'tool_calls' && event.tool_calls?.length > 0) {
                        const toolDoneEx = conversation.getExchange(exchangeId);
                        if (toolDoneEx) {
                            if (event.reasoning_content) toolDoneEx.assistant.reasoning_content = event.reasoning_content;
                            if (event.thinking_signature) toolDoneEx.assistant.thinking_signature = event.thinking_signature;
                            toolDoneEx.assistant.tool_calls = event.tool_calls;
                        }
                        
                        const toolPromises = [];
                        for (const tc of event.tool_calls) {
                            try {
                                const args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
                                toolPromises.push(handleToolExecution(exchangeId, {
                                    name: tc.function.name,
                                    args: args,
                                    id: tc.id
                                }, chatId, originalUserExchangeId, false)); // false = don't auto-resume stream
                            } catch (err) {
                                console.error('Failed to parse tool arguments', tc.function.arguments, err);
                            }
                        }
                        
                        // We await the Promise.all here inside the async loop so streamResponse doesn't exit early
                        // This locks the UI from clicking 'Send' while tools execute.
                        const toolExchangeIds = await Promise.all(toolPromises);
                        if (toolExchangeIds.length > 0) {
                            const lastToolExchangeId = toolExchangeIds[toolExchangeIds.length - 1];
                            await streamResponse(lastToolExchangeId, chatId, originalUserExchangeId || exchangeId);
                        }
                        return; // Done handling tool execution
                    }

                    // contentBuffer doesn't include our injected timestamp
                    // Get the exchange to find the original timestamp we injected
                    const ex = conversation.getExchange(exchangeId);
                    
                    let finalContent = contentBuffer;
                    const tsMatch = ex?.assistant?.content?.match(TIMESTAMP_REGEX);
                    if (tsMatch) {
                        // Reconstruct: original timestamp + content buffer (no LLM timestamp)
                        finalContent = tsMatch[0] + finalContent;
                    }
                    // Strip any extra timestamps LLM may have generated
                    finalContent = stripExtraTimestamps(finalContent);
                    // Update exchange with correct content
                    if (ex) {
                        ex.assistant.content = finalContent;
                    }
                    // Ensure final content is rendered
                    updateAssistantContent(assistantEl, finalContent);
                    // Await save to ensure data is persisted before continuing
                    await conversation.setAssistantComplete(exchangeId, event.usage, event.context, {
                        reasoning_content: event.reasoning_content || null,
                        thinking_signature: event.thinking_signature || null
                    });
                    finalizeAssistantElement(assistantEl, exchangeId, event.usage, event.context);
                    scrollToBottom();
                    break;
                case 'progress':
                    if (event.data?.phase === 'context_stats') {
                        updateUsageDisplay(assistantEl, event.data.context);
                    } else if (event.data) {
                        const statusEl = assistantEl.querySelector('.progress-status');
                        if (statusEl) {
                            let statusText = event.data.message || event.data.status;
                            if (!statusText && event.data.phase) {
                                // Default format if no explicit message is provided: "Uploading..." -> "Uploading"
                                statusText = event.data.phase.charAt(0).toUpperCase() + event.data.phase.slice(1);
                                if (event.data.progress !== undefined) {
                                    statusText += ` (${event.data.progress}%)`;
                                }
                            }
                            if (statusText) {
                                statusEl.classList.add('visible');
                                statusEl.textContent = statusText;
                            }
                        }
                    }
                    if (isNearBottom()) scrollToBottom();
                    break;
            }
        }
        
    } catch (error) {
        console.error('[Chat] Stream error caught in try/catch:', error);
        const errorMessage = typeof error === 'string' ? error : (error.message || 'Unknown error');
        showError(assistantEl, errorMessage);
        conversation.setAssistantError(exchangeId, errorMessage);
    } finally {
        isStreaming = false;
        markChatAsStreaming(chatId, false);
        updateSendButton();
        currentExchangeId = null;
    }
}

// ============================================
// DOM Creation & Updates
// ============================================

function renderConversation() {
    const container = getActiveContainer();

    container.innerHTML = '';

    if (conversation.length === 0) {
        container.innerHTML = `
            <div class="welcome-message">
                <h2>Welcome to LLM Gateway Chat</h2>
                <p>Select a model and start chatting</p>
            </div>
        `;
        updateOverallContext(); // Clear context indicator for new chat
        return;
    }

    for (const exchange of conversation.getAll()) {
        renderExchange(exchange);
    }

    updateOverallContext(); // Call this when loading historical conversation

    scrollToBottom();
}

function renderExchange(exchange) {
    if (exchange.type === 'tool') {
        const parsedObj = { name: exchange.tool.name, args: exchange.tool.args };
        const toolEl = document.createElement('div');
        toolEl.className = 'chat-message tool';
        toolEl.dataset.exchangeId = exchange.id;
        toolEl.dataset.mcpToolName = parsedObj.name;
        
        const isSuccess = exchange.tool.status === 'success';
        const isError = exchange.tool.status === 'error';
        const displayStatus = isSuccess ? 'Success' : (isError ? 'Failed' : 'Pending');
        const badgeVariant = isSuccess ? 'success' : (isError ? 'danger' : 'primary');
        
        let hasImages = exchange.tool.images && exchange.tool.images.length > 0;
        let imagesHtml = '';
        if (hasImages) {
            imagesHtml = `<div class="tool-images-container">`;
            exchange.tool.images.forEach(img => {
                imagesHtml += `<img src="${img}" class="tool-image" />`;
            });
            imagesHtml += `</div>`;
        }

        let resultHtml = '';
        if (isSuccess) resultHtml = exchange.tool.content;
        else if (isError) resultHtml = exchange.tool.content;

        toolEl.innerHTML = `
            <div class="tool-bubble">
                <div class="message-header tool-header">
                    <nui-icon name="extension"></nui-icon>
                    <strong class="tool-title">SYSTEM TOOL: ${parsedObj.name}</strong>
                    <nui-badge variant="${badgeVariant}" class="tool-status">${displayStatus}</nui-badge>
                </div>
                <div class="tool-notifications">
                  </div>
                  <div class="tool-images" style="display: ${hasImages ? 'block' : 'none'};">${imagesHtml}</div>
                <div class="message-content tool-payload" style="display: none;">
                    <div class="tool-section-title">Arguments</div>
                    <div class="tool-args">${JSON.stringify(parsedObj.args, null, 2)}</div>
                    <div class="tool-section-title">Execution Result</div>
                    <div class="tool-result"></div>
                </div>
            </div>
        `;
        getActiveContainer()?.appendChild(toolEl);

        // Use textContent to prevent SVG/code examples from being parsed as HTML
        const resultEl = toolEl.querySelector('.tool-result');
        if (isSuccess) resultEl.innerHTML = `<strong>Result:</strong><br>`;
        else if (isError) resultEl.innerHTML = `<strong>Error:</strong> `;
        resultEl.appendChild(document.createTextNode(exchange.tool.content));

        toolEl.querySelector('.message-header').addEventListener('click', () => {
            const payloadBox = toolEl.querySelector('.tool-payload');
            payloadBox.style.display = payloadBox.style.display === 'none' ? 'block' : 'none';
        });

        // Assistant message (if exists after tool) - append as sibling after the tool element
        if (exchange.assistant.content || exchange.assistant.isStreaming) {
            const cleanedContent = stripExtraTimestamps(exchange.assistant.content);
            const assistantParsed = parseTimestamp(cleanedContent);
            const assistantTimestamp = assistantParsed.timestamp || '';
            const assistantEl = createAssistantElement(exchange.id, assistantTimestamp);

            const tsLen = exchange.assistant.content.length - assistantParsed.cleanContent.length;
            if (tsLen > 0) {
                assistantEl.dataset.timestampLen = tsLen.toString();
                assistantEl.dataset.timestampStripped = 'true';
            }
            updateAssistantContent(assistantEl, assistantParsed.cleanContent, exchange.assistant.reasoning_content);
            // In renderExchange, toolEl is already in DOM, so we can insert assistant as sibling
            // This keeps tool and assistant as separate message bubbles
            toolEl.insertAdjacentElement('afterend', assistantEl);
            if (exchange.assistant.isComplete) {
                finalizeAssistantElement(assistantEl, exchange.id);
            }
        }
        return;
    }

    // Parse timestamps from content
    const userParsed = parseTimestamp(exchange.user.content);
    const userTimestamp = userParsed.timestamp || (exchange.timestamp && !isNaN(exchange.timestamp) ? new Date(exchange.timestamp).toISOString().slice(0,16).replace('T',' @ ') : '');
    
    // User message
    const userEl = document.createElement('div');
    userEl.className = 'chat-message user';
    userEl.dataset.exchangeId = exchange.id;

    let userContent = renderMarkdown(userParsed.cleanContent);

    // Add attachment previews
    if (exchange.user?.attachments?.length > 0) {
        userContent += '<div class="message-attachments"><nui-lightbox loop>';
        for (const att of exchange.user.attachments) {
            // blobUrl works for both IndexedDB (blob:) and API (server URL) modes
            const imgSrc = att.blobUrl || att.dataUrl || '';
            userContent += `<img src="${imgSrc}" alt="${att.name}" data-lightbox-src="${imgSrc}" class="chat-attachment">`
        }
        userContent += '</nui-lightbox></div>';
    }
    
    userEl.innerHTML = `
        <div class="message-header">
            You <span class="message-timestamp">${userTimestamp}</span>
            <span class="user-pending-indicator visible">
                <span class="dot">.</span><span class="dot">.</span><span class="dot">.</span>
            </span>
        </div>
        <div class="message-content">${userContent}</div>
        <div class="message-actions-user">
            <nui-button class="action-btn edit-message" title="Edit Message"><button type="button"><nui-icon name="edit"></nui-icon></button></nui-button>
            <nui-button class="action-btn delete-message" title="Delete Message"><button type="button"><nui-icon name="delete"></nui-icon></button></nui-button>
        </div>
    `;

    // Bind user message action buttons
    userEl.querySelector('.edit-message')?.addEventListener('click', () => startEditMode(exchange.id, 'user'));
    userEl.querySelector('.delete-message')?.addEventListener('click', () => {
        conversation.deleteExchange(exchange.id);
        renderConversation();
    });

    getActiveContainer()?.appendChild(userEl);

    // Initialize Lightbox declarative handlers for attached images
    if (exchange.user?.attachments?.length > 0) {
        const lightbox = userEl.querySelector('nui-lightbox');
        if (lightbox) {
            const imgs = lightbox.querySelectorAll('img');
            imgs.forEach((img, i) => {
                img.addEventListener('click', () => {
                    lightbox.open([], i);
                });
            });
        }
    }

    // Assistant message (if exists)
    if (exchange.assistant.content || exchange.assistant.isStreaming) {
        // Clean up any duplicate timestamps from historical data
        const cleanedContent = stripExtraTimestamps(exchange.assistant.content);
        const assistantParsed = parseTimestamp(cleanedContent);
        const assistantTimestamp = assistantParsed.timestamp || '';
        
        const assistantEl = createAssistantElement(exchange.id, assistantTimestamp);
        // For historical messages, we already have the clean content
        // Store expected length to prevent re-parsing issues
        const tsLen = exchange.assistant.content.length - assistantParsed.cleanContent.length;
        if (tsLen > 0) {
            assistantEl.dataset.timestampLen = tsLen.toString();
            assistantEl.dataset.timestampStripped = 'true';
        }
        updateAssistantContent(assistantEl, assistantParsed.cleanContent, exchange.assistant.reasoning_content);
        getActiveContainer()?.appendChild(assistantEl);

        if (exchange.assistant.isComplete) {
            finalizeAssistantElement(assistantEl, exchange.id);
        }
    }
}

function createAssistantElement(exchangeId, timestamp = '') {
    const el = document.createElement('div');
    el.className = 'chat-message assistant';
    el.dataset.exchangeId = exchangeId;
    el.innerHTML = `
        <div class="message-header message-header-flex">
            <span>Assistant</span>${timestamp ? ` <span class="message-timestamp">${timestamp}</span>` : ''}
            <span class="streaming-indicator visible">
                <span class="dot">.</span><span class="dot">.</span><span class="dot">.</span>
            </span>
            <span class="context-usage-display">
                <span class="usage-values">--</span>
            </span>
        </div>
        <div class="progress-status"></div>
        <div class="message-content"></div>
        <div class="message-actions">
            <nui-button class="action-btn speaker" title="Read Aloud"><button type="button"><nui-icon name="speaker"></nui-icon></button></nui-button>
            <nui-button class="action-btn regenerate" title="Regenerate"><button type="button"><nui-icon name="sync"></nui-icon></button></nui-button>
            <nui-button class="action-btn prev-version" title="Previous version"><button type="button"><nui-icon name="arrow" class="arrow-rotated"></nui-icon></button></nui-button>
            <span class="version-info"></span>
            <nui-button class="action-btn next-version" title="Next version"><button type="button"><nui-icon name="arrow"></nui-icon></button></nui-button>
            <div class="spacer"></div>
            <nui-button class="action-btn copy-message" title="Copy Message"><button type="button"><nui-icon name="content_copy"></nui-icon></button></nui-button>
            <nui-button class="action-btn edit-message" title="Edit Message"><button type="button"><nui-icon name="edit"></nui-icon></button></nui-button>
            <nui-button class="action-btn delete-message" title="Delete Message"><button type="button"><nui-icon name="delete"></nui-icon></button></nui-button>
        </div>
    `;

    // Bind action buttons
    el.querySelector('.speaker')?.addEventListener('click', () => toggleTts(exchangeId, el));
    el.querySelector('.regenerate')?.addEventListener('click', () => regenerate(exchangeId));
    el.querySelector('.prev-version')?.addEventListener('click', () => switchVersion(exchangeId, 'prev'));
    el.querySelector('.next-version')?.addEventListener('click', () => switchVersion(exchangeId, 'next'));
    el.querySelector('.copy-message')?.addEventListener('click', (e) => copyMessageToClipboard(exchangeId, e.currentTarget));
    el.querySelector('.edit-message')?.addEventListener('click', () => startEditMode(exchangeId, 'assistant'));
    el.querySelector('.delete-message')?.addEventListener('click', () => {
        conversation.deleteExchange(exchangeId);
        renderConversation();
    });

    return el;
}

function updateUsageDisplay(el, contextData) {
    if (!el || !contextData) return;
    const displaySpan = el.querySelector('.context-usage-display');
    const valueSpan = el.querySelector('.usage-values');
    if (!displaySpan || !valueSpan) return;

    if (contextData.used_tokens !== undefined) {
        displaySpan.style.display = 'inline-block';

        // Compact token formatting (e.g., 36139 -> "36K")
        function formatTokensCompact(n) {
            if (n >= 1000000) return Math.round(n / 100000) / 10 + 'M';
            if (n >= 1000) return Math.round(n / 100) / 10 + 'K';
            return n.toString();
        }

        const isEstimate = contextData.isEstimate;
        let text = `${isEstimate ? '~' : ''}${formatTokensCompact(contextData.used_tokens)}`;

        let windowSize = contextData.window_size;
        if (!windowSize) {
            const modelConfig = models.find(m => m.id === currentModel);
            if (modelConfig && modelConfig.capabilities?.contextWindow) {
                windowSize = modelConfig.capabilities.contextWindow;
            }
        }

        if (windowSize) {
            text += ` / ${formatTokensCompact(windowSize)}`;
        }
        text += ' Tokens';

        // Only update if value changed - prevents tooltip flicker
        if (valueSpan.textContent !== text) {
            valueSpan.textContent = text;
        }

        // Add full context info as tooltip for debugging
        let debugText = [];
        for (const [key, val] of Object.entries(contextData)) {
            if (key !== 'isEstimate') {
                debugText.push(`${key}: ${val}`);
            }
        }
        const newTitle = debugText.length > 0 ? debugText.join('\n') : '';
        if (displaySpan.title !== newTitle) {
            displaySpan.title = newTitle;
        }

        updateOverallContext(contextData);
    }
}

async function updateOverallContext(contextData = null) {
    if (!elements.overallContextProgressWrap) return;

    if (!contextData) {
        // Try to get from last conversation exchange
        const lastEx = conversation.exchanges[conversation.exchanges.length - 1];
        
        let foundContext = lastEx?.assistant?.context;
        let foundUsage = lastEx?.assistant?.usage;

        // Fallback to version data if loading from history and surface variables are missing
        if (!foundContext && !foundUsage && lastEx?.assistant?.versions?.length > 0) {
            const curVersion = lastEx.assistant.versions[lastEx.assistant.currentVersion || 0];
            if (curVersion) {
                foundContext = curVersion.context;
                foundUsage = curVersion.usage;
            }
        }

        if (foundContext) {
            contextData = foundContext;
        } else {
            // Rough estimation fallback based on the data we have in the conversation text
            let textLength = 0;
            const msgs = await conversation.getMessagesForApi();
            for (const m of msgs) {
                let contentText = '';
                if (typeof m.content === 'string') {
                    contentText = m.content;
                } else if (Array.isArray(m.content)) {
                    for (const block of m.content) {
                        if (block.type === 'text') contentText += block.text;
                    }
                }
                
                // Strip <think>...</think> blocks
                contentText = contentText.replace(/<think>[\s\S]*?<\/think>/g, '');
                
                textLength += contentText.length;
                textLength += m.role.length;
            }
            if (textLength > 0) {
                // Heuristic: ~4 chars per token for English
                contextData = { used_tokens: Math.ceil(textLength / 4), isEstimate: true };
            }
        }
    }

    // The wrapper is always visible via CSS, context-progress-wrap class handles display

    const usedTokens = (contextData && contextData.used_tokens) ? contextData.used_tokens : 0;
    const isEstimate = contextData && contextData.isEstimate;
    
    // Compact token formatting (e.g., 36139 -> "36K")
    function formatTokensCompact(n) {
        if (n >= 1000000) return Math.round(n / 100000) / 10 + 'M';
        if (n >= 1000) return Math.round(n / 100) / 10 + 'K';
        return n.toString();
    }
    
    let text = `${isEstimate ? '~' : ''}${formatTokensCompact(usedTokens)}`;
    let pct = 0;
    let knownLimit = false;

    const modelConfig = models.find(m => m.id === currentModel);

    if (modelConfig && modelConfig.capabilities?.contextWindow) {
        text += ` / ${formatTokensCompact(modelConfig.capabilities.contextWindow)} Tokens`;
        pct = Math.min(100, Math.max(0, (usedTokens / modelConfig.capabilities.contextWindow) * 100));
        knownLimit = true;
    } else if (contextData && contextData.window_size) {
        // Fallback to backend reported window size if model list lacks it
        text += ` / ${formatTokensCompact(contextData.window_size)} Tokens`;
        pct = Math.min(100, Math.max(0, (usedTokens / contextData.window_size) * 100));
        knownLimit = true;
    } else {
        text += ` / ? Tokens`;
    }

    if (elements.overallContextProgressWrap) {
        let debugText = [];
        if (contextData) {
            for (const [key, val] of Object.entries(contextData)) {
                if (key !== 'isEstimate') {
                    debugText.push(`${key}: ${val}`);
                }
            }
        }
        elements.overallContextProgressWrap.title = debugText.length > 0 ? debugText.join('\n') : '';
    }

    if (elements.overallContextProgress) {
        elements.overallContextProgress.setAttribute('value', pct || 0);
        
        // Dim the icon if we genuinely do not know the context limit, or if no model is selected
        if (!knownLimit || !currentModel) {
            elements.overallContextProgress.style.opacity = '0.3';
            elements.overallContextProgress.removeAttribute('variant');
        } else {
            elements.overallContextProgress.style.opacity = '1';
            // Change variant to warning/orange if context is full
            if (pct >= 100) {
                elements.overallContextProgress.setAttribute('variant', 'warning');
            } else {
                elements.overallContextProgress.removeAttribute('variant');
            }
        }
    }

    if (elements.overallContextTooltip) {
        elements.overallContextTooltip.textContent = text;
    }
}

// ============================================
// PHASE-3: MCP Tool Execution Logic
// ============================================

function showPendingToolUI(exchangeId, chatId) {
    // Hide user bubble pending indicator when tool is detected
    // Use getOrCreateContainer with chatId since tool belongs to that chat (may differ from current if user switched)
    const container = getOrCreateContainer(chatId);
    const userPendingEl = container?.querySelector(`.chat-message.user[data-exchange-id="${exchangeId}"] .user-pending-indicator`);
    if (userPendingEl) userPendingEl.classList.remove('visible');

    const toolEl = document.createElement('div');
    toolEl.className = 'chat-message tool pending-tool-element';
    toolEl.dataset.pendingExchangeId = exchangeId;

    toolEl.innerHTML = `
        <div class="tool-bubble pending">
            <div class="message-header tool-header pending">
                <nui-icon name="extension"></nui-icon>
                <strong class="tool-title">SYSTEM TOOL</strong>
                <nui-badge variant="primary" class="tool-status">Pending</nui-badge>
            </div>
        </div>
    `;
    container?.appendChild(toolEl);
    scrollToBottom();
}

async function handleToolExecution(originalExchangeId, parsedObj, forcedChatId, origUserExchangeId = null, resumeStream = true) {
    console.log('[Tool Call Intercepted]', parsedObj);

    // Guard: Reject vision tool calls if MCP Vision is disabled
    const isVisionTool = parsedObj.name.toLowerCase().includes('vision_');
    const modelSupportsVision = currentModelSupportsVision();
    if (isVisionTool && modelSupportsVision && !useVisionAnalysis) {
        console.warn('[Tool Call Blocked] Vision tool called but MCP Vision is disabled:', parsedObj.name);
        // Treat as error - add error exchange and continue
        const toolChatId = forcedChatId || currentChatId;
        const toolConversation = activeConversations.get(toolChatId);
        const toolExchangeId = await toolConversation.addToolExchange(parsedObj.name, parsedObj.args, origUserExchangeId || originalExchangeId);
        const exchange = toolConversation.getExchange(toolExchangeId);
        exchange.tool.status = 'error';
        exchange.tool.content = 'Vision tools are disabled. The selected model supports native vision - images were sent directly to the model.';
        toolConversation.save();
        
        // Render error UI
        const toolContainer = getOrCreateContainer(toolChatId);
        const toolEl = document.createElement('div');
        toolEl.className = 'chat-message tool';
        toolEl.dataset.exchangeId = toolExchangeId;
        toolEl.dataset.mcpToolName = parsedObj.name;
        toolEl.innerHTML = `
            <div class="tool-bubble">
                <div class="message-header tool-header">
                    <nui-icon name="extension"></nui-icon>
                    <strong class="tool-title">SYSTEM TOOL: ${parsedObj.name}</strong>
                    <nui-badge variant="danger" class="tool-status">Blocked</nui-badge>
                </div>
                <div class="message-content tool-payload" style="display: block;">
                    <div class="tool-section-title">Error</div>
                    <div class="tool-result"><span class="tool-error">Vision tools are disabled. Images were sent directly to the model.</span></div>
                </div>
            </div>
        `;
        toolContainer?.appendChild(toolEl);
        
        // Continue with normal response (don't stream again, just finalize)
        return;
    }

    // Use forcedChatId if provided (passed from streamResponse which knows the correct chat),
    // otherwise fall back to currentChatId for backward compatibility
    const toolChatId = forcedChatId || currentChatId;
    // Use this specific chat's container for all DOM operations (not getActiveContainer which may be different if user switched tabs)
    const toolContainer = getOrCreateContainer(toolChatId);
    // Always use the conversation for toolChatId - it might differ from global `conversation` if user switched chats during an async operation
    const toolConversation = activeConversations.get(toolChatId);

    // Determine the original user exchange ID.
    // origUserExchangeId is passed from streamResponse when this is a chained tool continuation.
    // If not passed, originalExchangeId IS the user exchange ID (first tool in a user exchange).
    const userExchangeId = origUserExchangeId || originalExchangeId;

    // 1. Finalize the current assistant message
    const oldEx = toolConversation.getExchange(originalExchangeId);
    // oldEx could be undefined if the user switched chats and this exchange doesn't exist in the new chat's conversation
    if (!oldEx) {
        console.warn('[handleToolExecution] Original exchange not found, likely from a different chat context');
        return;
    }
    // Trim trailing whitespace
    oldEx.assistant.content = oldEx.assistant.content.trim();
    toolConversation.setAssistantComplete(originalExchangeId);

    let originalEl = toolContainer?.querySelector(`.chat-message.assistant[data-exchange-id="${originalExchangeId}"]`);
    if (originalEl) {
        updateAssistantContent(originalEl, oldEx.assistant.content, oldEx.assistant.reasoning_content);
    }

    const pendingEl = toolContainer?.querySelector(`.pending-tool-element[data-pending-exchange-id="${originalExchangeId}"]`);
    if (pendingEl) {
        pendingEl.remove();
    }

    // 2. Create the tool exchange (pass userExchangeId so chained tools know the original)
    const toolExchangeId = await toolConversation.addToolExchange(parsedObj.name, parsedObj.args, parsedObj.id, userExchangeId);
    const exchange = toolConversation.getExchange(toolExchangeId);

    // 3. Render Tool UI
    const toolEl = document.createElement('div');
    toolEl.className = 'chat-message tool';
    toolEl.dataset.exchangeId = toolExchangeId;
    toolEl.dataset.mcpToolName = parsedObj.name;

    // Build collapsible box UI
    toolEl.innerHTML = `
          <div class="tool-bubble">
              <div class="message-header tool-header">
                  <nui-icon name="extension"></nui-icon>
                  <strong class="tool-title">SYSTEM TOOL: ${parsedObj.name}</strong>
                  <nui-badge variant="primary" class="tool-status">Pending</nui-badge>
              </div>
              <div class="tool-notifications">
                  </div>
                  <div class="tool-images" style="display: none;"></div>
              <div class="message-content tool-payload" style="display: none;">
                  <div class="tool-section-title">Arguments</div>
                  <div class="tool-args">${jsonStringifyForDisplay(parsedObj.args)}</div>
                  <div class="tool-section-title">Execution Result</div>
                  <div class="tool-result"></div>
    `;

    toolContainer?.appendChild(toolEl);
    scrollToBottom();

// Toggle expand/collapse
    toolEl.querySelector('.message-header').addEventListener('click', (e) => {
        // Prevent toggle if clicking a button
        if (e.target.tagName.toLowerCase() === 'button' || e.target.closest('button')) return;
        const payloadBox = toolEl.querySelector('.tool-payload');
        payloadBox.style.display = payloadBox.style.display === 'none' ? 'block' : 'none';
    });

    // 4. Execute tool (local archive tools first, then MCP servers)
    try {
        const isLocalTool = LOCAL_TOOL_NAMES.has(parsedObj.name);
        const result = isLocalTool
            ? await executeLocalTool(parsedObj.name, parsedObj.args)
            : await mcpClient.executeTool(parsedObj.name, parsedObj.args, (progressParams) => {
                // Update UI on progress
            const { progress, total, message } = progressParams;
            let statusText = 'Running...';
            if (message) statusText = message;
            if (progress !== undefined) {
                statusText += ` (${progress}${total ? '/' + total : ''})`;
            }
            const notifEl = toolEl.querySelector('.tool-notifications');
            if (notifEl) {
                notifEl.style.display = 'block';
                notifEl.innerHTML = '<span class="tool-spinner"></span> ' + statusText;
            }
        }, toolChatId);

        exchange.tool.status = 'success';
        // Extract the actual content from MCP result structure
        // MCP result is { content: [{ type: 'text', text: '...' }] } or similar
        let resultText = '';
        const resultImages = [];
        const rawBase64Attachments = []; // Array to intercept blobs for the backend
        
        if (result && typeof result === 'object') {
            if (result.content && Array.isArray(result.content)) {
                resultText = result.content.map(c => {
                    if (c.type === 'text') return c.text;
                    if (c.type === 'image') {
                        const mime = c.mimeType || 'image/png';
                        if (c.data) {
                            const dataUrl = `data:${mime};base64,${c.data}`;
                            rawBase64Attachments.push({
                                name: `mcp_output_${Date.now()}.png`,
                                type: mime,
                                dataUrl: dataUrl
                            });
                            return '[Image Included in Output]';
                        } else if (c.url) {
                            // Image URL - store directly, will be rendered as img src
                            resultImages.push(c.url);
                            return '[Image Included in Output]';
                        }
                    }
                    return JSON.stringify(c);
                }).join('\n');
            } else if (result.text) {
                resultText = result.text;
            } else {
                resultText = JSON.stringify(result);
            }
        } else {
            resultText = String(result);
        }
        resultText = resultText.trim();
        exchange.tool.content = resultText;
        
        // Intercept massive base64 images generated by the tool and force them into nDB natively
        if (rawBase64Attachments.length > 0) {
            try {
                // Shoot the base64 up to the node API which writes to disk via nDB and returns `/api/buckets/images/...`
                const savedToolFiles = await imageStore.save(exchange.id, rawBase64Attachments);
                
                // For every image saved, push the lightweight backend URL instead of the base64 string
                savedToolFiles.forEach(f => resultImages.push(f.url));
            } catch (err) {
                console.error('Failed to intercept and upload MCP base64 image data to local bucket store', err);
                // Fallback to storing massive json blobs in browser storage if upload strictly fails
                rawBase64Attachments.forEach(att => resultImages.push(att.dataUrl));
            }
        }
        
        if (resultImages.length > 0) {
            exchange.tool.images = resultImages;
        }
        toolConversation.save(); // persist
        toolConversation._syncMessage('tool', resultText, null, exchange.id, {
            toolName: exchange.tool.name,
            toolArgs: exchange.tool.args,
            toolStatus: 'success',
            toolImages: exchange.tool.images || []
        });

        toolEl.querySelector('.tool-status').setAttribute('variant', 'success');
          toolEl.querySelector('.tool-status').innerHTML = 'Success';
          toolEl.querySelector('.tool-notifications').style.display = 'none';
        
        // Use textContent to prevent SVG/code examples from being parsed as HTML
        toolEl.querySelector('.tool-result').textContent = exchange.tool.content;
        
        if (exchange.tool.images && exchange.tool.images.length > 0) {
            const imagesDiv = toolEl.querySelector('.tool-images');
            imagesDiv.style.display = 'block';
            let imagesHtml = `<div class="tool-images-inner">`;
            exchange.tool.images.forEach(img => {
                imagesHtml += `<img src="${img}" class="tool-image" />`;
            });
            imagesHtml += `</div>`;
            imagesDiv.innerHTML = imagesHtml;
        }

        // 5. Automatically resume stream!
        // We will start a new pseudo-assistant stream using the toolExchangeId
        // The LLM will receive the shimmed 'user' message and continue generating
        // Ensure sessionId and model are correct so server routes continuation WS messages to this chat
        const toolChatInfo = chatHistory.get(toolChatId);
        if (toolChatInfo?.sessionId) {
            client.setSessionId(toolChatInfo.sessionId);
        }
        if (toolChatInfo?.model) {
            currentModel = toolChatInfo.model;
        }
        
        if (resumeStream) {
            await streamResponse(toolExchangeId, toolChatId, userExchangeId);
        }
        return toolExchangeId;
        
    } catch (err) {
        console.error('Tool execution error', err);
        exchange.tool.status = 'error';
        exchange.tool.content = err.message || String(err);
        toolConversation.save();
        toolConversation._syncMessage('tool', exchange.tool.content, null, exchange.id, {
            toolName: exchange.tool.name,
            toolArgs: exchange.tool.args,
            toolStatus: 'error'
        });

        toolEl.querySelector('.tool-status').setAttribute('variant', 'danger');
          toolEl.querySelector('.tool-status').innerHTML = 'Failed';
          toolEl.querySelector('.tool-notifications').style.display = 'none';
        toolEl.querySelector('.tool-result').innerHTML = `<span class="tool-error"></span>
            <div class="tool-error-actions">
                <nui-button size="small" class="retry-tool"><button>Retry</button></nui-button>
                <nui-button size="small" class="dismiss-tool"><button>Dismiss & Continue</button></nui-button>
            </div>
        `;
        toolEl.querySelector('.tool-result .tool-error').textContent = exchange.tool.content;
        toolEl.querySelector('.tool-payload').style.display = 'block'; // force open
        
        // Wire up retry/dismiss
        toolEl.querySelector('.retry-tool')?.addEventListener('click', () => {
            toolEl.querySelector('.tool-result').innerHTML = '';
            toolEl.querySelector('.tool-status').innerHTML = 'Pending';
            toolEl.querySelector('.tool-notifications').innerHTML = '<span class="tool-spinner"></span> Running...';
            toolEl.querySelector('.tool-status').setAttribute('variant', 'primary');
            handleToolExecution(originalExchangeId, parsedObj, toolChatId, origUserExchangeId, resumeStream);
        });
        
        toolEl.querySelector('.dismiss-tool')?.addEventListener('click', () => {
            // Dismiss tool implies just continuing without tool result
            // Ensure sessionId and model are correct so server routes continuation WS messages to this chat
            const dismissChatInfo = chatHistory.get(toolChatId);
            if (dismissChatInfo?.sessionId) {
                client.setSessionId(dismissChatInfo.sessionId);
            }
            if (dismissChatInfo?.model) {
                currentModel = dismissChatInfo.model;
            }
            if (resumeStream) {
                streamResponse(toolExchangeId, toolChatId, userExchangeId);
            }
            toolEl.querySelector('.dismiss-tool').parentElement.style.display = 'none';
        });
        
        if (!resumeStream) {
            return toolExchangeId;
        }
    }
}

function updateAssistantContent(el, content, reasoningContent = null) {
    const contentDiv = el.querySelector('.message-content');
    if (!contentDiv) return;

    let visibleContent = content;

    // Strip the injected timestamp from visible content (shown in header)
    if (el.dataset.timestampLen && visibleContent.startsWith('[')) {
        const len = parseInt(el.dataset.timestampLen);
        if (visibleContent.length >= len) {
            visibleContent = visibleContent.substring(len).trim();
        } else if (visibleContent.length < 20) {
            // Not enough content yet, likely still building up timestamp
            return;
        }
    } else if (visibleContent.startsWith('[')) {
        // Fallback: try to parse timestamp (for backwards compatibility)
        const tsParsed = parseTimestamp(visibleContent);
        visibleContent = tsParsed.cleanContent;
    }

    // Hide the entire assistant bubble if it's completely empty (or just contained the stripped TOOL_CALL)
    if (!visibleContent.trim() && (!reasoningContent || !reasoningContent.trim())) {
        el.style.display = 'none';
        // Note: we don't return here, so it updates the internal state in case it needs to re-appear later
    } else {
        el.style.display = '';
    }

    // Skip if content hasn't changed (prevents redundant renders during streaming)
    const rKey = reasoningContent || '';
    if (contentDiv.dataset.lastContent === visibleContent && contentDiv.dataset.lastReasoning === rKey) return;
    contentDiv.dataset.lastContent = visibleContent;
    contentDiv.dataset.lastReasoning = rKey;

    // Check if thinking-content is currently scrolled to bottom to maintain it
    let thinkingScrollTop = 0;
    let thinkingWasAtBottom = true;
    const oldThinkingContent = contentDiv.querySelector('.thinking-content');
    if (oldThinkingContent) {
        thinkingScrollTop = oldThinkingContent.scrollTop;
        const tolerance = 10;
        thinkingWasAtBottom = Math.abs(oldThinkingContent.scrollHeight - oldThinkingContent.scrollTop - oldThinkingContent.clientHeight) <= tolerance;
    }

    // Parse thinking and answer
    const parsed = parseThinking(visibleContent);
    
    // Explicit API reasoning_content overrides inline <think> tags
    if (reasoningContent) {
        parsed.thinking = reasoningContent;
        // if explicitly passed via API, the content doesn't have <think> tags so answer is just the content.
    }

    // Use the element's actual streaming state, not just whether <think> is open
    const isNetworkStreaming = el.dataset.isStreaming === 'true';

    // INCREMENTAL DOM UPDATE PATTERN:
    // Only create elements once, then update in place

    // === THINKING BLOCK ===
    const thinkingId = 'thinking-' + el.dataset.exchangeId;
    let thinkingBlock = contentDiv.querySelector('.thinking-block');

    if (parsed.thinking !== null) {

        if (!thinkingBlock) {
            // Create thinking block once - it doesn't exist yet
            thinkingBlock = document.createElement('div');
            thinkingBlock.className = 'thinking-block collapsed';
            thinkingBlock.id = thinkingId;
            thinkingBlock.innerHTML = `
                <div class="thinking-header" onclick="toggleThinking('${thinkingId}')">
                    <nui-icon name="lightbulb_2" aria-hidden="true"><svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false"><use href="/lib/nui_wc2/NUI/assets/material-icons-sprite.svg#image"></use></svg></nui-icon>
                    <span class="thinking-title">Thoughts</span>
                    <span class="thinking-toggle">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <polyline points="6 9 12 15 18 9"></polyline>
                        </svg>
                    </span>
                </div>
                <div class="thinking-content"></div>
            `;
            contentDiv.appendChild(thinkingBlock);
        }

        // Update existing thinking block state and content
        // Always stay collapsed by default - user manually expands if they want to see it
        if (parsed.isStreaming) {
            thinkingBlock.classList.add('streaming');
            const titleEl = thinkingBlock.querySelector('.thinking-title');
            if (titleEl) titleEl.textContent = 'Thinking...';
        } else {
            thinkingBlock.classList.remove('streaming');
            const titleEl = thinkingBlock.querySelector('.thinking-title');
            if (titleEl) titleEl.textContent = 'Thoughts';
        }

        // Update thinking content text - only this changes during streaming
        const thinkingContent = thinkingBlock.querySelector('.thinking-content');
        if (thinkingContent) {
            thinkingContent.textContent = parsed.thinking;
        }
    } else if (thinkingBlock) {
        // No thinking but element exists - could remove it, or leave for now
        // Keeping it preserves collapsed state if user interacted with it
    }

    // === ANSWER BLOCK ===
    // Track answer container for incremental updates
    let answerContainer = contentDiv.querySelector('.answer-container');

    if (parsed.answer) {
        if (!answerContainer) {
            // Create answer container once
            answerContainer = document.createElement('div');
            answerContainer.className = 'answer-container';
            contentDiv.appendChild(answerContainer);

            const nuiMd = document.createElement('nui-markdown');
            answerContainer.appendChild(nuiMd);
            answerContainer.dataset.lastAnswerLen = 0;
        }

        const nuiMd = answerContainer.querySelector('nui-markdown');
        if (nuiMd) {
            const currentAnswerLen = parseInt(answerContainer.dataset.lastAnswerLen || '0', 10);
            const newAnswerLen = parsed.answer.length;

            if (isNetworkStreaming) {
                if (!nuiMd._isStreaming) nuiMd.beginStream();
                if (newAnswerLen > currentAnswerLen) {
                    const chunk = parsed.answer.substring(currentAnswerLen);
                    nuiMd.appendChunk(chunk);
                    answerContainer.dataset.lastAnswerLen = newAnswerLen;
                }
            } else {
                if (nuiMd._isStreaming) {
                    // End of an active stream
                    if (newAnswerLen > currentAnswerLen) {
                        const chunk = parsed.answer.substring(currentAnswerLen);
                        nuiMd.appendChunk(chunk);
                    }
                    nuiMd.endStream();
                    answerContainer.dataset.lastAnswerLen = newAnswerLen;
                } else if (newAnswerLen > currentAnswerLen) {
                    // Complete message (e.g. from history load)
                    if (window.nui?.util?.markdownToHtml) {
                        nuiMd.innerHTML = window.nui.util.markdownToHtml(parsed.answer);
                        // Prevent automatic connectedCallback from double-parsing if appended to DOM later
                        nuiMd._isStreaming = true;
                    } else {
                        // Module not ready: rely on declarative markup that upgrades automatically later
                        const safeContent = parsed.answer.replace(/<\/script/gi, '<\\/script');
                        nuiMd.innerHTML = `<script type="text/markdown">\n${safeContent}\n</script>`;
                    }
                    answerContainer.dataset.lastAnswerLen = newAnswerLen;
                }
            }
        }
    }

    // Restore thinking-content scroll position
    const newThinkingContent = contentDiv.querySelector('.thinking-content');
    if (newThinkingContent) {
        if (thinkingWasAtBottom) {
            newThinkingContent.scrollTop = newThinkingContent.scrollHeight;
        } else {
            newThinkingContent.scrollTop = thinkingScrollTop;
        }
    }
}

window.toggleThinking = function(id) {
    const el = document.getElementById(id);
    if (el) {
        const isCollapsing = !el.classList.contains('collapsed');
        el.classList.toggle('collapsed');
        el.dataset.userToggled = 'true';  // Track that user manually toggled

        // When collapsing, scroll to bottom first so most recent thinking shows
        if (isCollapsing) {
            const content = el.querySelector('.thinking-content');
            if (content) {
                content.scrollTop = content.scrollHeight;
            }
        }
    }
};

function showCompactionIndicator(el, data) {
    const contentDiv = el.querySelector('.message-content');
    if (!contentDiv) return;
    
    let compactEl = contentDiv.querySelector('.compaction-indicator');
    if (!compactEl) {
        compactEl = document.createElement('div');
        compactEl.className = 'compaction-indicator';
        compactEl.innerHTML = '<span class="icon">ðŸ“</span> Compacting context...';
        contentDiv.insertBefore(compactEl, contentDiv.firstChild);
    }
}

function updateCompactionProgress(el, data) {
    // Could show progress bar here
}

function hideCompactionIndicator(el) {
    const compactEl = el.querySelector('.compaction-indicator');
    if (compactEl) {
        compactEl.remove();
    }
}

function showError(el, message) {
    const contentDiv = el.querySelector('.message-content');
    if (contentDiv) {
        contentDiv.innerHTML += `<div class="error-message">Error: ${escapeHtml(message)}</div>`;
    }
    
    // Hide streaming indicator
    const indicator = el.querySelector('.streaming-indicator');
    if (indicator) indicator.style.display = 'none';
}

function finalizeAssistantElement(el, exchangeId, usage = null, contextInfo = null) {
    el.dataset.isStreaming = 'false';
    // Hide streaming indicator
    const indicator = el.querySelector('.streaming-indicator');
    if (indicator) indicator.classList.remove('visible');

    // Update static usage text if we have it
    const exchange = conversation.getExchange(exchangeId);
    let finalUsage = usage || exchange?.assistant?.usage;
    let finalContext = contextInfo || exchange?.assistant?.context;
    
    // Fallback to the saved version data if we are loading from history
    if (!finalUsage && !finalContext && exchange?.assistant) {
        const curVersion = exchange.assistant.versions?.[exchange.assistant.currentVersion || 0];
        if (curVersion) {
             finalUsage = curVersion.usage;
             finalContext = curVersion.context;
        }
    }

    if (finalContext) {
        updateUsageDisplay(el, finalContext);
    } else if (exchange && exchange.assistant?.content) {
        // If we lack explicit context stats, fallback to a heuristic estimation if it's rendered in history
        const userContent = exchange.user ? (typeof exchange.user.content === 'string' ? exchange.user.content : '') : '';
        let assistantContent = typeof exchange.assistant.content === 'string' ? exchange.assistant.content : '';
        
        // Strip <think>...</think> blocks
        assistantContent = assistantContent.replace(/<think>[\s\S]*?<\/think>/g, '');
        
        const roughTokens = Math.ceil((userContent.length + assistantContent.length) / 4);
        updateUsageDisplay(el, { used_tokens: roughTokens, isEstimate: true });
    }

    // Show actions only if we have multiple versions or after regeneration
    const info = conversation.getVersionInfo(exchangeId);
    const actions = el.querySelector('.message-actions');
    if (actions && info?.hasMultiple) {
        actions.classList.add('visible');
        updateVersionControls(el, exchangeId);
        actions.querySelector('.speaker').style.display = 'inline-block';
    } else if (actions) {
        // Only show regenerate and speaker buttons initially
        actions.classList.add('visible');
        actions.querySelector('.regenerate').style.display = 'inline-block';
        actions.querySelector('.speaker').style.display = 'inline-block';
        actions.querySelector('.prev-version').style.display = 'none';
        actions.querySelector('.next-version').style.display = 'none';
        actions.querySelector('.version-info').style.display = 'none';
    }
    
    // Remove streaming class from thinking block
    const thinking = el.querySelector('.thinking-block.streaming');
    if (thinking) {
        thinking.classList.remove('streaming');
        thinking.querySelector('.thinking-title').textContent = 'Thinking';
    }
}

function updateVersionControls(el, exchangeId) {
    const info = conversation.getVersionInfo(exchangeId);
    if (!info) return;
    
    const infoEl = el.querySelector('.version-info');
    const prevBtn = el.querySelector('.prev-version');
    const nextBtn = el.querySelector('.next-version');
    const regenerateBtn = el.querySelector('.regenerate');
    
    // Show version info only when multiple versions exist
    if (info.hasMultiple) {
        if (infoEl) {
            infoEl.textContent = `${info.current}/${info.total}`;
            infoEl.style.display = 'inline-block';
        }
        if (prevBtn) prevBtn.style.display = 'inline-block';
        if (nextBtn) nextBtn.style.display = 'inline-block';
    } else {
        if (infoEl) infoEl.style.display = 'none';
        if (prevBtn) prevBtn.style.display = 'none';
        if (nextBtn) nextBtn.style.display = 'none';
    }
    
    // Always show regenerate
    if (regenerateBtn) regenerateBtn.style.display = 'inline-block';
    // Always show speaker
    const speakerBtn = el.querySelector('.speaker');
    if (speakerBtn) speakerBtn.style.display = 'inline-block';
}

// ============================================
// Actions
// ============================================

function getAssistantPlainText(exchangeId) {
    const exchange = conversation.getExchange(exchangeId);
    if (!exchange || !exchange.assistant) return '';
    let content = exchange.assistant.content || '';
    const parsed = parseTimestamp(content);
    content = parsed.cleanContent || content;
    return getPlainText(content);
}

function stopTts() {
    if (currentTtsAudio) {
        currentTtsAudio.pause();
        currentTtsAudio.src = '';
        currentTtsAudio.load();
        currentTtsAudio = null;
    }
    if (currentTtsExchangeId) {
        const el = document.querySelector(`.chat-message.assistant[data-exchange-id="${currentTtsExchangeId}"]`);
        if (el) {
            const speakerBtn = el.querySelector('.speaker');
            if (speakerBtn) {
                speakerBtn.classList.remove('playing');
                speakerBtn.setAttribute('title', 'Read Aloud');
                const icon = speakerBtn.querySelector('nui-icon');
                if (icon) icon.setAttribute('name', 'speaker');
            }
        }
        currentTtsExchangeId = null;
    }
}

function toggleTts(exchangeId, el) {
    if (currentTtsExchangeId === exchangeId) {
        stopTts();
        return;
    }

    stopTts();

    const text = getAssistantPlainText(exchangeId);
    if (!text) return;

    const url = `${ttsEndpoint}/tts?text=${encodeURIComponent(text)}&voice_name=${encodeURIComponent(ttsVoice)}&speed=${ttsSpeed}&output_format=mp3`;

    const audio = new Audio(url);
    audio.preload = 'auto';

    audio.onended = () => stopTts();
    audio.onerror = () => {
        console.warn('[TTS] Playback failed');
        stopTts();
    };

    currentTtsAudio = audio;
    currentTtsExchangeId = exchangeId;

    const speakerBtn = el.querySelector('.speaker');
    if (speakerBtn) {
        speakerBtn.classList.add('playing');
        speakerBtn.setAttribute('title', 'Stop Reading');
        const icon = speakerBtn.querySelector('nui-icon');
        if (icon) icon.setAttribute('name', 'close');
    }

    audio.play().catch((err) => {
        console.warn('[TTS] Playback error:', err.message);
        stopTts();
    });
}

async function regenerate(exchangeId) {
    if (client.hasActiveStream(currentChatId)) return;
    
    conversation.regenerateResponse(exchangeId);
    
    // Remove old assistant element
    const oldEl = document.querySelector(`.chat-message.assistant[data-exchange-id="${exchangeId}"]`);
    if (oldEl) {
        oldEl.querySelector('.message-content').innerHTML = '';
        oldEl.querySelector('.streaming-indicator').classList.add('visible');
        oldEl.querySelector('.message-actions').classList.remove('visible');
    }
    
    // Stream new response
    currentExchangeId = exchangeId;
    await streamResponse(exchangeId);
}

function switchVersion(exchangeId, direction) {
    const directionKey = direction === 'prev' ? 'prev' : 'next';
        if (conversation.switchVersion(exchangeId, directionKey)) {
        const exchange = conversation.getExchange(exchangeId);
        const el = document.querySelector(`.chat-message.assistant[data-exchange-id="${exchangeId}"]`);
        if (el) {
            updateAssistantContent(el, exchange.assistant.content, exchange.assistant.reasoning_content);
            updateVersionControls(el, exchangeId);
            finalizeAssistantElement(el, exchangeId);
        }
    }
}

async function copyMessageToClipboard(exchangeId, btn) {
    const exchange = conversation.getExchange(exchangeId);
    if (!exchange) return;
    
    // Always use assistant, but can be generic if needed
    const rawContent = exchange.assistant.content;
    const currentContent = parseTimestamp(rawContent).cleanContent;
    const parsed = parseThinking(currentContent);
    const mdToCopy = parsed.answer || currentContent;
    
    try {
        await navigator.clipboard.writeText(mdToCopy.trim());
        const icon = btn.querySelector('nui-icon');
        const oldIconName = icon.getAttribute('name');
        icon.setAttribute('name', 'check');
        setTimeout(() => icon.setAttribute('name', oldIconName), 2000);
    } catch (err) {
        console.error('Failed to copy text: ', err);
    }
}

async function startEditMode(exchangeId, role = 'user') {
    // Block editing only if this specific exchange in the current chat is currently streaming
    if (client.hasActiveStream(currentChatId) && currentExchangeId === exchangeId) return;

    const exchange = conversation.getExchange(exchangeId);
    if (!exchange) return;

    const rawContent = role === 'user' ? exchange.user.content : exchange.assistant.content;
    const currentContent = parseTimestamp(rawContent).cleanContent;

    const parsed = parseThinking(currentContent);
    // Even if it has thinking, we only edit the final parsed answer
    const editableContent = parsed.answer || currentContent;

    const contentHtml = `
        <div class="edit-dialog-container">
            <nui-rich-text class="edit-textarea"></nui-rich-text>
        </div>
    `;

    const { dialog, main, result } = await nui.components.dialog.page('Edit Message', contentHtml, {
        contentScroll: false, 
        buttons: [
            { label: 'Cancel', type: 'secondary', value: 'cancel' },
            { label: role === 'user' ? 'Save & Resubmit' : 'Save', type: 'primary', value: 'save' }
        ]
    });

    // Initialize content using standard NUI method on connected nodes
    const applyContent = () => {
        const tb = main.querySelector('nui-rich-text');
        if(tb && tb.setMarkdown) tb.setMarkdown(editableContent);
    };
    
    // Auto focus the appended textarea within the dialog
    const focusArea = main.querySelector('nui-rich-text');
    if (focusArea) {
        // give dialog time to mount
        setTimeout(() => {
            applyContent();
            // NuiRichText inner editor focus
            const editor = focusArea.querySelector('.nui-rich-text-editor');
            if (editor) editor.focus();
        }, 100);
    }

    const action = await result;

    if (action === 'save') {
        let newContent = main.querySelector('nui-rich-text')?.getMarkdown().trim() || '';
        
        // Ensure if there was original thinking we retain it unedited in the saved state, 
        // to not alter the local rendering of the history if they don't want to change the thinking.
        // Wait, the user said "Therefore the edit window should only edit the message, not the thinking portion." 
        // This implies we simply prepend the old thinking block if it existed before saving.
        if (parsed.thinking) {
            newContent = `<think>\n${parsed.thinking}\n</think>\n\n${newContent}`.trim();
        }

        if (newContent && newContent !== currentContent) {
            commitEdit(exchangeId, role, newContent);
        }
    }
}

function commitEdit(exchangeId, role, newContent) {
    const exchange = conversation.getExchange(exchangeId);
    if (!exchange) return;

    if (role === 'user') {
        // 1. Update content with timestamp
        const timestamp = conversation._formatTimestamp(new Date(exchange.timestamp));
        exchange.user.content = `${timestamp} ${newContent}`;

        // 2. Save and render - keep existing assistant response intact
        conversation.save();
        renderConversation();
    } else {
        // 1. Update content for assistant with timestamp
        const timestamp = conversation._formatTimestamp();
        const contentWithTimestamp = `${timestamp} ${newContent}`;
        exchange.assistant.content = contentWithTimestamp;

        // Update the current version to match
        if (exchange.assistant.versions && exchange.assistant.versions.length > 0) {
            const currentVersionObj = exchange.assistant.versions[exchange.assistant.currentVersion] || exchange.assistant.versions[0];
            if (currentVersionObj) {
                currentVersionObj.content = contentWithTimestamp;
            }
        }

        // 2. Truncate conversation downstream
        conversation.truncateAfter(exchangeId);

        // 3. Save manually since we aren't streaming
        conversation.save();

        // 4. Render wipes downstream
        renderConversation();
    }
}

// ============================================
// History Management
// ============================================

async function startNewChat() {
    // Note: we do NOT abort background streams when starting a new chat.
    // Each chat's stream continues in its hidden container.

    const newChatId = await chatHistory.create();
    currentChatId = newChatId;

    // Cache the new conversation
    conversation = new Conversation(`chat-conversation-${currentChatId}`);
    activeConversations.set(currentChatId, conversation);

    // Create container for the new chat (hidden until shown)
    const newContainer = getOrCreateContainer(currentChatId);

    // Toggle: show new chat, hide others
    for (const [id, container] of chatContainers.entries()) {
        container.style.display = id === currentChatId ? 'flex' : 'none';
    }

    renderHistoryList();
    renderConversation(); // container is empty, will show welcome

    // Auto-focus input
    setTimeout(() => {
        const textarea = elements.messageInput?.querySelector('textarea');
        if (textarea) textarea.focus();
    }, 100);
}

function restoreSystemPromptUI(chatInfo) {
    if (chatInfo && elements.systemPrompt) {
        const textarea = elements.systemPrompt.querySelector('textarea');
        if (textarea) {
            textarea.value = chatInfo.systemPrompt || '';
            // Reset preset selector
            const select = elements.presetSelect?.querySelector('select');
            if (select) select.value = '';
        }
    }
}

async function switchChat(targetChatId) {
    // Save current conversation before switching to ensure no data loss
    if (conversation) {
        await conversation.save();
    }
    
    currentChatId = targetChatId;
    storage.setActiveChatId(currentChatId).catch(() => {});

    // 1. Get or create the container for this chat (creates DOM node if first time)
    const targetContainer = getOrCreateContainer(targetChatId);

    // 2. Load conversation from cache or IndexedDB
    let conv = activeConversations.get(targetChatId);
    if (!conv) {
        conv = new Conversation(`chat-conversation-${targetChatId}`);
        await conv.load();
        activeConversations.set(targetChatId, conv);
    }
    conversation = conv;

    // 3. Sync session ID for the SDK
    const chatInfo = chatHistory.get(targetChatId);
    if (chatInfo?.sessionId) {
        client.setSessionId(chatInfo.sessionId);
    } else if (chatInfo) {
        const newSessionId = `sess-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
        chatHistory.updateSessionId(targetChatId, newSessionId);
        client.setSessionId(newSessionId);
    }

    // 4. Build historical DOM if this is the first time viewing this session
    if (targetContainer.children.length === 0) {
        await buildHistoricalDomForChat(conversation, targetContainer);
    }

    // 5. Toggle container visibility — all other streams continue in their hidden containers
    for (const [id, container] of chatContainers.entries()) {
        container.style.display = id === targetChatId ? 'flex' : 'none';
    }

    // Restore the system prompt
    restoreSystemPromptUI(chatInfo);

    // 6. Restore the model if saved in history
    if (chatInfo && elements.modelSelect) {
        if (chatInfo.model) {
            const modelExists = models.some(m => m.id === chatInfo.model);
            if (modelExists) {
                currentModel = chatInfo.model;
            } else if (models.length > 0) {
                currentModel = models[0].id;
            }
        } else if (models.length > 0) {
            currentModel = models[0].id;
        }

        if (elements.modelSelect.setValue) {
            elements.modelSelect.setValue(currentModel);
        } else {
            const select = elements.modelSelect.querySelector('select');
            if (select) select.value = currentModel;
        }
    }

    // 7. Update UI without wiping background containers
    renderHistoryList();
    updateOverallContext();

    // 8. Sync send button state with whether THIS chat has an active stream
    // The input area is shared across chats, so we must show correct state for the visible chat
    const targetChatIsStreaming = client.hasActiveStream(targetChatId);
    const btn = elements.sendBtn?.querySelector('button');
    if (btn) {
        btn.innerHTML = targetChatIsStreaming
            ? '<nui-icon name="close"></nui-icon>'
            : '<nui-icon name="send"></nui-icon>';
    }
}

async function deleteChat(chatId, e) {
    e.stopPropagation(); // prevent row click

    // Skip confirmation on shift-click
    const skipConfirm = e.shiftKey;

    if (!skipConfirm && !await nui.components.dialog.confirm('Delete Chat', 'Are you sure you want to delete this chat?')) {
        return;
    }

    // Delete images from imageStore for this chat
    try {
        const exchanges = await storage.loadConversation(chatId);
        for (const ex of exchanges) {
            await imageStore.delete(ex.id);
        }
    } catch (err) {
        console.warn('[Chat] Failed to delete images for chat', chatId, err);
    }

    // Delete from chat history (handles IndexedDB deletion)
    chatHistory.delete(chatId);

    // Abort any ongoing stream for this chat
    client.abortStream(chatId);

    // Clean up multi-conversation state
    activeConversations.delete(chatId);
    const container = chatContainers.get(chatId);
    if (container) {
        container.remove();
        chatContainers.delete(chatId);
    }

    // Immediately re-render the history list to reflect deletion
    renderHistoryList();

    if (currentChatId === chatId) {
        const allChats = chatHistory.getAll();
        if (allChats.length > 0) {
            await switchChat(allChats[0].id);
        } else {
            await startNewChat();
        }
    }
}

async function exportChatAsJson(chatId, btn) {
    // Export from in-memory conversation object (source of truth for current session state)
    const conv = activeConversations.get(chatId);
    const exchanges = conv ? conv.getAll() : [];
    if (!exchanges || exchanges.length === 0) return;

    try {
        const chatInfo = chatHistory.get(chatId);

        // Build complete exchange data, stripping tool args to avoid noise
        const exportExchanges = exchanges.map(ex => {
            if (ex.type === 'tool') {
                // Strip tool args/content from tool exchanges
                return {
                    id: ex.id,
                    type: ex.type,
                    timestamp: ex.timestamp,
                    tool: {
                        name: ex.tool?.name,
                        status: ex.tool?.status,
                        // args and content stripped for cleaner export
                    },
                    assistant: ex.assistant ? {
                        content: ex.assistant.content,
                        isComplete: ex.assistant.isComplete,
                        isStreaming: ex.assistant.isStreaming,
                        usage: ex.assistant.usage,
                        context: ex.assistant.context,
                    } : null,
                };
            }
            return {
                id: ex.id,
                type: ex.type,
                timestamp: ex.timestamp,
                user: ex.user ? {
                    content: ex.user.content,
                    attachments: ex.user.attachments,
                } : null,
                assistant: ex.assistant ? {
                    content: ex.assistant.content,
                    isComplete: ex.assistant.isComplete,
                    isStreaming: ex.assistant.isStreaming,
                    usage: ex.assistant.usage,
                    context: ex.assistant.context,
                } : null,
            };
        });

        const exportData = {
            chatId,
            chatInfo: {
                id: chatInfo?.id,
                title: chatInfo?.title,
                model: chatInfo?.model,
                sessionId: chatInfo?.sessionId,
                timestamp: chatInfo?.timestamp,
            },
            exchanges: exportExchanges,
        };

        const formattedJson = JSON.stringify(exportData, null, 2);
        navigator.clipboard.writeText(formattedJson).then(() => {
            if (btn) {
                const originalHtml = btn.innerHTML;
                btn.innerHTML = '<nui-icon name="check"></nui-icon>';
                setTimeout(() => {
                    btn.innerHTML = originalHtml;
                }, 2000);
            }
        }).catch(err => {
            console.error('Failed to copy JSON to clipboard', err);
        });
    } catch (e) {
        console.error('Failed to parse chat data', e);
    }
}

async function exportChatToFile(chatId) {
    // Full export including images - for backup/restore
    const exchanges = await storage.loadConversation(chatId);
    if (!exchanges || exchanges.length === 0) return;

    try {
        const exportData = {
            version: 1,
            exportedAt: new Date().toISOString(),
            chatId: chatId,
            chatInfo: chatHistory.get(chatId) || null,
            exchanges: []
        };
        
        // Load images for each exchange
        for (const ex of exchanges) {
            const exportExchange = { ...ex };
            
            if (ex.user?.attachments?.some(att => att.hasImage)) {
                const images = await imageStore.load(ex.id);
                exportExchange.user = {
                    ...ex.user,
                    attachments: await Promise.all(ex.user.attachments.map(async (att, idx) => {
                        const img = images[idx];
                        if (img) {
                            return {
                                ...att,
                                dataUrl: await img.getDataUrl() // Embed full image data
                            };
                        }
                        return att;
                    }))
                };
            }
            exportData.exchanges.push(exportExchange);
        }
        
        // Download as file
        const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const chatInfo = exportData.chatInfo;
        const title = chatInfo?.title ? chatInfo.title.replace(/[^a-z0-9]/gi, '_').toLowerCase() : 'chat';
        
        const a = document.createElement('a');
        a.href = url;
        a.download = `chat_export_${title}_${Date.now()}.json`;
        a.click();
        URL.revokeObjectURL(url);
        
    } catch (e) {
        console.error('Failed to export chat to file', e);
        nui.components.dialog.alert('Export Failed', 'Could not export chat session.');
    }
}

async function handleChatImport(e) {
    const file = e.target.files?.[0];
    if (!file) return;

    // Reset input so same file can be selected again
    e.target.value = '';

    try {
        const text = await file.text();
        const importData = JSON.parse(text);

        // Validate format
        if (!importData.exchanges || !Array.isArray(importData.exchanges)) {
            throw new Error('Invalid format: missing exchanges array');
        }

        // Create new chat via chatHistory
        const newChatId = await chatHistory.create();
        const title = importData.chatInfo?.title || 'Imported Chat';

        // Update metadata
        const meta = chatHistory.conversations.find(c => c.id === newChatId);
        if (meta) {
            meta.title = title;
            meta.model = importData.chatInfo?.model || '';
        }
        await chatHistory._saveList();

        // Process exchanges - save images to server, store URL references
        const processedExchanges = [];
        for (const ex of importData.exchanges) {
            const processedEx = { ...ex };

            if (ex.user?.attachments?.some(att => att.dataUrl)) {
                const attachmentImages = ex.user.attachments
                    .filter(att => att.dataUrl)
                    .map(att => ({
                        dataUrl: att.dataUrl,
                        name: att.name,
                        type: att.type
                    }));

                if (attachmentImages.length > 0) {
                    const savedFiles = await imageStore.save(ex.id, attachmentImages);
                    // Store server URL in dataUrl
                    processedEx.user = {
                        ...ex.user,
                        attachments: ex.user.attachments.map((att, idx) => ({
                            name: att.name,
                            type: att.type,
                            hasImage: true,
                            dataUrl: (savedFiles && savedFiles[idx]?.url) || att.dataUrl
                        }))
                    };
                } else {
                    processedEx.user = {
                        ...ex.user,
                        attachments: ex.user.attachments.map(att => ({
                            name: att.name,
                            type: att.type,
                            hasImage: att.hasImage || !!att.dataUrl
                        }))
                    };
                }
            }
            processedExchanges.push(processedEx);
        }

        // Save conversation to IndexedDB
        await storage.saveConversation(newChatId, processedExchanges);
        
        // Switch to imported chat
        renderHistoryList();
        await switchChat(newChatId);
        
        nui.components.toast?.success?.('Chat imported successfully');
        
    } catch (err) {
        console.error('Failed to import chat', err);
        nui.components.dialog.alert('Import Failed', `Could not import chat: ${err.message}`);
    }
}

async function exportChatAsMarkdown(chatId) {
    const exchanges = await storage.loadConversation(chatId);
    if (!exchanges || exchanges.length === 0) return;

    try {
        let md = "";

        const chatInfo = chatHistory.get(chatId);
        if (chatInfo) {
            md += `# ${chatInfo.title || 'Chat'}\n\n`;
            md += `*Model: ${chatInfo.model || 'Unknown'} | Date: ${new Date(chatInfo.timestamp).toLocaleString()}*\n\n---\n\n`;
        }

        for (const ex of exchanges) {
            md += `### User\n\n${ex.user.content}\n\n`;
            if (ex.assistant && ex.assistant.content) {
                md += `### Assistant\n\n${ex.assistant.content}\n\n`;
            }
            md += `---\n\n`;
        }

        const blob = new Blob([md], { type: 'text/markdown' });
        const url = URL.createObjectURL(blob);
        
        const title = chatInfo && chatInfo.title ? chatInfo.title.replace(/[^a-z0-9]/gi, '_').toLowerCase() : 'chat';
        
        const a = document.createElement('a');
        a.href = url;
        a.download = `chat_${title}_${chatId}.md`;
        a.click();
        URL.revokeObjectURL(url);
    } catch (e) {
        console.error("Failed to export markdown", e);
    }
}

function updateChatTitle(chatId, firstMessageContent) {
    const meta = chatHistory.conversations.find(c => c.id === chatId);
    if (meta && (meta.title === 'New Chat' || meta.title === 'Old Chat')) {
        meta.title = firstMessageContent.substring(0, 30) + (firstMessageContent.length > 30 ? '...' : '');
        meta._dirty = true;
        chatHistory._saveList();
        renderHistoryList();
    }
}

function updateChatModel(chatId, modelId) {
    const meta = chatHistory.conversations.find(c => c.id === chatId);
    if (meta && meta.model !== modelId) {
        meta.model = modelId;
        meta._dirty = true;
        chatHistory._saveList();
    }
}

function updateChatSystemPrompt(chatId, promptText) {
    const meta = chatHistory.conversations.find(c => c.id === chatId);
    if (meta && meta.systemPrompt !== promptText) {
        meta.systemPrompt = promptText;
        meta._dirty = true;
        chatHistory._saveList();
    }
}

// ============================================
// Sidebar Streaming Indicators
// ============================================

/**
 * Shows a pulsing indicator on a chat in the sidebar when it's streaming in the background.
 */
function markChatAsStreaming(chatId, isStreaming) {
    const item = elements.chatHistoryList?.querySelector(`[data-chat-id="${chatId}"]`);
    if (item) {
        item.classList.toggle('streaming', isStreaming);
    }
}

function renderHistoryList() {
    if (!elements.chatHistoryList) return;

    const allChats = chatHistory.getAll();

    elements.chatHistoryList.innerHTML = '';

    if (allChats.length === 0) {
        const emptyMsg = document.createElement('div');
        emptyMsg.style.padding = '1rem';
        emptyMsg.style.color = 'var(--color-shade5)';
        emptyMsg.style.fontSize = '0.875rem';
        emptyMsg.textContent = 'No previous chats.';
        elements.chatHistoryList.appendChild(emptyMsg);
        return;
    }

    allChats.forEach(chat => {
        const item = document.createElement('div');
        item.className = 'chat-history-item' + (chat.id === currentChatId ? ' active' : '');
        item.dataset.chatId = chat.id;

        const titleDiv = document.createElement('div');
        titleDiv.style.display = 'flex';
        titleDiv.style.alignItems = 'center';
        titleDiv.style.gap = '0.25rem';
        titleDiv.style.pointerEvents = 'none';

        if (chat.pinned) {
            const pinIcon = document.createElement('nui-icon');
            pinIcon.setAttribute('name', 'star_rate');
            pinIcon.style.fontSize = '0.875rem';
            pinIcon.style.color = 'var(--text-color-dim)';
            titleDiv.appendChild(pinIcon);
        }

        const titleSpan = document.createElement('span');
        titleSpan.className = 'chat-history-item-title';
        titleSpan.textContent = chat.title || 'New Chat';
        titleSpan.title = chat.title;
        titleSpan.style.flex = '1';
        titleSpan.style.overflow = 'hidden';
        titleSpan.style.textOverflow = 'ellipsis';
        
        titleDiv.appendChild(titleSpan);
        
        const actionsDiv = document.createElement('div');
        actionsDiv.className = 'chat-history-item-actions';
        
        const optionsBtn = document.createElement('nui-button');
        optionsBtn.className = 'chat-history-item-action';
        optionsBtn.innerHTML = '<button type="button"><nui-icon name="edit"></nui-icon></button>';
        optionsBtn.title = 'Chat Options';
        optionsBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            openChatOptions(chat.id);
        });
        
        actionsDiv.appendChild(optionsBtn);

        item.appendChild(titleDiv);
        item.appendChild(actionsDiv);
        
        item.addEventListener('click', () => switchChat(chat.id));
        elements.chatHistoryList.appendChild(item);
    });
}

function openChatOptions(chatId) {
    currentOptionsChatId = chatId;
    const chatMeta = chatHistory.conversations.find(c => c.id === chatId);
    if (!chatMeta) return;

    const dialog = document.getElementById('chat-options-dialog');
    const titleInput = document.getElementById('chat-options-title-input');
    const pinToggle = document.getElementById('chat-options-pin-toggle');
    const createdDateSpan = document.getElementById('chat-options-created-date');
    const updatedDateSpan = document.getElementById('chat-options-updated-date');
    const msgCountSpan = document.getElementById('chat-options-msg-count');
    
    titleInput.value = chatMeta.title || 'New Chat';
    pinToggle.checked = !!chatMeta.pinned;
    
    createdDateSpan.textContent = new Date(chatMeta.timestamp).toLocaleString();
    updatedDateSpan.textContent = new Date(chatMeta.updatedAt).toLocaleString();
    
    // Attempt async fetch of messages for length
    msgCountSpan.textContent = 'Counting...';
    storage.loadConversation(chatId).then(exchanges => {
        if (!exchanges) {
            msgCountSpan.textContent = '0';
            return;
        }
        let total = 0;
        exchanges.forEach(ex => {
            if (ex.user) total++;
            if (ex.assistant) total++;
            if (ex.tool) total++;
        });
        msgCountSpan.textContent = total.toString();
    }).catch(() => {
        msgCountSpan.textContent = 'Error';
    });
    
    dialog.showModal();
}

// ============================================

function updateSendButton() {
    const btn = elements.sendBtn?.querySelector('button');
    if (btn) {
        const chatIsStreaming = client.hasActiveStream(currentChatId);
        btn.innerHTML = chatIsStreaming
            ? '<nui-icon name="close"></nui-icon>'
            : '<nui-icon name="send"></nui-icon>';
    }
}

function abortStream() {
    // Abort only the active chat's stream, not background chats
    client.abortStream(currentChatId);
}

// ============================================
// File Attachments
// ============================================

function handleFileSelect(e) {
    const files = Array.from(e.target.files || []);

    for (const file of files) {
        if (!file.type.startsWith('image/')) continue;
        
        const reader = new FileReader();
        reader.onload = (event) => {
            attachedImages.push({
                dataUrl: event.target.result,
                name: file.name,
                type: file.type
            });
            addAttachmentPreview(event.target.result, file.name);
        };
        reader.readAsDataURL(file);
    }
    
    // Clear input so same file can be selected again
    e.target.value = '';
}

// ============================================
// Vision Capability Detection
// ============================================

function currentModelSupportsVision() {
    if (!currentModel) return false;
    const modelConfig = models.find(m => m.id === currentModel);
    const supportsVision = modelConfig?.capabilities?.vision === true;
    return supportsVision;
}

function updateVisionToggleVisibility() {
    const visionToggle = document.getElementById('vision-toggle-container');
    if (!visionToggle) return;
    
    const hasImages = attachedImages.length > 0;
    const visionToolsAvailable = areVisionToolsAvailable();
    const modelSupportsVision = currentModelSupportsVision();
    
    // Show toggle when:
    // - Images are attached AND
    // - Either vision tools are available OR model supports vision
    if (hasImages) {
        if (visionToolsAvailable || modelSupportsVision) {
            visionToggle.style.display = 'flex';
            
            const checkbox = visionToggle.querySelector('nui-checkbox');
            const input = visionToggle.querySelector('input');
            
            if (visionToolsAvailable && modelSupportsVision) {
                // Both available - user can choose
                input.disabled = false;
                checkbox.title = 'OFF: Send images directly to model | ON: Use MCP vision tools to pre-analyze images';
            } else if (modelSupportsVision) {
                // Only model supports vision - disable MCP vision (force OFF)
                input.disabled = true;
                input.checked = false;
                useVisionAnalysis = false;
                checkbox.title = 'Model supports vision - images will be sent directly';
            } else if (visionToolsAvailable) {
                // Only MCP vision available - force ON (model can't process images directly)
                input.disabled = true;
                input.checked = true;
                useVisionAnalysis = true;
                checkbox.title = 'Model does not support vision - MCP vision tools will analyze images';
            }
            
            // Update mode indicator
            updateVisionModeIndicator();
        } else {
            // No vision support at all
            visionToggle.style.display = 'none';
        }
    } else {
        visionToggle.style.display = 'none';
    }
}

function addAttachmentPreview(dataUrl, name) {
    const item = document.createElement('div');
    item.className = 'attachment-item';
    item.title = name;
    item.innerHTML = `
        <img src="${dataUrl}" alt="${name}">
        <button class="remove" title="Remove">&times;</button>
    `;
    
    // Remove button
    item.querySelector('.remove').addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = attachedImages.findIndex(img => img.dataUrl === dataUrl);
        if (idx > -1) attachedImages.splice(idx, 1);
        item.remove();
        updateVisionToggleVisibility();
    });
    
    // Lightbox click - open full image
    item.addEventListener('click', () => {
        if (nui.components?.lightbox) {
            nui.components.lightbox.show([{ src: dataUrl, title: name }], 0);
        }
    });
    
    elements.attachmentPreview?.appendChild(item);
    updateVisionToggleVisibility();
}

function clearAttachments() {
    attachedImages = [];
    useVisionAnalysis = false;
    if (elements.attachmentPreview) {
        elements.attachmentPreview.innerHTML = '';
    }
    updateVisionToggleVisibility();
}

// ============================================
// Gateway Status
// ============================================

async function checkGatewayStatus() {
    try {
        const data = await client.getHealth();

        if (data.status === 'ok') {
            elements.gatewayStatus?.classList.remove('offline');
        } else {
            elements.gatewayStatus?.classList.add('offline');
        }
    } catch (error) {
        elements.gatewayStatus?.classList.add('offline');
    }
}

// ============================================
// Theme Toggle
// ============================================

async function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme') || 'light';
    const next = current === 'dark' ? 'light' : 'dark';
    await setTheme(next);
}

async function setTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    await storage.setPref('theme', theme);

    // Also sync with NUI if available
    if (window.nui?.setTheme) {
        window.nui.setTheme(theme);
    }

    // Update color-scheme for native form elements
    document.documentElement.style.colorScheme = theme;
}

// ============================================
// Lightbox
// ============================================

function openLightbox(src) {
    elements.lightboxImage.src = src;
    elements.lightbox.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
}

function closeLightbox() {
    elements.lightbox.setAttribute('aria-hidden', 'true');
    elements.lightboxImage.src = '';
    document.body.style.overflow = '';
}

window.openLightbox = openLightbox;

// ============================================
// Timestamp Parsing
// ============================================

const TIMESTAMP_REGEX = /^\[(\d{4})-(\d{2})-(\d{2})@(\d{2}):(\d{2})\]\s*/;
const TIMESTAMP_REGEX_GLOBAL = /\[\d{4}-\d{2}-\d{2}@\d{2}:\d{2}\]\s*/g;

function parseTimestamp(content) {
    if (!content) return { timestamp: null, cleanContent: content };
    const match = content.match(TIMESTAMP_REGEX);
    if (match) {
        const [, year, month, day, hour, minute] = match;
        return {
            timestamp: `${year}-${month}-${day} @ ${hour}:${minute}`,
            cleanContent: content.replace(TIMESTAMP_REGEX, '')
        };
    }
    return { timestamp: null, cleanContent: content };
}

function stripExtraTimestamps(content) {
    // Keep the first timestamp (ours), remove any subsequent ones the LLM generates
    let first = true;
    return content.replace(TIMESTAMP_REGEX_GLOBAL, (match) => {
        if (first) {
            first = false;
            return match; // Keep first timestamp
        }
        return ''; // Remove subsequent timestamps
    });
}

// ============================================
// Utilities
// ============================================

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ============================================
// Base64 Sanitization for Display
// ============================================

/**
 * Detects if a string is base64-encoded data (typically images or binary)
 * Uses fast heuristics to avoid expensive regex on large strings
 */
function isBase64Data(str) {
    if (typeof str !== 'string' || str.length < 100) return false;
    
    // Fast path: check length first (base64 images are typically >1KB)
    if (str.length < 1000) return false;
    
    // Check for common image signatures (first few chars)
    const start = str.substring(0, 20);
    if (start.startsWith('/9j/') ||           // JPEG
        start.startsWith('iVBOR') ||          // PNG  
        start.startsWith('R0lGOD') ||         // GIF
        start.startsWith('UEsDB') ||          // Binary/Zip
        start.startsWith('JVBERi0') ||        // PDF
        start.startsWith('Qk')) {             // BMP
        return true;
    }
    
    // Fallback: check if it looks like base64 (long alphanumeric + /+)
    // Only check first 100 chars for performance
    const sample = str.substring(0, 100);
    return /^[A-Za-z0-9+/]{100}/.test(sample);
}

/**
 * Sanitizes an object for display by replacing base64 data with placeholders
 * Recursively processes nested objects and arrays
 * @param {*} value - Value to sanitize
 * @returns {*} Sanitized value safe for JSON.stringify
 */
function sanitizeForDisplay(value) {
    if (value === null || value === undefined) return value;
    
    if (typeof value === 'string') {
        if (isBase64Data(value)) {
            return `[BASE64_DATA](${value.length} chars)`;
        }
        return value;
    }
    
    if (Array.isArray(value)) {
        return value.map(item => sanitizeForDisplay(item));
    }
    
    if (typeof value === 'object') {
        const sanitized = {};
        for (const [key, val] of Object.entries(value)) {
            sanitized[key] = sanitizeForDisplay(val);
        }
        return sanitized;
    }
    
    return value;
}

/**
 * Safe JSON.stringify that sanitizes base64 data first
 * Use this for UI display to avoid freezing on large base64 strings
 */
function jsonStringifyForDisplay(obj, space = 2) {
    const sanitized = sanitizeForDisplay(obj);
    return JSON.stringify(sanitized, null, space);
}

function scrollToBottom() {
    const container = getActiveContainer();
    if (container) {
        container.scrollTop = container.scrollHeight;
    }
}

function isNearBottom(threshold = 100) {
    const container = getActiveContainer();
    if (!container) return true;
    const { scrollTop, scrollHeight, clientHeight } = container;
    return scrollHeight - scrollTop - clientHeight < threshold;
}

// ============================================
// PHASE-2: MCP Configuration UI Layer
// ============================================

function initMCP() {
    // Set up global callback for MCP client to refresh UI when tools are loaded
    window.refreshMCPServersUI = () => renderMCPServers();
    
    // 1. Initial render
    renderMCPServers();

    // 2. Wire up 'Add Server' button
    if (elements.mcpAddBtn) {
        elements.mcpAddBtn.addEventListener('click', async () => {
            const nameInput = elements.mcpServerName.querySelector('input');
            const urlInput = elements.mcpServerUrl.querySelector('input');
            const name = nameInput.value.trim();
            const url = urlInput.value.trim();
            if (!name || !url) return alert('Name and URL are required');
            
            mcpClient.addServer(url, name);
            nameInput.value = '';
            urlInput.value = '';
            renderMCPServers();
            
            // Auto connect the newly added one
            const server = mcpClient.servers[mcpClient.servers.length - 1];
            try {
                await mcpClient.connectToServer(server);
            } catch (e) {
                console.error("Auto-connect failed", e);
            }
            renderMCPServers();
        });
    }

    // 3. Connect existing offline servers on load
    mcpClient.servers.forEach(async (server) => {
        if (server.status === 'disconnected') {
            try {
                await mcpClient.connectToServer(server);
                renderMCPServers();
            } catch (e) {
                renderMCPServers();
            }
        }
    });

    // 4. Debug Logs
    if (elements.mcpLogsBtn) {
        elements.mcpLogsBtn.addEventListener('click', () => {
            elements.mcpLogsDialog.showModal();
        });
    }
    if (elements.mcpLogsClearBtn) {
        elements.mcpLogsClearBtn.addEventListener('click', () => {
            if(elements.mcpLogsTextarea) {
                elements.mcpLogsTextarea.value = '';
            }
        });
    }

    mcpClient.onLog = (logMsg) => {
        if (elements.mcpLogsTextarea) {
            elements.mcpLogsTextarea.value += logMsg;
            // auto-scroll
            elements.mcpLogsTextarea.scrollTop = elements.mcpLogsTextarea.scrollHeight;
        }
    };
}

function renderMCPServers() {
    if (!elements.mcpServersList) return;
    elements.mcpServersList.innerHTML = ''; // basic clear

    mcpClient.servers.forEach(server => {
        const card = document.createElement('nui-card');
        card.className = "mcp-server-card";
        
        let badgeVariant = '';
          if (server.status === 'connected') badgeVariant = 'success';
          if (server.status === 'error') badgeVariant = 'danger';
          if (server.status === 'connecting...') badgeVariant = 'warning';

        const isConnected = server.status === 'connected';
        
        const enabledToolsMap = mcpClient.enabledTools.get(server.id);
        let activeCount = 0;
        let totalCount = server.tools ? server.tools.length : 0;
        if (server.tools && enabledToolsMap) {
            server.tools.forEach(t => {
                if (enabledToolsMap.get(t.name)) {
                    activeCount++;
                }
            });
        }

        let html = `
            <div class="mcp-server-inner">
                <!-- Header: Title and Toggle -->
                <div class="mcp-server-header">
                    <h3 class="mcp-server-title">${server.name}</h3>
                    <nui-checkbox variant="switch" title="Connect/Disconnect"><input type="checkbox" data-mcp-status-toggle="${server.id}" ${isConnected ? 'checked' : ''} ${(server.status === 'connecting...') ? 'disabled' : ''}></nui-checkbox>
                </div>

                <!-- Status Badge -->
                <div class="mcp-server-status-row">
                    <nui-badge variant="${badgeVariant}" class="mcp-server-status-badge">
                        <span class="mcp-server-status-dot">&#11044;</span> ${isConnected ? 'connected (' + activeCount + '/' + totalCount + ' active)' : server.status}
                    </nui-badge>
                  </div>

                  <!-- Bottom Actions -->
                <div class="mcp-server-actions">
                    <nui-button variant="icon" title="Edit Server" data-mcp-edit="${server.id}">
                        <button type="button" aria-label="Edit">
                            <nui-icon name="edit"></nui-icon>
                        </button>
                    </nui-button>
                    <nui-button variant="icon" title="Remove Server" data-mcp-remove="${server.id}">
                        <button type="button" aria-label="Remove">
                            <nui-icon name="delete"></nui-icon>
                        </button>
                    </nui-button>
                </div>
            </div>
        `;

        card.innerHTML = html;

        // Wire Event Listeners
        const removeBtn = card.querySelector('[data-mcp-remove]');
        if(removeBtn) {
            removeBtn.addEventListener('click', () => {
                mcpClient.removeServer(server.id);
                renderMCPServers();
            });
        }

        const editBtn = card.querySelector('[data-mcp-edit]');
        if (editBtn) {
            editBtn.addEventListener('click', () => {
                openMCPEditDialog(server);
            });
        }

        const toggle = card.querySelector(`nui-checkbox`);
        if (toggle) {
            toggle.addEventListener('nui-change', (e) => {
                if (e.detail.checked) {
                    mcpClient.connectToServer(server).catch(err => {
                        console.error("Connect failed", err);
                        renderMCPServers();
                    });
                } else {
                    mcpClient.disconnectServer(server.id);
                }
                renderMCPServers();
            });
        }

        elements.mcpServersList.appendChild(card);
    });
}

function openMCPEditDialog(server) {
    const dialog = document.getElementById('mcp-edit-dialog');
    if (!dialog) return;

    dialog.setAttribute('title', server.name);
    document.getElementById('mcp-edit-url').value = server.url;
    
    const toolsContainer = document.getElementById('mcp-edit-tools-container');
    toolsContainer.innerHTML = '';

    if (!server.tools || server.tools.length === 0) {
        toolsContainer.innerHTML = `<p class="mcp-empty-tools">No tools available. Connect the server to load tools.</p>`;
    } else {
        server.tools.forEach(tool => {
            const isEnabled = mcpClient.enabledTools.get(server.id)?.get(tool.name) ?? false;
            const toolEl = document.createElement('label');
            toolEl.style.cssText = 'display: flex; align-items: flex-start; gap: 0.75rem; padding: 0.5rem 0; border-bottom: 1px solid var(--color-shade2); cursor: pointer;';

            const nuiCheckbox = document.createElement('nui-checkbox');
            nuiCheckbox.innerHTML = `<input type="checkbox" data-mcp-toggle="${server.id}" data-mcp-tool="${tool.name}">`;
            const input = nuiCheckbox.querySelector('input');
            if (isEnabled) input.checked = true;

            toolEl.appendChild(nuiCheckbox);
            const textDiv = document.createElement('div');
            textDiv.style.cssText = 'display: flex; flex-direction: column; gap: 0.25rem;';
            textDiv.innerHTML = `
                <span class="mcp-tool-name">${tool.name}</span>
                <span class="mcp-tool-desc">${tool.description || 'No description available.'}</span>
            `;
            toolEl.appendChild(textDiv);

            nuiCheckbox.addEventListener('nui-change', (e) => {
                mcpClient.setToolEnabled(server.id, tool.name, e.detail.checked);
                renderMCPServers();
            });
            
            toolsContainer.appendChild(toolEl);
        });
    }

    dialog.showModal();
}

function setupDialogEventListeners() {
    document.getElementById('chat-options-rename-btn')?.addEventListener('click', () => {
        if (!currentOptionsChatId) return;
        const titleInput = document.getElementById('chat-options-title-input');
        const newTitle = titleInput.value.trim();
        if (newTitle) {
            const chatMeta = chatHistory.conversations.find(c => c.id === currentOptionsChatId);
            if (chatMeta) {
                chatMeta.title = newTitle;
                chatMeta._dirty = true;
                chatHistory._saveList();
                renderHistoryList();
                const renameBtn = document.getElementById('chat-options-rename-btn');
                renameBtn.setLoading(true);
                setTimeout(() => {
                    renameBtn.setLoading(false);
                }, 1500);
            }
        }
    });

    document.getElementById('chat-options-pin-toggle')?.addEventListener('change', (e) => {
        if (!currentOptionsChatId) return;
        const chatMeta = chatHistory.conversations.find(c => c.id === currentOptionsChatId);
        if (chatMeta) {
            chatMeta.pinned = e.target.checked;
            chatMeta._dirty = true;
            chatHistory._saveList();
            renderHistoryList();
        }
    });

    document.getElementById('chat-options-clone-btn')?.addEventListener('click', async () => {
        if (!currentOptionsChatId) return;
        const chatMeta = chatHistory.conversations.find(c => c.id === currentOptionsChatId);
        const exchanges = await storage.loadConversation(currentOptionsChatId);
        if (!chatMeta || !exchanges) return;

        const newId = chatHistory._generateId();
        const cloneMeta = {
            ...chatMeta,
            id: newId,
            title: `Copy of ${chatMeta.title || 'Chat'}`,
            timestamp: Date.now(),
            updatedAt: Date.now()
        };
        
        chatHistory.conversations.unshift(cloneMeta);
        chatHistory._saveList();
        
        // Rewrite exchange IDs slightly or retain them (retaining is fine since they are scoped per chat ID)
        await storage.saveConversation(newId, exchanges);
        
        renderHistoryList();
        document.getElementById('chat-options-dialog')?.close();
        await switchChat(newId);
        nui.components.toast?.success?.('Chat cloned successfully');
    });

    document.getElementById('chat-options-copy-json')?.addEventListener('click', (e) => {
        if (!currentOptionsChatId) return;
        exportChatAsJson(currentOptionsChatId, e.currentTarget);
    });

    document.getElementById('chat-options-save-json')?.addEventListener('click', () => {
        if (!currentOptionsChatId) return;
        exportChatToFile(currentOptionsChatId);
    });

    document.getElementById('chat-options-save-md')?.addEventListener('click', () => {
        if (!currentOptionsChatId) return;
        exportChatAsMarkdown(currentOptionsChatId);
    });

    document.getElementById('chat-options-delete')?.addEventListener('click', (e) => {
        if (!currentOptionsChatId) return;
        deleteChat(currentOptionsChatId, e);
        document.getElementById('chat-options-dialog')?.close();
    });
}

// ============================================
// Start
// ============================================

init();























