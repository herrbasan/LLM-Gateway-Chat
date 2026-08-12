# Plan: Content-Addressed Chat History (Chunk Store)

Status: **Dedup-primary engine built + corpus-verified; diffs parked; matrix testing next** — 2026-08-11
Supersedes: [plan-tool-result-offload-supersede.md](plan-tool-result-offload-supersede.md) (kept for history)
Scope: `chat/js/conversation.js`, `chat/js/chat.js`, `server/server.js`
Engine: [chunk-view.js](chunk-view.js) (standalone, ports to browser verbatim)

## Problem

Every request resends the full conversation. Corpus of 8 real sessions
([corpus/](corpus/)) shows per-request payloads from ~35K to ~700K tokens;
the 448-exchange flagship exceeds kimi-chat's 262,144-token window outright
(HTTP 400 `requested: 695195` — photographed in replay). No truncation
mechanism exists — conversations die by provider error.

## Performance Goal (user-set)

**≥20% token savings or a mechanism isn't worth shipping. Target: 80%.**
Composition to reach it: dedup (repetition) + retirement (consumed one-shot
content) + from_ref (re-emission). Diffs optional, niche-only.

## Design Principles (hard constraints)

1. **Lossless only.** The model's knowledge state is fully determined by the
   payload. Every compression must be resolvable FROM the payload itself:
   a reference points at content that IS present earlier in the same payload.
   No stubs, no excerpts, no "vague memory + fetch" asymmetry.
2. **Shape invariance.** Optimizations are content substitutions inside the
   existing message envelope. No new message types or schema changes.
   Auto-heal, role-merge, provider validation can't tell the difference.
3. **The model retires its own context.** The only removal mechanism is
   model-requested, with a stated reason (the note is the comprehension
   check). We never decide what the model sees; structure carries it
   (dedup) or the model declares it (retirement).

## Architecture: Three Layers

```
Layer 1 — CANONICAL: full conversation in nDB, as today. Embeddings,
  archive search, UI replay read this. Byte-for-byte current format.
  ZERO migration.

Layer 2 — REDUCED VIEW: not a separate document. chunkMeta is a derived
  field on canonical messages (additive); retirement flags a small map.
  View ASSEMBLED ON SEND: reference where dedup fired, full text
  elsewhere, tombstone where retired. Self-healing: missing referent →
  emit full text. No invalidation logic, no rebuild triggers.

Layer 3 — PAYLOAD: assembled view + convention paragraph (only when
  chunks present) + budget line (existing rendered-history estimate,
  conservative; savings manifest as headroom, not precision).
```

## Mechanism 1 — Dedup (primary, built, verified)

Every large content (>2K chars) gets a chunk label `[chunk_N]` on first
sight. A later repeat collapses to a one-line reference:

- `[chunk_M = chunk_N]` — byte-identical (exact hash)
- `[chunk_M ≈ chunk_N (same content, minor differences)]` — line-set
  Jaccard ≥ 0.85 (re-fetches with counter/timestamp drift, reshuffles)

**Fingerprinting is shape-aware** (the corpus lesson): MCP/JSON-RPC tool
responses carry their payload as ONE giant escaped string line. Raw-line
fingerprints see "1 of 10 lines changed" and miss 99.9% identity. For
JSON-shaped contents, fingerprint the parsed string-field values
(recursively) — their inner lines feed the Jaccard set.

Labels may prefix a message body OR appear inside a tool call's arguments
(write payloads travel in args, e.g. `storage_write(path, content)`).
The convention paragraph says both. Reference integrity is audited:
[audit-refs.mjs](audit-refs.mjs) verifies every ref resolves to a labeled
body or arg — 13/13 resolve on the flagship.

### Corpus results (verify-transform.mjs, offline, no model calls)

| Session | Msgs | In | Out | Saved | Fired |
|---|---|---|---|---|---|
| digital_twin archived | 866 | 2692K | 1349K | **50%** | 10 exact + 3 near |
| digital_twin refinement | 292 | 948K | 582K | **39%** | 6 exact + 16 near |
| court_case | 444 | 1044K | 930K | 11% | 1 near |
| tape_recordings | 213 | 446K | 403K | 10% | 3 exact |
| arena_summaries / blog_final / deepseek / kimi_intro | — | — | — | 0% | nothing repeated |

