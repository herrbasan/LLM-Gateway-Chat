# Report — MCP Tool Pipeline Slowness Investigation (2026-08-04)

**Status: RESOLVED — the pipeline is fast; the bottleneck was the orchestrating model (kimi-k3).**

## TL;DR

The perceived "storage.write takes forever" (sometimes ~1 min for ~50KB on a LAN) was **NOT
the transport, the storage, or the LAN**. Measured three independent ways, the MCP transport
is **6–550ms** per call. The ~100s the user felt was **kimi-k3's model-generation time between
tool calls** — the time it spends reasoning before emitting each tool-call JSON — which the
chat UI misattributes to the tool bubble ("Executing…"). With a fast model (deepseek-flash)
the exact same pipeline shows **6ms storage.write** and **2–5s gaps between calls**.

## How we measured

1. **Probe script** (`docs/probe-mcp-compact.mjs`) — drives the compact endpoint exactly as
   the chat app does: SSE connect → POST /message/compact → SSE response. All storage ops
   1–6ms server-side.
2. **Browser MCP trace** (`window.mcpClient._trace`, epoch-ms per request) — per-call
   transport duration + gaps between calls. This is the authoritative client-side timing.
3. **Gateway log** (`D:\DEV\LLM Gateway\logs\main-0.log`) — stream start/end per model.

## Measured numbers

| Workload | Model | Transport/call | Gap between calls |
|---|---|---|---|
| arena-summaries workflow | kimi-k3 | 300–550ms | **100–120s** |
| `llm.query` → DeepSeek | — | 47–56s (real generation) | — |
| controlled test (4 calls) | **deepseek-flash** | **6–330ms** | **2–5s** |
| `storage.write` (32B) | deepseek-flash | **6ms** | — |

## Root causes found & fixed (all verified live)

| # | Bug | Root cause | Fix |
|---|---|---|---|
| 1 | `storage.readMany` always "Unknown method" | Router did `COMPACT_TO_LEGACY[method.toLowerCase()]` but key is camelCase `"storage.readMany"` → never matched | Exact-match lookup first, then lowercase fallback (`D:\DEV\mcp_server\src\server.js`) |
| 2 | `saveToStorage:true` → 404 | Client POSTed to phantom `POST /api/storage/write` | Use real contract `PUT /storage/{path}` with raw body (`chat/js/chat.js`) |
| 3 | `PUT /storage/{path}` → 500 ENOENT | Handler didn't create parent dir (`sessions/` missing) | `fs.mkdirSync(path.dirname(target), { recursive: true })` (`D:\DEV\mcp_server\src\agents\storage\index.js`) |
| 4 | Failed sole tool call dead-ended conversation | `handleToolExecution` returned `null` → `toolExchangeIds` empty → `streamResponse` skipped → model never saw the error | Return `toolExchangeId` on failure so the stream resumes and feeds the error to the model (`chat/js/chat.js`) |
| 5 | Tool results truncated at 4KB → fragment-paging hell | `MAX_TOOL_CONTENT_API = 4096` bandaid (fix-attempt era) forced 10+ paged calls per session | Removed the cap — full results flow; session reconstruction now 1–2 calls (`chat/js/conversation.js`) |

**Result after fixes:** 3 arena sessions curated (#33, #34, #35) on a workload that
previously dead-ended repeatedly. Model confirmed: "full untruncated result — a big
improvement", "the error came back to me inline — the turn didn't stop".

## Secondary findings

- **Thinking toggle does NOT gate rendering.** The checkbox only changes the *request*
  (`enable_thinking` → gateway → `thinking: {type:'disabled'}` for anthropic-adapter models).
  `updateAssistantContent()` renders `reasoning_content` unconditionally — if a model
  generates thinking despite the toggle, it renders. User requirement satisfied.
- **kimi-k3 is slow regardless of thinking** — its ~100s/tool-call is intrinsic generation
  latency, not the toggle.
- **UI misattributes generation time to tools.** The pending tool bubble ("Executing…")
  renders as soon as the model starts streaming tool-call deltas, so model thinking shows up
  as a slow tool. The tool itself is ~300ms.
- **Watch: conversation bloat.** `getMessagesForApi()` resends all history every turn. The
  4KB bandaid was protecting against this; with the attachment pattern (saveToStorage URLs)
  large content stays out of history, but context grew to 180K tokens during the run.

## Services touched

- Chat app (frontend): `chat/js/chat.js`, `chat/js/conversation.js` — reload only.
- MCP server: `D:\DEV\mcp_server\src\server.js`, `src\agents\storage\index.js` — restart via
  nPM `agent_orchestrator`.
- LLM Gateway: untouched.

## Files

- Probe: `docs/probe-mcp-compact.mjs`
- This report: `docs/report-mcp-tool-pipeline-2026-08-04.md`
