// ============================================
// Arena Storage - Abstraction layer with multiple backends
// ============================================
//
// Detects server type and uses appropriate backend:
// - Chat Backend (nDB): BackendClient API (port 3500)
// - Node backend: API-based storage (/api/storage) — legacy
// - Browser/default: IndexedDB
//
// IndexedDB DB: 'arena-storage'
//   - 'data' store: key-value for arena sessions and history
// ============================================

import { BackendClient } from '../../chat/js/api-client.js';

const DB_NAME = 'arena-storage';
const DB_VERSION = 1;
const DATA_STORE = 'data';

let _isNodeServer = null;
let _backendClient = null;

const IS_NODE_SERVER = () => {
  if (_isNodeServer === null) {
    _isNodeServer = false;
  }
  return _isNodeServer;
};

const initServerType = async () => {
  if (_isNodeServer !== null) return _isNodeServer;
  try {
    const res = await fetch('/api/server-type');
    if (res.ok) {
      const data = await res.json();
      _isNodeServer = data.type === 'node-minimal';
    }
  } catch {
    _isNodeServer = false;
  }
  return _isNodeServer;
};

// ============================================
// Backend API Adapter (nDB via port 3500)
// ============================================

function getBackendClient() {
    if (_backendClient) return _backendClient;
    const config = window.CHAT_CONFIG || {};
    if (config.enableBackend && config.backendUrl && config.backendApiKey) {
        _backendClient = new BackendClient(config.backendUrl, config.backendApiKey);
    }
    return _backendClient;
}

class BackendApiAdapter {
    async _client() {
        const bc = getBackendClient();
        if (!bc) throw new Error('Backend not configured');
        return bc;
    }

    // Load history: fetch all arena sessions from backend
    async loadHistory() {
        const bc = await this._client();
        const sessions = await bc.listSessions();
        const arenas = sessions.filter(s => s.mode === 'arena');
        return arenas.map(s => ({
            id: s.id,
            title: s.title || s.arenaConfig?.topic || 'Arena Session',
            participants: [s.arenaConfig?.modelA || '?', s.arenaConfig?.modelB || '?'],
            messageCount: s.messageCount || 0,
            updatedAt: s.updatedAt || s.createdAt,
            createdAt: s.createdAt,
            topic: s.title || s.arenaConfig?.topic || ''
        }));
    }

    // Save history — no-op, backend is source of truth
    async saveHistory(arenas) {
        // Backend manages sessions directly; no separate history list needed
    }

    // Load a single arena session with messages
    async loadSession(id) {
        const bc = await this._client();
        const data = await bc.getSession(id);
        if (!data || !data.session) return null;

        const s = data.session;
        const msgs = data.messages || [];

        return {
            version: 1,
            id: s.id,
            exportedAt: s.updatedAt || s.createdAt,
            topic: s.title || s.arenaConfig?.topic || '',
            participants: [s.arenaConfig?.modelA || '', s.arenaConfig?.modelB || ''],
            messages: msgs.map(m => ({
                speaker: m.speaker || (m.role === 'system' ? 'moderator' : ''),
                role: m.role || 'assistant',
                content: m.content || '',
                model: m.model || null
            })),
            summary: s.summary || null,
            settings: s.arenaConfig || {}
        };
    }

    // Save session — use backend API
    async saveSession(id, sessionData) {
        const bc = await this._client();
        // Check if session exists
        try {
            const existing = await bc.getSession(id);
            if (existing?.session) {
                // Session exists — messages are added via sendMessage during arena run
                return;
            }
        } catch {}
        // Create new session
        await bc.createSession({
            title: sessionData.topic || 'Arena Session',
            mode: 'arena',
            model: sessionData.participants?.[0] || null
        });
    }

    // Delete session
    async deleteSession(id) {
        const bc = await this._client();
        try { await bc.deleteSession(id); } catch {}
    }

    // Remove from history — same as delete
    async removeFromHistory(id) {
        // Backend has no separate history; deleting the session removes it from listing
    }

    // Get all session IDs
    async getAllSessionIds() {
        const history = await this.loadHistory();
        return history.map(h => h.id);
    }

    // Clear all arenas
    async clearAll() {
        const ids = await this.getAllSessionIds();
        const bc = await this._client();
        for (const id of ids) {
            try { await bc.deleteSession(id); } catch {}
        }
    }
}

// ============================================
// IndexedDB Adapter
// ============================================

class IndexedDBAdapter {
    constructor() {
        this.db = null;
        this.initPromise = this._init();
    }

    async _init() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                this.db = request.result;
                resolve();
            };

            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains(DATA_STORE)) {
                    db.createObjectStore(DATA_STORE);
                }
            };
        });
    }

    async _ensureReady() {
        await this.initPromise;
    }

    async get(store, key) {
        await this._ensureReady();
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(store, 'readonly');
            const objectStore = tx.objectStore(store);
            const request = objectStore.get(key);

            request.onsuccess = () => resolve(request.result ?? null);
            request.onerror = () => reject(request.error);
        });
    }

    async set(store, key, value) {
        await this._ensureReady();
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(store, 'readwrite');
            const objectStore = tx.objectStore(store);
            const request = objectStore.put(value, key);

            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    async remove(store, key) {
        await this._ensureReady();
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(store, 'readwrite');
            const objectStore = tx.objectStore(store);
            const request = objectStore.delete(key);

            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    async getAllKeys(store) {
        await this._ensureReady();
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(store, 'readonly');
            const objectStore = tx.objectStore(store);
            const request = objectStore.getAllKeys();

            request.onsuccess = () => resolve(request.result ?? []);
            request.onerror = () => reject(request.error);
        });
    }

    async clear(store) {
        await this._ensureReady();
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(store, 'readwrite');
            const objectStore = tx.objectStore(store);
            const request = objectStore.clear();

            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }
}

