# Handover: Image URL Passthrough Bug — Fixed

**Date:** 2026-06-17
**Session context:** Streaming errors on `kimi-chat` model, repeating identically across multiple requests.

---

## The Symptom

```
[ERROR] [System] Streaming error
  "Invalid request: unsupported image url: /api/buckets/images/7caf3fd2.png"
```

Every subsequent `chat.append` in the conversation failed identically. The model (`kimi-chat` via Anthropic adapter) returned HTTP 400 before streaming could begin.

## Root Cause

A relative image URL (`/api/buckets/images/7caf3fd2.png`) was embedded in the conversation history. On every turn, the gateway's image-fetching pipeline attempted to resolve it:

1. `imageFetcher.fetchImage()` called `new URL("/api/buckets/images/7caf3fd2.png")` → threw `"Invalid URL"` (no protocol/host)
2. The `catch` block in `_fetchRemoteImagesOnly()` caught the error and **passed the original broken URL through unchanged** to Kimi's API
3. Kimi rightfully rejected it with `"unsupported image url"`

The same pattern existed in `_processImageContent()` for the media-processing path.

### Why It Repeated

The gateway is stateless — the client sends full message history with every `chat.append`. The broken URL lived in history permanently, so every subsequent turn triggered the same failure.

## The Fix

**File:** `src/core/model-router.js`

**Both `_processImageContent()` and `_fetchRemoteImagesOnly()`** now have URL validation gates **before** the try/catch:

```
empty URL?          → skip silently (nothing to work with)
data: URL?          → process inline (no fetch needed)
not http(s):// URL? → strip with warning (will never work, don't try)
http(s):// URL?     → try/catch for actual network fetch (system boundary)
```

Previously the try/catch swallowed the validation error and pushed the original broken part through. Now the validation gate catches predictable failures before they reach the catch block. The try/catch only guards genuine network I/O.

## The Deeper Lesson: try/catch as an Analytical Blind Spot

The old code was:

```js
try {
    const { mimeType, base64 } = await imageFetcher.fetchImage(imageUrl);
    // ... push processed image ...
} catch (error) {
    logger.warn('Failed to fetch remote image, using original URL', { error: error.message });
    processedContent.push(part);  // ← silently passes garbage to upstream
}
```

This is the classic try/catch failure mode:
- Static analysis sees "error handled" and moves on
- LLMs traverse the happy path and treat catch as resolved
- Future reviewers see "error handled" and trust it

The bug was **structurally invisible** — no tooling flags a catch block that silently corrupts data. A crash would have been caught immediately. A silent fallback cost hours of debugging across multiple sessions.

**The fix wasn't to improve the catch block — it was to eliminate the failure condition before it reached try/catch.**

## Not the Gateway's Problem: Media Storage TTL

The broken URL (`/api/buckets/images/7caf3fd2.png`) came from the chat client's own bucket storage (port 8080), not from the gateway's media protocol (`gateway-media://`). The gateway's `gateway-media://` resolution in `chat.js` works correctly — it inlines file contents as `data:` before the message reaches any adapter.

The gateway's own media storage uses `os.tmpdir()` with a **60-minute TTL** (`src/utils/storage.js`, `src/config.js`). This TTL is unrelated to conversation lifetime and belongs to the chat client's design domain, not the gateway's.

## What to Watch For

- The `gateway-media://` resolution path in `src/websocket/handlers/chat.js` is sound — no changes needed there
- Kimi's `count_tokens` endpoint returns occasional 400s (unrelated noise, safe fallback to estimator)
- Any image URL that isn't `http(s)://` or `data:` will now be silently stripped with a log warning — check logs if images are unexpectedly missing from upstream requests
