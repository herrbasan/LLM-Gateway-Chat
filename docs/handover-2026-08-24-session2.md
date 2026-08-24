# Handover — 2026-08-24 (session 3: DIRECTION CORRECTION)

**Branch `bff-rework` @ `7068731`.** The PC direction changed — read `docs/plan-pc-realign.md`.

## DIRECTION (overrides session 2's "build a new view")

The BFF refactor **connects a different backend to the EXISTING `chat/` UI** — it does NOT build a
new UI. The `chat/` UI is load-bearing (nui_wc2 components, virtual scroller, per-message header,
thinking/tool/attachment rendering, config tabs, and all their usage patterns). **Never rewrite,
simplify, or "clean up" the renderer, even when a pattern's purpose isn't obvious.** Only the data
plumbing changes: send → `POST /api/chats/:id/send`; render ← attach `GET /api/chats/:id/events`.
Orchestration (client-sdk.js, browser mcp-client.js, conversation.js state machine) retires channel
by channel as the runner covers it — this is the "`chat/js/` shrinks to a view" end state.

**`view/` is a DETOUR — a disposable reference/harness for the runner's event/route contracts,
NOT the product. Do not extend it.** All of session 2's PC increments (the `view/` code) are
superseded by the realign plan.

## Prior server-side work — KEEP (all E2E-verified, unchanged by the direction correction)

- `b4d66cc` chunk-tombstone label fix + mcp-pool floating-promise crash guard (live-incident class).
- `f0c5398` PB-b internal tools port.
- `071527e` message delete, `47f04e9` message edit, `2b16889` context display, `23808c0` view core,
  `/api/models` proxy, dir-URL→index fix — the **server routes/endpoints** from these are still the
  contract; only the UI-side `view/` code is discarded.

---

# Handover — 2026-08-24 (session 2: PB-b E2E + PC view)

**Branch `bff-rework` @ `47f04e9`.** Supersedes `handover-2026-08-24.md` for the PB-b/PC sections.

## Session 1 recap (already landed)

- #14 FILES_DIR fixed on branch + live master (`7a238ab`), live restarted (stderr → `server/logs/live-stderr.log`).
- PB-b internal tools port (`f0c5398`): `server/internal-tools.js`, runner advertises internal + vision-filtered MCP tools, CONTEXT C rewritten, `buildApiMessages` returns `{messages, chunkTable}`.

## Session 2 — PB-b fully E2E-verified, two real bugs fixed

- `browser_fetch` (inline + bucket), `attachment_save` (server-to-server MCP storage PUT), `context_retire`/`unretire` all PASS E2E (`_scratch/probe-pbb2.cjs`, `probe-pbb3.cjs`).
- **Bug fix 1** (`b4d66cc`): `chunk-view.js` tombstones dropped the chunk label, so `context_unretire` was *impossible* — the label vanished with the content. Tombstones now re-register their label in `chunkTable` and name it in the text. Verified: retire −52% payload → unretire restored.
- **Bug fix 2** (`b4d66cc`): `mcp-pool.js` `rpc()` floating promise — a POST fetch hanging past the 120s tool timeout rejected a promise nobody awaited yet → unhandled rejection → Node 24 killed the server. **This is the same class as the live :8080 incident** (process died ~50s post-boot). Fix: interim `.catch` on the result promise + `AbortSignal.timeout` on the fetch. Plus process-level `unhandledRejection`/`uncaughtException` log-don't-die handlers in `server.js`. **Re-verify live for recurrence.**

## PC (view parity) — new view lives at `/view/`

Committed as four increments (all E2E-verified in the integrated browser):

1. `23808c0` — `view/` (`index.html`, `css/view.css`, `js/app.js`, `js/render.js`): login, archive sidebar, snapshot+stream render (NUI markdown, thinking blocks, tool UI, attachments, embed dots), send/abort, title/model/sysprompt edits. Server: `/api/models` proxy (60s cache), directory-URL→index fix (was `/view/` → EISDIR 500).
2. `2b16889` — context/usage top-bar gauge (snapshot `lastRun` + `run.end`, window-size aware).
3. `071527e` — message delete: `convStore.deleteConversationMessage` + `runner.deleteMessage` (broadcasts `msg.deleted`) + `DELETE /api/chats/:id/messages/:messageId`. Reindex verified.
4. `47f04e9` — message edit: `convStore.editUserMessageAndTruncate` + `runner.editMessage` (snapshot broadcast + re-kick) + `PATCH /api/chats/:id/messages/:messageId`. Truncate+rerun+regenerate verified; non-user edit rejected 404.

### View contract compliance (the five contracts, architecture §5)

- **Timestamp** — snapshot exposes `{content, timestamp}` separately; no strip-by-length. ✓
- **Keying** — DOM keyed by `messageId`/`toolCallId`. ✓
- **Versioning** — renders current variant; shows `vN/M` badge when variants exist. (Switch UI not yet built.) ✓/partial
- **System prompt** — view edits the user portion only, never assembles. ✓
- **Module boundary** — `render.js` is the single render module; `app.js` the only state holder (EventSource-driven). ✓

### View gotchas (don't relearn)

- Snapshot shape is `{ meta: {title, systemPrompt, …}, messages, inFlight, lastRun }` — **not** `{ session, … }`.
- Auth check endpoint is `GET /api/auth/session` (there is no `/api/auth/me`).
- `msg.user` event payload **is** the message object directly (not `{ message }`).
- Sessions invalidate on **every** server restart — re-login (`POST /api/auth/login`, creds in `.env`).
- `nui-markdown` static render needs `textContent` set **before** append (connectedCallback reads once, `_processed` guard).

## Remaining PC parity (not yet built)

- Image lightbox/viewer (images render inline already)
- Pin/clone, export/import, system-prompt presets
- TTS controls (needs TTS proxy per architecture §8)
- Search UI, admin panel
- Arena view (deferred to Phase 6 by design)

## Environment (unchanged from session 1)

- Dev: `D:\DEV\LLM-Gateway-Chat`, `npm start` → :8082. nLogger → `server/logs/*.log`. Re-login after restart.
- Live: `D:\SRV\LLM-Gateway-Chat` master :8080. Hotfix flow via `git format-patch -o $env:TEMP` + `git apply` (PS5.1 `>` redirect writes UTF-16; `Get-Content -Raw` + `WriteAllText` double-encodes UTF-8).
- Branch not yet pushed (`git push -u origin bff-rework` when ready).
