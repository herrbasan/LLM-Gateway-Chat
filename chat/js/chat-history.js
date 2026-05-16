// ============================================
// Chat History Management - Multiple Conversations
// ============================================

import { storage } from './storage.js';
import { backendClient } from './api-client.js';

const CONFIG = window.CHAT_CONFIG || {};
const USE_BACKEND = CONFIG.enableBackend === true && !!CONFIG.backendUrl;

export class ChatHistory {
    constructor() {
        this.conversations = [];
        this._loadPromise = this._loadList();
    }

    async refreshList() {
        this._loadPromise = this._loadList();
        await this._loadPromise;
    }

    async _loadList() {
        if (USE_BACKEND && backendClient.user) {
            try {
                const sessions = await backendClient.listSessions();
                this.conversations = sessions
                    .filter(s => s.mode !== 'arena')
                    .filter(s => (s.messageCount || 0) > 0)
                    .map(s => this._backendToLocal(s));
                return;
            } catch (err) {
                console.warn('[ChatHistory] Backend load failed:', err.message);
                this.conversations = [];
            }
        } else {
            this.conversations = [];
        }
    }

    async _saveList() {
        if (USE_BACKEND && backendClient.user) {
            for (const conv of this.conversations) {
                if (conv._dirty) {
                    backendClient.updateSession(conv.sessionId || conv.id, { 
                        pinned: !!conv.pinned,
                        title: conv.title,
                        model: conv.model,
                        systemPrompt: conv.systemPrompt
                    }).catch(() => {});
                    conv._dirty = false;
                }
            }
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
            systemPrompt: session.systemPrompt || '',
            mode: session.mode || 'direct',
            pinned: session.pinned || false
        };
    }

    // ============================================
    // Conversation CRUD
    // ============================================

    async create() {
        const id = 'chat_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
        const sessionId = `sess-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
        const conversation = {
            id,
            sessionId,
            title: 'New Chat',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            messageCount: 0,
            model: '',
            systemPrompt: ''
        };

        this.conversations.unshift(conversation);
        this._setActiveId(id);

        if (USE_BACKEND && backendClient.user) {
            try {
                const serverSession = await backendClient.createSession({ title: 'New Chat' });
                console.log('[ChatHistory] Backend session created:', serverSession.id, '(local was:', id, ')');
                conversation.id = serverSession.id;
                conversation.sessionId = serverSession.id;
                conversation.createdAt = (c => isNaN(c) ? Date.now() : c)(new Date(serverSession.createdAt).getTime());
                conversation.updatedAt = (c => isNaN(c) ? Date.now() : c)(new Date(serverSession.updatedAt).getTime());
                this.activeId = serverSession.id;
                await this._setActiveId(serverSession.id);
                console.log('[ChatHistory] ActiveId saved as server ID:', serverSession.id);
                this._saveList();
                return serverSession.id;
            } catch (err) {
                console.warn('[ChatHistory] Backend create failed:', err.message);
            }
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
        return true;
    }

    async load(id) {
        this._setActiveId(id);

        if (USE_BACKEND && backendClient.user) {
            try {
                const data = await backendClient.getSession(id);
                if (data && data.messages) {
                    return this._messagesToExchanges(data.messages);
                }
            } catch (err) {
                console.warn('[ChatHistory] Backend load failed:', err.message);
            }
        }

        return [];
    }

    delete(id) {
        const index = this.conversations.findIndex(c => c.id === id);
        if (index === -1) return false;

        this.conversations.splice(index, 1);

        if (USE_BACKEND && backendClient.user) {
            backendClient.deleteSession(id).catch(err => {
                console.warn('[ChatHistory] Backend delete failed:', err.message);
            });
        }

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
        // Messages come in order from the conversation doc. Walk sequentially.

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

    async ready() {
        await this._loadPromise;
    }
}

export const chatHistory = new ChatHistory();
