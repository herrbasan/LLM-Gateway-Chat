// ============================================
// Chat History Management - Multiple Conversations
// ============================================

import { storage, PREFIX_CONV } from './storage.js';
import { backendClient } from './api-client.js';

const CONFIG = window.CHAT_CONFIG || {};
const USE_BACKEND = CONFIG.enableBackend === true && !!CONFIG.backendUrl;

export class ChatHistory {
    constructor() {
        this.conversations = [];
        this._loadPromise = this._loadList();
    }

    async _loadList() {
        if (USE_BACKEND && backendClient.apiKey) {
            try {
                const sessions = await backendClient.listSessions();
                this.conversations = sessions
                    .filter(s => s.mode !== 'arena')
                    .filter(s => (s.messageCount || 0) > 0)
                    .map(s => this._backendToLocal(s));
                return;
            } catch (err) {
                console.warn('[ChatHistory] Backend load failed, falling back to local:', err.message);
            }
        }
        try {
            this.conversations = await storage.loadHistory();
        } catch (error) {
            console.error('[ChatHistory] Failed to load list:', error);
            this.conversations = [];
        }
    }

    async _saveList() {
        if (USE_BACKEND && backendClient.apiKey) {
            return;
        }
        try {
            await storage.saveHistory(this.conversations);
        } catch (error) {
            console.error('[ChatHistory] Failed to save list:', error);
        }
    }

    _backendToLocal(session) {
            const createdAt = new Date(session.createdAt).getTime();
            const updatedAt = new Date(session.updatedAt).getTime();
            return {
                id: session.id,
                sessionId: session.id,
                title: session.title || 'New Chat',
                createdAt: !isNaN(createdAt) ? createdAt : Date.now(),
                updatedAt: !isNaN(updatedAt) ? updatedAt : Date.now(),
            messageCount: session.messageCount || 0,
            model: session.model || '',
            mode: session.mode || 'direct',
            pinned: session.pinned || false
        };
    }

    // ============================================
    // Conversation CRUD
    // ============================================

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

        this.conversations.unshift(conversation);
        this._setActiveId(id);

        if (USE_BACKEND && backendClient.apiKey) {
            backendClient.createSession({ title: 'New Chat' })
                .then(serverSession => {
                    conversation.id = serverSession.id;
                    conversation.sessionId = serverSession.id;
                    conversation.createdAt = (c => isNaN(c) ? Date.now() : c)(new Date(serverSession.createdAt).getTime());
                    conversation.updatedAt = (c => isNaN(c) ? Date.now() : c)(new Date(serverSession.updatedAt).getTime());
                })
                .catch(err => {
                    console.warn('[ChatHistory] Backend create failed:', err.message);
                });
        } else {
            this._saveList();
            this._saveConversationData(id, []);
        }

