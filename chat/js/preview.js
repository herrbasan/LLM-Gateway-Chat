// ============================================
// Preview Pane — LLM-driven second rendering surface
// ============================================
//
// The preview pane is NOT a file viewer. It's a rendering surface the LLM
// writes to via the chat_preview_show local tool. It can show files, proposed
// edits, diffs, or any work product. The LLM decides what to render.
//
// State is in-memory and keyed by conversation session. The pane is ONE shared
// DOM surface across per-chat containers, so switchChat() calls setSession(id):
// swapping the record in restores that chat's items, marks and open flags
// instead of wiping them, and a background chat's chat_preview_show lands in
// its own record — it never hijacks the preview of the chat on screen.

import {
    resolvePreviewUrl,
    inferLanguageFromUrl,
    deriveIdFromUrl,
    deriveTitleFromUrl
} from './preview-url.js';
import {
    kindFromName,
    kindFromMime,
    languageFromName,
    KIND_MEDIA
} from './preview-file-types.js';
import { docxModel, docxModelText, renderDocxModel } from './preview-docx.js';
import { resolveContentHref, noteUrlFromHref, splitNoteSource } from './research-note.js';
import {
    MAX_MARKS,
    MAX_NOTE_CHARS,
    normalizeWhitespace,
    extractBlockText,
    captureMarkFromRange,
    applyMarksToDom
} from './preview-marks.js';

// ============================================
// State — one record per conversation session
// ============================================

const DEFAULT_SESSION_ID = '__default';

const sessions = new Map();   // sessionId → { items, activeId, paneOpen, browserOpen, notes }
let currentSessionId = null;

function _newSession() {
    return {
        items: new Map(),       // id → { id, title, language, content, source }
        activeId: null,         // currently displayed item id
        paneOpen: false,
        browserOpen: false,
        notes: new Map()        // note url → source text
    };
}

function _getSession(sessionId) {
    const key = sessionId ?? currentSessionId ?? DEFAULT_SESSION_ID;
    let s = sessions.get(key);
    if (!s) {
        s = _newSession();
        sessions.set(key, s);
    }
    return s;
}

function _activeSession() {
    return _getSession(currentSessionId);
}

function _activeId() {
    return _activeSession().activeId;
}

function _setActiveId(id) {
    _activeSession().activeId = id;
}

let _renderedContent = null;  // tracks what's currently on screen (for TTS invalidation)

// Knowledge-base notes: one dialog at a time, its source fetched from the
// document's own base and reused for the rest of the conversation.
let noteDialog = null;     // lazily built <nui-dialog> holding the panel
let noteUrl = null;        // url of the note currently in the panel
let noteSeq = 0;           // invalidates a slow fetch that a newer note overtook
let noteParts = null;      // { body, title } refs inside the dialog
let linkObserver = null;   // follows the rendered DOM so no render path re-wires links

// Callback fired when the active content changes (chat.js registers a TTS stop here)
let _onContentChange = null;

// TTS entry point for passage playback. chat.js registers it — preview never
// imports the speech controller (that would close an import cycle through chat.js).
let _onSpeakText = null;

// Live selection under the floating toolbar; a clone, because a toolbar click
// can collapse the browser selection before the action runs.
let _activeSelectionRange = null;
let _marksNoticeTimer = null;

// ============================================
// DOM references (populated in init())
// ============================================

let pane, resizer, content, selectEl, sourceEl, closeBtn, viewBtn, chatMain;
let browserPanel, browserBtn, treeEl, treeFilter, treeRefresh, treeCollapse;
let marksBar, selToolbar, previewBody, browserResizer;
let dragCleanup = null;
let browserDragCleanup = null;

// ============================================
// Constants
// ============================================

const MIN_WIDTH_PX = 320;          // 20rem at 16px base
const MAX_WIDTH_RATIO = 0.8;       // 80% of chat-main width
const DEFAULT_WIDTH_RATIO = 0.4;   // 40% of chat-main width on first open
const STORAGE_KEY = 'preview-width';
const BROWSER_WIDTH_KEY = 'preview-browser-width';
const BROWSER_MIN_WIDTH_PX = 160;
const BROWSER_MAX_WIDTH_PX = 520;
const BROWSER_CONTENT_MIN_PX = 220; // #preview-content must never collapse
const VIEW_KEY = 'preview-view';        // last chosen view — 'document' | 'deck'
const MAX_CONTENT_BYTES = 256 * 1024;  // 256KB hard cap
const DOCX_MAX_BYTES = 25 * 1024 * 1024; // 25MB — a conversion input, not a reading surface
const FETCH_TIMEOUT_MS = 15000;        // url-mode fetch cap — never block forever

// Internal storage trees that are not content: hidden from the browser.
const HIDDEN_STORAGE_DIRS = new Set(['.backups', '.trash']);
// Mirrors server-side validatePreviewContext — a field over the cap is omitted
// client-side rather than failing the user's send.
const CONTEXT_STRING_MAX = 512;

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

/**
 * Inject the TTS entry point. chat.js owns the speech controller; passing a
 * function keeps preview free of an import cycle through chat.js.
 * @param {(text: string) => void} fn
 */
