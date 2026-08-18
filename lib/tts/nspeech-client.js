/**
 * nSpeech Client SDK — the canonical, single-file client for the nSpeech V3 API.
 * Pure ESM, zero dependencies. Browser + Node.js (18+; SpeechPlayer/EventStream
 * are browser-only: they use Audio/MediaSource/EventSource).
 *
 *   import { NSpeechClient, SpeechPlayer, EventStream, cleanMarkdown } from './nspeech-client.js';
 *
 *   // REST: speech, voices, presets, engine admin
 *   const nspeech = new NSpeechClient({ baseUrl: 'http://127.0.0.1:2233' });
 *   const res = await nspeech.speech({ model: 'nspeech', input: 'Hello.', voice: 'af_heart', clean: true });
 *
 *   // Playback: decoupled download + playback (pause never aborts the stream)
 *   const player = new SpeechPlayer({ client: nspeech });
 *   player.on('state', ({ state }) => render(state));
 *   player.on('time', (t) => timeline(t));
 *   player.speak({ model: 'nspeech', input: markdown, voice: 'af_heart', clean: true });
 *
 *   // Server progress feed (engine lifecycle, chunking percent/stage)
 *   const events = new EventStream({ baseUrl: 'http://127.0.0.1:2233', types: ['tts'] });
 *   events.on('progress', (e) => progressBar(e.percent, e.stage));
 *   events.connect();
 *
 * Markdown cleaning is a CLIENT responsibility: pass clean:true (or call
 * cleanMarkdown yourself) — never rely on the server's legacy extra_body.markdown.
 *
 * Contents:
 *   1. Errors
 *   2. Markdown cleaning (cleanMarkdown, expandAcronyms)
 *   3. EventEmitter / retry / voice cache
 *   4. NSpeechClient — REST API
 *   5. SpeechPlayer — streaming playback with pause/seek
 *   6. EventStream — /v1/admin/events SSE feed
 */

// ═══════════════════════════════════════════════════════════════════════════
//  1. Errors
// ═══════════════════════════════════════════════════════════════════════════

export class NSpeechError extends Error {
  constructor(message, code, status, requestId) {
    super(message);
    this.name = 'NSpeechError';
    this.code = code || 'unknown';
    this.status = status || 500;
    this.requestId = requestId || null;
  }
}

export class VoiceNotFoundError extends NSpeechError {
  constructor(voiceId, engine, requestId) {
    super(`Voice not found: ${voiceId} (engine: ${engine})`, 'voice_not_found', 404, requestId);
    this.name = 'VoiceNotFoundError';
    this.voiceId = voiceId;
    this.engine = engine;
  }
}

export class EngineError extends NSpeechError {
  constructor(message, engine, status, requestId) {
    super(message, 'engine_error', status || 503, requestId);
    this.name = 'EngineError';
    this.engine = engine;
  }
}

