// ============================================
// NSpeechController — Shared TTS controller for chat + arena
// ============================================
//
// Talks to nSpeech V3 (OpenAI-compatible API):
//   POST /v1/audio/speech  { model, input, voice, response_format, speed, ... }
//   GET  /v1/voices?engine=<name>
//
// Replaces the legacy /tts?text=...&voice_name=... GET endpoint.
//
// One controller serves both apps:
//   - chat   → voiceCount: 1 (single voice)
//   - arena  → voiceCount: 2 (voice A / voice B per speaker)
//
// Voices are engine-scoped. The controller groups them and exposes a flat
// select whose options are prefixed with the engine name. The selected
// voice's engine is sent as the `model` field so nSpeech routes correctly.
//
// All UI wiring is optional — pass the DOM elements you have. State is
// persisted via the injected `storage` adapter (storage.getPref / setPref)
// plus localStorage for the endpoint.

const DEFAULT_ENDPOINT = 'http://localhost:2233';
const DEFAULT_MODEL = 'nspeech';        // dashboard-selected local engine
const DEFAULT_FORMAT = 'mp3';
const DEFAULT_SPEED = 1.0;
const VOICE_FETCH_TIMEOUT_MS = 6000;

// Voice selection is shared across both apps via this pref key, so changing
// the voice in chat also changes it in arena (and vice versa). Arena's A/B
// voices use separate keys.
const PREF_VOICE = 'tts-voice';
const PREF_VOICE_A = 'arena-tts-voice-a';
const PREF_PREF_VOICE_B = 'arena-tts-voice-b';
const PREF_SPEED = 'tts-speed';
const PREF_ARENA_SPEED = 'arena-tts-speed';
const LS_ENDPOINT = 'tts-endpoint';

// ============================================
// Helpers
// ============================================

function endpointFromStorage() {
    return localStorage.getItem(LS_ENDPOINT) || '';
}

function voiceLabel(v) {
    const name = v.name || v.voice_id || String(v);
    const engine = v.engine ? `[${v.engine}] ` : '';
    const cat = v.voice_type && v.voice_type !== 'builtin' ? ` (${v.voice_type})` : '';
    return `${engine}${name}${cat}`;
}

function voiceValue(v) {
    // Engine-qualified value so we can recover the engine on selection.
    // Format: "engine:voice_id". If engine missing, bare voice_id.
    const id = v.voice_id || v.name || String(v);
    const engine = v.engine || '';
    return engine ? `${engine}:${id}` : id;
}

function parseVoiceValue(value) {
    if (!value) return { engine: null, voiceId: null };
    const idx = value.indexOf(':');
    if (idx === -1) return { engine: null, voiceId: value };
    return { engine: value.slice(0, idx), voiceId: value.slice(idx + 1) };
}

// ============================================
// Controller
// ============================================

export class NSpeechController {
    /**
     * @param {object} opts
     * @param {number} [opts.voiceCount=1]  1 for chat, 2 for arena (A/B)
     * @param {string} [opts.defaultModel='nspeech']
     * @param {string} [opts.prefKeyVoice]   override pref key for the (single) voice
     * @param {string} [opts.prefKeySpeed]   override pref key for speed
     * @param {object} storage               storage adapter with getPref/setPref (Promise-returning)
     * @param {object} elements              DOM elements:
     *   - endpoint:        nui-input wrapping <input>
     *   - voiceSelect:     nui-select (voiceCount=1)
     *   - voiceASelect:    nui-select (voiceCount=2)
     *   - voiceBSelect:    nui-select (voiceCount=2)
     *   - speed:           nui-input wrapping <input>
     *   - status:          element for status messages
     * @param {object} [serverDefaults]
     *   - endpoint, voice, speed  (from server-generated config)
     */
    constructor({ voiceCount = 1, defaultModel = DEFAULT_MODEL, prefKeyVoice, prefKeySpeed, storage, elements, serverDefaults = {} }) {
        if (!storage) throw new Error('NSpeechController: storage adapter required');
        if (!elements) throw new Error('NSpeechController: elements required');
        this.voiceCount = voiceCount;
        this.defaultModel = defaultModel;
        this.storage = storage;
        this.elements = elements;

        this.prefKeyVoice = prefKeyVoice || (voiceCount === 2 ? PREF_VOICE_A : PREF_VOICE);
        this.prefKeySpeed = prefKeySpeed || (voiceCount === 2 ? PREF_ARENA_SPEED : PREF_SPEED);

        // State
        this.endpoint = serverDefaults.endpoint || endpointFromStorage() || '';
        this.model = defaultModel;
        this.speed = serverDefaults.speed ?? DEFAULT_SPEED;
        this.voices = [];                  // raw voice list from /v1/voices
        this.voiceA = serverDefaults.voice || '';  // engine-qualified value
        this.voiceB = '';                          // engine-qualified value (arena only)

        // Playback (decoupled from download)
        this.audio = null;
        this.targetEl = null;
        this._playbackState = 'idle'; // idle | loading | playing | paused
        this._listeners = new Map(); // event -> Set<fn>
        this._rafId = null;
        this._dragSeeking = false;
        // Monotonic timeline length for UI while duration is still unknown.
        this._timelineMax = 0;
        // Download pipeline — independent of audio.play/pause
        this._speechAbort = null;       // AbortController for fetch body
        this._mediaSource = null;
        this._sourceBuffer = null;
        this._objectUrl = null;         // blob: URL for MSE or final blob
        this._mseQueue = [];            // pending Uint8Array chunks for SourceBuffer
        this._mseAppending = false;
        this._mseEnded = false;
        this._downloadComplete = false;
        this._bytesReceived = 0;
        this._chunkCount = 0;

        // Abort controller for the voices fetch (so a stale request can't clobber fresh state)
        this._voicesAbort = null;
    }

