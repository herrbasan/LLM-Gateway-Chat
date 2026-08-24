# BFF Refactor — Deep-Dive Findings Report

**Date:** 2026-08-24
**Scope:** `D:\DEV\LLM-Gateway-Chat` (branch `bff-rework`, dev port 8082)
**Governing spec:** [plan-backend-routed-refactor.md](plan-backend-routed-refactor.md) · **Design authority:** [architecture-conversation-runner.md](architecture-conversation-runner.md)
**Survey (channel map):** [codebase-survey-bff.md](codebase-survey-bff.md) · **Tracking:** LLM-Gateway-Chat #12
**This report:** the code/pipeline + UI deep-dive that the survey and the architecture doc do **not** cover. It is a companion to `codebase-survey-bff.md`, not a replacement.

---

## 0. TL;DR

The strangle-side of the refactor is well specced (runner core, event stream, tool port, view parity, cutover). But two things are **underspecified and will bite in implementation**:

1. **The system prompt is a large, dynamic, browser-state-dependent blob** — the docs never mention it. The runner must reproduce it byte-identically server-side.
2. **The UI layer is a ~7000-line client-centric monolith** whose render path is untangled from its state/orchestration. The docs call it a "view" but never specify the split, and there are five concrete cross-process contracts (timestamp prefix, exchange-ID keying, versioning, system-prompt sourcing, module boundary) that must be defined before Phase A.

