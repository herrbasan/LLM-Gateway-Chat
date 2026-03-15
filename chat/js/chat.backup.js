// ============================================
// LLM Gateway Chat - Main Controller
// ============================================

import { Conversation } from './conversation.js';
import { StreamingHandler } from './streaming.js';
import { renderMarkdown, parseThinking, renderThinking } from './markdown.js';

// Gateway URL (WebAdmin runs on :3401, Gateway on :3400)
const GATEWAY_URL = window.location.origin.replace(':3401', ':3400');

// State
let conversation = new Conversation();
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
    themeToggle: document.getElementById('theme-toggle'),
    sidebar: document.getElementById('sidebar'),
    sidebarToggle: document.getElementById('sidebar-toggle'),
    sidebarToggleMobile: document.getElementById('sidebar-toggle-mobile'),
    gatewayStatus: document.querySelector('.status-dot'),
    lightbox: document.getElementById('lightbox'),
    lightboxImage: document.getElementById('lightbox-image'),
    lightboxClose: document.getElementById('lightbox-close')
};

// ============================================
// Initialization
// ============================================

async function init() {
    console.log('[Chat] Initializing...');
    
    // Setup event listeners first
    setupEventListeners();
    
    // Wait for NUI to be ready, then load models
    await waitForNUI();
    await loadModels();
    
    // Restore conversation
    renderConversation();
    
    // Check gateway status
    checkGatewayStatus();
    
    console.log('[Chat] Ready');
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
        
        // Bind change event via NUI
        elements.modelSelect.addEventListener('nui-change', (e) => {
            currentModel = e.detail.values[0] || '';
            console.log('[Chat] Selected model:', currentModel);
        });
    } else {
        // Fallback if NUI not loaded yet
        console.warn('[Chat] NUI select not ready, using fallback');
        populateModelSelectFallback(chatModels);
    }
}

// Fallback for when NUI is not ready
function populateModelSelectFallback(chatModels) {
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
    
    // Lightbox
    elements.lightboxClose?.addEventListener('click', closeLightbox);
    elements.lightbox?.addEventListener('click', (e) => {
        if (e.target === elements.lightbox || e.target.classList.contains('lightbox-backdrop')) {
            closeLightbox();
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
        alert('Please select a model first');
        return;
    }
    
    // Clear welcome message if present
    const welcome = elements.messages?.querySelector('.welcome-message');
    if (welcome) welcome.remove();
    
    // Add user message to conversation
    currentExchangeId = conversation.addExchange(content, [...attachedImages]);
    
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
    const temperature = parseFloat(elements.temperature?.value) || 0.7;
    const maxTokens = parseInt(elements.maxTokens?.value) || 2048;
    
    // Create assistant message element
    const assistantEl = createAssistantElement(exchangeId);
    elements.messages?.appendChild(assistantEl);
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
                transcode: 'webp',
                quality: 85
            };
        }
        
        let contentBuffer = '';
        let thinkingBuffer = '';
        let inThinking = false;
        
        for await (const event of streamer.streamChat(requestBody)) {
            switch (event.type) {
                case 'delta':
                    contentBuffer += event.content;
                    
                    // Parse thinking blocks
                    const parsed = parseThinking(contentBuffer);
                    
                    if (parsed.thinking !== null && !inThinking) {
                        inThinking = true;
                        showThinkingIndicator(assistantEl, parsed.thinking);
                    } else if (parsed.thinking !== null) {
                        updateThinking(assistantEl, parsed.thinking);
                    }
                    
                    if (parsed.answer) {
                        updateAssistantContent(assistantEl, parsed.answer);
                    }
                    
                    conversation.updateAssistantResponse(exchangeId, event.content);
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
                    showError(assistantEl, event.error);
                    conversation.setAssistantError(exchangeId, event.error);
                    break;
                    
                case 'aborted':
                    showError(assistantEl, 'Stopped');
                    break;
                    
                case 'done':
                    conversation.setAssistantComplete(exchangeId);
                    finalizeAssistantElement(assistantEl, exchangeId);
                    break;
            }
            
            scrollToBottom();
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
            userContent += `<img src="${att.dataUrl}" alt="${att.name}" onclick="openLightbox('${att.dataUrl}')">`;
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
    
    // Parse thinking and answer
    const parsed = parseThinking(content);
    
    let html = '';
    
    // Render thinking block if exists
    if (parsed.thinking !== null) {
        const isCollapsed = contentDiv.querySelector('.thinking-block:not(.streaming)') !== null;
        const thinkingClass = isCollapsed ? 'collapsed' : '';
        const thinkingId = 'thinking-' + el.dataset.exchangeId;
        
        html += `
            <div class="thinking-block ${thinkingClass}" id="${thinkingId}">
                <div class="thinking-header" onclick="toggleThinking('${thinkingId}')">
                    <span class="thinking-icon">🧠</span>
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
        thinkEl.className = 'thinking-block streaming';
        thinkEl.innerHTML = `
            <div class="thinking-header" onclick="toggleThinking('${thinkingId}')">
                <span class="thinking-icon">🧠</span>
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

function updateThinking(el, thinking) {
    const thinkEl = el.querySelector('.thinking-block .thinking-content');
    if (thinkEl) {
        thinkEl.textContent = thinking;
    }
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

function startNewChat() {
    if (isStreaming) {
        streamer.abort();
    }
    
    conversation.clear();
    renderConversation();
}

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

// ============================================
// Start
// ============================================

init();
