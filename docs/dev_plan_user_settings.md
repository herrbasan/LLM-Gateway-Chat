# User-Based Settings — Development Plan

## 1. Motivation

Currently, user settings are scattered across `localStorage`, `IndexedDB`, hardcoded constants, and `config.js`. There is no concept of a user profile. Moving to server-side user settings enables:

- **Multi-user support**: Each user has their own preferences, MCP servers, presets
- **Roaming settings**: Same config across devices/browsers
- **Backend auth integration**: Settings live alongside the user's sessions
- **Cleaner defaults**: `config.js` becomes deployment config, not user config

---

## 2. Current State

### 2.1 Data Sources

| Source | Examples | Persistence |
|--------|----------|-------------|
| `chat/js/config.js` (`CHAT_CONFIG`) | `gatewayUrl`, `operationMode`, `defaultTemperature` | Code constant |
| `localStorage` (via `storage.getPref/setPref`) | `user-language`, `operation-mode`, `tts-endpoint`, `tts-voice-*`, `mcp-vision` | Browser-only |
| `IndexedDB` (via `storage.mcpGet/mcpSet`) | `mcp-servers`, `mcp-enabledTools` | Browser-only |
| Hardcoded in `chat.js` | User name, location (in `buildMetadataPrefix()`) | Code constant |
| `SERVER.DB` (`_type: 'user'` in nDB) | `{ apiKey, name }` — only auth, no settings | Server (nDB) |

### 2.2 Auth Flow

- All nDB-documents are scoped by `userId`
- Auth via `X-API-Key` header → lookup `_type: 'user'` by key
- Currently exactly one user: `user-migrated-default`

---

## 3. Target Architecture

### 3.1 Data Model — Server (nDB)

**User document** (`_type: 'user'`):
```javascript
{
  _type: 'user',
  id: 'user-xxx',                    // nDB-assigned
  name: 'Herrbasan',
  apiKey: 'migrated-...',            // unchanged
  settings: {
    // Profile
    displayName: 'Herrbasan',
    location: 'Germany',
    language: 'English',

    // Chat defaults
    operationMode: 'sse',             // 'sse' | 'websocket'
    defaultTemperature: 0.7,
    defaultMaxTokens: null,
    defaultModel: '',

    // System prompts
    systemPresets: [
      { id: 'preset-1', name: 'Friendly', content: '...' },
      { id: 'preset-2', name: 'Technical', content: '...' }
    ],

    // MCP
    mcpServers: [
      {
        id: 'srv-1',
        url: 'http://192.168.0.100:3100/sse',
        name: 'Orchestrator',
        enabledTools: ['vision_create_session', 'vision_analyze', 'memory_recall', ...]
      }
    ],
    visionEnabled: false,

    // TTS
    ttsEndpoint: 'http://localhost:2244',
    ttsVoice: '',
    ttsSpeed: 1.0
  }
}
```

### 3.2 API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/user/settings` | Fetch current user's settings |
| `PUT` | `/api/user/settings` | Replace current user's settings |
| `PATCH` | `/api/user/settings` | Partial update (merge) |

All require `X-API-Key` auth. Returns `401` if unauthenticated.

### 3.3 Frontend — Settings Manager

New module: `chat/js/user-settings.js`

```javascript
// Centralized settings manager
class UserSettings {
  constructor() { /* ... */ }
  
  // Load: try backend → fallback localStorage → fallback config.js defaults
  async load() { /* ... */ }
  
  // Save: always write to backend + localStorage (offline fallback)
  async save(partial) { /* ... */ }
  
  // Getters (return current value, never undefined)
  get language() { /* ... */ }
  get operationMode() { /* ... */ }
  get systemPresets() { /* ... */ }
  // ...
  
  // Sync to UI elements
  applyToUI() { /* populate all nui-input/nui-select */ }
  readFromUI() { /* read all nui-input/nui-select */ }
}
```

### 3.4 Initialization Flow

