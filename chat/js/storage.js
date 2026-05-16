// ============================================
// Storage - API strictly using User Settings
// ============================================

import { backendClient } from './api-client.js';

class StorageManager {
    constructor() {
        this._userSettingsData = null;
        this._initPromise = null;
    }

    async _ensureUserSettings() {
        if (this._userSettingsData) return true;
        try {
            const res = await backendClient.getUserSettings();
            if (res && res.settings) {
                this._userSettingsData = res.settings;
                return true;
            }
        } catch(e) {}
        this._userSettingsData = {};
        return true;
    }

    async _saveUserSettings() {
        if (!this._userSettingsData) return;
        try {
            await backendClient.updateUserSettings(this._userSettingsData);
        } catch(e) {}
    }

    // ---- Conversation data (Offline caching ripped out per request) ----

    async saveConversation(id, exchanges) {}
    async loadConversation(id) { return []; }
    async deleteConversation(id) {}

    // ---- History list (Offline caching ripped out) ----

    async saveHistory(conversations) {}
    async loadHistory() { return []; }

    // ---- Active chat ID ----

    async getActiveChatId() {
        if (await this._ensureUserSettings()) {
            return this._userSettingsData['activeChatId'] || null;
        }
        return null;
    }

    async setActiveChatId(id) {
        if (await this._ensureUserSettings()) {
            this._userSettingsData['activeChatId'] = id;
            await this._saveUserSettings();
        }
    }

    // ---- User preferences ----

    async getPref(key) {
        if (await this._ensureUserSettings()) {
            return this._userSettingsData[key] !== undefined ? this._userSettingsData[key] : null;
        }
        return null;
    }

    async setPref(key, value) {
        if (await this._ensureUserSettings()) {
            this._userSettingsData[key] = value;
            await this._saveUserSettings();
        }
    }

    // ---- MCP config (namespace: 'mcp:') ----

    async mcpGet(key) {
        if (await this._ensureUserSettings()) {
            const mcpKey = 'mcp-' + key;
            return this._userSettingsData[mcpKey] !== undefined ? this._userSettingsData[mcpKey] : null;
        }
        return null;
    }

    async mcpSet(key, value) {
        if (await this._ensureUserSettings()) {
            const mcpKey = 'mcp-' + key;
            this._userSettingsData[mcpKey] = value;
            await this._saveUserSettings();
        }
    }

    // ---- Storage estimate ----

    async getStorageEstimate() {
        return { usage: 0, quota: 0, percent: '0' };
    }
}

// Singleton
export const storage = new StorageManager();

