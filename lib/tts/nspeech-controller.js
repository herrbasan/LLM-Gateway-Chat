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

        // Playback
        this.audio = null;
        this.targetEl = null;
        this._onEnded = null;

        // Abort controller for the voices fetch (so a stale request can't clobber fresh state)
        this._voicesAbort = null;
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
     * Speak plain text. Stops any current playback.
     *
     * @param {string} text          plain text to speak
     * @param {HTMLElement} targetEl the message element owning the speaker button
     * @param {object} [opts]
     * @param {'A'|'B'} [opts.slot]  voice slot (arena only)
     * @param {string} [opts.voice]  explicit engine-qualified voice override (else uses slot)
     */
    speak(text, targetEl, opts = {}) {
        if (!text) return;
        if (!this.endpoint) {
            this._showStatus('No TTS endpoint configured');
            return;
        }

        this.stop();

        const slot = opts.slot || 'A';
        const override = opts.voice ? parseVoiceValue(opts.voice) : null;
        const resolved = override
            ? { model: override.engine || this.defaultModel, voice: override.voiceId || 'default' }
            : this.resolveVoice(slot);

        // Build a GET URL so the browser's <audio> element can use native HTTP
        // streaming (Range requests, progressive playback). This is what makes
        // playback start instantly — the browser plays chunks as they arrive,
        // same as the old /tts endpoint. POST would force full buffering.
        const params = new URLSearchParams({
            model: resolved.model,
            input: text,
            voice: resolved.voice,
            response_format: DEFAULT_FORMAT,
            speed: String(this.speed),
        });
        const url = `${this.endpoint}/v1/audio/speech?${params}`;

        const audio = new Audio(url);
        audio.preload = 'auto';
        this.audio = audio;
        this.targetEl = targetEl;

        // Loading state immediately — model may need to load before first byte
        this._setButtonState('loading');

        // Switch to playing state once audio actually starts
        audio.onplay = () => this._setButtonState('playing');
        audio.onended = () => this.stop();
        audio.onerror = () => {
            console.warn('[TTS] Playback failed');
            this.stop();
        };
        audio.play().catch((err) => {
            console.warn('[TTS] Playback error:', err.message);
            this.stop();
        });
    }

    /**
     * Toggle playback for a target element. If the target is currently active,
     * stop; otherwise start.
     */
    toggle(text, targetEl, opts = {}) {
        if (this.targetEl === targetEl && this.audio) {
            this.stop();
            return;
        }
        this.speak(text, targetEl, opts);
    }

    /**
     * Stop playback and reset the speaker button UI.
     */
    stop() {
        if (this.audio) {
            this.audio.pause();
            this.audio.src = '';
            this.audio.load();
            this.audio = null;
        }
        if (this.targetEl) {
            this._setButtonState('idle');
            this.targetEl = null;
        }
    }

    /**
     * Set the speaker button visual state.
     * @param {'idle'|'loading'|'playing'} state
     *   idle    — volume icon, clickable
     *   loading — spinning sync icon (model loading / waiting for first byte), clickable to cancel
     *   playing — close icon, clickable to stop
     */
    _setButtonState(state) {
        if (!this.targetEl) return;
        const btn = this.targetEl.querySelector('.speaker');
        if (!btn) return;
        const icon = btn.querySelector('nui-icon');

        // Clear all states first
        btn.classList.remove('playing', 'loading');

        if (state === 'loading') {
            btn.classList.add('loading');
            btn.setAttribute('title', 'Loading... click to cancel');
            if (icon) icon.setAttribute('name', 'sync');
        } else if (state === 'playing') {
            btn.classList.add('playing');
            btn.setAttribute('title', 'Stop Reading');
            if (icon) icon.setAttribute('name', 'close');
        } else {
            btn.setAttribute('title', 'Read Aloud');
            if (icon) icon.setAttribute('name', 'volume');
        }
    }

    /**
     * @returns {boolean} whether audio is currently active (loading or playing)
     */
    isPlaying() {
        return !!this.audio;
    }
}
