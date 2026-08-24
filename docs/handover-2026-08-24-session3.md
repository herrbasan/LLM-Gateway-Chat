# Handover — 2026-08-24 (session 3: PC realign LANDED — `chat/` rewired to the runner)

**Branch `bff-rework`.** Supersedes and replaces `handover-2026-08-24-session2.md`
(deleted — its `view/` detour and "build a new view" interpretation are gone).

## The direction (settled, do not re-litigate)

**The `chat/` UI is the app.** The BFF refactor connects the server-side ConversationRunner
to the EXISTING `chat/` UI — it does NOT build a new UI. The renderer is load-bearing and
untouched; only the data plumbing changed: send → `POST /api/chats/:id/send`, render ←
`GET /api/chats/:id/events`. See [plan-pc-realign.md](plan-pc-realign.md) for the full decision.

## What landed this session (all E2E-verified on :8082)

- `chat/js/runner-client.js` (new) — same-origin SSE attach + REST (`send` / `abort` /
  `switchVariant` / `deleteMessage` / `editMessage`). The runner event contract (§ below)
  is the source of truth.
- `messagesToExchanges()` (new export in `chat/js/conversation.js`) — stored-form → exchange-form
  projection the renderer consumes. Reuses `_backendMessagesToExchanges` grouping; preserves
  `_userMsgId` / `_asstMsgId` / `_toolMsgId` for delete/edit/embed mapping.
- `chat/js/chat.js` — `switchChat` / `init` / `startNewChat` attach to `/events` (snapshot →
  `buildHistoricalDomForChat`); `sendMessage` → `runnerClient.send`; event handlers
  (`_runnerUser`/`RunStart`/`Delta`/`Assistant`/`RunEnd`/`Error`/`Embed`/`ResumeInflight`) drive
  the existing renderer (`renderExchange` / `createAssistantElement` / `updateAssistantContent` /
  `finalizeAssistantElement`).

**Verified:** 125-message snapshot renders correctly (user/assistant/tool + timestamps + thinking
blocks); send → stream → persist round-trip; reload re-renders from the snapshot (runner owns
persistence — the client never writes messages).

**Bug fixed:** a debounced delta timer raced `run.end` nulling the in-flight element → guarded
with `if (s.el !== el || !el.isConnected) return`.

## Server-side (KEEP — unchanged, all E2E-verified in prior sessions)

Runner core (`server/runner.js`), `api-view.js`, `system-prompt.js`, `mcp-pool.js`,
`internal-tools.js`, `conversation-store.js`, delete/edit routes, `/api/models` proxy.
These are the contract; do not change them while completing the view side.

## Still open (follow-ups, in order)

1. **Tool rendering** — `_runnerToolStart` / `_runnerToolEnd` are stubs. Tools already run
   server-side; the view just needs to render the `tool.start`/`tool.end` bubbles.
2. **Delete / edit / regenerate / variant** — still on the old client path. Move them to
   `runnerClient.deleteMessage` / `editMessage` / `switchVariant` (single-author). Regenerate
   needs a runner route — confirm `switchVariant` semantics or add a regenerate op.
3. **Attachments / `embed.status` / vision** — attachment upload is wired into `sendMessage`
   (`imageStore.save` → bucket refs → `/send`); verify round-trip. `_runnerEmbed` maps
   `embed.status` → exchange. Vision is now server-side (the client vision pipeline retired).
4. **Retire dead orchestration** — `streamResponse`, `handleToolExecution`, `executeLocalTool`,
   the vision pipeline, `conversation.js` persistence methods (`_syncMessage`/`_syncFullState`/
   `save`), then `client-sdk.js` and browser `mcp-client.js`, channel by channel.

## Runner event contract (what the view consumes)

`snapshot` (meta + messages[] + inFlight + lastRun), `run.start {exchangeId, model, messageId}`,
`delta {content?, reasoningContent?}`, `tool.start`, `tool.end`, `msg.assistant`, `msg.user`,
`msg.deleted`, `msg.variant`, `run.end {finishReason, usage, context, aborted, messageId}`,
`error`, `embed.status {messageId, status, embedError, idx}`.

## Environment / gotchas (don't relearn)

- Dev: `npm start` in `D:\DEV\LLM-Gateway-Chat` → :8082. Live: `D:\SRV` master :8080 (keep working).
- Server sessions invalidate on restart → re-login (creds in `.env` as TEST_USER/TEST_PW).
- `attachRunnerEvents` is idempotent — background chats keep their stream; don't re-attach on switch.
- The runner is the single author. Never reintroduce client-side message writes.
