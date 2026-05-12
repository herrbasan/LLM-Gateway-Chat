# Chat Architecture Refactor — Development Plan

> Branch: `refactor/chat-architecture`
> Status: Phase 2 complete, Phase 3 in progress
> Last updated: 2026-05-11

---

## Objective

Transform the LLM Gateway Chat from a pure frontend SPA (localStorage/IndexedDB) into a multi-user, database-backed application with semantic search. The archive becomes queryable by LLMs via MCP tools, and arena sessions are automatically published.

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


---

## Technology Decisions

| Component | Choice | Rationale |
|-----------|--------|-----------|
| Backend | Node.js + native HTTP | Matches gateway stack, no frameworks |
| Structured DB | nDB (npm module) | Document store for chat metadata |
| Vector DB | nVDB (npm module) | HNSW search for semantic retrieval |
| NOT using | nGDB wrapper | Unnecessary proxy layer for single service |
| Auth | API keys + session cookies | Simple, sufficient for lab use |
| Embedding | Gateway `/v1/embeddings` | Gateway proxies to Fatten internally |

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
  POST to Wrapper:4080/embedding or Gateway:3400/v1/embeddings → 
  Qwen3-Embedding-4B on Fatten (Intel Arc A770) →
  Store [2560] vector in nVDB
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
- [ ] `/api/search` endpoint — text-based only (line 225). Needs nVDB vector search.
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
- [ ] MCP tool definitions
- [ ] Backend endpoints for each tool
- [ ] Frontend integration (chat.js tool execution)
- [ ] System prompt injection when tools active

---

## Phase 5: Frontend Migration

**Goal:** Frontend uses backend API instead of localStorage.

### 5.1 Client SDK Changes

`client-sdk.js` additions:
- `client.createApiKey()` → `POST /api/auth/key`
- `client.listChats()` → `GET /api/chats`
- `client.createChat()` → `POST /api/chats`
- `client.getChat(id)` → `GET /api/chats/:id`
- `client.sendMessage()` → `POST /api/chats/:id/messages`
- `client.search()` → `POST /api/search`

### 5.2 State Management Changes

`chat-history.js`:
- Replace `localStorage` reads/writes with API calls
- Keep in-memory cache for active session
- Lazy-load chat list on sidebar open

`conversation.js`:
- `addExchange()` → POST to backend, then update local state
- `getMessagesForApi()` → reads from local cache (already synced)

### 5.3 Offline Behavior

- If backend unreachable, show offline indicator
- Offer "local mode" fallback (existing localStorage behavior)
- Queue sends for retry when connection returns

### 5.4 Deliverables
- [ ] API client methods
- [ ] chat-history.js uses backend
- [ ] conversation.js syncs to backend
- [ ] Offline indicator and fallback
- [ ] Import existing localStorage data

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
| 5 | Image storage — keep IndexedDB or move to backend? | Architecture complexity | Keep IndexedDB for v1, store references in nDB |
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

