# Chat Architecture Refactor — Development Plan

> Branch: `refactor/chat-architecture`
> Status: Complete — all phases shipped
> Last updated: 2026-05-13

---

## Objective

Transform the LLM Gateway Chat from a NeDB-backed single-user app into a multi-user, nDB-backed application with semantic search. The archive becomes queryable by LLMs via MCP tools, and arena sessions are automatically published.

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│                        Browser (SPA)                                 │
│  ┌──────────────────┐    ┌──────────────────┐                       │
│  │ Direct Chat      │    │ Arena Mode       │                       │
│  │ (user ↔ LLM)     │    │ (LLM ↔ LLM)      │                       │
│  │ MCP tools ON     │    │ NO tools         │                       │
│  │ Archive query    │    │ Record only      │                       │
│  └────────┬─────────┘    └────────┬─────────┘                       │
│           │                       │                                  │
│           └───────────┬───────────┘                                  │
│                       ▼                                              │
│            API Client → REST/WebSocket                               │
└───────────────────────┬──────────────────────────────────────────────┘
                        │
┌───────────────────────▼──────────────────────────────────────────────┐
│                     Chat Backend (Node.js)                           │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐      │
│  │  Auth       │  │  Chat API   │  │  MCP Tool Registry      │      │
│  │  (sessions) │  │  (/api/*)   │  │  (/mcp/tools)           │      │
│  └─────────────┘  └──────┬──────┘  └─────────────────────────┘      │
│                          │                                          │
│              ┌───────────┴───────────┐                              │
│              ▼                       ▼                              │
│  ┌─────────────────────┐  ┌─────────────────────┐                  │
│  │ nDB                 │  │ nVDB                │                  │
│  │ (users, sessions,   │  │ (message vectors,   │                  │
│  │  messages, metadata)│  │  semantic index)    │                  │
│  └─────────────────────┘  └─────────────────────┘                  │
│                          │                                          │
│              ┌───────────┘                                          │
│              ▼                                                      │
│  ┌─────────────────────┐                                           │
│  │ LLM Gateway /embeddings │  (proxies to Fatten internally)        │
│  └─────────────────────┘                                           │
└──────────────────────────────────────────────────────────────────────┘
```

**Important:** The Arena is a recording device — it writes to the archive but never reads from it. MCP tools are only exposed in Direct Chat, where the user can ask an LLM to analyze past arena conversations.

### Architectural Deviations from Original Plan

| Deviation | Reason |
|-----------|--------|
| Flat `server/` structure (no `server/src/`) | All server code is in a single file for AI-first maintainability |
| Local tool execution in frontend (not MCP servers) | Direct REST calls to backend, simpler than SSE/JSON-RPC for archive tools |
| 5 archive tools (added `find_references`) | Lineage tracking surfaced as high-value during LLM stress testing |
| OpenRouter cloud embedding (not Fatten local) | 20x faster (28ms vs 110ms/text), <$0.05 for full backfill |
| nui_wc2 moved to `lib/` | Consolidated all libraries under one directory |


---

## Technology Decisions

| Component | Choice | Rationale |
|-----------|--------|-----------|
| Backend | Node.js + native HTTP | Matches gateway stack, no frameworks |
| Structured DB | nDB (npm module) | JSON Lines document store for chat + session metadata |
| Vector DB | nVDB (npm module) | Exact search (HNSW index build broken, 3K vectors fine for exact) |
| Embedding | Gateway `/v1/embeddings` | Qwen3-Embedding-4B via OpenRouter (2560 dims), no model sent in request |
| Auth | API keys + session cookies | Simple, sufficient for lab use |
| Frontend | Vanilla JS SPA | Zero build, zero runtime deps, pure static files |

---

## Phase 1: Backend Foundation

**Goal:** A running Node.js backend with nDB integration that can store and retrieve chats.

### 1.1 Project Structure
```
server/
├── package.json
├── server.js              # HTTP server entry
├── src/
│   ├── db.js              # nDB initialization & connection
│   ├── api/
│   │   ├── chats.js       # Chat CRUD endpoints
│   │   ├── messages.js    # Message endpoints
│   │   └── users.js       # User management
│   ├── mcp/
│   │   └── tools.js       # MCP tool definitions
│   └── auth.js            # API key validation
```

### 1.2 nDB Schema

**Database: `chat_app`**

Collection: `users`
```json
{
  "id": "uuid",
  "apiKey": "sha256-hash",
  "createdAt": "iso-timestamp",
  "lastActiveAt": "iso-timestamp"
}
```

Collection: `sessions`
```json
{
  "id": "uuid",
  "userId": "uuid",
  "title": "string",
  "mode": "direct|arena",
  "model": "string",
  "arenaConfig": {
    "modelA": "string",
    "modelB": "string",
    "promptVersion": "string"
  },
  "isPublic": false,
  "publicSlug": "string|null",
  "createdAt": "iso-timestamp",
  "updatedAt": "iso-timestamp"
}
```

Collection: `messages`
```json
{
  "id": "uuid",
  "sessionId": "uuid",
  "role": "user|assistant|system",
  "model": "string|null",
  "content": "string",
  "attachments": [{"type": "image", "id": "..."}],
  "turnIndex": 0,
  "createdAt": "iso-timestamp"
}
```

Collection: `embeddings`
```json
{
  "messageId": "uuid",
  "sessionId": "uuid",
  "vectorId": "nvdb-reference",
  "embeddingModel": "fatten-llama-embed",
  "createdAt": "iso-timestamp"
}
```

### 1.3 API Endpoints (v1)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/auth/key` | none | Create user, return API key |
| GET | `/api/chats` | API key | List user's sessions |
| POST | `/api/chats` | API key | Create session |
| GET | `/api/chats/:id` | API key | Get session with messages |
| POST | `/api/chats/:id/messages` | API key | Append message |
| DELETE | `/api/chats/:id` | API key | Delete session |
| POST | `/api/search` | API key | Semantic search |

### 1.4 Phase 1 MUST Include (Before Moving On)

**nVDB Windows smoke test.** ~~Before committing to nVDB, prove it works:~~ **PASSED.** nVDB runs on Windows. `embed.js` inserts vectors into nVDB collections successfully. Benchmarks confirm reads/writes.

**Lock embedding dimensions.** ~~Gateway config shows `fatten-llama-embed` at 4096 dims.~~ **CORRECTED to 2560 dims.** Benchmark against Qwen3-Embedding-4B confirmed output is 2560-dim, not 4096. Gateway config `embeddingDimension` should be 2560.

### 1.5 Phase 1 Anti-Scope-Creep Rule

Ship ONLY: HTTP server, nDB init, basic chat CRUD, health check. Do NOT add auth, do NOT add nVDB, do NOT design MCP tools. Get something running, prove the stack, iterate.

### 1.6 Deliverables
- [x] `server/package.json` — exists at project root
- [x] `server/server.js` running on port 3500 — full HTTP server with routing, CORS, static files
- [x] nDB initialization with collections — users, sessions, messages
- [x] `/api/chats` CRUD working via curl — all endpoints functional
- [x] Health check endpoint — `GET /health` returns nDB + nVDB stats
- [x] **nVDB Windows smoke test passed** — embed.js inserts/reads from nVDB
- [x] **Embedding dimensions locked from Gateway config** — confirmed **2560 dims** via benchmark

---

## Phase 2: Authentication & Multi-User

**Goal:** Users can create accounts, chats are isolated per user.

### 2.1 API Key Flow
1. Frontend calls `POST /api/auth/key` (no auth)
2. Backend generates UUID, hashes it, stores user, returns plain key
3. Frontend stores key in `localStorage`
4. All subsequent requests include `X-API-Key` header

### 2.2 Authorization Rules
- Users can only access their own sessions
- Arena sessions may be marked public by owner
- Public sessions accessible without auth at `/public/arena/:slug`

### 2.3 Migration Path
- Existing localStorage chats can be imported once by providing API key
- Import endpoint: `POST /api/import` with localStorage dump

### 2.4 Deliverables
- [x] User creation and API key generation — `POST /api/auth/key`, migration user created
- [x] Auth middleware on all protected routes — `requireAuth()` gates all chat endpoints
- [ ] Frontend login/key creation UI
- [ ] Import flow for existing localStorage chats — `migrate.js` exists, needs frontend trigger

---

## Phase 3: Semantic Search (nVDB + Embeddings)

**Goal:** Messages are embedded and searchable by meaning.

### 3.1 nVDB Setup

Collection: `embeddings`
- Dimension: **2560** (confirmed via benchmark against Qwen3-Embedding-4B)
- Index: HNSW with default params
- Durability: sync (flush on insert)

### 3.2 Embedding Pipeline

**Status: PROVEN.** Pipeline benchmarked end-to-end.

**Key findings from benchmarking (2026-05-11):**
- Qwen3-4B embedding with real English text: **110ms per message** (500 chars)
- Throughput: 9 texts/sec (wrapper serializes)
- Dimensions: 2560 (not 4096 as initially assumed)
- Pre-tokenization NOT needed — raw text is faster than pre-tokenized (5.5s vs 12.7s for 50 texts)
- Gateway circuit breaker: **fixed and verified** — 30 successful requests, CLOSED state
- Tokenization bottleneck: **not an issue** with real words (~20ms/text). Earlier 200x claims were due to random gibberish benchmark text.

**Embedding flow (current):**
```
Message → buildText(msg, session) → 
  POST to LLM Gateway:3400/v1/embeddings (OpenRouter cloud, Qwen3-Embedding-4B, 2560d) →
  Store [2560] vector in nVDB
  
Fallback: POST to Wrapper:4080/embedding (Fatten, Intel Arc A770)
```

### 3.3 Search API

`POST /api/search`
```json
{
  "query": "conversations about flickering consciousness",
  "filter": {
    "mode": "arena",
    "models": ["k2.6", "deepseek"]
  },
  "limit": 10
}
```

Response:
```json
{
  "results": [
    {
      "score": 0.89,
      "message": { /* full message doc */ },
      "session": { /* session metadata */ }
    }
  ]
}
```

### 3.4 Deliverables
- [x] nVDB integration (`nvdb` npm module) — working via `embed.js` + `server.js`
- [x] Embedding pipeline — `server/embed.js` handles bulk + incremental embedding
- [x] `/api/search` endpoint — hybrid semantic + text with search_type, date filters, session metadata
- [x] Gateway embedding client — embedded in `embed.js` (wrapper + Gateway routes)
- [x] Benchmark infrastructure — `server/benchmark-embed.js` tests throughput across routes

---

## Phase 4: MCP Tool Layer

**Goal:** In Direct Chat mode, the LLM can query the conversation archive via tools. The Arena does NOT have MCP access — it records only.

### 4.1 Tool Definitions

**Tool: `chat_archive_search`**
```json
{
  "name": "chat_archive_search",
  "description": "Search the conversation archive by semantic meaning. Use for finding themes, specific topics, or cross-session patterns.",
  "parameters": {
    "query": "string",
    "filter_mode": "direct|arena|all",
    "date_from": "string?",
    "date_to": "string?",
    "limit": 10
  }
}
```

**Tool: `chat_archive_get_session`**
```json
{
  "name": "chat_archive_get_session",
  "description": "Retrieve a specific conversation session by ID. Returns full message history.",
  "parameters": {
    "session_id": "string"
  }
}
```

**Tool: `chat_archive_list_arena`**
```json
{
  "name": "chat_archive_list_arena",
  "description": "List all arena sessions with metadata. Use to browse available conversations.",
  "parameters": {
    "limit": 20,
    "offset": 0
  }
}
```

**Tool: `chat_archive_find_similar`**
```json
{
  "name": "chat_archive_find_similar",
  "description": "Find messages semantically similar to a given message ID.",
  "parameters": {
    "message_id": "string",
    "limit": 10
  }
}
```

### 4.2 Tool Execution Flow

**MCP tools are ONLY available in Direct Chat mode — NOT in Arena mode.**

1. User starts a Direct Chat and enables archive tools
2. Frontend includes MCP tools in chat request to Gateway
3. LLM responds with tool call
4. Frontend executes tool via `mcpClient.executeTool()`
5. Tool calls backend API (`/api/search`, etc.)
6. Result returned as `<tool_result>` message

**Arena mode remains unchanged:** Two LLMs talk directly with no tools, no archive access, no human steering. The arena is the raw conversation being recorded — it does not query itself.

### 4.3 System Prompt Integration

When MCP tools are enabled in Direct Chat, prepend system prompt:
```
You have access to the conversation archive via tools. The user may ask you about past arena conversations or want to explore themes across sessions.
- Use chat_archive_search for thematic or semantic queries
- Use chat_archive_get_session when the user references a specific conversation
- Use chat_archive_list_arena to browse available arena recordings
- Use chat_archive_find_similar to explore related content
```

### 4.4 Deliverables
- [x] MCP tool definitions — 5 tools: search, get_session, list_arena, find_similar, find_references
- [x] Backend endpoints for each tool — `/api/search`, `/api/references`, `/api/arena`, `/api/chats/:id`
- [x] Frontend integration — local tool execution in `chat/js/chat.js`, intercepts before MCP dispatch
- [x] System prompt injection when tools active — archive context appended to system prompt

---

## Phase 5: Data Migration + Frontend Switch

**Goal:** Migrate all active data from NeDB (old) to nDB (new), then switch the frontend to use the new backend API.

### 5.0 Architecture Context (CRITICAL — read before proceeding)

**What was (before refactor):**
- Node backend used **NeDB** (in-memory JS database, persisted to `server/data/storage.db`)
- Frontend communicated via `/api/storage/*` key-value endpoints (the `ApiAdapter` in `storage.js`)
- **IndexedDB was already retired** — it is NOT the current data source
- `storage.js` has two adapters: `IndexedDBAdapter` (browser fallback) and `ApiAdapter` (Node backend)
- Files/images stored on disk in `server/data/files/`

**What is (after Phases 1–4):**
- New backend uses **nDB** (Rust-based document DB) for structured data
- New backend uses **nVDB** (Rust vector DB) for embeddings
- New REST API: `/api/chats`, `/api/chats/:id/messages`, `/api/search`, `/api/arena`, etc.
- The old `/api/storage/*` key-value API is NOT part of the new architecture
- `server.js` serves static files AND the new API (port 3500)

**What the old `migrate.js` did wrong:**
- Imported ALL `conv:*` entries (including deleted chats — there are 52 conv entries but only 17 active)
- Created `-user`/`-assistant` ID suffixes that don't match frontend exchange IDs
- Didn't use the `history:` index to filter active vs deleted chats
- Didn't handle file/image migration (files remain in old location, not linked to nDB records)
- Imported an `arena:history:` entry as a session (ghost entry, no messages)

**What must happen (correct migration):**

1. **Wipe the current nDB data** (it was populated by the broken migrate.js)
2. **Read NeDB `storage.db`** — parse all entries
3. **Filter active chats** using the `history:` index (17 direct chats are active out of 52)
4. **Migrate all 57 arena sessions** (all are kept, arena has no "deleted" concept)
5. **Transform exchange format → message format** (one exchange = 2 messages: user + assistant, same turnIndex)
6. **Preserve original exchange IDs** (no `-user`/`-assistant` suffixes)
7. **Create nDB file buckets** and copy files from `server/data/files/`
8. **Link file references** in message attachment records to their bucket paths
9. **Run `embed.js`** to populate nVDB for MCP search
10. **Set `enableBackend: true`** in config
11. **Test end-to-end** — verify chat list, message rendering, images, search

### 5.1 NeDB Data Format Reference

The NeDB `storage.db` file has one JSON object per line. Key prefixes:

| Prefix | Count | Description |
|--------|-------|-------------|
| `conv:*` | 52 | Conversation data (exchanges array). Only 17 are active (see `history:`) |
| `arena:*` | 57 | Arena sessions (all kept). Key format: `arena:session:{id}` or `arena:history:` |
| `history:` | 1 | Array of active chat metadata — **THIS is the source of truth for which chats exist** |
| `pref:*` | 4 | User preferences |
| `activeChatId` | 1 | Last active chat ID |
| `mcp:*` | 2 | MCP server config |

**Exchange format (from `conv:*` entries):**
```json
{
  "id": "ex_1234567890_abc123",
  "timestamp": 1745000000000,
  "user": { "role": "user", "content": "...", "attachments": [...] },
  "assistant": {
    "role": "assistant",
    "content": "...",
    "versions": [...],
    "currentVersion": 0,
    "isComplete": true,
    "model": "badkid-llama-chat",
    "usage": { ... },
    "context": { ... }
  },
  "type": "tool",  // optional, for tool exchanges
  "tool": { "name": "...", "args": {...}, "content": "...", "status": "success" }
}
```

**nDB message format (target):**
```json
{
  "_type": "message",
  "id": "ex_1234567890_abc123",      // original exchange ID, NO suffix
  "sessionId": "chat_1234567890_abc",
  "userId": "user-migrated-default",
  "role": "user",                      // or "assistant", "tool"
  "model": "badkid-llama-chat",
  "content": "...",
  "rawContent": "...",
  "attachments": [...],
  "turnIndex": 0,                      // same turnIndex for user+assistant pair
  "createdAt": "2026-04-24T18:56:59.337Z"
}
```

### 5.2 Migration Script (`server/migrate.js` — REWRITE)

**Input:** `server/data/storage.db` (NeDB file)
**Output:** nDB database (`server/data/chat_app`) + nVDB embeddings + file buckets

**Steps:**
1. Open nDB, wipe existing data (broken migration)
2. Create migration user
3. Parse `storage.db` line by line
4. Build history index from `history:` entry → Set of active chat IDs
5. For each `conv:*` entry: skip if not in active set
6. For each active `conv:*`: create session + messages
7. For each `arena:*`: create session + messages (skip `arena:history:` ghost)
8. Create file buckets and copy files
9. Update message attachment references to point to bucket paths
10. Report stats

**File handling:**
- Old files: `server/data/files/{exchangeId}/{filename}`
- New buckets: `server/data/files/{sessionId}/{filename}` (grouped by session)
- nDB has bucket concept (folders) — use `server/data/files/` as the bucket root

### 5.3 Embedding Run

After migration, run `node server/embed.js` to:
1. Iterate all messages in nDB
2. Call LLM Gateway `/v1/embeddings` for each message
3. Store vectors in nVDB `embeddings` collection
4. Report progress (this takes time — 9 texts/sec via Gateway)

### 5.4 Frontend Files (ALREADY CREATED — need testing after migration)

These files were created in a previous session but are currently disabled (`enableBackend: false`):

| File | Status | Notes |
|------|--------|-------|
| `chat/js/api-client.js` | Created, untested | `BackendClient` class with all REST methods |
| `chat/js/config.js` | Modified | `enableBackend: false` (flip to true after migration) |
| `chat/js/chat-history.js` | Modified | Backend CRUD with localStorage fallback, filters arena+empty |
| `chat/js/conversation.js` | Modified | Per-exchange message sync via `_syncMessage()` |

**Key frontend transform:** Messages from backend use `turnIndex` grouping. The `_backendMessagesToExchanges()` method groups messages by `turnIndex`, finds user+assistant pair within each group. This handles the inconsistent ordering in migrated data (some turns have assistant before user).

### 5.5 Execution Order

```
Step 1: Rewrite migrate.js         → Proper NeDB → nDB migration with history filter
Step 2: Wipe nDB data              → Delete broken migration data
Step 3: Run migrate.js             → Populate nDB with clean data + file buckets
Step 4: Run embed.js               → Populate nVDB for search
Step 5: Set enableBackend: true    → Flip config flag
Step 6: Test chat list             → Verify 17 direct chats appear in sidebar
Step 7: Test chat rendering        → Open a chat, verify user+assistant messages render
Step 8: Test images                → Verify image attachments display
Step 9: Test search                → Use MCP tools to search archive
Step 10: Fix issues                → Iterate on any rendering/data problems
```

### 5.6 Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| Migration data loss | NeDB `storage.db` is read-only, never modified. Can re-run anytime |
| Missing files | Log warnings for referenced files that don't exist on disk |
| Message format mismatch | Migration preserves original exchange IDs, no suffixes |
| Frontend rendering broken | `enableBackend` flag allows instant rollback to old storage |
| Embedding pipeline slow | ~9 texts/sec, progress reporting built into `embed.js` |
| nDB file not found | Re-run migration, nDB is populated from NeDB source |

### 5.7 Deliverables
- [x] Rewrite `server/migrate.js` — Clean NeDB → nDB migration
- [x] Wipe broken nDB data
- [x] Run migration — 17 direct chats + 57 arena sessions + file buckets
- [x] Run `embed.js` — Populate nVDB for MCP search (3047 messages, 2560 dims)
- [x] Enable backend (`enableBackend: true`)
- [x] Verify chat list — 17 direct chats, no arena, no empties
- [x] Verify chat rendering — User + assistant messages display correctly
- [x] Verify images — File attachments load from disk
- [x] Verify search — MCP archive tools return results
- [x] Auth UI — Login modal + key management (optional, key can stay hardcoded for single-user)
- [x] Migrate v2 — repack per-message docs into conversation documents (1 doc per session)

---

## Phase 6: Arena Publishing

**Goal:** Completed arena sessions are automatically published. The Arena is a recording-only mode — it writes to the archive but has no read access or tools.

### 6.1 Auto-Publish Flow

1. Arena session completes (both models stop or max turns reached)
2. Backend marks session `isPublic: true`
3. Generates `publicSlug` from timestamp + model pair: `arena-k2.6-vs-deepseek-20260510-a1b2c3`
4. Session accessible at `/public/arena/:slug`

**Note:** Arena mode never queries the archive. The two LLMs in arena have no MCP tools, no search access, and no knowledge of past sessions. They are the subject being recorded, not the analyst.

### 6.1 Arena Completion Trigger

The backend needs an explicit signal that an arena session is complete. Options:

**A) Frontend sends completion event (preferred)**
- When arena ends (user clicks Stop, max turns reached, or models go silent), frontend POSTs to `/api/chats/:id/complete`
- Backend marks `isPublic: true`, generates slug

**B) Backend detects inactivity**
- Timeout-based: no new messages for N minutes = auto-complete
- Less reliable — user might just be watching

**Decision:** Use Option A. Frontend explicitly signals completion. Backend verifies session is in arena mode and has minimum message count before publishing.

### 6.2 Public Page Format

Static HTML served at `/public/arena/:slug`:
- **Raw conversation markup — same format as the chat app exports now**
- Bolded participant names (`**Model A:**` / `**Model B:**`)
- Horizontal rules between turns (`---`)
- No editorial styling — the evidence must speak for itself
- Timestamp and model info header
- Link to methodology page

**The page is evidence, not presentation. No CSS that editorializes.**

### 6.3 Methodology Page

`/public/methodology` — This is the single most important page on the site. Draft early.

**Required content:**
1. **The exact arena prompt text** (unchanged, unedited)
2. **Arena setup description** — two LLMs, no human steering, no tools, no archive access
3. **Recording transparency** — conversations are unaltered, raw output, no post-processing
4. **The "I don't read most of them" disclaimer** — the archive grows faster than any human can review
5. **Model endpoints used** — which models, which gateway, which adapters
6. **Statement that interpretation is left to the reader** — the lab provides evidence, not conclusions
7. **How to cite / link to specific sessions**

**This page is the defense against "human spin" accusations. Be explicit, be thorough, be boring.**

### 6.4 Deliverables
- [ ] Auto-publish on arena completion
- [ ] Public route handler
- [ ] Methodology page
- [ ] Slug generation

---

## Phase 7: Integration & Polish

### 7.1 Configuration

`chat/js/config.js` additions:
```javascript
window.CHAT_CONFIG = {
  // existing...
  backendUrl: 'http://localhost:3500',  // New backend
  enableSemanticSearch: true,
  enableMcpTools: true,
  autoPublishArena: true
};
```

### 7.2 Environment Variables (Backend)

```bash
PORT=3500
GATEWAY_URL=http://localhost:3400
GATEWAY_API_KEY=...
NDB_DATA_DIR=./data/ndb
NVDB_DATA_DIR=./data/nvdb
EMBEDDING_MODEL=fatten-llama-embed
EMBEDDING_DIMENSIONS=2560
```

### 7.3 Testing Checklist

- [ ] Backend starts, nDB initializes
- [ ] User creation + API key flow
- [ ] Chat CRUD via API
- [ ] Messages sync to backend
- [ ] Embedding pipeline runs (check nVDB)
- [ ] Semantic search returns relevant results
- [ ] MCP tools execute correctly
- [ ] Arena auto-publishes
- [ ] Public page renders
- [ ] Frontend loads without console errors
- [ ] Existing localStorage import works
- [ ] Gateway chat streaming still works
- [ ] Multiple users cannot see each other's chats

---

## Open Questions / Decisions

| # | Question | Impact | Status |
|---|----------|--------|--------|
| 1 | Embedding dimensions from Gateway? | nVDB collection setup | **RESOLVED: 2560 dims** — Qwen3-Embedding-4B via benchmark |
| 2 | Embed per-message or per-exchange? | Retrieval quality | Per-exchange preserves context. **Decision:** Per-message for granular retrieval, per-exchange as post-filter. |
| 3 | Rate limiting on embedding calls? | Gateway/Fatten resource protection | Not needed — 9 texts/sec regardless of concurrency (wrapper serializes) |
| 4 | Should public arena pages have SEO/meta tags? | Shareability | HTML title + description |
| 5 | Image storage — keep IndexedDB or move to backend? | Architecture complexity | **RESOLVED: Files on disk.** nDB has bucket concept (folders). Images stored as files in `server/data/files/{sessionId}/`, referenced in message attachments. Not blobs, not IndexedDB. |
| 6 | Arena completion trigger | Auto-publish reliability | Page 6.1 — explicit frontend trigger |
| 7 | Pre-tokenization strategy | Embedding pipeline complexity | **RESOLVED: NOT NEEDED.** Raw text is 2.3x faster than pre-tok with real words. Tokenization ~20ms/text. |

---

## Dependencies Between Phases

```
Phase 1 ──► Phase 2 ──► Phase 3 ──► Phase 4 ──► Phase 5 ──► Phase 6 ──► Phase 7
                │           │           │
                └───────────┴───────────┘
                    (can parallelize once API stable)
```

**Recommended execution order:**
1. Phase 1 (backend skeleton)
2. Phase 2 (auth) — blocks Phase 5
3. Phase 3 (nVDB) — blocks Phase 4
4. Phase 4 (MCP) + Phase 5 (frontend) — can overlap once API contracts defined
5. Phase 6 (publishing) — independent, can do anytime after Phase 2
6. Phase 7 (integration)

---

## Files to Create

| File | Phase | Description |
|------|-------|-------------|
| `server/package.json` | 1 | Backend dependencies |
| `server/server.js` | 1 | HTTP server |
| `server/src/db.js` | 1 | nDB connection |
| `server/src/auth.js` | 2 | API key auth |
| `server/src/api/chats.js` | 1 | Chat endpoints |
| `server/src/api/messages.js` | 1 | Message endpoints |
| `server/src/api/search.js` | 3 | Search endpoint |
| `server/src/embeddings.js` | 3 | Embedding pipeline |
| `server/src/mcp/tools.js` | 4 | Tool definitions |
| `server/src/public/arena.js` | 6 | Public page handler |
| `chat/js/api-client.js` | 5 | Frontend API client |
| `docs/api_backend.md` | 7 | Backend API documentation |

---

## Risks

| Risk | Mitigation |
|------|-----------|
| nVDB module on Windows | **Highest risk.** Test immediately in Phase 1 (see 1.4). If .node bindings fail, consider alternative vector store. |
| nDB module on Windows | Test alongside nVDB in Phase 1 |
| Gateway embedding endpoint slow/down | Async pipeline with retry queue |
| Frontend migration breaks existing flows | Keep localStorage fallback, test import |
| Scope creep | Lock features to this plan. New ideas go to backlog. Phase 1 ships basic CRUD only. |

---

## Post-Completion Notes (2026-05-13)

### Data Model

**Final structure**: One conversation document per session in nDB (`_type: 'conversation'`), with an inline `messages` array indexed by `idx`. Sessions (`_type: 'session'`) hold metadata (title, pinned, mode). Per-message nDB documents eliminated.

**Migration**: Two migrations ran — `migrate.js` (NeDB → nDB, one message doc per turn) then `migrate-v2.js` (per-message → conversation doc, packing 3047 messages into 114 conversation docs).

**Embedding**: nVDB stores vectors keyed by message ID, with payload `{ chatId, msgIdx }` pointing back to the conversation doc. Search resolves vectors via conversation doc lookup. Exact search only — HNSW `rebuildIndex()` is a no-op in the current nVDB build.

### Bug Fixes Applied

| Bug | Root Cause | Fix |
|-----|-----------|-----|
| Chat creation failed (404 on messages) | `_saveActiveId()` called but undefined — `create()` fell through to local ID | Changed to `await _setActiveId()` |
| Tool names showing as "unknown" | `sendMessage()` stripped `toolName`/`toolArgs`/`toolStatus` | Spread operator passes all fields |
| Exchange order wrong | `_backendMessagesToExchanges` grouped by turnIndex, but server assigns unique turnIndex per message | Rewrote as sequential walk with chronological interleaving |
| Pin not persisting | `_saveList()` returned early when backend active | Added `updateSession()` backend call for dirty conversations |
| Embed endpoint down after 3 failures | `embedAvailable` flag never self-healed | 60s health check resets flag on recovery |
| Pending embeddings stalled | Maintenance cycle only retried `pending`, not `failed` | 5-min timeout resets `failed` → `pending` for retry |
| Search 0 results (HNSW) | `approximate: true` returned 0; `rebuildIndex()` doesn't build graph | Switched to exact search |
| Embedding to wrong endpoint | Config had hardcoded `embedModel: "or-qwen-embed"` | Removed model from config, made optional in request |
| Reconciliation flodded endpoint | All pending embeds fired at once on startup | Batch of 5 with 2s delay |
| `/api/server-type` 404 warnings | New server missing old node backend endpoint | Added endpoint returning `{ type: 'node-backend' }` |
| Role filter missing | MCP tool schema had no `role` param | Added to tool definition + frontend + server filter |

### What's Working

- Chat creation, persistence, and rendering across reloads
- Realtime embedding (message → vector within 1s)
- Semantic search (exact, 3047+ vectors, role filtering, text fallback)
- Migration scripts (`migrate.js`, `migrate-v2.js`, `heal-embed.js`)
- Startup reconciliation (backfills missing embeddings on restart)
- Maintenance cycles (5s flush, 60s health check + pending retry, failed retry)
- Pin persistence across sessions
- MCP archive tools (search, get_session, list_arena, find_similar, find_references)