Read: repetition-heavy sessions clear the 20% bar from dedup alone.
One-shot-heavy sessions (0%) need retirement — dedup can't touch unique
content. The flagship at 50% still overflows kimi-chat's window →
retirement is required to reach the 80% target there.

## Mechanism 2 — Diff-chains (PARKED, proven, ready)

Line-based unified diff chains for sequential edits of one artifact.
Engine complete and tested (round-trips incl. the real 114K corpus pair;
self-validating apply throws on any mismatch → fail loud, fall back to
full text). **Parked behind `ENABLE_DIFFS = false`** because corpus
analysis showed the mass of repetition is re-fetch/reshuffle (dedup's
domain), not sequential edits — and near-dup dedup alone captures most of
the sequential-edit savings anyway (refinement: 28% with diffs OFF vs 30%
with). Enable per-session or globally when retirement+dedup numbers show
sequential-edit sessions justify the complexity. User instinct (complexity
risk) honored: ships dark.

## Mechanism 3 — `from_ref` tool args (designed, probe-proven)

Tools accepting content already in the conversation take
`from_ref: "chunk_N"`; frontend materializes and executes with full
content. Schema must state refs resolve to materialized content (exp4).
Probe exp2: PASS, zero re-emission. Saves OUTPUT tokens (3-5× cost).

## Mechanism 4 — Model-driven compaction (retire-with-distill)

The model retires chunks it has consumed AND writes the distillation of
what to keep. `context_retire(chunk_ids, distill)` / `context_unretire` —
frontend-local tools. The tombstone carries the distillation: the model's
own working memory, not a justification note. User's key insights
(2026-08-12): (a) the model has a real sense of what's important in a
piece of info — trust it; (b) the tombstone is MORE informative than the
original slot — what was there, what mattered, where the original lives;
(c) distillation costs output tokens once, saves input tokens on every
subsequent request — one-time cost, compounding return.

