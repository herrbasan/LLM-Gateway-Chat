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

// ============================================
// State (module-level, per-conversation)
// ============================================

const items = new Map();   // id → { id, title, language, content, source }
let activeId = null;       // currently displayed item id

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
 * Show or update a preview item. Called by the chat_preview_show local tool.
 * Brings the item to front (selects it). Opens the pane if hidden.
 *
 * @param {Object} args - Tool arguments
 * @param {string} args.id - Stable identifier (reuse to update in place)
 * @param {string} args.title - Human-readable label for dropdown
 * @param {string} args.content - The content to render
 * @param {string} [args.language='text'] - 'markdown' for rendered MD, else code language
 * @param {string} [args.source] - Optional provenance label
 * @returns {Object} MCP-style result { content: [{ type: 'text', text }] }
 */
function show(args) {
    // Success conditions — fail fast on invalid input
    if (!args || typeof args !== 'object') throw new Error('preview.show: args object required');
    if (typeof args.id !== 'string' || args.id.length === 0) throw new Error('preview.show: id required');
    if (typeof args.title !== 'string' || args.title.length === 0) throw new Error('preview.show: title required');
    if (typeof args.content !== 'string' || args.content.length === 0) throw new Error('preview.show: content required');
    if (args.content.length > MAX_CONTENT_BYTES) {
        throw new Error(`preview.show: content exceeds ${MAX_CONTENT_BYTES} byte cap (${args.content.length} bytes). Excerpt the file and show the relevant portion.`);
    }
    const language = typeof args.language === 'string' ? args.language : 'text';
    const source = typeof args.source === 'string' ? args.source : null;

    // Upsert into items map
    items.set(args.id, {
        id: args.id,
        title: args.title,
        language,
        content: args.content,
        source
    });

    // Select this item (brings to front)
    activeId = args.id;

    // Open pane if hidden
    openPane();

    // Update dropdown + render
    syncDropdown();
    renderActive();

    return {
        content: [{
            type: 'text',
            text: JSON.stringify({
                shown: true,
                id: args.id,
                selected: true,
                itemCount: items.size
            })
        }]
    };
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

// ============================================
// Module exports
// ============================================

export const preview = {
    init,
    show,
    close,
    reset
};
