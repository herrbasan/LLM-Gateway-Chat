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

import { SpeechPlayer } from './nspeech-client.js';

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

// Markdown cleanup pref. Values: 'off' | 'true' (regex clean).
// Cleaning happens CLIENT-SIDE via the vendored nSpeech SDK
// (lib/tts/nspeech-client.js) — extra_body.markdown is never sent.
const PREF_MARKDOWN = 'tts-markdown';

// Long-text rendering mode pref (shared chat + arena). 'stream' (default,
// progressive playback) vs 'stitch' (buffered, seamless joins). Sent to nSpeech
// via extra_body.mode. Only applies to inputs over the engine's char limit.
const PREF_STITCH = 'tts-stitch';

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
     *   - stitch:          nui-checkbox wrapping <input> — "Seamless joins (slow)"
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
        this.stitch = false;        // long-text mode: false → 'stream' (progressive), true → 'stitch' (seamless/slow)
        this.voices = [];                  // raw voice list from /v1/voices (local engine)
        this.engines = [];                 // engine catalog from /v1/admin/engines
        this.voicesByEngine = new Map();   // engine name → voice[] (all engines)
        // Engine selection per slot. 'nspeech' = local dashboard-selected.
        this.engineA = DEFAULT_MODEL;
        this.engineB = DEFAULT_MODEL;
        this.voiceA = serverDefaults.voice || '';  // engine-qualified value
        this.voiceB = '';                          // engine-qualified value (arena only)

        // Playback — SDK SpeechPlayer, created lazily per endpoint (see _player()).
        this._speechPlayer = null;
        this.targetEl = null;             // last speak() target (for toggle/stop button state)
        this._listeners = new Map();      // event -> Set<fn>

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
        // 'llm' from older prefs degrades to regex clean.
        this.markdownMode = storedMarkdown === 'off' ? 'off' : 'true';
        this._applyMarkdownModeToCheckboxes();

        const storedStitch = await this.storage.getPref(PREF_STITCH);
        this.stitch = storedStitch === 'true';
        this._setCheckbox(this.elements.stitch, this.stitch);

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

        // Markdown cleanup checkbox (off / true — server-side regex clean)
        const persistMarkdown = () => {
            this.markdownMode = this._readCheckbox(this.elements.markdownClean) ? 'true' : 'off';
            this.storage.setPref(PREF_MARKDOWN, this.markdownMode).catch(() => {});
        };
        this.elements.markdownClean?.addEventListener('nui-change', persistMarkdown);
        this.elements.markdownClean?.querySelector('input')?.addEventListener('change', persistMarkdown);

        // Long-text mode toggle (stitch = seamless joins, slow; default stream).
        const persistStitch = () => {
            this.stitch = this._readCheckbox(this.elements.stitch);
            this.storage.setPref(PREF_STITCH, String(this.stitch)).catch(() => {});
        };
        this.elements.stitch?.addEventListener('nui-change', persistStitch);
        this.elements.stitch?.querySelector('input')?.addEventListener('change', persistStitch);
    }

    _readSelectValue(event) {
        return (event.detail?.values?.[0]) || event.detail?.value || '';
    }

    // ============================================
    // Markdown cleanup (off / true — server-side regex)
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

    _applyMarkdownModeToCheckboxes() {
        this._setCheckbox(this.elements.markdownClean, this.markdownMode === 'true');
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

    // ============================================
    // Playback — delegated to SDK SpeechPlayer
    // ============================================

    /**
     * Lazily create the SpeechPlayer bound to the current endpoint.
     * Endpoint changes tear down the player so the next speak rebuilds it.
     */
    _player() {
        if (!this.endpoint) {
            this._showStatus('No TTS endpoint configured');
            return null;
        }
        if (!this._speechPlayer || this._speechPlayer.client.baseUrl !== this.endpoint.replace(/\/+$/, '')) {
            this._speechPlayer?.stop();
            this._speechPlayer = new SpeechPlayer({ baseUrl: this.endpoint });
            this._wirePlayerEvents(this._speechPlayer);
        }
        return this._speechPlayer;
    }

    _wirePlayerEvents(player) {
        player.on('state', ({ state, context }) => {
            if (context) this._applyButtonState(context, state);
            this._emit('state', { state, targetEl: context });
        });
        player.on('time', (t) => this._emit('time', t));
        player.on('error', ({ error }) => {
            console.warn('[TTS] playback error:', error?.message || error);
        });
    }

    /**
     * Speak plain text via the SDK SpeechPlayer. Download runs independently
     * of playback — pause/resume never aborts the stream.
     *
     * @param {string} text
     * @param {HTMLElement} targetEl
     * @param {object} [opts]
     * @param {'A'|'B'} [opts.slot]
     * @param {string} [opts.voice]
     */
    speak(text, targetEl, opts = {}) {
        if (!text) return;
        const player = this._player();
        if (!player) return;

        const slot = opts.slot || 'A';
        const override = opts.voice ? parseVoiceValue(opts.voice) : null;
        const resolved = override
            ? { model: this.defaultModel, voice: override.voiceId || 'default' }
            : this.resolveVoice(slot);

        this.targetEl = targetEl;
        player.speak({
            model: resolved.model,
            input: text,
            voice: resolved.voice,
            format: DEFAULT_FORMAT,
            speed: this.speed,
            clean: this.markdownMode === 'true',
            extraBody: { mode: this.stitch ? 'stitch' : 'stream' },
            context: targetEl,
        });
    }

    /**
     * Toggle for a target element:
     * - same target + loading → cancel; playing/paused → pause/resume
     * - different target → new speak
     */
    toggle(text, targetEl, opts = {}) {
        if (this._speechPlayer && this.targetEl === targetEl && this.isActive()) {
            if (this._speechPlayer.getPlaybackState() === 'loading') this.stop();
            else this.togglePause();
            return;
        }
        this.speak(text, targetEl, opts);
    }

    togglePause() { this._speechPlayer?.togglePause(); }
    pause() { this._speechPlayer?.pause(); }
    resume() { this._speechPlayer?.resume(); }

    /** Explicit cancel — same as stop(). */
    cancel() { this.stop(); }

    /** Seek to absolute seconds. Clamped to buffered/duration range. */
    seek(seconds) { this._speechPlayer?.seek(seconds); }
    seekBy(delta) { this._speechPlayer?.seekBy(delta); }

    /** Soft dismiss: pause if playing, keep download + audio. */
    dismiss() {
        if (!this._speechPlayer) return;
        this._speechPlayer.dismiss();
        this._emit('dismiss', { state: this._speechPlayer.getPlaybackState(), targetEl: this.targetEl });
    }

    /** Hard stop — abort download, tear down playback, idle. */
    stop() {
        const prevTarget = this.targetEl;
        this.targetEl = null;
        if (!this._speechPlayer) return;
        this._speechPlayer.stop();
        if (prevTarget) this._applyButtonState(prevTarget, 'idle');
    }

    getPlaybackState() { return this._speechPlayer?.getPlaybackState() ?? 'idle'; }
    isActive() { return this._speechPlayer?.isActive() ?? false; }
    isPlaying() { return this._speechPlayer?.isPlaying() ?? false; }
    isPaused() { return this._speechPlayer?.isPaused() ?? false; }
    isDownloading() { return this._speechPlayer?.isDownloading() ?? false; }

    getTimes() {
        return this._speechPlayer?.getTimes()
            ?? { currentTime: 0, duration: 0, bufferedEnd: 0, timelineMax: 0 };
    }

    setSeekDragging(dragging) { this._speechPlayer?.setSeekDragging(dragging); }

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
}

