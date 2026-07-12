# Virtual Scroll: Detached-Element Recycler

**Technique:** Variable-height virtual scrolling for DOM-heavy content (web components, syntax highlighting, rich text). Works on desktop and mobile (native touch scrolling, momentum, scrollbar drag).

**Solved:** 2026-07-11 in LLM Gateway Chat. After 5 failed approaches, this one works.

---

## The Problem

A chat conversation with 700 turns produces ~1400 DOM elements. Each message contains `<nui-markdown>` web components that run a markdown parser on connect, plus `<nui-code>` components for syntax highlighting. Hundreds of these in the layout tree simultaneously makes scrolling physically impossible on mobile — single-digit pixels per second.

Standard virtual scroll techniques fail because:
- **Fixed-height virtual scroll** (like `nui-list`) can't handle variable content heights
- **`content-visibility: auto`** causes scrollbar jumps — the browser recalculates `scrollHeight` as elements render/skip
- **`display: none` recycling** causes the browser to fight scroll position on every toggle
- **Spacer-swap** (element ↔ placeholder div) causes layout-change feedback loops on every swap

---

## The Solution

**Render all elements once. Measure their heights. Set an explicit stage height. Detach non-visible elements. Re-attach on scroll.**

### Architecture

```
.conversation-container (overflow-y: auto — the scroll container)
  └── .vs-stage (height: explicit pixel value, position: relative, flex-shrink: 0)
        ├── .chat-message (position: absolute, top: 120px)    ← visible, attached
        ├── .chat-message (position: absolute, top: 460px)    ← visible, attached
        └── ... only ~10-15 elements attached at any time
```

Off-screen elements are **detached** (`removeChild`) — fully removed from the render tree but kept in memory as DOM nodes. Their `innerHTML`, event listeners, and web component state survive detachment.

### Data Model

```javascript
slots: [
  { el: <div>, height: 120, offset: 0    },  // element 0
  { el: <div>, height: 340, offset: 120  },  // element 1
  { el: <div>, height: 80,  offset: 460  },  // element 2
  ...
]
totalHeight = sum of all heights
```

Each slot stores:
- `el` — reference to the DOM element (even when detached)
- `height` — measured `offsetHeight` + margins
- `offset` — accumulated top position (sum of all previous heights)

### Lifecycle

#### 1. Initial Render

Render all elements into the container using normal flow — exactly what the page already does on load. This is fast (under a second for 700 elements). All `<nui-markdown>` components process their content, all `<nui-code>` components syntax-highlight.

#### 2. Activate (after web components settle)

Wait for web components to finish rendering (300ms timeout + `requestAnimationFrame`). Then:

1. **Measure:** For each element, read `offsetHeight` + computed margins. Store as `el._vsHeight`.
2. **Build offset array:** `offset[i] = sum(heights[0..i-1])`.
3. **Create stage:** A new `<div class="vs-stage">` with `height: totalHeight px`.
4. **Position elements:** Each element gets `position: absolute; top: offset px; left: 0; right: 0; margin: 0`.
5. **Move all elements into stage:** `stage.appendChild(el)` for each.
6. **Replace container content:** `container.innerHTML = ''; container.appendChild(stage)`.
7. **Track attached state:** `state.attached = new Set(allElements)` — all start attached.
8. **First visibility pass:** `_vsUpdateVisible()` detaches everything outside the viewport.

#### 3. On Scroll (requestAnimationFrame-throttled)

`_vsUpdateVisible(container)`:
1. Read `scrollTop` and `clientHeight` from the container.
2. Calculate visible range: `[scrollTop - margin, scrollTop + clientHeight + margin]`.
3. Scan the slots array. For each slot, check if `[offset, offset + height]` overlaps the visible range.
4. **Detach:** Elements in `state.attached` but NOT in the visible range → `stage.removeChild(el)`.
5. **Attach:** Elements in the visible range but NOT in `state.attached` → `stage.appendChild(el)`.

Only ~10-15 elements are in the DOM at any time. The scan is O(n) but can be optimized to O(log n) with binary search on the offset array.

#### 4. New Message (streaming)

New elements are appended to the stage directly. They get `data-is-streaming="true"` which exempts them from detachment. When streaming finalizes, the height is re-measured and the stage height is updated.

