// ============================================
// Image Store - IndexedDB for chat attachments
// ============================================

const DB_NAME = 'chat-images';
const DB_VERSION = 1;
const STORE_NAME = 'attachments';

export class ImageStore {
    constructor() {
        this.db = null;
        this.initPromise = this.init();
    }

    async init() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                this.db = request.result;
                resolve();
            };
            
            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    // Key = exchangeId
                    db.createObjectStore(STORE_NAME);
                }
            };
        });
    }

    /**
     * Store attachments for an exchange
     * @param {string} exchangeId - The exchange ID
     * @param {Array} attachments - Array of {dataUrl, name, type}
     */
    async save(exchangeId, attachments) {
        await this.initPromise;
        
        // Strip data URL prefix and convert to Uint8Array for efficient storage
        const imageBlobs = attachments.map(att => {
            const base64 = att.dataUrl.split(',')[1];
            const binary = atob(base64);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) {
                bytes[i] = binary.charCodeAt(i);
            }
            return {
                name: att.name,
                type: att.type,
                data: bytes
            };
        });

        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            const request = store.put(imageBlobs, exchangeId);
            
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Load attachments for an exchange
     * @param {string} exchangeId - The exchange ID
     * @returns {Array} Array of {blobUrl, name, type, getDataUrl} - blobUrl for display, getDataUrl() for API
     */
    async load(exchangeId) {
        await this.initPromise;
        
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(STORE_NAME, 'readonly');
            const store = tx.objectStore(STORE_NAME);
            const request = store.get(exchangeId);
            
            request.onsuccess = () => {
                const imageBlobs = request.result;
                if (!imageBlobs) {
                    resolve([]);
                    return;
                }
                
                const attachments = imageBlobs.map(img => {
                    // Create blob URL for display (cheap, no conversion)
                    const blob = new Blob([img.data], { type: img.type });
                    const blobUrl = URL.createObjectURL(blob);
                    
                    // Lazily convert to base64 only when needed for API
                    const getDataUrl = () => this._bytesToDataUrl(img.data, img.type);
                    
                    return {
                        blobUrl,      // For <img> display
                        getDataUrl,   // Function - call when sending to API
                        name: img.name,
                        type: img.type
                    };
                });
                
                resolve(attachments);
            };
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Convert Uint8Array to base64 data URL (expensive, only call when needed)
     */
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

    /**
     * Delete attachments for an exchange
     * @param {string} exchangeId - The exchange ID
     */
    async delete(exchangeId) {
        await this.initPromise;
        
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            const request = store.delete(exchangeId);
            
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Clear all stored images
     */
    async clear() {
        await this.initPromise;
        
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            const request = store.clear();
            
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Get storage estimate
     */
    async getSize() {
        await this.initPromise;
        
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(STORE_NAME, 'readonly');
            const store = tx.objectStore(STORE_NAME);
            const request = store.getAllKeys();
            
            request.onsuccess = async () => {
                const keys = request.result;
                let totalBytes = 0;
                
                for (const key of keys) {
                    const data = await new Promise((res, rej) => {
                        const r = store.get(key);
                        r.onsuccess = () => res(r.result);
                        r.onerror = () => rej(r.error);
                    });
                    
                    if (data) {
                        for (const img of data) {
                            totalBytes += img.data?.length || 0;
                        }
                    }
                }
                
                resolve({
                    entries: keys.length,
                    bytes: totalBytes,
                    mb: (totalBytes / 1024 / 1024).toFixed(2)
                });
            };
            request.onerror = () => reject(request.error);
        });
    }
}

// Singleton instance
export const imageStore = new ImageStore();
