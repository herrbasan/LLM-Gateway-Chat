# Embedding Pipeline Performance Issue

## Architecture

```
Client (embed.js) 
    ↓ HTTP POST /v1/embeddings
LLM Gateway (Badkid, 192.168.0.100:3400)
    ↓ HTTP POST (internal)
Service Wrapper (Fatten, 192.168.0.145:4080)
    ↓ IPC/localhost
llama.cpp Server (Fatten, localhost:4081)
    ↓ GPU
Intel Arc A770
```

## The Problem

Embedding 2,177 messages takes ~15-20 minutes when it should take ~30 seconds.

### Symptoms

1. **Gateway circuit breaker trips repeatedly**
   - Error: `[CircuitBreaker] Fast fail: Circuit is OPEN for provider 'llamacpp'`
   - The Gateway opens the circuit after just a few 500 errors from the wrapper
   - Stays open for 15-20 seconds, then retries
   - With 2,177 messages, even 1% failure rate triggers this repeatedly

2. **Direct wrapper access is slow with long texts**
   - 50 short texts (12 chars): ~2 seconds
   - 50 medium texts (1K chars): ~5 seconds
   - 50 long texts (4K chars): **~86 seconds**
   - 50 very long texts (8K chars): **~120+ seconds**

3. **GPU is underutilized**
   - GPU power: ~213W (normal for A770 under load)
   - But processing is sporadic, not continuous
   - CPU also shows activity during embedding

## Root Causes

### 1. Gateway Circuit Breaker (Critical)

The LLM Gateway on Badkid has a circuit breaker for the `llamacpp` adapter that is too aggressive for embedding workloads:

- Trips after ~3 failures in quick succession
- Stays open for 15-20 seconds
- Does not distinguish between transient errors (batch too large) and persistent failures

**Why it happens:**
- The llama.cpp server was initially configured with `batch_size=512`
- Some single messages exceed 512 tokens (up to ~2000 tokens)
- These requests fail with: `input (1621 tokens) is too large to process. increase the physical batch size (current batch size: 512)`
- The Gateway counts these as failures and opens the circuit

**Current workaround:**
- Direct access to the wrapper on `192.168.0.145:4080` bypasses the Gateway
- But this requires manual header configuration

**Fix needed:**
- Gateway should have separate circuit breaker config for embedding endpoints
- Should not circuit-break on 500 errors from downstream (only on connection failures)
- Should allow per-adapter circuit breaker thresholds

### 2. llama.cpp Batch Size (Resolved)

The llama.cpp server on Fatten was running with `--batch-size 512`:

```
Error: input (1621 tokens) is too large to process.
        increase the physical batch size (current batch size: 512)
```

**Fix applied:**
- Changed to `batch_size=8192` (via LM Studio settings)
- Also needed `ubatch-size=8192`
- Full restart of llama.cpp server required

**Status:** Resolved. Can now process texts up to ~2000 tokens individually.

### 3. Text Length Bottleneck (Critical)

Even with batch_size=8192, the wrapper is extremely slow with long texts:

| Text Length | Time for 50 | Time per text |
|-------------|-------------|---------------|
| 12 chars    | 2 sec       | 40 ms         |
| 1K chars    | 5 sec       | 100 ms        |
| 4K chars    | 26 sec      | 520 ms        |
| 8K chars    | 86+ sec     | 1.7 sec       |

**Analysis:**
- 50 texts × 4K chars ≈ 200K chars ≈ 50K tokens total
- The wrapper appears to process these sequentially or in very small micro-batches
- GPU utilization is intermittent, suggesting CPU bottleneck in tokenization or batch preparation

**The math:**
- Our messages: max 17K chars, average ~2K chars
- At 4 chars/token: ~500 tokens average, up to ~4000 tokens max
- 50 messages × 500 tokens = 25K tokens per batch
- With 8192 batch size, this should need ~3 GPU passes
- But it's taking 26+ seconds, suggesting ~10x overhead somewhere

### 4. GPU Idle Gap Between Batches (Critical)

**User observation:** GPU shows multiple seconds of complete inactivity between batches.

**What this means:**
- The GPU finishes one batch in ~2 seconds
- Then sits idle for 5-10 seconds before starting the next batch
- The bottleneck is NOT the GPU computation itself
- Something in the pipeline is stalling between requests

**Possible causes:**

