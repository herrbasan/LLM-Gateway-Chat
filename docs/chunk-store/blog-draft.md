# The Chunk Store: Teaching a Chat History to Hold Everything Once

**Draft — 2026-08-12, for review. Data verified against probes and production session logs. Target: personal blog, technical-but-honest register.**

---

Every LLM conversation is a hoarder. Each time you hit send, the entire
history — every message, every tool result, every document anyone has ever
opened — goes back over the wire. Turn fifty pays for turn one's bytes
again. A 173-message working session of mine transmitted roughly **4 million
tokens**; the actual *content* of that session was a fraction of that. The
rest was repetition, billed at full price, every single time.

I run a chat client of my own (vanilla JS, a Node backend, an LLM gateway
between them and the models), so I could see the payloads directly. What I
saw: tool results dominating everything. In one flagship session — 448
exchanges, biography-reconstruction work with heavy file reads — **88% of
every request was tool content**, and the session had quietly grown past a
point where a 256K-context model couldn't even receive it anymore. The
provider's answer was an HTTP 400: `requested: 695195` tokens against a
262,144 limit. Conversations don't degrade gracefully; they hit a wall and
die.

So the question became: what would it take for the history to hold each
chunk of data **exactly once**?

## What everyone else does (and doesn't)

I checked the field first. GitHub Copilot CLI offloads tool output over
20KB to a temp file and hands the model a path — lossy, and the copies
accumulate forever. Claude Code trims stale tool results and can run tool
chains in a sandbox where intermediates never enter history — better, but
still deletion. Aider famously avoids the problem by sending a ranked
skeleton of your repo instead of files.

What nobody does: **remember that two chunks are the same thing.** No tool
I found deduplicates repeated content in history, supersedes stale versions
of a document, or lets the model write a file by *referencing* text it
already produced instead of re-emitting it.

That gap became the design.

## The rules I refused to break

Two constraints shaped everything, and both came from disliking the
obvious solutions:

**Lossless only.** The industry-standard move is the stub: replace old
content with a head/tail excerpt and a pointer. I rejected it, and the
reason is trust: with stubs I can never know what the model actually knows
versus vaguely remembers it can fetch. Worse — *it* can't know what it's
missing. A model can't miss what it doesn't know exists. So: anything in
the payload must be resolvable from the payload itself. References point at
content that *is* present, earlier, in the same request.

**Shape invariance.** Every optimization is a content substitution inside
the existing message envelope. A compressed message is still a `role:
'tool'` message with a string in `content` — the string just says
`[chunk_23 = chunk_5]`. No new message types, no schema changes, nothing
for downstream machinery to trip over. If the whole system is bypassed,
the conversation is byte-identical to before.

## Mechanism 1: Dedup, or "you've seen this exact thing before"

The engine fingerprints every large chunk (>2KB) and, on a repeat, replaces
it with a one-line reference:

```
[chunk_23 = chunk_5]                              ← byte-identical
[chunk_25 ≈ chunk_5 (same content, minor differences)]  ← 85%+ same lines
```

The reference is unambiguous, the content is present once at `chunk_5`,
and the model treats the reference as the content. That last part isn't
hopeful — it's probed (more on the probes below).

The non-obvious lesson was **fingerprinting**. My first version hashed
lines of raw text — and caught almost nothing in real traffic. The reason:
tool responses arrive as JSON-RPC, where the entire payload is *one giant
escaped string* (`"body": "...434K chars with literal \n inside..."`). A
two-byte counter difference inside made my line-based similarity score say
"1 of 10 lines changed — 90% different" about content that was 99.9%
identical. The fix was shape-aware fingerprinting: if it parses as JSON,
fingerprint the parsed string fields, not the raw lines. That one change
took the flagship session from 16% savings to **50%**.

The second lesson: **write payloads travel in tool-call *arguments*, not
results.** When the model saves a file, the document is in
`storage.write(path, content)`'s arguments. My first engine only examined
tool *results* and scored 0% on a session that was 52% repetition by
measurement. Both fixes came from the data correcting me, not from
foresight.

## Mechanism 2: The model retires what it's done with

Dedup handles repetition. But my real working sessions turned out to be
dominated by *unique* history — documents read once, used, done. A live
translation session (173 messages, ~4M tokens transmitted) saved only
1-2% from dedup. For the big win, content has to *leave* the payload.

Here's where the design got its best idea, and it came from inverting the
stub: **the model decides what it's finished with, and writes its own
distillation of what to keep.**

A new tool, `context_retire(chunk_ids, distill)`. When the model has
consumed a document — translated it, summarized it, extracted what it
needed — it retires the chunk and writes what its future self should
remember. The full text leaves the payload; the tombstone stays:

```
[chunk_A — RETIRED. Your distillation: "Q3 infra report: Frankfurt cluster
 live 2026-06-14, 34 nodes. Monthly spend €41,200. RI coverage 73%.
 Post-incident alert paging now 90s (was 5min). Original intact; restore
 with context_unretire(chunk_A)."]
```

