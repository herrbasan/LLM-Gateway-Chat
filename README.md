# LLM Gateway Chat

LLM Gateway Chat is a lightweight, pure frontend vanilla JavaScript client designed to interface directly with an LLM Gateway backend. Built with a focus on performance, reliability, and local execution, it leverages the NUI Web Components library for a consistent, responsive UI supporting both desktop and mobile layouts.

This application runs entirely in the browser without any build steps or external network dependencies for its vendor libraries, ensuring a robust and self-contained frontend experience.

## Usage

### 1. Prerequisites
You need a running instance of the LLM Gateway backend to attach this client to.

### 2. Configuration
Before launching, configure the application to connect to your gateway by editing `chat/js/config.js`:

```javascript
window.CHAT_CONFIG = {
    gatewayUrl: 'http://localhost:3400',   // Target LLM Gateway URL
    defaultModel: '',                      // Optional: Auto-select this model
    defaultTemperature: 0.7,               // Default temperature (0-2)
    defaultMaxTokens: 2048,                // Default max tokens
};
```

### 3. Running the Client
Since this is a pure web frontend, you can serve it using any simple static HTTP server. Serve the directory at the root of this project.

**Option 1: Node.js (npx serve)**
```bash
npx serve -l 8080
```

**Option 2: Python**
```bash
python -m http.server 8080
```

**Option 3: VS Code Live Server / Five Server**
Open the workspace in VS Code and start your preferred live server extension targeting `chat/index.html`.

Once the server is running, navigate to the provided local URL (e.g., `http://localhost:8080/chat/index.html`) in your browser to start chatting.

## Key Features

- **Direct Gateway Integration:** Interfaces seamlessly with the LLM Gateway backend.
- **Multiple Chat Sessions:** Maintains chat history across multiple separate conversational threads using `localStorage`.
- **Vision Support:** Attach and process images via IndexedDB.
- **Markdown & Code:** Full markdown rendering with syntax highlighting and easy code copying.
- **Streaming & Thinking Blocks:** Supports real-time prompt streaming with support for expandable thinking/reasoning blocks used by advanced models.
- **Vanilla Tech Stack:** Pure HTML, CSS, and JS with locally vendored dependencies (DOMPurify, marked, Prism) and the NUI components module. No npm build pipelines.

## Storage

- **IndexedDB**: Image attachments (per-browser, survives refresh)
- **localStorage**: Chat history and messages

## Updating Vendor Libraries

When the WebAdmin vendor files are updated, run one of:

```bash
# Node.js (cross-platform)
node update-vendor.js

# Windows PowerShell
.\update-vendor.ps1

# Windows Command Prompt
update-vendor.bat

# Linux/macOS Bash
./update-vendor.sh
```

This copies the latest vendor files from `WebAdmin/public/shared` to `ChatStandalone/shared`.

## CORS

The LLM Gateway must allow CORS from your standalone chat origin. Add to Gateway's config or middleware:

```javascript
// Allow standalone chat origin
res.header('Access-Control-Allow-Origin', 'http://localhost:8080');
res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
res.header('Access-Control-Allow-Headers', 'Content-Type');
```
