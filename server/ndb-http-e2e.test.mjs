// Real nDB v2 HTTP end-to-end: a throwaway `ndb serve` (plus `nvdb serve` for
// the sync half), no NAPI, no live data.
//   node server/ndb-http-e2e.test.mjs
//
// Proves the wire contract the chat backend relies on:
//   1  multi-DB mount (`chat_users` + `chat_<user>`) and dynamic createDb
//   2  conversation-store appends/edits through ATOMIC PATCH + Rust pagination
//   3  attachment buckets: store/get/release with 64-hex SHA-256 AND legacy
//      8-hex refs
//   4  Phase 4b sync: pinned-snapshot rebuild -> incremental catch-up ->
//      direct delete sweep -> compact()/409 cursor_expired -> automatic
//      rebuild -> loud failure when the watermark is ahead of the source
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const require = createRequire(import.meta.url);
const { createNdbClient, NdbError } = require('./ndb-client');
const { createV2Client } = require('./nvdb-v2-client');
const { createNvdbSync, createVectorDrainer } = require('./nvdb-sync');
const {
    chatCollectionConfig,
    buildMessageV2Docs,
    buildUserExpectedDocs,
    userPrincipal,
    buildChatVectorInput,
    parseChatChunkId,
    expectedDocsFromDocs
} = require('./nvdb-chat');
const { documentHashes } = require('./nvdb-v2-hash');
const { isEmbeddableMessage } = require('./embed');
const { searchArchive } = require('./internal-tools');
const store = require('./conversation-store');

const NDB_EXE = process.env.NDB_EXE || 'D:\\DEV\\nDB\\target\\release\\ndb.exe';
const NVDB_EXE = process.env.NVDB_EXE || 'D:\\DEV\\nVDB\\target\\release\\nvdb.exe';
const COLLECTION = 'chat';
const DIMS = 8;
const MODEL_VERSION = 'test-v1';
const CHUNK_OPTS = { chunkTokens: 64, overlapTokens: 8, tokRatio: 2.5 };
const SLEEP_MS = 100;
const HEALTH_TIMEOUT_MS = 10_000;

const ALICE = 'alice';

let passed = 0;
const failures = [];
async function test(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`ok   ${name}`);
    } catch (err) {
        failures.push({ name, err });
        console.log(`FAIL ${name}\n     ${err.message}`);
    }
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function hash32(text) {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
}

function unitVector(seed) {
    const raw = [];
    for (let i = 0; i < DIMS; i++) raw.push(((hash32(`${seed}:${i}`) % 2001) / 1000) - 1);
    const norm = Math.hypot(...raw) || 1;
    return raw.map(value => value / norm);
}

async function freePort() {
    return new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.once('error', reject);
        probe.listen(0, '127.0.0.1', () => {
            const { port } = probe.address();
            probe.close(() => resolve(port));
        });
    });
}

async function waitForHealth(check, child, stderrTail, label) {
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    let lastError = null;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) {
            throw new Error(`${label} serve exited early (code ${child.exitCode}): ${stderrTail()}`);
        }
        try {
            const health = await check();
            if (health?.ok === true) return health;
            lastError = new Error(`health not ok: ${JSON.stringify(health)}`);
        } catch (err) {
            lastError = err;
        }
        await sleep(SLEEP_MS);
    }
    throw new Error(`${label} serve did not become healthy within ${HEALTH_TIMEOUT_MS}ms: ${lastError?.message}\n${stderrTail()}`);
}

async function stopChild(child) {
    if (!child || child.exitCode !== null) return;
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill();
    const timer = setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
    }, 5000);
    await exited;
    clearTimeout(timer);
}

const ctx = {};
const logSink = { info() {}, warn() {}, error() {}, debug() {} };

function sessionDoc(id, title, updatedAt) {
    return { _type: 'session', id, userId: ALICE, title, mode: 'direct', model: 'test-model', createdAt: updatedAt, updatedAt, messageCount: 0 };
}

function conversationDoc(id, title, messages, updatedAt) {
    return { _type: 'conversation', id, userId: ALICE, title, mode: 'direct', model: null, isPublic: false, createdAt: updatedAt, updatedAt, messageCount: messages.length, messages };
}

function storedMessage(id, idx, role, content, createdAt) {
    return {
        id, idx, role, speaker: null, model: role === 'assistant' ? 'test-model' : null,
        content, rawContent: content, attachments: [], createdAt,
        embedStatus: 'pending', embedAttempts: 0, embedError: null
    };
}

function instance(userId, username, dbName, db) {
    return {
        userId,
        username,
        dbName,
        db,
        nvdbClient: ctx.client,
        nvdbCollection: COLLECTION,
        nvdbChunkOpts: CHUNK_OPTS,
        reconcileRunning: null
    };
}

/** The embed loop as the live server runs it, minus the gateway. */
async function embedMessageAsync(dbInstance, msg, session, convNdbId, msgIdx) {
    if (!isEmbeddableMessage(msg)) return;
    const docs = buildMessageV2Docs({ userId: dbInstance.userId, session, msg, msgIdx, chunkOpts: CHUNK_OPTS });
    if (docs.length === 0) return;
    await ctx.client.upsert(COLLECTION, docs, { commit: true });
    await ctx.client.attachVectors(COLLECTION, docs.map(doc => ({
        id: doc.id,
        content_hash: documentHashes(doc).content_hash,
        model_version: MODEL_VERSION,
        vector: unitVector(doc.id)
    })));
}

