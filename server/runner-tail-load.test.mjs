// ============================================
// runner-tail-load.test.mjs — Track 2a: a long conversation is attached as a
// TAIL WINDOW, not as the whole document.
//   node server/runner-tail-load.test.mjs
//
// Against a real `ndb serve` (ram DB), so the peek contract is the engine's:
//   - cold attach never calls `db.get` (a 500-message document whole) — only
//     `peek`;
//   - the tail window snaps back across a 30-message tool chain to a turn
//     boundary, and keeps absolute indexes;
//   - backward paging reconstructs the exact stored history with no gap and no
//     duplicate;
//   - ensureFull() loads everything for a run, while a warm snapshot STILL
//     returns only the tail for fast re-switch.
// ============================================
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createNdbClient } = require('./ndb-client');
const mcpPool = require('./mcp-pool');
const runner = require('./runner');
const store = require('./conversation-store');

const NDB_EXE = process.env.NDB_EXE || 'D:\\DEV\\nDB\\target\\release\\ndb.exe';
const MODEL = 'tail-load-test-model';
const WINDOW = 200000;
const USER_ID = 'user_tail';
const CHAT_ID = 'chat_tail';
const DB_NAME = 'chat_tail_user';
const TOTAL = 500;
const TOOL_CHAIN_START = 450;
const TOOL_CHAIN_LEN = 30;

mcpPool.getForUser = async () => ({
    getFormattedTools: async () => [],
    getStorageOrigin: () => null,
    hasToolPrefix: () => false,
    registry: new Map()
});

function startModelServer() {
    const server = http.createServer((req, res) => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ data: [{ id: MODEL, capabilities: { contextWindow: WINDOW, vision: false } }] }));
    });
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function freePort() {
    return new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.once('error', reject);
        probe.listen(0, '127.0.0.1', () => {
            const { port } = probe.address();
            probe.close(() => resolve(port));
        });
    });
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function waitForHealth(check, child, stderrTail) {
    const deadline = Date.now() + 15_000;
    let lastError = null;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`ndb serve exited (code ${child.exitCode}): ${stderrTail()}`);
        try {
            const health = await check();
            if (health?.ok === true) return health;
            lastError = new Error(`health not ok: ${JSON.stringify(health)}`);
        } catch (err) {
            lastError = err;
        }
        await sleep(100);
    }
    throw new Error(`ndb serve never became healthy: ${lastError?.message}\n${stderrTail()}`);
}

async function stopChild(child) {
    if (!child || child.exitCode !== null) return;
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill();
    const timer = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 5000);
    await exited;
    clearTimeout(timer);
}

