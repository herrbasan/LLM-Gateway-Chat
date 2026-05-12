// ============================================
// Backend API Client — Chat Backend (port 3500)
// ============================================

const STORAGE_KEY_APIKEY = 'chat-backend-apikey';

export class BackendClient {
    constructor(baseUrl = '', apiKey = '') {
        this.baseUrl = baseUrl;
        this._apiKey = apiKey;
        this._offline = false;
        this._offlineListeners = new Set();
    }

    get apiKey() {
        return this._apiKey;
    }

    set apiKey(key) {
        this._apiKey = key;
        if (key) {
            try { localStorage.setItem(STORAGE_KEY_APIKEY, key); } catch {}
        } else {
            try { localStorage.removeItem(STORAGE_KEY_APIKEY); } catch {}
        }
    }

    get isOffline() {
        return this._offline;
    }

    loadSavedApiKey() {
        try {
            const saved = localStorage.getItem(STORAGE_KEY_APIKEY);
            if (saved) this._apiKey = saved;
        } catch {}
        return this._apiKey;
    }

    onOfflineChange(fn) {
        this._offlineListeners.add(fn);
        return () => this._offlineListeners.delete(fn);
    }

    _setOffline(value) {
        if (this._offline === value) return;
        this._offline = value;
        for (const fn of this._offlineListeners) {
            try { fn(value); } catch {}
        }
    }

    // ============================================
    // HTTP Core
    // ============================================

    async _request(method, path, body = null) {
        const headers = { 'Content-Type': 'application/json' };
        if (this._apiKey) headers['X-API-Key'] = this._apiKey;

        const opts = { method, headers };
        if (body !== null) opts.body = JSON.stringify(body);

        let res;
        try {
            res = await fetch(this.baseUrl + path, opts);
        } catch (err) {
            this._setOffline(true);
            const e = new Error(err.message || 'Network error');
            e.isOffline = true;
            throw e;
        }

        if (res.ok) {
            this._setOffline(false);
            if (res.status === 204) return null;
            return res.json();
        }

        this._setOffline(false);

        let errorMsg;
        try {
            const errBody = await res.json();
            errorMsg = errBody.error || `HTTP ${res.status}`;
        } catch {
            errorMsg = `HTTP ${res.status}`;
        }

        const e = new Error(errorMsg);
        e.status = res.status;
        if (res.status === 401) e.isAuthError = true;
        throw e;
    }

    // ============================================
    // Health
    // ============================================

    async health() {
        return this._request('GET', '/health');
    }

    async probe() {
        try {
            await this.health();
            return true;
        } catch {
            return false;
        }
    }

    // ============================================
    // Auth
    // ============================================

    async createApiKey() {
        const data = await this._request('POST', '/api/auth/key');
        if (data.apiKey) {
            this.apiKey = data.apiKey;
        }
        return data;
    }

    // ============================================
    // Sessions
    // ============================================

    async listSessions() {
        const data = await this._request('GET', '/api/chats');
        return data.data || [];
    }

    async createSession(params = {}) {
        return this._request('POST', '/api/chats', {
            title: params.title || 'New Chat',
            mode: params.mode || 'direct',
            model: params.model || null
        });
    }

    async getSession(id) {
        return this._request('GET', `/api/chats/${encodeURIComponent(id)}`);
    }

    async deleteSession(id) {
        return this._request('DELETE', `/api/chats/${encodeURIComponent(id)}`);
    }

    // ============================================
    // Messages
    // ============================================

    async sendMessage(sessionId, msg) {
        return this._request('POST', `/api/chats/${encodeURIComponent(sessionId)}/messages`, {
            role: msg.role || 'user',
            content: msg.content || '',
            model: msg.model || null,
            attachments: msg.attachments || []
        });
    }

    // ============================================
    // Search
    // ============================================

    async search(query, options = {}) {
        return this._request('POST', '/api/search', {
            query,
            mode: options.mode || 'all',
            search_type: options.search_type || 'semantic',
            limit: options.limit || 10,
            date_from: options.date_from || null,
            date_to: options.date_to || null
        });
    }

    // ============================================
    // Arena
    // ============================================

    async listArena() {
        const data = await this._request('GET', '/api/arena');
        return data.data || [];
    }

    // ============================================
    // References
    // ============================================

    async findReferences(sessionId, direction = 'both') {
        return this._request('POST', '/api/references', {
            session_id: sessionId,
            direction
        });
    }

    // ============================================
    // Import
    // ============================================

    async importData(data) {
        return this._request('POST', '/api/import', data);
    }
}

const CONFIG = window.CHAT_CONFIG || {};
export const backendClient = new BackendClient(
    CONFIG.backendUrl || 'http://localhost:3500',
    CONFIG.backendApiKey || ''
);
backendClient.loadSavedApiKey();
