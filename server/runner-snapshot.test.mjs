// ============================================
// runner-snapshot.test.mjs — the attach path of the ConversationRunner.
//   node --test server/runner-snapshot.test.mjs
//
// Two invariants that make switching chats fast, both invisible in the JSON:
//   1  a cold mount reads the conversation exactly ONCE (init() hydrates,
//      buildSnapshot() reuses it) — it used to read it four times, 5.9 MB each;
//   2  no js-tiktoken pass runs when the last assistant turn already persisted
//      the context the pill renders, so GET /snapshot never stalls on CPU.
// ============================================
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mcpPool = require('./mcp-pool');
const runner = require('./runner');

// No MCP servers in a unit test: the pool's real connect() reaches for the
// network and schedules retries that outlive the process.
mcpPool.getForUser = async () => ({
    getFormattedTools: async () => [],
    getStorageOrigin: () => null,
    hasToolPrefix: () => false,
    registry: new Map()
});

const MODEL = 'snapshot-test-model';
const WINDOW = 200000;

function startModelServer() {
    const server = http.createServer((req, res) => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ data: [{ id: MODEL, capabilities: { contextWindow: WINDOW, vision: false } }] }));
    });
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// nDB handle stub: `query` counts per document type, so a doubled hydration is
// a visible call count instead of an invisible 6 MB transfer. `peek` implements
// the engine's field-projection + array-slice contract (fields are returned as
// named, NOT "all fields").
function makeDb(docs) {
    const reads = { session: 0, conversation: 0, peek: 0 };
    const db = {
        async findAll(field, value) { return docs.filter(doc => doc[field] === value); },
        async query({ filter = {}, limit = 1000, fields = null } = {}) {
            if (filter._type === 'session') reads.session += 1;
            if (filter._type === 'conversation') reads.conversation += 1;
            return {
                total: docs.filter(doc => Object.entries(filter).every(([field, value]) => doc[field] === value)).length,
                count: 0,
                results: docs
                    .filter(doc => Object.entries(filter).every(([field, value]) => doc[field] === value))
                    .slice(0, limit)
                    .map(doc => fields ? Object.fromEntries(fields.map(f => [f, doc[f]])) : doc),
                took_ms: 0
            };
        },
        async peek(id, { fields = null, arraySlices = [] } = {}) {
            reads.peek += 1;
            const doc = docs.find(d => d._id === id);
            if (!doc) throw new Error(`not_found: ${id}`);
            const out = { _id: doc._id };
            for (const field of fields || []) {
                if (field === '_id' || doc[field] === undefined) continue;
                out[field] = doc[field];
            }
            const ranges = {};
            for (const spec of arraySlices) {
                const arr = doc[spec.path] || [];
                const end = Math.min(arr.length, spec.offset + spec.limit);
                const slice = spec.offset < end ? arr.slice(spec.offset, end) : [];
                out[spec.path] = slice;
                ranges[spec.path] = {
                    offset: spec.offset, returned: slice.length, total: arr.length,
                    has_more: spec.offset + slice.length < arr.length, next_offset: spec.offset + slice.length
                };
            }
            return { id: doc._id, seq: 0, doc: out, ranges };
        },
        async patch() { throw new Error('snapshot test: unexpected patch'); },
        async set() { throw new Error('snapshot test: unexpected set'); },
        async update() { throw new Error('snapshot test: unexpected update'); },
        async insert() { throw new Error('snapshot test: unexpected insert'); },
        async getFile() { throw new Error('snapshot test: unexpected getFile'); }
    };
    return { db, reads };
}

function makeDocs(chatId, messages) {
    const now = '2026-01-01T00:00:00.000Z';
    return [
        { _id: `sess_${chatId}`, _type: 'session', id: chatId, userId: `$user_${chatId}`, title: chatId, model: MODEL, mode: 'direct', createdAt: now, updatedAt: now },
        { _id: `conv_${chatId}`, _type: 'conversation', id: chatId, userId: `$user_${chatId}`, title: chatId, createdAt: now, updatedAt: now, messageCount: messages.length, messages }
    ];
}

