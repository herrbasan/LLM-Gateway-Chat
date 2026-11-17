// ============================================
// Preview Pane — LLM-driven second rendering surface
// ============================================
//
// The preview pane is NOT a file viewer. It's a rendering surface the LLM
// writes to via the chat_preview_show local tool. It can show files, proposed
// edits, diffs, or any work product. The LLM decides what to render.
//
// State is in-memory and per-conversation. switchChat() calls reset().
// The pane is a shared surface across per-chat containers — reset is a
// correctness requirement, not just hygiene.

import {
    resolvePreviewUrl,
    inferLanguageFromUrl,
    deriveIdFromUrl,
    deriveTitleFromUrl
} from './preview-url.js';
import { resolveContentHref, noteUrlFromHref, splitNoteSource } from './research-note.js';

// ============================================
// State (module-level, per-conversation)
// ============================================

const items = new Map();   // id → { id, title, language, content, source }
let activeId = null;       // currently displayed item id
let _renderedContent = null;  // tracks what's currently on screen (for TTS invalidation)

// Knowledge-base notes: one dialog at a time, its source fetched from the
// document's own base and reused for the rest of the conversation.
const notes = new Map();   // note url → source text
let noteDialog = null;     // lazily built <nui-dialog> holding the panel
let noteUrl = null;        // url of the note currently in the panel
let noteSeq = 0;           // invalidates a slow fetch that a newer note overtook
let noteParts = null;      // { body, title } refs inside the dialog
let linkObserver = null;   // follows the rendered DOM so no render path re-wires links

// Callback fired when the active content changes (chat.js registers a TTS stop here)
let _onContentChange = null;

// ============================================
// DOM references (populated in init())
// ============================================

let pane, resizer, content, selectEl, sourceEl, closeBtn, viewBtn, chatMain;
let dragCleanup = null;

// ============================================
// Constants
// ============================================

const MIN_WIDTH_PX = 320;          // 20rem at 16px base
const MAX_WIDTH_RATIO = 0.8;       // 80% of chat-main width
const DEFAULT_WIDTH_RATIO = 0.4;   // 40% of chat-main width on first open
const STORAGE_KEY = 'preview-width';
const VIEW_KEY = 'preview-view';        // last chosen view — 'document' | 'deck'
const MAX_CONTENT_BYTES = 256 * 1024;  // 256KB hard cap
const FETCH_TIMEOUT_MS = 15000;        // url-mode fetch cap — never block forever

// Resolver for the MCP server origin, injected by chat.js (getMcpServerOrigin).
// Used to turn relative /storage/... paths into absolute fetch URLs. Topology
// belongs to the client — chat.js owns the origin, preview just asks for it.
let _mcpOriginResolver = null;

/**
 * Inject the MCP server origin resolver. Called by chat.js during init.
 * Must be a function returning the origin string (or null when unconfigured).
 * @param {() => string|null} resolverFn
 */
function setMcpOriginResolver(resolverFn) {
    if (typeof resolverFn !== 'function') throw new Error('preview.setMcpOriginResolver: function required');
    _mcpOriginResolver = resolverFn;
}

// ============================================
// Initialization
// ============================================

