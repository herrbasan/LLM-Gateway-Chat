// ============================================
// LLM Gateway Chat - Main Controller
// ============================================

import { Conversation } from './conversation.js';
import { GatewayClient } from './client-sdk.js';
import { renderMarkdown, parseThinking } from './markdown.js';
import { imageStore } from './image-store.js';

// Config values with defaults
const CONFIG = window.CHAT_CONFIG || {};
const GATEWAY_URL = CONFIG.gatewayUrl || 'http://localhost:3400';
const DEFAULT_MODEL = CONFIG.defaultModel || '';
const DEFAULT_TEMPERATURE = CONFIG.defaultTemperature ?? 0.7;
const DEFAULT_MAX_TOKENS = CONFIG.defaultMaxTokens || 2048;

// State
// Storage wrapper for Chat History
const HISTORY_KEY = 'chat-history-index';
let chatHistory = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
let currentChatId = localStorage.getItem('current-chat-id');

if (!currentChatId || !chatHistory.find(c => c.id === currentChatId)) {
    // Check if there is an old conversation without history tracking
    let oldData = localStorage.getItem('chat-conversation');
    if (oldData) {
        currentChatId = 'default';
        if (!chatHistory.find(c => c.id === currentChatId)) {
            chatHistory.push({ id: currentChatId, title: 'Old Chat', timestamp: Date.now() });
        }
    } else {
        currentChatId = 'ex_' + Date.now();
        chatHistory.push({ id: currentChatId, title: 'New Chat', timestamp: Date.now() });
    }
    localStorage.setItem(HISTORY_KEY, JSON.stringify(chatHistory));
    localStorage.setItem('current-chat-id', currentChatId);
}

let conversation = new Conversation(`chat-conversation-${currentChatId}`);

// Also polyfill the old 'chat-conversation' if it exists and we're loading 'default'
if (currentChatId === 'default' && localStorage.getItem('chat-conversation') && !localStorage.getItem('chat-conversation-default')) {
    localStorage.setItem('chat-conversation-default', localStorage.getItem('chat-conversation'));
    conversation = new Conversation(`chat-conversation-default`);
}

// Async initialization - load images from IndexedDB
await conversation.load();

let client = new GatewayClient({ baseUrl: GATEWAY_URL });
let models = [];
let currentModel = '';
let isStreaming = false;
let currentExchangeId = null;
let attachedImages = []; // Array of {dataUrl, name, type}

// DOM Elements
const elements = {
    modelSelect: document.getElementById('model-select'),
    temperature: document.getElementById('temperature'),
    maxTokens: document.getElementById('max-tokens'),
    systemPrompt: document.getElementById('system-prompt'),
    messages: document.getElementById('messages'),
    messageInput: document.getElementById('message-input'),
    sendBtn: document.getElementById('send-btn'),
    attachBtn: document.getElementById('attach-btn'),
    fileInput: document.getElementById('file-input'),
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
    stopButton: document.getElementById('stop-btn') // Added safe fallback
};

// ============================================
// Initialization
// ============================================

async function init() {
    console.log('[Chat] Initializing...');
    
    // Apply default config values
    applyDefaultConfig();
    
    // Setup event listeners first
    setupEventListeners();
    
    // Wait for NUI to be ready, then load models
    await waitForNUI();
    await loadModels();
    
    // Restore conversation
    renderHistoryList();
    renderConversation();
    
    // Check gateway status
    checkGatewayStatus();
    
    console.log('[Chat] Ready');
}

function applyDefaultConfig() {
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
}

