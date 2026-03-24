# LLM Gateway Chat - Agent Instructions

## Project Overview

LLM Gateway Chat is a **pure frontend vanilla JavaScript client** designed to interface with an LLM Gateway backend. It is a **single-page application (SPA)** that runs entirely in the browser without any build steps or external runtime dependencies.

### Key Characteristics

- **No Build Process**: Directly serve static HTML/JS/CSS files
- **Zero Runtime Dependencies**: All vendor libraries are locally vendored
- **WebSocket-First**: Real-time communication with backend via JSON-RPC 2.0 over WebSocket
- **Frontend-Driven Architecture**: MCP tool execution happens entirely in the browser
- **AI-First Maintainability**: Code is optimized for LLM parsing, not human readability dogmas

---

## Technology Stack

| Layer | Technology |
|-------|------------|
| **Language** | Vanilla JavaScript (ES2022+), HTML5, CSS3 |
| **UI Library** | NUI Web Components (proprietary, via Git submodule) |
| **Communication** | WebSocket (JSON-RPC 2.0) + REST fallback |
| **Storage** | localStorage (conversation metadata), IndexedDB (images) |
| **Markdown** | markdown-it + DOMPurify + Prism.js |
| **Server** | Any static file server (Python, Node, or VS Code Live Server) |

---

## Project Structure

```
├── chat/                       # Main application
│   ├── index.html             # Entry point
│   ├── css/
│   │   └── chat.css           # Application styles
│   └── js/
│       ├── chat.js            # Main controller (UI, event handling)
│       ├── client-sdk.js      # GatewayClient (WebSocket/REST SDK)
│       ├── conversation.js    # Conversation state management
│       ├── chat-history.js    # Multi-conversation history
│       ├── mcp-client.js      # MCP tool client (SSE connections)
│       ├── image-store.js     # IndexedDB image storage
│       ├── markdown.js        # Markdown rendering with syntax highlight
│       └── config.js          # User configuration (gateway URL, defaults)
├── chat/vendor/             # Vendored dependencies + update scripts
│   ├── markdown-it.js
│   ├── markdown-it-prism.js
│   ├── prism.js / prism.css
│   └── purify.js
├── nui_wc2/                   # NUI Web Components (Git submodule)
│   ├── NUI/nui.js             # Core library
│   └── NUI/css/nui-theme.css  # Theme variables
├── docs/                      # Documentation
│   ├── api_rest.md            # REST API documentation
│   ├── api_websocket.md       # WebSocket API documentation
│   ├── MCP_TOOL_INTEGRATION.md # MCP architecture guide
│   ├── features_backlog.md    # Feature tracking
│   └── dev_plan_edit.md       # Implementation plans
├── package.json               # Minimal metadata (no runtime deps)
├── start.py                   # Python HTTP server with CORS
└── update-vendor.js           # Script to sync vendor files from WebAdmin
```

---

## Running the Application

### Prerequisites

1. A running **LLM Gateway backend** instance (default: `http://localhost:3400`)
2. Any static HTTP server

### Configuration

Edit `chat/js/config.js` before launching:

```javascript
window.CHAT_CONFIG = {
    gatewayUrl: 'http://localhost:3400',   // Your gateway URL
    defaultModel: '',                       // Optional: auto-select model
    defaultTemperature: 0.7,               // Default temperature (0-2)
    defaultMaxTokens: null,                // Optional max tokens
};
```

### Start Commands

**Option 1: Python (recommended)**
```bash
python start.py [PORT]     # Default port 8080
```

**Option 2: Node.js**
```bash
npx serve -l 8080
```

**Option 3: Python one-liner**
```bash
python -m http.server 8080
```

Then navigate to: `http://localhost:8080/chat/`

---

## Architecture Overview

### Communication Flow

```
┌─────────────┐      WebSocket       ┌─────────────┐      HTTP      ┌─────────────┐
│   Chat UI   │ ◄──────────────────► │  LLM Gateway │ ◄───────────► │   LLM API   │
│  (Browser)  │    (JSON-RPC 2.0)    │  (Backend)   │               │  (Provider) │
└──────┬──────┘                      └─────────────┘               └─────────────┘
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
| `chat.js` | UI controller, event handlers, message rendering, streaming logic |
| `client-sdk.js` | `GatewayClient` class - WebSocket connection, JSON-RPC protocol, auto-reconnect |
| `conversation.js` | `Conversation` class - message history, versioning, API message formatting |
| `chat-history.js` | `ChatHistory` class - multi-conversation management, localStorage persistence |
| `mcp-client.js` | `MCPClient` class - SSE connections to MCP servers, tool registry, execution |
| `image-store.js` | `ImageStore` class - IndexedDB storage for image attachments |
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
| Conversation history | localStorage | `chat-conversation-${chatId}` |
| Chat list metadata | localStorage | `chat-history-index` |
| User preferences | localStorage | `chat-user-*` |
| MCP server config | localStorage | `mcp-servers`, `mcp-enabledTools` |
| Image attachments | IndexedDB | `chat-images` store |

### MCP Tool Execution (Frontend-Driven)

Tool execution happens **entirely in the browser**:

1. Frontend sends chat request with `tools` array and system prompt
2. LLM responds with `__TOOL_CALL__({"name": "...", "args": {...}})` in text
3. Frontend detects pattern, executes tool via `mcpClient.executeTool()`
4. Result sent as new user message with `<tool_result>` XML

**Backend is NOT involved in tool execution** - it just forwards messages.

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

// Get formatted messages for API
const messages = conversation.getMessagesForApi(systemPrompt);

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

Run one of the update scripts when WebAdmin vendor files change:

```bash
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
