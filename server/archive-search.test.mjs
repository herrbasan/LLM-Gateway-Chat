// Archive search — nVDB v2 HTTP client mocks.
//   node server/archive-search.test.mjs
// No server, no DB files, no services: internal-tools.js is pure, the nVDB v2
// client is mocked, and the nDB handle answers point lookups only (a full
// `find('_type', …)` scan throws, so hydration cannot regress into one).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { searchArchive, shapeSearchToolResult, isSearchEligible } = require('./internal-tools');
const { isEmbeddableMessage } = require('./embed');
const { classifyQueryProfile } = require('./nvdb-search-options');
const { parseChatChunkId, toUnixSeconds } = require('./nvdb-chat');

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

const USER = 'u1';

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

// V2HybridHit: `/hybrid_search` returns these directly; `/level2` wraps each in
// `{ hybrid, rerank_score }`.
function hybridHit(chatId, msgIdx, score, { chunk = 0, vectorScore = null, rrf = null } = {}) {
    return {
        hit: { id: `${USER}:${chatId}:${msgIdx}#${chunk}`, score, excerpt: '' },
        lexical_score: score,
        lexical_rank: 1,
        vector_score: vectorScore,
        vector_rank: null,
        rrf_score: rrf === null ? score : rrf
    };
}

function makeEnv({ conversations = [CONV_A, CONV_B], sessions = SESSIONS, hits = [], level2 = null } = {}) {
    const calls = { hybrid: [], level2: [], find: [], embed: [] };
    const all = [...conversations, ...sessions];

    // The real engine applies `filters` inside the query, so the mock must too —
    // otherwise a role filter would look like it is enforced during hydration.
    function matchesFilters(h, query) {
        const parsed = parseChatChunkId(h.hit?.id, USER);
        if (!parsed) return false;
        const conv = conversations.find(c => c.id === parsed.sessionId);
        const msgHit = conv?.messages[parsed.msgIdx];
        const session = sessions.find(s => s.id === parsed.sessionId);
        if (!msgHit) return false;
        for (const filter of query?.lexical?.filters?.promoted || []) {
            const actual = filter.field === 'role'
                ? msgHit.role
                : filter.field === 'mode'
                    ? (session?.mode === 'arena' ? 'arena' : 'direct')
                    : undefined;
            if (actual !== filter.value) return false;
        }
        const created = query?.lexical?.filters?.created_at;
        if (created) {
            const ts = toUnixSeconds(msgHit.createdAt);
            if (ts === null) return false;
            if (created.min !== undefined && ts < created.min) return false;
            if (created.max !== undefined && ts > created.max) return false;
        }
        return true;
    }

    const dbInstance = {
        db: {
            find(field, value) {
                if (field === '_type') {
                    throw new Error(`full nDB scan: find(${JSON.stringify(field)}) is forbidden`);
                }
                calls.find.push([field, value]);
                return all.filter(d => d[field] === value);
            }
        },
        nvdbClient: {
            hybridSearch: async (name, query) => {
                calls.hybrid.push({ name, query });
                const list = typeof hits === 'function' ? hits(query) : hits;
                return { hits: structuredClone(list).filter(h => matchesFilters(h, query)), took_ms: 1 };
            },
            level2: async (name, payload) => {
                calls.level2.push({ name, payload });
                const value = typeof level2 === 'function' ? level2(payload) : level2;
                return structuredClone(value);
            }
        }
    };
    const deps = {
        userId: USER,
        nvdbCollection: 'chat',
        rerankerLoaded: false,
        embedAvailable: true,
        embedBatch: async (texts) => {
            calls.embed.push(...texts);
            return texts.map(() => [0.1, 0.2, 0.3]);
        }
    };
    return { dbInstance, deps, calls, all };
}

// ------------------------------------------------------ default hybrid request

