# Dev Plan: Chat Preview Pane

**Status:** Revised post-feedback (Kimi K3 + Claude Fable reviews)
**Date:** 2026-07-21
**Author:** David + Copilot session

---

## Context for reviewers

### What this project is

**LLM Gateway Chat** — a vanilla JavaScript SPA (no framework, no build step) with its own Node.js backend. The chat connects to an LLM Gateway for model inference and runs MCP tools in the browser. The UI is built on **NUI**, a custom high-performance web-component library (not React/Vue/etc). NUI's design philosophy is documented in `lib/nui_wc2/LLM-CHEATSHEET.md` and `lib/nui_wc2/documentation/DOCUMENTATION.md`.

**NUI constraints (these are library rules, not preferences):**

- ❌ **Don't** propose custom CSS on NUI components. Components ARE the style — use attributes or theme variables only.
- ❌ **Don't** suggest React/Vue patterns (virtual DOM, hooks, state libraries). This is a DOM-first library; state lives in the DOM.
- ❌ **Don't** invent new custom element names (`<nui-split>`, `<nui-pane>`). They don't exist — check `documentation/components.json` for what does.
- ❌ **Don't** recommend external dependencies for things NUI already does. It has `enableDrag`, `nui-select`, `nui-markdown`, `nui-code`, etc.

### The design principles are load-bearing — but argue against them if you have a better idea

The **Design principles** section below is not a wishlist. Each one exists because of a specific project constraint or past failure:

- "LLM-driven, not file-system-driven" exists because storage-interception patterns caused invisible staleness bugs in the past.
- "No backend changes for v1" exists because backend changes require deployment to a production server with live data.
- "Local tool, not MCP" exists because MCP transport caps at ~64KB per message.

These are the *current* constraints, not commandments. If you see a fundamentally better approach — even one that violates a principle, restructures the architecture, or scraps part of this plan — say so and make the case. The owner will sort out what to keep and what to discard. What's listed here is the starting point, not the destination.

### Reference points in the codebase

- Existing local tool pattern (`browser_fetch`): `chat/js/chat.js` — search for `ARCHIVE_TOOLS` and `executeLocalTool`.
- Current chat DOM: `chat/index.html` — search for `chat-main`.
- NUI's `enableDrag`: `lib/nui_wc2/NUI/nui.js`. Callback receives `{ type: 'start'|'move'|'end', x, y, percentX, percentY, clientX, clientY, isTouch }`. Use `options.subtarget` to get pre-clamped coordinates relative to a reference element.
- Prime directive (fail-fast, no-defensive-coding, zero-dependency philosophy): `prime-directive.instructions.md` in the VS Code prompts folder.

### Known doc bug (being fixed separately)

`Agents.md` claims a "markdown-it + DOMPurify + Prism.js" stack. **This is stale.** The chat's `renderMarkdown()` is an 8-line wrapper that emits `<nui-markdown>`; all actual rendering goes through NUI's regex-based `markdownToHtml()`. There is no markdown-it, no DOMPurify, no Prism anywhere in the repo. `Agents.md` will be updated in a separate commit. Do not rely on those libraries existing.

---

## One-line summary

Split the chat content area into two columns: chat on the left, a **preview pane** on the right that the LLM can write to via a local tool. The preview is not a file viewer — it's a second rendering surface for the LLM's work product (files, proposed edits, diffs, new artifacts).

## Motivation

Today the chat can render files returned by MCP tools, but only inline in the chat scrollback. That mixes two different things:

1. **The conversation** (back-and-forth, streaming, ephemeral)
2. **The work product** (files, code, docs — persistent, structured, deserves its own surface)

When the LLM edits a file, the user sees a code block buried in chat. There's no way to say "show me the current state of what you're working on" without scrolling. Proposed edits can't be reviewed before being applied.

The preview pane separates these concerns. The chat is the dialog; the preview is the canvas.

## Design principles (non-negotiable)

These are project-wide maxims, not specific to this feature. Any proposal that violates them is wrong.

1. **LLM-driven, not file-system-driven.** The LLM decides what to render. We do not watch storage, intercept tool calls, or guess what the user wants to see.
2. **Native NUI patterns.** Use `nui-markdown`, `nui-code`, `nui-select`, `nui-button`. No custom CSS on NUI components — only theme variables and layout on our own wrappers.
3. **Zero backend changes for v1.** The preview is a browser-side concern. No new REST endpoints, no server state.
4. **Local tool, not MCP.** Like `browser_fetch`, the preview tool is intercepted by the frontend and executed in the browser. No MCP server round-trip.
5. **Fail loud.** Missing required args throw. No silent degradation, no fallback renders.
6. **No defensive coding.** Validate at the boundary (tool args), then trust the data.