function init() {
    pane = document.getElementById('preview-pane');
    resizer = document.getElementById('preview-resizer');
    content = document.getElementById('preview-content');
    selectEl = document.getElementById('preview-select');
    sourceEl = document.getElementById('preview-source');
    closeBtn = document.getElementById('preview-close-btn');
    viewBtn = document.getElementById('preview-view-btn');
    chatMain = document.querySelector('.chat-main');

    if (!pane || !resizer || !content || !selectEl || !sourceEl || !closeBtn || !viewBtn || !chatMain) {
        throw new Error('preview.init: required DOM elements not found');
    }

    // Close button
    closeBtn.addEventListener('click', close);

    // Every anchor rendered into the pane is resolved against the document's
    // own base at click time (a note opens in the dialog, anything else in a
    // new tab). Delegated on the container so no render path has to re-wire.
    wireContentClicks(content, activeItemBase);
    // The same resolution is stamped onto the anchors as they appear: every
    // render builds new ones, and nui-slides clones them for its slides, so the
    // decorator follows the DOM rather than the render call.
    linkObserver = new MutationObserver(() => decorateLinks(content, activeItemBase()));
    linkObserver.observe(content, { childList: true, subtree: true });

    // Document ↔ slide view toggle (markdown items with deck structure only)
    viewBtn.addEventListener('click', toggleView);

    // Dropdown switch — listen for nui-change (NUI's custom event, not native change)
    selectEl.addEventListener('nui-change', (e) => {
        const values = e.detail?.values;
        if (values && values.length > 0 && values[0] !== activeId) {
            activeId = values[0];
            renderActive();
        }
    });

    // Resize handle via NUI's enableDrag
    const nui = window.nui;
    if (!nui?.util?.enableDrag) {
        throw new Error('preview.init: nui.util.enableDrag not available');
    }

    dragCleanup = nui.util.enableDrag(resizer, (data) => {
        if (data.type === 'move' || data.type === 'start') {
            const rect = chatMain.getBoundingClientRect();
            const newWidth = rect.width - data.x;
            const maxWidth = rect.width * MAX_WIDTH_RATIO;
            const clamped = Math.max(MIN_WIDTH_PX, Math.min(newWidth, maxWidth));
            chatMain.style.setProperty('--preview-width', clamped + 'px');
        }
        if (data.type === 'start') {
            resizer.classList.add('dragging');
        }
        if (data.type === 'end') {
            resizer.classList.remove('dragging');
            const currentWidth = chatMain.style.getPropertyValue('--preview-width');
            if (currentWidth) {
                localStorage.setItem(STORAGE_KEY, currentWidth);
            }
        }
    }, { subtarget: chatMain });
}

// ============================================
// Public API
// ============================================

/**
 * Heuristic: does this content look like markdown?
 *
 * The chat_preview_show tool has language as an opt-in hint, and the model
 * frequently hands generated/read markdown without one (defaulting to 'text'
 * → rendered as code, hiding the whole point of the preview). When no
 * explicit language was given, treat clearly-markdown content as markdown.
 * Only returns true on strong signatures — plain prose stays plain text.
 */
