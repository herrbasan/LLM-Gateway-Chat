// ============================================
// NSpeechController — Shared TTS controller for chat + arena
// ============================================
//
// Talks to nSpeech V3 (OpenAI-compatible API):
//   POST /v1/audio/speech  { model, input, voice, response_format, speed, ... }
//   GET  /v1/voices?engine=<name>
//   GET  /v1/admin/engines
//
// One controller serves both apps:
//   - chat   → voiceCount: 1 (single voice)
//   - arena  → voiceCount: 2 (voice A / voice B per speaker)
//
// Two-select pattern (engine → voice):
//   Select 1 lists the local engine (dashboard-selected, shown with its real
//   name) + all cloud engines. Select 2 lists only the voices for the
//   selected engine. Changing the engine clears the voice and repopulates.
//
// The selected engine is sent as the `model` field so nSpeech routes
// correctly. The local sentinel 'nspeech' means "dashboard-selected engine".
//
// All UI wiring is optional — pass the DOM elements you have. State is
// persisted via the injected `storage` adapter (storage.getPref / setPref)
// plus localStorage for the endpoint.

const DEFAULT_ENDPOINT = 'http://localhost:2233';
const DEFAULT_MODEL = 'nspeech';        // dashboard-selected local engine
const DEFAULT_FORMAT = 'mp3';
const DEFAULT_SPEED = 1.0;
const VOICE_FETCH_TIMEOUT_MS = 6000;
const ENGINE_FETCH_TIMEOUT_MS = 4000;

// Voice selection is shared across both apps via this pref key, so changing
// the voice in chat also changes it in arena (and vice versa). Arena's A/B
// voices use separate keys.
const PREF_VOICE = 'tts-voice';
const PREF_VOICE_A = 'arena-tts-voice-a';
const PREF_PREF_VOICE_B = 'arena-tts-voice-b';
const PREF_SPEED = 'tts-speed';
const PREF_ARENA_SPEED = 'arena-tts-speed';
// Engine prefs — same sharing pattern as voice prefs.
const PREF_ENGINE = 'tts-engine';
const PREF_ENGINE_A = 'arena-tts-engine-a';
const PREF_ENGINE_B = 'arena-tts-engine-b';
const LS_ENDPOINT = 'tts-endpoint';

// Markdown cleanup mode sent to nSpeech via extra_body.markdown.
// Values: 'off' (omit) | 'true' (regex clean) | 'llm' (regex + LLM prosody).
// Shared pref across chat + arena (set in the chat TTS settings).
const PREF_MARKDOWN = 'tts-markdown';

// ============================================
// Helpers
// ============================================

function endpointFromStorage() {
    return localStorage.getItem(LS_ENDPOINT) || '';
}

function voiceLabel(v) {
    const name = v.name || v.voice_id || String(v);
    const cat = v.voice_type && v.voice_type !== 'builtin' && v.voice_type !== 'cloned' ? ` (${v.voice_type})` : '';
    return `${name}${cat}`;
}

// Voice values are bare voice_id — the engine is tracked separately via
// the engine select, so we don't need to embed it in the voice value.
function voiceValue(v) {
    return v.voice_id || v.name || String(v);
}

