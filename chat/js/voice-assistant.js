// ============================================
// Voice assistant controller — reactive hands-free turn-taking mode over
// nVoice SDK v1.1+ (?intent=1 gauntlet) + streaming look-ahead sentence TTS
// via TtsPlayer over the /api/tts relay.
//
// Owns nVoiceClient and TtsPlayer lifecycles; UI presentation and runner
// coordination live in chat.js.
//
// Emits:
//   state {state, hint}  off | starting | listening | transcribing | evaluating | speaking | ducked | interrupted
//   transcript {text, isFinal} live utterance as the user speaks
//   message {text}       settled, cleaned turn ready to send to LLM
//   bargeIn {reason}     user spoke interrupt keyword (stops TTS, aborts active run)
//   duck                 TTS volume ducked due to sustained speech
//   unduck               TTS volume restored
//   echoSuppressed {text} self-echo dropped by server-side echo guard
//   verdict {verdict, text, latencyMs} 12B gauntlet turn outcome (COMPLETE/INCOMPLETE/NOT_SPEECH)
//   turn {turn}          live turn snapshot from nVoice
//   error {error}        voice/backend failure (fail loud, never silent)
// ============================================
import '../../lib/stt/nvoice-client.js';
import '../../lib/stt/tts-player.js';

const STT_BASE_PATH = '/api/stt';
const TTS_BASE_URL = '/api/tts';
// How long a "busy" state may survive with nothing actually running before we
// call it what it is and reset. Long enough to cover a slow tool hop, short
// enough that a phantom state is not mistaken for the app hanging.
const STUCK_STATE_MS = 8000;
// How long the INTERRUPTED state stays up before falling back to listening.
const INTERRUPT_DISPLAY_MS = 2500;
// Wait before re-attaching after a lost link, and the cap on the backoff.
//
// Deliberately NOT aggressive. A service restart is the most common cause of a
// lost link, and nVoice needs ~15s to load the model and warm up — while a
// session arriving DURING that warmup wedges it (nVoice #10: the health check
// then times out at 120s and the engine stays dead until a manual restart). So
// the reconnect storm a restart provokes is itself the hazard: knocking at 1.5s
// and 3s walks straight into the warmup window. A slower first retry trades a
// few seconds of recovery for not being the thing that breaks the server.
const RECONNECT_DELAY_MS = 5000;
const MAX_RECONNECT_DELAY_MS = 30000;
const MAX_RECONNECT_ATTEMPTS = 5;
// The realtime worker emits telemetry every loop cycle — including silence, where
// the idle branch sends it every 0.2s. So a quiet link is a DEAD link, and this
// is the only signal that cannot lie: a half-open socket (TCP gone, no FIN — the
// usual failure over Wi-Fi/VPN, or a killed far end) keeps reporting OPEN forever.
const STALE_LINK_MS = 6000;
const LIVENESS_POLL_MS = 2000;
// (Reply tokens used to be batched here to work around an upstream scheduler bug:
// TtsPlayer._schedule() guarded only on `_source`, which _startSource assigned
// AFTER its awaited decode, so pushes landing in that window started several
// sentences at once and the audio stacked. nVoice #3 fixed it in SDK v1.1.2 with a
// reserved `_starting` slot, so the batching is gone -- tokens go straight
// through. The overlap detector below stays as a canary for a regression.)

