// ============================================
// Conversation State Management
// ============================================

import { imageStore } from './image-store.js';
import { storage } from './storage.js';
import { backendClient } from './api-client.js';

const _CONFIG = window.CHAT_CONFIG || {};
const _USE_BACKEND = _CONFIG.enableBackend === true && !!_CONFIG.backendUrl;

export class Conversation {
    constructor(storageKey = 'chat-conversation', sessionId = null) {
        this.exchanges = [];
        this.storageKey = storageKey;
        this.sessionId = sessionId || this._extractId();
        this._pendingBackendSync = new Map();
    }

    _extractId() {
        return this.storageKey.replace('chat-conversation-', '');
    }

    // Generate unique ID
    _generateId() {
        return 'ex_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    }

    _syncMessage(role, content, model = null, exchangeId = null, metadata = null) {
        if (!_USE_BACKEND || !backendClient.apiKey || !this.sessionId) return;
        const body = { role, content, model };
        if (metadata) Object.assign(body, metadata);
        console.log('[Conversation] Syncing to backend:', role, 'sessionId:', this.sessionId);
        backendClient.sendMessage(this.sessionId, body)
            .then(() => {
                console.log('[Conversation] Backend sync OK:', role, 'sessionId:', this.sessionId);
                if (exchangeId) this._pendingBackendSync.delete(exchangeId);
            })
            .catch(err => {
                console.warn('[Conversation] Backend sync failed:', err.message, 'sessionId:', this.sessionId);
                if (exchangeId) this._pendingBackendSync.set(exchangeId, { role, content, model });
            });
    }

    // ============================================
    // Timestamp Formatting
    // ============================================
    
    _formatTimestamp(date = new Date()) {
        const pad = (n) => n.toString().padStart(2, '0');
        return `[${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}@${pad(date.getHours())}:${pad(date.getMinutes())}]`;
    }
    
    _prependTimestamp(content, timestamp) {
        const ts = this._formatTimestamp(new Date(timestamp));
        return `${ts} ${content}`;
    }
    
    _stripExtraTimestamps(content) {
        // Keep the first timestamp, remove any subsequent ones
        const TIMESTAMP_REGEX_GLOBAL = /\[\d{4}-\d{2}-\d{2}@\d{2}:\d{2}\]\s*/g;
        let first = true;
        return content.replace(TIMESTAMP_REGEX_GLOBAL, (match) => {
            if (first) {
                first = false;
                return match;
            }
            return '';
        });
    }

    // ============================================
    // Exchange Management
    // ============================================

    async addToolExchange(toolName, toolArgs, callId = null, userId = null) {
        const timestamp = Date.now();
        const exchange = {
            id: this._generateId(),
            timestamp: timestamp,
            type: 'tool', // special flag for UI and shim
            userId: userId, // original user exchange ID for chained tool calls
            tool: {
                role: 'tool',
                callId: callId,
                name: toolName,
                args: toolArgs,
                status: 'pending',
                content: '',
                images: []
            },
            assistant: {
                role: 'assistant',
                content: '',
                versions: [],
                currentVersion: 0,
                isStreaming: true,
                isComplete: false
            }
        };
        this.exchanges.push(exchange);
        this.save();
        this._syncMessage('tool', '', null, exchange.id, { 
            toolName, 
            toolArgs,
            toolStatus: 'pending'
        });
        return exchange.id;
    }

    async addExchange(userContent, attachments = []) {
        const timestamp = Date.now();
        const contentWithTimestamp = this._prependTimestamp(userContent, timestamp);
        
        const exchange = {
            id: this._generateId(),
            timestamp: timestamp,
            user: {
                role: 'user',
                content: contentWithTimestamp,
                // Store only metadata in memory, not full dataUrl
                attachments: attachments.map(att => ({
                    name: att.name,
                    type: att.type,
                    hasImage: !!att.dataUrl
                }))
            },
            assistant: {
                role: 'assistant',
                content: '',
                versions: [], // Array of alternative responses
                currentVersion: 0,
                isStreaming: true,
                isComplete: false
            },
            systemPrompt: '' // Will be set when sending to gateway
        };
        
        // Store full images in IndexedDB
        if (attachments.length > 0) {
            await imageStore.save(exchange.id, attachments);
            // Store with blobUrl for display, getDataUrl for API
            exchange.user.attachments = attachments.map(att => ({
                name: att.name,
                type: att.type,
                hasImage: !!att.dataUrl,
                dataUrl: att.dataUrl,  // Original dataUrl for immediate API use
                blobUrl: att.dataUrl   // Use dataUrl as blobUrl for newly added images
            }));
        }
        
        this.exchanges.push(exchange);
        this.save();
        this._syncMessage('user', contentWithTimestamp, null, exchange.id);
        return exchange.id;
    }

    getExchange(id) {
        return this.exchanges.find(e => e.id === id);
    }

    deleteExchange(id) {
        const index = this.exchanges.findIndex(e => e.id === id);
        if (index !== -1) {
            imageStore.delete(id);
            this.exchanges.splice(index, 1);
            this.save();
        }
    }

    truncateAfter(id) {
        const index = this.exchanges.findIndex(e => e.id === id);
        if (index !== -1) {
            // Delete images for orphaned downstream exchanges
            for (let i = index + 1; i < this.exchanges.length; i++) {
                imageStore.delete(this.exchanges[i].id);
            }
            // Splice array to remove exchanges *after* 'index' (dropping index+1 onward)
            // Splice arguments: start, deleteCount. 
            // Start at index + 1, delete until the end.
            this.exchanges.splice(index + 1);
            this.save();
        }
    }

    // ============================================
    // Assistant Response Management
    // ============================================

    updateAssistantResponse(exchangeId, delta) {
        const exchange = this.getExchange(exchangeId);
        if (!exchange) return;
        
        exchange.assistant.content += delta;
        // Note: We don't save here during streaming to avoid excessive storage writes.
        // Content accumulates in memory and is persisted when setAssistantComplete() is called.
    }

    updateAssistantReasoning(exchangeId, delta) {
        const exchange = this.getExchange(exchangeId);
        if (!exchange) return;
        
        if (typeof exchange.assistant.reasoning_content !== 'string') {
            exchange.assistant.reasoning_content = '';
        }
        exchange.assistant.reasoning_content += delta;
    }

    setAssistantComplete(exchangeId, usage = null, contextInfo = null, thinkingData = null) {
        const exchange = this.getExchange(exchangeId);
        if (!exchange) return;

        // Prevent multiple completions logic from double-pushing
        if (exchange.assistant.isComplete) return;

        exchange.assistant.isStreaming = false;
        exchange.assistant.isComplete = true;

        if (usage) exchange.assistant.usage = usage;
        if (contextInfo) exchange.assistant.context = contextInfo;
        if (thinkingData?.reasoning_content) {
            exchange.assistant.reasoning_content = thinkingData.reasoning_content;
        }
        if (thinkingData?.thinking_signature) {
            exchange.assistant.thinking_signature = thinkingData.thinking_signature;
        }

        // Clean content - remove any duplicate timestamps the LLM may have generated
        const cleanedContent = this._stripExtraTimestamps(exchange.assistant.content);
        exchange.assistant.content = cleanedContent;

        // Save this version only if it's unique to prevent accidental double-pushes
        if (!exchange.assistant.versions.some(v => v.content === cleanedContent)) {
            exchange.assistant.versions.push({
                content: cleanedContent,
                timestamp: Date.now(),
                usage: usage,
                context: contextInfo
            });
            // Update current version to point to the latest
            exchange.assistant.currentVersion = exchange.assistant.versions.length - 1;
        }

        this._syncMessage('assistant', cleanedContent, null, exchangeId);

        return this.save();
    }

    setSystemPrompt(exchangeId, systemPrompt) {
        const exchange = this.getExchange(exchangeId);
        if (!exchange) return Promise.resolve();
        exchange.systemPrompt = systemPrompt;
        return this.save();
    }

    setAssistantError(exchangeId, error) {
        const exchange = this.getExchange(exchangeId);
        if (!exchange) return Promise.resolve();
        
        exchange.assistant.isStreaming = false;
        exchange.assistant.isComplete = true; // Mark as complete so history exporter picks up the exchange
        exchange.assistant.error = error;
        return this.save(); // Persist error state
    }

    // ============================================
    // Version Control (Regenerate)
    // ============================================

    regenerateResponse(exchangeId) {
        const exchange = this.getExchange(exchangeId);
        if (!exchange) return false;
        
        // Clean and save current as version if not already saved
        const cleanedContent = this._stripExtraTimestamps(exchange.assistant.content);
        if (cleanedContent && !exchange.assistant.versions.find(v => v.content === cleanedContent)) {
            exchange.assistant.versions.push({
                content: cleanedContent,
                timestamp: Date.now()
            });
        }
        
        // Reset for new response
        exchange.assistant.content = '';
        exchange.assistant.isStreaming = true;
        exchange.assistant.isComplete = false;
        exchange.assistant.error = null;
        
        this.save();
        return true;
    }

    switchVersion(exchangeId, direction) {
        const exchange = this.getExchange(exchangeId);
        if (!exchange || exchange.assistant.versions.length === 0) return false;
        
        const versions = exchange.assistant.versions;
        let newIndex;
        
        if (direction === 'next') {
            newIndex = (exchange.assistant.currentVersion + 1) % versions.length;
        } else {
            newIndex = (exchange.assistant.currentVersion - 1 + versions.length) % versions.length;
        }
        
        exchange.assistant.currentVersion = newIndex;
        exchange.assistant.content = versions[newIndex].content;
        this.save();
        
        return true;
    }

    getVersionInfo(exchangeId) {
        const exchange = this.getExchange(exchangeId);
        if (!exchange) return null;
        
        return {
            current: exchange.assistant.currentVersion + 1,
            total: exchange.assistant.versions.length,
            hasMultiple: exchange.assistant.versions.length > 1
        };
    }

    // ============================================
    // API Format
    // ============================================

    // Helper to strip base64 data from tool args for API messages
    _sanitizeToolArgs(args) {
        if (!args || typeof args !== 'object') return args;
        
        const sanitized = {};
        for (const [key, value] of Object.entries(args)) {
            // Detect base64 image data (long strings starting with common base64 patterns)
            if (typeof value === 'string' && value.length > 1000 && 
                (/^[A-Za-z0-9+/]{100,}/.test(value) || 
                 value.startsWith('/9j/') ||  // JPEG
                 value.startsWith('iVBOR') || // PNG
                 value.startsWith('R0lGOD') || // GIF
                 value.startsWith('UEsDB')    // Common binary
                )) {
                sanitized[key] = `[BASE64_DATA](${value.length} chars)`;
            } else {
                sanitized[key] = value;
            }
        }
        return sanitized;
    }

    getMessagesForApi(systemPrompt = '') {
        const rawMessages = [];
        
        // Add system prompt if provided
        if (systemPrompt?.trim()) {
            rawMessages.push({
                role: 'system',
                content: systemPrompt.trim()
            });
        }
        
        // Add exchanges
        // Only include images for the LAST (current) exchange - previous images are in history
        const lastExchangeIndex = this.exchanges.length - 1;
        
        for (let i = 0; i < this.exchanges.length; i++) {
            const exchange = this.exchanges[i];
            const isLastExchange = i === lastExchangeIndex;

            // PHASE-3: Tool exchanges - add tool result as tool message, skip normal user/assistant
            if (exchange.type === 'tool') {
                if (exchange.tool.status === 'success' || exchange.tool.status === 'error') {
                    const callId = exchange.tool.callId || `call_${exchange.id}`;
                    
                    // --- BACKWARD COMPATIBILITY FIX ---
                    // Older chats (pre-migration) did not save `tool_calls` onto the preceding assistant exchange.
                    // This causes native tool APIs to reject the request due to orphaned tool_result blocks.
                    // We scan backwards to find the last assistant message and backfill the tool_call.
                    
                    let targetAssistant = null;
                    // Scan backwards to find the assistant message, but STOP if we hit a user/system message.
                    // The LLM provider structurally rejects if we skip over a user message to attach tool_calls to an older assistant.
                    for (let j = rawMessages.length - 1; j >= 0; j--) {
                        const lastMsg = rawMessages[j];
                        if (lastMsg.role === 'assistant') {
                            targetAssistant = lastMsg;
                            break;
                        } else if (lastMsg.role !== 'tool') {
                            break; // Cannot bridge across user/system messages
                        }
                    }
                    
                    if (targetAssistant) {
                        if (!targetAssistant.tool_calls) targetAssistant.tool_calls = [];
                        const hasMatchingCall = targetAssistant.tool_calls.some(tc => tc.id === callId);
                        if (!hasMatchingCall) {
                            let sanitizedArgs = {};
                            try {
                                sanitizedArgs = typeof exchange.tool.args === 'string' ? JSON.parse(exchange.tool.args) : exchange.tool.args;
                                sanitizedArgs = this._sanitizeToolArgs(sanitizedArgs);
                            } catch (e) {
                                sanitizedArgs = exchange.tool.args || {};
                            }
                            targetAssistant.tool_calls.push({
                                id: callId,
                                type: 'function',
                                function: {
                                    name: exchange.tool.name || 'unknown_tool',
                                    arguments: typeof sanitizedArgs === 'string' ? sanitizedArgs : JSON.stringify(sanitizedArgs)
                                }
                            });
                        }
                    } else {
                        // If no valid preceding assistant message is exposed, inject a dummy one
                        let sanitizedArgs = {};
                        try {
                            sanitizedArgs = typeof exchange.tool.args === 'string' ? JSON.parse(exchange.tool.args) : exchange.tool.args;
                            sanitizedArgs = this._sanitizeToolArgs(sanitizedArgs);
                        } catch (e) {
                            sanitizedArgs = exchange.tool.args || {};
                        }
                        
                        // We push the dummy assistant message into rawMessages BEFORE the tool result
                        rawMessages.push({
                            role: 'assistant',
                            content: null,
                            tool_calls: [{
                                id: callId,
                                type: 'function',
                                function: {
                                    name: exchange.tool.name || 'unknown_tool',
                                    arguments: typeof sanitizedArgs === 'string' ? sanitizedArgs : JSON.stringify(sanitizedArgs)
                                }
                            }]
                        });
                    }
                    // ----------------------------------

                    const toolResultObj = {
                        role: 'tool',
                        tool_call_id: callId,
                        content: exchange.tool.content || ''
                    };
                    
                    if (exchange.tool.images && exchange.tool.images.length > 0) {
                        toolResultObj.content = [
                            { type: 'text', text: exchange.tool.content || '' },
                            ...exchange.tool.images.map(imgUrl => ({
                                type: 'image_url',
                                image_url: { url: imgUrl, detail: 'auto' }
                            }))
                        ];
                    }

                    rawMessages.push(toolResultObj);
                }
                
                // Fall through to emit the assistant response (the follow-up after tool execution)
            } else {
                // User message (Only parse for normal exchanges)
                // Only include attachments for the current (last) exchange
                const validAttachments = isLastExchange
                    ? exchange.user?.attachments?.filter(att => att.getDataUrl || att.dataUrl) || []
                    : [];

                // Clean user content (in case of any timestamp duplication)
                const cleanUserContent = this._stripExtraTimestamps(exchange.user?.content || '');

                if (validAttachments.length > 0) {
                    // Multimodal content - text first, then images
                    const content = [
                        {
                            type: 'text',
                            text: cleanUserContent
                        },
                        ...validAttachments.map(att => ({
                            type: 'image_url',
                            image_url: {
                                url: att.getDataUrl ? att.getDataUrl() : att.dataUrl,
                                detail: 'auto'
                            }
                        }))
                    ];
                    rawMessages.push({ role: 'user', content });
                } else {
                    if (cleanUserContent) {
                        rawMessages.push({
                            role: 'user',
                            content: cleanUserContent
                        });
                    }
                }
            }

            // Assistant message (only if complete)
            if (exchange.assistant.isComplete && (exchange.assistant.content || exchange.assistant.reasoning_content || exchange.assistant.tool_calls)) {
                const cleanAssistantContent = exchange.assistant.content
                    ? this._stripExtraTimestamps(exchange.assistant.content).trim()
                    : '';

                if (cleanAssistantContent || exchange.assistant.reasoning_content || exchange.assistant.tool_calls) {
                    const msg = {
                        role: 'assistant',
                        content: cleanAssistantContent || null
                    };

                    if (exchange.assistant.reasoning_content) {
                        msg.reasoning_content = exchange.assistant.reasoning_content;
                        if (exchange.assistant.thinking_signature) {
                            msg.thinking_blocks = [{
                                type: 'thinking',
                                thinking: exchange.assistant.reasoning_content,
                                signature: exchange.assistant.thinking_signature
                            }];
                        } else {
                            // Anthropic/Deepseek models via specific gateways might require thinking even without signature
                            msg.thinking_blocks = [{
                                type: 'thinking',
                                thinking: exchange.assistant.reasoning_content,
                                signature: ''
                            }];
                        }
                    }

                    if (exchange.assistant.tool_calls) {
                        msg.tool_calls = exchange.assistant.tool_calls.map(tc => {
                            let sanitizedArgs = {};
                            try {
                                if (typeof tc.function?.arguments === 'string') {
                                    sanitizedArgs = this._sanitizeToolArgs(JSON.parse(tc.function.arguments));
                                } else if (typeof tc.function?.arguments === 'object') {
                                    sanitizedArgs = this._sanitizeToolArgs(tc.function.arguments);
                                }
                            } catch (e) {
                                // If parsing fails, pass raw as string
                                sanitizedArgs = tc.function?.arguments;
                            }
                            return {
                                id: tc.id,
                                type: 'function',
                                function: {
                                    name: tc.function?.name,
                                    arguments: typeof sanitizedArgs === 'string' ? sanitizedArgs : JSON.stringify(sanitizedArgs)
                                }
                            };
                        });
                    }

                    rawMessages.push(msg);
                }
            }

            if (exchange.assistant.error) {
                rawMessages.push({
                    role: 'user',
                    content: `[System Error Notification: The LLM Provider API rejected the payload or execution failed:\n${exchange.assistant.error}\nPlease correct the issue or state that you cannot proceed.]`
                });
            }
        }

        // Merge back-to-back messages of the same role to prevent API validation errors
        // (This happens if an assistant speaks, then calls a tool, creating two assistant parts)
        // NEVER merge 'tool' or 'system' roles! Each tool response must be an independent block.
        const messages = [];
        for (const msg of rawMessages) {
            if (messages.length > 0 && 
                messages[messages.length - 1].role === msg.role && 
                msg.role !== 'tool' && msg.role !== 'system' &&
                typeof msg.content === 'string' && 
                typeof messages[messages.length - 1].content === 'string' &&
                !msg.tool_calls && !messages[messages.length - 1].tool_calls) {
                
                messages[messages.length - 1].content += '\n' + msg.content;
            } else {
                messages.push(msg);
            }
        }

        // Auto-heal: Remove unmatched tool_calls to prevent permanent chat corruption (HTTP 400s).
        // If a tool execution crashed totally or was aborted before generating a tool_result block,
        // we strip the orphan tool_call from the history so the conversation can seamlessly continue.
        const validToolCallIds = new Set();
        for (const msg of messages) {
            if (msg.role === 'tool' && msg.tool_call_id) {
                validToolCallIds.add(msg.tool_call_id);
            }
        }
        
        for (const msg of messages) {
            if (msg.role === 'assistant' && msg.tool_calls) {
                msg.tool_calls = msg.tool_calls.filter(tc => validToolCallIds.has(tc.id));
                if (msg.tool_calls.length === 0) {
                    delete msg.tool_calls;
                }
            }
        }

        console.log('[getMessagesForApi] Final exact API payload:', JSON.stringify(messages, null, 2));

        return messages;
    }

    // ============================================
    // Persistence
    // ============================================

    async save() {
        // Strip dataUrl and systemPrompt before saving
        // (images are in IndexedDB via imageStore, systemPrompt is re-computed on load)
        const exchangesToSave = this.exchanges.map(ex => {
            const base = { ...ex };
            // Omit systemPrompt - it's re-computed and not needed after load
            delete base.systemPrompt;
            // Tool exchanges don't have user.attachments
            if (ex.user?.attachments) {
                base.user = {
                    ...ex.user,
                    attachments: ex.user.attachments.map(att => ({
                        name: att.name,
                        type: att.type,
                        hasImage: att.hasImage
                        // dataUrl is intentionally omitted
                    }))
                };
            }
            return base;
        });

        // Extract conversation ID from storageKey (format: "chat-conversation-{id}")
        const conversationId = this.storageKey.replace('chat-conversation-', '');
        try {
            await storage.saveConversation(conversationId, exchangesToSave);
        } catch (err) {
            console.error('[Conversation] Failed to save:', err);
        }
    }

    async load() {
        try {
            const conversationId = this.storageKey.replace('chat-conversation-', '');
            let loadedFromBackend = false;

            if (_USE_BACKEND && backendClient.apiKey && this.sessionId) {
                try {
                    const data = await backendClient.getSession(this.sessionId);
                    if (data && data.messages && data.messages.length > 0) {
                        this.exchanges = this._backendMessagesToExchanges(data.messages);
                        loadedFromBackend = true;
                    }
                } catch (err) {
                    console.warn('[Conversation] Backend load failed, falling back to local:', err.message);
                }
            }

            if (!loadedFromBackend) {
                const data = await storage.loadConversation(conversationId);
                if (data && data.length > 0) {
                    this.exchanges = data;
                }
            }

            if (this.exchanges.length > 0) {
                for (const ex of this.exchanges) {
                    if (ex.user && ex.user.attachments?.some(att => att.hasImage)) {
                        try {
                            const images = await imageStore.load(ex.id);
                            ex.user.attachments = ex.user.attachments.map((att, idx) => {
                                const img = images[idx];
                                if (!img) return att;
                                return {
                                    ...att,
                                    blobUrl: img.blobUrl,
                                    getDataUrl: img.getDataUrl
                                };
                            });
                        } catch (err) {
                            console.warn('[Conversation] Failed to load images for exchange', ex.id, err);
                        }
                    }

                    if (ex.assistant && Array.isArray(ex.assistant.versions) && ex.assistant.versions.length > 0) {
                        const uniqueVersions = [];
                        const seen = new Set();

                        for (const v of ex.assistant.versions) {
                            if (!seen.has(v.content)) {
                                seen.add(v.content);
                                uniqueVersions.push(v);
                            }
                        }

                        ex.assistant.versions = uniqueVersions;

                        if (ex.assistant.currentVersion >= uniqueVersions.length) {
                            ex.assistant.currentVersion = Math.max(0, uniqueVersions.length - 1);
                        }
                    }
                }
            }
        } catch (error) {
            console.error("[Conversation] Failed to load:", error);
            this.exchanges = [];
        }
    }

    _backendMessagesToExchanges(messages) {
        // Messages come in order from the conversation doc. Walk sequentially,
        // grouping into exchanges: user starts new exchange, assistant attaches
        // to last tool exchange if one exists, otherwise to the regular exchange.

        const groups = [];
        let current = [];
        for (const msg of messages) {
            if (msg.role === 'user' && current.length > 0) {
                groups.push(current);
                current = [msg];
            } else {
                current.push(msg);
            }
        }
        if (current.length > 0) groups.push(current);

        const exchanges = [];

        for (const group of groups) {
            let regularExchange = null;
            let lastToolExchange = null;
            const pendingTools = new Map();

            for (const msg of group) {
                if (msg.role === 'user') {
                    regularExchange = {
                        id: 'ex_' + (Date.now() + Math.random()),
                        timestamp: new Date(msg.createdAt).getTime() || Date.now(),
                        user: { role: 'user', content: msg.content || '', attachments: msg.attachments || [] },
                        assistant: { role: 'assistant', content: '', versions: [], currentVersion: 0, isStreaming: false, isComplete: false }
                    };
                } else if (msg.role === 'tool') {
                    const toolName = msg.toolName;
                    const toolContent = msg.content || '';
                    if (!toolName && !toolContent) continue;
                    if (msg.toolStatus === 'pending') { pendingTools.set(toolName, msg); continue; }
                    if (msg.toolStatus === 'success') pendingTools.delete(toolName);

                    const toolEx = {
                        id: 'ex_' + (Date.now() + Math.random()),
                        timestamp: new Date(msg.createdAt).getTime() || Date.now(),
                        type: 'tool',
                        tool: { name: toolName || 'unknown', args: msg.toolArgs || {}, status: msg.toolStatus || 'success', content: toolContent, images: msg.toolImages || [] },
                        user: { role: 'user', content: '', attachments: [] },
                        assistant: { role: 'assistant', content: '', versions: [], currentVersion: 0, isStreaming: false, isComplete: false }
                    };
                    exchanges.push(toolEx);
                    lastToolExchange = toolEx;
                } else if (msg.role === 'assistant') {
                    const content = (msg.content || '').trim();
                    if (!content) continue;
                    const target = lastToolExchange || regularExchange;
                    if (target) {
                        target.assistant.content = target.assistant.content ? target.assistant.content + '\n' + content : content;
                        target.assistant.isComplete = true;
                        if (!target.assistant.versions.length) target.assistant.versions = [{ content, timestamp: Date.now() }];
                    }
                }
            }

            for (const [toolName, toolMsg] of pendingTools) {
                exchanges.push({
                    id: 'ex_' + (Date.now() + Math.random()),
                    timestamp: new Date(toolMsg.createdAt).getTime() || Date.now(),
                    type: 'tool',
                    tool: { name: toolName || 'unknown', args: toolMsg.toolArgs || {}, status: 'pending', content: toolMsg.content || '', images: toolMsg.toolImages || [] },
                    user: { role: 'user', content: '', attachments: [] },
                    assistant: { role: 'assistant', content: '', versions: [], currentVersion: 0, isStreaming: false, isComplete: false }
                });
            }
            if (regularExchange) exchanges.push(regularExchange);
        }

        return exchanges.sort((a, b) => a.timestamp - b.timestamp);
    }

    async clear() {
        // Clear IndexedDB images
        await imageStore.clear();
        this.exchanges = [];
        const conversationId = this.storageKey.replace('chat-conversation-', '');
        storage.deleteConversation(conversationId);
    }

    /**
     * Get storage info for debugging
     */
    async getStorageInfo() {
        return await imageStore.getSize();
    }

    // ============================================
    // Getters
    // ============================================

    getAll() {
        return this.exchanges;
    }

    getLast() {
        return this.exchanges[this.exchanges.length - 1] || null;
    }

    get length() {
        return this.exchanges.length;
    }
}


