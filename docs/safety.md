# Data Safety Checklist

> **Purpose:** Guardrails for any change touching storage, save paths, or data persistence.
> **Rule:** If you change a write path, run this checklist BEFORE deploying to production.

---

## Before You Touch Any Save/Storage Path

### 1. Copy the production database locally
```powershell
# Copy the user DB you'll be testing against
robocopy "\\BADKID\Stuff\SRV\LLM-Gateway-Chat\server\data\chat_user" "server\data\chat_user_test" /E
```
Or copy any user's `dbPath` from `config.json`. Point your local server at the copy.

### 2. Run a pre-change integrity check
```bash
node docs/_Archive/analyze-arena-dupes.js server/data/chat_user_test
```
Baseline the state before your change. Note session count, message counts, any existing duplicates.

### 3. Make the change, test the specific scenario
- Does it work for **new** sessions?
- Does it work for **loaded/existing** sessions?
- Does it survive **concurrent** calls (two rapid saves)?
- Does it survive a **page reload** (state restored correctly)?

### 4. Run the integrity check again
Same command. Compare against baseline. Any new duplicates? Any changed message counts?

### 5. Check for the known failure modes
| Failure Mode | What to Look For |
|-------------|-----------------|
| Duplicate sessions | Same title + same model pair + same message count appearing twice in session list |
| Duplicate messages | Message count doubling after save, messages appearing twice in conversation doc |
| Orphaned embeddings | nVDB vector count exceeding nDB message count |
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
