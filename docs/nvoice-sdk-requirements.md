# nVoice SDK — Chat-App Integration Requirements

> **Audience:** the maintainer of nVoice (`D:\DEV\nVoice`). Authored from the chat-app side (`LLM-Gateway-Chat`) after a full read of `sdk/nVoiceClient.js`, `src/nvoice/worker_routes.py`, `src/nvoice/wakeword.py`, `server/api/assistant.js`, and `web/pages/assistant.html` (2026-09-03).
> **Goal:** the browser SDK offers EVERYTHING the chat app needs for voice integration. The chat app must never construct an nVoice URL, run a VAD, match a command phrase, or buffer PCM — all of that is SDK/endpoint concern.

## Integration shape (chat-app side, for context)

Two modes over ONE conversation:

1. **Dictation (normal mode)** — mic button in the chat input. Live raw transcript previews into the input field while speaking. User hits **Done** → SDK cleans the accumulated raw text → cleaned text replaces the input content → user reviews and presses the normal Send button. Voice replaces typing; nothing else changes.
2. **Assistant (hands-free mode)** — per-conversation toggle. Always-listening: wake phrase → capture utterance → end-by-voice-command → SDK cleans the utterance → chat app sends it to the model automatically (tagged as voice input). Replies are auto-spoken via the chat app's existing nSpeech TTS. The conversation's system prompt carries a TTS-friendly-output block while the mode is on.

Transport is a same-origin relay through the chat backend (browser → `https://chat-host/api/stt/*` → nVoice), mirroring the existing `/api/tts/*` pattern — nVoice binds localhost on the server host, and the nPort cutover makes 443 the only public surface. Consequence: **the SDK runs on the chat origin, not the nVoice origin** — this drives requirement R1.

## What already exists (do NOT rebuild)

| Piece | Where | Status |
|---|---|---|
| Realtime STT WS (PCM f32 16k in, transcript/telemetry JSON out) | `WS /v1/realtime/ws` | production, user-verified |
| Session creation | `GET /v1/realtime/sessions` | works |
| "ok kimi" acoustic wake detector (worker-side, kimi_wake.onnx, `{type:"wake"}`) | `WS /v1/wakeword/ws` + `src/nvoice/wakeword.py` | trained + shipped, recall ~72-80%, FP/hr 3-6 @ thr 0.6-0.7 |
| SDK kimi state machine (sleep→command→transcribing, local command match listen/stop/send, Cyrillic→Latin normalization, text-command fallback when acoustic wake misses, false-wake resume, 4s command timeout) | `nVoiceClient.js` `enableKimiWakeWord()` + `_kimi*` | works, dashboard-shaped |
| One-shot LLM cleanup (`clean`/`format`/`compact`, EN+DE, ~1s short input) | `POST /v1/audio/cleanup {text,mode}` → `{text}` | E2E verified 2026-09-02 |
| Server-side assistant layer (pause-triggered cleanup, paragraphs, undo commands) | `?assistant=1` on realtime WS | works, dashboard-only |
| Pre-wake buffer (anti first-word clipping), endpointing/hang-up, recording-to-WAV debug | `nVoiceClient.js` | works |

The chat integration needs **neither** the local Silero WASM VAD (assistant mode uses the worker detector; dictation mode is button-gated) **nor** the `?assistant=1` segmented cleanup (one-shot cleanup on Done is the contract). Integration should be ort.js/silero_vad.onnx-free.

## Requirements

### R1 — Base-URL handling (BLOCKER)

Today only the session fetch honors `serverUrl`; both WS connects hardcode `window.location.host` and bare `/v1/*` paths (`nVoiceClient.js` ~line 352 and in `start()`). On the chat origin that hits the chat backend, not nVoice.

- One config drives every request: `new nVoiceClient({ serverUrl, basePath })`.
  - `serverUrl` absolute (`https://host:2245`) OR same-origin (`''`) + `basePath` (e.g. `/api/stt`).
  - Applies to: session fetch, realtime WS, wakeword WS, cleanup POST. WS URL derived from serverUrl (`http→ws`, `https→wss`) or from `location` when same-origin.
- Acceptance: SDK served from `https://chat-host/chat/` works against `serverUrl: '', basePath: '/api/stt'` with zero nVoice-origin contact.

### R2 — Dictation API (REQUIRED)

- SDK owns a raw transcript buffer: append finals, track provisional. `getRawText()` / `clearRawText()`.
- `async cleanup(text, mode = 'clean')` → string. Wraps `POST /v1/audio/cleanup`; throws on 4xx/5xx (fail loud, the app shows the error and keeps the raw text).
- Chat flow this enables: `start()` → transcript events preview → `const cleaned = await client.cleanup(client.getRawText())`.

### R3 — Assistant mode API (REQUIRED)

A dedicated wrapper over the existing kimi state machine — the dashboard flow (`ok kimi` → "listen" → dictate → `ok kimi send`) is one command too many for chat. Target flow: **`ok kimi` → immediately capturing → end command → cleaned text delivered**.

