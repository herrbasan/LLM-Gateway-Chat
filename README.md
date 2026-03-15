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

Edit `chat/js/config.js` and configure your Gateway URL:

```javascript
window.CHAT_CONFIG = {
    gatewayUrl: 'http://localhost:3400',  // Your LLM Gateway URL
    defaultModel: '',                      // Optional: Auto-select this model
    defaultTemperature: 0.7,               // Default temperature (0-2)
    defaultMaxTokens: 2048,                // Default max tokens
};
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

## Development Guidelines

### NUI Components

This project uses the **NUI Web Components** library (`nui_wc2`). When adding UI elements:

- **Use NUI components** whenever possible (`<nui-input>`, `<nui-select>`, `<nui-button>`, etc.)
- **Avoid custom HTML elements** like native `<input>` or `<select>` without the NUI wrapper
- **Don't add custom CSS** for basic styling - NUI handles it through the theme system
- **Use NUI theme variables** for colors (e.g., `--nui-shade2`, `--nui-accent`, `--nui-bg`)

Example - Correct:
```html
<nui-input id="temperature">
    <input type="number" min="0" max="2" step="0.1">
</nui-input>
```

Example - Avoid:
```html
<input type="number" id="temperature" class="custom-styled-input">
```

### NUI Theme Variables

Leverage NUI's CSS custom properties for consistent theming:

```css
/* Use NUI theme variables */
.my-element {
    background: var(--nui-bg);
    color: var(--nui-fg);
    border: 1px solid var(--nui-shade3);
}
```

Common theme variables:
- `--nui-bg` / `--nui-fg` - Background and foreground colors
- `--nui-shade2` through `--nui-shade7` - Shade variations
- `--nui-accent` - Primary accent color
- `--nui-color-primary` / `--nui-color-danger` - Semantic colors

The theme automatically supports light/dark modes based on system preferences.

## CORS

The LLM Gateway must allow CORS from your standalone chat origin. Add to Gateway's config or middleware:

```javascript
// Allow standalone chat origin
res.header('Access-Control-Allow-Origin', 'http://localhost:8080');
res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
res.header('Access-Control-Allow-Headers', 'Content-Type');
```
