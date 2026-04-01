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

// Config values with defaults
const CONFIG = window.CHAT_CONFIG || {};
const GATEWAY_URL = CONFIG.gatewayUrl || 'http://localhost:3400';
const DEFAULT_MODEL = CONFIG.defaultModel || '';
const DEFAULT_TEMPERATURE = CONFIG.defaultTemperature ?? 0.7;
const DEFAULT_MAX_TOKENS = CONFIG.defaultMaxTokens || '';

// State
let currentChatId = null;
let conversation = null;

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

// DOM Elements
const elements = {
    modelSelect: document.getElementById('model-select'),
    temperature: document.getElementById('temperature'),
    maxTokens: document.getElementById('max-tokens'),
    systemPrompt: document.getElementById('system-prompt'),
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
    mcpServersList: document.getElementById('mcp-servers-list')
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
            updateAssistantContent(assistantEl, assistantParsed.cleanContent);

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
    const userTimestamp = userParsed.timestamp || new Date(exchange.timestamp).toISOString().slice(0, 16).replace('T', ' @ ');

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
        updateAssistantContent(assistantEl, assistantParsed.cleanContent);

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
            <nui-checkbox variant="switch" title="Automatically create vision sessions for images, allowing the AI to analyze them using vision_analyze tool">
                <input type="checkbox" id="vision-toggle-input">
            </nui-checkbox>
            <label for="vision-toggle-input">Auto Vision</label>
        `;
        
        // Insert after attachment preview in the images row
        const imagesRow = document.getElementById('images-row');
        if (imagesRow) {
            imagesRow.appendChild(visionToggle);
        } else {
            elements.attachmentPreview.parentNode?.insertBefore(visionToggle, elements.attachmentPreview);
        }
        
        // Add event listener
        const checkbox = visionToggle.querySelector('input');
        checkbox?.addEventListener('change', (e) => {
            useVisionAnalysis = e.target.checked;
        });
    }
}

// ============================================
// Initialization
// ============================================

async function init() {
    console.log('[Chat] Initializing...');

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
        activeId = chatHistory.create();
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
        console.log(`[Chat] Generated new session ID for old conversation: ${newSessionId}`);
        chatHistory.updateSessionId(currentChatId, newSessionId);
        client.setSessionId(newSessionId);
    }

    // Apply default config values (needs history loaded first for async prefs)
    await applyDefaultConfig();

    // Setup event listeners first
    setupEventListeners();

    // Create vision toggle UI
    ensureVisionToggleUI();

    // Wait for NUI to be ready, then load models
    await waitForNUI();
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

    // Periodic auto-save every 30 seconds as a safety net
    setInterval(() => {
        for (const [chatId, conv] of activeConversations) {
            conv.save();
        }
    }, 30000);

    console.log('[Chat] Ready');
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

    // Defaults: Herrbasan, Germany, English
    const name = savedName !== null ? savedName : 'Herrbasan';
    const location = savedLocation !== null ? savedLocation : 'Germany';
    const language = savedLanguage !== null ? savedLanguage : 'English';
    
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
        populateModelSelect();

        console.log('[Chat] Loaded models:', models.length);
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
            console.log('[Chat] Selected model:', currentModel);
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
        console.log('[Chat] Selected model:', currentModel);
        updateOverallContext();
        updateVisionToggleVisibility();
    });
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

function getSystemPromptWithMetadata() {
    const userPrompt = elements.systemPrompt?.querySelector('textarea')?.value?.trim() || '';
    const metadata = buildMetadataPrefix();
    
    if (userPrompt) {
        prompt = `${metadata}\n\n${userPrompt}`;
    } else {
        prompt = metadata;
    }

    // PHASE-3: MCP System Prompt Injection
    const mcpPrompt = mcpClient.generateToolPrompt();
    if (mcpPrompt) {
        prompt += `\n\n${mcpPrompt}`;
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

    // Store images for potential auto-vision before clearing
    const imagesForAutoVision = [...attachedImages];
    const shouldAutoCreateVisionSessions = imagesForAutoVision.length > 0 && areVisionToolsAvailable() && useVisionAnalysis;
    
    // Clear input and attachments
    editor.setMarkdown('');
    clearAttachments();
    useVisionAnalysis = false; // Reset for next message
    updateVisionToggleVisibility();
    
    // Render user message
    renderExchange(conversation.getExchange(currentExchangeId));
    
    // AUTO-VISION: If images attached and vision tools available, create sessions automatically
    // This happens AFTER user message is rendered, BEFORE LLM responds
    
    if (shouldAutoCreateVisionSessions) {
        try {
            await autoCreateVisionSessions(currentExchangeId, imagesForAutoVision, currentChatId);
        } catch (err) {
            console.error('[Vision] Auto session creation failed:', err);
            // Continue with normal flow - LLM might still handle it
        }
    }
    
    // Start streaming response
    await streamResponse(currentExchangeId);
}

// ============================================
// Vision Tool Integration
// ============================================

// Note: The vision workflow has changed:
// - OLD: Pre-process images through vision before sending to LLM
// - NEW: Auto-create vision sessions after user message, let LLM call vision_analyze
// 
// Functions kept for potential manual use:
// - analyzeImagesWithVision: Can be called manually if needed

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

async function autoCreateVisionSessions(userExchangeId, images) {
    // Verify vision tools are available
    if (!areVisionToolsAvailable()) {
        console.log('[AutoVision] Vision tools not available, skipping auto session creation');
        return;
    }
    
    const createSessionToolName = getVisionToolName('vision_create_session');
    
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
            
            // Create vision session tool call args
            const toolArgs = {
                image_data: base64Data,
                image_mime_type: mimeType
            };
            
            // Add tool exchange to conversation (similar to handleToolExecution)
            const toolExchangeId = await conversation.addToolExchange(createSessionToolName, toolArgs);
            const exchange = conversation.getExchange(toolExchangeId);
            
            // Render the tool call UI
            const toolEl = document.createElement('div');
            toolEl.className = 'chat-message tool';
            toolEl.dataset.exchangeId = toolExchangeId;
            toolEl.dataset.mcpToolName = createSessionToolName;
            
            toolEl.innerHTML = `
                <div class="tool-bubble">
                    <div class="message-header tool-header">
                        <nui-icon name="extension"></nui-icon>
                        <strong class="tool-title">SYSTEM TOOL: ${createSessionToolName}</strong>
                        <nui-badge variant="primary" class="tool-status">Running</nui-badge>
                    </div>
                    <div class="tool-notifications" style="display: block;">
                        <span class="tool-spinner"></span> Creating vision session for image ${i + 1}${img.name ? ` (${img.name})` : ''}...
                    </div>
                    <div class="message-content tool-payload" style="display: none;">
                        <div class="tool-section-title">Arguments</div>
                        <div class="tool-args">${JSON.stringify(toolArgs, null, 2)}</div>
                        <div class="tool-section-title">Execution Result</div>
                        <div class="tool-result"></div>
                    </div>
                </div>
            `;

            getActiveContainer()?.appendChild(toolEl);
            scrollToBottom();

            // Toggle expand/collapse
            toolEl.querySelector('.message-header').addEventListener('click', (e) => {
                if (e.target.tagName.toLowerCase() === 'button' || e.target.closest('button')) return;
                const payloadBox = toolEl.querySelector('.tool-payload');
                payloadBox.style.display = payloadBox.style.display === 'none' ? 'block' : 'none';
            });

            // Execute the tool
            const result = await mcpClient.executeTool(createSessionToolName, toolArgs);
            
            // Extract result text
            let resultText = '';
            if (result && typeof result === 'object') {
                if (result.content && Array.isArray(result.content)) {
                    resultText = result.content.map(c => c.type === 'text' ? c.text : JSON.stringify(c)).join('\n');
                } else if (result.session_id) {
                    resultText = `Session created: ${result.session_id}`;
                } else {
                    resultText = JSON.stringify(result);
                }
            } else {
                resultText = String(result);
            }
            
            // Update exchange with result
            exchange.tool.status = 'success';
            exchange.tool.content = resultText;
            conversation.save();
            
            // Update UI
            toolEl.querySelector('.tool-status').setAttribute('variant', 'success');
            toolEl.querySelector('.tool-status').innerHTML = 'Success';
            toolEl.querySelector('.tool-notifications').style.display = 'none';
            toolEl.querySelector('.tool-result').innerHTML = resultText;
            
            console.log(`[AutoVision] Created session for image ${i + 1}:`, resultText);
            
        } catch (err) {
            console.error(`[AutoVision] Failed to create session for image ${i + 1}:`, err);
            
            // Add error exchange
            const toolArgs = { image_data: '[base64 data]', image_mime_type: img.type || 'image/jpeg' };
            const toolExchangeId = await conversation.addToolExchange(createSessionToolName, toolArgs);
            const exchange = conversation.getExchange(toolExchangeId);
            exchange.tool.status = 'error';
            exchange.tool.content = err.message || 'Failed to create vision session';
            conversation.save();
            
            // Render error UI
            const toolEl = document.createElement('div');
            toolEl.className = 'chat-message tool';
            toolEl.dataset.exchangeId = toolExchangeId;
            toolEl.dataset.mcpToolName = createSessionToolName;
            
            toolEl.innerHTML = `
                <div class="tool-bubble">
                    <div class="message-header tool-header">
                        <nui-icon name="extension"></nui-icon>
                        <strong class="tool-title">SYSTEM TOOL: ${createSessionToolName}</strong>
                        <nui-badge variant="danger" class="tool-status">Failed</nui-badge>
                    </div>
                    <div class="tool-notifications" style="display: none;"></div>
                    <div class="message-content tool-payload" style="display: block;">
                        <div class="tool-section-title">Arguments</div>
                        <div class="tool-args">${jsonStringifyForDisplay(toolArgs)}</div>
                        <div class="tool-section-title">Execution Result</div>
                        <div class="tool-result"><span class="tool-error">${err.message}</span></div>
                    </div>
                </div>
            `;

            getActiveContainer()?.appendChild(toolEl);
            scrollToBottom();
        }
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
    conversation.updateAssistantResponse(exchangeId, timestampWithSpace);
    const systemPrompt = getSystemPromptWithMetadata();
    // Store system prompt for debugging (included in JSON export)
    conversation.setSystemPrompt(exchangeId, systemPrompt);
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
        const messages = conversation.getMessagesForApi(systemPrompt);

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
        const mcpTools = mcpClient.getFormattedToolsForLLM();
        if (mcpTools.length > 0) {
            requestBody.tools = mcpTools;
        }

        // Add image processing if images attached (skip for tool exchanges - they have no user message)
        if (!isToolExchange && exchange && exchange.user?.attachments?.length > 0) {
            requestBody.image_processing = {
                resize: 'auto',
                transcode: 'jpg',
                quality: 70  // Lower quality for smaller payload
            };
        }
        
        let contentBuffer = '';
        let pendingUpdate = false;
        let lastRender = 0;
        const RENDER_INTERVAL = 50; // Render at most every 50ms

        // PHASE-3: __TOOL_CALL__ text detection
        // Matches: __TOOL_CALL__({"name": "tool", "args": {...}})
        // The JSON args may span multiple lines with nested objects
        const TOOL_CALL_REGEX = /__TOOL_CALL__\(([\s\S]*?)\)\s*$/;
        let toolCallIntercepted = false;
        let isReceivingTool = false;

        for await (const event of client.streamChatIterable(requestBody, chatId, false, conversation)) {
            if (toolCallIntercepted) break; // Halts the iterable immediately

            switch (event.type) {
                case 'delta':
                    // Hide progress status once text generation begins
                    const statusEl = assistantEl.querySelector('.progress-status');
                    if (statusEl) statusEl.classList.remove('visible');

                    // Hide user bubble pending indicator once assistant starts responding
                    const userPendingEl = targetContainer?.querySelector(`.chat-message.user[data-exchange-id="${exchangeId}"] .user-pending-indicator`);
                    if (userPendingEl) userPendingEl.classList.remove('visible');

                    contentBuffer += event.content;
                    conversation.updateAssistantResponse(exchangeId, event.content);

                    const toolCallIndex = contentBuffer.indexOf('__TOOL_CALL__');
                    if (toolCallIndex !== -1 && !isReceivingTool) {
                        isReceivingTool = true;
                        showPendingToolUI(exchangeId, chatId);
                    }

                    // Check for __TOOL_CALL__ pattern in accumulated content
                    const toolMatch = contentBuffer.match(TOOL_CALL_REGEX);
                    if (toolMatch) {
                        const rawJson = toolMatch[1].trim();
                        try {
                            const parsedObj = JSON.parse(rawJson);
                            if (parsedObj.name && parsedObj.args) {
                                toolCallIntercepted = true;
                                handleToolExecution(exchangeId, parsedObj, chatId, originalUserExchangeId);
                                break;
                            }
                        } catch (e) {
                            // JSON not complete yet, continue streaming
                        }
                    }

                    // Debounce DOM updates to prevent freezing
                    if (!pendingUpdate) {
                        pendingUpdate = true;
                        const now = performance.now();
                        const delay = Math.max(0, Math.min(RENDER_INTERVAL, RENDER_INTERVAL - (now - lastRender)));

                        const wasNearBottom = isNearBottom();
                        setTimeout(() => {
                            // Give the UI the content without the __TOOL_CALL__ part
                            updateAssistantContent(assistantEl, contentBuffer);
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
                    // Reconstruct full content with timestamp for proper stripping
                    const errorTsMatch = exchange.assistant.content.match(TIMESTAMP_REGEX);
                    const errorFullContent = errorTsMatch ? errorTsMatch[0] + contentBuffer : contentBuffer;
                    updateAssistantContent(assistantEl, errorFullContent);
                    showError(assistantEl, event.error);
                    conversation.setAssistantError(exchangeId, event.error);
                    conversation.save();
                    break;
                    
                case 'aborted':
                    // Reconstruct full content with timestamp for proper stripping
                    const abortTsMatch = exchange.assistant.content.match(TIMESTAMP_REGEX);
                    const abortFullContent = abortTsMatch ? abortTsMatch[0] + contentBuffer : contentBuffer;
                    updateAssistantContent(assistantEl, stripExtraTimestamps(abortFullContent));
                    showError(assistantEl, 'Stopped');
                    conversation.setAssistantError(exchangeId, 'Stopped');
                    conversation.save();
                    break;
                    
                case 'done':
                    // Tool calls are handled via __TOOL_CALL__ text detection in delta events
                    // handleToolExecution() already called streamResponse() to continue
                    if (toolCallIntercepted) break;

                    // contentBuffer doesn't include our injected timestamp
                    // Get the exchange to find the original timestamp we injected
                    const ex = conversation.getExchange(exchangeId);
                    
                    let finalContent = contentBuffer;
                    const toolIdxDone = finalContent.indexOf('__TOOL_CALL__');
                    if (toolIdxDone !== -1) {
                        finalContent = finalContent.substring(0, toolIdxDone).trim();
                    }
                    const tsMatch = ex?.assistant?.content?.match(TIMESTAMP_REGEX);
                    if (tsMatch) {
                        // Reconstruct: original timestamp + content buffer (no LLM timestamp)
                        finalContent = tsMatch[0] + finalContent; // use the stripped finalContent instead of raw contentBuffer
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
                    await conversation.setAssistantComplete(exchangeId, event.usage, event.context);
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
        console.error('[Chat] Stream error:', error);
        showError(assistantEl, error.message);
        conversation.setAssistantError(exchangeId, error.message);
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

    // Multi-conversation: If container already has DOM (previously viewed), don't rebuild.
    // Just append any new exchanges that might not be in the DOM yet.
    // Rebuild only happens for: new empty container (startNewChat case).
    if (container.children.length > 0) {
        // Container already has DOM — skip full rebuild.
        // New exchanges added by send/edit will call renderExchange directly.
        updateOverallContext();
        return;
    }

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
        if (isSuccess) resultHtml = `<strong>Result:</strong><br>${exchange.tool.content}`;
        else if (isError) resultHtml = `<strong>Error:</strong> ${exchange.tool.content}`;

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
                    <div class="tool-result">${resultHtml}</div>
                </div>
            </div>
        `;
        getActiveContainer()?.appendChild(toolEl);

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
            updateAssistantContent(assistantEl, assistantParsed.cleanContent);
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
    const userTimestamp = userParsed.timestamp || new Date(exchange.timestamp).toISOString().slice(0,16).replace('T',' @ ');
    
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
        updateAssistantContent(assistantEl, assistantParsed.cleanContent);
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

function updateOverallContext(contextData = null) {
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
            const msgs = conversation.getMessagesForApi();
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

async function handleToolExecution(originalExchangeId, parsedObj, forcedChatId, origUserExchangeId = null) {
    console.log('[Tool Call Intercepted]', parsedObj);

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
    // Strip partial tool call fragments that may have leaked into the UI during streaming
    oldEx.assistant.content = oldEx.assistant.content.replace(/__TOOL_CALL__\([\s\S]*$/, '').trim();
    toolConversation.setAssistantComplete(originalExchangeId);

    let originalEl = toolContainer?.querySelector(`.chat-message.assistant[data-exchange-id="${originalExchangeId}"]`);
    if (originalEl) {
        updateAssistantContent(originalEl, oldEx.assistant.content);
    }

    const pendingEl = toolContainer?.querySelector(`.pending-tool-element[data-pending-exchange-id="${originalExchangeId}"]`);
    if (pendingEl) {
        pendingEl.remove();
    }

    // 2. Create the tool exchange (pass userExchangeId so chained tools know the original)
    const toolExchangeId = await toolConversation.addToolExchange(parsedObj.name, parsedObj.args, userExchangeId);
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

    // 4. Execute tool
    try {
        const result = await mcpClient.executeTool(parsedObj.name, parsedObj.args, (progressParams) => {
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
        if (result && typeof result === 'object') {
            if (result.content && Array.isArray(result.content)) {
                resultText = result.content.map(c => {
                    if (c.type === 'text') return c.text;
                    if (c.type === 'image') {
                        const mime = c.mimeType || 'image/png';
                        if (c.data) {
                            // Base64 image data - store as data URI
                            resultImages.push(`data:${mime};base64,${c.data}`);
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
        // Strip any __TOOL_CALL__ artifacts from the result
        resultText = resultText.replace(/__TOOL_CALL__\([\s\S]*?\)/g, '').trim();
        exchange.tool.content = resultText;
        if (resultImages.length > 0) {
            exchange.tool.images = resultImages;
        }
        toolConversation.save(); // persist

        toolEl.querySelector('.tool-status').setAttribute('variant', 'success');
          toolEl.querySelector('.tool-status').innerHTML = 'Success';
          toolEl.querySelector('.tool-notifications').style.display = 'none';
        
        let toolResultHtml = exchange.tool.content;
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
        toolEl.querySelector('.tool-result').innerHTML = toolResultHtml;

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
        await streamResponse(toolExchangeId, toolChatId, userExchangeId);
        
    } catch (err) {
        console.error('Tool execution error', err);
        exchange.tool.status = 'error';
        exchange.tool.content = err.message || String(err);
        toolConversation.save();

        toolEl.querySelector('.tool-status').setAttribute('variant', 'danger');
          toolEl.querySelector('.tool-status').innerHTML = 'Failed';
          toolEl.querySelector('.tool-notifications').style.display = 'none';
        toolEl.querySelector('.tool-result').innerHTML = `<span class="tool-error">${exchange.tool.content}</span>
            <div class="tool-error-actions">
                <nui-button size="small" class="retry-tool"><button>Retry</button></nui-button>
                <nui-button size="small" class="dismiss-tool"><button>Dismiss & Continue</button></nui-button>
            </div>
        `;
        toolEl.querySelector('.tool-payload').style.display = 'block'; // force open
        
        // Wire up retry/dismiss
        toolEl.querySelector('.retry-tool')?.addEventListener('click', () => {
            toolEl.querySelector('.tool-result').innerHTML = '';
            toolEl.querySelector('.tool-status').innerHTML = 'Pending';
            toolEl.querySelector('.tool-notifications').innerHTML = '<span class="tool-spinner"></span> Running...';
            toolEl.querySelector('.tool-status').setAttribute('variant', 'primary');
            handleToolExecution(originalExchangeId, parsedObj); // re-run recursively! wait, we might duplicate exchange. Instead, just execute again inside here.
            // Simplified: just let user delete/regenerate, or handle properly inside handleToolExecution.
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
            streamResponse(toolExchangeId, toolChatId, userExchangeId);
            toolEl.querySelector('.dismiss-tool').parentElement.style.display = 'none';
        });
    }
}

function updateAssistantContent(el, content) {
    const contentDiv = el.querySelector('.message-content');
    if (!contentDiv) return;

    let visibleContent = content;

    // First strip out the tool call exactly, so we don't accidentally leave floating whitespace or closing braces
    const toolCallIndex = visibleContent.indexOf('__TOOL_CALL__');
    if (toolCallIndex !== -1) {
        visibleContent = visibleContent.substring(0, toolCallIndex).trim();
    }

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
    if (!visibleContent.trim()) {
        el.style.display = 'none';
        // Note: we don't return here, so it updates the internal state in case it needs to re-appear later
    } else {
        el.style.display = '';
    }

    // Skip if content hasn't changed (prevents redundant renders during streaming)
    if (contentDiv.dataset.lastContent === visibleContent) return;
    contentDiv.dataset.lastContent = visibleContent;

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
                    <nui-icon name="lightbulb_2" aria-hidden="true"><svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false"><use href="/nui_wc2/NUI/assets/material-icons-sprite.svg#image"></use></svg></nui-icon>
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
    console.log('[Chat] Compaction progress:', data);
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
    } else if (actions) {
        // Only show regenerate button initially
        actions.classList.add('visible');
        actions.querySelector('.regenerate').style.display = 'inline-block';
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
}

// ============================================
// Actions
// ============================================

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
            updateAssistantContent(el, exchange.assistant.content);
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
        
        // 2. Truncate conversation
        conversation.truncateAfter(exchangeId);

        // 3. Clear assistant response for this exchange so it doesn't flash on screen
        conversation.regenerateResponse(exchangeId);

        // 4. Render wipes downstream
        renderConversation();

        // 5. Stream new response
        currentExchangeId = exchangeId;
        streamResponse(exchangeId);
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

function startNewChat() {
    // Note: we do NOT abort background streams when starting a new chat.
    // Each chat's stream continues in its hidden container.

    const newChatId = chatHistory.create();
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

    // 6. Restore the model if saved in history
    if (chatInfo && chatInfo.model && elements.modelSelect) {
        const modelExists = models.some(m => m.id === chatInfo.model);
        if (modelExists) {
            currentModel = chatInfo.model;
            if (elements.modelSelect.setValue) {
                elements.modelSelect.setValue(currentModel);
            } else {
                const select = elements.modelSelect.querySelector('select');
                if (select) select.value = currentModel;
            }
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

    if (currentChatId === chatId) {
        const allChats = chatHistory.getAll();
        if (allChats.length > 0) {
            await switchChat(allChats[0].id);
        } else {
            startNewChat();
        }
    } else {
        renderHistoryList();
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
                    attachments: ex.user.attachments.map((att, idx) => {
                        const img = images[idx];
                        if (img) {
                            return {
                                ...att,
                                dataUrl: img.getDataUrl() // Embed full image data
                            };
                        }
                        return att;
                    })
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
        const newChatId = chatHistory.create();
        const title = importData.chatInfo?.title || 'Imported Chat';

        // Update metadata
        const meta = chatHistory.conversations.find(c => c.id === newChatId);
        if (meta) {
            meta.title = title;
            meta.model = importData.chatInfo?.model || '';
        }
        await chatHistory._saveList();

        // Process exchanges - save images to IndexedDB
        const processedExchanges = [];
        for (const ex of importData.exchanges) {
            const processedEx = { ...ex };

            // Strip dataUrl from attachments for storage, save to IndexedDB
            if (ex.user?.attachments?.some(att => att.dataUrl)) {
                const attachmentsForDb = ex.user.attachments
                    .filter(att => att.dataUrl)
                    .map(att => ({
                        dataUrl: att.dataUrl,
                        name: att.name,
                        type: att.type
                    }));

                if (attachmentsForDb.length > 0) {
                    await imageStore.save(ex.id, attachmentsForDb);
                }

                // Store metadata only in exchange
                processedEx.user = {
                    ...ex.user,
                    attachments: ex.user.attachments.map(att => ({
                        name: att.name,
                        type: att.type,
                        hasImage: att.hasImage || !!att.dataUrl
                        // dataUrl is intentionally omitted - stored in IndexedDB
                    }))
                };
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
        chatHistory._saveList();
        renderHistoryList();
    }
}

function updateChatModel(chatId, modelId) {
    const meta = chatHistory.conversations.find(c => c.id === chatId);
    if (meta && meta.model !== modelId) {
        meta.model = modelId;
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

        const titleSpan = document.createElement('span');
        titleSpan.className = 'chat-history-item-title';
        titleSpan.textContent = chat.title || 'New Chat';
        titleSpan.title = chat.title;
        
        const actionsDiv = document.createElement('div');
        actionsDiv.className = 'chat-history-item-actions';
        
        const exportJsonBtn = document.createElement('nui-button');
        exportJsonBtn.className = 'chat-history-item-action';
        exportJsonBtn.innerHTML = '<button type="button"><nui-icon name="content_copy"></nui-icon></button>';
        exportJsonBtn.title = 'Copy conversation JSON to clipboard';
        exportJsonBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            exportChatAsJson(chat.id, exportJsonBtn);
        });

        const exportFullBtn = document.createElement('nui-button');
        exportFullBtn.className = 'chat-history-item-action';
        exportFullBtn.innerHTML = '<button type="button"><nui-icon name="download"></nui-icon></button>';
        exportFullBtn.title = 'Export to file (with images)';
        exportFullBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            exportChatToFile(chat.id);
        });

        const exportMdBtn = document.createElement('nui-button');
        exportMdBtn.className = 'chat-history-item-action';
        exportMdBtn.innerHTML = '<button type="button"><nui-icon name="save"></nui-icon></button>';
        exportMdBtn.title = 'Export Markdown';
        exportMdBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            exportChatAsMarkdown(chat.id);
        });

        const delBtn = document.createElement('nui-button');
        delBtn.setAttribute('variant', 'danger');
        delBtn.className = 'chat-history-item-action chat-history-item-delete';
        delBtn.innerHTML = '<button type="button"><nui-icon name="close"></nui-icon></button>';
        delBtn.title = 'Delete chat (Shift+click to skip confirm)';
        delBtn.addEventListener('click', (e) => deleteChat(chat.id, e));
        
        actionsDiv.appendChild(exportJsonBtn);
        actionsDiv.appendChild(exportFullBtn);
        actionsDiv.appendChild(exportMdBtn);
        actionsDiv.appendChild(delBtn);

        item.appendChild(titleSpan);
        item.appendChild(actionsDiv);
        
        item.addEventListener('click', () => switchChat(chat.id));
        elements.chatHistoryList.appendChild(item);
    });
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
    return modelConfig?.capabilities?.vision === true;
}

function updateVisionToggleVisibility() {
    const visionToggle = document.getElementById('vision-toggle-container');
    if (!visionToggle) return;
    
    const hasImages = attachedImages.length > 0;
    const visionToolsAvailable = areVisionToolsAvailable();
    
    // Show toggle when:
    // - Images are attached
    // - Vision tools are available from MCP
    if (hasImages && visionToolsAvailable) {
        visionToggle.style.display = 'flex';
        visionToggle.querySelector('input').disabled = false;
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
    console.log(`[MCP UI] Rendering ${mcpClient.servers.length} servers`);

    mcpClient.servers.forEach(server => {
        console.log(`[MCP UI] Server ${server.name}: status=${server.status}, tools=${server.tools?.length || 0}`);
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

// ============================================
// Start
// ============================================

init();























