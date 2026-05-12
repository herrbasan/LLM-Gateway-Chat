# Data Migration Analysis & Strategy

> Current data in `server/data/` — migrating to nDB + nVDB architecture
> Date: 2026-05-11

---

## Current Data Inventory

| Source | Count | Description |
|--------|-------|-------------|
| `conv:` records | 52 | Direct chat conversations (exchanges array) |
| `arena:` records | 57 | Arena session exports |
| `history:` | 1 | Chat list metadata (53 entries) |
| `pref:` | 4 | User preferences (TTS voice, etc.) |
| `activeChatId:` | 1 | Last active chat |
| `mcp:` | 2 | MCP server configuration |
| Image files | 17 | Binary attachments in `server/data/files/` |

**Message volume:**
- Direct chat messages: ~831 (user + assistant)
- Arena messages: ~877 (system + model A + model B)
- Total text: ~4.16M characters (~1.04M tokens)

---

## Current Data Structures

### 1. Direct Chat Conversation (`conv:chat_{id}`)

```json
[
  {
    "id": "ex_{timestamp}_{random}",
    "timestamp": 1775241393390,
    "user": {
      "role": "user",
      "content": "[2026-04-03@20:36] Hello there",
      "attachments": []
    },
    "assistant": {
      "role": "assistant",
      "content": "[2026-04-03@20:36] Hello! How can I help you today?",
      "versions": [...],
      "currentVersion": 0,
      "isStreaming": false,
      "isComplete": true,
      "context": {...}
    }
  },
  {
    "id": "ex_{timestamp}_{random}",
    "timestamp": 1775241427414,
    "type": "tool",
    "userId": "ex_...",
    "tool": {
      "role": "tool",
      "name": "vision_create_session",
      "args": {...},
      "status": "success",
      "content": "..."
    },
    "assistant": {...}
  }
]
```

**Key observations:**
- Content has auto-prepended timestamps: `[2026-04-03@20:36] ...`
- Tool calls are stored as `type: "tool"` exchanges
- Assistant has version history (for regeneration)
- Attachments reference images by name (stored separately)

### 2. Arena Session (`arena:session:arena-{id}`)

```json
{
  "version": 1,
  "id": "arena-1774390386421-jd1zvekbt",
  "exportedAt": "2026-03-24T22:16:15.043Z",
  "topic": "You are different LLM models...",
  "participants": ["kimi-cli-chat", "kimi-chat"],
  "participantNames": ["kimi-cli-chat", "kimi-chat"],
  "settings": {
    "maxTurns": 10,
    "autoAdvance": true,
    "systemPromptA": null,
    "systemPromptB": null,
    "targetTokens": null
  },
  "contextUsage": {...},
  "summary": {
    "condensedVersion": "...",
    "compactedConversation": "..."
  },
  "messages": [
    {"role": "system", "speaker": "moderator", "content": "Topic: ..."},
    {"role": "assistant", "speaker": "Model A", "content": ""},
    {"role": "assistant", "speaker": "Model B", "content": "..."}
  ]
}
```

**Key observations:**
- Two formats: older `version: 1` with simpler structure, newer with `settings`, `contextUsage`, `summary`
- Messages have `speaker` field ("moderator", "Model A", "Model B")
- Arena prompt is in the first system message
- Some have LLM-generated summaries

### 3. Chat History Index (`history:`)

```json
[
  {
    "id": "chat_1777057015598_253bdav2x",
    "sessionId": "sess-1777057015598-430",
    "title": "Hello there",
    "createdAt": 1777057015598,
    "updatedAt": 1777057015598,
    "messageCount": 0,
    "model": "badkid-llama-chat"
  }
]
```

**Key observations:**
- `id` and `sessionId` are different (sessionId has `sess-` prefix)
- `messageCount` is often 0 (not updated in real-time)
- `model` is the last used model

---

## Migration Mapping

### User Migration

All existing data belongs to a single implicit user. Migration creates:

```json
{
  "id": "user-migrated-default",
  "apiKey": "migrated-{hash}",
  "displayName": "Legacy User",
  "createdAt": "2026-05-11T00:00:00Z",
  "lastActiveAt": "2026-05-11T00:00:00Z",
  "isMigrated": true
}
```

The user gets a migration API key they can use immediately. They can optionally regenerate a proper key later.

### Direct Chat → Session + Messages

| NeDB Field | nDB Target | Transform |
|------------|-----------|-----------|
| `conv:chat_{id}` | `sessions` + `messages` | Split into session metadata + message docs |
| Exchange `timestamp` | `messages.createdAt` | Convert to ISO timestamp |
| `user.content` | `messages.content` (role: user) | Strip prepended timestamps `[YYYY-MM-DD@HH:MM] ` |
| `assistant.content` | `messages.content` (role: assistant) | Strip prepended timestamps, keep versions as array |
| `assistant.versions` | `messages.versions` | Store as JSON array |
| `attachments` | `messages.attachments` | Update file paths |
| `type: "tool"` | `messages.role: "tool"` | Map tool fields |