        return id;
    }

    save(id, exchanges, model = '') {
        const meta = this.conversations.find(c => c.id === id);
        if (!meta) return false;

        meta.updatedAt = Date.now();
        meta.messageCount = exchanges.length;
        if (model) meta.model = model;

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

    async load(id) {
        this._setActiveId(id);

        if (USE_BACKEND && backendClient.apiKey) {
            try {
                const data = await backendClient.getSession(id);
                if (data && data.messages) {
                    return this._messagesToExchanges(data.messages);
                }
            } catch (err) {
                console.warn('[ChatHistory] Backend load failed, falling back to local:', err.message);
            }
        }

        return await this._getConversationData(id);
    }

    delete(id) {
        const index = this.conversations.findIndex(c => c.id === id);
        if (index === -1) return false;

        this.conversations.splice(index, 1);
        this._deleteConversationData(id);

        if (USE_BACKEND && backendClient.apiKey) {
            backendClient.deleteSession(id).catch(err => {
                console.warn('[ChatHistory] Backend delete failed:', err.message);
            });
        } else {
            this._saveList();
        }

        storage.setActiveChatId(null).catch(() => {});

        return true;
    }

    // ============================================
    // Getters
    // ============================================

    getAll() {
        return [...this.conversations].sort((a, b) => {
            if (a.pinned && !b.pinned) return -1;
            if (!a.pinned && b.pinned) return 1;
            return b.updatedAt - a.updatedAt;
        });
    }

    get(id) {
        return this.conversations.find(c => c.id === id);
    }

    getSessionId(id) {
        const meta = this.conversations.find(c => c.id === id);
        return meta?.sessionId || null;
    }

    updateSessionId(id, sessionId) {
        const meta = this.conversations.find(c => c.id === id);
        if (!meta) return false;
        meta.sessionId = sessionId;
        this._saveList();
        return true;
    }

    async getActiveId() {
        return await storage.getActiveChatId();
    }

    has(id) {
        return this.conversations.some(c => c.id === id);
    }

    getMostRecent() {
        if (this.conversations.length === 0) return null;
        return this.conversations.reduce((latest, c) =>
            c.updatedAt > latest.updatedAt ? c : latest
        );
    }

    // ============================================
    // Backend Message → Exchange Transform
    // ============================================

    _messagesToExchanges(messages) {
        const sorted = [...messages].sort((a, b) => a.turnIndex - b.turnIndex);

        const groups = new Map();
        for (const msg of sorted) {
            const key = msg.turnIndex;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(msg);
        }

        const exchanges = [];
        for (const [turnIndex, msgs] of groups) {
            const userMsg = msgs.find(m => m.role === 'user');
            const assistantMsg = msgs.find(m => m.role === 'assistant');
            const toolMsg = msgs.find(m => m.role === 'tool');

            // Tool exchange — has tool message but no user content
            if (toolMsg && !userMsg?.content) {
                const ts = new Date(toolMsg.createdAt).getTime();
                const exchange = {
                    id: toolMsg.id?.replace(/-tool$/, '') || ('ex_' + turnIndex),
                    timestamp: !isNaN(ts) ? ts : Date.now(),
                    type: 'tool',
                    tool: {
                        name: toolMsg.toolName || 'unknown',
                        args: toolMsg.toolArgs || {},
                        status: toolMsg.toolStatus || 'success',
                        content: toolMsg.content || '',
                        images: toolMsg.toolImages || []
                    },
                    user: {
                        role: 'user',
                        content: '',
                        attachments: []
                    },
                    assistant: {
                        role: 'assistant',
                        content: '',
                        versions: [],
                        currentVersion: 0,
                        isStreaming: false,
                        isComplete: false
                    }
                };
                // If assistant responded after tool, include it
                if (assistantMsg) {
                    exchange.assistant.content = assistantMsg.content || '';
                    exchange.assistant.isComplete = true;
                    exchange.assistant.versions = [{
                        content: assistantMsg.content || '',
                        timestamp: (t => !isNaN(t) ? t : Date.now())(new Date(assistantMsg.createdAt).getTime())
                    }];
                    if (assistantMsg.model) exchange.assistant.model = assistantMsg.model;
                }
                exchanges.push(exchange);
                continue;
            }

            const ts = new Date((userMsg || assistantMsg)?.createdAt).getTime();
            const exchange = {
                id: (userMsg || assistantMsg)?.id?.replace(/-user$/, '').replace(/-assistant$/, '') || ('ex_' + turnIndex),
                timestamp: !isNaN(ts) ? ts : Date.now(),
                user: {
                    role: 'user',
                    content: userMsg?.content || '',
                    attachments: userMsg?.attachments || []
                },
                assistant: {
                    role: 'assistant',
                    content: '',
                    versions: [],
                    currentVersion: 0,
                    isStreaming: false,
                    isComplete: false
                }
            };

            if (assistantMsg) {
                exchange.assistant.content = assistantMsg.content || '';
                exchange.assistant.isComplete = true;
                exchange.assistant.versions = [{
                    content: assistantMsg.content || '',
                    timestamp: (t => !isNaN(t) ? t : Date.now())(new Date(assistantMsg.createdAt).getTime())
                }];
                if (assistantMsg.model) exchange.assistant.model = assistantMsg.model;
                if (assistantMsg.usage) exchange.assistant.usage = assistantMsg.usage;
            }

            exchanges.push(exchange);
        }

        return exchanges;
    }

    // ============================================
    // Helpers
    // ============================================

    async _setActiveId(id) {
        await storage.setActiveChatId(id);
    }

    _generateTitle(content) {
        const clean = content.replace(/\n/g, ' ').trim();
        if (clean.length <= 30) return clean;
        return clean.substring(0, 30).trim() + '...';
    }

    _generateId() {
        return 'chat_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
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

    async ready() {
        await this._loadPromise;
    }
}

export const chatHistory = new ChatHistory();