await test('default hybrid request sends dense+lexical, principals, diversity and level2 payload', async () => {
    const rawHits = [hybridHit('chatA', 0, 0.5)];
    const { dbInstance, deps, calls } = makeEnv({
        hits: () => rawHits,
        level2: (payload) => ({
            rejected: false,
            best_rerank_score: 0.91,
            hits: payload.hits.map(h => ({ hybrid: h, rerank_score: 0.91 }))
        })
    });
    const data = await searchArchive(dbInstance, { query: 'alpha concept', limit: 10 }, { ...deps, rerankerLoaded: true });

    assert.equal(calls.hybrid.length, 1);
    assert.equal(calls.hybrid[0].name, 'chat');
    const q = calls.hybrid[0].query;
    assert.equal(q.dense, true);
    assert.equal(q.lexical_enabled, true);
    assert.deepEqual(q.lexical.principals, [`user:${USER}`]);
    assert.deepEqual(q.lexical.group_by_parent, { max_per_parent: 2 });
    assert.equal(q.rrf_k, 20);
    assert.equal(q.candidate_k, 200);
    assert.equal(q.lexical.text, 'alpha concept');
    assert.deepEqual(q.lexical.filters, {});
    assert.equal(q.lexical.top_k, 20, 'the rerank shortlist sizes the lexical top_k');

    assert.equal(calls.level2.length, 1);
    const l2 = calls.level2[0].payload;
    assert.equal(l2.query_text, 'alpha concept');
    assert.deepEqual(l2.principals, [`user:${USER}`]);
    assert.deepEqual(l2.hits, rawHits);
    assert.equal(l2.shortlist, 20);
    assert.equal(l2.rerank_weight, 0.2);
    assert.equal(l2.relevance_floor, 0.05);

    assert.equal(data.method, 'hybrid');
    assert.equal(data.rejected, false);
    assert.deepEqual(data.results.map(r => r.message.id), ['a0']);
    assert.equal(data.results[0].score, 0.91);
    assert.equal(data.results[0].rerankScore, 0.91);
});

await test('hybrid without a reranker never calls level2 and uses top_k max(limit*2, 10)', async () => {
    const { dbInstance, deps, calls } = makeEnv({ hits: [hybridHit('chatA', 0, 0.4)] });
    await searchArchive(dbInstance, { query: 'alpha concept', limit: 3 }, deps);
    assert.equal(calls.level2.length, 0);
    assert.equal(calls.hybrid[0].query.lexical.top_k, 10);
});

// ---------------------------------------------------- Qwen3 Instruct: prefix

await test('Qwen3 Instruct: prefix is applied to the query text passed to embedBatch', async () => {
    const { dbInstance, deps, calls } = makeEnv({ hits: [hybridHit('chatA', 0, 0.4)] });
    await searchArchive(dbInstance, { query: 'alpha concept', limit: 5 }, deps);
    assert.equal(calls.embed.length, 1);
    assert.equal(
        calls.embed[0],
        'Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: alpha concept'
    );
});

await test('a custom queryInstruct replaces the default instruction', async () => {
    const { dbInstance, deps, calls } = makeEnv({ hits: [hybridHit('chatA', 0, 0.4)] });
    await searchArchive(dbInstance, { query: 'alpha', limit: 5 }, { ...deps, queryInstruct: 'Find chat turns' });
    assert.equal(calls.embed[0], 'Instruct: Find chat turns\nQuery: alpha');
});

// ------------------------------------------------- adaptive RRF weights (#87)

await test('adaptive RRF weights: rrf_k 20 across all six query profiles', async () => {
    const cases = [
        ['abc1234', 'exact-id', 1.0, 0.2],
        ['foo_bar', 'exact-id', 1.0, 0.2],
        ['"being aware of ones own thinking"', 'exact-phrase', 1.0, 0.3],
        ['server/embed.js fix', 'exact-short', 1.0, 0.3],
        ['why did foo_bar fail', 'mixed-exact', 0.5, 1.0],
        ['consciousness', 'single-term', 0.8, 1.0],
        ['how does memory consolidation work', 'semantic', 0.3, 1.0]
    ];
    for (const [query, profile, lexicalWeight, vectorWeight] of cases) {
        assert.equal(classifyQueryProfile(query).profile, profile, `profile for ${JSON.stringify(query)}`);
        const { dbInstance, deps, calls } = makeEnv({ hits: [hybridHit('chatA', 0, 0.4)] });
        const data = await searchArchive(dbInstance, { query, limit: 5 }, deps);
        const q = calls.hybrid[0].query;
        assert.equal(q.rrf_k, 20, `rrf_k for ${profile}`);
        assert.equal(q.lexical_weight, lexicalWeight, `lexical_weight for ${profile}`);
        assert.equal(q.vector_weight, vectorWeight, `vector_weight for ${profile}`);
        assert.match(data.mode, new RegExp(`profile=${profile}`));
    }
});