**Also cleaned up / verified:** nDB (183 tests) and nVDB (118+ tests) both pass; the storage primitives the runner depends on are sound. `FILES_DIR` is undeclared (issue #14) — unrelated to BFF, cleanup. Dead deps `express` + `@seald-io/nedb` never imported.

---

## 1. What was analyzed and verified

### 1.1 Read in full
- `docs/architecture-conversation-runner.md`
- `docs/plan-backend-routed-refactor.md`
- `docs/plan-p0-stream-ownership.md` (superseded design input)
- `docs/codebase-survey-bff.md` (P−1 channel map)

### 1.2 Traced end-to-end
| Pipeline | Files | Core |
|----------|-------|------|
| Chat stream | `chat.js` `streamResponse` (2976), `client-sdk.js` | Browser builds `requestBody` → `GatewayClient` SSE → `Conversation` accumulates → `setAssistantComplete` → `_syncMessage` → backend |
| Tool execution | `chat.js` `handleToolExecution` (4570), `executeLocalTool` (357), `mcp-client.js` | Browser routes local-vs-MCP, extracts result, offloads base64→bucket, persists `role:'tool'`, recurses `streamResponse` |
| Conversation state | `conversation.js` | `exchanges[]` tree, versioning, crash-net (localStorage), `getMessagesForApi` (553), `_syncFullState` (PUT replace) |
| MCP client | `mcp-client.js` | SSE discovery + JSON-RPC POST; `getFormattedToolsForLLM` (1085), `executeTool` (922); config in `localStorage['mcp-servers']`/`mcp-enabledTools` |
| Persistence (server) | `server.js` | `POST /api/chats/:id/messages` (1568) appends + fires embed; `PUT` replace (1691); `GET` (1428) densifies attachment URLs; `DELETE` (1731) GCs |
| Embed | `server.js` | `embedBatch` (623), `embedMessageAsync` (713), circuit breaker, `pendingQueue` drain (220–290), lazy mount + reconciliation (302–445) |
| Attachment/bucket | `server.js` `file-store.js` | `PUT /api/chat-files/:id` → `storeFile` → `/api/buckets/...`; bucket GET (968) requires cookie |
| Arena | `chat-arena/js/arena.js` | Direct `GatewayClient` per participant/summary; persistence via `backendClient` (374/2128), `EventSource` embed (1865) |
| TTS | `lib/tts/*` | nSpeech V3 SDK; prefs mostly via `storage.getPref`→`/api/user/settings`; endpoint pref is localStorage |

### 1.3 Tests & live verification
- **nDB:** `cargo test -p ndb` → 183 tests pass (100 unit + 8 + 11 + 10 + 26 + 28 integration). Covers `arrayPush`, `set`, `update`, `delete`, `restore`, bucket `storeFile/getFile/releaseFile/restoreFile/GC`, query.
- **nVDB:** `cargo test -p nvdb` → 118+ tests pass (HNSW, WAL, segment, compaction, distance/SIMD).
- **Live app (`:8082`):** boots clean (only NUI aria-label a11y warnings); logged-in against the real 120MB snapshot; 23 models from gateway; all sidebar tabs; active chat with 5 messages rendered in a `.vs-stage`; history list virtualized; preview pane is a shared surface.
- **Confirm:** **stored conversation form** is timestamp-prefixed user content (`[2026-08-24@…] …`), inline `messages[]`, per-message `embedStatus/embedAttempts/embedError/id/idx/rawContent/attachments`.

---

## 2. Planning gaps (code/pipeline level)

These are either absent from the docs or specified at a level that will bite mid-implementation.

### G1. The system prompt is a dynamic, browser-state-dependent blob (HIGH — not in any doc)
`getSystemPromptWithMetadata()` (chat.js:2569) assembles five components on **every send**:
1. `CONFIG.instructions` — the prime-directive blob (fetched by `/chat/js/config.js` via `fetchPrimeDirective()`, server.js:2160).
2. `buildMetadataPrefix()` (2553) — user name/location/language + "don't add timestamps".
3. User `systemPrompt` textarea.
4. Archive-tool context: **EXECUTION CONTEXTS + CURRENT SESSION ID + Large-File-Retrieval + Saving-Attachments**.
5. `buildMcpResourceContext()` (2790) + memory-tool reminder.

Parts 4–5 depend on live browser state: `currentChatId`, `getMcpServerOrigin()` (115), `areMemoryToolsAvailable()` (2780), MCP resources/templates.

**The runner must reproduce this byte-identically server-side**, so the server MCP pool must answer: what is the MCP origin? what resources/templates exist? are memory tools available? Also decide where `instructions` comes from (fetch per-run / cache / committed blob). Getting this wrong changes every model's behavior mid-refactor.

### G2. Stored-form vs API-form duality (the core seam — half-specified)
Docs say "port `getMessagesForApi` + `buildChunkView`." But the runner is the **single author of the stored form too**, authored by `addExchange` (conversation.js:334): timestamp-prefix, `imageStore.save` offload → `_file` compact nURI, tool messages with `toolName/toolArgs/toolStatus/toolImages`, assistant messages with `reasoning_content/thinking_signature/streamStats/usage/context`. The runner must replicate *this* (the append that fires embed) plus the API view. Today it's inline in `POST /api/chats/:id/messages` (server.js:1568) — needs extracting into a shared append+embed helper.

### G3. Tool-execution server-side (H1) needs a precise split
`handleToolExecution` (chat.js:4570) is browser-bound: UI render, local-vs-MCP routing, result extraction (`content[]` → base64 → bucket), persist `role:'tool'`, then recursion. Of the 13 local tools (`ARCHIVE_TOOLS` 126, `RETIREMENT_TOOLS` 323), several are view-bound (preview pane renders DOM; `context_retire/unretire` read `_lastChunkTable`). Which move server-side vs stay in the view, and how the recursion/serialization moves, is unspecified. Note `browser_fetch` server-side loses its accidental CORS guard — state the new trust boundary (arch §4 acknowledges).

### G4. Vision has two paths, both need server decisions
- **Direct vision:** `getMessagesForApi` resolves bucket URLs to absolute via `_resolveImageUrlForGateway` using `window.location.origin`. In the runner the server origin must be reachable by the gateway, which interacts with issue #5 and P2 (localhost binding).
- **MCP auto-vision:** `autoCreateVisionSessions` (chat.js:2834) calls `vision.session_create`/`vision.analyze` through the MCP `tools` dispatcher, injecting analysis into user content. Moves with the MCP pool; `shouldFilterVisionTools` moves to the runner (arch §4).

### G5. MCP config migration is more than a list move
`mcp-client.js` reads localStorage, does per-server collision naming (`serverName__tool`), and synthesizes `read_resource`. The server MCP pool must reproduce all three, keyed per user from `/api/user/settings` (the `mcp-` prefixed namespace already exists in `storage.js`). Auto-connect / lazy pool / how the `tools` dispatcher is advertised — undefined.

### G6. Attachment/bucket origin + timing
Server-side offload is `db.storeFile` (dissolves issue #5 — good). But *when* the runner offloads, and exactly what URL origin it hands the gateway, must be pinned. `GET /api/buckets/*` keeps cookie-auth (view is same-origin); the non-browser consumer (gateway/model fetching an image) is the open question.

### G7. Event/concurrency semantics under-specified
"Runs serialize; sends queue; consecutive queued messages get one batching run" (arch §2.1) needs a precise definition of batch assembly and how the model reads multiple queued messages. The snapshot + `inFlight` re-attach, and abort-vs-close (explicit API vs connection-close), are clear at a high level but the frame shapes and the `error`→`run.end` persist contract are not.

---

## 3. UI-layer map & refactor (the focused deep-dive)

### 3.1 Architecture
- **Shell** (`index.html`): `nui-app` → left sidebar (history), right sidebar (config tabs **Model / User / System / MCP / TTS**), `nui-main` (chat pane + preview pane).
- **Per-chat container:** every chat gets a `.conversation-container` under `#messages` (hidden via `display:none`, one active at `display:flex`). Inside is a **`.vs-stage`** (virtual scroll, chat.js:3441+) holding positioned `.chat-message` elements; the stage's explicit height controls the scrollbar. The history list (`nui-list`) is also virtualized.
- **State:** in-memory `Conversation.exchanges[]` (user / assistant / tool) per chat in `activeConversations` (Map); singleton globals `conversation`, `currentChatId`, `currentModel`. The DOM is a projection; the client is the **author** (persists via `_syncMessage` → `POST /messages`, `_syncFullState` → `PUT /messages`).

### 3.2 Render path (state → DOM)
`renderExchange`/`buildExchangeElement` (4099/1382) → `createAssistantElement` (4294) → `updateAssistantContent` (4989) → `finalizeAssistantElement` (5269).
- Assistant bubble: header (model + timestamp + embed-status dot + streaming indicator + `context-usage-display`), `progress-status`, `message-content` (thinking block + `nui-markdown` answer container), action toolbar.
- `updateAssistantContent` drives incremental streaming via `nui-markdown.beginStream/appendChunk/endStream`, thinking-block collapse/expand, and dedup via `dataset.lastContent/lastReasoning`. `forceFinalizeMarkdownStream` (5209) closes the race where a debounced timer fires after the terminal event.
- **User bubble** uses `.message-actions-user` (edit/delete only). **Assistant bubble** uses `.message-actions` (speaker / regenerate / prev–next version / copy / edit / delete).

### 3.3 Interaction model (DOM mutates state + backend)
Every action handler mutates the `Conversation` and writes to the backend:
- delete / edit → `deleteExchange`/`startEditMode`/`commitEdit` → `_syncFullState` (PUT replace).
- regenerate / switch version → local `Conversation` mutation + re-stream (`regenerate` 5419, `switchVersion` 5442).
- send → `sendMessage` (2630) → `addExchange` + `streamResponse` (gateway SSE).
- tool bubbles → `handleToolExecution` + resume stream.
- embed status → `connectEmbedEvents` (4908) → separate `/api/embed-events` EventSource.
- TTS → `toggleTts` (5394) → browser nSpeech SDK.
- switch chat → `switchChat` (5656) = addExchange-load + `buildHistoricalDomForChat` + vs-activate + model/system-prompt restore + `connectEmbedEvents`.

### 3.4 Live confirmations
Clicked a chat in the history: container rebuilt, `.vs-stage` height set, `data-exchange-id` keys the DOM, `context-usage-display` shows "73.6K / 1M Tokens | 7704ms TTFT", per-message embed-status dots, collapsible thinking block. **This `switchChat` load-and-render path is already the attach flow the new view needs.**

### 3.5 What leaves the view (→ runner/server)
The `Conversation` state machine, `client-sdk.js`, `mcp-client.js`, `getMessagesForApi`/`buildChunkView`, the system-prompt builder (G1), the tool-execution recursion, and all client-authored persistence (crash-net, `_syncMessage`, `_syncFullState`).

### 3.6 What stays in the view
The render pipeline (markdown / thinking / tool / image / version / context-usage), pure-view interactions (thinking toggle, tool-payload toggle, lightbox, copy), input + attachment bucket upload, TTS playback, and the sidebar/history/search/presets/settings/admin REST wrappers. These largely survive **as-is** — they only change their **state source** from `Conversation` to the snapshot+event stream.

### 3.7 Five cross-process contracts to define (the real risk)
1. **Timestamp prefix stripping.** `updateAssistantContent` strips the stored content's timestamp via `dataset.timestampLen`. Snapshot must expose `{content, timestamp}` separately, or keep the prefix + a known length. Fragile today, cross-process tomorrow.
2. **Exchange IDs vs messages.** DOM keyed by client-generated `ex_*`; tool + following assistant grouped by `exchangeId`. The runner works in messages, not exchanges. Need event-level keying (`toolCallId`/`messageId`) for `data-exchange-id` and the tool↔assistant pairing.
3. **Versioning.** regenerate/switch-version is view-local now. Is it server (runner holds versions) or display-only? Not in the parity checklist.
4. **System-prompt sourcing.** Embeds `currentChatId` + MCP context; the runner supplies these, the view stops building it.
5. **Module boundary.** `chat.js` mixes render + state + orchestration. The view split needs a concrete module boundary — not "the client shrinks to a view."

---

## 4. Cross-cutting notes

- **TTS config is already ~80% server-side** (`storage.getPref`/`setPref` → `/api/user/settings`); only the endpoint pref is localStorage.
- **`gatewayUrl` in generated `config.js` is never read** (chat reads localStorage) — moot for the chat stream (server holds the Bearer), but `/v1/models` needs the same-origin `GET /api/models` proxy; `chat-arena/js/config.js` is static and must become dynamic.
- **`FILES_DIR` undeclared** (issue #14) breaks `file-store.js.load` / `/files/*`; the modern image path uses nDB buckets, so it's cleanup not BFF.
- **`api-client.js`** instantiates `BackendClient(CONFIG.backendUrl ?? 'http://localhost:3500')`; same-origin is a config artifact, not invariant.

---

## 5. Recommended next step

Use this report to amend `plan-backend-routed-refactor.md` (correct/add to §6 "Open questions" and the phase acceptance criteria) before starting Phase A. Specifically:
- Add **G1** (system prompt) and **G2** (stored-form authoring) to the Phase A scope — they are prerequisites for "runner core."
- Add the **five UI contracts (§3.7)** to Phase C's parity checklist so the new view is built against them, not against the current client's incidental format.
- File the `FILES_DIR` cleanup as part of the pass (already issue #14).

---

## 6. Versioning model — current mechanics (to port)

**Bottom line: `versions` / `currentVersion` are client-in-memory only. `server.js` references none of them (grep: zero hits). The persisted conversation doc stores a flat `messages[]` with no version fields.** The runner must own versioning explicitly and must NOT port the current reload-broken behavior.

### 6.1 In-memory shape (`conversation.js`, `exchange.assistant`)
```
assistant: {
  content,            // currently displayed version's content
  reasoning_content, thinking_signature, streamStats, usage, context,
  isStreaming, isComplete, error, model,
  versions: [ { content, timestamp, usage, context, streamStats } ],
  currentVersion      // 0-based index into versions
}
```
Version entry from `setAssistantComplete` (conversation.js:429): `{ content, timestamp, usage, context, streamStats }`.
`regenerateResponse` (conversation.js:480) pushes `{ content, timestamp }` **only** — so version entries are shape-inconsistent. `finalizeAssistantElement` (chat.js:5287) reads `curVersion.usage/context/streamStats`; for a merely-regenerated version these are `undefined`, so it falls back to a token estimate.

### 6.2 `setAssistantComplete` (the only version "write")
conversation.js:391 — marks complete, cleans content, then:
- **Dedup-push** a version (`if (!versions.some(v => v.content === cleanedContent))`), set `currentVersion = versions.length - 1`.
- `_syncMessage('assistant', cleanedContent, ...)` → `POST /api/chats/:id/messages` appends **one flat assistant message** (no version fields).

So each completed response = 1 in-memory version + 1 backend assistant message (1:1 **only while the page is open and no regenerate ran**).

### 6.3 `regenerate(exchangeId)` (chat.js:5419 → conversation.js:473)
1. `regenerateResponse`: push `{content, timestamp}` if not already a version; reset `content=''`, `isStreaming=true`, `isComplete=false`, `error=null`; `this.save()` (no-op).
2. chat.js wipes old assistant DOM, calls `streamResponse(exchangeId, currentChatId)` (re-streams into the **same** exchange).
3. On done, `setAssistantComplete` → push a **2nd** in-memory version + `POST` a **2nd** assistant message.

**Persist effect:** appends a new assistant message; never replaces/links the old one. Only a single `_asstMsgIdx` is tracked, so the prior message's index is lost from the exchange.

### 6.4 `switchVersion(exchangeId, direction)` (chat.js:5442 → conversation.js:496)
1. `conversation.switchVersion`: cycles `currentVersion` (modulo), sets `assistant.content = versions[newIndex].content`; `this.save()` (no-op).
2. chat.js re-renders DOM only (`updateAssistantContent`, `updateVersionControls`, `finalizeAssistantElement`).

**Persist effect: NONE.** The backend store is untouched. Switching versions is ephemeral and lost on reload.

### 6.5 `commitEdit` (assistant) (chat.js:5561)
Sets `assistant.content` to the timestamped edit, updates the **current** version object's `content`, then `truncateAfter(exchangeId)` → `_syncFullState()` → **`PUT /api/chats/:id/messages` replaces the whole array** (re-serialized via `_exchangesToBackendMessages`, which writes only `ex.assistant.content`). Versions still not serialized.

### 6.6 Reload trap (do NOT port as-is)
`_backendMessagesToExchanges` (conversation.js:1100) reconstructs exchanges; for `role:'assistant'` it **concatenates** multiple assistant messages into one `content` and sets `versions = [{ content: <first> }]` **only if empty** (`!target.assistant.versions.length`, line 1164). So after a regenerate (2 backend assistant messages), **reload concatenates and collapses to one version** — multi-version state is destroyed on reload. Current versioning is effectively **non-durable**.

### 6.7 What the runner must decide
- **Durable vs ephemeral.** Today it's inconsistent: `regenerate` leaks duplicate assistant messages into the store, `switchVersion` leaks nothing and is lost on reload.
- **Recommended:** store assistant-message *variants* explicitly (e.g. `versions[]` inside the assistant message doc, or linked messages with a `variantOf`/`currentVariant` pointer) and make `switchVersion` a cheap server call that flips `currentVariant`. That removes both the reload trap and the "switch is ephemeral" surprise.
- **If you keep versions display-only,** then `regenerate` must **not** append a second assistant message (replace the prior one, or store it separately) — otherwise the store and the view diverge.

*End of report.*
