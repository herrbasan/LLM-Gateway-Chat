# Context Cost & Reporting Refactor

**Date:** 2026-08-29
**Status:** §3 + §4 + §5a + §5b + §5c — **ALL DONE** (committed, live-verified). Plan complete.
**Supersedes/extends:** [docs/context-length-saga.md](context-length-saga.md) (the saga settles *measurement*; this settles *cost discipline* and *reporting*)
**Tracks:** LLM-Gateway-Chat (view + reporting) · LLM-Gateway (per-provider reasoning policy)

---

## 1. Alignment — what we are optimizing for

Two goals, stated by the user, in this order:

1. **Meaningful cost savings.** Every context-reduction measure must *truly* reduce cost —
   not just shrink the wire payload. Prompt caching is prefix-based: any measure that
   mutates the payload *inside* the cached prefix invalidates the cache from that point
   on, and the recompute is paid as fresh input tokens. A measure that shrinks the
   payload but breaks the cache can cost **more**, not less. **Every measure must be
   worth its cache invalidation.**
2. **Meaningful reporting.** Two numbers are needed, and they answer different questions:
   - **Wire context** (after all measures) → *"Will I hit the context-length limit soon?"*
     This is what the pill shows. It must be exactly what is sent to the endpoint.
   - **Raw context** (before measures) → *"How big is this conversation, really — and how
     much are the measures saving me?"* Needed to understand the measures in operation:
     is dedup doing anything on this chat? Are retirements worth their cache breaks?

The judging rule for any existing or future measure:

> **saving must exceed (cache break cost) + (per-turn residual cost of the mechanism).**
> If a provider *requires* a measure for caching to work at all (e.g. reasoning must be
> present for DeepSeek tool chains), then applying that measure is self-inflicted damage.

---

## 2. The measures, audited against the rule

Current measures, where they mutate, and their cache behavior (analysis from 2026-08-29):

| Measure | Mutates | Cache effect | Verdict |
|---|---|---|---|
| **Dedup (chunk collapse)** | repeated content → one-line ref, deterministic | **Neutral.** Same history → byte-identical payload; prefix preserved across turns. | **Keep.** Pure win — smaller payload *and* cache-stable. |
| **Reasoning strip** | removes `reasoning_content` mid-array, *varies turn to turn* | **Hostile and unstable.** The kept/stripped set changes as new reasoning arrives → breaks the prefix at a *moving* point, every turn. Worse: DeepSeek **requires** prior reasoning on the wire for tool use (400s without it); xAI documents omitting it as the #1 cache-miss cause. | **Fix.** Per-provider policy (§3). For DeepSeek-with-tools we are currently paying full recompute every turn *and* risking 400s. |
| **Retirement (tombstones)** | rewrites an early chunk to a tombstone | **Breaking by design.** One recompute at the retirement point; the mass is then shed from *every* future turn. | **Keep, but batch.** Correct trade when the content would otherwise ride along for many turns. The convention paragraph already tells the model to batch ("each retirement rewrites history and invalidates prompt caching") — keep that pressure. |
| **Unretire** | restores full text mid-array | Breaking by design (mirror of retire). | Keep — deliberate, bounded. |
| **Merge / auto-heal / signature-propagation** | deterministic functions of stored history | Neutral. | Keep. |

**The one structural instability left in dedup:** chunk IDs are *position-derived*
(`chunk_N` counter in payload order). A mid-history edit/delete renumbers every later
chunk → the cache break propagates from the edit point to the end of the conversation
instead of stopping at the edit. Prefix caching can't recover a suffix, so this doesn't
cost cache hits directly — but it makes the label a *lying name* (the same `chunk_3`
means different content on different turns), which is a correctness/alignment hazard
and breaks build-to-build stability for unretire. **Fix: content-derived IDs (§4).**

---

## 3. Per-provider reasoning policy (gateway) — ✅ DONE 2026-08-29