    // ============================================
    // Events — 'state' | 'time'
    // ============================================

    on(event, fn) {
        if (typeof fn !== 'function') throw new Error('NSpeechController.on: fn required');
        if (!this._listeners.has(event)) this._listeners.set(event, new Set());
        this._listeners.get(event).add(fn);
        return () => this.off(event, fn);
    }

    off(event, fn) {
        this._listeners.get(event)?.delete(fn);
    }

    _emit(event, data) {
        const set = this._listeners.get(event);
        if (!set) return;
        for (const fn of set) fn(data);
    }

    // ============================================
    // Initialization
    // ============================================

    /**
     * Load persisted prefs, populate inputs, fetch voices. Call once at startup.
     */
    async init() {
        this.endpoint = endpointFromStorage() || this.endpoint;

        if (this.voiceCount === 2) {
            this.voiceA = await this.storage.getPref(PREF_VOICE_A) || this.voiceA;
            this.voiceB = await this.storage.getPref(PREF_PREF_VOICE_B) || '';
        } else {
            const v = await this.storage.getPref(this.prefKeyVoice);
            this.voiceA = v !== null ? v : (this.voiceA || '');
        }

        const storedSpeed = await this.storage.getPref(this.prefKeySpeed);
        this.speed = storedSpeed !== null ? parseFloat(storedSpeed) : this.speed;

        this._populateInputs();
        await this.loadVoices();
        this._wireEvents();
    }

    _populateInputs() {
        const endpointInput = this.elements.endpoint?.querySelector('input');
        if (endpointInput) endpointInput.value = this.endpoint;

        const speedInput = this.elements.speed?.querySelector('input');
        if (speedInput) speedInput.value = this.speed;
    }

    _wireEvents() {
        // Endpoint — save + reload voices on change
        this.elements.endpoint?.querySelector('input')?.addEventListener('change', (e) => {
            this.endpoint = e.target.value || '';
            localStorage.setItem(LS_ENDPOINT, this.endpoint);
            this.loadVoices();
        });

        // Voice select(s)
        if (this.voiceCount === 2) {
            this.elements.voiceASelect?.addEventListener('nui-change', (e) => {
                this.voiceA = this._readSelectValue(e);
                this.storage.setPref(PREF_VOICE_A, this.voiceA).catch(() => {});
            });
            this.elements.voiceBSelect?.addEventListener('nui-change', (e) => {
                this.voiceB = this._readSelectValue(e);
                this.storage.setPref(PREF_PREF_VOICE_B, this.voiceB).catch(() => {});
            });
            // Legacy fallback: some nui-select versions emit 'change' on inner <select>
            this.elements.voiceASelect?.querySelector('select')?.addEventListener('change', (e) => {
                this.voiceA = e.target.value;
                this.storage.setPref(PREF_VOICE_A, this.voiceA).catch(() => {});
            });
            this.elements.voiceBSelect?.querySelector('select')?.addEventListener('change', (e) => {
                this.voiceB = e.target.value;
                this.storage.setPref(PREF_PREF_VOICE_B, this.voiceB).catch(() => {});
            });
        } else {
            this.elements.voiceSelect?.addEventListener('nui-change', (e) => {
                this.voiceA = this._readSelectValue(e);
                this.storage.setPref(this.prefKeyVoice, this.voiceA).catch(() => {});
            });
            this.elements.voiceSelect?.querySelector('select')?.addEventListener('change', (e) => {
                this.voiceA = e.target.value;
                this.storage.setPref(this.prefKeyVoice, this.voiceA).catch(() => {});
            });
        }

        // Speed
        this.elements.speed?.querySelector('input')?.addEventListener('change', (e) => {
            this.speed = parseFloat(e.target.value) || DEFAULT_SPEED;
            this.storage.setPref(this.prefKeySpeed, String(this.speed)).catch(() => {});
        });
    }

