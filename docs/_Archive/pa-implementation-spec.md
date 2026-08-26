# PA Implementation Spec — Event Protocol Frames + Append/Embed Helper

**Date:** 2026-08-24
**Scope:** answers to the two PA-implementation questions, mapped against the verified current code.
**Sources:** [architecture-conversation-runner.md](architecture-conversation-runner.md) (§2, §3), [server.js](../server/server.js) (`POST /api/chats/:id/messages` 1568–1693, `GET /api/chats/:id` 1428–1486), [refactor-deep-dive-report.md](refactor-deep-dive-report.md) (§6 versioning, §3.7 view contracts), [conversation.js](../chat/js/conversation.js).
**Tracking:** LLM-Gateway-Chat #12 · **Branch:** `bff-rework`

**Source legend used throughout:**
- `[S]` — EXISTS in the current stored form (already a field on the message/conversation doc).
- `[SYN]` — SYNTHESIZED by the runner (not in the store; produced at runtime).
- `[RN]` — RENAMED from the stored form (same data, different field name / shape).

---

# PART 1 — EVENT PROTOCOL FRAME SCHEMAS

## 1.0 Shared message shape (the view form)

Events that carry a message (`snapshot`, `msg.user`, `msg.assistant`, and `inFlight`) all use **one** shape so the view renders partial and final with a single code path. This is the **densified view form** (see 1.12).

```jsonc
{
  "id":            "msg_…",                  // [S]  message id
  "idx":           7,                        // [S]  index in the conversation messages array
  "role":          "user|assistant|tool",    // [S]
  "speaker":       null,                     // [S]  arena speaker, else null
  "model":         "kimi-k3-chat",           // [S]
  "content":       "the rendered text",      // [RN] from stored content — the timestamp prefix is STRIPPED for the view (contract #1)
  "timestamp":     1787538600000,            // [SYN] display time, split out of the user prefix / from createdAt (contract #1)
  "createdAt":     "2026-08-24T01:01:27Z",   // [S]
  "embedStatus":   "embedded|pending|failed",// [S]
  "embedAttempts": 0,                        // [S]
  "embedError":    null,                     // [S]
  "attachments": [                           // [S], densified (see 1.12)
    { "name":"a.jpg","type":"image/jpeg","hasImage":true,
      "url":"/api/buckets/images/x.png",      // [S] densified
      "blobUrl":"/api/buckets/images/x.png",  // [S] densified
      "_file":"images:x.png" }                // [S] compact nURI (GC ref)
  ],
  // — message-role optional fields —
  "toolName":"storage_write","toolArgs":{…},"toolStatus":"success","toolImages":["/api/buckets/images/…"],  // [S] tool
  "reasoning_content":"…",                   // [S] assistant (view may need `reasoningContent` alias — see naming note)
  "thinking_signature":"…", "streamStats":{…},"usage":{…},"context":{…},  // [S] assistant
  "tool_calls":[ { "id":"call_…","type":"function","function":{…} } ]      // [S] assistant
}
```

**Naming note (snake vs camel):** message documents keep the **nDB stored-form snake_case** (`reasoning_content`, `thinking_signature`, `streamStats`, `usage`, `context`, `tool_calls`). Event **envelopes** use the arch §3 camelCase (`reasoningContent`, `content`, `finishReason`). Do not mix: the view reads message fields in snake_case, and control envelopes in camelCase. This matches the old client, which already consumes `event.reasoning_content` from the SDK but stores `reasoning_content`.

## 1.1 `snapshot`

One frame on attach. `{ meta, messages, inFlight, lastRun }`.

```jsonc
{
  "meta": {                                   // [SYN] runner-curated subset of the session doc
    "id":"chat_…", "title":"…", "model":"…", "systemPrompt":"…",
    "mode":"direct", "chunkTransform":false, "retirements":{…},
    "category":null, "summary":null, "arenaConfig":null
  },
  "messages": [ /* 1.0 message shape, in order */ ],   // [S] densified (see 1.12)
  "inFlight": null | { /* 1.12 inFlight shape */ },    // [SYN] if a run is active
  "lastRun": { "usage":{…}, "context":{…} }            // [S] from the last assistant message's usage/context
}
```

