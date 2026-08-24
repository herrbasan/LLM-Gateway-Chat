# Spec: Backend-Routed Refactor (BFF) + Multi-User Scoping

**Date:** 2026-08-23 (specced during an nPort session; execution happens in THIS repo)
**Status:** ARCHITECTURE PIVOT (2026-08-23) — the proxy-retrofit is replaced by the **ConversationRunner** architecture; [architecture-conversation-runner.md](architecture-conversation-runner.md) is the design authority. Survey: [codebase-survey-bff.md](codebase-survey-bff.md) (channel × callsite authority; §1/§2 corrected with its findings). Retrofit P0 design kept as input: [plan-p0-stream-ownership.md](plan-p0-stream-ownership.md). Phases re-scoped in §4.
**Branch:** `bff-rework` (worktree `D:\DEV\LLM-Gateway-Chat`, dev port 8082)
**Live:** `D:\SRV\LLM-Gateway-Chat` on `master`, port 8080 — must keep working throughout
**Tracking:** LLM-Gateway-Chat issue #12
**Revives:** `refactor-backend-routed-communication.md` (archived 2026-07-11 — "backend proxy concept may be revisited later"). This is that revisit.
**Supersedes (direction only):** `plan-client-side-service-urls.md` (2026-07-11) — its localStorage URL config stays valid knowledge, but the end state makes per-service browser URLs obsolete: the browser talks same-origin only.

---

## 0. Read first — how to run this spec