export class RateLimitError extends NSpeechError {
  constructor(message, retryAfter, requestId) {
    super(message, 'rate_limit_exceeded', 429, requestId);
    this.name = 'RateLimitError';
    this.retryAfter = retryAfter || 60;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  2. Markdown → speech-ready plain text (regex path, deterministic)
//
//  server/markdown-clean.js re-exports these (Node speech pipeline, legacy
//  extra_body.markdown); clients should clean before send (clean:true on
//  speech()/speak()). NO imports — must stay dependency-free.
//
//  Rules settled by F5 ear tests (2026-08-18): emphasis strips silently;
//  label colons (1–2 words, line-initial) merge with em-dash; clause colons
//  split into sentence + paragraph break; headers get terminal periods;
//  strikethrough drops (retracted text must not be spoken).
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Regex-based markdown cleanup. Fast, deterministic, no external calls.
 * @param {string} text — raw markdown
 * @returns {string} plain text suitable for TTS
 */
export function cleanMarkdown(text) {
  let t = text;

  // YAML frontmatter
  t = t.replace(/^---\s*\n[\s\S]*?\n---\s*\n/, '');

  // Images (drop entirely), links (keep link text)
  t = t.replace(/!\[.*?\]\(.+?\)/g, '');
  t = t.replace(/\[(.+?)\]\(.+?\)/g, '$1');

  // Bare URLs — drop (reading "aich-tee-tee-pee" is never right)
  t = t.replace(/https?:\/\/\S+/g, '');

  // Strikethrough — drop entirely: struck text is retracted, speaking it is wrong
  t = t.replace(/\s*~~[\s\S]*?~~\s*/g, ' ');

  // Emphasis (bold + italic) → strip silently. Tested 2026-08-18:
  // em-dash, quotes, and hyphen all break the flow more than they help;
  // the engine emphasizes better when left alone.
  t = t.replace(/\*\*(.+?)\*\*/g, '$1');
  t = t.replace(/__(.+?)__/g, '$1');
  t = t.replace(/\*(.+?)\*/g, '$1');
  t = t.replace(/(?<!\w)_(.+?)_(?!\w)/g, '$1');

  // Colon handling, two branches by left side:
  //  - Label (line-initial, 1-2 words: "A Rule:", "Third:") → em-dash merge.
  //    F5 compresses short segments and ignores their terminal punctuation,
  //    but an em-dash breaks the flow reliably even after short labels.
  //  - Clause (3+ words: "The answer is simple:") → period + paragraph
  //    break + capitalize: a real sentence boundary with a full pause.
  // Only colon+space — times (12:30) have no following space.
  t = t.replace(/(^|\n)(\S+(?: \S+)?): (\p{L})/gmu, (_m, br, left, ch) => br + left + ' — ' + ch);
  t = t.replace(/: (\p{L})/gu, (_m, ch) => '.\n\n' + ch.toUpperCase());

  // Code blocks (drop — reads poorly as TTS), inline code (keep content)
  t = t.replace(/```[\s\S]*?```/g, '');
  t = t.replace(/`(.+?)`/g, '$1');

  // Headers: strip '#' prefix (with or without following space — "#Title"
  // is common in pasted content), add trailing period if missing
  t = t.replace(/^(#{1,6})\s*(.+)$/gm, (_m, _hashes, title) => {
    const trimmed = title.trim();
    return /[.!?…]$/.test(trimmed) ? trimmed + '\n' : trimmed + '.\n';
  });

  // Standalone lines without terminal punctuation get a period — these are
  // headings/titles in sources that don't use '#' (plain-text articles,
  // pasted content). A line counts as standalone when bordered by blank
  // lines or text boundaries. Length cap: long lines are wrapped prose,
  // not headings — don't punctuate mid-thought.
  t = t.replace(/(?:^|\n\n)([^\n]{1,120})(?=\n\n|$)/g, (m, line) => {
    const trimmed = line.trim();
    if (!trimmed || /[.!?…:;,—–-]$/.test(trimmed)) return m;
    return m.slice(0, m.length - line.length) + trimmed + '.';
  });

  // Horizontal rules → paragraph break
  t = t.replace(/^\s*[-*_]{3,}\s*$/gm, '\n');

  // Blockquotes: strip '>' prefix
  t = t.replace(/^\s*>\s?/gm, '');

  // Unordered/ordered list markers → plain line
  t = t.replace(/^\s*[-*+]\s+/gm, '');
  t = t.replace(/^\s*\d+\.\s+/gm, '');

  // HTML comments and tags
  t = t.replace(/<!--[\s\S]*?-->/g, '');
  t = t.replace(/<\/?[a-zA-Z][^>]*>/g, '');

  // Normalize dashes: -- → —
  t = t.replace(/--/g, '—');

  // Acronyms → speakable form (engines pronounce "GLM" as a word otherwise)
  t = expandAcronyms(t);

  // Collapse 3+ consecutive newlines
  t = t.replace(/\n{3,}/g, '\n\n');

  return t.trim();
}

/**
 * Acronyms spoken letter-by-letter need explicit spelling for TTS engines,
 * which otherwise attempt word pronunciation ("GLM" → "glum"). Also splits
 * letter+digit compounds: "GLM5" → "G L M five", "K3" → "K three".
 */
const PRONOUNCED_ACRONYMS = new Set([
  'NASA', 'CUDA', 'NATO', 'UNESCO', 'SCUBA', 'RADAR', 'LASER', 'OK',
]);

const DIGIT_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];

function spellLetters(s) {
  return s.split('').join(' ');
}

function digitWord(d) {
  return DIGIT_WORDS[parseInt(d, 10)];
}

export function expandAcronyms(t) {
  // File extensions: "religion.md" → "religion dot m d". Without this,
  // engines read the dot as sentence end and "md" as the word "midi".
  // Run FIRST — the dot must not survive into other rules.
  t = t.replace(/\b([A-Za-z0-9_\-]+)\.(md|txt|json|js|ts|py|wav|mp3|pdf|html|css|yml|yaml|xml|png|jpg|jpeg|log|csv)\b/g,
    (_m, name, ext) => `${name} dot ${ext.split('').join(' ')}`);
  // Hyphen directly before an acronym run becomes a space ("F5-TTS" → "F5 TTS")
  t = t.replace(/([A-Za-z0-9])-(?=[A-Z]{2,}\b)/g, '$1 ');
  // Letter-run + trailing digits: GLM5, GPT4, RTX4090. Single digit → word,
  // multi-digit stays numeric (engines read "4090" acceptably).
  t = t.replace(/\b([A-Z]{2,})(\d+)\b/g, (_m, letters, digits) => {
    const spelled = spellLetters(letters);
    const num = digits.length === 1 ? digitWord(digits) : digits;
    return `${spelled} ${num}`;
  });
  // Single letter + single digit: K3, F5, B2
  t = t.replace(/\b([A-Z])(\d)\b/g, (_m, letter, d) => `${letter} ${digitWord(d)}`);
  // Plain letter runs: GLM, GPU, RLHF — unless pronounced as a word
  t = t.replace(/\b[A-Z]{2,}\b/g, (m) => (PRONOUNCED_ACRONYMS.has(m) ? m : spellLetters(m)));
  return t;
}

// ═══════════════════════════════════════════════════════════════════════════
//  3. Event Emitter / Retry / Voice Cache (internal infrastructure)
// ═══════════════════════════════════════════════════════════════════════════

class EventEmitter {
  constructor() {
    this._events = {};
  }