export function createVoiceAssistant() {
    const ClientClass = window.nVoiceClient;
    if (!ClientClass) throw new Error('voice-assistant: nVoiceClient global missing — sdk failed to load');
    const TtsPlayerClass = window.TtsPlayer;
    if (!TtsPlayerClass) throw new Error('voice-assistant: TtsPlayer global missing — sdk failed to load');

    let client = null;
    let ttsPlayer = null;
    let running = false;
    let currentState = 'off';
    let audioDeviceId = null;
    // No hardcoded engine/voice: the TTS settings own that choice and it is
    // re-resolved on every turn. Defaulting here silently spoke with Kokoro
    // even when the user had picked another engine.
    let ttsOptions = { model: null, voice: null, speed: null };
    let unduckTimer = null;
    let turnActive = false;      // a gauntlet-surviving turn is being answered
    let replyGate = { open: true, held: '' };
    let activityText = '';
    let activityDesktop = true;
    let getTtsVoice = null;      // injected: () => ({ model, voice, speed })
    let stateWatchdog = null;
    let interruptTimer = null;
    let reconnectTimer = null;
    // Set for the duration of a deliberate stop(), so the SDK's 'disconnected'
    // event is not mistaken for a lost connection.
    let stopping = false;
    // Playback-run tracking: a 'start' while a run is already open means two
    // sentences are sounding at once — the stacking bug (#3, fixed upstream in
    // v1.1.2). Kept as a canary: if it ever fires again, the scheduler regressed.
    let ttsRunActive = false;

    // States that claim something is happening. If one of these is showing and
    // nothing is playing, queued or generating, the state is a lie left behind by
    // a missing/reset event — say so loudly and recover instead of freezing.
    const BUSY_STATES = new Set(['thinking', 'speaking', 'ducked', 'interrupted']);

    // ---- projection-label hygiene -----------------------------------------
    // Stored content is label-free, but the API projection puts a label on the
    // user's turns — `[YYYY-MM-DD@HH:MM] ` always, plus `[voice] ` when the turn
    // was spoken — and models demonstrably mimic the leading label (that mimicry
    // is why the timestamp case exists at all). Both shapes are stripped before
    // synthesis, and from the displayed reply: what the model echoed is not part
    // of what the assistant said.
    const TS_LABEL = /\[(?:\d{4}-\d{2}-\d{2}@\d{2}:\d{2}|voice)\]\s*/g;
    function stripTimestamps(text) { return String(text ?? '').replace(TS_LABEL, ''); }

    const listeners = {};
    const emit = (ev, data) => (listeners[ev] || []).slice().forEach((cb) => cb(data));

    function on(ev, cb) { (listeners[ev] ??= []).push(cb); }

    function setAudioDevice(id) { audioDeviceId = id || null; }

    // Pull the engine/voice the TTS settings currently resolve to and apply it
    // to the live player. Called at the START of each turn, never mid-turn — a
    // voice swap mid-reply would mix engines inside one answer.
    function syncTtsVoice() {
        if (!ttsPlayer || typeof getTtsVoice !== 'function') return;
        const r = getTtsVoice();
        if (!r) return;
        if (r.model) ttsPlayer.model = r.model;
        if (r.voice) ttsPlayer.voice = r.voice;
        if (typeof r.speed === 'number' && r.speed > 0) ttsPlayer.speed = r.speed;
    }

    function setTtsOptions(opts) {
        if (!opts) return;
        if (opts.model) ttsOptions.model = opts.model;
        if (opts.voice) ttsOptions.voice = opts.voice;
        if (typeof opts.speed === 'number') ttsOptions.speed = opts.speed;
        if (opts.getTtsVoice) getTtsVoice = opts.getTtsVoice;
        if (ttsPlayer) syncTtsVoice();
    }

    function setState(state, hint = '') {
        currentState = state;
        armStateWatchdog();
        emit('state', { state, hint });
    }

    // A state is only trustworthy while something backs it up. Everything here
    // is a safety net for a lost event, never a substitute for handling one.
    function armStateWatchdog() {
        clearTimeout(stateWatchdog);
        stateWatchdog = null;
        if (!BUSY_STATES.has(currentState)) return;
        stateWatchdog = setTimeout(() => {
            stateWatchdog = null;
            if (!BUSY_STATES.has(currentState)) return;
            if (ttsPlayer?.playing || ttsPlayer?.pending || turnActive) return; // still real
            console.warn(`[voice-assistant] stuck in '${currentState}' with nothing playing or generating — resetting to listening`);
            setState('listening', 'Listening… speak naturally');
        }, STUCK_STATE_MS);
    }

    // Activity = what the assistant is DOING right now (tool name, thinking
    // preview, "writing…"). Separate from state so a long tool turn shows
    // progress instead of a frozen silence.
    //
    // `desktop` gates the reasoning PREVIEW: on desktop the chat already renders
    // the thinking block, so echoing it into the dock would show it twice. Short
    // phase labels ("Thinking…", "Using X…") go to both surfaces.
    function setActivity(text, { desktop = true } = {}) {
        const next = String(text ?? '');
        if (next === activityText && desktop === activityDesktop) return;
        activityText = next;
        activityDesktop = desktop;
        emit('activity', { text: activityText, desktop: activityDesktop });
    }

    function beginTurn() {
        turnActive = true;
        replyGate = { open: false, held: '' };
        syncTtsVoice();
    }

    function endTurn() {
        turnActive = false;
        // An interrupt owns the indicator until its own timer clears it — a
        // run.end arriving right after a cut must not erase the trace of it.
        if (currentState === 'interrupted') { armStateWatchdog(); return; }
        // The turn is over: if nothing is still playing or queued, go back to
        // listening now. The runner knows the answer is finished — waiting for a
        // TTS 'end' that will never come is how a view gets stuck.
        if (!ttsPlayer?.playing && !ttsPlayer?.pending) {
            setState('listening', 'Listening… speak naturally');
        }
        armStateWatchdog();
    }

    function _handleTtsEvent(ev) {
        if (ev.type === 'start') {
            if (ttsRunActive) {
                // Two playback runs overlapping — the sentences stack in volume.
                // Record it in the nVoice session report so it is not lost, and
                // keep the indication on screen rather than hiding it.
                console.warn('[voice-assistant] overlapping TTS playback detected (stacking audio)');
                try { client?.note('tts-overlap', 'a TTS run started while another was still open', 'warn'); } catch { /* report optional */ }
                emit('error', { error: 'Audio glitch detected — playback overlapping' });
            }
            ttsRunActive = true;
            setState('speaking', 'Assistant speaking — say "stop" to interrupt');
            emit('ttsStart', ev);
        } else if (ev.type === 'end') {
            ttsRunActive = false;
            // Still generating? Then this was just a gap between sentences — the
            // answer is not finished and calling it "listening" would be a lie.
            if (currentState === 'speaking' || currentState === 'ducked') {
                setState(turnActive ? 'thinking' : 'listening',
                    turnActive ? 'Still writing…' : 'Listening… speak naturally');
            }
            emit('ttsEnd', ev);
        } else if (ev.type === 'interrupted') {
            ttsRunActive = false;
            emit('ttsInterrupted', ev);
        } else if (ev.type === 'ducked') {
            setState('ducked', 'Listening… (audio lowered)');
            emit('duck', ev);
        } else if (ev.type === 'overlap-prevented') {
            // The SDK's slot guard doing its job (v1.1.2, nVoice #3): a second start
            // was refused and the sentence kept for the next slot. Benign by design,
            // so it is logged rather than shown — but it is a trace, not silence.
            console.debug('[voice-assistant] TTS overlap prevented by the player');
        } else if (ev.type === 'error') {
            emit('error', { error: `TTS: ${ev.error || 'playback error'}` });
        } else if (ev.type === 'suspended') {
            // The SDK's own inaudible-output alarm (once per episode): sources
            // decode and start/end fire while nothing is audible. Passing it on
            // is the whole point — silent playback must never look like success.
            console.warn('[voice-assistant] TTS not audible:', ev.message || ev.state);
            emit('error', { error: 'Audio is muted by the browser — tap the screen to enable sound' });
        }
    }

    function _newPlayer() {
        const p = new TtsPlayerClass({
            baseUrl: TTS_BASE_URL,
            model: ttsOptions.model || undefined,
            voice: ttsOptions.voice || undefined,
            speed: ttsOptions.speed ?? 1.0,
            clean: true,
            // No `loopback` override: the SDK picks the playback path per platform
            // (WebRTC loopback off on iOS, where the AEC trick it exists for does
            // not apply). An explicit value here would pin it and block that.
            onEvent: _handleTtsEvent,
        });
        syncTtsVoice();
        return p;
    }

    // Build and UNMUTE the playback path. MUST run inside a user gesture: iOS
    // Safari keeps an AudioContext suspended when it was not created in one, and
    // everything else still succeeds — sources decode, playback events fire, and
    // nothing is audible. The SDK exposes resume() for exactly this; no peeking
    // at private fields.
    function primeTts() {
        try {
            if (!ttsPlayer) ttsPlayer = _newPlayer();
            ttsPlayer.resume()
                .then((state) => {
                    if (state !== 'running') {
                        emit('error', { error: 'Audio is muted by the browser — tap the screen to enable sound' });
                    }
                })
                .catch((e) => emit('error', { error: `TTS unavailable: ${e.message}` }));
        } catch (e) {
            emit('error', { error: `TTS unavailable: ${e.message}` });
        }
    }

    // ONE interrupt path. The stop word, nVoice's own barge-in and the tap-to-
    // interrupt buttons all funnel here, so all three behave identically and all
    // three leave the same visible trace — a cut that only half-happens (audio
    // stops, indicator keeps claiming it is speaking) is the bug this prevents.
    function interrupt(reason = 'user') {
        clearTimeout(unduckTimer);
        clearTimeout(interruptTimer);
        // Nothing more is coming for this turn — drop the flag here, or the
        // 'interrupted' phase and the watchdog both still believe it is running.
        turnActive = false;
        ttsPlayer?.stop(reason);          // cuts playback AND drops unspoken sentences
        ttsPlayer?.unmute();              // the next turn must be audible
        setActivity('');
        setState('interrupted', 'Stopped — go ahead');
        interruptTimer = setTimeout(() => {
            if (currentState === 'interrupted') setState('listening', 'Listening… speak naturally');
        }, INTERRUPT_DISPLAY_MS);
    }

    // --- link health ---------------------------------------------------------
    // Three signals, weakest first:
    //   `readyState`     — CLOSED after a clean close, but a HALF-OPEN socket
    //                      still reads OPEN forever.
    //   'disconnected'   — the SDK's event; only fires if a close actually
    //                      arrived, which is exactly what a half-open link
    //                      never delivers.
    //   SERVER TRAFFIC   — the only signal that cannot lie. See STALE_LINK_MS.
    let lastServerEventAt = 0;
    let livenessTimer = null;
    let reconnectAttempt = 0;

    function _touchLink() { lastServerEventAt = Date.now(); }

    function _linkAlive() {
        const rs = client && client.ws ? client.ws.readyState : null;
        if (rs !== 0 && rs !== 1) return false;          // CONNECTING or OPEN
        if (!lastServerEventAt) return true;             // just started
        return (Date.now() - lastServerEventAt) < STALE_LINK_MS;
    }

    // Polled, not event-driven: nothing fires on a half-open socket, so waiting
    // for a notification is waiting for something that will never arrive.
    function _startLiveness() {
        _touchLink();
        clearInterval(livenessTimer);
        livenessTimer = setInterval(() => {
            if (!running || stopping) return;
            if (_linkAlive()) return;
            const quiet = lastServerEventAt ? Math.round((Date.now() - lastServerEventAt) / 1000) : 0;
            console.warn(`[voice-assistant] link unhealthy — no server traffic for ${quiet}s, reconnecting`);
            try { client?.note?.('link-stalled', `no server traffic for ${quiet}s`, 'warn'); } catch { /* report optional */ }
            _handleLostLink('Connection stalled — reconnecting…');
        }, LIVENESS_POLL_MS);
    }

    function _stopLiveness() { clearInterval(livenessTimer); livenessTimer = null; }

    // Shared lost-link path: the SDK's 'disconnected', the liveness poll, and the
    // foreground/tap checks all land here.
    function _handleLostLink(hint) {
        if (!running || stopping) return;   // our own teardown, or already healing
        running = false;
        turnActive = false;
        _stopLiveness();
        setActivity('');
        setState('off', hint || 'Connection lost — reconnecting…');
        _scheduleReconnect();
    }

    // Bounded backoff, because one attempt was not enough: the common case is a
    // network briefly gone (tunnel, lift, screen lock) which is back a few
    // seconds later. Giving up after a single try left a dead mic and no reason.
    function _scheduleReconnect() {
        if (stopping) return;
        clearTimeout(reconnectTimer);
        if (reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
            setState('off', 'Connection lost — tap to restart');
            emit('error', { error: 'Voice connection lost — tap to restart' });
            return;
        }
        const delay = Math.min(RECONNECT_DELAY_MS * (2 ** reconnectAttempt), MAX_RECONNECT_DELAY_MS);
        reconnectAttempt += 1;
        setState('off', `Reconnecting… (${reconnectAttempt}/${MAX_RECONNECT_ATTEMPTS})`);
        reconnectTimer = setTimeout(() => {
            if (running || stopping) return;
            start().catch((e) => {
                console.warn('[voice-assistant] reconnect attempt failed:', e?.message || e);
                _scheduleReconnect();
            });
        }, delay);
    }

    // Called when the app returns to the foreground and when the user taps the
    // surface. Returns true when it detected a dead link and started healing.
    function recoverIfDead() {
        if (!running) return false;      // nothing of ours to heal
        if (_linkAlive()) return false;  // healthy — do not interfere
        _handleLostLink('Connection stalled — reconnecting…');
        return true;
    }

    async function start(opts = {}) {
        if (running) throw new Error('voice-assistant: start() while running');
        // Never inherit a previous session's socket, mic track or AudioContext.
        // Belt-and-braces: stop() already does this, but a start that follows a
        // failed start (or a reconnect) would otherwise build on the wreckage.
        _hardCloseClient();
        if (opts.getTtsVoice) getTtsVoice = opts.getTtsVoice;
        if (opts.tts) setTtsOptions(opts.tts);

        setState('starting', 'Opening microphone and connecting…');

        // Ensure TtsPlayer is ready and audible
        if (!ttsPlayer) ttsPlayer = _newPlayer();
        ttsPlayer.resume().catch(() => { /* start() runs after a gesture, but be safe */ });

        client = new ClientClass({
            serverUrl: '',
            basePath: STT_BASE_PATH,
            audioDeviceId,
            intentEnabled: true,
            intentNoReply: true, // Chat app generates with thread history
            audioProcessing: true, // Force AEC for full-duplex loopback
        });

        // Any server event proves the link is carrying traffic. Telemetry is the
        // dependable one: the worker emits it every loop cycle, silence included.
        for (const ev of ['connected', 'telemetry', 'transcript', 'phase', 'verdict',
                          'turn', 'turn-end', 'reply', 'speech-start', 'speech-end',
                          'duck', 'barge-in', 'echo-suppressed', 'asleep', 'standby']) {
            client.on(ev, _touchLink);
        }

        // Live transcription
        client.on('transcript', (d) => {
            if (!client) return;
            if (currentState === 'listening' || currentState === 'transcribing') {
                setState('transcribing', d.text);
            }
            emit('transcript', { text: d.text, isFinal: !!d.is_final });
        });

        // Machine phase. Every phase the SDK documents is handled explicitly —
        // a phase we forgot would leave the UI frozen on the previous state
        // ('evaluating' stuck was exactly that: 'done'/'streaming' fell through).
        client.on('phase', ({ phase }) => {
            switch (phase) {
                case 'cleaning':
                case 'thinking':
                    setState('thinking', 'Understanding what you said…');
                    break;
                case 'streaming':
                    // Only reachable when nVoice generates (intentNoReply off).
                    setState('speaking', 'Assistant speaking');
                    break;
                case 'done':
                    // Turn settled. If we are answering, stay in 'thinking' until
                    // audio actually starts; otherwise go back to listening.
                    if (!turnActive && !ttsPlayer?.playing) setState('listening', 'Listening… speak naturally');
                    break;
                case 'discarded':
                    setState('listening', 'Listening… (noise discarded)');
                    emit('discarded');
                    break;
                case 'interrupted':
                    setState('interrupted', 'Stopped — go ahead');
                    break;
                case 'reopened':
                    setState('listening', 'Listening… speak naturally');
                    break;
                default:
                    // Unknown phase from a newer backend — say so rather than
                    // pretending nothing happened.
                    console.warn('[voice-assistant] unhandled nVoice phase:', phase);
                    setState('listening', 'Listening… speak naturally');
            }
        });

        // Interruption keyword (barge-in): cut TTS immediately!
        client.on('barge-in', (d) => {
            interrupt('keyword');
            emit('bargeIn', { reason: d?.reason || 'keyword' });
        });

        // Sustained speech during TTS: duck volume smoothly
        client.on('duck', (d) => {
            clearTimeout(unduckTimer);
            ttsPlayer?.duck(0.4);
            setState('ducked', 'Listening… (audio lowered)');
            emit('duck', d);
        });

        client.on('speech-end', () => {
            clearTimeout(unduckTimer);
            unduckTimer = setTimeout(() => {
                if (!client?.speaking) {
                    ttsPlayer?.unduck();
                    if (currentState === 'ducked') {
                        setState('speaking', 'Assistant speaking');
                    }
                    emit('unduck');
                }
            }, 800);
        });

        // Echo dropped
        client.on('echo-suppressed', ({ text }) => {
            emit('echoSuppressed', { text });
        });

        // Gauntlet verdict
        client.on('verdict', (d) => {
            if (d.verdict === 'COMPLETE') {
                // A new turn arrived — cut any remaining audio from a prior turn,
                // and only now resolve the engine/voice (a settings change mid-
                // session must apply to the NEXT answer, not the one in flight).
                beginTurn();
                ttsPlayer?.stop('new-turn', { mute: false });
                ttsPlayer?.unmute();
                setActivity('');
                setState('thinking', 'Thinking…');
            } else if (d.verdict === 'INCOMPLETE') {
                setState('transcribing', 'Still listening — keep going');
            } else if (d.verdict === 'NOT_SPEECH') {
                setState('listening', 'Listening… (noise discarded)');
            }
            emit('verdict', d);
        });

        // Settled cleaned turn survivor
        client.on('reply', (d) => {
            if (d.result?.type === 'cleaned' && d.result.text) {
                emit('message', { text: d.result.text });
            }
        });

        client.on('turn', (t) => emit('turn', t));
        client.on('error', (e) => emit('error', { error: e?.message || String(e) }));

        // The SDK has no auto-reconnect (nVoice #1, R6), so a socket dropped by an
        // nVoice restart used to leave this UI claiming to listen forever while
        // every turn silently did nothing. Notice it, say so, and retry once — a
        // hands-free session should not need a reload because the server bounced.
        client.on('disconnected', () => {
            _handleLostLink();
        });

        try {
            await client.start();
        } catch (e) {
            // The SDK asks for a saved mic with `deviceId: { exact: ... }`, so a
            // device that is no longer present throws OverconstrainedError. That is
            // the normal case on a phone — iOS device ids are not stable, and a
            // paired headset may simply be off — so a stale saved id would kill
            // voice mode for every session. Fall back to the default mic and SAY SO:
            // a silent device swap is worse than the error it replaces.
            const staleDevice = e?.name === 'OverconstrainedError' && !!audioDeviceId;
            if (staleDevice) {
                client.setAudioDevice(null);
                audioDeviceId = null;
                emit('error', { error: 'Saved microphone unavailable — using the default mic' });
            }
            try {
                if (staleDevice) await client.start();
                else throw e;
            } catch (e2) {
                client.disconnect();
                client = null;
                ttsPlayer?.stop('start-failed');
                setState('off', 'Error starting assistant');
                throw e2;
            }
        }

        running = true;
        reconnectAttempt = 0;
        _startLiveness();
        setState('listening', 'Listening… speak naturally');
    }

    // Hard-close whatever is left of a previous session.
    //
    // Called BOTH before opening a new session and when one ends. A fresh client
    // per session is the SDK's own model ("one client per session"), and it is the
    // only way to be certain a half-open socket, a hot mic track or a leaked
    // AudioContext cannot outlive the session that created it. The SDK's
    // disconnect() already does this, but the close must not DEPEND on it
    // succeeding: a teardown that throws part-way leaves the mic recording and
    // burns one of the ~6 AudioContexts a renderer is allowed. `audioStream` and
    // `audioContext` are plain public properties, so this is not private-field
    // poking. Cost of the rebuild: one session fetch plus a WS handshake (a few
    // hundred ms, behind the 'starting' state) — the worker attaches to the
    // already-loaded model, so nothing is reloaded.
    function _hardCloseClient() {
        const c = client;
        client = null;
        if (!c) return;
        try {
            c.disconnect();
        } catch (e) {
            console.warn('[voice-assistant] disconnect threw — forcing cleanup:', e?.message || e);
        }
        try { c.audioStream?.getTracks?.().forEach((t) => t.stop()); } catch { /* already released */ }
        try {
            if (c.audioContext && c.audioContext.state !== 'closed') c.audioContext.close();
        } catch { /* already closed */ }
    }

    function stop() {
        // Flags FIRST: client.disconnect() fires the 'disconnected' handler, and
        // with running still true it would treat our own teardown as a lost link
        // and schedule a reconnect — leaving a zombie session behind.
        stopping = true;
        running = false;
        turnActive = false;
        clearTimeout(reconnectTimer);
        _stopLiveness();
        clearTimeout(unduckTimer);
        clearTimeout(stateWatchdog);
        clearTimeout(interruptTimer);
        stateWatchdog = null;
        ttsRunActive = false;
        _hardCloseClient();
        if (ttsPlayer) {
            try { ttsPlayer.stop('assistant-stopped'); } catch { /* ignore */ }
        }
        turnActive = false;
        running = false;
        stopping = false;
        setState('off', 'Assistant off');
    }

    // Feed reply tokens as they stream from the LLM runner.
    //
    // The opening tokens are held until we can tell whether the reply starts with
    // a timestamp label. That is free: TtsPlayer buffers until a sentence
    // completes, so nothing is delayed in practice.
    function pushReply(text) {
        if (!running || !ttsPlayer) return;
        if (replyGate.open) {
            const clean = stripTimestamps(text);
            if (clean) ttsPlayer.push(clean);
            return;
        }
        replyGate.held += text;
        const held = replyGate.held;
        // A label is either already complete, still impossible to be one, or
        // absurdly long — in every case stop holding and release the text.
        const plausible = /^[\[\d\-:@\s]*$/.test(held.slice(0, 32));
        if (!plausible || held.includes(']') || held.length > 40) {
            replyGate.open = true;
            replyGate.held = '';
            const clean = stripTimestamps(held);
            if (clean) ttsPlayer.push(clean);
        }
    }

    // Flush any leftover sentence at the end of the LLM generation.
    function flushReply() {
        if (!running || !ttsPlayer) return;
        if (!replyGate.open && replyGate.held) {
            let clean = stripTimestamps(replyGate.held);
            // A reply that was cut off mid-label leaves a fragment like
            // "[2026-09-" that would be read aloud as gibberish. Drop it — but
            // only when it is unambiguously a label fragment (2+ digits with a
            // separator), so a trailing list marker like "[1" survives.
            clean = clean.replace(/\[\d{2,4}(?:-\d{0,2}){0,2}(?:@\d{0,2}(?::\d{0,2})?)?\]?$/, '');
            replyGate.held = '';
            replyGate.open = true;
            if (clean) ttsPlayer.push(clean);
        }
        ttsPlayer.flush();
    }

    // Cut current reply playback — the tap-to-interrupt entry point. Same
    // semantics as the stop word because it IS the same path.
    function stopReply(reason = 'user') {
        if (!running) return;
        interrupt(reason);
    }

    return {
        on,
        start,
        stop,
        primeTts,
        pushReply,
        flushReply,
        stopReply,
        interrupt,
        setActivity,
        beginTurn,
        endTurn,
        recoverIfDead,
        stripTimestamps,
        setAudioDevice,
        setTtsOptions,
        get running() { return running; },
        get state() { return currentState; },
        get activity() { return activityText; },
        get activityDesktop() { return activityDesktop; },
        get isPlayingTts() { return !!ttsPlayer?.playing; },
    };
}