    _readSelectValue(event) {
        return (event.detail?.values?.[0]) || event.detail?.value || '';
    }

    // ============================================
    // Voice loading
    // ============================================

    /**
     * Fetch voices from nSpeech and populate the select(s).
     * Silently disables TTS on connection failure (service may not be running).
     */
    async loadVoices() {
        if (!this.endpoint) {
            this.voices = [];
            this._updateVoiceSelects();
            return;
        }

        // Cancel any in-flight fetch
        if (this._voicesAbort) this._voicesAbort.abort();
        const abort = new AbortController();
        this._voicesAbort = abort;
        const timer = setTimeout(() => abort.abort(), VOICE_FETCH_TIMEOUT_MS);

        try {
            const resp = await fetch(`${this.endpoint}/v1/voices`, {
                signal: abort.signal,
            });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            this.voices = data.voices || [];
            this._updateVoiceSelects();
            this._showStatus(null);
        } catch (err) {
            this.voices = [];
            this._updateVoiceSelects();
            // Only show a status if the endpoint looks configured — avoid noise on empty startup
            if (this.endpoint) this._showStatus('TTS unavailable');
        } finally {
            clearTimeout(timer);
            this._voicesAbort = null;
        }
    }

    _updateVoiceSelects() {
        const selects = this.voiceCount === 2
            ? [this.elements.voiceASelect, this.elements.voiceBSelect]
            : [this.elements.voiceSelect];

        if (this.voices.length === 0) {
            const items = [{ value: '', label: 'No voices available', disabled: true }];
            selects.forEach(sel => { if (sel?.setItems) sel.setItems(items); });
            return;
        }

        // Sort: by engine, then by voice_type (builtin first), then name
        const sorted = [...this.voices].sort((a, b) => {
            const ea = a.engine || '~';
            const eb = b.engine || '~';
            if (ea !== eb) return ea < eb ? -1 : 1;
            const ta = a.voice_type || 'z';
            const tb = b.voice_type || 'z';
            if (ta !== tb) return ta < tb ? -1 : 1;
            const na = a.name || a.voice_id || '';
            const nb = b.name || b.voice_id || '';
            return na < nb ? -1 : (na > nb ? 1 : 0);
        });

        const items = sorted.map(v => ({ label: voiceLabel(v), value: voiceValue(v) }));

        selects.forEach((sel, idx) => {
            if (!sel) return;
            if (sel.setItems) sel.setItems(items);
            const current = idx === 0 ? this.voiceA : this.voiceB;
            if (current) {
                if (sel.setValue) sel.setValue(current);
            } else if (sorted.length > 0) {
                const first = voiceValue(sorted[0]);
                if (sel.setValue) sel.setValue(first);
                if (idx === 0) {
                    this.voiceA = first;
                    this.storage.setPref(this.voiceCount === 2 ? PREF_VOICE_A : this.prefKeyVoice, first).catch(() => {});
                } else {
                    this.voiceB = first;
                    this.storage.setPref(PREF_PREF_VOICE_B, first).catch(() => {});
                }
            }
        });
    }

    _showStatus(message) {
        const el = this.elements.status;
        if (!el) return;
        if (message) {
            el.textContent = message;
            el.style.display = 'block';
        } else {
            el.textContent = '';
            el.style.display = 'none';
        }
    }