function waitForNUI() {
    return new Promise((resolve) => {
        // Check if NUI is already ready
        if (window.nui?.ready) {
            resolve();
            return;
        }
        
        // Wait for custom elements to be defined
        const check = () => {
            if (customElements.get('nui-select')) {
                // Give a small delay for components to upgrade
                setTimeout(resolve, 100);
            } else {
                setTimeout(check, 50);
            }
        };
        check();
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
    const curChatInfo = chatHistory.find(c => c.id === currentChatId);
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
            console.log('[Chat] Selected model:', modelToSelect);
        }
        
        // Bind change event via NUI
        elements.modelSelect.addEventListener('nui-change', (e) => {
            currentModel = e.detail.values[0] || '';
            console.log('[Chat] Selected model:', currentModel);
            updateOverallContext();
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
        console.log('[Chat] Selected model:', modelToSelect);
    }
    
    select.addEventListener('change', (e) => {
        currentModel = e.target.value;
        console.log('[Chat] Selected model:', currentModel);
        updateOverallContext();
    });
}

// ============================================
// Event Listeners
// ============================================

function setupEventListeners() {
    // Model selection
    elements.modelSelect?.addEventListener('change', (e) => {
        currentModel = e.target.value;
        console.log('[Chat] Selected model:', currentModel);
    });
    
    // Send message / Toggle Stop
    elements.sendBtn?.addEventListener('click', (e) => {
        if (isStreaming) {
            abortStream();
        } else {
            sendMessage();
        }
    });
    elements.messageInput?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });
    
    // Auto-resize textarea
    elements.messageInput?.addEventListener('input', autoResizeTextarea);
    
    // File attachment
    elements.attachBtn?.addEventListener('click', () => {
        elements.fileInput?.click();
    });
    elements.fileInput?.addEventListener('change', handleFileSelect);
    
    // New chat
    elements.newChatBtn?.addEventListener('click', startNewChat);
    
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

function autoResizeTextarea() {
    const textarea = elements.messageInput?.querySelector('textarea');
    if (!textarea) return;
    
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 200) + 'px';
}

// ============================================
// Message Sending
// ============================================

async function sendMessage() {
    const textarea = elements.messageInput?.querySelector('textarea');
    const content = textarea?.value.trim();
    
    if ((!content && attachedImages.length === 0) || isStreaming) return;
    if (!currentModel) {
        nui.components.dialog.alert('Model Required', 'Please select a model first.');
        return;
    }
    
    // Clear welcome message if present
    const welcome = elements.messages?.querySelector('.welcome-message');
    if (welcome) welcome.remove();
    
    // Add user message to conversation
    currentExchangeId = await conversation.addExchange(content, [...attachedImages]);

    // Track the used model for this chat
    updateChatModel(currentChatId, currentModel);

    // Update chat title if it's the first message
    if (conversation.length === 1 && content) {
        updateChatTitle(currentChatId, content);
    }

    // Clear input and attachments
    textarea.value = '';
    textarea.style.height = 'auto';
    clearAttachments();
    
    // Render user message
    renderExchange(conversation.getExchange(currentExchangeId));
    
    // Start streaming response
    await streamResponse(currentExchangeId);
}