async function setup() {
    for (const [label, exe] of [['nDB', NDB_EXE], ['nVDB', NVDB_EXE]]) {
        if (!fs.existsSync(exe)) throw new Error(`${label} binary not found: ${exe} (cargo build --release in its repo)`);
    }

    ctx.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-ndb-http-e2e-'));
    ctx.ndbDir = path.join(ctx.dir, 'ndb');
    ctx.ndbRoot = path.join(ctx.ndbDir, 'dbs');
    ctx.nvdbDir = path.join(ctx.dir, 'nvdb');
    fs.mkdirSync(ctx.ndbRoot, { recursive: true });
    fs.mkdirSync(ctx.nvdbDir, { recursive: true });

    ctx.ndbPort = await freePort();
    ctx.ndbStderr = '';
    ctx.ndbChild = spawn(
        NDB_EXE,
        [
            'serve',
            '--dir', ctx.ndbRoot,
            '--db', `chat_users=${path.join(ctx.ndbDir, 'chat_users')}`,
            '--bind', '127.0.0.1',
            '--port', String(ctx.ndbPort)
        ],
        { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
    );
    ctx.ndbChild.stdout.on('data', () => {});
    ctx.ndbChild.stderr.on('data', (chunk) => { ctx.ndbStderr += chunk.toString(); });

    ctx.ndb = createNdbClient(`http://127.0.0.1:${ctx.ndbPort}`);
    await waitForHealth(() => ctx.ndb.health(), ctx.ndbChild, () => ctx.ndbStderr.slice(-2000), 'ndb');
    ctx.usersDb = ctx.ndb.db('chat_users');

    const nvdbPort = await freePort();
    ctx.nvdbStderr = '';
    ctx.nvdbChild = spawn(
        NVDB_EXE,
        ['serve', '--dir', ctx.nvdbDir, '--host', '127.0.0.1', '--port', String(nvdbPort)],
        { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
    );
    ctx.nvdbChild.stdout.on('data', () => {});
    ctx.nvdbChild.stderr.on('data', (chunk) => { ctx.nvdbStderr += chunk.toString(); });

    ctx.client = createV2Client(`http://127.0.0.1:${nvdbPort}`);
    await waitForHealth(() => ctx.client.health(), ctx.nvdbChild, () => ctx.nvdbStderr.slice(-2000), 'nvdb');
    await ctx.client.createCollection(COLLECTION, chatCollectionConfig({ embedDims: DIMS, embedModelVersion: MODEL_VERSION }));

    ctx.sync = createNvdbSync({
        usersDb: () => ctx.usersDb,
        log: () => logSink,
        chunkOpts: CHUNK_OPTS,
        expectedDocsFromDocs,
        parseChatChunkId,
        afterSync: null
    });
}

async function teardown() {
    await stopChild(ctx.ndbChild);
    await stopChild(ctx.nvdbChild);
    if (ctx.dir) {
        try {
            fs.rmSync(ctx.dir, { recursive: true, force: true });
        } catch (err) {
            console.error(`temp dir cleanup failed (${ctx.dir}): ${err.message}`);
        }
    }
}

async function main() {
    await setup();

    // ---- 1. multi-DB mount + dynamic createDb -------------------------------

    await test('chat_users is mounted and served over HTTP', async () => {
        const health = await ctx.ndb.health();
        assert.equal(health.ok, true);
        assert.equal(health.allow_create, true);
        const names = (await ctx.ndb.listDbs()).map(d => d.name).sort();
        assert.deepEqual(names, ['chat_users']);
        const stats = await ctx.usersDb.stats();
        assert.equal(stats.documents, 0);
        assert.ok(stats.lineage.source_epoch_uuid, 'lineage carries an epoch');
    });

    await test('a brand-new user gets its own database through createDb', async () => {
        const created = await ctx.ndb.createDb('chat_alice', { format: 'ram' });
        assert.equal(created.name, 'chat_alice');
        assert.equal(created.format, 'ram');
        const names = (await ctx.ndb.listDbs()).map(d => d.name).sort();
        assert.deepEqual(names, ['chat_alice', 'chat_users']);

        await assert.rejects(
            () => ctx.ndb.createDb('chat_alice', { format: 'ram' }),
            (err) => {
                assert.equal(err instanceof NdbError, true);
                assert.equal(err.status, 409);
                assert.equal(err.code, 'already_exists');
                return true;
            }
        );

        ctx.aliceDb = ctx.ndb.db('chat_alice');
        // Idempotent indexes, exactly as the server ensures them at mount.
        await ctx.aliceDb.createIndex('_type', 'hash');
        await ctx.aliceDb.createIndex('id', 'hash');
        await ctx.aliceDb.createIndex('updatedAt', 'btree');
        const second = await ctx.aliceDb.createIndex('_type', 'hash');
        assert.equal(second.created, false, 'index creation is idempotent');
    });

    // ---- 2. conversation-store over HTTP ------------------------------------

    ctx.aliceInstance = instance(ALICE, 'alice', 'chat_alice', ctx.aliceDb);
    const ctxStore = () => ({
        user: { id: ALICE },
        dbInstance: ctx.aliceInstance,
        embedMessageAsync,
        log: logSink
    });

    await test('appendConversationMessage persists via one atomic PATCH', async () => {
        const createdAt = '2026-01-01T00:00:00Z';
        await ctx.aliceDb.insert(sessionDoc('chat_1', 'New Chat', createdAt));
        await ctx.aliceDb.insert(conversationDoc('chat_1', 'New Chat', [], createdAt));

        const first = await store.appendConversationMessage(ctxStore(), {
            conversationId: 'chat_1',
            role: 'user',
            content: 'hello world from the http client'
        });
        assert.equal(first.message.idx, 0);
        assert.equal(first.session.title, 'hello world from the http client');

        const second = await store.appendConversationMessage(ctxStore(), {
            conversationId: 'chat_1',
            role: 'assistant',
            content: 'hello back'
        });
        assert.equal(second.message.idx, 1);

        const conv = await ctx.aliceDb.get(first.conv._id);
        assert.equal(conv.messages.length, 2);
        assert.equal(conv.messageCount, 2);
        assert.equal(conv.messages[1].content, 'hello back');

        const session = await ctx.aliceDb.get(first.session._id);
        assert.equal(session.messageCount, 2);
        assert.equal(session.title, 'hello world from the http client');
    });

    await test('a PATCH batch is atomic: one bad path applies nothing', async () => {
        const session = (await ctx.aliceDb.findAll('id', 'chat_1')).find(d => d._type === 'session');
        const titleBefore = session.title;
        await assert.rejects(
            () => ctx.aliceDb.patch(session._id, [
                { op: 'set', path: 'title', value: 'MUTATED' },
                { op: 'set', path: 'no.such.path', value: 1 }
            ]),
            (err) => {
                assert.equal(err instanceof NdbError, true);
                assert.equal(err.status, 400);
                return true;
            }
        );
        const after = await ctx.aliceDb.get(session._id);
        assert.equal(after.title, titleBefore, 'the first op must not survive the failed batch');
    });

    await test('edit + delete flows keep messageCount consistent', async () => {
        const assistant = (await ctx.aliceDb.findAll('id', 'chat_1')).find(d => d._type === 'conversation').messages[1];
        await store.editAssistantMessageContent(ctxStore(), {
            conversationId: 'chat_1',
            messageId: assistant.id,
            content: 'hello back, revised'
        });
        let conv = (await ctx.aliceDb.findAll('id', 'chat_1')).find(d => d._type === 'conversation');
        assert.equal(conv.messages[1].content, 'hello back, revised');

        await store.deleteConversationMessage(ctxStore(), { conversationId: 'chat_1', messageId: assistant.id });
        conv = (await ctx.aliceDb.findAll('id', 'chat_1')).find(d => d._type === 'conversation');
        assert.equal(conv.messages.length, 1);
        assert.equal(conv.messageCount, 1);
    });

    await test('session pagination runs in Rust (filter + sort + offset + limit)', async () => {
        await ctx.aliceDb.insert(sessionDoc('chat_new', 'Newest', '2026-03-01T00:00:00Z'));
        await ctx.aliceDb.insert(sessionDoc('chat_mid', 'Middle', '2026-02-01T00:00:00Z'));

        const page1 = await ctx.aliceDb.query({
            filter: { _type: 'session' },
            sort: { field: 'updatedAt', dir: 'desc' },
            offset: 0,
            limit: 2
        });
        assert.equal(page1.total, 3);
        // chat_1 was just written by the append tests, so it is the newest.
        assert.deepEqual(page1.results.map(s => s.id), ['chat_1', 'chat_new']);

        const page2 = await ctx.aliceDb.query({
            filter: { _type: 'session' },
            sort: { field: 'updatedAt', dir: 'desc' },
            offset: 2,
            limit: 2
        });
        assert.deepEqual(page2.results.map(s => s.id), ['chat_mid']);

        const projected = await ctx.aliceDb.query({
            filter: { _type: 'session' },
            sort: { field: 'updatedAt', dir: 'desc' },
            fields: ['id', 'title']
        });
        assert.deepEqual(Object.keys(projected.results[0]).sort(), ['_id', 'id', 'title']);

        // queryAll pages the same query until `total` is reached — no silent cap.
        const all = await ctx.aliceDb.queryAll({ filter: { _type: 'session' }, pageSize: 2 });
        assert.equal(all.length, 3);
    });

    // ---- 3. attachment buckets ---------------------------------------------

    const BUCKET_FILE_RE = /^(?:[0-9a-f]{8}|[0-9a-f]{64})$/;

    await test('bucket store/get/release with a 64-hex SHA-256 ref', async () => {
        const payload = Buffer.from('modern sha-256 addressed attachment', 'utf8');
        const stored = await ctx.aliceDb.storeFile('images', payload, 'modern.png');
        assert.match(stored.hash, /^[0-9a-f]{64}$/);
        assert.equal(stored.ext, 'png');
        assert.equal(stored.size, payload.length);
        assert.equal(stored.ref, `images:${stored.hash}.png`);
        assert.equal(BUCKET_FILE_RE.test(stored.hash), true);

        const read = await ctx.aliceDb.getFile('images', `${stored.hash}.png`);
        assert.deepEqual(read.buffer, payload);
        assert.equal(read.contentType.startsWith('image/png'), true);

        const listed = await ctx.aliceDb.listFiles('images');
        assert.ok(listed.includes(`${stored.hash}.png`));
    });

    await test('legacy 8-hex refs are still readable', async () => {
        const payload = Buffer.from('legacy 8-hex addressed attachment', 'utf8');
        const legacyHash = crypto.createHash('sha256').update(payload).digest('hex').slice(0, 8);
        assert.equal(BUCKET_FILE_RE.test(legacyHash), true, 'the app-side hash guard accepts 8-hex');

        // Exactly what a v1 database left on disk: the file is NAMED by its
        // short id. Writing it directly is how a legacy bucket looks to the
        // engine, which serves whatever filename the ref names.
        const bucketDir = path.join(ctx.ndbRoot, 'chat_alice', '_files', 'images');
        fs.mkdirSync(bucketDir, { recursive: true });
        fs.writeFileSync(path.join(bucketDir, `${legacyHash}.png`), payload);

        const read = await ctx.aliceDb.getFile('images', `${legacyHash}.png`);
        assert.deepEqual(read.buffer, payload);

        // releaseFile refuses while a document references the file and succeeds
        // with force — the two branches the chat delete path depends on.
        await ctx.aliceDb.insert({
            _type: 'message',
            id: 'legacy-ref-doc',
            attachment: `images:${legacyHash}.png`
        });
        await assert.rejects(
            () => ctx.aliceDb.releaseFile('images', `${legacyHash}.png`),
            (err) => {
                assert.equal(err.status, 409);
                assert.equal(err.code, 'file_referenced');
                return true;
            }
        );
        const released = await ctx.aliceDb.releaseFile('images', `${legacyHash}.png`, { force: true });
        assert.equal(released.deleted, true);
        assert.equal(await ctx.aliceDb.getFile('images', `${legacyHash}.png`), null);
    });

    await test('an unknown bucket file is a null read, not an error', async () => {
        assert.equal(await ctx.aliceDb.getFile('images', `${'ab'.repeat(32)}.png`), null);
    });

    // ---- 4. Phase 4b: nDB -> nVDB sync --------------------------------------

    const chunkIdsFor = async (userId) => {
        const fp = await ctx.client.fingerprints(COLLECTION);
        return (fp?.entries || []).map(e => e.id).filter(id => id.startsWith(`${userId}:`)).sort();
    };

    await test('first sync rebuilds from a pinned snapshot and stores the watermark', async () => {
        const result = await ctx.sync.reconcileUserNvdb(ctx.aliceInstance);
        assert.equal(result.mode, 'rebuild');

        const wm = await ctx.sync.readWatermark('alice');
        assert.ok(wm, 'watermark persisted in chat_users');
        assert.equal(wm._type, 'nvdb_watermark');
        assert.equal(wm.key, 'nvdb_wm_alice');
        const lineage = await ctx.aliceDb.lineage();
        assert.equal(wm.source_epoch_uuid, lineage.source_epoch_uuid);
        assert.equal(wm.synced_seq, lineage.last_seq);

        const ids = await chunkIdsFor(ALICE);
        assert.ok(ids.length >= 1, `expected chunk docs, got ${ids.length}`);
        assert.ok(ids.every(id => id.includes(':chat_1:') || id.includes(':chat_new:') || id.includes(':chat_mid:')));
    });

    await test('a direct ndb write is picked up incrementally (no re-embed)', async () => {
        const before = (await ctx.sync.readWatermark('alice')).synced_seq;
        const conv = (await ctx.aliceDb.findAll('id', 'chat_1')).find(d => d._type === 'conversation');
        const messages = [...conv.messages, storedMessage('m-direct', conv.messages.length, 'user', 'cardamom direct write', '2026-01-02T00:00:00Z')];
        await ctx.aliceDb.patch(conv._id, [
            { op: 'set', path: 'messages', value: messages },
            { op: 'set', path: 'messageCount', value: messages.length }
        ]);
        const lineage = await ctx.aliceDb.lineage();
        assert.ok(lineage.last_seq > before);

        const result = await ctx.sync.reconcileUserNvdb(ctx.aliceInstance);
        assert.equal(result.mode, 'incremental');
        assert.ok(result.upserted >= 1);

        const ids = await chunkIdsFor(ALICE);
        assert.ok(ids.some(id => id.startsWith(`${ALICE}:chat_1:${messages.length - 1}#`)), 'the new message is indexed');
        assert.equal((await ctx.sync.readWatermark('alice')).synced_seq, lineage.last_seq);
    });

    await test('a no-op sync does nothing and leaves the watermark alone', async () => {
        const before = await ctx.sync.readWatermark('alice');
        const result = await ctx.sync.reconcileUserNvdb(ctx.aliceInstance);
        assert.equal(result.mode, 'noop');
        const after = await ctx.sync.readWatermark('alice');
        assert.equal(after.synced_seq, before.synced_seq);
        assert.equal(after.updatedAt, before.updatedAt);
    });

    await test('a direct ndb delete sweeps that session\u2019s chunks', async () => {
        // Give the doomed session real content first, and let the sync see it.
        const goneMessages = [storedMessage('gm0', 0, 'user', 'fenugreek doomed turn', '2026-02-02T00:00:00Z')];
        await ctx.aliceDb.insert(sessionDoc('chat_gone', 'Doomed', '2026-02-01T00:00:00Z'));
        await ctx.aliceDb.insert(conversationDoc('chat_gone', 'Doomed', goneMessages, '2026-02-01T00:00:00Z'));
        await ctx.sync.reconcileUserNvdb(ctx.aliceInstance);
        const before = await chunkIdsFor(ALICE);
        assert.ok(before.some(id => id.startsWith(`${ALICE}:chat_gone:0#`)), 'the doomed session is indexed');

        // A delete event carries no body, so the sweep must infer the orphan.
        for (const doc of await ctx.aliceDb.findAll('id', 'chat_gone')) {
            await ctx.aliceDb.delete(doc._id);
        }

        const result = await ctx.sync.reconcileUserNvdb(ctx.aliceInstance);
        assert.equal(result.mode, 'incremental');
        assert.ok(result.deleted >= 1, `expected deletions, got ${result.deleted}`);
        const ids = await chunkIdsFor(ALICE);
        assert.equal(ids.some(id => id.includes(':chat_gone:')), false);
    });

    await test('compact() expires the cursor and the sync rebuilds automatically', async () => {
        // Advance the source past the watermark, then destroy the change log.
        const conv = (await ctx.aliceDb.findAll('id', 'chat_1')).find(d => d._type === 'conversation');
        const messages = [...conv.messages, storedMessage('m-post-compact', conv.messages.length, 'assistant', 'saffron after compaction', '2026-01-03T00:00:00Z')];
        await ctx.aliceDb.patch(conv._id, [
            { op: 'set', path: 'messages', value: messages },
            { op: 'set', path: 'messageCount', value: messages.length }
        ]);
        const wmBefore = (await ctx.sync.readWatermark('alice')).synced_seq;

        const compacted = await ctx.aliceDb.compact();
        assert.ok(compacted.min_available_seq > wmBefore + 1, 'compaction moved min_available_seq past the cursor');
        assert.ok(compacted.last_seq > wmBefore);

        const result = await ctx.sync.reconcileUserNvdb(ctx.aliceInstance);
        assert.equal(result.mode, 'rebuild', 'cursor_expired must fall back to the pinned-snapshot rebuild');

        const ids = await chunkIdsFor(ALICE);
        assert.ok(ids.some(id => id.startsWith(`${ALICE}:chat_1:${messages.length - 1}#`)));
        const wmAfter = await ctx.sync.readWatermark('alice');
        const lineage = await ctx.aliceDb.lineage();
        assert.equal(wmAfter.synced_seq, lineage.last_seq);
        assert.equal(wmAfter.source_epoch_uuid, lineage.source_epoch_uuid);
    });

    await test('a watermark ahead of the source fails loudly (monotonic invariant)', async () => {
        const lineage = await ctx.aliceDb.lineage();
        await ctx.sync.writeWatermark('alice', lineage.source_epoch_uuid, lineage.last_seq + 1000);
        await assert.rejects(
            () => ctx.sync.reconcileUserNvdb(ctx.aliceInstance),
            /AHEAD of the source.*monotonic seq invariant violated/s
        );
        // Restore a sane watermark so the teardown path stays clean.
        await ctx.sync.writeWatermark('alice', lineage.source_epoch_uuid, lineage.last_seq);
    });

    await test('an epoch change forces a rebuild', async () => {
        await ctx.sync.writeWatermark('alice', '00000000-0000-0000-0000-000000000000', 1);
        const result = await ctx.sync.reconcileUserNvdb(ctx.aliceInstance);
        assert.equal(result.mode, 'rebuild');
        const lineage = await ctx.aliceDb.lineage();
        assert.equal((await ctx.sync.readWatermark('alice')).source_epoch_uuid, lineage.source_epoch_uuid);
    });

    // ---- 5. nDB v3 read/search surface (peek / searchText / schema) ---------

    await test('peek returns a field projection, a text range and an array slice', async () => {
        const body = 'abcdefghij' + 'K'.repeat(40) + 'tail';
        const inserted = await ctx.aliceDb.insert({
            _type: 'probe', id: 'probe-1', body, items: ['a', 'b', 'c', 'd', 'e']
        });
        const peeked = await ctx.aliceDb.peek(inserted.id, {
            fields: ['body', 'items'],
            textRanges: [{ path: 'body', offset: 10, limit: 5 }],
            arraySlices: [{ path: 'items', offset: 1, limit: 2 }]
        });
        assert.equal(peeked.id, inserted.id);
        assert.equal(peeked.seq, inserted.seq);
        assert.equal(peeked.doc.body, 'KKKKK', 'only the requested character range came back');
        assert.deepEqual(peeked.doc.items, ['b', 'c'], 'only the requested array slice came back');
        assert.equal(peeked.ranges.body.offset, 10);
        assert.equal(peeked.ranges.body.returned, 5);
        assert.equal(peeked.ranges.body.total, body.length);
        assert.equal(peeked.ranges.body.has_more, true);
        assert.equal(peeked.ranges.body.next_offset, 15);
        assert.equal(peeked.ranges.items.returned, 2);
    });

    await test('peek with a mismatched expected_seq is a 409 conflict', async () => {
        const doc = (await ctx.aliceDb.findAll('id', 'probe-1')).pop();
        const current = await ctx.aliceDb.peek(doc._id, { fields: ['body'] });
        await assert.rejects(
            () => ctx.aliceDb.peek(doc._id, { fields: ['body'], expectedSeq: current.seq + 1 }),
            (err) => {
                assert.equal(err instanceof NdbError, true);
                assert.equal(err.status, 409);
                return true;
            }
        );
        const pinned = await ctx.aliceDb.peek(doc._id, { fields: ['body'], expectedSeq: current.seq });
        assert.equal(pinned.seq, current.seq, 'the matching seq is accepted');
    });

    await test('searchText matches text inside messages[].content and pages by cursor', async () => {
        const page = await ctx.aliceDb.searchText({
            query: 'cardamom',
            filter: { _type: 'conversation' },
            maxScanDocs: 1000,
            limit: 200
        });
        assert.ok(page.data.length >= 1, `expected a matching conversation, got ${page.data.length}`);
        assert.ok(page.data.every(d => d._type === 'conversation'));
        const hit = page.data.find(c => (c.messages || []).some(m => String(m.content).includes('cardamom')));
        assert.ok(hit, 'the conversation holding the cardamom message is the match');
        assert.equal(typeof page.total, 'number');
        assert.equal(typeof page.scannedDocs, 'number');
        assert.equal(page.nextCursor, null);

        const narrowed = await ctx.aliceDb.searchText({
            query: 'cardamom',
            textFields: ['messages'],
            filter: { _type: 'conversation' },
            limit: 5
        });
        assert.ok(narrowed.data.length >= 1, 'text.fields narrows to the messages field without losing the hit');
        await assert.rejects(() => ctx.aliceDb.searchText({ query: '   ' }), /non-empty/);
    });

    await test('getSchema + setFieldMapping round-trip', async () => {
        const before = await ctx.aliceDb.getSchema();
        assert.ok(Array.isArray(before.field_mapping));
        const mapping = [
            ...before.field_mapping.filter(entry => entry.field !== 'title'),
            { field: 'title', text: true }
        ];
        const after = await ctx.aliceDb.setFieldMapping(mapping);
        const title = after.field_mapping.find(entry => entry.field === 'title');
        assert.ok(title, 'the mapped field is reported back');
        assert.equal(title.text, true);
        const reread = await ctx.aliceDb.getSchema();
        assert.deepEqual(
            reread.field_mapping.find(entry => entry.field === 'title'),
            title,
            'the mapping is persisted in the schema'
        );
        // A declared `text` field NARROWS unfielded text queries to it, so put
        // the schema back the way this suite found it.
        const restored = await ctx.aliceDb.setFieldMapping(before.field_mapping);
        assert.equal(restored.field_mapping.some(entry => entry.field === 'title'), false);
    });

    // ---- 6. #69: the real vector drain (createVectorDrainer) -----------------

    const drainCalls = { probes: 0 };
    function makeDrainer({ gate = null, embedBatchImpl = null } = {}) {
        return createVectorDrainer({
            buildUserExpectedDocs,
            userFingerprints: ctx.sync.userFingerprints,
            acquireEmbedSlot: async () => {},
            releaseEmbedSlot: () => {},
            embedBatch: embedBatchImpl || (async (texts) => texts.map(text => unitVector(text))),
            attachVectorsQuietly: async (instance, attachments) => {
                await ctx.client.attachVectors(COLLECTION, attachments);
                return true;
            },
            isEmbedAvailable: () => true,
            buildChatVectorInput,
            parseChatChunkId,
            embeddingDims: DIMS,
            embedModelVersion: MODEL_VERSION,
            log: () => logSink,
            onNvdbError: (instance, err, context) => { ctx.drainNvdbError = { context, message: err.message }; },
            isNvdbUnavailableError: () => false
        });
    }

    await test('drainPendingVectors attaches vectors and marks the message embedded (#69)', async () => {
        const createdAt = '2026-05-01T00:00:00Z';
        await ctx.aliceDb.insert(sessionDoc('chat_drain', 'Drain', createdAt));
        await ctx.aliceDb.insert(conversationDoc('chat_drain', 'Drain', [
            storedMessage('dm0', 0, 'user', 'juniper drain target message', createdAt)
        ], createdAt));
        // Lexical sync only (afterSync is null in this suite): docs exist, no vectors.
        await ctx.sync.reconcileUserNvdb(ctx.aliceInstance);

        const pending = await ctx.client.pendingEmbeddings(COLLECTION, 256);
        assert.ok(
            (pending.pending || []).some(item => String(item.id).startsWith(`${ALICE}:chat_drain:`)),
            'the new message starts life without a vector'
        );

        const drainer = makeDrainer();
        await drainer(ctx.aliceInstance, { mode: 'incremental' });

        const stillPending = await ctx.client.pendingEmbeddings(COLLECTION, 256);
        assert.equal(
            (stillPending.pending || []).some(item => String(item.id).startsWith(`${ALICE}:chat_drain:`)),
            false,
            'every chunk got a vector (no ReferenceError on userFingerprints)'
        );

        const conv = (await ctx.aliceDb.findAll('id', 'chat_drain')).find(d => d._type === 'conversation');
        assert.equal(conv.messages[0].embedStatus, 'embedded');
        assert.ok(conv.messages[0].embedChunks >= 1);
        assert.equal(ctx.aliceInstance.drainRunning, false, 'the guard is released');

        const fp = await ctx.client.fingerprints(COLLECTION);
        const drainEntries = (fp.entries || []).filter(e => e.id.startsWith(`${ALICE}:chat_drain:`));
        assert.ok(drainEntries.length >= 1);
        assert.ok(drainEntries.every(e => e.has_vector === true));
    });

    await test('a concurrent drain is blocked by instance.drainRunning before probing', async () => {
        const createdAt = '2026-05-02T00:00:00Z';
        await ctx.aliceDb.insert(sessionDoc('chat_gate', 'Gate', createdAt));
        await ctx.aliceDb.insert(conversationDoc('chat_gate', 'Gate', [
            storedMessage('gm0', 0, 'user', 'sorrel gated drain message', createdAt)
        ], createdAt));
        await ctx.sync.reconcileUserNvdb(ctx.aliceInstance);

        let release;
        const gate = new Promise(resolve => { release = resolve; });
        let embedStarted;
        const embedStartedPromise = new Promise(resolve => { embedStarted = resolve; });

        const slow = makeDrainer({
            embedBatchImpl: async (texts) => {
                embedStarted();
                await gate;
                return texts.map(text => unitVector(text));
            }
        });
        const first = slow(ctx.aliceInstance, { mode: 'incremental' });
        assert.equal(ctx.aliceInstance.drainRunning, true, 'the first drain owns the instance synchronously');
        await embedStartedPromise;

        let probedDuringSecond = 0;
        const counting = makeDrainer({
            embedBatchImpl: async (texts) => texts.map(text => unitVector(text))
        });
        const originalPending = ctx.client.pendingEmbeddings;
        ctx.client.pendingEmbeddings = async (...args) => {
            probedDuringSecond++;
            return originalPending.call(ctx.client, ...args);
        };
        await counting(ctx.aliceInstance, { mode: 'incremental' });
        ctx.client.pendingEmbeddings = originalPending;
        assert.equal(probedDuringSecond, 0, 'the second call returned before doing any work');

        release();
        await first;
        assert.equal(ctx.aliceInstance.drainRunning, false);
    });

    // ---- 7. nVDB outage: searchArchive falls back to nDB searchText ---------

    await test('searchArchive falls back to nDB text search while nVDB is unreachable', async () => {
        const nvdbErrors = [];
        const offlineClient = {
            hybridSearch: async () => {
                throw new Error('nvdb POST /v2/collections/chat/hybrid_search unreachable at http://127.0.0.1:1: fetch failed');
            },
            level2: async () => { throw new Error('level2 must not run when hybrid already failed'); }
        };
        const data = await searchArchive(
            { db: ctx.aliceDb, nvdbClient: offlineClient, nvdbCollection: COLLECTION, userId: ALICE },
            { query: 'cardamom', limit: 10 },
            {
                userId: ALICE,
                nvdbClient: offlineClient,
                nvdbCollection: COLLECTION,
                rerankerLoaded: false,
                embedAvailable: false,
                onNvdbError: (err) => nvdbErrors.push(err),
                log: logSink
            }
        );

        assert.equal(data.method, 'ndb-text-fallback');
        assert.equal(data.engine, 'ndb');
        assert.equal(data.degraded, true);
        assert.equal(typeof data.truncated, 'boolean');
        assert.match(data.nvdbError, /unreachable|fetch failed/);
        assert.equal(nvdbErrors.length, 1, 'the outage reaches the watchdog through onNvdbError');
        assert.ok(data.results.length >= 1);
        assert.ok(data.results.some(r => r.message.content.includes('cardamom')));
        assert.equal(typeof data.results[0].score, 'number');
        assert.ok(data.results[0].session && data.results[0].session.id);
    });

    // ---- 8. wiped nVDB: forceVerify rebuilds the affected user slice --------

    await test('a wiped nVDB slice is rebuilt by reconcileUserNvdb({ forceVerify: true })', async () => {
        const WIPE_USER = 'wipey';
        const WIPE_COLLECTION = 'chat_wipe';
        await ctx.ndb.createDb('chat_wipey', { format: 'ram' });
        const wipeDb = ctx.ndb.db('chat_wipey');
        const createdAt = '2026-06-01T00:00:00Z';
        await wipeDb.insert({ ...sessionDoc('chat_w', 'Wipe', createdAt), userId: WIPE_USER });
        await wipeDb.insert({
            _type: 'conversation', id: 'chat_w', userId: WIPE_USER, title: 'Wipe', mode: 'direct',
            model: null, isPublic: false, createdAt, updatedAt: createdAt, messageCount: 1,
            messages: [storedMessage('wm0', 0, 'user', 'quince unique wiped slice marker', createdAt)]
        });
        await ctx.client.createCollection(WIPE_COLLECTION, chatCollectionConfig({ embedDims: DIMS, embedModelVersion: MODEL_VERSION }));

        const wipeInstance = {
            userId: WIPE_USER,
            username: WIPE_USER,
            dbName: 'chat_wipey',
            db: wipeDb,
            nvdbClient: ctx.client,
            nvdbCollection: WIPE_COLLECTION,
            nvdbChunkOpts: CHUNK_OPTS,
            reconcileRunning: null
        };

        const first = await ctx.sync.reconcileUserNvdb(wipeInstance);
        assert.equal(first.mode, 'rebuild');
        const before = (await ctx.client.fingerprints(WIPE_COLLECTION)).entries || [];
        const wipeIds = before.filter(e => e.id.startsWith(`${WIPE_USER}:`)).map(e => e.id);
        assert.ok(wipeIds.length >= 1);

        // The restart-with-fresh-data shape: identical watermark, empty collection.
        await ctx.client.deleteIds(WIPE_COLLECTION, wipeIds, { commit: true });
        const wipedFp = (await ctx.client.fingerprints(WIPE_COLLECTION)).entries || [];
        assert.equal(wipedFp.filter(e => e.id.startsWith(`${WIPE_USER}:`)).length, 0);

        const noop = await ctx.sync.reconcileUserNvdb(wipeInstance);
        assert.equal(noop.mode, 'noop', 'the watermark alone cannot see a wipe — this is the bug forceVerify closes');

        const healed = await ctx.sync.reconcileUserNvdb(wipeInstance, { forceVerify: true });
        assert.equal(healed.mode, 'rebuild');

        const expected = await buildUserExpectedDocs({ userId: WIPE_USER, db: wipeDb, chunkOpts: CHUNK_OPTS });
        const integrity = await ctx.client.integrityCheck(WIPE_COLLECTION, expected.expected);
        assert.equal(integrity.clean, true, `integrity must be clean: ${JSON.stringify(integrity)}`);

        const hits = await ctx.client.hybridSearch(WIPE_COLLECTION, {
            lexical: {
                text: 'quince',
                top_k: 10,
                principals: [userPrincipal(WIPE_USER)],
                fuzzy_edits: 1,
                explain: false,
                group_by_parent: null,
                filters: {}
            },
            query_vector: null,
            dense: false,
            lexical_enabled: true,
            candidate_k: 200,
            rrf_k: 20,
            lexical_weight: 0.3,
            vector_weight: 1.0
        });
        assert.ok((hits.hits || []).some(hit => String(hit.hit?.id).startsWith(`${WIPE_USER}:`)), 'nVDB search returns the message again');
    });

    // ---- 9. 410 snapshot_expired retry --------------------------------------

    await test('rebuildFromSnapshot retries a 410 snapshot_expired, then gives up loudly', async () => {
        let snapshotCalls = 0;
        const makeInstance = (username, alwaysFail) => ({
            userId: username,
            username,
            dbName: `chat_${username}`,
            db: {
                async fullSnapshot() {
                    snapshotCalls++;
                    if (alwaysFail || snapshotCalls < 3) {
                        throw new NdbError(410, 'snapshot_expired', 'snapshot pin expired', 'GET /snapshot', {});
                    }
                    return {
                        docs: [],
                        total: 0,
                        source_epoch_uuid: 'epoch-zeta',
                        watermark_seq: 5,
                        snapshot_id: 'snap-zeta'
                    };
                },
                async lineage() {
                    return { source_epoch_uuid: 'epoch-zeta', last_seq: 5, min_available_seq: 0 };
                }
            },
            nvdbClient: {
                async fingerprints() { return { entries: [] }; },
                async upsert() {},
                async deleteIds() {},
                async commit() {}
            },
            nvdbCollection: COLLECTION,
            reconcileRunning: null
        });

        const result = await ctx.sync.reconcileUserNvdb(makeInstance('zeta_soft', false));
        assert.equal(result.mode, 'rebuild');
        assert.equal(snapshotCalls, 3, 'two retries after the first expiry');

        snapshotCalls = 0;
        await assert.rejects(
            () => ctx.sync.reconcileUserNvdb(makeInstance('zeta_hard', true)),
            (err) => {
                assert.equal(err.code, 'snapshot_expired');
                return true;
            }
        );
        assert.equal(snapshotCalls, 3, 'the third expiry is thrown, not retried forever');
    });

    console.log(`\n${passed} passed, ${failures.length} failed`);
}

try {
    await main();
} catch (err) {
    failures.push({ name: 'setup', err });
    console.error(`FATAL ${err.message}\n${err.stack}`);
} finally {
    await teardown();
}

if (failures.length > 0) {
    for (const f of failures) console.error(`\n--- ${f.name}\n${f.err.stack}`);
    process.exit(1);
}
