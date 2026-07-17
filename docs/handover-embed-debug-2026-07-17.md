# Embedding Debug Handover — 2026-07-17

## Task
Finish getting the **378 stale chat messages** embedded into nVDB. The embedding endpoint (`/v1/embeddings` on the LLM Gateway at `192.168.0.100:3400`) returns **500 Internal Server Error** during reconciliation, even though manual tests work fine.

## Architecture

```
LLM Gateway Chat (Node backend, port 8080)
  └─ server/server.js
       ├─ embedBatch(texts[])     — sends fetch to Gateway /v1/embeddings
       ├─ embedMessageAsync(...)  — per-message embed with retry, truncation, nVDB insert
       ├─ Reconciliation (startup) — scans nDB for messages missing from nVDB, embeds them
       └─ Health check (5s loop)  — sends `input: ['health check']`, drains pendingQueue on recovery
```

Embedding uses `qwen3-embedding-4b` via OpenRouter, proxied through the Gateway. API key is `GATEWAY_API_KEY` from `.env`, sent as `Authorization: Bearer <key>`.

## Current State

| Item | Count |
|------|-------|
| Messages in nDB (total) | 8,282 |
| Successfully in nVDB | 6,662 |
| Stale (need embedding) | 378 |
| Stale counter decreasing | Yes — each restart reduces it |

The 378 are `pending` messages from a ~2-day window when the Gateway didn't require API keys on embeddings. Older messages were embedded before the key requirement.

## What Works

1. **API auth** — `GATEWAY_API_KEY` is correctly read from `.env` and included in headers. Tested manually.
2. **Single-text embedding** — `embedBatch(['hello world'])` and `embedBatch(['[Chat: Untitled] [user] ...'])` both return 200.
3. **Batch of 20 short texts** — 20 synthetic short texts all return 200.
4. **Health check** — `input: ['health check']` returns 200 and recovers `embedAvailable`.
5. **nVDB is intact** — 6,053 segments, 10,469 docs. Not corrupted.

## What Fails

**Reconciliation batches produce Gateway 500 errors.** The first batch of 20 real messages gets `Embed 500`. Retries (up to 5 with exponential backoff) all get 500. This happens consistently across restarts.

Suspected cause: some real messages are very long (full assistant responses). Batching 20 of them together may exceed the Gateway's internal token limit, crashing the worker/model process. The Gateway returns 500 rather than 413/429.

## What's On Disk Now

`server/server.js` has reconciliation switched to **one message at a time** (`embedMessageAsync` per message, 500ms gap, exponential backoff on failure). This should avoid the batch token overflow issue since `embedMessageAsync` already uses `middleTruncateEmbedText()` to cap each message at `EMBED_MAX_TOKENS` (25,000 tokens).

The batch queue system was stripped down — `embedBatch(texts)` is a simple fetch wrapper now. Reconciliation doesn't use it directly; it calls `embedMessageAsync` which calls `embedBatch([text])`.

## Key Code Locations

| What | File | Lines |
|------|------|-------|
| API key header | `server/server.js` | ~44-50 |
| `embedBatch()` | `server/server.js` | ~605-630 |
| `embedMessageAsync()` | `server/server.js` | ~765-868 |
| Reconciliation | `server/server.js` | ~370-415 |
| `middleTruncateEmbedText()` | `server/server.js` | ~750-760 |
| Health check loop | `server/server.js` | ~236-280 |
| `.env` config | `.env` | `GATEWAY_API_KEY=...` |

## Environment

- **Dev machine**: Coolkid (this repo). Database is stale copy of production — safe to break.
- **Production**: BADKID at `\\BADKID\Stuff\SRV\LLM-Gateway-Chat`. Database is live — do NOT run experimental writes there.
- **Gateway URL**: `http://192.168.0.100:3400/v1/embeddings`
- **Embedding model**: Qwen3-Embedding-4B (2560 dims)

## Quick Diagnostic Test

```powershell
node -e "
const embedUrl = 'http://192.168.0.100:3400/v1/embeddings';
const apiKey = 'someKey33!!';
const r = await fetch(embedUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
    body: JSON.stringify({ input: ['test'], dimensions: 2560 })
});
console.log(r.status, r.ok ? 'OK' : await r.text());
"
```
