# nVoice Realtime JavaScript SDK

Zero-dependency vanilla JS client for nVoice realtime STT, wake word, turn-taking, and transcript cleanup. Dual export: browser global (`window.nVoiceClient`) and CommonJS (`require`).

## Usage

```html
<script src="/sdk/nVoiceClient.js"></script>
```

```javascript
// Direct to nVoice origin (dashboard):
const client = new nVoiceClient({ serverUrl: 'https://badkid:2245' });

// Behind a same-origin relay (chat app shape):
const client = new nVoiceClient({ serverUrl: '', basePath: '/api/stt' });
// → fetch('/api/stt/v1/...'), ws://<page-host>/api/stt/v1/...
```

## Config

| Option | Default | Notes |
|--------|---------|-------|
| `serverUrl` | `''` | Absolute nVoice base (`https://host:2245`) or `''` for same-origin. |
| `basePath` | `''` | Path prefix for relayed deployments (e.g. `/api/stt`). Drives every request the SDK makes. |
| `audioProcessing` | `false` | Force browser AEC/NS/AGC on every platform. |
| `rawAudio` | `false` | Explicit raw capture override (loses to `audioProcessing`). |
| `audioDeviceId` | `null` | Mic device for `start()`. |
| `engine` | `null` | Engine id (else server default). |
| `recordDebug` | `false` | Worker records engine-received audio to WAV. |
| `intentEnabled` | `false` | Reactive assistant session (`?intent=1`). See below. |

Note: assistant/intent sessions default to **AEC-only** capture (NS/AGC off — AGC lifts
the noise floor until the VAD hears breathing as speech). Explicit per-flag overrides
always win.

## Dictation API (mic button flow)

```javascript
await client.start();
client.on('transcript', (d) => { if (d.is_final) updatePreview(d.text); });
// ... speak ...
const raw = client.getRawText();          // accumulated non-command finals
const cleaned = await client.cleanup(raw, 'clean');  // throws on error — keep raw on failure
client.clearRawText();
```

`cleanup(text, mode?)` wraps `POST /v1/audio/cleanup` (modes `clean`/`format`/`compact`, EN+DE). Fail-loud: throws on HTTP/malformed errors.

## Wake word (optional)

```javascript
await client.enableKimiWakeWord();  // before start(); "ok kimi" wakes the stream
```

Worker-side acoustic detector over `WS /v1/wakeword/ws`. Plain wake-gate for dictation. The kimi listen/hold/send assistant mode that built on it was **retired 2026-09-20** — `enableAssistantMode()` throws with a pointer to the reactive assistant.

## Methods

| Method | Description |
|--------|-------------|
| `start()` | Get mic, open realtime WS (+ wakeword WS when enabled), stream audio. Failed starts tear down fully. |
| `stop()` | Stop the mic stream (use `disconnect()` for full teardown). |
| `disconnect()` | Full teardown. |
| `getRawText()` / `clearRawText()` | Accumulated raw transcript buffer. |
| `cleanup(text, mode)` | One-shot LLM cleanup. Throws on failure. |
| `enableKimiWakeWord()` | Worker-side "ok kimi" wake detector. |
| `setAudioDevice(id)` | Mic for next `start()`. |
| `on(ev, cb)` / `off(ev, cb)` | Event listeners. |
| `client.turn` | Live snapshot of the current turn (`null` before the first). |
| `getSessionReport()` | Structured record of the current/last intent session. |
| `printSessionReport(reason?)` | Build + print + cache the report (automatic on socket close). |
| `client.lastReport` / `lastReportText` | Last report, structured and rendered. |
| `note(code, detail, severity?)` | Annotate the session record from the app (playback cuts, UI decisions). Shows as a finding. |

## Events

`connected`, `disconnected`, `standby`, `transcript` `{text, is_final}`, `telemetry` `{rtf, backlog_sec, speech_sec}`, `wakeWordDetected`, `asleep`, `error`, `speech-start`, `speech-end`.

## Reactive assistant (turn-taking) — the chat-app voice mode

`client.intentEnabled = true` opens an assistant session (`?intent=1` on the realtime
WS). The SERVER runs the conversation loop — turn detection, noise rejection, cleanup,
optionally the reply — the app renders and speaks.

**How a turn is decided (the gauntlet).** After a pause (`intentPauseMs`, default
1200ms) the server runs: trailing-word list (0ms) → 0.6B trigger → **one 12B call that
returns a verdict + the cleaned text**. Terminal punctuation (`.?!…`) skips straight to
the verdict. The verdict is `COMPLETE` (send), `INCOMPLETE` (keep listening), or
`NOT_SPEECH` (whole buffer discarded — a cough never becomes a message). A trailing
still-speaking arms a ~2.5s re-check rather than the full ceiling. The silence ceiling
(`intentMaxSilenceMs`, 8s) forces the verdict as a fail-safe, never a blind send.

