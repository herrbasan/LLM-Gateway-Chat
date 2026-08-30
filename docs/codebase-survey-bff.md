# Codebase Survey — Backend-Routed (BFF) Refactor

**Author:** deepseek-flash-chat survey (P−1)
**Date:** 2026-08-23
**Scope:** `D:\DEV\LLM-Gateway-Chat` (branch `bff-rework`) — written pre-ship; the branch merged to `master` 2026-08-28, so `D:\DEV` paths now read as `D:\SRV`. Line citations are a 2026-08-23 snapshot; retired channels are marked inline.
**Purpose:** Test the six-channel hypothesis in `docs/_Archive/plan-backend-routed-refactor.md` §1 against the actual code, inventory callsites and coupling, and correct spec §2.
**Tracking:** LLM-Gateway-Chat issue #12.

Every claim carries a `file:line` citation. Speculation is marked **[SPECULATION]**.
Browser module root = `chat/js/`, `chat-arena/js/`, `lib/tts/`. Server = `server/server.js` unless stated.

---

## 7. Bottom line first — is the six-channel hypothesis complete?

**No. The hypothesis is incomplete in two directions:**

1. **It is stale about channel 4 (TTS).** The hypothesis's "TTS GET `/voices` + GET `/tts?params` … audio via `new Audio(url)`" describes the **retired** pre-nSpeech-V3 path. The live TTS channel is the nSpeech V3 SDK (`NSpeechController` + `SpeechPlayer`) calling a much larger REST/SSE surface (`/v1/audio/speech`, `/v1/voices` + engine variants, `/v1/admin/engines`, `/v1/text/clean`, `/v1/voices/clone|preview|mix|preset|:id`, `/v1/admin/engine`, `/health`, `/engine`, and an `EventSource /v1/admin/events`). No `GET /tts` and no bare `new Audio(url)` exist anywhere in `chat/` or `chat-arena/` (grep for `/tts\b` and `new Audio(` matched nothing in the SPA code; the audio is streamed via `MediaSource` + `Audio` inside `lib/tts/nspeech-client.js`).

2. **It misses two additional browser→upstream channels** that the browser currently opens directly (both cross-origin):
   - **Ch 7 — browser→MCP storage box over plain HTTP (PUT), bypassing the MCP SSE protocol.** `chat_archive_get_session({saveToStorage:true})` and the `saveToStorage` branch of the archive tools write session JSON straight to `${mcpServerOrigin}/storage/<path>` (chat.js:556–585; origin derived in `getMcpServerOrigin()`, chat.js:115). This is a browser→MCP-server HTTP PUT.
   - **Ch 8 — `browser_fetch`, an arbitrary-URL browser `fetch()`** (chat.js:803, `executeBrowserFetch`; definition in `ARCHIVE_TOOLS`, chat.js:126–322). Used by the `browser_fetch`, `attachment_save`, `storage_read`/`storage_write` round-trips and any tool that pulls/pushes bytes from the LAN or internet. It is cross-origin by design (subject to CORS).

Also worth stating: channels 1/2/6 are all **the same underlying GatewayClient SSE/REST client** (`chat/js/client-sdk.js`) instantiated with different `baseUrl`s (chat, arena participant, arena summary). They are three callsites of two upstream endpoints, not three distinct protocols.

**Corrected channel list (8 browser→upstream):**

| # | Channel | Module(s) | Cross-origin? |
|---|---------|-----------|---------------|
| 1 | Gateway SSE POST `/v1/chat/completions` | client-sdk.js (via chat.js, arena.js) | Yes |
| 2 | Gateway REST GET `/v1/models`, `/health` | client-sdk.js | Yes |
| 3 | Gateway WebSocket `/v1/realtime` | **retired** — no code | — |
| 4 | nSpeech V3 REST/SSE/EventSource + audio stream | NSpeechController / SpeechPlayer | Yes |
| 5 | MCP SSE connect + POST JSON-RPC | mcp-client.js | Yes |
| 6 | Arena per-participant GatewayClient instances | arena.js | Yes — **RETIRED 2026-08-26** (see Channel 6 note) |
| 7 | MCP storage box plain-HTTP PUT `/storage/...` | chat.js archive tools | Yes |
| 8 | `browser_fetch` arbitrary URL | chat.js | Yes (by design) |

**The only already-same-origin traffic is the chat backend itself** (BackendClient, file-store, archive-tool REST to `/api/...`, embed-status SSE) — because the server dynamically generates `backendUrl:''` into `config.js`. But note the trap: the *code default* for that base is `http://localhost:3500`, not `''` (api-client.js:289). Same-origin holds **only** because of the generated config, not the code.