// ---------------------------------------------------------- search modes

await test('semantic mode: dense only, no level2, and fails loudly without embeddings', async () => {
    const { dbInstance, deps, calls } = makeEnv({
        hits: [hybridHit('chatA', 0, 0.71, { vectorScore: 0.71 })],
        level2: { rejected: false, best_rerank_score: 1, hits: [] }
    });
    const data = await searchArchive(
        dbInstance,
        { query: 'alpha', limit: 10, search_type: 'semantic' },
        { ...deps, rerankerLoaded: true }
    );
    const q = calls.hybrid[0].query;
    assert.equal(q.dense, true);
    assert.equal(q.lexical_enabled, false);
    assert.equal(calls.level2.length, 0, 'semantic never reranks');
    assert.equal(data.method, 'semantic');
    assert.equal(data.results[0].score, 0.71, 'semantic score comes from vector_score');

    const { dbInstance: db2, deps: deps2 } = makeEnv();
    await assert.rejects(
        searchArchive(db2, { query: 'alpha', search_type: 'semantic' }, { ...deps2, embedAvailable: false }),
        /Semantic search unavailable/
    );
});

await test('keyword mode: lexical only, no embedding, no level2', async () => {
    const { dbInstance, deps, calls } = makeEnv({
        hits: [hybridHit('chatA', 0, 0, { rrf: 0 }), hybridHit('chatB', 0, 0, { rrf: 0 })]
    });
    const data = await searchArchive(
        dbInstance,
        { query: 'alpha concept', limit: 10, search_type: 'keyword' },
        { ...deps, rerankerLoaded: true }
    );
    const q = calls.hybrid[0].query;
    assert.equal(q.dense, false);
    assert.equal(q.lexical_enabled, true);
    assert.equal(q.query_vector, null);
    assert.equal(calls.embed.length, 0);
    assert.equal(calls.level2.length, 0);
    assert.equal(data.method, 'keyword');
    assert.deepEqual(data.results.map(r => r.message.id), ['a0', 'b0']);
});

await test('hybrid degrades to lexical-only when embeddings are unavailable', async () => {
    const { dbInstance, deps, calls } = makeEnv({ hits: [hybridHit('chatA', 0, 0.2)] });
    const data = await searchArchive(dbInstance, { query: 'alpha', limit: 5 }, { ...deps, embedAvailable: false });
    assert.equal(data.method, 'keyword-fallback');
    assert.equal(calls.embed.length, 0);
    const q = calls.hybrid[0].query;
    assert.equal(q.dense, false);
    assert.equal(q.lexical_enabled, true);
    assert.equal(q.query_vector, null);
});

await test('hybrid degrades to lexical-only when embedBatch rejects', async () => {
    const { dbInstance, deps, calls } = makeEnv({ hits: [hybridHit('chatA', 0, 0.2)] });
    const data = await searchArchive(dbInstance, { query: 'alpha', limit: 5 }, {
        ...deps,
        embedBatch: async () => { throw new Error('gateway 503'); }
    });
    assert.equal(data.method, 'keyword-fallback');
    assert.equal(calls.hybrid[0].query.dense, false);
    assert.deepEqual(data.results.map(r => r.message.id), ['a0']);
});

await test('an empty embedding vector also degrades hybrid to lexical', async () => {
    const { dbInstance, deps, calls } = makeEnv({ hits: [hybridHit('chatA', 0, 0.2)] });
    const data = await searchArchive(dbInstance, { query: 'alpha', limit: 5 }, {
        ...deps,
        embedBatch: async () => [[]]
    });
    assert.equal(data.method, 'keyword-fallback');
    assert.equal(calls.hybrid[0].query.dense, false);
});

