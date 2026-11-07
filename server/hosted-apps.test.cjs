const test = require('node:test');
const assert = require('node:assert/strict');
const { openHostedApp, resolveHostedApp } = require('./hosted-apps');
const internalTools = require('./internal-tools');

const ORIGIN = 'http://localhost:3100';
const valid = { id: 'print-vita', title: 'Vita — print layout', app: 'print', url: '/print?path=vita%2Fvita.md' };

test('creates an explicit hosted-app action with a unique conversation-scoped instance id', () => {
    const first = openHostedApp(valid, { mcpOrigin: ORIGIN, conversationId: 'chat_test' });
    const second = openHostedApp(valid, { mcpOrigin: ORIGIN, conversationId: 'chat_test' });
    assert.equal(first.ui.kind, 'hosted-app');
    assert.equal(first.ui.app, 'print');
    assert.equal(first.ui.label, 'Open Vita — print layout');
    assert.equal(first.ui.url, 'http://localhost:3100/print?path=vita%2Fvita.md');
    assert.match(first.ui.appInstanceId, /^app_[0-9a-f-]{36}$/);
    assert.notEqual(first.ui.appInstanceId, second.ui.appInstanceId);
    assert.match(first.content[0].text, /nothing has been opened automatically/);
});

test('accepts an absolute URL only on the configured MCP origin', () => {
    const resolved = resolveHostedApp({ ...valid, url: `${ORIGIN}/print?path=vita.md` }, ORIGIN);
    assert.equal(resolved.url, `${ORIGIN}/print?path=vita.md`);
    assert.throws(() => resolveHostedApp({ ...valid, url: 'https://example.com/print' }, ORIGIN), /does not match/);
});

test('rejects arbitrary apps, paths, schemes, and credential-bearing URLs', () => {
    assert.throws(() => resolveHostedApp({ ...valid, app: 'browser' }, ORIGIN), /unsupported hosted app/);
    assert.throws(() => resolveHostedApp({ ...valid, url: '/storage/secret.txt' }, ORIGIN), /must use \/print/);
    assert.throws(() => resolveHostedApp({ ...valid, url: 'javascript:alert(1)' }, ORIGIN), /HTTP\(S\)/);
    assert.throws(() => resolveHostedApp({ ...valid, url: 'http://user:pass@localhost:3100/print' }, ORIGIN), /credentials/);
    assert.throws(() => resolveHostedApp({ ...valid, url: '/print?token=secret' }, ORIGIN), /credential query parameter/);
});

test('requires a safe id and conversation scope', () => {
    assert.throws(() => resolveHostedApp({ ...valid, id: 'bad id' }, ORIGIN), /safe slug/);
    assert.throws(() => openHostedApp(valid, { mcpOrigin: ORIGIN }), /conversationId required/);
});

test('chat_app_open is registered as a native tool and returns its UI action through dispatch', async () => {
    assert.equal(internalTools.isInternalTool('chat_app_open'), true);
    const result = await internalTools.executeInternalTool('chat_app_open', valid, {
        user: { id: 'test' },
        dbInstance: { db: {} },
        conversationId: 'chat_test',
        mcpOrigin: ORIGIN
    });
    assert.equal(result.ui.kind, 'hosted-app');
    assert.equal(result.ui.app, 'print');
    assert.match(result.ui.appInstanceId, /^app_/);
});
