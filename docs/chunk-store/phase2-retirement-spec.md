# Phase 2 Spec: Model-Driven Compaction (Retire-with-Distill)

Status: **Ready to implement** — 2026-08-12
Read first: [plan-chunk-store.md](plan-chunk-store.md) (architecture + principles + evidence)
Engine: [chunk-view.js](chunk-view.js) (canonical) / [chat/js/chunk-view.js](../../chat/js/chunk-view.js) (app copy — keep in sync)

## What this phase adds

Two frontend-local tools the model can call in flagged chats:

```
context_retire(chunk_ids: string[], distill: string)
context_unretire(chunk_ids: string[])
```

Retiring a chunk replaces its content in the **outgoing payload** with a
tombstone carrying the model's distillation. Canonical history (Layer 1)
is never modified. Unretire restores full text from the next request.

Validated by exp6 ([probe-retirement.mjs](probe-retirement.mjs)): 4 model
families retire when asked, write specific distillations, recall from
them, and recover undistilled details. Probe harness physically rewrote
chunk messages into tombstones mid-session — the mechanism works with the
original genuinely absent from the payload.

## Prerequisites (all shipped)

- Per-chat `chunkTransform` flag (session doc, chat-options checkbox,
  default ON for new chats as of commit 0d2b957).
- Dedup engine live in `getMessagesForApi` ([conversation.js](../../chat/js/conversation.js) ~L865):
  `if (this.chunkTransform === true) { buildChunkView(messages) }`.
- Convention paragraph injected when chunks exist (in chunk-view.js) —
  retirement instructions extend it (below).
- Savings pill + per-message dedup stats + console logging.

## Design (settled during discussion — do not re-litigate)

1. **Distill, not note.** The `distill` string is the model's working
   memory, written for its future self — key facts, decisions, open items,
   and how to get the original back. exp6 showed models write dense,
   specific distillations unprompted (canaries, figures, decisions).
2. **Tombstone = receipt.** The payload message keeps its envelope
   (`role`, `tool_call_id`) — shape invariance — with content:
   `[chunk_A — RETIRED. Your distillation: "..." Original intact; restore with context_unretire.]`
3. **The working model distills, never a cheap model.** Cheap model lacks
   session context; its summaries would be generic, forcing unretire
   round-trips that cost more than they save. Distillation is nearly free
   for the working model — the content is already in its context.
4. **Batch discipline (cache economics).** Mid-history tombstones
   invalidate the provider's prefix cache from that point. Retire in
   batches, not one chunk per turn. Enforced socially (tool description
   says so), not mechanically.
5. **User control**: tools exist only in flagged chats; every retirement
   renders as a readable tool call; toggle-off re-expands everything
   (assembly reads live flags); standing rules via system prompt possible.

## Implementation

### 1. Retirement state (server)

Persist per conversation: `retirements: { [chunkStableId]: { distill, at } }`.

