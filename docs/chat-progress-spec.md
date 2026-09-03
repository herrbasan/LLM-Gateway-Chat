# Spec: chat session progress in the chat UI

**Status**: APPROVED for implementation (owner 2026-09-03)
**Repo**: LLM-Gateway-Chat · **Depends on**: mcp_server `chat.status` (live, smoke-tested)
**Author**: Kimi K3 · **Implementer**: GLM 5.3

## 1. Problem

When the chat app's model calls `chat.send` on the workshop MCP server, the call
blocks inside `executeToolCalls` (server/runner.js) until the session's whole
tool loop finishes — sometimes 30s+ of multi-hop work. The human watching the
chat sees `tool.start` and then silence. The MCP server already exposes live
activity via `chat.status` (in-memory registry: phase, hops, currentTool,
tokensSoFar, lastEvents ring buffer) — but nothing polls it.

## 2. Design

Poll `chat.status` from the runner **while a `chat.send` dispatcher call is in
flight**, and broadcast each poll result as a new runner event `chat.progress`.
The frontend renders the newest activity line under the tool indicator.

### 2.1 Server side — server/runner.js, `executeToolCalls`

Detection: the tool call is the workshop dispatcher (name === `'tools'` or
`name.endsWith('__tools')` — same scan as the auto-vision block) **and** its
parsed args have `method === 'chat.send'`. All other tool calls behave exactly
as before.

While awaiting that one `pool.callTool`:

```text
poller = every 2000ms:
    result = await pool.callTool(dispatcher, { method: 'chat.status', payload: {} })
    parse text → { sessions: [...] }
    broadcast('chat.progress', { sessions, messageId: f.messageId, exchangeId: f.exchangeId })
```

- Poll **without** a `name` — nested sends (A→B) produce entries for several
  sessions; the UI wants them all.
- First poll fires immediately (not after 2s) so the human sees something fast.
- When the `chat.send` call settles: stop the poller, then broadcast one final
  `chat.progress` with `{ done: true, sessions: <last known> }`.
- **Boundary tolerance with a trace**: a failed poll (MCP hiccup, parse error)
  logs a warning and the poller continues — it must never reject the tool call
  it watches. The poller wraps each tick in try/catch.
- The poller is per-`chat.send`-call. Two concurrent sends in one tool batch →
  two pollers; that's fine (each clears its own interval).
- No new config. Poll interval is a module constant `CHAT_STATUS_POLL_MS = 2000`.

### 2.2 Event plumbing

`broadcast()` already multiplexes runner events into the user-level stream
(`/api/events` as `r.<name>`). No server-side plumbing beyond the new event
name is needed, but register `'chat.progress'` in `EVENT_NAMES` in
chat/js/runner-client.js or the frames never reach handlers.

### 2.3 Frontend — chat/js/chat.js (handler registration near :345)

Add a `chat.progress` handler that renders a single status line under the
in-flight tool block (same place `run.status` phases show):

- Show the most recent `lastEvents` entry per non-idle session, one line each:
  `⟨name⟩: hop 3: browser.research ok (4.2s)` — plus `tokensSoFar` when > 0:
  `⟨name⟩: hop 3 … · 12.4k tok`.
- On `{ done: true }`, freeze the last lines (they get replaced by `tool.end`
  rendering naturally).
- Keep it plain text, same visual weight as the existing phase line — no new
  CSS framework, no spinner components. One `<div>` reused/updated per event.
- Reconnect/snapshot: progress lines are ephemeral — do NOT persist or restore
  them. `tool.end` is the durable artifact.

## 3. Non-goals

- MCP `notifications/progress` (progressToken path) — that's for the *calling
  model's* client; this spec is for the human's UI. Both can coexist.
- Persisting activity. The registry is in-memory on the MCP server; progress
  lines in the UI are ephemeral.
- Per-session filtering in the UI. Show all active sessions; nested sends are
  the interesting case anyway.

## 4. Verified facts (read this session, no re-exploration needed)

- `executeToolCalls` is at server/runner.js:779; the `pool.callTool` await is
  at :795; `tool.start` broadcast at :790; `tool.end` at :817.
- Dispatcher detection precedent (auto-vision): server/runner.js:484-489 —
  scans `pool.registry.keys()` for `'tools'` / `endsWith('__tools')`.
- `_status(phase, message)` (:247) broadcasts `run.status` — precedent for
  phase lines; `broadcast(event, data)` at :238 multiplexes via
  `DEPS.emitUserEvent`.
- runner-client.js EVENT_NAMES at chat/js/runner-client.js:21 — add
  `'chat.progress'` there.
- chat.js registers its runner handlers near :345 (found via `run.status`).
- `chat.status` response shape (verified on the live server):
  `{ ok, sessions: [{ name, phase, hops, currentTool, startedAt, updatedAt,
  tokensSoFar, lastEvents: <count> }] }` — nameless form returns
  `lastEvents` as a COUNT. For the event strings the UI renders, poll with
  `{ name }` per active session OR change nothing and render
  `phase`/`currentTool`/`hops`/`tokensSoFar` only. **Decision: render from
  the summary fields** (`⟨name⟩ — phase · hop N · currentTool · N tok`);
  skip per-session detail polling (N extra MCP calls per tick is wrong).
  The nameless summary is enough for a status line.

## 5. Acceptance test

1. Human asks the chat model something that makes it call `chat.send` with a
   multi-hop task (e.g. "ask your kimi session to research X").
2. While the session works: the UI shows updating lines —
   `smoke-a — tool-call · hop 3 · browser.research · 9.2k tok` — refreshing
   ~every 2s without user action.
3. When the send returns, `tool.end` renders as before; progress line freezes
   then clears with the tool block.
4. Non-chat.send tool calls show no progress lines (no regression).
