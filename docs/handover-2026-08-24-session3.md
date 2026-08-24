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

## Still open (one item)

1. **Regenerate + assistant-edit** — the runner has no regenerate method (append a variant +
   re-run the turn) and no assistant-edit (only user messages are editable). `regenerate` and
   assistant `commitEdit` are currently no-ops (`console.warn`). Build the runner methods
   (server-side, in `server/runner.js` + routes), then wire `regenerate` and assistant edit.
   Everything else in the PC realign is done and committed.

## Landed since the first cut (verified E2E on :8082)

- **Tool rendering** — `_runnerToolStart`/`_runnerToolEnd` + `_runnerToolBubble`/`_runnerFinalizeTool`
  render `tool.start`/`tool.end` bubbles (Running → Success/Failed, args/result/images). The
  follow-up assistant keys to the LAST tool exchange (matches `messagesToExchanges` grouping).
- **Delete / edit / variant** — routed through the runner (single-author). Delete → `msg.deleted` →
  `_runnerRefresh` (re-attach → snapshot re-render). Edit → runner broadcasts `snapshot` → re-render
  + re-run. Variant → `msg.variant` → local content update. The snapshot handler now always
  re-renders (initial attach AND post-mutation).
- **Retired ~2000 lines of dead orchestration** — `streamResponse`, `handleToolExecution`,
  `executeLocalTool`, `executeBrowserFetch`, `executeAttachmentSave`, the vision pipeline, the
  system-prompt builder, and the tool-definition constants. `chat.js` is now ~4972 lines (was ~7000).
  Kept `getVisionToolName`/`areVisionToolsAvailable` (live via the vision toggle).
- **Fixed orphaned-assistant bug** — `runner.deleteMessage` now cascade-deletes the whole turn when
  deleting a user message (was leaving an orphaned assistant → gateway 400 on the next send).
- **Attachments verified** — base64 → bucket upload → `/send` → snapshot densifies to a bucket URL;
  image renders with no base64 leak. `embed.status` maps to the exchange via `_runnerEmbed`.

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