**Interruption authority lives in the input pipeline, not the audio level.** Only two
things stop output:

1. an **interrupt keyword** in a final (`wait`, `stop`, `halt`, `hold on`, `never mind`;
   DE `warte`, `stopp`, `moment`, `vergiss es`; incl. STT spellings `schtop`/`стоп`;
   leading fillers like "äh wait" allowed) → `barge-in` — cut TTS immediately, or
2. a **new input that survived the full gauntlet** while output was running →
   `phase {phase:'interrupted', trigger:'new-input'}`.

Sustained voiced audio during output does NOT stop playback — it emits `duck` (after
`duckMs`, default 400ms of VAD-voiced audio): lower the volume, don't cut. A cough fit
survives the reply; a real sentence interrupts it ~2.5s after speech ends. Never cut on
`speech-start` — it is the raw VAD edge and fires on any bump.

**Self-echo is suppressed server-side.** The relay tracks what the TTS spoke; any final
matching it is dropped and reported as `echo-suppressed`. Even when AEC collapses
(music playing), the assistant cannot answer its own voice.

### Assistant events

| Event | Shape | Meaning |
|-------|-------|---------|
| `intent` | `{label:'turn-done'\|'still-speaking', text, pause_ms, superseded, punctuation?, forced?}` | the trigger decision on a pause |
| `verdict` | `{verdict:'COMPLETE'\|'INCOMPLETE'\|'NOT_SPEECH', text, latency_ms, forced, parse_failed, superseded}` | the 12B gate — this is what sends/discards |
| `phase` | `{phase:'cleaning'\|'thinking'\|'streaming'\|'done'\|'interrupted'\|'reopened'\|'discarded'}` | machine phase; `interrupted` carries `trigger:'new-input'` or the keyword; `discarded` follows NOT_SPEECH |
| `reply` | `{result:{type:'cleaned'\|'stream', text}}` | the settled cleaned turn, then reply tokens |
| `barge-in` | `{reason:'keyword'}` | cut TTS NOW (keyword only) |
| `duck` | `{voicedMs}` | lower TTS volume (sustained speech, not an interrupt) |
| `echo-suppressed` | `{text}` | a final was dropped as self-echo (info) |
| `turn` / `turn-end` | snapshot | live turn state / completed turn |
| `session-report` | report | full structured record on socket close |

### Two reply shapes — pick by who owns the conversation

**A. nVoice generates (stateless).** Default. Reply tokens stream via `reply`
(`cleaned` then `stream`) from the gateway model configured on the server; override per
session with `client.intentReplyModel = 'kimi-k3-chat'` (or page URL `?reply_model=`).
**Each turn is standalone — the reply model gets no conversation history.** Fine for a
standalone voice mode; wrong for a chat thread.

**B. The chat app generates (with history) — the chat-integration shape.** Set
`client.intentNoReply = true`: nVoice does turn detection, noise/echo rejection and
cleanup, but generates nothing. The app takes each settled message into its own model
with the full thread history:

```javascript
const client = new nVoiceClient({ serverUrl: '', basePath: '/api/stt' });
client.intentEnabled = true;
client.intentNoReply = true;          // app-side generation, with history
await client.start();                 // inside a click (autoplay + mic permission)

client.on('reply', d => {
  if (d.result.type === 'cleaned') {
    // A gauntlet survivor: noise discarded, echo suppressed, fillers stripped.
    sendUserMessage(d.result.text);   // → your model, your history, your reply
  }
});

// Speak the chat's reply through TtsPlayer with the interrupt semantics:
client.on('barge-in', () => tts.stop('keyword'));
client.on('duck', () => tts.duck());
client.on('speech-end', () => setTimeout(() => { if (!client.speaking) tts.unduck(); }, 1000));
// A stale reply can still be speaking when the NEXT cleaned turn arrives —
// cut it there (synthesis outlives the server):
client.on('verdict', d => { if (d.verdict === 'COMPLETE') tts.stop('new turn', { mute: false }); });
```

### Session options (set as properties before `start()`)

| Property | Default | Meaning |
|----------|---------|---------|
| `intentEnabled` | `false` | Opt into the reactive assistant (`?intent=1`). |
| `intentNoReply` | `false` | App-side generation: no reply model runs on the server. |
| `intentReplyModel` | `null` | Override the reply model (default: server `assistant.model`). |
| `intentPauseMs` | `1200` | Pause before the gauntlet decides. |
| `intentMaxSilenceMs` | `8000` | Silence ceiling — forces the verdict. |
| `intentMaxTokens` | `2048` | Reply token cap. |
| `duckMs` | `400` | Voiced milliseconds before `duck` fires. |