function looksLikeMarkdown(content) {
    if (typeof content !== 'string' || !content) return false;
    return /^#{1,6}\s/m.test(content)          // ATX heading
        || /^\s*```/m.test(content)             // fenced code block
        || /^\s*[-*+]\s+\S/m.test(content)      // list item
        || /^\s*>\s+\S/m.test(content)          // blockquote
        || /^\s*---\s*$/m.test(content)         // frontmatter / horizontal rule
        || /\*\*[^*\n]+\*\*/m.test(content)     // bold
        || /\[[^\]]+\]\([^)]+\)/m.test(content) // link
        || /^\s*\|.+\|/m.test(content);         // table
}

// ============================================
// View mode — document (flow) ↔ deck (slides)
// ============================================

function defaultView() {
    return localStorage.getItem(VIEW_KEY) === 'deck' ? 'deck' : 'document';
}

/**
 * Does this document have the structure a deck needs? A deck is one section per
 * slide, so the document must carry at least one root-level section break or
 * MD-Blocks structure. Frontmatter is removed first: its opening and closing
 * `---` lines are not sections.
 */
function hasDeckStructure(content) {
    if (typeof content !== 'string' || !content) return false;
    let body = content;
    const fm = body.match(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/);
    if (fm) body = body.slice(fm[0].length);
    if (/<!--\s*mb:/.test(body)) return true;
    return /^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/m.test(body);
}

function setViewButton(isDeck) {
    if (!viewBtn) return;
    const label = isDeck ? 'Document view' : 'Slide view';
    viewBtn.title = label;
    viewBtn.setAttribute('aria-label', label);
    const button = viewBtn.querySelector('button');
    if (button) button.setAttribute('aria-label', label);
    const icon = viewBtn.querySelector('nui-icon');
    if (icon) icon.setAttribute('name', isDeck ? 'article' : 'fullscreen');
}

function toggleView() {
    const item = activeId && items.get(activeId);
    if (!item || !hasDeckStructure(item.content)) return;
    item.view = item.view === 'deck' ? 'document' : 'deck';
    localStorage.setItem(VIEW_KEY, item.view);
    renderActive();
}

/**
 * Show or update a preview item. Called by the chat_preview_show local tool.
 * Brings the item to front (selects it). Opens the pane if hidden.
 *
 * TWO MODES — pass EXACTLY ONE of content or url:
 *   content mode: render generated text (id, title, content required)
 *   url mode:     fetch an existing file and display it (url only required;
 *                 id/title/language/source derived from the url when omitted)
 *
 * @param {Object} args - Tool arguments
 * @param {string} args.id - Stable identifier (reuse to update in place)
 * @param {string} args.title - Human-readable label for dropdown
 * @param {string} [args.content] - Content mode: the text to render
 * @param {string} [args.url] - Url mode: /storage/... path or absolute http(s) url to fetch
 * @param {string} [args.language='text'] - 'markdown' for rendered MD, else code language
 * @param {string} [args.source] - Optional provenance label
 * @returns {Promise<Object>} MCP-style result { content: [{ type: 'text', text }] }
 */
async function show(args) {
    // Success conditions — fail fast on invalid input
    if (!args || typeof args !== 'object') throw new Error('preview.show: args object required');
    const hasContent = typeof args.content === 'string' && args.content.length > 0;
    const hasUrl = typeof args.url === 'string' && args.url.length > 0;
    if (hasContent && hasUrl) throw new Error('preview.show: provide EITHER content OR url — never both');
    if (!hasContent && !hasUrl) throw new Error('preview.show: content or url required');

    let id = args.id;
    let title = args.title;
    let language = typeof args.language === 'string' && args.language.length > 0 ? args.language : 'text';
    let source = typeof args.source === 'string' && args.source.length > 0 ? args.source : null;
    let content;
    let docBase = null;

    if (hasContent) {
        // MODE A — generated content (existing behavior)
        content = args.content;
        if (typeof id !== 'string' || id.length === 0) throw new Error('preview.show: id required when using content');
        // title is display-only dropdown metadata — a missing one must not
        // block the render. Derive a label from the stable id and trace it.
        if (typeof title !== 'string' || title.length === 0) {
            console.warn('[preview] content mode missing title — deriving from id:', id);
            title = id;
        }
    } else {
        // MODE B — fetched file: the model hands just the url, the preview
        // fetches and displays it. No regeneration of content.
        const resolvedUrl = resolvePreviewUrl(args.url, _mcpOriginResolver);
        docBase = resolvedUrl;
        try {
            content = await _fetchUrlText(resolvedUrl);
        } catch (err) {
            renderFetchError(resolvedUrl, err);
            throw err;
        }
        if (typeof id !== 'string' || id.length === 0) id = deriveIdFromUrl(resolvedUrl);
        if (typeof title !== 'string' || title.length === 0) title = deriveTitleFromUrl(resolvedUrl);
        if (typeof args.language !== 'string' || args.language.length === 0) language = inferLanguageFromUrl(resolvedUrl);
        if (!source) source = resolvedUrl;
    }

    // No explicit language hint and clearly-markdown content → render as MD.
    // Otherwise the LLM's read/generated markdown shows as raw code.
    if (language === 'text' && looksLikeMarkdown(content)) {
        language = 'markdown';
    }

    if (content.length > MAX_CONTENT_BYTES) {
        throw new Error(`preview.show: content exceeds ${MAX_CONTENT_BYTES} byte cap (${content.length} bytes). Excerpt it and pass content, or show a smaller file.`);
    }

    // Upsert into items map
    const isNew = !items.has(id);
    const prevItem = items.get(id);
    const contentChanged = isNew || prevItem.content !== content;

    items.set(id, {
        id,
        title,
        language,
        content,
        source,
        // Per-item view, defaulting to whatever was used last. Only markdown
        // items with deck structure can actually render as a deck — renderActive
        // is the gate, so an item may carry 'deck' while its content has none.
        view: isNew ? defaultView() : prevItem.view,
        // Document base (issue #38): in url mode the fetched document HAS a
        // location — its resolved URL — and relative media destinations must
        // resolve against it, like any viewer opening the file from disk.
        // Content mode has no location; base stays null and relative paths
        // render as authored.
        base: docBase
    });

    // Select this item (brings to front)
    activeId = id;

    // Open pane if hidden
    openPane();

    // Update dropdown + render
    syncDropdown();
    renderActive();

    // If content changed, fire the callback so chat.js can stop stale TTS.
    // The old audio no longer matches what's on screen — keeping it playing
    // would be a silent lie (user sees new content, hears old content).
    if (contentChanged && _onContentChange) _onContentChange();

    return {
        content: [{
            type: 'text',
            text: JSON.stringify({
                shown: true,
                id,
                selected: true,
                itemCount: items.size,
                mode: hasContent ? 'content' : 'url',
                url: hasUrl ? args.url : undefined
            })
        }]
    };
}

async function showUi(args) {
    if (!args || typeof args !== 'object') throw new Error('preview.showUi: args object required');
    if (typeof args.url !== 'string' || !args.url.trim()) throw new Error('preview.showUi: url required');
    const url = new URL(args.url, window.location.origin);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('preview.showUi: only HTTP(S) UIs are supported');
    const rawMcpOrigin = _mcpOriginResolver ? _mcpOriginResolver() : null;
    const mcpOrigin = rawMcpOrigin ? new URL(rawMcpOrigin).origin : null;
    if (url.origin !== window.location.origin && url.origin !== mcpOrigin) {
        throw new Error(`preview.showUi: untrusted UI origin ${url.origin}`);
    }
    const id = typeof args.id === 'string' && args.id ? args.id : `tool-ui-${url.toString()}`;
    const title = typeof args.title === 'string' && args.title ? args.title : 'Tool UI';
    const previous = items.get(id);
    items.set(id, {
        id, title, language: 'ui', kind: 'ui', content: url.toString(), url: url.toString(),
        source: url.origin, view: 'document', base: null
    });
    activeId = id;
    openPane();
    syncDropdown();
    renderActive();
    if ((!previous || previous.content !== url.toString()) && _onContentChange) _onContentChange();
    return { content: [{ type: 'text', text: JSON.stringify({ shown: true, id, selected: true, itemCount: items.size, mode: 'ui', url: url.toString() }) }] };
}

// ============================================
// Internal: URL fetch mode helpers
// ============================================

function renderFetchError(url, err) {
    activeId = null;
    _renderedContent = null;
    syncDropdown();
    openPane();
    viewBtn.hidden = true;
    content.classList.remove('deck-mode', 'ui-mode');
    const error = document.createElement('div');
    error.className = 'preview-fetch-error';
    error.setAttribute('role', 'alert');
    error.textContent = err.message;
    content.replaceChildren(error);
    sourceEl.textContent = url;
    sourceEl.title = url;
    if (_onContentChange) _onContentChange();
}

/**
 * Fetch a url and return its text content. Goes through the same-origin
 * backend proxy (/api/preview/fetch) — the MCP storage server binds localhost
 * on the server host and is not reachable from remote browsers directly.
 * Network is unpredictable — bounded by FETCH_TIMEOUT_MS so a hanging server
 * never leaves the tool stuck. Fails loudly on non-2xx and on timeout.
 */
async function _fetchUrlText(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(`/api/preview/fetch?url=${encodeURIComponent(url)}`, { signal: controller.signal });
        if (!res.ok) {
            let detail;
            if (res.headers.get('content-type')?.includes('application/json')) {
                const body = await res.json();
                detail = body.error || JSON.stringify(body);
            } else {
                detail = await res.text();
            }
            throw new Error(`preview: fetch failed (${res.status} ${res.statusText}) for ${url}${detail ? ` — ${detail}` : ''}`);
        }
        return await res.text();
    } catch (err) {
        if (err.name === 'AbortError') {
            throw new Error(`preview: fetch timed out after ${FETCH_TIMEOUT_MS}ms for ${url}`);
        }
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Close the preview pane. Items are preserved — reopening shows the dropdown
 * still populated.
 */
function close() {
    if (!pane) return;
    pane.hidden = true;
    resizer.hidden = true;
}

/**
 * Reset all state. Called on conversation switch (switchChat).
 * Must be idempotent — runs on initial load and new-chat creation
 * before any show() has happened.
 */
function reset() {
    items.clear();
    activeId = null;
    _renderedContent = null;
    noteSeq++;                        // a fetch in flight must not land in the next conversation
    noteUrl = null;
    notes.clear();
    if (noteDialog && noteDialog.isOpen()) noteDialog.close('reset');
    if (noteParts) noteParts.body.replaceChildren();
    if (content) content.replaceChildren();
    if (content) content.classList.remove('deck-mode', 'ui-mode');
    if (viewBtn) viewBtn.hidden = true;
    if (sourceEl) sourceEl.textContent = '';
    close();
    if (selectEl?.setItems) {
        selectEl.setItems([]);
    }
}

// ============================================
// Internal: pane open/close with width management
// ============================================

function openPane() {
    // Measure initial width on first open — don't rely on CSS 42rem default
    // which doesn't go through the clamp and can overflow on narrow windows
    if (!chatMain.style.getPropertyValue('--preview-width')) {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved) {
            chatMain.style.setProperty('--preview-width', saved);
        } else {
            const rect = chatMain.getBoundingClientRect();
            const initialWidth = Math.max(MIN_WIDTH_PX, rect.width * DEFAULT_WIDTH_RATIO);
            chatMain.style.setProperty('--preview-width', initialWidth + 'px');
        }
    }

    pane.hidden = false;
    resizer.hidden = false;
}

// ============================================
// Internal: dropdown synchronization
// ============================================

function syncDropdown() {
    if (!selectEl?.setItems) return;

    const itemList = [...items.values()].map(item => ({
        value: item.id,
        label: item.title
    }));

    selectEl.setItems(itemList);

    // Set through the component API (NOT the native select .value) so the
    // custom control label (nui-select-value) syncs with activeId. Setting
    // nativeSelect.value directly left the label stale — it showed the first
    // option (setItems rebuilds options with no selected), so the user picked
    // a wrong item first and had to "switch back and forth" to reach real one.
    if (selectEl.setValue) selectEl.setValue(activeId || '');
}

// ============================================
// Internal: rendering
// ============================================

function renderActive() {
    if (!content) return;
    if (!activeId || !items.has(activeId)) {
        content.replaceChildren();
        content.classList.remove('deck-mode', 'ui-mode');
        if (viewBtn) viewBtn.hidden = true;
        if (sourceEl) sourceEl.textContent = '';
        return;
    }

    const item = items.get(activeId);

    // Detect content change from dropdown switch (show() handles its own detection).
    // If the rendered content differs from what's on screen, fire the callback
    // so chat.js can stop stale TTS.
    if (_renderedContent !== item.content) {
        _renderedContent = item.content;
        if (_onContentChange) _onContentChange();
    }

    // Update source label
    if (sourceEl) {
        sourceEl.textContent = item.source || '';
        sourceEl.title = item.source || '';
    }

    if (item.kind === 'ui') {
        if (viewBtn) viewBtn.hidden = true;
        content.classList.remove('deck-mode');
        content.classList.add('ui-mode');
        renderUi(item);
        return;
    }
    content.classList.remove('ui-mode');

    if (item.language === 'markdown') {
        const deckCapable = hasDeckStructure(item.content);
        const isDeck = deckCapable && item.view === 'deck';
        // A markdown document with no section structure has exactly one slide and
        // would overflow it — the toggle is not offered (spec §9: sections are the
        // slide unit; a plain document is one surface).
        if (viewBtn) viewBtn.hidden = !deckCapable;
        setViewButton(isDeck);
        content.classList.toggle('deck-mode', isDeck);
        if (isDeck) {
            renderDeck(item.content, item.base);
        } else {
            renderMarkdown(item.content, item.base);
        }
    } else {
        if (viewBtn) viewBtn.hidden = true;
        content.classList.remove('deck-mode');
        renderCode(item.content, item.language);
    }
}

/**
 * Render markdown via nui-markdown.
 *
 * CRITICAL: NuiMarkdown.connectedCallback has a `if (this._processed) return;`
 * guard — a re-attached or content-swapped element will NOT re-render.
 * Creating a fresh element per render is REQUIRED, not just convenient.
 * Do not "optimize" this to in-place content swapping.
 */
function renderMarkdown(mdContent, base) {
    const md = document.createElement('nui-markdown');
    // Previews show rendered work product, not document metadata — strip
    // frontmatter (nui-markdown default 'show' renders it as a card).
    md.setAttribute('frontmatter', 'strip');
    // Deck authoring surface: label each section boundary ("Slide 2 of 7"). Set
    // BEFORE appending — the component reads its attributes once, at render, and
    // its _processed guard ignores later changes.
    md.setAttribute('show-breaks', 'Slide');
    if (base) md.base = base;
    const script = document.createElement('script');
    script.type = 'text/markdown';
    script.textContent = mdContent;
    md.appendChild(script);
    content.replaceChildren(md);
}

/**
 * Render the same markdown through the nui-slides presentation profile.
 * One section = one slide, chrome repeats per slide, the canvas scales to the
 * pane. A fresh element per render is required for the same reason as
 * renderMarkdown: nui-markdown's `_processed` guard ignores re-attachment.
 */
function renderDeck(mdContent, base) {
    const deck = document.createElement('nui-slides');
    deck.setAttribute('toolbar', '');
    // Natural flow, not `height="fill"`: the container itself is locked to the
    // deck's 16:9 canvas. A filled viewport stretches to the pane and letterboxes
    // the surface, which reads as a container that is not 16:9.
    const md = document.createElement('nui-markdown');
    md.setAttribute('frontmatter', 'strip');
    if (base) md.base = base;
    const script = document.createElement('script');
    script.type = 'text/markdown';
    script.textContent = mdContent;
    md.appendChild(script);
    deck.appendChild(md);
    content.replaceChildren(deck);
}

/**
 * Render code via nui-code with <pre><code data-lang>.
 * Uses the direct pattern (not <script type="example">) to avoid
 * the </script> escaping trap.
 */
function renderCode(codeContent, language) {
    const codeBlock = document.createElement('nui-code');
    const pre = document.createElement('pre');
    const code = document.createElement('code');
    code.setAttribute('data-lang', language);
    code.textContent = codeContent;
    pre.appendChild(code);
    codeBlock.appendChild(pre);
    content.replaceChildren(codeBlock);
}

/**
 * Get the active item's content as plain text suitable for TTS.
 * Strips markdown formatting via the same getPlainText utility the chat uses.
 * Returns empty string if no active item.
 *
 * @param {Function} plainTextFn - The getPlainText function from tts-utils.js
 * @returns {string}
 */
function getActivePlainText(plainTextFn) {
    if (!activeId || !items.has(activeId)) return '';
    const item = items.get(activeId);
    if (item.kind === 'ui') return '';
    return plainTextFn(item.content);
}

/**
 * Get the current preview state for the LLM.
 * Returns metadata only (no content) — the LLM already has the content
 * in its context from when it called chat_preview_show.
 *
 * @returns {Object} MCP-style result { content: [{ type: 'text', text }] }
 */
function getState() {
    const state = {
        paneOpen: pane ? !pane.hidden : false,
        activeId,
        activeTitle: activeId && items.has(activeId) ? items.get(activeId).title : null,
        items: [...items.values()].map(item => ({
            id: item.id,
            title: item.title,
            language: item.language,
            source: item.source
        }))
    };
    return {
        content: [{
            type: 'text',
            text: JSON.stringify(state, null, 2)
        }]
    };
}

function renderUi(item) {
    const frame = document.createElement('iframe');
    frame.className = 'preview-ui-frame';
    frame.title = item.title;
    frame.src = item.url;
    // Trusted, configured origins only (enforced by showUi). No top navigation,
    // popups, or same-origin escape to untrusted content; forms and downloads
    // remain available for editor/save/export workflows such as /print.
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-downloads');
    frame.referrerPolicy = 'strict-origin-when-cross-origin';
    content.replaceChildren(frame);
}

// ============================================
// Knowledge-base notes — research-note links open as an inline dialog
// ============================================
//
// The blog bakes one <dialog> per cited note at build time; a preview has no
// build, so the note source is fetched from the link's own destination and
// shown in the same kind of panel — a side excursion over the document, not a
// page the reader has to leave. One note at a time: a note→note link swaps the
// panel, matching the site's own chrome.

function activeItemBase() {
    const item = activeId ? items.get(activeId) : null;
    return item ? item.base : null;
}

/**
 * Delegated click handling for rendered markdown. The base is read at click
 * time, so a render that replaces the DOM needs no new listener.
 */
function wireContentClicks(root, getBase) {
    root.addEventListener('click', (e) => {
        const anchor = e.target.closest && e.target.closest('a[href]');
        if (!anchor) return;
        const href = anchor.getAttribute('href');
        if (!href) return;
        const base = getBase();
        const noteHref = noteUrlFromHref(href, base, _mcpOriginResolver);
        if (noteHref) {
            if (!base) console.warn(`[preview] note link "${href}" resolved without a document base — assumed ${noteHref}`);
            e.preventDefault();
            void showNote(noteHref);
            return;
        }
        const url = resolveContentHref(href, base, _mcpOriginResolver);
        if (!url) return;   // in-page anchor, non-http scheme, or a locationless relative path
        e.preventDefault();
        window.open(browserHref(url), '_blank', 'noopener,noreferrer');
    });
}

/**
 * The storage origin binds localhost on the server host, so a browser cannot
 * reach it from anywhere else. Deep links go through the backend's same-origin
 * /storage/* proxy instead (issue #36), which is also what makes them survive
 * the public nPort origin.
 */
function browserHref(url) {
    const rawOrigin = _mcpOriginResolver ? _mcpOriginResolver() : null;
    if (!rawOrigin) return url;
    const origin = rawOrigin.replace(/\/+$/, '');
    return url.startsWith(origin + '/storage/') ? url.slice(origin.length) : url;
}

/**
 * Stamp each rendered anchor with its absolute destination and a new-tab
 * target, so ctrl/middle-click and copy-link match what a plain click does.
 * Idempotent — the observer calls it on every DOM change.
 */
function decorateLinks(root, base) {
    if (!root) return;
    for (const anchor of root.querySelectorAll('a[href]')) {
        const href = anchor.getAttribute('href');
        const url = noteUrlFromHref(href, base, _mcpOriginResolver)
            || resolveContentHref(href, base, _mcpOriginResolver);
        if (!url) continue;
        const target = browserHref(url);
        if (anchor.getAttribute('href') !== target) anchor.setAttribute('href', target);
        anchor.target = '_blank';
        anchor.rel = 'noopener noreferrer';
    }
}

function ensureNoteDialog() {
    if (noteDialog) return noteDialog;

    const host = document.createElement('nui-dialog');
    host.id = 'preview-note-dialog';
    host.innerHTML = `
        <dialog>
            <article class="preview-note">
                <header class="preview-note-head">
                    <h2 class="preview-note-title"></h2>
                    <nui-button variant="icon"><button type="button" data-note-action="open" aria-label="Open the note page in a new tab" title="Open the note page in a new tab"><nui-icon name="link"></nui-icon></button></nui-button>
                    <nui-button variant="icon"><button type="button" data-note-action="close" aria-label="Close" title="Close"><nui-icon name="close"></nui-icon></button></nui-button>
                </header>
                <div class="preview-note-body"></div>
            </article>
        </dialog>`;
    document.body.appendChild(host);

    const body = host.querySelector('.preview-note-body');
    const title = host.querySelector('.preview-note-title');
    const open = host.querySelector('[data-note-action="open"]');
    const close = host.querySelector('[data-note-action="close"]');

    // Leaving for the note's own page ends the excursion: the panel would
    // otherwise stay open behind the new tab, hiding the document.
    open.addEventListener('click', () => {
        const url = noteUrl;
        host.close('open');
        window.open(browserHref(url), '_blank', 'noopener,noreferrer');
    });
    close.addEventListener('click', () => host.close());
    wireContentClicks(body, () => noteUrl);

    noteParts = { body, title };
    noteDialog = host;
    return host;
}

/**
 * Fetch (once) and show the note at `url`. The panel opens immediately so a
 * slow fetch still shows what is happening; a failed fetch renders its error
 * in place — never a blank panel.
 */
async function showNote(url) {
    const host = ensureNoteDialog();
    const seq = ++noteSeq;
    noteUrl = url;
    noteParts.title.textContent = noteTitleFromUrl(url);
    noteParts.body.replaceChildren(noteLine('Loading note…', 'preview-note-loading'));
    if (!host.isOpen()) host.showModal();

    let source = notes.get(url);
    if (source === undefined) {
        try {
            source = await _fetchUrlText(url);
        } catch (err) {
            if (seq !== noteSeq) return;
            noteParts.body.replaceChildren(noteLine(`${err.message}\n${url}`, 'preview-note-error'));
            return;
        }
        notes.set(url, source);
    }
    if (seq !== noteSeq) return;
    renderNote(url, source);
}

function renderNote(url, source) {
    const { title, body } = splitNoteSource(source);
    noteParts.title.textContent = title || noteTitleFromUrl(url);

    const md = document.createElement('nui-markdown');
    md.setAttribute('frontmatter', 'strip');
    md.base = url;
    const script = document.createElement('script');
    script.type = 'text/markdown';
    script.textContent = body;
    md.appendChild(script);
    noteParts.body.replaceChildren(md);
    // nui-markdown renders synchronously on attach, so the anchors exist here.
    decorateLinks(noteParts.body, url);
}

function noteTitleFromUrl(url) {
    return deriveTitleFromUrl(url).replace(/\.md$/i, '');
}

function noteLine(text, className) {
    const p = document.createElement('p');
    p.className = className;
    p.textContent = text;
    return p;
}

// ============================================
// Module exports
// ============================================

export const preview = {
    init,
    show,
    showUi,
    close,
    reset,
    getActivePlainText,
    getState,
    setMcpOriginResolver,
    set onContentChange(fn) { _onContentChange = fn; }
};
