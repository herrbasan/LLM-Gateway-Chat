/**
 * TtsPlayer — sentence-at-a-time speech for an assistant reply.
 *
 * Playback is the window that matters for barge-in. Synthesis queues behind
 * generation, so the assistant keeps talking long after the server has gone back
 * to listening — and only the client knows when audio is still coming out of the
 * speaker. The server therefore cannot be the judge of "the assistant is still
 * speaking"; cutting playback is the application's job. This is that job.
 *
 * Feed it reply tokens as they stream. Each complete sentence is synthesized and
 * spoken, with the next one synthesized while the current one plays, so playback
 * runs continuously instead of pausing between sentences. `stop()` cuts the audio
 * immediately and drops everything not yet spoken — that is the barge-in.
 *
 * Synthesis is nSpeech (`POST /v1/audio/speech`). Zero dependencies.
 *
 * Playback does not go straight to an <audio> element. It runs through a local
 * WebRTC loopback, because Chromium's AEC takes its reference from WebRTC playout:
 * audio that never passes through it is not cancelled, and the mic keeps hearing
 * the assistant. The path is created once and kept open for the session — AEC is
 * adaptive and needs seconds to converge, so a fresh sink per sentence never gives
 * it a stable reference to learn. `prime()` builds it inside a user gesture, since
 * autoplay policy suspends an AudioContext created outside one.
 *
 * Usage:
 *   const tts = new TtsPlayer({ onEvent: e => ... });
 *   client.on('reply', d => tts.push(d.result.text));   // stream tokens
 *   client.on('phase', d => { if (d.phase === 'done') tts.flush(); });
 *   client.on('barge-in', () => tts.stop('keyword'));      // only interrupts
 *   client.on('duck', () => tts.duck());                    // sustained speech
 *   client.on('speech-end', () => setTimeout(() => tts.unduck(), 1000));
 *
 * Classic script: exposes `window.TtsPlayer` in the browser, exports for Node.
 */
class TtsPlayer {
    /**
     * @param {object} [opts]
     * @param {string} [opts.baseUrl='http://127.0.0.1:2233'] nSpeech base URL
     * @param {string} [opts.model='kokoro'] engine model
     * @param {string} [opts.voice='af_heart'] voice id
     * @param {number} [opts.speed=1.0]
     * @param {number} [opts.maxChars=180] split long sentences at this length
     * @param {number} [opts.bufferAhead=2] sentences to keep synthesized ahead
     * @param {boolean} [opts.enabled=true]
     * @param {(ev:object)=>void} [opts.onEvent] 'start' | 'end' | 'interrupted' | 'error'
     */
    constructor(opts = {}) {
        this.baseUrl = (opts.baseUrl || 'http://127.0.0.1:2233').replace(/\/+$/, '');
        this.model = opts.model || 'kokoro';
        this.voice = opts.voice || 'af_heart';
        this.speed = opts.speed ?? 1.0;
        this.maxChars = opts.maxChars || 180;
        this.bufferAhead = opts.bufferAhead || 2;
        this.enabled = opts.enabled !== false;
        this.loopback = opts.loopback !== false;   // route playback through WebRTC for AEC
        // Text cleaning, done by nSpeech (extra_body.clean): true = regex strip,
        // 'llm' = rewrite via the local gateway (better with emphasis/tables, but
        // adds gateway latency — the wrong trade for realtime speech), false = off.
        this.clean = opts.clean === undefined ? true : opts.clean;
        this.onEvent = opts.onEvent || (() => {});

        this._buffer = '';      // reply text not yet split into sentences
        this._queue = [];       // sentences awaiting synthesis
        this._ready = [];       // synthesized (ArrayBuffer + text), awaiting playback
        this._synthing = false;
        this._generation = 0;   // bumped by stop() so stale work is discarded
        this._runActive = false; // one 'start'/'end' pair per playback run
        this._muted = false;    // set by an interrupt; cleared by unmute()
        this._startedAt = null;
        this._duckLevel = 1;     // 1 = full volume; <1 while ducked (see duck())

        // One long-lived output path, created once. See _ensureAudio().
        this._readyPromise = null;  // AudioContext + loopback setup
        this._ctx = null;
        this._dest = null;
        this._gain = null;          // volume node — duck/unduck live here
        this._out = null;           // <audio> playing the loopback / destination stream
        this._pc1 = null;
        this._pc2 = null;
        this._source = null;        // playing AudioBufferSourceNode

        this.stats = { sentences: 0, spokenChars: 0, synthMs: 0, spokenMs: 0, interrupted: 0 };
    }