- `meta` is **SYNTHESIZED** (the runner curates the session-doc fields the view needs). The source fields exist on the `_type:'session'` doc — `[S]`.
- The `meta` field covers the "flags (chunk-view toggle, …)" from arch §2.1.
- `messages` are the densified view form; `inFlight` mirrors the assistant message shape.

## 1.2 `msg.user`

Appended + persisted user message. Same shape as 1.0 (`role:'user'`). Runner strips the stored timestamp prefix for `content` and exposes `timestamp` separately (contract #1). `embedStatus` is `'pending'` until the embed pipeline updates it (via `embed.status`).

## 1.3 `run.start`

```jsonc
{ "exchangeId":"ex_…",   // [SYN] runner-assigned, for tool↔assistant pairing
  "model":"kimi-k3-chat", // [SYN]
  "messageId":"msg_…" }   // [SYN] assistant message id, for view keying (contract #2)
```

`exchangeId` and `model` are per arch §3; `messageId` is an **added** [SYN] field so running deltas can be keyed to a bubble.

## 1.4 `delta`

```jsonc
{ "messageId":"msg_…",          // [SYN] routes the delta to the right bubble (contract #2)
  "exchangeId":"ex_…",          // [SYN]
  "content":"…",                // [SYN] a chunk of text
  "reasoningContent":"…",       // [RN] from stored `reasoning_content` — same data, camelCase envelope
  "toolCalls":[ { "index":0,"id":"call_…","function":{ "name":"…","arguments":"…" } } ] }  // [SYN] raw delta fragments; view aggregates
```

The runner emits **raw** deltas (as the gateway publishes them, incl. partial tool-call `arguments` fragments). The view aggregates tool-calls and debounces text rendering — exactly as `streamResponse`/client-sdk do today.

## 1.5 `tool.start`

```jsonc
{ "toolCallId":"call_…",   // [SYN] stable, from the assistant's tool_calls id (contract #2)
  "name":"storage_write",  // [SYN] MCP original name, or the `tools` dispatcher method (view derives display via `args.method`)
  "args":{…},              // [SYN] the tool arguments (may still be partial)
  "exchangeId":"ex_…",     // [SYN]
  "messageId":"msg_…" }    // [SYN] the assistant message that requested it
```

`name` + `args` let the view call `formatToolDisplayName(name, args)` (cherry-picks `args.method`) exactly as today.

## 1.6 `tool.end`

```jsonc
{ "toolCallId":"call_…",        // [SYN]
  "name":"storage_write",       // [SYN]
  "status":"success|error",     // [SYN]
  "resultMessage":"…",          // [SYN] text result (images stripped to URLs)
  "resultImages":["/api/buckets/images/…"],  // [SYN] bucket URLs (base64 intercept → db.storeFile)
  "toolMessageId":"msg_…",      // [SYN] the persisted role:tool message id
  "messageId":"msg_…" }         // [SYN] the triggering assistant message
```

`resultImages` corresponds to stored `toolImages` `[S]`. `resultMessage`/`resultImages` are **renamed/split** from the tool message's `content` + `toolImages`. `toolMessageId` is the newly-persisted tool message.

## 1.7 `msg.assistant`

The finalized assistant message (1.0 shape, `role:'assistant'`), plus the variant fields. Emitted at `finish_reason:'stop'` and (with `tool_calls`) at `finish_reason:'tool_calls'`. For a variant-creating run it also carries the new variant (see 1.8).

```jsonc
{ …1.0 message shape…,
  "isStreaming": false,          // [SYN]
  "versions":[ { "content":"…","reasoning_content":"…","thinking_signature":"…","usage":{…},"context":{…},"streamStats":{…},"model":"…","timestamp":1787538600000 } ],
  "currentVersion": 0 }          // [SYN] §2.4 durable variants
```

The `versions[]` / `currentVersion` fields are **NEW** (not in today's stored form — today they are client-in-memory only; §6 mechanics). Marked [SYN] as the runner's §2.4 target. For old messages with no variants the runner may omit these or emit `versions: []`.

## 1.8 `msg.variant`

Emitted when the runner flips the selected variant (arch §2.4: `switchVersion` becomes a server call). It must carry enough for the view to swap the rendered message in place.

```jsonc
{ "messageId":"msg_…",            // [SYN] the assistant message
  "currentVersion":1,             // [SYN] the new selection (pointer change)
  "variant": { "content":"…","reasoning_content":"…","thinking_signature":"…","usage":{…},"context":{…},"streamStats":{…},"model":"…","timestamp":… } }  // [SYN] full current variant, so the view re-renders without re-fetching
```

Rationale: a bare `{messageId, currentVersion}` is a pointer change, but the view must re-render `content`/`reasoning_content`/`usage`/`context`/`streamStats`. Carrying the variant eliminates a fetch and keeps the view a pure projection. This is **not** a structural mutation — the runner does not re-broadcast a full snapshot for it.

## 1.9 `run.end`

```jsonc
{ "finishReason":"stop|tool_calls|aborted",  // [SYN] from gateway / abort
  "usage":{…},                              // [SYN] from gateway
  "context":{…},                            // [SYN]
  "aborted":false,                          // [SYN]
  "messageId":"msg_…" }                     // [SYN]
```

`finishReason`/`usage`/`context`/`aborted` are [SYN]. `usage`/`context` map to the stored assistant message's `usage`/`context` `[S]`.

## 1.10 `embed.status`

Folds today's `/api/embed-events` into the conversation stream. Sourced from the embed pipeline `embedEvents.emit('status', { chatId, msgIdx, messageId, embedStatus, embedError })`.

```jsonc
{ "messageId":"msg_…",   // [RN] from stored message `id`
  "status":"embedded",   // [RN] from stored `embedStatus`
  "embedError":null,     // [S]  from stored `embedError`
  "idx":7 }              // [RN] from `msgIdx`
```

The stored message doc carries `embedStatus`/`embedAttempts`/`embedError` `[S]`; the event renames `embedStatus`→`status` and `msgIdx`→`idx` to match the event-envelope camel-case style. `embedAttempts` is not surfaced (the view doesn't need it, but it stays on the message doc).

## 1.11 `error`

Relayed gateway/provider errors.

```jsonc
{ "code":"rate_limit|server|client|…",   // [SYN] from the gateway error / EmbedError.kind
  "message":"…",                          // [SYN] the error text
  "raw":{…},                              // [SYN] the full upstream body (optional)
  "exchangeId":"ex_…" }                   // [SYN] which exchange failed
```

The view's existing crash-self-heal (`showError`, `setAssistantError`) renders these.

## 1.12 The two "get right" items

### (a) `inFlight` mirrors the assistant-message shape

`inFlight` must be a **partial assistant-message document**, sharing field names with a persisted assistant message, so the view renders a streaming bubble and a final bubble with **one code path** (build the bubble from a message-shaped object; on `msg.assistant`, swap in the finalized message).

```jsonc
{ "id":"msg_…",                                  // [SYN] reserved at run.start, becomes the persisted id
  "idx":8,                                       // [SYN] reserved
  "role":"assistant",
  "model":"kimi-k3-chat",
  "content":"",                                  // [SYN] accumulates deltas
  "reasoning_content":"",                        // [SYN]
  "thinking_signature":null,                     // [SYN]
  "streamStats":null,"usage":null,"context":null,// [SYN] filled at finish
  "tool_calls":null,                             // [SYN] aggregated, for tool turns
  "timestamp":1787538600000,                     // [SYN]
  "exchangeId":"ex_…",                           // [SYN] runner-only
  "finishReason":null,                           // [SYN] runner-only
  "isStreaming":true,                            // [SYN] the only real difference from a final message
  "embedStatus":"pending" }                      // [SYN] so the view treats it identically to a pending persisted message
```

**Why it works:** every field in `inFlight` has the **same name** as the final message (1.0). Only `isStreaming` and the runner-only `exchangeId`/`finishReason` differ. There is no `versions`/`currentVersion` during streaming (a variant is only appended at finish). Embed fires only when the message is persisted, so `embedStatus` on `inFlight` is `'pending'` and the `embed.status` event updates it after — exactly like a normal assistant message.

### (b) Attachments in the snapshot — **densified form, not raw**

**Decision: carry the densified form** (same as `GET /api/chats/:id` today, server.js:1428). Each attachment gets `_file` (compact nURI) + `url` + `blobUrl`; `dataUrl` is preserved only if it is a genuine `data:` URI.

Why:
1. **The view renders `<img src>`.** It needs `url`/`blobUrl` (absolute `/api/buckets/...`), not the compact `images:hash.ext` nURI. Densifying is what lets the existing render code (`att.blobUrl || att.dataUrl || ''`) work unchanged.
2. **Base64 must never enter the viewer context.** The raw stored form can hold a base64 `dataUrl`; densifying replaces a non-`data:` `dataUrl` with the bucket URL (server.js:1444), keeping large blobs out of the snapshot/event payload. A real `data:` URI is kept (occasional small inline images).
3. **`_file` is the GC reference.** The runner needs it (for `releaseFile` on delete). Densifying adds/derives `_file` for older docs that only stored a URL/path. So the snapshot is **self-describing for GC**.
4. **Consistency with the existing GET path.** The snapshot should be the same projection the old client already consumes, so the strangler old-client behavior and the new view stay aligned during cutover.

The runner authors the **canonical stored form** (always `_file` + `url`, never a bare base64-only attachment) via the shared append helper (Part 2). So for runner-authored messages, densification is a no-op; for legacy docs loaded from nDB, the runner densifies on the way out — the same logic as today's GET. Keep the densify logic as a shared function so the helper and the GET route agree (see Part 2).

---

# PART 2 — APPEND+EMBED HELPER EXTRACTION

## 2.1 What the POST route does today (server.js:1568–1693), step by step

| # | Step | Code | HTTP/request-specific? |
|---|------|------|------------------------|
| 1 | `requireAuth(req, res)` → `{ user, dbInstance }` | 1568–1571 | **YES** — reads req/res |
| 2 | `readBody(req)` → `body` (stored-form fields) | 1573 | **YES** |
| 3 | `db.find('id', params.id)` → `session`; 404 if missing | 1574–1581 | **YES** (path param + HTTP 404) |
| 4 | Find-or-create the `_type:'conversation'` doc; seed from session + `user.id` | 1583–1600 | **NO** (reusable) |
| 5 | `idx = conv.messages.length`; `msgId = 'msg_' + ts + '_' + rand` | 1602–1603 | **NO** (reusable) |
| 6 | Normalize attachments: derive `_file` nURI from `url`/`dataUrl`/`blobUrl`; set `url` from `_file` | 1605–1634 | **NO** (pure; reuse in densify) |
| 7 | Build `message` with defaults (`role:'user'`, `speaker:null`, `model:null`, `content:''`, `rawContent`, `attachments`, `createdAt`, `embedStatus:'pending'`, `embedAttempts:0`, `embedError:null`) | 1636–1653 | **NO** (reusable) |
| 8 | Copy optional fields if truthy: `toolName/toolArgs/toolStatus/toolImages`, `reasoning_content/thinking_signature/streamStats/usage/context` | 1655–1666 | **NO** (reusable) |
| 9 | `conv.messages.push(message)` (keep in-memory array in sync) | 1668 | **NO** (reusable) |
| 10 | `db.arrayPush(conv._id,'messages',message)`; `db.set` `messageCount`/`updatedAt` on conv | 1670–1673 | **NO** (reusable; the runner needs the same atomic writes) |
| 11 | Update `session.messageCount`/`updatedAt`; `db.set` both | 1675–1678 | **NO** (reusable) |
| 12 | Auto-title if `role==='user'` and `session.title==='New Chat'` (first line, 40 chars) | 1680–1686 | **NO** (reusable) |
| 13 | Log `Message added` | 1688 | Mostly **YES** (request-oriented wording; reuse the payload, not the wording) |
| 14 | `embedMessageAsync(dbInstance, message, session, conv._id, idx).catch(…)` fire-and-forget, swallow rejection | 1690–1693 | **NO** (reusable; MUST swallow rejection) |
| 15 | `json(res, message, 201, req)` — response | 1695 | **YES** |

## 2.2 Keep OUT of the helper (HTTP/request-specific)

- `requireAuth`, `readBody`, `req` / `res`, `params.id` extraction, the HTTP `404` branch, and `json(res, …)`.
- The `sessionId`/`req` scoping in the logger call (genericize the log payload; keep it server-side but not request-shaped).
- Everything that derives identity from the HTTP request must be passed in explicitly.

## 2.3 Proposed helper set

Split the reusable logic so the append path, the append-variant path, and the PUT replace path all share the pure parts without each carrying HTTP baggage.

### 2.3.1 `normalizeStoredMessage(msg)` — **pure, no db, no I/O**

```js
// Input:  a stored-form message (as the client/runner already has it)
// Output: a fully-defaulted, attachment-densified message in canonical stored form
function normalizeStoredMessage({ role, content, rawContent, attachments, speaker, model,
    toolName, toolArgs, toolStatus, toolImages, reasoning_content, thinking_signature,
    streamStats, usage, context, tool_calls, id, idx, createdAt } = {})
```
- Derives `_file` compact nURI from each attachment (`url`/`dataUrl`/`blobUrl` — the regexes at 1609–1631).
- Sets `url` from `_file` when absent.
- Defaults: `role:'user'`, `speaker:null`, `model:null`, `content:''`, `rawContent` = `content`, `createdAt` = now, `embedStatus:'pending'`, `embedAttempts:0`, `embedError:null`, `id` and `idx` if not supplied.
- Copies the optional fields only when truthy (mirrors 1655–1666).
- **Reuses the same attachment logic as the GET densify path** (server.js:1428) so POST, snapshot densification, and the helper agree.

### 2.3.2 `appendConversationMessage(ctx, msg)` — **the shared append+embed**

```js
// ctx = { user, dbInstance }   (dbInstance carries { db, embeddingsCol, dbPath })
// msg = { conversationId, role, content, attachments?, speaker?, model?,
//         toolName?, toolArgs?, toolStatus?, toolImages?,
//         reasoning_content?, thinking_signature?, streamStats?, usage?, context?, tool_calls? }
// Returns { message }  — the PERSISTED message (with real id + idx)
async function appendConversationMessage(ctx, msg)
```
Steps (all shared, no HTTP):
1. Resolve `session` + `conv` from `msg.conversationId` (find-or-create conv, seeded from session + `ctx.user.id`).
2. `idx = conv.messages.length`, `msgId = 'msg_' + ts + '_' + rand`.
3. `message = normalizeStoredMessage({ ...msg, id: msgId, idx, createdAt })`.
4. `conv.messages.push(message)`; `db.arrayPush(conv._id,'messages',message)`; `db.set` conv `messageCount`/`updatedAt`.
5. `db.set` session `messageCount`/`updatedAt`.
6. Auto-title (user + `New Chat`).
7. **Fire embed fire-and-forget** and **swallow the rejection**:
   `embedMessageAsync(ctx.dbInstance, message, session, conv._id, idx).catch(() => {})`.
8. Return `{ message }`.

### 2.3.3 `appendMessageVariant(ctx, { messageId, variant })` — **runner variant-append**

For §2.4 durable variants. Appends a full-shape variant to an existing assistant message and flips `currentVersion`:

```js
// variant = { content, reasoning_content, thinking_signature, usage, context, streamStats, model, timestamp }
async function appendMessageVariant(ctx, { messageId, variant })
```
1. Find the assistant message (by `messageId` or `conv.messages[idx]`).
2. `messages[idx].versions.push(variant)`; `messages[idx].currentVersion = versions.length - 1`.
3. Mirror the variant onto the top-level fields (`content`, `reasoning_content`, `usage`, `context`, `streamStats`, `model`, `timestamp`) so non-version-aware consumers see a normal message (§2.4).
4. Persist via atomic writes (`db.set(conv._id, `messages.${idx}`, message)` — reuses `normalizeStoredMessage` for the updated shape).
5. **Fire embed fire-and-forget** (per §2.4: "embed fires per variant creation").
6. Return `{ message }`.

### 2.3.4 `replaceConversationMessages(ctx, messages)` — **the PUT path**

```js
async function replaceConversationMessages(ctx, messages)
```
1. `newMessages = messages.map((m, i) => normalizeStoredMessage({ ...m, idx:i }))`.
2. `conv.messages = newMessages`; `db.update(conv._id, conv)`.
3. Sync session `messageCount`/`updatedAt`.
4. **No embed fire** (keeps today's PUT behavior). Flag: consider whether a replace that introduces messages missing from nVDB should re-embed (currently it does not — a latent gap; open question).

## 2.4 Callers that must switch

| Caller | Current behavior | Switch to |
|--------|------------------|-----------|
| `POST /api/chats/:id/messages` (server.js:1568) | inline append+embed | `appendConversationMessage(ctx, body)`; route keeps auth/readBody/response only |
| `PUT /api/chats/:id/messages` (server.js:1691) | naive `map(m => ({...m, idx}))` | `replaceConversationMessages(ctx, messages)` (normalization shared) |
| Runner run loop — `msg.user` append (arch §2.1 step 1) | n/a (new) | `appendConversationMessage(ctx, storedForm)` |
| Runner run loop — assistant persist (arch §2.1 step 4) | n/a (new) | `appendConversationMessage(ctx, storedForm)` |
| Runner tool persist (arch §2.1 step 5) | n/a (new) | `appendConversationMessage(ctx, toolStoredForm)` |
| Runner **variant** persist (arch §2.4) | n/a (new) | `appendMessageVariant(ctx, { messageId, variant })` |
| Runner **snapshot densify** | n/a (new) | reuse `normalizeStoredMessage` (or a `densifyAttachments` split) so the snapshot matches the GET path |
| Embed reconciliation / drain loop (server.js:220–290) | calls `embedMessageAsync` directly | unchanged — it already targets the message+conv+idx; keep as the low-level embed entrypoint that `append*` calls |

## 2.5 Flags / open questions

- **Embed duplicates:** `appendMessageVariant` fires an embed for the new variant; ensure the vector payload carries the variant index (`{ chatId, msgIdx, variant }`, §2.4) so variants don't collide in nVDB.
- **PUT replace re-embed gap:** today a messages-replace does not re-embed; if the runner ever replaces (rename/summary edits don't, but a client edit of content does), confirm whether content edits should re-embed. Leave as-is for PA (no behavior change).
- **`rawContent`:** in the POST path `rawContent = content`; the runner must keep `rawContent` mirroring the **stored** content (with timestamp prefix if any), while `content` in the *view form* is stripped. Decide whether the stored user message retains the timestamp prefix in `content` (keeps old-client compat) — recommended yes, and the runner strips it only when building the view/snapshot.

*End of spec.*
