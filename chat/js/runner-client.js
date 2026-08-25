// ============================================
// runner-client.js — the view's backend for a runner-owned conversation.
// Same-origin, cookie-auth. Replaces GatewayClient + browser MCP client +
// client-authored persistence: send → POST /api/chats/:id/send, render ←
// GET /api/chats/:id/events (snapshot + live events).
// No state. No orchestration. No system-prompt knowledge. The controller
// (chat.js) feeds its renderer from the handlers this module invokes.
// Event contract: docs/architecture-conversation-runner.md §3 · server/runner.js.
// ============================================

// Event names the runner emits. Kept as a single source of truth for attach().
const EVENT_NAMES = [
    'snapshot', 'run.start', 'delta', 'tool.start', 'tool.end',
    'msg.assistant', 'msg.user', 'msg.deleted',
    'run.end', 'run.status', 'error', 'embed.status'
];

function _parseJSON(data) {
    if (!data) return {};
    try { return JSON.parse(data); } catch { return {}; }
}

async function _api(method, path, body) {
    const res = await fetch(path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    });
    const data = await res.json().catch(() => null);
    return { status: res.status, ok: res.ok, data };
}

// Attach to a conversation's event stream. `handlers` maps event name →
// callback(parsedData). Returns { close() } — call on detach/switch.
// On attach the server sends one `snapshot` event first, then live events.
function attach(chatId, handlers = {}) {
    const es = new EventSource(`/api/chats/${chatId}/events`);
    for (const name of EVENT_NAMES) {
        if (typeof handlers[name] === 'function') {
            es.addEventListener(name, (e) => handlers[name](_parseJSON(e.data)));
        }
    }
    return { close: () => es.close() };
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

// Event names the user-level list stream emits (sidebar sync across devices).
const LIST_EVENT_NAMES = ['chat.created', 'chat.updated', 'chat.deleted'];

// Attach to the user-level list stream. handlers maps event name → callback(data).
// Returns { close() }. Long-lived for the page — the sidebar must track new chats
// created on another device.
function attachListEvents(handlers = {}) {
    const es = new EventSource('/api/events');
    for (const name of LIST_EVENT_NAMES) {
        if (typeof handlers[name] === 'function') {
            es.addEventListener(name, (e) => handlers[name](_parseJSON(e.data)));
        }
    }
    return { close: () => es.close() };
}

export const runnerClient = { attach, send, abort, deleteMessage, editMessage, attachListEvents };
