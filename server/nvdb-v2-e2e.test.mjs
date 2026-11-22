// Real nVDB v2 end-to-end: a throwaway `nvdb serve` process, a throwaway nDB.
//   node server/nvdb-v2-e2e.test.mjs
//
// Nothing here touches live data: the server binds an ephemeral loopback port
// and writes into a fresh `mkdtemp` directory that is removed afterwards. The
// only shared resource is the binary, which is read and executed.
//
// What it proves, against the real Tantivy + vector engine:
//   - the collection contract the chat writer produces is accepted as-is
//   - pending embeddings / attach / integrity round-trip is clean
//   - ACL principals keep one user's hits out of another user's results
//   - promoted role/mode filters and created_at ranges work natively
//   - conversation-store mutations keep the index consistent (no orphan text)
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';

const require = createRequire(import.meta.url);
const { Database: nDB } = require('../lib/ndb/napi');
const { createV2Client, NvdbHttpError } = require('./nvdb-v2-client');
const {
    chatCollectionConfig,
    buildUserExpectedDocs,
    buildMessageV2Docs
} = require('./nvdb-chat');
const { isEmbeddableMessage } = require('./embed');
const { documentHashes } = require('./nvdb-v2-hash');
const { searchArchive } = require('./internal-tools');
const store = require('./conversation-store');

const NVDB_EXE = process.env.NVDB_EXE || 'D:\\DEV\\nVDB\\target\\release\\nvdb.exe';
const COLLECTION = 'chat';
const DIMS = 8;
const MODEL_VERSION = 'test-v1';
const CHUNK_OPTS = { chunkTokens: 64, overlapTokens: 8, tokRatio: 2.5 };
const SLEEP_MS = 100;
const HEALTH_TIMEOUT_MS = 10_000;

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

/** Deterministic unit vector, distinct per seed — real cosine math, fake model. */
function unitVector(seed) {
    const raw = [];
    for (let i = 0; i < DIMS; i++) {
        raw.push(((hash32(`${seed}:${i}`) % 2001) / 1000) - 1);
    }
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

async function waitForHealth(client, child, stderrTail) {
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    let lastError = null;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) {
            throw new Error(`nvdb serve exited early (code ${child.exitCode}): ${stderrTail()}`);
        }
        try {
            const health = await client.health();
            if (health?.ok === true) return health;
            lastError = new Error(`health not ok: ${JSON.stringify(health)}`);
        } catch (err) {
            lastError = err;
        }
        await sleep(SLEEP_MS);
    }
    throw new Error(`nvdb serve did not become healthy within ${HEALTH_TIMEOUT_MS}ms: ${lastError?.message}\n${stderrTail()}`);
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

function storedMessage(id, idx, role, content, createdAt) {
    return {
        id,
        idx,
        role,
        speaker: null,
        model: role === 'assistant' ? 'test-model' : null,
        content,
        rawContent: content,
        attachments: [],
        createdAt,
        embedStatus: 'pending',
        embedAttempts: 0,
        embedError: null
    };
}

function sessionDoc(id, title, mode, createdAt) {
    return { _type: 'session', id, title, mode, createdAt, updatedAt: createdAt, messageCount: 0 };
}

function conversationDoc(session, userId, messages) {
    return {
        _type: 'conversation',
        id: session.id,
        userId,
        title: session.title,
        mode: session.mode,
        model: session.model || null,
        isPublic: false,
        createdAt: session.createdAt,
        updatedAt: session.createdAt,
        messageCount: messages.length,
        messages
    };
}

const ALICE = 'alice';
const BOB = 'bob';
const SHARED_WORD = 'zanzibar';
const BOB_ONLY_WORD = 'bobuniqueword';
const SYSTEM_ONLY_WORD = 'protocolquirk';

const LONG_ALICE_TEXT = Array.from(
    { length: 12 },
    (_, i) => `alice longform marker paragraph ${i} about memory consolidation and archival retrieval seams.`
).join(' ');

