// ============================================
// File Store - Unified file/image storage abstraction
// ============================================
//
// Returns { url } for API backend (server URL)
// Returns { blobUrl } for IndexedDB backend (browser blob URL)
//
// Used by chat when rendering images/files in messages.
// ============================================

let _isNodeServer = null;

const IS_NODE_SERVER = () => {
  if (_isNodeServer === null) _isNodeServer = false;
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
// IndexedDB Backend
// ============================================

const DB_NAME = 'chat-images';
const DB_VERSION = 1;
const STORE_NAME = 'attachments';

class FileStoreIndexedDB {
  constructor() {
    this.db = null;
    this.initPromise = this._init();
  }

  async _init() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => { this.db = request.result; resolve(); };
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };
    });
  }

  async _ensureReady() {
    await this.initPromise;
  }

  async _get(store, key) {
    await this._ensureReady();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(store, 'readonly');
      const request = tx.objectStore(store).get(key);
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error);
    });
  }

  async _put(store, key, value) {
    await this._ensureReady();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(store, 'readwrite');
      const request = tx.objectStore(store).put(value, key);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async _delete(store, key) {
    await this._ensureReady();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(store, 'readwrite');
      const request = tx.objectStore(store).delete(key);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  // Convert ArrayBuffer/Uint8Array to base64 data URL
  _bytesToDataUrl(bytes, type) {
    const chunkSize = 65536;
    let binary = '';
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.subarray(i, i + chunkSize);
      binary += String.fromCharCode(...chunk);
    }
    const base64 = btoa(binary);
    return `data:${type};base64,${base64}`;
  }

  // Save files for an exchange
  async save(exchangeId, files) {
    const fileBlobs = files.map(f => {
      // dataUrl is "data:type;base64,..."
      const base64 = f.dataUrl.split(',')[1];
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      return { name: f.name, type: f.type, data: bytes };
    });
    await this._put(STORE_NAME, exchangeId, fileBlobs);
  }

  // Load files for an exchange - returns array of { blobUrl, name, type, getDataUrl }
  async load(exchangeId) {
    const fileBlobs = await this._get(STORE_NAME, exchangeId);
    if (!fileBlobs) return [];

    return fileBlobs.map(f => {
      const blob = new Blob([f.data], { type: f.type });
      const blobUrl = URL.createObjectURL(blob);
      return {
        blobUrl,
        name: f.name,
        type: f.type,
        getDataUrl: () => this._bytesToDataUrl(f.data, f.type)
      };
    });
  }

  // Delete files for an exchange
  async delete(exchangeId) {
    await this._delete(STORE_NAME, exchangeId);
  }

  // Get storage stats
  async getSize() {
    await this._ensureReady();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(STORE_NAME, 'readonly');
      const request = tx.objectStore(STORE_NAME).getAllKeys();
      request.onsuccess = async () => {
        const keys = request.result;
        let totalBytes = 0;
        for (const key of keys) {
          const data = await new Promise((res, rej) => {
            const r = tx.objectStore(STORE_NAME).get(key);
            r.onsuccess = () => res(r.result);
            r.onerror = () => rej(r.error);
          });
          if (data) {
            for (const f of data) {
              totalBytes += f.data?.length || 0;
            }
          }
        }
        resolve({ entries: keys.length, bytes: totalBytes, mb: (totalBytes / 1024 / 1024).toFixed(2) });
      };
      request.onerror = () => reject(request.error);
    });
  }
}

// ============================================
// API Backend (Node server - file-based)
// ============================================

class FileStoreApi {
  async _fetchAsDataUrl(url) {
    const res = await fetch(url);
    const blob = await res.blob();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  // Save files - receive as base64 dataUrl, store as files on server
  async save(exchangeId, files) {
    const fileData = files.map(f => {
      const base64 = f.dataUrl.split(',')[1];
      return { name: f.name, type: f.type, data: base64 };
    });
    await fetch(`/api/chat-files/${encodeURIComponent(exchangeId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: fileData }),
    });
  }

  // Load files - returns array of { blobUrl, name, type, getDataUrl }
  // blobUrl is the server URL that works directly as img src
  async load(exchangeId) {
    const res = await fetch(`/api/chat-files/${encodeURIComponent(exchangeId)}`);
    if (!res.ok) return [];
    const files = await res.json();
    return files.map(f => ({
      blobUrl: f.url,  // server URL works as img src
      name: f.name,
      type: f.type,
      getDataUrl: async () => this._fetchAsDataUrl(f.url)
    }));
  }

  // Delete files for an exchange
  async delete(exchangeId) {
    await fetch(`/api/chat-files/${encodeURIComponent(exchangeId)}`, { method: 'DELETE' });
  }

  // Get storage stats
  async getSize() {
    const res = await fetch('/api/files');
    return res.json();
  }
}

// ============================================
// FileStore - Unified facade
// ============================================

class FileStore {
  constructor() {
    this._backend = null;
  }

  async _ensureBackend() {
    if (!this._backend) {
      await initServerType();
      this._backend = IS_NODE_SERVER() ? new FileStoreApi() : new FileStoreIndexedDB();
      console.log('File backend:', IS_NODE_SERVER() ? 'Node (API)' : 'Browser (IndexedDB)');
    }
    return this._backend;
  }

  async save(exchangeId, files) {
    const backend = await this._ensureBackend();
    return backend.save(exchangeId, files);
  }

  async load(exchangeId) {
    const backend = await this._ensureBackend();
    return backend.load(exchangeId);
  }

  async delete(exchangeId) {
    const backend = await this._ensureBackend();
    return backend.delete(exchangeId);
  }

  async getSize() {
    const backend = await this._ensureBackend();
    return backend.getSize();
  }
}

export const fileStore = new FileStore();
