// Explicit hosted tool apps (#58 Stage 1). Separate from the Markdown preview:
// the server-issued action only creates an Open button; this module owns the
// large dialog and its allowlisted iframe.

const HOSTED_APPS = {
    print: { editorPath: '/print' }
};
const CREDENTIAL_PARAMS = /^(?:access_?token|api_?key|token|session|secret|password|sig|signature)$/i;
let dialog = null;
let frame = null;

function init() {
    dialog = document.getElementById('hosted-app-dialog');
    frame = document.getElementById('hosted-app-frame');
    if (!dialog || !frame) throw new Error('hostedApps.init: required DOM elements not found');
    dialog.addEventListener('nui-dialog-close', () => {
        frame.src = 'about:blank';
    });
}

function resolve(ui, rawMcpOrigin) {
    if (!ui || ui.kind !== 'hosted-app') return null;
    const definition = HOSTED_APPS[ui.app];
    if (!definition || typeof ui.url !== 'string' || typeof ui.title !== 'string') return null;
    if (typeof ui.id !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(ui.id)) return null;
    if (typeof ui.appInstanceId !== 'string' || !/^app_[0-9a-f-]{36}$/.test(ui.appInstanceId)) return null;
    if (!rawMcpOrigin) return null;

    let url;
    let origin;
    try {
        origin = new URL(rawMcpOrigin).origin;
        url = new URL(ui.url, origin);
    } catch {
        return null;
    }
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.origin !== origin) return null;
    if (url.pathname !== definition.editorPath || url.username || url.password) return null;
    for (const key of url.searchParams.keys()) {
        if (CREDENTIAL_PARAMS.test(key)) return null;
    }
    return {
        mode: 'dialog',
        id: ui.id,
        app: ui.app,
        appInstanceId: ui.appInstanceId,
        title: ui.title,
        url: url.toString(),
        label: typeof ui.label === 'string' && ui.label.trim() ? ui.label.trim() : `Open ${ui.title}`
    };
}

function open(action) {
    if (!dialog || !frame || !action || action.mode !== 'dialog') throw new Error('hostedApps.open: initialized hosted-app action required');
    dialog.setAttribute('title', action.title);
    const titleEl = dialog.querySelector('dialog > header h2');
    if (titleEl) titleEl.textContent = action.title;
    frame.title = action.title;
    if (frame.src !== action.url) frame.src = action.url;
    dialog.showModal();
}

function reset() {
    if (!dialog || !frame) return;
    if (dialog.isOpen()) dialog.close('conversation-switch');
    frame.src = 'about:blank';
}

export const hostedApps = { init, resolve, open, reset };