- `enableAssistantMode({ endCommands?, cleanup = 'clean' | 'format' | false, autoListen = true })`.
- `autoListen: true` — wake goes straight to capturing, no "listen" gate.
- End command (existing stop/send vocabulary, configurable phrase list) finishes capture; SDK then runs cleanup internally and emits ONE event:
  - `assistantMessage { raw, text }` — `text` is cleaned (or `raw` when `cleanup: false` / cleanup endpoint failed — emit `assistantError` on cleanup failure and still deliver raw).
  - Cancel vocabulary → `assistantCancel`, nothing delivered, back to listening.
- Keep emitting `kimiState` (or rename `assistantState`) for UI: `listening | capturing | processing`.
- Existing acoustic-wake-miss text fallback and false-wake resume logic carry over unchanged.

### R4 — Echo cancellation for hands-free (REQUIRED)

Desktop capture defaults to raw (no AEC/NS/AGC: `useProcessing = rawAudio ? false : isMobile`). Assistant mode plays TTS through speakers with the mic open — without AEC the assistant transcribes itself and the wake detector hears the TTS.

- Constructor option `audioProcessing: true` forcing `echoCancellation/noiseSuppression/autoGainControl` on any platform (or force it inside `enableAssistantMode`).
- Note for the maintainer: browser AEC only removes audio played through the SAME device/output — good enough here (TTS plays in the same browser).

### R5 — Capture pause hooks (RECOMMENDED)

`pauseCapture()` / `resumeCapture()` — gate the worklet so no frames reach either WS while the app plays TTS (belt-and-braces behind R4's AEC; also the deterministic way to prevent self-trigger when AEC is unavailable, e.g. raw-audio desktop setups). Barge-in stays possible because R4 keeps the detector usable during playback; apps choose pause-vs-AEC.

### R6 — Reconnect with backoff (RECOMMENDED)

Assistant mode = 2 long-lived WS (realtime + wakeword). Today an nVoice bounce emits `error`/`disconnected` and stays dead (chat app has the same bug class as issue #31 against its own MCP/TTS connections). SDK should auto-reconnect both sockets with escalating backoff, re-arm wake state, and emit `ready` on re-attach. Permanent failure (engine gone, close code 4000/4503) must NOT retry silently forever — surface a terminal `error`.

### R7 — Wakeword detector concurrency (HARDENING)

`get_detector()` is a process-wide singleton; `wakeword_ws` calls `reset()` on session close. Two concurrent sessions (two chat tabs, or chat + dashboard) share one rolling buffer — feeds interleave and the second close wipes the first's state. For always-on assistant mode this WILL happen.

- Per-session detector state (share the loaded ONNX sessions read-only, per-connection rolling buffer + latch), or fail loud: reject a second concurrent session with a distinct close code. Isolation preferred — the cost is ~28ms per 2.6s window per session.

### R8 — Docs sync

`sdk/README.md` is stale (auto-sleep removed 2026-08-07, mentions PeerConnection/DataChannel, no kimi/assistant API). Rewrite against the new surface; update `documentation/nVoice_API.md` (wakeword WS is undocumented there) and `Agents.md`.

## Explicitly NOT requested

- **True keyword spotting beyond "ok kimi"** — the trained marker is fixed; retraining is out of scope. End/cancel vocabulary is text-matched and already multilingual-tolerant (Cyrillic normalization).
- **`/v1/assistant/chat`** — stays a standalone harness, not part of this integration (documented 2026-09-03).
- **Utterance-settled server event** — the SDK's idle-telemetry + timeout capture-end logic already covers it.
- **Server-side `?assistant=1` layer for chat** — one-shot `/v1/audio/cleanup` on Done/end-command is the whole cleanup contract.

## Test requirements (tests/e2e + tools)

1. **Dictation flow**: feed a known WAV through the realtime WS (the `?record=1` capture path or the existing realtime test harness) → assert final transcript → `cleanup()` → assert cleaned (fillers gone, numbers written out) → latency budget (< 1.5s for short input warm).
2. **Assistant flow E2E**: synthetic audio "ok kimi" + utterance + end command → `wake` fires → capture → `assistantMessage` with cleaned text. Assert wake-word audio itself is NOT in `raw`.
3. **False-wake resume**: speech-like non-wake audio during capture → no `assistantMessage`, dictation preserved (existing SDK logic — pin it with a test).
4. **Acoustic-miss fallback**: end command as bare text without a `wake` event → still classified (existing `_kimiShouldTreatAsCommand` path).
5. **Concurrency (R7)**: two simultaneous wakeword sessions → both get correct independent wake detection (or second is rejected with the documented close code).
6. **Reconnect (R6)**: kill + restart the worker mid-session → SDK re-attaches, wake re-arms, `ready` emitted.
7. **AEC smoke (R4)**: `audioProcessing: true` yields `echoCancellation: true` in the getUserMedia constraints (assert constraints, not audio — browser-dependent).
8. Update `tools/kimi_wake/test_wakeword_fire.js` if the session/detector contract changes under R7.

## Chat-app side (owned here, not nVoice)

WS+REST same-origin relay `/api/stt/*` → nVoice (byte-piping, mirrors `proxyTts`), mic button + input preview UI, conversation `meta.assistantMode` toggle, system-prompt TTS-friendly block while on, send with `voice: true` stored-form field, auto-TTS on `msg.assistant`, barge-in (stop player on wake). Secure-context deployment note: mic needs HTTPS or localhost — LAN HTTP origins can't use voice.
