// ============================================
// Conversation State Management
// ============================================

import { imageStore } from './image-store.js';

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
    // Exchange Management
    // ============================================

    async addExchange(userContent, attachments = []) {
        const exchange = {
            id: this._generateId(),
            timestamp: Date.now(),
            user: {
                role: 'user',
                content: userContent,
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
            }
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
            this.exchanges.splice(index, 1);
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

        // Save this version only if it's unique to prevent accidental double-pushes
        if (!exchange.assistant.versions.some(v => v.content === exchange.assistant.content)) {
            exchange.assistant.versions.push({
                content: exchange.assistant.content,
                timestamp: Date.now(),
                usage: usage,
                context: contextInfo
            });
            // Update current version to point to the latest
            exchange.assistant.currentVersion = exchange.assistant.versions.length - 1;
        }

        this.save();
    }

    setAssistantError(exchangeId, error) {
        const exchange = this.getExchange(exchangeId);
        if (!exchange) return;
        
        exchange.assistant.isStreaming = false;
        exchange.assistant.error = error;
        this.save(); // Persist error state
    }

    // ============================================
    // Version Control (Regenerate)
    // ============================================

    regenerateResponse(exchangeId) {
        const exchange = this.getExchange(exchangeId);
        if (!exchange) return false;
        
        // Save current as version if not already saved
        if (exchange.assistant.content && !exchange.assistant.versions.find(v => v.content === exchange.assistant.content)) {
            exchange.assistant.versions.push({
                content: exchange.assistant.content,
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

    getMessagesForApi(systemPrompt = '') {
        const messages = [];
        
        // Add system prompt if provided
        if (systemPrompt?.trim()) {
            messages.push({
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
            
            // User message
            // Only include attachments for the current (last) exchange
            const validAttachments = isLastExchange 
                ? exchange.user.attachments?.filter(att => att.getDataUrl || att.dataUrl) || []
                : [];
                
            if (validAttachments.length > 0) {
                // Multimodal content - text first, then images
                const content = [
                    {
                        type: 'text',
                        text: exchange.user.content
                    },
                    ...validAttachments.map(att => ({
                        type: 'image_url',
                        image_url: { 
                            url: att.getDataUrl ? att.getDataUrl() : att.dataUrl, 
                            detail: 'auto' 
                        }
                    }))
                ];
                messages.push({ role: 'user', content });
            } else {
                messages.push({
                    role: 'user',
                    content: exchange.user.content
                });
            }
            
            // Assistant message (only if complete)
            if (exchange.assistant.isComplete && exchange.assistant.content) {
                messages.push({
                    role: 'assistant',
                    content: exchange.assistant.content
                });
            }
        }
        
        return messages;
    }

    // ============================================
    // Persistence
    // ============================================

    save() {
        try {
            // Strip dataUrl before saving to localStorage (images are in IndexedDB)
            const exchangesToSave = this.exchanges.map(ex => ({
                ...ex,
                user: {
                    ...ex.user,
                    attachments: ex.user.attachments?.map(att => ({
                        name: att.name,
                        type: att.type,
                        hasImage: att.hasImage
                        // dataUrl is intentionally omitted
                    })) || []
                }
            }));
            localStorage.setItem(this.storageKey, JSON.stringify(exchangesToSave));
        } catch (error) {
            console.error('[Conversation] Failed to save:', error);
            // Handle quota exceeded - remove oldest exchanges
            if (error.name === 'QuotaExceededError' && this.exchanges.length > 5) {
                const removed = this.exchanges.slice(0, -5);
                this.exchanges = this.exchanges.slice(-5);
                // Clean up IndexedDB for removed exchanges
                removed.forEach(ex => imageStore.delete(ex.id));
                this.save();
            }
        }
    }

    async load() {
        try {
            const data = localStorage.getItem(this.storageKey);
            if (data) {
                this.exchanges = JSON.parse(data);
                
                // Load images from IndexedDB for each exchange
                for (const ex of this.exchanges) {
                    if (ex.user.attachments?.some(att => att.hasImage)) {
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
        localStorage.removeItem(this.storageKey);
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