await test('an unknown search_type throws instead of guessing', async () => {
    const { dbInstance, deps } = makeEnv();
    await assert.rejects(
        searchArchive(dbInstance, { query: 'alpha', search_type: 'fuzzy' }, deps),
        /Invalid search_type: fuzzy/
    );
});

// -------------------------------------------------------------- fail-closed ACL

await test('fail closed: a missing or empty userId throws before any nVDB call', async () => {
    for (const userId of [undefined, '', '   ', null]) {
        const { dbInstance, deps, calls } = makeEnv();
        await assert.rejects(
            searchArchive(dbInstance, { query: 'alpha' }, { ...deps, userId }),
            /userPrincipal: userId required/
        );
        assert.equal(calls.hybrid.length, 0);
    }
});

await test('fail closed: a missing nvdbClient throws', async () => {
    const { dbInstance, deps } = makeEnv();
    delete dbInstance.nvdbClient;
    await assert.rejects(searchArchive(dbInstance, { query: 'alpha' }, deps), /nvdbClient is required/);
});

// ------------------------------------------- native promoted filters + dates

await test('role filter becomes a native promoted predicate', async () => {
    const { dbInstance, deps, calls } = makeEnv({ hits: [hybridHit('chatA', 0, 0)] });
    await searchArchive(dbInstance, { query: 'alpha', role: 'user', limit: 5 }, deps);
    assert.deepEqual(calls.hybrid[0].query.lexical.filters.promoted, [
        { field: 'role', op: 'eq', value: 'user' }
    ]);
});

await test('mode filter normalizes chat to direct and keeps arena', async () => {
    const arena = makeEnv({ hits: [hybridHit('chatA', 0, 0)] });
    await searchArchive(arena.dbInstance, { query: 'alpha', mode: 'arena', limit: 5 }, arena.deps);
    assert.deepEqual(arena.calls.hybrid[0].query.lexical.filters.promoted, [
        { field: 'mode', op: 'eq', value: 'arena' }
    ]);

    const chat = makeEnv({ hits: [hybridHit('chatA', 0, 0)] });
    await searchArchive(chat.dbInstance, { query: 'alpha', mode: 'chat', limit: 5 }, chat.deps);
    assert.deepEqual(chat.calls.hybrid[0].query.lexical.filters.promoted, [
        { field: 'mode', op: 'eq', value: 'direct' }
    ]);
});

await test('role and mode filters stack in one promoted list', async () => {
    const { dbInstance, deps, calls } = makeEnv({ hits: [hybridHit('chatA', 0, 0)] });
    await searchArchive(dbInstance, { query: 'alpha', role: 'user', mode: 'arena', limit: 5 }, deps);
    assert.deepEqual(calls.hybrid[0].query.lexical.filters.promoted, [
        { field: 'role', op: 'eq', value: 'user' },
        { field: 'mode', op: 'eq', value: 'arena' }
    ]);
});

await test("role/mode 'all' add no filter", async () => {
    const { dbInstance, deps, calls } = makeEnv({ hits: [hybridHit('chatA', 0, 0)] });
    await searchArchive(dbInstance, { query: 'alpha', role: 'all', mode: 'all', limit: 5 }, deps);
    assert.deepEqual(calls.hybrid[0].query.lexical.filters, {});
});

await test('date_from / date_to become an inclusive created_at range in unix seconds', async () => {
    const { dbInstance, deps, calls } = makeEnv({ hits: [hybridHit('chatA', 0, 0)] });
    await searchArchive(dbInstance, {
        query: 'alpha',
        date_from: '2026-01-01T00:00:00Z',
        date_to: '2026-02-01T00:00:00Z',
        limit: 5
    }, deps);
    assert.deepEqual(calls.hybrid[0].query.lexical.filters.created_at, {
        min: 1767225600,
        max: 1769904000
    });
});

