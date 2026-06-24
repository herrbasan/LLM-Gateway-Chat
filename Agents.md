# LLM Gateway Chat - Agent Instructions

## Core Maxims & Memory

Covered by the prime directive (`prime-directive.instructions.md`) — development maxims, fail-fast/fail-loud, memory protocol, and collaboration style. This file covers only project-specific details.

## Project Overview

LLM Gateway Chat is a **vanilla JavaScript SPA** with its own **Node.js backend** (default port 8080, configurable in `server/config.json`). It connects to an LLM Gateway for chat streaming and embedding, and stores all data in Rust-based embedded databases.

### Deployment

**Development** happens on **Coolkid** (this repo's primary machine). The database here is a stale copy of production data — it's disposable and safe to break. Test all storage/save-path changes here before pushing.

**Production** runs on **BADKID** at `\\BADKID\Stuff\SRV\LLM-Gateway-Chat`. The database there is live — do NOT run migration scripts, cleanup scripts, or experimental write operations against it. After committing and pushing changes, pull on BADKID:

```powershell
git -C "\\BADKID\Stuff\SRV\LLM-Gateway-Chat" pull --recurse-submodules
```

The server auto-restarts when files change.

### Key Characteristics

- **No Build Process**: Directly serve static HTML/JS/CSS files via the backend
- **Zero Runtime Dependencies**: All vendor libraries are locally vendored
- **Dual-Mode Transport**: SSE (default) or WebSocket via JSON-RPC 2.0 to gateway
- **Frontend-Driven Architecture**: MCP tool execution happens entirely in the browser
- **AI-First Maintainability**: Code is optimized for LLM parsing, not human readability dogmas
- **Own Backend**: Node.js server (port from `server/config.json`, default 8080) serves static files + REST API + search

---

## Technology Stack

| Layer | Technology |
|-------|------------|
| **Language** | Vanilla JavaScript (ES2022+), HTML5, CSS3 |
| **UI Library** | NUI Web Components (proprietary, via Git submodule) |
| **Backend** | Node.js native HTTP (no framework), port from `server/config.json` (default 8080) |
| **Structured DB** | nDB (Rust-based JSON Lines document store) |
| **Vector DB** | nVDB (Rust-based vector DB, exact search) |
| **Embedding** | Gateway `/v1/embeddings` (Qwen3-Embedding-4B via OpenRouter, 2560d) |
| **Communication** | SSE (default) or WebSocket (JSON-RPC 2.0) to gateway + REST to backend |
| **Logging** | nLogger (JSON Lines structured logger) |
| **Markdown** | markdown-it + DOMPurify + Prism.js |

---

## Project Structure

```
├── chat/                       # Main application
│   ├── index.html             # Entry point
│   ├── css/
│   │   └── chat.css           # Application styles
│   └── js/
│       ├── chat.js            # Main controller (UI, event handling, archive tools)
│       ├── client-sdk.js      # GatewayClient (WebSocket/REST SDK)
│       ├── api-client.js      # BackendClient (REST to Node backend)
│       ├── storage.js         # localStorage/IndexedDB fallback
│       ├── conversation.js    # Conversation state management
│       ├── chat-history.js    # Multi-conversation history + backend sync
│       ├── mcp-client.js      # MCP tool client (SSE connections)
│       ├── file-store.js      # File storage (sends base64 to server, returns URLs)
│       ├── image-store.js     # Re-exports fileStore as imageStore (backwards compat)
│       ├── markdown.js        # Markdown rendering with syntax highlight
│       ├── tts-utils.js       # Text-to-speech utilities
│       └── config.js          # User configuration (gateway URL, backend toggle)
├── chat-arena/                # Arena mode (LLM-to-LLM autonomous conversations)
│   ├── index.html
│   └── js/
│       ├── arena.js           # Arena orchestrator + UI
│       ├── config.js          # Arena defaults
│       └── storage.js         # Arena backend-only storage
├── lib/                       # Shared libraries
│   ├── nui_wc2/               # NUI Web Components (Git submodule)
│   ├── ndb/napi/              # nDB Node bindings
│   ├── nvdb/napi/             # nVDB Node bindings
│   ├── nlogger/               # nLogger (ESM)
│   └── nlogger-cjs.js         # nLogger CJS bridge
├── server/                    # Node.js backend
│   ├── server.js              # HTTP server (REST API, static files, search, embeddings, auth)
│   ├── embed.js               # Shared embedding utilities (chunking, fetch, vector ops)
│   ├── backfill-embed.js      # Offline bulk embedding backfill
│   ├── migrate-import-nedb.js       # Import legacy NeDB backups → nDB (step 1 of 2, historical)
│   ├── migrate-pack-conversations.js # Per-message docs → conversation docs (step 2 of 2, historical)
│   ├── migrate-ndb-to-folder.js     # Flat .jsonl → folder-as-database (future)
│   ├── migrate-ndb-buckets.js       # File migration utilities
│   ├── config.json            # Server configuration (port, users, embedding, paths)
│   ├── server.bat             # Windows convenience launcher
│   ├── logs/                  # JSON Lines log files (gitignored)
│   └── data/                  # nDB + nVDB database files (gitignored)
├── docs/                      # Documentation
│   ├── api_rest.md            # Gateway REST API reference
│   ├── api_websocket.md       # Gateway WebSocket/JSON-RPC protocol
│   ├── bugs.md                # Known bugs and their status
│   ├── features_backlog.md    # Feature backlog (completed + pending)
│   └── dev_plan_user_settings.md  # Multi-user auth architecture plan
└── package.json               # Minimal metadata
```

---

## Running the Application

### Prerequisites

1. A running **LLM Gateway backend** instance (default: `http://192.168.0.100:3400`)
2. Node.js v24+
3. At least one user configured (via `server/config.json` `users[]` or `SUPERADMIN_USERNAME`/`SUPERADMIN_PASSWORD` env vars)

### Configuration

**Server config** (`server/config.json`) — controls the backend, users, embedding, and data paths:
```json
{
    "port": 8080,
    "embedUrl": "http://192.168.0.100:3400/v1/embeddings",
    "embedDims": 2560,
    "embedMaxTokens": 25000,
    "embedBatchTokenLimit": 29000,
    "sessionTtlMinutes": 1440,
    "users": [
        {
            "id": "admin-seed-user",
            "username": "chat_user",
            "password": "chat2026",
            "displayName": "Chat User",
            "dbPath": "server/data/chat_user",
            "rights": { "login": true, "read": true, "write": true, "admin": true }
        }
    ]
}
```

**Frontend config** — `chat/js/config.js` is **dynamically generated by the server** from environment variables (`.env` file). Available env vars:
```bash
LLM_GATEWAY_URL=http://192.168.0.100:3400
UI_DEFAULT_MODEL=
UI_DEFAULT_TEMP=0.7
UI_DEFAULT_TOKENS=
UI_OPERATION_MODE=sse
TTS_ENDPOINT=http://localhost:2244
TTS_VOICE=
TTS_SPEED=1.0
```

### Start Commands

```bash
# Start the backend (serves static files + API)
node server/server.js
# or
npm start

# Navigate to http://localhost:8080/chat/
```

### Deployment (Production Server)

The production deployment lives on a network share. After committing and pushing
changes, always pull on the deployment server:

```powershell
# Add safe directory exception (one-time, already done):
# git config --global --add safe.directory '//BADKID/Stuff/SRV/LLM-Gateway-Chat'

# Pull latest (including submodules):
git -C "\\BADKID\Stuff\SRV\LLM-Gateway-Chat" pull --recurse-submodules
```

The server auto-restarts when files change (nodemon or similar). The share is at
`\\BADKID\Stuff\SRV\LLM-Gateway-Chat` and is a git clone of this repo.

---

## Architecture Overview

### Communication Flow

```
┌─────────────┐  SSE (default) or   ┌─────────────┐      HTTP      ┌─────────────┐
│   Chat UI   │ ◄──────────────────► │  LLM Gateway │ ◄───────────► │   LLM API   │
│  (Browser)  │  (JSON-RPC 2.0 WS)  │  (Backend)   │               │  (Provider) │
└──────┬──────┘                      └──────┬──────┘               └─────────────┘
       │                                    │
       │ REST (configurable port)           │ /v1/embeddings
       │ + SSE (embed events)               ▼
       ▼                            ┌─────────────┐
┌─────────────┐                    │ Rust DBs    │
│ Chat Backend│◄──── nDB/nVDB ───►│ (portable)  │
│ (Node.js)   │                    └─────────────┘
└─────────────┘
       │
       │ SSE (EventSource)
       ▼
┌─────────────┐
│ MCP Servers │  (Frontend-driven tool execution)
└─────────────┘
```

### Module Responsibilities

| Module | Purpose |
|--------|---------|
| `chat.js` | UI controller, event handlers, message rendering, streaming logic, archive tools, login, presets, admin UI, embed status monitoring via SSE |
| `client-sdk.js` | `GatewayClient` class - dual-mode (SSE + WebSocket) transport, JSON-RPC 2.0, auto-reconnect, stream registry |
| `api-client.js` | `BackendClient` class - REST calls to Node backend (cookie auth, `/api/chats`, `/api/search`, `/api/auth/*`, `/api/user/settings`) |
| `conversation.js` | `Conversation` class - message history, versioning, API message formatting, backend sync, `thinking_signature` propagation |
| `chat-history.js` | `ChatHistory` class - multi-conversation management, backend CRUD, localStorage fallback |
| `mcp-client.js` | `MCPClient` class - SSE connections to MCP servers, tool registry, execution |
| `file-store.js` | File storage — sends base64 to server `/api/buckets/images/`, returns lightweight URLs |
| `image-store.js` | Re-exports `fileStore` as `imageStore` for backward compatibility |
| `markdown.js` | `renderMarkdown()` - markdown-it with Prism highlighting, DOMPurify sanitization |
| `tts-utils.js` | Text-to-speech utilities (endpoint management, voice list, playback) |
| `storage.js` | localStorage/IndexedDB fallback for preferences (MCP config, presets) |

---

## Key Implementation Details

### NUI Web Components Usage

**CRITICAL**: Always use NUI components, never native HTML elements for UI controls.

**Correct:**
```html
<nui-input id="temperature">
    <input type="number" min="0" max="2" step="0.1">
</nui-input>

<nui-select id="model-select" searchable>
    <select>...</select>
</nui-select>
```

**Avoid:**
```html
<input type="number" id="temperature" class="custom-input">
<select id="model-select">...</select>
```

### Theme Variables

Use NUI's CSS custom properties:

```css
.my-element {
    background: var(--color-base);
    color: var(--text-color);
    border: thin solid var(--border-shade1);
    padding: var(--nui-space);
}
```

Key variables:
- `--color-base`, `--color-shade1-9` - Surface colors
- `--text-color`, `--text-color-dim` - Text colors
- `--color-highlight` / `--nui-accent` - Accent color
- `--border-shade1-4` - Border colors
- `--nui-space`, `--nui-space-half` - Spacing
- `--border-radius1`, `--border-radius2` - Border radius

### Storage Strategy

| Data Type | Storage | Key |
|-----------|---------|-----|
| Sessions | nDB | `_type: 'session'`, `id: chat_xxx` |
| Conversation messages | nDB | `_type: 'conversation'`, `id: chat_xxx`, inline `messages` array, each with `embedStatus` (`pending`/`embedded`/`failed`) |
| Embedding vectors | nVDB | `chatId` + `msgIdx` payload, keyed by message ID |
| User settings | nDB | `_type: 'user_settings'`, `id: {userId}` — operationMode, temperature, language, presets, etc. |
| User auth | nDB (`users_db`) | `_type: 'user'` — username, passwordHash, dbPath, rights, userToken |
| Conversation history (fallback) | localStorage | `chat-conversation-${chatId}` |
| Chat list metadata (fallback) | localStorage | `chat-history-index` |
| System prompt presets | localStorage | `chat-system-presets` (via `storage.getPref`) |
| MCP server config | localStorage | `mcp-servers`, `mcp-enabledTools` |
| Image files | nDB Buckets | `/api/buckets/images/{sessionId}/{filename}`, garbage-collected on chat delete |

**Data model**: One conversation document per session. Messages are an inline array indexed by `idx`. nVDB stores vectors keyed by message ID with `{ chatId, msgIdx }` payload for back-reference. Each message carries an `embedStatus` field (`pending` → `embedded` → `failed`) updated by the server and pushed to the frontend in real-time via SSE.

### Embedding & Monitoring

- **Async Fire-and-Forget**: `embedMessageAsync` runs after each `POST /api/chats/:id/messages`, embedding user and assistant messages (tool messages skipped).
- **Self-Healing**: On startup, the server reconciles nDB messages against nVDB — missing vectors are re-embedded, orphaned `pending`/missing `embedStatus` fields are backfilled.
- **Real-Time SSE Notifications**: `GET /api/embed-events?chatId=xxx` streams `embed-status` events as each message transitions from `pending` → `embedded`/`failed`. Chat uses `msgIdx` matching; Arena uses `messageId` (direct DOM attribute).
- **Visual Indicators**: Small colored dots in message headers — 🟡 yellow pulse (pending), 🟢 green (embedded), 🔴 red (failed), ⚪ gray (unknown). Shown on both user and assistant bubbles for monitoring.
- **Retry & Backoff**: Failed embeddings retry 3× with exponential backoff, then enter a persistent queue with escalating delays (5s → 30s → 2min → 10min → 30min).

### Image Storage & Garbage Collection Architecture
- **Zero JSON Bloat:** MCP tool responses returning large base64 images are intercepted by the frontend. The base64 is uploaded via `/api/buckets/images/...`, returning a lightweight URL string replacing the massive base64 blob in the JSON response sent to the Gateway.
- **Native nDB Bucket Storage:** Images are securely stored in the native Rust `nDB` engine using `db.bucket('images')`. This eliminates orphaned physical sidecar files and ensures the database folder `_files/` directory is highly portable and cleanly backed up alongside the documents.
- **Lifecycle Integration:** When a chat is deleted via the UI (`DELETE /api/chats/:id`), the backend extracts every image URL (both user-uploaded and MCP-generated), checks if any other active chats reference them, and calls `db.releaseFile(ref)`. Orphans are safely moved to the `.trash` directory natively by the Rust engine.

### MCP Tool Execution (Frontend-Driven)

Tool execution happens **entirely in the browser** using the OpenAI-compatible `tool_calls` protocol:

1. Frontend sends chat request with `tools` array and system prompt
2. Gateway streams `delta.tool_calls` events (OpenAI-compatible format: `[{id, type: 'function', function: {name, arguments}}]`)
3. On `finish_reason: 'tool_calls'`, frontend aggregates all tool call deltas, executes each:
   - **Local archive tools** (`chat_archive_*`) → direct REST calls to backend (`/api/search`, `/api/chats/:id`, `/api/arena`, `/api/references`)
   - **MCP tools** → via `mcpClient.executeTool()` over SSE connections
4. Results sent as `role: 'tool'` messages with `tool_call_id` matching the assistant's `tool_calls[].id`

**Backend is NOT involved in tool execution** — it only provides the archive REST API. Tool detection is fully native (no text parsing, no regex).

---

## Coding Guidelines

### AI-First Maintainability

This codebase is designed to be maintained by LLMs, not humans:

1. **Explicit, flat logic** over deep abstraction hierarchies
2. **Dense colocation** - related code stays together
3. **Minimal comments** - only structural markers, not verbose explanations
4. **Deterministic clarity** - code paths should be obvious from reading

### Code Style

- **Indentation**: 4 spaces (not tabs, for alignment with existing code)
- **Quotes**: Single quotes for strings
- **Semicolons**: Required
- **Naming**: camelCase for variables/functions, PascalCase for classes
- **Modules**: ES6 modules with explicit imports/exports

### File Organization Patterns

```javascript
// ============================================
// Module Name - Brief Description
// ============================================

import { Dependency } from './dependency.js';

// Constants
const CONFIG = window.CHAT_CONFIG || {};

// State (module-level)
let currentState = null;

// ============================================
// Main Class/Controller
// ============================================

export class MyClass {
    constructor() {
        // Initialize
    }
    
    // Public methods
    publicMethod() {}
    
    // Private helpers (prefix with _)
    _privateHelper() {}
}

// ============================================
// Helper Functions
// ============================================

function helperFunction() {}

// ============================================
// Initialization
// ============================================

export const singleton = new MyClass();
```

---

## API Reference

### GatewayClient (client-sdk.js)

```javascript
const client = new GatewayClient({
    baseUrl: 'http://localhost:3400',
    operationMode: 'sse'  // 'sse' (default) or 'websocket'
});

// REST methods
const models = await client.getModels();
const health = await client.getHealth();

// WebSocket streaming
const stream = client.chatStream({
    model: 'gemini-flash',
    messages: [{role: 'user', content: 'Hello'}]
});

stream.on('delta', (data) => console.log(data.choices[0].delta.content));
stream.on('done', (data) => console.log('Complete'));
stream.on('error', (err) => console.error(err));

// Modern async iterator (recommended)
for await (const event of client.streamChatIterable(params)) {
    // event.type: 'delta' | 'progress' | 'done' | 'error' | 'aborted'
    // event.content (for delta)
    // event.data (for progress)
}
```

### Conversation (conversation.js)

```javascript
const conversation = new Conversation('storage-key');

// Add exchange
const exchangeId = await conversation.addExchange(content, attachments);

// Update streaming response
conversation.updateAssistantResponse(exchangeId, deltaContent);

// Complete exchange
conversation.setAssistantComplete(exchangeId, usage, context);

// Get formatted messages for API (async — resolves image URLs)
const messages = await conversation.getMessagesForApi(systemPrompt);

// Version control (regenerate)
conversation.regenerateResponse(exchangeId);
conversation.switchVersion(exchangeId, 'next' | 'prev');
```

### MCPClient (mcp-client.js)

```javascript
import { mcpClient } from './mcp-client.js';

// Add/connect server
mcpClient.addServer(url, name);
await mcpClient.connectToServer(server);

// Get tools for LLM
const tools = mcpClient.getFormattedToolsForLLM();
const toolPrompt = mcpClient.generateToolPrompt();

// Execute tool
const result = await mcpClient.executeTool(toolName, parameters, onProgress);
```

---

## Common Tasks

### Adding a New UI Feature

1. Update HTML in `chat/index.html` using NUI components
2. Add event listeners in `chat/js/chat.js` `setupEventListeners()`
3. Add rendering logic in appropriate render function
4. Update styles in `chat/css/chat.css` using NUI theme variables

### Adding a New Configuration Option

1. Add default to the server's dynamic config generation (`server/server.js` L1738-1753)
2. Optionally add an env var override (`.env` file)
3. Read value in `chat/js/chat.js` from `CONFIG` object
4. Apply in `applyDefaultConfig()` or directly where used

### Modifying MCP Tool Behavior

1. Tool detection: `chat/js/chat.js` - `streamResponse()` function
2. Tool execution: `chat/js/mcp-client.js` - `executeTool()` method
3. Message formatting: `chat/js/conversation.js` - `getMessagesForApi()`

### Updating Vendor Libraries

Vendored dependencies (markdown-it, Prism.js, DOMPurify) are served from `nui_wc2` (the NUI submodule). When WebAdmin vendor files change, update the submodule:

```bash
git submodule update --remote lib/nui_wc2
```

No separate vendor directory or update scripts are needed.

---

## LLM Gateway Backend Integration

**Do NOT build complex frontend workarounds for backend limitations.**

If a feature requires backend changes, point them out explicitly:

- New API endpoints
- Additional WebSocket methods
- Modified response formats
- New capabilities in model definitions

The LLM Gateway is our proprietary project - we can and should modify it when needed.

---

## Security Considerations

1. **Cookie-only auth**: No API keys or secrets in frontend code. HttpOnly cookies prevent XSS token theft.
2. **Password hashing**: `crypto.scryptSync` with random salt per user, stored in isolated `users_db`.
3. **XSS Protection**: DOMPurify sanitizes all rendered markdown.
4. **Same-origin by default**: Server serves both frontend and API — no CORS needed in production.
5. **Image validation**: Only `image/*` MIME types accepted.
6. **Database isolation**: Each user gets a physically separate nDB + nVDB at their `dbPath`.

---

## Timeout & Progress Rules

These rules prevent indefinite hangs during task execution. The agent must never silently block for >15s.

### 1. Every command gets a timeout and expected output

Before any bash/node command that could block (servers, model loading, HTTP calls), state:

```
Running: <command>
Expect: <result> within <N>s
```

If the command exceeds its timeout, report what happened and what to do next.

### 2. Never start server processes in the foreground

Servers that bind ports and run indefinitely must be started in background mode. Use:

```powershell
# PowerShell: background start, then poll health
Start-Process -NoNewWindow node -ArgumentList "server/server.js"
```

After starting, poll the health endpoint with a separate short-lived command to confirm it's ready.

### 3. Progress reporting for operations >10s

If any operation takes longer than 10 seconds, report progress at least once:

- Model loading: "Waiting for model to load, ~30s estimated"
- Batch processing: "Processing batch 3/11, ETA 45s"
- Embedding: "Embedding 50 texts, ~5s remaining"
- HTTP call hanging: "Request to Fatten timed out after 30s. Retrying."

### 4. Self-contained E2E tests over server interactions

When validating end-to-end functionality, prefer single-script tests that run start-to-finish without requiring a long-running server:

```javascript
// Inline test: init nVDB → embed test data → search → verify → exit
node -e "(async () => { /* test logic */ })()"
```

### 5. No ambiguous "let me try" without a fallback

Every approach gets one attempt. If it fails, state the failure, diagnose the root cause, and propose a fix — don't retry the same approach silently.

### 6. Read AI-generated output patterns carefully

Output that looks like a server log line (e.g., "Chat Backend running at http://localhost:3500") means the process started but hasn't returned. Recognize this pattern immediately and don't wait for it to "finish."

---

## Testing Checklist

Before submitting changes:

- [ ] Application loads without console errors
- [ ] Gateway connection establishes successfully
- [ ] Models load and populate select dropdown
- [ ] Messages send and receive correctly
- [ ] Streaming responses display properly
- [ ] Image attachments work (paste and file upload)
- [ ] Conversation history persists across reloads
- [ ] Multiple chat sessions work correctly
- [ ] MCP servers connect and tools execute (if applicable)
- [ ] Mobile layout is usable (basic responsive check)

---

## Documentation References

- `docs/api_rest.md` - REST API specification
- `docs/api_websocket.md` - WebSocket/JSON-RPC protocol
- `docs/MCP_TOOL_INTEGRATION.md` - Frontend MCP architecture
- `nui_wc2/docs/playground-component-quickstart.md` - NUI component usage
- `nui_wc2/Agents.md` - NUI library agent instructions

---

## External Dependencies (Vendored)

| Library | Version | Purpose | Source |
|---------|---------|---------|--------|
| markdown-it | 14.x | Markdown parsing | WebAdmin/shared |
| markdown-it-prism | latest | Syntax highlighting | WebAdmin/shared |
| PrismJS | 1.29.x | Code highlighting | WebAdmin/shared |
| DOMPurify | 3.x | XSS sanitization | WebAdmin/shared |

These are copied from the WebAdmin project via `update-vendor.js`.