const aliceDirect = sessionDoc('chat-a', 'Alice Direct', 'direct', '2026-01-01T00:00:00Z');
const aliceArena = sessionDoc('arena-a', 'Alice Arena', 'arena', '2026-02-01T00:00:00Z');
const aliceDirectMessages = [
    storedMessage('am0', 0, 'user', `alice user turn shared phrase ${SHARED_WORD} appears here`, '2026-01-02T00:00:00Z'),
    storedMessage('am1', 1, 'assistant', `alice assistant turn shared phrase ${SHARED_WORD} answered`, '2026-01-03T00:00:00Z'),
    storedMessage('am2', 2, 'system', `alice system directive ${SHARED_WORD} ${SYSTEM_ONLY_WORD}`, '2026-01-04T00:00:00Z'),
    storedMessage('am3', 3, 'tool', `alice tool payload ${SHARED_WORD} json blob`, '2026-01-05T00:00:00Z'),
    storedMessage('am4', 4, 'assistant', '', '2026-01-06T00:00:00Z'),
    storedMessage('am5', 5, 'user', `${LONG_ALICE_TEXT}`, '2026-01-07T00:00:00Z')
];
const aliceArenaMessages = [
    storedMessage('rm0', 0, 'user', `alice arena turn ${SHARED_WORD} debate`, '2026-02-02T00:00:00Z'),
    storedMessage('rm1', 1, 'assistant', `alice arena reply ${SHARED_WORD} debate`, '2026-02-03T00:00:00Z')
];

const bobDirect = sessionDoc('chat-b', 'Bob Direct', 'direct', '2026-01-01T00:00:00Z');
const bobMessages = [
    storedMessage('bm0', 0, 'user', `bob user turn shared phrase ${SHARED_WORD} plus ${BOB_ONLY_WORD}`, '2026-01-02T00:00:00Z'),
    storedMessage('bm1', 1, 'assistant', `bob assistant reply ${BOB_ONLY_WORD}`, '2026-01-03T00:00:00Z')
];

function sortedIds(data) {
    const results = Array.isArray(data) ? data : data.results;
    return results.map(r => r.message.id).sort();
}

function instance(userId, db) {
    return {
        dbPath: db.path,
        userId,
        db,
        nvdbClient: ctx.client,
        nvdbCollection: COLLECTION,
        nvdbChunkOpts: CHUNK_OPTS
    };
}

/** The embed loop as the live server runs it, minus the gateway: same docs, same CAS. */
async function embedMessageAsync(dbInstance, msg, session, convNdbId, msgIdx) {
    if (!isEmbeddableMessage(msg)) return;
    const docs = buildMessageV2Docs({ userId: dbInstance.userId, session, msg, msgIdx, chunkOpts: CHUNK_OPTS });
    if (docs.length === 0) return;
    await ctx.client.upsert(COLLECTION, docs, { commit: true });
    const attachments = docs.map(doc => ({
        id: doc.id,
        content_hash: documentHashes(doc).content_hash,
        model_version: MODEL_VERSION,
        vector: unitVector(doc.id)
    }));
    await ctx.client.attachVectors(COLLECTION, attachments);
}

async function searchAs(userId, db, body) {
    return searchArchive(instance(userId, db), body, {
        userId,
        nvdbCollection: COLLECTION,
        nvdbClient: ctx.client,
        rerankerLoaded: false,
        embedAvailable: true,
        embedBatch: async (texts) => texts.map(text => unitVector(text))
    });
}

const ctx = {};

