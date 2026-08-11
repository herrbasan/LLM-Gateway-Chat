# Plan: Tool Result Offload + Chain Supersede

Status: **Draft** — 2026-08-11
Scope: `chat/js/chat.js`, `chat/js/conversation.js`, `server/server.js`, `chat/js/file-store.js`

## Problem

Tool chains that operate on one artifact hold that artifact N times in conversation
history. Example chain on a single document:

```
storage.read  → tool result: full document (24 KB)
storage.write → tool result: full document (24 KB, v2)
preview render→ tool result: full document (24 KB, rendered)
```

Each tool result is stored verbatim in `exchange.tool.content`
([chat.js](../chat/js/chat.js) — tool completion handler), synced to nDB, and then
`getMessagesForApi()` ([conversation.js](../chat/js/conversation.js)) resends **all**
tool results in full on **every** subsequent request for the rest of the session.
The document exists 3× in every outgoing payload — and stays there forever.

Goal (user requirement): **the chunk of data exists in context exactly once** —
at its latest version. Earlier versions degrade to pointers.

## Industry Research (2026-08-11)

What existing tools do (full findings in workshop memory #1330):

| Tool | Strategy | Dedup of repeated versions? |
|------|----------|------------------------------|
| GitHub Copilot CLI | Tool output > 20 KiB → temp file, model gets path + preview. Auto-compaction (summarize history) at ~80% context. | No — offloaded copies accumulate |
| Claude Code | Context editing (trim stale `tool_result`s), programmatic tool calling (chain runs in sandbox, intermediates never enter history), tool search for definitions | No |
| Aider | Repo-map skeleton instead of full files; files added on demand, user can `/drop` | No |
| Cursor / Cline | Outline-only (Cursor) / send-everything-then-crash (Cline) — anti-patterns | No |

**Key finding: no existing tool supersedes stale versions of the same artifact in
history.** Everyone truncates, offloads (accumulating copies), summarizes, or
restarts. The chain-supersede mechanism in phase 2 appears to be novel — if it
works in practice, it's blog-post material.

## Design

Two composable phases. Phase 1 is mechanical and safe; phase 2 is the novel part
and layers on top.

### Phase 1 — Threshold offload (Copilot CLI pattern, extended from our image path)

We already do exactly this for images: base64 never enters history, it goes to the
nDB bucket and history holds a lightweight URL (image interception in
[chat.js](../chat/js/chat.js) tool completion). Extend the same pattern to text.

1. **Server: generic text bucket.** The `/api/buckets/:bucket/:filename` GET
   handler already exists; the PUT path (`PUT /api/chat-files/:exchangeId`)
   hardcodes an image extMap → store as `.bin`. Add a `text` path: accept
   `text/*` / `application/json` / `application/javascript`, store in a `files`
   bucket with the correct extension (`.md`, `.html`, `.json`, `.txt`, ...).
   GC comes free: chat deletion already walks message content for
   `/api/buckets/` URLs and calls `releaseFile`.

2. **Frontend: intercept on tool completion.** Where
   `exchange.tool.content = resultText` is set: if
   `resultText.length > TOOL_OFFLOAD_THRESHOLD` (start: 16 KB, make it a config
   value), upload via the new endpoint, then:
   - `exchange.tool.contentRef = <bucket URL>` — full text, out-of-band
   - `exchange.tool.content` stays the full text in memory/storage
     (UI replay unchanged — the tool bubble can still render everything)

3. **Payload-time substitution.** In `getMessagesForApi()`, when building a `tool`
   message: if `exchange.tool.contentRef` exists, emit head + tail + reference
   instead of the body:

   ```
   [Large tool result — 24,118 chars stored at /api/buckets/files/abc.md]
   --- head ---
   (first ~2000 chars)
   --- tail ---
   (last ~500 chars)
   [Fetch the full content via the URL above if needed.]
   ```

   The model keeps enough to reason about what the tool produced and has a
   resolvable URL (via `browser_fetch` / `storage.read`) if it needs the body.

Stored data is never mutated — offload affects only the outgoing API payload.

### Phase 2 — Chain supersede (the novel part)

When a later tool result is a **newer version of the same artifact**, earlier
versions collapse to stubs in the outgoing payload. The chunk travels in full
exactly once — its latest version.

**Identity rule (deliberately narrow):** match by declared target path in tool
args. A tool result is "the same artifact" as an earlier one when the tool call
args contain a `path` (or `filePath`, `filename`) value that matches the earlier
call's. This covers `storage.write` / `storage.replace` / `storage.append` /
file-writing forge tools — the chains that actually bloat sessions. No fuzzy
content hashing (generic but risky — false merges are context corruption).

Mechanism, all in `getMessagesForApi()`:

1. While building messages, record for each tool message: `(normalizedPath, index)`.
2. After the full pass, for every path seen more than once: rewrite all but the
   **last** occurrence to a stub:

   ```
   [storage.write → docs/x.md — superseded by a later version in this
   conversation. 24,118 chars stored at /api/buckets/files/abc.md]
   ```

3. The last occurrence keeps its full (or phase-1-offloaded) content.

Reads participate too: a `storage.read` of path P followed by a `storage.write`
of P means the read's snapshot is stale — collapse it as well. The read result
matters only if nothing newer exists.

**Failure-mode consideration (fail-loud, not silent):** superseding is lossy
context by design. If the model later needs to diff v1 vs v3, it must re-fetch
via the URL in the stub. That's correct (history is not a database), but it's a
behavior change — gate it behind a per-session toggle (default ON once proven)
and log each collapse to the console for observability.

### Phase 3 (optional, later) — Context editing

Claude Code's pattern: tool results older than N turns, already consumed by an
assistant reply, get trimmed from the outgoing payload entirely (stub only).
Composes with phases 1+2. Defer until 1+2 are measured.

## Implementation Points

| Change | File | Location |
|--------|------|----------|
| Text bucket PUT (accept text MIME, `files` bucket) | [server/server.js](../server/server.js) | `PUT /api/chat-files/:exchangeId` handler |
| Offload intercept on tool completion | [chat/js/chat.js](../chat/js/chat.js) | tool success path, `exchange.tool.content = resultText` |
| `fileStore.saveText()` (text upload, returns bucket URL) | [chat/js/file-store.js](../chat/js/file-store.js) | new method next to `save()` |
| Payload-time head/tail substitution | [chat/js/conversation.js](../chat/js/conversation.js) | `getMessagesForApi()` tool branch |
| Path extraction from tool args + supersede pass | [chat/js/conversation.js](../chat/js/conversation.js) | `getMessagesForApi()`, after message list built |
| Config: threshold + supersede toggle | [server/server.js](../server/server.js) dynamic config / `chat/js/config.js` | alongside existing defaults |

## Interaction with existing behavior

- **Auto-heal passes** (orphan tool_calls / tool results stripping) run on the
  message list — supersede stubs must keep `role: 'tool'` and `tool_call_id`
  intact so healing logic is unaffected.
- **Role-merge pass** never merges `tool` messages — unaffected.
- **`_sanitizeToolArgs`** already strips base64 from tool *args* — unaffected;
  phase 1 handles tool *results*.
- **Embedding pipeline**: tool messages are skipped by `embedMessageAsync` —
  offloaded content is not embedded for archive search. Acceptable (tool dumps
  are low-value search content); revisit if archive recall of tool output is
  missed.
- **UI replay**: tool bubbles render from `exchange.tool.content` (full text,
  still stored) — no UI change needed. Optionally render a "view full" link when
  `contentRef` exists instead of inline megabytes.

## Risks

- **False supersede merges** (same path, semantically different artifacts —
  e.g. write, delete, recreate). Mitigation: stub always carries the bucket URL,
  so nothing is unrecoverable; keep identity rule path-based only.
- **Model behavior change**: some models re-read earlier tool results instead of
  trusting the latest. Mitigation: stub text explicitly says where the latest
  version is ("see the most recent result for this path").
- **Provider validation**: stubs must remain valid `tool` messages with matching
  `tool_call_id` — covered by keeping structure identical, only `content` shrinks.

## Success criteria

- A read→write→render chain on a 24 KB document contributes ~24 KB + 2 stubs
  (< 1 KB) to every subsequent payload instead of 72 KB.
- Long MCP-heavy sessions (the workshop/storage workflows) show measurably
  smaller request bodies after ~10 tool calls.
- No provider 400s from malformed tool sequences (auto-heal still green).
- UI replay of old chats unchanged.

## If it works — the blog post

Angle: "Everyone truncates or summarizes tool history. Nobody dedupes it."
Copilot CLI offloads but accumulates; Claude trims but doesn't supersede;
Aider never sends files twice but has no tool-chain story. The artifact-identity
insight — *tool calls that declare their target path make version chains
detectable, so history can hold the chunk exactly once at its latest version* —
is the contribution. Measure before/after token counts on a real workshop
session for the headline number.
