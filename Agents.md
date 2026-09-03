# LLM Gateway Chat — Agent Instructions

> **This file governs the live repo** `D:\SRV\LLM-Gateway-Chat` on `master`, port 8080. The BFF refactor shipped 2026-08-28 (`bff-rework` merged into `master`); the old `D:\DEV` worktree workflow is suspended (its git admin points at a stale `.old` worktree — re-clone `D:\DEV` before resuming branch-based dev).

## Read First

1. The prime directive — core maxims, fail-fast, memory protocol. Applies fully.
2. **The Technical Spec below (§Technical Spec)** — the fastest route to "how does this codebase work": the runner model, event protocol, data model, context/cost management, tools, and forward roadmap.
3. [docs/architecture-conversation-runner.md](docs/architecture-conversation-runner.md) — the design authority: the conversation is a server-side session; the browser is an attach/detach view.
4. `docs/codebase-survey-bff.md` — the channel × callsite map of the client-centric code. Keep it updated; do not duplicate its call-shape tables into this file (snapshots drift, pointers don't).

## Operating Rules

- **Master IS live.** Work directly in `D:\SRV` on `master`; the server runs under nPM — coordinate stop/start with the user around backend edits and restarts.
- **Submodules: check for updates at the start of every work session.** Fetch in each of `lib/ndb`, `lib/nvdb`, `lib/nlogger`, `lib/nui_wc2` and fast-forward to the remote default branch; commit the pointer bump separately. Windows gotcha: a running server keeps ndb's napi `.node` binary locked — stop the server before updating `lib/ndb`, and load-test after: `node -e "require('./lib/ndb/napi')"`.
- Server does not auto-restart — restart after backend edits. A `Chat Backend running at …` log line means the process started, not that the command returned. Start servers in background; poll `/api/config` or `/health` for readiness (never an SSE endpoint — it hangs the request).

## Project Overview

Vanilla JavaScript SPA + own Node.js backend. No build step. Connects to an LLM Gateway for chat streaming and embeddings; persistence in embedded Rust DBs (nDB documents, nVDB vectors).

**The refactor SHIPPED 2026-08-28:** the ConversationRunner architecture runs live — conversations are server-side sessions, the browser is a disposable attach/detach view over `snapshot + events`, persistence is a side effect of the runner's traffic. The existing `chat/` UI is wired to the runner (`send` → `/send`, render ← `/events`); tools execute server-side; the arena conversation is a server-side autonomous session with `chat-arena/` as spectator view; TTS is proxied same-origin via `/api/tts/*` (f319393). Remaining direct-gateway remnant: arena summary generation + legacy import; dead browser orchestration (client-sdk/mcp-client/conversation state machine) awaits the PD cleanup pass. Completed phase plans and session handovers are archived under `docs/_Archive/`.

## Technology Stack

| Layer | Technology |
|-------|------------|
| Language | Vanilla JS (ES2022+), HTML5, CSS3 — no TypeScript, no build |
| UI | NUI Web Components (git submodule `lib/nui_wc2/`) |
| Backend | Node.js raw `http` + hand-rolled router (`server/server.js`) — zero framework deps |
| Structured DB | nDB (Rust JSON-Lines store, submodule `lib/ndb/`) |
| Dead deps | `express` + `@seald-io/nedb` in package.json are never imported — remove in a cleanup pass |
| Vector DB | nVDB (Rust, submodule `lib/nvdb/`) |
| Embedding | Gateway `/v1/embeddings` (Qwen3-Embedding-4B, 2560d) |
| Transport | SSE to gateway + same-origin REST/SSE to backend |
| Logging | nLogger (JSON Lines) |

## Project Structure

```
├── chat/            # Main SPA (index.html, css/, js/)
├── chat-arena/      # Arena mode (LLM-to-LLM autonomous conversations)
├── lib/             # Submodules: nui_wc2, ndb, nvdb, nlogger; tts/
├── server/          # Backend: server.js (router+routes), runner.js, arena-runner.js,
│                    #   conversation-store.js, api-view.js, system-prompt.js, mcp-pool.js,
│                    #   internal-tools.js, embed.js, config.json, migrations (historical)
│   ├── data/        # nDB + nVDB files (gitignored, per-user subdirs)
│   └── logs/        # JSON Lines logs (gitignored)
└── docs/            # Governing spec + codebase survey
```

## Module Map (browser side)

| Module | Role |
|--------|------|
| `chat/js/chat.js` | UI controller + runner event handlers (`_runner*`): rendering, login, presets, admin; send → `/send`, render ← `/events` |
| `chat/js/runner-client.js` | same-origin SSE attach + REST (`send`/`abort`/`deleteMessage`/`editMessage`) + list-events sync (`attachListEvents`) — the view's only backend for a runner-owned conversation |
| `chat/js/client-sdk.js` | `GatewayClient` — SSE-over-REST to gateway. **Retired for chat** (the runner owns the gateway call); still used by arena summary generation — a PD remnant |
| `chat/js/api-client.js` | `BackendClient` — same-origin REST (cookie auth, `/api/chats`, `/api/search`, `/api/auth/*`) |
| `chat/js/conversation.js` | `messagesToExchanges` (stored→exchange projection). State machine / persistence / API formatting **retired** |
| `chat/js/chat-history.js` | Multi-conversation management, backend CRUD, localStorage fallback |
| `chat/js/mcp-client.js` | MCP SSE connections, tool registry. **Retired** — tools run server-side in the runner |
| `chat/js/file-store.js` | Attachment upload → `/api/buckets/images/…`, returns lightweight URLs |
| `chat/js/preview.js`, `preview-url.js`, `chunk-view.js` | Preview pane + chunk inspection |
| `chat-arena/js/arena.js` | Arena **spectator view** over the server ArenaRunner (snapshot + events via `/api/chats/:id/events`, start/stop/extend via `/api/arena/:id/*`). Legacy `Participant`/`Arena` classes (lines ~40–1165) are dead orchestration except: summary generation (`summarize`, direct `GatewayClient`) and legacy import — **cutover remnants** |

## Module Map (server side)

| Module | Role |
|--------|------|
| `server/runner.js` | ConversationRunner — single author of chat conversation state; gateway stream, tool loop, queued sends |
| `server/arena-runner.js` | ArenaRunner — autonomous N-participant runner variant; no tools; refreshes store state every turn; derives turn/speaker from history on (re)start |
| `server/conversation-store.js` | Shared stored-form authoring: append/insert-at/edit messages, session↔conversation resolution. nDB `find()` returns detached copies — **re-read at every use point, never cache across writes** |
| `server/api-view.js` | Stored → provider payload projection (ported `getMessagesForApi`), vision base64 inlining |
| `server/system-prompt.js` | System-prompt assembly (prime-directive blob + metadata + tool context) |
| `server/mcp-pool.js`, `internal-tools.js` | Server-side tool execution (MCP SSE pool + internal archive/storage/bucket tools) |
| `server/embed.js` | Embed pipeline: fire-and-forget, retry backoff, startup reconciliation, `embed.status` events |

## Technical Spec — How This Codebase Works

Quick-access reference for an LLM arriving here. Deeper detail: [architecture-conversation-runner.md](docs/architecture-conversation-runner.md) (design authority) and [codebase-survey-bff.md](docs/codebase-survey-bff.md) (channel map).

### The model: conversation is a server-side session

A conversation is a **server-side session**; the browser is a **disposable attach/detach view** over `snapshot + events` (tmux model). Three load-bearing principles:

1. **Single author.** `server/runner.js` (the ConversationRunner) is the ONLY writer of conversation state. No client ever persists a message — this deletes the whole class of double-write guards.
2. **The store is canonical, the runner is a cache.** nDB holds the durable conversation doc (format unchanged). The runner holds the same messages in memory + the only non-recoverable state: the in-flight generation.
3. **The view is disposable.** Browser state is a projection of `snapshot + events`. Killing a tab changes nothing.

**One Runner per `{user}:{conversation}` pair** (the registry key is `${userId}:${conversationId}`, `server/runner.js:36`). "Per conversation", not "per tab": the same user's tabs/devices on the SAME conversation all attach to the ONE Runner; different conversations get separate Runners and run in parallel; different users never share a Runner (per-user `dbPath` isolation). Lifecycle: lazy mount on first attach/send → idle unload after N minutes with no views and no run → remount on demand. Server restart loses only `inFlight` (everything completed is already persisted).

**Concurrency — serialization is per-conversation, not global:** sends are always accepted — appended, persisted, broadcast immediately. A send is just an added prompt. What must never happen is concurrent **runs** (two gateway streams interleaving assistant output into one conversation) — runs serialize *within a conversation*; a send during an active run queues and batches into a follow-up run. Different conversations stream in parallel (independent Runners, no shared lock). Connection state carries no semantics: abort is an explicit API call; a closed browser is just one less listener.

### Event protocol (`GET /api/chats/:id/events`)

SSE, framed like embed-events (15s keepalive, drop the view on close). **On attach: one `event: snapshot`** — full state: `meta`, `messages[]` (stored form, `embedStatus` included), `inFlight` (if a run is active), `usage/context` of the last run.

Incremental events during a run:

| Event | Payload |
|-------|---------|
| `msg.user` | message (appended + persisted) |
| `run.start` | `{exchangeId, model}` |
| `delta` | `{content?, reasoningContent?}` — raw rate; the view debounces |
| `tool.start` | `{toolCallId, name, args}` |
| `tool.end` | `{toolCallId, name, status, resultMessage}` (result also persisted) |
| `msg.assistant` | message (appended + persisted) |
| `run.end` | `{finishReason, usage, context, aborted?}` |
| `embed.status` | `{messageId, status}` |
| `error` | `{code, message, raw?}` — gateway/provider errors relayed faithfully |

Structural mutations (edit/delete/rename/clear): the runner re-broadcasts a full `snapshot`. No fine-grained mutation events. Attach mid-run: the snapshot carries `inFlight`, so the view renders the partial immediately and continues from live deltas. **No replay buffer, no offsets, no streamIds.**

### Runner routes (all cookie-auth, per-user DB isolation)

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/chats/:id/send` | Append user message + start a run (queued if one is active). Body = raw stored-form fields (`content`, `attachments`, …). Returns `{exchangeId}`. |
| `GET` | `/api/chats/:id/events` | Attach to the conversation SSE stream (snapshot + live events). |
| `POST` | `/api/chats/:id/abort` | Abort the active run. |

Existing `/api/chats/*` CRUD (list/rename/pin/delete), `/api/search`, `/api/buckets/*`, `/api/user/settings`, `/api/models`, admin — unchanged.

### Stored data model (nDB)

- One conversation document per session (`_type: 'conversation'`, inline `messages[]`).
- Message **stored form**: `role`, `content`, timestamp prefix, attachments offloaded to `_file` nURIs, tool message shape (`toolName`/`toolArgs`/`toolStatus`/`toolImages`), assistant metadata (`reasoning_content`, `thinking_signature`, `streamStats`, `usage`, `context`), per-message `embedStatus`.
- **nDB `find()` returns detached copies** — re-read at every use point, never cache across writes (`runner.refresh()`). Objects held across writes go stale.
- Vectors in nVDB keyed by message ID, payload `{chatId, msgIdx}`. Users in `users_db` (scrypt-hashed, per-user `dbPath` isolation).
- **Message ordering is contractual:** the in-flight assistant message is persisted at its RESERVED position (`insertConversationMessageAt`, `atIdx` reserved at run start); queued sends append after it. Without this, an abort during a queued send produces an assistant-FINAL payload (providers treat as prefill; thinking-mode prefills 400).
- Aborted runs persist **content only** — reasoning cut mid-stream is a malformed thinking block.

### Context & cost management

- **The runner counts, not the gateway.** `server/token-count.js` (`countApiMessages`/`breakdownApiMessages`, js-tiktoken cl100k/o200k) is fed the full field set (content + reasoning_content + tool_calls + tool results + image costs). The gateway's own estimate only reads `content` and under-counts thinking/tool chats by 58–91%.
- `_assemblePayload()` in `server/runner.js` is shared by `runOnce` (live turn) and `buildSnapshot` (on-load) — identical payload → no load/send flip. **The context pill = the on-the-wire payload** (what the next request consumes), not raw stored history.
- **Measures** (audited against "saving must exceed cache-break cost"): dedup/chunk-collapse (cache-neutral, keep), retirement/tombstones (breaking by design — batch them), unretire, merge/auto-heal.
- **Chunk IDs are content-derived**: `chunk_` + `fnv1a64(bareContent).toString(36)`. Tombstones key retirements by content hash. Label regex `^chunk_[a-z0-9]+$`. Accept both on read; never rewrite stored numeric labels.
- **Chunk labels are view-only** — never file content, never tool payload (#30). The runner scrubs outbound tool args before dispatch: leading labels are stripped (logged loud + flagged in the tool result), a bare label as a value is rejected with an error. The chunk-view convention paragraph teaches this contract; never reintroduce "labels persist in files".
- **Per-provider prior-reasoning policy** (in the gateway, `capabilities.priorReasoning`; the chat `api-view` strip was REMOVED — reasoning passes through verbatim):

| Provider | `priorReasoning` | Why |
|----------|------------------|-----|
| DeepSeek | `keep-with-tools` | No-tools: prior reasoning ignored → strip free. With tools: omitting → API 400. |
| OpenAI | `strip` | Silently **ignored**, not rejected; keeping is pure token waste. |
| xAI (Grok) | `keep` | Omitting prior reasoning = documented #1 cache-miss cause. |
| Anthropic | `keep` | Structured thinking blocks with signatures must round-trip verbatim during tool use. |
| Kimi | `keep` | `reasoning_content` always present and must be echoed. |
| z.AI (GLM) | `keep` (with `clear_thinking:false`) | server-side clear default; retaining keeps the prefix append-only. |
| unknown | `keep` | cache-safe default. |

- **`thinking_signature`**: assistant reasoning is only kept on the wire when it carries a signature (Anthropic contract guard). Unsigned reasoning = poison, dropped.

### Tool execution (server-side)

Tools run in the runner, not the browser. `server/mcp-pool.js` (per-user MCP pool, JSON-RPC, settings-sourced config) + `server/internal-tools.js` (archive/storage/fetch). Runner tool loop: `tool.start`/`tool.end` events, single-author tool messages, 12-hop cap, server-side recursion. MCP images → internal buckets. **Preview is pure view** — the tool returns data; the view renders a preview affordance from `tool.end`. Server-side reach *increases* vs the old browser-bound tools (no CORS). `browser_fetch` is the one place CORS used to be an accidental guard — log every call.

### Forward roadmap (not yet done)

- **P2 — nPort cutover:** bind all services to localhost/127.0.0.1, close direct ports, public surface = 443 only. OPNSense forwards 80/443; nPort runs as a Windows service (nssm). Verify `/health` + `/v1/models` via public domain.
- **P3 — Multi-user data-layer enforcement (family model):** every memory/storage record gets `owner` (usr_id). Write/delete requires `sub == owner`; read is family-wide. No ACLs/groups — family-only. Reconcile chat `users_db` with nPort identity (nPort owns WHO, chat owns WHAT keyed by `sub`).
- **P4 — Token hygiene (nPort):** `label` + `createdAt` on all tokens; session tokens get `exp`; server-side `exp` enforcement; kind policy (sessions vs apikeys gated per surface); revoke stale test sessions.
- **PD cutover remnants:** dead browser orchestration (`client-sdk.js`, `mcp-client.js`, conversation state machine) awaits removal; arena summary generation + legacy import still direct-gateway.

### Open questions

- **Memory privacy exception:** twin/biography/psychology memories may need a private scope overriding the family-readable default.
- **Chat `users_db` migration:** adopt nPort identity for login, keep per-user profile data keyed by `sub`? Decide at P3 kickoff.
- **Context alignment (unresolved):** the user reports mutual understanding drifts on very long conversations. Hypothesis: stripping prior reasoning removes the model's visible chain-of-thought, so misreadings compound instead of self-correcting. Experiment (do NOT assert without it): same long task, same model, reasoning kept vs stripped, compare felt alignment. Per-provider policy is the likely fix.

## Invariants That Survive the Refactor

- **NUI components only** for UI controls (`nui-input`, `nui-select`, …) — never raw HTML controls. Style via theme variables (`--color-base`, `--text-color`, `--nui-accent`, `--nui-space`, …), not custom CSS on components.
- **Code style:** 4-space indent, single quotes, semicolons, ES6 modules. Flat explicit logic; dense colocation; minimal comments (structural markers only).
- **Data model:** one conversation document per session (`_type: 'conversation'`, inline `messages` array with per-message `embedStatus`). Vectors in nVDB keyed by message ID with `{ chatId, msgIdx }` payload. Users in `users_db` (scrypt-hashed, per-user `dbPath` isolation) — reconciled with nPort identity at P3.
- **Embedding pipeline** (server-side, stays): fire-and-forget after message POST, startup reconciliation nDB↔nVDB, SSE `embed-status` events, retry with escalating backoff.
- **Image lifecycle:** base64 intercepted client-side → bucket upload → lightweight URL in message JSON. On chat delete, refs are garbage-collected via `db.releaseFile` (orphans → `.trash`).
- **Tool execution is server-side** (runner `mcp-pool` + `internal-tools`); the view renders `tool.start`/`tool.end` events. The browser no longer runs tools, assembles system prompts, or orchestrates the gateway — it is a view over the runner's snapshot + event stream.

## Security

- Cookie-only auth (HttpOnly), same-origin by default, no secrets in frontend.
- `nui-markdown` escapes `& < >` before formatting, but attribute-value/URL-scheme hardening is a known gap owned by **nui_wc2** — don't build markdown sanitization here.
- nPort cutover (P2) binds services to localhost; public surface becomes 443 only.

## Visual Verification (UI changes)

Reach the target UI state in the integrated browser (`http://localhost:8080/chat/`), save a cropped element screenshot under `_scratch/`, then launch a subagent on model `minimax-m3-chat (customendpoint)` with the PNG path + a precise checklist. Trust DOM geometry for numbers; use the subagent for appearance (clipping, overlap, alignment). It can produce false positives — confirm with the DOM before acting.

## References

- Completed refactor spec (archived, shipped 2026-08-28): [docs/_Archive/plan-backend-routed-refactor.md](docs/_Archive/plan-backend-routed-refactor.md) · Tracking: GitHub issue #12
- Context saga + cost plan (archived, shipped 2026-08-29): [docs/_Archive/context-length-saga.md](docs/_Archive/context-length-saga.md) · [docs/_Archive/plan-context-cost-and-reporting.md](docs/_Archive/plan-context-cost-and-reporting.md)
- Gateway API docs live in the **LLM-Gateway** repo (`docs/api_rest.md` there) — the copy in this repo was removed as drift-prone.
- NUI: `lib/nui_wc2/Agents.md`, `lib/nui_wc2/LLM-CHEATSHEET.md`
- nDB / nVDB: `lib/ndb/AGENTS.md`, `lib/ndb/docs/`
