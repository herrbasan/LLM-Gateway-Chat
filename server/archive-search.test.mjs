// Archive search + embedding eligibility — mocked-db tests.
//   node server/archive-search.test.mjs
// No server, no DB files, no services: internal-tools.js and embed.js are pure
// modules, so this exercises the real code against in-memory fixtures.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { searchArchive, shapeSearchToolResult, isSearchEligible } = require('./internal-tools');
const { isEmbeddableMessage } = require('./embed');

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

function msg(id, idx, role, content, createdAt) {
    return { id, idx, role, content, createdAt, model: role === 'assistant' ? 'test-model' : undefined };
}

const CONV_A = {
    _type: 'conversation', _id: 'acv', id: 'chatA',
    messages: [
        msg('a0', 0, 'user', 'alpha concept origin', '2026-01-01T00:00:00Z'),
        msg('a1', 1, 'assistant', 'alpha concept reply', '2026-01-02T00:00:00Z'),
        msg('a2', 2, 'tool', 'alpha concept tool payload', '2026-01-03T00:00:00Z'),
        msg('a3', 3, 'system', 'alpha concept system prompt', '2026-01-04T00:00:00Z'),
        msg('a4', 4, 'assistant', '', '2026-01-05T00:00:00Z'),
        msg('a5', 5, 'assistant', '   ', '2026-01-06T00:00:00Z'),
        msg('a6', 6, 'tool', '', '2026-01-07T00:00:00Z'),
        // Same createdAt as chatB's message: chatId is the tie-break.
        msg('a7', 7, 'user', 'alpha concept tie', '2026-02-01T00:00:00Z')
    ]
};
const CONV_B = {
    _type: 'conversation', _id: 'bcv', id: 'chatB',
    messages: [msg('b0', 0, 'user', 'alpha concept newest', '2026-02-01T00:00:00Z')]
};
const SESSIONS = [
    { _type: 'session', id: 'chatA', title: 'Chat A', mode: 'direct', createdAt: '2026-01-01T00:00:00Z' },
    { _type: 'session', id: 'chatB', title: 'Chat B', mode: 'direct', createdAt: '2026-02-01T00:00:00Z' }
];

function makeDb({ conversations = [CONV_A, CONV_B], search } = {}) {
    const calls = { search: [] };
    const all = [...conversations, ...SESSIONS];
    return {
        calls,
        dbInstance: {
            db: { find: (field, value) => all.filter(d => d[field] === value) },
            embeddingsCol: {
                search: async (opts) => {
                    calls.search.push(opts);
                    return search ? search(opts) : [];
                }
            }
        },
        deps: { embedBatch: async () => [[0.1, 0.2, 0.3]], embedAvailable: true }
    };
}

const EMPTY_DEPS = { embedBatch: async () => [[]], embedAvailable: false };

function hit(chatId, msgIdx, score, id) {
    return {
        id: id || `${chatId}_${msgIdx}`,
        score,
        payload: chatId ? JSON.stringify({ chatId, msgIdx, chunk: 0 }) : null
    };
}

// ---------------------------------------------------------------- topK

await test('semantic search asks nVDB for topK (camelCase), not top_k', async () => {
    const { dbInstance, deps, calls } = makeDb();
    await searchArchive(dbInstance, { query: 'alpha', limit: 4, search_type: 'semantic' }, deps);
    assert.equal(calls.search.length, 1);
    assert.equal(calls.search[0].topK, 12);
    assert.equal('top_k' in calls.search[0], false);
    assert.ok(Array.isArray(calls.search[0].vector));
});

await test('topK defaults to limit 10 * 3 when no limit is passed', async () => {
    const { dbInstance, deps, calls } = makeDb();
    await searchArchive(dbInstance, { query: 'alpha' }, deps);
    assert.equal(calls.search[0].topK, 30);
});

// ------------------------------------------------- eligibility before mapping

await test('default search drops legacy tool/system/empty vectors before mapping', async () => {
    const { dbInstance, deps } = makeDb({
        search: () => [
            hit('chatA', 2, 0.99),  // tool
            hit('chatA', 3, 0.98),  // system
            hit('chatA', 4, 0.97),  // empty assistant
            hit('chatA', 6, 0.96),  // empty tool
            hit('chatA', 0, 0.90)   // user — the only eligible one
        ]
    });
    const data = await searchArchive(dbInstance, { query: 'alpha', limit: 10, search_type: 'semantic' }, deps);
    assert.deepEqual(data.results.map(r => r.message.id), ['a0']);
    assert.equal(data.method, 'semantic');
});

