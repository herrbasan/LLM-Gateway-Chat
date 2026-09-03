// ============================================
// runner-client.js — the view's backend for a runner-owned conversation.
// Same-origin, cookie-auth. send → POST /api/chats/:id/send, state ← REST
// snapshot, live events ← ONE shared multiplexed SSE (issue #19).
//
// Transport (multiplexing): every runner event also flows through the
// user-level stream /api/events as an `r.<event>` frame whose data carries
// `chatId`. This module holds ONE EventSource for the whole tab and routes
// frames to the handlers registered per chat. Rationale: browsers cap ~6
// concurrent connections per host on HTTP/1.1 — one EventSource per chat
// (plus the list stream) starved same-origin fetches (sends hung with zero
// server-side trace) as soon as 2–3 tabs were open.
//
// No state. No orchestration. The controller (chat.js) feeds its renderer
// from the handlers this module invokes.
// Event contract: docs/architecture-conversation-runner.md §3 · server/runner.js.
// ============================================

// Event names the runner emits (server fan-out prefixes them with `r.`).
const EVENT_NAMES = [
    'snapshot', 'run.start', 'delta', 'tool.start', 'tool.end',
    'msg.assistant', 'msg.user', 'msg.deleted',
    'run.end', 'run.status', 'error', 'embed.status', 'model.changed',
    'chat.progress'
];

// Event names the user-level list stream emits (sidebar sync across devices).
const LIST_EVENT_NAMES = ['chat.created', 'chat.updated', 'chat.deleted'];

const SEND_TIMEOUT_MS = 20000;

function _parseJSON(data) {
    if (!data) return {};
    try { return JSON.parse(data); } catch { return {}; }
}

async function _api(method, path, body) {
    // Fail loud: a send that produces no server response within the window is a
    // wedged transport (starved connection pool, dead server) — surface it
    // instead of queueing forever (issue #19 symptom class: "nothing happens").
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), SEND_TIMEOUT_MS);
    let res;
    try {
        res = await fetch(path, {
            method,
            headers: { 'Content-Type': 'application/json' },
            ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
            signal: ctrl.signal
        });
    } catch (err) {
        if (err?.name === 'AbortError') {
            throw new Error(`Request timed out after ${SEND_TIMEOUT_MS / 1000}s — server unreachable. If several tabs are open, close the extras and retry.`);
        }
        throw err;
    } finally {
        clearTimeout(timer);
    }
    const data = await res.json().catch(() => null);
    return { status: res.status, ok: res.ok, data };
}

// ---- Shared multiplexed EventSource (one per tab, page-lifetime) ----

let sharedEs = null;
const chatHandlers = new Map();   // chatId → handlers object
const listHandlers = new Set();   // handlers objects for list events

function _ensureStream() {
    if (sharedEs) return sharedEs;

    const es = new EventSource('/api/events');
    sharedEs = es;

    // Runner events arrive as `r.<name>` frames with chatId in the payload.
    for (const name of EVENT_NAMES) {
        es.addEventListener('r.' + name, (e) => {
            const data = _parseJSON(e.data);
            const handlers = data.chatId ? chatHandlers.get(data.chatId) : null;
            if (typeof handlers?.[name] === 'function') handlers[name](data);
        });
    }
    for (const name of LIST_EVENT_NAMES) {
        es.addEventListener(name, (e) => {
            const data = _parseJSON(e.data);
            for (const h of listHandlers) {
                if (typeof h[name] === 'function') h[name](data);
            }
        });
    }

    // Reconnect (drop or server restart): EventSource replays nothing —
    // re-snapshot every attached chat so views rebuild from persisted state.
    es.onopen = () => {
        for (const [chatId, handlers] of chatHandlers) {
            _fetchSnapshot(chatId, handlers);
        }
    };
    return es;
}

async function _fetchSnapshot(chatId, handlers) {
    try {
        const res = await fetch(`/api/chats/${chatId}/snapshot`);
        if (!res.ok) return;
        const snap = await res.json().catch(() => null);
        if (snap && typeof handlers.snapshot === 'function') handlers.snapshot(snap);
    } catch { /* transient — next reconnect retries */ }
}

// Register a view for a conversation. `handlers` maps event name →
// callback(parsedData). Returns { close() } — call on detach/switch.
// Snapshot is fetched over REST on attach (and on every stream reconnect),
// then live events are routed from the shared stream by chatId.
function attach(chatId, handlers = {}) {
    chatHandlers.set(chatId, handlers);
    _ensureStream();
    _fetchSnapshot(chatId, handlers);
    return { close: () => { if (chatHandlers.get(chatId) === handlers) chatHandlers.delete(chatId); } };
}

// Append a user message + start a run (queued if one is active).
// body: { content, attachments?, model?, temperature?, max_tokens?, reasoning_effort? }
// → { status, ok, data: { message } }
function send(chatId, body) {
    return _api('POST', `/api/chats/${chatId}/send`, body);
}

// Abort the active run. → { status, ok, data: { aborted } }
function abort(chatId) {
    return _api('POST', `/api/chats/${chatId}/abort`);
}

// Delete one message (single-author write through the runner).
function deleteMessage(chatId, messageId) {
    return _api('DELETE', `/api/chats/${chatId}/messages/${encodeURIComponent(messageId)}`);
}

// Edit a user message in place and re-run from it. → { status, ok, data }
function editMessage(chatId, messageId, content) {
    return _api('PATCH', `/api/chats/${chatId}/messages/${encodeURIComponent(messageId)}`, { content });
}

// Attach to the user-level list stream. handlers maps event name → callback(data).
// Shares the same single EventSource as the per-chat view. Long-lived for the
// page — the sidebar must track new chats created on another device.
function attachListEvents(handlers = {}) {
    listHandlers.add(handlers);
    _ensureStream();
    return { close: () => { listHandlers.delete(handlers); } };
}

export const runnerClient = { attach, send, abort, deleteMessage, editMessage, attachListEvents };