```
App init
  ↓
1. Load models from Gateway (no settings needed)
  ↓
2. Create/find API key (same as now)
  ↓
3. UserSettings.load()
   ├── Backend reachable? → GET /api/user/settings → merge with defaults
   └── Backend offline?   → localStorage prefs → merge with config.js defaults
  ↓
4. UserSettings.applyToUI()
   ├── Fill name/location/language inputs
   ├── Set operation mode selector
   ├── Load system prompt presets
   ├── Configure MCP servers + enabled tools
   └── Set TTS endpoint/voice
  ↓
5. GatewayClient created with resolved operationMode
6. MCP servers connected
7. Ready
```

---

## 4. Migration Path

### Phase 1 — Backend Settings CRUD (no multi-user yet)

1. Add `settings` field to the existing user document (nDB schema evolution)
2. Implement `GET/PUT/PATCH /api/user/settings` routes in `server/server.js`
3. Add `UserSettings` class to `chat/js/user-settings.js`
4. On init, call `UserSettings.load()` → populate UI
5. On settings change, call `UserSettings.save()` → backend + localStorage
6. Keep localStorage as fallback when backend offline

**Migration note**: The first time a user loads the app after this change, the nDB user document won't have a `settings` field. The server should return the full default settings object on `GET` if missing, and the frontend should send the complete object on first `PUT`.

### Phase 2 — Profile Enhancements

1. User registration flow (username + auto-generated API key)
2. Settings UI in the config pane
3. Import/export settings as JSON

### Phase 3 — Multi-User (Future)

1. Login screen
2. Session switching
3. Admin user management

---

## 5. Files to Create/Modify

### New Files

| File | Purpose |
|------|---------|
| `docs/dev_plan_user_settings.md` | This document |
| `chat/js/user-settings.js` | Centralized settings manager class |

### Modified Files

| File | Changes |
|------|---------|
| `server/server.js` | Add `GET/PUT/PATCH /api/user/settings` routes |
| `chat/js/chat.js` | Replace `storage.getPref/setPref` calls with `UserSettings`, update `buildMetadataPrefix()`, update init flow |
| `chat/js/config.js` | Strip user-facing defaults, keep only deployment config (`gatewayUrl`) |
| `chat/js/api-client.js` | Add `getSettings()`, `updateSettings()` methods |
| `chat/js/mcp-client.js` | Load server list from `UserSettings` instead of IndexedDB |
| `chat/js/storage.js` | Keep `getPref/setPref` as offline fallback only |
| `chat/js/image-store.js` | No changes expected |
| `chat-arena/js/arena.js` | No changes expected (arena has own GatewayClient config) |

---

## 6. Default Settings (when no user settings exist)

```javascript
const DEFAULTS = {
  displayName: '',
  location: '',
  language: 'English',
  operationMode: 'sse',
  defaultTemperature: 0.7,
  defaultMaxTokens: null,
  defaultModel: '',
  systemPresets: [
    { id: 'preset-friendly', name: 'Friendly Assistant', content: 'You are a friendly and helpful assistant.' },
    { id: 'preset-technical', name: 'Technical Expert', content: 'You are a technical expert. Provide detailed, precise answers.' },
    { id: 'preset-creative', name: 'Creative Writer', content: 'You are a creative writer. Be imaginative and descriptive.' }
  ],
  mcpServers: [],
  visionEnabled: false,
  ttsEndpoint: 'http://localhost:2244',
  ttsVoice: '',
  ttsSpeed: 1.0
};
```

---

## 7. Open Questions

1. **MCP server connections**: Should MCP servers reconnect automatically when settings are loaded? Yes — the init flow already handles this via `mcpClient.ready()`.

2. **Conflict resolution**: If settings change in two browser tabs simultaneously, last-write-wins via `PUT`. Is that acceptable? Yes, for a single-user app.

3. **Offline behavior**: When the backend is unreachable, should the app fall back to localStorage settings? Yes — the `UserSettings.load()` method should try backend first, fall back to localStorage, fall back to hardcoded defaults.