    // ============================================
    // Playback
    // ============================================

    /**
     * Resolve the engine + voice_id to send to nSpeech for a given slot.
     * @param {'A'|'B'} slot  which voice to use (ignored when voiceCount=1)
     */
    resolveVoice(slot = 'A') {
        const value = this.voiceCount === 2
            ? (slot === 'B' ? this.voiceB : this.voiceA)
            : this.voiceA;
        const { engine, voiceId } = parseVoiceValue(value);
        return {
            model: engine || this.defaultModel,
            voice: voiceId || 'default',
        };
    }

    /**
     * Speak plain text.
     * Starts an independent download of the full speech stream. Playback can
     * pause/resume freely; download continues until complete or stop()/cancel.
     *
     * @param {string} text
     * @param {HTMLElement} targetEl
     * @param {object} [opts]
     * @param {'A'|'B'} [opts.slot]
     * @param {string} [opts.voice]
     */
    speak(text, targetEl, opts = {}) {
        if (!text) return;
        if (!this.endpoint) {
            this._showStatus('No TTS endpoint configured');
            return;
        }

        // New speak replaces previous session (download + playback).
        this.stop();

        const slot = opts.slot || 'A';
        const override = opts.voice ? parseVoiceValue(opts.voice) : null;
        const resolved = override
            ? { model: override.engine || this.defaultModel, voice: override.voiceId || 'default' }
            : this.resolveVoice(slot);

        const params = new URLSearchParams({
            model: resolved.model,
            input: text,
            voice: resolved.voice,
            response_format: DEFAULT_FORMAT,
            speed: String(this.speed),
        });
        const url = `${this.endpoint}/v1/audio/speech?${params}`;

        this.targetEl = targetEl;
        this._downloadComplete = false;
        this._bytesReceived = 0;
        this._chunkCount = 0;
        this._timelineMax = 0;
        this._setPlaybackState('loading');
        this._startTimeLoop();

        // AbortController owns the generation stream — only stop()/new speak abort it.
        const speechAbort = new AbortController();
        this._speechAbort = speechAbort;

        const audio = new Audio();
        audio.preload = 'auto';
        this.audio = audio;
        this._wireAudioElement(audio);

        // Prefer MediaSource so we can append while paused (true decouple).
        // Fallback: accumulate blob, play object URL when first bytes arrive /
        // on complete if MSE unsupported.
        const useMse = typeof MediaSource !== 'undefined'
            && MediaSource.isTypeSupported
            && MediaSource.isTypeSupported('audio/mpeg');

        if (useMse) {
            this._startMsePipeline(audio);
        }

        this._runDownload(url, speechAbort, useMse).catch((err) => {
            if (speechAbort.signal.aborted) return;
            console.warn('[TTS] Download failed:', err.message || err);
            this.stop();
        });
    }

    /**
     * Wire HTMLAudioElement events. Playback state only — never aborts download.
     */
    _wireAudioElement(audio) {
        audio.onplaying = () => {
            if (this.audio !== audio) return;
            this._setPlaybackState('playing');
            this._startTimeLoop();
        };
        audio.onpause = () => {
            if (this.audio !== audio) return;
            if (!audio.src || audio.ended) return;
            if (this._playbackState === 'loading') return;
            this._setPlaybackState('paused');
            this._startTimeLoop();
            this._emitTime();
        };
        audio.onended = () => {
            if (this.audio !== audio) return;
            // Natural end of playhead — download may already be done; keep session.
            this._setPlaybackState('paused');
            this._startTimeLoop();
            this._emitTime();
        };
        audio.onerror = () => {
            if (this.audio !== audio) return;
            // Ignore transient MSE/blob swap errors while still downloading.
            if (!this._downloadComplete && this._speechAbort && !this._speechAbort.signal.aborted) {
                return;
            }
            console.warn('[TTS] Playback failed');
            this.stop();
        };
        audio.ondurationchange = () => {
            if (this.audio !== audio) return;
            this._emitTime();
        };
        audio.onprogress = () => {
            if (this.audio !== audio) return;
            this._emitTime();
        };
        audio.onloadeddata = () => {
            if (this.audio !== audio) return;
            this._emitTime();
        };
        audio.oncanplay = () => {
            if (this.audio !== audio) return;
            // Auto-start once we can play (first buffered media).
            if (this._playbackState === 'loading') {
                audio.play().catch((err) => {
                    if (this.audio !== audio) return;
                    console.warn('[TTS] Playback error:', err.message);
                });
            }
            this._emitTime();
        };
    }

