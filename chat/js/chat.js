// ============================================
// LLM Gateway Chat - Main Controller
// ============================================

import { Conversation } from './conversation.js';
import { StreamingHandler } from './streaming.js';
import { renderMarkdown, parseThinking, renderThinking } from './markdown.js';
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

let streamer = new StreamingHandler(GATEWAY_URL);
let models = [];
let currentModel = '';
let isStreaming = false;
let currentExchangeId = null;
let attachedImages = []; // Array of {dataUrl, name, type}

// DOM Elements
const elements = {
    modelSelect: document.getElementById('model-select'),
    temperature: document.getElementById('temperature'),
    tempValue: document.getElementById('temp-value'),
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
    gatewayStatus: document.querySelector('.status-dot')
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
        elements.temperature.value = DEFAULT_TEMPERATURE;
        elements.temperature.setAttribute('value', DEFAULT_TEMPERATURE);
        if (elements.tempValue) {
            elements.tempValue.textContent = DEFAULT_TEMPERATURE;
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
        const response = await fetch(`${GATEWAY_URL}/v1/models`);
        const data = await response.json();
        
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
    
    if (DEFAULT_MODEL) {
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
            elements.modelSelect.setValues([modelToSelect]);
            console.log('[Chat] Selected model:', modelToSelect);
        }
        
        // Bind change event via NUI
        elements.modelSelect.addEventListener('nui-change', (e) => {
            currentModel = e.detail.values[0] || '';
            console.log('[Chat] Selected model:', currentModel);
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
    
    // Temperature slider
    elements.temperature?.addEventListener('input', (e) => {
        elements.tempValue.textContent = e.target.value;
    });
    
    // Send message
    elements.sendBtn?.addEventListener('click', sendMessage);
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
        
        for await (const event of streamer.streamChat(requestBody)) {
            switch (event.type) {
                case 'delta':
                    contentBuffer += event.content;
                    conversation.updateAssistantResponse(exchangeId, event.content);
                    
                    // Debounce DOM updates to prevent freezing
                    if (!pendingUpdate) {
                        pendingUpdate = true;
                        const now = performance.now();
                        const delay = Math.max(0, RENDER_INTERVAL - (now - lastRender));
                        
                        setTimeout(() => {
                            updateAssistantContent(assistantEl, contentBuffer);
                            lastRender = performance.now();
                            pendingUpdate = false;
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
                    conversation.setAssistantComplete(exchangeId);
                    finalizeAssistantElement(assistantEl, exchangeId);
                    scrollToBottom();
                    break;
            }
            
            // Only scroll on delta if user is near bottom
            if (event.type === 'delta' && isNearBottom()) {
                scrollToBottom();
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
        return;
    }
    
    for (const exchange of conversation.getAll()) {
        renderExchange(exchange);
    }
    
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
        userContent += '<div class="message-attachments">';
        for (const att of exchange.user.attachments) {
            // Use blobUrl for loaded images, dataUrl for new attachments
            const displayUrl = att.blobUrl || att.dataUrl || '';
            const dataUrl = att.getDataUrl ? att.getDataUrl() : att.dataUrl;
            userContent += `<img src="${displayUrl}" alt="${att.name}" data-full-src="${dataUrl}" class="chat-attachment">`;
        }
        userContent += '</div>';
    }
    
    userEl.innerHTML = `
        <div class="message-header">You</div>
        <div class="message-content">${userContent}</div>
    `;
    
    elements.messages?.appendChild(userEl);
    
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
        <div class="message-header">
            Assistant
            <span class="streaming-indicator" style="display: inline-block; margin-left: 8px;">
                <span class="dot">.</span><span class="dot">.</span><span class="dot">.</span>
            </span>
        </div>
        <div class="message-content"></div>
        <div class="message-actions" style="display: none;">
            <button class="action-btn regenerate" title="Regenerate">↻</button>
            <button class="action-btn prev-version" title="Previous version">←</button>
            <span class="version-info"></span>
            <button class="action-btn next-version" title="Next version">→</button>
        </div>
    `;
    
    // Bind action buttons
    el.querySelector('.regenerate')?.addEventListener('click', () => regenerate(exchangeId));
    el.querySelector('.prev-version')?.addEventListener('click', () => switchVersion(exchangeId, 'prev'));
    el.querySelector('.next-version')?.addEventListener('click', () => switchVersion(exchangeId, 'next'));
    
    return el;
}

function updateAssistantContent(el, content) {
    const contentDiv = el.querySelector('.message-content');
    if (!contentDiv) return;
    
    // Skip if content hasn't changed (prevents redundant renders during streaming)
    if (contentDiv.dataset.lastContent === content) return;
    contentDiv.dataset.lastContent = content;
    
    // Parse thinking and answer
    const parsed = parseThinking(content);
    
    let html = '';
    
    // Render thinking block if exists
    if (parsed.thinking !== null) {
        const existingBlock = contentDiv.querySelector('.thinking-block');
        const isCollapsed = existingBlock ? existingBlock.classList.contains('collapsed') : true;
        const thinkingClass = isCollapsed ? 'collapsed' : '';
        const thinkingId = 'thinking-' + el.dataset.exchangeId;
        
        html += `
            <div class="thinking-block ${thinkingClass}" id="${thinkingId}">
                <div class="thinking-header" onclick="toggleThinking('${thinkingId}')">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 0.5rem;"><path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2Z"></path><path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2Z"></path></svg>
                    <span class="thinking-title">Thinking</span>
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
}

function showThinkingIndicator(el, thinking) {
    const contentDiv = el.querySelector('.message-content');
    if (!contentDiv) return;
    
    let thinkEl = contentDiv.querySelector('.thinking-block');
    if (!thinkEl) {
        const thinkingId = 'thinking-' + el.dataset.exchangeId;
        thinkEl = document.createElement('div');
        thinkEl.id = thinkingId;
        thinkEl.className = 'thinking-block streaming collapsed';
        thinkEl.innerHTML = `
            <div class="thinking-header" onclick="toggleThinking('${thinkingId}')">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 0.5rem;"><path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2Z"></path><path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2Z"></path></svg>
                <span class="thinking-title">Thinking...</span>
                <span class="thinking-toggle">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polyline points="6 9 12 15 18 9"></polyline>
                    </svg>
                </span>
            </div>
            <div class="thinking-content"></div>
        `;
        contentDiv.insertBefore(thinkEl, contentDiv.firstChild);
    }
    
    thinkEl.querySelector('.thinking-content').textContent = thinking;
}



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

function finalizeAssistantElement(el, exchangeId) {
    // Hide streaming indicator
    const indicator = el.querySelector('.streaming-indicator');
    if (indicator) indicator.style.display = 'none';
    
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
        }
    }
}

// ============================================
// History Management
// ============================================

function startNewChat() {
    if (isStreaming) {
        streamer.abort();
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
        streamer.abort();
    }
    currentChatId = chatId;
    localStorage.setItem('current-chat-id', currentChatId);
    conversation = new Conversation(`chat-conversation-${currentChatId}`);
    await conversation.load();
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

function updateChatTitle(chatId, firstMessageContent) {
    const chatInfo = chatHistory.find(c => c.id === chatId);
    if (chatInfo && (chatInfo.title === 'New Chat' || chatInfo.title === 'Old Chat')) {
        chatInfo.title = firstMessageContent.substring(0, 30) + (firstMessageContent.length > 30 ? '...' : '');
        localStorage.setItem(HISTORY_KEY, JSON.stringify(chatHistory));
        renderHistoryList();
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
        emptyMsg.style.color = 'var(--nui-shade2)';
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
        
        const delBtn = document.createElement('button');
        delBtn.className = 'chat-history-item-delete';
        delBtn.innerHTML = '<nui-icon name="close"></nui-icon>';
        delBtn.title = 'Delete chat';
        delBtn.addEventListener('click', (e) => deleteChat(chat.id, e));
        
        item.appendChild(titleSpan);
        item.appendChild(delBtn);
        
        item.addEventListener('click', () => switchChat(chat.id));
        elements.chatHistoryList.appendChild(item);
    });
}

// ============================================

function updateSendButton() {
    const btn = elements.sendBtn?.querySelector('button');
    if (btn) {
        btn.innerHTML = isStreaming 
            ? '<nui-icon name="stop"></nui-icon>' 
            : '<nui-icon name="send"></nui-icon>';
    }
    
    if (isStreaming) {
        elements.sendBtn?.addEventListener('click', abortStream, { once: true });
    }
}

function abortStream() {
    streamer.abort();
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
        const response = await fetch(`${GATEWAY_URL}/health`);
        const data = await response.json();
        
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