    /**
     * Build the output path now. Call inside a user gesture (a Start button
     * click): autoplay policy suspends an AudioContext created outside one, and
     * the reply that needs to play arrives seconds later with no gesture in sight.
     */
    prime() {
        if (!this.enabled) return;
        this._ensureAudio().catch(err => this.onEvent({ type: 'error', error: `audio init: ${err.message}` }));
    }

    /**
     * Feed reply tokens. Speaks each complete sentence as it lands.
     *
     * Each sentence is stripped of markdown before it is queued. That is not the
     * authoritative clean — nSpeech does that (see `this.clean`) — but splitting
     * happens here and markdown breaks it: an ordered-list marker like "1." is
     * indistinguishable from a sentence end. Cleaning each sentence also reduces
     * such a marker to nothing, which is why empty results are dropped rather than
     * queued to be spoken.
     */
    push(text) {
        if (!this.enabled || !text || this._muted) return;
        this._buffer += text;
        let sentence;
        while ((sentence = this._takeSentence())) {
            const clean = _ttsClean(sentence);
            if (clean) this._enqueue(clean);
        }
        this._schedule();
    }

    /** End of the reply — speak whatever is left over. */
    flush() {
        if (this._muted) { this._buffer = ''; return; }
        const rest = _ttsClean(this._buffer);
        this._buffer = '';
        if (rest) this._enqueue(rest);
        this._schedule();   // _enqueue only queues — without this the tail of the
    }                       // reply would sit in the queue and never be spoken

    /**
     * Cut playback now and drop everything not yet spoken.
     *
     * Mutes the rest of the reply as well. Cutting only the sentence in flight is not
     * an interrupt: the reply is still streaming, so the next tokens arrive, form a
     * sentence, and playback starts again — which reads as "it ignored me".
     * Call `unmute()` when the next turn begins.
     *
     * @param {string} [reason] why playback was cut (for the session record)
     * @param {object} [opts]
     * @param {boolean} [opts.mute=true] silence the remainder of this reply
     * @returns {{wasPlaying: boolean, dropped: number}}
     */
    stop(reason = 'stopped', { mute = true } = {}) {
        if (mute) this._muted = true;
        const wasPlaying = !!this._source;
        const dropped = this._queue.length + this._ready.length;
        const spokenMs = this._startedAt != null ? Date.now() - this._startedAt : 0;
        this._generation += 1;          // any in-flight synthesis is now stale
        this._buffer = '';
        this._queue = [];
        this._ready = [];
        this._stopSource();
        this._runActive = false;
        this._startedAt = null;
        if (wasPlaying || dropped) {
            this.stats.interrupted += 1;
            this.onEvent({ type: 'interrupted', reason, dropped, wasPlaying, spokenMs });
        }
        return { wasPlaying, dropped };
    }

    /** Allow speech again — call when a new turn starts. */
    unmute() {
        this._muted = false;
    }

    /**
     * Duck playback to `level` (0..1) without stopping it — the v2 answer to
     * voiced-but-not-interrupting audio during output (a cough fit, background
     * talking). Only a keyword or a gauntlet-surviving input may STOP playback;
     * sustained audio just lowers it so the user is acknowledged without the
     * reply being killable by noise. Smooth ~50ms ramp — no click.
     */
    duck(level = 0.5) {
        this._duckLevel = Math.max(0, Math.min(1, level));
        if (this._gain && this._ctx) {
            try { this._gain.gain.setTargetAtTime(this._duckLevel, this._ctx.currentTime, 0.05); } catch { /* context closed */ }
        }
        this.onEvent({ type: 'ducked', level: this._duckLevel });
    }

    /** Restore full volume after a duck. */
    unduck() {
        this.duck(1);
    }

    get playing() { return !!this._source; }
    get pending() { return this._queue.length + this._ready.length; }