---

## 1. Channel × callsite table

### Channel 1 — Gateway SSE POST `/v1/chat/completions`

| Aspect | Value | Evidence |
|--------|-------|----------|
| URL | `${restUrl}/v1/chat/completions` | client-sdk.js:133 |
| Method | POST | client-sdk.js:131 |
| Streaming | SSE (fetch body reader, line-split, `event:`/`data:`) | client-sdk.js:136–241 |
| Auth | `Authorization: Bearer ${accessKey}` (optional; empty if no key) | client-sdk.js:145–147 |
| Payload | `{...params, stream:true, session_id}` — params from caller incl. `model`, `messages`, `temperature`, `reasoning_effort`, `max_tokens`, `tools`, `image_processing` | client-sdk.js:155–159; requestBody chat.js:3107–3157 |
| Default `restUrl` | `http://localhost:3400` | client-sdk.js:54 |
| Actual base for chat | `GATEWAY_URL = localStorage.getItem('gateway-url') || ''` → **empty → relative → same-origin** | chat.js:40, 1161 |
| Callsites | chat stream: chat.js:3180 (`for await … streamChatIterable`); arena participant: arena.js:114; arena summary: arena.js:1104 | |

**Key finding:** the chat `GatewayClient` base URL is **not** the generated `config.js` `gatewayUrl` — it is `localStorage['gateway-url']`, default `''`. The generated `gatewayUrl` field (server.js:2161) is **never read** by chat.js (grep for `CONFIG.gatewayUrl` returns nothing). With a clean browser (no localStorage) and no proxy in place, the default `''` makes the SSE POST hit the **chat backend origin** at `/v1/chat/completions`, which the server does not proxy → 404. Out-of-box the chat only works after the user sets `gateway-url` in localStorage (or once P0 adds the proxy and the client stops needing localStorage).

### Channel 2 — Gateway REST GET `/v1/models` + `/health`

| Aspect | Value | Evidence |
|--------|-------|----------|
| `getModels()` | `GET ${restUrl}/v1/models`, Bearer if key | client-sdk.js:78–84 |
| `getHealth()` | `GET ${restUrl}/health`, no auth header | client-sdk.js:86–91 |
| Used by | chat gateway connect / model dropdown populate (chat.js:1899–1901 area); arena uses the same GatewayClient for `/v1/models` | |

### Channel 3 — Gateway WebSocket `/v1/realtime`

**Retired — confirmed.** `client-sdk.js:1–2`: "SSE-only transport for LLM Gateway — WebSocket transport was removed after the gateway retired /v1/realtime." No WebSocket code remains. The spec's hypothesis claim "believed retired" is **verified correct**; no action needed beyond removing the entry.

### Channel 4 — nSpeech V3 (TTS) — **hypothesis is wrong about the shape**

`chat.js` instantiates one `NSpeechController` (chat.js:1915) plus a `TtsPlayerHost` (chat.js:1917). arena.js imports the same two (arena.js:12–13) and wires a controller with arena voices (arena.js:1681–1684). Endpoint resolution: `TTS_ENDPOINT = CONFIG.ttsEndpoint || 'http://localhost:2233'` (chat.js:45); NSpeechController default `http://localhost:2233` (nspeech-controller.js:28) with localStorage `'tts-endpoint'` override (nspeech-controller.js:47,64).

All traffic flows through `nspeech-client.js._fetch()` → `fetch(baseUrl + path)` (nspeech-client.js:804–806), where `baseUrl = this.endpoint`:

| Call | Method | Evidence |
|------|--------|----------|
| `/v1/audio/speech` (SSE-streamed audio via MediaSource) | POST | nspeech-client.js:365 |
| `/v1/text/clean` | POST | nspeech-client.js:466 |
| `/v1/voices` (+ `?engine=`) | GET | nspeech-client.js:498; nspeech-controller.js:369,398 |
| `/v1/voices/clone` / `/v1/voices/preview` / `/v1/voices/mix` / `/v1/voices/preset` / `/v1/voices/:id` | GET | nspeech-client.js:547,580,610,638,672 |
| `/v1/admin/engine`, `/v1/admin/engines` | GET | nspeech-client.js:727,775,786 |
| `/engine`, `/health` | GET | nspeech-client.js:786,798 |
| `/v1/admin/events` (live engine events) | EventSource | nspeech-client.js:1439 |

