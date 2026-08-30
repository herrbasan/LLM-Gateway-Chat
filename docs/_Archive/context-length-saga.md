# Context-Length Saga — The Whole Story

**Date:** 2026-08-28 → 2026-08-29
**Tracking:** LLM-Gateway-Chat issue #10 · related LLM-Gateway#2, LLM-Gateway#3
**Status:** Measurement is settled and correct. **Open:** reasoning-strip policy + the alignment question.

> Read this first in a fresh session. It is the distilled, verified account of what we
> found, what we changed, what broke, and the two questions still open. Written so the
> next session does not re-litigate settled facts.

---

## 1. The symptom that started it

The context pill (the `overall-context-progress-wrap` element beside the chat input)
showed wrong numbers. A conversation known to hold hundreds of thousands of tokens
read ~51K. Historically it was "wrong most of the time, only plausible after a reload."

## 2. What the number is supposed to mean

After much back-and-forth, the user pinned the semantics:

> **"How close am I to the limit."** The context window has an upper bound; the only
> thing the pill must answer is how much of that bound the *next request* will consume.

That is the **on-the-wire payload** — what is actually sent to the model — NOT the raw
stored history. This was the key decision, reached only after the metric flip-flopped
(see §6, the lesson).

## 3. The root causes (there were several, stacked)

The display was lying in **three independent ways**:

1. **Frozen pill (display bug).** `updateOverallContext()` no-arg path read the retired
   `conversation` global (dead post-BFF) and fell through to a chars/4 estimate that
   ignores tool results and reasoning — overwriting the good value with a smaller one.
   Fixed: read from the live `activeConversations` store, walk back to the latest
   exchange with real context, and never let an estimate overwrite a real reading.

2. **Gateway under-count.** The gateway's `context.used_tokens` is a tiktoken estimate
   (`_estimateMessagesTokens`, model-router.js) that reads **only `m.content`** — it
   misses `reasoning_content` and `tool_calls` JSON entirely. These are the dominant
   masses in a thinking/tool conversation. Filed as **LLM-Gateway#2**.
   - Note: `usage.prompt_tokens` on these models is NOT a real provider count — the
     tell is `completion_tokens: 0` everywhere. The gateway *backfills* usage with its
     own lossy estimate when the upstream omits it. There is no true value on the wire
     to read back for these models.

3. **Load vs. send measured different things.** On load the pill counted raw stored
   history; on send it counted the dedup'd wire payload. Same conversation, two numbers
   (341K vs 75K), looked like the pill "dying" mid-conversation.

## 4. The strategy change (the actual fix)

**The side that holds the real payload does the counting.** Post-BFF that side is the
runner — it assembles the exact `apiMessages` array via `buildApiMessages` before POSTing
to the gateway. So the runner counts, not the gateway.

- New module: `server/token-count.js` — `countApiMessages` / `breakdownApiMessages`,
  using `js-tiktoken` (cl100k/o200k), the **same library the gateway uses**, but fed the
  full field set (content + reasoning_content + tool_calls + tool results + image costs).
