// ============================================
// Arena Storage - Abstraction layer with multiple backends
// ============================================
//
// Detects server type and uses appropriate backend:
// - Node backend: API-based storage (/api/storage)
// - Browser/default: IndexedDB
//
// IndexedDB DB: 'arena-storage'
//   - 'data' store: key-value for arena sessions and history
// ============================================

const DB_NAME = 'arena-storage';
const DB_VERSION = 1;
const DATA_STORE = 'data';

let _isNodeServer = null;

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
  console.log('Arena storage backend:', _isNodeServer ? 'Node (API)' : 'Browser (IndexedDB)');
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
        if (!res.ok) return null;
        const data = await res.json();
        // Server returns the value directly (or null if key doesn't exist)
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
        // Filter keys that start with arena: prefix
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

class ArenaStorageManager {
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

    // ---- Arena session data ----

    async saveSession(id, sessionData) {
        const backend = await this._ensureBackend();
        await backend.set(DATA_STORE, PREFIX_SESSION + id, sessionData);
    }

    async loadSession(id) {
        const backend = await this._ensureBackend();
        return (await backend.get(DATA_STORE, PREFIX_SESSION + id)) ?? null;
    }

    async deleteSession(id) {
        const backend = await this._ensureBackend();
        await backend.remove(DATA_STORE, PREFIX_SESSION + id);
    }

    // ---- Arena history list ----

    async saveHistory(arenas) {
        const backend = await this._ensureBackend();
        await backend.set(DATA_STORE, PREFIX_HISTORY, arenas);
    }

    async loadHistory() {
        const backend = await this._ensureBackend();
        return (await backend.get(DATA_STORE, PREFIX_HISTORY)) ?? [];
    }

    async removeFromHistory(id) {
        const history = await this.loadHistory();
        const filtered = history.filter(h => h.id !== id);
        if (filtered.length !== history.length) {
            await this.saveHistory(filtered);
        }
    }

    // ---- Utility ----

    async getAllSessionIds() {
        const backend = await this._ensureBackend();
        const keys = await backend.getAllKeys(DATA_STORE);
        return keys
            .filter(k => k.startsWith(PREFIX_SESSION))
            .map(k => k.replace(PREFIX_SESSION, ''));
    }

    async clearAll() {
        const backend = await this._ensureBackend();
        await backend.clear(DATA_STORE);
    }
}

// Singleton
export const arenaStorage = new ArenaStorageManager();