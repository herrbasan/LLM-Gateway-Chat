# Virtual Scroll v2 — Implementation Spec & NUI Module Design

**Date:** 2026-07-12 (rev 2 — upgraded from assessment to implementation spec)
**Builds on:** `docs/virtual-scroll-technique.md` (detached-element recycler, solved 2026-07-11)
**Audience:** an implementation agent with no prior context. Everything needed is in this file plus the referenced source. Work items 1–5 are specified to implementation level; §8 (NUI module / Tier 2) is design-stage — do NOT implement it from this document alone.
**End goal:** extract the technique into a reusable `nui-virtual-scroll` NUI module — easy and reliable enough for third-party use, with a low-cost mode for very large lists (>1000 items).

**Verification protocol (after ANY `chat/js/chat.js` edit):**
1. Syntax — `node --check` is NOT sufficient for browser ES modules (template-literal nesting slips through). Run from repo root:
   ```powershell
   node -e "import('file://' + process.cwd().replace(/\\/g,'/') + '/chat/js/chat.js').then(() => console.log('LOADED')).catch(e => { if (e.name === 'SyntaxError') { console.log(e.stack); process.exit(1); } console.log('SYNTAX OK (browser-global ReferenceError expected)'); })"
   ```
   `ReferenceError: window is not defined` = PASS. `SyntaxError` = FAIL.
2. Cache-bust — bump the version query in `chat/index.html`: `<script src="js/chat.js?v=N">`.
3. Do NOT start or stop server processes — the user manages them. The server serves static files; a browser hard-reload picks up changes.

---

## 0. Current State Reference (as of 2026-07-12)

All virtual-scroll code lives in `chat/js/chat.js`. CSS in `chat/css/chat.css` (`.vs-stage`, `.chat-busy-overlay`).

### State model

```javascript
const VS_MARGIN = 200;              // px overscan above/below viewport
const _vsState = new Map();         // container → state

state = {
    slots: [{ el, height, offset, spacing }],  // ordered top→bottom. SOURCE OF TRUTH.
    totalHeight,        // sum of slot heights = stage pixel height
    stage,              // .vs-stage div: position:relative, explicit height, flex-shrink:0
    attached: Set,      // elements currently in the DOM (subset of slots[].el)
    rafId,              // scroll-listener rAF throttle handle
    resizeTimer,        // ResizeObserver settle timer (300ms)
    measuredWidth,      // container clientWidth the cached heights are valid for
    staleMeasurements,  // true = a measurement was skipped while hidden
    gap                 // container's natural flex row-gap (px), baked into every slot.spacing
};
```

- `slot.spacing` = natural CSS `marginTop + marginBottom + gap`, captured ONCE at slot creation from natural flow. **It can never be re-derived from the DOM** — staged elements carry inline `margin: 0`, so computed margins read 0. Every re-measure MUST use `getBoundingClientRect().height + slot.spacing`.
- `slot.height` = visual box height + spacing. `getBoundingClientRect().height`, NOT `offsetHeight` — offsetHeight ignores CSS `max-height` clamping (thinking-content collapse).
- Detached elements are NOT in the DOM: `querySelectorAll` cannot find them. Any operation over "all messages" must iterate `state.slots`.
- Background chats live in `display:none` containers (`getOrCreateContainer`). **Never measure while `container.clientHeight === 0`** — set `state.staleMeasurements = true` and return; the ResizeObserver settle handler reconciles on switch-back.

### Function inventory