    /** Live view for debugging — what the player is doing right now. */
    get state() {
        return {
            enabled: this.enabled,
            playing: !!this._source,
            muted: this._muted,
            duckLevel: this._duckLevel,
            queued: this._queue.length,
            ready: this._ready.length,
            synthing: this._synthing,
            bufferedChars: this._buffer.length,
            voice: this.voice,
            loopback: !this.loopback ? 'off' : (this._pc1 ? this._pc1.connectionState : 'not-started'),
            audioContext: this._ctx ? this._ctx.state : 'none',
            stats: { ...this.stats },
        };
    }

    // ── internals ───────────────────────────────────────────────────────────

    /** Pull one complete sentence out of the buffer, or null if not enough yet. */
    _takeSentence() {
        const m = this._buffer.match(/^\s*([\s\S]*?[.!?\u2026]+["')\]]*)(\s+|$)/);
        if (m && m[1].trim()) {
            this._buffer = this._buffer.slice(m[0].length);
            return m[1].trim();
        }
        // No terminator in sight — don't hold a long clause hostage to punctuation
        // that may never come (spoken replies often have none).
        if (this._buffer.length > this.maxChars) {
            const comma = this._buffer.lastIndexOf(',', this.maxChars);
            const space = this._buffer.lastIndexOf(' ', this.maxChars);
            const at = comma > 40 ? comma + 1 : (space > 40 ? space : this.maxChars);
            const head = this._buffer.slice(0, at).trim();
            this._buffer = this._buffer.slice(at);
            return head || null;
        }
        return null;
    }

    _enqueue(text) {
        if (!text) return;
        this._queue.push(text);
    }

    /** Play the next ready sentence, or make sure synthesis is running. */
    _schedule() {
        if (!this.enabled || this._muted) return;
        if (this._source) return;                // 'onended' will call back
        const item = this._ready.shift();
        if (item) { this._play(item); return; }
        if (this._queue.length) this._synthesize();
    }

    /** Keep `bufferAhead` sentences synthesized so playback does not gap. */
    async _synthesize() {
        if (this._synthing || !this._queue.length) return;
        this._synthing = true;
        const generation = this._generation;
        try {
            while (this._queue.length && this._ready.length < this.bufferAhead) {
                const text = this._queue.shift();
                const startedAt = Date.now();
                const res = await fetch(`${this.baseUrl}/v1/audio/speech`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        model: this.model,
                        input: text,
                        voice: this.voice,
                        response_format: 'mp3',
                        speed: this.speed,
                        ...(this.clean ? { extra_body: { clean: this.clean } } : {}),
                    }),
                });
                if (generation !== this._generation) return;   // stopped meanwhile
                if (!res.ok) throw new Error(`nSpeech ${res.status}: ${(await res.text()).slice(0, 120)}`);
                const blob = await res.blob();
                if (generation !== this._generation) return;
                const data = await blob.arrayBuffer();
                if (generation !== this._generation) return;
                this.stats.synthMs += Date.now() - startedAt;
                this.stats.sentences += 1;
                this.stats.spokenChars += text.length;
                this._ready.push({ data, text });
                // Start speaking the moment the first sentence exists — do not sit
                // through the whole look-ahead buffer first. (Re-entrant _synthesize
                // is a no-op here because _synthing is still set.)
                if (!this._source) this._schedule();
            }
        } catch (e) {
            this.onEvent({ type: 'error', error: String(e?.message || e) });
            return;
        } finally {
            this._synthing = false;
        }
        this._schedule();
    }

    _play(item) {
        if (this._muted) return;
        const generation = this._generation;
        this._ensureAudio()
            .then(() => this._startSource(item, generation))
            .catch(err => {
                this.onEvent({ type: 'error', error: `playback: ${err.message}` });
                this._schedule();
            });
    }

