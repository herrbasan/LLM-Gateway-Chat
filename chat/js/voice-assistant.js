// ============================================
// Voice assistant controller — hands-free mode over the vendored nVoice
// SDK's R3 assistant surface ("ok kimi" wake → listen → capture → end
// command → internal cleanup → deliver). Owns the nVoiceClient lifecycle;
// rendering, sending, and TTS live in chat.js. Talks to the /api/stt relay.
//
// Emits:
//   state {state}    listening | awake | capturing | processing | held
//   capture {text}   live accumulated utterance while capturing
//   hold {text}      capture stopped, unsent (REVIEW)
//   message {raw, text}  deliverable — text is cleaned (raw on cleanup failure)
//   cancel {reason}  capture/held discarded
//   error {error}    voice/backend failure (fail loud, never silent)
// ============================================
import '../../lib/stt/nvoice-client.js';

const STT_BASE_PATH = '/api/stt';

export function createVoiceAssistant() {
    const ClientClass = window.nVoiceClient;
    if (!ClientClass) throw new Error('voice-assistant: nVoiceClient global missing — sdk failed to load');

    let client = null;
    let running = false;
    const listeners = {};
    const emit = (ev, data) => (listeners[ev] || []).slice().forEach((cb) => cb(data));

    function on(ev, cb) { (listeners[ev] ??= []).push(cb); }

    async function start() {
        if (running) throw new Error('voice-assistant: start() while running');
        client = new ClientClass({ serverUrl: '', basePath: STT_BASE_PATH });

        client.on('assistantState', ({ state }) => {
            if (state === 'disabled') return; // controller-owned transition
            emit('state', { state });
        });
        client.on('kimiState', ({ state }) => {
            // The command window between wake and "listen" — surface as 'awake'.
            if (state === 'command') emit('state', { state: 'awake' });
        });
        client.on('kimiDictation', ({ text }) => emit('capture', { text }));
        client.on('assistantHold', ({ text }) => emit('hold', { text }));
        client.on('assistantMessage', ({ raw, text }) => emit('message', { raw, text }));
        client.on('assistantCancel', ({ reason }) => emit('cancel', { reason }));
        client.on('assistantError', ({ error }) => emit('error', { error }));
        client.on('error', (e) => emit('error', { error: e?.message || String(e) }));

        try {
            await client.enableAssistantMode({ cleanup: 'clean' }); // arms worker wake + forces AEC (R4)
            await client.start(); // mic + realtime WS — includes the permission prompt
        } catch (e) {
            // Can fail after the mic was granted — full teardown or the track
            // and the wake socket stay open (same hygiene as voice-dictation).
            client.disableAssistantMode();
            client.disconnect();
            client = null;
            throw e;
        }
        running = true;
    }

    function stop() {
        if (!client) return;
        client.disableAssistantMode();
        client.disconnect();
        client = null;
        running = false;
    }

    // REVIEW actions — release the SDK's held text after a manual Send/Discard
    // (the R3 held field has no public release; this is the one sanctioned
    // touchpoint — re-check against the vendored SDK on updates).
    function releaseHeld() {
        if (client) client._assistantHeldText = null;
    }

    return {
        on, start, stop, releaseHeld,
        get running() { return running; },
    };
}
