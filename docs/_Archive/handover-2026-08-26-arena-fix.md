# Handover 2026-08-26 — Arena fix cluster (commit 5bcd8e2)

**Scope:** `server/arena-runner.js`, `chat-arena/js/arena.js` · Branch `bff-rework` · E2E-verified on :8082

## Symptoms reported

Arena broken in four ways: (1) models repeat their opening every turn — local AND cloud (glm vs kimi), so not a model problem; (2) turn counter wrong while running, correct only after reload; (3) context-length display wrong, persists after reload; (4) new arena tabs don't appear in the sidebar until reload.

## Root cause (one bug, four symptoms)

nDB `find()` returns a JSON string → every result is a **detached copy**. `ArenaRunner` cached `this.conv` at construction/attach and `runOneTurn`→`buildMessages` never re-read it. Every turn built the payload from a conversation frozen in time.

**Data proof:** the broken glm-vs-kimi session has `usage.prompt_tokens = 77` on ALL 9 turns (topic-only payload, no history). **Log proof:** turn 1 of a fresh arena went out EMPTY (the `start()` refresh ran before the topic append) → `messages must not be empty` (kimi 400), `No messages provided` Jinja 500 (coolkid). Later turns froze at whatever the conv held at the last attach.

This is the same gotcha documented for the chat runner ("nDB find() does not return live references", architecture doc §7) — the chat runner refreshes at 12 use points; the arena runner refreshed at 2 (attach, start) and missed the hot one.

## Fixes

### Server — `server/arena-runner.js`

1. `runOneTurn()`: `this.refresh()` at the top. Each turn now builds from current store state. **This is the repetition fix.**
2. `start()`: derive `currentTurn` = assistant-message count and next speaker = alternate from whoever spoke last (was: reset to 0 + random). Fixes cumulative turn display and continue/extend semantics — extend-by-N previously ran `maxTurns` NEW turns instead of N more.

### Frontend — `chat-arena/js/arena.js`

3. Turn display: `turn.start` shows `evt.turn + 1` (server is 0-based); counter advances on `msg.assistant` via `_completedTurns()` (assistant-message count — same derivation as the reload path, so live and reloaded displays agree by construction).
4. `_computeContextDisplay`: per-participant **latest** message's `context.used_tokens`/`usage.total_tokens` (was: SUM of `total_tokens` across all turns — every turn re-sends the full history, so sums multiply monotonically). Overall = sum of both latest, window = min of windows (old aggregation shape kept).
5. `_startConversation`: `await this._loadHistory()` after session create → sidebar tab appears immediately; `arena.end` also refreshes history (final message count on the tab).
6. `_newSpectatorSession`: added `participantBConfig` (was missing → `TypeError` in `_updateParticipantModel` on EVERY arena load during settings restore, crashing `_loadArena`). Config objects now alias the participant objects.
7. Live streaming: added `run.start` + `delta` listeners with a throttled (120 ms) streaming bubble — the arena previously had NO `delta` listener; messages popped in only at turn end. `snapshot.inFlight` renders as a streaming bubble on mid-run attach and continues from live deltas.
8. EventSource `error` listener guards `!e.data` — EventSource fires data-less `error` events on transport drops (server restart), which crashed `JSON.parse(undefined)` every time.

## E2E verification (two fresh arenas, badkid-llama-chat vs deepseek-flash-chat)

| Check | Result |
|---|---|
| Prompt tokens per turn | 87 → 131 → 191 → 279 → 352 → 427 (strictly growing) |
| Content quality | models cite and rebut each other's actual arguments |
| Turn display | live `Turn 1/2`, `Turn 5/6` mid-extend, cumulative across extend |
| Context display | `470 / 128K` — matches stored latest values exactly |
| Streaming | bubble grows live (112 → 428 chars observed) |
| Mid-run reload + reattach | in-flight partial (16K chars) renders from snapshot |
| Extend (+2 turns) | continues the same debate; alternation derived correctly |
| Full reload | identical state; settings restore clean; zero pageErrors |
| Server log | zero arena errors post-fix |

## Remnants / follow-ups

- **Pre-fix arenas are content-poisoned** (N near-identical openings). Mechanically fine to continue now, but the existing content is garbage — delete them.
- **Summary generation** (options dialog → `Arena.summarize`, arena.js:1051/1104/2685) still streams browser→gateway directly. Re-point through the backend when the summary flow is re-based.
- **Legacy import** still constructs the old `Arena` orchestrator (arena.js:810, 2171).
- **Dead code:** `Participant`/`Arena` classes (arena.js:40–1165) — delete in the Phase D cleanup pass.
- **Observation (unverified, likely LLM-Gateway-side):** `usage.completion_tokens = 0` on all streamed turns; `context.used_tokens` carries the real prompt count.

## Pointers

- Survey status notes: `docs/codebase-survey-bff.md` — Channel 6, W4, H5 (dated 2026-08-26).
- Data probe: `_scratch/probe-arena-data.cjs` (extracts arena sessions from `data.jsonl`; note it's an op-log mix — prefer `/api/chats/:id` for fresh state).
