// ------------------------------------------------------------------ //
// Kimi command matcher — LOCAL, no gateway.                           //
//                                                                     //
// The command vocabulary is fixed and tiny: listen / stop / send. An  //
// LLM is not needed to understand it (and would only see parakeet's   //
// output anyway). Parakeet auto-detects language and often drifts to  //
// Russian on a single short word; Russian borrowed "стоп" (stop), so  //
// Cyrillic→Latin normalization makes the misdetected forms match the  //
// English words. Word-boundary matching rejects false hits            //
// ("stopwatch" ≠ "stop").                                             //
// ------------------------------------------------------------------ //
const _KIMI_CYR_TO_LAT = {
    'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ё': 'e',
    'ж': 'zh', 'з': 'z', 'и': 'i', 'й': 'i', 'к': 'k', 'л': 'l', 'м': 'm',
    'н': 'n', 'о': 'o', 'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'у': 'u',
    'ф': 'f', 'х': 'h', 'ц': 'ts', 'ч': 'ch', 'ш': 'sh', 'щ': 'shch',
    'ъ': '', 'ы': 'y', 'ь': '', 'э': 'e', 'ю': 'yu', 'я': 'ya',
};

// Match priority: stop > send > listen ("stop listening" must stop, not listen).
const _KIMI_COMMAND_PHRASES = [
    ['stop',   ['stop', 'stopp', 'stoppen', 'halt']],
    ['send',   ['send', 'sende', 'zend', 'sen']],
    ['listen', ['listen', 'listening', 'lissin', 'listun']],
];

function _kimiNormalize(raw) {
    let out = '';
    for (const ch of String(raw || '').toLowerCase()) {
        const c = _KIMI_CYR_TO_LAT[ch];
        if (c !== undefined) out += c;
        else if (/[a-z0-9]/.test(ch)) out += ch;
        else out += ' ';  // punctuation/space → separator
    }
    return out.replace(/\s+/g, ' ').trim();
}

/**
 * Match a raw STT command utterance to one of the fixed commands.
 * Returns 'listen' | 'stop' | 'send' | null (null = not a command).
 */
function _kimiMatchCommand(text) {
    const norm = _kimiNormalize(text);
    if (!norm) return null;
    for (const [action, phrases] of _KIMI_COMMAND_PHRASES) {
        for (const p of phrases) {
            const np = _kimiNormalize(p);
            const re = new RegExp('\\b' + np.replace(/\s+/g, '\\s+') + '\\b');
            if (re.test(norm)) return action;
        }
    }
    return null;
}

class nVoiceClient {
    constructor(config = {}) {
        this.serverUrl = config.serverUrl || '';
        // R1: basePath allows the SDK to run behind a same-origin relay
        // (chat app /api/stt/*). All request URLs derive from serverUrl+basePath.
        this.basePath = (config.basePath || '').replace(/\/+$/, '');
        this.audioDeviceId = config.audioDeviceId || null;
        this.rawAudio = config.rawAudio || false;
        // R4: force browser AEC/NS/AGC on every platform (assistant mode plays
        // TTS with the mic open — without AEC the assistant transcribes itself).
        this.audioProcessing = config.audioProcessing || false;
        this.engine = config.engine || null;
        this.recordDebug = config.recordDebug || false;  // worker captures engine-received audio
        this.assistantEnabled = config.assistantEnabled || false;  // opt into LLM post-processing

        // R2: raw transcript buffer — every non-command final, in speak order.
        this._rawFinals = '';

        this.ws = null;             // local realtime WebSocket (browser → Node → worker)
        this.audioStream = null;
        this._streamNode = null;    // AudioWorkletNode feeding PCM frames to this.ws
        this._streamContext = null; // AudioContext for _streamNode

        // VAD state (Silero V4 legacy model from vad-web)
        // Model inputs:  input[1,N], sr[int64], h[2,1,64], c[2,1,64]
        // Model outputs: output[1,1], hn[2,1,64], cn[2,1,64]
        this.wakeWordEnabled = false;
        this.isAwake = true;
        this.wwSession = null;
        this.wwH = null;
        this.wwC = null;
        this.wwSr = null;
        this.audioContext = null;
        this.workletNode = null;
        this._vadChain = Promise.resolve();

        // Auto-sleep: after a final transcript, count consecutive silence frames
        // 1536 samples @ 16kHz = 96ms/frame, so ~31 frames = ~3s silence
        this._finalReceived = false;
        this._silenceCount = 0;
        this._silenceFramesToSleep = 31;
        this._silenceThreshold = 0.3;

        // Kimi-mode state machine (Phase 4). After "ok kimi" wakes the client it
        // captures the NEXT utterance as a command and matches it LOCALLY
        // (no gateway): "listen" → transcribing | "stop" → sleep+discard |
        // "send" → sleep+submit | anything else → ignore.
        //   sleep        → "ok kimi" → command (capture one utterance → match)
        //   command      → listen → transcribing | stop → sleep | send → sleep+submit
        //   transcribing → "ok kimi" (interrupt) → command (capture stop/send)
        // The kimi WS is always listening, so "ok kimi" interrupts transcription.
        // NOTE: the wake detector can false-fire on speech-like audio during
        // dictation (~11% adversarial FA). When that happens the captured
        // "command" matches NO command word — which means it was dictation, not
        // a command. We then RESUME transcribing instead of responding (see
        // _kimiInterruptedTranscribing).
        this._kimiState = 'sleep';          // sleep | command | transcribing
        this._kimiCommandText = '';         // current command utterance (raw STT)
        this._kimiCommandFinal = false;     // a final landed for the current command
        this._kimiDictationText = '';       // accumulated dictation (for send)
        this._kimiIdleCount = 0;            // idle/silence telemetry beats since last final
        this._kimiIdleToClassify = 3;       // idle beats before classifying the command
        this._kimiClassifying = false;      // re-entrancy guard for async classify
        this._kimiInterruptedTranscribing = false;  // wake came mid-dictation
        this._kimiCommandTimer = null;      // command-state timeout (self-heal false wakes)

        // Wake-on-voice: require SUSTAINED speech to wake (rejects fan/ambient noise)
        this._wakeThreshold = 0.5;   // per-frame Silero prob to count toward wake
        this._wakeFrames = 3;        // consecutive frames needed to wake (~96ms)
        this._wakeCount = 0;

        // Endpointing (hang-up): close the gate after sustained non-speech so the
        // backend goes idle. Per industry research (Pipecat turn-stop strategy):
        // the countdown resets ONLY on confident speech (prob >= reset threshold),
        // so a noise burst's decay tail (mid prob) counts toward hang-up instead of
        // resetting it. Window ~2s (research's 1.5–3.0s dictation guidance).
        this._hangupResetProb = 0.5;  // prob >= this = confident speech → reset countdown
        this._hangupFrames = 20;      // ~20 × 96ms ≈ 2s of non-confident-speech → close
        this._hangupCount = 0;

        // Recording: capture the exact 16kHz frames the pipeline sends (post-worklet)
        this._recording = false;
        this._recordedChunks = [];

        // Assistant layer: segment store + action handlers
        this.segments = [];
        this._actions = {};

        this.listeners = {};
    }

