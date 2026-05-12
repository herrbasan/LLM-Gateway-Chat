// ============================================
// Embedding Pipeline Benchmark
// Run on Fatten or from the server to compare routes
//
// Usage:
//   node benchmark-embed.js                          # all targets
//   node benchmark-embed.js --wrapper --gateway      # specific targets
//   node benchmark-embed.js --tokenize               # test tokenizer performance
// ============================================

const WRAPPER_BASE = 'http://192.168.0.145:4080';
const GATEWAY_URL = 'http://192.168.0.100:3400/v1/embeddings';
const GATEWAY_MODEL = 'or-qwen-embed';

// Direct OpenRouter (bypass Gateway while dimension forwarding is broken)
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/embeddings';
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || '';

// Cloud embedding API (uncomment and configure to benchmark)
// const CLOUD_URL = 'https://api.openai.com/v1/embeddings';
// const CLOUD_MODEL = 'text-embedding-3-large';
// const CLOUD_API_KEY = 'sk-...';

const WRAPPER_HEADERS = {
    'Content-Type': 'application/json',
    'X-Model-Path': 'E:\\\\LM Studio Models\\\\Qwen\\\\Qwen3-Embedding-4B-GGUF\\\\Qwen3-Embedding-4B-Q4_K_M.gguf',
    'X-Model-CtxSize': '32000',
    'X-Model-GpuLayers': '99',
    'X-Model-Embedding': 'true',
    'X-Model-Pooling': 'mean',
    'X-Model-BatchSize': '32000'
};

const GATEWAY_HEADERS = { 'Content-Type': 'application/json' };

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const REAL_WORDS = [
    'function', 'const', 'return', 'import', 'export', 'async', 'await', 'class', 'interface',
    'component', 'render', 'state', 'props', 'handle', 'click', 'event', 'data', 'user',
    'config', 'server', 'request', 'response', 'error', 'debug', 'test', 'build', 'deploy',
    'database', 'query', 'select', 'update', 'delete', 'insert', 'table', 'column', 'index',
    'client', 'service', 'module', 'middleware', 'router', 'handler', 'schema', 'model',
    'application', 'protocol', 'message', 'session', 'token', 'password', 'security',
    'the', 'a', 'is', 'are', 'was', 'were', 'has', 'have', 'will', 'would', 'should', 'can',
    'with', 'from', 'this', 'that', 'these', 'those', 'some', 'many', 'each', 'every', 'all',
    'process', 'method', 'object', 'array', 'string', 'number', 'boolean', 'value', 'type'
];

function generateText(len) {
    const words = [];
    while (words.join(' ').length < len) {
        words.push(REAL_WORDS[Math.floor(Math.random() * REAL_WORDS.length)]);
    }
    return words.join(' ');
}

async function timedFetch(url, headers, body, label) {
    const start = Date.now();
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(body)
        });
        const ms = Date.now() - start;
        if (!res.ok) {
            const err = await res.text().catch(() => 'unknown');
            console.log(`  ${label}: FAILED ${res.status} — ${err.slice(0, 80)}`);
            return null;
        }
        return { ms, data: await res.json() };
    } catch (err) {
        console.log(`  ${label}: FAILED — ${err.message.slice(0, 80)}`);
        return null;
    }
}

// ============================================
// Phase 0: Tokenizer benchmark
// ============================================

