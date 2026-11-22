const test = require('node:test');
const assert = require('node:assert/strict');
const { openHostedApp, resolveHostedApp, normalizeAppEvent } = require('./hosted-apps');
const { buildAppEventBlock } = require('./system-prompt');
const runner = require('./runner');
const internalTools = require('./internal-tools');

const ORIGIN = 'http://localhost:3100';
const valid = { id: 'print-vita', title: 'Vita — print layout', app: 'print', url: '/print?path=vita%2Fvita.md' };

test('creates an explicit hosted-app action with a unique conversation-scoped instance id', () => {
    const first = openHostedApp(valid, { mcpOrigin: ORIGIN, conversationId: 'chat_test' });
    const second = openHostedApp(valid, { mcpOrigin: ORIGIN, conversationId: 'chat_test' });
    assert.equal(first.ui.kind, 'hosted-app');
    assert.equal(first.ui.app, 'print');
    assert.equal(first.ui.label, 'Open Vita — print layout');
    assert.equal(first.ui.url, 'http://localhost:3100/print/?path=vita%2Fvita.md');
    assert.match(first.ui.appInstanceId, /^app_[0-9a-f-]{36}$/);
    assert.notEqual(first.ui.appInstanceId, second.ui.appInstanceId);
    assert.match(first.content[0].text, /nothing has been opened automatically/);
});

test('accepts an absolute URL only on the configured MCP origin', () => {
    const resolved = resolveHostedApp({ ...valid, url: `${ORIGIN}/print?path=vita.md` }, ORIGIN);
    assert.equal(resolved.url, `${ORIGIN}/print/?path=vita.md`);
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

const savedEvent = {
    source: 'workshop-app',
    version: 1,
    app: 'print',
    instance: 'app_12345678-1234-1234-1234-123456789abc',
    type: 'saved',
    path: 'vita/vita_ai_change_manager_v4.md',
    sourceSha256: 'a'.repeat(64),
    pdfUrl: '/storage/prints/_editor/session/document.pdf'
};

test('validates compact saved and closed app events', () => {
    assert.deepEqual(normalizeAppEvent(savedEvent), {
        appInstanceId: savedEvent.instance,
        app: 'print',
        type: 'saved',
        path: savedEvent.path,
        sourceSha256: savedEvent.sourceSha256,
        pdfUrl: savedEvent.pdfUrl
    });
    assert.deepEqual(normalizeAppEvent({ ...savedEvent, type: 'closed', path: undefined }), {
        appInstanceId: savedEvent.instance,
        app: 'print',
        type: 'closed'
    });
});

test('rejects forged, malformed, or out-of-scope app events', () => {
    assert.throws(() => normalizeAppEvent({ ...savedEvent, source: 'anything' }), /source or version/);
    assert.throws(() => normalizeAppEvent({ ...savedEvent, instance: 'app_fake' }), /appInstanceId/);
    assert.throws(() => normalizeAppEvent({ ...savedEvent, type: 'rendered' }), /unsupported type/);
    assert.throws(() => normalizeAppEvent({ ...savedEvent, path: '../secret.md' }), /storage-relative/);
    assert.throws(() => normalizeAppEvent({ ...savedEvent, sourceSha256: 'bad' }), /sourceSha256/);
    assert.throws(() => normalizeAppEvent({ ...savedEvent, pdfUrl: 'https://example.com/document.pdf' }), /pdfUrl/);
});

test('formats pending app events as an authoritative next-turn system block', () => {
    const block = buildAppEventBlock([normalizeAppEvent(savedEvent)]);
    assert.match(block, /HOSTED APP EVENTS/);
    assert.match(block, /document write already succeeded/);
    assert.match(block, /vita\/vita_ai_change_manager_v4\.md/);
    assert.match(block, new RegExp('a'.repeat(64)));
    assert.equal(buildAppEventBlock([]), '');
});

test('runner persists and deduplicates issued app events, then consumes them only on settlement', async (t) => {
    const docs = [
        { _id: 'session_1', _type: 'session', id: 'chat_1', title: 'Test', createdAt: new Date().toISOString() },
        {
            _id: 'conv_1', _type: 'conversation', id: 'chat_1', title: 'Test', messages: [{
                role: 'tool',
                toolName: 'chat_app_open',
                toolUi: { kind: 'hosted-app', app: 'print', appInstanceId: savedEvent.instance }
            }]
        }
    ];
    // The runner speaks to an nDB handle whose calls are all async.
    const db = {
        async findAll(field, value) { return structuredClone(docs.filter(doc => doc[field] === value)); },
        async find(field, value) {
            const results = await this.findAll(field, value);
            return { count: results.length, results };
        },
        async patch(id, ops) {
            const doc = docs.find(entry => entry._id === id);
            for (const op of ops) {
                if (op.op !== 'set') throw new Error(`fake db: unsupported op ${op.op}`);
                const parts = op.path.split('.');
                let cur = doc;
                for (let i = 0; i < parts.length - 1; i++) cur = cur[parts[i]];
                cur[parts[parts.length - 1]] = structuredClone(op.value);
            }
            return { applied: ops.length, doc: structuredClone(doc) };
        },
        async set(id, field, value) { return this.patch(id, [{ op: 'set', path: field, value }]); },
        async update(id, doc) { Object.assign(docs.find(entry => entry._id === id), structuredClone(doc)); },
        async insert(doc) {
            const stored = { _id: `gen_${docs.length + 1}`, ...structuredClone(doc) };
            docs.push(stored);
            return { id: stored._id, doc: stored };
        }
    };
    const emitted = [];
    runner.init({
        idleMs: 60000,
        log: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
        emitUserEvent: (_user, _chat, type, data) => emitted.push({ type, data }),
        getInstructions: async () => '',
        embedMessageAsync: async () => {}
    });
    const instance = await runner.getRunner({ id: 'test' }, { db }, 'chat_1');
    t.after(() => clearTimeout(instance.idleTimer));

    const first = await instance.recordAppEvent(savedEvent);
    assert.equal(first.duplicate, false);
    assert.equal(instance.conv.appEvents.length, 1);
    assert.equal(instance._pendingAppEvents().length, 1);
    assert.equal(emitted.at(-1).type, 'app.event');

    const duplicate = await instance.recordAppEvent(savedEvent);
    assert.equal(duplicate.duplicate, true);
    assert.equal(instance.conv.appEvents.length, 1);
    await assert.rejects(
        () => instance.recordAppEvent({ ...savedEvent, instance: 'app_00000000-0000-0000-0000-000000000000' }),
        /was not issued/
    );

    instance._appEventIdsInRun = new Set([first.event.id]);
    await instance._consumeAppEventsInRun();
    assert.ok(instance.conv.appEvents[0].consumedAt);
    assert.equal(instance._pendingAppEvents().length, 0);
});