await test('keyword fallback also drops ineligible roles and empty content', async () => {
    const { dbInstance } = makeDb();
    const data = await searchArchive(dbInstance, { query: 'alpha concept', limit: 10, search_type: 'keyword' }, EMPTY_DEPS);
    const ids = data.results.map(r => r.message.id);
    assert.equal(ids.includes('a2'), false, 'tool must not leak');
    assert.equal(ids.includes('a3'), false, 'system must not leak');
    assert.equal(ids.includes('a4'), false, 'empty must not leak');
    assert.equal(ids.includes('a5'), false, 'whitespace-only must not leak');
});

await test('semantic-empty fallback cannot resurrect tool/system/empty messages', async () => {
    // Vectors exist for ineligible messages only; the failure path falls back to
    // lexical search and must still refuse to return them.
    const { dbInstance, deps } = makeDb({ search: () => [hit('chatA', 2, 0.9), hit('chatA', 4, 0.8)] });
    const data = await searchArchive(dbInstance, { query: 'alpha concept', limit: 10, search_type: 'semantic' }, deps);
    assert.equal(data.results.some(r => ['a2', 'a4'].includes(r.message.id)), false);
    assert.deepEqual(data.results.map(r => r.message.id), ['a7', 'b0', 'a1', 'a0']);
});

// ------------------------------------------------------- explicit role filter

await test('explicit role:tool can inspect non-empty legacy tool messages', async () => {
    const { dbInstance } = makeDb();
    const data = await searchArchive(dbInstance, { query: 'alpha', role: 'tool', limit: 10, search_type: 'keyword' }, EMPTY_DEPS);
    assert.deepEqual(data.results.map(r => r.message.id), ['a2']);
});

await test('explicit role:system can inspect non-empty system messages', async () => {
    const { dbInstance } = makeDb();
    const data = await searchArchive(dbInstance, { query: 'alpha', role: 'system', limit: 10, search_type: 'keyword' }, EMPTY_DEPS);
    assert.deepEqual(data.results.map(r => r.message.id), ['a3']);
});

await test('empty content is excluded even under an explicit tool filter', async () => {
    const { dbInstance } = makeDb();
    const data = await searchArchive(dbInstance, { query: 'alpha', role: 'tool', limit: 10, search_type: 'keyword' }, EMPTY_DEPS);
    assert.equal(data.results.some(r => r.message.id === 'a6'), false);
    assert.equal(isSearchEligible({ role: 'tool', content: '' }, 'tool'), false);
});

await test('role:user never returns tool or system even with matching text', async () => {
    const { dbInstance } = makeDb();
    const data = await searchArchive(dbInstance, { query: 'alpha concept', role: 'user', limit: 10, search_type: 'keyword' }, EMPTY_DEPS);
    assert.deepEqual(data.results.map(r => r.message.role), ['user', 'user', 'user']);
});

// ----------------------------------------------------- deterministic ordering

await test('keyword order is recency-descending with chatId/idx tie-breaks', async () => {
    const { dbInstance } = makeDb();
    const data = await searchArchive(dbInstance, { query: 'alpha concept', limit: 10, search_type: 'keyword' }, EMPTY_DEPS);
    const ids = data.results.map(r => r.message.id);
    // b0 and a7 share 2026-02-01 → chatA before chatB by chatId; then a1, a0.
    assert.deepEqual(ids, ['a7', 'b0', 'a1', 'a0']);
    for (const r of data.results) assert.equal(r.score, 0);
});

await test('keyword order is independent of conversation/list input order', async () => {
    const forward = makeDb();
    const reversed = makeDb({ conversations: [CONV_B, CONV_A] });
    const a = await searchArchive(forward.dbInstance, { query: 'alpha concept', limit: 10, search_type: 'keyword' }, EMPTY_DEPS);
    const b = await searchArchive(reversed.dbInstance, { query: 'alpha concept', limit: 10, search_type: 'keyword' }, EMPTY_DEPS);
    assert.deepEqual(a.results.map(r => r.message.id), b.results.map(r => r.message.id));
    assert.deepEqual(a.results.map(r => r.message.id), ['a7', 'b0', 'a1', 'a0']);
});

await test('keyword order is stable when the conversation doc also shuffles messages', async () => {
    const shuffled = {
        ...CONV_A,
        messages: [CONV_A.messages[4], CONV_A.messages[2], CONV_A.messages[0], CONV_A.messages[7], CONV_A.messages[1]]
    };
    const base = makeDb();
    const other = makeDb({ conversations: [shuffled] });
    const a = await searchArchive(base.dbInstance, { query: 'alpha concept', limit: 10, search_type: 'keyword' }, EMPTY_DEPS);
    const b = await searchArchive(other.dbInstance, { query: 'alpha concept', limit: 10, search_type: 'keyword' }, EMPTY_DEPS);
    // other has no chatB, so compare only chatA entries.
    assert.deepEqual(a.results.map(r => r.message.id).filter(id => id.startsWith('a')), b.results.map(r => r.message.id));
});

