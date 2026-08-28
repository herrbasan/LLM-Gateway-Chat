# LLM Gateway Chat — Agent Instructions

> **This file governs the live repo** `D:\SRV\LLM-Gateway-Chat` on `master`, port 8080. The BFF refactor shipped 2026-08-28 (`bff-rework` merged into `master`); the old `D:\DEV` worktree workflow is suspended (its git admin points at a stale `.old` worktree — re-clone `D:\DEV` before resuming branch-based dev).

## Read First

1. The prime directive — core maxims, fail-fast, memory protocol. Applies fully.
2. [docs/plan-backend-routed-refactor.md](docs/plan-backend-routed-refactor.md) — the governing spec (GitHub issue #12).
3. [docs/architecture-conversation-runner.md](docs/architecture-conversation-runner.md) — the target architecture (design authority). The conversation is a server-side session; the browser is an attach/detach view.
4. `docs/codebase-survey-bff.md` — the channel × callsite map of the current client-centric code. Keep it updated as phases land; do not duplicate its call-shape tables into this file (snapshots drift, pointers don't).

## Operating Rules

- **Master IS live.** Work directly in `D:\SRV` on `master`; the server runs under nPM — coordinate stop/start with the user around backend edits and restarts.
- **Submodules: check for updates at the start of every work session.** Fetch in each of `lib/ndb`, `lib/nvdb`, `lib/nlogger`, `lib/nui_wc2` and fast-forward to the remote default branch; commit the pointer bump separately. Windows gotcha: a running server keeps ndb's napi `.node` binary locked — stop the server before updating `lib/ndb`, and load-test after: `node -e "require('./lib/ndb/napi')"`.
- Server does not auto-restart — restart after backend edits. A `Chat Backend running at …` log line means the process started, not that the command returned. Start servers in background; poll `/api/config` or `/health` for readiness (never an SSE endpoint — it hangs the request).

## Project Overview

Vanilla JavaScript SPA + own Node.js backend. No build step. Connects to an LLM Gateway for chat streaming and embeddings; persistence in embedded Rust DBs (nDB documents, nVDB vectors).

**The refactor:** today the browser orchestrates gateway, MCP, TTS, and persistence directly — eight browser→upstream channels (spec §1). Target: the ConversationRunner architecture — conversations are server-side sessions, the browser is a disposable attach/detach view, persistence is a side effect of the runner's traffic. **PC realign has LANDED (2026-08-24):** the existing `chat/` UI is now wired to the runner (`send` → `/send`, render ← `/events`); orchestration retires channel by channel. **Arena re-based on the server ArenaRunner (Phase D, landed e06f3dd, fix cluster 2026-08-26):** the arena conversation is a server-side autonomous session; `chat-arena/` is a spectator view. Remaining direct-gateway remnant there: summary generation + legacy import. Completed phase plans and session handovers are archived under `docs/_Archive/`.

## Technology Stack

| Layer | Technology |
|-------|------------|
| Language | Vanilla JS (ES2022+), HTML5, CSS3 — no TypeScript, no build |
| UI | NUI Web Components (git submodule `lib/nui_wc2/`) |
| Backend | Node.js raw `http` + hand-rolled router (`server/server.js`) — zero framework deps |
| Structured DB | nDB (Rust JSON-Lines store, submodule `lib/ndb/`) |
| Dead deps | `express` + `@seald-io/nedb` in package.json are never imported — remove in a cleanup pass |
| Vector DB | nVDB (Rust, submodule `lib/nvdb/`) |
| Embedding | Gateway `/v1/embeddings` (Qwen3-Embedding-4B, 2560d) |
| Transport | SSE to gateway + same-origin REST/SSE to backend |
| Logging | nLogger (JSON Lines) |

## Project Structure

```
├── chat/            # Main SPA (index.html, css/, js/)
├── chat-arena/      # Arena mode (LLM-to-LLM autonomous conversations)
├── lib/             # Submodules: nui_wc2, ndb, nvdb, nlogger; tts/
├── server/          # Backend: server.js (router+routes), runner.js, arena-runner.js,
│                    #   conversation-store.js, api-view.js, system-prompt.js, mcp-pool.js,
│                    #   internal-tools.js, embed.js, config.json, migrations (historical)
│   ├── data/        # nDB + nVDB files (gitignored, per-user subdirs)
│   └── logs/        # JSON Lines logs (gitignored)
└── docs/            # Governing spec + codebase survey
```

## Module Map (browser side)

| Module | Role |
|--------|------|
| `chat/js/chat.js` | UI controller + runner event handlers (`_runner*`): rendering, login, presets, admin; send → `/send`, render ← `/events` |
| `chat/js/runner-client.js` | same-origin SSE attach + REST (`send`/`abort`/`deleteMessage`/`editMessage`) + list-events sync (`attachListEvents`) — the view's only backend for a runner-owned conversation |
| `chat/js/client-sdk.js` | `GatewayClient` — SSE-over-REST to gateway. **Retiring** (the runner owns the gateway call) |
| `chat/js/api-client.js` | `BackendClient` — same-origin REST (cookie auth, `/api/chats`, `/api/search`, `/api/auth/*`) |
| `chat/js/conversation.js` | `messagesToExchanges` (stored→exchange projection). State machine / persistence / API formatting **retiring** |
| `chat/js/chat-history.js` | Multi-conversation management, backend CRUD, localStorage fallback |
| `chat/js/mcp-client.js` | MCP SSE connections, tool registry. **Retiring** — tools run server-side in the runner |
| `chat/js/file-store.js` | Attachment upload → `/api/buckets/images/…`, returns lightweight URLs |
| `chat/js/preview.js`, `preview-url.js`, `chunk-view.js` | Preview pane + chunk inspection |
| `chat-arena/js/arena.js` | Arena **spectator view** over the server ArenaRunner (snapshot + events via `/api/chats/:id/events`, start/stop/extend via `/api/arena/:id/*`). Legacy `Participant`/`Arena` classes (lines ~40–1165) are dead orchestration except: summary generation (`summarize`, direct `GatewayClient`) and legacy import — **cutover remnants** |

## Module Map (server side)

| Module | Role |
|--------|------|
| `server/runner.js` | ConversationRunner — single author of chat conversation state; gateway stream, tool loop, queued sends |
| `server/arena-runner.js` | ArenaRunner — autonomous N-participant runner variant; no tools; refreshes store state every turn; derives turn/speaker from history on (re)start |
| `server/conversation-store.js` | Shared stored-form authoring: append/insert-at/edit messages, session↔conversation resolution. nDB `find()` returns detached copies — **re-read at every use point, never cache across writes** |
| `server/api-view.js` | Stored → provider payload projection (ported `getMessagesForApi`), vision base64 inlining |
| `server/system-prompt.js` | System-prompt assembly (prime-directive blob + metadata + tool context) |
| `server/mcp-pool.js`, `internal-tools.js` | Server-side tool execution (MCP SSE pool + internal archive/storage/bucket tools) |
| `server/embed.js` | Embed pipeline: fire-and-forget, retry backoff, startup reconciliation, `embed.status` events |

## Invariants That Survive the Refactor

- **NUI components only** for UI controls (`nui-input`, `nui-select`, …) — never raw HTML controls. Style via theme variables (`--color-base`, `--text-color`, `--nui-accent`, `--nui-space`, …), not custom CSS on components.
- **Code style:** 4-space indent, single quotes, semicolons, ES6 modules. Flat explicit logic; dense colocation; minimal comments (structural markers only).
- **Data model:** one conversation document per session (`_type: 'conversation'`, inline `messages` array with per-message `embedStatus`). Vectors in nVDB keyed by message ID with `{ chatId, msgIdx }` payload. Users in `users_db` (scrypt-hashed, per-user `dbPath` isolation) — reconciled with nPort identity at P3.
- **Embedding pipeline** (server-side, stays): fire-and-forget after message POST, startup reconciliation nDB↔nVDB, SSE `embed-status` events, retry with escalating backoff.
- **Image lifecycle:** base64 intercepted client-side → bucket upload → lightweight URL in message JSON. On chat delete, refs are garbage-collected via `db.releaseFile` (orphans → `.trash`).
- **Tool execution is server-side** (runner `mcp-pool` + `internal-tools`); the view renders `tool.start`/`tool.end` events. The browser no longer runs tools, assembles system prompts, or orchestrates the gateway — it is a view over the runner's snapshot + event stream.

## Security

- Cookie-only auth (HttpOnly), same-origin by default, no secrets in frontend.
- `nui-markdown` escapes `& < >` before formatting, but attribute-value/URL-scheme hardening is a known gap owned by **nui_wc2** — don't build markdown sanitization here.
- nPort cutover (P2) binds services to localhost; public surface becomes 443 only.

## Visual Verification (UI changes)

Reach the target UI state in the integrated browser (`http://localhost:8080/chat/`), save a cropped element screenshot under `_scratch/`, then launch a subagent on model `minimax-m3-chat (customendpoint)` with the PNG path + a precise checklist. Trust DOM geometry for numbers; use the subagent for appearance (clipping, overlap, alignment). It can produce false positives — confirm with the DOM before acting.

## References

- Spec: [docs/plan-backend-routed-refactor.md](docs/plan-backend-routed-refactor.md) · Tracking: GitHub issue #12
- Gateway API docs live in the **LLM-Gateway** repo (`docs/api_rest.md` there) — the copy in this repo was removed as drift-prone.
- NUI: `lib/nui_wc2/Agents.md`, `lib/nui_wc2/LLM-CHEATSHEET.md`
- nDB / nVDB: `lib/ndb/AGENTS.md`, `lib/ndb/docs/`