async function startNdb() {
    if (!fs.existsSync(NDB_EXE)) throw new Error(`nDB binary not found: ${NDB_EXE} (cargo build --release in its repo)`);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-tail-load-'));
    const root = path.join(dir, 'dbs');
    fs.mkdirSync(root, { recursive: true });
    const port = await freePort();
    let stderr = '';
    const child = spawn(
        NDB_EXE,
        ['serve', '--dir', root, '--db', `chat_users=${path.join(dir, 'chat_users')}`, '--bind', '127.0.0.1', '--port', String(port)],
        { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
    );
    child.stdout.on('data', () => {});
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    const client = createNdbClient(`http://127.0.0.1:${port}`);
    await waitForHealth(() => client.health(), child, () => stderr.slice(-2000));
    return { dir, child, client };
}

// Call ledger over the real handle: the invariant is "peek, never get".
function countingDb(db) {
    const calls = { get: 0, peek: 0, query: 0, findAll: 0 };
    const proxy = new Proxy(db, {
        get(target, prop) {
            if (typeof prop === 'string' && Object.prototype.hasOwnProperty.call(calls, prop)) calls[prop] += 1;
            const value = target[prop];
            return typeof value === 'function' ? value.bind(target) : value;
        }
    });
    return { db: proxy, calls };
}

function storedMessage(i) {
    const createdAt = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
    if (i >= TOOL_CHAIN_START && i < TOOL_CHAIN_START + TOOL_CHAIN_LEN) {
        return {
            idx: i, id: `m${i}`, role: 'tool', toolName: 'browser_fetch', toolArgs: { url: `https://example.com/${i}` },
            toolStatus: 'success', content: `tool result ${i}`, rawContent: `tool result ${i}`,
            attachments: [], createdAt, embedStatus: 'skipped', embedAttempts: 0, embedError: null
        };
    }
    const role = i % 2 === 0 ? 'user' : 'assistant';
    const msg = {
        idx: i, id: `m${i}`, role, speaker: null, model: role === 'assistant' ? MODEL : null,
        content: `message ${i}`, rawContent: `message ${i}`, attachments: [], createdAt,
        embedStatus: 'skipped', embedAttempts: 0, embedError: null
    };
    if (role === 'assistant') msg.usage = { total_tokens: 5 };
    return msg;
}

const PERSISTED_CONTEXT = {
    window_size: WINDOW,
    used_tokens: 3210,
    raw_tokens: 4000,
    available_tokens: WINDOW - 3210,
    strategy_applied: false,
    counted: 'runner'
};

// `totalHint` comes from the session's messageCount and can OVERESTIMATE (a
// stale count, a session doc updated after messages were trimmed). At the
// boundary the first peek lands exactly at the end (`offset === total`) or past
// it (`offset > total`) and returns an empty slice — the tail must still load.
test('loadConversationTail recovers the real tail from an overestimated totalHint', async () => {
    const { dir, child, client } = await startNdb();
    const TOTAL_SHORT = 100;
    const tailSize = store.TAIL_PAGE_SIZE;
    try {
        await client.createDb(DB_NAME, { format: 'ram' });
        const raw = client.db(DB_NAME);

        const messages = [];
        for (let i = 0; i < TOTAL_SHORT; i++) messages.push(storedMessage(i));
        const createdAt = '2026-01-01T00:00:00.000Z';
        const created = await raw.insert({
            _type: 'conversation', id: CHAT_ID, userId: USER_ID, title: 'short', mode: 'direct', model: null,
            isPublic: false, createdAt, updatedAt: createdAt, messageCount: TOTAL_SHORT, messages
        });
        const convId = created.id;

        // offset === total: hint - tailSize lands exactly on the stored length.
        // offset > total: the hint overshoots far past it.
        for (const totalHint of [TOTAL_SHORT + tailSize, 500, 600]) {
            const tail = await store.loadConversationTail(raw, convId, { tailSize, totalHint });
            assert.equal(tail.totalMessages, TOTAL_SHORT, `hint ${totalHint}: the real length is reported`);
            assert.ok(tail.conv.messages.length >= tailSize, `hint ${totalHint}: got the tail (${tail.conv.messages.length} messages)`);
            assert.ok(tail.baseIdx < TOTAL_SHORT, `hint ${totalHint}: baseIdx is inside the history (${tail.baseIdx})`);
            assert.equal(tail.conv.messages[0].role, 'user', `hint ${totalHint}: opens on a turn boundary`);
            assert.equal(tail.conv.messages[tail.conv.messages.length - 1].id, `m${TOTAL_SHORT - 1}`, `hint ${totalHint}: ends at the newest message`);
            assert.equal(tail.fullLoaded, false, `hint ${totalHint}: still windowed, not the whole history`);
        }
    } finally {
        await stopChild(child);
        try {
            fs.rmSync(dir, { recursive: true, force: true });
        } catch (err) {
            console.error(`temp dir cleanup failed (${dir}): ${err.message}`);
        }
    }
});

test('a 500-message conversation attaches as a tail window, pages back losslessly, and fully loads on demand', async () => {
    const { dir, child, client } = await startNdb();
    const modelServer = await startModelServer();
    runner.init({
        gatewayUrl: `http://127.0.0.1:${modelServer.address().port}`,
        gatewayKey: null,
        publicOrigin: 'http://localhost:8080',
        embedMessageAsync: async () => {},
        log: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
        getInstructions: async () => '',
        idleMs: 60_000
    });

    let instance = null;
    try {
        await client.createDb(DB_NAME, { format: 'ram' });
        const raw = client.db(DB_NAME);
        const { db, calls } = countingDb(raw);

        const messages = [];
        for (let i = 0; i < TOTAL; i++) messages.push(storedMessage(i));
        // The final assistant turn persisted the context figure — the pill must
        // be painted from it, with no tiktoken pass (the tail is all it needs).
        messages[TOTAL - 1].context = PERSISTED_CONTEXT;

        const createdAt = '2026-01-01T00:00:00.000Z';
        await raw.insert({
            _type: 'session', id: CHAT_ID, userId: USER_ID, title: 'tail', model: MODEL, mode: 'direct',
            createdAt, updatedAt: createdAt, messageCount: TOTAL
        });
        await raw.insert({
            _type: 'conversation', id: CHAT_ID, userId: USER_ID, title: 'tail', mode: 'direct', model: null,
            isPublic: false, createdAt, updatedAt: createdAt, messageCount: TOTAL, messages
        });

        instance = await runner.getRunner({ id: USER_ID }, { db }, CHAT_ID);

        assert.equal(calls.get, 0, 'cold attach never fetches the whole conversation (db.get)');
        assert.ok(calls.peek > 0, 'the tail came from peek');
        assert.equal(instance._fullLoaded, false, 'only the tail is loaded');

        const snap = await instance.buildSnapshot();
        assert.equal(snap.totalMessages, TOTAL);
        assert.equal(snap.hasMore, true);
        assert.ok(snap.baseIdx > 0 && snap.baseIdx < TOTAL, `baseIdx must be inside the history (got ${snap.baseIdx})`);
        // 450 is the first tool of the 30-message chain → the window had to snap
        // back past the whole chain to find a user turn.
        assert.equal(snap.messages[0].role, 'user', 'the window opens on a turn boundary');
        assert.equal(snap.messages[0].idx, snap.baseIdx);
        assert.ok(snap.baseIdx < TOOL_CHAIN_START, 'the 30-message tool chain was crossed, not cut');
        assert.equal(snap.messages[snap.messages.length - 1].idx, TOTAL - 1);
        assert.deepEqual(snap.lastRun.context, PERSISTED_CONTEXT, 'pill reused the persisted context — no tiktoken pass');
        assert.equal(snap.convSeq !== undefined, true);

        // ---- backward paging: every page a turn boundary, no gaps, no dupes
        const pages = [];
        let before = snap.baseIdx;
        while (before > 0) {
            const page = await store.loadConversationPage(raw, instance.conv._id, { before, limit: store.TAIL_PAGE_SIZE });
            assert.ok(page.messages.length > 0, `page before=${before} is not empty`);
            assert.equal(page.messages[0].role, 'user', `page before=${before} opens on a turn boundary`);
            assert.equal(page.baseIdx, before - page.messages.length, 'page indexes are contiguous');
            assert.equal(page.endIdx, before);
            assert.equal(page.totalMessages, TOTAL);
            pages.unshift(page);
            before = page.baseIdx;
            assert.ok(pages.length < 100, 'backward pagination terminated');
        }
        assert.equal(before, 0, 'the last page reaches index 0');
        assert.equal(pages[0].hasMore, false);
        assert.equal(pages[pages.length - 1].hasMore, true);

        let expectedStart = 0;
        for (const page of pages) {
            assert.equal(page.baseIdx, expectedStart, 'pages do not overlap and leave no gap');
            expectedStart = page.endIdx;
        }
        assert.equal(expectedStart, snap.baseIdx);

        const tail = instance.conv.messages;
        assert.equal(tail.length, TOTAL - snap.baseIdx, 'the loaded window matches baseIdx..total');
        const reconstructed = pages.flatMap(page => page.messages).concat(tail);
        assert.equal(reconstructed.length, TOTAL, 'pages + tail cover the whole history');
        reconstructed.forEach((msg, i) => assert.equal(msg.id, `m${i}`, `index ${i} holds the stored message`));

        // ---- ensureFull: the run path gets everything
        await instance.ensureFull();
        assert.equal(instance._fullLoaded, true);
        assert.equal(instance._baseIdx, 0);
        assert.equal(instance.conv.messages.length, TOTAL);
        assert.equal(calls.get, 0, 'the full load goes through query, never a whole-document fetch');

        // ---- warm snapshot after a full load STILL ships only the tail
        const warm = await instance.buildSnapshot();
        assert.equal(warm.hasMore, true, 'a warm snapshot stays windowed for fast re-switch');
        assert.equal(warm.totalMessages, TOTAL);
        assert.ok(warm.baseIdx > 0);
        assert.equal(warm.messages[0].role, 'user');
        assert.equal(warm.messages[0].idx, warm.baseIdx);
        assert.ok(warm.messages.length < TOTAL, 'the payload is a tail, not the history');
        assert.deepEqual(warm.lastRun.context, PERSISTED_CONTEXT);
    } finally {
        if (instance) clearTimeout(instance.idleTimer);
        modelServer.close();
        await stopChild(child);
        try {
            fs.rmSync(dir, { recursive: true, force: true });
        } catch (err) {
            console.error(`temp dir cleanup failed (${dir}): ${err.message}`);
        }
    }
});
