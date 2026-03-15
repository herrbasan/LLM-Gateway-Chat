// ============================================
// Chat History Management - Multiple Conversations
// ============================================

const HISTORY_KEY = 'chat-history-list';
const ACTIVE_CHAT_KEY = 'chat-active-id';

/**
 * Manages a list of saved conversations.
 * Each conversation has metadata (id, title, timestamp) + the full conversation data.
 */
export class ChatHistory {
    constructor() {
        this.conversations = this._loadList();
    }

    // ============================================
    // List Management
    // ============================================

    _loadList() {
        try {
            const data = localStorage.getItem(HISTORY_KEY);
            return data ? JSON.parse(data) : [];
        } catch (error) {
            console.error('[ChatHistory] Failed to load list:', error);
            return [];
        }
    }

    _saveList() {
        try {
            localStorage.setItem(HISTORY_KEY, JSON.stringify(this.conversations));
        } catch (error) {
            console.error('[ChatHistory] Failed to save list:', error);
            // If quota exceeded, remove oldest conversations
            if (error.name === 'QuotaExceededError' && this.conversations.length > 3) {
                this.conversations = this.conversations.slice(-3);
                localStorage.setItem(HISTORY_KEY, JSON.stringify(this.conversations));
            }
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
        const conversation = {
            id,
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
     * Load a conversation's exchanges
     * @param {string} id - Conversation ID
     * @returns {Array} Array of exchanges
     */
    load(id) {
        this._setActiveId(id);
        return this._getConversationData(id);
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
            localStorage.removeItem(ACTIVE_CHAT_KEY);
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
     * Get the currently active conversation ID
     */
    getActiveId() {
        try {
            return localStorage.getItem(ACTIVE_CHAT_KEY);
        } catch {
            return null;
        }
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

    _setActiveId(id) {
        try {
            localStorage.setItem(ACTIVE_CHAT_KEY, id);
        } catch (error) {
            console.error('[ChatHistory] Failed to set active ID:', error);
        }
    }

    _generateTitle(content) {
        // Take first 30 chars, remove newlines, add ellipsis if truncated
        const clean = content.replace(/\n/g, ' ').trim();
        if (clean.length <= 30) return clean;
        return clean.substring(0, 30).trim() + '...';
    }

    _getStorageKey(id) {
        return `chat-data-${id}`;
    }

    _saveConversationData(id, exchanges) {
        try {
            const key = this._getStorageKey(id);
            localStorage.setItem(key, JSON.stringify(exchanges));
        } catch (error) {
            console.error('[ChatHistory] Failed to save conversation data:', error);
        }
    }

    _getConversationData(id) {
        try {
            const key = this._getStorageKey(id);
            const data = localStorage.getItem(key);
            return data ? JSON.parse(data) : [];
        } catch (error) {
            console.error('[ChatHistory] Failed to load conversation data:', error);
            return [];
        }
    }

    _deleteConversationData(id) {
        try {
            const key = this._getStorageKey(id);
            localStorage.removeItem(key);
        } catch (error) {
            console.error('[ChatHistory] Failed to delete conversation data:', error);
        }
    }

    // ============================================
    // Migration
    // ============================================

    /**
     * Migrate from old single-conversation format
     * Call this once on startup to preserve existing chat
     */
    migrateLegacyConversation() {
        try {
            const legacyData = localStorage.getItem('chat-conversation');
            if (!legacyData) return null;

            const exchanges = JSON.parse(legacyData);
            if (!Array.isArray(exchanges) || exchanges.length === 0) return null;

            // Create new conversation with legacy data
            const id = this.create();
            this.save(id, exchanges);
            
            // Clear legacy data
            localStorage.removeItem('chat-conversation');
            
            console.log('[ChatHistory] Migrated legacy conversation:', id);
            return id;
        } catch (error) {
            console.error('[ChatHistory] Failed to migrate legacy:', error);
            return null;
        }
    }
}

// Singleton instance
export const chatHistory = new ChatHistory();