#### 5. Resize (NOT YET IMPLEMENTED)

When the container resizes (window resize, orientation change, sidebar toggle), element widths change → text reflows → heights change → all cached heights are invalid.

**Planned approach:**
1. Debounce the resize event (200ms settle).
2. Re-attach all elements to the stage.
3. Reset their positioning (temporary, for measurement).
4. Read all `offsetHeight` values (one layout pass — cheap per-element after that).
5. Rebuild offset array.
6. Update stage height.
7. Re-position all elements.
8. Run visibility pass to detach non-visible.

Cost: one append + one layout + N reads + one detach ≈ under 100ms for 700 elements on mobile.

---

## Critical Implementation Details

### 1. The `_processed` Guard (NuiMarkdown)

**Without this, the technique does not work.** Web components fire `connectedCallback` every time they're re-attached to the DOM. `NuiMarkdown.connectedCallback()` runs `markdownToHtml()` — the expensive operation we're trying to avoid.

**Fix:** Add a guard to `NuiMarkdown` in `lib/nui_wc2/NUI/nui.js`:

```javascript
async connectedCallback() {
    if (this._isStreaming) return;
    if (this._processed) return;  // ← Guard: skip re-processing on re-attach

    // ... existing markdown processing ...

    this.innerHTML = markdownToHtml(rawText);
    this._processed = true;  // ← Mark as processed
}
```

With this guard, re-attaching a detached element is nearly free — the browser just places the already-rendered node in the tree. No markdown parsing, no syntax highlighting.

**Any web component used inside virtual-scrolled content needs this guard pattern.**

### 2. `flex-shrink: 0` on the Stage

The scroll container is `display: flex; flex-direction: column`. Without `flex-shrink: 0`, the flex container compresses the stage to fit the viewport — making it non-scrollable. The scrollbar gets stuck.

```css
.vs-stage {
    position: relative;
    width: 100%;
    flex-shrink: 0;  /* CRITICAL: prevent flex container from shrinking the stage */
}
```

### 3. `state.attached` Must Start Full

After moving all elements into the stage, `state.attached` must be initialized with ALL elements:

```javascript
const state = {
    slots,
    totalHeight,
    stage,
    attached: new Set(messages)  // ← ALL elements, not empty Set
};
```

If `attached` starts empty, the first `_vsUpdateVisible()` pass has nothing to detach — all elements stay in the DOM.

### 4. Margin Measurement

`offsetHeight` excludes CSS margins. The measurement must include them:

```javascript
const style = getComputedStyle(el);
const marginTop = parseFloat(style.marginTop) || 0;
const marginBottom = parseFloat(style.marginBottom) || 0;
const height = el.offsetHeight + marginTop + marginBottom;
```

Without margins, the stage height is too short and the scrollbar is inaccurate.

### 5. Streaming Elements Exempt from Detachment

Elements with `data-is-streaming="true"` must never be detached — their height is still changing:

```javascript
if (el.dataset.isStreaming === 'true') {
    shouldAttach.add(el);
    continue;
}
```

---

## Why Previous Approaches Failed

| Approach | Failure Mode |
|----------|-------------|
| `content-visibility: auto` + estimated height | Scrollbar jumps — placeholder height ≠ real height |
| `content-visibility: auto` + measured height | Scrollbar desyncs — browser recalculates `scrollHeight` on render/skip |
| Spacer-swap (element ↔ placeholder div) | Layout change on every swap → scroll event → more swaps → feedback loop |
| `display: none` recycler | Browser adjusts scroll position when elements toggle display → jumps |

**The key difference:** Detached nodes are **fully removed** from the render tree. No display toggling, no content-visibility, no swapping. The stage has an explicit pixel height that never changes during scroll. Native scrolling works perfectly.

---

## Files (LLM Gateway Chat Implementation)

| File | Role |
|------|------|
| `lib/nui_wc2/NUI/nui.js` | `NuiMarkdown` class — `_processed` guard in `connectedCallback` |
| `chat/js/chat.js` | `renderConversation()`, `buildHistoricalDomForChat()`, `_vsActivate()`, `_vsUpdateVisible()`, `_vsDeactivate()`, `_vsRecalcItem()`, `_vsRecalculate()`, `_vsOnContentGrown()`, `_vsShowBusy()`, `_vsHideBusy()` |
| `chat/css/chat.css` | `.vs-stage`, `.chat-busy-overlay`, `.chat-busy-spinner` |
| `chat/index.html` | Cache-busted script/css links |

