// ============================================
// render.js — the view's render pipeline (architecture contract #5).
// ONE module whose state source is the event stream. No orchestration
// imports: app.js feeds it snapshot + events, it owns the message DOM.
// Contracts honored: {content, timestamp} split (no strip-by-length),
// DOM keyed by messageId/toolCallId, current variant rendered as-is,
// zero system-prompt knowledge.
// ============================================

const $msgs = () => document.getElementById('v-msgs');

const bubbles = new Map();      // messageId -> element
let streamingEl = null;         // in-flight assistant element (id: 'inflight')
let mdReady = false;

function ensureMd() {
    if (mdReady) return true;
    mdReady = !!customElements.get('nui-markdown');
    return mdReady;
}

function fmtTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function scrollIfPinned() {
    const el = $msgs();
    if (!el) return;
    const pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (pinned) el.scrollTop = el.scrollHeight;
}

function roleClass(m) {
    return m.role === 'user' ? 'user' : m.role === 'tool' ? 'tool' : 'assistant';
}

// ---- message construction (snapshot + msg.assistant) ----

function buildMessage(m) {
    const d = document.createElement('div');
    d.className = `msg ${roleClass(m)}`;
    d.dataset.id = m.id || '';

    const meta = document.createElement('div');
    meta.className = 'msg-meta';
    const bits = [fmtTime(m.timestamp)];
    if (m.model) bits.push(m.model);
    if (m.role === 'tool' && m.toolName) bits.push(m.toolName);
    if (m.role === 'assistant' && Array.isArray(m.versions) && m.versions.length > 1) {
        bits.push(`v${(m.currentVersion ?? 0) + 1}/${m.versions.length}`);
    }
    meta.textContent = bits.join(' · ');

    const embed = document.createElement('span');
    embed.className = 'embed-dot';
    embed.dataset.embedFor = m.id || '';
    embed.title = m.embedStatus || '—';
    embed.textContent = m.embedStatus === 'embedded' ? ' ●' : m.embedStatus === 'failed' ? ' ✕' : ' ◌';
    meta.appendChild(embed);
    if (m.role === 'user') {
        const edit = document.createElement('button');
        edit.className = 'msg-edit';
        edit.title = 'Edit & resend';
        edit.textContent = '✎';
        edit.onclick = (ev) => { ev.stopPropagation(); if (onEdit) onEdit(m.id, m.content); };
        meta.appendChild(edit);
    }
    const del = document.createElement('button');
    del.className = 'msg-delete';
    del.title = 'Delete message';
    del.textContent = '×';
    del.onclick = (ev) => { ev.stopPropagation(); if (onDelete) onDelete(m.id); };
    meta.appendChild(del);
    d.appendChild(meta);

    const body = document.createElement('div');
    body.className = 'msg-body';

    if (m.role === 'tool') {
        renderToolBody(body, m);
    } else if (m.role === 'assistant') {
        renderAssistantBody(body, m);
    } else {
        const md = document.createElement('nui-markdown');
        md.textContent = m.content || '';
        body.appendChild(md);
    }

    // attachments (densified by the snapshot)
    if (Array.isArray(m.attachments) && m.attachments.length > 0) {
        const atts = document.createElement('div');
        atts.className = 'msg-attachments';
        for (const a of m.attachments) {
            if ((a.type || '').startsWith('image/')) {
                const img = document.createElement('img');
                img.src = a.url || a.dataUrl || '';
                img.alt = a.name || 'attachment';
                img.loading = 'lazy';
                atts.appendChild(img);
            } else {
                const f = document.createElement('div');
                f.className = 'msg-file';
                f.textContent = `📎 ${a.name || 'file'} (${a.type || '?'})`;
                atts.appendChild(f);
            }
        }
        body.appendChild(atts);
    }

    d.appendChild(body);
    return d;
}

function renderToolBody(body, m) {
    const det = document.createElement('details');
    const sum = document.createElement('summary');
    const status = m.toolStatus === 'error' ? '✕' : m.toolStatus === 'success' ? '✓' : '…';
    sum.textContent = `${status} ${m.toolName || 'tool'}`;
    det.appendChild(sum);
    const pre = document.createElement('pre');
    pre.className = 'tool-out';
    pre.textContent = String(m.content || '').slice(0, 4000);
    det.appendChild(pre);
    body.appendChild(det);
}

function renderAssistantBody(body, m) {
    // thinking block (collapsed)
    if (m.reasoning_content) {
        const det = document.createElement('details');
        det.className = 'thinking';
        const sum = document.createElement('summary');
        sum.textContent = 'thinking';
        det.appendChild(sum);
        const pre = document.createElement('pre');
        pre.className = 'think-out';
        pre.textContent = m.reasoning_content;
        det.appendChild(pre);
        body.appendChild(det);
    }
    // static render: textContent BEFORE attach — connectedCallback picks it up
    const md = document.createElement('nui-markdown');
    md.textContent = m.content || '';
    body.appendChild(md);
}

// ---- public API (called by app.js) ----

let onDelete = null;
let onEdit = null;
export function setDeleteHandler(fn) { onDelete = fn; }
export function setEditHandler(fn) { onEdit = fn; }