    _startMsePipeline(audio) {
        const mediaSource = new MediaSource();
        this._mediaSource = mediaSource;
        this._mseQueue = [];
        this._mseAppending = false;
        this._mseEnded = false;

        const objectUrl = URL.createObjectURL(mediaSource);
        this._objectUrl = objectUrl;
        audio.src = objectUrl;

        mediaSource.addEventListener('sourceopen', () => {
            if (this._mediaSource !== mediaSource) return;
            let sb;
            try {
                sb = mediaSource.addSourceBuffer('audio/mpeg');
            } catch (err) {
                console.warn('[TTS] SourceBuffer audio/mpeg failed, will use blob fallback');
                return;
            }
            this._sourceBuffer = sb;
            sb.mode = 'sequence';
            sb.addEventListener('updateend', () => {
                this._mseAppending = false;
                this._pumpMseQueue();
                this._emitTime();
            });
            this._pumpMseQueue();
        }, { once: true });
    }

    _pumpMseQueue() {
        const sb = this._sourceBuffer;
        const ms = this._mediaSource;
        if (!sb || !ms || ms.readyState !== 'open') return;
        if (this._mseAppending || sb.updating) return;

        if (this._mseQueue.length > 0) {
            const chunk = this._mseQueue.shift();
            this._mseAppending = true;
            try {
                sb.appendBuffer(chunk);
            } catch (err) {
                this._mseAppending = false;
                console.warn('[TTS] appendBuffer failed:', err.message);
            }
            return;
        }

        if (this._downloadComplete && !this._mseEnded) {
            this._mseEnded = true;
            try {
                ms.endOfStream();
            } catch (_) {
                // already ended / invalid state
            }
            this._emitTime();
        }
    }

    /**
     * Fetch speech body. Runs to completion unless aborted via stop().
     * Pause/resume never touch this.
     */
    async _runDownload(url, speechAbort, useMse) {
        const res = await fetch(url, { signal: speechAbort.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        if (!res.body) throw new Error('No response body');

        const reader = res.body.getReader();
        const mime = res.headers.get('content-type') || 'audio/mpeg';
        const fallbackChunks = []; // used when MSE unavailable or SB missing
        let useFallback = !useMse;

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (speechAbort.signal.aborted) {
                try { reader.cancel(); } catch (_) {}
                return;
            }
            if (!value || !value.byteLength) continue;

            this._bytesReceived += value.byteLength;
            this._chunkCount += 1;
            const copy = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);

            if (!useFallback && this._sourceBuffer) {
                this._mseQueue.push(copy);
                this._pumpMseQueue();
            } else if (!useFallback && this._mediaSource && !this._sourceBuffer) {
                // sourceopen not ready yet — queue anyway
                this._mseQueue.push(copy);
                this._pumpMseQueue();
            } else {
                useFallback = true;
                fallbackChunks.push(new Uint8Array(copy));
                // Progressive blob playback: refresh object URL periodically
                if (this._chunkCount === 1 || this._chunkCount % 8 === 0) {
                    this._applyFallbackBlob(fallbackChunks, mime, false);
                }
            }
            this._emitTime();
        }

        if (speechAbort.signal.aborted) return;

        this._downloadComplete = true;

        if (useFallback) {
            this._applyFallbackBlob(fallbackChunks, mime, true);
        } else {
            this._pumpMseQueue();
        }
        this._emit('download-complete', {
            bytes: this._bytesReceived,
            chunks: this._chunkCount,
        });
        this._emitTime();
    }

    /**
     * Blob fallback when MSE is unavailable. Rebuilds object URL from chunks.
     * Preserves currentTime across swaps when possible.
     */
    _applyFallbackBlob(chunks, mime, final) {
        if (!this.audio || !chunks.length) return;
        const blob = new Blob(chunks, { type: mime });
        const nextUrl = URL.createObjectURL(blob);
        const audio = this.audio;
        const wasPlaying = !audio.paused && !audio.ended;
        const t = audio.currentTime || 0;

        const prevUrl = this._objectUrl;
        this._objectUrl = nextUrl;
        audio.src = nextUrl;
        if (prevUrl && prevUrl !== nextUrl) {
            try { URL.revokeObjectURL(prevUrl); } catch (_) {}
        }

        const restore = () => {
            if (this.audio !== audio) return;
            if (t > 0 && Number.isFinite(t)) {
                try { audio.currentTime = t; } catch (_) {}
            }
            if (wasPlaying || this._playbackState === 'loading' || this._playbackState === 'playing') {
                audio.play().catch(() => {});
            }
            this._emitTime();
        };
        if (audio.readyState >= 1) restore();
        else audio.addEventListener('loadedmetadata', restore, { once: true });
    }

