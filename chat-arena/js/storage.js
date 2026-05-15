// ============================================
// Arena Storage — Backend-only via chat API
// No localStorage, no IndexedDB fallback.
// ============================================

import { backendClient } from '../../chat/js/api-client.js';

function _getClient() {
    return backendClient;
}

async function _listArenas() {
    const bc = _getClient();
    const sessions = await bc.listSessions();
    return sessions.filter(s => s.mode === 'arena');
}

export const arenaStorage = {
    async loadHistory() {
        const arenas = await _listArenas();
        return arenas.map(s => ({
            id: s.id,
            title: s.title || s.arenaConfig?.topic || 'Arena Session',
            participants: [s.arenaConfig?.modelA || '?', s.arenaConfig?.modelB || '?'],
            messageCount: s.messageCount || 0,
            updatedAt: s.updatedAt || s.createdAt,
            createdAt: s.createdAt,
            topic: s.title || s.arenaConfig?.topic || ''
        }));
    },

    async saveHistory() {
        // Backend is source of truth — no-op
    },

    async loadSession(id) {
        const bc = _getClient();
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
                speaker: m.speaker || m.role || '',
                role: m.role || 'assistant',
                content: m.content || '',
                model: m.model || null
            })),
            summary: s.summary || null,
            settings: s.arenaConfig || {}
        };
    },

    async saveSession(id, sessionData) {
        const bc = _getClient();
        try {
            const existing = await bc.getSession(id);
            if (!existing?.session) {
                await bc.createSession({
                    title: sessionData.topic || 'Arena Session',
                    mode: 'arena',
                    model: sessionData.participants?.[0] || null,
                    arenaConfig: sessionData.settings || {
                        modelA: sessionData.participants?.[0] || '',
                        modelB: sessionData.participants?.[1] || ''
                    }
                });
            }
        } catch {
            await bc.createSession({
                title: sessionData.topic || 'Arena Session',
                mode: 'arena',
                model: sessionData.participants?.[0] || null,
                arenaConfig: sessionData.settings || {}
            });
        }
    },

    async deleteSession(id) {
        const bc = _getClient();
        try { await bc.deleteSession(id); } catch {}
    },

    async getAllSessionIds() {
        const arenas = await _listArenas();
        return arenas.map(a => a.id);
    },

    async clearAll() {
        const ids = await this.getAllSessionIds();
        const bc = _getClient();
        for (const id of ids) {
            try { await bc.deleteSession(id); } catch {}
        }
    },

    async removeFromHistory(id) {
        await this.deleteSession(id);
    }
};
