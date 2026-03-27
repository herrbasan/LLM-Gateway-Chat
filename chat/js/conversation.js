// ============================================
// Conversation State Management
// ============================================

import { imageStore } from './image-store.js';
import { storage } from './storage.js';

export class Conversation {
    constructor(storageKey = 'chat-conversation') {
        this.exchanges = []; // {id, user: {role, content, attachments}, assistant: {role, content, versions: [], currentVersion}}
        this.storageKey = storageKey;
        this.load();
    }

    // Generate unique ID
    _generateId() {
        return 'ex_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
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

    async addToolExchange(toolName, toolArgs, userId = null) {
        const timestamp = Date.now();
        const exchange = {
            id: this._generateId(),
            timestamp: timestamp,
            type: 'tool', // special flag for UI and shim
            userId: userId, // original user exchange ID for chained tool calls
            tool: {
                role: 'tool',
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

    setAssistantComplete(exchangeId, usage = null, contextInfo = null) {
        const exchange = this.getExchange(exchangeId);
        if (!exchange) return;

        // Prevent multiple completions logic from double-pushing
        if (exchange.assistant.isComplete) return;

        exchange.assistant.isStreaming = false;
        exchange.assistant.isComplete = true;

        if (usage) exchange.assistant.usage = usage;
        if (contextInfo) exchange.assistant.context = contextInfo;

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

            // PHASE-3: Tool exchanges - add tool result as user message, skip normal user/assistant
            if (exchange.type === 'tool') {
                if (exchange.tool.status === 'success' || exchange.tool.status === 'error') {
                    // 1) First, insert the assistant's tool call so the LLM remembers what it did
                    // Strip base64 data from tool args to prevent bloating context
                    const sanitizedArgs = this._sanitizeToolArgs(exchange.tool.args);
                    rawMessages.push({
                        role: 'assistant',
                        content: `__TOOL_CALL__({"name": "${exchange.tool.name}", "args": ${JSON.stringify(sanitizedArgs)}})`
                    });

                    // 2) Then, provide the tool result back as the user
                    const toolResultText = `<tool_result>\n  <tool_name>${exchange.tool.name}</tool_name>\n  <status>${exchange.tool.status}</status>\n  <output>\n${exchange.tool.content || ''}\n  </output>\n</tool_result>`;
                    
                    let toolResultOptions = { role: 'user', content: toolResultText };
                    
                    // Attach images for tool exchanges if present
                    if (exchange.tool.images && exchange.tool.images.length > 0) {
                        toolResultOptions.content = [
                            { type: 'text', text: toolResultText },
                            ...exchange.tool.images.map(imgUrl => ({
                                type: 'image_url',
                                image_url: { url: imgUrl, detail: 'auto' }
                            }))
                        ];
                    }

                    rawMessages.push(toolResultOptions);
                }
                
                // Do not 'continue;' here! We must allow the assistant's response that generated AFTER the tool execution
                // to be appended to the context, just like normal exchanges.
                // However, since it is a tool exchange, it has no `user` message to push, so we just skip the user part and let the assistant part be evaluated below.
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
            if (exchange.assistant.isComplete && exchange.assistant.content) {
                // Clean assistant content (remove duplicate timestamps and thinking portions)
                const cleanAssistantContent = this._stripExtraTimestamps(exchange.assistant.content)
                    .replace(/<think>[\s\S]*?<\/think>/g, '')
                    .trim();

                if (cleanAssistantContent) {
                    rawMessages.push({
                        role: 'assistant',
                        content: cleanAssistantContent
                    });
                }
            }
        }

        // Merge back-to-back messages of the same role to prevent API validation errors
        // (This happens if an assistant speaks, then calls a tool, creating two assistant parts)
        const messages = [];
        for (const msg of rawMessages) {
            if (messages.length > 0 && messages[messages.length - 1].role === msg.role && typeof msg.content === 'string' && typeof messages[messages.length - 1].content === 'string') {
                messages[messages.length - 1].content += '\n' + msg.content;
            } else {
                messages.push(msg);
            }
        }

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
            // Extract conversation ID from storageKey (format: "chat-conversation-{id}")
            const conversationId = this.storageKey.replace('chat-conversation-', '');
            const data = await storage.loadConversation(conversationId);

            if (data && data.length > 0) {
                this.exchanges = data;

                // Load images from IndexedDB for each exchange
                for (const ex of this.exchanges) {
                    if (ex.user && ex.user.attachments?.some(att => att.hasImage)) {
                        try {
                            const images = await imageStore.load(ex.id);
                            // Merge image data with metadata
                            ex.user.attachments = ex.user.attachments.map((att, idx) => {
                                const img = images[idx];
                                if (!img) return att;
                                return {
                                    ...att,
                                    blobUrl: img.blobUrl,      // For display
                                    getDataUrl: img.getDataUrl // Function for API
                                };
                            });
                        } catch (err) {
                            console.warn('[Conversation] Failed to load images for exchange', ex.id, err);
                        }
                    }

                    // Cleanup routine for historically duplicated versions
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