| Function | Contract |
|---|---|
| `_vsActivateWhenReady(container)` | 300ms + rAF settle, then activate |
| `_vsActivate(container)` | Measure all children in natural flow → build stage → absolutize → install scroll listener + container ResizeObserver → first visibility pass → hide busy. Bails (no stage) on 0 messages or hidden container. |
| `_vsRecalculate(container)` | Full re-measure: re-attach all, reset to natural flow, re-read heights AND spacing, re-absolutize. Only called by RO settle when width changed or stale. Bails hidden → stale. |
| `_vsUpdateVisible(container)` | Attach/detach pass: linear slot scan vs `[scrollTop - VS_MARGIN, scrollTop + clientHeight + VS_MARGIN]`. Elements with `data-is-streaming="true"` always stay attached. |
| `_vsRecalcItem(el)` | Single-slot re-measure (rect.height + slot.spacing, transitions frozen during read) + cascade offsets below + stage height + visibility pass. Bails hidden → stale. Throws if slot has no `spacing`. |
| `_vsOnContentGrown(container)` | Recalcs the LAST slot (stream finalize hook). |
| `_vsAppendMessage(container, el)` | THE append path for all new message elements. VS active: absolutize at `state.totalHeight`, append to stage, read natural margins BEFORE setting inline margin:0, register slot with spacing, grow stage. VS inactive: plain `container.appendChild`. |
| `_vsRemoveExchangeDom(clickedEl, exchangeId)` | Deletion without re-render: filter `state.slots` by `dataset.exchangeId` (slots, not DOM — detached siblings), detach removed, rebuild all offsets, shrink stage, visibility pass. Falls back to `renderConversation()` only when the chat empties. |
| `_vsDeactivate(container)` | Cancel rAF + timer, delete state, remove scroll listener, disconnect RO. |
| `_vsShowBusy()` / `_vsHideBusy()` | Spinner overlay on `.chat-main` during activation. Idempotent, no args. |

### Explicit `_vsRecalcItem` call sites (deleted by Work Item 2)

1. buildHistoricalDom tool header toggle (~L871)
2. `renderExchange` tool header toggle (~L3491)
3. live tool header toggle in `handleToolExecution` (~L3992)
4. tool failure UI expand (~L4038)
5. `window.toggleThinking` (~L4444)
6. `regenerate` (~L4672)
7. `switchVersion` (~L4691)

Plus `_vsOnContentGrown` called from `finalizeAssistantElement` (~L4549). Line numbers drift — locate by function name + `_vsRecalcItem` grep.

### CSS facts the code depends on

- `.conversation-container`: `display:flex; flex-direction:column; gap:1rem; overflow-y:auto` — the gap is why `state.gap` exists.
- `.chat-message`: `margin-bottom:1.5rem`; `.user { margin-left:auto }` (right-aligned), `.assistant { margin-right:auto }`, `.tool` full-width. In the stage this is reproduced with inline `left`/`right` per class.
- `.thinking-content`: `transition: max-height 0.3s` — the reason `_vsRecalcItem` freezes transitions before measuring (removed by Work Item 2, which measures mid-animation on purpose).

---

## 1. FIXED: Hidden-Container Height Corruption (2026-07-12)

**The bug.** Background chats live in `display:none` containers (`getOrCreateContainer`). Hidden elements report `offsetHeight`/`getBoundingClientRect().height` of **0**. Three paths measured hidden containers:

1. The container `ResizeObserver` fires on every `switchChat` (size transitions W→0 and 0→W). 300ms after switching *away*, `_vsRecalculate()` ran on the hidden container → every slot height cached as 0 → `_vsUpdateVisible` saw every `[0,0]` slot as inside the viewport → **re-attached all 700 elements** to the hidden container. Switch-back carried a full 700-element layout until the next RO settle re-measured (~300ms) — a hidden full-layout hit plus a broken-scrollbar flash on every switch into a large chat. It self-healed, which is why it went unnoticed.
2. `_vsRecalcItem()` fires from streaming finalize (`_vsOnContentGrown`) — background chats keep streaming while hidden, caching a 0 height for the finalized message.
3. `_vsActivate()` could run on a container hidden during the 300ms `_vsActivateWhenReady` window → corrupt stage built from all-zero measurements.

**The fix (in `chat.js`):**

- `_vsActivate`: bail if `container.clientHeight === 0` — no stage is created, so `switchChat`'s `!querySelector('.vs-stage')` check re-triggers activation when the chat becomes visible.
- `_vsRecalculate` / `_vsRecalcItem`: bail if hidden and set `state.staleMeasurements = true`.
- RO settle handler: skip when hidden; skip when `clientWidth === state.measuredWidth && !staleMeasurements` — cached heights are width-dependent, so an unchanged width means they're still valid. **This also removes the needless full re-measure on every switch-back.**
- `_vsRecalculate` records `state.measuredWidth` on success and clears the stale flag.

**Why this works:** measurements are only ever taken from a visible, laid-out container; invalidation is tracked explicitly (`staleMeasurements`) instead of re-measuring on every visibility transition; and the existing RO settle handler is the single reconciliation point on switch-back.

**Rule for the NUI module:** *never measure while hidden; track staleness; reconcile on visibility.* nui-list enforces the same invariant with an `IntersectionObserver` + `stop` flag gating its rAF loop.