## Architecture

### DOM structure (current)

```html
<nui-content>
  <nui-main>                              <!-- absolute, fills content area -->
    <div class="chat-main">               <!-- flex: 1, column -->
      <div class="chat-messages">         <!-- flex: 1 -->
        <div class="conversation-container">...</div>
      </div>
      <footer class="chat-input-area">...</footer>
    </div>
  </nui-main>
</nui-content>
```

### DOM structure (proposed)

```html
<nui-content>
  <nui-main>
    <div class="chat-main">                       <!-- becomes flex-row -->
      <div class="chat-pane">                     <!-- NEW wrapper, holds existing children -->
        <div class="chat-messages">...</div>
        <footer class="chat-input-area">...</footer>
      </div>
      <div class="preview-resizer" hidden></div>  <!-- NEW drag handle -->
      <div class="preview-pane" hidden>           <!-- NEW -->
        <header class="preview-header">
          <nui-select id="preview-select">        <!-- dropdown of shown items -->
            <select>...</select>
          </nui-select>
          <span class="preview-source"></span>    <!-- optional provenance subtitle -->
          <nui-button data-action="preview-close">
            <button><nui-icon name="close"></nui-icon></button>
          </nui-button>
        </header>
        <div class="preview-content"></div>       <!-- nui-markdown or nui-code lands here -->
      </div>
    </div>
  </nui-main>
</nui-content>
```

**Key change:** `.chat-main` flips from `flex-direction: column` to `flex-direction: row`. The existing chat children move inside a new `.chat-pane` wrapper that preserves the old column layout. Everything inside `.chat-pane` works unchanged.

### CSS sketch (scoped, no NUI component styling)

```css
.chat-main {
    display: flex;
    flex-direction: row;                /* was column */
    /* other existing properties unchanged */
}

.chat-pane {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;             /* the old .chat-main layout */
}

.preview-pane {
    flex: 0 0 var(--preview-width, 42rem);
    min-width: 20rem;
    max-width: 80%;
    border-left: thin solid var(--border-shade1);
    background: var(--color-shade1);
    display: flex;
    flex-direction: column;
    overflow: hidden;
}
/* [hidden] must override display: flex — keep both rules adjacent,
   a future "cleanup" that drops this will break the hide behavior */
.preview-pane[hidden] { display: none; }

/* Resizer: wide hit area (8px) with visible 1px line via ::after.
   nui-slider gets away with a thin handle because its track is tall;
   a vertical strip needs a wider grab target. */
.preview-resizer {
    flex: 0 0 8px;
    margin-left: -4px;                  /* overlap the preview border */
    cursor: col-resize;
    background: transparent;
    position: relative;
    z-index: 1;
}
.preview-resizer::after {
    content: '';
    position: absolute;
    left: 50%;
    top: 0; bottom: 0;
    width: 1px;
    transform: translateX(-50%);
    background: var(--border-shade1);
}
.preview-resizer[hidden] { display: none; }
.preview-resizer.dragging::after,
.preview-resizer:hover::after {
    background: var(--color-highlight);
    width: 2px;
}

.preview-header {
    display: flex;
    align-items: center;
    gap: var(--nui-space-half);
    padding: var(--nui-space-half) var(--nui-space);
    border-bottom: thin solid var(--border-shade1);
    flex: 0 0 auto;
}

.preview-header nui-select {
    flex: 1 1 auto;
    min-width: 0;
}

.preview-source {
    font-size: 0.75rem;
    color: var(--text-color-dim);
    padding: 0 var(--nui-space-half);
    flex: 0 0 auto;
}

.preview-content {
    flex: 1 1 auto;
    overflow: auto;
    padding: var(--nui-space);
    min-height: 0;
}

/* Desktop-only for v1. Below 60rem viewport, hide the pane entirely. */
@media (max-width: 60rem) {
    .preview-pane, .preview-resizer { display: none !important; }
}
```

### Resize behavior

Use NUI's built-in `nui.util.enableDrag()` (already in the library, used by `nui-slider`). The callback receives `{ type: 'start'|'move'|'end', x, y, percentX, percentY, clientX, clientY, isTouch }` — switch on `type`, no separate start/move/end wiring needed.

