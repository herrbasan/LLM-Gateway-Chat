// ============================================
// File Store - Unified file/image storage abstraction
// ============================================
//
// Returns { blobUrl } for API backend (server URL)
// Used by chat when rendering images/files in messages.
// ============================================

class FileStore {
  async _fetchAsDataUrl(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error('Failed to fetch file');
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
    if (!files || files.length === 0) return;
    
    const fileData = files.map(f => {
      const base64 = f.dataUrl.split(',')[1];
      return { name: f.name, type: f.type, data: base64 };
    });
    
    const response = await fetch(`/api/chat-files/${encodeURIComponent(exchangeId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: fileData }),
    });
    const result = await response.json();
    return result.files || [];
  }

  // Load files - returns array of { blobUrl, name, type, getDataUrl }
  // blobUrl is the server URL that works directly as img src
  async load(exchangeId) {
    try {
      const res = await fetch(`/api/chat-files/${encodeURIComponent(exchangeId)}`);
      if (!res.ok) return [];
      
      const files = await res.json();
      if (!Array.isArray(files)) return [];
      
      return files.map(f => ({
        blobUrl: f.url,  // server URL works as img src
        name: f.name,
        type: f.type,
        getDataUrl: async () => this._fetchAsDataUrl(f.url)
      }));
    } catch (e) {
      console.error('Failed to load files for exchange', exchangeId, e);
      return [];
    }
  }

  // Delete files for an exchange
  async delete(exchangeId) {
    try {
      await fetch(`/api/chat-files/${encodeURIComponent(exchangeId)}`, { method: 'DELETE' });
    } catch (e) {
      console.error('Failed to delete files for exchange', exchangeId, e);
    }
  }

  // Get storage stats
  async getSize() {
    try {
      const res = await fetch('/api/files');
      if (!res.ok) return { entries: 0, bytes: 0, mb: '0.00' };
      return res.json();
    } catch (e) {
      return { entries: 0, bytes: 0, mb: '0.00' };
    }
  }
}

export const fileStore = new FileStore();
