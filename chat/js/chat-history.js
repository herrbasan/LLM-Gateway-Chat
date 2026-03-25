// ============================================
// Chat History Management - Multiple Conversations
// ============================================

import { storage, PREFIX_CONV } from './storage.js';

/**
 * Manages a list of saved conversations.
 * Each conversation has metadata (id, title, timestamp) + the full conversation data.
 */
export class ChatHistory {
    constructor() {
        this.conversations = [];
        this._loadPromise = this._loadList();
    }

    async _loadList() {
        try {
            this.conversations = await storage.loadHistory();
        } catch (error) {
            console.error('[ChatHistory] Failed to load list:', error);
            this.conversations = [];
        }
    }

    async _saveList() {
        try {
            await storage.saveHistory(this.conversations);
        } catch (error) {
            console.error('[ChatHistory] Failed to save list:', error);
        }
    }

    // ============================================
    // Conversation CRUD
    // ============================================

    /**
     * Create a new conversation entry
     * @returns {string} The new conversation ID
     */
    create() {
        const id = 'chat_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
        const sessionId = `sess-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
        const conversation = {
            id,
            sessionId,
            title: 'New Chat',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            messageCount: 0,
            model: ''
        };

        // Add to beginning of list
        this.conversations.unshift(conversation);
        this._saveList();
        this._setActiveId(id);

        // Initialize empty conversation data
        this._saveConversationData(id, []);

        return id;
    }

    /**
     * Save/update a conversation's data
     * @param {string} id - Conversation ID
     * @param {Array} exchanges - Array of exchange objects
     * @param {string} model - Current model ID
     */
    save(id, exchanges, model = '') {
        // Update metadata
        const meta = this.conversations.find(c => c.id === id);
        if (!meta) return false;

        meta.updatedAt = Date.now();
        meta.messageCount = exchanges.length;
        if (model) meta.model = model;

        // Generate title from first user message
        if (exchanges.length > 0 && meta.title === 'New Chat') {
            const firstUserMsg = exchanges[0]?.user?.content?.trim();
            if (firstUserMsg) {
                meta.title = this._generateTitle(firstUserMsg);
            }
        }

        this._saveList();
        this._saveConversationData(id, exchanges);
        return true;
    }

    /**
     * Load a conversation's exchanges (async)
     * @param {string} id - Conversation ID
     * @returns {Promise<Array>} Array of exchanges
     */
    async load(id) {
        this._setActiveId(id);
        return await this._getConversationData(id);
    }

    /**
     * Delete a conversation
     * @param {string} id - Conversation ID
     */
    delete(id) {
        const index = this.conversations.findIndex(c => c.id === id);
        if (index === -1) return false;

        this.conversations.splice(index, 1);
        this._saveList();
        this._deleteConversationData(id);

        // If we deleted the active conversation, clear active ID
        if (this.getActiveId() === id) {
            storage.setActiveChatId(null).catch(() => {});
        }

        return true;
    }

    // ============================================
    // Getters
    // ============================================

    /**
     * Get all conversations sorted by most recent
     */
    getAll() {
        return [...this.conversations].sort((a, b) => b.updatedAt - a.updatedAt);
    }

    /**
     * Get a single conversation's metadata
     */
    get(id) {
        return this.conversations.find(c => c.id === id);
    }

    /**
     * Get session ID for a conversation
     */
    getSessionId(id) {
        const meta = this.conversations.find(c => c.id === id);
        return meta?.sessionId || null;
    }

    /**
     * Update session ID for a conversation
     */
    updateSessionId(id, sessionId) {
        const meta = this.conversations.find(c => c.id === id);
        if (!meta) return false;
        meta.sessionId = sessionId;
        this._saveList();
        return true;
    }

    /**
     * Get the currently active conversation ID
     */
    async getActiveId() {
        return await storage.getActiveChatId();
    }

    /**
     * Check if a conversation exists
     */
    has(id) {
        return this.conversations.some(c => c.id === id);
    }

    /**
     * Get the most recent conversation
     */
    getMostRecent() {
        if (this.conversations.length === 0) return null;
        return this.conversations.reduce((latest, c) =>
            c.updatedAt > latest.updatedAt ? c : latest
        );
    }

    // ============================================
    // Helpers
    // ============================================

    async _setActiveId(id) {
        await storage.setActiveChatId(id);
    }

    _generateTitle(content) {
        // Take first 30 chars, remove newlines, add ellipsis if truncated
        const clean = content.replace(/\n/g, ' ').trim();
        if (clean.length <= 30) return clean;
        return clean.substring(0, 30).trim() + '...';
    }

    _saveConversationData(id, exchanges) {
        storage.saveConversation(id, exchanges).catch(err => {
            console.error('[ChatHistory] Failed to save conversation data:', err);
        });
    }

    async _getConversationData(id) {
        try {
            return await storage.loadConversation(id);
        } catch (error) {
            console.error('[ChatHistory] Failed to load conversation data:', error);
            return [];
        }
    }

    _deleteConversationData(id) {
        storage.deleteConversation(id).catch(err => {
            console.error('[ChatHistory] Failed to delete conversation data:', err);
        });
    }

    /**
     * Ensure history is loaded before accessing conversations
     */
    async ready() {
        await this._loadPromise;
    }
}

// Singleton instance
export const chatHistory = new ChatHistory();
