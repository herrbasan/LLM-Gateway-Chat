# Multi-User Architecture — Development Plan

## 1. Motivation

Currently, the app authenticates via a hardcoded API key in config.js. There is no login screen, no session management, and no concept of separate users. Moving to proper session-based auth enables:

- **Multi-user support**: Multiple people can use the same server with isolated data
- **Login UI**: Username + password authentication
- **Session persistence**: Token-based sessions that survive server restarts (stored in nDB)
- **User settings**: Each user's preferences stored in the chat database (as they already are)
- **Self-contained**: No external auth dependencies — built on Node.js crypto only
- **Superadmin bootstrap**: `SUPERADMIN_USERNAME` / `SUPERADMIN_PASSWORD` env vars guarantee a login escape hatch
- **No API keys**: Cookie-only auth. No legacy `X-API-Key` path. Simplifies the frontend and removes secrets from config files.

---

## 2. Architecture Overview

### Database per User

```text
server/data/users_db/data.jsonl  ← Global Auth + Routing
    └── _type: 'user'
        { id, username, displayName, passwordHash, rights, userToken, dbPath, lastAccess }

[dbPath] /data.jsonl             ← User's private chat data
    ├── _type: 'session'
    ├── _type: 'conversation'
    └── _type: 'user_settings'         ← preferences (created on first login)
```

**The User Database** (users_db) concerns itself only with authentication, rights, and mapping a user to their dedicated database folder (`dbPath`).

**The User's Private Database** (located at `dbPath`) holds everything else — chat sessions, messages, embeddings, and user settings (display name, preferences, etc.). Each user gets a completely physically isolated database, meaning there is no risk of cross-user data leakage.

### The userToken

When authentication succeeds, the server generates a userToken (a random string), stores it in the user's document in users_db, and returns it to the browser. The browser keeps it as a cookie.

On every API request, the server reads the cookie, looks up the user by userToken in users_db, mounts or retrieves their dedicated `nDB` instance from the `dbPath`, and processes the request against that specific database.

The userToken **is the session**. Because it lives in nDB (which persists to disk), sessions survive server restarts — no need to re-login after a restart.

```text
Login success
  ↓
Server: userToken = crypto.randomUUID()
         userDoc.userToken = userToken
         userDoc.lastAccess = Date.now()
  ↓
Browser: Cookie: userToken=abc123
  ↓
Every API call:
         req → parse cookie → lookup users_db by userToken → userDoc
         → resolve userDoc.dbPath → get/mount nDB instance
         → execute operation securely against specific user db
         → update lastAccess
```

### Auth Flow Diagram

```
┌──────────────────────────────────────────────────────────────┐
│                        Auth Flow                              │
│                                                              │
│  Browser                          Server                     │
│    │                                │                        │
│    │── POST /api/auth/login ───────►│                        │
│    │   { username, password }       │                        │
│    │                                │── lookup users_db by   │
│    │                                │   username             │
│    │                                │── crypto.scryptSync    │
│    │                                │   compare password     │
│    │                                │── generate userToken   │
│    │                                │── store in user doc    │
│    │◄── { userToken, user } ───────│   + Set-Cookie          │
│    │   + rights                    │                        │
│    │                                │                        │
│    │── GET /api/chats ────────────►│                        │
│    │   Cookie: userToken=abc123    │                        │
│    │                                │── lookup users_db by   │
│    │                                │   userToken            │
│    │                                │── refresh lastAccess   │
│    │                                │── route to handler     │
│    │◄── { data: [...] } ──────────│   scoped to userId      │
│    │                                │                        │
│    │── POST /api/auth/logout ─────►│                        │
│    │   Cookie: userToken=abc123    │                        │
│    │                                │── clear userToken      │
│    │◄── { ok: true } ─────────────│   from user doc         │
└──────────────────────────────────────────────────────────────┘
```

### Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| **Separate users_db nDB** | Auth concerns isolated from chat data. Clean separation of concerns. |
| **userToken in user doc** | Survives server restarts (nDB persists to disk). No in-memory state to rebuild. |
| **No in-memory session cache** | nDB is already in-memory + persisted. Every auth check is a quick .find(). |
| **Passwords in config.json** | No registration UI needed. Users are defined by the server operator. |
| **Password hashing via crypto.scryptSync** | Built into Node.js (zero npm deps). Proper KDF. |
| **TTL via lastAccess field** | Checked on every API call. Expired token = 401. Cleanup interval purges stale tokens. |
| **Cookie-only auth** | No X-API-Key header. All browser requests use HttpOnly cookies. Scripts use the login endpoint too. |
| **SUPERADMIN env vars as bootstrap** | `SUPERADMIN_USERNAME` + `SUPERADMIN_PASSWORD` always seeded. Guaranteed admin account regardless of config. |
| **No users → fail to start** | If neither env vars nor config.json define any users, the server exits with an error. Fail fast. |
| **User DB has no settings** | The `_type: 'user'` in `users_db` only has auth fields. Settings live in `chat_app`. |
| **Admin user has extra UI** | Admin badge + user management dialog visible only to users with `admin` right. |
| **Rights in user doc** | Each user has a `rights` object. `{ admin, read, write }` — admin unlocks management UI. |

---

## 3. Current State

### 3.1 Data Sources

| Source | Examples | Persistence |
|--------|----------|-------------|
| server/config.json | gatewayUrl, port, users[] | Config file |
| nDB chat_app | { _type: 'user' } with { id, apiKey, displayName } (legacy) | Server (nDB) |
| nDB chat_app | { _type: 'session' }, { _type: 'conversation' } | Server (nDB) |
| chat/js/config.js | backendUrl | Deployment config |
| Environment variables | SUPERADMIN_USERNAME, SUPERADMIN_PASSWORD | Process env |

### 3.2 Current Auth Flow

- Auth via X-API-Key header → lookup _type: 'user' by key in chat_app
- One user: user-migrated-default with apiKey: migrated-...
- No login screen, no session concept
- **Post-migration:** The X-API-Key path is removed entirely. All auth is cookie-based.

---

## 4. Target Data Model

### 4.1 User Database (users_db — auth only)

**User document** (_type: 'user'):
```javascript
{
    _type: 'user',
    id: 'user-migrated-default',
    username: 'herrbasan',
    displayName: 'Herrbasan',
    dbPath: 'server/data/chat_app',                    // path to user's isolated nDB
    passwordHash: 'crypto.scryptSync output (hex)',   // never stored in config
    rights: { login: true, read: true, write: true, admin: true },
    userToken: 'sess_a1b2c3d4...',                     // null when logged out
    lastAccess: '2026-05-16T12:00:00.000Z',            // ISO string, refreshed on API call
    createdAt: '2026-05-16T00:00:00.000Z'
}
```

**No settings in this database.** Only what's needed for auth, rights validation, and database mapping.

### 4.2 User Sources

Users come from two sources. Both are checked on every server start, and they're merged together. If both sources are empty, the server **fails to start** — no users means nobody can log in.

#### Source 1: Environment Variables (Superadmin)

```
SUPERADMIN_USERNAME=admin
SUPERADMIN_PASSWORD=<strong-password>
SUPERADMIN_DBPATH=server/data/admin_data
```

If set, a superadmin user with `rights.admin: true` is always seeded. This is the guaranteed "you can always get in" account. The password never lives in a config file that could be committed to git.

#### Source 2: config.json (Regular Users)

This is for creating additional non-admin users (or additional admins) that are defined alongside the server configuration.

```json
{
    "users": [
        {
            "id": "user-migrated-default",
            "username": "herrbasan",
            "password": "chat2026",
            "displayName": "Herrbasan",
            "dbPath": "server/data/chat_app",
            "rights": { "login": true, "read": true, "write": true, "admin": true }
        },
        {
            "id": "user-clean",
            "username": "fresh",
            "password": "chat2026",
            "displayName": "Fresh User",
            "dbPath": "server/data/fresh_user_db",
            "rights": { "login": true, "read": true, "write": true }
        }
    ]
}
```

### 4.3 Chat Database (User's Private DB at dbPath — settings)

**User settings document** (`_type: 'user_settings'`):
```javascript
{
    _type: 'user_settings',
    id: 'user-migrated-default',
    displayName: 'Herrbasan',
    settings: {
        location: 'Germany',
        language: 'English',
        operationMode: 'sse',
        defaultTemperature: 0.7,
        defaultModel: '',
        defaultMaxTokens: null,
        systemPresets: [],
        mcpServers: [],
        visionEnabled: false,
        ttsEndpoint: 'http://localhost:2244',
        ttsVoice: '',
        ttsSpeed: 1.0
    }
}
```

The `_type: 'user_settings'` doc is **created on first login** (not seeded from config). It inherits `id` and `displayName` from the `users_db` auth doc and sets default settings. No `apiKey` field — cookie-only auth, no backward compat needed.

### 4.4 API Endpoints