Audio playback uses `Audio()` plus `MediaSource` for streamed `audio/speech` (nspeech-client.js:931). This is **not** a "GET + `new Audio(url)`" passthrough — proxying TTS means proxying an SSE audio POST stream, voice/admin GETs, and an EventSource. P1's "GET query passthrough" gotcha is **incomplete**: it must cover POST streaming audio and EventSource too.

### Channel 5 — MCP SSE + POST JSON-RPC

`mcp-client.js` is the browser MCP client. Config is per-server in localStorage `'mcp-servers'` / `'mcp-enabledTools'` (mcp-client.js:99–130).

| Aspect | Value | Evidence |
|--------|-------|----------|
| Connect | `fetch(sseUrl, {Accept:text/event-stream})`, manual reader; derives `/sse` from url (`/mcp`→`/sse`, `/mcp/compact`→`/sse/compact`) | mcp-client.js:428, 438–449 |
| POST endpoint discovery | `endpoint` SSE event on the connect stream; absolute-izes relative | mcp-client.js:486–493 |
| JSON-RPC POST | `fetch(server.postEndpoint, {POST, jsonrpc payload})`; response via SSE body reader (`_readSSEBodyForId`) or on the main connect stream | mcp-client.js:322–342, 560–650 |
| Methods | `tools/list`, `tools/call`, `resources/list`, `resources/templates/list`, `resources/read|subscribe|unsubscribe`, `notifications/progress` | mcp-client.js:185–267, 500–560 |
| Request/response | `pendingRequests` map; 30s tool timeout; `_readSSEBodyForId` | mcp-client.js:249–267, 645–685 |
| Auto-reconnect | exponential backoff 1s→30s; fails pending on stream death | mcp-client.js:523–557, 500–519 |

The browser both **connects to** MCP servers (SSE) and **executes** tools (POST) itself — the deepest client-orchestration surface (see §3). Arena does not use MCP (arena stream sends `tools: []`, arena.js ~line 100).

### Channel 6 — Arena per-participant GatewayClient instances

`Participant` builds its own `GatewayClient` (arena.js:50–56), base from `options.gatewayUrl || localStorage['gateway-url'] || window.ARENA_CONFIG?.gatewayUrl || ''` (arena.js:44). Summary generation spawns a fresh client via `_createGatewayClient(this.gatewayUrl)` (arena.js:732, 1051) and streams `/v1/chat/completions` (arena.js:1104). Arena `index.html` loads **both** `js/config.js` (static ARENA_CONFIG) and `../chat/js/config.js` (dynamic CHAT_CONFIG) (arena index.html:323, 326), so it also sees `enableBackend`/`backendUrl`.

> **STATUS 2026-08-26 — conversation path RETIRED.** The arena conversation runs server-side in `server/arena-runner.js` (ArenaRunner, landed e06f3dd; fix cluster 5bcd8e2); `ArenaUI` is a spectator over `/api/chats/:id/events` + `/api/arena/:id/*`. The `Participant` class and its per-participant `GatewayClient` (arena.js:50–56, 114) are dead code. **Still live direct-gateway remnants:** summary generation (`Arena.summarize` → arena.js:1051, 1104, called from the options dialog at arena.js:2685) and the legacy import path (`new Arena`, arena.js:810, 2171).

### Channel 7 — browser → MCP storage box plain-HTTP PUT (ADDED)

`chat_archive_get_session({saveToStorage:true})` → `getMcpServerOrigin()` = origin of the first configured MCP server (chat.js:115) → `fetch('${storageBase}/storage/${storagePath}', {PUT})` (chat.js:556–585). Cross-origin; this is how session JSON is offloaded to workshop storage without blowing the LLM context window. **Note:** this URL is the MCP server's *HTTP storage endpoint*, unrelated to the SSE protocol of channel 5.

### Channel 8 — `browser_fetch` arbitrary URL (ADDED)

`executeBrowserFetch` (chat.js:803) performs a direct browser `fetch()` to any URL the model passes — LAN addresses, internet, storage files. `attachment_save` uses it to copy a bucket URL to storage (server→browser→server transfer). Cross-origin by design, CORS-bound.

---

## 2. Server capability inventory (what the backend already offers)

The server (`server/server.js`) is **raw Node `http.createServer`** (server.js:2045) with a hand-rolled router: a `routes` object keyed `'METHOD /path'`, manual `:param` matching, no middleware framework (server.js:2127–2150). CORS preflight handled at server.js:2070–2081.