// ============================================
// API Adapter (Node backend) — legacy
// ============================================

class ApiAdapter {
    async get(store, key) {
        const res = await fetch(`/api/storage/${encodeURIComponent(key)}`);
        if (!res.ok) return null;
        const data = await res.json();
        return data;
    }

    async set(store, key, value) {
        await fetch(`/api/storage/${encodeURIComponent(key)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ value }),
        });
    }

    async remove(store, key) {
        await fetch(`/api/storage/${encodeURIComponent(key)}`, { method: 'DELETE' });
    }

    async getAllKeys(store) {
        const res = await fetch('/api/storage');
        if (!res.ok) return [];
        const data = await res.json();
        const allKeys = Object.keys(data || {});
        return allKeys.filter(k => k.startsWith('arena:'));
    }

    async clear(store) {
        const keys = await this.getAllKeys(store);
        await Promise.all(keys.map(k => this.remove(store, k)));
    }
}

// ============================================
// Storage Manager - Arena-specific storage
// ============================================

const PREFIX_SESSION = 'arena:session:';
const PREFIX_HISTORY = 'arena:history:';

function isBackendAvailable() {
    const config = window.CHAT_CONFIG || {};
    return !!(config.enableBackend && config.backendUrl && config.backendApiKey);
}

class ArenaStorageManager {
    constructor() {
        this._backend = null;
        this._backendType = null; // 'backend' | 'api' | 'indexeddb'
    }

    async _detectBackend() {
        if (this._backendType) return;

        // Priority 1: Chat Backend API (nDB)
        if (isBackendAvailable()) {
            this._backend = new BackendApiAdapter();
            this._backendType = 'backend';
            console.log('Arena storage backend: Chat Backend (nDB)');
            return;
        }

        // Priority 2: Legacy Node server
        await initServerType();
        if (IS_NODE_SERVER()) {
            this._backend = new ApiAdapter();
            this._backendType = 'api';
            console.log('Arena storage backend: Node (API)');
            return;
        }

        // Priority 3: IndexedDB
        this._backend = new IndexedDBAdapter();
        this._backendType = 'indexeddb';
        console.log('Arena storage backend: Browser (IndexedDB)');
    }

    async _ensureBackend() {
        await this._detectBackend();
        return this._backend;
    }

    // ---- Arena history list ----

    async loadHistory() {
        const backend = await this._ensureBackend();
        if (this._backendType === 'backend') {
            return await backend.loadHistory();
        }
        return (await backend.get(DATA_STORE, PREFIX_HISTORY)) ?? [];
    }

    async saveHistory(arenas) {
        const backend = await this._ensureBackend();
        if (this._backendType === 'backend') {
            await backend.saveHistory(arenas);
            return;
        }
        await backend.set(DATA_STORE, PREFIX_HISTORY, arenas);
    }

    async removeFromHistory(id) {
        if (this._backendType === 'backend') {
            const b = await this._ensureBackend();
            await b.removeFromHistory(id);
            return;
        }
        const history = await this.loadHistory();
        const filtered = history.filter(h => h.id !== id);
        if (filtered.length !== history.length) {
            await this.saveHistory(filtered);
        }
    }

    // ---- Arena session data ----

    async saveSession(id, sessionData) {
        const backend = await this._ensureBackend();
        if (this._backendType === 'backend') {
            await backend.saveSession(id, sessionData);
            return;
        }
        await backend.set(DATA_STORE, PREFIX_SESSION + id, sessionData);
    }

    async loadSession(id) {
        const backend = await this._ensureBackend();
        if (this._backendType === 'backend') {
            return await backend.loadSession(id);
        }
        return (await backend.get(DATA_STORE, PREFIX_SESSION + id)) ?? null;
    }

    async deleteSession(id) {
        const backend = await this._ensureBackend();
        if (this._backendType === 'backend') {
            await backend.deleteSession(id);
            return;
        }
        await backend.remove(DATA_STORE, PREFIX_SESSION + id);
    }

    // ---- Utility ----

    async getAllSessionIds() {
        const backend = await this._ensureBackend();
        if (this._backendType === 'backend') {
            return await backend.getAllSessionIds();
        }
        const keys = await backend.getAllKeys(DATA_STORE);
        return keys
            .filter(k => k.startsWith(PREFIX_SESSION))
            .map(k => k.replace(PREFIX_SESSION, ''));
    }

    async clearAll() {
        const backend = await this._ensureBackend();
        if (this._backendType === 'backend') {
            await backend.clearAll();
            return;
        }
        await backend.clear(DATA_STORE);
    }
}

// Singleton
export const arenaStorage = new ArenaStorageManager();
