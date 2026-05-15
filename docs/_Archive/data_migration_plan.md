# Data Migration Plan — NeDB → nDB + nVDB

> Branch: `refactor/chat-architecture`
> Created: 2026-05-12
> Status: Plan review — not yet executed

---

## 1. Source Data Inventory

### 1.1 Local Machine (`server/data/storage.db`, 11.12 MB)

| Prefix | Count | Description |
|--------|-------|-------------|
| `conv:*` | 52 | Conversation exchanges (includes deleted) |
| `history:` | 1 | Array of 17 active chat metadata — **source of truth for active set** |
| `arena:session:*` | 56 | Arena session data (topic, participants, messages array) |
| `arena:history:` | 1 | Array of 43 arena metadata entries (index, some outdated) |
| `activeChatId` | 1 | Last active chat ID |
| `pref:*` | 4 | User preferences |
| `mcp:*` | 2 | MCP server config |

### 1.2 Remote Machine (`\\BADKID\Stuff\SRV\LLM-Gateway-Chat\server\data\`)

| Prefix | Count | Description |
|--------|-------|-------------|
| `conv:*` | 61 | Conversation exchanges (includes deleted) |
| `history:` | 1 | Array of 9 active chat metadata |
| `arena:session:*` | 24 | Arena session data (1 duplicates local — see §5.3) |
| `arena:history:` | 1 | Arena metadata index |
| `activeChatId` | 1 | Last active chat ID |
| `pref:*` | 4 | User preferences |
| `mcp:*` | 2 | MCP server config |