async function mount(gatewayUrl, chatId, messages) {
    const { db, reads } = makeDb(makeDocs(chatId, messages));
    const user = { id: `user_${chatId}` };
    const instance = await runner.getRunner(user, { db }, chatId);
    return { instance, reads, user };
}

async function withServer(fn) {
    const server = await startModelServer();
    const { port } = server.address();
    runner.init({
        gatewayUrl: `http://127.0.0.1:${port}`,
        gatewayKey: null,
        publicOrigin: 'http://localhost:8080',
        embedMessageAsync: async () => {},
        log: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
        getInstructions: async () => '',
        idleMs: 60_000
    });
    try {
        return await fn();
    } finally {
        server.close();
    }
}

const PERSISTED_CONTEXT = {
    window_size: WINDOW,
    used_tokens: 123456,
    raw_tokens: 150000,
    available_tokens: WINDOW - 123456,
    strategy_applied: false,
    counted: 'runner'
};

test('cold mount reads the conversation once and paints the pill from the persisted count', async () => {
    await withServer(async () => {
        const filler = 'x'.repeat(50000); // 600k chars total — far past the count budget
        const messages = [];
        for (let i = 0; i < 6; i++) {
            messages.push({ idx: messages.length, id: `u${i}`, role: 'user', content: `[2026-01-01@10:00] ${filler}` });
            messages.push({ idx: messages.length, id: `a${i}`, role: 'assistant', content: filler, usage: { total_tokens: 10 }, context: PERSISTED_CONTEXT });
        }
        const { instance, reads } = await mount('chat_cold', 'chat_cold', messages);
        try {
            assert.deepEqual(reads, { session: 1, conversation: 1, peek: 2 }, 'init() hydrates the tail: one session read, one `_id`-only conversation query, two peeks');

            const snap = await instance.buildSnapshot();
            assert.deepEqual(reads, { session: 1, conversation: 1, peek: 2 }, 'buildSnapshot() reuses the hydration — no second read');
            assert.deepEqual(Object.keys(snap).sort(), [
                'appEvents', 'baseIdx', 'contextHistory', 'convSeq', 'hasMore',
                'inFlight', 'lastRun', 'messages', 'meta', 'running', 'totalMessages'
            ]);
            assert.equal(snap.baseIdx, 0, 'a short conversation is fully loaded');
            assert.equal(snap.hasMore, false);
            assert.equal(snap.totalMessages, messages.length);
            assert.deepEqual(snap.lastRun.context, PERSISTED_CONTEXT, 'pill comes from the persisted context, uncounted');
            assert.equal(snap.messages.length, messages.length);
            // viewMessage projection still runs: the timestamp prefix splits out...
            assert.equal(snap.messages[0].timestamp, Date.parse('2026-01-01T10:00:00'));
            assert.equal(snap.messages[0].content, filler);
            // ...without touching the stored message (shallow copy, no JSON round-trip).
            assert.equal(messages[0].content, `[2026-01-01@10:00] ${filler}`);

            await instance.buildSnapshot();
            assert.deepEqual(reads, { session: 2, conversation: 2, peek: 2 }, 'a warm snapshot refreshes the full document — other writers stay visible');
        } finally {
            clearTimeout(instance.idleTimer);
        }
    });
});

test('a small conversation with no persisted context is counted, and the cache serves the next snapshot', async () => {
    await withServer(async () => {
        const messages = [
            { idx: 0, id: 'u0', role: 'user', content: 'hello there' },
            { idx: 1, id: 'a0', role: 'assistant', content: 'hi', usage: { total_tokens: 5 } }
        ];
        const { instance, reads } = await mount('chat_small', 'chat_small', messages);
        try {
            const snap = await instance.buildSnapshot();
            assert.deepEqual(reads, { session: 1, conversation: 1, peek: 2 });
            assert.equal(snap.lastRun.context.counted, 'runner');
            assert.ok(snap.lastRun.context.used_tokens > 0);
            assert.equal(snap.lastRun.context.window_size, WINDOW);

            const cached = instance._countCache;
            assert.ok(cached && cached.key, 'the count is cached for the next attach');
            await instance.buildSnapshot();
            assert.equal(instance._countCache.key, cached.key, 'unchanged conversation keeps the cached count');
        } finally {
            clearTimeout(instance.idleTimer);
        }
    });
});
