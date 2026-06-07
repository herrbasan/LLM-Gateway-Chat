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
            topic: s.title || s.arenaConfig?.topic || '',
            category: s.category || '',
            summary: s.summary || '',
            pinned: !!s.pinned
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
        const cfg = s.arenaConfig || {};
        const createdAt = s.createdAt ? new Date(s.createdAt).getTime() : Date.now();
        const updatedAt = s.updatedAt ? new Date(s.updatedAt).getTime() : createdAt;
        const summaryRaw = s.summary || null;

        // Fallback: if arenaConfig is missing model names (e.g. legacy imports
        // or arenas created before model tracking), infer them from the
        // first two unique non-moderator speakers in the messages.
        let inferredModels = false;
        if (!cfg.modelA || !cfg.modelB) {
            const speakers = [...new Set(
                msgs.filter(m => m.speaker && m.speaker !== 'moderator')
                    .map(m => m.speaker)
            )];
            if (!cfg.modelA && speakers[0]) { cfg.modelA = speakers[0]; inferredModels = true; }
            if (!cfg.modelB && speakers[1]) { cfg.modelB = speakers[1]; inferredModels = true; }
        }
        // Persist the inferred models back to the backend (one-time fix-up).
        // This is a soft migration for legacy data; safe to run repeatedly.
        if (inferredModels && (cfg.modelA || cfg.modelB)) {
            bc.updateSession(id, {
                arenaConfig: {
                    ...cfg
                }
            }).catch(err => console.warn('[Arena] Failed to persist inferred models:', err.message));
        }
        const summary = summaryRaw ? {
            title: summaryRaw.title || '',
            teaser: summaryRaw.teaser || summaryRaw.shortSummary || '',
            reflection: summaryRaw.reflection || summaryRaw.longSummary || '',
            category: summaryRaw.category || '',
            pinned: !!summaryRaw.pinned
        } : null;

        return {
            version: 2,
            mode: 'arena',
            id: s.id,
            sessionId: s.sessionId || s.id,
            exportedAt: new Date().toISOString(),
            topic: cfg.topic || s.title || '',
            chatInfo: {
                id: s.id,
                title: s.title || cfg.topic || 'Arena Session',
                createdAt,
                updatedAt,
                category: s.category || '',
                pinned: !!s.pinned
            },
            participants: [
                {
                    name: cfg.modelA ? cfg.modelA.split('/').pop() : 'Model A',
                    model: cfg.modelA || '',
                    role: 'assistant',
                    systemPrompt: cfg.systemPromptA || null
                },
                {
                    name: cfg.modelB ? cfg.modelB.split('/').pop() : 'Model B',
                    model: cfg.modelB || '',
                    role: 'assistant',
                    systemPrompt: cfg.systemPromptB || null
                }
            ],
            settings: {
                maxTurns: cfg.maxTurns,
                autoAdvance: cfg.autoAdvance,
                temperature: cfg.temperature,
                reasoningEffort: cfg.reasoningEffort || null,
                modelA: cfg.modelA || '',
                modelB: cfg.modelB || '',
                systemPromptA: cfg.systemPromptA || null,
                systemPromptB: cfg.systemPromptB || null,
                targetTokens: cfg.targetTokens
            },
            summary,
            messages: msgs.map(m => ({
                id: m.id || null,
                speaker: m.speaker || '',
                role: m.role || 'assistant',
                content: m.content || '',
                createdAt: m.createdAt || null,
                reasoning_content: m.reasoning_content || null,
                thinking_signature: m.thinking_signature || null,
                streamStats: m.streamStats || null,
                usage: m.usage || null,
                context: m.context || null,
                embedStatus: m.embedStatus || null,
                embedError: m.embedError || null
            }))
        };
    },

    async saveSession(id, sessionData) {
        const bc = _getClient();
        try {
            const created = await bc.createSession({
                title: sessionData.topic || 'Arena Session',
                mode: 'arena',
                model: sessionData.participants?.[0] || null,
                arenaConfig: {
                    modelA: sessionData.settings?.modelA || sessionData.participants?.[0] || '',
                    modelB: sessionData.settings?.modelB || sessionData.participants?.[1] || '',
                    maxTurns: sessionData.settings?.maxTurns,
                    autoAdvance: sessionData.settings?.autoAdvance,
                    systemPromptA: sessionData.settings?.systemPromptA,
                    systemPromptB: sessionData.settings?.systemPromptB,
                    targetTokens: sessionData.settings?.targetTokens
                }
            });
            return created?.id || id;
        } catch {
            return id;
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
