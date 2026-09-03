// ============================================
// Voice dictation controller — button-driven dictation over the vendored
// nVoice SDK (R2 flow). Owns the nVoiceClient lifecycle; rendering lives in
// chat.js. Talks to the backend relay at /api/stt (same-origin → nVoice).
// Emits: state {state} | final {settled} | provisional {text} | error {error}
// ============================================
import '../../lib/stt/nvoice-client.js';

const STT_BASE_PATH = '/api/stt';

export function createVoiceDictation() {
    const ClientClass = window.nVoiceClient;
    if (!ClientClass) throw new Error('voice-dictation: nVoiceClient global missing — sdk failed to load');

    let client = null;
    let state = 'idle'; // idle | connecting | recording | cleaning
    let cancelPending = false;
    const listeners = {};
    const emit = (ev, data) => (listeners[ev] || []).slice().forEach((cb) => cb(data));

    function on(ev, cb) { (listeners[ev] ??= []).push(cb); }

    async function start() {
        if (state !== 'idle') throw new Error(`voice-dictation: start() while ${state}`);
        state = 'connecting';
        cancelPending = false;
        emit('state', { state });
        client = new ClientClass({ serverUrl: '', basePath: STT_BASE_PATH });
        client.on('transcript', (d) => {
            if (!client) return;
            if (d.is_final) emit('final', { settled: client.getRawText() });
            else emit('provisional', { text: d.text });
        });
        client.on('error', (e) => emit('error', { error: e?.message || String(e) }));
        try {
            await client.start(); // includes the mic-permission prompt — can sit for a while
        } catch (e) {
            // start() can fail AFTER the mic was granted (e.g. relay down on the
            // session fetch) — disconnect or the track stays open and the
            // browser's mic indicator never goes out.
            client?.disconnect();
            client = null;
            state = 'idle';
            emit('state', { state });
            throw e;
        }
        if (cancelPending) { // cancelled while the permission prompt was open
            client.disconnect();
            client = null;
            state = 'idle';
            emit('state', { state });
            return;
        }
        state = 'recording';
        emit('state', { state });
    }

    // Done: stop audio, clean the accumulated raw text, hand both back.
    // cleanup() throws on failure — the caller keeps the raw text (it is
    // already in the input; nothing is lost).
    async function finish() {
        if (state !== 'recording') throw new Error(`voice-dictation: finish() while ${state}`);
        state = 'cleaning';
        emit('state', { state });
        const c = client;
        client = null;
        const raw = c.getRawText();
        c.stop(); // mute the mic immediately; the REST cleanup needs no connection
        let cleaned = '';
        try {
            if (raw) cleaned = await c.cleanup(raw, 'clean');
        } finally {
            c.disconnect();
        }
        state = 'idle';
        emit('state', { state });
        return { raw, cleaned };
    }

    function cancel() {
        if (state === 'idle' || state === 'cleaning') return;
        if (state === 'connecting') { cancelPending = true; return; }
        client?.disconnect();
        client = null;
        state = 'idle';
        emit('state', { state });
    }

    return {
        on, start, finish, cancel,
        get state() { return state; },
    };
}
