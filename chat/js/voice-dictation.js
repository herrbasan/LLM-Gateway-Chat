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
    // Set while WE are tearing the session down, so the SDK's 'disconnected'
    // event is not mistaken for a lost connection.
    let discarding = false;
    let audioDeviceId = null; // STT settings tab — applied to the next session
    const listeners = {};
    const emit = (ev, data) => (listeners[ev] || []).slice().forEach((cb) => cb(data));

    function on(ev, cb) { (listeners[ev] ??= []).push(cb); }

    function setAudioDevice(id) { audioDeviceId = id || null; }

    async function start() {
        if (state !== 'idle') throw new Error(`voice-dictation: start() while ${state}`);
        state = 'connecting';
        cancelPending = false;
        emit('state', { state });
        client = new ClientClass({ serverUrl: '', basePath: STT_BASE_PATH, audioDeviceId });
        client.on('transcript', (d) => {
            if (!client) return;
            if (d.is_final) emit('final', { settled: client.getRawText() });
            else emit('provisional', { text: d.text });
        });
        client.on('error', (e) => emit('error', { error: e?.message || String(e) }));
        // A dropped socket (nVoice restart, iOS suspending a home-screen app) used
        // to leave dictation stuck in 'recording' with the mic button dead, and
        // the only way out was a page reload — which an installed web app does not
        // offer. Notice it, say so, and return to idle so a tap retries.
        client.on('disconnected', () => {
            if (state === 'idle' || state === 'cleaning') return;  // our own teardown
            if (discarding) return;
            const wasRecording = state === 'recording';
            client?.disconnect();
            client = null;
            state = 'idle';
            emit('state', { state });
            emit('error', {
                error: wasRecording
                    ? 'Voice connection lost — nothing was transcribed. Tap the mic to start again'
                    : 'Voice connection lost — tap the mic to retry',
            });
        });
        try {
            await client.start(); // includes the mic-permission prompt — can sit for a while
        } catch (e) {
            // Same stale-device case as the assistant: the SDK requests a saved mic
            // with `deviceId: { exact: ... }`, and a device that is gone (routine on
            // iOS, where device ids are not stable) throws OverconstrainedError.
            // Retry on the default mic, loudly, rather than leaving dictation dead.
            const staleDevice = e?.name === 'OverconstrainedError' && !!audioDeviceId;
            if (staleDevice) {
                client.setAudioDevice(null);
                audioDeviceId = null;
                try {
                    await client.start();
                } catch (e2) {
                    discarding = true;
                    client?.disconnect();
                    client = null;
                    discarding = false;
                    state = 'idle';
                    emit('state', { state });
                    throw e2;
                }
                emit('error', { error: 'Saved microphone unavailable — using the default mic' });
            } else {
                discarding = true;
                client?.disconnect();
                client = null;
                discarding = false;
                state = 'idle';
                emit('state', { state });
                throw e;
            }
        }
        if (cancelPending) { // cancelled while the permission prompt was open
            discarding = true;
            client.disconnect();
            client = null;
            discarding = false;
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
            discarding = true;
            c.disconnect();
            discarding = false;
        }
        state = 'idle';
        emit('state', { state });
        return { raw, cleaned };
    }

    function cancel() {
        if (state === 'idle' || state === 'cleaning') return;
        if (state === 'connecting') { cancelPending = true; return; }
        discarding = true;
        client?.disconnect();
        client = null;
        discarding = false;
        state = 'idle';
        emit('state', { state });
    }

    return {
        on, start, finish, cancel, setAudioDevice,
        get state() { return state; },
    };
}