async function setup() {
    if (!fs.existsSync(NVDB_EXE)) {
        throw new Error(`nVDB binary not found: ${NVDB_EXE} (build it with cargo build --release in D:\\DEV\\nVDB)`);
    }
    ctx.port = await freePort();
    ctx.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-nvdb-v2-e2e-'));
    ctx.nvdbDir = path.join(ctx.dir, 'nvdb-data');
    ctx.ndbDir = path.join(ctx.dir, 'ndb-data');
    fs.mkdirSync(ctx.nvdbDir, { recursive: true });
    fs.mkdirSync(ctx.ndbDir, { recursive: true });

    ctx.stderr = '';
    ctx.child = spawn(
        NVDB_EXE,
        ['serve', '--dir', ctx.nvdbDir, '--host', '127.0.0.1', '--port', String(ctx.port)],
        { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
    );
    ctx.child.stdout.on('data', () => {});
    ctx.child.stderr.on('data', (chunk) => { ctx.stderr += chunk.toString(); });

    ctx.client = createV2Client(`http://127.0.0.1:${ctx.port}`);
    await waitForHealth(ctx.client, ctx.child, () => ctx.stderr.slice(-2000));

    ctx.aliceDb = nDB.open(path.join(ctx.ndbDir, 'alice.jsonl'));
    ctx.aliceDb.path = path.join(ctx.ndbDir, 'alice.jsonl');
    ctx.bobDb = nDB.open(path.join(ctx.ndbDir, 'bob.jsonl'));
    ctx.bobDb.path = path.join(ctx.ndbDir, 'bob.jsonl');

    ctx.aliceDb.insert(aliceDirect);
    ctx.aliceDb.insert(conversationDoc(aliceDirect, ALICE, aliceDirectMessages));
    ctx.aliceDb.insert(aliceArena);
    ctx.aliceDb.insert(conversationDoc(aliceArena, ALICE, aliceArenaMessages));
    ctx.bobDb.insert(bobDirect);
    ctx.bobDb.insert(conversationDoc(bobDirect, BOB, bobMessages));

    ctx.aliceInstance = instance(ALICE, ctx.aliceDb);
}

async function teardown() {
    await stopChild(ctx.child);
    for (const db of [ctx.aliceDb, ctx.bobDb]) {
        try {
            db?.close();
        } catch (err) {
            console.error(`nDB close failed: ${err.message}`);
        }
    }
    if (ctx.dir) {
        try {
            fs.rmSync(ctx.dir, { recursive: true, force: true });
        } catch (err) {
            console.error(`temp dir cleanup failed (${ctx.dir}): ${err.message}`);
        }
    }
}

function expectedBoth() {
    const alice = buildUserExpectedDocs({ userId: ALICE, db: ctx.aliceDb, chunkOpts: CHUNK_OPTS });
    const bob = buildUserExpectedDocs({ userId: BOB, db: ctx.bobDb, chunkOpts: CHUNK_OPTS });
    return { alice, bob, all: [...alice.expected, ...bob.expected] };
}

async function main() {
    await setup();

    // ---- collection + index -------------------------------------------------

    await test('createCollection accepts the chat collection contract', async () => {
        const result = await ctx.client.createCollection(COLLECTION, chatCollectionConfig({
            embedDims: DIMS,
            embedModelVersion: MODEL_VERSION
        }));
        assert.equal(result.ok, true);
        assert.equal(result.collection.name, COLLECTION);
        const names = (await ctx.client.listCollections()).collections.map(c => c.name);
        assert.deepEqual(names, [COLLECTION]);
    });

    ctx.aliceExpected = buildUserExpectedDocs({ userId: ALICE, db: ctx.aliceDb, chunkOpts: CHUNK_OPTS });
    ctx.bobExpected = buildUserExpectedDocs({ userId: BOB, db: ctx.bobDb, chunkOpts: CHUNK_OPTS });

    await test('buildUserExpectedDocs covers both users with per-chunk ids', async () => {
        const aliceIds = ctx.aliceExpected.docs.map(d => d.id);
        assert.ok(aliceIds.every(id => id.startsWith('alice:')), 'every alice chunk id is namespaced by principal');
        assert.ok(aliceIds.includes('alice:chat-a:0#0'));
        assert.ok(aliceIds.includes('alice:arena-a:0#0'));
        assert.ok(ctx.aliceExpected.docs.some(d => d.id.startsWith('alice:chat-a:5#')) === true);
        const longChunks = ctx.aliceExpected.docs.filter(d => d.id.startsWith('alice:chat-a:5#'));
        assert.ok(longChunks.length > 1, `the long message must split into several chunks (got ${longChunks.length})`);
        assert.equal(ctx.aliceExpected.docs.some(d => d.id.startsWith('alice:chat-a:3#')), false, 'tool messages are never indexed');
        assert.equal(ctx.aliceExpected.docs.some(d => d.id.startsWith('alice:chat-a:4#')), false, 'empty messages are never indexed');
        assert.ok(ctx.bobExpected.docs.every(d => d.id.startsWith('bob:')));
    });

    await test('batch upsert + commit tracks every expected chunk', async () => {
        const docs = [...ctx.aliceExpected.docs, ...ctx.bobExpected.docs];
        const result = await ctx.client.upsert(COLLECTION, docs, { commit: true });
        assert.equal(result.upserted, docs.length);
        const fingerprints = await ctx.client.fingerprints(COLLECTION, { timeoutMs: 30_000 });
        assert.equal(fingerprints.doc_count, docs.length);
    });

    await test('pendingEmbeddings lists every chunk, attachVectors empties the queue', async () => {
        const pending = await ctx.client.pendingEmbeddings(COLLECTION, 256);
        assert.equal(pending.count, ctx.aliceExpected.docs.length + ctx.bobExpected.docs.length);
        assert.deepEqual(
            pending.pending.map(p => p.id).sort(),
            [...ctx.aliceExpected.docs, ...ctx.bobExpected.docs].map(d => d.id).sort()
        );

        const attachments = pending.pending.map(item => ({
            id: item.id,
            content_hash: item.content_hash,
            model_version: MODEL_VERSION,
            vector: unitVector(item.id)
        }));
        const attached = await ctx.client.attachVectors(COLLECTION, attachments);
        assert.equal(attached.attached > 0, true);
        assert.equal(attached.vec_generation > 0, true);

        const after = await ctx.client.pendingEmbeddings(COLLECTION, 256);
        assert.equal(after.count, 0);
        assert.deepEqual(after.pending, []);
    });

    await test('integrityCheck(check_vectors) is clean for every user', async () => {
        const diff = await ctx.client.integrityCheck(COLLECTION, expectedBoth().all, { checkVectors: true });
        assert.equal(diff.clean, true, JSON.stringify(diff));
        assert.deepEqual(diff.missing, []);
        assert.deepEqual(diff.extra, []);
        assert.deepEqual(diff.content_mismatched, []);
        assert.deepEqual(diff.envelope_mismatched, []);
        assert.deepEqual(diff.missing_vectors, []);
    });

    // ---- ACL isolation ------------------------------------------------------

    await test('alice sees only her own hits for the shared phrase (keyword)', async () => {
        const data = await searchAs(ALICE, ctx.aliceDb, {
            query: SHARED_WORD,
            search_type: 'keyword',
            limit: 50,
            search: { diversity: false }
        });
        const sessions = new Set(data.results.map(r => r.session.id));
        assert.equal(sessions.has('chat-b'), false, 'never bob');
        assert.equal(data.results.some(r => r.message.id.startsWith('bm')), false);
        assert.ok(data.results.length >= 2);
        assert.equal(sortedIds(data).includes('am0'), true);
    });

    await test('alice sees only her own hits for the shared phrase (hybrid)', async () => {
        const data = await searchAs(ALICE, ctx.aliceDb, { query: SHARED_WORD, limit: 50 });
        assert.ok(data.results.length > 0);
        assert.equal(data.results.some(r => r.session.id === 'chat-b'), false);
    });

    await test("alice gets zero lexical hits for bob's unique phrase", async () => {
        const keyword = await searchAs(ALICE, ctx.aliceDb, {
            query: BOB_ONLY_WORD, search_type: 'keyword', limit: 50
        });
        assert.deepEqual(keyword.results, [], 'the lexical lane must not see bob’s text');

        // The dense lane always answers with *some* of alice's own vectors, so
        // the invariant there is different: never a bob document.
        for (const search_type of ['hybrid', 'semantic']) {
            const data = await searchAs(ALICE, ctx.aliceDb, { query: BOB_ONLY_WORD, search_type, limit: 50 });
            assert.equal(data.results.some(r => r.session.id === 'chat-b'), false, `${search_type} leaked bob's text`);
        }
        const bobData = await searchAs(BOB, ctx.bobDb, { query: BOB_ONLY_WORD, search_type: 'keyword', limit: 50 });
        assert.deepEqual(sortedIds(bobData), ['bm0', 'bm1'], 'bob can still read his own text');
    });

    await test('hybridSearch without principals fails closed with 400 missing_principals', async () => {
        await assert.rejects(
            ctx.client.hybridSearch(COLLECTION, { lexical: { text: 'test', principals: [] } }),
            (err) => {
                assert.equal(err instanceof NvdbHttpError, true);
                assert.equal(err.status, 400);
                assert.equal(err.code, 'missing_principals');
                return true;
            }
        );
    });

    // ---- native promoted filters + date range ------------------------------

    await test("mode: 'arena' returns only the arena session", async () => {
        const data = await searchAs(ALICE, ctx.aliceDb, {
            query: SHARED_WORD, mode: 'arena', search_type: 'keyword', limit: 50, search: { diversity: false }
        });
        assert.deepEqual(sortedIds(data), ['rm0', 'rm1']);
        assert.ok(data.results.every(r => r.session.mode === 'arena'));
    });

    await test("role: 'user' returns only user messages", async () => {
        const data = await searchAs(ALICE, ctx.aliceDb, {
            query: SHARED_WORD, role: 'user', search_type: 'keyword', limit: 50, search: { diversity: false }
        });
        assert.deepEqual(sortedIds(data), ['am0', 'rm0']);
        assert.ok(data.results.every(r => r.message.role === 'user'));
    });

    await test('date_from / date_to filter strictly by message created_at', async () => {
        const data = await searchAs(ALICE, ctx.aliceDb, {
            query: SHARED_WORD,
            search_type: 'keyword',
            date_from: '2026-01-03T00:00:00Z',
            date_to: '2026-01-05T00:00:00Z',
            limit: 50,
            search: { diversity: false }
        });
        assert.deepEqual(sortedIds(data), ['am1']);
        const created = Date.parse(data.results[0].message.createdAt) / 1000;
        assert.ok(created >= 1767398400 && created <= 1767571200);
    });

    await test("date_from alone excludes older turns", async () => {
        const data = await searchAs(ALICE, ctx.aliceDb, {
            query: SHARED_WORD, search_type: 'keyword', date_from: '2026-02-01T00:00:00Z', limit: 50,
            search: { diversity: false }
        });
        assert.deepEqual(sortedIds(data), ['rm0', 'rm1']);
    });

    // ---- search types against the real engine ------------------------------

    await test("search_type hybrid / semantic / keyword all hit the real engine", async () => {
        const hybrid = await searchAs(ALICE, ctx.aliceDb, { query: SHARED_WORD, limit: 20 });
        assert.equal(hybrid.method, 'hybrid');
        assert.ok(hybrid.results.length > 0);
        assert.equal(hybrid.results.some(r => r.session.id === 'chat-b'), false);

        const semantic = await searchAs(ALICE, ctx.aliceDb, { query: SHARED_WORD, search_type: 'semantic', limit: 20 });
        assert.equal(semantic.method, 'semantic');
        assert.ok(semantic.results.length > 0);
        assert.equal(semantic.results.some(r => r.session.id === 'chat-b'), false);

        const keyword = await searchAs(ALICE, ctx.aliceDb, {
            query: SHARED_WORD, search_type: 'keyword', limit: 50, search: { diversity: false }
        });
        assert.equal(keyword.method, 'keyword');
        assert.deepEqual(sortedIds(keyword), ['am0', 'am1', 'rm0', 'rm1']);
    });

    await test('default search excludes system and tool messages (#64)', async () => {
        const hidden = await searchAs(ALICE, ctx.aliceDb, {
            query: SYSTEM_ONLY_WORD, search_type: 'keyword', limit: 20
        });
        assert.deepEqual(hidden.results, []);

        const explicit = await searchAs(ALICE, ctx.aliceDb, {
            query: SYSTEM_ONLY_WORD, role: 'system', search_type: 'keyword', limit: 20
        });
        assert.deepEqual(sortedIds(explicit), ['am2']);
        assert.equal(explicit.results[0].message.role, 'system');
    });

    // ---- conversation-store mutations against the live index ---------------

    const ctxStore = () => ({
        user: { id: ALICE },
        dbInstance: ctx.aliceInstance,
        embedMessageAsync,
        log: {
            info() {},
            debug() {},
            warn: (...args) => console.log(`     [warn] ${args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`),
            error: (...args) => console.log(`     [error] ${args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`)
        }
    });

    await test('appendConversationMessage indexes the new text immediately', async () => {
        const appended = await store.appendConversationMessage(ctxStore(), {
            conversationId: 'chat-a',
            role: 'user',
            content: 'append marker grenadine first turn'
        });
        ctx.grenadineId = appended.message.id;
        const data = await searchAs(ALICE, ctx.aliceDb, { query: 'grenadine', search_type: 'keyword', limit: 20 });
        assert.deepEqual(sortedIds(data), [appended.message.id]);
    });

    await test('editAssistantMessageContent drops the old text and indexes the new one', async () => {
        const appended = await store.appendConversationMessage(ctxStore(), {
            conversationId: 'chat-a',
            role: 'assistant',
            content: 'assistant marjoram prior answer'
        });
        ctx.marjoramId = appended.message.id;
        const before = await searchAs(ALICE, ctx.aliceDb, { query: 'marjoram', search_type: 'keyword', limit: 20 });
        assert.deepEqual(sortedIds(before), [appended.message.id]);

        await store.editAssistantMessageContent(ctxStore(), {
            conversationId: 'chat-a',
            messageId: appended.message.id,
            content: 'assistant saffron revised answer'
        });

        const stale = await searchAs(ALICE, ctx.aliceDb, { query: 'marjoram', search_type: 'keyword', limit: 20 });
        assert.deepEqual(stale.results, []);
        const fresh = await searchAs(ALICE, ctx.aliceDb, { query: 'saffron', search_type: 'keyword', limit: 20 });
        assert.deepEqual(sortedIds(fresh), [appended.message.id]);
    });

    await test('deleteConversationMessage removes the text from the index', async () => {
        const removed = await store.deleteConversationMessage(ctxStore(), {
            conversationId: 'chat-a',
            messageId: ctx.grenadineId
        });
        assert.equal(removed.removed.id, ctx.grenadineId);
        const data = await searchAs(ALICE, ctx.aliceDb, { query: 'grenadine', search_type: 'keyword', limit: 20 });
        assert.deepEqual(data.results, []);
    });

    await test('insertConversationMessageAt re-keys the shifted tail in the index', async () => {
        const inserted = await store.insertConversationMessageAt(ctxStore(), {
            conversationId: 'chat-a',
            atIdx: 1,
            message: { role: 'user', content: 'inserted cardamom turn' }
        });
        ctx.insertedId = inserted.message.id;
        assert.equal(inserted.message.idx, 1);

        const insertedHit = await searchAs(ALICE, ctx.aliceDb, { query: 'cardamom', search_type: 'keyword', limit: 20 });
        assert.deepEqual(sortedIds(insertedHit), [inserted.message.id]);

        // The tail moved by one index; its chunk ids were re-keyed, not lost.
        const tailHit = await searchAs(ALICE, ctx.aliceDb, { query: 'saffron', search_type: 'keyword', limit: 20 });
        assert.deepEqual(sortedIds(tailHit), [ctx.marjoramId]);
    });

    await test('editUserMessageAndTruncate retires the removed tail from the index', async () => {
        const trimmed = await store.editUserMessageAndTruncate(ctxStore(), {
            conversationId: 'chat-a',
            messageId: ctx.insertedId,
            content: 'rewritten cumin opening turn'
        });
        assert.equal(trimmed.removedCount > 0, true, 'the tail was truncated');

        const cumin = await searchAs(ALICE, ctx.aliceDb, { query: 'cumin', search_type: 'keyword', limit: 20 });
        assert.equal(cumin.results.length, 1);
        assert.equal(cumin.results[0].message.content.startsWith('rewritten cumin'), true);

        const cardamom = await searchAs(ALICE, ctx.aliceDb, { query: 'cardamom', search_type: 'keyword', limit: 20 });
        assert.deepEqual(cardamom.results, [], 'the truncated turn no longer matches');
        const saffron = await searchAs(ALICE, ctx.aliceDb, { query: 'saffron', search_type: 'keyword', limit: 20 });
        assert.deepEqual(saffron.results, [], 'the truncated assistant turn no longer matches');
    });

    await test('integrityCheck is still clean after every mutation', async () => {
        const diff = await ctx.client.integrityCheck(COLLECTION, expectedBoth().all, { checkVectors: true });
        assert.equal(diff.clean, true, JSON.stringify(diff));
        const pending = await ctx.client.pendingEmbeddings(COLLECTION, 256);
        assert.equal(pending.count, 0);

        const survivors = await searchAs(ALICE, ctx.aliceDb, {
            query: SHARED_WORD, search_type: 'keyword', limit: 50, search: { diversity: false }
        });
        assert.ok(survivors.results.length > 0, 'untouched history still matches');
        assert.equal(survivors.results.some(r => r.session.id === 'chat-b'), false);
    });

    // ---- done ---------------------------------------------------------------

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