State model: `_vsState` — a `Map<container, { slots, totalHeight, stage, attached: Set, rafId, resizeTimer }>`.

---

## Incremental Recalc (`_vsRecalcItem`) — 2026-07-12

When a single message changes height (thinking toggle, tool expand), the remaining slots below it must shift. `_vsRecalcItem(el)`:

1. **Re-attach** if detached (`stage.appendChild(el)`) — cheap, NUI components skip re-processing via `_processed` guard.
2. **Freeze CSS transitions** on the slot and any `.thinking-content` children. `.thinking-content` has `transition: max-height 0.3s`; measuring mid-animation gives the PRE-change height, not the POST-change height. `transition: none` forces the final state immediately.
3. **Measure** `getBoundingClientRect().height` — NOT `offsetHeight`, which ignores CSS `max-height` clamping.
4. **Restore** transitions.
5. **Cascade**: recompute offsets for every slot from the changed index downward. Slots before keep their offsets.
6. **Update stage height** and **re-evaluate visibility** (`_vsUpdateVisible`).

Always cascades — no early-exit. Cost: O(slots-after-change) offset writes, acceptable for occasional user interactions.

Wired at: 4 tool-toggle sites, `toggleThinking`, `regenerate`, `switchVersion`.

---

## Busy Overlay — 2026-07-12

During the render → measure → activate pipeline, the user saw intermediate DOM ("all messages rendered → container emptied → only visible re-attached"). A busy overlay on `.chat-main` hides this:

- **Target: `.chat-main`** — the only panel with stable dimensions during activation.
- **CSS**: `.chat-main .chat-busy-overlay`, `.chat-main.chat-busy .chat-messages { overflow: hidden }`.
- **JS**: `_vsShowBusy()` appends overlay, `_vsHideBusy()` removes. No arguments, idempotent.
- **Lifecycle**: shown before any DOM work in `renderConversation()`/`buildHistoricalDomForChat()`, hidden after the post-activation visibility pass in `_vsActivate()`.

---

## Proposal: Reactive Height Observer — 2026-07-12

Currently 7 interaction sites (4 tool toggles, thinking toggle, regenerate, version switch) explicitly call `_vsRecalcItem(el)`. This is fragile — every new interaction that changes slot height needs its own call.

Replace explicit calls with a per-container `requestAnimationFrame` loop that polls attached slots' heights and cascades when anything changed. Pattern lifted from `nui-list`'s frame-time update:

```
per-frame (rAF, per active container):
  for each slot in state.slots:
    if slot is attached to stage → read getBoundingClientRect().height
    if height !== slot.height → mark dirty, cascade from here
  if no diffs → return
  if diffs → cascade offsets below first changed slot, update stage height, _vsUpdateVisible
```

**Why rAF instead of ResizeObserver:**
- ResizeObserver fires on ALL attached slots simultaneously during resize events, flooding the loop. rAF throttles to once per frame.
- During streaming, slots resize on every token — ResizeObserver would fire thousands of times. rAF lets `finalizeAssistantElement` remain the single trigger.
- Observer setup/teardown per slot (~12–15 instances active) adds complexity with no benefit over a single per-container loop.

**Benefits over current:**
- Zero wiring for new interaction types. Any CSS change that alters slot height (max-height animation, image load, font resize) is handled transparently.
- Smooth animation: thinking-toggle `transition: max-height 0.3s` cascades via mid-animation `getBoundingClientRect().height` readings (no freeze). 6–8ms per frame for 700 slots, well under the 16ms budget.
- Resilience: a slot whose height drifts for any reason (NUI component re-render, embedded iframe load) self-corrects on the next frame.

**Cost:** per-frame loop walks all state.slots. For a 700-slot chat this is ~0.5ms of integer iteration (O(n) linear scan). The current code already has O(n) in `_vsUpdateVisible` (attached/detached check), so combining them adds no meaningful overhead. Binary search on offset array remains the optimization path for large lists.

