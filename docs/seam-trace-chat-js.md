# Seam Trace — chat.js (render / orchestrate boundary)

**Date:** 2026-08-24
**Branch:** `bff-rework` · **Dev:** :8082
**Purpose:** locate the render/orchestrate boundary in `chat/js/chat.js` so the
PC rewire can feed the *existing* renderer from the runner stream without
disturbing rendering (per [plan-pc-realign.md](plan-pc-realign.md) step 1).
**Companion to:** [codebase-survey-bff.md](codebase-survey-bff.md),
[refactor-deep-dive-report.md](refactor-deep-dive-report.md).

`chat.js` = 351 KB / 6730 lines / ~144 top-level functions, one shared scope.
All functions close over the same module-level state (`conversation`,
`currentChatId`, `activeConversations`, `currentModel`, `models`, `elements`,
`chatHistory`, `mcpClient`, `client`, `imageStore`).

---

## 1. The two render paths (already duplicated)

Two near-identical builders produce the same user/tool/assistant DOM:

| Path | Function | Line | Caller |
|------|----------|------|--------|
| History rebuild | `buildExchangeElement(exchange)` | 1382 | `buildHistoricalDomForChat` (1288) → `switchChat` |
| Live append | `renderExchange(exchange, targetContainer)` | 4099 | `sendMessage` (user msg), elsewhere |

Both hand-build `userEl`, `toolEl`, `assistantEl` (innerHTML templates) and call
the same shared leaf functions: `createAssistantElement`, `updateAssistantContent`,
`finalizeAssistantElement`, `_applyEmbedStatusAttrs`, `_decoratePreviewToolButton`,
`_vsAppendMessage`. They differ only in small details (history path escapes tool
content, live path uses `textContent`; live path wires lightbox clicks). This
duplication is a candidate for the extraction to unify — but unification is
behavior-preserving only if done mechanically, one path at a time.

## 2. Render pipeline (SURVIVES — this is the "view")

These read exchange-shaped data and write DOM. They have **no upstream
network calls** and (almost) **no persistence**:

- `createAssistantElement` (4294) — assistant bubble skeleton + action-button binding.
- `updateAssistantContent` (4989) — incremental streaming render: thinking block
  + `nui-markdown` begin/append/end stream, dedup keys, scroll preservation.
- `forceFinalizeMarkdownStream` (5209) — drains a trailing partial markdown block.
- `finalizeAssistantElement` (5269) — finalize + usage/context + version controls.
- `updateUsageDisplay` (4347), `updateOverallContext` (4418) — token gauge.
- `showPendingToolUI` (4536), `showError` (5242), compaction indicators (5218–5242).
- Tool-bubble + user-bubble builders (inline in both §1 paths and `handleToolExecution`).
- Virtual scroller `_vs*` (3448–4032) — detached-element recycler, `_vsAppendMessage`,
  `_vsRemoveExchangeDom`, `_vsWake`, `_vsUpdateVisible`.
- Embed-status: `setEmbedStatus` (4889), `_applyEmbedStatusAttrs` (4896),
  `connectEmbedEvents` (4908), `_applyEmbedEvent` (4939).
- `toggleThinking` (window), `updateVersionControls` (5345), `getAssistantPlainText` (5380).

**Ambient state the renderer reads (must be threaded or shared on extraction):**

| Symbol | Used by |
|--------|---------|
| `conversation` (global) | `deleteExchange`, `getExchange`, `_lastChunkStats` in `updateUsageDisplay` |
| `models` / `currentModel` | `updateUsageDisplay`, `updateOverallContext` |
| `elements` | `updateOverallContext`, `sendMessage` |
| `window.nui.util.markdownToHtml` | `updateAssistantContent` history branch |
| `chatHistory` | model lookup in several paths |
| `startEditMode`, `toggleTts`, `regenerate`, `switchVersion`, `copyMessageToClipboard` | action-button handlers |

## 3. Orchestration (RETIRES — moves to the runner)

- `sendMessage` (2630) — but *splits*: vision pipeline, title update, model
  tracking, attachment handling stay or move with the channels; the actual
  "send + stream" becomes `POST /api/chats/:id/send`.
- `streamResponse` (2976) — the gateway SSE loop (`client.streamChatIterable`)
  + tool recursion. This whole `for await (event …)` is replaced by the
  `/api/chats/:id/events` attach.
- `handleToolExecution` (4570) — tool routing + execution + recursion.
- `executeLocalTool` (357), `executeBrowserFetch` (803), `executeAttachmentSave` (969).
- `getSystemPromptWithMetadata` (2569), `buildMetadataPrefix` (2553),
  `buildMcpResourceContext` (2790).
- Vision: `getVisionToolName` (2753), `areVisionToolsAvailable` (2765),
  `callVisionMethod` (2772), `autoCreateVisionSessions` (2834).
- `conversation.js` (separate file) — the state machine, `getMessagesForApi`,
  `addExchange`, `_syncMessage`, `_syncFullState`.

## 4. THE crux — form mismatch

The renderer consumes **`Conversation.exchanges[]` form**:

```
exchange = {
  id, type: 'tool' | (user+assistant pair), timestamp,
  user:  { content, attachments: [{name, blobUrl, dataUrl}] },
  tool:  { name, args, status, content, images[] },
  assistant: { content, reasoning_content, isStreaming, isComplete,
               embedStatus, embedError, versions[], currentVersion,
               model, usage, context, streamStats }
}
```

The runner emits **stored form** (the nDB conversation doc): `role`, timestamp-
prefixed `content`, `toolName/toolArgs/toolStatus/toolImages`, `reasoning_content`,
`thinking_signature`, `usage`, `context`, `streamStats`, `embedStatus`.

These two shapes are **not the same**. The runner emits stored form, but
`chat/`'s renderer expects exchange form. So "feed the
existing renderer" requires one of:

- **(a) A thin projection layer** — map runner snapshot/events → exchange-form
  objects, keep a minimal client-side `Conversation`-shaped mirror. Renderer
  untouched. This is the smallest change to the load-bearing UI.
- **(b) Adapt the renderer** to consume stored form directly — higher risk to
  the load-bearing code, contradicts "do not rewrite the renderer".

Decision (a) is the default. The event names also don't match — gateway emits
`delta/compaction/error/aborted/done/progress`; the runner emits
`snapshot/run.start/delta/tool.start/tool.end/msg.assistant/msg.user/run.end/
embed.status/error`. A mapper (runner event → renderer calls) sits in the same
projection layer.

## 5. Recommended cut (for the extraction step)

Split `chat.js` into **three** modules, mechanical and behavior-identical:

1. **`render.js`** — everything in §2 (the render pipeline + virtual scroller +
   embed-status + thinking toggle + version controls). Input: exchange-form
   objects + a callbacks object (edit/delete/tool-action/toggle). No imports of
   `client-sdk`, `mcp-client`, `conversation`.
2. **`orchestration.js`** (temporary holding area) — `streamResponse`,
   `handleToolExecution`, local tools, vision, system-prompt assembly. This is
   what *retires*; grouping it makes the retirement visible.
3. **`chat.js`** (controller) — `sendMessage`, `switchChat`, history/export/import,
   settings/presets/admin, the `init()` wiring. Coordinates render + orchestration.

Cut order (each step compiles and renders identically before the next):
1. Extract `render.js` (leaf functions + their helpers) — highest value, lowest risk.
2. Extract `orchestration.js`.
3. Re-point `chat.js` at the two new modules.

> The three-way split is for the *rewire* step; it does **not** itself move any
> logic server-side. Retirement happens channel-by-channel afterward.
