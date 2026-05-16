// ============================================
// Backend API Client — Chat Backend (port 3500)
// ============================================

export class BackendClient {
    constructor(baseUrl = '') {
        this.baseUrl = baseUrl;
        this._offline = false;
        this._offlineListeners = new Set();
        this._authErrorListeners = new Set();
        this.user = null;
    }

    get isOffline() {
        return this._offline;
    }

    onOfflineChange(fn) {
        this._offlineListeners.add(fn);
        return () => this._offlineListeners.delete(fn);
    }

    onAuthError(fn) {
        this._authErrorListeners.add(fn);
        return () => this._authErrorListeners.delete(fn);
    }

    _setOffline(value) {
        if (this._offline === value) return;
        this._offline = value;
        for (const fn of this._offlineListeners) {
            try { fn(value); } catch {}
        }
    }

    _triggerAuthError() {
        this.user = null;
        for (const fn of this._authErrorListeners) {
            try { fn(); } catch {}
        }
    }

    // ============================================
    // HTTP Core
    // ============================================

    async _request(method, path, body = null) {
        const headers = { 'Content-Type': 'application/json' };

        const opts = { 
            method, 
            headers,
            credentials: 'include' // Send cookies
        };
        
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

        if (res.status === 401 || res.status === 403) {
            this._triggerAuthError();
        }

        let errorMsg;
        try {
            const errBody = await res.json();
            errorMsg = errBody.error || `HTTP ${res.status}`;
        } catch {
            errorMsg = `HTTP ${res.status}`;
        }

        const e = new Error(errorMsg);
        e.status = res.status;
        if (res.status === 401 || res.status === 403) e.isAuthError = true;
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

    async verifySession() {
        try {
            const data = await this._request('GET', '/api/auth/session');
            this.user = data;
            return data;
        } catch (e) {
            if (e.isAuthError) return null;
            throw e;
        }
    }
    
    async login(username, password) {
        const data = await this._request('POST', '/api/auth/login', { username, password });
        this.user = data;
        return data;
    }

    async logout() {
        await this._request('POST', '/api/auth/logout');
        this.user = null;
    }

    // ============================================
    // Admin (User Management)
    // ============================================

    async adminGetUsers() {
        const data = await this._request('GET', '/api/admin/users');
        return data.data || [];
    }

    async adminCreateUser(userObj) {
        return this._request('POST', '/api/admin/users', userObj);
    }

    async adminUpdateUser(id, userObj) {
        return this._request('PUT', `/api/admin/users/${id}`, userObj);
    }

    async adminDeleteUser(id) {
        return this._request('DELETE', `/api/admin/users/${id}`);
    }

    async adminResetPassword(id, password) {
        return this._request('POST', `/api/admin/users/${id}/reset-password`, { password });
    }

    // ============================================
    // User Settings Operations
    // ============================================

    async getUserSettings() {
        return this._request('GET', '/api/user/settings');
    }

    async updateUserSettings(settings) {
        return this._request('PUT', '/api/user/settings', { settings });
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

    async updateSession(id, fields) {
        return this._request('PATCH', `/api/chats/${encodeURIComponent(id)}`, fields);
    }

    // ============================================
    // Messages
    // ============================================

    async sendMessage(sessionId, msg) {
        const body = { ...msg };
        if (!body.role) body.role = 'user';
        if (!body.content) body.content = '';
        body.model = body.model || null;
        body.attachments = body.attachments || [];
        return this._request('POST', `/api/chats/${encodeURIComponent(sessionId)}/messages`, body);
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
    CONFIG.backendUrl || 'http://localhost:3500'
);