**Config resolution (env-first)** — server.js:15–36:
- `.env` parsed manually (server.js:15–20); `PORT = CHAT_PORT || cfg.port || 3500` (server.js:31); `USERS_DB_PATH = CHAT_USERS_DB || cfg.usersDbPath || 'server/data/users_db/data.jsonl'` (relative, server.js:35); `SESSION_TTL = (cfg.sessionTtlMinutes || 1440) * 60 * 1000` (ms, server.js:36); `EMBED_URL` default `http://192.168.0.100:3400/v1/embeddings` (server.js:38).

**REST API surface (all require cookie auth unless noted):**

| Route | Method | Purpose | Evidence |
|-------|--------|---------|----------|
| `/health` | GET | liveness (no auth) | server.js:806 |
| `/api/embed-events` | GET | **SSE relay** (see below) | server.js:852–882 |
| `/api/chat-files/:exchangeId` | PUT/GET/DELETE | legacy file exchange (modern write path actually uses nDB buckets) | server.js:895, 922, 953 |
| `/api/buckets/:bucket/:filename` | GET | file bytes (cookie auth) | server.js:968 |
| `/api/files` | GET | storage stats | server.js:1019 |
| `/api/server-type` | GET | `{type:'node-backend'}` | server.js:1042 |
| `/api/client-log` | POST | forward client logs to nLogger | server.js:1048 |
| `/api/auth/login` / `logout` / `session` | POST/POST/GET | cookie auth | server.js:1061, 1138, 1157 |
| `/api/auth/key` | POST | 410 (legacy removed) | server.js:1176 |
| `/api/admin/users` [+/:id, reset-password] | CRUD | user management | server.js:1190–1425 |
| `/api/user/settings` | GET/PUT | per-user settings | server.js:1436–1502 |
| `/api/chats`, `/api/chats/:id`, `/api/chats/:id/messages` | CRUD | sessions + conversation docs | server.js:1512–1780 |
| `/api/search` | POST | hybrid nVDB+text search | server.js:1810 |
| `/api/arena` | GET | list arena sessions | server.js:1990 |
| `/api/references` | POST | lineage | server.js:2010 |

**Static serving:** `/chat/` and `/chat-arena/` redirects + fallback file serve (server.js:2090–2206); `/files/*` served from `FILES_DIR` (server.js:2104–2116); gzip compression for compressible mimes (server.js:543–600).

**Config.js generation — the BFF-friendly part:**
- `/chat/js/config.js` is **dynamically generated** from env: `gatewayUrl`, `defaultModel/Temperature/MaxTokens`, `ttsEndpoint/Voice/Speed`, `backendUrl:''`, `enableBackend`, `enableArchiveTools`, and a fresh prime-directive blob `instructions` (server.js:2160–2177). This is the mechanism P0/P1 will extend to point the client at same-origin proxies.
- `/chat-arena/js/config.js` is served **verbatim** from the static file (server.js:2182–2189) — confirming the spec's P1 gotcha: arena config must become dynamic.

**The SSE relay pattern (P0 template) — `embed-events`:**
`embedEvents = new EventEmitter()` (server.js:452). Producer: `embedEvents.emit('status', {...})` after each embed outcome (server.js:705, 727, 783). Consumer route `GET /api/embed-events?chatId=…` (server.js:852–882): `requireAuth`, `writeHead text/event-stream`, `:ok` comment, per-`chatId` filter, `event: embed-status\ndata: …`, 15s keepalive, cleanup on `req.on('close')`. The browser side subscribes with `new EventSource('/api/embed-events?chatId=…')` (chat.js:4914; arena.js:1865). **This is exactly the pattern P0 wants to replicate for chat streaming** — the difference: embed-events is backend→browser push of completed states, whereas P0 needs a browser→backend→gateway SSE *relay* (bidirectional, mid-stream). The EventEmitter relay pattern carries over; the proxy plumbing does not exist yet.

**Embed pipeline (server-side, stays):** `embedBatch()` (server.js:610–665) with failure classification (`rate_limit`/`server`/`client`/`unavailable`/`response`), circuit breaker (`embedFailCount>=3` → `embedAvailable=false`, server.js:632,647,660,672), retry with `Retry-After`; `embedMessageAsync` (server.js:717) with 3 attempts + re-queue into a per-db `pendingQueue` with escalating backoff; a global 5s drain loop (server.js:220–290); lazy per-user DB mount with startup reconciliation nDB↔nVDB (server.js:352–445); message `embedStatus` writes via atomic `db.set` (server.js:700–711). This is the **server-side model for durable, restart-safe background work** — a useful reference for P0's "don't lose the stream on tab-kill" requirement, though chat streaming is synchronous, not queueable.

