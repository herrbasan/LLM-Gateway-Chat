# Plan: Client-Side Service URL Configuration

**Date:** 2026-07-11
**Status:** Planning
**Replaces:** `refactor-backend-routed-communication.md` (archived — backend proxy concept may be revisited later)

---

## 1. Problem

The browser client receives hardcoded LAN URLs for upstream services (gateway, TTS, MCP) from the server-generated `config.js`. When the app is accessed from outside the LAN (public internet, different network, mobile), these URLs are unreachable and the app fails to initialize.

The gateway URL has no UI input at all — it is entirely server-configured. TTS and MCP have UI inputs but store their URLs in the per-user database profile, which is wrong: service URLs are location-dependent (what works from a desktop doesn't work from a phone), not user-identity-dependent.

---

## 2. Approach

Service URLs are stored in localStorage only. No server-default fallback chain — if there's no localStorage value, the field is empty and the user must enter one. The server still generates `config.js` with the `.env` values as placeholder text (shown in the input fields), but they are not used as runtime defaults.

No user-profile (nDB) storage for service URLs. The user profile keeps everything else (temperature, presets, name, language, operation mode, etc.).

The browser talks directly to each service. No backend proxy. Each service must be reachable from the browser's network and have CORS configured if cross-origin.

---

## 3. Services in Scope

| Service | Current URL Source | Current Storage | Has UI Input? |
|---------|-------------------|-----------------|---------------|
| **Gateway** | `CONFIG.gatewayUrl` (from `LLM_GATEWAY_URL` env) | None (server-only) | **No — must add** |
| **TTS** | `CONFIG.ttsEndpoint` (from `TTS_ENDPOINT` env) | User profile (`storage.getPref('tts-endpoint')`) | Yes (TTS tab) |
| **MCP** | User-entered per server | User profile (`storage.mcpGet('servers')`) | Yes (MCP tab) |

---

## 4. Changes by Area

### 4.1 Gateway URL — New UI + Client-Side Storage

**HTML (`chat/index.html`)**

Add a gateway URL section at the top of the Model config tab, above the model select:

```html
<nui-input-group class="sidebar-section">
    <div class="gateway-config-header">
        <label>Gateway</label>
        <span class="gateway-config-status" id="gateway-config-status">
            <span class="status-dot"></span>
            <span class="gateway-config-status-text">Checking...</span>
        </span>
    </div>
    <nui-input id="gateway-url">
        <input type="url" placeholder="http://localhost:3400" id="gateway-url-input">
    </nui-input>
    <nui-button id="gateway-connect-btn">
        <button type="button">Connect</button>
    </nui-button>
</nui-input-group>
```

The status indicator (dot + text) lives here, next to the "Gateway" label. It reflects the same health-check state as the old header indicator.

**JS (`chat/js/chat.js`)**

- On startup: read the gateway URL from `localStorage.getItem('gateway-url')`. This replaces the current hardcoded `GATEWAY_URL` constant.

```javascript
const GATEWAY_URL = localStorage.getItem('gateway-url') || '';
```

If empty, the app shows the gateway config section with a placeholder (sourced from `CONFIG.gatewayUrl` for display only) and waits for the user to enter a URL and click Connect.

- The `GatewayClient` is created once at startup with the resolved URL (`chat.js:657`). On "Connect", **mutate the existing client in place** — no recreation, no state migration:

```javascript
client.restUrl = newUrl;
client.wsUrl = newUrl.replace(/^http/, 'ws') + '/v1/realtime';
```

  If a WebSocket is open, close it first (`client.socket?.close()`). The next request uses the new URL.

- "Connect" button handler:
  1. Read the input value
  2. Save to `localStorage.setItem('gateway-url', value)`
  3. Mutate `client.restUrl` and `client.wsUrl` in place
  4. If WebSocket open, close it
  5. Call `loadModels()` — updates model select (success or "Failed to load models")
  6. Call `checkGatewayStatus()` — updates the status dot in the config tab

- `checkGatewayStatus()` updates `#gateway-config-status` (config tab). The header indicator (`#gateway-status`) is removed from the DOM — one indicator, one update path.

### 4.2 TTS Endpoint — Move to localStorage

**JS (`chat/js/chat.js`)**

Currently:
```javascript
// applyDefaultConfig() — chat.js:1238
const savedTtsEndpoint = await storage.getPref('tts-endpoint');
ttsEndpoint = savedTtsEndpoint !== null ? savedTtsEndpoint : TTS_ENDPOINT;
```

Change to:
```javascript
ttsEndpoint = localStorage.getItem('tts-endpoint') || '';
```

Currently (on change):
```javascript
// chat.js:1721
storage.setPref('tts-endpoint', ttsEndpoint).catch(() => {});
```

Change to:
```javascript
localStorage.setItem('tts-endpoint', ttsEndpoint);
```

The TTS tab input, `loadTtsVoices()`, and `toggleTts()` all read the `ttsEndpoint` variable — no changes needed there, just the storage mechanism.

**Server (`server/server.js`)**

Remove `ttsEndpoint` from the user settings defaults (`server.js:1193`). The server still generates `CONFIG.ttsEndpoint` in `config.js` from `TTS_ENDPOINT` env — used as placeholder text in the input only, not as a runtime default.

### 4.3 MCP Servers — Move to localStorage

**JS (`chat/js/mcp-client.js`)**

Currently:
```javascript
// mcp-client.js:28
const storedServers = await storage.mcpGet('servers');
// mcp-client.js:34
const storedEnabledTools = await storage.mcpGet('enabledTools');
```

Change to direct `localStorage`:
```javascript
const storedServers = localStorage.getItem('mcp-servers');
const storedEnabledTools = localStorage.getItem('mcp-enabledTools');
```

Same for `saveConfig()`:
```javascript
// mcp-client.js:53
localStorage.setItem('mcp-servers', JSON.stringify(serversToStore));
localStorage.setItem('mcp-enabledTools', JSON.stringify(serializedTools));
```

Remove the `import { storage } from './storage.js'` from `mcp-client.js` — it's no longer needed.

**Note:** MCP servers are inherently machine-local (they point to services on the browser's network). localStorage is more correct than user profile here.

### 4.4 Header — Remove Status, Hide Title on Mobile

**HTML (`chat/index.html`)**

Remove the `#gateway-status` div from the header center slot entirely. The status indicator now lives only in the config tab.

**CSS (`chat/css/chat.css`)**

Hide the app title on mobile (status indicator is already gone from header):

```css
@media (max-width: 37.5rem) {
    .app-title { display: none; }
    /* existing rules... */
}
```

### 4.5 Arena — Same Treatment as Chat

The arena needs the same gateway URL and TTS endpoint configurability as chat. MCP is not used in the arena today but may be added in the future — out of scope for now.

**Arena config static file (`chat-arena/js/config.js`)**

Keep as a static file — no server changes needed. Just blank out the two URL fields so localStorage and the JS fallback handle resolution:

```javascript
window.ARENA_CONFIG = {
    gatewayUrl: '',   // empty — resolved from localStorage at runtime
    ttsEndpoint: '',  // empty — resolved from localStorage at runtime
    // ... all other existing defaults unchanged
};
```

**Arena JS (`chat-arena/js/arena.js`)**

Add localStorage override at construction sites:
```javascript
const gatewayUrl = localStorage.getItem('gateway-url') || '';
const ttsEndpoint = localStorage.getItem('tts-endpoint') || '';
```

The arena creates multiple `GatewayClient` instances (`arena.js:40,740,1059`) — all should use the resolved URL.

**Arena UI (`chat-arena/index.html`)**

Add gateway URL input + status + Connect button to the arena's config panel, mirroring the chat UI. The arena already has a TTS endpoint input (`arena.js:1232`) — it needs the same localStorage migration as chat.

---

## 5. Files to Modify

### Frontend

| File | Changes |
|------|---------|
| `chat/index.html` | Add gateway URL input + status + Connect button in Model tab, remove header gateway-status div |
| `chat/js/chat.js` | Gateway URL from localStorage, mutate client URL on Connect, TTS endpoint → localStorage, status indicator in config tab |
| `chat/js/mcp-client.js` | MCP server/tool storage → localStorage, remove storage.js import |
| `chat/css/chat.css` | Hide app-title on mobile |

### Backend

| File | Changes |
|------|---------|
| `server/server.js` | Remove ttsEndpoint from user settings defaults |

### Arena

| File | Changes |
|------|---------|
| `chat-arena/index.html` | Add gateway URL input + status + Connect button |
| `chat-arena/js/arena.js` | localStorage override for gateway + TTS URLs, Connect button handler, TTS storage → localStorage |
| `chat-arena/js/config.js` | Blank out gatewayUrl + ttsEndpoint fields (keep as static file) |

### Documentation

| File | Changes |
|------|---------|
| `docs/plan-client-side-service-urls.md` | This file — update as work progresses |

---

## 6. Implementation Phases

### Phase 1: Gateway URL client-side config

The highest-impact change — this is the only service with no UI input and the one that breaks the app when wrong.

1. Add gateway URL input + status + Connect button to Model tab in `chat/index.html`.
2. Remove `#gateway-status` div from header.
3. Change `GATEWAY_URL` constant to read from localStorage only: `localStorage.getItem('gateway-url') || ''`.
4. Wire Connect button: save to localStorage, mutate `client.restUrl`/`client.wsUrl` in place, close WS if open, reload models + status.
5. Update `checkGatewayStatus()` to target `#gateway-config-status` (config tab only).
6. Add CSS media query to hide app-title on mobile.
7. Test: change gateway URL via UI, verify models reload and status updates.

### Phase 2: TTS endpoint → localStorage

1. Change `applyDefaultConfig()` TTS endpoint read from `storage.getPref` to `localStorage.getItem`.
2. Change TTS endpoint change handler from `storage.setPref` to `localStorage.setItem`.
3. Remove `ttsEndpoint` from server user settings defaults.
4. Test: set TTS endpoint, reload page, verify it persists.

### Phase 3: MCP servers → localStorage

1. Change `mcp-client.js` `ready()` and `saveConfig()` to use localStorage directly.
2. Remove `storage.js` import from `mcp-client.js`.
3. Test: add MCP server, reload page, verify it persists and reconnects.

### Phase 4: Arena

Mirror the chat changes in the arena — gateway URL and TTS endpoint both need UI inputs + localStorage storage.

1. Blank out `gatewayUrl` and `ttsEndpoint` in static `chat-arena/js/config.js` (keep all other defaults).
2. Add gateway URL input + status + Connect button to arena config UI in `chat-arena/index.html`.
3. Add localStorage override + Connect handler in `chat-arena/js/arena.js`.
4. Migrate arena TTS endpoint storage to localStorage.
5. Test: arena loads models and streams from the configured gateway URL; TTS works from configured endpoint.

---

## 7. Migration Considerations

- **Existing user profiles** will still have `ttsEndpoint` and `mcp-servers` keys in their nDB settings document. These become dead data — harmless but unused. No migration script needed; they'll be ignored.
- **First load after deploy:** All users must enter their service URLs once (gateway, TTS, MCP). The `.env` values appear as placeholder text in the input fields as a hint.

---

## 8. Risks

1. **CORS on upstream services.** Each service (gateway, TTS, MCP) must allow the chat backend's origin when accessed cross-origin. The gateway is already exposed. TTS and MCP may need CORS headers added if they don't have them.
2. **Mixed content.** If the chat backend is served over HTTPS but an upstream service is HTTP, the browser will block the request. Users must configure HTTPS on upstream services or access the chat backend via HTTP.
3. **WebSocket open during URL change.** If a WebSocket connection is open when the user clicks Connect, close it first (`client.socket?.close()`). The next request uses the new URL. No state migration needed since we mutate `restUrl`/`wsUrl` in place rather than recreating the client.

---

## 9. Testing Checklist

- [ ] App loads with no localStorage — gateway field is empty, user enters URL and clicks Connect
- [ ] Enter a custom gateway URL, click Connect — models reload
- [ ] Enter a wrong gateway URL, click Connect — status shows red, model select shows error
- [ ] Reload page — gateway URL persists from localStorage
- [ ] TTS endpoint persists across reloads via localStorage
- [ ] MCP servers persist across reloads via localStorage
- [ ] Mobile view: header title hidden, config tab shows gateway status
- [ ] Arena loads with correct gateway URL from localStorage override
- [ ] Existing user profile settings (temperature, presets, name) still work unchanged