**Remote files** (`\\BADKID\...\server\data\files\`): 2 files

| File | Exchange ID | Active Chat | Size |
|------|------------|-------------|------|
| `ex_1776195965835_v9zawn4bc_0.jpg` | ex_1776195965835_v9zawn4bc | chat_1776195559533_yy2otmxbp | 1.6 MB |
| `ex_1777058022758_6uet25iqo_0.jpg` | ex_1777058022758_6uet25iqo | chat_1777057889691_obrdchl75 | 3.5 MB |

### 1.3 Local Files (`server/data/files/`)

- 17 files, named `{exchangeId}_{index}.{ext}` (e.g., `ex_1774077075843_il0h8m4h6_0.png`)
- All map to exchange IDs in active conv entries (verified via prefix match)

### 1.4 Remote Files (`\\BADKID\...\server\data\files\`)

- 2 files, same naming convention

### 1.5 Internal Data Stats

| Stat | Count |
|------|-------|
| Tool exchanges across all convs | 289 |
| Conversations with tool calls | 18 |
| Empty assistant responses (complete, no content) | 176 |
| Incomplete (streaming) assistant responses | 4 |
| Exchanges with image attachments | 20 |
| Multi-version assistant responses | 2 |
| Arena total messages (from 56 sessions) | 877 |

---

## 2. NeDB Source Format

### 2.1 Conversation Exchange Format (`conv:*`)

```json
{
  "id": "ex_1775241393390_p5l2ngjll",
  "timestamp": 1775241393390,
  "user": {
    "role": "user",
    "content": "[2026-04-03@20:36] Hello there",
    "attachments": []
  },
  "assistant": {
    "role": "assistant",
    "content": "[2026-04-03@20:36] Hello! How can I help you today?",
    "versions": [{ "content": "...", "timestamp": 1775241396802, "context": {...}, "usage": null }],
    "currentVersion": 0,
    "isStreaming": false,
    "isComplete": true,
    "model": "unknown",
    "usage": { ... },
    "context": { ... }
  },
  "systemPrompt": ""
}
```

**Tool exchange variant:**
```json
{
  "id": "ex_1775241436187_rpmlnf7ss",
  "timestamp": 1775241436187,
  "type": "tool",
  "tool": {
    "role": "tool",
    "callId": "call_xxx",
    "name": "vision_create_session",
    "args": { "image_data": "...", "image_mime_type": "image/png" },
    "status": "success",
    "content": "Session created: ...",
    "images": []
  },
  "assistant": { "role": "assistant", "content": "", "isComplete": false, ... }
}
```

Note: Tool exchanges have `type: "tool"`, a `tool` block, AND an `assistant` block. The assistant block may or may not have content (the LLM response after tool result).

### 2.2 Arena Session Format (`arena:session:*`)

```json
{
  "version": 1,
  "id": "arena-1774390386421-jd1zvekbt",
  "exportedAt": "2026-03-24T22:16:15.043Z",
  "topic": "You are different LLM models. Find out what makes you different.",
  "participants": ["kimi-cli-chat", "kimi-chat"],
  "messages": [
    { "speaker": "moderator", "role": "system", "content": "Topic: ..." },
    { "speaker": "Model A", "role": "assistant", "content": "<think>...</think>..." },
    { "speaker": "Model B", "role": "assistant", "content": "..." }
  ]
}
```

### 2.3 Arena History Format (`arena:history:`)

```json
[
  {
    "id": "arena-1777054441464-6vods1gkw",
    "title": "...",
    "topic": "...",
    "exportedAt": "2026-04-11T18:34:01.440Z",
    "participants": ["modelA", "modelB"],
    "messageCount": 20,
    "createdAt": "2026-04-11T18:34:01.440Z"
  }
]
```

Note: Arena history may contain metadata for sessions that no longer have `arena:session:*` data — but verified: all history entries on local machine have corresponding sessions (0 missing).

### 2.4 History Index (`history:`)

```json
[
  {
    "id": "chat_1777057015598_253bdav2x",
    "title": "Hello there",
    "model": "some-model",
    "createdAt": 1777057015598,
    "updatedAt": 1777057036805,
    "messageCount": 2
  }
]
```

**THIS is the source of truth for which chats are active.** Only 17 of 52 `conv:*` entries appear here. The other 35 were deleted.

---

## 3. nDB Target Format

### 3.1 Session Document

```json
{
  "_type": "session",
  "id": "chat_1775241382391_xxbfhmz1t",
  "userId": "user-migrated-default",
  "title": "Hello there",
  "mode": "direct",
  "model": "unknown",
  "arenaConfig": { "modelA": "...", "modelB": "...", "promptVersion": "v1", "maxTurns": 20, "autoAdvance": false },
  "summary": null,
  "createdAt": "2026-04-03T18:36:33.390Z",
  "updatedAt": "2026-04-03T18:37:16.187Z",
  "messageCount": 2,
  "isPublic": false,
  "publicSlug": null
}
```

### 3.2 Message Document

```json
{
  "_type": "message",
  "id": "ex_1775241393390_p5l2ngjll",
  "sessionId": "chat_1775241382391_xxbfhmz1t",
  "userId": "user-migrated-default",
  "role": "user",
  "model": null,
  "content": "Hello there",
  "rawContent": "[2026-04-03@20:36] Hello there",
  "attachments": [{ "name": "image.png", "type": "image/png", "hasImage": true }],
  "turnIndex": 0,
  "createdAt": "2026-04-03T18:36:33.390Z",
  "versions": null,
  "speaker": null
}
```

### 3.3 Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| **Same `id` for user+assistant pair** | One exchange produces one logical ID. Frontend groups by `turnIndex`, not by `id`. The `_backendMessagesToExchanges` strips `-user`/`-assistant` suffixes as a defense anyway. |
| **No `-user`/`-assistant` suffixes** | Dev plan requirement. Frontend regex handles both cases. |
| **`rawContent` preserves original** | Original includes `[timestamp]` prefix. `content` is stripped. |
| **`versions` on assistant messages** | Stores multi-version history for regenerate/switchVersion support |
| **Tool messages as `role: "tool"`** | Separate message with `toolName`, `toolArgs`, `toolStatus` |

---

## 4. Transform Rules

### 4.1 Conversation → Session + Messages

```
NeDB `conv:{chatId}` with exchanges[] 
    ↓
nDB session: { id: chatId, mode: "direct", userId, title, ... }
nDB messages: for each exchange in exchanges[]:
    - IF exchange has user block with non-empty content:
        → message { id: exchangeId, role: "user", content: stripped, ... }
    - IF exchange has assistant block with non-empty content AND isComplete:
        → message { id: exchangeId, role: "assistant", content: stripped, ... }
    - IF exchange has type === "tool" and tool block:
        → message { id: exchangeId, role: "tool", content: tool.content, toolName, ... }
    - All messages for same exchange get same turnIndex
```

### 4.2 Timestamp Stripping

```javascript
function stripTimestamp(content) {
    if (!content) return '';
    return content.replace(/^\[\d{4}-\d{2}-\d{2}@\d{2}:\d{2}\]\s*/, '').trim();
}
```

This removes the auto-generated `[2026-04-03@20:36] ` prefix that the chat app prepends to user messages and LLMs sometimes echo in responses.

### 4.3 Empty Assistant Filtering

**Problem:** 176 exchanges have assistant content that is empty after timestamp stripping (`stripTimestamp(assistant.content)` → `""`), yet `isComplete: true`.

**Decision:** Skip assistant messages where stripped content is empty (regardless of `isComplete`). These are edge cases where:
- The LLM echoed only the timestamp prefix
- The response was truncated to zero
- The exchange was a tool call with no follow-up

**Risk:** Could drop a genuine empty response. **Validation:** These 176 cases should be logged and can be inspected post-migration.

### 4.4 Arena → Session + Messages

```
NeDB `arena:session:{id}` with { topic, participants, messages[] }
    ↓
nDB session: { id: arenaId, mode: "arena", userId, title: topic, arenaConfig: { modelA, modelB }, ... }
nDB messages: for each entry in messages[]:
    → message { id: arenaId-msg-{index}, sessionId: arenaId, role, model, speaker, content, turnIndex: index }
```

**Arena session scope:** Migrate ALL 56 local sessions + ALL 23 unique remote sessions (1 duplicate skipped, see §5.3). The `arena:history:` entry is metadata only — used to enrich missing fields (exportedAt, participants) but NOT treated as sessions themselves.

**Extra sessions (13 local, not in history):** Migrate all of them. They may be completed sessions that weren't indexed, or abandoned ones. Arena has no "deleted" concept per the dev plan.

### 4.5 File Handling

**Current structure:** `server/data/files/{exchangeId}_{index}.{ext}` — flat directory.

**Target structure:** `server/data/files/{sessionId}/{exchangeId}_{index}.{ext}` — grouped by session.

**Mapping:** For each file `{exchangeId}_{index}.{ext}`:
1. Find which session contains `exchangeId` in its exchanges
2. Copy file to `files/{sessionId}/{exchangeId}_{index}.{ext}`
3. In the corresponding nDB message, update attachment reference

**Attachment reference format in nDB:**
```json
{
  "attachments": [
    {
      "name": "image.png",
      "type": "image/png",
      "hasImage": true,
      "blobUrl": "/files/{sessionId}/{exchangeId}_{index}.{ext}"
    }
  ]
}
```

### 4.6 Title Derivation

For conversations, title derives from (in priority order):
1. History index entry title (most reliable)
2. First exchange's user content (stripped, truncated to 100 chars)
3. Fallback: `"Untitled"`

For arenas, title = `topic` field (truncated to 200 chars).

### 4.7 Model Detection

For conversations:
1. First exchange's `assistant.context.model` 
2. History index entry's `model` field
3. Fallback: `"unknown"`

For arenas:
- `arenaConfig.modelA` = participants[0] or `"unknown"`
- `arenaConfig.modelB` = participants[1] or `"unknown"`

---

## 5. Migration Script (`server/migrate.js`)

### 5.1 Command-Line Interface

```bash
node server/migrate.js                                    # Migrate local only
node server/migrate.js --remote \\BADKID\Stuff\SRV\...    # Migrate local + remote
node server/migrate.js --dry-run                           # Validate without writing
```

### 5.2 Execution Steps

1. **Parse arguments**: Determine source paths
2. **Open nDB**: Connect to `server/data/chat_app`
3. **Wipe existing data**: Delete all documents (previous broken migration)
4. **Open nVDB**: Connect to `server/data/nvdb`, create/recreate `embeddings` collection (2560 dims)
5. **Create migration user**: Single user `user-migrated-default` for all imported data
6. **Process each source** (local, then remote):
   a. Read `storage.db` line-by-line
   b. **Build active set** from `history:` entry → Set of chat IDs
   c. **Migrate conversations**: For each `conv:*` in active set → session + messages
   d. **Migrate arenas**: For each `arena:session:*` → session + messages (skip `arena:history:`)
   e. **Enrich from history**: Apply metadata (title, model) from history index
   f. **Copy files**: Copy from source `files/` dir to nDB files dir, grouped by session
   g. **Update attachment refs**: Point message attachments to new file paths
7. **Flush nVDB**: Ensure durability
8. **Report stats**: Sessions created, messages, files, skipped, warnings

### 5.3 Deduplication Strategy

When processing two sources (local + remote):

- **Conversation IDs**: UUIDs include timestamps → collisions virtually impossible. **Verified:** 0 duplicates across 52+61 conv entries.
- **Arena session IDs**: **1 duplicate found** — `arena-1776062925829-fa2jvtydv` exists on both machines.
  - Local: 71,621 bytes, exportedAt 2026-05-10 (newer, more complete)
  - Remote: 62,134 bytes, exportedAt 2026-04-13 (older, partial)
  - **Decision:** Prefer local (larger, newer). Skip remote duplicate. Log as info.
- **User**: Single migration user for all data (no per-machine isolation needed)

### 5.4 Error Handling

| Condition | Action |
|-----------|--------|
| `storage.db` not found | Fatal — abort |
| Malformed JSON line | Skip, log warning with line content |
| Exchange without user block | Skip exchange, log warning |
| Empty assistant content (stripped) | Skip assistant message, log info |
| File referenced but missing on disk | Log warning, leave attachment reference as-is |
| Remote files dir not writable | Log warning, skip remote files (user can copy manually) |
| `arena:history:` entry without matching session | Log info (expected for remote — history may reference deleted sessions) |
| Duplicate arena session (local preferred) | Skip remote duplicate, log info |
| nVDB collection exists | Recreate it (wipe old embeddings) |

---

## 6. Expected Output Stats

### 6.1 Local Only

| Item | Expected Count |
|------|---------------|
| Sessions (direct) | 17 |
| Sessions (arena) | 56 |
| Total sessions | 73 |
| Messages (user) | ~17 × average turn count |
| Messages (assistant) | ~same minus 176 empty |
| Messages (tool) | ~289 |
| Messages (arena) | 877 |
| Files copied | 17 |
| Skipped `conv:*` (deleted) | 35 |

### 6.2 Local + Remote

| Item | Expected Count |
|------|---------------|
| Sessions (direct) | 17 + 9 = 26 |
| Sessions (arena) | 56 + 23 = 79 (1 duplicate skipped) |
| Total sessions | 105 |
| Files copied | 17 (local) + 2 (remote, if writable) |
| Duplicate arena skipped | 1 (arena-1776062925829-fa2jvtydv) |

---

## 7. Post-Migration Steps

### 7.1 Verify nDB State

```bash
# Count documents by type
node -e "
const {Database} = require('./lib/ndb/napi');
const db = Database.open('server/data/chat_app');
console.log('Total docs:', db.len());
console.log('Sessions:', db.find('_type','session').length);
console.log('Messages:', db.find('_type','message').length);
console.log('Users:', db.find('_type','user').length);

const sessions = db.find('_type','session');
console.log('Direct sessions:', sessions.filter(s=>s.mode==='direct').length);
console.log('Arena sessions:', sessions.filter(s=>s.mode==='arena').length);
"
```

### 7.2 Run Embedding Pipeline

```bash
node server/embed.js
```

Expect: ~9 texts/sec via Gateway (Qwen3-Embedding-4B). Each message text is ~500 chars on average.
Local: ~1000 messages → ~2 minutes.
Local + remote: ~2000 messages → ~4 minutes.

### 7.3 Enable Backend in Frontend

In `chat/js/config.js`, flip:
```javascript
enableBackend: true,  // was false
```

### 7.4 Verify End-to-End

1. Start server: `node server/server.js`
2. Open `http://localhost:3500/chat/`
3. Check sidebar shows 17 (or 26) direct chats, no arena, no empty
4. Open a chat, verify user + assistant messages render
5. Verify image attachments load
6. Test MCP archive tools in chat

### 7.5 Rollback

If anything is wrong:
- `enableBackend: false` returns to localStorage mode instantly
- Re-run `migrate.js` to redo from scratch (NeDB source never modified)

---

## 8. Risks & Edge Cases

### 8.1 High-Impact Edge Cases

| Edge Case | Count | Handling |
|-----------|-------|----------|
| Tool exchanges without tool block | 0 observed | Log warning, skip |
| Assistant with `isComplete: false` | 4 | Skip — streaming didn't finish |
| Multi-version assistant responses | 2 | Store all versions in `versions` array |
| `rawContent` with full thinking blocks | Common (arena) | Store full raw, strip only for `content` |

### 8.2 Known Issues with Current (Broken) Migration

| Issue | Root Cause | Fixed By |
|-------|-----------|----------|
| 52 chats shown instead of 17 | No `history:` filter | Step 6b — filter by active set |
| `-user`/`-assistant` ID suffixes | `migrate.js` line 179-182 | Use exchange ID directly |
| Files not linked to messages | `migrate.js` just copies flat | Step 6f-6g — session grouping + ref update |
| Ghost `arena:history:` treated as session | `migrate.js` processes `arena:` prefix broadly | Step 6d — only process `arena:session:*` |
| No arena sessions migrated | Arena processing was broken or not present | Step 6d — new arena migration |
| Empty assistant messages clutter history | No filtering | Step 4.3 — skip empty stripped content |

---

## 9. Verification Queries

After migration, run these to validate data integrity:

```bash
# Check no -user/-assistant suffixes in message IDs
node -e "db.find('_type','message').forEach(m => { if (m.id.match(/-user\$/)) console.log('SUFFIX FOUND:', m.id); })"

# Check conversation message pairing (user+assistant per turnIndex)
node -e "
const msgs = db.find('_type','message');
const groups = {};
msgs.forEach(m => { const k = m.sessionId + ':' + m.turnIndex; (groups[k]=groups[k]||[]).push(m.role); });
Object.entries(groups).forEach(([k,roles]) => { if (!roles.includes('user')) console.log('Missing user for', k); });
"

# Check file references are valid
node -e "
const fs = require('fs');
const msgs = db.find('_type','message');
msgs.forEach(m => {
    (m.attachments||[]).forEach(a => {
        if (a.blobUrl && !fs.existsSync('server/data' + a.blobUrl)) console.log('MISSING FILE:', a.blobUrl);
    });
});
"
```

---

## 10. What This Does NOT Cover

- **User preferences** (`pref:*`): Out of scope — frontend uses new backend for prefs now
- **MCP config** (`mcp:*`): Out of scope — frontend manages MCP separately
- **activeChatId**: Out of scope — set by frontend on first load
- **nVDB search index**: Handled by separate `embed.js` run (Phase 3)
- **Arena auto-publish**: Phase 6, not part of migration
- **Auth/login UI**: Phase 2 remnant, key is hardcoded in config.js

---

## 11. Decision Log

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Same `id` for user+assistant pair | Frontend groups by `turnIndex`, not `id`. Unique per-exchange ID simplifies tracing. |
| 2 | Skip empty stripped assistant content | 176 messages with no real content after timestamp strip. They're noise. |
| 3 | Migrate all 56 arena sessions, not just 43 in history | Dev plan says all kept. 13 extra have real messages (2-11 each). |
| 4 | Single migration user | No need for per-machine users until Phase 2 auth is fully implemented. |
| 5 | Files grouped by sessionId, not exchangeId | nDB bucket concept uses session-level folders. Frontend serves files by path. |
| 6 | `arena:history:` for enrichment only | It's an index, not a session. Use metadata but don't create sessions from it. |