- **chunkStableId problem**: payload chunk IDs (`chunk_1..N`) are assigned
  per-request in assembly order — NOT stable across requests. Retirement
  must key on something durable. Solution: key retirements on the
  **content fingerprint** (the engine's `fnv1a` hash). The convention
  paragraph tells the model labels; the frontend resolves label→hash at
  execution time using the *current* assembly's chunk table, then stores
  `retirements[hash] = { distill, at }`. Hash survives label renumbering,
  reordering, reload.
- Storage: field on the conversation doc (server: add to the messages
  endpoints — `PUT /api/chats/:id/messages` full-state path already
  replaces conv fields; simplest is a dedicated
  `PUT /api/chats/:id/retirements` that merges the map).
- CRITICAL for execution-time resolution: `buildChunkView` must return
  the chunk table, not just messages+stats: `{ messages, stats, chunkTable:
  Map<chunkId, {hash, messageIndex}> }`. Small engine change — record
  during assembly.

### 2. Assembly (chunk-view.js)

In `buildChunkView`, after the dedup pass:
- For each message whose content hash is in `retirements`: replace content
  with the tombstone (envelope untouched). Applies to tool messages AND to
  assistant tool_call args content (the write-payload slots — same hash
  lookup; if the args content is a retired chunk, replace that string
  field with the tombstone text).
- Tombstone text:
  `[RETIRED chunk — distillation: "<distill>". Original intact in history; call context_unretire to restore it.]`
- Convention paragraph gains (only when retirement tools are offered):
  > You may retire chunks you have fully consumed with context_retire(chunk_ids, distill). The full text leaves your context; your distillation stays. Write distillations as your future working memory: key facts, decisions, open items, and how to restore. Retire in batches (each retirement rewrites history and invalidates caching). context_unretire(chunk_ids) restores. If a tombstone's distillation looks wrong or insufficient, say so — you are the only observer of the transformed view.

### 3. Frontend tools (chat.js)

Register alongside the archive tools (same pattern as `chat_archive_*`):
- Only offered when `streamConv.chunkTransform === true`.
- `context_retire(chunk_ids, distill)`:
  1. Resolve each `chunk_id` → content hash via the *last assembly's*
     chunkTable (cached on the conversation from the last
     getMessagesForApi call — `_lastChunkTable`).
  2. Unknown id → throw with the valid ids listed (fail loud, model
     self-corrects).
  3. `PUT /api/chats/:id/retirements` merge `{ [hash]: { distill, at } }`.
  4. Update the local copy + `conv._retirements`.
  5. Render as a tool call in the UI (it is one) — the distill text is
     the visible receipt.
- `context_unretire(chunk_ids)`: same resolution, delete keys, PUT.
- Result content for the model: `{ ok: true, retired: [...] }` etc.

### 4. Conversation glue (conversation.js)

- `conv._retirements` loaded with the conversation (GET session path —
  check what the conversation GET returns; may need to include the field).
- After `buildChunkView` in getMessagesForApi: pass `conv._retirements`
  into the engine (new options arg: `buildChunkView(messages, { retirements })`),
  cache `_lastChunkTable` for tool resolution.

### 5. Kill-switch interactions

- Flag off → engine not called → retirements irrelevant (full text).
- `CHUNK_TRANSFORM=off` config → same.
- Tombstones never touch Layer 1; deleting the retirements map restores
  byte-identical legacy payloads.

## Edge cases (think before coding)

- **Retiring a chunk that's a dedup target**: later messages referencing
  it (`[chunk_9 = chunk_4]`) keep working — the reference points at the
  tombstone slot, which is intentional: the distillation is what the
  reference should resolve to. Do NOT special-case.
- **Retire then unretire across reloads**: flags live server-side;
  assembly is pure function of (messages, retirements) — consistent.
- **Model retires the convention paragraph's own turn / tiny chunks**:
  harmless; tombstone is shorter anyway. No minimum-size guard needed
  (chunks only exist >2K chars).
- **Retirement during streaming/tool chains**: retirements apply at next
  assembly; mid-chain state is fine because tool results re-assemble.
- **Arena mode**: out of scope this phase (arena has its own storage path).

## Validation

1. Re-run exp6 against the real frontend tools (probe harness already
   simulates the exact tombstone semantics — port the probe's message
   rewrite to call the real assembly).
2. Corpus verify: apply synthetic retirements to the flagship session
   (retire the 3×434K fetch group after first use) — expect flagship
   50% → ~75%+ with retirement layered on dedup.
3. Live: one flagged test chat, multi-document task, watch distillations
   render, quiz the model post-retirement, check the pill counter jump.

## Success criteria

- exp6-equivalent pass through the REAL code path (not just the probe).
- Flagship + retirement ≥ 75% in verify-transform.
- kimi-chat can complete a session that previously 400'd (the portability
  test — retirement brings late-history under 262K).
- No provider 400s from tombstone substitution (shape invariance holds).

## Files

| Change | File |
|---|---|
| chunkTable return + retirement pass in assembly | [chunk-view.js](chunk-view.js) → sync to [chat/js/chunk-view.js](../../chat/js/chunk-view.js) |
| `_retirements` load, engine options, `_lastChunkTable` cache | [chat/js/conversation.js](../../chat/js/conversation.js) |
| Tool registration + execution + UI rendering | [chat/js/chat.js](../../chat/js/chat.js) (archive-tools section ~L120, streamResponse tools assembly ~L3000, handleToolExecution ~L4400) |
| `PUT /api/chats/:id/retirements` + include field on GET | [server/server.js](../../server/server.js) |
| api-client method | [chat/js/api-client.js](../../chat/js/api-client.js) |

## Open questions for the implementing session

- Does the conversation GET path return arbitrary conv fields already, or
  does it whitelist? (Check `GET /api/chats/:id` response shape.)
- Should retirement be offered in arena chats? (Default: no this phase.)
- Metrics: add `retired` count to the `[chunk-view]` log line and pill
  tooltip.