function setSpeechHandler(fn) {
    if (typeof fn !== 'function') throw new Error('preview.setSpeechHandler: function required');
    _onSpeakText = fn;
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
    browserPanel = document.getElementById('preview-browser');
    browserBtn = document.getElementById('preview-browser-btn');
    treeEl = document.getElementById('preview-file-tree');
    treeFilter = document.getElementById('preview-tree-filter');
    treeRefresh = document.getElementById('preview-tree-refresh');
    treeCollapse = document.getElementById('preview-tree-collapse');
    previewBody = document.querySelector('.preview-body');
    browserResizer = document.getElementById('preview-browser-resizer');
    marksBar = document.getElementById('preview-marks-bar');
    selToolbar = document.getElementById('preview-selection-toolbar');

    if (!pane || !resizer || !content || !selectEl || !sourceEl || !closeBtn || !viewBtn || !chatMain) {
        throw new Error('preview.init: required DOM elements not found');
    }
    if (!browserPanel || !browserBtn || !treeEl || !treeFilter || !treeRefresh || !treeCollapse) {
        throw new Error('preview.init: storage browser DOM elements not found');
    }
    if (!previewBody || !browserResizer || !marksBar || !selToolbar) {
        throw new Error('preview.init: preview layout elements not found');
    }

    // Storage browser: the tree is provider-driven and lazily rooted on first
    // open, so a chat that never browses issues no listing requests.
    browserBtn.addEventListener('click', toggleBrowser);
    treeEl.addEventListener('nui-file-select', (e) => {
        const entry = e.detail?.entry;
        if (!entry || entry.kind !== 'file') return;
        // show() renders a readable error inside #preview-content when the file
        // is not previewable (binary, issue #57) and then rethrows — swallow it
        // here, the pane already says what happened.
        show({ url: '/storage/' + encodeStoragePath(entry.path), title: entry.name, source: entry.path })
            .catch(err => {
                console.error('[preview] file open failed:', err);
                // show() renders its own fetch failure; a resolution failure
                // (no MCP origin, unreadable URL) happens before it and must
                // still land on screen, not in the console alone.
                if (!content.querySelector('.preview-fetch-error')) {
                    renderFetchError('/storage/' + encodeStoragePath(entry.path), err);
                }
            });
        // A docked (mobile) pane has no room for both columns — browsing ends
        // when a file is chosen, so the content gets the full width back.
        if (window.matchMedia('(max-width: 60rem)').matches) {
            _activeSession().browserOpen = false;
            browserPanel.hidden = true;
            syncBrowserResizer();
        }
    });
    treeFilter.addEventListener('nui-input', (e) => {
        treeEl.filter = e.detail.value.trim() || null;
    });
    treeRefresh.addEventListener('click', () => {
        if (!browserReady) { ensureBrowserTree().catch(reportBrowserError); return; }
        treeEl.refresh().catch(reportBrowserError);
    });
    treeCollapse.addEventListener('click', () => {
        if (browserReady) treeEl.collapseAll();
    });

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
        if (values && values.length > 0 && values[0] !== _activeId()) {
            _setActiveId(values[0]);
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

    // Storage browser width: same drag idiom, horizontal. `x` is relative to
    // .preview-body, whose left edge is the browser column's left edge.
    applySavedBrowserWidth();
    browserDragCleanup = nui.util.enableDrag(browserResizer, (data) => {
        if (data.type === 'move' || data.type === 'start') {
            const maxWidth = Math.min(BROWSER_MAX_WIDTH_PX, previewBody.clientWidth - BROWSER_CONTENT_MIN_PX);
            const clamped = Math.max(BROWSER_MIN_WIDTH_PX, Math.min(data.x, maxWidth));
            previewBody.style.setProperty('--preview-browser-width', clamped + 'px');
        }
        if (data.type === 'start') {
            browserResizer.classList.add('dragging');
        }
        if (data.type === 'end') {
            browserResizer.classList.remove('dragging');
            const width = previewBody.style.getPropertyValue('--preview-browser-width');
            if (width) localStorage.setItem(BROWSER_WIDTH_KEY, width);
        }
    }, { subtarget: previewBody });

    // Passage marks: floating selection toolbar (speak / speak from here / mark)
    // and the marked-passages bar. Both act on the ACTIVE markdown document in
    // document view — a deck slide or a code file has no selectable prose here.
    selToolbar.addEventListener('mousedown', (e) => e.preventDefault());
    selToolbar.addEventListener('click', onSelectionToolbarClick);
    content.addEventListener('mouseup', () => syncSelectionToolbar());
    content.addEventListener('keyup', () => syncSelectionToolbar());
    content.addEventListener('scroll', hideSelectionToolbar, { passive: true });
    document.addEventListener('selectionchange', () => {
        if (selToolbar.hidden) return;
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed || sel.rangeCount === 0) hideSelectionToolbar();
    });
    document.addEventListener('mousedown', (e) => {
        if (selToolbar.hidden) return;
        if (selToolbar.contains(e.target) || content.contains(e.target)) return;
        hideSelectionToolbar();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') hideSelectionToolbar();
    });
    marksBar.addEventListener('click', onMarksBarClick);
    marksBar.addEventListener('nui-input', onMarksBarNote);
    syncBrowserResizer();
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
    const item = _activeId() && _activeSession().items.get(_activeId());
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
 * The renderer is chosen from ONE type table (preview-file-types.js): markdown,
 * code, image, svg, audio, video, html, docx, pdf and the trusted hosted-UI
 * surface. Unknown types fail readably — never decoded.
 *
 * @param {Object} args - Tool arguments
 * @param {string} args.id - Stable identifier (reuse to update in place)
 * @param {string} args.title - Human-readable label for dropdown
 * @param {string} [args.content] - Content mode: the text to render
 * @param {string} [args.url] - Url mode: /storage/... path or absolute http(s) url to fetch
 * @param {string} [args.language='text'] - 'markdown' for rendered MD, else code language
 * @param {string} [args.kind] - Explicit type override (needed only without a usable extension)
 * @param {string} [args.source] - Optional provenance label
 * @param {Object} [opts]
 * @param {string} [opts.sessionId] - Conversation that owns the item. Defaults
 *        to the visible session; a background chat passes its own id so the
 *        pane on screen is never touched.
 * @returns {Promise<Object>} MCP-style result { content: [{ type: 'text', text }] }
 */
async function show(args, opts = {}) {
    // Success conditions — fail fast on invalid input
    if (!args || typeof args !== 'object') throw new Error('preview.show: args object required');
    const hasContent = typeof args.content === 'string' && args.content.length > 0;
    const hasUrl = typeof args.url === 'string' && args.url.length > 0;
    if (hasContent && hasUrl) throw new Error('preview.show: provide EITHER content OR url — never both');
    if (!hasContent && !hasUrl) throw new Error('preview.show: content or url required');

    const targetId = opts.sessionId ?? currentSessionId ?? DEFAULT_SESSION_ID;
    const s = _getSession(targetId);

    const explicitKind = typeof args.kind === 'string' && args.kind.length > 0 ? args.kind : null;
    let id = args.id;
    let title = args.title;
    let language = typeof args.language === 'string' && args.language.length > 0 ? args.language : 'text';
    let source = typeof args.source === 'string' && args.source.length > 0 ? args.source : null;
    let kind;
    let content = null;
    let docBase = null;
    let itemUrl = null;
    let mime = null;
    let docx = null;

    if (hasContent) {
        // MODE A — generated content (text only: bytes belong in url mode)
        content = args.content;
        if (typeof id !== 'string' || id.length === 0) throw new Error('preview.show: id required when using content');
        // title is display-only dropdown metadata — a missing one must not
        // block the render. Derive a label from the stable id and trace it.
        if (typeof title !== 'string' || title.length === 0) {
            console.warn('[preview] content mode missing title — deriving from id:', id);
            title = id;
        }
        kind = classifyContentKind({ explicitKind, language, title, source });
        if (kind === 'html') language = 'html';
        // No explicit language hint and clearly-markdown content → render as MD.
        // Otherwise the LLM's read/generated markdown shows as raw code.
        if (kind === 'code' && language === 'text' && looksLikeMarkdown(content)) {
            kind = 'markdown';
            language = 'markdown';
        }
    } else {
        // MODE B — fetched file: the model hands just the url, the preview
        // classifies it by extension, fetches only what a renderer needs, and
        // never decodes binary bytes as text.
        const resolvedUrl = resolvePreviewUrl(args.url, _mcpOriginResolver);
        docBase = resolvedUrl;
        // A root-relative path is served by THIS origin — the /storage/* proxy is
        // cookie-auth'd and Range-capable — so media renders straight from it and
        // stays reachable from a remote browser. Absolute urls are passive
        // content the browser fetches itself.
        itemUrl = args.url.startsWith('/') ? args.url : resolvedUrl;
        if (typeof id !== 'string' || id.length === 0) id = deriveIdFromUrl(resolvedUrl);
        if (typeof title !== 'string' || title.length === 0) title = deriveTitleFromUrl(resolvedUrl);
        if (!source) source = resolvedUrl;

        let loaded;
        try {
            loaded = await loadUrlSource({ explicitKind, resolvedUrl, displayUrl: itemUrl });
        } catch (err) {
            // The error paints the shared surface only when this session owns it.
            if (targetId === currentSessionId) renderFetchError(itemUrl, err);
            throw err;
        }
        // No await follows: the session check after recordItem below covers the
        // whole fetch + conversion window.
        kind = loaded.kind;
        content = loaded.text ?? null;
        mime = loaded.mime ?? null;
        docx = loaded.model ?? null;
        if (kind === 'docx') content = docxModelText(docx);
        if (loaded.language) language = loaded.language;
        else if (kind === 'code') language = inferLanguageFromUrl(resolvedUrl);
        else language = kind;
        if (kind === 'code' && language === 'text' && looksLikeMarkdown(content)) {
            kind = 'markdown';
            language = 'markdown';
        }
    }

    if (typeof content === 'string' && content.length > MAX_CONTENT_BYTES) {
        throw new Error(`preview.show: content exceeds ${MAX_CONTENT_BYTES} byte cap (${content.length} bytes). Excerpt it and pass content, or show a smaller file.`);
    }

    const contentChanged = recordItem(s, { id, title, language, kind, content, source, url: itemUrl, mime, docx, base: docBase });

    // Select this item (brings to front)
    s.activeId = id;
    s.paneOpen = true;

    // Re-checked AFTER every await above: the user may have switched chats while
    // a fetch was in flight. A background session records the item and stops.
    if (targetId !== currentSessionId) {
        return showResult(s, id, hasContent, args.url);
    }

    // Open pane if hidden
    openPane();

    // Update dropdown + render
    syncDropdown();
    renderActive();

    // If the rendered item changed, fire the callback so chat.js can stop stale
    // TTS. The old audio no longer matches what's on screen — keeping it playing
    // would be a silent lie (user sees new content, hears old content).
    if (contentChanged && _onContentChange) _onContentChange();

    return showResult(s, id, hasContent, args.url);
}

function showResult(s, id, hasContent, url) {
    return {
        content: [{
            type: 'text',
            text: JSON.stringify({
                shown: true,
                id,
                selected: true,
                itemCount: s.items.size,
                mode: hasContent ? 'content' : 'url',
                url: hasContent ? undefined : url
            })
        }]
    };
}

function classifyContentKind({ explicitKind, language, title, source }) {
    if (explicitKind === 'svg' || explicitKind === 'code') return 'code';
    if (explicitKind === 'markdown' || explicitKind === 'html') return explicitKind;
    if (explicitKind) {
        throw new Error(`preview.show: content mode renders text only — "${explicitKind}" needs url mode`);
    }
    if (language === 'markdown') return 'markdown';
    if (language === 'html') return 'html';
    const named = kindFromName(title) || kindFromName(source);
    if (named?.kind === 'markdown') return 'markdown';
    if (named?.kind === 'html') return 'html';
    return 'code';
}

// One render key for every kind: content for text, url for media/docx. The key
// change is what stops stale TTS when the visible item is swapped.
function itemRenderKey(item) {
    if (!item) return '';
    return `${item.kind || ''}|${item.url || ''}|${item.content ?? ''}`;
}

function recordItem(s, { id, title, language, kind, content, source, url, mime, docx, base }) {
    const isNew = !s.items.has(id);
    const prevItem = s.items.get(id);
    const item = {
        id,
        title,
        language,
        kind,
        content,
        source,
        url,
        mime,
        docxModel: docx,
        // Per-item view, defaulting to whatever was used last. Only markdown
        // items with deck structure can actually render as a deck — renderActive
        // is the gate, so an item may carry 'deck' while its content has none.
        view: isNew ? defaultView() : prevItem.view,
        // Passage marks survive an in-place content update: they are identified
        // by text, so a still-present passage re-highlights and a revised-away
        // one is dropped at apply time (applyItemMarks).
        marks: isNew ? [] : (prevItem.marks || []),
        marksContent: isNew ? undefined : prevItem.marksContent,
        // Document base (issue #38): in url mode the fetched document HAS a
        // location — its resolved URL — and relative media destinations must
        // resolve against it, like any viewer opening the file from disk.
        // Content mode has no location; base stays null and relative paths
        // render as authored.
        base
    };
    const changed = isNew || itemRenderKey(prevItem) !== itemRenderKey(item);
    s.items.set(id, item);
    return changed;
}

async function showUi(args, opts = {}) {
    if (!args || typeof args !== 'object') throw new Error('preview.showUi: args object required');
    if (typeof args.url !== 'string' || !args.url.trim()) throw new Error('preview.showUi: url required');
    const url = new URL(args.url, window.location.origin);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('preview.showUi: only HTTP(S) UIs are supported');
    const rawMcpOrigin = _mcpOriginResolver ? _mcpOriginResolver() : null;
    const mcpOrigin = rawMcpOrigin ? new URL(rawMcpOrigin).origin : null;
    if (url.origin !== window.location.origin && url.origin !== mcpOrigin) {
        throw new Error(`preview.showUi: untrusted UI origin ${url.origin}`);
    }
    const targetId = opts.sessionId ?? currentSessionId ?? DEFAULT_SESSION_ID;
    const s = _getSession(targetId);
    const id = typeof args.id === 'string' && args.id ? args.id : `tool-ui-${url.toString()}`;
    const title = typeof args.title === 'string' && args.title ? args.title : 'Tool UI';
    const previous = s.items.get(id);
    s.items.set(id, {
        id, title, language: 'ui', kind: 'ui', content: url.toString(), url: url.toString(),
        source: url.origin, view: 'document', base: null, marks: []
    });
    s.activeId = id;
    s.paneOpen = true;

    const changed = !previous || previous.content !== url.toString();
    if (targetId !== currentSessionId) {
        return { content: [{ type: 'text', text: JSON.stringify({ shown: true, id, selected: true, itemCount: s.items.size, mode: 'ui', url: url.toString() }) }] };
    }

    openPane();
    syncDropdown();
    renderActive();
    if (changed && _onContentChange) _onContentChange();
    return { content: [{ type: 'text', text: JSON.stringify({ shown: true, id, selected: true, itemCount: s.items.size, mode: 'ui', url: url.toString() }) }] };
}

// ============================================
// Internal: URL fetch mode helpers
// ============================================

function renderFetchError(url, err) {
    _setActiveId(null);
    _renderedContent = null;
    syncDropdown();
    openPane();
    viewBtn.hidden = true;
    content.classList.remove('deck-mode', 'ui-mode', 'media-mode', 'html-mode');
    const error = document.createElement('div');
    error.className = 'preview-fetch-error';
    error.setAttribute('role', 'alert');
    error.textContent = err.message;
    content.replaceChildren(error);
    sourceEl.textContent = url;
    sourceEl.title = url;
    hideSelectionToolbar();
    renderMarksBar(null);
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
 * Classify a url and load only what its renderer needs — media is never
 * prefetched, DOCX is read as bytes, text goes through the decode gate.
 * An unknown extension is sniffed with a HEAD (same-origin only) so the
 * Content-Type decides; cross-origin falls through to the text proxy, which
 * reports a binary upstream as an unsupported-format error rather than text.
 *
 * @returns {Promise<{kind: string, text?: string, language?: string, mime?: string, model?: Array}>}
 */
async function loadUrlSource({ explicitKind, resolvedUrl, displayUrl }) {
    const named = explicitKind ? { kind: explicitKind } : kindFromName(displayUrl);
    if (named) return loadAsKind(named.kind, named.language, { resolvedUrl, displayUrl });

    const mime = await _sniffContentType(displayUrl);
    const sniffed = mime ? kindFromMime(mime) : null;
    if (sniffed) return loadAsKind(sniffed, null, { resolvedUrl, displayUrl, mime });
    if (mime) throw unsupportedFormat(displayUrl, mime);

    const text = await _fetchUrlText(resolvedUrl);
    return { kind: 'code', text };
}

function loadAsKind(kind, language, { resolvedUrl, displayUrl, mime }) {
    if (KIND_MEDIA.has(kind)) return { kind, mime: mime || null };
    if (kind === 'pdf') return { kind, mime: mime || 'application/pdf' };
    if (kind === 'docx') {
        return _fetchUrlBytes(displayUrl)
            .then(docxModel)
            .then(model => ({ kind, model, mime: mime || 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }));
    }
    if (kind === 'markdown' || kind === 'code' || kind === 'html') {
        const lang = language || languageFromName(displayUrl) || (kind === 'markdown' || kind === 'html' ? kind : null);
        return _fetchUrlText(resolvedUrl).then(text => ({ kind, text, language: lang || undefined }));
    }
    throw unsupportedFormat(displayUrl, null, kind);
}

function unsupportedFormat(displayUrl, mime, kind) {
    const name = deriveTitleFromUrl(displayUrl);
    const detail = kind ? `format "${kind}"` : `type "${mime || 'unknown'}"`;
    return new Error(`preview: cannot render "${name}" — unsupported ${detail}. Text, Markdown, code, HTML, images, audio, video, DOCX and PDF are supported.`);
}

/**
 * Content-Type of a same-origin resource, or null when it cannot be probed
 * (a cross-origin HEAD is CORS-bound; the text proxy decides those).
 */
async function _sniffContentType(displayUrl) {
    if (!displayUrl.startsWith('/')) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(displayUrl, { method: 'HEAD', credentials: 'same-origin', signal: controller.signal });
        if (!res.ok) throw new Error(`preview: fetch failed (${res.status} ${res.statusText}) for ${displayUrl}`);
        return res.headers.get('content-type');
    } catch (err) {
        if (err.name === 'AbortError') {
            throw new Error(`preview: fetch timed out after ${FETCH_TIMEOUT_MS}ms for ${displayUrl}`);
        }
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Fetch bytes for a binary renderer (DOCX). Bounded by FETCH_TIMEOUT_MS and the
 * DOCX size cap — the conversion input is not a reading surface.
 */
async function _fetchUrlBytes(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, { credentials: 'same-origin', signal: controller.signal });
        if (!res.ok) throw new Error(`preview: fetch failed (${res.status} ${res.statusText}) for ${url}`);
        const declared = Number(res.headers.get('content-length'));
        if (Number.isFinite(declared) && declared > DOCX_MAX_BYTES) {
            throw new Error(`preview: "${url}" is ${declared} bytes — over the ${DOCX_MAX_BYTES} byte DOCX cap`);
        }
        const bytes = await res.arrayBuffer();
        if (bytes.byteLength > DOCX_MAX_BYTES) {
            throw new Error(`preview: "${url}" is ${bytes.byteLength} bytes — over the ${DOCX_MAX_BYTES} byte DOCX cap`);
        }
        return bytes;
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
 * Close the preview pane. Items and marks are preserved on the session —
 * reopening (or returning to the chat) brings them back.
 */
function close() {
    if (!pane) return;
    _activeSession().paneOpen = false;
    hideSelectionToolbar();
    pane.hidden = true;
    resizer.hidden = true;
}

// ============================================
// Storage file browser — nui-file-tree over the same-origin /storage/ proxy
// ============================================
//
// The browser is a navigation surface, not conversation state: it lists the
// shared storage box through the backend's authenticated /storage/* proxy (the
// MCP origin binds localhost on the server host, unreachable from a remote
// browser). The tree's provider is attached on FIRST open — a chat that never
// browses costs no listing requests.

let browserReady = false;

function encodeStoragePath(dirPath) {
    return dirPath.split('/').filter(Boolean).map(encodeURIComponent).join('/');
}

async function fetchStorageDir(dirPath) {
    if (typeof dirPath !== 'string') throw new Error('preview.fetchStorageDir: directory path string required');
    const encoded = encodeStoragePath(dirPath);
    const res = await fetch(`/storage/${encoded}`, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`storage listing failed (${res.status} ${res.statusText}) for /storage/${encoded}`);
    const body = await res.json();
    if (!Array.isArray(body.entries)) {
        throw new Error(`storage listing for /storage/${encoded} carried no entries array`);
    }
    return body.entries
        .filter(entry => !(entry.type === 'dir' && HIDDEN_STORAGE_DIRS.has(entry.name)))
        .map(entry => ({
            name: entry.name,
            path: dirPath ? `${dirPath}/${entry.name}` : entry.name,
            kind: entry.type === 'dir' ? 'dir' : 'file'
        }));
}

async function ensureBrowserTree() {
    if (browserReady) return;
    if (typeof treeEl.setProvider !== 'function' || typeof treeEl.setRoot !== 'function') {
        throw new Error('preview: nui-file-tree component not loaded');
    }
    treeEl.setProvider(fetchStorageDir);
    await treeEl.setRoot({ name: 'Storage', path: '' });
    browserReady = true;
    clearBrowserError();
}

function reportBrowserError(err) {
    console.error('[preview] storage browser failed:', err);
    let errorEl = browserPanel.querySelector('.preview-browser-error');
    if (!errorEl) {
        errorEl = document.createElement('p');
        errorEl.className = 'preview-browser-error';
        errorEl.setAttribute('role', 'alert');
        browserPanel.appendChild(errorEl);
    }
    errorEl.textContent = err.message;
}

function clearBrowserError() {
    browserPanel.querySelector('.preview-browser-error')?.remove();
}

function openBrowser() {
    openPane();
    _activeSession().browserOpen = true;
    browserPanel.hidden = false;
    syncBrowserResizer();
    if (!browserReady) ensureBrowserTree().catch(reportBrowserError);
}

function toggleBrowser() {
    if (browserPanel.hidden) {
        openBrowser();
    } else {
        _activeSession().browserOpen = false;
        browserPanel.hidden = true;
    }
    syncBrowserResizer();
}

// The splitter exists only while the browser column does.
function syncBrowserResizer() {
    if (!browserResizer || !browserPanel) return;
    browserResizer.hidden = browserPanel.hidden;
}

// Browser column width is a layout preference, not conversation state.
function applySavedBrowserWidth() {
    const saved = localStorage.getItem(BROWSER_WIDTH_KEY);
    if (saved) previewBody.style.setProperty('--preview-browser-width', saved);
}

/**
 * Header toggle: the pane is reachable at any time, including on a blank chat
 * where no tool has produced an item yet — in that case the storage browser is
 * what the pane has to offer, so it opens with the pane.
 */
function togglePane() {
    if (!pane) return;
    if (pane.hidden) {
        openPane();
        const s = _activeSession();
        syncDropdown();
        if (s.activeId) renderActive();
        else openBrowser();
    } else {
        close();
    }
}

/**
 * The live preview state the view sends with its next user turn. Validated and
 * persisted server-side (conversation-store.validatePreviewContext) and
 * projected onto that turn only — never into the system prompt.
 *
 * @returns {Object|null} null when the pane is closed and nothing is marked
 */
function getContext() {
    if (!pane || pane.hidden) return null;
    const s = _activeSession();
    const item = s.activeId && s.items.has(s.activeId) ? s.items.get(s.activeId) : null;
    if (!item) return { paneOpen: true };
    const ctx = { paneOpen: true };
    boundedContextString(ctx, 'id', item.id);
    boundedContextString(ctx, 'path', storagePathOf(item));
    boundedContextString(ctx, 'title', item.title);
    ctx.kind = item.kind || (item.language === 'markdown' ? 'markdown' : 'code');
    if (ctx.kind === 'markdown') ctx.view = item.view || 'document';
    // Only the fields the server validates ride the wire: quote is required,
    // heading/note are optional and dropped when empty (validatePreviewContext
    // rejects unknown keys' payloads by size, so nothing extra is attached —
    // mark IDs travel separately via getActiveMarkIds()).
    ctx.marks = (Array.isArray(item.marks) ? item.marks : []).map(mark => {
        const entry = { quote: mark.quote };
        if (mark.heading) entry.heading = mark.heading;
        const note = typeof mark.note === 'string' ? mark.note.trim() : '';
        if (note) entry.note = note.slice(0, MAX_NOTE_CHARS);
        return entry;
    });
    return ctx;
}

function boundedContextString(target, key, value) {
    if (typeof value !== 'string' || !value) return;
    if (value.length > CONTEXT_STRING_MAX) {
        console.warn(`[preview] context ${key} exceeds ${CONTEXT_STRING_MAX} chars — omitted`);
        return;
    }
    target[key] = value;
}

// Normalized storage path when the item has a storage location; content-mode
// items have none (their `source` is null and `id` carries the identity).
function storagePathOf(item) {
    const source = item.source;
    if (typeof source !== 'string' || !source) return null;
    const href = browserHref(source);
    return href.startsWith('/storage/') ? href.slice('/storage/'.length) : href;
}

/**
 * Full reset — every session record is dropped. Logout / hard reload path.
 * Must be idempotent: it also runs before any session was ever set.
 */
function reset() {
    sessions.clear();
    currentSessionId = null;
    _renderedContent = null;
    closeNoteDialog();
    if (content) content.replaceChildren();
    if (content) content.classList.remove('deck-mode', 'ui-mode', 'media-mode', 'html-mode');
    if (viewBtn) viewBtn.hidden = true;
    if (sourceEl) {
        sourceEl.textContent = '';
        sourceEl.title = '';
    }
    // The browser is global navigation, but its open state belongs to the
    // session that opened it — drop both.
    if (browserPanel) {
        browserPanel.hidden = true;
        syncBrowserResizer();
        const filterInput = treeFilter?.querySelector('input');
        if (filterInput) filterInput.value = '';
        // Only touch the tree when a filter is actually set: assigning `filter`
        // triggers a refresh (a listing request) in the component.
        if (browserReady && treeEl.filter) treeEl.filter = null;
    }
    hideSelectionToolbar();
    renderMarksBar(null);
    if (pane) pane.hidden = true;
    if (resizer) resizer.hidden = true;
    if (selectEl?.setItems) {
        selectEl.setItems([]);
    }
}

/**
 * Drop one session's record (chat deleted). The shared DOM is cleared only when
 * that session is the one on screen; every other chat keeps its own state.
 */
function clearSession(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('preview.clearSession: session id required');
    sessions.delete(sessionId);
    if (sessionId !== currentSessionId) return;
    _renderedContent = null;
    closeNoteDialog();
    if (content) content.replaceChildren();
    if (content) content.classList.remove('deck-mode', 'ui-mode', 'media-mode', 'html-mode');
    if (viewBtn) viewBtn.hidden = true;
    if (sourceEl) {
        sourceEl.textContent = '';
        sourceEl.title = '';
    }
    if (browserPanel) {
        browserPanel.hidden = true;
        syncBrowserResizer();
    }
    hideSelectionToolbar();
    renderMarksBar(null);
    if (pane) pane.hidden = true;
    if (resizer) resizer.hidden = true;
    if (selectEl?.setItems) selectEl.setItems([]);
}

/**
 * Switch the visible session. Called by switchChat before the new chat renders:
 * the outgoing chat's record keeps its items/marks/open flags, and the incoming
 * chat's record is loaded onto the shared pane. Idempotent.
 */
function setSession(sessionId) {
    if (sessionId === currentSessionId) return;

    // Leaving: nothing of the outgoing chat may stay on the shared surface.
    hideSelectionToolbar();
    closeNoteDialog();
    noteSeq++;                       // a note fetch in flight must not land in the next conversation

    currentSessionId = sessionId;
    const s = _getSession(sessionId);
    _renderedContent = null;

    if (!pane) return;

    if (s.browserOpen) {
        browserPanel.hidden = false;
        syncBrowserResizer();
        if (!browserReady) ensureBrowserTree().catch(reportBrowserError);
    } else {
        browserPanel.hidden = true;
        syncBrowserResizer();
    }

    syncDropdown();

    if (!s.paneOpen) {
        content.replaceChildren();
        content.classList.remove('deck-mode', 'ui-mode', 'media-mode', 'html-mode');
        viewBtn.hidden = true;
        sourceEl.textContent = '';
        sourceEl.title = '';
        hideSelectionToolbar();
        renderMarksBar(null);
        pane.hidden = true;
        resizer.hidden = true;
        return;
    }

    openPane();
    renderActive();
}

function closeNoteDialog() {
    noteSeq++;
    noteUrl = null;
    if (noteDialog && noteDialog.isOpen()) noteDialog.close('session');
    if (noteParts) noteParts.body.replaceChildren();
}

// ============================================
// Internal: pane open/close with width management
// ============================================

function openPane() {
    _activeSession().paneOpen = true;

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

    const s = _activeSession();
    const itemList = [...s.items.values()].map(item => ({
        value: item.id,
        label: item.title
    }));

    selectEl.setItems(itemList);

    // Set through the component API (NOT the native select .value) so the
    // custom control label (nui-select-value) syncs with activeId. Setting
    // nativeSelect.value directly left the label stale — it showed the first
    // option (setItems rebuilds options with no selected), so the user picked
    // a wrong item first and had to "switch back and forth" to reach real one.
    if (selectEl.setValue) selectEl.setValue(s.activeId || '');
}

// ============================================
// Internal: rendering
// ============================================

function renderActive() {
    if (!content) return;
    const s = _activeSession();
    if (!s.activeId || !s.items.has(s.activeId)) {
        content.replaceChildren();
        content.classList.remove('deck-mode', 'ui-mode', 'media-mode', 'html-mode');
        if (viewBtn) viewBtn.hidden = true;
        if (sourceEl) sourceEl.textContent = '';
        hideSelectionToolbar();
        renderMarksBar(null);
        return;
    }

    const item = s.items.get(s.activeId);

    // Detect content change from dropdown switch (show() handles its own detection).
    // If the rendered item differs from what's on screen, fire the callback
    // so chat.js can stop stale TTS.
    const renderKey = itemRenderKey(item);
    if (_renderedContent !== renderKey) {
        _renderedContent = renderKey;
        if (_onContentChange) _onContentChange();
    }

    // Update source label
    if (sourceEl) {
        sourceEl.textContent = item.source || '';
        sourceEl.title = item.source || '';
    }
    // The selection toolbar belongs to the document view of THIS render.
    hideSelectionToolbar();

    content.classList.remove('ui-mode', 'deck-mode', 'media-mode', 'html-mode');
    if (viewBtn) viewBtn.hidden = true;

    switch (item.kind || (item.language === 'markdown' ? 'markdown' : 'code')) {
        case 'ui':
            content.classList.add('ui-mode');
            renderUi(item);
            renderMarksBar(item);
            return;
        case 'markdown':
            renderMarkdownItem(item);
            return;
        case 'code':
            renderCode(item.content, item.language);
            renderMarksBar(item);
            return;
        case 'image':
        case 'svg':
            renderMediaImage(item);
            return;
        case 'audio':
            renderMediaAudio(item);
            return;
        case 'video':
            renderMediaVideo(item);
            return;
        case 'html':
            renderHtmlDocument(item);
            return;
        case 'docx':
            renderDocxItem(item);
            return;
        case 'pdf':
            renderPdfDocument(item);
            return;
        default:
            renderUnsupportedItem(item, 'Unsupported file type', `"${item.title}" has no preview renderer.`);
    }
}

function renderMarkdownItem(item) {
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
        // Marks stay on the item while a deck is shown; they are re-applied
        // the moment the document view comes back.
        renderMarksBar(item);
        return;
    }
    const md = renderMarkdown(item.content, item.base);
    // nui-markdown renders synchronously on appendChild, so the text
    // nodes the marks wrap already exist here.
    applyItemMarks(item, md);
}

/**
 * Media renders from its url — nothing is prefetched or decoded here. An SVG
 * is an <img>, never inline markup: an image document cannot execute script,
 * and the sandboxed HTML path is the only place scripts run.
 */
function renderMediaImage(item) {
    content.classList.add('media-mode');
    const img = document.createElement('img');
    img.className = 'preview-media-image';
    img.src = item.url;
    img.alt = item.title || '';
    img.title = item.title || '';
    img.loading = 'lazy';
    img.decoding = 'async';
    content.replaceChildren(img);
    renderMarksBar(item);
}

function renderMediaAudio(item) {
    const audio = document.createElement('audio');
    audio.className = 'preview-media-audio';
    audio.controls = true;
    audio.preload = 'metadata';
    audio.src = item.url;
    content.replaceChildren(audio);
    renderMarksBar(item);
}

function renderMediaVideo(item) {
    content.classList.add('media-mode');
    const video = document.createElement('video');
    video.className = 'preview-media-video';
    video.controls = true;
    video.preload = 'metadata';
    video.playsInline = true;
    video.src = item.url;
    content.replaceChildren(video);
    renderMarksBar(item);
}

/**
 * HTML in an opaque-origin frame: scripts may run, but the document cannot
 * reach this origin, forms, popups, modals or the top-level frame.
 */
function renderHtmlDocument(item) {
    content.classList.add('html-mode');
    const frame = document.createElement('iframe');
    frame.className = 'preview-html-frame';
    frame.title = item.title || 'HTML preview';
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.srcdoc = item.content;
    content.replaceChildren(frame);
    renderMarksBar(item);
}

function renderDocxItem(item) {
    const wrap = document.createElement('div');
    wrap.className = 'preview-docx-document';
    wrap.appendChild(renderDocxModel(item.docxModel));
    content.replaceChildren(wrap);
    renderMarksBar(item);
}

// Normal browsers already ship a PDF viewer; no document bytes enter JS and no
// pdf.js worker/vendor surface is needed. If a device cannot display PDFs
// inline, its native viewer offers the usual open/download fallback.
function renderPdfDocument(item) {
    content.classList.add('html-mode');
    const frame = document.createElement('iframe');
    frame.className = 'preview-html-frame preview-pdf-frame';
    frame.title = item.title || 'PDF preview';
    frame.src = item.url;
    content.replaceChildren(frame);
    renderMarksBar(item);
}

function renderUnsupportedItem(item, heading, detail) {
    const box = document.createElement('div');
    box.className = 'preview-unsupported';
    const title = document.createElement('p');
    title.className = 'preview-unsupported-title';
    title.textContent = heading;
    const body = document.createElement('p');
    body.textContent = detail;
    box.append(title, body);
    const link = item.url || (item.source && /^https?:\/\//i.test(item.source) ? item.source : null);
    if (link) {
        const open = document.createElement('nui-button');
        open.setAttribute('variant', 'ghost');
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = 'Open in new tab';
        button.addEventListener('click', () => window.open(link, '_blank', 'noopener'));
        open.appendChild(button);
        box.appendChild(open);
    }
    content.replaceChildren(box);
    renderMarksBar(item);
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
    return md;
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
    const s = _activeSession();
    if (!s.activeId || !s.items.has(s.activeId)) return '';
    const item = s.items.get(s.activeId);
    const kind = item.kind || (item.language === 'markdown' ? 'markdown' : 'code');
    // Only text-backed kinds speak: an html source is not prose, and a media
    // item has no text at all.
    if (kind !== 'markdown' && kind !== 'code' && kind !== 'docx') return '';
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
    const s = _activeSession();
    const state = {
        paneOpen: pane ? !pane.hidden : false,
        activeId: s.activeId,
        activeTitle: s.activeId && s.items.has(s.activeId) ? s.items.get(s.activeId).title : null,
        items: [...s.items.values()].map(item => ({
            id: item.id,
            title: item.title,
            kind: item.kind,
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
// Passage marks — floating selection toolbar + marked-passages bar
// ============================================
//
// Marks are conversation state on the preview item: they ride the next user turn
// through getContext() and leave the bar only when a send is ACKNOWLEDGED
// (chat.js calls consumeMarks after res.ok), so a failed send or an outbox
// retry never loses them.

function currentMarkdownRoot() {
    const s = _activeSession();
    const item = s.activeId && s.items.has(s.activeId) ? s.items.get(s.activeId) : null;
    if (!item) return null;
    if ((item.kind || (item.language === 'markdown' ? 'markdown' : 'code')) !== 'markdown') return null;
    if ((item.view || 'document') !== 'document') return null;
    return content.querySelector('nui-markdown');
}

function syncSelectionToolbar() {
    if (!selToolbar) return;
    const mdRoot = currentMarkdownRoot();
    if (!mdRoot) {
        hideSelectionToolbar();
        return;
    }
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
        hideSelectionToolbar();
        return;
    }
    const range = selection.getRangeAt(0);
    if (!mdRoot.contains(range.startContainer) || !mdRoot.contains(range.endContainer)) {
        hideSelectionToolbar();
        return;
    }
    if (!normalizeWhitespace(range.toString()) && !range.getBoundingClientRect().width) {
        hideSelectionToolbar();
        return;
    }
    _activeSelectionRange = range.cloneRange();
    selToolbar.hidden = false;
    positionSelectionToolbar(range);
}

/**
 * Float above the selection, clamped inside the pane on all four sides — a
 * selection near an edge would otherwise push the bar out of reach (the pane
 * clips overflow).
 */
function positionSelectionToolbar(range) {
    const rect = range.getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height)) {
        hideSelectionToolbar();
        return;
    }
    const paneRect = pane.getBoundingClientRect();
    const barRect = selToolbar.getBoundingClientRect();
    const margin = 6;

    let left = rect.left + rect.width / 2 - barRect.width / 2;
    left = Math.max(paneRect.left + margin, Math.min(left, paneRect.right - barRect.width - margin));

    let top = rect.top - barRect.height - margin;
    if (top < paneRect.top + margin) top = rect.bottom + margin;
    top = Math.max(paneRect.top + margin, Math.min(top, paneRect.bottom - barRect.height - margin));

    selToolbar.style.left = `${left - paneRect.left}px`;
    selToolbar.style.top = `${top - paneRect.top}px`;
}

function hideSelectionToolbar() {
    _activeSelectionRange = null;
    if (selToolbar && !selToolbar.hidden) selToolbar.hidden = true;
}

function onSelectionToolbarClick(event) {
    const button = event.target.closest('[data-action]');
    if (!button || !selToolbar.contains(button)) return;
    const action = button.getAttribute('data-action');
    const range = _activeSelectionRange;
    const mdRoot = currentMarkdownRoot();
    if (!range || !mdRoot) {
        hideSelectionToolbar();
        return;
    }

    if (action === 'speak-selection' || action === 'speak-from-here') {
        const text = extractBlockText(range, mdRoot, { toEnd: action === 'speak-from-here' });
        hideSelectionToolbar();
        if (!text.trim()) return;
        if (!_onSpeakText) {
            console.warn('[preview] no speech handler — the view must wire preview.onSpeakText');
            return;
        }
        _onSpeakText(text);
        return;
    }

    if (action === 'mark-passage') {
        const s = _activeSession();
        const item = s.activeId && s.items.has(s.activeId) ? s.items.get(s.activeId) : null;
        if (!item) return;
        item.marks = Array.isArray(item.marks) ? item.marks : [];
        if (item.marks.length >= MAX_MARKS) {
            flashMarksBarNotice(`Mark limit reached (${MAX_MARKS}) — remove a mark to add another.`);
            return;
        }
        const result = captureMarkFromRange(range, mdRoot);
        if (result.error) {
            flashMarksBarNotice(result.error);
            return;
        }
        item.marks.push(result.mark);
        window.getSelection()?.removeAllRanges();
        hideSelectionToolbar();
        syncMarksUi(item);
    }
}

// Re-highlight the active document and redraw the bar. The one place mark
// mutations land, so DOM and bar can never disagree.
function syncMarksUi(item) {
    if (!item) return;
    item.marksContent = item.content;
    const s = _activeSession();
    const active = s.activeId && s.items.has(s.activeId) ? s.items.get(s.activeId) : null;
    if (item === active) {
        const mdRoot = currentMarkdownRoot();
        if (mdRoot) applyMarksToDom(mdRoot, item.marks || []);
    }
    renderMarksBar(item);
}

/**
 * Apply an item's marks to freshly rendered markdown. When the DOCUMENT TEXT
 * changed under them (the model rewrote the file via chat_preview_show), a
 * passage that no longer resolves was already revised away — drop that mark
 * rather than keep a highlight that can never land again.
 */
function applyItemMarks(item, mdRoot) {
    const marks = Array.isArray(item.marks) ? item.marks : [];
    if (!marks.length) {
        renderMarksBar(item);
        return;
    }
    const { resolvedIds, unresolvedIds } = applyMarksToDom(mdRoot, marks);
    if (unresolvedIds.size) {
        const revised = item.marksContent !== undefined && item.marksContent !== item.content;
        if (revised) {
            item.marks = marks.filter(mark => resolvedIds.has(mark.id));
            if (item.marks.length) applyMarksToDom(mdRoot, item.marks);
        } else {
            console.warn('[preview] marks did not resolve against unchanged content:', [...unresolvedIds]);
        }
    }
    item.marksContent = item.content;
    renderMarksBar(item);
}

function renderMarksBar(item) {
    if (!marksBar) return;
    const marks = item && Array.isArray(item.marks) ? item.marks : [];
    if (!marks.length) {
        marksBar.hidden = true;
        marksBar.replaceChildren();
        return;
    }

    const head = document.createElement('div');
    head.className = 'preview-marks-head';
    const title = document.createElement('span');
    title.className = 'preview-marks-title';
    title.textContent = `Marks (${marks.length})`;
    const clearAll = document.createElement('nui-button');
    clearAll.setAttribute('variant', 'ghost');
    clearAll.setAttribute('size', 'small');
    clearAll.innerHTML = '<button type="button" data-marks-action="clear-all">Clear all</button>';
    head.append(title, clearAll);

    const list = document.createElement('ul');
    list.className = 'preview-marks-list';
    for (const mark of marks) list.appendChild(createMarkRow(mark));

    marksBar.replaceChildren(head, list);
    marksBar.hidden = false;
}

function createMarkRow(mark) {
    const row = document.createElement('li');
    row.className = 'preview-mark-item';
    row.setAttribute('data-mark-id', mark.id);

    const jump = document.createElement('nui-button');
    jump.setAttribute('variant', 'ghost');
    jump.setAttribute('size', 'small');
    jump.className = 'preview-mark-jump';
    const jumpButton = document.createElement('button');
    jumpButton.type = 'button';
    jumpButton.setAttribute('data-marks-action', 'jump');
    jumpButton.title = mark.heading ? `${mark.heading}\n${mark.quote}` : mark.quote;
    if (mark.heading) {
        const heading = document.createElement('span');
        heading.className = 'preview-mark-heading';
        heading.textContent = mark.heading;
        jumpButton.appendChild(heading);
    }
    const quote = document.createElement('span');
    quote.className = 'preview-mark-quote';
    quote.textContent = `"${truncateQuote(mark.quote)}"`;
    jumpButton.appendChild(quote);
    jump.appendChild(jumpButton);

    const note = document.createElement('nui-input');
    note.className = 'preview-mark-note';
    note.setAttribute('size', 'small');
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Optional note...';
    input.maxLength = MAX_NOTE_CHARS;
    input.value = mark.note || '';
    input.setAttribute('aria-label', 'Note for this marked passage');
    input.setAttribute('data-mark-note', mark.id);
    note.appendChild(input);

    const remove = document.createElement('nui-button');
    remove.setAttribute('variant', 'icon');
    remove.setAttribute('size', 'small');
    remove.innerHTML = '<button type="button" data-marks-action="remove" aria-label="Remove mark" title="Remove mark"><nui-icon name="close"></nui-icon></button>';

    row.append(jump, note, remove);
    return row;
}

function truncateQuote(quote) {
    const text = typeof quote === 'string' ? quote : '';
    return text.length > 60 ? text.slice(0, 60).trimEnd() + '…' : text;
}

function onMarksBarClick(event) {
    const button = event.target.closest('[data-marks-action]');
    if (!button || !marksBar.contains(button)) return;
    const s = _activeSession();
    const item = s.activeId && s.items.has(s.activeId) ? s.items.get(s.activeId) : null;
    if (!item) return;

    const action = button.getAttribute('data-marks-action');
    if (action === 'clear-all') {
        item.marks = [];
        syncMarksUi(item);
        return;
    }
    const markId = button.closest('.preview-mark-item')?.getAttribute('data-mark-id');
    if (!markId) return;
    if (action === 'remove') {
        item.marks = (item.marks || []).filter(mark => mark.id !== markId);
        syncMarksUi(item);
        return;
    }
    if (action === 'jump') jumpToMark(item, markId);
}

function onMarksBarNote(event) {
    if (event.target?.tagName !== 'NUI-INPUT') return;
    const input = event.target.querySelector('input[data-mark-note]');
    if (!input) return;
    const s = _activeSession();
    const item = s.activeId && s.items.has(s.activeId) ? s.items.get(s.activeId) : null;
    if (!item) return;
    const mark = (item.marks || []).find(candidate => candidate.id === input.getAttribute('data-mark-note'));
    if (!mark) return;
    const value = typeof event.detail?.value === 'string' ? event.detail.value : input.value;
    mark.note = value.slice(0, MAX_NOTE_CHARS);
}

function jumpToMark(item, markId) {
    const locate = () => content.querySelector(`mark.preview-passage-mark[data-mark-id="${markId}"]`);
    let target = locate();
    if (!target && (item.kind || 'markdown') === 'markdown' && hasDeckStructure(item.content) && (item.view || 'document') !== 'document') {
        // A slide is not the reading surface — jumping means returning to the
        // document flow, where the passages live.
        item.view = 'document';
        localStorage.setItem(VIEW_KEY, item.view);
        renderActive();
        target = locate();
    }
    if (!target) return;
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    target.classList.add('preview-passage-mark-pulse');
    setTimeout(() => target.classList.remove('preview-passage-mark-pulse'), 1000);
}

// A mark is a create action with preconditions (text present, size cap, mark
// cap); a rejection is shown in place for a few seconds rather than swallowed.
function flashMarksBarNotice(message) {
    if (!marksBar) return;
    let notice = marksBar.querySelector('.preview-marks-notice');
    if (!notice) {
        notice = document.createElement('p');
        notice.className = 'preview-marks-notice';
        notice.setAttribute('role', 'status');
    }
    notice.textContent = message;
    marksBar.hidden = false;
    marksBar.insertBefore(notice, marksBar.firstChild);
    clearTimeout(_marksNoticeTimer);
    _marksNoticeTimer = setTimeout(() => {
        notice.remove();
        const s = _activeSession();
        renderMarksBar(s.activeId && s.items.has(s.activeId) ? s.items.get(s.activeId) : null);
    }, 5000);
}

function getActiveMarkIds() {
    const s = _activeSession();
    const item = s.activeId && s.items.has(s.activeId) ? s.items.get(s.activeId) : null;
    return item && Array.isArray(item.marks) ? item.marks.map(mark => mark.id) : [];
}

/**
 * Drop the marks a send carried. Called by the view only AFTER the send is
 * acknowledged: marks added while that request was in flight are not in
 * `markIds`, so they survive untouched. `opts.sessionId` targets the session
 * that sent — the user may have switched chats while the request was in flight.
 */
function consumeMarks(markIds, opts = {}) {
    if (!Array.isArray(markIds) || markIds.length === 0) return;
    const targetId = opts.sessionId ?? currentSessionId ?? DEFAULT_SESSION_ID;
    const s = sessions.get(targetId);
    if (!s) return;
    const sent = new Set(markIds);
    for (const item of s.items.values()) {
        if (!Array.isArray(item.marks) || item.marks.length === 0) continue;
        const remaining = item.marks.filter(mark => !sent.has(mark.id));
        if (remaining.length === item.marks.length) continue;
        item.marks = remaining;
        if (targetId === currentSessionId && s.activeId === item.id) syncMarksUi(item);
    }
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
    const s = _activeSession();
    const item = s.activeId ? s.items.get(s.activeId) : null;
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
    const session = _activeSession();   // the fetch lands in the session that opened it
    const seq = ++noteSeq;
    noteUrl = url;
    noteParts.title.textContent = noteTitleFromUrl(url);
    noteParts.body.replaceChildren(noteLine('Loading note…', 'preview-note-loading'));
    if (!host.isOpen()) host.showModal();

    let source = session.notes.get(url);
    if (source === undefined) {
        try {
            source = await _fetchUrlText(url);
        } catch (err) {
            if (seq !== noteSeq) return;
            noteParts.body.replaceChildren(noteLine(`${err.message}\n${url}`, 'preview-note-error'));
            return;
        }
        session.notes.set(url, source);
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
    setSession,
    clearSession,
    togglePane,
    openBrowser,
    getContext,
    getActiveMarkIds,
    consumeMarks,
    getActivePlainText,
    getState,
    setMcpOriginResolver,
    setSpeechHandler,
    set onContentChange(fn) { _onContentChange = fn; },
    set onSpeakText(fn) { _onSpeakText = fn; }
};
