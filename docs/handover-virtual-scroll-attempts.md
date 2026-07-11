# Handover: Chat Virtual Scroll

**Date:** 2026-07-11
**Status:** SOLVED — detached-element recycler with explicit stage height
**Current state:** Working on desktop and mobile (touch scrolling + scrollbar)

---

## The Problem

Conversations with 300-700+ turns (~600-1400 DOM elements) are unusable on mobile. Each message contains `<nui-markdown>` web components (runs `markdownToHtml()` synchronously in `connectedCallback`) and `<nui-code>` components for syntax highlighting. Hundreds of these in the layout tree simultaneously makes scrolling physically impossible on mobile — single-digit pixels per second.

---

## Attempts and Effects

### Attempt 1: `content-visibility: auto` + `contain-intrinsic-size: auto 500px`

**Approach:** CSS-native virtual scroll. Browser skips rendering off-screen elements, reserves space using estimated height.

**Effect:** Scrollbar jumps when scrolling. The 500px placeholder height doesn't match real element heights. When the browser renders an element on-demand and discovers the real height (e.g., 800px for a code block), the total page height changes and the scrollbar jumps.

**Verdict:** Wrong — placeholder height ≠ real height causes jumps.

---

### Attempt 2: `content-visibility: auto` + measured `contain-intrinsic-size`

**Approach:** Same as above, but after web components settle (300ms delay), measure each element's real `offsetHeight` (including margins) and set it as the exact `contain-intrinsic-size` pixel value.

**Effect:** Scrollbar still desynced. 3:1 drag ratio when using the scrollbar thumb. Root cause: the browser recalculates `scrollHeight` as elements render/skip. Even with correct heights, the browser's internal bookkeeping of which elements are rendered vs skipped causes the scrollbar thumb position to shift during scroll.

**Verdict:** Wrong — `content-visibility` fundamentally fights scrollbar stability for variable-height elements.

---

### Attempt 3: Spacer-swap (element ↔ placeholder div)

**Approach:** On scroll, swap off-screen `.chat-message` elements for lightweight `.vs-spacer` divs with measured heights. Swap back when scrolled into view. Cache `outerHTML` for restoration.

**Effect:** Scrollbar jumps on every swap. Each swap is a layout change (element removed, spacer added). Even though the spacer has the measured height, the browser reflows on each swap. If any height is off by 1px, the scrollbar shifts, triggering another scroll event, triggering more swaps — feedback loop.

Additional bug: first version only queried `.chat-message` elements, so spacers could never be found to swap back. Fixed by querying `.chat-message, .vs-spacer`, but the fundamental jump problem remained.

**Verdict:** Wrong — layout changes on every swap cause feedback loops.

---

### Attempt 4: `display: none` recycler with explicit container height

**Approach:** Render all elements into a `.vs-content` div. After web components settle, measure `scrollHeight` and set it as an explicit `style.height` on `.vs-content`. Then `display: none` off-screen elements. The explicit height is the scrollbar source of truth — `display: none` elements don't affect it.

**Effect:** Uncontrollable scrolling, jumping around wildly. The explicit height should have been stable, but in practice the browser's scroll position calculation interacted badly with elements appearing/disappearing via `display`. When elements toggle between `none` and `''`, the browser may adjust scroll position to compensate, causing jumps.

**Verdict:** Wrong — `display` toggling during scroll causes the browser to fight the scroll position.

---

### Attempt 5: Pagination only (current state)

**Approach:** Only render the last 50 exchanges. "Load older messages" button prepends batches of 50. No virtualization at all. Normal flow, normal scrollbar.

**Effect:** Works perfectly for the loaded elements. Scrollbar is accurate, no jumps. But after loading 3+ batches (150+ elements), mobile scroll performance degrades again because all elements participate in layout/paint.

**Verdict:** Partial solution — works for reasonable conversation sizes, doesn't scale to 700+ turns.

---

## What Would Likely Work (not attempted)

### The NUI-list pattern: absolute positioning with explicit container height

This is the approach used by `lib/nui_wc2/NUI/lib/modules/nui-list.js` for fixed-height items. Adapted for variable height:

**Structure:**
```
.conversation-container (overflow-y: auto)
  └── .vs-content (height: explicit pixel value, position: relative)
        ├── .chat-message (position: absolute, top: 120px)
        ├── .chat-message (position: absolute, top: 460px)
        └── ... only visible ones in the DOM
```

**Data model:**
```javascript
slots: [
  { height: 120, offset: 0,   el: null },     // not in DOM
  { height: 340, offset: 120, el: <div> },    // in DOM, positioned
  { height: 80,  offset: 460, el: null },     // not in DOM
]
totalHeight = sum of all heights + gaps
```

**Lifecycle:**
1. Render all exchanges into a hidden container (the "shadow render"). Can be chunked via `requestAnimationFrame` — batches of ~20, ~1ms per `nui-markdown` processing, total ~700ms for 700 elements. UI stays responsive with a loading indicator.
2. Measure each element's `offsetHeight` + margins. Store on the element: `el._vsHeight = measuredHeight`. Build offset array: `offsets[i] = sum(heights[0..i-1]) + i * gap`.
3. **Detach all elements** from the hidden container. They survive in memory as cached DOM nodes — `innerHTML` intact, event listeners intact, web component state intact. They're just not in the render tree.
4. Create the virtual stage: a div with `height: totalHeight px` (explicit pixel value). This is the scrollbar source of truth. Native scroll, touch throw, momentum — all work perfectly because it's just a div with a known height.
5. On `requestAnimationFrame` scroll handler: calculate visible range from `scrollTop` and `clientHeight`. **Attach** cached elements in that range with `position: absolute; top: offset px`. **Detach** elements that scroll out. Only ~10-15 elements in the DOM at any time.