**As implemented** (supersedes the earlier `reasoningRetention` top-level sketch):
the field is `capabilities.priorReasoning` per model (a provider fact inside
capabilities — the adapter derives behavior, the client never acts on it):

```
priorReasoning: 'required' | 'required-with-tools' | 'ignored'   // unset = keep (cache-safe)
```

| Provider | Value | Why |
|---|---|---|
| DeepSeek | `keep-with-tools` | No-tools: prior reasoning ignored → strip is free. With tools: omitting it → API 400. |
| OpenAI | `strip` | **Silently IGNORED, not rejected** (corrected 2026-08-29 via openai/codex #24500 — unknown fields are dropped, no 400). Strip anyway: ignored content is pure token waste and breaks prefix canonicality for no benefit. Continuity via `previous_response_id` / Responses items. |
| xAI (Grok) | `keep` | Omitting prior reasoning is the **documented #1 cache-miss cause** (verified 2026-08-29, docs.x.ai prompt-caching/multi-turn). Not a 400 — a silent full-price recompute every turn. |
| Anthropic | `keep` | Structured thinking blocks with signatures must round-trip verbatim during tool use (400 otherwise). |
| Kimi (K2.7-code) | `keep` | `reasoning_content` always present and must be echoed every turn. |
| z.AI (GLM) | `keep` (with `clear_thinking: false`) | `thinking.clear_thinking` defaults to `true` = server-side clear; retaining reasoning keeps the prefix append-only for the automatic cache. |
| unknown | `keep` | Cache-safe default. |

**Doc updates made 2026-08-29 (storage `documentation/LLM APIs/`):** `provider_xai.md`
gained §6.5 Prompt Caching (append-only rule, reasoning-echo requirement); `provider_openai.md`
gained §8 Prompt Caching (automatic, minimums, `prompt_cache_key`, 1.25× write premium on
GPT-5.6+, reasoning-field-is-ignored note); `provider_zai.md` gained the
`clear_thinking` ↔ cache-continuity note. The saga doc's "OpenAI hard-rejects" claim is
**superseded** — it ignores, doesn't reject.

Enforcement (as built): `applyReasoningHistoryPolicy` in the **openai adapter**
(single payload choke point, strips or injects empty `reasoning_content` on tool-call
messages) + the poison guard in the **anthropic adapter** (unsigned thinking dropped +
warn on native Anthropic only; kept for third-party like Kimi). GLM additionally gets
`thinking.clear_thinking: false` via `capabilities.clearThinkingSupport` (z.AI clears
server-side by default). The chat-app strip in [server/api-view.js](../server/api-view.js)
was **removed** — reasoning passes through verbatim now. Live config set for all 13
models; gateway commits `8c3d183`/`1724ee8`/`358f04a`, chat `a510a6f`. Live-verified:
DeepSeek tool chain 400-free, reasoning on wire.

**Cost note:** this directly serves alignment goal 1 — for DeepSeek tool chats we stop
invalidating the cache every turn, and stop breaking tool chains.

---

## 4. Content-derived chunk IDs (chat app, chunk-view.js) — ✅ DONE 2026-08-29

Replace the position counter with a content hash:

```
chunkId = 'chunk_' + fnv1a64(bareContent).toString(36)
```

- **First sight:** `[chunk_a3f9z]` + full content. **Repeat:** bare `[chunk_a3f9z]` —
  the label IS the ref (drops the `= chunk_X` suffix; shorter, self-describing).
- **64-bit hash** (two-pass FNV-1a or a 64-bit variant) — 32-bit FNV hits birthday
  collisions at realistic chunk counts (~1% at ~600 chunks).
- **Tombstones** already key retirements by content hash — only the label regex
  (`^chunk_\d+$`) widens to `^chunk_[a-z0-9]+$`. Accept both formats on read; never
  rewrite stored numeric labels (they age out naturally). No data migration.
- **Delete `chunkCounter`** and the push-past-label bookkeeping — a whole class of
  ordering bugs goes with it.
- Near-dup refs stay two-named: `[chunk_b7k2 ≈ chunk_a3f9]`.

**Payoff, stated honestly:** not a cache-hit recovery mechanism (prefix cache can't do
that). It (a) confines cache breaks to the mutation point instead of cascading via
renumbering, (b) makes chunk names *true* — the same label always means the same content,
which matters for the alignment question, (c) shortens every dedup ref.

---

## 5. Reporting — the two numbers, everywhere

The runner already counts the real wire payload per turn ([server/token-count.js](../server/token-count.js))
and logs a breakdown. Extend so both numbers are first-class and inspectable.

### 5a. Per-turn data (runner)

`buildSnapshot` / `_assemblePayload` already produce `stats` from `buildChunkView`
(bytesIn, bytesOut, chunks, exactDupes, nearDupes, retired). Capture per turn:

- `rawTokens` — token count of the payload *before* chunk-transform + reasoning policy
  (the no-measures number).
- `wireTokens` — token count of the final payload (already computed).
- Per-measure deltas: `reasoningStripped`, `dedupSaved`, `retiredSaved` (tokens each).
- `cacheHint` — whether this turn's payload prefix matched the previous turn's
  (cheap: hash the prefix up to the last message; a break flag, not a provider number).

Emit in the `context` payload of `run.end` events and the snapshot, so the client can
render it without a second request. Keep the stdout/log breakdown line.

### 5b. The pill (chat.js `updateOverallContext`)

- **Main readout: wire tokens** — unchanged semantics ("will I hit the limit"). This is
  settled; do not regress it to raw.
- **Tooltip: the full picture.** The tooltip is already a debug dump; make it structured:
  - Wire: `75.2K / 131K (57%)` — what the next request sends
  - Raw: `366K` — stored history, no measures
  - Savings breakdown: `reasoning −198K · dedup −71K · retired −22K`
  - Cache: `prefix stable` / `prefix broken at <measure>` for the last turn
- Tooltip is the always-available answer; no click needed.

### 5c. Detailed report (edit/inspector window)

A per-chat "Context" view (button near the pill or in the chat-edit dialog) showing:
- The two numbers over the last N turns (sparkline or small table — wire vs raw).
- The per-measure savings as a stacked breakdown for the latest turn.
- Retirement list: active tombstones (label, distillation, when retired, est. tokens
  saved per turn) — this is also the UI surface where a *manual* retire/unretire could
  later hang, but that is out of scope here.

Data source: the per-turn records from §5a, kept in the conversation's runtime state
(last N, ring buffer) — no new persistence.

---

## 6. Sequencing

1. ~~§3 gateway reasoning policy~~ — **DONE** (live-verified 2026-08-29).
2. ~~§4 content-derived chunk IDs~~ — **DONE** (committed `cd6aff3`, live-verified).
3. **§5a per-turn data** — NEXT. Small; the stats already exist, this wires them through.
4. **§5b tooltip + §5c report view** — UI, depends on §5a.

**Start here next session: §5a.** Wire `rawTokens`/`wireTokens`/per-measure deltas/
`cacheHint` into the runner's `run.end` context payload (the token-count breakdown
already runs per turn — capture, don't recompute). One known gap to fold in: the
breakdown only counts plain `reasoning_content`; via the anthropic adapter reasoning
converts to `thinking` blocks, so policy-kept reasoning can read `reasoning=0` while
present on the wire as a block — the raw/wire computation must count both forms.

## 7. Out of scope (deliberately)

- Manual retire/unretire from the UI (the report view is read-only for now).
- Provider-reported cache telemetry (`prompt_cache_hit_tokens`) — worth checking what
  the gateway surfaces, but not required for this refactor; the prefix-hash hint is
  ours and provider-independent.
- The Question B alignment A/B experiment itself — this refactor builds the
  instrumentation and the per-provider switch that make it runnable.

---

## Work Log

### 2026-08-29 — §4 content-derived chunk IDs (IN PROGRESS)

**Working agreements this session:**
- Keep this log current so a session switch is safe at any point (user may run out of
  credits mid-work).
- End-to-end test against the live chat at `http://localhost:8080/chat/` (an instance is
  open and shared). **UI behavior is the acceptance criterion the user cares about most** —
  verify in the browser, not just in unit tests.

**Implementation plan for §4 (chunk-view.js only):**
1. Add 64-bit FNV-1a (two 32-bit passes with different offset bases, combined) next to
   the existing 32-bit `fnv1a` — keep the 32-bit one untouched: retirement keys are
   persisted as 32-bit hashes and must stay stable.
2. `chunkId = 'chunk_' + fnv1a64(bare).toString(36)`; delete `chunkCounter` and all
   push-past-label bookkeeping.
3. Refs collapse to the bare label: `[chunk_a3f9z]` (first sight carries the body;
   later sightings are the bare label — the label IS the ref). Near-dup keeps both
   names: `[chunk_b7k2 ≈ chunk_a3f9]`.
4. Widen label regexes to accept both legacy numeric and new hash labels:
   `^chunk_[a-z0-9]+$` (stored labels + tombstone labels + `stripOwnLabels` +
   `hadLabel` detection). Legacy numeric labels pass through unchanged, never rewritten.
5. Tombstone path: retirements already keyed by content hash; `r.label` may be legacy
   numeric — both must register in `chunkTable` so `context_retire`/`unretire` resolve.
6. **Tests first (standalone engine, zero deps):** `_scratch/chunk-id-replay.test.js` —
   replay a stored conversation JSON through the transform, assert: (a) idempotence on
   rebuild, (b) repeat-collapse to bare label, (c) legacy numeric labels pass through,
   (d) tombstone resolution both label formats, (e) no `chunkCounter` ordering effects
   (shuffle-free rebuild of edited history keeps stable labels).
7. **E2E in the live chat:** send a turn in a chunkTransform chat, read the per-turn
   `[chunk-view]` breakdown log + inspect the payload labels; retire a chunk via the
   model, confirm tombstone + unretire restore; reload the chat and confirm labels are
   identical across loads (the determinism proof).

**Status: IMPLEMENTED + VERIFIED (offline). Not yet committed.**

What landed:
- [chat/js/chunk-view.js](../chat/js/chunk-view.js): added `fnv1a64` (two-half 64-bit
  FNV-1a); `register()` assigns `chunk_<fnv1a64(bare)>`; deleted `chunkCounter` and all
  push-past-label bookkeeping; exact-dedup repeat → bare label `[chunk_x]\n`; near-dup →
  `[chunk_y ≈ chunk_x]`; widened all label regexes to `chunk_[a-z0-9]+` (legacy numeric
  pass-through preserved, never restamped); convention paragraph rewritten to teach
  content-hash semantics and bare-label collapse.
- [server/internal-tools.js](../server/internal-tools.js): tool-description examples now
  show hash-form labels.
- [_scratch/chunk-id-replay.test.js](../_scratch/chunk-id-replay.test.js): 19 checks,
  ALL PASS (identity, determinism incl. mid-history insert, legacy pass-through,
  tombstones both label formats, convention paragraph content).

Bugs caught and fixed during implementation:
- Diff-chain path (parked, ENABLE_DIFFS=false) referenced `chainBaseId` before
  definition after the refactor — fixed; dead code must still be correct.
- Ref form made `[label]\n` (with newline) so a model-stored ref line round-trips
  through `stripOwnLabels` to empty bare; `hadLabel` now skips registration when bare
  is empty (degenerate-label guard).
- E2E test initially mis-indexed because the convention paragraph is UNSHIFTED as a
  leading system message when none exists — the transform inserts a message.

Verification (live server, restarted 2026-08-29 ~06:02):
- Server up (`/health` 200). Scratch chat `chat_1787983447429_r9o1snme` created with
  chunkTransform:true (still exists, 0 msgs — safe to delete or reuse).
- Snapshot of the 274-msg test chat (`chat_1787906168732_6hlifjf3`) built clean:
  `[chunk-view] in=611K out=179K (-71%) chunks=2 retired=26` — identical stats to
  pre-change (transform output shape stable).
- **Offline replay of the REAL stored conversation through the exact server pipeline**
  (`buildApiMessages` + new engine, store opened via `lib/ndb/napi`):
  new content → hash label `[chunk_8fr8nz1d2h8ge]`; all 26 legacy numeric retirement
  labels (`chunk_2`, `chunk_4`, …) tombstone correctly and re-register; chunkTable
  holds 28 mixed-format labels; 31 messages carry refs. This exercised the identical
  code path `_assemblePayload` runs, including the legacy-migration case.

Remaining (optional): a live turn to see labels flow over SSE + runner log — costs
model tokens; the replay already covered the identical path. Then commit
(chunk-view.js + internal-tools.js + this doc + scratch test).

**UPDATE — §4 COMPLETE and committed (`cd6aff3`).** Live-turn E2E done:
- Scratch chat `chunk-id-e2e-scratch` (chunkTransform:true, model `badkid-llama-chat` —
  local, zero cost), sent a message forcing a `storage_read` of Agents.md. First send
  short-circuited ("No model selected") — the chat needed a model PATCH before the run
  would execute; worth remembering for future E2E.
- Tool call ran; runner breakdown showed `chunks=1` created server-side.
- Offline replay of the *stored* scratch conversation through `buildApiMessages`:
  tool result carries `[chunk_1j9ia1vlur852]`; two builds → identical label,
  byte-identical payload (determinism proof on live-turn data).
- Scratch chat deleted. `_scratch/chunk-id-replay.test.js` is gitignored (stays local).

**Next session starts at §3 (gateway per-provider reasoning policy)** in the
LLM-Gateway repo — file the issue there first (architecture-repo rule), then implement.
Then §5a (per-turn raw/wire + per-measure deltas in the runner's `run.end` context
payload), then §5b/§5c (tooltip + report view).

---

### 2026-08-29 (cont.) — §3 per-provider reasoning policy (IMPLEMENTED, gateway commits local)

**Research first (docs updated in storage `documentation/LLM APIs/`):**
- `provider_openai.md` gained §8 Prompt Caching (automatic, 1024/2048 minimums,
  `prompt_cache_key`, 1.25× write premium on GPT-5.6+, reasoning_content **silently
  ignored not rejected** — supersedes the saga's hard-reject claim).
- `provider_xai.md` gained §6.5 Prompt Caching (append-only rule; omitting prior
  reasoning_content = documented #1 cache-miss cause — cache issue, not a 400).
- `provider_zai.md` gained the `clear_thinking` ↔ cache-continuity note (default true
  actively breaks prefix stability on reasoning models).

**Gateway (D:\DEV\LLM Gateway, local commits on main, NOT PUSHED):**
- `8c3d183` — openai adapter: `applyReasoningHistoryPolicy` at the single payload
  choke point. `capabilities.priorReasoning`: `required` (xAI/Kimi) / `required-with-tools`
  (DeepSeek: keep iff tools advertised) / `ignored` (OpenAI: strip — pure token waste) /
  unset = keep (cache-safe). Legacy `reasoningContent: true` kept working as alias.
  Schema-registered (fail-fast), documented in config.example.json, 7 unit tests pass
  (`tests/reasoning-policy.test.js`).
- `1724ee8` — anthropic adapter: unsigned-thinking poison guard moved gateway-side and
  scoped to native Anthropic (`anthropicVersion` set): drop + warn. Third-party
  (Kimi) keeps the echo. `priorReasoning: 'ignored'` strips. **Incidental fix:
  `countMessageTokens` called async `formatMessages` without `await`** — was sending a
  serialized Promise to count_tokens.

**Chat side (this repo, `a510a6f`):** api-view.js passes `reasoning_content` /
`thinking_signature` through verbatim; the global strip is gone. Verified: unsigned
reasoning now reaches the payload.

**⚠️ REQUIRED before live traffic:** ~~the running gateway's config.json must declare
`priorReasoning` per model~~ **DONE 2026-08-29:** live `D:\DEV\LLM Gateway\config.json`
updated — deepseek-*: `required-with-tools`, grok-*: `required`, kimi-*: `required`,
gpt-chat: `ignored`, glm5-*: `required` + `clearThinkingSupport: true` (z.AI's
`thinking.clear_thinking` defaults true = server discards prior reasoning even when
echoed; `358f04a` adds the `clear_thinking:false` injection for that case).
Gateway commits **pushed** (`8c3d183`, `1724ee8`, `358f04a`); chat commits pushed
(`cd6aff3` → `bd172bf`). **Both servers restarted 2026-08-29 ~08:32.**

**LIVE E2E PASSED** (scratch chat `chat_1787985163748_qz7ezk1h`, deepseek-chat,
chunkTransform on — deleted after): browser_fetch tool chain completed **without a
400** (the strict-history injection works: empty `reasoning_content:""` was injected on
the tool-call turn), and after a real thinking turn the next request carried
`reasoning=43` tokens on the wire (msg[6] in the `[token-count]` breakdown) — prior
reasoning flows to DeepSeek instead of being stripped. Note: the token-count breakdown
only counts plain `reasoning_content`; via the anthropic adapter the reasoning converts
to `thinking` blocks, so policy-kept reasoning can show as `reasoning=0` while still
being on the wire as a block. The 43-token reading is the plain-field path.

**§3 COMPLETE.** Next: §5a (per-turn raw/wire + per-measure deltas in `run.end`
context payload), then §5b/§5c (tooltip + report view).

---

### 2026-08-29 (cont.) — §5a per-turn reporting + §5b tooltip (IMPLEMENTED, uncommitted)

**§5a landed:**
- `chat/js/chunk-view.js`: stats gained `dedupSavedBytes` (exact+near dup refs) and
  `retiredSavedBytes` (tombstone replacements) — byte-level savings split per measure.
- `server/api-view.js`: `buildApiMessages` returns `rawMessages` (pre-transform merged
  payload) + `chunkStats`; breakdown log line gained the savings split.
- `server/token-count.js`: `reasoningOf()` counts BOTH reasoning forms —
  `reasoning_content` and anthropic-form `thinking` blocks (the known gap closed).
- `server/runner.js`: `_contextReport()` per turn — `rawTokens` (no-measures count),
  `wireTokens` (reuses the existing breakdown — capture, not recompute),
  `reasoningTokens`, savings split, `cacheHint`. Folded into the `run.end` context
  payload (`raw_tokens`, `reasoning_tokens`, `savings{dedup_bytes, retired_bytes,
  retired_count, chunks}`, `cache_hint`) + snapshot (`raw_tokens`) + `contextHistory`
  ring buffer (last 50 turns, exposed in snapshot — the §5c data source).
- `reasoningStripped` deliberately NOT reported: the strip is gateway-side (§3),
  invisible to the runner. `reasoningTokens` (on the wire) is the honest number.

**Cache-hint design bug caught mid-verification:** whole-prefix hash always reports
"broken" — every turn appends, so the prefix legitimately grows. Fixed to per-message
hashes compared at the same indices; append-only history → `stable`, a mutation →
`broken at msg[i]` (reports WHERE). **Fix is in runner.js, needs a server restart,
then two-turn verification (turn 2 must read `stable`).**

**§5b landed (beyond spec):**
- Structured rows in the nui-tooltip (`buildContextTooltipHtml`): Wire / Raw /
  Reasoning on wire / Savings (dedup −X B · retired −Y B (n)) / Cache prefix —
  rows render only when data exists. Native `title` debug dump removed.
- Label contrast fix: `--color-shade4` is rgb(80,80,80) in dark mode (invisible on
  the tooltip surface) → `--text-color` at 65% opacity.
- **Click-to-pin persistent panel** (`#context-detail-pop`, manual popover): the
  hover tooltip closes during generation because nui-tooltip hides on ANY captured
  scroll event; the pinned panel has no scroll listener, updates in place on every
  `updateOverallContext`, closes on second click or Esc. Verified live incl. scroll.

**Side quest:** tool-bubble action name — workshop envelope nested (`args.method` =
"agent.action", real action at `args.payload.method`); `formatToolDisplayName` prefers
the nested field, legacy flat fallback. Verified live.

**Live verification so far:** turn 1 on scratch chat `chat_1787986880250_phu1ku5j`
(badkid-llama-chat, chunkTransform on): raw=wire=4014, cache_hint=null (first turn),
context payload carries all new fields. **Pending:** restart → turn 2 `stable`,
tool turn → dedup savings on wire, then delete scratch chat.

**Uncommitted (7 files):** chunk-view.js, api-view.js, token-count.js, runner.js,
chat.js, chat.css, index.html + this doc.

**UPDATE — §5a LIVE-VERIFIED (server restarted ~07:20).** Scratch chat
`chat_1787986880250_phu1ku5j` (badkid-llama-chat, chunkTransform on, deleted after):
- Turn 2 post-restart: `cache_hint: null` — correct (new Runner instance after
  restart = first report; `_lastMsgHashes` is per-instance runtime state).
- Turn 3: **`cache_hint: "stable"`** — append-only history detected correctly.
- Deleted turn 1 mid-history, turn 4: **`cache_hint: "broken at msg[1]"`** — exactly
  right: msg[0] (system prompt) survived, the delete shifted everything from index 1.

**§5a COMPLETE.** Remaining: §5c (report view — data source `contextHistory` ready),
then commit all (§5a + §5b + preview rework + tool-name fix).

**Preview rework (same session, verified live by user):** url-mode preview fetches
went browser-direct to the MCP storage origin (`localhost:3100` — unreachable when
MCP is down or from remote clients, plus CORS). Fixed BFF-style:
- `GET /api/preview/fetch?url=…` (server.js): same-origin proxy, `/storage/...`
  paths resolve against the user's MCP storage origin, absolute http(s) pass
  through server-side (10s bound, text-only). Mirrors the TTS proxy pattern.
- `preview.js _fetchUrlText` fetches through the proxy.
- Auto-open restored: `_runnerToolStart` calls `preview.show(d.args)` on
  `chat_preview_show` tool.start (the tool's effect is client-side; the server
  only validates). The bubble reopen button stays for history reloads.

**UPDATE — §5c report view (IMPLEMENTED + LIVE-VERIFIED).** The pinned panel
(click the pill) is now the full §5c report:
- Data: `_contextReports` per-chat map — `contextHistory` + `meta.retirements`
  stashed from the snapshot, turns appended live from each `run.end` context
  payload (module scope — first attempt landed inside `attachRunnerEvents`,
  `_contextReports is not defined`; moved next to `runnerViews`).
- Renders: headline rows (same builder as the tooltip) + wire-vs-raw SVG
  sparkline (last 30 turns, wire=accent/raw=dim, legend+count) + latest-turn
  savings breakdown + active retirements list (label, distillation, date).
  Sections render conditionally; panel scrolls at 60vh.
- Verified on `chat_1787985868110_45sja5r0` (21 turns, wire<raw gap visible) and
  `chat_1787906168732_6hlifjf3` (22 turns, raw ~600K vs wire ~180K early —
  dedup+retirement impact visible at a glance; savings line `retired −281.8KB
  (26)`; all 26 tombstones listed with legacy numeric labels + distillations).

**PLAN COMPLETE.** §3 (gateway reasoning policy) · §4 (content-derived chunk IDs)
· §5a (per-turn raw/wire/savings/cache-hint) · §5b (structured tooltip + pin)
· §5c (report view).