async function benchmarkTokenizer() {
    console.log('=== Tokenizer Performance ===\n');

    const texts = [
        generateText(50),
        generateText(500),
        generateText(2000),
        generateText(4000)
    ];

    // Single text tokenization
    console.log('Single text:');
    for (const text of texts) {
        const label = `tokenize ${text.length}c`;
        const result = await timedFetch(`${WRAPPER_BASE}/tokenize`, WRAPPER_HEADERS, { content: text }, label);
        if (result) {
            const tokenCount = Array.isArray(result.tokens) ? result.tokens.length : '?';
            console.log(`  ${label}: ${result.ms}ms (${tokenCount} tokens, ${(text.length / result.ms * 1000 / 1000).toFixed(0)}k chars/s)`);
        }
    }
    console.log('');

    // Batched tokenization
    console.log('Batched tokenization:');
    const batchCounts = [10, 50, 100, 200];
    for (const count of batchCounts) {
        const batchTexts = [];
        for (let i = 0; i < count; i++) batchTexts.push(generateText(500));
        const totalChars = batchTexts.reduce((s, t) => s + t.length, 0);
        const label = `tokenize ${count}×500c`;
        const result = await timedFetch(`${WRAPPER_BASE}/tokenize`, WRAPPER_HEADERS, { content: batchTexts }, label);
        if (result) {
            const tokenArrays = result.tokens;
            const totalTokens = Array.isArray(tokenArrays) ? tokenArrays.reduce((s, t) => s + (Array.isArray(t) ? t.length : 0), 0) : '?';
            console.log(`  ${label}: ${(result.ms / 1000).toFixed(1)}s (${totalChars.toLocaleString()} chars, ${totalTokens} tokens, ${(totalChars / result.ms * 1000 / 1000).toFixed(0)}k chars/s, ${(result.ms / count).toFixed(0)} ms/text)`);
        }
    }
    console.log('');
}

// ============================================
// Route-specific embedding
// ============================================

function formatEmbeddingResult(data, route) {
    if (route === 'gateway') {
        const list = data.data || data;
        return list.map(d => d.embedding);
    }
    if (route === 'llamacpp') {
        return data.map(d => d.embedding);
    }
    // wrapper: [{ embedding: [[vec]] }, ...]
    return data.map(d => {
        if (Array.isArray(d.embedding)) {
            return Array.isArray(d.embedding[0]) ? d.embedding[0] : d.embedding;
        }
        return d.embedding;
    });
}

async function embedTest(route, url, headers, body, label) {
    const result = await timedFetch(url, headers, body, `${route} ${label}`);
    if (!result) return null;
    const embeddings = formatEmbeddingResult(result.data, route);
    const dims = embeddings[0]?.length || 0;
    return { ms: result.ms, count: embeddings.length, dims };
}

// ============================================
// Main
// ============================================