**Session document:**
```json
{
  "id": "chat_177...",
  "userId": "user-migrated-default",
  "title": "Hello there",
  "mode": "direct",
  "model": "kimi-chat",
  "createdAt": "2026-03-21T07:57:00Z",
  "updatedAt": "2026-04-04T07:42:00Z",
  "messageCount": 12,
  "isPublic": false
}
```

**Message document:**
```json
{
  "id": "ex_1774076246109_gct8gvnpp",
  "sessionId": "chat_1774331121805_6xvr9ui3w",
  "userId": "user-migrated-default",
  "role": "assistant",
  "model": "kimi-chat",
  "content": "Good morning! How can I help you today?",
  "rawContent": "[2026-03-21@07:57] Good morning! How can I help you today?",
  "versions": [...],
  "attachments": [],
  "turnIndex": 0,
  "createdAt": "2026-03-21T07:57:26Z"
}
```

### Arena Export → Session + Messages

| NeDB Field | nDB Target | Transform |
|------------|-----------|-----------|
| `arena:session:arena-{id}` | `sessions` + `messages` | Reconstruct as session + messages |
| `topic` | `sessions.title` | Use topic as title (truncated if needed) |
| `participants` | `sessions.arenaConfig.modelA/B` | Map to model fields |
| `settings` | `sessions.arenaConfig` | Store settings object |
| `messages` | `messages` | Convert each to message doc |
| `summary` | `sessions.summary` | Store LLM-generated summary |
| `exportedAt` | `sessions.createdAt` | Use export time as creation time |

**Session document:**
```json
{
  "id": "arena-1774390386421-jd1zvekbt",
  "userId": "user-migrated-default",
  "title": "You are different LLM models...",
  "mode": "arena",
  "arenaConfig": {
    "modelA": "kimi-cli-chat",
    "modelB": "kimi-chat",
    "promptVersion": "v1",
    "maxTurns": 10,
    "autoAdvance": true
  },
  "summary": {
    "condensedVersion": "..."
  },
  "createdAt": "2026-03-24T22:16:15Z",
  "updatedAt": "2026-03-24T22:16:15Z",
  "isPublic": false,
  "publicSlug": null
}
```

**Message document:**
```json
{
  "id": "msg-arena-0",
  "sessionId": "arena-1774390386421-jd1zvekbt",
  "userId": "user-migrated-default",
  "role": "system",
  "model": null,
  "content": "Topic: You are different LLM models...",
  "turnIndex": 0,
  "speaker": "moderator",
  "createdAt": "2026-03-24T22:16:15Z"
}
```

### Image Files

Keep current file structure. Copy `server/data/files/` → new data directory.

Update references: exchange IDs change during migration, so image filenames need updating OR we store a mapping table.

**Decision:** Keep original filenames (they include exchange IDs). Store a migration mapping: `oldExchangeId → newMessageId`. The image files stay named with old IDs.

### Preferences

```json
{
  "userId": "user-migrated-default",
  "ttsVoice": "Allan6",
  "...": "..."
}
```

---

## Migration Script Design

```javascript
// migrate.js — One-time migration from NeDB to nDB

const fs = require('fs');
const path = require('path');
const { Database } = require('ndb');

const MIGRATION_USER = {
  id: 'user-migrated-default',
  apiKey: 'migrated-' + require('crypto').randomUUID(),
  displayName: 'Legacy User',
  createdAt: new Date().toISOString(),
  isMigrated: true
};

async function migrate() {
  const db = Database.open('./data/ndb/chat_app');
  const users = db.collection('users');
  const sessions = db.collection('sessions');
  const messages = db.collection('messages');
  
  // 1. Create migration user
  users.insert(MIGRATION_USER);
  
  // 2. Read NeDB storage
  const lines = fs.readFileSync('server/data/storage.db', 'utf8')
    .trim().split('\n');
  
  for (const line of lines) {
    const doc = JSON.parse(line);
    
    if (doc.key.startsWith('conv:')) {
      await migrateConversation(doc, sessions, messages);
    }
    else if (doc.key.startsWith('arena:')) {
      await migrateArena(doc, sessions, messages);
    }
    else if (doc.key === 'history:') {
      // Enrich session metadata from history index
      await enrichFromHistory(doc.value, sessions);
    }
  }
  
  // 3. Copy image files
  fs.cpSync('server/data/files/', 'data/files/', { recursive: true });
  
  console.log('Migration complete');
}
```

---

## Embedding Strategy for Historical Data

**Volume:** ~1.04M tokens across ~1,708 messages

**Approach:** Parallel batch embedding after migration