    /**
     * Create the output path once and keep it for the whole session.
     *
     * Chromium's AEC takes its reference from WebRTC playout, so audio that never
     * passes through it is not cancelled and the mic keeps hearing the assistant.
     * The reference also has to be *stable* — AEC is adaptive and needs seconds to
     * converge — so one long-lived path is the point, not a new sink per sentence.
     */
    _ensureAudio() {
        if (this._readyPromise) return this._readyPromise;
        this._readyPromise = (async () => {
            const ctx = new AudioContext();
            const dest = ctx.createMediaStreamDestination();
            const gain = ctx.createGain();
            gain.gain.value = this._duckLevel;   // if ducked before init, stay ducked
            gain.connect(dest);
            this._ctx = ctx;
            this._dest = dest;
            this._gain = gain;
            const out = new Audio();
            out.autoplay = true;
            this._out = out;

            if (!this.loopback) {
                out.srcObject = dest.stream;
                await out.play();
                return;
            }

            // Local WebRTC loopback: our audio goes in one peer and comes back out
            // of the other as a MediaStream, which is what makes Chromium treat it
            // as playout — and therefore as something AEC will cancel.
            const pc1 = new RTCPeerConnection();
            const pc2 = new RTCPeerConnection();
            pc1.onicecandidate = (e) => { if (e.candidate) pc2.addIceCandidate(e.candidate).catch(() => {}); };
            pc2.onicecandidate = (e) => { if (e.candidate) pc1.addIceCandidate(e.candidate).catch(() => {}); };
            pc2.ontrack = (e) => { out.srcObject = e.streams[0]; };
            for (const track of dest.stream.getAudioTracks()) pc1.addTrack(track, dest.stream);
            const offer = await pc1.createOffer();
            await pc1.setLocalDescription(offer);
            await pc2.setRemoteDescription(offer);
            const answer = await pc2.createAnswer();
            await pc2.setLocalDescription(answer);
            await pc1.setRemoteDescription(answer);
            this._pc1 = pc1;
            this._pc2 = pc2;
            await out.play();
        })().catch(err => {
            this._readyPromise = null;   // allow a retry rather than failing forever
            throw err;
        });
        return this._readyPromise;
    }

    async _startSource({ data, text }, generation) {
        // decodeAudioData detaches its input, so hand it a copy.
        const buffer = await this._ctx.decodeAudioData(data.slice(0));
        // An interrupt during the decode means this sentence is already obsolete.
        // Without this the play pipeline resumed after the user said stop — the
        // queue was cleared, but work already inside the pipeline still completed.
        // Every await in here needs the same check, not just the queue.
        if (this._muted || generation !== this._generation) return;
        if (!this._ctx) throw new Error('audio context gone');
        const src = this._ctx.createBufferSource();
        src.buffer = buffer;
        src.connect(this._gain);   // through the duck/unduck gain node
        this._source = src;
        const playStartedAt = Date.now();
        if (!this._runActive) {
            // One 'start' per playback run, not per sentence.
            this._runActive = true;
            this._startedAt = playStartedAt;
            this.onEvent({ type: 'start', voice: this.voice, text });
        }
        src.onended = () => {
            if (this._source !== src) return;   // superseded by stop()
            this._source = null;
            this.stats.spokenMs += Date.now() - playStartedAt;
            try { src.disconnect(); } catch { /* already detached */ }
            this._schedule();
            if (!this._source && !this.pending) {
                this._runActive = false;
                this._startedAt = null;
                this.onEvent({ type: 'end', stats: { ...this.stats } });
            }
        };
        src.start();
        // Keep the buffer full while this one plays.
        if (this._queue.length && this._ready.length < this.bufferAhead) this._synthesize();
    }

    /** Cut the current sentence. The output path itself stays open. */
    _stopSource() {
        const src = this._source;
        this._source = null;
        if (!src) return;
        try {
            src.onended = null;
            src.stop();
            src.disconnect();
        } catch { /* already stopped */ }
    }
}

/**
 * Strip markdown so the model does not read punctuation aloud.
 *
 * Shapes the text for our own sentence splitting; nSpeech cleans again on arrival
 * (`extra_body.clean`, see `this.clean`), where it is authoritative — it also
 * handles emphasis, tables and HTML that this does not.
 */
function _ttsClean(text) {
    return String(text || '')
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/`([^`]*)`/g, '$1')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/\*([^*]+)\*/g, '$1')
        .replace(/^\s{0,3}#{1,6}\s+/gm, '')
        .replace(/^\s*[-*+]\s+/gm, '')
        .replace(/^\s*\d+[.)]\s+/gm, '')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/\s+/g, ' ')
        .trim();
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { TtsPlayer, _ttsClean };
} else if (typeof window !== 'undefined') {
    window.TtsPlayer = TtsPlayer;
}