await test('a one-sided date filter carries only that bound', async () => {
    const lower = makeEnv({ hits: [hybridHit('chatA', 0, 0)] });
    await searchArchive(lower.dbInstance, { query: 'alpha', date_from: 1767225600, limit: 5 }, lower.deps);
    assert.deepEqual(lower.calls.hybrid[0].query.lexical.filters.created_at, { min: 1767225600 });

    const upper = makeEnv({ hits: [hybridHit('chatA', 0, 0)] });
    await searchArchive(upper.dbInstance, { query: 'alpha', date_to: 1767225600, limit: 5 }, upper.deps);
    assert.deepEqual(upper.calls.hybrid[0].query.lexical.filters.created_at, { max: 1767225600 });
});

// ------------------------------------------------------- zero full nDB scans

await test('hydration uses point lookups only, cached per unique session', async () => {
    const { dbInstance, deps, calls } = makeEnv({
        hits: [
            hybridHit('chatA', 0, 0.9),
            hybridHit('chatA', 1, 0.8),
            hybridHit('chatB', 0, 0.7)
        ]
    });
    const data = await searchArchive(dbInstance, { query: 'alpha concept', limit: 10 }, deps);
    assert.deepEqual(calls.find, [['id', 'chatA'], ['id', 'chatB']]);
    assert.equal(data.results.length, 3);
});

// -------------------------------------------------- chunk dedup + #64 rules

await test('two chunks of one stored message hydrate once and yield one result', async () => {
    const { dbInstance, deps, calls } = makeEnv({
        hits: [
            hybridHit('chatA', 0, 0.9, { chunk: 0 }),
            hybridHit('chatA', 0, 0.8, { chunk: 1 })
        ]
    });
    const data = await searchArchive(dbInstance, { query: 'alpha', limit: 10 }, deps);
    assert.equal(data.results.length, 1);
    assert.equal(data.results[0].message.id, 'a0');
    assert.deepEqual(calls.find, [['id', 'chatA']]);
});

await test('default search drops tool, system and empty/whitespace hits (#64)', async () => {
    const { dbInstance, deps } = makeEnv({
        hits: [
            hybridHit('chatA', 2, 0.99),
            hybridHit('chatA', 3, 0.98),
            hybridHit('chatA', 4, 0.97),
            hybridHit('chatA', 5, 0.965),
            hybridHit('chatA', 6, 0.96),
            hybridHit('chatA', 0, 0.90)
        ]
    });
    const data = await searchArchive(dbInstance, { query: 'alpha', limit: 10 }, deps);
    assert.deepEqual(data.results.map(r => r.message.id), ['a0']);
});

await test('explicit role:system inspects non-empty system messages but still rejects empty ones', async () => {
    const convEmptySystem = {
        _type: 'conversation', _id: 'dcv', id: 'chatD',
        messages: [
            msg('d0', 0, 'system', 'system prompt text', '2026-03-01T00:00:00Z'),
            msg('d1', 1, 'system', '', '2026-03-02T00:00:00Z'),
            msg('d2', 2, 'user', 'system prompt text', '2026-03-03T00:00:00Z')
        ]
    };
    const { dbInstance, deps } = makeEnv({
        conversations: [convEmptySystem],
        sessions: [{ _type: 'session', id: 'chatD', title: 'Chat D', mode: 'direct', createdAt: '2026-03-01T00:00:00Z' }],
        hits: [hybridHit('chatD', 0, 0.9), hybridHit('chatD', 1, 0.8), hybridHit('chatD', 2, 0.7)]
    });
    const data = await searchArchive(dbInstance, { query: 'system prompt text', role: 'system', limit: 10 }, deps);
    assert.deepEqual(data.results.map(r => r.message.id), ['d0']);
    assert.equal(isSearchEligible({ role: 'system', content: '' }, 'system'), false);
});

await test('explicit role filter selects that role only, and never resurrects empties', async () => {
    const { dbInstance, deps } = makeEnv({
        hits: [
            hybridHit('chatA', 0, 0.9),
            hybridHit('chatA', 2, 0.8),
            hybridHit('chatA', 3, 0.7)
        ]
    });
    const tool = await searchArchive(dbInstance, { query: 'alpha', role: 'tool', limit: 10 }, deps);
    assert.deepEqual(tool.results.map(r => r.message.id), ['a2']);
    const user = await searchArchive(dbInstance, { query: 'alpha', role: 'user', limit: 10 }, deps);
    assert.deepEqual(user.results.map(r => r.message.id), ['a0']);
});