Logic:
- Pass `options.subtarget: chatMainEl` so callback `x` is pre-clamped to `[0, rect.width]` relative to `.chat-main`.
- On `type === 'move'`: compute `newWidth = rect.width - x`. Clamp to `[20rem, 80% of rect.width]`. Apply via CSS variable: `chatMainEl.style.setProperty('--preview-width', newWidth + 'px')`.
- On `type === 'end'`: persist to `localStorage` key `preview-width`.
- **Initial width on first open:** measure `.chat-main` width in JS and set `--preview-width` against it, rather than relying on the CSS `42rem` default. The CSS default doesn't go through the clamp and can overflow on narrow windows.

No custom pointer-event code. `enableDrag` handles pointer capture, touch, and cleanup.

### The local tool: `chat_preview_show`

Registered in `ARCHIVE_TOOLS` (alongside `browser_fetch`). Dispatched in `executeLocalTool` switch. No MCP server involved.

**Schema:**
```json
{
  "name": "chat_preview_show",
  "description": "Render content in the chat's preview pane. The preview is a separate surface from the chat scrollback — use it to show files, proposed edits, diffs, or any work product the user should see alongside the conversation. Calling with an existing id updates that item in place and brings it to front. The user can switch between shown items via a dropdown. Prefer content under ~32KB; for larger files, show the relevant excerpt. Syntax coloring is applied for html, css, javascript, typescript, and json; other languages render as plain monospace (still correct, just uncolored).",
  "parameters": {
    "type": "object",
    "properties": {
      "id": {
        "type": "string",
        "description": "Stable identifier for this preview item. Reusing an id updates the existing item rather than creating a new one. Example: 'file:server.js' or 'proposed-edit:config.json'."
      },
      "title": {
        "type": "string",
        "description": "Human-readable label shown in the dropdown and header. Example: 'server.js' or 'Proposed: config.json'."
      },
      "language": {
        "type": "string",
        "description": "Content type. Use 'markdown' for rendered MD preview. Any other value (javascript, python, json, text, etc.) renders as syntax-highlighted code via nui-code.",
        "default": "text"
      },
      "content": {
        "type": "string",
        "description": "The full content to render. For markdown, this is the raw MD source. For code, this is the source text."
      },
      "source": {
        "type": "string",
        "description": "Optional provenance label. Example: 'storage:foo.js', 'proposed-edit:foo.js', 'generated'. Shown as a subtitle in the header."
      }
    },
    "required": ["id", "title", "content"]
  }
}
```

**Behavior:**
1. Validate: `id`, `title`, `content` must be non-empty strings. `language` defaults to `'text'`. Throw on missing. **Hard cap:** reject `content` over 256KB with a loud throw telling the LLM to excerpt. Unbounded content means unbounded model output tokens (slow, expensive) and unbounded context/history bloat (the tool-call args re-enter context on every subsequent turn and get embedded with the assistant message).
2. Upsert into the items map keyed by `id`. If new, add to dropdown. If existing, update stored content + title.
3. Set active item to this `id` (brings to front — this is how the LLM "selects").
4. Open the preview pane if hidden (remove `hidden` from `.preview-pane` and `.preview-resizer`).
5. Render: `language === 'markdown'` → fresh `<nui-markdown>` element. Anything else → `<nui-code>` with `<pre><code data-lang>`.
6. Return MCP-style confirmation: `{ content: [{ type: 'text', text: '{"shown": true, "id": "...", "selected": true, "itemCount": N}' }] }`. The `itemCount` lets the LLM reason about dropdown state without a second tool call.

**No confirmation bubble in chat.** The tool return value is the LLM's confirmation; the pane opening is the user's. The chat already shows tool-call activity indicators for archive tools — the preview tool inherits that rendering for free.

**Why "select" is implicit:** The LLM shouldn't need two calls (show + select). Calling `chat_preview_show` with any id always brings that item to front. If the LLM wants to update without selecting, that's a future `select: false` option — not in v1.

### State model

In-memory, per-conversation. No localStorage persistence in v1.

```javascript
// preview.js — module-level state
const items = new Map();   // id → { id, title, language, content, source }
let activeId = null;       // currently displayed item id
```

On conversation switch: clear `items`, clear `activeId`, hide pane. **This is a correctness requirement, not just hygiene.** All conversations live in the DOM simultaneously (per-chat `.conversation-container` divs shown/hidden by `switchChat` at `chat.js:4877`). The preview pane is a single shared surface outside those containers — without reset, chat B would see chat A's preview. `switchChat` also runs on initial load and new-chat creation, so `reset()` must be idempotent and safe to call before any `show()` has happened.