Note what that tombstone *is*: not a vague pointer, but a receipt. You can
read exactly what the model chose to remember. The model knows what it
knew, what it kept, and how to get the original back. The retrieval
pathway carries its own *reason* — a stub never tells you why you'd want
to fetch; a distillation does.

This also inverts the cost direction in an interesting way: the
distillation costs output tokens once (the model writing its own notes),
then saves input tokens on every request for the rest of the session.
One-time cost, compounding return.

The failure mode I worried about — premature retirement — is structurally
resisted: a model that can't write a specific distillation hasn't consumed
the chunk. And a wrong call costs one `context_unretire` and a re-read.
Fail loud, recover cheap, canonical history never touched.

## Does it actually work? The probe battery

Claims are cheap; I built probes. All against real model endpoints, all
scored by exact checks (planted canary strings, tool-call shape), no
LLM-judge needed for the core battery:

| Probe | Result |
|---|---|
| Model dereferences a labeled chunk spontaneously | PASS |
| `from_ref` — model writes a file by referencing content instead of re-emitting it | PASS, zero re-emission |
| Model answers about *unchanged* regions of a diffed document | PASS |
| Five stacked diffs composed mentally | PASS, 4/4 runs |
| Real 195-exchange history transformed, then quizzed on buried facts | 4/4 — including cross-referencing two chunks to reason about state change |
| Retirement: distill quality, recall from distillation, recovery of an un-distilled detail | **8/8** deepseek; core mechanism 4/4 model families (kimi-k3 7/8, glm5 6/8, claude-sonnet 6/8 — the misses were my probe demanding exact figures in free-text summaries, while the distillations themselves contained every fact) |

The retirement probe deserves a moment. The model was walked through two
documents, instructed to retire each with a distillation, then quizzed.
From distillations alone it recalled the monthly spend (€41,200) and the
migration window correctly. Then I asked about a detail I'd deliberately
made unlikely to be distilled — an alert-paging threshold buried in an
incident report. It recovered the answer. The distillations it wrote were
dense and specific: canaries, figures, decisions — not "this document
discusses infrastructure."

There was also an emergent behavior I didn't design for: in the real-history
probe, the model spontaneously compared two chunk-referenced arena listings
and reasoned *across* them — "118 sessions... the later listing reported
114, after the shells were deleted." Nobody taught it that. Given
references, it used them as first-class objects.

## The honest numbers

Offline verification over a corpus of real exported sessions:

| Session | Shape | Dedup savings |
|---|---|---|
| 448-exchange biography reconstruction | re-fetch heavy | **50%** per request |
| Document refinement (116 exchanges) | edit chains | **39%** |
| Philosophy/tooling chat (195 exchanges) | mixed | 11% |
| One-shot dump sessions | unique content | ~0% (retirement's job) |

Then the multi-model matrix: five model families (DeepSeek, two Kimis,
GLM, Claude) replayed the flagship session with transformed histories. Did
they diverge from the original trajectory? Sometimes — and here's the part
that makes me trust the result: **the raw control diverged identically.**
Replaying the *untouched* history produced the same "divergences" at the
same checkpoints. The session itself has high trajectory entropy (it's
open-ended biographical work); the transform was invisible in the noise.
Zero confirmed transform-caused divergences, five model families.

And production: a real 173-message translation session with the toggle on
saved ~1-2% — dedup alone can't bend a unique-content session, which is
exactly what the corpus predicted, and exactly why retirement is the main
lever. The two mechanisms compose: dedup for "the same thing twice,"
retirement for "done with this, keeping the essence."

## What it looks like live

The chat UI grew one small vanity: a header pill that counts tokens kept
out of requests, ticking upward as the session runs. (Its first version
double-counted — the savings counter itself needed dedup, which felt
appropriate.)

The toggle is per-chat. History on disk is never modified; flip the toggle
off and the next request is byte-identical to the old behavior. The whole
system is a view, computed at send time, over a canonical store that
doesn't know it exists.

## What's genuinely new here

To the best of my research: content-addressed dedup inside chat history,
`from_ref` tool arguments, and model-driven retirement with
self-distillation are each, individually, not things the current tools do.
The combination — a lossless, shape-invariant, model-participating history
— is the contribution.

The deeper shift is framing. The industry's mental model of history is a
*log*: append-only, sacred, expensive. The alternative is a *store*:
content-addressed, deduplicated, curated by its own reader. The model
isn't a passive consumer of its context. It can be the curator.

---

*All probes, the engine, the corpus analyzers, and the replay harness are
in the repo under `docs/chunk-store/`. The engine is ~300 lines of
dependency-free JavaScript.*

### Appendix: failure modes we designed for

- **Broken diff/reference** → self-validating apply throws at assembly,
  full text is sent instead. Loud, never silent.
- **Premature retirement** → the distillation requirement is the
  comprehension check; unretire is one tool call.
- **Prompt-cache invalidation** → retirement is batched; tombstones rewrite
  mid-history content, which busts the provider's prefix cache — so retire
  rarely and in groups, not one chunk at a time.
- **Reorder-heavy content** (same bytes, shuffled) → caught by line-set
  similarity, not positional diff. Learned the hard way from memory-dump
  re-reads.