await test('keyword limit keeps the newest matches after sorting', async () => {
    const { dbInstance } = makeDb();
    const data = await searchArchive(dbInstance, { query: 'alpha concept', limit: 2, search_type: 'keyword' }, EMPTY_DEPS);
    assert.deepEqual(data.results.map(r => r.message.id), ['a7', 'b0']);
});

await test('semantic result order stays vector-score order', async () => {
    const { dbInstance, deps } = makeDb({
        search: () => [hit('chatA', 0, 0.71), hit('chatB', 0, 0.95)]
    });
    const data = await searchArchive(dbInstance, { query: 'alpha', limit: 10, search_type: 'semantic' }, deps);
    assert.deepEqual(data.results.map(r => [r.message.id, r.score]), [['a0', 0.71], ['b0', 0.95]]);
});

// -------------------------------------- original outranks indexed tool copies

await test('the original user message outranks its tool copies by eligibility', async () => {
    const conv = {
        _type: 'conversation', _id: 'ccv', id: 'chatC',
        messages: [
            msg('c0', 0, 'user', 'exact question text', '2026-03-01T00:00:00Z'),
            msg('c1', 1, 'tool', 'exact question text', '2026-03-02T00:00:00Z'),
            msg('c2', 2, 'tool', 'exact question text', '2026-03-03T00:00:00Z')
        ]
    };
    const { dbInstance, deps } = makeDb({
        conversations: [conv],
        search: () => [hit('chatC', 2, 0.99), hit('chatC', 1, 0.98), hit('chatC', 0, 0.60)]
    });
    const semantic = await searchArchive(dbInstance, { query: 'exact question text', limit: 10, search_type: 'semantic' }, deps);
    assert.deepEqual(semantic.results.map(r => r.message.id), ['c0']);
    const keyword = await searchArchive(dbInstance, { query: 'exact question text', limit: 10, search_type: 'keyword' }, EMPTY_DEPS);
    assert.deepEqual(keyword.results.map(r => r.message.id), ['c0']);
});

// ------------------------------------------------------------- tool JSON shape

await test('tool JSON carries messageId and idx alongside the existing fields', async () => {
    const { dbInstance } = makeDb();
    const data = await searchArchive(dbInstance, { query: 'alpha concept', limit: 2, search_type: 'keyword' }, EMPTY_DEPS);
    const shaped = shapeSearchToolResult(data);
    assert.equal(shaped.query, 'alpha concept');
    assert.equal(shaped.method, 'text');
    assert.equal(shaped.results.length, 2);
    const [first] = shaped.results;
    assert.equal(first.messageId, 'a7');
    assert.equal(first.idx, 7);
    assert.equal(first.sessionId, 'chatA');
    assert.equal(first.sessionTitle, 'Chat A');
    assert.equal(first.mode, 'direct');
    assert.equal(first.role, 'user');
    assert.ok(typeof first.content === 'string');
    assert.ok('score' in first && 'date' in first);
    // Round-trips through JSON with identity intact.
    const parsed = JSON.parse(JSON.stringify(shaped));
    assert.deepEqual(parsed.results.map(r => [r.messageId, r.idx]), [['a7', 7], ['b0', 0]]);
});

// --------------------------------------------------- isEmbeddableMessage rules

await test('isEmbeddableMessage: non-tool and non-empty trimmed content only', () => {
    assert.equal(isEmbeddableMessage({ role: 'user', content: 'hello' }), true);
    assert.equal(isEmbeddableMessage({ role: 'assistant', content: ' hi ' }), true);
    assert.equal(isEmbeddableMessage({ role: 'system', content: 'prompt' }), true);
    assert.equal(isEmbeddableMessage({ role: 'tool', content: 'payload' }), false);
    assert.equal(isEmbeddableMessage({ role: 'assistant', content: '' }), false);
    assert.equal(isEmbeddableMessage({ role: 'assistant', content: '   \n\t ' }), false);
    assert.equal(isEmbeddableMessage({ role: 'user' }), false);
    assert.equal(isEmbeddableMessage({ role: 'user', content: null }), false);
    assert.equal(isEmbeddableMessage(null), false);
    assert.equal(isEmbeddableMessage(undefined), false);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
    for (const f of failures) console.error(`\n--- ${f.name}\n${f.err.stack}`);
    process.exit(1);
}