Rationale for per-conversation scoping: preview content is contextual to the conversation. Cross-chat persistence is v2.

### Rendering details

Both paths use NUI components. `nui-markdown` handles code fences by emitting `<nui-code>` internally, so markdown with embedded code gets the same highlighting as the direct code path.

**Markdown path** — fresh `<nui-markdown>` element per render:
```javascript
const md = document.createElement('nui-markdown');
const script = document.createElement('script');
script.type = 'text/markdown';
script.textContent = content;
md.appendChild(script);
previewContent.replaceChildren(md);
```

Note: `NuiMarkdown.connectedCallback` has a `if (this._processed) return;` guard — a re-attached or content-swapped element will NOT re-render. Creating a fresh element per render is required, not just convenient. Add a comment in `preview.js` so a future "optimization" doesn't switch to in-place content swapping and silently break updates.

**Code path** — `<nui-code>` with `<pre><code data-lang>` (direct pattern, avoids the `<script type="example">` escaping trap):
```javascript
const codeBlock = document.createElement('nui-code');
const pre = document.createElement('pre');
const code = document.createElement('code');
code.setAttribute('data-lang', language);
code.textContent = content;
pre.appendChild(code);
codeBlock.appendChild(pre);
previewContent.replaceChildren(codeBlock);
```

`data-lang` on the inner `<code>` drives highlighting. NUI highlights `html`/`xml`, `css`, `js`/`javascript`, `ts`/`typescript`, `json`. Everything else renders as clean monospace. The tool description should state this honestly so the LLM knows what it gets.

**Security prerequisite:** both paths depend on the NUI XSS fix being applied first (see *Files touched*). `markdownToHtml` currently has an attribute-injection vector (escapes `&<>` but not `"`, then interpolates raw into `<img src="$2">` / `<a href="$2">`), and `setupCodeBlock` passes `rawText` to `highlight()` without `forceEscape=true`, triggering the `isEscaped` sniff that can skip escaping for the whole block. These are live issues in the chat today, independent of this feature.

### Dropdown population

The `nui-select` in the header reflects `items`. Use the supported API, not manual `<option>` rebuilding:

1. On any change to the items map: call `previewSelect.setItems([...items.values()].map(i => ({ value: i.id, label: i.title })))`. `nui-select` exposes `setItems()` which rewrites the inner `<select>` and resyncs the custom UI.
2. Set the native select's value to `activeId`.
3. Listen for the **`nui-change`** custom event (detail: `{ values, labels, options }`), not the native `change` event, to switch items. On `nui-change`: set `activeId` and re-render content.

When items becomes empty (last item closed): hide the pane.

Insertion-ordered iteration is guaranteed for string keys in JS Maps, so dropdown order is free — just iterate `items.values()`.

### Close behavior

The `×` button in the header closes the pane (sets `hidden` on pane + resizer). Items are preserved — reopening shows the dropdown still populated. (Future: per-item close via right-click or a small × on each dropdown entry. Not in v1.)

## Files touched

| File | Change |
|------|--------|
| `lib/nui_wc2/NUI/nui.js` | **Prerequisite security fix:** escape `"` in `markdownToHtml` global pass; scheme-validate URLs in img/link replacements; pass `forceEscape=true` from `setupCodeBlock` to `highlight()`. Via submodule update. |
| `lib/nui_wc2/NUI/lib/modules/nui-syntax-highlight.js` | **Prerequisite security fix:** the `isEscaped` sniff is bypassed by the `forceEscape=true` arg from the call site above. (Minimal change — ideally delete the sniff outright, but forcing the flag from the one production call site is the safe minimal fix.) |
| `chat/index.html` | Wrap existing chat children in `.chat-pane`; add `.preview-resizer` and `.preview-pane` markup |
| `chat/css/chat.css` | `.chat-main` → flex-row; add `.chat-pane`, `.preview-pane`, `.preview-resizer`, `.preview-header`, `.preview-source`, `.preview-content` rules; mobile hide below 60rem |
| `chat/js/preview.js` | **NEW** — module: state, `show()`, `select()`, `close()`, `render()`, resize wiring, dropdown population |
| `chat/js/chat.js` | Import `preview.js`; add `chat_preview_show` to `ARCHIVE_TOOLS`; add case to `executeLocalTool` switch; wire close button + dropdown via event delegation; call `preview.reset()` in `switchChat` |