## Turn-taking record

An intent session records itself: findings first, then per-turn summaries (spoken,
cleaned and reply text), then the raw frame timeline. Bind a UI to `turn` (live) and
`turn-end` (completed). The snapshot carries `{ index, state, outcome, rawText, intent,
verdict, cleanedText, replyText, ttfbMs, replyDurationMs, startedAtMs, endedAtMs }`.

Findings name the failures that are otherwise invisible: `no-speech`,
`classifier-never-ran`, `no-intent`, `no-reply`, `unfinished-turn`, `forced-completion`,
`spurious-interrupt`, `interrupt-dropped`, `orphan-reply`, `empty-final`,
`slow-classifier`, `slow-cleanup`, `slow-verdict`, `slow-ttfb`, `long-final-gap`,
`cleanup-discarded`, `classifier-skipped`, `noise-discarded`, `verdict-parse-failed`,
`echo-suppressed`, `playback-cut`.

```javascript
client.intentEnabled = true;
client.on('turn', t => renderState(t));              // live state
client.on('turn-end', t => showAnswer(t.replyText));  // completed turn
client.on('session-report', r => save(r));            // full record
```

## Speaking the reply (`TtsPlayer`)

`sdk/tts-player.js` turns streamed reply text into speech via nSpeech, one sentence at a
time, synthesizing the next while the current one plays.

**Playback is the barge-in window.** Synthesis queues behind generation, so the
assistant keeps talking after the server has gone back to listening — only the client
knows when audio is still coming out of the speaker. Cutting playback is the app's job.

**Stop vs duck (v2 semantics):**

- `stop()` — only for a **keyword** (`barge-in`) or a **new gauntlet-surviving turn**
  (a fresh `cleaned` reply arriving while old audio still plays). Cuts playback AND
  drops unspoken sentences; the `mute` option controls whether the new reply may speak.
- `duck()` / `unduck()` — sustained speech during output. One gain value, reversible;
  the reply keeps playing at reduced volume. Pumping on noisy rooms is mitigated by the
  400ms voiced threshold before `duck` fires.

**Echo survives two ways.** The mic runs with `echoCancellation` (forced for intent
sessions), and playback runs through a local **WebRTC loopback** — Chromium's AEC only
cancels WebRTC playout, and the path must stay alive for seconds to converge. When AEC
nonetheless collapses, the server-side echo guard drops the transcribed self-echo.

Call `tts.prime()` from inside the Start click — autoplay policy suspends an
AudioContext created outside a user gesture.

| | |
|---|---|
| `push(text)` | Feed reply tokens; speaks each complete sentence as it lands |
| `flush()` | End of reply — speak what is left |
| `stop(reason?, {mute}?)` | Cut playback now, drop everything unspoken |
| `duck(level?)` / `unduck()` | Volume duck to `level` (default 0.5) / restore |
| `prime()` | Build the output path — call inside a user gesture |
| `clean` | Text cleaning by nSpeech (`extra_body.clean`): `true` (default) / `'llm'` / `false` |
| `playing` / `pending` | Speaking now / sentences queued |
| `stats` | `{ sentences, spokenChars, synthMs, spokenMs, interrupted }` |
| `onEvent` | `start` · `end` · `interrupted` · `ducked` · `error` |

Markdown is stripped before synthesis (sentence splitting needs it gone); nSpeech
cleans what arrives via `extra_body.clean`, where it is authoritative. Measured against
local Kokoro: first audio ~650ms after text arrives, one sentence of look-ahead kept
synthesized. Feed app-side playback decisions into the record with `client.note()`.

## Notes

- No auto-sleep: once awake the stream stays open; the backend VAD idles inference during silence.
- Transport is WebSocket only. Mic requires a secure context (HTTPS or localhost).
- One client per session: call `disconnect()` before creating another (an SPA page
  never unloads, and stacked clients exhaust the renderer's audio contexts).
- The server reply model is stateless (no conversation history) — for history, use
  `intentNoReply` and generate in the app.
- Pending for chat integration (issue #1): WS auto-reconnect (R6), per-session
  wakeword detector state (R7). R3 assistant mode retired.

## Test bench

`web/pages/sdk-test.html` — manual bench. Serve from the nVoice origin or through
`tests/e2e/chat-relay.mjs` (chat-origin relay simulator). `tests/e2e/sdk_test_runner.js`
— Node-level suite.