**a) Model loading/unloading**
- The wrapper might be loading/unloading the model between requests
- LM Studio might be doing something between inference calls
- Check if the model stays loaded in GPU memory continuously

**b) Connection overhead**
- HTTP connection to wrapper might be closing/reopening each time
- TCP handshake + TLS negotiation adding seconds
- Wrapper might be accepting one request at a time

**c) Synchronization barrier**
- The wrapper might be waiting for some internal cleanup
- GPU might be flushing caches or synchronizing between batches
- Memory allocation/deallocation overhead

**d) Batch preparation on CPU**
- Tokenization might be happening synchronously before each batch
- If tokenization is single-threaded and takes 5+ seconds for 50 texts
- That would explain the gap perfectly

**Test to verify:**
```bash
# On Fatten, monitor GPU continuously during embedding:
# Watch for idle periods between compute spikes
# If GPU drops to 0% for multiple seconds between batches,
# the issue is CPU-side preparation, not GPU computation
```

### 5. CPU Overhead (Unknown)

Observed:
- CPU activity on Fatten during embedding
- This might be:
  - Tokenization overhead (converting text to tokens on CPU)
  - Batch preparation overhead
  - Memory copy overhead between CPU and GPU
  - The wrapper doing extra work

**Question:** Why is tokenization happening per-batch instead of being pipelined?

## Test Results

### Gateway Health Check
```
GET http://192.168.0.100:3400/health
llamacpp adapter: state=OPEN, failures=3, totalRequests=6704
```

### Direct Wrapper Test (Batch 50, 4K chars each)
```
POST http://192.168.0.145:4080/embedding
Headers: X-Model-Path, X-Context-Size=32000, X-GPU-Layers=99, etc.
Body: { content: [50 texts] }
Result: 200 OK, but takes ~86 seconds
```

### Direct llama.cpp Server Test
```
POST http://192.168.0.145:4081/embedding
Result: Connection timeout (server only binds to localhost)
```

## Current Workaround

1. Truncate texts to 500 chars (~125 tokens)
2. Send 50 per batch (~6K tokens total)
3. Access wrapper directly, bypass Gateway
4. Gets ~50 msg/sec (2 sec per batch of 50)

**Trade-off:** Less semantic information in embeddings (only first 500 chars of each message)

## Recommended Fixes

### 1. Fix Gateway Circuit Breaker (High Priority)

File: Gateway config on Badkid

Changes needed:
```json
{
  "adapters": {
    "llamacpp": {
      "circuitBreaker": {
        "enabled": true,
        "failureThreshold": 10,
        "recoveryTimeout": 5000,
        "halfOpenMaxCalls": 3
      },
      "embedding": {
        "circuitBreaker": {
          "enabled": false
        }
      }
    }
  }
}
```

Or add a separate embedding endpoint that doesn't use circuit breaker at all.

### 2. Optimize llama.cpp / Wrapper (High Priority)

Investigate why long texts are so slow:

- Is tokenization happening on every request?
- Is the batch being split into tiny micro-batches?
- Is there a memory allocation bottleneck?
- Can we use llama.cpp's built-in batching more efficiently?

**Tests to run on Fatten:**
1. Profile llama.cpp server with `LLAMA_LOG_LEVEL=debug`
2. Check if `ubatch-size` is actually being applied
3. Test with llama.cpp's native embedding example (not through wrapper)
4. Check GPU memory bandwidth utilization

### 3. Increase Batch Size Further (Medium Priority)

Current: 8192
Suggested: 16384 or 24576

This would allow:
- Larger batches (100+ messages)
- Longer individual texts (up to ~4000 tokens)

Requires testing to ensure GPU memory can handle it.

### 4. Pipeline Tokenization (Low Priority)

Pre-tokenize texts on the client side:
- Send tokens instead of raw text
- Skip wrapper tokenization step
- Would reduce CPU overhead

## Files Affected

- `server/embed.js` — embedding generation script
- `server/server.js` — backend API (uses Gateway for new messages)
- LLM Gateway config (Badkid) — circuit breaker settings
- LM Studio config (Fatten) — batch size settings

## Next Steps

1. Fix Gateway circuit breaker configuration
2. Profile llama.cpp embedding performance with long texts
3. Determine optimal batch size / text length trade-off
4. Update embed.js with optimal settings
5. Re-embed all 2,177 messages with full text (not truncated to 500 chars)