**No backend changes.** No new feature dependencies. The NUI changes are security hardening (live XSS in the chat today), not feature additions — they benefit the entire chat and Arena regardless of this feature.

## Out of scope (v2+)

- Per-item close in the dropdown
- localStorage persistence across reloads
- Cross-conversation preview state
- HTML rendering (iframe srcdoc) — security implications need separate analysis
- Diff view (the LLM can render a diff as markdown or code for now)
- Edit-in-place via `nui-code-editor`
- User-initiated file open (the LLM is the only entry path in v1)
- Multiple panes (more than chat + one preview)

## Resolved questions (from Kimi K3 + Claude Fable reviews)

1. **`nui-code` API surface** — RESOLVED. `data-lang` on the inner `<code>` element, not an attribute on `<nui-code>` itself. Both `<script type="example" data-lang>` and `<pre><code data-lang>` patterns work; we use the latter to avoid the `</script>` escaping trap. Verified at `nui.js:1126-1150`.

2. **Resize handle ergonomics** — RESOLVED. 4px is too thin. Use 8px hit area with negative margin overlap and a visible 1px `::after` line. `nui-slider` gets away with thin handles because its track is tall; a vertical strip needs wider grab target.

3. **Mobile / narrow viewport** — RESOLVED. Desktop-only for v1. Below 60rem viewport, hide the pane entirely (`display: none`). The chat is already cramped on mobile; a second column makes it worse. Full-width overlay is a v2 consideration if mobile usage warrants it.

4. **Tool result feedback** — RESOLVED. Silent (no confirmation bubble). The tool return value (`{ shown, id, selected, itemCount }`) is the LLM's confirmation; the pane opening is the user's. The chat already renders tool-call activity indicators — the preview tool inherits that for free.

5. **Streaming** — DEFERRED to v2. `nui-markdown` has `beginStream()` / `appendChunk()` / `endStream()` (verified at `nui.js:6033+`). The v1 schema is already compatible: a future `chat_preview_begin` / `chat_preview_append` / `chat_preview_end` trio composes cleanly with `show`. Update replaces, append extends — no semantic conflict.

6. **Security** — RESOLVED (requires prerequisite fix). The original assumption ("nui-markdown uses markdown-it + DOMPurify") was wrong — that pipeline doesn't exist in this repo. NUI's `markdownToHtml` is regex-based and has a **live attribute-injection XSS today** (escapes `&<>` but not `"`, then interpolates raw into `<img src="$2">` / `<a href="$2">`). `setupCodeBlock` has a second vector via the `isEscaped` sniff in `nui-syntax-highlight.js`. Both must be fixed in NUI before this feature ships. See *Files touched*.

## Implementation order

0. **Prerequisite: NUI XSS fix** — escape `"` in `markdownToHtml`, scheme-validate URLs, pass `forceEscape=true` from `setupCodeBlock`. Submodule update. Benefits the whole chat immediately, independent of this feature.
1. **DOM + CSS** — wrap chat in `.chat-pane`, add hidden preview pane, flip flex direction. Verify chat still works with pane hidden.
2. **preview.js skeleton** — state, `show()` with hardcoded content, `close()`. No tool wiring yet. Manual test via console: `preview.show({id:'test', title:'Test', language:'markdown', content:'# Hello'})`.
3. **Resize handle** — wire `enableDrag` with `subtarget`, switch on `type`, persist on `end`. Measure initial width in JS on first open. Test dragging.
4. **Dropdown** — populate via `setItems()`, listen for `nui-change`, switch items.
5. **Local tool** — add to `ARCHIVE_TOOLS`, dispatch in `executeLocalTool`. Test via LLM call.
6. **switchChat reset** — wire `preview.reset()` into `switchChat`. Verify idempotency on initial load + new chat.
7. **Syntax check** — dynamic import check (not just `node --check`, per the template-literal gotcha) against both `preview.js` AND `chat.js` — both will contain template literals.
8. **Manual smoke** — open chat, trigger tool, verify render, resize, close, reopen, multiple items, switch conversations.

## Success criteria

- LLM calls `chat_preview_show` → pane opens with rendered content.
- Calling again with same `id` updates in place, brings to front.
- Calling with new `id` adds to dropdown, switches to it.
- User can drag the divider to resize; width persists across pane open/close.
- User can switch items via dropdown.
- User can close pane via `×`; items preserved.
- Switching conversations clears preview state.
- No console errors. No XSS vectors. No backend changes.