async function streamResponse(exchangeId) {
    isStreaming = true;
    updateSendButton();
    
    const exchange = conversation.getExchange(exchangeId);
    const systemPrompt = elements.systemPrompt?.querySelector('textarea')?.value || '';
    const temperature = parseFloat(elements.temperature?.value) || DEFAULT_TEMPERATURE;
    const maxTokens = parseInt(elements.maxTokens?.value) || DEFAULT_MAX_TOKENS;
    
    // Get or create assistant message element
    let assistantEl = elements.messages?.querySelector(`.chat-message.assistant[data-exchange-id="${exchangeId}"]`);
    if (!assistantEl) {
        assistantEl = createAssistantElement(exchangeId);
        elements.messages?.appendChild(assistantEl);
    }
    scrollToBottom();
    
    try {
        const messages = conversation.getMessagesForApi(systemPrompt);
        
        const requestBody = {
            model: currentModel,
            messages,
            temperature,
            max_tokens: maxTokens,
            stream: true
        };
        
        // Add image processing if images attached
        if (exchange.user.attachments?.length > 0) {
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
        
        for await (const event of client.streamChatIterable(requestBody)) {
            switch (event.type) {
                case 'delta':
                    // Hide progress status once text generation begins
                    const statusEl = assistantEl.querySelector('.progress-status');
                    if (statusEl) statusEl.style.display = 'none';

                    contentBuffer += event.content;
                    conversation.updateAssistantResponse(exchangeId, event.content);
                    
                    // Debounce DOM updates to prevent freezing
                    if (!pendingUpdate) {
                        pendingUpdate = true;
                        const now = performance.now();
                        const delay = Math.max(0, RENDER_INTERVAL - (now - lastRender));
                        
                        const wasNearBottom = isNearBottom();
                        setTimeout(() => {
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
                    updateAssistantContent(assistantEl, contentBuffer); // Render what we have
                    showError(assistantEl, event.error);
                    conversation.setAssistantError(exchangeId, event.error);
                    break;
                    
                case 'aborted':
                    updateAssistantContent(assistantEl, contentBuffer); // Render what we have
                    showError(assistantEl, 'Stopped');
                    break;
                    
                case 'done':
                    // Ensure final content is rendered
                    updateAssistantContent(assistantEl, contentBuffer);
                    conversation.setAssistantComplete(exchangeId, event.usage, event.context);
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
                                statusEl.style.display = 'block';
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
        updateSendButton();
        currentExchangeId = null;
    }
}

// ============================================
// DOM Creation & Updates
// ============================================

function renderConversation() {
    elements.messages.innerHTML = '';
    
    if (conversation.length === 0) {
        elements.messages.innerHTML = `
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
    // User message
    const userEl = document.createElement('div');
    userEl.className = 'chat-message user';
    userEl.dataset.exchangeId = exchange.id;

    let userContent = escapeHtml(exchange.user.content);

    // Add attachment previews
    if (exchange.user.attachments?.length > 0) {
        userContent += '<div class="message-attachments"><nui-lightbox loop>';
        for (const att of exchange.user.attachments) {
            // Use blobUrl for loaded images, dataUrl for new attachments
            const displayUrl = att.blobUrl || att.dataUrl || '';
            const dataUrl = att.getDataUrl ? att.getDataUrl() : att.dataUrl;
            userContent += `<img src="${displayUrl}" alt="${att.name}" data-lightbox-src="${dataUrl}" class="chat-attachment" style="cursor: pointer;">`;
        }
        userContent += '</nui-lightbox></div>';
    }
    
    userEl.innerHTML = `
        <div class="message-header">You</div>
        <div class="message-content">${userContent}</div>
    `;

    elements.messages?.appendChild(userEl);

    // Initialize Lightbox declarative handlers for attached images
    if (exchange.user.attachments?.length > 0) {
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
        const assistantEl = createAssistantElement(exchange.id);
        updateAssistantContent(assistantEl, exchange.assistant.content);
        elements.messages?.appendChild(assistantEl);
        
        if (exchange.assistant.isComplete) {
            finalizeAssistantElement(assistantEl, exchange.id);
        }
    }
}

function createAssistantElement(exchangeId) {
    const el = document.createElement('div');
    el.className = 'chat-message assistant';
    el.dataset.exchangeId = exchangeId;
    el.innerHTML = `
        <div class="message-header" style="display: flex; align-items: center;">
            <span>Assistant</span>
            <span class="streaming-indicator" style="display: inline-block; margin-left: 8px;">
                <span class="dot">.</span><span class="dot">.</span><span class="dot">.</span>
            </span>
            <span class="context-usage-display" style="display: none; margin-left: auto; font-size: 0.9em; color: var(--color-shade5, #888); font-weight: normal;">
                Context: <span class="usage-values">--</span>
            </span>
        </div>
        <div class="progress-status" class="progress-status" style="display: none;"></div>
        <div class="message-content"></div>
        <div class="message-actions" style="display: none; align-items: center; gap: 0.5rem;">
            <nui-button class="action-btn regenerate" title="Regenerate"><button type="button"><nui-icon name="sync"></nui-icon></button></nui-button>
            <nui-button class="action-btn prev-version" title="Previous version"><button type="button"><nui-icon name="arrow" style="transform: rotate(180deg)"></nui-icon></button></nui-button>
            <span class="version-info" style="min-width: 3rem; text-align: center; color: var(--color-shade2); font-size: 0.75rem;"></span>
            <nui-button class="action-btn next-version" title="Next version"><button type="button"><nui-icon name="arrow"></nui-icon></button></nui-button>
        </div>
    `;
    
    // Bind action buttons
    el.querySelector('.regenerate')?.addEventListener('click', () => regenerate(exchangeId));
    el.querySelector('.prev-version')?.addEventListener('click', () => switchVersion(exchangeId, 'prev'));
    el.querySelector('.next-version')?.addEventListener('click', () => switchVersion(exchangeId, 'next'));
    
    return el;
}

function updateUsageDisplay(el, contextData) {
    if (!el || !contextData) return;
    const displaySpan = el.querySelector('.context-usage-display');
    const valueSpan = el.querySelector('.usage-values');
    if (!displaySpan || !valueSpan) return;

    if (contextData.used_tokens !== undefined) {
        displaySpan.style.display = 'inline-block';
        const isEstimate = contextData.isEstimate;
        let text = `${isEstimate ? '~' : ''}${contextData.used_tokens.toLocaleString()}`;
        
        let windowSize = contextData.window_size;
        if (!windowSize) {
            const modelConfig = models.find(m => m.id === currentModel);
            if (modelConfig && modelConfig.capabilities?.contextWindow) {
                windowSize = modelConfig.capabilities.contextWindow;
            }
        }

        if (windowSize) {
            text += ` / ${windowSize.toLocaleString()}`;
        }
        text += ' tokens';
        valueSpan.textContent = text;
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
        } else if (foundUsage) {
            contextData = { used_tokens: foundUsage.total_tokens };
        } else {
            // Rough estimation fallback based on the data we have in the conversation text
            let textLength = 0;
            const msgs = conversation.getMessagesForApi();
            for (const m of msgs) {
                if (typeof m.content === 'string') {
                    textLength += m.content.length;
                } else if (Array.isArray(m.content)) {
                    for (const block of m.content) {
                        if (block.type === 'text') textLength += block.text.length;
                    }
                }
                textLength += m.role.length;
            }
            if (textLength > 0) {
                // Heuristic: ~4 chars per token for English
                contextData = { used_tokens: Math.ceil(textLength / 4), isEstimate: true };
            }
        }
    }

    // Always display the wrapper so we can show 0% if no history exists yet
    elements.overallContextProgressWrap.style.display = 'flex';

    const usedTokens = (contextData && contextData.used_tokens) ? contextData.used_tokens : 0;
    const isEstimate = contextData && contextData.isEstimate;
    
    let text = `Context: ${isEstimate ? '~' : ''}${usedTokens.toLocaleString()} tokens`;
    let pct = 0;
    let knownLimit = false;

    const modelConfig = models.find(m => m.id === currentModel);

    if (modelConfig && modelConfig.capabilities?.contextWindow) {
        text += ` / ${modelConfig.capabilities.contextWindow.toLocaleString()}`;
        pct = Math.min(100, Math.max(0, (usedTokens / modelConfig.capabilities.contextWindow) * 100));
        knownLimit = true;
    } else if (contextData && contextData.window_size) {
        // Fallback to backend reported window size if model list lacks it
        text += ` / ${contextData.window_size.toLocaleString()}`;
        pct = Math.min(100, Math.max(0, (usedTokens / contextData.window_size) * 100));
        knownLimit = true;
    } else {
        text += ` / Unknown`;
    }

    if (elements.overallContextProgress) {
        elements.overallContextProgress.setAttribute('value', pct || 0);
        
        // Dim the icon if we genuinely do not know the context limit, or if no model is selected
        if (!knownLimit || !currentModel) {
            elements.overallContextProgress.style.opacity = '0.3';
            elements.overallContextProgress.removeAttribute('variant');
            if (!knownLimit) text += " (Max size unknown)";
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

function updateAssistantContent(el, content) {
    const contentDiv = el.querySelector('.message-content');
    if (!contentDiv) return;
    
    // Skip if content hasn't changed (prevents redundant renders during streaming)
    if (contentDiv.dataset.lastContent === content) return;
    contentDiv.dataset.lastContent = content;
    
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
    const parsed = parseThinking(content);
    
    let html = '';
    
    // Render thinking block if exists
    if (parsed.thinking !== null) {
        const existingBlock = contentDiv.querySelector('.thinking-block');
        const isCollapsed = existingBlock ? existingBlock.classList.contains('collapsed') : true;
        let thinkingClass = isCollapsed ? 'collapsed' : '';
        if (parsed.isStreaming) thinkingClass += ' streaming';
        
        const thinkingId = 'thinking-' + el.dataset.exchangeId;
        
        html += `
            <div class="thinking-block ${thinkingClass}" id="${thinkingId}">
                <div class="thinking-header" onclick="toggleThinking('${thinkingId}')">
                    <nui-icon name="lightbulb_2" aria-hidden="true"><svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false"><use href="/nui_wc2/NUI/assets/material-icons-sprite.svg#image"></use></svg></nui-icon>
                    <span class="thinking-title">${parsed.isStreaming ? 'Thinking...' : 'Thoughts'}</span>
                    <span class="thinking-toggle">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <polyline points="6 9 12 15 18 9"></polyline>
                        </svg>
                    </span>
                </div>
                <div class="thinking-content">${escapeHtml(parsed.thinking)}</div>
            </div>
        `;
    }
    
    // Render answer with markdown
    if (parsed.answer) {
        html += renderMarkdown(parsed.answer);
    }
    
    contentDiv.innerHTML = html;

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
        el.classList.toggle('collapsed');
    }
};

function showCompactionIndicator(el, data) {
    const contentDiv = el.querySelector('.message-content');
    if (!contentDiv) return;
    
    let compactEl = contentDiv.querySelector('.compaction-indicator');
    if (!compactEl) {
        compactEl = document.createElement('div');
        compactEl.className = 'compaction-indicator';
        compactEl.innerHTML = '<span class="icon">📝</span> Compacting context...';
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
    // Hide streaming indicator
    const indicator = el.querySelector('.streaming-indicator');
    if (indicator) indicator.style.display = 'none';

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

    if (finalUsage || finalContext) {
        // Build a display object
        const displayData = {};
        if (finalContext) {
            displayData.used_tokens = finalContext.used_tokens;
            displayData.window_size = finalContext.window_size;
        } else if (finalUsage) {
            displayData.used_tokens = finalUsage.total_tokens;
        }
        updateUsageDisplay(el, displayData);
    } else if (exchange && exchange.assistant.content) {
        // If we still lack explicit context stats, fallback to a heuristic estimation if it's rendered in history
        const roughTokens = Math.ceil((exchange.user.content.length + exchange.assistant.content.length) / 4);
        updateUsageDisplay(el, { used_tokens: roughTokens, isEstimate: true });
    }

    // Show actions only if we have multiple versions or after regeneration
    const info = conversation.getVersionInfo(exchangeId);
    const actions = el.querySelector('.message-actions');
    if (actions && info?.hasMultiple) {
        actions.style.display = 'flex';
        updateVersionControls(el, exchangeId);
    } else if (actions) {
        // Only show regenerate button initially
        actions.style.display = 'flex';
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
    if (isStreaming) return;
    
    conversation.regenerateResponse(exchangeId);
    
    // Remove old assistant element
    const oldEl = document.querySelector(`.chat-message.assistant[data-exchange-id="${exchangeId}"]`);
    if (oldEl) {
        oldEl.querySelector('.message-content').innerHTML = '';
        oldEl.querySelector('.streaming-indicator').style.display = 'inline-block';
        oldEl.querySelector('.message-actions').style.display = 'none';
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

// ============================================
// History Management
// ============================================

function startNewChat() {
    if (isStreaming) {
        client.abortCurrentIterableStream();
    }
    
    currentChatId = 'ex_' + Date.now();
    chatHistory.unshift({ id: currentChatId, title: 'New Chat', timestamp: Date.now() });
    localStorage.setItem(HISTORY_KEY, JSON.stringify(chatHistory));
    localStorage.setItem('current-chat-id', currentChatId);
    
    conversation = new Conversation(`chat-conversation-${currentChatId}`);
    renderHistoryList();
    renderConversation();
    
    // Auto-focus input
    setTimeout(() => {
        const textarea = elements.messageInput?.querySelector('textarea');
        if (textarea) textarea.focus();
    }, 100);
}

async function switchChat(chatId) {
    if (isStreaming) {
        client.abortCurrentIterableStream();
    }
    currentChatId = chatId;
    localStorage.setItem('current-chat-id', currentChatId);
    conversation = new Conversation(`chat-conversation-${currentChatId}`);
    await conversation.load();

    // Restore the model if saved in history
    const chatInfo = chatHistory.find(c => c.id === currentChatId);
    if (chatInfo && chatInfo.model && elements.modelSelect) {
        // Ensure the model actually exists to avoid setting invalid state
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

    renderHistoryList();
    renderConversation();
}

async function deleteChat(chatId, e) {
    e.stopPropagation(); // prevent row click
    if (await nui.components.dialog.confirm('Delete Chat', 'Are you sure you want to delete this chat?')) {
        // Delete images from IndexedDB for this chat
        const chatData = localStorage.getItem(`chat-conversation-${chatId}`);
        if (chatData) {
            try {
                const exchanges = JSON.parse(chatData);
                for (const ex of exchanges) {
                    await imageStore.delete(ex.id);
                }
            } catch (err) {
                console.warn('[Chat] Failed to delete images for chat', chatId, err);
            }
        }
        
        chatHistory = chatHistory.filter(c => c.id !== chatId);
        localStorage.removeItem(`chat-conversation-${chatId}`);
        localStorage.setItem(HISTORY_KEY, JSON.stringify(chatHistory));
        
        if (currentChatId === chatId) {
            if (chatHistory.length > 0) {
                await switchChat(chatHistory[0].id);
            } else {
                startNewChat();
            }
        } else {
            renderHistoryList();
        }
    }
}

function exportChatAsJson(chatId, btn) {
    const chatDataString = localStorage.getItem(`chat-conversation-${chatId}`);
    if (!chatDataString) return;
    
    // Format JSON with 2 spaces for readability
    try {
        const formattedJson = JSON.stringify(JSON.parse(chatDataString), null, 2);
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

function exportChatAsMarkdown(chatId) {
    const chatDataString = localStorage.getItem(`chat-conversation-${chatId}`);
    if (!chatDataString) return;
    
    try {
        const exchanges = JSON.parse(chatDataString);
        let md = "";
        
        const chatInfo = chatHistory.find(c => c.id === chatId);
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
    const chatInfo = chatHistory.find(c => c.id === chatId);
    if (chatInfo && (chatInfo.title === 'New Chat' || chatInfo.title === 'Old Chat')) {
        chatInfo.title = firstMessageContent.substring(0, 30) + (firstMessageContent.length > 30 ? '...' : '');
        localStorage.setItem(HISTORY_KEY, JSON.stringify(chatHistory));
        renderHistoryList();
    }
}

function updateChatModel(chatId, modelId) {
    const chatInfo = chatHistory.find(c => c.id === chatId);
    if (chatInfo && chatInfo.model !== modelId) {
        chatInfo.model = modelId;
        localStorage.setItem(HISTORY_KEY, JSON.stringify(chatHistory));
    }
}

function renderHistoryList() {
    if (!elements.chatHistoryList) return;
    
    // Sort by timestamp desc
    chatHistory.sort((a, b) => b.timestamp - a.timestamp);
    
    elements.chatHistoryList.innerHTML = '';
    
    if (chatHistory.length === 0) {
        const emptyMsg = document.createElement('div');
        emptyMsg.style.padding = '1rem';
        emptyMsg.style.color = 'var(--color-shade5)';
        emptyMsg.style.fontSize = '0.875rem';
        emptyMsg.textContent = 'No previous chats.';
        elements.chatHistoryList.appendChild(emptyMsg);
        return;
    }
    
    chatHistory.forEach(chat => {
        const item = document.createElement('div');
        item.className = 'chat-history-item' + (chat.id === currentChatId ? ' active' : '');
        
        const titleSpan = document.createElement('span');
        titleSpan.className = 'chat-history-item-title';
        titleSpan.textContent = chat.title || 'New Chat';
        titleSpan.title = chat.title;
        
        const actionsDiv = document.createElement('div');
        actionsDiv.className = 'chat-history-item-actions';
        
        const exportJsonBtn = document.createElement('nui-button');
        exportJsonBtn.className = 'chat-history-item-action';
        exportJsonBtn.innerHTML = '<button type="button"><nui-icon name="content_copy"></nui-icon></button>';
        exportJsonBtn.title = 'Copy JSON to clipboard';
        exportJsonBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            exportChatAsJson(chat.id, exportJsonBtn);
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
        delBtn.title = 'Delete chat';
        delBtn.addEventListener('click', (e) => deleteChat(chat.id, e));
        
        actionsDiv.appendChild(exportJsonBtn);
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
        btn.innerHTML = isStreaming
            ? '<nui-icon name="close"></nui-icon>'
            : '<nui-icon name="send"></nui-icon>';
    }
}

function abortStream() {
    client.abortCurrentIterableStream();
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

function addAttachmentPreview(dataUrl, name) {
    const item = document.createElement('div');
    item.className = 'attachment-item';
    item.innerHTML = `
        <img src="${dataUrl}" alt="${name}">
        <button class="remove" title="Remove">&times;</button>
    `;
    
    item.querySelector('.remove').addEventListener('click', () => {
        const idx = attachedImages.findIndex(img => img.dataUrl === dataUrl);
        if (idx > -1) attachedImages.splice(idx, 1);
        item.remove();
    });
    
    elements.attachmentPreview?.appendChild(item);
}

function clearAttachments() {
    attachedImages = [];
    if (elements.attachmentPreview) {
        elements.attachmentPreview.innerHTML = '';
    }
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

function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme') || 'light';
    const next = current === 'dark' ? 'light' : 'dark';
    setTheme(next);
}

function setTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('chat-theme', theme);
    
    // Also sync with NUI if available
    if (window.nui?.setTheme) {
        window.nui.setTheme(theme);
    }
    
    // Update color-scheme for native form elements
    document.documentElement.style.colorScheme = theme;
}

// Restore theme on load
const savedTheme = localStorage.getItem('chat-theme');
if (savedTheme) {
    setTheme(savedTheme);
} else {
    // Default to system preference
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    setTheme(prefersDark ? 'dark' : 'light');
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
// Utilities
// ============================================

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function scrollToBottom() {
    if (elements.messages) {
        elements.messages.scrollTop = elements.messages.scrollHeight;
    }
}

function isNearBottom(threshold = 100) {
    if (!elements.messages) return true;
    const { scrollTop, scrollHeight, clientHeight } = elements.messages;
    return scrollHeight - scrollTop - clientHeight < threshold;
}

// ============================================
// Start
// ============================================

init();