    /**
     * Toggle for a target element:
     * - same target + loading → cancel (stop download + playback)
     * - same target + playing/paused → pause/resume (download continues)
     * - different target → new speak
     */
    toggle(text, targetEl, opts = {}) {
        if (this.targetEl === targetEl && this.isActive()) {
            if (this._playbackState === 'loading') this.stop();
            else this.togglePause();
            return;
        }
        this.speak(text, targetEl, opts);
    }

    /**
     * Pause if playing, resume if paused. Never touches the download.
     */
    togglePause() {
        if (!this.audio) return;
        if (this._playbackState === 'playing') {
            this.pause();
            return;
        }
        if (this._playbackState === 'paused' || this._playbackState === 'loading') {
            // loading: try play if media already available
            this.resume();
        }
    }

    pause() {
        if (!this.audio) return;
        if (this._playbackState !== 'playing') return;
        // Playback only — download keeps running via fetch reader.
        this.audio.pause();
    }

    resume() {
        if (!this.audio) return;
        if (this._playbackState === 'idle') return;
        const a = this.audio;
        const dur = Number.isFinite(a.duration) ? a.duration : 0;
        if (a.ended || (dur > 0 && a.currentTime >= dur - 0.05)) {
            a.currentTime = 0;
        }
        a.play().catch((err) => {
            console.warn('[TTS] Resume error:', err.message);
        });
    }

    /**
     * Explicit cancel — aborts download and tears down playback.
     * Same as stop(); named for call-site clarity.
     */
    cancel() {
        this.stop();
    }

    /**
     * Seek to absolute seconds. Clamped to buffered/duration range.
     */
    seek(seconds) {
        if (!this.audio) return;
        if (typeof seconds !== 'number' || !Number.isFinite(seconds)) {
            throw new Error('NSpeechController.seek: seconds must be a finite number');
        }
        const max = this._seekMax();
        const t = Math.max(0, Math.min(seconds, max > 0 ? max : seconds));
        try {
            this.audio.currentTime = t;
        } catch (err) {
            console.warn('[TTS] seek failed:', err.message);
        }
        this._emitTime();
    }

    seekBy(delta) {
        if (!this.audio) return;
        if (typeof delta !== 'number' || !Number.isFinite(delta)) {
            throw new Error('NSpeechController.seekBy: delta must be a finite number');
        }
        this.seek((this.audio.currentTime || 0) + delta);
    }

    /**
     * Soft dismiss for host chrome: pause if playing, keep download + audio.
     */
    dismiss() {
        if (!this.audio && !this._speechAbort) return;
        if (this._playbackState === 'playing') this.pause();
        this._emit('dismiss', { state: this._playbackState, targetEl: this.targetEl });
    }

    /**
     * Hard stop — abort download, tear down MSE/blob, idle.
     */
    stop() {
        this._stopTimeLoop();
        const prevTarget = this.targetEl;

        if (this._speechAbort) {
            try { this._speechAbort.abort(); } catch (_) {}
            this._speechAbort = null;
        }

        this._mseQueue = [];
        this._mseAppending = false;
        this._mseEnded = false;
        this._sourceBuffer = null;

        if (this._mediaSource) {
            const ms = this._mediaSource;
            this._mediaSource = null;
            if (ms.readyState === 'open') {
                try { ms.endOfStream(); } catch (_) {}
            }
        }

        if (this.audio) {
            const audio = this.audio;
            this.audio = null;
            audio.onplaying = null;
            audio.onpause = null;
            audio.onended = null;
            audio.onerror = null;
            audio.ondurationchange = null;
            audio.onprogress = null;
            audio.onloadeddata = null;
            audio.oncanplay = null;
            audio.oncanplaythrough = null;
            audio.pause();
            audio.removeAttribute('src');
            try { audio.load(); } catch (_) {}
        }

        if (this._objectUrl) {
            try { URL.revokeObjectURL(this._objectUrl); } catch (_) {}
            this._objectUrl = null;
        }

        this.targetEl = null;
        this._dragSeeking = false;
        this._timelineMax = 0;
        this._downloadComplete = false;
        this._bytesReceived = 0;
        this._chunkCount = 0;

        if (this._playbackState !== 'idle' || prevTarget) {
            this._playbackState = 'idle';
            if (prevTarget) this._applyButtonState(prevTarget, 'idle');
            this._emit('state', { state: 'idle', targetEl: null });
            this._emit('time', { currentTime: 0, duration: 0, bufferedEnd: 0, timelineMax: 0 });
        }
    }

