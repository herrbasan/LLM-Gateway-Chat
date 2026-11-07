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
    if (url.pathname !== definition.editorPath) throw new Error(`chat_app_open: ${app} apps must use ${definition.editorPath}, received ${url.pathname}`);
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

module.exports = { openHostedApp, resolveHostedApp };