export function removeMessage(messageId) {
    if (bubbles.has(messageId)) {
        bubbles.get(messageId).remove();
        bubbles.delete(messageId);
    }
}

export function clear() {
    const el = $msgs();
    if (el) el.innerHTML = '';
    bubbles.clear();
    streamingEl = null;
}

export function renderSnapshot(messages, meta = {}) {
    clear();
    const el = $msgs();
    if (!el) return;
    const info = document.createElement('div');
    info.className = 'conv-info';
    info.textContent = meta.title || '';
    el.appendChild(info);
    for (const m of messages || []) {
        const d = buildMessage(m);
        el.appendChild(d);
        if (m.id) bubbles.set(m.id, d);
    }
    el.scrollTop = el.scrollHeight;
}

export function upsertMessage(m) {
    const el = $msgs();
    if (!el) return;
    if (m.id && bubbles.has(m.id)) {
        const old = bubbles.get(m.id);
        const fresh = buildMessage(m);
        old.replaceWith(fresh);
        bubbles.set(m.id, fresh);
    } else {
        const d = buildMessage(m);
        el.appendChild(d);
        if (m.id) bubbles.set(m.id, d);
    }
    scrollIfPinned();
}

// run.start → begin streaming bubble keyed by messageId
export function beginStream({ messageId, model }) {
    const el = $msgs();
    if (!el) return;
    removeStream();
    const d = document.createElement('div');
    d.className = 'msg assistant streaming';
    d.dataset.id = messageId;
    d.innerHTML = `<div class="msg-meta">${model || ''} · streaming</div>`;
    const body = document.createElement('div');
    body.className = 'msg-body';
    const think = document.createElement('details');
    think.className = 'thinking';
    think.style.display = 'none';
    think.innerHTML = '<summary>thinking</summary><pre class="think-out"></pre>';
    body.appendChild(think);
    const md = document.createElement('nui-markdown');
    body.appendChild(md);
    d.appendChild(body);
    el.appendChild(d);
    streamingEl = d;
    scrollIfPinned();
}

let thinkOpen = false;
export function streamDelta({ content, reasoningContent }) {
    const el = streamingEl;
    if (!el) return;
    const md = el.querySelector('nui-markdown');
    const think = el.querySelector('.thinking');
    if (reasoningContent && think) {
        think.style.display = '';
        think.querySelector('pre').textContent += reasoningContent;
        if (!thinkOpen) { /* leave collapsed; user can open */ }
    }
    if (content && md) {
        // delta is INCREMENTAL — append
        if (!md._isStreaming) { try { md.beginStream(); } catch { } }
        try { md.appendChunk(content); } catch { md.textContent += content; }
    }
    el.classList.add('active');
    scrollIfPinned();
}

export function toolStart({ toolCallId, name }) {
    const el = $msgs();
    if (!el) return;
    const d = document.createElement('div');
    d.className = 'msg tool running';
    d.dataset.toolCallId = toolCallId || '';
    d.innerHTML = `<div class="msg-meta">${name} · running</div><div class="msg-body"><pre class="tool-out">…</pre></div>`;
    el.appendChild(d);
    scrollIfPinned();
}

export function toolEnd({ toolCallId, name, status, resultMessage, toolMessageId }) {
    const el = $msgs();
    let d = (toolCallId && el.querySelector(`[data-tool-call-id="${toolCallId}"]`)) || null;
    if (!d) { toolStart({ toolCallId, name }); d = el.querySelector(`[data-tool-call-id="${CSS.escape(toolCallId || '')}"]`); }
    if (!d) return;
    if (toolMessageId) {
        d.dataset.id = toolMessageId;
        bubbles.set(toolMessageId, d);
    }
    d.className = `msg tool ${status === 'error' ? 'errored' : ''}`;
    const sum = `${status === 'error' ? '✕' : '✓'} ${name}`;
    d.querySelector('.msg-meta').textContent = sum;
    d.querySelector('.tool-out').textContent = String(resultMessage || '').slice(0, 4000);
    scrollIfPinned();
}

export function removeStream() {
    if (streamingEl) { streamingEl.remove(); streamingEl = null; }
}

// msg.assistant replaces the streaming bubble with the persisted message
export function finalizeAssistant(m) {
    removeStream();
    upsertMessage(m);
}

export function runLine(text) {
    const el = $msgs();
    if (!el) return;
    const d = document.createElement('div');
    d.className = 'runline';
    d.textContent = text;
    el.appendChild(d);
    scrollIfPinned();
}

export function errorLine(text) {
    const el = $msgs();
    if (!el) return;
    const d = document.createElement('div');
    d.className = 'errorline';
    d.textContent = `⚠ ${text}`;
    el.appendChild(d);
    scrollIfPinned();
}

export function embedStatus({ messageId, status }) {
    const dot = messageId && document.querySelector(`[data-embed-for="${CSS.escape(messageId)}"]`);
    if (dot) {
        dot.textContent = status === 'embedded' ? ' ●' : status === 'failed' ? ' ✕' : ' ◌';
        dot.title = status;
    }
}
