# Handover — Issue #63: iOS TTS playback (nSpeech client)

**Date:** 2026-11-17, end of session. Two prior sessions on this: #64/#66 (closed), #63 in flight.
**Status: RESOLVED on device — TTS plays, pauses and resumes on iOS. Seek unverified.** Root causes and fixes below.

## Resolution (2026-11-17, late session) — read this before anything else

Round 3 (Web Audio) was never the problem. Four separate defects sat on top of it, each
found by measurement, not by reasoning:

1. **Decode byte race** (found by a Node harness, `_scratch/wa63-state.mjs`): the decode
   frontier was read *after* the `await`, so bytes that arrived mid-decode were marked
   decoded. The end check then saw `pending === 0` and ended playback mid-stream. Fixed by
   snapshotting `totalAtStart` before the await; the end check now also requires
   `_downloadComplete`.
2. **Seek scheduled from stream position 0** instead of the seek target (the parked
   position IS the next source offset). Fixed.
3. **iOS never ran the source**: `AudioBufferSourceNode.start(when, offset, duration)` is
   accepted by WebKit and silently never plays (no audio, no `ended`). Sources now start
   with two arguments — chained at the previous end time, fresh with `when = 0`.
4. **Silent output despite a healthy graph**: the analyser measured peak 0.76 for the whole
   utterance while the phone was silent. Web Audio's direct route to `ctx.destination`
   does not reach the speaker on this device; **media-element playback does** (the
   element-based round 2 was audible, only its re-sourcing was broken). Output now goes
   through a shared gain → `MediaStreamDestination` → `<audio>` element, which also
   sidesteps the hardware mute switch (Web Audio honours it, media elements do not).

Also fixed: a paused player was evaluated as an ended one (pause after download complete
restarted the utterance from the top).

**Device telemetry was the unblocker.** The phone has no devtools, so `SpeechPlayer`
gained an opt-in `diag` mode (analyser peak, ctx state, every decode/start/end), beaconed
by `NSpeechController` to `POST /api/client-diag` and written to the server log. That is
what turned "still silent" into "peak 0.76, so the samples exist". **Remove the analyser,
the `wa-diag` events, the beacon and the route once seek is confirmed.**

Commits: `a73bc02` (WA port + harness fixes), `2781f7a` (two-arg start), `e2e8b8e`
(unlock on gesture), `841b7bb` (element output), `d4c862d` (starve gate), `9cfdfd6`
(pause vs end), `df6d082` (MP3 frame cut + decode timeout), `913af37` (starvation
requests its own decode), `80a7471` (diag off by default). nSpeech carries the same
client file (identical bytes), committed there but **not pushed** — David's call.

Two further defects found on device after the first audible playback:
- The final decode hung: WebKit neither resolves nor rejects `decodeAudioData` on a
  buffer whose tail is a partial MP3 frame (`_fbDecoding` stayed true forever, playback
  froze ~2 s early). Decode now cuts at the last complete frame (frame scanner, ID3v2
  aware, only trusted when the scan reached the end) and races a timeout.
- Chunks under the 24 KB threshold that all arrived while the lead looked healthy were
  gated out with nothing scheduled to wake the pipeline → playback stopped after the
  first chunk. The underrun branch now forces one decode per byte frontier.

Diagnostics: `SpeechPlayer({ diag: true })` + `POST /api/client-diag` remain available
and off by default. That is the tool for the next device-only mystery.

Known limitation: the WA path keeps the whole stream in memory and re-decodes the
accumulated buffer per pass. Fine for chat-length speech; a long document would need
chunked decode.

## Symptom history (herrbasan/LLM-Gateway-Chat #63)

1. Original: on iOS, `SpeechPlayer` (lib/tts/nspeech-client.js) blob fallback re-assigned
   `audio.src` every 8 received chunks → decoder teardown per package → 500–1000ms stop/restart.
2. Fix round 1 (`b1f8739` nSpeech / `21b9224` chat): swap only at ≤2s remaining or `ended`.
   **Device result: still stutters** — rare breaks are still breaks; each swap is a full WebKit reload.
3. Fix round 2 (`09a71bc` nSpeech / `38187a8` chat, pushed): double-buffer — idle element preloads
   the grown blob, handoff = seek+play. Desktop lab: 0–1ms gaps, 2 handoffs/1126 chunks, zero violations.
   **Device result: playback stops entirely after the first chunk, cannot be restarted.** iOS blocks or
   poisons the handoff play(); root cause NOT confirmed (no device debugging available).
4. Fix round 3 (current, **uncommitted** in both repos): Web Audio fallback — see below.
   **Never verified: lab run kept getting interrupted; device never tested.**

## Current file state (exact)

