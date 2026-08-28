# Architecture: The Conversation Runner

**Date:** 2026-08-23 · **Status:** LANDED — runs live on `master` since 2026-08-28 (PA–PC + arena Phase D; cutover remnants tracked in the spec's §4)
**Supersedes:** the proxy-retrofit P0 design ([_Archive/plan-p0-stream-ownership.md](_Archive/plan-p0-stream-ownership.md), kept as design input)
**Governing spec:** [plan-backend-routed-refactor.md](plan-backend-routed-refactor.md) · **Map:** [codebase-survey-bff.md](codebase-survey-bff.md)

---

## 1. The model

**A conversation is a server-side session. The browser attaches to it.** (tmux model:
the session runs whether or not a terminal is attached; attach from anywhere, detach
freely, the session doesn't care.)

Three principles, all load-bearing:

1. **Single author.** The runner is the only writer of conversation state. No client
   ever persists a message. This deletes the entire class of double-write guards the
   retrofit needed.
2. **The store is canonical, the runner is a cache.** nDB holds the durable
   conversation doc (format unchanged). The runner holds the same messages in memory
   plus the only non-recoverable state: the in-flight generation.
3. **The view is disposable.** Browser state is a projection of `snapshot + events`.
   Killing it changes nothing.

Connection state carries no semantics. There is no abort-vs-kill signal to design:
abort is an explicit API call; a closed browser connection is just one less listener.

## 2. Server components

### 2.1 Runner (`server/runner.js`, new module)

One per active conversation, keyed `{userId}:{conversationId}`:

```js
{
  conversationId, userId,
  messages: [],            // canonical stored form, loaded from nDB on mount
  meta: {},                // title, model, systemPrompt, flags (chunk-view toggle, ...)
  inFlight: null | {       // the only volatile state
    exchangeId, content, reasoningContent, toolCalls,
    usage, context, thinkingSignature, finishReason, startedAt
  },
  views: Set<res>,         // attached SSE consumers
  abortController,         // aborts the in-flight gateway fetch
  lastActiveAt
}
```

**Lifecycle:** lazy mount on first attach or message send → idle unload after N
minutes with no views and no run (nothing to flush — the store is always current) →
remount on demand. Server restart loses only `inFlight` (documented limitation; the
user message and all completed messages are already persisted).

**Run loop:**

1. View sends a message → runner appends it (stored form), persists via the shared
   append helper (embed fires), broadcasts `msg.user`.
2. Runner builds the API payload: ported `getMessagesForApi` (conversation.js:553–668,
   incl. tool-result backfill) + ported `buildChunkView` transform (chat/js/chunk-view.js,
   ~300 lines dependency-free, honors the per-chat toggle) + `thinking_signature`
   propagation.
3. POST to gateway `/v1/chat/completions` (SSE, server-held Bearer). Deltas accumulate
   into `inFlight` and broadcast as `delta` events.
4. `finish_reason: stop` → append assistant message (persist + embed), broadcast
   `msg.assistant`, `run.end`.
5. `finish_reason: tool_calls` → persist assistant-with-tool_calls → execute each tool
   (§4), broadcasting `tool.start`/`tool.end` and persisting each `role:tool` message →
   loop to 2. The recursion moves server-side.
6. Abort (explicit API call) → abort upstream, persist the partial assistant marked
   aborted, broadcast `run.end {aborted}`.

**Stored-form authoring (deep-dive G2):** the runner authors the stored *form*, not just
bytes: timestamp prefix, attachment offload to `_file` nURIs, tool message shape
(`toolName/toolArgs/toolStatus/toolImages`), assistant metadata (`reasoning_content`,
`thinking_signature`, `streamStats`, `usage`, `context`). Today this lives inline in
`POST /api/chats/:id/messages` (server.js:1568) and `addExchange` (conversation.js:334)
— extract it into the shared append+embed helper that both the route and the runner call.

**Concurrency:** sends are always accepted — appended, persisted, broadcast
immediately. A send is just an added prompt; the expected multi-device case is the
*same user* picking the conversation up on another device, not an author conflict.
What must never happen is concurrent **runs** (two gateway streams interleaving
assistant output into one conversation) — so runs serialize: a send during an active
run queues, and when the run ends the runner starts a follow-up run covering
everything appended since (batched — consecutive queued messages get one run, which
the model reads as "oh, and also this"). A view may later offer send-and-interrupt
(abort + rerun with the new message included) as an input policy — UX choice, not an
architecture rule.

### 2.2 Routes (extend the existing hand-rolled router, server.js:2127)

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/chats/:id/send` | Append user message + start a run (queued if one is active). Body = raw stored-form fields (`content`, `attachments`, …). Returns `{exchangeId}`. |
| `GET` | `/api/chats/:id/events` | Attach to the conversation SSE stream (snapshot + live events). |
| `POST` | `/api/chats/:id/abort` | Abort the active run. |

All cookie-auth (`requireAuth`), per-user DB isolation as today. Existing
`/api/chats/*` CRUD (list/rename/pin/delete), `/api/search`, `/api/buckets/*`,
`/api/user/settings`, admin — unchanged. Route part-counts are distinct from existing
routes; literal parts differ from `:param` slots (verify against the router's matcher
at implementation time).

### 2.3 Ports into the server (mechanical, all fetch-based already)

- `getMessagesForApi` + message versioning → `server/api-view.js` (from conversation.js,
  incl. tool-result backfill and the version tree — regenerate/switch-version state
  moves to the runner).
- `buildChunkView` → `server/chunk-view.js` (verbatim port; toggle lives in conversation meta).
  The chunk table lives here — `context_retire`/`unretire` operate on it server-side.
- **System-prompt assembly** → `server/system-prompt.js` (from chat.js
  `getSystemPromptWithMetadata`, chat.js:2569): prime-directive blob (the server already
  fetches it for config generation, server.js:2160), metadata prefix, user prompt,
  archive-tool context (incl. the current session ID), MCP resource context (answered by
  the server MCP pool). Output must be byte-equivalent to today's — drift silently
  changes every model's behavior. (Deep-dive G1.)
- MCP client → `server/mcp/` (from chat/js/mcp-client.js — fetch-based SSE reader +
  JSON-RPC POST; Node ≥18 fetch works the same). MCP server list moves from browser
  localStorage to per-user server-side settings.

### 2.4 Versioning — durable variants (deep-dive §6)

Today versions are in-memory only: `regenerate` appends an orphaned second assistant
message to the store while `switchVersion` persists nothing, and reload collapses
multiple assistant messages into one (concatenated content, single version). Store and
view diverge by design — do not port this.

Target model: the assistant message doc owns its variants.

```js
{ role: 'assistant', content, reasoning_content, thinking_signature,
  usage, context, streamStats, model, timestamp,        // = the current variant
  versions: [ { content, reasoning_content, thinking_signature,
                usage, context, streamStats, model, timestamp } ],
  currentVersion }
```

- Top-level fields mirror the current variant (consumers that don't care about
  versions see a normal message).
- `regenerate` = a run operation: the runner streams a new response, appends it as a
  variant (full shape — fixes today's `{content, timestamp}`-only inconsistency), sets
  `currentVersion`, persists, broadcasts.
- `switchVersion` = a cheap server call flipping `currentVersion`, persisted and
  broadcast (`msg.variant {messageId, currentVersion}` — a pointer change, not a
  structural mutation). Selection is conversation state: switch on the desktop, the
  phone shows the same variant.
- The API view (`getMessagesForApi`) uses the current variant only.
- Embed fires per variant creation; the vector payload gains a variant index
  (`{chatId, msgIdx, variant}`) — implementation detail.
- Old data: past regenerates left orphaned duplicate assistant messages in existing
  conversations. Leave them (they render as separate messages); an optional later
  migration can fold consecutive assistant messages into variants.

## 3. Event protocol (`GET /api/chats/:id/events`)

SSE, framed like embed-events (server.js:852–882: `text/event-stream`, `:ok` comment,
15s keepalive, `req.on('close')` → drop the view from `views`).

**On attach:** one `event: snapshot` — full state: `meta`, `messages[]` (stored form,
embedStatus included), `inFlight` (if a run is active), `usage/context` of the last run.

**Incremental events (during a run):**

| Event | Payload | Notes |
|-------|---------|-------|
| `msg.user` | message | appended + persisted |
| `run.start` | `{exchangeId, model}` | |
| `delta` | `{content?, reasoningContent?}` | raw rate; the view debounces rendering (as today) |
| `tool.start` | `{toolCallId, name, args}` | |
| `tool.end` | `{toolCallId, name, status, resultMessage}` | result message also persisted |
| `msg.assistant` | message | appended + persisted |
| `run.end` | `{finishReason, usage, context, aborted?}` | |
| `embed.status` | `{messageId, status}` | folds today's separate `/api/embed-events` channel into the conversation stream |
| `error` | `{code, message, raw?}` | gateway/provider errors, relayed faithfully (the view's crash-self-heal renders them) |

**Structural mutations** (edit/delete messages, rename, clear): rare — the runner
re-broadcasts a full `snapshot`. No fine-grained mutation events; correctness over
cleverness.

Attach mid-run: the snapshot contains `inFlight`, so the view renders the partial
immediately and continues from live `delta`s. **No replay buffer, no offsets, no
streamIds.**

## 4. Tool execution, server-side

The survey's "browser-bound tools" (H1) was a retrofit artifact. Server-side, reach
*increases* (no CORS). Routing inside the runner:

| Tool class | Today | In the runner |
|------------|-------|---------------|
| MCP tools | browser mcp-client.js | server MCP pool (per-user config) |
| `chat_archive_*` | browser → backend REST | internal calls into the same handlers the REST routes wrap |
| `browser_fetch` | browser fetch (CORS-bound) | Node fetch — LAN + internet. Log every call. (Family trust model; note as the one place CORS used to be an accidental guard.) |
| `saveToStorage` | browser PUT → MCP storage box | server PUT to the storage box (same LAN) |
| `context_retire`/`unretire` | browser, reads `_lastChunkTable` | server-side — the chunk table lives with the ported transform (§2.3) |
| `attachment_save`, base64 image offload | browser round-trip | internal `db.storeFile` — no HTTP hop; issue #5 (bucket 401s) dissolves because the server reads its own buckets |
| Preview | DOM | The tool returns data; the *view* renders a preview affordance from `tool.end`. Preview becomes pure view. |

Vision-tool filtering (`shouldFilterVisionTools`, issues #9/#11) moves into the
runner's tool selection.

## 5. The view

The EXISTING `chat/` UI is the view (PC realign 2026-08-24 — rewired in place, not rebuilt).
It is: conversation view (snapshot + events rendered with NUI — markdown, thinking blocks,
images, tool UI), input + attachments (existing bucket PUT upload), sidebar (existing
history/search REST), TTS playback (nSpeech SDK stays browser-side — audio output is
inherently local), settings UI. The renderer is load-bearing and untouched; only the data
plumbing changed (send → `/send`, render ← `/events`).

It is NOT (anymore): a state machine, a persistence layer, a gateway client, an MCP client.

Build the view against five cross-process contracts, not the old client's incidental
formats (deep-dive §3.7):

1. **Timestamp prefix** — the snapshot exposes `{content, timestamp}` separately; no
   client-side strip-by-length.
2. **Keying** — events carry stable `messageId`/`toolCallId`; the DOM keys off those
   (today: client-generated `ex_*`, tool↔assistant paired by `exchangeId`).
3. **Versioning** — runner-owned durable variants (§2.4); regenerate/switch-version
   are server operations, the view renders the current variant.
4. **System prompt** — the view never assembles it; it edits the user portion only.
5. **Module boundary** — the render pipeline (markdown/thinking/tool/image/context-usage)
   is one module whose state source is the event stream; zero orchestration imports.

Parity checklist (expand during Phase C): streaming render, thinking blocks, tool UI,
image display + viewer, message edit/delete, pin/clone, export/import, system-prompt
presets, context/usage display, TTS controls, search UI, login, admin, arena view.

## 6. Arena

Arena = a runner variant: N participants, a turn-taking policy, the same event stream,
a spectator view. It becomes server-resident and autonomous — conversations that run
whether or not anyone watches. Deferred until the chat path is proven; answers the
spec's open question: **same backend machinery, own view.**

## 7. Failure modes & limits

- **Server restart mid-run:** in-flight partial lost; user message safe; the view shows
  the conversation with the last completed state. Acceptable (matches retrofit plan).
- **Gateway non-2xx before streaming:** runner broadcasts `error` with the upstream
  status + body; nothing persisted. The view renders it like today's crash-self-heal.
- **Two tabs/devices on the same conversation:** both attach to the same runner; the
  runner lazy-loads and is the single author, so sequential use is fine. Simultaneous
  use is a don't — documented, not enforced (dev-phase concern only).
- **Concurrent sends:** no guard — appends are just added prompts (same user, other
  device). Runs never overlap; pending messages queue and batch into the follow-up run.
- **Orphaned runs** (all views detached): the run completes and persists regardless —
  this is the point. Cost is bounded by the gateway request itself.
- **nDB find() does not return live references** — objects held across writes go stale.
  First PA bug: the runner's cached conv produced empty payloads (gateway 400
  "at least one message is required"). Long-lived holders re-read at use points
  (`runner.refresh()`); verified by acceptance 2026-08-24.
- **Message ordering is contractual (E2E-found, 2026-08-24):** the in-flight assistant
  message is persisted at its RESERVED position (`insertConversationMessageAt`,
  atIdx reserved at run start). Queued sends append after it. Without this, an abort
  during a queued send produces an assistant-FINAL payload — which providers treat as
  a prefill, and in thinking mode a prefill without thinking blocks 400s
  ("content[].thinking must be passed back"). Related rule: aborted runs persist
  content only — reasoning cut mid-stream is a malformed thinking block; and the API
  view drops reasoning_content that lacks a thinking_signature (unsigned = poison).

## 8. Remaining channels

`/v1/models` + `/health` for the model dropdown → thin same-origin proxy
(`GET /api/models`, brief cache). Channels 7/8 dissolve into server-side tool
execution (§4).

**TTS (channel 4) splits into three planes.** *Playback* is inherently client-side —
audio happens where the human is (MediaSource + Audio in the view); playback state is
ephemeral view state, never synced. *Control plane* (voices, engines,
`/v1/audio/speech`, `/v1/admin/events`) is stateless — it gets a plain backend proxy,
needed only by P2 (nSpeech binds to localhost; the browser reaches :443 only).
*Config* (endpoint, engine, voice, speed) is user profile data — moves to
`/api/user/settings` so it follows the user across devices (PC). The runner never
touches audio for chat; server-side TTS production (arena episodes, RAUM pipeline)
is a separate batch concern, out of scope here.

## 9. Migration phases (strangler — old client works until cutover)

| Phase | Deliverable | Acceptance |
|-------|-------------|------------|
| **A — runner core** | runner.js, event stream, send/abort routes, gateway call, shared append+embed helper, ported api-view + chunk-view. Tools disabled. | Kill the tab mid-stream → reopen → generation still running or already persisted. Attach from two browsers → both live. |
| **B — tool port** | server MCP pool, internal archive/storage tools, tool events, server-side recursion | A tool-chain conversation runs with the browser closed between calls. |
| **C — view parity** | rewire the existing `chat/` UI to the runner (snapshot + events); tool/delete/edit/regenerate/variant; retire orchestration | Daily-driver `chat/` against the runner for a week; the old gateway/MCP client code is gone. |
| **D — cutover** | old client retired (or kept read-only), dead code removed (client-sdk.js, browser mcp-client.js, conversation state machine), arena re-based on runner, TTS proxy | `chat/js/` shrinks to a view. |

Then **P2** (nPort cutover) and **P3** (multi-user enforcement) as already specced —
both get easier: identity attaches at the runner, per-user DBs already isolate.

## 10. Open implementation questions

- Gateway `session_id` semantics (today sent in requestBody) — verify what the gateway
  does with it (KV affinity?); runner passes a conversation-derived value.
- Error-contract mapping: which upstream statuses become `error` events vs. thrown
  5xx on `send`.
- Embed-status channel: keep `/api/embed-events` for the old client until cutover;
  the runner also emits `embed.status` on the conversation stream.
- MCP server config migration: browser localStorage → per-user server settings.
- Batching semantics: how multiple queued user messages are presented to the model
  (separate user turns vs. one merged turn) — pin during PA.
- Vision/bucket origin: which absolute origin the runner hands the gateway for image
  URLs (interacts with issue #5 and P2 localhost binding) — deep-dive G4/G6.
