# Data Safety Checklist

> **Purpose:** Guardrails for any change touching storage, save paths, or data persistence.
> **Rule:** If you change a write path, run this checklist BEFORE deploying to production.

---

## Before You Touch Any Save/Storage Path

### 1. Use the local test database
A copy of representative production data lives in `server/data/chat_user_test/`.
Point your local server at it by adding a test user to `server/config.json`:

```json
{
    "id": "test-user",
    "username": "test",
    "password": "test",
    "displayName": "Test User",
    "dbPath": "server/data/chat_user_test",
    "rights": { "login": true, "read": true, "write": true, "admin": true }
}
```

Start the server, log in as `test` / `test`, and verify your changes against real-but-disposable data.
The test DB is in the repo — it gets committed and updated when the data model changes.

### 2. Run a pre-change integrity check
```bash
node docs/_Archive/analyze-arena-dupes.js server/data/chat_user_test
```
Baseline the state before your change. Note session count, message counts, any existing duplicates.

### 3. Make the change, test the specific scenarios
- Does it work for **new** sessions?
- Does it work for **loaded/existing** sessions?
- Does it survive **concurrent** calls (two rapid saves)?
- Does it survive a **page reload** (state restored correctly)?
- Does it survive **switching between sessions** (multi-chat)?
- Export → import: does the round-trip preserve all data?

### 4. Run the integrity check again
Same command. Compare against baseline. Any new duplicates? Any changed message counts?

### 5. Update the test DB if the data model changed
If your change alters the data format, export a fresh snapshot from the production database on BADKID. Replace `herrbasan` with the actual user folder name:
```powershell
robocopy "\\BADKID\Stuff\SRV\LLM-Gateway-Chat\server\data\herrbasan" "server\data\chat_user_test" /E
```
Commit the updated test DB so the next change has accurate test data.

### 6. Deploy only after clean verification
- Pull latest to BADKID
- Restart server
- Verify the fix works on production data

---

## Known Failure Modes

| Failure Mode | What to Look For |
|-------------|-----------------|
| Duplicate sessions | Same title + same model pair + same message count appearing twice in session list |
| Duplicate messages | Message count doubling after save, messages appearing twice in conversation doc |
| Orphaned embeddings | nVDB vector count exceeding nDB message count |
| Lost state on reload | `_backendChatId`, `_lastSyncedCount`, `summary` not surviving page refresh |
| Concurrent save race | Two `_saveToStorage()` calls overlapping, both creating sessions |
| Lost state on reload | `_backendChatId`, `_lastSyncedCount`, `summary` not surviving page refresh |
| Concurrent save race | Two `_saveToStorage()` calls overlapping, both creating sessions |

### 6. Deploy only after clean verification
- Pull latest to BADKID
- Restart server
- Verify the fix works on production data

---

## Code-Level Safeguards to Always Include

### Mutex guards on every async write method
```javascript
async _saveToStorage() {
    if (this._saving) return;
    this._saving = true;
    try {
        // ... save logic ...
    } finally {
        this._saving = false;
    }
}
```

### Restore all internal state on load
When loading from storage, restore EVERY piece of tracking state:
- `_backendChatId` — so saves update existing sessions, not create duplicates
- `_lastSyncedCount` — so only new messages are sent to backend
- `summary` — so generated summaries survive reload
- Any other field that tracks what's already been persisted

### Idempotent saves where possible
Prefer PATCH/upsert over POST/create when the entity might already exist. Check before creating.

---

## Known Risk Areas (audit these especially)

| Area | Risk | Last Audited |
|------|------|-------------|
| `chat-arena/js/arena.js` `_saveToStorage()` | Concurrent calls, loaded session state loss | 2026-05-30 |
| `chat/js/conversation.js` `save()` | Multiple rapid saves, IndexedDB races | — |
| `chat/js/chat-history.js` `create()` | Backend ID sync, localStorage fallback | — |
| `server/server.js` `embedMessageAsync()` | Stale conversation doc overwrite (see lessons-learned.md) | — |
| `server/server.js` `POST /api/chats/:id/messages` | Duplicate message insertion | — |