**users_db / sessions / isolation:** users live in `users_db` (nDB), seeded from env (`SUPERADMIN_*`) or `config.users` (server.js:140–245), scrypt-hashed (server.js:169). Each user has an isolated per-user `dbPath`; DBs are lazily mounted into `activeDbs` (server.js:302–350) with per-user nDB + nVDB. `GET /api/chats` etc. operate on the authenticated user's isolated DB (server.js:1512–1515).

**Dependency reality (spec correction):**
- **express 5 is declared (`package.json` deps) but never imported.** `server/server.js` is raw `http`. Grep for `require('express')` across all server `.js` → zero hits. **Dead dependency.**
- **`@seald-io/nedb` is declared (`^4.1.2`) but never imported.** Only `server/migrate-import-nedb.js` reads legacy NeDB files, and it does so with its **own** `readNeDB()` implementation (migrate-import-nedb.js:95) using `fs`, not the package. **Dead dependency.** The live data layer is nDB (`lib/ndb`) + nVDB (`lib/nvdb`).
- **Latent bug:** `FILES_DIR` is referenced (server.js:927,957,1022,1029,1031,2109) but **never declared** → any hit to the legacy `/api/chat-files` GET/DELETE, `/api/files`, or `/files/*` throws `ReferenceError` at runtime (caught → 500/404). The modern image path (PUT `/api/chat-files` → `dbInstance.db.storeFile('images',…)`, server.js:900–921, returning `/api/buckets/…` URLs) does **not** touch `FILES_DIR`, so uploads work — but the legacy read/stat/delete wrappers are broken. Flag for cleanup, not for this refactor.

---

## 3. Workflow coupling analysis (ranked by refactoring difficulty)

### W1 — Tool-call execution loop (HIGHEST) — chat.js + mcp-client.js
The deepest client-orchestration encoding. Full loop:

1. `streamResponse` builds `requestBody` (chat.js:3107–3157): `messages` from `streamConv.getMessagesForApi(systemPrompt)`; `tools` = MCP tools (vision-filtered) + `ARCHIVE_TOOLS` + `RETIREMENT_TOOLS`; `image_processing` hints.
2. `client.streamChatIterable(requestBody, chatId, false, streamConv)` (chat.js:3180) → SSE to gateway.
3. `client-sdk.js` aggregates `tool_calls` **delta fragments** by index into `aggregatedToolCalls`, concatenating `name` and `arguments` strings (client-sdk.js:139–167), and yields them with `done` (client-sdk.js:173–196).
4. On `done` with `finish_reason==='tool_calls'` (chat.js:3263), the exchange's `assistant.tool_calls` is set, tool_calls are **sorted by index**, and each is executed serially: `await handleToolExecution(...)` (chat.js:3268–3284).
5. `handleToolExecution` (chat.js:4570): creates a tool exchange, renders collapsible UI, then routes by name: `isLocalTool ? executeLocalTool : mcpClient.executeTool(...)` (chat.js:4712–4721). `LOCAL_TOOL_NAMES` = `ARCHIVE_TOOLS ∪ RETIREMENT_TOOLS` names (chat.js:1143) — i.e. browser-native tools.
6. MCP path: `mcpClient.executeTool` → JSON-RPC `tools/call` over the SSE POST, waits for result (mcp-client.js:600+).
7. Result extraction (chat.js:4804–4835): unwraps `{content:[{type:'text'|'image'}]}`, base64 images intercepted → `imageStore.save` → nDB bucket → `/api/buckets/…` URLs.
8. Tool result persisted as a **`role:'tool'` message** with `toolName/toolArgs/toolStatus/toolImages` via `_syncMessage` → `backendClient.sendMessage` (conversation.js:148–190; sync call chat.js:4860–4870).
9. **Recursion:** if `resumeStream`, `await streamResponse(toolExchangeId, …)` (chat.js:4881) issues a **fresh** gateway request including the tool result.

`getMessagesForApi` (conversation.js:553) re-serializes the tool result for the follow-up as `role:'tool'` + `tool_call_id` (conversation.js:588–668), backfilling the preceding assistant's `tool_calls` (and injecting a dummy assistant if needed) to satisfy native tool APIs.

