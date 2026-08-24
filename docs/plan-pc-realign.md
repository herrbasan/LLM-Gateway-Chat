# Plan — PC: Connect the Existing UI to the Runner (Preserve the UI)

**Date:** 2026-08-24
**Branch:** `bff-rework` · **Dev port:** :8082 · **Live:** :8080 (`D:\SRV`)
**Supersedes:** the "build a new view" interpretation of PC (the `view/` folder). Read
[handover-2026-08-24-session2.md](handover-2026-08-24-session2.md) for prior state.
**Design authority:** [architecture-conversation-runner.md](architecture-conversation-runner.md) · **Map:** [codebase-survey-bff.md](codebase-survey-bff.md) · **Tangle detail:** [refactor-deep-dive-report.md](refactor-deep-dive-report.md)

---

## Decision (this is the point — do not re-litigate)

**The `chat/` UI is the app. The refactor connects a DIFFERENT BACKEND to the existing UI.
It does NOT build a new UI.**

The `chat/` UI — its HTML/CSS/JS and its *usage patterns* — must stay **largely the same** and
keep producing the same interactions. It took a lot of work to get right, and the patterns are
load-bearing even when their reason isn't obvious.

### THE RULE (non-negotiable)
> **Do NOT rewrite, simplify, or "clean up" the UI renderer, even when a pattern's purpose is not
> fully understood. Treat the UI code as load-bearing. Never re-implement it.**

The ONLY thing that changes is the **data plumbing** — the backend the UI talks to.

## What is PRESERVED (unchanged)

Everything in `chat/` that renders and interacts:

- **nui_wc2 components** — `nui-app`, `nui-list` (sidebar: sort by Date/Title/Messages, search,
  category filter, virtualization), `nui-markdown` (incremental streaming), `nui-select`,
  `nui-slider`, `nui-dialog`, `nui-lightbox`, `nui-rich-text`.
- **Virtual scroller** — `.vs-stage`, detached-element recycler, absolute `top` positioning,
  `VS_MIN_ITEMS=30`, recycled on scroll. (chat.js ~3431–3560.)
- **Per-message header** — `model · timestamp · embed-status · streaming-indicator ·
  context-usage-display` (e.g. `140.7K / 1M Tokens | 12340ms TTFT`).
- **Thinking blocks** (collapsible), **tool bubbles** (`data-mcp-tool-name`), attachments,
  input bar (attach/send), config tabs (Model/User/System/MCP/TTS with temp/thinking/max-tokens).
- The look AND the behavior. Every interaction pattern.

## What is SWAPPED (the only change)

The browser stops orchestrating; the server-side ConversationRunner owns the conversation.
The UI becomes an attach/detach view:

| Concern | Today (browser) | After (runner) |
|---------|-----------------|----------------|
| Send message | `GatewayClient` → gateway | `POST /api/chats/:id/send` |
| Receive stream | direct SSE from gateway | attach `GET /api/chats/:id/events` (snapshot + live events) |
| Tools | browser `mcp-client` + `executeLocalTool` | server `mcp-pool` + `internal-tools` (PB-a/PB-b, done) |
| Conversation state | `conversation.js` state machine + localStorage | `server/runner.js` single-author |
| Persistence | `BackendClient` per-message PUT/POST | runner persists as side effect |

### Retire as each channel moves server-side
- `chat/js/client-sdk.js` (`GatewayClient`)
- browser `chat/js/mcp-client.js`
- `chat/js/conversation.js` state machine

Retiring these **is** the "`chat/js/` shrinks to a view" end state.

## The one difficulty the deep-dive flags (read before touching)

`chat.js` is a **~7000-line client-centric monolith** where render logic is interwoven with
orchestration (deep-dive §1.2, G2/H1). The rewire must find the **render/orchestrate boundary**
and feed the *existing renderer* from the runner stream — it must NOT disturb rendering.

Commands guiding the rewire, channel by channel, are in `codebase-survey-bff.md` (the 8
browser→upstream channels and every callsite).

## Where we are

- **Server-side: DONE and E2E-verified.** Runner (single-author, event stream, run loop,
  12-hop cap, abort, idle unload, embed bridge), `api-view` (stored→API form, chunk transform,
  `{messages, chunkTable}`), `system-prompt` (byte-faithful, archive block + memory reminder on),
  `mcp-pool` (per-user, dual-path JSON-RPC, storage origin), `internal-tools` (archive/search/
  browser_fetch/attachment_save/retire), delete + edit routes, `/api/models` proxy.
- **`view/` = DETOUR.** A minimal UI I built from scratch before this direction was clear. It is a
  disposable **reference/harness** for the runner's event/route contracts — NOT the product. Do
  NOT extend it.

## Events the runner emits (the contract the existing UI must consume)

`snapshot`, `run.start`, `delta` (`{content, reasoningContent}`), `tool.start`, `tool.end`,
`msg.assistant`, `msg.user`, `msg.deleted`, `msg.variant`, `run.end` (`{finishReason, usage,
context, aborted, messageId}`), `error` (`{code,message}`), `embed.status`.

Rest endpoints: `POST /api/chats/:id/send`, `POST /api/chats/:id/abort`,
`POST /api/chats/:id/variant`, `DELETE /api/chats/:id/messages/:messageId`,
`PATCH /api/chats/:id/messages/:messageId`, `GET /api/chats/:id/events` (SSE).

## Gotchas (don't relearn)

- snapshot shape: `{ meta: {title, systemPrompt, …}, messages, inFlight, lastRun }` — NOT `{ session }`.
- auth check: `GET /api/auth/session` (there is no `/api/auth/me`).
- `msg.user` event payload **is** the message directly (not `{message}`).
- server sessions invalidate on EVERY restart → re-login (creds in `.env`).
- `nui-markdown` static render: set `textContent` BEFORE append (connectedCallback reads once,
  `_processed` guard).
- `runner.js` is the single author of conversation state; views attach/detach over SSE.
- Ordering invariant: in-flight assistant persists at its RESERVED idx; aborted runs persist
  content only; API view drops `reasoning_content` without `thinking_signature`.

## Next steps

1. Trace the seam in `chat.js`: where it builds `requestBody` and calls `GatewayClient`
   (`streamResponse` ~2976, `sendMessage` ~2820s) and how it renders a message
   (`appendChatMessage` / the `.chat-message` builder). Map exactly what feeds the renderer.
2. Rewire send to `POST /api/chats/:id/send`; feed the renderer from `/api/chats/:id/events`.
3. Verify the existing UI renders runner data identically (visual + interaction parity, not
   just DOM). Use `view/` as the behavioral reference for the event contract.
4. Only then retire orchestration channel by channel.