  on(event, fn) {
    if (!this._events[event]) this._events[event] = [];
    this._events[event].push(fn);
    return this;
  }

  off(event, fn) {
    if (!this._events[event]) return this;
    this._events[event] = this._events[event].filter(f => f !== fn);
    return this;
  }

  emit(event, data) {
    if (!this._events[event]) return;
    for (const fn of this._events[event]) {
      try { fn(data); } catch (err) { console.error(`[nspeech] event handler error (${event}):`, err); }
    }
  }
}

async function _retry(fn, opts = {}) {
  const maxRetries = opts.maxRetries ?? 3;
  const baseDelay = opts.baseDelay ?? 1000;
  const maxDelay = opts.maxDelay ?? 10000;

  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      // Don't retry on 4xx (client errors) — only 5xx and network failures
      if (err.status && err.status >= 400 && err.status < 500) {
        throw err;
      }
      if (attempt < maxRetries) {
        const delay = Math.min(baseDelay * Math.pow(2, attempt) + Math.random() * 1000, maxDelay);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastError;
}

class VoiceCache {
  constructor(ttlMs = 300000) { // 5 minutes default
    this._cache = new Map();
    this._ttl = ttlMs;
  }

  get(engine) {
    const entry = this._cache.get(engine);
    if (!entry) return null;
    if (Date.now() - entry.time > this._ttl) {
      this._cache.delete(engine);
      return null;
    }
    return entry.data;
  }

  set(engine, data) {
    this._cache.set(engine, { data, time: Date.now() });
  }

  clear(engine) {
    if (engine) this._cache.delete(engine);
    else this._cache.clear();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  4. NSpeechClient — REST API
// ═══════════════════════════════════════════════════════════════════════════

/**
 * @param {object} opts
 * @param {string} [opts.baseUrl='http://127.0.0.1:2233']
 * @param {AbortSignal} [opts.signal] — default abort signal for all requests
 * @param {boolean} [opts.debug=false] — enable debug logging
 * @param {number} [opts.maxRetries=3] — max retries for network failures
 * @param {number} [opts.cacheTtl=300000] — voice cache TTL in ms (0 to disable)
 */
export class NSpeechClient {
  constructor(opts = {}) {
    this.baseUrl = (opts.baseUrl || 'http://127.0.0.1:2233').replace(/\/+$/, '');
    this.signal = opts.signal || null;
    this.debug = opts.debug || false;
    this.maxRetries = opts.maxRetries ?? 3;
    this._voiceCache = opts.cacheTtl !== 0 ? new VoiceCache(opts.cacheTtl) : null;
    this._requestCounter = 0;
  }

  _log(...args) {
    if (this.debug) console.log('[nspeech]', ...args);
  }

  _requestId() {
    return `req_${Date.now()}_${++this._requestCounter}`;
  }

  // ── TTS ──────────────────────────────────────────────────────────────────

  /**
   * Generate speech. Returns the raw Response for streaming.
   *
   * @param {object} params
   * @param {string} params.model — engine model (nspeech, minimax, elevenlabs, gemini, xai)
   * @param {string} params.input — text to speak
   * @param {string} [params.voice='default'] — voice ID (can be a preset ID)
   * @param {string} [params.format='mp3'] — mp3, opus, aac, flac, wav, pcm, pcm_f32
   * @param {number} [params.speed=1.0] — speaking speed
   * @param {string} [params.instructions] — style direction
   * @param {boolean} [params.clean=false] — client-side markdown clean (cleanMarkdown)
   * @param {object} [params.extraBody] — engine-specific extra_body fields
   * @param {AbortSignal} [params.signal] — per-request abort signal
   * @returns {Promise<Response>}
   */
  async speech({ model, input, voice, format, speed, instructions, clean, extraBody, signal } = {}) {
    if (!model || !input) throw new Error('model and input are required');
    const text = clean ? cleanMarkdown(input) : input;
    const body = {
      model,
      input: text,
      voice: voice || 'default',
      response_format: format || 'mp3',
      speed: speed ?? 1.0,
      instructions: instructions || undefined,
      extra_body: extraBody || undefined,
    };
    if (body.instructions === undefined) delete body.instructions;
    if (body.extra_body === undefined) delete body.extra_body;

    const reqId = this._requestId();
    this._log(`[${reqId}] speech: ${model} "${text.slice(0, 50)}..." voice=${voice}`);

    return _retry(async () => {
      const res = await this._fetch('/v1/audio/speech', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: signal || this.signal,
      }, reqId);
      this._log(`[${reqId}] speech response: ${res.status} ${res.headers.get('content-type')}`);
      return res;
    }, { maxRetries: this.maxRetries });
  }

  /**
   * Generate speech with event tracking. Returns an EventEmitter.
   *
   * Events:
   *   start    — request sent
   *   ttfb     — first byte received ({ timeMs })
   *   progress — download progress ({ bytes, totalBytes })
   *   complete — download finished ({ audioUrl, timeMs, bytes })
   *   error    — error occurred ({ error })
   *
   * @param {object} params — same as speech()
   * @returns {EventEmitter & { response: Promise<Response>, stop: function }}
   */
  speechStream(params = {}) {
    const emitter = new EventEmitter();
    const reqId = this._requestId();
    let aborted = false;

    const responsePromise = (async () => {
      const startTime = performance.now();
      emitter.emit('start', { requestId: reqId, model: params.model, inputLen: params.input?.length });

      try {
        const res = await this.speech({ ...params, signal: params.signal });
        if (aborted) return null;

        const contentLength = parseInt(res.headers.get('content-length') || '0', 10);
        const reader = res.body.getReader();
        const chunks = [];
        let receivedBytes = 0;
        let firstChunk = false;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (aborted) {
            reader.cancel();
            return null;
          }
          if (!firstChunk && value?.length) {
            firstChunk = true;
            const ttfb = performance.now() - startTime;
            emitter.emit('ttfb', { requestId: reqId, timeMs: ttfb });
            this._log(`[${reqId}] TTFB: ${ttfb.toFixed(0)}ms`);
          }
          chunks.push(value);
          receivedBytes += value.length;
          emitter.emit('progress', { requestId: reqId, bytes: receivedBytes, totalBytes: contentLength || null });
        }

        const blob = new Blob(chunks, { type: res.headers.get('content-type') || 'audio/mpeg' });
        const audioUrl = URL.createObjectURL(blob);
        const totalTime = performance.now() - startTime;
        emitter.emit('complete', { requestId: reqId, audioUrl, timeMs: totalTime, bytes: receivedBytes });
        this._log(`[${reqId}] complete: ${receivedBytes} bytes in ${totalTime.toFixed(0)}ms`);

        return res;
      } catch (err) {
        if (!aborted) {
          emitter.emit('error', { requestId: reqId, error: err });
          this._log(`[${reqId}] error:`, err.message);
        }
        throw err;
      }
    })();

    return Object.assign(emitter, {
      response: responsePromise,
      stop: () => { aborted = true; },
    });
  }

  // ── Voices ───────────────────────────────────────────────────────────────

  /**
   * List voices for an engine. Includes built-in, cloned, blended, and preset voices.
   * Uses cache if enabled.
   *
   * @param {string} [engine] — engine name. Defaults to current local engine.
   * @param {AbortSignal} [signal]
   * @param {boolean} [forceRefresh=false] — bypass cache
   * @returns {Promise<{voices: Array}>}
   */
  async listVoices(engine, signal, forceRefresh = false) {
    const cacheKey = engine || '_default';
    if (!forceRefresh && this._voiceCache) {
      const cached = this._voiceCache.get(cacheKey);
      if (cached) {
        this._log(`voices cache hit: ${cacheKey}`);
        return cached;
      }
    }

    const reqId = this._requestId();
    const url = engine ? `/v1/voices?engine=${encodeURIComponent(engine)}` : '/v1/voices';
    this._log(`[${reqId}] listVoices: ${engine || 'current'}`);

    const data = await _retry(async () => {
      const res = await this._fetch(url, { signal: signal || this.signal }, reqId);
      return res.json();
    }, { maxRetries: this.maxRetries });

    if (this._voiceCache) {
      this._voiceCache.set(cacheKey, data);
    }
    return data;
  }

  /**
   * Invalidate voice cache for an engine (or all).
   *
   * @param {string} [engine] — engine name, or omit to clear all
   */
  clearVoiceCache(engine) {
    if (this._voiceCache) {
      this._voiceCache.clear(engine);
      this._log(`voice cache cleared: ${engine || 'all'}`);
    }
  }

  /**
   * Clone a voice from reference audio. Persists the voice.
   * Invalidates voice cache on success.
   *
   * @param {object} params
   * @param {string} params.model — engine model
   * @param {string} params.name — voice name
   * @param {File|Blob} params.audio — reference audio
   * @param {string} [params.promptText] — transcript of the audio
   * @param {AbortSignal} [params.signal]
   * @returns {Promise<object>}
   */
  async cloneVoice({ model, name, audio, promptText, signal } = {}) {
    if (!model || !name || !audio) throw new Error('model, name, and audio are required');
    const reqId = this._requestId();
    this._log(`[${reqId}] cloneVoice: ${model} "${name}"`);

    const formData = new FormData();
    formData.append('name', name);
    formData.append('audio', audio);
    if (promptText) formData.append('prompt_text', promptText);

    const result = await _retry(async () => {
      const res = await this._fetch(`/v1/voices/clone?engine=${encodeURIComponent(model)}`, {
        method: 'POST',
        body: formData,
        signal: signal || this.signal,
      }, reqId);
      return res.json();
    }, { maxRetries: this.maxRetries });

    this.clearVoiceCache(model);
    this._log(`[${reqId}] cloneVoice success: ${result.voice_id || name}`);
    return result;
  }

  /**
   * Preview a cloned voice without persisting it. Returns streaming MP3 audio.
   *
   * @param {object} params
   * @param {string} params.model — engine model
   * @param {File|Blob} params.audio — reference audio
   * @param {string} [params.testPhrase] — text to speak for preview
   * @param {AbortSignal} [params.signal]
   * @returns {Promise<Response>}
   */
  async previewVoice({ model, audio, testPhrase, signal } = {}) {
    if (!model || !audio) throw new Error('model and audio are required');
    const reqId = this._requestId();
    this._log(`[${reqId}] previewVoice: ${model}`);

    const formData = new FormData();
    formData.append('audio', audio);
    if (testPhrase) formData.append('test_phrase', testPhrase);

    return _retry(async () => {
      return this._fetch(`/v1/voices/preview?engine=${encodeURIComponent(model)}`, {
        method: 'POST',
        body: formData,
        signal: signal || this.signal,
      }, reqId);
    }, { maxRetries: this.maxRetries });
  }

  /**
   * Mix two voices (Kokoro only). Invalidates voice cache on success.
   *
   * @param {object} params
   * @param {string} params.name — name for the blended voice
   * @param {string} params.voiceA — first voice ID
   * @param {string} params.voiceB — second voice ID
   * @param {number} [params.ratio=0.5] — blend ratio (0 = all A, 1 = all B)
   * @param {string} [params.engine] — engine name
   * @param {AbortSignal} [params.signal]
   * @returns {Promise<object>}
   */
  async mixVoices({ name, voiceA, voiceB, ratio, engine, signal } = {}) {
    if (!name || !voiceA || !voiceB) throw new Error('name, voiceA, and voiceB are required');
    const reqId = this._requestId();
    this._log(`[${reqId}] mixVoices: ${voiceA} + ${voiceB} -> ${name}`);

    const params = new URLSearchParams();
    if (engine) params.set('engine', engine);
    const query = params.toString();

    const result = await _retry(async () => {
      const res = await this._fetch('/v1/voices/mix' + (query ? `?${query}` : ''), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, voice_a: voiceA, voice_b: voiceB, ratio: ratio ?? 0.5 }),
        signal: signal || this.signal,
      }, reqId);
      return res.json();
    }, { maxRetries: this.maxRetries });