| Method | Path | Auth | DB | Purpose |
|--------|------|------|-----|---------|
| POST | /api/auth/login | None | users_db | Verify credentials, generate userToken, return Set-Cookie |
| POST | /api/auth/logout | Token | users_db | Clear userToken from user doc |
| GET | /api/auth/session | None | users_db | Check if cookie has a valid token → return user info |
| GET | /api/user/settings | Token | dbPath | Fetch user settings doc from user's isolated db |
| PUT | /api/user/settings | Token | dbPath | Save user settings to user's isolated db |
| * | /api/* | Token | dbPath | All data endpoints run against the user's isolated db instance |
| GET | /api/admin/users | Admin | users_db | List all users (id, username, displayName, dbPath, rights) |
| POST | /api/admin/users | Admin | users_db | Create new user (username, password, displayName, dbPath, rights) |
| DELETE | /api/admin/users/:id | Admin | users_db | Remove user and revoke access |
| POST | /api/admin/users/:id/reset-password | Admin | users_db | Reset password for a user |

---

## 5. Auth Middleware

### 5.1 `requireAuth()` — checks auth + enforces rights

```javascript
function requireAuth(req, res) {
    const user = getAuthUser(req);
    if (!user || user.rights?.login === false) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return null;
    }
    return user;
}
```

### 5.2 `getAuthUser()` — resolves user from request

```javascript
function getAuthUser(req) {
    // Cookie-only auth. No X-API-Key fallback.
    const token = parseCookies(req).userToken;
    if (token) {
        const user = usersDb.find('userToken', token).find(d => d._type === 'user');
        if (user) {
            // Check TTL
            const ttl = (cfg.sessionTtlMinutes || 1440) * 60 * 1000;
            if (Date.now() - new Date(user.lastAccess).getTime() > ttl) {
                user.userToken = null;       // expire the token
                usersDb.update(user._id, user);
                return null;
            }
            // Refresh lastAccess only if more than half the TTL has elapsed
            // to reduce write amplification
            if (Date.now() - new Date(user.lastAccess).getTime() > ttl / 2) {
                user.lastAccess = new Date().toISOString();
                usersDb.update(user._id, user);
            }
            return user;
        }
    }

    return null;
}
```

### Why this works without caching

nDB loads the entire dataset into memory on `open()`. `usersDb.find()` is a synchronous in-memory scan of a tiny dataset (<100 users). There is no disk I/O, no latency. An in-memory cache on top would add complexity for zero benefit.

### Cookie + CORS Scope

Since the frontend is served from the same Node server (`localhost:3500` serves both static files and API), all requests are same-origin. No CORS headers are needed for cookie auth in production. The existing `Access-Control-Allow-Origin: *` in the `json()` helper does not interfere — browsers ignore CORS for same-origin requests.

If the frontend is ever served from a different origin (e.g. dev on port 3000), the server must echo back the specific origin and set `Access-Control-Allow-Credentials: true` — `*` is not allowed with credentialed requests.

### Arena Mode

`chat-arena/js/arena.js` imports `backendClient` from `../../chat/js/api-client.js`. Since `api-client.js` is updated to use cookies, Arena mode inherits cookie auth **automatically** — no additional auth code needed.

---

## 6. Login Flow

### 6.1 Server

```
POST /api/auth/login { username, password }
  → Find user in users_db by username
  → crypto.scryptSync(password, salt) → compare to stored passwordHash
  → Match → generate random userToken → store in user doc
           → Set-Cookie: userToken=...; path=/; max-age=86400; HttpOnly; SameSite=Lax
           → return { userToken, userId, displayName, rights }
  → No match → return 401 (after a 2-second delay if multiple failed attempts)
```

**Important:** The cookie is `HttpOnly` — JavaScript cannot read it. This prevents XSS token theft. On logout, the server returns `Set-Cookie: userToken=; max-age=0; HttpOnly; SameSite=Lax` to clear the browser copy.

### 6.2 Frontend

```
App init
  ↓
1. Check cookie → GET /api/auth/session
   ├── 200 → { userId, displayName, rights } → proceed to chat
   └── 401 → show login screen
  ↓
2. Login dialog (NUI custom dialog)
   ├── Username field (nui-input)
   ├── Password field (nui-input, type=password)
   ├── Error message (hidden, shown on wrong credentials)
   └── Sign In button
  ↓
3. `POST /api/auth/login { username, password }` (with `credentials: 'include'`)
   ├── 200 → cookie set automatically by Set-Cookie (HttpOnly, not accessible via JS), close dialog, init chat
   └── 401 → show error, user retries
  ↓
4. All subsequent API calls send `credentials: 'include'` so the browser attaches the cookie
   → `api-client.js` `_request()` must use `fetch(url, { ..., credentials: 'include' })`
   → `executeLocalTool()` in `chat.js` must also use `credentials: 'include'`
  ↓
5. Logout button in header (logout icon)
   → `nui.components.dialog.confirm('Logout', 'Are you sure?')`
   → `POST /api/auth/logout` (with `credentials: 'include'`)
   → Server clears `userToken` in users_db + returns clearing Set-Cookie header
   → Reload page → back to login
```

### 6.3 Admin UI

When the logged-in user has `rights.admin === true`, an extra icon appears in the header (crown or shield). Clicking it opens an `nui-dialog` in **page mode** (`nui.components.dialog.page()`) with a user management panel:

```
┌─────────────────────────────────────────────┐
│  ┌───────────── User Management ──────────┐ │
│  │                                         │ │
│  │  Username   Display Name   Rights   Del │ │
│  │  ─────────────────────────────────────  │ │
│  │  herrbasan  Herrbasan      admin ✓  [ ] │ │
│  │  fresh      Fresh User     read    [✕] │ │
│  │                                         │ │
│  │  [ + Add User ]  [ Reset Password ]    │ │
│  │                                         │ │
│  │  ── Add User ─────────────────────      │ │
│  │  Username: [________]                   │ │
│  │  Password: [________]                   │ │
│  │  Rights:   [admin] [read] [write]       │ │
│  │  [ Create ]                              │ │
│  └─────────────────────────────────────────┘ │
└─────────────────────────────────────────────┘
```

**Operations:**

| Action | Backend call | Description |
|--------|-------------|-------------|
| List users | `GET /api/admin/users` | Returns all user profiles (no password hashes) |
| Add user | `POST /api/admin/users` | Creates new user in `users_db` + settings doc in `chat_app` |
| Delete user | `DELETE /api/admin/users/:id` | Removes from `users_db`. Chat data orphaned (quarantined). |
| Reset password | `POST /api/admin/users/:id/reset-password` | Updates `passwordHash` in `users_db`, clears `userToken` (forces re-login) |

All admin endpoints require the requesting user to have `rights.admin === true`. Non-admin users receive `403 Forbidden`.

The dialog uses `nui.components.dialog.page()` for the main panel, with a sub-dialog (`nui.components.dialog.prompt` or a nested `nui-dialog`) for the Add User form.

---

## 7. User Seeding (server startup)

On every server start:

1. Open users_db nDB (path: server/data/users_db/data.jsonl)
2. Check for users from two sources:
   - **Env vars**: `SUPERADMIN_USERNAME` + `SUPERADMIN_PASSWORD` — always seeded as admin
   - **config.json**: `cfg.users[]` — additional users with configurable rights
3. **Fail if both sources are empty** — no users means nobody can log in
4. For each user definition:
   - Look up by id in users_db
   - **Not found** → hash password with crypto.scryptSync, insert user doc
   - **Found, password changed** → re-hash (via salt extraction, not random salt), update doc, clear session
   - **Found, password same** → skip
5. Compact users_db

```javascript
// Collect users from both sources
const usersToSeed = [];

// Source 1: SUPERADMIN env vars
const superAdminUser = process.env.SUPERADMIN_USERNAME;
const superAdminPass = process.env.SUPERADMIN_PASSWORD;
const superAdminDbPath = process.env.SUPERADMIN_DBPATH || 'server/data/admin_data';
if (superAdminUser && superAdminPass) {
    usersToSeed.push({
        id: 'user-superadmin',
        username: superAdminUser,
        password: superAdminPass,
        displayName: 'Superadmin',
        dbPath: superAdminDbPath,
        rights: { login: true, read: true, write: true, admin: true }
    });
}

// Source 2: config.json
for (const u of (cfg.users || [])) {
    if (!u.dbPath) {
        logger.error('User missing dbPath, skipping', { username: u.username }, 'Auth');
        continue;
    }
    usersToSeed.push(u);
}

// Fail fast if no users configured
if (usersToSeed.length === 0) {
    logger.error('No valid users configured', {}, 'Auth');
    console.error('FATAL: No valid users configured. Set SUPERADMIN_USERNAME/SUPERADMIN_PASSWORD env vars or add users (with dbPath) to config.json.');
    process.exit(1);
}

for (const userDef of usersToSeed) {
    const existing = usersDb.find('id', userDef.id).filter(d => d._type === 'user');

    if (existing.length === 0) {
        // New user — hash password, insert
        const salt = crypto.randomBytes(16).toString('hex');
        const hash = crypto.scryptSync(userDef.password, salt, 64).toString('hex');
        usersDb.insert({
            _type: 'user',
            id: userDef.id,
            username: userDef.username,
            displayName: userDef.displayName || userDef.username,
            dbPath: userDef.dbPath,
            passwordHash: salt + ':' + hash,
            rights: userDef.rights || { login: true },
            userToken: null,
            lastAccess: null,
            createdAt: new Date().toISOString()
        });
        logger.info('User created', { id: userDef.id, username: userDef.username }, 'Auth');
    } else {
        // Existing user — check if password or rights changed
        const doc = existing[0];
        let changed = false;

        // Compare password: extract salt from stored hash, re-hash config password with same salt
        const storedParts = doc.passwordHash.split(':');
        const storedSalt = storedParts[0];
        const storedHash = storedParts.slice(1).join(':');
        const configHash = crypto.scryptSync(userDef.password, storedSalt, 64).toString('hex');
        if (storedHash !== configHash) {
            // Password changed — generate new salt and re-hash
            const newSalt = crypto.randomBytes(16).toString('hex');
            doc.passwordHash = newSalt + ':' + crypto.scryptSync(userDef.password, newSalt, 64).toString('hex');
            changed = true;
        }
        // Sync displayName
        if (userDef.displayName && doc.displayName !== userDef.displayName) {
            doc.displayName = userDef.displayName;
            changed = true;
        }
        // Sync dbPath
        if (userDef.dbPath && doc.dbPath !== userDef.dbPath) {
            doc.dbPath = userDef.dbPath;
            changed = true;
        }
        // Sync rights
        if (userDef.rights) {
            doc.rights = userDef.rights;
            changed = true;
        }

        if (changed) {
            doc.userToken = null; // force re-login on password/rights change
            usersDb.update(doc._id, doc);
            logger.info('User updated', { id: userDef.id, username: userDef.username }, 'Auth');
        }
    }
}

// Compact users_db after seeding
usersDb.compact();
```

**Note:** `displayName` and `dbPath` are stored in `users_db` during seeding (see above) so the login endpoint can return it and the server can mount the specific database without reading `config.json` every time. The DB at `dbPath` `_type: 'user_settings'` doc inherits `displayName` on first login.

---

## 8. Session TTL & Cleanup

### 8.1 Config

```json
{
    "sessionTtlMinutes": 1440
}
```

Default: 1440 minutes (24 hours). Set to `0` for no expiry.

### 8.2 TTL Enforcement

TTL is checked **on every API call** in getAuthUser(). No separate cleanup interval is strictly necessary — expired tokens are rejected at the middleware. However, a periodic cleanup removes stale tokens from the database:

```javascript
const SESSION_TTL = (cfg.sessionTtlMinutes || 1440) * 60 * 1000;

if (SESSION_TTL > 0) {
    setInterval(() => {
        const now = Date.now();
        const expired = usersDb.find('_type', 'user').filter(u =>
            u.userToken && (now - new Date(u.lastAccess).getTime() > SESSION_TTL)
        );
        for (const user of expired) {
            user.userToken = null;
            usersDb.update(user._id, user);
            logger.info('Session expired', { userId: user.id }, 'Auth');
        }
    }, 60000); // check every minute
}
```

No cleanup needed if `sessionTtlMinutes` is 0 or omitted.

### 8.3 `users_db` Compaction

The existing 5-minute compaction interval for `chat_app` must be duplicated for `users_db`. While `users_db` is tiny (<100 docs), the `lastAccess` writes on every API call cause append growth:

```javascript
setInterval(() => {
    if (usersDb) {
        try {
            usersDb.compact();
            logger.info('users_db compacted', {}, 'Auth');
        } catch (err) {
            logger.error('users_db compact failed', err, {}, 'Auth');
        }
    }
}, 5 * 60 * 1000);
```

The write amplification is mitigated by the half-TTL refresh optimization in `getAuthUser()` (section 5.2), which only updates `lastAccess` when more than half the TTL has elapsed since the last write.

---

## 9. Files to Create/Modify

### Modified Files

| File | Changes |
|------|---------|
| docs/dev_plan_user_settings.md | This document |
| server/config.json | Add users[] array with username/password/rights/dbPath, sessionTtlMinutes |
| server/server.js | Open users_db, add crypto, user seeding, login/logout/session endpoints. Implement dynamic mounting of `dbPath` `nDB` databases on demand when user logs in/makes request. Update `requireAuth`. |
| chat/js/api-client.js | Add `login()`, `logout()`, `checkSession()` methods. **All `fetch()` calls must use `credentials: 'include'`** so the browser sends the `userToken` cookie. Remove localStorage key storage. Add cookie helpers. |
| chat/js/user-settings.js | New module (Phase 3). Centralized settings manager that reads/writes `GET/PUT/PATCH /api/user/settings`. See dev plan section 4.3 for the target schema. |
| chat/js/chat.js | Add auth guard at start of `init()`, login dialog, logout button handler. Update `executeLocalTool()` fetch calls to use `credentials: 'include'`. |
| chat/index.html | Add logout button in header |
| chat/index.html | Add logout button in header |

---

## 10. Implementation Notes

### 10.1 NUI Documentation Required Reading

All frontend work (login dialog, admin UI, settings panels) uses NUI Web Components. Before writing any UI code, the NUI orientation guide at `lib/nui_wc2/documentation/DOCUMENTATION.md` must be read in full. It covers:

- The **Light DOM wrapper pattern** — `<nui-button>` wraps `<button>`, `<nui-input>` wraps `<input>`, never omit the inner native element
- **`data-action` declarative event delegation** — for buttons, dialogs, and sidebar toggles
- **CSS custom property theming** — `--color-base`, `--text-color`, `--nui-space`, etc.
- **Programmatic APIs** — `nui.components.dialog.*`, `nui.components.banner.show()`

Individual component LLM guides are in `lib/nui_wc2/Playground/pages/components/` and provide philosophy, anti-patterns, and decision logic for each component.

---

## 11. Migration Path

### Phase 1 — Auth Foundation (this session)

1. Add users to server/config.json with username + password + rights + dbPath
2. Open users_db nDB in server.js
3. Implement user seeding from config to users_db
4. Implement dynamic nDB mounting based on `dbPath` for user requests
5. Implement POST /api/auth/login + POST /api/auth/logout + GET /api/auth/session
6. Update `requireAuth` to check `userToken` cookie and ensure the correct DB is mounted
7. Frontend: login dialog, logout button, cookie-based session check
8. Test: login as herrbasan (migrated data), login as fresh (empty data)

### Phase 2 — User Management

1. Add `GET/POST/DELETE /api/admin/users` + reset-password endpoints on server
2. Require `rights.admin === true` for admin endpoints (403 otherwise)
3. Build admin UI: admin badge in header → `nui.components.dialog.page()` with user list + add/remove/reset-password forms
4. Test: admin can manage users, non-admin gets 403

### Phase 3 — User Settings

1. Add `GET/PUT/PATCH /api/user/settings` routes to server (reads/writes `chat_app` user settings doc)
2. Wire up `user-settings.js` to backend endpoints
3. Settings UI persistence

---

## Appendix: Core Development Maxims (from `Agents.md`)

These principles override all style guides, conventions, or habits:

| Priority | Principle |
|----------|-----------|
| **1** | **Reliability > Performance > Everything else** |
| **2** | **LLM-Native Codebase** — Code readability for humans is a non-goal. The code will not be maintained by humans. Optimize for the most efficient structure an LLM can understand. Do not rely on conventional human coding habits. |
| **3** | **Vanilla JS** — No TypeScript anywhere. Code must stay as close to the bare platform as possible for easy optimization and debugging. `.d.ts` files are generated strictly for LLM/editor context, not used at runtime. |
| **4** | **Zero Dependencies** — If we can build it ourselves using raw standard libraries, we build it. Avoid external third-party packages. Evaluate per-case if a dependency is truly necessary. |
| **5** | **Fail Fast, Always** — No defensive coding. No mock data. No fallback defaults. No silencing try/catch. No optional chaining (`?.`) for required values. Configuration must be explicit — missing required config must throw immediately at startup. When something breaks, let it crash and fix the root cause. |
| **6** | **Collaborative Development** — The human user is a partner, not just a reviewer. When facing architectural decisions, trade-offs, or uncertain paths, pause and ask for input. Explain the options clearly. The user's domain knowledge and preferences are valuable — include them in the loop. Avoid long silent stretches of trial-and-error; converse, don't just execute. |
User settings have been fully persisted via API calls under the hood using a new backend synchronization layer in storage.js. Phase 3 is completed.