    /**
     * R1: one derivation for every request URL.
     * httpBase — for fetch() calls (session, cleanup).
     * wsBase  — protocol+host part for WebSocket URLs.
     * serverUrl set → derive ws proto from it; serverUrl '' (same-origin,
     * possibly behind a relay) → derive from window.location.
     */
    _apiBase() {
        const bp = this.basePath;
        if (this.serverUrl) {
            const wsProto = this.serverUrl.startsWith('https') ? 'wss:'
                : this.serverUrl.startsWith('http') ? 'ws:' : null;
            if (!wsProto) throw new Error(`serverUrl must start with http:// or https:// (got "${this.serverUrl}")`);
            let host = this.serverUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '');
            return { httpBase: this.serverUrl + bp, wsBase: `${wsProto}//${host}${bp}` };
        }
        const proto = (window.location.protocol === 'https:') ? 'wss:' : 'ws:';
        return { httpBase: bp, wsBase: `${proto}//${window.location.host}${bp}` };
    }

    /**
     * R2: the accumulated raw transcript (every non-command final in speak
     * order). Reset with clearRawText(). The dictation flow cleans this on Done.
     */
    getRawText() {
        return this._rawFinals.trim();
    }

    clearRawText() {
        this._rawFinals = '';
    }

    /**
     * R2: one-shot LLM cleanup via POST /v1/audio/cleanup.
     * Fail-loud: throws on HTTP errors — the app shows the error and keeps
     * the raw text. Returns the cleaned string.
     */
    async cleanup(text, mode = 'clean') {
        const trimmed = (text || '').trim();
        if (!trimmed) throw new Error('cleanup: text required');
        const { httpBase } = this._apiBase();
        const resp = await fetch(`${httpBase}/v1/audio/cleanup`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: trimmed, mode }),
        });
        if (!resp.ok) {
            let msg = `cleanup failed: HTTP ${resp.status}`;
            try { const j = await resp.json(); if (j?.error?.message) msg += ` — ${j.error.message}`; } catch {}
            throw new Error(msg);
        }
        const data = await resp.json();
        if (typeof data.text !== 'string') throw new Error('cleanup: malformed response (missing text)');
        return data.text;
    }

    /**
     * Start/stop capturing the pipeline's 16kHz mono frames into a buffer.
     * These are the SAME frames sent to the backend — post-worklet, post any
     * browser processing — so a recording reflects exactly what the STT hears.
     */
    startRecording() {
        this._recordedChunks = [];
        this._recording = true;
    }

    stopRecording() {
        this._recording = false;
    }

    get isRecording() { return this._recording; }

    /**
     * Build a WAV (16kHz mono PCM16) blob from the recorded frames.
     */
    recordingToWavBlob() {
        const chunks = this._recordedChunks;
        const total = chunks.reduce((n, c) => n + c.length, 0);
        const pcm = new Float32Array(total);
        let off = 0;
        for (const c of chunks) { pcm.set(c, off); off += c.length; }

        // float32 [-1,1] → int16 PCM
        const pcm16 = new Int16Array(total);
        for (let i = 0; i < total; i++) {
            const s = Math.max(-1, Math.min(1, pcm[i]));
            pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }

        const sampleRate = 16000, numCh = 1, bytesPerSample = 2;
        const dataLen = pcm16.length * bytesPerSample;
        const buf = new ArrayBuffer(44 + dataLen);
        const v = new DataView(buf);
        const wstr = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
        wstr(0, 'RIFF'); v.setUint32(4, 36 + dataLen, true); wstr(8, 'WAVE');
        wstr(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
        v.setUint16(22, numCh, true); v.setUint32(24, sampleRate, true);
        v.setUint32(28, sampleRate * numCh * bytesPerSample, true);
        v.setUint16(32, numCh * bytesPerSample, true); v.setUint16(34, 16, true);
        wstr(36, 'data'); v.setUint32(40, dataLen, true);
        new Int16Array(buf, 44).set(pcm16);
        return new Blob([buf], { type: 'audio/wav' });
    }

    on(event, callback) {
        if (!this.listeners[event]) this.listeners[event] = [];
        this.listeners[event].push(callback);
    }

    off(event, callback) {
        if (!this.listeners[event]) return;
        this.listeners[event] = this.listeners[event].filter(cb => cb !== callback);
    }

    emit(event, data) {
        if (this.listeners[event]) this.listeners[event].forEach(cb => cb(data));
    }

    // --- Assistant layer (LLM-powered transcription post-processing) ---

    /**
     * Segment store — tracks all transcript segments (raw + corrected).
     * Segments are non-destructive: removed segments stay in the array
     * with status "removed" for undo support.
     *
     * Segment shape:
     *   { id, raw, text, status: "active"|"removed", paragraph_break, timestamp }
     */
    // this.segments = [];     // initialized in constructor
    // this._actions = {};     // registered action handlers

    /**
     * Register a custom action handler.
     * When the LLM detects the spoken phrase, the SDK emits 'action' and calls the handler.
     *
     * @param {string} id - Action id (must match the id registered server-side)
     * @param {Function} handler - Called with { action, phrase, segment_id }
     */
    registerAction(id, handler) {
        if (!this._actions) this._actions = {};
        this._actions[id] = handler;
    }

    /**
     * Get the current "settled" transcript — all active segments' cleaned text,
     * joined with appropriate spacing and paragraph breaks.
     *
     * @returns {string}
     */
    getTranscript() {
        if (!this.segments) return '';
        return this.segments
            .filter(s => s.status === 'active')
            .map(s => s.text)
            .join(s => s.paragraph_break ? '\n\n' : ' ');
    }

    /**
     * Handle an assistant event from the server.
     * Dispatches to the appropriate handler based on type.
     */
    _handleAssistantEvent(data) {
        if (!this.segments) this.segments = [];

        if (data.type === 'cleanup' || data.type === 'paragraph') {
            if (data.type === 'paragraph') {
                // Server measured a long pause — record it so the dictation handed
                // to "kimi stop/send" cleanup carries paragraph structure.
                this._kimiDictationText = (this._kimiDictationText.replace(/\s+$/, '') + '\n\n').trimStart();
            }
            // Pause-triggered cleanup + paragraph-break notice \u2014 no segment
            // bookkeeping, just relay to the page.
            this.emit('assistant', data);

        } else if (data.type === 'correction' || data.type === 'passthrough') {
            // Add a new segment with cleaned text
            const segment = {
                id: data.segment_id,
                raw: data.original,
                text: data.text,
                status: 'active',
                paragraph_break: false,
                timestamp: Date.now(),
            };
            this.segments.push(segment);
            this.emit('assistant', { ...data, segment });

        } else if (data.type === 'command') {
            // Built-in transcript manipulation commands
            const cmd = data.command;
            if (cmd === 'delete_last_sentence' || cmd === 'undo') {
                // Mark the last active segment as removed (non-destructive)
                for (let i = this.segments.length - 1; i >= 0; i--) {
                    if (this.segments[i].status === 'active') {
                        this.segments[i].status = 'removed';
                        break;
                    }
                }
            } else if (cmd === 'delete_last_paragraph') {
                // Remove segments back to the last paragraph break
                for (let i = this.segments.length - 1; i >= 0; i--) {
                    if (this.segments[i].status === 'active') {
                        this.segments[i].status = 'removed';
                        if (this.segments[i].paragraph_break) break;
                    }
                }
            } else if (cmd === 'paragraph_break') {
                // Mark the last active segment as ending a paragraph
                for (let i = this.segments.length - 1; i >= 0; i--) {
                    if (this.segments[i].status === 'active') {
                        this.segments[i].paragraph_break = true;
                        break;
                    }
                }
            }
            this.emit('command', { command: cmd, original: data.original, segment_id: data.segment_id });

        } else if (data.type === 'action') {
            // Custom action — emit event and call registered handler
            const actionEvent = { action: data.action, original: data.original, segment_id: data.segment_id };
            this.emit('action', actionEvent);
            if (this._actions && this._actions[data.action]) {
                this._actions[data.action](actionEvent);
            }
        }
    }

    setAudioDevice(deviceId) {
        this.audioDeviceId = deviceId;
    }

    async enableWakeWord(modelUrl) {
        if (typeof ort === 'undefined') {
            throw new Error("onnxruntime-web is not loaded.");
        }

        this.emit('telemetry', { state: 'Loading ONNX model...', rtf: 0, backlog_sec: 0 });

        // ORT resolves WASM paths relative to the ort.js script URL.
        // Since ort.js is served from /sdk/ort.js, it will find /sdk/ort-wasm-*.wasm.
        // No need to set wasmPaths explicitly — just ensure the files are there.
        console.log('[VAD] ORT version:', ort.env.version || 'unknown');

        console.log('[VAD] Loading ONNX model from', modelUrl);

        // Match vad-web: fetch to ArrayBuffer first, then create session from buffer
        const modelResponse = await fetch(modelUrl);
        const modelBuffer = await modelResponse.arrayBuffer();
        console.log('[VAD] Model loaded, size=', modelBuffer.byteLength, 'bytes');
        this.wwSession = await ort.InferenceSession.create(modelBuffer, {
            executionProviders: ['wasm'],
            graphOptimizationLevel: 'all',
        });
        console.log('[VAD] ORT session created, inputs:', this.wwSession.inputNames, 'outputs:', this.wwSession.outputNames);

        // Silero V4 legacy: h/c [2, 1, 64] float32 zeros
        this.wwH = new ort.Tensor('float32', new Float32Array(2 * 64), [2, 1, 64]);
        this.wwC = new ort.Tensor('float32', new Float32Array(2 * 64), [2, 1, 64]);
        // Use BigInt constructor for broader compatibility (not literal syntax)
        this.wwSr = new ort.Tensor('int64', [BigInt(16000)], []);

        this.wakeWordEnabled = true;
        this.isAwake = false;

        this.emit('telemetry', { state: 'ONNX model loaded', rtf: 0, backlog_sec: 0 });
    }

    /**
     * Enable "ok kimi" wake mode via the worker-side acoustic detector.
     *
     * Instead of the browser running Silero VAD locally, the client streams the
     * raw 16kHz frames to the worker's /v1/wakeword/ws detector (which runs the
     * trained kimi_wake model). The worker emits {type:"wake"} when "ok kimi"
     * crosses threshold; the client then wakes and captures the next utterance.
     *
     * Must be called before start(). Disables local VAD wake (if any).
     */
    async enableKimiWakeWord() {
        this.kimiWakeEnabled = true;
        this.wakeWordEnabled = true;
        this.isAwake = false;
        this._finalReceived = false;
        this._kimiState = 'sleep';
        this._kimiCommandText = '';
        this._kimiCommandFinal = false;
        this._kimiDictationText = '';
        this._kimiIdleCount = 0;
        this._kimiClassifying = false;
        this._kimiInterruptedTranscribing = false;
        this._kimiCommandTimer = null;

        const model = this.engine ? `?model=${encodeURIComponent(this.engine)}` : '';
        const { wsBase } = this._apiBase();
        this._kimiWs = new WebSocket(`${wsBase}/v1/wakeword/ws${model}${model ? '&' : '?'}telemetry=1`);

        this._kimiWs.onmessage = (event) => {
            let evt;
            try { evt = JSON.parse(event.data); } catch { return; }
            if (evt.type === 'wake') {
                console.log('[Kimi] wake detected, score=' + evt.score);
                this._onKimiWake();
            } else if (evt.type === 'score') {
                // throttled diagnostic so we can see live detector liveness
                this._kimiDiagCount = (this._kimiDiagCount || 0) + 1;
                if (this._kimiDiagCount % 30 === 0) {
                    console.log('[Kimi] score=' + evt.score);
                }
            }
        };
        this._kimiWs.onerror = (e) => {
            console.error('[Kimi] wake-word WS error', e);
            // Fall back to "always awake" so the loop isn't dead.
            if (!this.isAwake) { this.isAwake = true; this.emit('wakeWordDetected'); }
        };
        this._kimiWs.onclose = () => {
            console.log('[Kimi] wake-word WS closed');
            this._kimiWs = null;
        };

        console.log('[Kimi] kimi wake mode armed (worker detector)');
    }

    /**
     * Build an AudioWorklet that downsamples the mic to 16kHz mono float32
     * frames and forwards each frame to the realtime WebSocket. Gated by
     * isAwake — when asleep (wake-word mode), frames are produced but dropped,
     * so no audio leaves the browser until the wake word fires.
     */
    async _setupStreamingWorklet() {
        // Local ctx — never read the shared field across an await; overlapping
        // setup calls would otherwise cross-contaminate contexts.
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        this._streamContext = ctx;
        const nativeSr = ctx.sampleRate;
        const targetSr = 16000;
        const frameSize = 512; // 32ms @ 16kHz
        const source = ctx.createMediaStreamSource(this.audioStream);

        const workletCode = `
        class StreamProcessor extends AudioWorkletProcessor {
            constructor() {
                super();
                this.nativeSr = ${nativeSr};
                this.targetSr = ${targetSr};
                this.frameSize = ${frameSize};
                this.inputBuffer = [];
            }
            _hasEnoughData() {
                return (this.inputBuffer.length * this.targetSr) / this.nativeSr >= this.frameSize;
            }
            _generateFrame() {
                const frame = new Float32Array(this.frameSize);
                let outIdx = 0, inIdx = 0;
                while (outIdx < this.frameSize) {
                    let sum = 0, num = 0;
                    const boundary = ((outIdx + 1) * this.nativeSr) / this.targetSr;
                    const limit = Math.min(this.inputBuffer.length, boundary);
                    while (inIdx < limit) {
                        const val = this.inputBuffer[inIdx];
                        if (val !== undefined) { sum += val; num++; }
                        inIdx++;
                    }
                    frame[outIdx] = sum / num;
                    outIdx++;
                }
                this.inputBuffer = this.inputBuffer.slice(inIdx);
                return frame;
            }
            process(inputs) {
                const input = inputs[0];
                if (!input || input.length === 0) return true;
                const channelData = input[0];
                if (!channelData || channelData.length === 0) return true;
                for (let i = 0; i < channelData.length; i++) {
                    this.inputBuffer.push(channelData[i]);
                    while (this._hasEnoughData()) {
                        const frame = this._generateFrame();
                        this.port.postMessage({ audio: frame.buffer }, [frame.buffer]);
                    }
                }
                return true;
            }
        }
        registerProcessor('stream-processor', StreamProcessor);
        `;

        const blob = new Blob([workletCode], { type: 'application/javascript' });
        const workletUrl = URL.createObjectURL(blob);
        await ctx.audioWorklet.addModule(workletUrl);

        this._streamNode = new AudioWorkletNode(ctx, 'stream-processor');
        this._preWakeBuffer = [];      // frames received while asleep
        this._preWakeMaxFrames = 10;   // ~320ms at 32ms/frame
        this._streamNode.port.onmessage = (event) => {
            const frame = event.data.audio;  // ArrayBuffer of float32 16kHz

            // Kimi wake mode: the wake-word detector (worker) needs ALL audio,
            // asleep or awake — it decides when "ok kimi" was spoken.
            if (this.kimiWakeEnabled && this._kimiWs && this._kimiWs.readyState === WebSocket.OPEN) {
                try { this._kimiWs.send(frame); } catch (e) { /* ignore */ }
            }

            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
            if (!this.isAwake) {
                // Asleep: buffer frame for retroactive send on wake.
                // This prevents the first word from being clipped by the
                // wake detection delay.
                this._preWakeBuffer.push(frame);
                if (this._preWakeBuffer.length > this._preWakeMaxFrames) {
                    this._preWakeBuffer.shift();
                }
                return;
            }
            this.ws.send(frame);                             // ArrayBuffer of float32
        };

        source.connect(this._streamNode);
        const silentGain = ctx.createGain();
        silentGain.gain.value = 0;
        this._streamNode.connect(silentGain);
        silentGain.connect(ctx.destination);
    }

    async _setupAudioWorklet() {
        // Local ctx — never read the shared field across an await; overlapping
        // setup calls would otherwise cross-contaminate contexts.
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        this.audioContext = ctx;

        // iOS Safari: AudioContext starts suspended, must be resumed after user gesture
        if (ctx.state === 'suspended') {
            console.log('[VAD] AudioContext suspended, resuming...');
            try {
                await ctx.resume();
            } catch (e) {
                console.warn('[VAD] Could not resume AudioContext:', e);
            }
        }

        const nativeSr = ctx.sampleRate;
        const targetSr = 16000;
        const frameSize = 1536;

        const source = ctx.createMediaStreamSource(this.audioStream);

        // Exact vad-web resampler algorithm ported into AudioWorklet
        const workletCode = `
        class VADProcessor extends AudioWorkletProcessor {
            constructor() {
                super();
                this.nativeSr = ${nativeSr};
                this.targetSr = ${targetSr};
                this.frameSize = ${frameSize};
                this.inputBuffer = [];
                this._fc = 0;
            }

            _hasEnoughData() {
                return (this.inputBuffer.length * this.targetSr) / this.nativeSr >= this.frameSize;
            }

            _generateFrame() {
                const frame = new Float32Array(this.frameSize);
                let outIdx = 0;
                let inIdx = 0;

                while (outIdx < this.frameSize) {
                    let sum = 0;
                    let num = 0;
                    const boundary = ((outIdx + 1) * this.nativeSr) / this.targetSr;
                    const limit = Math.min(this.inputBuffer.length, boundary);
                    while (inIdx < limit) {
                        const val = this.inputBuffer[inIdx];
                        if (val !== undefined) {
                            sum += val;
                            num++;
                        }
                        inIdx++;
                    }
                    frame[outIdx] = sum / num;
                    outIdx++;
                }

                this.inputBuffer = this.inputBuffer.slice(inIdx);
                return frame;
            }

            process(inputs) {
                const input = inputs[0];
                if (!input || input.length === 0) return true;
                const channelData = input[0];
                if (!channelData || channelData.length === 0) return true;

                for (let i = 0; i < channelData.length; i++) {
                    this.inputBuffer.push(channelData[i]);

                    while (this._hasEnoughData()) {
                        const frame = this._generateFrame();
                        this._fc++;
                        this.port.postMessage({ audio: frame.buffer, fc: this._fc }, [frame.buffer]);
                    }
                }

                return true;
            }
        }
        registerProcessor('vad-processor', VADProcessor);
        `;

        const blob = new Blob([workletCode], { type: 'application/javascript' });
        const workletUrl = URL.createObjectURL(blob);
        await ctx.audioWorklet.addModule(workletUrl);

        this.workletNode = new AudioWorkletNode(ctx, 'vad-processor');
        console.log('[VAD] AudioWorklet registered. nativeSr=' + nativeSr + ' targetSr=' + targetSr + ' frameSize=' + frameSize);

        this.workletNode.port.onmessage = (event) => {
            const audio = new Float32Array(event.data.audio);
            this._vadChain = this._vadChain.then(() => this._processVAD(audio, event.data.fc)).catch(console.error);
        };

        source.connect(this.workletNode);

        const silentGain = ctx.createGain();
        silentGain.gain.value = 0;
        this.workletNode.connect(silentGain);
        silentGain.connect(ctx.destination);
    }

    async _processVAD(audioFrame, fc) {
        if (!this.wakeWordEnabled || !this.wwSession) return;
        if (this.kimiWakeEnabled) return;  // kimi mode: wake decided by worker detector

        try {
            const inputTensor = new ort.Tensor('float32', audioFrame, [1, audioFrame.length]);

            const feeds = {
                input: inputTensor,
                h: this.wwH,
                c: this.wwC,
                sr: this.wwSr
            };

            const results = await this.wwSession.run(feeds);

            this.wwH = results.hn;
            this.wwC = results.cn;

            const prob = results.output.data[0];

            // Throttled diagnostic: log VAD liveness + prob every ~3s so we can
            // tell "VAD dead" apart from "VAD alive but prob never crosses threshold".
            this._vadDiagCount = (this._vadDiagCount || 0) + 1;
            if (this._vadDiagCount % 32 === 0) {
                console.log(`[VAD] alive=${this.isAwake ? 'awake' : 'asleep'} prob=${prob.toFixed(3)} fc=${fc}`);
            }

            if (!this.isAwake) {
                // ASLEEP: require SUSTAINED speech to wake. A single frame above
                // threshold is too easy to trip on amplified fan/ambient noise
                // (AGC-free mics still push broadband noise over 0.5 on isolated
                // frames). Speech sustains high prob across consecutive frames;
                // noise is spiky. 3 frames ≈ 96ms of sustained speech — responsive
                // to voice, immune to transient noise.
                if (prob > this._wakeThreshold) {
                    this._wakeCount = (this._wakeCount || 0) + 1;
                    if (this._wakeCount >= this._wakeFrames) {
                        console.log('[VAD] WAKE (sustained prob=' + prob.toFixed(3) + ', frames=' + this._wakeCount + ')');
                        this.wake();
                    }
                } else {
                    this._wakeCount = 0;
                }
            } else {
                // AWAKE: hang up on sustained non-speech (endpointing).
                // Design per industry VAD/turn-stop research (Pipecat et al.):
                // the countdown resets ONLY on CONFIDENT speech (prob >= wake
                // threshold), NOT on the mid-prob decay tail of a noise burst.
                // A scrape peaks ~0.5s then decays 0.47→0.04 — only that brief
                // peak counts as speech; the whole decay tail counts toward hang-up.
                // A real conversational pause ends with confident resumed speech,
                // which resets the timer. ~20 frames × 96ms ≈ 2s (research's
                // 1.5–3.0s guidance for dictation pause tolerance).
                if (prob >= this._hangupResetProb) {
                    this._hangupCount = 0;
                } else {
                    this._hangupCount = (this._hangupCount || 0) + 1;
                    if (this._hangupCount >= this._hangupFrames) {
                        console.log('[VAD] HANG-UP (sustained non-speech, frames=' + this._hangupCount + ')');
                        this.sleep();
                    }
                }
            }
            // Note: endpointing (sentence-final commit) is the BACKEND strategy's
            // job (commit_silence_tail_sec). This browser hang-up only decides when
            // to STOP SENDING audio so the backend goes idle. Two separate concerns.
        } catch (e) {
            console.error('[VAD] Inference error:', e);
        }
    }

    wake() {
        if (!this.wakeWordEnabled || this.isAwake) return;

        this.isAwake = true;
        this._finalReceived = false;
        this._silenceCount = 0;
        this._hangupCount = 0;   // fresh endpointing window on wake

        // Flush pre-wake buffer: send the last ~320ms of audio that was
        // captured during the wake detection delay. This recovers the
        // first word that would otherwise be clipped.
        if (this._preWakeBuffer && this._preWakeBuffer.length > 0) {
            console.log('[VAD] Flushing pre-wake buffer:', this._preWakeBuffer.length, 'frames');
            for (const frame of this._preWakeBuffer) {
                if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                    this.ws.send(frame);
                }
            }
            this._preWakeBuffer = [];
        }

        this.emit('wakeWordDetected');
    }

    sleep() {
        if (!this.wakeWordEnabled || !this.isAwake) return;

        this.isAwake = false;
        this._finalReceived = false;
        this._silenceCount = 0;
        this._wakeCount = 0;   // reset sustained-wake counter for next listen cycle
        this._hangupCount = 0; // reset endpointing counter

        this.wwH = new ort.Tensor('float32', new Float32Array(2 * 64), [2, 1, 64]);
        this.wwC = new ort.Tensor('float32', new Float32Array(2 * 64), [2, 1, 64]);

        // Frames stop flowing to the WebSocket while asleep.
        this.emit('asleep');
    }

    // --- Kimi state machine (Phase 4) --------------------------------------
    // States: sleep → command → transcribing (loop back to sleep or command).
    //   sleep        : listening for "ok kimi". On wake → command.
    //   command      : capturing the next utterance to classify (listen/stop/
    //                  send/other). On final + idle → classify → dispatch.
    //   transcribing : continuous dictation. On "ok kimi" (interrupt) → command
    //                  to capture stop/send.
    //
    // Events emitted to the host app:
    //   kimiState    {state}                     — sleep|command|transcribing
    //   kimiCommand  {action, text}              — a classified command action
    //   kimiDictation {text}                     — accumulated dictation text
    //   assistantState {state}                   — R3: listening|capturing|processing
    //   assistantMessage {raw, text}             — R3: one deliverable per capture
    //   assistantCancel {reason}                 — R3: capture discarded
    //   assistantError {error, raw}              — R3: cleanup failed (raw still delivered)

    _onKimiWake() {
        // R3 assistant mode: wake from listening goes STRAIGHT to capturing —
        // no "listen" gate (autoListen). A wake during capture falls through
        // to the interrupt path below (end/cancel command capture).
        if (this.assistantMode && this._kimiState === 'sleep' && this._assistantAutoListen) {
            console.log('[Assistant] wake → capturing');
            this._assistantStartCapture();
            return;
        }
        // "ok kimi" heard. From sleep → capture a command; from transcribing →
        // interrupt to capture a stop/send command. Already capturing a command?
        // Ignore (don't double-capture).
        if (this._kimiState === 'command') return;
        const wasTranscribing = this._kimiState === 'transcribing';
        this._kimiState = 'command';
        this._kimiCommandText = '';
        this._kimiCommandFinal = false;
        this._kimiIdleCount = 0;
        this._kimiInterruptedTranscribing = wasTranscribing;
        if (!this.isAwake) {
            this.wake();
        }
        console.log('[Kimi] -> command' + (wasTranscribing ? ' (interrupting transcription)' : ''));
        this.emit('kimiState', { state: 'command' });
        this._armKimiCommandTimeout();
    }

    /**
     * Called from the STT transcript handler when a final transcript lands.
     * Routes the text depending on kimi state:
     *   command      → accumulate as the command utterance
     *   transcribing → accumulate as dictation
     */
    _kimiOnFinal(text) {
        // Returns true when the final was consumed as a COMMAND utterance (it
        // must then be suppressed from the transcript — control words are not
        // dictation). Returns false for dictation/ignored finals.
        if (this._kimiState === 'command') {
            this._kimiCommandText = (this._kimiCommandText + ' ' + text).trim();
            this._kimiCommandFinal = true;
            this._kimiIdleCount = 0;
            this.emit('kimiCommandText', { text: this._kimiCommandText });
            // NOTE: the command timeout stays armed as a safety net — if idle
            // telemetry never arrives (so classify never fires), the timeout
            // force-classifies or restores the dictation instead of wedging the
            // client in command state.
            return true;
        }
        // R3: wake-word residue suppression at capture start (see below).
        // NOTE: bare end commands ("stop" with no "ok kimi") are NOT honored in
        // assistant mode — short content utterances ("...eventually say stop")
        // are indistinguishable from commands. End commands are wake-gated:
        // "ok kimi send" / "ok kimi stop" / "ok kimi cancel" only.
        if (this.assistantMode && this._kimiState === 'transcribing') {
            if (this._assistantIsWakeResidue(text)) {
                console.log('[Assistant] wake residue suppressed: "' + text + '"');
                return true;  // consumed, not dictation
            }
        }
        // Acoustic wake missed — the STT still transcribed the command phrase, so
        // recognize it from text ("ok kimi listen/send/stop", or a bare short
        // command). This is what makes the flow work when the wake detector
        // fails to fire on the live voice ("3 attempts" symptom).
        if (this.assistantMode) {
            // Assistant mode: the wake token alone ("okay kimi", ≤3 words) opens
            // a command window — the actual command word typically arrives as
            // the NEXT final after a pause. Complete commands ("ok kimi send")
            // fall through to the normal text-command path below.
            const normOnly = _kimiNormalize(text);
            const wakeOnly = /\b(kimi|kimmy|kyumi)\b/.test(normOnly)
                && normOnly.split(' ').filter(Boolean).length <= 3
                && !/\b(send|sende|stop|stopp|halt|listen|cancel|abort|abbrechen|forget|never)\b/.test(normOnly);
            if (wakeOnly && this._kimiState === 'sleep') {
                console.log('[Kimi] text-wake (command word pending): "' + text + '"');
                this._kimiState = 'command';
                this._kimiCommandText = '';
                this._kimiCommandFinal = false;
                this._kimiIdleCount = 0;
                this._kimiInterruptedTranscribing = false;
                this.emit('kimiState', { state: 'command' });
                this._armKimiCommandTimeout();
                return true;
            }
        }
        if (this._kimiShouldTreatAsCommand(text)) {
            const wasTranscribing = this._kimiState === 'transcribing';
            this._kimiState = 'command';
            this._kimiCommandText = text;
            this._kimiCommandFinal = true;
            this._kimiIdleCount = 0;
            this._kimiInterruptedTranscribing = wasTranscribing;
            console.log('[Kimi] text-command (wake missed): "' + text + '"');
            this.emit('kimiState', { state: 'command' });
            this.emit('kimiCommandText', { text });
            this._armKimiCommandTimeout();  // safety net if telemetry never arrives
            return true;
        }
        if (this._kimiState === 'transcribing') {
            this._kimiDictationText = (this._kimiDictationText + ' ' + text).trim();
            this._kimiIdleCount = 0;
            this.emit('kimiDictation', { text: this._kimiDictationText });
            return false;
        }
        // Assistant mode: 'sleep' (= listening) is QUIET. The mic stays open
        // (the wake detector needs the stream), but speech between commands
        // is neither emitted nor accumulated — capture starts on "listen".
        // The wake-missed text fallback above still runs first, so a spoken
        // "ok kimi listen" lands even without an acoustic wake.
        if (this.assistantMode && this._kimiState === 'sleep') {
            return true;  // consumed — not transcript, not raw buffer
        }
        return false;
    }

    // ── R3: Assistant mode (chat-app hands-free wrapper) ──────────────
    // Flow: "ok kimi" → immediately capturing → end command → internal
    // cleanup → ONE assistantMessage {raw, text}. Cancel vocabulary →
    // assistantCancel. Thin layer over the kimi machine: listening = kimi
    // 'sleep', capturing = kimi 'transcribing' (entered directly on wake),
    // processing = cleanup in flight. Mic stays open throughout (keep-awake
    // policy) — the wakeword WS keeps feeding the detector.

    async enableAssistantMode({ endCommands = null, stopCommands = null, cancelCommands = null, cleanup = 'clean', autoListen = false } = {}) {
        this.assistantMode = true;
        this._assistantCleanupMode = cleanup;   // 'clean'|'format'|'compact'|false
        this._assistantAutoListen = autoListen;
        // End-vocabulary split: send-words deliver, stop-words HOLD (nothing
        // sent — "ok kimi stop" is the "wait, don't send yet" escape).
        this._assistantSendPhrases = endCommands ?? ['send', 'sende', 'send it', 'abschicken'];
        this._assistantStopPhrases = stopCommands ?? ['stop', 'stopp', 'stoppen', 'halt'];
        this._assistantCancelPhrases = cancelCommands ?? ['cancel', 'abort', 'never mind', 'forget it', 'abbrechen', 'vergiss es'];
        this._assistantHeldText = null;   // set when a capture was stopped (held, unsent)
        // R4: assistant mode plays TTS with the mic open — AEC is not optional.
        this.audioProcessing = true;
        await this.enableKimiWakeWord();
        this.emit('assistantState', { state: this._assistantHeldText ? 'held' : 'listening' });
    }

    /**
     * R3: leave assistant mode. Discards held text, closes the wake-word
     * session, restores plain-dictation behavior (finals emit + accumulate
     * again). The mic/realtime connection is untouched — stop() and
     * disconnect() remain the controls for that layer.
     */
    disableAssistantMode() {
        if (!this.assistantMode) return;
        this.assistantMode = false;
        this._assistantHeldText = null;
        this._assistantCaptureAt = null;
        this._clearKimiCommandTimeout();
        this._kimiState = 'sleep';
        this._kimiDictationText = '';
        if (this._kimiWs) {
            try { this._kimiWs.close(); } catch {}
            this._kimiWs = null;
        }
        this.kimiWakeEnabled = false;
        this.emit('assistantState', { state: 'disabled' });
        this.emit('kimiState', { state: 'sleep' });
        console.log('[Assistant] mode disabled');
    }

    _assistantMatchPhrase(text, phrases) {
        const norm = _kimiNormalize(text);
        if (!norm) return false;
        return phrases.some((p) => {
            const np = _kimiNormalize(p);
            return np && new RegExp('(^|\\s)' + np.replace(/\s+/g, '\\s+') + '(\\s|$)').test(norm);
        });
    }

    _assistantStartCapture() {
        this._kimiState = 'transcribing';
        this._kimiDictationText = '';
        this._kimiIdleCount = 0;
        this._kimiInterruptedTranscribing = false;
        if (!this.isAwake) this.wake();
        // Wake fires MID-phrase: the tail of "ok kimi" can land as the first
        // dictation final ("Me.", "kimi"). Suppress a short wake-ish final
        // arriving right after capture opens (see _kimiOnFinal).
        this._assistantCaptureAt = Date.now();
        this.emit('assistantState', { state: 'capturing' });
        this.emit('kimiState', { state: 'transcribing' });
    }

    // Is this final wake-word residue? Only plausible in the first second of a
    // capture, only if short, only if it reads like the wake phrase tail.
    _assistantIsWakeResidue(text) {
        if (!this._assistantCaptureAt) return false;
        if (Date.now() - this._assistantCaptureAt > 1000) return false;
        const norm = _kimiNormalize(text);
        const words = norm.split(' ').filter(Boolean);
        if (words.length > 2) return false;
        return words.every((w) => /^(ok|okay|kimi|kimmy|kyumi|me|hey|hi|ja|yes)$/.test(w));
    }

    async _assistantEnd(action) {
        const raw = (this._kimiDictationText || '').trim();
        if (action === 'send' && !raw && !this._assistantHeldText) {
            // nothing to send at all
            this._kimiState = 'sleep';
            this.emit('assistantCancel', { reason: 'empty' });
            this.emit('assistantState', { state: this._assistantHeldText ? 'held' : 'listening' });
            return;
        }
        if (action === 'stop') {
            // HOLD: keep the text, send nothing. "ok kimi stop" = wait, don't
            // send yet. From held, "ok kimi send" delivers it.
            this._kimiState = 'sleep';
            this._kimiInterruptedTranscribing = false;
            this._clearKimiCommandTimeout();
            if (raw) this._assistantHeldText = raw;
            this._kimiDictationText = '';
            this.emit('assistantHold', { text: this._assistantHeldText });
            this.emit('assistantState', { state: 'held' });
            this.emit('kimiState', { state: 'sleep' });
            return;
        }
        if (action === 'cancel') {
            this._kimiState = 'sleep';
            this._kimiInterruptedTranscribing = false;
            this._clearKimiCommandTimeout();
            this._kimiDictationText = '';
            this._assistantHeldText = null;   // cancel discards held text too
            this.emit('assistantCancel', { reason: 'cancel' });
            this.emit('assistantState', { state: 'listening' });
            this.emit('kimiState', { state: 'sleep' });
            return;
        }
        // 'send': deliver current capture, or the held text if capture is empty
        const toSend = raw || this._assistantHeldText;
        this._kimiState = 'sleep';
        this._kimiInterruptedTranscribing = false;
        this._clearKimiCommandTimeout();
        this._kimiDictationText = '';
        this._assistantHeldText = null;
        this.emit('assistantState', { state: 'processing' });
        let text = toSend;
        if (this._assistantCleanupMode !== false) {
            try {
                text = await this.cleanup(toSend, this._assistantCleanupMode);
            } catch (err) {
                // Fail-loud but still deliver: the app shows the error and gets raw.
                this.emit('assistantError', { error: err.message, raw: toSend });
                text = toSend;
            }
        }
        this.emit('assistantMessage', { raw: toSend, text });
        this.emit('assistantState', { state: 'listening' });
        this.emit('kimiState', { state: 'sleep' });
    }

    // A final that wasn't captured in `command` state (acoustic wake missed) can
    // still be a command. Heuristic: it matches a command word AND is either a
    // bare short command (<= 2 words, e.g. "send", "и сен") or carries a wake
    // token ("kimi"/"kimmy"/"кюми"). Longer dictation like "i listen to music"
    // or "eventually i will stop it" is left as dictation.
    // ASSISTANT MODE: bare commands are disabled — the wake token is REQUIRED,
    // because short content ("...say stop" landing as its own final) would
    // otherwise end the capture.
    _kimiShouldTreatAsCommand(text) {
        if (!_kimiMatchCommand(text)) return false;
        const norm = _kimiNormalize(text);
        const words = norm.split(' ').filter(Boolean).length;
        if (this.assistantMode) {
            return /\b(kimi|kimmy|kyumi)\b/.test(norm);  // wake token required
        }
        if (words === 1) return true;  // bare single-word command ("stop", "listen")
        return /\b(kimi|kimmy|kyumi)\b/.test(norm);  // carries a wake token
    }

    _clearKimiCommandTimeout() {
        if (this._kimiCommandTimer) { clearTimeout(this._kimiCommandTimer); this._kimiCommandTimer = null; }
    }

    _armKimiCommandTimeout() {
        this._clearKimiCommandTimeout();
        this._kimiCommandTimer = setTimeout(() => {
            this._kimiCommandTimer = null;
            if (this._kimiState !== 'command') return;
            // A final was captured but classify never fired (no idle telemetry) —
            // force-classify now so a command isn't stuck and the flow continues.
            if (this._kimiCommandFinal) { this._kimiClassifyCommand(); return; }
            if (this._kimiInterruptedTranscribing) {
                // False wake with no command captured — resume transcribing and
                // re-surface any text swallowed into the command capture so it
                // does NOT vanish from the transcript panel.
                const t = (this._kimiCommandText || '').trim();
                if (t) {
                    this._kimiDictationText = (this._kimiDictationText + ' ' + t).trim();
                    this.emit('kimiDictation', { text: this._kimiDictationText });
                    this.emit('transcript', { type: 'transcript', text: t + ' ', is_final: true });
                }
                this._kimiState = 'transcribing';
                this._kimiIdleCount = 0;
                this._kimiInterruptedTranscribing = false;
                this.emit('kimiState', { state: 'transcribing' });
                if (this.assistantMode) this.emit('assistantState', { state: 'capturing' });
            } else {
                this._kimiToSleep('command timeout');
            }
        }, 4000);
    }

    /**
     * Telemetry-driven state progression. In `command` state, after the first
     * final lands and the backend reports idle/silence (utterance fully
     * committed), classify the command and dispatch. In `transcribing` state
     * idle/silence is ignored (dictation continues until interrupted).
     */
    _kimiHandleTelemetry(data) {
        if (!this.kimiWakeEnabled || !this.isAwake) return;

        if (this._kimiState === 'command') {
            if (this._kimiCommandFinal && data.state === 'idle/silence') {
                this._kimiIdleCount = (this._kimiIdleCount || 0) + 1;
                if (this._kimiIdleCount >= this._kimiIdleToClassify) {
                    this._kimiClassifyCommand();
                }
            }
        }
    }

    /**
     * Match the captured command LOCALLY (no gateway) and dispatch.
     */
    async _kimiClassifyCommand() {
        if (this._kimiState !== 'command' || this._kimiClassifying) return;
        this._kimiClassifying = true;
        try {
            const text = this._kimiCommandText.trim();
            if (!text) { this._kimiToSleep('no command captured'); return; }

            console.log('[Kimi] classifying command: "' + text + '"');
            const action = _kimiMatchCommand(text);  // 'listen' | 'stop' | 'send' | null
            console.log('[Kimi] command action=' + (action || 'none') +
                        (this._kimiInterruptedTranscribing ? ' (interrupted transcription)' : ''));

            // R3 assistant mode: cancel vocabulary ends the capture discarded.
            // Checked BEFORE the false-wake restore — a cancel word after wake
            // is deliberate, not dictation.
            if (this.assistantMode && this._assistantMatchPhrase(text, this._assistantCancelPhrases)) {
                this._assistantEnd('cancel');
                return;
            }

            // A wake that interrupted transcription is only honored for real
            // commands. No match = false wake (it was dictation) → resume
            // transcribing, don't respond, don't lose the dictation.
            if (action === null && this._kimiInterruptedTranscribing) {
                // Put the captured text back into the dictation (it wasn't a command)
                // AND re-surface it in the raw transcript — a false wake must NOT
                // make dictation vanish from the panel.
                if (text) {
                    this._kimiDictationText = (this._kimiDictationText + ' ' + text).trim();
                    this.emit('kimiDictation', { text: this._kimiDictationText });
                    this.emit('transcript', { type: 'transcript', text: text + ' ', is_final: true });
                    console.log('[Kimi] false wake — dictation restored: "' + text + '"');
                }
                this._kimiState = 'transcribing';
                this._kimiIdleCount = 0;
                this._kimiInterruptedTranscribing = false;
                this.emit('kimiState', { state: 'transcribing' });
                if (this.assistantMode) this.emit('assistantState', { state: 'capturing' });
                return;
            }

            // Not a command and nothing was being dictated — silently return to
            // sleep. No gateway call, no response.
            if (action === null) { this._kimiToSleep('not a command'); return; }

            switch (action) {
                case 'listen':
                    if (this.assistantMode) {
                        // Fresh capture cycle. Any HELD text is discarded — the
                        // user chose to start over instead of sending it.
                        this._assistantHeldText = null;
                        this._assistantStartCapture();
                        break;
                    }
                    this._kimiState = 'transcribing';
                    this._kimiIdleCount = 0;
                    this._kimiInterruptedTranscribing = false;
                    // Fresh dictation cycle — clear the previous session's
                    // accumulated text and tell the server to reset its
                    // segmented-cleanup state, so the new transcript starts
                    // clean instead of appending to the last one.
                    this._kimiDictationText = '';
                    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                        this.ws.send(JSON.stringify({ type: 'assistant_reset' }));
                    }
                    this.emit('kimiState', { state: 'transcribing' });
                    this.emit('kimiCommand', { action: 'listen', text });
                    break;
                case 'stop':
                    if (this.assistantMode) {
                        // "ok kimi stop": HOLD the capture — nothing is sent.
                        this._assistantEnd('stop');
                        break;
                    }
                    // Stop transcribing. The dictation is KEPT and handed to the
                    // page for LLM cleanup ("ok kimi stop" flow) — not discarded.
                    this._kimiState = 'sleep';
                    this._kimiInterruptedTranscribing = false;
                    this.emit('kimiCommand', { action: 'stop', text, dictation: this._kimiDictationText });
                    this.sleep();
                    break;
                case 'send':
                    if (this.assistantMode) {
                        // "ok kimi send": deliver current capture (or held text).
                        this._assistantEnd('send');
                        break;
                    }
                    this._kimiState = 'sleep';
                    this._kimiInterruptedTranscribing = false;
                    this.emit('kimiCommand', { action: 'send', text, dictation: this._kimiDictationText });
                    this.sleep();
                    break;
            }
        } finally {
            this._kimiClassifying = false;
            this._clearKimiCommandTimeout();
        }
    }

    _kimiToSleep(reason) {
        console.log('[Kimi] -> sleep (' + reason + ')');
        this._clearKimiCommandTimeout();
        this._kimiState = 'sleep';
        this._kimiCommandText = '';
        this._kimiCommandFinal = false;
        this._kimiIdleCount = 0;
        this.emit('kimiState', { state: 'sleep' });
        // Assistant mode: unsent held text survives; the visible state is
        // 'held', not 'listening'.
        if (this.assistantMode) {
            this.emit('assistantState', { state: this._assistantHeldText ? 'held' : 'listening' });
        }
        // Keep the mic open — do NOT call this.sleep(). The keep-awake
        // policy says once awake, stay awake. If the STT final arrives
        // late (after timeout), _kimiOnFinal's text-command fallback
        // will still pick up "ok kimi listen" and re-enter the loop
        // instead of the user having to repeat themselves.
    }

    async start() {
        // Guard against overlapping/duplicate start() calls. A second concurrent
        // start races on the shared AudioContext fields, leaving the worklet
        // unregistered ("vad-processor is not defined") and the UI stuck.
        if (this._starting) return;
        if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
        this._starting = true;
        try {
            console.log('[nVoice] start() called, wakeWordEnabled=' + this.wakeWordEnabled);

            // Audio constraints: phones need AGC/noiseSuppression because the mic
            // is far from the mouth. Desktop with a good mic benefits from raw audio.
            // User can override with the "Raw Audio" toggle.
            const isMobile = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
            // R4: audioProcessing forces AEC/NS/AGC on any platform (assistant
            // mode needs it — TTS plays with the mic open). rawAudio still wins
            // only when the user explicitly toggles it.
            const useProcessing = this.audioProcessing || (this.rawAudio ? false : isMobile);

            const constraints = {
                audio: {
                    echoCancellation: useProcessing,
                    noiseSuppression: useProcessing,
                    autoGainControl: useProcessing,
                }
            };

            console.log('[nVoice] Audio constraints:', JSON.stringify(constraints.audio), '(mobile=' + isMobile + ', rawOverride=' + !!this.rawAudio + ')');

            if (this.audioDeviceId && this.audioDeviceId !== 'default') {
                constraints.audio.deviceId = { exact: this.audioDeviceId };
            }

            this.audioStream = await navigator.mediaDevices.getUserMedia(constraints);

            if (this.wakeWordEnabled) {
                this.isAwake = false;
                this._finalReceived = false;
                this._silenceCount = 0;
                if (this.kimiWakeEnabled) {
                    // Kimi mode: no local Silero VAD — the worker detector drives
                    // wake. The stream worklet (set up below after the session)
                    // routes frames to /v1/wakeword/ws.
                } else {
                    this.wwH = new ort.Tensor('float32', new Float32Array(2 * 64), [2, 1, 64]);
                    this.wwC = new ort.Tensor('float32', new Float32Array(2 * 64), [2, 1, 64]);
                    await this._setupAudioWorklet();
                }
            } else {
                this.isAwake = true;
            }

            // Local engines: realtime audio over WebSocket (browser → Node → worker).
            // Cloud engines: handled separately via their own WebSocket flow below.
            console.log('[nVoice] Creating realtime session... (engine=' + (this.engine || 'default') + ')');
            const { httpBase } = this._apiBase();
            const sessionUrl = this.engine
                ? `${httpBase}/v1/realtime/sessions?model=${encodeURIComponent(this.engine)}`
                : `${httpBase}/v1/realtime/sessions`;
            const sessionResp = await fetch(sessionUrl);
            if (!sessionResp.ok) {
                throw new Error('Failed to create realtime session: ' + sessionResp.status);
            }
            const session = await sessionResp.json();
            this._sessionId = session.id;
            console.log('[nVoice] Session created: ' + session.id);

            // Cloud engines use WebSocket directly to the provider — no local worker
            if (session.cloud) {
                console.log('[nVoice] Cloud engine detected (' + session.provider + '), using WebSocket flow');
                await this._startCloudRealtime(session, this.audioStream);
                return;
            }

            // Build the streaming worklet that feeds PCM frames to the socket.
            await this._setupStreamingWorklet();

            // Open the realtime WebSocket (ws on http, wss on https).
            // recordDebug → worker captures engine-received audio to a WAV (output/).
            const { wsBase } = this._apiBase();
            let wsUrl = `${wsBase}${session.ws_endpoint}`;
            if (this.recordDebug) {
                wsUrl += (wsUrl.includes('?') ? '&' : '?') + 'record=1';
            }
            if (this.assistantEnabled) {
                wsUrl += (wsUrl.includes('?') ? '&' : '?') + 'assistant=1';
            }
            console.log('[nVoice] Connecting realtime WebSocket: ' + wsUrl);
            this.ws = new WebSocket(wsUrl);

            this.ws.onopen = () => {
                console.log('[nVoice] Realtime WebSocket open');
                // The socket is connected regardless of wake/sleep state.
                // Emit 'connected' (enables Stop), then signal asleep if wake-word is armed.
                this.emit('connected');
                if (this.wakeWordEnabled && !this.isAwake) {
                    this.emit('asleep');
                }
            };

            this.ws.onmessage = async (event) => {
                // Accept both text and binary frames. The Node relay may send
                // JSON as either depending on the ws library's frame type detection.
                let text;
                if (typeof event.data === 'string') {
                    text = event.data;
                } else if (event.data instanceof Blob) {
                    text = await event.data.text();
                } else if (event.data instanceof ArrayBuffer) {
                    text = new TextDecoder().decode(event.data);
                } else {
                    return;
                }
                try {
                    const data = JSON.parse(text);
                    if (data.type === 'transcript') {
                        if (this.wakeWordEnabled && data.is_final) {
                            this._finalReceived = true;
                        }
                        // Route finals into the kimi state machine (command capture
                        // or dictation accumulation). Command utterances are CONTROL
                        // words ("ok kimi listen/stop/send") — they must NOT appear
                        // in the transcript. Emit an empty final reset so consumers
                        // clear any lingering provisional tail.
                        if (this.kimiWakeEnabled && data.is_final && data.text) {
                            const consumedAsCommand = this._kimiOnFinal(data.text);
                            if (consumedAsCommand) {
                                this.emit('transcript', { type: 'transcript', text: '', is_final: true, is_command: true });
                                return;
                            }
                        }
                        // R2: accumulate every non-command final into the raw buffer
                        if (data.is_final && data.text && data.text.trim()) {
                            this._rawFinals = (this._rawFinals + ' ' + data.text.trim()).trim();
                        }
                        // Suppress provisionals while a REAL command is being captured
                        // (a wake from sleep). A false-wake interrupt is still
                        // dictation, so its provisionals stay visible.
                        // Assistant mode: also quiet in 'sleep' (listening) —
                        // nothing previews until "listen" starts the capture.
                        const quietState = (this._kimiState === 'command' && !this._kimiInterruptedTranscribing)
                            || (this.assistantMode && this._kimiState === 'sleep');
                        if (this.kimiWakeEnabled && !data.is_final && quietState) {
                            return;
                        }
                        this.emit('transcript', data);
                    } else if (data.type === 'assistant') {
                        this._handleAssistantEvent(data.result || data);
                    } else if (data.type === 'telemetry') {
                        this.emit('telemetry', data);
                        this._kimiHandleTelemetry(data);
                    }
                } catch (e) {
                    this.emit('error', new Error('Failed to parse realtime message: ' + e.message));
                }
            };

            this.ws.onerror = (err) => {
                console.error('[nVoice] Realtime WebSocket error', err);
                this.emit('error', new Error('Realtime WebSocket error'));
            };

            this.ws.onclose = () => {
                console.log('[nVoice] Realtime WebSocket closed');
                this.emit('disconnected');
            };

        } catch (error) {
            this._starting = false;
            this.emit('error', error);
            throw error;
        }
        this._starting = false;
    }

    /**
     * Cloud realtime: connect directly to the provider via WebSocket.
     * The browser captures mic audio, converts to PCM 16kHz, and sends as base64 chunks.
     * Transcript events are received via the WebSocket and emitted as normal events.
     */
    async _startCloudRealtime(session, audioStream) {
        const { httpBase } = this._apiBase();

        // 1. Fetch a single-use token from our server
        const tokenUrl = `${httpBase}${session.token_endpoint}?model=${encodeURIComponent(session.model)}`;
        console.log('[nVoice] Fetching cloud token from', tokenUrl);
        const tokenResp = await fetch(tokenUrl);
        if (!tokenResp.ok) {
            throw new Error('Failed to fetch cloud token: ' + tokenResp.status);
        }
        const tokenData = await tokenResp.json();
        const token = tokenData.token;
        console.log('[nVoice] Cloud token received');

        // 2. Connect to ElevenLabs WebSocket
        const wsParams = new URLSearchParams({
            model_id: 'scribe_v2_realtime',
            token,
            include_timestamps: 'true',
            commit_strategy: 'vad',
            vad_silence_threshold_secs: '1.5',
            vad_threshold: '0.4',
        });
        this._cloudExpectTimestamps = true;
        const wsUrl = `wss://api.elevenlabs.io/v1/speech-to-text/realtime?${wsParams}`;
        console.log('[nVoice] Connecting to ElevenLabs WebSocket...');

        this._cloudWs = new WebSocket(wsUrl);

        // 3. Set up audio capture → PCM 16kHz → base64 chunks
        this._cloudAudioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
        const source = this._cloudAudioContext.createMediaStreamSource(audioStream);

        // Use ScriptProcessorNode for broad compatibility (AudioWorklet is complex for this use case)
        const bufferSize = 4096;
        this._cloudProcessor = this._cloudAudioContext.createScriptProcessor(bufferSize, 1, 1);

        this._cloudProcessor.onaudioprocess = (e) => {
            if (!this._cloudWs || this._cloudWs.readyState !== WebSocket.OPEN) return;

            const inputData = e.inputBuffer.getChannelData(0);
            // Convert float32 [-1, 1] to int16 PCM
            const pcm16 = new Int16Array(inputData.length);
            for (let i = 0; i < inputData.length; i++) {
                const sample = Math.max(-1, Math.min(1, inputData[i]));
                pcm16[i] = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
            }

            // Send as base64 chunk
            const bytes = new Uint8Array(pcm16.buffer);
            let binary = '';
            for (let i = 0; i < bytes.length; i++) {
                binary += String.fromCharCode(bytes[i]);
            }
            const base64 = btoa(binary);

            this._cloudWs.send(JSON.stringify({
                message_type: 'input_audio_chunk',
                audio_base_64: base64,
                commit: false,
                sample_rate: 16000,
            }));
        };

        source.connect(this._cloudProcessor);
        // ScriptProcessorNode must connect to destination to work (even if silent)
        const silentGain = this._cloudAudioContext.createGain();
        silentGain.gain.value = 0;
        this._cloudProcessor.connect(silentGain);
        silentGain.connect(this._cloudAudioContext.destination);

        // 4. Handle WebSocket events
        this._cloudWs.onopen = () => {
            console.log('[nVoice] ElevenLabs WebSocket connected, starting audio capture');
        };

        this._cloudWs.onmessage = (event) => {
            try {
                const msg = JSON.parse(event.data);

                switch (msg.message_type) {
                    case 'session_started':
                        console.log('[nVoice] ElevenLabs session started:', msg.session_id);
                        this.emit('connected');
                        break;

                    case 'partial_transcript':
                        if (msg.text) {
                            this.emit('transcript', { text: msg.text, is_final: false });
                        }
                        break;

                    case 'committed_transcript':
                        // Skip — committed_transcript_with_timestamps will fire next
                        // with the same text plus word data. Only emit if timestamps
                        // are disabled (in which case this is the only committed event).
                        if (!this._cloudExpectTimestamps && msg.text) {
                            if (this.wakeWordEnabled) {
                                this._finalReceived = true;
                            }
                            this.emit('transcript', { text: msg.text, is_final: true });
                        }
                        break;

                    case 'committed_transcript_with_timestamps':
                        if (msg.text) {
                            if (this.wakeWordEnabled) {
                                this._finalReceived = true;
                            }
                            this.emit('transcript', { text: msg.text, is_final: true });
                        }
                        break;

                    case 'error':
                    case 'input_error':
                        console.error('[nVoice] ElevenLabs error:', msg);
                        this.emit('error', new Error('ElevenLabs: ' + (msg.error || JSON.stringify(msg))));
                        break;
                }
            } catch (e) {
                console.error('[nVoice] Failed to parse WebSocket message:', e);
            }
        };

        this._cloudWs.onerror = (error) => {
            console.error('[nVoice] ElevenLabs WebSocket error:', error);
            this.emit('error', new Error('ElevenLabs WebSocket error'));
        };

        this._cloudWs.onclose = () => {
            console.log('[nVoice] ElevenLabs WebSocket closed');
            this.emit('disconnected');
        };
    }

    _stopCloudRealtime() {
        if (this._cloudProcessor) {
            this._cloudProcessor.disconnect();
            this._cloudProcessor = null;
        }
        if (this._cloudAudioContext) {
            this._cloudAudioContext.close();
            this._cloudAudioContext = null;
        }
        if (this._cloudWs) {
            if (this._cloudWs.readyState === WebSocket.OPEN || this._cloudWs.readyState === WebSocket.CONNECTING) {
                this._cloudWs.close();
            }
            this._cloudWs = null;
        }
    }

    stop() {
        // Clean up cloud realtime if active
        this._stopCloudRealtime();

        // Stop the streaming worklet (mic → WebSocket)
        if (this._streamNode) {
            this._streamNode.disconnect();
            this._streamNode = null;
        }
        if (this._streamContext) {
            this._streamContext.close();
            this._streamContext = null;
        }

        if (this.audioStream) {
            this.audioStream.getTracks().forEach(track => track.stop());
            this.audioStream = null;
        }

        if (this.audioContext) {
            this.audioContext.close();
            this.audioContext = null;
        }

        this.emit('standby');
    }

    disconnect() {
        this.stop();

        if (this._kimiWs) {
            if (this._kimiWs.readyState === WebSocket.OPEN || this._kimiWs.readyState === WebSocket.CONNECTING) {
                this._kimiWs.close();
            }
            this._kimiWs = null;
        }
        this.kimiWakeEnabled = false;

        if (this.ws) {
            if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
                this.ws.close();
            }
            this.ws = null;
        }

        this.emit('disconnected');
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { nVoiceClient };
} else if (typeof window !== 'undefined') {
    window.nVoiceClient = nVoiceClient;
}