- `js-tiktoken` added as a dependency (a BPE tokenizer is a legitimate dep — out of scope
  to hand-roll; cf. the zero-dependency rule's "complex infrastructure" carve-out).
- `server/runner.js` `_assemblePayload()` extracted — the single assembly shared by
  `runOnce` (live turn) and `buildSnapshot` (on-load). Both count the **identical**
  payload → no load/send flip.
- `buildSnapshot` is now **async** (it runs the real assembly to count it).

## 5. Verification (it is genuinely correct now)

Cross-validated the runner's cl100k count against an independent chars/4 heuristic across
8 conversations:

- **Text-only chats** (the control): runner count matched the gateway within **~1%** →
  the tokenizer is calibrated.
- **Reasoning/tool-heavy chats:** gateway had under-reported by 58–91% (it only counted
  content). Runner now captures it.
- **One over-report case** (a chat with images): the gateway counts image token costs
  (85/255 per image) that raw text can't see — the one place the gateway could exceed
  a text-only count.

Residual uncertainty is the cl100k-vs-actual-model tokenizer mismatch (~5-15%),
unavoidable without a real provider `prompt_tokens` (which these models don't return).

A **per-turn breakdown is logged**: `console.log` header (visible in the nPM console) +
a per-message table in `server/logs/main-0.log`. So "is this number real" is answerable
by inspection, every turn.

## 6. Regressions introduced along the way (and fixed)

Making `buildSnapshot` async + extracting `_assemblePayload` broke three things; all
fixed and committed. Recorded so the next session knows the blast radius:

1. `_assemblePayload` field-name mismatch — `buildApiMessages` returns `{messages,
   chunkTable}`, callers destructured `{apiMessages}` → "apiMessages is not iterable".
2. REST `GET /api/chats/:id/snapshot` didn't `await` the async `buildSnapshot` →
   serialized a Promise as `{}` → empty conversation. (The SSE attach path was already
   fixed; this REST path — used by `runner-client._fetchSnapshot` — was missed.)
3. `mcpOrigin` moved into `_assemblePayload` but `runOnce` still referenced it →
   ReferenceError. Now returned from the helper.

**Lesson (also fed back into the Prime Directive):** pin the metric/semantics with the
user FIRST, implement once, and smoke-test a real turn before committing — `node --check`
catches syntax, not runtime contract breaks.

## 7. The measured pipeline (the 366K → 75K drop, explained)

For the test conversation (252 messages, `chunkTransform: true`, 26 retirements,
model deepseek-chat):

| Stage | Chars | ~Tokens | What happened |
|---|---|---|---|
| Raw stored | 1,464,247 | ~366K | everything on disk |
| → strip reasoning | 670,488 | ~168K | **−198K tokens of thinking removed** (all 77 reasoning blocks; 0 carry a `thinking_signature`) |
| → dedup + retirements | ~171K | ~75K | chunk-view collapses repeats; tombstones replace retired tool results |

So: **the thinking IS stripped** (the single biggest reduction), and dedup/retirement
takes it the rest of the way. The 75K wire figure is the true "what hits the window."

## 8. OPEN QUESTION A — the reasoning-strip policy (is stripping correct?)

Current rule (`server/api-view.js:230`): **no `thinking_signature` → drop reasoning.**
Written for the Anthropic thinking-block contract. DeepSeek (OpenAI-adapter) **never
sends a signature**, so for DeepSeek this = *always strip all prior reasoning, every turn.*

Research (2026-08-29, `research.topic`, provider docs) shows this is **provider-specific
and the blanket rule is wrong**:

| Provider | Prior reasoning on the wire |
|---|---|
| DeepSeek, **no tools** | Ignored even if sent → stripping is free/correct |
| DeepSeek, **with tools** | **REQUIRED** — omit it and the API 400s. Stripping breaks tool chains. |
| OpenAI | Hard-rejected (unknown field) → must strip. Uses `previous_response_id` for continuity |
| xAI (Grok) | **Required** — omitting it is the documented #1 cache-miss cause |
| Anthropic | Structured `thinking` blocks, must round-trip during tool use |

**Prompt caching is prefix-based and universal:** any change to earlier messages breaks
the cache; only appending preserves it. So payload *shape stability* matters — but
"strip vs keep" is a per-provider answer, not a global toggle.

**Correct home:** the gateway (the adapter knows the provider + whether `tools` are
present). Likely policy:
- Anthropic → keep structured thinking (signature present)
- DeepSeek → keep reasoning **iff tools advertised**, else strip
- OpenAI → always strip
- xAI → always keep
- unknown → keep (safer for cache continuity)

The chat app's strip stays only as the Anthropic-contract guard. This is a gateway change
(LLM-Gateway repo), deliberately deferred — do not do it tired.

## 9. OPEN QUESTION B — the alignment concern (the one to take seriously)

User's report at end of session:

> "The work in the chat is more difficult now. The longer a conversation becomes, the
> harder it is for the model to understand me and me to understand the model. Not that
> it doesn't remember — a drift in mutual understanding. Might just be too many turns."

**Hypothesis:** stripping all prior `reasoning_content` removes the model's visible
chain-of-thought — the place where it worked out *what the user meant* (the half-formed
read, the noticed constraint, the "he means X not Y"). Each turn then re-derives its
understanding of the user from polished conclusions only, so small misreadings compound
instead of self-correcting via visible prior reasoning.

**Confound (user's own caveat):** long conversations degrade alignment regardless —
signal-to-noise drops as context grows. Both can be true.

**Provider-split matters here:** the effect, if real, is strongest on DeepSeek/Grok-style
models (where prior reasoning is required/useful) and absent on OpenAI (where it's never
kept).

**The experiment to run (do NOT assert without it):**
1. Make reasoning-retention a per-provider policy (Question A) or a per-chat toggle.
2. Run the **same long task twice** on the **same model** (DeepSeek is the one to test
   first) — once with reasoning kept, once stripped.
3. Compare *felt alignment* across many turns.

If the feeling is real and it's the stripping, Question A's policy is the fix.

## 10. What is committed

On `master` (LLM-Gateway-Chat), in order:
- `ddeb6b0` — frozen-pill fix (read live store, don't overwrite real with estimate)
- `1a76a9e` — runner counts real payload; `token-count.js` added; `js-tiktoken` dep
- `887e7de` — snapshot recounts history (superseded by e589fda's shared assembly)
- `e589fda` — `_assemblePayload` shared by runOnce + buildSnapshot; consistent count
- `3decb76` — fix `_assemblePayload` field-name mismatch
- `a831a49` — fix missing `await` on async buildSnapshot in REST route
- `394f965` — pill = on-the-wire payload; per-turn breakdown logging
- `04a415d` — fix `mcpOrigin` scope
- `c6301ba` — echo turn-payload summary to stdout

Filed downstream: **LLM-Gateway#2** (estimator ignores reasoning + tool_calls),
**LLM-Gateway#3** (vision path: false analysis note + vision models not receiving images).

## 11. Where to start tomorrow

1. Confirm the pill reads consistently on load and after a turn (should match the
   console breakdown line).
2. Tackle **Question A** (gateway per-provider reasoning policy) — it's the prerequisite
   for **Question B**'s experiment.
3. Run Question B's A/B on DeepSeek before concluding anything about alignment.

Memory anchors: #2021 (the saga), #2022 (the alignment concern).