- **Knowledge state stays payload-determined**: the kept-knowledge is
  explicit, visible text — reviewable and correctable ("your chunk_5
  distillation missed the tone rule — fix it").
- **Retrieval pathway carries its reason**: unlike a stub (raw excerpts,
  hoping the model infers relevance), the distillation tells the model
  exactly why it might want the original back.
- **Batch discipline** (prompt-cache economics): mid-history tombstones
  invalidate cached prefix — retire in batches; distill-as-consumed early,
  execute later. Budget line = existing rendered-history estimate, placed
  at end of system block or appended to latest user message.
- **User control**: tools only exist when the chat flag is on; every
  distillation renders as a readable tool call; standing rules via system
  prompt ("never retire what I pasted"); toggle off re-expands everything.

### Production evidence (2026-08-11, real toggle-on session)

173-message GLM-5.2 translation session: ~4M tokens transmitted, dedup
saved ~50-90K (**~1-2%**) — below the 20% bar. The corpus flagship got 50%
per-request because its mass is repeats; a real working session is
dominated by UNIQUE history re-transmission. Conclusion: dedup trims,
**only retirement bends the session-sum**. exp6 gates it.

## Probe Evidence (2026-08-11, deepseek-flash-chat unless noted)

| Experiment | Result | Meaning |
|---|---|---|
| exp1 forward-ref | PASS | Labeled chunks dereference spontaneously |
| exp2 from_ref | PASS | Zero content re-emission |
| exp3 diff depth 1 | PASS | Unchanged-region reconstruction |
| exp4 depth 2 + write | explained | Schema contract fix (Mechanism 3) |
| exp5 diff depth 5 | PASS 4/4 | Full chain composition |
| real-history quiz (stub era) | 4/4 | incl. emergent cross-chunk reasoning (118→114) |
| corpus verify (offline) | above | dedup engine on 8 real sessions |
| audit-refs | 13/13 resolve | no dangling references |
| matrix run 1 (flagship, 5 models) | see below | exposed 4 bugs, all fixed |

### Matrix run 1 findings (all addressed)

1. **kimi-chat HTTP 400s** — raw flagship exceeds 262K window. The disease,
   photographed. (With transform: ~385K tokens — still over; needs retirement.)
2. **claude-sonnet 400s** — replay harness synthesized tool-call IDs violating
   Anthropic's `^[a-zA-Z0-9_-]+$`. Fixed (sanitize in replay.mjs).
3. **0% savings where 52% repetition measured** — repetition lives in tool
   ARGS (write payloads); engine only looked at results. Fixed (arg-side
   chaining in chunk-view.js).
4. **Bare base labels** — labels without diffs were pure noise. Fixed
   (labels only where a ref/diff can point).

### Fingerprint lesson (the deep one)

Raw-line dedup missed the 434K×3 re-fetch group entirely: JSON-RPC bodies
are single escaped lines; a 2-char counter difference dropped Jaccard to
0.82 < 0.85. Shape-aware fingerprinting (parse, hash string-field values)
fixed it: 16%→50% on the flagship.

## Industry Context

Researched 2026-08-11 (memory #1330): Copilot CLI offloads at 20KiB (lossy,
accumulates); Claude Code trims stale results (lossy); Aider repo-maps
(lossy). **Nobody ships lossless dedup-reference history, from_ref args,
or model-driven retirement with audit notes.** Blog angle: "history holds
the chunk exactly once — and the model decides what it's done with."

## Phases

### Phase 0 — Metrics + full-text from_ref (cheap wins, no machinery)
- Metrics line per request: payload chars, chunks, refs, prompt_tokens,
  cache-read where reported. May falsify the whole project — that's the point.
- from_ref restricted to full-text chunks (~30 lines + schema sentence).

### Phase 1 — Dedup engine into the app (BUILT in simulation)
- Port chunk-view.js to chat/js/ verbatim; wire into getMessagesForApi
  (assembly point), chunkMeta as derived field, kill-switch
  (`CHUNK_TRANSFORM=off` → raw Layer 1). Per-chat flag; shadow mode first
  (transform logged, raw sent) on live traffic.

### Phase 2 — Model-driven retirement
- context_retire/unretire local tools, retirement map, tombstones,
  budget line, batch discipline. Gated by exp6 (retirement quality) and
  exp7 (ambient chain/ref use — fact needed incidentally, not pointed at).

### Phase 3 — from_ref full (materialize any chunk incl. refs) + optional diffs
- Resolution through the chunk table; MCP tools wrapped transparently.
- ENABLE_DIFFS decision with production metrics in hand.

## Consequences of the Steering (recorded decisions)

- Batched retirement → notes decouple from execution (note-as-consumed
  early, execute in batch later).
- Budget line placement fights the prompt cache → end of system block or
  appended to latest user message.
- chunkMeta follows `currentVersion` on regenerate/version-switch.
- Rebase/Jaccard thresholds bias toward keeping refs (a slightly-wrong
  near-dup ref at 0.85+ is lossless; a missed one is pure cost).
- Metrics may falsify the project → good outcome, Phase 0 exists for that.
- Budget number = existing rendered-history estimate; payload-exact
  estimation rejected as overengineering (user). Tripwire: metrics log
  assembled-chars vs prompt_tokens; payload LARGER than rendered estimate
  = transform leak, visible in logs.

## Success Criteria

1. Corpus flagship: ≥80% with dedup+retirement (dedup alone: 50%).
2. Matrix replay: SAME-trajectory rate ≥ deepseek baseline across all 5
   models on transformed histories.
3. from_ref adoption ≥80% of eligible writes.
4. Zero provider 400s attributable to the transform (auto-heal green).
5. Archive search / embeddings recall unchanged (Layer 1 untouched).

## Files

| Artifact | Purpose |
|---|---|
| [chunk-view.js](chunk-view.js) | The engine (dedup live, diffs parked) — ports to chat/js/ |
| [replay.mjs](replay.mjs) | Multi-model corpus replay + judge |
| [verify-transform.mjs](verify-transform.mjs) | Offline savings per corpus file |
| [audit-refs.mjs](audit-refs.mjs) | Reference-integrity audit |
| [positional-overlap.mjs](positional-overlap.mjs) | Jaccard-vs-diffable analyzer |
| [analyze-repetition.mjs](analyze-repetition.mjs) | Block-level repetition analyzer |
| [probe-chunk-refs.mjs](probe-chunk-refs.mjs) | Synthetic battery exp1-5 |
| [probe-history-transform.mjs](probe-history-transform.mjs) | Real-history continuation quiz |
| [corpus/](corpus/) | 8 real session exports (2 dupes excluded by filename) |
| [results/](results/) | Replay reports per file+model |
