# ChatStandalone

Standalone LLM Gateway Chat client. A pure frontend application that connects to any LLM Gateway instance.

## Quick Start

### Option 1: Python
```bash
cd ChatStandalone
python -m http.server 8080
```

### Option 2: Node.js (npx)
```bash
cd ChatStandalone
npx serve -l 8080
```

### Option 3: VS Code Live Server
Install the "Live Server" extension and right-click on `chat/index.html` → "Open with Live Server"

## Configuration

Edit `chat/index.html` and change the Gateway URL:

```html
<script>
    window.CHAT_CONFIG = {
        gatewayUrl: 'http://localhost:3400',  // Your LLM Gateway URL
    };
</script>
```

## Features

- Connects to any LLM Gateway instance
- Multiple chat sessions with history
- Image attachments (vision)
- Markdown rendering with code highlighting
- Thinking/Reasoning blocks
- Streaming responses
- Light/Dark theme
- Responsive design

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