    getPlaybackState() {
        return this._playbackState;
    }

    isActive() {
        return this._playbackState !== 'idle';
    }

    isPlaying() {
        return this._playbackState === 'playing';
    }

    isPaused() {
        return this._playbackState === 'paused';
    }

    /** True while speech bytes are still arriving. */
    isDownloading() {
        return !!(this._speechAbort && !this._downloadComplete);
    }

    getTimes() {
        const audio = this.audio;
        if (!audio) {
            return { currentTime: 0, duration: 0, bufferedEnd: 0, timelineMax: 0 };
        }
        const currentTime = audio.currentTime || 0;
        const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
        const bufferedEnd = this._bufferedEnd();
        const nextMax = Math.max(this._timelineMax, duration, bufferedEnd, currentTime);
        this._timelineMax = nextMax;
        return {
            currentTime,
            duration,
            bufferedEnd,
            timelineMax: nextMax,
            bytesReceived: this._bytesReceived,
            downloadComplete: this._downloadComplete,
        };
    }

    setSeekDragging(dragging) {
        this._dragSeeking = !!dragging;
    }

    _setPlaybackState(state) {
        if (this._playbackState === state) {
            if (this.targetEl) this._applyButtonState(this.targetEl, state);
            return;
        }
        this._playbackState = state;
        if (this.targetEl) this._applyButtonState(this.targetEl, state);
        this._emit('state', { state, targetEl: this.targetEl });
        this._emitTime();
    }

    _applyButtonState(targetEl, state) {
        if (!targetEl) return;
        const btn = targetEl.querySelector('.speaker');
        if (!btn) return;
        const icon = btn.querySelector('nui-icon');

        btn.classList.remove('playing', 'loading', 'paused');

        if (state === 'loading') {
            btn.classList.add('loading');
            btn.setAttribute('title', 'Loading audio…');
            if (icon) icon.setAttribute('name', 'sync');
        } else if (state === 'playing') {
            btn.classList.add('playing');
            btn.setAttribute('title', 'Pause');
            if (icon) icon.setAttribute('name', 'pause');
        } else if (state === 'paused') {
            btn.classList.add('paused');
            btn.setAttribute('title', 'Resume');
            if (icon) icon.setAttribute('name', 'play');
        } else {
            btn.setAttribute('title', 'Read Aloud');
            if (icon) icon.setAttribute('name', 'volume');
        }
    }

    _startTimeLoop() {
        if (this._rafId) return;
        const tick = () => {
            this._rafId = null;
            if (!this.audio || this._playbackState === 'idle') return;
            if (!this._dragSeeking) this._emitTime();
            // Poll through loading/playing/paused so buffer growth paints
            // while download continues under a paused playhead.
            if (this._playbackState !== 'idle' && this.audio) {
                this._rafId = requestAnimationFrame(tick);
            }
        };
        this._rafId = requestAnimationFrame(tick);
    }

    _stopTimeLoop() {
        if (this._rafId) {
            cancelAnimationFrame(this._rafId);
            this._rafId = null;
        }
    }

    _emitTime() {
        this._emit('time', this.getTimes());
    }

    _bufferedEnd() {
        const audio = this.audio;
        if (!audio || !audio.buffered || audio.buffered.length === 0) return 0;
        try {
            return audio.buffered.end(audio.buffered.length - 1);
        } catch {
            return 0;
        }
    }

    _seekMax() {
        const audio = this.audio;
        if (!audio) return 0;
        const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
        const buffered = this._bufferedEnd();
        return Math.max(duration, buffered, audio.currentTime || 0, this._timelineMax || 0);
    }
}
