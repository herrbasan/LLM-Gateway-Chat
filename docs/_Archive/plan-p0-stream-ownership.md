# P0 Design — Server-Owned Chat Stream (retrofit plan)

**Source:** deepseek-flash-chat planning session (relayed), 2026-08-23.
**Verification:** citations spot-checked by primary. Survey correction confirmed: `BackendClient` constructor defaults `baseUrl=''` (api-client.js:3); the `http://localhost:3500` fallback is the instantiation at the file bottom (api-client.js:272–274) and chat.js:39. Substance of the survey's point unchanged.
**Status (2026-08-23): SUPERSEDED as the P0 plan.** Direction pivoted to the conversation-runner architecture (see plan-backend-routed-refactor.md). Kept as design input: §4's persistence-format insight (proxy body is API-format, not stored form), the citation map, and the stream mechanics all informed the runner design.

---

## 1. New routes (all cookie-auth via `requireAuth`, all in the `routes` object, server.js:2127)

The router matches `'METHOD /path'` by exact part-count (server.js:2140-2146) — these part-counts are all distinct, no conflict. CORS already allows `DELETE` (server.js:2074).

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/proxy/chat/completions` | Start the relay. `requireAuth`→`{user, dbInstance}`. Open upstream fetch to gateway + `/v1/chat/completions`, Bearer `GATEWAY_API_KEY`. Register a stream record, **prepend an `event: proxy\ndata:{streamId,offset:0}` frame**, then relay the gateway's SSE verbatim to the POST's response. |
| `GET` | `/api/proxy/chat/completions/:streamId?offset=N` | Re-attach. Replay buffered `events[offset..]`, then live-tail. Unknown/completed → 404/`{status:'completed'}`. |
| `DELETE` | `/api/proxy/chat/completions/:streamId` | **Explicit user abort.** Abort upstream fetch, drop buffer, mark `status:'aborted'`, persist nothing. |
| `GET` | `/api/proxy/streams?sessionId=X` | List `status:'running'` streams for the session → the re-attach trigger after a refresh. |

**Gateway key moves server-side.** `localStorage['gateway-api-key']` + `gateway-url` stay as an opt-in direct-debug override (survey H7).

## 2. Buffer / registry structure (in-memory, new module e.g. `server/proxy-stream.js`)

```js
const registry = new Map();                    // streamId -> StreamRecord
{
  streamId, userId, sessionId, exchangeId,
  status: 'running'|'completed'|'aborted'|'failed',
  controller,                                 // AbortController for the upstream fetch
  events: [ { seq, frame } ],                 // faithful SSE frames; seq = offset index
  content: '', reasoningContent: '',          // accumulated for the persisted assistant write
  toolCalls, usage, context, thinkingSignature, finishReason,
  consumers: Set<res>,                        // POST client + any re-attachers
  createdAt, updatedAt
}
```

- **`events[]` must be a faithful replay of the gateway SSE** — the client reconstructs `content`/`reasoning_content`/`tool_calls` by accumulating `delta` frames (client-sdk.js:166-196). Gaps would silently corrupt the resumed bubble.
- **Eviction:** TTL (~30 min) + drop the record after completion-persist.
- **Copy the `embed-events` framing/keepalive/cleanup** (server.js:852-882): `writeHead text/event-stream`, `:ok`, 15s keepalive, `req.on('close')` cleanup.

## 3. Abort vs tab-kill (survey H2 — the core ambiguity)

| Signal | Meaning | Server behavior |
|--------|---------|-----------------|
| `DELETE` streamId | user abort (Stop button, chat.js:6624→6626) | abort upstream, drop buffer, **don't persist** |
| SSE `req.on('close')` | tab-kill (or tab switch) | **NOT abort** — keep relay + buffer, persist assistant on completion |

## 4. Persistence ownership (one deliberate spec deviation)

Spec says "persists the user message on receipt **and** the assistant message on completion." **Recommend: server persists ONLY the assistant; client keeps authoring user + tool messages.** Reasons:

- The proxy body's `messages` array is the **API-format** form (image_url parts injected, getMessagesForApi, conversation.js:553+), *not* the raw stored form (`contentWithTimestamp` + attachments manifest, conversation.js:334). Persisting it would corrupt the stored user message.
- No acceptance impact: the user message is persisted by the client *before* streaming begins (conversation.js:334) with the crash-net guard (conversation.js:22-190).

Server appends the assistant **on completion** via the same code path as `POST /api/chats/:id/messages` (server.js:1588+) — refactor the append + `embedMessageAsync` fire (server.js:1687-1693) into a shared helper so the proxy completion-persist also fires embed. On `finish_reason:'tool_calls'`, the server persists the assistant *with* `tool_calls`; the browser then executes tools and issues a fresh proxy POST per follow-up exchange.

## 5. Re-attach protocol

1. On chat load, client `GET /api/proxy/streams?sessionId=X` → running streams.
2. For each running stream whose exchange lacks a persisted assistant, client opens `GET /api/proxy/chat/completions/:streamId?offset=0`, feeds it through the same SSE parser (client-sdk.js:136-241), rebuilds the assistant bubble live.
3. **Offset is 0, not a remembered position** — after a refresh the DB has no partial assistant, so replay-from-0 reconstructs it exactly.
4. The client re-attaches **only `status:'running'` streams**. Completed assistants live in DB; this avoids double-persist.

## 6. Callsites that change

**Browser:** client-sdk.js:131-133 (POST URL → proxy, `credentials:'include'`, stop gateway Bearer); client-sdk.js:136-241 (parse leading `event: proxy` meta frame); new `resumeStream`/`listRunningStreams`; client-sdk.js:247-255 (abortStream also DELETEs); chat.js:40 (`GATEWAY_URL = CONFIG.gatewayProxyUrl ?? ''`); chat.js:3107-3157 (wrap requestBody with `proxy:{sessionId, exchangeId, model}`); chat.js:3180 (re-attach on load); chat.js:3360 / conversation.js:391-449 (`setAssistantComplete` skips `_syncMessage('assistant')` when server-owned); chat.js:6624-6626 (abort → DELETE); server.js:2160-2177 (config gen adds `gatewayProxyUrl`).

**Arena (P1):** excluded. Two direct GatewayClient uses (arena.js:114, 1104) — same proxy route works, but arena has no per-exchange ownership model matching chat's — deferred.

## 7. Problematic parts — ranked, with mitigations

1. **Assistant double-persist** → server-owned flag in `setAssistantComplete`; re-attach only running streams.
2. **Re-attach trigger after refresh** — `_streamRegistry` is in-memory → `GET /api/proxy/streams` drives re-attach; offset=0.
3. **StreamId from the single POST** races first tokens → prepend `event: proxy` meta frame.
4. **Abort-vs-kill ambiguity** → explicit DELETE = abort; close = keep. Orphan risk bounded by TTL + persist-regardless.
5. **Buffer memory / restart durability** → TTL + event cap + drop after persist. Documented limitation: server restart mid-stream loses the partial assistant.
6. **Cookie auth on SSE POST** — current fetch sends no credentials → `credentials:'include'`.
7. **Gateway key routing** → server-side, localStorage override kept for debug.
8. **Embed on completion-persist** → shared append + `embedMessageAsync` helper.

**On H1 (tool execution browser-driven): agreed — keep it.** `executeLocalTool` routes to browser-bound tools; the tool-result backfill + recursion is woven into the `Conversation` state machine (conversation.js:553-668).

## 8. Open decision

User-message authoring split (§4) is the one deliberate deviation from spec §P0.2.
