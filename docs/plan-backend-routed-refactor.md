# Plan: Backend-Routed Refactor (BFF) + Multi-User Scoping

**Date:** 2026-08-23
**Status:** AGREED — execution not started
**Branch:** `bff-rework` (worktree at `D:\DEV\LLM-Gateway-Chat`, dev port 8082)
**Live deployment:** `D:\SRV\LLM-Gateway-Chat` on `master`, port 8080 — must keep working throughout.
**Revives:** `refactor-backend-routed-communication.md` (archived 2026-07-11 — "backend proxy concept may be revisited later"). This is that revisit.
**Supersedes (direction only):** `plan-client-side-service-urls.md` — its localStorage URL config stays valid knowledge, but the end state makes per-service browser URLs obsolete: the browser talks same-origin only.

---

## 1. Why

The chat app is client-centric: the browser orchestrates gateway, MCP, TTS, and
persistence directly. Six direct browser→upstream channels (analysis 2026-07-11,
memory #700):

1. GatewayClient SSE POST `/v1/chat/completions`
2. GatewayClient REST GET `/v1/models` + `/health`
3. GatewayClient WebSocket `/v1/realtime`
4. TTS GET `/voices` + GET `/tts?params` (chat.js and arena.js; audio via `new Audio(url)`)
5. MCP SSE via fetch reader + POST to MCP postEndpoint
6. Arena creates multiple GatewayClient instances with direct gatewayUrl

**Consequence:** every service port must be exposed for the chat to work. The
current open-ports state is not a misconfiguration — it is forced by the design.
Ports cannot be closed until the browser stops needing them.

In July, direct browser→service calls were the pragmatic choice (external
reachability had no other answer). nPort now exists and solves reachability at
the edge — the reason for client-centrism is gone.

## 2. Target shape

```
browser ──► nPort :443 (one door, session token) ──► chat backend ──► gateway / MCP / nSpeech
                                                         │
                                                         └─► persists messages as traffic flows
```

- Browser = view ("window"). Server = center of operations.
- Persistence = side effect of traffic, not a client chore.
- Chat backend attaches the verified `sub` to every internal call.
  The browser never asserts identity.

## 3. Phases (strict order)

### P0 — Chat backend owns conversation stream + persistence
`server/server.js` grows from static host to BFF. Proxy `/v1/chat/completions`
(SSE), persist user+assistant messages server-side as they stream.
Highest value, smallest step. Server already has an SSE relay pattern
(embed-events). BackendClient already uses relative paths (`baseUrl=''`).

### P1 — Route remaining channels through the backend
MCP tool calls, TTS, `/v1/models` + `/health`.
Gotchas (from memory #700):
- TTS audio uses GET with query params via `new Audio(url)` — proxy must
  support GET query passthrough, not only POST.
- MCP client uses a fetch-based SSE reader (not EventSource) — relay must
  preserve streaming in both directions.
- Arena's `config.js` is STATIC — must become dynamically generated like chat's.

### P2 — nPort cutover (the unsafe state ends here)
Bind all services to localhost/127.0.0.1. Close direct ports. Public surface
= 443 only. Gateway accessKey remains for direct LAN debug. Admin UI stays
localhost-only forever. OPNSense forwards 80/443; nPort runs as a service
(nssm). Verify `/health` and `/v1/models` through the public domain.
This phase lands mostly in herrbasan/nPort.

### P3 — Multi-user data-layer enforcement (family model, memory #1662)
- Every memory/storage record gets `owner` (usr_id).
- Write/delete requires `sub == owner`. Read is family-wide.
- No ACLs, groups, or sharing flags — family-only scope, never public.
- Threat model: an LLM acting for user A must not delete user B's work.
  Enforcement at the data layer makes this structural, not prompt-level.

### P4 — Token hygiene (identified 2026-08-23, nPort session)
- `label` + `createdAt` on all tokens; label REQUIRED for POST /keys.
- Session tokens get `exp` (30d); today every login mints an immortal token.
- Server-side exp enforcement in `requireAuth` + `forward_auth` — currently only
  the SDK verifier checks exp; expired tokens pass the coarse gate.
- Kind policy: sessions vs apikeys gated per surface (e.g. admin UI = session only).
Lands in herrbasan/nPort.

## 4. Locked decisions

- Family-only, never public / multi-tenant.
- Owner writes, family reads. Whole permission system.
- Admin surface localhost-only; remote admin via SSH tunnel.
- BFF rework and multi-user scoping are ONE plan — server-attached identity
  is what makes P3 enforceable.
- Live service keeps running from `D:\SRV` on master; refactor happens in the
  `bff-rework` worktree and merges when proven.

## 5. Open questions

- Memory privacy exception: user's twin/biography/psychology memories likely
  need a private scope overriding the family-readable default.
- Gateway WebSocket realtime path (`/v1/realtime`) through the backend.
- Arena: merge into chat or keep as separate client?

## 6. References

- memory #700 — six-channel browser→upstream analysis (2026-07-11)
- memory #1662 — family multi-user model (2026-08-23)
- memory #1664 — this plan's session record (2026-08-23)
- memory #1040 — Security & Privacy Deferred cluster
- nPort: `docs/ARCHITECTURE.md`, `Agents.md` (edge auth model)
- `docs/plan-client-side-service-urls.md` (2026-07-11, direction superseded)