**Difficulty of moving execution server-side: HIGH.** The local tools (`executeLocalTool`) are browser-bound by nature — `browser_fetch` uses browser fetch/CORS, preview pane renders in the DOM, `chat_archive_*` hit the backend REST, and `saveToStorage`/`attachment_save` move bytes via the browser. The MCP execution itself is portable (JSON-RPC), but the result/image-offload pipeline (base64→bucket) and the follow-up recursion are woven into the conversation state machine. **Realistic P0: proxy the raw stream and persist as messages flow; leave tool execution client-driven** (server persists each `role:'tool'` message as it's POSTed — it already does). Full server-side tool orchestration is a later-phase, high-risk change.

### W2 — Conversation state machine + persistence (HIGH)
`conversation.js` owns exchanges, versioning, crash-net retry queue (localStorage, conversation.js:22–52), and **drives all backend persistence** via `_syncMessage` → `backendClient.sendMessage(sessionId, body)` (conversation.js:148), called for user (conversation.js:334), assistant (conversation.js:447), and tool (conversation.js:4860) messages. `getMessagesForApi` is the gateway-payload builder (conversation.js:553). The browser is the **write-author** of every message; the backend is a passive store. P0 inverts this: the server becomes the author during streaming. The crash-net queue shows the team already tolerates client-driven writes; moving to server-authoring changes the failure contract (who retries?).

### W3 — Attachment / image pipeline (MEDIUM-HIGH)
`file-store.js` PUTs base64 to `/api/chat-files/:exchangeId` (file-store.js:38) but the server writes nDB buckets and returns `/api/buckets/…` URLs (server.js:900–921); the modern message store uses `attachments[]._file` compact nURI + `url` (server.js:1572–1600). Bucket **reads** (`GET /api/buckets/*`) require cookie auth (server.js:968–970) — which is exactly why **server-side fetches of those URLs 401** (issue #5; a model/gateway/vision path that fetches the image gets no cookie). Image GC on chat delete releases `_file` refs via `db.releaseFile` (server.js:1730–1740). Already mostly same-origin; the coupling is the auth model for non-browser consumers, not the transport.

### W4 — Arena mode (MEDIUM-HIGH)
`arena.js` is a parallel orchestrator: `Participant` streams directly to gateway (arena.js:50–56, 114), summary generation streams directly to gateway (arena.js:732, 1051, 1104), persistence is backend-only via `arenaStorage` (chat-arena/js/storage.js, "No localStorage, no IndexedDB fallback") replaying messages through `backendClient.sendMessage` (arena.js:374) and PATCHing metadata (arena.js:2128–2137, 2350–2357). It also opens an embed `EventSource` (arena.js:1865). Two direct-gateway surfaces (participant + summary) plus its own controller duplicate channel 1. It loads the dynamic chat config too (arena index.html:326), so it is BFF-ready on config; the work is re-pointing its two GatewayClient uses through the proxy.

> **STATUS 2026-08-26 — mostly RETIRED.** Arena is re-based on the server ArenaRunner (Phase D); the spectator view holds no orchestration, persistence is a side effect of the runner's appends. Remaining work, downgraded to LOW: summary generation still streams browser→gateway directly (arena.js:2685 → `Arena.summarize`), legacy import still constructs the old `Arena` orchestrator, and the dead `Participant`/`Arena` classes (arena.js:40–1165) await deletion in the Phase D cleanup pass.

### W5 — TTS player (MEDIUM)
`NSpeechController` + `TtsPlayerHost` (chat.js:1914–1925; arena.js:1681) are fully browser-driven nSpeech clients (channel 4). Coupling is moderate: voices/audio are fetched per-endpoint; the endpoint is user-configurable (localStorage + config). Routing through the backend means proxying a fairly large REST+SSE+EventSource+audio surface and deciding whether per-user TTS endpoint config becomes a server concern.

### W6 — Memory/storage browser UI (MEDIUM)
Settings/profiles live in the backend already: `storage.js` reads/writes `/api/user/settings` via BackendClient (chat/js/storage.js:1–40); `chat-history.js` is backend CRUD with a `_saveList` that PATCHes dirty conversations (chat-history.js:40–60). The browser-native **tools** (`chat_archive_*`, `browser_fetch`, `saveToStorage`) are the coupling — they give the model direct browser reach into the backend and the MCP storage box (channels 7/8). These are interception points that must survive the refactor (either stay browser-native, which they can, since they talk to the backend same-origin anyway, or move server-side).

### W7 — Settings / profiles (LOW)
`/api/user/settings` is already backend CRUD (server.js:1436–1502); the client just wraps it (storage.js). Minimal coupling. P3's identity reconciliation (nPort `sub` keying) affects this the most.

---

## 4. Hard parts list (ranked by coupling)

| # | Hard part | What breaks | What must move | Suggested phase |
|---|-----------|-------------|----------------|-----------------|
| H1 | **Tool-call execution loop** (W1) | The recursion `streamResponse → tool_calls → executeTool → streamResponse` is browser-native (local tools, bucket offload, preview). Moving it server-side breaks `browser_fetch`/preview semantics and requires the server to hold a tool loop state machine. | **P0: don't move.** Proxy the stream; keep execution client-driven; server persists `role:'tool'` messages (already does). Full move = P1+ research spike. | P0 (proxy only) / later (execution) |
| H2 | **Server-owned stream ownership (P0 core)** | Today a killed tab loses the partial assistant stream — nothing server-side holds it. Need: buffer the proxied SSE, re-attach with offset, and **distinguish user-abort (`client.abortStream`, chat.js:6624/5802 → `controller.abort()` → `'aborted'` event, client-sdk.js:250–253) from tab-kill (browser just dies → server sees connection close)**. No server machinery exists (no mid-stream store; `embed.js` is a queue for *embeddings*, not streams). | New: proxy route, in-flight buffer keyed by session+user, re-attach offset, abort semantics (explicit abort header vs connection-close). The `embed-events` EventEmitter relay (server.js:853–882) is the pattern to copy for the browser-facing SSE. | **P0** |
| H3 | **TTS channel is a whole SDK, not a GET** (W5) | Proxying TTS means proxy POST `/v1/audio/speech` (SSE audio), voice/admin GETs, and `/v1/admin/events` EventSource — not just "GET with query passthrough" (spec P1 gotcha is incomplete). | Backend `/api/tts/*` proxy mirroring nspeech-client.js routes; decide if endpoint config moves server-side. | **P1** |
| H4 | **Bucket URLs auth for non-browser fetchers** (issue #5) | `GET /api/buckets/*` needs cookie (server.js:968). Server-side/model-side fetches (vision, `attachment_save`) get 401. | Server-to-server fetch with the user's identity attached, or a short-lived signed URL / internal header; align with P3 identity. | P1 / P3 |
| H5 | **Arena dual direct-gateway surfaces** (W4) | Two `GatewayClient` uses (participant + summary) stream straight to gateway. | **Participant surface RETIRED 2026-08-26** (server ArenaRunner). Remaining: summary generation (options dialog) — re-point through the backend when the summary flow is re-based; make `chat-arena/js/config.js` dynamic (server.js:2182 currently static). | ~~P0/P1~~ → P1 remnant |
| H6 | **`browser_fetch` / `saveToStorage` channels 7–8** | Give the model arbitrary browser reach (CORS-bound) and direct writes to the MCP storage box. | Decide policy: keep browser-native (they are CORS-limited anyway) or move server-side with identity. Lower priority — they are already same-origin for the backend REST parts. | P1 (keep browser-native) |
| H7 | **`gatewayUrl` config is dead / default '' 404s** | Chat `GatewayClient` uses localStorage only (chat.js:40); generated `config.js.gatewayUrl` unread; default '' is a same-origin 404. | P0 must stop relying on localStorage and inject the proxy URL into the client; keep a fallback for the direct-debug path. | **P0** |

---

## 5. Corrections to spec §2 ("verified facts")

Every claim the code contradicts or sharpens:

1. **"Deps: express 5, @seald-io/nedb"** — *WRONG in substance.* Both are in `package.json` but **never imported**. The server is raw `http.createServer` + hand-rolled router (server.js:2045, 2127). express 5 is not "used and how"; it is unused. Same for `@seald-io/nedb` (only migrate scripts read legacy files with their own reader, migrate-import-nedb.js:95). **The backend has zero framework dependencies.**

2. **"BackendClient uses relative paths (`baseUrl='')"** — *code default contradicts.* `api-client.js:289` defaults to `http://localhost:3500`; it only becomes `''` because the **server-generated** `config.js` sets `backendUrl:''` (server.js:2173). Same-origin is a config artifact, not a code invariant. If a page loads without the generated config (or a stale one), it hits 3500.

3. **"`SESSION_TTL = cfg.sessionTtlMinutes (default 1440) * 60s`"** — units off by 1000. Code: `(cfg.sessionTtlMinutes || 1440) * 60 * 1000` (milliseconds, server.js:36). Trivial, but the spec's "60s" is wrong.

4. **Channel 4 TTS shape** — *WRONG.* No `GET /tts`, no `new Audio(url)`. It is the nSpeech V3 SDK surface (nspeech-client.js:365–1439). See §1 channel 4.

5. **Channel 3 WebSocket `/v1/realtime`** — *verified retired*, client-sdk.js:1–2. Spec is right.

6. **"the server has an SSE relay pattern (embed-events) to copy"** — *true* (server.js:852–882), but note it is a **one-directional push EventEmitter**, not a bidirectional stream relay. P0 must build the relay; the pattern copied is the SSE framing/keepalive/cleanup, not the plumbing.

7. **"Arena's `config.js` is STATIC — must become dynamically generated"** — *confirmed* (server.js:2182–2189 serves the file verbatim). Arena index.html also loads the **dynamic chat config** (arena index.html:326), so `enableBackend`/`backendUrl` are already available to arena — the arena config gap is only about gateway/tts/model defaults, not backend wiring.

8. **Spec §2 "Config resolution is env-first"** — *confirmed* (server.js:15–36). Also confirmed: `USERS_DB_PATH` relative (server.js:35); separate `users_db` system (server.js:35, 140–245).

9. **New fact the spec misses:** the chat `GatewayClient` base URL comes from **localStorage only** (`chat.js:40`), and the generated `config.js.gatewayUrl` is **never read** (no `CONFIG.gatewayUrl` reference in chat.js). This affects P0: the proxy URL must be delivered through a mechanism the client actually reads.

10. **New latent bug for the plan:** `FILES_DIR` is used-but-undeclared (server.js:927 etc.) → legacy file read/stat/delete routes throw ReferenceError. Unrelated to BFF but should be fixed or removed during the pass.

---

## 6. Open issues → channel / module mapping

| Issue | Title | Channel / module | Where in code |
|-------|-------|------------------|---------------|
| #4 | Missing action toolbar on assistant message when a tool call follows | W1 tool-call loop (browser UI) — `chat.js` handleToolExecution / finalizeAssistantElement | chat.js:4570–4660 (tool exchange render + finalize) |
| #5 | Attachment bucket URLs return 401 to server-side fetches | Backend bucket auth — `GET /api/buckets/*` cookie-required | server.js:968–970 (requireAuth); URLs minted server.js:915 |
| #6 | `chat_archive_update_metadata` stringifies summary | W6 archive tools → `PATCH /api/chats/:id` summary validation | chat.js:126–322 (tool def), backend PATCH server.js:1624–1636 (summary must be object) |
| #8 | `chat_archive_update_metadata` silently overwrites curated summaries (needs guard + session-ID exposure) | W6 archive tools → `backendClient.updateSession` | chat.js executeLocalTool `chat_archive_update_metadata` handler (~chat.js:550–620) |
| #9 | Direct vision support broken: vision models get manifest not image | W1 vision-filtering + attachment→gateway image resolution | chat.js:3131–3151 (vision tool filter); conversation.js:553+ (attachment manifest build) |
| #10 | Context-window display wrong; breaks with tool use, only right after reload | W1 stream `usage`/`context` events + client-sdk `done` | client-sdk.js:173–196 (`usage`, `context` in done); chat.js `updateUsageDisplay`/context handling |
| #11 | Direct vision path broken: images fall through to MCP vision tools | W1 `shouldFilterVisionTools` logic | chat.js:3131–3151 |
| #13 | Arena summaries never persisted to backend (missing PATCH) | W4 arena metadata persistence | **appears RESOLVED**: arena.js:2128–2137 and 2350–2357 now call `backendClient.updateSession` with the `summary` object. Verify against live before re-triaging. |

---

## Notes on stream ownership for P0 (deep dive)

- **Client abort today:** `abortStream()` (chat.js:6624) → `client.abortStream(chatId)` (chat.js:5802) → `controller.abort()` → the reader's `AbortError` yields `{type:'aborted'}` (client-sdk.js:250–253). This is **explicit user intent**, distinguishable at the client.
- **Tab-kill today:** no client signal; the fetch connection just dies. The server (once it proxies) would see `req.on('close')`. **Nothing currently persists the partial assistant stream** — the server's message writes are client-initiated append-only (`POST /api/chats/:id/messages`), and a mid-stream tab-kill drops the in-flight assistant text entirely.
- **What must be built for P0's acceptance ("killing the tab mid-stream loses nothing"):** a proxy route that (a) forwards `POST /v1/chat/completions` SSE to the gateway, (b) buffers the token stream server-side keyed by `{user, conversation, exchange}` as it flows, (c) writes the assistant message to the conversation doc **when the stream completes** (even if the browser disconnected), and (d) lets a re-attaching client resume from an offset. The distinguishing signal for abort-vs-kill needs an explicit client header on abort (the connection-close alone is ambiguous). The `embed-events` relay (server.js:852–882) + the embed `pendingQueue`/reconciliation pattern (server.js:220–290, 352–445) are the closest existing server-side models for durable, restart-safe state.

*End of survey. Amend `docs/_Archive/plan-backend-routed-refactor.md` §2 with section 5 corrections, then mark P−1 complete.*