### 1b. FIXED same day: margin loss on re-measure + unmanaged live appends + deletion re-render

- **Margin loss:** `_vsRecalcItem` read computed margins, but staged elements carry inline `margin:0` — reads returned 0, so every re-measure (thinking toggle, tool expand, finalize) permanently stripped the natural 1.5rem spacing. Activation also silently dropped the container's 1rem flex gap. Fix: `slot.spacing` captured once at creation (see §0). **Lesson: any inline style the virtualizer writes destroys the ability to re-read that property from CSS — capture CSS-derived values at slot creation time.**
- **Unmanaged appends:** live tool bubbles and live-sent user messages were `container.appendChild`-ed — landing OUTSIDE the stage, unmanaged, and `_vsRecalcItem` silently no-opped on them. Fix: `_vsAppendMessage` is now the single append path (streaming assistant, live tools, vision-blocked tools, `renderExchange` user/assistant).
- **Deletion:** all 6 delete handlers did a full `renderConversation()`. Fix: `_vsRemoveExchangeDom` splices slots + cascades — same machinery as a height change. The slots array is the source of truth because a deleted exchange's sibling bubble may be detached and invisible to DOM queries.

---

## Work Item 1 — Cascade Decoupling (do this FIRST)

**Problem:** cascades (`_vsRecalcItem`, `_vsRemoveExchangeDom`) write `style.top` on **every** slot below the change, attached or detached. A per-frame cascade during a 300ms animation near the top of a 700-slot chat ≈ 13,000 style writes. Writes to detached elements are pure waste — they're not in the render tree.

**Change — new invariant:** *detached slots never receive style writes; `slot.offset` in the data is authoritative; `style.top` is applied only to attached elements.*

1. `_vsUpdateVisible` attach pass: set `slot.el.style.top = slot.offset + 'px'` immediately **before** `stage.appendChild(slot.el)`. The attach pass must therefore iterate slots (which carry `offset`), not the `shouldAttach` element Set:
   ```
   // pass 1 — detach: for el of state.attached → if !shouldAttach.has(el): removeChild + delete
   // pass 2 — attach: for slot of state.slots → if shouldAttach.has(slot.el) && !state.attached.has(slot.el):
   //     slot.el.style.top = slot.offset + 'px'; stage.appendChild(slot.el); state.attached.add(slot.el)
   ```
2. `_vsRecalcItem` cascade loop: replace the unconditional `s.el.style.top = ...` (and the redundant `s.el.style.margin = '0'`) with:
   ```
   s.offset = offset;
   if (state.attached.has(s.el)) s.el.style.top = offset + 'px';
   ```
3. Same treatment in `_vsRemoveExchangeDom`'s offset-rebuild loop.

**Why it works:** DOM write cost becomes O(attached ≈ 15) instead of O(total), independent of chat length. A detached element's stale `style.top` is harmless — it is ALWAYS refreshed at attach time (step 1). Prerequisite for Work Item 2's per-frame cascade budget.

**Pitfall:** after this change `el.style.top` of a detached element is stale data. Grep for any `.style.top` READS before starting — there must be none (offsets must come from `slot.offset`).

**Acceptance:**
- Expand/collapse a thinking block in a large chat → slots below shift correctly.
- Immediately after a cascade, scroll 3+ screens in both directions → newly attached elements appear at correct positions (fresh `top` applied on attach), no overlaps, no gaps.
- Delete a message mid-chat → same checks.

---

## Work Item 2 — Reactive Height Frame Loop (wake/sleep)

Replaces all explicit `_vsRecalcItem` wiring with a per-container rAF loop that detects height changes on attached slots and cascades automatically. `nui-list` runs the same pattern (`loop()` → `update()` → rAF) and survives it through two disciplines this spec adopts: **dirty-check early-exit** and **visibility gating**. Requires Work Item 1.

### State additions

```javascript
// in _vsActivate's state object:
loopId: null,     // rAF handle of the height loop (null = sleeping)
idleFrames: 0     // consecutive frames with zero height diffs
// module constant:
const VS_IDLE_FRAMES = 30;   // sleep after ~0.5s of no changes
const VS_EPSILON = 0.5;      // px — ignore sub-pixel jitter (prevents cascade loops)
```

### `_vsWake(container)`

