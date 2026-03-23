// ============================================
// Storage - IndexedDB abstraction layer
// ============================================
//
// Provides a unified IndexedDB backend for all chat data.
//
// IndexedDB DB: 'chat-storage'
//   - 'data' store: key-value for conversations, history, prefs, active chat ID
// ============================================

const DB_NAME = 'chat-storage';
const DB_VERSION = 1;
const DATA_STORE = 'data';

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
// Storage Manager - Unified IndexedDB facade
// ============================================

// Key prefixes for namespacing within the single data store
export const PREFIX_CONV = 'conv:';
const PREFIX_HISTORY = 'history:';
const PREFIX_ACTIVE = 'activeChatId';
const PREFIX_PREF = 'pref:';

class StorageManager {
    constructor() {
        this.idb = new IndexedDBAdapter();
    }

    // ---- Conversation data ----

    async saveConversation(id, exchanges) {
        await this.idb.set(DATA_STORE, PREFIX_CONV + id, exchanges);
    }

    async loadConversation(id) {
        return await this.idb.get(DATA_STORE, PREFIX_CONV + id) ?? [];
    }

    async deleteConversation(id) {
        await this.idb.remove(DATA_STORE, PREFIX_CONV + id);
    }

    // ---- History list ----

    async saveHistory(conversations) {
        await this.idb.set(DATA_STORE, PREFIX_HISTORY, conversations);
    }

    async loadHistory() {
        return await this.idb.get(DATA_STORE, PREFIX_HISTORY) ?? [];
    }

    // ---- Active chat ID ----

    async getActiveChatId() {
        return await this.idb.get(DATA_STORE, PREFIX_ACTIVE);
    }

    async setActiveChatId(id) {
        await this.idb.set(DATA_STORE, PREFIX_ACTIVE, id);
    }

    // ---- User preferences ----

    async getPref(key) {
        return await this.idb.get(DATA_STORE, PREFIX_PREF + key);
    }

    async setPref(key, value) {
        await this.idb.set(DATA_STORE, PREFIX_PREF + key, value);
    }

    // ---- MCP config (namespace: 'mcp:') ----

    async mcpGet(key) {
        return await this.idb.get(DATA_STORE, 'mcp:' + key);
    }

    async mcpSet(key, value) {
        await this.idb.set(DATA_STORE, 'mcp:' + key, value);
    }

    // ---- Storage estimate ----

    async getStorageEstimate() {
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