    this.clearVoiceCache(engine);
    this._log(`[${reqId}] mixVoices success: ${result.voice_id || name}`);
    return result;
  }

  /**
   * Delete a voice or preset. Invalidates voice cache on success.
   *
   * @param {string} engine — engine name
   * @param {string} voiceId — voice or preset ID to delete
   * @param {AbortSignal} [signal]
   * @returns {Promise<object>}
   */
  async deleteVoice(engine, voiceId, signal) {
    if (!engine || !voiceId) throw new Error('engine and voiceId are required');
    const reqId = this._requestId();
    this._log(`[${reqId}] deleteVoice: ${engine} "${voiceId}"`);

    const result = await _retry(async () => {
      const res = await this._fetch(`/v1/voices/${encodeURIComponent(voiceId)}?engine=${encodeURIComponent(engine)}`, {
        method: 'DELETE',
        signal: signal || this.signal,
      }, reqId);
      return res.json();
    }, { maxRetries: this.maxRetries });

    this.clearVoiceCache(engine);
    this._log(`[${reqId}] deleteVoice success`);
    return result;
  }

  // ── Presets ──────────────────────────────────────────────────────────────

  /**
   * Create or update a voice preset. Invalidates voice cache on success.
   *
   * @param {object} params
   * @param {string} params.engine — engine name
   * @param {string} params.id — unique preset ID (URL-safe slug)
   * @param {string} params.name — display name
   * @param {string} params.voice — base voice ID
   * @param {string} [params.instructions] — style instructions
   * @param {number} [params.speed] — default speed
   * @param {object} [params.extraBody] — additional extra_body fields
   * @param {AbortSignal} [params.signal]
   * @returns {Promise<object>}
   */
  async createPreset({ engine, id, name, voice, instructions, speed, extraBody, signal } = {}) {
    if (!engine || !id || !name || !voice) throw new Error('engine, id, name, and voice are required');
    const reqId = this._requestId();
    this._log(`[${reqId}] createPreset: ${engine} "${id}" -> ${voice}`);

    const result = await _retry(async () => {
      const res = await this._fetch('/v1/voices/preset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ engine, id, name, voice, instructions, speed, extra_body: extraBody }),
        signal: signal || this.signal,
      }, reqId);
      return res.json();
    }, { maxRetries: this.maxRetries });

    this.clearVoiceCache(engine);
    this._log(`[${reqId}] createPreset success`);
    return result;
  }

  /**
   * Delete a preset. Invalidates voice cache on success.
   *
   * @param {string} engine — engine name
   * @param {string} id — preset ID
   * @param {AbortSignal} [signal]
   * @returns {Promise<object>}
   */
  async deletePreset(engine, id, signal) {
    return this.deleteVoice(engine, id, signal);
  }

  /**
   * List presets for an engine.
   *
   * @param {string} engine — engine name
   * @param {AbortSignal} [signal]
   * @returns {Promise<Array>}
   */
  async listPresets(engine, signal) {
    const data = await this.listVoices(engine, signal);
    return (data.voices || []).filter(function(v) { return v.voice_type === 'preset'; });
  }

  // ── Engine Admin ─────────────────────────────────────────────────────────

  /**
   * Switch the active local engine.
   *
   * @param {string} engine — engine name (kokoro, chatterbox, minimax, ...)
   * @param {function} [onProgress] — callback for SSE events ({ stage, engine })
   * @param {AbortSignal} [signal]
   * @returns {Promise<object>}
   */
  async switchEngine(engine, onProgress, signal) {
    if (!engine) throw new Error('engine is required');
    const reqId = this._requestId();
    this._log(`[${reqId}] switchEngine: ${engine}`);

    const res = await this._fetch('/v1/admin/engine', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ engine }),
      signal: signal || this.signal,
    }, reqId);

    if (onProgress && res.body) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              onProgress(data);
              this._log(`[${reqId}] switchEngine progress: ${data.stage}`);
            } catch (_) {}
          }
        }
      }
    }
    return res.json().catch(function() { return { status: 'switched' }; });
  }

  /**
   * List all available engines.
   *
   * @param {AbortSignal} [signal]
   * @returns {Promise<object>}
   */
  async listEngines(signal) {
    const res = await this._fetch('/v1/admin/engines', { signal: signal || this.signal });
    return res.json();
  }

  /**
   * Get the current engine name.
   *
   * @param {AbortSignal} [signal]
   * @returns {Promise<string>}
   */
  async getEngine(signal) {
    const res = await this._fetch('/engine', { signal: signal || this.signal });
    const data = await res.json();
    return data.engine;
  }

  /**
   * Health check.
   *
   * @param {AbortSignal} [signal]
   * @returns {Promise<object>}
   */
  async getStatus(signal) {
    const res = await this._fetch('/health', { signal: signal || this.signal });
    return res.json();
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  async _fetch(path, opts, reqId) {
    const url = this.baseUrl + path;
    const res = await fetch(url, opts);
    if (!res.ok) {
      let detail = 'HTTP ' + res.status;
      let code = 'unknown';
      let voiceId = null;
      let engine = null;

      try {
        const err = await res.json();
        if (err.error) {
          detail = err.error.message || detail;
          code = err.error.code || code;
        } else if (err.message) {
          detail = err.message;
        }
        if (err.error?.param === 'voice') voiceId = path.split('/').pop();
        engine = new URLSearchParams(path.split('?')[1] || '').get('engine');
      } catch (_) {}

      if (res.status === 404 && code === 'voice_not_found') {
        throw new VoiceNotFoundError(voiceId || 'unknown', engine || 'unknown', reqId);
      }
      if (res.status === 429) {
        throw new RateLimitError(detail, 60, reqId);
      }
      if (res.status >= 500) {
        throw new EngineError(detail, engine || 'unknown', res.status, reqId);
      }
      throw new NSpeechError(detail, code, res.status, reqId);
    }
    return res;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  5. SpeechPlayer — streaming playback (browser only)
//
//  Decoupled download/playback: the fetch reader runs to completion
//  regardless of pause/resume; MSE appends while paused so seeking into
//  not-yet-played regions works. Blob fallback for non-MSE environments
//  rebuilds the object URL periodically, preserving currentTime.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Events:
 *   state             — { state, context }   idle | loading | playing | paused
 *   time              — { currentTime, duration, bufferedEnd, timelineMax, bytesReceived, downloadComplete }
 *   download-progress — { bytes, chunks }
 *   download-complete — { bytes, chunks }
 *   error             — { error }
 *   dismiss           — { state, context }
 *
 * @param {object} opts
 * @param {NSpeechClient} [opts.client] — existing client (created from baseUrl if omitted)
 * @param {string} [opts.baseUrl] — used when no client is passed
 * @param {boolean} [opts.debug=false]
 */
export class SpeechPlayer {
  constructor(opts = {}) {
    this.client = opts.client || new NSpeechClient({ baseUrl: opts.baseUrl, debug: opts.debug });
    this._emitter = new EventEmitter();

    this.audio = null;
    this.context = null;               // opaque per-speak token (e.g. a DOM element)
    this._playbackState = 'idle';      // idle | loading | playing | paused
    this._rafId = null;
    this._dragSeeking = false;
    this._timelineMax = 0;
    this._speechAbort = null;
    this._mediaSource = null;
    this._sourceBuffer = null;
    this._objectUrl = null;
    this._mseQueue = [];
    this._mseAppending = false;
    this._mseEnded = false;
    this._downloadComplete = false;
    this._bytesReceived = 0;
    this._chunkCount = 0;
  }

  on(event, fn) {
    this._emitter.on(event, fn);
    return () => this._emitter.off(event, fn);
  }

  off(event, fn) {
    this._emitter.off(event, fn);
  }

  _emit(event, data) {
    this._emitter.emit(event, data);
  }

  /**
   * Speak text. Starts an independent download of the full speech stream;
   * playback can pause/resume freely while download continues.
   *
   * @param {object} params — NSpeechClient.speech() params, plus:
   * @param {*} [params.context] — opaque token echoed in events (e.g. message element)
   */
  speak(params = {}) {
    if (!params.input) throw new Error('SpeechPlayer.speak: params.input required');
    if (!params.model) throw new Error('SpeechPlayer.speak: params.model required');

    this.stop();

    this.context = params.context ?? null;
    this._downloadComplete = false;
    this._bytesReceived = 0;
    this._chunkCount = 0;
    this._timelineMax = 0;
    this._setPlaybackState('loading');
    this._startTimeLoop();

    const speechAbort = new AbortController();
    this._speechAbort = speechAbort;

    const audio = new Audio();
    audio.preload = 'auto';
    this.audio = audio;
    this._wireAudioElement(audio);

    const useMse = typeof MediaSource !== 'undefined'
      && MediaSource.isTypeSupported
      && MediaSource.isTypeSupported('audio/mpeg');

    if (useMse) {
      this._startMsePipeline(audio);
    }

    this._runDownload(speechAbort, useMse, params).catch((err) => {
      if (speechAbort.signal.aborted) return;
      this._emit('error', { error: err });
      this.stop();
    });
  }

  /**
   * Toggle for a context token:
   * - same context + loading → cancel; same context + playing/paused → pause/resume
   * - different context → new speak
   */
  toggle(params = {}) {
    const ctx = params.context ?? null;
    if (this.context === ctx && ctx !== null && this.isActive()) {
      if (this._playbackState === 'loading') this.stop();
      else this.togglePause();
      return;
    }
    this.speak(params);
  }

  /** Pause if playing, resume if paused. Never touches the download. */
  togglePause() {
    if (!this.audio) return;
    if (this._playbackState === 'playing') {
      this.pause();
      return;
    }
    if (this._playbackState === 'paused' || this._playbackState === 'loading') {
      this.resume();
    }
  }

  pause() {
    if (!this.audio) return;
    if (this._playbackState !== 'playing') return;
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
    a.play().catch(() => {});
  }

  /** Explicit cancel — same as stop(). */
  cancel() {
    this.stop();
  }

  /** Seek to absolute seconds. Clamped to buffered/duration range. */
  seek(seconds) {
    if (!this.audio) return;
    if (typeof seconds !== 'number' || !Number.isFinite(seconds)) {
      throw new Error('SpeechPlayer.seek: seconds must be a finite number');
    }
    const max = this._seekMax();
    const t = Math.max(0, Math.min(seconds, max > 0 ? max : seconds));
    try {
      this.audio.currentTime = t;
    } catch (_) {}
    this._emitTime();
  }

  seekBy(delta) {
    if (!this.audio) return;
    if (typeof delta !== 'number' || !Number.isFinite(delta)) {
      throw new Error('SpeechPlayer.seekBy: delta must be a finite number');
    }
    this.seek((this.audio.currentTime || 0) + delta);
  }

  /** Soft dismiss: pause if playing, keep download + audio. */
  dismiss() {
    if (!this.audio && !this._speechAbort) return;
    if (this._playbackState === 'playing') this.pause();
    this._emit('dismiss', { state: this._playbackState, context: this.context });
  }

  /** Hard stop — abort download, tear down MSE/blob, idle. */
  stop() {
    this._stopTimeLoop();
    const prevContext = this.context;

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

    this.context = null;
    this._dragSeeking = false;
    this._timelineMax = 0;
    this._downloadComplete = false;
    this._bytesReceived = 0;
    this._chunkCount = 0;

    if (this._playbackState !== 'idle' || prevContext) {
      this._playbackState = 'idle';
      this._emit('state', { state: 'idle', context: null });
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

  // ── Internals ────────────────────────────────────────────────────────────

  _setPlaybackState(state) {
    if (this._playbackState === state) return;
    this._playbackState = state;
    this._emit('state', { state, context: this.context });
    this._emitTime();
  }

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
      this._emit('error', { error: new Error('playback failed') });
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
      if (this._playbackState === 'loading') {
        audio.play().catch(() => {});
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
        // Fall through to blob fallback in _runDownload.
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
      }
      return;
    }

    if (this._downloadComplete && !this._mseEnded) {
      this._mseEnded = true;
      try {
        ms.endOfStream();
      } catch (_) {}
      this._emitTime();
    }
  }

  /** Fetch speech body. Runs to completion unless aborted via stop(). */
  async _runDownload(speechAbort, useMse, params) {
    const res = await this.client.speech({ ...params, signal: speechAbort.signal });
    if (speechAbort.signal.aborted) return;
    if (!res.body) throw new Error('no response body');

    const reader = res.body.getReader();
    const mime = res.headers.get('content-type') || 'audio/mpeg';
    const fallbackChunks = [];
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
        // Progressive blob playback: refresh object URL periodically.
        if (this._chunkCount === 1 || this._chunkCount % 8 === 0) {
          this._applyFallbackBlob(fallbackChunks, mime, false);
        }
      }

      this._emit('download-progress', { bytes: this._bytesReceived, chunks: this._chunkCount });
    }

    this._downloadComplete = true;
    if (useFallback) {
      this._applyFallbackBlob(fallbackChunks, mime, true);
    } else {
      this._pumpMseQueue();
    }
    this._emit('download-complete', { bytes: this._bytesReceived, chunks: this._chunkCount });
    this._emitTime();
  }

  /** Blob fallback when MSE is unavailable. Preserves currentTime across swaps. */
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

  _startTimeLoop() {
    if (this._rafId) return;
    const tick = () => {
      this._rafId = null;
      if (!this.audio || this._playbackState === 'idle') return;
      if (!this._dragSeeking) this._emitTime();
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

// ═══════════════════════════════════════════════════════════════════════════
//  6. EventStream — /v1/admin/events SSE feed (browser only)
//
//  Server events carry { ts, type, message, ...meta }. Type 'tts' events
//  from long-form chunking runs include progress fields:
//    stage:   'plan' | 'generating' | 'aligning' | 'trimmed' | 'done' | 'failed'
//    chunk, totalChunks, percent (0–100)
//  Events are NOT correlated to a specific request — with concurrent jobs the
//  feed interleaves. Fine for single-user dashboards/chat apps.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Events:
 *   event     — every event (after type filter): { ts, type, message, ...meta }
 *   progress  — 'tts' events only: { stage, chunk, totalChunks, percent, message }
 *   open      — connection established
 *   close     — connection closed (reconnect attempts follow unless close() was called)
 *
 * @param {object} opts
 * @param {string} opts.baseUrl — nSpeech base URL (required)
 * @param {string[]} [opts.types] — event type allowlist; omit for all events
 * @param {boolean} [opts.reconnect=true] — auto-reconnect with backoff
 * @param {number} [opts.maxReconnectDelay=30000]
 */
export class EventStream {
  constructor(opts = {}) {
    if (!opts.baseUrl) throw new Error('EventStream: baseUrl required');
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.types = opts.types || null;
    this.reconnect = opts.reconnect !== false;
    this.maxReconnectDelay = opts.maxReconnectDelay || 30000;

    this._emitter = new EventEmitter();
    this._es = null;
    this._closed = false;
    this._reconnectDelay = 1000;
    this._reconnectTimer = null;
  }

  on(event, fn) {
    this._emitter.on(event, fn);
    return () => this._emitter.off(event, fn);
  }

  off(event, fn) {
    this._emitter.off(event, fn);
  }

  connect() {
    if (this._es || this._closed) return;
    const es = new EventSource(this.baseUrl + '/v1/admin/events');
    this._es = es;

    es.onopen = () => {
      if (this._es !== es) return;
      this._reconnectDelay = 1000;
      this._emitter.emit('open', {});
    };

    es.onmessage = (msg) => {
      if (this._es !== es) return;
      let event;
      try {
        event = JSON.parse(msg.data);
      } catch (_) {
        return;
      }
      if (this.types && !this.types.includes(event.type)) return;
      this._emitter.emit('event', event);
      if (event.type === 'tts') {
        this._emitter.emit('progress', {
          stage: event.stage || null,
          chunk: event.chunk ?? null,
          totalChunks: event.totalChunks ?? null,
          percent: event.percent ?? null,
          message: event.message,
        });
      }
    };

    es.onerror = () => {
      if (this._es !== es) return;
      es.close();
      this._es = null;
      this._emitter.emit('close', {});
      if (!this._closed && this.reconnect) {
        this._reconnectTimer = setTimeout(() => {
          this._reconnectTimer = null;
          this.connect();
        }, this._reconnectDelay);
        this._reconnectDelay = Math.min(this._reconnectDelay * 2, this.maxReconnectDelay);
      }
    };
  }

  close() {
    this._closed = true;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this._es) {
      this._es.close();
      this._es = null;
    }
  }
}