**CRITICAL — the `connectedCallback` guard:**

`NuiMarkdown.connectedCallback()` (in `lib/nui_wc2/NUI/nui.js` line ~5986) has no guard against re-processing. Every time a detached `nui-markdown` element is re-attached to the DOM, it re-reads the `<script type="text/markdown">` content and re-runs `markdownToHtml()`, replacing `innerHTML`. This is the expensive operation that would fire on every scroll-in.

**Fix:** Add a guard at the top of `connectedCallback`:
```javascript
async connectedCallback() {
    if (this._isStreaming) return;
    if (this._processed) return;  // ← ADD THIS: skip re-processing on re-attach
    // ... existing code ...
    this.innerHTML = markdownToHtml(rawText);
    this._processed = true;  // ← ADD THIS: mark as processed
}
```

With this guard, re-attaching a cached element is free — the browser just places the already-rendered node in the tree. No `markdownToHtml()`, no `nui-code` re-initialization.

**Responsive recalculation (the "mindfuck"):**

When viewport resizes (window resize, orientation change, sidebar toggle), element widths change → text reflows → heights change → all cached heights are invalid.

Re-measure cost: append all cached elements to hidden container in one batch → browser does ONE layout pass → read all `offsetHeight` values (cheap — no reflow per read because layout already computed) → detach all → recalculate offsets → update container height → re-render visible range.

For 700 elements: one append + one layout + 700 reads + one detach ≈ under 100ms on mobile. Debounce the resize event (200ms settle) so it only fires once after the user stops resizing.

**Why it should work where previous attempts failed:**
- Scrollbar is tied to an explicit pixel height we control — not derived from content layout
- Elements are `position: absolute` — they don't affect each other's layout
- No `display` toggling (attempt 4 failure), no `content-visibility` (attempts 1-2 failure), no element swapping (attempt 3 failure)
- Only ~10-15 elements in the DOM at any time
- Re-attach is free with the `connectedCallback` guard
- Native touch scrolling works because the container is just a fixed-height div

**Complexity:** High but bounded. Requires:
- **Shadow rendering is NOT a new performance concern:**

The current app already renders all elements on page load — it takes under a second. The "shadow render" is exactly what already happens today. We just intercept the results (read `offsetHeight` on each element) before detaching the non-visible ones.

No hidden/off-screen container is needed. The visible container IS the measurement surface:
1. Render all elements into the container (exactly like today's page load)
2. Let the browser lay them out (one layout pass — already happening)
3. Read each `offsetHeight` + margins, store on element: `el._vsHeight = h`
4. Build offset array from stored heights
5. Set container to `position: relative; height: totalHeight px`
6. Switch all elements to `position: absolute; top: offset px`
7. Detach all but the visible range

On resize (debounced 200ms): re-attach all elements, read heights, detach non-visible, rebuild offsets, update container height. Same operation, triggered by resize.
- `connectedCallback` guard on `NuiMarkdown` (one-line fix)
- Offset array maintenance (shift all offsets on prepend/edit/delete)
- Streaming support (last element grows — update its slot + container height)
- Resize handler (debounced full re-measure)

---

## Key Files

| File | Role |
|------|------|
| `chat/js/chat.js` | `renderConversation()`, `_loadOlderMessages()`, `renderExchange()` — the rendering pipeline |
| `chat/css/chat.css` | `.conversation-container` (scroll container, flex column, gap 1rem), `.chat-message` (margin-bottom 1.5rem, max-width 85%) |
| `lib/nui_wc2/NUI/lib/modules/nui-list.js` | Reference implementation — fixed-height virtual scroll with explicit container height |
| `lib/nui_wc2/NUI/nui.js` | `NuiMarkdown` class (line ~5986) — `connectedCallback` runs `markdownToHtml()` synchronously |

## Current Rendering Code State

The current `renderConversation()` in `chat/js/chat.js`:
- Creates a `.vs-content` div inside the container
- Renders last 50 exchanges into it
- Calls `_vsInitAfterSettle()` which sets explicit height + runs `_vsUpdateVisibility()`
- `_vsUpdateVisibility()` toggles `display: none` on off-screen elements

**To revert to pure pagination (no virtualization):** Remove the `.vs-content` wrapper, `_vsInitAfterSettle`, `_vsUpdateVisibility`, `_vsAttachScroll`, `_vsDetachScroll` calls. Just render exchanges directly into the container. The pagination logic (`RENDER_BATCH_SIZE`, `_loadOlderMessages`) can stay.

## Performance Bottleneck

The root cause is not element count alone — it's `<nui-markdown>` web components. Each one runs `markdownToHtml()` (regex-based markdown parser) in its `connectedCallback`, and produces `<nui-code>` child components for code blocks. With 700 turns that's ~1400 web components in the layout tree. Any virtualization solution must ensure off-screen `nui-markdown` components are not in the DOM, not just hidden.
