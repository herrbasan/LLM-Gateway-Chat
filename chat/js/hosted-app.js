// Explicit hosted tool apps (#58 Stage 1). Separate from the Markdown preview:
// the server-issued action only creates an Open button; this module owns the
// large dialog and its allowlisted iframe.

const HOSTED_APPS = {
    print: { editorPath: '/print' }
};
const CREDENTIAL_PARAMS = /^(?:access_?token|api_?key|token|session|secret|password|sig|signature)$/i;
let dialog = null;
let frame = null;
let current = null;
let conversationId = null;

function init() {
    dialog = document.getElementById('hosted-app-dialog');
    frame = document.getElementById('hosted-app-frame');
    if (!dialog || !frame) throw new Error('hostedApps.init: required DOM elements not found');
    dialog.addEventListener('nui-dialog-close', () => {
        frame.src = 'about:blank';
    });
    window.addEventListener('message', onHostMessage);
}

function resolveUrl(raw, rawPublicOrigin, rawBackendOrigin) {
    if (typeof raw !== 'string' || !raw.trim() || !rawPublicOrigin) return null;
    let publicOrigin;
    let backendOrigin = null;
    try {
        publicOrigin = new URL(rawPublicOrigin).origin;
        backendOrigin = rawBackendOrigin ? new URL(rawBackendOrigin).origin : null;
    } catch {
        return null;
    }

    let url;
    try { url = new URL(raw, publicOrigin); } catch { return null; }
    if (url.origin !== publicOrigin && url.origin !== backendOrigin) return null;
    if (url.pathname === '/print') url.pathname = '/print/';
    // Path preservation turns a backend-issued internal URL into its public
    // route without ever exposing the internal host to the browser (#62).
    return new URL(`${url.pathname}${url.search}${url.hash}`, publicOrigin);
}

function resolve(ui, rawPublicOrigin, rawBackendOrigin) {
    if (!ui || ui.kind !== 'hosted-app') return null;
    const definition = HOSTED_APPS[ui.app];
    if (!definition || typeof ui.url !== 'string' || typeof ui.title !== 'string') return null;
    if (typeof ui.id !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(ui.id)) return null;
    if (typeof ui.appInstanceId !== 'string' || !/^app_[0-9a-f-]{36}$/.test(ui.appInstanceId)) return null;

    const url = resolveUrl(ui.url, rawPublicOrigin, rawBackendOrigin);
    if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) return null;
    const origin = url.origin;
    if (url.pathname !== definition.editorPath && url.pathname !== `${definition.editorPath}/`) return null;
    url.pathname = `${definition.editorPath}/`;
    if (url.username || url.password) return null;
    for (const key of url.searchParams.keys()) {
        if (CREDENTIAL_PARAMS.test(key)) return null;
    }
    url.searchParams.set('hostInstanceId', ui.appInstanceId);
    url.searchParams.set('parentOrigin', window.location.origin);
    return {
        mode: 'dialog',
        id: ui.id,
        app: ui.app,
        appInstanceId: ui.appInstanceId,
        title: ui.title,
        url: url.toString(),
        mcpOrigin: origin,
        label: typeof ui.label === 'string' && ui.label.trim() ? ui.label.trim() : `Open ${ui.title}`
    };
}

function open(action) {
    if (!dialog || !frame || !action || action.mode !== 'dialog') throw new Error('hostedApps.open: initialized hosted-app action required');
    if (!conversationId) throw new Error('hostedApps.open: no active conversation');
    current = { ...action, conversationId };
    dialog.setAttribute('title', action.title);
    const titleEl = dialog.querySelector('dialog > header h2');
    if (titleEl) titleEl.textContent = action.title;
    frame.title = action.title;
    if (frame.src !== action.url) frame.src = action.url;
    dialog.showModal();
}

function setConversation(id) {
    conversationId = id || null;
}

function acknowledgeHost(source, eventType, accepted, error = null) {
    if (!current || eventType !== 'saved') return;
    source.postMessage({
        source: 'chat-host',
        version: 1,
        app: current.app,
        instance: current.appInstanceId,
        type: 'event-result',
        eventType,
        accepted,
        error
    }, current.mcpOrigin);
}

async function onHostMessage(event) {
    if (!current || event.origin !== current.mcpOrigin || event.source !== frame.contentWindow) return;
    const data = event.data;
    if (!data || data.source !== 'workshop-app' || data.version !== 1) return;
    if (data.app !== current.app || data.instance !== current.appInstanceId) return;
    if (data.type !== 'saved' && data.type !== 'closed') return;
    if (data.type === 'saved' && (typeof data.path !== 'string' || typeof data.sourceSha256 !== 'string' || typeof data.pdfUrl !== 'string')) return;

    try {
        const response = await fetch(`/api/chats/${encodeURIComponent(current.conversationId)}/app-events`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(data)
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
        acknowledgeHost(event.source, data.type, true);
    } catch (error) {
        // The document save is already authoritative on the MCP side. This ack
        // only reports notification failure; it must never become a save error.
        acknowledgeHost(event.source, data.type, false, error.message);
    }
}

function reset() {
    if (!dialog || !frame) return;
    if (dialog.isOpen()) dialog.close('conversation-switch');
    else current = null;
    frame.src = 'about:blank';
    conversationId = null;
}

export const hostedApps = { init, resolve, resolveUrl, open, reset, setConversation };