```javascript
function _vsWake(container) {
    const state = _vsState.get(container);
    if (!state) return;                    // VS not active — legitimate no-op
    state.idleFrames = 0;
    if (state.loopId !== null) return;     // already awake — idempotent
    state.loopId = requestAnimationFrame(() => _vsOnFrame(container));
}
```

### `_vsOnFrame(container)` — read phase strictly before write phase

```javascript
function _vsOnFrame(container) {
    const state = _vsState.get(container);
    if (!state) return;                               // deactivated — stop
    if (container.clientHeight === 0) {               // hidden — sleep, mark stale
        state.loopId = null;
        state.staleMeasurements = true;               // RO settle reconciles on switch-back
        return;
    }
    // READ: all measurements before any style write
    const scrollTop = container.scrollTop;            // (used by anchoring, WI-3)
    let firstDirty = -1;
    for (let i = 0; i < state.slots.length; i++) {
        const slot = state.slots[i];
        if (!state.attached.has(slot.el)) continue;   // detached can't change height
        const h = slot.el.getBoundingClientRect().height + slot.spacing;  // NEVER computed margins — see §0
        if (Math.abs(h - slot.height) > VS_EPSILON) {
            slot.height = h;
            if (firstDirty === -1) firstDirty = i;    // slots are ordered — first hit is topmost
        }
    }
    // WRITE
    if (firstDirty !== -1) {
        // cascade offsets from firstDirty (WI-1 style: data always, style.top only if attached)
        // scroll anchoring here (WI-3)
        // state.totalHeight + stage.style.height
        _vsUpdateVisible(container);
        state.idleFrames = 0;
    } else {
        state.idleFrames++;
    }
    if (state.idleFrames >= VS_IDLE_FRAMES) { state.loopId = null; return; }  // sleep
    state.loopId = requestAnimationFrame(() => _vsOnFrame(container));
}
```

### Wake triggers (all cheap, all idempotent)

| Trigger | Where |
|---|---|
| scroll | existing scroll listener in `_vsActivate` — add `_vsWake(container)` |
| click / keydown | delegated listeners on the container, added in `_vsActivate`, removed in `_vsDeactivate` (any interaction may toggle something that animates) |
| new message | end of `_vsAppendMessage` (VS-active branch) |
| streaming delta | in `updateAssistantContent` — keeps the loop awake through generation pauses > 0.5s |
| activation | end of `_vsActivate`, after the first visibility pass (catches late-settling web components — neutralizes the 300ms `_vsActivateWhenReady` race) |
| full recalc | end of `_vsRecalculate` |

### Deletions (ONLY after acceptance tests pass)

- All 7 explicit `_vsRecalcItem` call sites (inventory in §0). `window.toggleThinking` reverts to a pure CSS class toggle.
- `_vsOnContentGrown` + its call in `finalizeAssistantElement`.
- The transition-freeze block inside `_vsRecalcItem` (saved transitions, `transition:none`, flush) — mid-animation measurement is now the *feature*: the loop cascades every frame of the 300ms max-height animation, so slots below slide smoothly instead of jumping.
- Then `_vsRecalcItem` itself has no callers — delete it. The streaming placeholder-height guess in `_vsAppendMessage` stops mattering (loop corrects it next frame), and the stage height now tracks streaming growth continuously.

**Keep:** the streaming exemption in `_vsUpdateVisible` (`data-is-streaming` stays attached) — the loop measures only attached slots, so the streaming element must remain attached to be tracked.

### Pitfalls

