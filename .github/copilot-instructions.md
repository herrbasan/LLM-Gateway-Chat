# LLM Gateway Chat - Agent Instructions

## Project Overview

LLM Gateway Chat is a **vanilla JavaScript SPA** with its own **Node.js backend** (port 3500). It connects to an LLM Gateway for chat streaming and embedding, and stores all data in Rust-based embedded databases.

### Key Characteristics

- **No Build Process**: Directly serve static HTML/JS/CSS files via the backend
- **Zero Runtime Dependencies**: All vendor libraries are locally vendored
- **Dual-Mode Transport**: SSE (default) or WebSocket via JSON-RPC 2.0 to gateway
- **Frontend-Driven Architecture**: MCP tool execution happens entirely in the browser
- **AI-First Maintainability**: Code is optimized for LLM parsing, not human readability dogmas
- **Own Backend**: Node.js server on port 3500 serves static files + REST API + search

---

## Technology Stack

| Layer | Technology |
|-------|------------|
| **Language** | Vanilla JavaScript (ES2022+), HTML5, CSS3 |
| **UI Library** | NUI Web Components (proprietary, via Git submodule) |
| **Backend** | Node.js native HTTP (no framework), port 3500 |
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
├── chat/vendor/               # Vendored dependencies + update scripts
├── nui_wc2/                   # NUI Web Components (Git submodule)
├── lib/                       # Shared libraries
│   ├── ndb/napi/              # nDB Node bindings
│   ├── nvdb/napi/             # nVDB Node bindings
│   └── nlogger-cjs.js         # nLogger CJS bridge
├── server/                    # Node.js backend
│   ├── server.js              # HTTP server (port 3500), REST API, search, embeddings
│   ├── embed.js               # Bulk embedding pipeline
│   ├── migrate-import-nedb.js       # Import legacy NeDB backups → nDB (step 1 of 2)
│   ├── migrate-pack-conversations.js # Repack per-message docs → conversation docs (step 2 of 2)
│   ├── migrate-ndb-to-folder.js     # Flat .jsonl → folder-as-database (future, not yet needed)
│   ├── config.json            # Server configuration
│   ├── server.bat             # Windows convenience launcher
│   ├── logs/                  # JSON Lines log files (gitignored)
│   └── data/                  # nDB + nVDB database files (gitignored)
├── docs/                      # Documentation
│   ├── api_rest.md
│   ├── api_websocket.md
│   ├── bugs.md
│   ├── dev_plan_refactor.md
│   ├── dev_plan_user_settings.md
│   └── features_backlog.md
└── package.json               # Minimal metadata
```

---

## Running the Application

### Prerequisites

1. A running **LLM Gateway backend** instance (default: `http://192.168.0.100:3400`)
2. Node.js v24+

### Configuration

Edit `server/config.json` for backend settings and `chat/js/config.js` for frontend:

```javascript
// chat/js/config.js
window.CHAT_CONFIG = {
    gatewayUrl: 'http://192.168.0.100:3400',
    enableBackend: true,
    backendUrl: 'http://localhost:3500',
    defaultModel: '',
    defaultTemperature: 0.7,
    defaultMaxTokens: null,
};
```

```json
// server/config.json
{
    "port": 3500,
    "embedUrl": "http://192.168.0.100:3400/v1/embeddings",
    "embedDims": 2560,
    "embedMaxTokens": 30000,
    "embedBatchTokenLimit": 29000
}
```

### Start Commands

```bash
# Start the backend (serves static files + API)
node server/server.js
# or
npm start

# Navigate to http://localhost:3500/chat/
```

---

## Architecture Overview

### Communication Flow

```
┌─────────────┐  SSE (default) or   ┌─────────────┐      HTTP      ┌─────────────┐
│   Chat UI   │ ◄──────────────────► │  LLM Gateway │ ◄───────────► │   LLM API   │
│  (Browser)  │  (JSON-RPC 2.0 WS)  │  (Backend)   │               │  (Provider) │
└──────┬──────┘                      └──────┬──────┘               └─────────────┘
       │                                    │
       │ REST (port 3500)                   │ /v1/embeddings
       ▼                                    ▼
┌─────────────┐                    ┌─────────────┐
│ Chat Backend│◄──── nDB/nVDB ───►│ Rust DBs    │
│ (Node.js)   │                    │ (portable)  │
└─────────────┘                    └─────────────┘
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
| `chat.js` | UI controller, event handlers, message rendering, streaming logic, archive tools |
| `client-sdk.js` | `GatewayClient` class - WebSocket connection, JSON-RPC protocol, auto-reconnect |
| `api-client.js` | `BackendClient` class - REST calls to Node backend (/api/chats, /api/search) |
| `conversation.js` | `Conversation` class - message history, versioning, API message formatting, backend sync |
| `chat-history.js` | `ChatHistory` class - multi-conversation management, backend CRUD, localStorage fallback |
| `mcp-client.js` | `MCPClient` class - SSE connections to MCP servers, tool registry, execution |
| `image-store.js` | `ImageStore` class - re-exports fileStore for backward compatibility |
| `markdown.js` | `renderMarkdown()` - markdown-it with Prism highlighting, DOMPurify sanitization |

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
| Conversation messages | nDB | `_type: 'conversation'`, `id: chat_xxx`, inline `messages` array |
| Embedding vectors | nVDB | `chatId` + `msgIdx` payload, keyed by message ID |
| Conversation history (fallback) | localStorage | `chat-conversation-${chatId}` |
| Chat list metadata (fallback) | localStorage | `chat-history-index` |
| User preferences | localStorage | `chat-user-*` |
| MCP server config | localStorage | `mcp-servers`, `mcp-enabledTools` |
| Image files | Server filesystem | `server/data/files/{exchangeId}/` |

**Data model**: One conversation document per session. Messages are an inline array indexed by `idx`. nVDB stores vectors keyed by message ID with `{ chatId, msgIdx }` payload for back-reference.

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
    accessKey: 'optional-key'
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

1. Add default to `chat/js/config.js` `window.CHAT_CONFIG`
2. Read value in `chat/js/chat.js` from `CONFIG` object
3. Apply in `applyDefaultConfig()` or directly where used

### Modifying MCP Tool Behavior

1. Tool detection: `chat/js/chat.js` - `streamResponse()` function
2. Tool execution: `chat/js/mcp-client.js` - `executeTool()` method
3. Message formatting: `chat/js/conversation.js` - `getMessagesForApi()`

### Updating Vendor Libraries

Run the update script from `chat/vendor/` when WebAdmin vendor files change:

```bash
cd chat/vendor
node update-vendor.js       # Cross-platform Node
.\update-vendor.ps1         # Windows PowerShell
update-vendor.bat           # Windows CMD
./update-vendor.sh          # Linux/macOS
```

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

1. **No secrets in frontend**: API keys are stored in Gateway config, not here
2. **XSS Protection**: DOMPurify sanitizes all rendered markdown
3. **CORS**: Backend must allow origin from this client
4. **Image validation**: Only image/* MIME types accepted
5. **Local-only by default**: WebSocket access restricted to local IPs

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
