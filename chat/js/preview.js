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

// ============================================
// State (module-level, per-conversation)
// ============================================

const items = new Map();   // id → { id, title, language, content, source }
let activeId = null;       // currently displayed item id
let _renderedContent = null;  // tracks what's currently on screen (for TTS invalidation)

// Callback fired when the active content changes (chat.js registers a TTS stop here)
let _onContentChange = null;

// ============================================
// DOM references (populated in init())
// ============================================

let pane, resizer, content, selectEl, sourceEl, closeBtn, chatMain;
let dragCleanup = null;

// ============================================
// Constants
// ============================================

const MIN_WIDTH_PX = 320;          // 20rem at 16px base
const MAX_WIDTH_RATIO = 0.8;       // 80% of chat-main width
const DEFAULT_WIDTH_RATIO = 0.4;   // 40% of chat-main width on first open
const STORAGE_KEY = 'preview-width';
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
    chatMain = document.querySelector('.chat-main');

    if (!pane || !resizer || !content || !selectEl || !sourceEl || !closeBtn || !chatMain) {
        throw new Error('preview.init: required DOM elements not found');
    }

    // Close button
    closeBtn.addEventListener('click', close);

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
        content = await _fetchUrlText(resolvedUrl);
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
        source
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

// ============================================
// Internal: URL fetch mode helpers
// ============================================

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
        if (!res.ok) throw new Error(`preview: fetch failed (${res.status} ${res.statusText}) for ${url}`);
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
    if (content) content.replaceChildren();
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

    // Set the native select value to activeId
    const nativeSelect = selectEl.querySelector('select');
    if (nativeSelect) nativeSelect.value = activeId || '';
}

// ============================================
// Internal: rendering
// ============================================

function renderActive() {
    if (!content) return;
    if (!activeId || !items.has(activeId)) {
        content.replaceChildren();
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

    if (item.language === 'markdown') {
        renderMarkdown(item.content);
    } else {
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
function renderMarkdown(mdContent) {
    const md = document.createElement('nui-markdown');
    // Previews show rendered work product, not document metadata — strip
    // frontmatter (nui-markdown default 'show' renders it as a card).
    md.setAttribute('frontmatter', 'strip');
    const script = document.createElement('script');
    script.type = 'text/markdown';
    script.textContent = mdContent;
    md.appendChild(script);
    content.replaceChildren(md);
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

// ============================================
// Module exports
// ============================================

export const preview = {
    init,
    show,
    close,
    reset,
    getActivePlainText,
    getState,
    setMcpOriginResolver,
    set onContentChange(fn) { _onContentChange = fn; }
};