// Parse a voice value that might be in the old engine:voice_id format
// (from persisted prefs written by the previous version) or bare voice_id.
function parseVoiceValue(value) {
    if (!value) return { voiceId: null };
    const idx = value.indexOf(':');
    if (idx === -1) return { voiceId: value };
    return { voiceId: value.slice(idx + 1) };
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
     *   - engineSelect:    nui-select (voiceCount=1) — engine chooser
     *   - voiceSelect:     nui-select (voiceCount=1) — voice for selected engine
     *   - engineASelect:   nui-select (voiceCount=2) — engine chooser A
     *   - engineBSelect:   nui-select (voiceCount=2) — engine chooser B
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
        this.markdownMode = 'true'; // default: regex clean (matches prior client-side cleaning)
        this.voices = [];                  // raw voice list from /v1/voices (local engine)
        this.engines = [];                 // engine catalog from /v1/admin/engines
        this.voicesByEngine = new Map();   // engine name → voice[] (all engines)
        // Engine selection per slot. 'nspeech' = local dashboard-selected.
        this.engineA = DEFAULT_MODEL;
        this.engineB = DEFAULT_MODEL;
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
            this.engineA = await this.storage.getPref(PREF_ENGINE_A) || this.engineA;
            this.engineB = await this.storage.getPref(PREF_ENGINE_B) || this.engineB;
            this.voiceA = await this.storage.getPref(PREF_VOICE_A) || this.voiceA;
            this.voiceB = await this.storage.getPref(PREF_PREF_VOICE_B) || '';
        } else {
            const e = await this.storage.getPref(PREF_ENGINE);
            this.engineA = e || this.engineA;
            const v = await this.storage.getPref(this.prefKeyVoice);
            this.voiceA = v !== null ? v : (this.voiceA || '');
        }

        const storedSpeed = await this.storage.getPref(this.prefKeySpeed);
        this.speed = storedSpeed !== null ? parseFloat(storedSpeed) : this.speed;

        const storedMarkdown = await this.storage.getPref(PREF_MARKDOWN);
        this.markdownMode = ['off', 'true', 'llm'].includes(storedMarkdown) ? storedMarkdown : 'true';
        this._applyMarkdownModeToCheckboxes();

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

        // Engine select(s) — changing engine clears voice + repopulates
        if (this.voiceCount === 2) {
            const onEngineA = (value) => {
                this.engineA = value || DEFAULT_MODEL;
                this.voiceA = '';
                this.storage.setPref(PREF_ENGINE_A, this.engineA).catch(() => {});
                this.storage.setPref(PREF_VOICE_A, '').catch(() => {});
                this._updateVoiceSelect('A');
            };
            const onEngineB = (value) => {
                this.engineB = value || DEFAULT_MODEL;
                this.voiceB = '';
                this.storage.setPref(PREF_ENGINE_B, this.engineB).catch(() => {});
                this.storage.setPref(PREF_PREF_VOICE_B, '').catch(() => {});
                this._updateVoiceSelect('B');
            };
            this.elements.engineASelect?.addEventListener('nui-change', (e) => onEngineA(this._readSelectValue(e)));
            this.elements.engineBSelect?.addEventListener('nui-change', (e) => onEngineB(this._readSelectValue(e)));
            this.elements.engineASelect?.querySelector('select')?.addEventListener('change', (e) => onEngineA(e.target.value));
            this.elements.engineBSelect?.querySelector('select')?.addEventListener('change', (e) => onEngineB(e.target.value));
        } else {
            const onEngine = (value) => {
                this.engineA = value || DEFAULT_MODEL;
                this.voiceA = '';
                this.storage.setPref(PREF_ENGINE, this.engineA).catch(() => {});
                this.storage.setPref(this.prefKeyVoice, '').catch(() => {});
                this._updateVoiceSelect('A');
            };
            this.elements.engineSelect?.addEventListener('nui-change', (e) => onEngine(this._readSelectValue(e)));
            this.elements.engineSelect?.querySelector('select')?.addEventListener('change', (e) => onEngine(e.target.value));
        }

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

        // Markdown cleanup checkboxes (off / true / llm)
        const persistMarkdown = () => {
            this.markdownMode = this._computeMarkdownMode();
            this.storage.setPref(PREF_MARKDOWN, this.markdownMode).catch(() => {});
        };
        this.elements.markdownClean?.addEventListener('nui-change', persistMarkdown);
        this.elements.markdownClean?.querySelector('input')?.addEventListener('change', persistMarkdown);
        this.elements.markdownLlms?.addEventListener('nui-change', persistMarkdown);
        this.elements.markdownLlms?.querySelector('input')?.addEventListener('change', persistMarkdown);
    }

    _readSelectValue(event) {
        return (event.detail?.values?.[0]) || event.detail?.value || '';
    }

    // ============================================
    // Markdown cleanup mode (off / true / llm)
    // ============================================

    _readCheckbox(el) {
        if (!el) return false;
        const input = el.tagName === 'INPUT' ? el : el.querySelector('input');
        return !!(input && input.checked);
    }

    _setCheckbox(el, checked) {
        if (!el) return;
        const input = el.tagName === 'INPUT' ? el : el.querySelector('input');
        if (input) input.checked = !!checked;
    }

    _computeMarkdownMode() {
        const llm = this._readCheckbox(this.elements.markdownLlms);
        const clean = this._readCheckbox(this.elements.markdownClean);
        // LLM prosody pass implies the regex clean.
        return llm ? 'llm' : (clean ? 'true' : 'off');
    }

    _applyMarkdownModeToCheckboxes() {
        const clean = this.markdownMode === 'true' || this.markdownMode === 'llm';
        const llm = this.markdownMode === 'llm';
        this._setCheckbox(this.elements.markdownClean, clean);
        this._setCheckbox(this.elements.markdownLlms, llm);
    }

    // ============================================
    // Voice loading
    // ============================================

    /**
     * Fetch engines + per-engine voices from nSpeech and populate selects.
     *
     * Three parallel fetches:
     *   1. GET /v1/admin/engines  → engine catalog (local + cloud)
     *   2. GET /v1/voices         → local engine voices
     *   3. GET /v1/voices?engine=X for each cloud engine (parallel)
     *
     * Silently disables TTS on connection failure (service may not be running).
     */
    async loadVoices() {
        if (!this.endpoint) {
            this.voices = [];
            this.engines = [];
            this.voicesByEngine.clear();
            this._updateEngineSelects();
            this._updateVoiceSelect('A');
            if (this.voiceCount === 2) this._updateVoiceSelect('B');
            return;
        }

        // Cancel any in-flight fetch
        if (this._voicesAbort) this._voicesAbort.abort();
        const abort = new AbortController();
        this._voicesAbort = abort;
        const timer = setTimeout(() => abort.abort(), ENGINE_FETCH_TIMEOUT_MS + VOICE_FETCH_TIMEOUT_MS);

        try {
            // Fetch engine catalog + local voices in parallel
            const [enginesResp, localVoicesResp] = await Promise.all([
                fetch(`${this.endpoint}/v1/admin/engines`, { signal: abort.signal }).catch(() => null),
                fetch(`${this.endpoint}/v1/voices`, { signal: abort.signal }).catch(() => null),
            ]);

            if (enginesResp && !enginesResp.ok) throw new Error(`Engines HTTP ${enginesResp.status}`);
            const enginesData = enginesResp ? await enginesResp.json() : { engines: [] };
            const engines = Array.isArray(enginesData.engines) ? enginesData.engines : [];
            this._currentEngine = enginesData.current || null;

            const localVoices = (localVoicesResp && localVoicesResp.ok)
                ? ((await localVoicesResp.json()).voices || [])
                : [];

            this.engines = engines;
            this.voices = localVoices;

            // Build voicesByEngine map: local voices under 'nspeech', cloud voices under their engine name
            this.voicesByEngine = new Map();
            this.voicesByEngine.set(DEFAULT_MODEL, localVoices);

            // Fetch cloud engine voices in parallel
            const cloudEngines = engines.filter(e => e.type === 'cloud');
            const cloudResults = await Promise.all(cloudEngines.map(async eng => {
                try {
                    const resp = await fetch(`${this.endpoint}/v1/voices?engine=${encodeURIComponent(eng.name)}`, {
                        signal: abort.signal,
                    });
                    if (!resp.ok) return { name: eng.name, voices: [] };
                    const data = await resp.json();
                    return { name: eng.name, voices: data.voices || [] };
                } catch {
                    return { name: eng.name, voices: [] };
                }
            }));
            for (const { name, voices } of cloudResults) {
                this.voicesByEngine.set(name, voices);
            }

            this._updateEngineSelects();
            this._updateVoiceSelect('A');
            if (this.voiceCount === 2) this._updateVoiceSelect('B');
            this._showStatus(null);
        } catch (err) {
            this.voices = [];
            this.engines = [];
            this._currentEngine = null;
            this.voicesByEngine.clear();
            this._updateEngineSelects();
            this._updateVoiceSelect('A');
            if (this.voiceCount === 2) this._updateVoiceSelect('B');
            if (this.endpoint) this._showStatus('TTS unavailable');
        } finally {
            clearTimeout(timer);
            this._voicesAbort = null;
        }
    }

    /**
     * Build the engine catalog for selects: local engine first (with real
     * name if available), then cloud engines alphabetically.
     */
    _buildEngineOptions() {
        const options = [];

        // The "nspeech" sentinel means "use whatever the dashboard selected".
        // Label it with the actual current engine name from /v1/admin/engines
        // so the user knows which engine is active. The top-level `current`
        // field is authoritative — is_current on individual engines is not
        // reliable (all false when a cloud engine is dashboard-selected).
        const currentName = this._currentEngine || this.engines.find(e => e.is_current)?.name || 'nSpeech';
        const display = currentName.charAt(0).toUpperCase() + currentName.slice(1);
        options.push({ value: DEFAULT_MODEL, label: `Active (${display})` });

        // Cloud engines — sorted alphabetically
        const cloudEngines = this.engines
            .filter(e => e.type === 'cloud')
            .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
        for (const eng of cloudEngines) {
            const label = eng.name.charAt(0).toUpperCase() + eng.name.slice(1);
            options.push({ value: eng.name, label });
        }

        return options;
    }

    _updateEngineSelects() {
        const options = this._buildEngineOptions();
        const selects = this.voiceCount === 2
            ? [
                { el: this.elements.engineASelect, value: this.engineA },
                { el: this.elements.engineBSelect, value: this.engineB },
            ]
            : [
                { el: this.elements.engineSelect, value: this.engineA },
            ];

        for (const { el, value } of selects) {
            if (!el) continue;
            if (el.setItems) el.setItems(options);
            // Validate stored engine — fall back to local if it no longer exists
            const valid = options.some(o => o.value === value);
            const target = valid ? value : DEFAULT_MODEL;
            if (el.setValue) el.setValue(target);
        }
    }

    /**
     * Populate a single voice select ('A' or 'B') with voices for the
     * currently selected engine. If the stored voice is invalid for the
     * engine, pick the first available voice.
     */
    _updateVoiceSelect(slot) {
        const selectEl = slot === 'B'
            ? this.elements.voiceBSelect
            : (this.voiceCount === 2 ? this.elements.voiceASelect : this.elements.voiceSelect);
        if (!selectEl) return;

        const engine = slot === 'B' ? this.engineB : this.engineA;
        const voices = this.voicesByEngine.get(engine) || [];

        if (voices.length === 0) {
            const items = [{ value: '', label: 'No voices available', disabled: true }];
            if (selectEl.setItems) selectEl.setItems(items);
            return;
        }

        // Sort: presets/cloned first (★), then alphabetical
        const sorted = [...voices].sort((a, b) => {
            const af = this._isFeatured(a) ? 0 : 1;
            const bf = this._isFeatured(b) ? 0 : 1;
            if (af !== bf) return af - bf;
            return String(a.name || a.voice_id || '').localeCompare(String(b.name || b.voice_id || ''));
        });

        const items = sorted.map(v => ({
            label: this._isFeatured(v) ? `★ ${voiceLabel(v)}` : voiceLabel(v),
            value: voiceValue(v),
        }));

        if (selectEl.setItems) selectEl.setItems(items);

        const currentValue = slot === 'B' ? this.voiceB : this.voiceA;
        if (currentValue) {
            // Validate that the stored voice belongs to this engine
            const isValid = items.some(i => i.value === currentValue);
            if (isValid) {
                if (selectEl.setValue) selectEl.setValue(currentValue);
            } else {
                // Voice is from a different engine — clear it, pick first
                this._selectFirstVoice(slot, sorted, selectEl);
            }
        } else if (sorted.length > 0) {
            this._selectFirstVoice(slot, sorted, selectEl);
        }
    }

    _isFeatured(v) {
        return v.voice_type === 'preset' || v.category === 'cloned';
    }

    _selectFirstVoice(slot, sortedVoices, selectEl) {
        const first = voiceValue(sortedVoices[0]);
        if (selectEl.setValue) selectEl.setValue(first);
        if (slot === 'B') {
            this.voiceB = first;
            this.storage.setPref(PREF_PREF_VOICE_B, first).catch(() => {});
        } else {
            this.voiceA = first;
            this.storage.setPref(this.voiceCount === 2 ? PREF_VOICE_A : this.prefKeyVoice, first).catch(() => {});
        }
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
     * The engine comes from the engine select (this.engineA/engineB).
     * The voice comes from the voice select (stored as engine-qualified value;
     * we extract just the voice_id part).
     * @param {'A'|'B'} slot  which voice to use (ignored when voiceCount=1)
     */
    resolveVoice(slot = 'A') {
        const engine = this.voiceCount === 2
            ? (slot === 'B' ? this.engineB : this.engineA)
            : this.engineA;
        const value = this.voiceCount === 2
            ? (slot === 'B' ? this.voiceB : this.voiceA)
            : this.voiceA;
        const { voiceId } = parseVoiceValue(value);
        return {
            model: engine || this.defaultModel,
            voice: voiceId || value || 'default',
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
            ? { model: this.defaultModel, voice: override.voiceId || 'default' }
            : this.resolveVoice(slot);

        // Body is sent as POST JSON. extra_body.markdown tells nSpeech to clean
        // the markdown before synthesis (off / true / llm).
        const body = {
            model: resolved.model,
            input: text,
            voice: resolved.voice,
            response_format: DEFAULT_FORMAT,
            speed: String(this.speed),
        };
        if (this.markdownMode === 'true') body.extra_body = { markdown: true };
        else if (this.markdownMode === 'llm') body.extra_body = { markdown: 'llm' };

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

        this._runDownload(speechAbort, useMse, body).catch((err) => {
            if (speechAbort.signal.aborted) return;
            console.warn('[TTS] Download failed:', err.message || err);
            this.stop();
        });
    }

    /**
     * POST the speech request. extra_body.markdown selects the cleanup mode.
     */
    async _fetchSpeech(body, speechAbort) {
        return fetch(`${this.endpoint}/v1/audio/speech`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: speechAbort.signal,
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
    async _runDownload(speechAbort, useMse, body) {
        let res = await this._fetchSpeech(body, speechAbort);

        // LLM prosody pass can fail with gateway errors (500/502). Graceful
        // fallback: retry with the plain regex clean (markdown:true).
        if (!res.ok && body.extra_body?.markdown === 'llm' && (res.status === 500 || res.status === 502)) {
            const fallbackBody = { ...body, extra_body: { markdown: true } };
            res = await this._fetchSpeech(fallbackBody, speechAbort);
        }

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
