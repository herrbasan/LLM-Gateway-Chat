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
const DEFAULT_MAX_TOKENS = CONFIG.defaultMaxTokens || '';

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
    
    // Load session metadata from localStorage (with defaults)
    const savedName = localStorage.getItem('chat-user-name');
    const savedLocation = localStorage.getItem('chat-user-location');
    const savedLanguage = localStorage.getItem('chat-user-language');
    
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
    
    // Session metadata - save to localStorage on change
    elements.userName?.querySelector('input')?.addEventListener('change', (e) => {
        localStorage.setItem('chat-user-name', e.target.value);
    });
    elements.userLocation?.querySelector('input')?.addEventListener('change', (e) => {
        localStorage.setItem('chat-user-location', e.target.value);
    });
    elements.userLanguage?.querySelector('input')?.addEventListener('change', (e) => {
        localStorage.setItem('chat-user-language', e.target.value);
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
        return `${metadata}\n\n${userPrompt}`;
    }
    return metadata;
}

// ============================================
// Message Sending
// ============================================

async function sendMessage() {
    const editor = elements.messageInput;
    const content = editor?.getMarkdown().trim();
    
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
    editor.setMarkdown('');
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
    
    // Prepend timestamp to assistant response for LLM context
    const assistantTimestamp = conversation._formatTimestamp();
    const timestampWithSpace = assistantTimestamp + ' ';
    conversation.updateAssistantResponse(exchangeId, timestampWithSpace);
    const systemPrompt = getSystemPromptWithMetadata();
    const temperature = parseFloat(elements.temperature?.value) || DEFAULT_TEMPERATURE;
    const maxTokensStr = elements.maxTokens?.querySelector('input')?.value || elements.maxTokens?.value;
    const maxTokens = maxTokensStr ? parseInt(maxTokensStr) : null;
    
    // Get or create assistant message element
    let assistantEl = elements.messages?.querySelector(`.chat-message.assistant[data-exchange-id="${exchangeId}"]`);
    if (!assistantEl) {
        assistantEl = createAssistantElement(exchangeId);
        elements.messages?.appendChild(assistantEl);
    }
    // Store timestamp info for stripping during rendering (reset on regeneration)
    const tsLen = timestampWithSpace.length;
    assistantEl.dataset.timestampLen = tsLen.toString();
    assistantEl.dataset.timestampStripped = 'true';
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
                    if (statusEl) statusEl.classList.remove('visible');

                    contentBuffer += event.content;
                    conversation.updateAssistantResponse(exchangeId, event.content);
                    
                    // Debounce DOM updates to prevent freezing
                    if (!pendingUpdate) {
                        pendingUpdate = true;
                        const now = performance.now();
                        const delay = Math.max(0, RENDER_INTERVAL - (now - lastRender));
                        
                        const wasNearBottom = isNearBottom();
                        setTimeout(() => {
                            // Reconstruct full content with timestamp for proper stripping
                            const tsMatch = exchange.assistant.content.match(TIMESTAMP_REGEX);
                            const fullContent = tsMatch ? tsMatch[0] + contentBuffer : contentBuffer;
                            updateAssistantContent(assistantEl, fullContent);
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
                    break;
                    
                case 'aborted':
                    // Reconstruct full content with timestamp for proper stripping
                    const abortTsMatch = exchange.assistant.content.match(TIMESTAMP_REGEX);
                    const abortFullContent = abortTsMatch ? abortTsMatch[0] + contentBuffer : contentBuffer;
                    updateAssistantContent(assistantEl, stripExtraTimestamps(abortFullContent));
                    showError(assistantEl, 'Stopped');
                    break;
                    
                case 'done':
                    // contentBuffer doesn't include our injected timestamp
                    // Get the exchange to find the original timestamp we injected
                    const ex = conversation.getExchange(exchangeId);
                    const tsMatch = ex?.assistant?.content?.match(TIMESTAMP_REGEX);
                    let finalContent;
                    if (tsMatch) {
                        // Reconstruct: original timestamp + content buffer (no LLM timestamp)
                        finalContent = tsMatch[0] + contentBuffer;
                    } else {
                        finalContent = contentBuffer;
                    }
                    // Strip any extra timestamps LLM may have generated
                    finalContent = stripExtraTimestamps(finalContent);
                    // Update exchange with correct content
                    if (ex) {
                        ex.assistant.content = finalContent;
                    }
                    // Ensure final content is rendered
                    updateAssistantContent(assistantEl, finalContent);
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
    // Parse timestamps from content
    const userParsed = parseTimestamp(exchange.user.content);
    const userTimestamp = userParsed.timestamp || new Date(exchange.timestamp).toISOString().slice(0,16).replace('T',' @ ');
    
    // User message
    const userEl = document.createElement('div');
    userEl.className = 'chat-message user';
    userEl.dataset.exchangeId = exchange.id;

    let userContent = renderMarkdown(userParsed.cleanContent);

    // Add attachment previews
    if (exchange.user.attachments?.length > 0) {
        userContent += '<div class="message-attachments"><nui-lightbox loop>';
        for (const att of exchange.user.attachments) {
            // Use blobUrl for loaded images, dataUrl for new attachments
            const displayUrl = att.blobUrl || att.dataUrl || '';
            const dataUrl = att.getDataUrl ? att.getDataUrl() : att.dataUrl;
            userContent += `<img src="${displayUrl}" alt="${att.name}" data-lightbox-src="${dataUrl}" class="chat-attachment">`
        }
        userContent += '</nui-lightbox></div>';
    }
    
    userEl.innerHTML = `
        <div class="message-header">You <span class="message-timestamp">${userTimestamp}</span></div>
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
        elements.messages?.appendChild(assistantEl);
        
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

function updateAssistantContent(el, content) {
    const contentDiv = el.querySelector('.message-content');
    if (!contentDiv) return;

    // Strip the injected timestamp from visible content (shown in header)
    // We know the exact format: [YYYY-MM-DD@HH:MM] with optional space
    if (el.dataset.timestampLen && content.startsWith('[')) {
        const len = parseInt(el.dataset.timestampLen);
        if (content.length >= len) {
            content = content.substring(len);
        } else if (content.length < 20) {
            // Not enough content yet, likely still building up timestamp
            return;
        }
        // If content is between 17-19 chars and starts with '[', it might be partial timestamp
        // Just strip what we can and continue
    } else if (content.startsWith('[')) {
        // Fallback: try to parse timestamp (for backwards compatibility)
        const tsParsed = parseTimestamp(content);
        content = tsParsed.cleanContent;
    }

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
        }

        // Only re-render markdown if answer content changed
        const newHtml = renderMarkdown(parsed.answer);
        if (answerContainer.dataset.lastHtml !== newHtml) {
            answerContainer.innerHTML = newHtml;
            answerContainer.dataset.lastHtml = newHtml;
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
    } else if (exchange && exchange.assistant.content) {
        // If we lack explicit context stats, fallback to a heuristic estimation if it's rendered in history
        const userContent = typeof exchange.user.content === 'string' ? exchange.user.content : '';
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
    if (isStreaming) return;
    
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
    // Block editing only if this specific exchange is currently streaming
    if (isStreaming && currentExchangeId === exchangeId) return;

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
    
    // Skip confirmation on shift-click
    const skipConfirm = e.shiftKey;
    
    if (!skipConfirm && !await nui.components.dialog.confirm('Delete Chat', 'Are you sure you want to delete this chat?')) {
        return;
    }
    
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

function exportChatAsJson(chatId, btn) {
    // Export for debugging - excludes images, just metadata
    const chatDataString = localStorage.getItem(`chat-conversation-${chatId}`);
    if (!chatDataString) return;
    
    try {
        const exchanges = JSON.parse(chatDataString);
        // Create debug version without any image data
        const debugExchanges = exchanges.map(ex => ({
            ...ex,
            user: {
                ...ex.user,
                attachments: ex.user.attachments?.map(att => ({
                    name: att.name,
                    type: att.type,
                    hasImage: att.hasImage
                    // Intentionally omit dataUrl/blobUrl
                })) || []
            }
        }));
        const formattedJson = JSON.stringify(debugExchanges, null, 2);
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
    const chatDataString = localStorage.getItem(`chat-conversation-${chatId}`);
    if (!chatDataString) return;
    
    try {
        const exchanges = JSON.parse(chatDataString);
        const exportData = {
            version: 1,
            exportedAt: new Date().toISOString(),
            chatId: chatId,
            chatInfo: chatHistory.find(c => c.id === chatId) || null,
            exchanges: []
        };
        
        // Load images for each exchange
        for (const ex of exchanges) {
            const exportExchange = { ...ex };
            
            if (ex.user.attachments?.some(att => att.hasImage)) {
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
        
        // Create new chat ID
        const newChatId = 'ex_' + Date.now();
        const title = importData.chatInfo?.title || 'Imported Chat';
        
        // Add to history
        chatHistory.unshift({
            id: newChatId,
            title: title,
            timestamp: Date.now(),
            model: importData.chatInfo?.model || ''
        });
        localStorage.setItem(HISTORY_KEY, JSON.stringify(chatHistory));
        
        // Process exchanges - save images to IndexedDB
        const processedExchanges = [];
        for (const ex of importData.exchanges) {
            const processedEx = { ...ex };
            
            // Strip dataUrl from attachments for storage, save to IndexedDB
            if (ex.user.attachments?.some(att => att.dataUrl)) {
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
        
        // Save conversation
        localStorage.setItem(`chat-conversation-${newChatId}`, JSON.stringify(processedExchanges));
        
        // Switch to imported chat
        renderHistoryList();
        await switchChat(newChatId);
        
        nui.components.toast?.success?.('Chat imported successfully');
        
    } catch (err) {
        console.error('Failed to import chat', err);
        nui.components.dialog.alert('Import Failed', `Could not import chat: ${err.message}`);
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
        exportJsonBtn.title = 'Copy JSON to clipboard (debug, no images)';
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





