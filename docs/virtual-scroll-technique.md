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
| `chat/js/chat.js` | `renderConversation()`, `_vsActivate()`, `_vsUpdateVisible()`, `_vsDeactivate()` |
| `chat/css/chat.css` | `.vs-stage` class — `position: relative; flex-shrink: 0` |

---

## Porting to NUI Library

To generalize this as an NUI component (e.g., `nui-virtual-scroll`):

1. **Accept a render function** — like `nui-list`'s `options.render`, called to create each element
2. **Accept a data array** — the items to render
3. **Shadow-render all items** on `updateData()` — append to self, measure, set up stage
4. **Expose `scrollToIndex(index)`** — calculate offset from slots array, set `scrollTop`
5. **Handle resize** — debounced re-measure via `ResizeObserver`
6. **Require the `_processed` guard** on any web components used inside items — document this clearly
7. **Binary search** for visible range — O(log n) instead of O(n) for large lists

The component would have the same API surface as `nui-list` but handle variable heights.


## Known Issues (2026-07-11)

### 1. No Resize Recalculation

When the container's width changes (window resize, orientation change, sidebar toggle), element text reflows and their heights change. The cached heights in the slots array become stale.

**Symptoms:** Elements may overlap or have gaps after resize. Scrolling past the new visible range may reveal stale positions.

**Planned fix:** Debounced `ResizeObserver` on the container. On resize:
1. Re-attach all elements to the stage (temporarily)
2. Reset their positioning (remove `position: absolute` so they flow naturally)
3. Force one layout pass, then read all `offsetHeight` values
4. Rebuild offset array, update stage height
5. Re-position all elements with `position: absolute; top: offset`
6. Run visibility pass to detach non-visible

Cost: one append + one layout + N reads + one detach ≈ under 100ms for 700 elements on mobile.

### 2. Chat Bubble Styling Issues

After virtual scroll activation, elements are moved from the `.conversation-container` (flexbox with `gap: 1rem`) into `.vs-stage` (positioned absolutely). This changes the DOM path and can break CSS selectors.

**Symptoms:** Some CSS rules (especially `.conversation-container > .chat-message` or flex-gap-dependent layouts) no longer match.

**Potential fixes:**
- Move any gap-based spacing into the offset calculation (already partially done via margin measurement)
- Audit CSS selectors that depend on the `.conversation-container > .chat-message` parent relationship
- Add `.vs-stage .chat-message` variants where needed

### 3. Streaming Height Updates (FIXED 2026-07-11)

When a new message is appended during streaming, it's now registered as a slot in the slots array immediately (with an initial height estimate of 100px for positioning). On `finalizeAssistantElement`, `_vsOnContentGrown()` re-measures the last slot and updates the stage height and visibility. The streaming element's final height is now correctly reflected in the stage.