await test('hits whose message index no longer exists are skipped', async () => {
    const { dbInstance, deps } = makeEnv({
        hits: [hybridHit('chatA', 0, 0.9), hybridHit('chatA', 42, 0.8)]
    });
    const data = await searchArchive(dbInstance, { query: 'alpha', limit: 10 }, deps);
    assert.deepEqual(data.results.map(r => r.message.id), ['a0']);
});

// ---------------------------------------------------------- level-2 rejection

await test('level-2 rejection returns no results and preserves the score and note', async () => {
    const rawHits = [hybridHit('chatA', 0, 0.3)];
    const { dbInstance, deps, calls } = makeEnv({
        hits: () => rawHits,
        level2: () => ({
            rejected: true,
            best_rerank_score: 0.01,
            hits: rawHits.map(h => ({ hybrid: h, rerank_score: 0.01 }))
        })
    });
    const data = await searchArchive(dbInstance, { query: 'alpha', limit: 10 }, { ...deps, rerankerLoaded: true });
    assert.equal(calls.level2.length, 1);
    assert.deepEqual(data.results, []);
    assert.equal(data.rejected, true);
    assert.equal(data.bestRerankScore, 0.01);
    assert.equal(data.rejectedCount, 1);
    assert.equal(data.method, 'hybrid');
    assert.equal(data.search_type, 'hybrid');

    const shaped = shapeSearchToolResult(data);
    assert.deepEqual(shaped.results, []);
    assert.equal(shaped.rejected, true);
    assert.equal(shaped.bestRerankScore, 0.01);
    assert.match(shaped.note, /relevance floor/);
});

await test('a rejected level-2 run still never touches the nDB', async () => {
    const { dbInstance, deps, calls } = makeEnv({
        hits: [hybridHit('chatA', 0, 0.3)],
        level2: { rejected: true, best_rerank_score: 0.0, hits: [] }
    });
    await searchArchive(dbInstance, { query: 'alpha', limit: 10 }, { ...deps, rerankerLoaded: true });
    assert.deepEqual(calls.find, []);
});

// ------------------------------------------------------- tool result + parity

await test('shapeSearchToolResult carries message identity and search mode', async () => {
    const { dbInstance, deps } = makeEnv({ hits: [hybridHit('chatA', 7, 0.66, { rrf: 0.66 })] });
    const data = await searchArchive(dbInstance, { query: 'alpha', limit: 2 }, deps);
    const shaped = shapeSearchToolResult(data);
    assert.equal(shaped.query, 'alpha');
    assert.equal(shaped.method, 'hybrid');
    assert.match(shaped.searchMode, /layers=/);
    assert.equal(shaped.results.length, 1);
    const [first] = shaped.results;
    assert.equal(first.messageId, 'a7');
    assert.equal(first.idx, 7);
    assert.equal(first.sessionId, 'chatA');
    assert.equal(first.sessionTitle, 'Chat A');
    assert.equal(first.mode, 'direct');
    assert.equal(first.role, 'user');
    assert.equal(first.score, 0.66);
    assert.equal(first.date, '2026-01-01T00:00:00Z');
    assert.ok(typeof first.content === 'string');
    const parsed = JSON.parse(JSON.stringify(shaped));
    assert.deepEqual(parsed.results.map(r => [r.messageId, r.idx]), [['a7', 7]]);
    assert.equal('rejected' in shaped, false);
});

await test('an empty query short-circuits without touching nVDB or nDB', async () => {
    const { dbInstance, deps, calls } = makeEnv();
    const data = await searchArchive(dbInstance, { query: '   ', limit: 5 }, deps);
    assert.deepEqual(data.results, []);
    assert.equal(data.method, 'hybrid');
    assert.equal(calls.hybrid.length, 0);
    assert.equal(calls.find.length, 0);
});

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