| File | State |
|---|---|
| `D:\DEV\nSpeech\lib\nspeech-client\nspeech-client.js` | WA rewrite **uncommitted** on top of `09a71bc` (canonical; David's repo has other dirty files — never touch them) |
| `D:\SRV\LLM-Gateway-Chat\lib\tts\nspeech-client.js` | Same WA rewrite **uncommitted** on top of pushed `38187a8` |
| Both syntax-clean (`node --check` passes). SpeechPlayer sections are byte-identical between the two. |

**Live impact:** master (`38187a8`) is what the iPhone currently runs → TTS stops after first chunk.
Open decision for David: revert master to pre-#63 while WA is unverified, or push WA quickly after lab verify.

## The Web Audio design (what's in the working tree)

Port of the nVoice assistant pattern (`lib/stt/tts-player.js` — proven working on David's iPhone today):

- `speak()` picks `_fbMode`: `'wa'` when `!useMse && AudioContext && !opts.audio`; `'element'`
  (double-buffer, kept) otherwise; MSE path untouched.
- WA mode: `this.audio` is a **muted shadow element** (no media handlers) — exists only so
  `controller.audio` stays truthy (scrub gate in tts-player.js reads `controller.audio` and paints
  `element.currentTime` during drag; the tick loop syncs `shadow.currentTime = _fbPosition()`).
- Stream chunks accumulate; `_fbDecodeAndSchedule()` decodes the whole accumulated blob via
  `decodeAudioData` (re-decode per pass, bounded by FALLBACK_SWAP_MIN_BYTES gain + FALLBACK_PRELOAD_S
  lead gates + one-attempt-per-byte-frontier), then `_fbSchedulePending()` chains an
  `AudioBufferSourceNode` to start at the ctx time the current one ends — **sample-accurate, no
  playback boundaries**.
- Position = `_fbPlayOffset + (ctx.currentTime - _fbPlayStartCtx)`; clock rebased on every fresh
  start (first play, resume, seek, underrun recovery).
- Underrun (playback outruns synthesis): position freezes at decoded end, state stays `playing`
  (that IS the auto-resume flag — do not add another), next decode re-schedules from there.
- Pause: stop sources, rewind `_fbScheduledStreamPos` to live position. Resume: state must flip to
  `playing` BEFORE `_fbSchedulePending()` (it refuses to start audio while paused — this was a
  deadlock once, fixed in `resume()`).
- `AudioContext` created/resumed inside `speak()` (click path — the nVoice rule).
- External audio (`opts.audio`) never takes WA (owner-owns-element contract) → legacy element path.

## Verification status

- **Lab (desktop, forced WebKit path): NOT completed.** The one partial run (`?v=wa63b`) showed:
  mode=wa, decode covered 37.37s, played to `ended` — but `sawPlaying:false` anomaly unexplained and
  pause/resume/seek never exercised (test window closed early). Two later runs got killed by tool
  interruptions — **lesson: never await a long loop inside runPlaywrightCode; the tool dies mid-await.
  Fire the test without awaiting (window slot pattern), then poll with short calls.**
- Suggested harness (next session): fire-and-poll pattern as above; verify: position advances,
  pause holds, resume advances, seek jumps and continues, full playthrough reaches `_fbEnded`,
  no `error` events, state transitions sensible. Mute via wrapping `_fbWaInit` → ctx.createBufferSource
  rerouted to a zero gain (pattern in the killed harnesses above — reuse it).
- **Device: untested.** David reloads the page on iPhone and ear-tests. Success criteria: continuous
  speech, no per-package stops, pause/resume/seek work from the TTS panel.
- If WA also fails on device → the nVoice `lib/stt/tts-player.js` is the reference implementation to
  diff against (it genuinely works on iOS, including ctx resume in gesture + 'suspended' handling).

## Known gotchas (cost real time — do not rediscover)

0. **Test in seconds, not minutes.** A lab test that plays a 60s stream in real time is a design
   error (and it burned the session: long in-page loops get interrupted). The WA state machine is
   verifiable in ~5s: decode coverage after 2-3 chunks, position advancing on the audio clock,
   pause-holds, resume-advances, seek-jumps — assert those and stop. Only the ear needs real time.

1. **Module cache**: a page that imported `/lib/tts/nspeech-client.js` keeps the old module instance;
   harness imports need a fresh query string (`?v=<unique>`) after every file edit.
2. **Chrome decodeAudioData resolves truncated MP3s; Safari may reject** — the retry-per-frontier
   gate handles it; don't "fix" it away.
3. `gh issue close` has no `--comment-file`; use `-c (Get-Content file -Raw)`.
4. nSpeech repo tree is dirty with David's unrelated server work — commit ONLY the client file, and
   do NOT push nSpeech (his call).
5. First harness run measured the OLD module by accident — it doubles as the baseline capture
   (51 swaps, up to 20s headroom destroyed; saved output under the session).

## Open items

- [x] Lab-verify WA (advance/pause/resume/seek/end + no error events) — 18 checks, `_scratch/wa63-state.mjs`
- [x] David: device test — plays, pause/resume confirmed, full-length generation confirmed
- [ ] Seek on device (drag mid-playback, seek while paused, resume) — harness-verified only
- [x] Commit canonical nSpeech (file only) + vendored port; push chat repo — nSpeech commit local
- [x] Strip diagnostics — capability kept, beacon off by default (`80a7471`)
- [ ] Comment on #63; close after seek confirmation
- [ ] Start-of-utterance blip: first chunk plays before the stream catches up — worth a
      "start after ~0.5 s decoded" gate if it still annoys on device

## References

- Issue: herrbasan/LLM-Gateway-Chat#63 (comments document rounds 1–3 with lab numbers)
- nSpeech commits: `b1f8739` (round 1), `09a71bc` (round 2, double-buffer) — both unpushed
- Chat commits: `21b9224` (round 1), `38187a8` (round 2) — pushed to master
- nVoice reference: `D:\SRV\LLM-Gateway-Chat\lib\stt\tts-player.js` (WebRTC loopback is Chromium-AEC
  specific and NOT needed here — only its AudioContext/BufferSource/iOS-resume pattern matters)