**Migration path:**
1. Add `state.heightDirty = false` and an `_vsOnFrame(container)` rAF loop.
2. `_vsOnFrame` checks `getBoundingClientRect().height` on every attached slot. If any differ, cascade + `_vsUpdateVisible`.
3. Remove all 7 explicit `_vsRecalcItem` calls — any height change is caught by the rAF.
4. `toggleThinking` reverts to pure CSS class toggle. No custom JS needed.

---

## Porting to NUI Library

To generalize this as an NUI component (e.g., `nui-virtual-scroll`):

1. **Accept a render function** — like `nui-list`'s `options.render`
2. **Accept a data array** — the items to render
3. **Shadow-render all items** on `updateData()` — append, measure, set up stage
4. **Expose `scrollToIndex(index)`** — calculate offset from slots array, set `scrollTop`
5. **Handle resize** — debounced via `ResizeObserver`
6. **Require the `_processed` guard** on any web components — document clearly
7. **Binary search** for visible range — O(log n)
8. **Expose `recalcItem(el)`** for per-item height changes
9. **Busy-overlay** — accept a CSS selector for the stable container


## Known Issues

### Resize Recalculation (FIXED 2026-07-11)

When the container's width changes (window resize, orientation change, sidebar toggle), element text reflows and their heights change. A `ResizeObserver` on the container detects width changes with a **settle pattern**: each resize event resets a 300ms timer. Only after 300ms of no further resizing does `_vsRecalculate()` fire, preventing thrashing during active resize.

`_vsRecalculate()`:
1. Re-attaches all elements to stage, resets to `position: static` (natural flow)
2. Reads all `offsetHeight` values (one layout pass, then cheap per-element reads)
3. Rebuilds slots with new heights and offsets
4. Re-positions elements with `position: absolute; top: offset`
5. Updates stage height
6. Runs visibility pass to detach non-visible

### 2. Chat Bubble Styling Issues (PARTIALLY FIXED 2026-07-11)

After virtual scroll activation, elements are moved from the `.conversation-container` (flexbox with `gap: 1rem`) into `.vs-stage` (positioned absolutely). This changes the DOM path and can break CSS selectors.

**Fixed:** Horizontal alignment. The original code set `left: 0; right: 0` on all elements, which made user messages full-width from the left (CSS `margin-left: auto` no longer works on absolutely positioned elements). Now uses class-aware positioning: `.chat-message.user → right:0`, `.chat-message.assistant → left:0`, `.chat-message.tool → left:0; right:0`.

**Still possible:** Other CSS rules that depend on the `.conversation-container > .chat-message` parent relationship or flex-gap-dependent layouts. Audit needed if further visual glitches appear.

### 3. Streaming Height Updates (FIXED 2026-07-11)

When a new message is appended during streaming, it's now registered as a slot in the slots array immediately (with an initial height estimate of 100px for positioning). On `finalizeAssistantElement`, `_vsOnContentGrown()` re-measures the last slot and updates the stage height and visibility. The streaming element's final height is now correctly reflected in the stage.

### Thinking Toggle Recalc (FIXED 2026-07-12)

Toggling a thinking block expanded/collapsed used to keep the slot's stored height unchanged — `offsetHeight` ignores CSS `max-height` clamping, so the measurement stayed the same regardless of collapse state. Slots below never shifted; expanded thinking content overflowed visually without pushing anything down.

Fixed by using `getBoundingClientRect().height` for measurement, freezing CSS transitions on `.thinking-content` before reading (the `transition: max-height 0.3s` rule would otherwise give a mid-animation PRE-change height), and always cascading (no early-exit).

### Busy Overlay During Activation (FIXED 2026-07-12)

The render → measure → empty → re-attach pipeline was visible to the user as a janky flash. Fixed with a spinner overlay on `.chat-main` — the only panel with stable dimensions during virtual-scroll activation. Shown before any DOM work, hidden after the post-activation visibility pass.

### Regenerate / Version Switch (OPEN)

Regenerate and version-switch handlers call `_vsRecalcItem` on the changed slot. But reported: regenerate may break version navigation. Image storage also reported broken. Neither is related to virtual-scroll code; investigation needed in `conversation.js` and `file-store.js`.