```javascript
const messages = await messagesColl.find({ userId: 'user-migrated-default' });

// Chunk into ~50-message batches (~30K tokens each), fire all in parallel
const BATCH_SIZE = 50;  // ~30K tokens per batch
const batches = chunk(messages, BATCH_SIZE);

const promises = batches.map(async (batch) => {
  const texts = batch.map(m => buildEmbeddingText(m));
  const response = await fetch(`${GATEWAY_URL}/v1/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'fatten-llama-embed', input: texts })
  });
  const { data } = await response.json();

  for (let i = 0; i < batch.length; i++) {
    nvdbCollection.insert(batch[i].id, data[i].embedding, {
      sessionId: batch[i].sessionId,
      role: batch[i].role,
      model: batch[i].model
    });
  }
});

await Promise.all(promises);
```

| Metric | Value |
|--------|-------|
| Total messages to embed | ~1,708 |
| Batch size | 50 messages (~30K tokens) |
| Total batches | ~35 |
| Execution | All 35 batches fire simultaneously |
| Estimated time | ~2-3 seconds (Gateway/Fatten handles parallel GPU scheduling) |
| nVDB storage | ~28 MB (1,708 × 4096 dims × 4 bytes) |

> **On quality:** Each message is embedded independently. Whether sent one-by-one or in a batch of 50, the resulting vector is identical. Batching is purely a transport optimization.

> **On reliability:** If a batch fails (network hiccup, Gateway timeout), the other 34 batches still succeed. Retry the failed batch individually. No data is lost.

> **On performance:** Fatten's GPU can run multiple embedding forward passes in parallel. The bottleneck is usually network latency to the Gateway, not GPU throughput. Firing all 35 batches at once saturates the pipeline efficiently.

---

## Migration Execution Plan

### Option A: Big Bang (Recommended)

1. Stop the old server
2. Run migration script
3. Start new backend
4. Frontend auto-detects new backend and offers import

**Pros:** Clean cut, no dual-write complexity
**Cons:** Brief downtime

### Option B: Dual-Write (Overkill)

Keep old server running, write to both during transition.

**Not recommended** — this is a lab project, not production.

### Option C: Lazy Migration

New backend starts empty. User clicks "Import existing data" when ready.

**Pros:** No forced migration, user controls timing
**Cons:** Two data sources during transition

**Recommendation:** Option A for this project. The migration script is idempotent (can re-run). If something breaks, restore from `server/data/` backup.

---

## Post-Migration Verification

```bash
# Check counts
node -e "
const { Database } = require('ndb');
const db = Database.open('./data/ndb/chat_app');
console.log('Users:', db.collection('users').count());
console.log('Sessions:', db.collection('sessions').count());
console.log('Messages:', db.collection('messages').count());
"

# Spot-check a conversation
node -e "
const { Database } = require('ndb');
const db = Database.open('./data/ndb/chat_app');
const s = db.collection('sessions').findOne({ mode: 'arena' });
console.log('Arena:', s.title, s.arenaConfig);
const msgs = db.collection('messages').find({ sessionId: s.id });
console.log('Messages:', msgs.length);
"

# Verify embeddings
node -e "
const { Database } = require('nvdb');
const db = new Database('./data/nvdb');
const col = db.collection('embeddings_user-migrated-default');
console.log('Vectors:', col.count());
"
```

---

## Risk: Timestamp Stripping

Direct chat content has auto-prepended timestamps:
```
[2026-04-03@20:36] Hello there
```

**Decision:** Store `rawContent` (with timestamp) and `content` (stripped). The stripped version goes to the LLM and embeddings. The raw version is preserved for archival accuracy.

**Regex:** `/^\[\d{4}-\d{2}-\d{2}@\d{2}:\d{2}\]\s*/`

---

## Risk: Arena "Model A / Model B" vs Actual Model Names

Arena exports use generic speaker names. The actual model is in `participants` array.

**Mapping:**
- `speaker: "Model A"` → `model: participants[0]`
- `speaker: "Model B"` → `model: participants[1]`
- `speaker: "moderator"` → `model: null, role: "system"`

---

## Summary

| Item | Count | Action |
|------|-------|--------|
| Users to create | 1 | Migration user with API key |
| Direct chat sessions | 52 | Migrate to `sessions` + `messages` |
| Arena sessions | 57 | Migrate to `sessions` + `messages` |
| Total messages | ~1,708 | Migrate to `messages` collection |
| Image files | 17 | Copy to new files directory |
| Embeddings to generate | ~1,708 | Batch via Gateway after migration |
| Estimated embedding time | ~35 sec | 35 batches at 30K tokens |
| Estimated vector storage | ~28 MB | 1,708 × 4096 dims |

The migration is straightforward because the data is clean and well-structured. The main complexity is handling the two different formats (direct chat exchanges vs arena message arrays) and stripping timestamps.
