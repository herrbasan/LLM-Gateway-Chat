const crypto = require('crypto');

// Explicit hosted UIs only. A model cannot turn an arbitrary MCP URL into an
// iframe: the app id selects the allowed editor path, and the URL must remain on
// the configured MCP origin. Headless tools never enter this path (#58).
const HOSTED_APPS = {
    print: { editorPath: '/print', defaultTitle: 'Print editor' }
};
const CREDENTIAL_PARAMS = /^(?:access_?token|api_?key|token|session|secret|password|sig|signature)$/i;

function resolveHostedApp(args, mcpOrigin) {
    if (!args || typeof args !== 'object') throw new Error('chat_app_open: args object required');
    const id = typeof args.id === 'string' ? args.id.trim() : '';
    const app = typeof args.app === 'string' ? args.app.trim() : '';
    const rawUrl = typeof args.url === 'string' ? args.url.trim() : '';
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(id)) throw new Error('chat_app_open: id must be a safe slug');
    const definition = HOSTED_APPS[app];
    if (!definition) throw new Error(`chat_app_open: unsupported hosted app "${app}"`);
    if (!rawUrl) throw new Error('chat_app_open: url required');
    if (!mcpOrigin) throw new Error('chat_app_open: no MCP storage origin configured');

    const origin = new URL(mcpOrigin).origin;
    const url = new URL(rawUrl, origin);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('chat_app_open: only HTTP(S) apps are supported');
    if (url.origin !== origin) throw new Error(`chat_app_open: app URL origin ${url.origin} does not match the configured MCP origin ${origin}`);
    if (url.pathname !== definition.editorPath && url.pathname !== `${definition.editorPath}/`) throw new Error(`chat_app_open: ${app} apps must use ${definition.editorPath}, received ${url.pathname}`);
    url.pathname = `${definition.editorPath}/`;
    if (url.username || url.password) throw new Error('chat_app_open: credentials in URLs are forbidden');
    for (const key of url.searchParams.keys()) {
        if (CREDENTIAL_PARAMS.test(key)) throw new Error(`chat_app_open: credential query parameter "${key}" is forbidden`);
    }

    const title = typeof args.title === 'string' && args.title.trim() ? args.title.trim() : definition.defaultTitle;
    return { id, app, title, url: url.toString() };
}

function openHostedApp(args, { mcpOrigin, conversationId }) {
    if (!conversationId) throw new Error('chat_app_open: conversationId required');
    const resolved = resolveHostedApp(args, mcpOrigin);
    // The id is issued inside this conversation's tool message; that persisted
    // tool message is the Stage 1 scope. Stage 2 adds server-side instance state.
    const appInstanceId = `app_${crypto.randomUUID()}`;
    const label = `Open ${resolved.title}`;
    return {
        content: [{
            type: 'text',
            text: `Hosted app "${resolved.title}" is ready (appInstanceId: ${appInstanceId}). Click "${label}" on this tool message to open it; nothing has been opened automatically.`
        }],
        ui: { kind: 'hosted-app', ...resolved, appInstanceId, label }
    };
}

function normalizeAppEvent(raw) {
    if (!raw || raw.source !== 'workshop-app' || raw.version !== 1) throw new Error('app event: unsupported source or version');
    if (raw.app !== 'print') throw new Error(`app event: unsupported app "${raw.app}"`);
    if (typeof raw.instance !== 'string' || !/^app_[0-9a-f-]{36}$/.test(raw.instance)) throw new Error('app event: invalid appInstanceId');
    if (raw.type !== 'saved' && raw.type !== 'closed') throw new Error(`app event: unsupported type "${raw.type}"`);

    const event = { appInstanceId: raw.instance, app: raw.app, type: raw.type };
    if (raw.path !== undefined) {
        if (typeof raw.path !== 'string' || !raw.path || raw.path.length > 1024 || raw.path.startsWith('/') || raw.path.includes('\\') || raw.path.split('/').includes('..')) {
            throw new Error('app event: path must be a confined storage-relative path');
        }
        event.path = raw.path;
    }
    if (raw.type === 'saved') {
        if (!event.path) throw new Error('app event: saved requires path');
        if (typeof raw.sourceSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(raw.sourceSha256)) throw new Error('app event: saved requires sourceSha256');
        if (typeof raw.pdfUrl !== 'string' || !raw.pdfUrl.startsWith('/storage/prints/') || raw.pdfUrl.includes('..')) throw new Error('app event: saved requires a confined print pdfUrl');
        event.sourceSha256 = raw.sourceSha256;
        event.pdfUrl = raw.pdfUrl;
    }
    return event;
}

module.exports = { openHostedApp, resolveHostedApp, normalizeAppEvent };
