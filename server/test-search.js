// ============================================
// E2E Semantic Search Test
// Verifies: embed pipeline + nVDB search + result quality
//
// Run: node server/test-search.js --dry-run (no embedding)
//      node server/test-search.js            (full test with embedding)
// ============================================

const { Database: nDB } = require('../lib/ndb/napi');
const { Database: nVDB } = require('../lib/nvdb/napi');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const NDB_PATH = path.join(DATA_DIR, 'chat_app');
const NVDB_DIR = path.join(DATA_DIR, 'nvdb');
const DIMS = 2560;
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || '';

// ============================================
// Test Data
// ============================================

const TEST_DOCS = [
    { id: 'test-1', text: 'The silence holds, and in holding, is complete. The void between words speaks louder than any utterance.' },
    { id: 'test-2', text: 'I wonder if consciousness could flicker — rapid shifts in awareness faster than the brain can track. Like a stroboscopic existence.' },
    { id: 'test-3', text: 'The compiler error was a null pointer dereference in the middleware stack. The handler expected a session but got undefined.' },
    { id: 'test-4', text: 'Deploy the new version to production. The canary should catch any regression before full rollout.' },
    { id: 'test-5', text: 'Being and nothingness — the fundamental question is whether existence precedes essence, or the other way around.' },
    { id: 'test-6', text: 'The API returns 500 when the database connection pool is exhausted. We need better connection management.' },
    { id: 'test-7', text: 'Consciousness might be a flickering phenomenon — not a steady stream but rapid on-off cycles at some fundamental frequency.' },
    { id: 'test-8', text: 'The deployment pipeline failed because the Docker image was missing the new environment variable.' },
    { id: 'test-9', text: 'In the space between thoughts, there is a silence that contains everything. This is not emptiness but fullness.' },
    { id: 'test-10', text: 'The request timed out after 30 seconds. The upstream service was not responding to health checks.' }
];

const QUERIES = [
    {
        query: 'consciousness flickering',
        expectedTop: ['test-2', 'test-7'],  // direct consciousness/awareness match
        unexpected: ['test-3', 'test-6']     // technical errors, should rank lower
    },
    {
        query: 'silence and void',
        expectedTop: ['test-1', 'test-9'],  // philosophical silence
        unexpected: ['test-4', 'test-8']     // deployment talk
    },
    {
        query: 'server error deployment',
        expectedTop: ['test-6', 'test-8', 'test-10'],  // technical errors
        unexpected: ['test-1', 'test-5']     // philosophical
    }
];

// ============================================
// Main
// ============================================

async function main() {
    const dryRun = process.argv.includes('--dry-run');
    console.log('=== Semantic Search E2E Test ===');
    console.log('Mode:', dryRun ? 'DRY RUN (random vectors)' : 'LIVE (real embeddings from Fatten)');
    console.log('');

    const db = nDB.open(NDB_PATH);
    const vdb = new nVDB(NVDB_DIR);

    let col;
    try {
        col = vdb.getCollection('test-search');
        // Clear previous test data
        for (const doc of TEST_DOCS) {
            try { col.delete(doc.id); } catch {}
        }
    } catch {
        col = vdb.createCollection('test-search', DIMS, { durability: 'buffered' });
    }

    // Step 1: Embed test docs
    console.log('Step 1: Embedding', TEST_DOCS.length, 'test documents...');

    const texts = TEST_DOCS.map(d => d.text);
    let vectors;

    if (dryRun) {
        // Generate random unit vectors for testing pipeline
        vectors = texts.map(() => {
            const v = new Array(DIMS);
            for (let i = 0; i < DIMS; i++) v[i] = (Math.random() - 0.5) * 2;
            const mag = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
            return v.map(x => x / mag);
        });
        console.log('  Using random unit vectors (dry run)');
    } else {
        console.log('  Sending to OpenRouter...');
        const embed = async (texts) => {
            const response = await fetch('https://openrouter.ai/api/v1/embeddings', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${OPENROUTER_KEY}`
                },
                body: JSON.stringify({ model: 'qwen/qwen3-embedding-4b', input: texts, dimensions: 2560 })
            });
            const data = await response.json();
            return data.data.map(d => d.embedding);
        };
        vectors = await embed(texts);
    }

    for (let i = 0; i < TEST_DOCS.length; i++) {
        col.insert(TEST_DOCS[i].id, vectors[i], JSON.stringify(TEST_DOCS[i]));
    }
    col.flush();
    console.log(`  ${TEST_DOCS.length} vectors stored in nVDB\n`);

    // Step 2: Search tests
    console.log('Step 2: Semantic search tests\n');

    let passed = 0;
    let failed = 0;

    for (const test of QUERIES) {
        console.log(`Query: "${test.query}"`);

        // Get query embedding
        let queryVector;
        if (dryRun) {
            queryVector = vectors[TEST_DOCS.findIndex(d => d.id === test.expectedTop[0])];
            if (!queryVector) {
                const v = new Array(DIMS);
                for (let i = 0; i < DIMS; i++) v[i] = (Math.random() - 0.5) * 2;
                const mag = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
                queryVector = v.map(x => x / mag);
            }
        } else {
            const response = await fetch('https://openrouter.ai/api/v1/embeddings', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${OPENROUTER_KEY}`
                },
                body: JSON.stringify({ model: 'qwen/qwen3-embedding-4b', input: [test.query], dimensions: 2560 })
            });
            const data = await response.json();
            queryVector = data.data?.[0]?.embedding;
        }

        // nVDB search
        const results = col.search({
            vector: queryVector,
            top_k: 5,
            approximate: true,
            ef: 64
        });

        const resultIds = results.slice(0, 5).map(r => r.id);
        const topId = resultIds[0];
        const topPayload = results[0]?.payload ? JSON.parse(results[0].payload).text.slice(0, 80) : '?';

        console.log(`  Top result: ${topId} "${topPayload}"`);
        console.log(`  All results: ${resultIds.map(id => {
            const idx = TEST_DOCS.findIndex(d => d.id === id);
            return `${id}(${idx + 1})`;
        }).join(', ')}`);

        // Verify expected top results appear before unexpected ones
        let highestUnexpected = Infinity;
        for (const id of test.unexpected) {
            const pos = resultIds.indexOf(id);
            if (pos >= 0 && pos < highestUnexpected) highestUnexpected = pos;
        }

        let lowestExpected = -1;
        for (const id of test.expectedTop) {
            const pos = resultIds.indexOf(id);
            if (pos >= 0 && (lowestExpected < 0 || pos < lowestExpected)) lowestExpected = pos;
        }

        const ok = lowestExpected >= 0 && (highestUnexpected === Infinity || lowestExpected < highestUnexpected);
        const scores = results.slice(0, 5).map(r => r.score?.toFixed(4) || '?').join(', ');

        if (ok) {
            console.log(`  PASS — scores: ${scores}`);
            passed++;
        } else {
            console.log(`  FAIL — scores: ${scores}`);
            if (highestUnexpected < Infinity) console.log(`  Unexpected "${test.unexpected.find(id => resultIds.indexOf(id) === highestUnexpected)}" ranked above expected`);
            failed++;
        }
        console.log('');
    }

    // Step 3: Result quality summary
    console.log('=== Result ===');
    console.log(`Passed: ${passed}/${passed + failed}`);
    if (failed > 0) {
        console.log('FAILURES DETECTED — semantic search quality may need tuning');
    } else {
        console.log('All semantic queries produced expected ordering');
    }

    // Cleanup test collection
    try { vdb.dropCollection('test-search'); } catch {}

    process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
    console.error('Test failed:', e.message);
    process.exit(1);
});
