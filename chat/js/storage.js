// ============================================
// Storage - Abstraction layer with multiple backends
// ============================================
//
// Detects server type and uses appropriate backend:
// - Node backend: API-based storage (/api/storage)
// - Browser/default: IndexedDB
//
// IndexedDB DB: 'chat-storage'
//   - 'data' store: key-value for conversations, history, prefs, active chat ID
// ============================================

const DB_NAME = 'chat-storage';
const DB_VERSION = 1;
const DATA_STORE = 'data';

let _isNodeServer = null;

const IS_NODE_SERVER = () => {
  if (_isNodeServer === null) {
    // Will be resolved on first storage access
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
  console.log('Storage backend:', _isNodeServer ? 'Node (API)' : 'Browser (IndexedDB)');
  return _isNodeServer;
};

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
// API Adapter (Node backend)
// ============================================

class ApiAdapter {
    async get(store, key) {
        const res = await fetch(`/api/storage/${encodeURIComponent(key)}`);
        return res.json();
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

    async getStorageEstimate() {
        const res = await fetch('/api/storage');
        const data = await res.json();
        const totalBytes = JSON.stringify(data).length;
        return { usage: totalBytes, quota: 0, percent: '0' };
    }
}

// ============================================
// Storage Manager - Unified storage facade
// ============================================

// Key prefixes for namespacing within the single data store
export const PREFIX_CONV = 'conv:';
const PREFIX_HISTORY = 'history:';
const PREFIX_ACTIVE = 'activeChatId';
const PREFIX_PREF = 'pref:';

class StorageManager {
    constructor() {
        this._backend = null;
        this._initPromise = null;
    }

    async _ensureBackend() {
        if (!this._backend) {
            await initServerType();
            this._backend = IS_NODE_SERVER() ? new ApiAdapter() : new IndexedDBAdapter();
        }
        return this._backend;
    }

    // ---- Conversation data ----

    async saveConversation(id, exchanges) {
        const backend = await this._ensureBackend();
        await backend.set(DATA_STORE, PREFIX_CONV + id, exchanges);
    }

    async loadConversation(id) {
        const backend = await this._ensureBackend();
        return (await backend.get(DATA_STORE, PREFIX_CONV + id)) ?? [];
    }

    async deleteConversation(id) {
        const backend = await this._ensureBackend();
        await backend.remove(DATA_STORE, PREFIX_CONV + id);
    }

    // ---- History list ----

    async saveHistory(conversations) {
        const backend = await this._ensureBackend();
        await backend.set(DATA_STORE, PREFIX_HISTORY, conversations);
    }

    async loadHistory() {
        const backend = await this._ensureBackend();
        return (await backend.get(DATA_STORE, PREFIX_HISTORY)) ?? [];
    }

    // ---- Active chat ID ----

    async getActiveChatId() {
        const backend = await this._ensureBackend();
        return await backend.get(DATA_STORE, PREFIX_ACTIVE);
    }

    async setActiveChatId(id) {
        const backend = await this._ensureBackend();
        await backend.set(DATA_STORE, PREFIX_ACTIVE, id);
    }

    // ---- User preferences ----

    async getPref(key) {
        const backend = await this._ensureBackend();
        return await backend.get(DATA_STORE, PREFIX_PREF + key);
    }

    async setPref(key, value) {
        const backend = await this._ensureBackend();
        await backend.set(DATA_STORE, PREFIX_PREF + key, value);
    }

    // ---- MCP config (namespace: 'mcp:') ----

    async mcpGet(key) {
        const backend = await this._ensureBackend();
        return await backend.get(DATA_STORE, 'mcp:' + key);
    }

    async mcpSet(key, value) {
        const backend = await this._ensureBackend();
        await backend.set(DATA_STORE, 'mcp:' + key, value);
    }

    // ---- Storage estimate ----

    async getStorageEstimate() {
        if (IS_NODE_SERVER()) {
            const backend = await this._ensureBackend();
            return backend.getStorageEstimate();
        }
        try {
            const estimate = await navigator.storage.estimate();
            return {
                usage: estimate.usage,
                quota: estimate.quota,
                percent: ((estimate.usage / estimate.quota) * 100).toFixed(1)
            };
        } catch {
            return null;
        }
    }
}

// Singleton
export const storage = new StorageManager();