- **Small steps.** Execute one phase (or sub-item) at a time; the user reviews between steps.
- The user is not a backend engineer and runs at variable capacity. Explain changes in plain terms, one concept at a time.
- He sometimes thinks aloud — confirm before acting on ambiguous directives (memory #1665).
- Work ONLY in the worktree on `bff-rework`. Live hotfixes (rare) go to `master` in `D:\SRV`; merge `master` into `bff-rework` after each hotfix to prevent drift.
- The executing session should load memory #1664 (session record) and read this file fully before touching code.

## 1. Why

The chat app is client-centric: the browser orchestrates gateway, MCP, TTS, and
persistence directly. Six direct browser→upstream channels (analysis 2026-07-11,
memory #700):

1. GatewayClient SSE POST `/v1/chat/completions`
2. GatewayClient REST GET `/v1/models` + `/health`
3. ~~GatewayClient WebSocket `/v1/realtime`~~ — retired, no code remains (verified)
4. nSpeech V3 SDK surface — POST `/v1/audio/speech` (SSE audio stream), `/v1/text/clean`, voice/admin GETs, EventSource `/v1/admin/events`. The "GET `/tts` + `new Audio(url)`" shape from the 2026-07-11 analysis is stale (survey §1 ch.4).
5. MCP SSE via fetch reader + POST to MCP postEndpoint
6. Arena creates multiple GatewayClient instances with direct gatewayUrl
7. Browser→MCP-storage plain-HTTP PUT `/storage/…` (`saveToStorage`, chat.js:556) — missed by the July analysis
8. `browser_fetch` arbitrary-URL fetch (chat.js:803) — missed by the July analysis

**Consequence:** every service port must be exposed for the chat to work. The
current open-ports state is not a misconfiguration — it is forced by the design.
Ports cannot be closed until the browser stops needing them.

In July, direct browser→service calls were the pragmatic choice (external
reachability had no other answer). nPort now exists and solves reachability at
the edge — the reason for client-centrism is gone.

## 2. Current state — verified facts (2026-08-23)

### Chat server (this repo)

- **Config resolution is env-first** (server/server.js): `process.env` (loaded from `.env`)
  wins over `server/config.json`, which wins over built-in defaults.
  - `PORT = CHAT_PORT || cfg.port || 3500`. Live uses config.json's 8080; the worktree `.env` sets 8082.
  - `USERS_DB_PATH = CHAT_USERS_DB || cfg.usersDbPath || 'server/data/users_db/data.jsonl'` — RELATIVE path, so each checkout owns its data. Neither `.env` overrides it.
  - `SESSION_TTL = (cfg.sessionTtlMinutes || 1440) * 60 * 1000` ms (server.js:36) — **the chat has its own user/session system (`users_db`), separate from nPort auth.** P3 must reconcile these: nPort becomes the identity authority; chat profiles key by nPort `sub`.
- `server/data/` is gitignored. The dev instance starts with NO data — copy a snapshot from live for testing (see §7). Never let the dev instance point at the live data dir.
- Deps: express 5 and @seald-io/nedb are in `package.json` but **never imported** — dead deps; the server is raw `http.createServer` + hand-rolled router (server.js:2045, 2127). Submodules in `lib/`: ndb, nlogger, nui_wc2, nvdb.
- Latent bug, fix during the pass: `FILES_DIR` is used-but-undeclared (server.js:927 etc.) → legacy `/api/chat-files` GET/DELETE, `/api/files`, `/files/*` throw ReferenceError. Tracked as issue #14.
- BFF-friendly, with two traps: BackendClient's same-origin is a **config artifact** (code default `http://localhost:3500`, api-client.js:289; the generated config.js sets `backendUrl:''`), and chat's GatewayClient reads **`localStorage['gateway-url']` only** — the generated `config.js.gatewayUrl` is never read, and the default `''` 404s out-of-box (chat.js:40). P0 must deliver the proxy URL through a mechanism the client actually reads.
- The server has an SSE pattern to copy in embed-events (server.js:852–882) — framing/keepalive/cleanup only; it is one-directional push. P0's bidirectional relay plumbing is new code.

### nPort (edge auth — separate repo, `D:\DEV\nPort`)

- Token model: opaque tokens; records = `{ type:'token', kind:'session'|'apikey', sub, roles, exp }`.
- **`kind` is informational only today** — nothing branches on it. An apikey can log into the admin UI; a session can authenticate a service call.
- Two-check model: Caddy `forward_auth` coarse gate → upstream SDK local-Map fine check. nPort forwards identity headers `X-Auth-Sub` / `X-Auth-Roles` / `X-Auth-Kind`; upstreams treat them as `req.auth = { sub, roles, exp }`.
- Token state broadcasts to upstream SDKs via SSE `/sync` (subnet-only).
- **Expiry gap:** only the SDK verifier (`isExpired`) checks `exp`. `requireAuth` and `forward_auth` do NOT — expired tokens pass the coarse gate. Every login mints a session token with `exp: null` (never expires, never revoked) — they accumulate (6 test sessions in the store as of 2026-08-23).
- `POST /keys` creates `kind=apikey` tokens (admin-only), `exp: null`.
- Admin UI: served at `/` on the nPort process (dev: `http://127.0.0.1:3199/`); the public `/admin/*` route works only because Caddy `handle_path` strips the prefix. Static handler enforces localhost-only.
- nPort itself is not yet live: test mode (localhost:8443, internal TLS). Production cutover = OPNSense 80/443 forward + nssm service + verify `/health` and `/v1/models` via public domain.

## 3. Target architecture

```
browser (view) ──► nPort :443 (one door, session token) ──► chat backend ──► gateway / MCP / nSpeech
                                                                  │
                                                     ConversationRunner (one per active
                                                     conversation) — the ONLY author of
                                                     conversation state; persistence is a
                                                     side effect of its traffic
```

**Design north star (user's words):** "Auth is the pass into that world. Everything
happens in the local network. The client is just a window into what is happening,
gated by the auth." Usable from the LAN and on the go through the same door.

- Browser = attach/detach view over a snapshot+event stream. Server = center of operations (the tmux model: the conversation runs whether or not anyone watches).
- Persistence = side effect of the runner's traffic, not a client chore.
- The backend attaches the verified `sub` to every internal call. The browser never asserts identity.
- Full design: [architecture-conversation-runner.md](architecture-conversation-runner.md).

## 4. Phases (strict order)

### P−1 — Codebase survey (prerequisite, no code changes)

This spec is strategy written from architecture knowledge + the 2026-07-11
analysis — NOT from reading this codebase in depth. The client-centrism runs
deep into workflows (tool execution, attachments, arena, TTS player, memory
UI). A full survey is required before any refactor step.

**How:** delegate to `deepseek-flash-chat` (subagent, 1M context, cheap) per the
prime directive's delegation rule. Primary model reviews and amends this spec.

**Survey brief — inventory these, with file:line and call shapes:**

1. Every browser→upstream network call: URL, method, streaming mode, auth
   headers, payload shape. (The six channels of §1 are the hypothesis — verify,
   complete, correct.)
2. Every workflow that assumes client-side orchestration: conversation state
   machine, tool-call execution loop, attachment pipeline, arena mode, TTS
   player, memory/storage browser UI, settings/profiles.
3. Every persistence touchpoint: where the client initiates a save, of what,
   keyed how.
4. Server-side reality: everything server/server.js already does (static
   serving, embed relay, users_db, sessions, config.js generation) — the BFF
   builds on this.
5. Auth/session handling today: how chat sessions relate to users_db; what
   breaks when nPort identity replaces it (P3).
6. Dependency map: module → channels touched, so refactor steps can be scoped
   by module instead of by discovery.

**Output:** `docs/codebase-survey-bff.md` — a channel×callsite table plus a
"hard parts" list ranked by coupling. Then update this spec: correct §2 facts,
re-scope phases, mark status READY FOR EXECUTION.

### PA–PD — Runner build-out (strangler; full detail in the architecture doc §9)

- **PA — runner core:** `server/runner.js`, conversation event stream, `send`/`abort` routes, gateway call, shared append+embed helper (stored-form authoring: timestamp prefix, nURI offload, message metadata), ported api-view + chunk-view, **system-prompt assembly server-side** (deep-dive G1 — byte-equivalent to today's `getSystemPromptWithMetadata`). Tools disabled. **Acceptance:** kill the tab mid-stream on :8082 → reopen → generation still running or already persisted; two browsers attached → both live.
- **PB — tool port:** server MCP pool, internal archive/storage/fetch tools, tool events, server-side recursion. Acceptance: a tool-chain conversation completes with the browser closed between calls.
- **PC — view parity:** the new view grows to the parity checklist while the old client keeps working (same nDB store — sequential use only). Build against the five view contracts (architecture §5: timestamp, keying, versioning, system prompt, module boundary) — not the old client's incidental formats.
- **PD — cutover:** old client retired/read-only, dead browser code removed (client-sdk, mcp-client, conversation state machine), arena re-based as a runner variant, TTS + `/v1/models` proxied.

The old proxy-retrofit P0/P1 plan is superseded — kept in [plan-p0-stream-ownership.md](plan-p0-stream-ownership.md) for its citation map and stream mechanics.

### P2 — nPort cutover (the unsafe state ends here; lands in herrbasan/nPort)

Bind all services to localhost/127.0.0.1. Close direct ports. Public surface = 443 only.
Gateway accessKey remains for direct LAN debug. Admin UI stays localhost-only forever.
OPNSense forwards 80/443; nPort runs as a Windows service (nssm).
Verify `/health` and `/v1/models` through the public domain before declaring done.

### P3 — Multi-user data-layer enforcement (family model, memory #1662)

- Every memory/storage record gets `owner` (usr_id).
- Write/delete requires `sub == owner`. Read is family-wide.
- No ACLs, groups, or sharing flags — family-only scope, never public.
- Threat model: an LLM acting for user A must not delete user B's work. Enforcement at the data layer makes this structural, not prompt-level.
- Reconcile chat `users_db` with nPort identity: nPort owns WHO you are; chat owns profile/history keyed by nPort `sub`. Migration path is an open question (§6).

### P4 — Token hygiene (lands in herrbasan/nPort)

- `label` + `createdAt` on all tokens; label REQUIRED for `POST /keys`.
- Session tokens get `exp` (30d suggested) — today every login mints an immortal token.
- Server-side exp enforcement in `requireAuth` + `forward_auth`.
- Kind policy: sessions vs apikeys gated per surface (e.g. admin UI = session only).
- Housekeeping: revoke the accumulated stale test sessions (keep the active one).

## 5. Locked decisions

- Family-only, never public / multi-tenant.
- Owner writes, family reads. Whole permission system.
- Admin surface localhost-only; remote admin via SSH tunnel.
- BFF rework and multi-user scoping are ONE plan — server-attached identity is what makes P3 enforceable.
- Identity/data separation (nPort Agents.md §5): nPort owns WHO, services own WHAT keyed by usr_id.
- Live service keeps running from `D:\SRV` on master; refactor merges when proven.
- **Single author:** the runner is the only writer of conversation state; clients never persist messages. (2026-08-23 pivot)
- **Tool execution moves server-side.** The survey's "browser-bound tools" (H1) was a retrofit artifact — server-side reach is a superset (no CORS); preview becomes pure view.
- **Strangler migration, not big-bang:** the nDB conversation format is the seam; the old client works until the new view reaches parity.

## 6. Open questions

- Memory privacy exception: the user's twin/biography/psychology memories likely need a private scope overriding the family-readable default.
- Chat `users_db` migration: adopt nPort identity for login, keep per-user profile data keyed by `sub`? Decide at P3 kickoff.
- ~~Gateway WebSocket realtime path (`/v1/realtime`)~~ — dead: the gateway retired it, no code remains (survey-verified).
- ~~Arena: merge into chat or keep as separate client?~~ — answered by the runner architecture: arena is a runner variant (same backend, spectator view).

## 7. Environment & operations

| | Live | Dev (this branch) |
|---|---|---|
| Folder | `D:\SRV\LLM-Gateway-Chat` | `D:\DEV\LLM-Gateway-Chat` |
| Branch | `master` | `bff-rework` |
| Port | 8080 | 8082 (via worktree `.env`) |
| Data | own `server/data/` | own `server/data/` (starts empty) |

- **First run:** copy the data snapshot while live is idle-ish:
  `robocopy D:\SRV\LLM-Gateway-Chat\server\data D:\DEV\LLM-Gateway-Chat\server\data /E`
  Snapshot semantics: live data keeps evolving; the dev copy is throwaway test material. Only CODE merges.
- **Run dev:** `npm start` in the worktree → `http://localhost:8082`.
- **Hotfix flow:** edit in `D:\SRV` (master) → commit → `git -C D:\DEV\LLM-Gateway-Chat merge master`.
- **Ship:** merge `bff-rework` → master; in `D:\SRV`: `git pull` + restart the live service.
- **Publish branch when ready:** `git push -u origin bff-rework`.

## 8. References

- **Architecture (design authority):** [docs/architecture-conversation-runner.md](architecture-conversation-runner.md) — the ConversationRunner design
- **Survey (P−1 output):** [docs/codebase-survey-bff.md](codebase-survey-bff.md) — channel × callsite table, server inventory, coupling ranking, spec corrections
- **Retrofit P0 plan (superseded, design input):** [docs/plan-p0-stream-ownership.md](plan-p0-stream-ownership.md)
- **Deep-dive (2026-08-24):** [docs/refactor-deep-dive-report.md](refactor-deep-dive-report.md) — system-prompt gap (G1), stored-form authoring (G2), five view contracts; companion to the survey
- memory #700 — six-channel browser→upstream analysis (2026-07-11; superseded by the survey's 8-channel map)
- memory #1662 — family multi-user model (2026-08-23)
- memory #1664 — session record of this spec's creation (2026-08-23)
- memory #1665 — interaction preference: confirm ambiguous directives
- memory #1648 — nPort baseline commit + secret guards (2026-08-23)
- memory #1040 — Security & Privacy Deferred cluster
- nPort: `Agents.md`, `docs/ARCHITECTURE.md`, `docs/ADMIN_UI.md`
- `docs/plan-client-side-service-urls.md` (2026-07-11, direction superseded)
- Tracking issue: LLM-Gateway-Chat #12
