# Embedding Reliability Rework — 2026-07-17

## Goal (user-stated)
A reliable embedding service that:
1. Does not hammer usage limits (OpenRouter is the current provider).
2. Fills gaps left by transient failures automatically.
3. Produces good-quality embeddings.
4. Works without babysitting — "I don't even have to think about it."

Local embedding (`fatten-llama-embed`) is being repaired separately; until then the
**OpenRouter route (`or-qwen-embed`)** is the production path and must be solid.

## Root causes found (not the ones in the previous handover)

The earlier handover assumed *"batch of 20 long messages overflows the Gateway's
token limit → 500"*. That was wrong:

- A manual test of **20 texts × ~32k chars each** against the live Gateway returned
  **200** — token volume alone does not cause the 500.
- The default `embed` task in the Gateway routes to **`or-qwen-embed` (OpenRouter)**,
  not the local llama.cpp. The 500s were OpenRouter-side (rate-limit window /
  provider capacity), and the intermittent success bursts in the log
  (`succeeded:20` then `failed:220`, recoveries followed instantly by more 500s)
  match a throttling window, not a deterministic per-payload overflow.
- Both Gateway adapters (`openai.js`, `llamacpp.js`) did `await res.json()` with
  **no `res.ok` check**, so any non-JSON or error body from the upstream was
  destroyed and the chat server logged a bare `Embed 500` with zero diagnostic
  content.

## What changed

### Chat server — `server/server.js`

1. **`EmbedError` class + error classification** in `embedBatch()`:
   - `kind: 'rate_limit'` — 429. Honors `Retry-After` (seconds or HTTP-date).
     Does **not** trip the circuit breaker — a rate-limit is not an outage.
   - `kind: 'server'` — 5xx, network failure, or timeout. Counts toward the
     breaker (3 consecutive → `embedAvailable = false`).
   - `kind: 'client'` — 4xx (non-429). Permanent payload problem; never retried
     blindly, never trips the breaker.
   - `kind: 'response'` — 200 with malformed body or bad vector shape. Transient.
   - The upstream **error body** (first 300 chars) is now included in every
     thrown message, so the log shows *why* OpenRouter failed.

2. **`embedMessageAsync()` retry logic**:
   - Permanent failures (`client` errors, `too_many_tokens`) → status `failed`,
     **not** re-queued. One-line change, big effect: content problems stop
     burning retries.
   - Transient failures → status stays `pending`, message is re-queued into
     `pendingQueue` with escalating backoff (5s → 30s → 2min → 10min → 30min).
     Retry-After from the provider is honored on top of the exponential base.
   - SSE `embed-status` events now emit `pending` (not `failed`) for transient
     re-queues so the frontend indicator reflects reality.

3. **Reconciliation gap filling** (`getOrLoadUserDb`):
   - The old code skipped `embedStatus === 'failed'` messages forever — every
     transient failure became a permanent hole. Now any message missing from
     nVDB is re-embedded regardless of prior status. Gaps close themselves on
     every restart.
   - The outer reconciliation loop no longer double-retries (it used to re-run
     `embedMessageAsync`'s full 3-retry block up to 5× per message = 18 attempts
     while other messages starved). `embedMessageAsync` owns retries; the outer
     loop just drives the list and counts `succeeded / retriedLater`.

### Gateway — `src/adapters/openai.js` + `src/adapters/llamacpp.js`

- Added `if (!res.ok)` guard before `res.json()` in `createEmbedding()`.
- On non-OK: reads the body as text, throws an Error with
  `HTTP <status>: <body>` and sets `err.status = res.status`.
- The global error middleware (`src/server.js:191`) already maps `err.status`
  and `err.message` into the HTTP response, so the upstream reason now reaches
  the chat server verbatim.

**⚠️ Gateway restart required** for the adapter change to take effect. The chat
server also needs a restart for its own changes. (Per house rules, restarts are
left to the user.)

## Design notes

- **Circuit breaker only on transport-class errors.** A 429 or a single bad
  message no longer flips the whole service "unavailable" — that was the source
  of the `Embedding unavailable` streaks in the old log.
- **Retry-After is honored, not guessed.** When OpenRouter says "wait 30s", we
  wait 30s instead of blindly doubling.
- **Gap filling is convergent, not perfect.** A message that is permanently
  un-embeddable (e.g. exceeds even the 30k-token middle-truncation) will be
  re-attempted on each restart and re-fail with a clear `permanent failure` log
  line. That's honest signal, bounded cost, and far better than silently
  skipping it forever. If that set ever grows beyond a handful, add a
  `embedError === 'too_many_tokens'` skip in reconciliation — but don't add it
  preemptively.

## Verification done

- `node --check` clean on all three edited files.
- `EmbedError` + `_parseRetryAfterMs` unit-sanity-tested in isolation (seconds,
  HTTP-date, and absent-header cases).
- Live Gateway probe: 20×32k-char batch returns 200 (disproves the old
  token-overflow theory); unknown-model probe returns a clean 404 from the
  registry. Full upstream-body propagation requires the Gateway restart.

## Still open / next steps

- **Restart both servers**, then watch the next reconciliation pass: transient
  500s should now show the real OpenRouter body in the log, rate-limits should
  pace themselves via Retry-After, and the stale count should converge to ~0
  instead of leaving a permanent failed residue.
- When `fatten-llama-embed` is healthy again, consider pointing the chat
  server's `embedModel` at it for the bulk reconciliation workload (local, no
  rate limit, free), keeping OpenRouter as the fallback. `server/config.json`
  already has an `embedModel` knob (`CHAT_EMBED_MODEL` env overrides it).
- The health check still uses a trivial `'health check'` string. It's a weak
  readiness signal, but with 429 no longer tripping the breaker it's mostly
  harmless now. Leave it unless it proves misleading in practice.