- ONE loop per container — guard with `state.loopId !== null` in `_vsWake`. Two concurrent loops double-cascade.
- `_vsDeactivate` must `cancelAnimationFrame(state.loopId)`.
- Do not start the loop for a hidden container (`_vsWake` → `_vsOnFrame` handles it by sleeping + stale flag — acceptable, but don't bypass the check).
- `VS_EPSILON` is load-bearing: gBCR returns fractional pixels; comparing with `!==` makes the loop never sleep.
- Height must be `rect.height + slot.spacing`. Reading computed margins re-introduces the margin-loss bug (§1b).

### Acceptance

- Thinking toggle: slots below animate smoothly over ~300ms (no end-jump). Works with zero explicit recalc calls.
- Loop sleeps: add a temporary `console.count` in `_vsOnFrame`; after any interaction settles, counting must STOP within ~1s. (Remove the counter after verifying.)
- Streaming: stage height and scrollbar grow continuously during generation; final height correct without `_vsOnContentGrown`.
- Background chat: stream completing in a hidden chat does not corrupt it — switch back shows correct layout (stale-flag reconciliation).
- Tool expand/collapse, regenerate, version switch: all still reflow correctly with their explicit calls removed.

### Why rAF-with-sleep over ResizeObserver (corrected rationale)

The technique doc dismissed RO on wrong grounds — RO batches once per frame before paint (not "thousands of times"), and one instance observes many elements. RO would be strictly cheaper while idle. rAF-with-sleep is chosen anyway for: nui-list precedent, one code path instead of per-slot observe/unobserve bookkeeping, no size-0-entry filtering on detach, and margin-change blindness doesn't apply (spacing is cached). Both converge in practice.

---

## Work Item 3 — Scroll Anchoring

**Problem:** when a slot *above* the viewport changes height, the cascade shifts all content under the user's eyes. Native browser scroll anchoring can't help — the stage height is explicit and absolute positions bypass it.

**Change:** inside the frame-loop write phase (and any surviving cascade), accumulate the height delta of every dirty slot that sits **fully above the viewport top**, then compensate once:

```javascript
// during the READ loop, alongside marking dirty:
//   if (slot.offset + oldHeight <= scrollTop) anchorDelta += (newHeight - oldHeight);
// during the WRITE phase, after offsets and stage height are updated:
if (anchorDelta !== 0) container.scrollTop = scrollTop + anchorDelta;
```

Use the `scrollTop` read at the top of the frame (read phase), not a fresh read mid-write.

**Why it works:** content the user is reading keeps its viewport position — matches native browser behavior for normal-flow content. No conflict with streaming autoscroll: the streaming slot is at the bottom (never fully above the viewport), so `anchorDelta` is 0 in that path.

**Same treatment in `_vsRemoveExchangeDom`:** deleting a message above the viewport currently yanks content up by its height. Accumulate removed heights for slots fully above `scrollTop` and subtract from `scrollTop`.

**Acceptance:** expand a tool payload near the top of a long chat, scroll down two screens, trigger a re-measure of that tool (collapse it via a temporary console call or the frame loop after WI-2) → visible content must not shift. Delete a message two screens above → no visible jump.

---

## Work Item 4 — Binary Search Visible Range

**Problem:** `_vsUpdateVisible` linearly scans all slots and allocates a `shouldAttach` Set every pass — O(n) + churn, now running every dirty frame (WI-2).

**Change:** slots are sorted by offset — binary-search the first visible index, walk forward to the last:

```javascript
function _vsFirstVisibleIndex(slots, above) {
    let lo = 0, hi = slots.length - 1, ans = slots.length;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (slots[mid].offset + slots[mid].height >= above) { ans = mid; hi = mid - 1; }
        else lo = mid + 1;
    }
    return ans;
}
// range: first = _vsFirstVisibleIndex(slots, scrollTop - VS_MARGIN)
//        last  = walk forward from first while slot.offset <= scrollTop + clientHeight + VS_MARGIN
```

Visible range becomes two integers. Detach pass: iterate `state.attached`, detach anything whose index is outside `[first, last]` and not pinned. This requires an index lookup: maintain `slot.el._vsIndex = i` **everywhere offsets are rebuilt** (`_vsActivate`, `_vsRecalculate`, cascade loops, `_vsRemoveExchangeDom` splice, `_vsAppendMessage`). Pinned (streaming) elements: track in a small `state.pinned` Set instead of the per-slot dataset check, so the range logic stays pure.

**Why it works:** O(log n + visible) per pass, zero allocation. The prerequisite `_vsIndex` bookkeeping also removes `_vsRecalcItem`'s O(n) `findIndex` (moot anyway once WI-2 deletes it).

**Acceptance:** parity test before/after — at 5+ scroll positions (top, bottom, middle, mid-animation), the set of attached elements must be identical to the linear version. Easiest: keep the linear scan behind a temporary flag and assert both produce the same `[first, last]`.

---

## Work Item 5 — Activation Threshold

**Problem:** every non-empty chat gets the full busy-overlay → measure → stage pipeline, even a 3-message chat — pure overhead and extra failure surface.

**Change:**

```javascript
const VS_MIN_ITEMS = 30;  // .chat-message elements, not exchanges
```

1. `_vsActivate`: after the empty check, `if (messages.length < VS_MIN_ITEMS) { _vsHideBusy(); return; }` — no stage, no state. All helpers already degrade correctly: `_vsAppendMessage` plain-appends, `_vsRemoveExchangeDom` takes its no-state branch, `_vsUpdateVisible`/`_vsRecalcItem` no-op.
2. `renderConversation` / `buildHistoricalDomForChat`: skip `_vsShowBusy()` when the exchange count is clearly below threshold (`conversation.getAll().length * 2 < VS_MIN_ITEMS` is a safe under-estimate) — avoids the overlay flash on small chats.
3. Crossing the threshold upward: in `_vsAppendMessage`'s plain branch, after appending, `if (container.querySelectorAll('.chat-message').length >= VS_MIN_ITEMS && !_vsState.get(container)) _vsActivateWhenReady(container);`

**Why it works:** below the threshold the browser handles 30 elements in normal flow effortlessly; the no-state code paths already exist and are exercised. The `if (!state) return` guards throughout gain a legitimate meaning ("VS not active") instead of masking bugs.

**Acceptance:** 5-message chat → no `.vs-stage`, no overlay flash; delete/append/edit all work. Send messages until 30+ → stage appears after settle; layout unchanged. Reload a 700-message chat → virtualized as before.

---

## 7. Global Pitfalls — read before touching ANY of this code

1. **Inline styles destroy CSS reads.** The virtualizer writes `margin:0`, `position`, `top`, `left/right`. Any CSS-derived value you'll need later (margins, gap) must be captured at slot creation — it is unrecoverable afterwards. This caused the margin-loss bug (§1b).
2. **Detached elements are invisible to DOM queries.** `querySelectorAll` misses them. `state.slots` is the source of truth for "all messages". This caused deletion to miss sibling bubbles.
3. **Never measure while hidden.** `container.clientHeight === 0` → every measurement is 0. Set `staleMeasurements`, bail, let the RO settle handler reconcile. This caused the switch-back corruption (§1).
4. **`offsetHeight` ≠ visual height.** It ignores CSS `max-height` clamping — use `getBoundingClientRect().height` for slot measurement.
5. **Web components re-run `connectedCallback` on every re-attach.** Any component inside virtualized content needs the `_processed` guard (see technique doc) or re-attach re-runs the expensive work. `NuiMarkdown` has it; new components must add it.
6. **`node --check` passes broken browser modules.** Use the dynamic-import check from the header. Markdown-style backticks inside template literals are the classic killer.
7. **Multiple containers exist simultaneously** (one per open chat, hidden ones `display:none`, streams continue in them). Never assume `getActiveContainer()` is the element's container — derive via `el.closest('.conversation-container')`.
8. **Bump `chat.js?v=N`** in `chat/index.html` after every edit or the browser serves the stale file.

---

## 8. NUI Module: `nui-virtual-scroll` — Tiered Architecture

> **STATUS: DESIGN-STAGE.** Do not implement from this section alone — it defines the target shape and the concessions, not the implementation. Write a dedicated spec (like Work Items 1–5 above) before starting, after WI 1–5 are proven in chat.js. Note for the module: the hardcoded `.user`/`.tool`/`.assistant` alignment logic must become generic — read each element's computed `margin-left/right: auto` intent before absolutization, or accept a per-item alignment callback.

Two proven implementations, complementary trade-offs:

| | nui-list | detached-element recycler |
|---|---|---|
| Item height | fixed, uniform | variable, measured |
| Element lifetime | created on demand, discarded freely | render-once, recycled forever |
| Item cost assumption | cheap to re-render | expensive (markdown, syntax highlight, web components) |
| Scales to | ~300K items | ~1–2K items (memory + initial render) |

The module unifies them as **tiers selected by item count** (thresholds configurable):

### Tier 0 — Static (< ~30 items)
No virtualization. Normal flow. Zero overhead, zero failure surface.

### Tier 1 — Recycler (~30–1000 items)
The full detached-element technique with §2–§7 applied. All features: render-once, pinned (streaming) items, animated cascades, exact scrollbar, exact `scrollToIndex`.

### Tier 2 — Windowed / Low-Cost Mode (> ~1000 items)

The recycler cannot scale here: render-once means O(n) initial render (markdown-parsing 10,000 messages up front) and O(n) DOM nodes held in memory. nui-list's answer is fixed heights + render-on-demand; Tier 2 adapts that to variable heights:

**Design:**
- **Data-driven, render-on-demand** (nui-list style): requires `options.data` + `options.render(item)`. Only the visible window (~20–30 items) exists as DOM at any time.
- **Estimated heights:** unmeasured items use a running average of all measured items (seeded by `options.estimatedHeight`). Offsets = measured heights where known, estimates elsewhere.
- **Measure-as-you-go:** when an item enters the window it's rendered, measured once, and its real height replaces the estimate (stored permanently — measurements are monotonically accumulated).
- **Anchor correction:** replacing an estimate with a measurement for an item *above* the viewport shifts all offsets below — compensate via scroll anchoring (§4) so the viewport never jumps. The scrollbar is approximate and refines as more items get measured.
- **Bounded element cache (LRU, ~200–300 elements):** rendered elements aren't discarded immediately — recently-used ones are kept detached and re-attached on return (the `_processed` guard still pays off for back-and-forth scrolling). Beyond the cap, oldest elements are dropped and re-rendered on demand.

**Concessions (explicit, documented):**

| Feature | Tier 1 | Tier 2 |
|---|---|---|
| Initial render cost | O(n), all up front | O(window) |
| Memory | O(n) DOM nodes | O(cache cap) |
| Scrollbar accuracy | exact | approximate, self-refining |
| `scrollToIndex` | exact | approximate until neighborhood measured, then corrects |
| Dynamic height changes (frame loop) | full, animated | window-only; off-window changes invisible until re-render |
| Element identity / component state | preserved forever | preserved only within cache window |
| Pinned/streaming items | any | last item only |
| Source | pre-existing DOM **or** data+render | data+render required |

**Why tiers beat one mode:** each tier's guarantees are honest for its scale. Forcing recycler semantics onto 100K items fails on memory; forcing windowed semantics onto a 200-message chat needlessly discards expensive rendered markdown and component state.

### API Sketch

```javascript
const vs = nuiVirtualScroll(containerEl, {
    // Tier 1 (element mode): virtualize existing children
    items: '.chat-message',          // selector or element array
    // Tier 2 (data mode): render-on-demand
    data: [...], render: (item) => el, estimatedHeight: 120,
    // Shared
    thresholds: { activate: 30, windowed: 1000 },  // tier boundaries
    margin: 200,                     // px overscan
    align: (el) => 'left'|'right'|'stretch',  // horizontal positioning
    busyTarget: '.chat-main'         // stable overlay host during activation
});

vs.pin(el);            // exempt from detachment (streaming)
vs.unpin(el);
vs.appendItem(el|data);// register new item at the end
vs.scrollToIndex(i);
vs.recalc();           // force full re-measure (rarely needed — frame loop self-heals)
vs.deactivate();       // restore normal flow, remove listeners/observers
```

**Hard integration contract (document prominently):** any web component rendered inside MUST guard `connectedCallback` against re-processing on re-attach (the `_processed` pattern). This is the single biggest reliability risk for third-party content — without it, re-attach re-runs the expensive work the module exists to avoid.

**Module-internal invariants (from §1):**
1. Never measure while `clientHeight === 0`; set a stale flag instead.
2. Reconcile staleness on the visibility/size transition back (IntersectionObserver or RO settle).
3. Cached heights are width-scoped — re-measure only on width change or staleness.

---

## 9. Implementation Order

1. ~~Hidden-container guards~~ — **DONE 2026-07-12** (§1).
2. ~~Spacing capture, unified append (`_vsAppendMessage`), slot-based deletion (`_vsRemoveExchangeDom`)~~ — **DONE 2026-07-12** (§1b).
3. **Work Item 1** — cascade decoupling. Small, independently testable, prerequisite for WI-2.
4. **Work Item 2** — frame loop. The big one. Verify all acceptance tests BEFORE deleting the explicit call sites; delete in a separate commit so it's revertable.
5. **Work Item 3** — scroll anchoring (slots into WI-2's write phase).
6. **Work Item 4** — binary search. **Work Item 5** — threshold. Independent of each other.
7. Extract to `nui-virtual-scroll` Tier 0/1 (needs a dedicated spec, §8), port chat.js to it, verify parity.
8. Tier 2 windowed mode — new capability, built against a synthetic 10K-item playground page.

Each step: run the verification protocol (header), test in the browser against a large chat AND a second background chat with an active stream, commit separately.