async function main() {
    const args = process.argv.slice(2);
    const testWrapper = args.includes('--wrapper') || (!args.includes('--gateway') && !args.includes('--llamacpp') && !args.includes('--tokenize') && !args.includes('--openrouter'));
    const testGateway = args.includes('--gateway') || (!args.includes('--wrapper') && !args.includes('--llamacpp') && !args.includes('--tokenize') && !args.includes('--openrouter'));
    const testLlamaCpp = args.includes('--llamacpp');
    const testOpenRouter = args.includes('--openrouter');
    const testTokenizer = args.includes('--tokenize') || (!args.some(a => a.startsWith('--')));

    console.log('=== Embedding Pipeline Benchmark ===');

    // Phase 0: Tokenizer
    if (testTokenizer) {
        console.log('');
        await benchmarkTokenizer();
    }

    // Build target list
    const targets = [];
    if (testLlamaCpp) targets.push({
        name: 'llamacpp',
        url: 'http://127.0.0.1:4081/embedding',
        headers: { 'Content-Type': 'application/json' },
        bodyFn: (content) => ({ content }),
        route: 'llamacpp'
    });
    if (testWrapper) targets.push({
        name: 'wrapper',
        url: `${WRAPPER_BASE}/embedding`,
        headers: WRAPPER_HEADERS,
        bodyFn: (content) => ({ content }),
        route: 'wrapper'
    });
    if (testGateway) targets.push({
        name: 'gateway',
        url: GATEWAY_URL,
        headers: GATEWAY_HEADERS,
        bodyFn: (content) => ({ model: 'or-qwen-embed', input: content, dimensions: 2560 }),
        route: 'gateway'
    });
    if (testOpenRouter) targets.push({
        name: 'openrouter',
        url: OPENROUTER_URL,
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENROUTER_KEY}` },
        bodyFn: (content) => ({ model: 'qwen/qwen3-embedding-4b', input: content, dimensions: 2560 }),
        route: 'gateway'
    });

    if (targets.length === 0) {
        console.log('No targets selected. Use --wrapper, --gateway, --llamacpp, or --tokenize');
        return;
    }

    console.log('\nTargets:', targets.map(t => t.name).join(', '));

    // Phase 1: Single-text latency
    console.log('\nPhase 1: Single-text latency');
    for (const t of targets) {
        for (const len of [50, 500, 2000]) {
            const text = generateText(len);
            const result = await embedTest(t.route, t.url, t.headers, t.bodyFn([text]), `${len}c`);
            if (result) console.log(`  ${t.name} ${len}c: ${result.ms}ms, ${result.dims}d`);
        }
    }

    // Phase 2: Batch scaling
    console.log('\nPhase 2: Batch scaling (500c texts)');
    for (const t of targets) {
        for (const count of [10, 50, 100]) {
            const texts = [];
            for (let i = 0; i < count; i++) texts.push(generateText(500));
            const result = await embedTest(t.route, t.url, t.headers, t.bodyFn(texts), `${count}×500c`);
            if (result) console.log(`  ${t.name} ${count}×500c: ${(result.ms / 1000).toFixed(1)}s, ${(result.ms / count).toFixed(0)} ms/text, ${result.count} vec`);
            await sleep(500);
        }
    }

    // Phase 3: Pre-tokenized vs raw text
    console.log('\nPhase 3: Raw text vs pre-tokenized');
    for (const t of targets) {
        const count = 50;
        const rawTexts = [];
        for (let i = 0; i < count; i++) rawTexts.push(generateText(500));

        // Raw text embedding
        const rawResult = await embedTest(t.route, t.url, t.headers, t.bodyFn(rawTexts), `raw ${count}×500c`);
        if (rawResult) console.log(`  ${t.name} raw ${count}×500c: ${(rawResult.ms / 1000).toFixed(1)}s`);

        // Tokenize first, then embed with pre-tokenized IDs
        let preResult = null;
        if (t.name !== 'gateway') {
            // Gateway has no /tokenize — skip pre-tokenized test for gateway
            const tokResult = await timedFetch(`${WRAPPER_BASE}/tokenize`, WRAPPER_HEADERS, { content: rawTexts }, `tokenize ${count}×500c`);
            if (tokResult && tokResult.data.tokens) {
                await sleep(200);
                const preBody = t.bodyFn(tokResult.data.tokens);
                preResult = await embedTest(t.route, t.url, t.headers, preBody, `pre-tok ${count}×500c`);
            }
        } else {
            // For gateway, tokenize via wrapper then embed via gateway
            const tokResult = await timedFetch(`${WRAPPER_BASE}/tokenize`, WRAPPER_HEADERS, { content: rawTexts }, `tokenize ${count}×500c`);
            if (tokResult && tokResult.data.tokens) {
                await sleep(200);
                const preBody = t.bodyFn(tokResult.data.tokens);
                preResult = await embedTest(t.route, t.url, t.headers, preBody, `pre-tok ${count}×500c`);
            }
        }

        if (preResult) {
            const speedup = rawResult ? `(${(rawResult.ms / preResult.ms).toFixed(1)}x faster)` : '';
            console.log(`  ${t.name} pre-tok ${count}×500c: ${(preResult.ms / 1000).toFixed(1)}s ${speedup}`);
        }
    }

    // Phase 4: Concurrency
    console.log('\nPhase 4: Concurrency (50 texts × 500c)');
    for (const t of targets) {
        for (const conc of [1, 2, 4]) {
            const start = Date.now();
            const promises = [];
            for (let i = 0; i < conc; i++) {
                const texts = [];
                for (let j = 0; j < 50; j++) texts.push(generateText(500));
                promises.push((async () => {
                    const result = await timedFetch(t.url, t.headers, t.bodyFn(texts), '');
                    return result ? 50 : 0;
                })());
            }
            const results = await Promise.all(promises);
            const totalTexts = results.reduce((s, r) => s + r, 0);
            const elapsed = (Date.now() - start) / 1000;
            console.log(`  ${t.name} ${conc} concurrent: ${elapsed.toFixed(1)}s wall (${(totalTexts / elapsed).toFixed(0)} texts/s)`);
            await sleep(1000);
        }
    }

    console.log('\n=== Done ===');
}

main().catch(e => { console.error('Benchmark failed:', e.message); process.exit(1); });
