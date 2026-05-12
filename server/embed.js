// ============================================
// Embedding Pipeline — Direct text embedding
//
//   node embed.js                            # embed via Gateway (default, cloud)
//   node embed.js --wrapper                   # embed via Fatten wrapper (backup)
//   node embed.js --openrouter                # embed via OpenRouter directly
//
// Benchmarks (Qwen3-4B, 500c real text):
//   50 texts: ~5.5s (110ms/text) — tokenization not a bottleneck
//   Throughput: 9 texts/sec (wrapper serializes)
// ============================================

const fs = require('fs');
const path = require('path');
const { Database: nDB } = require('../lib/ndb/napi');
const { Database: nVDB } = require('../lib/nvdb/napi');

// ============================================
// Config
// ============================================

const WRAPPER_BASE = 'http://192.168.0.145:4080';
const GATEWAY_URL = 'http://192.168.0.100:3400/v1/embeddings';
const GATEWAY_MODEL = 'or-qwen-embed';

// Direct OpenRouter (while Gateway dimension forwarding is broken)
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/embeddings';
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || '';

const MODEL_HEADERS = {
    'Content-Type': 'application/json',
    'X-Model-Path': 'E:\\\\LM Studio Models\\\\Qwen\\\\Qwen3-Embedding-4B-GGUF\\\\Qwen3-Embedding-4B-Q4_K_M.gguf',
    'X-Model-CtxSize': '32000',
    'X-Model-GpuLayers': '99',
    'X-Model-Embedding': 'true',
    'X-Model-Pooling': 'mean',
    'X-Model-BatchSize': '32000'
};

const DATA_DIR = path.join(__dirname, 'data');
const NDB_PATH = path.join(DATA_DIR, 'chat_app');
const NVDB_DIR = path.join(DATA_DIR, 'nvdb');
const PROGRESS_FILE = path.join(DATA_DIR, 'embed-progress.json');
const EMBEDDING_DIMS = 2560;
const BATCH_TOKEN_LIMIT = 5500;
const MAX_SINGLE_TEXT_TOKENS = 5000;

// ============================================
// CLI
// ============================================

function parseArgs() {
    const args = process.argv.slice(2);
    const opts = {
        gateway: false,
        wrapper: false,
        openrouter: false,
        batchSize: 100,
        resume: false,
        dryRun: false,
        retries: 3
    };

    for (const arg of args) {
        if (arg === '--gateway') opts.gateway = true;
        else if (arg === '--wrapper') opts.wrapper = true;
        else if (arg === '--openrouter') opts.openrouter = true;
        else if (arg === '--resume') opts.resume = true;
        else if (arg === '--dry-run') opts.dryRun = true;
        else if (arg.startsWith('--batch-size=')) opts.batchSize = parseInt(arg.split('=')[1], 10);
    }

    return opts;
}

// ============================================
// Helpers
// ============================================

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function loadProgress() {
    try {
        if (fs.existsSync(PROGRESS_FILE)) return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
    } catch {}
    return {};
}

function saveProgress(data) {
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function buildText(msg, session) {
    const parts = [];
    if (session.mode === 'arena') {
        parts.push(`[Arena: ${(session.title || '').slice(0, 60)}]`);
        if (msg.speaker) parts.push(`[${msg.speaker}]`);
    } else {
        parts.push(`[Chat: ${(session.title || '').slice(0, 60)}]`);
        parts.push(`[${msg.role}]`);
    }
    if (msg.model) parts.push(`[${msg.model}]`);
    parts.push(msg.content || '');
    return parts.join(' ');
}

async function fetchRetry(url, options, retries) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const res = await fetch(url, { ...options, body: JSON.stringify(options.body) });
            if (!res.ok) {
                const err = await res.text().catch(() => 'unknown');
                throw new Error(`${res.status}: ${err.slice(0, 200)}`);
            }
            const data = await res.json();
            if (data.error) {
                throw new Error(data.error.message || JSON.stringify(data.error).slice(0, 200));
            }
            return data;
        } catch (err) {
            lastErr = err;
            if (attempt < retries) {
                const wait = Math.min(1000 * Math.pow(2, attempt), 10000);
                console.log(`\n  Retry ${attempt + 1}/${retries} in ${wait / 1000}s...`);
                await sleep(wait);
            }
        }
    }
    throw lastErr;
}

// ============================================
// Embed functions (wrapper or gateway)
// ============================================

async function embedViaWrapper(texts, retries) {
    const result = await fetchRetry(`${WRAPPER_BASE}/embedding`, {
        method: 'POST',
        headers: MODEL_HEADERS,
        body: { content: texts }
    }, retries);

    return result.map(d => {
        if (Array.isArray(d.embedding)) {
            return Array.isArray(d.embedding[0]) ? d.embedding[0] : d.embedding;
        }
        return d.embedding;
    });
}

async function embedViaGateway(texts, retries) {
    const result = await fetchRetry(GATEWAY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { model: GATEWAY_MODEL, input: texts }
    }, retries);

    const data = result.data || result;
    const sorted = [...data].sort((a, b) => (a.index || 0) - (b.index || 0));
    return sorted.map(d => d.embedding);
}

async function embedViaOpenRouter(texts, retries) {
    const result = await fetchRetry(OPENROUTER_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${OPENROUTER_KEY}`
        },
        body: { model: 'qwen/qwen3-embedding-4b', input: texts, dimensions: 2560 }
    }, retries);

    if (result.error) {
        throw new Error(`OpenRouter: ${result.error.message || JSON.stringify(result.error).slice(0, 150)}`);
    }
    if (!result.data || !Array.isArray(result.data)) {
        throw new Error(`Unexpected OpenRouter response: ${JSON.stringify(result).slice(0, 200)}`);
    }
    return result.data.map(d => d.embedding);
}

// ============================================
// Main
// ============================================

async function run() {
    const opts = parseArgs();
    const embedFn = opts.openrouter ? embedViaOpenRouter : opts.wrapper ? embedViaWrapper : embedViaGateway;
    const route = opts.openrouter ? 'OpenRouter' : opts.wrapper ? 'Wrapper' : 'Gateway';

    console.log('=== Embedding Pipeline ===');
    console.log('Route:', route);
    console.log('Batch size:', opts.batchSize);
    console.log('Dry run:', opts.dryRun);
    console.log('');

    const startTime = Date.now();

    const db = nDB.open(NDB_PATH);
    const vdb = new nVDB(NVDB_DIR);

    let col;
    try {
        col = vdb.getCollection('embeddings');
    } catch {
        col = vdb.createCollection('embeddings', EMBEDDING_DIMS, { durability: 'buffered' });
    }

    const docs = db.iter();
    const messages = docs.filter(d => d._type === 'message');
    const sessions = {};
    for (const s of docs.filter(d => d._type === 'session')) sessions[s.id] = s;

    const progress = opts.resume ? loadProgress() : {};

    let already = 0;
    const todo = [];

    for (const m of messages) {
        if (col.get(m.id) || progress[m.id]) {
            already++;
        } else {
            todo.push(m);
        }
    }

    console.log('Total:', messages.length, '| Done:', already, '| Todo:', todo.length);
    console.log('');

    if (todo.length === 0) {
        console.log('All done!');
        cleanup();
        return;
    }

    // Pre-build texts and estimate tokens
    const withText = todo.map(m => {
        const text = buildText(m, sessions[m.sessionId]);
        return { msg: m, text, tokEst: Math.ceil(text.length / 4) };
    });

    // Dynamic batch sizing: stay under BATCH_TOKEN_LIMIT
    const batches = [];
    let currentBatch = [], currentTokens = 0;

    for (const item of withText) {
        if (item.tokEst > MAX_SINGLE_TEXT_TOKENS) {
            item.text = item.text.slice(0, MAX_SINGLE_TEXT_TOKENS * 4);
            item.tokEst = MAX_SINGLE_TEXT_TOKENS;
        }

        if (currentBatch.length > 0 && currentTokens + item.tokEst > BATCH_TOKEN_LIMIT) {
            batches.push(currentBatch);
            currentBatch = [];
            currentTokens = 0;
        }

        currentBatch.push(item);
        currentTokens += item.tokEst;
    }
    if (currentBatch.length > 0) batches.push(currentBatch);

    const totalTokEst = withText.reduce((s, t) => s + t.tokEst, 0);
    console.log('Batches:', batches.length, `(~${(totalTokEst / 1000).toFixed(0)}k tokens total, ${BATCH_TOKEN_LIMIT} limit/batch)\n`);

    let embedded = 0;
    let failed = 0;
    const batchTimes = [];

    for (let i = 0; i < batches.length; i++) {
        const batch = batches[i];
        const texts = batch.map(b => b.text);
        const batchTokens = batch.reduce((s, b) => s + b.tokEst, 0);
        const batchStart = Date.now();

        let embeddings = null;
        let batchTexts = texts.slice();

        try {
            for (let truncAttempt = 0; truncAttempt <= 2; truncAttempt++) {
                try {
                    embeddings = opts.dryRun
                        ? batchTexts.map(() => new Array(EMBEDDING_DIMS).fill(0))
                        : await embedFn(batchTexts, 0); // no inner retry, we handle retry
                    break;
                } catch (err) {
                    // Progressive truncation for "too large" errors on single-text batches
                    if (batch.length === 1 && err.message.includes('too large') && truncAttempt < 2) {
                        const prevLen = batchTexts[0].length;
                        batchTexts[0] = batchTexts[0].slice(0, Math.floor(prevLen * 0.65));
                        continue;
                    }
                    // On last attempt (or multi-text batch), rethrow
                    if (truncAttempt === 2) throw err;
                    throw err;
                }
            }

            if (!embeddings) throw new Error('No embeddings returned');
            if (embeddings.length !== batch.length) {
                throw new Error(`Expected ${batch.length} embeddings, got ${embeddings.length}`);
            }

            if (!opts.dryRun) {
                for (let j = 0; j < batch.length; j++) {
                    const m = batch[j].msg;
                    col.insert(m.id, embeddings[j], JSON.stringify({
                        messageId: m.id, sessionId: m.sessionId,
                        role: m.role, model: m.model, turnIndex: m.turnIndex
                    }));
                }
            }

            for (const b of batch) progress[b.msg.id] = true;
            embedded += batch.length;

            col.flush();
        } catch (err) {
            failed += batch.length;
            console.log(`\nBatch ${i + 1} FAILED: ${err.message.slice(0, 120)}`);
        }

        const batchMs = Date.now() - batchStart;
        batchTimes.push(batchMs);
        saveProgress(progress);

        const avgMs = batchTimes.reduce((a, b) => a + b, 0) / batchTimes.length;
        const eta = batches.length - (i + 1) > 0
            ? ((avgMs * (batches.length - i - 1)) / 1000).toFixed(0) + 's'
            : 'done';

        process.stdout.write(
            `\r  ${embedded}/${todo.length} | Failed: ${failed} | ` +
            `Batch ${i + 1}/${batches.length} ${(batchMs / 1000).toFixed(1)}s ` +
            `(${batchTokens}tk, ${(batch.length / batchMs * 1000).toFixed(0)} msg/s) | ETA: ${eta}`
        );
    }

    const elapsed = (Date.now() - startTime) / 1000;
    const avgBatchMs = batchTimes.reduce((a, b) => a + b, 0) / batchTimes.length;

    console.log('\n\n=== Summary ===');
    console.log('Route:', route);
    console.log('Embedded:', embedded);
    console.log('Failed:', failed);
    console.log('Time:', elapsed.toFixed(1), 's');
    console.log('Speed:', (embedded / elapsed).toFixed(1), 'msg/sec');
    console.log('Avg batch:', (avgBatchMs / 1000).toFixed(1), 's');
    console.log('Batches:', batchTimes.length, '| Failed batches:', failed ? Math.round(failed / (embedded ? embedded / batchTimes.length : 1)) : 0);

    if (batchTimes.length > 1) {
        const sorted = [...batchTimes].sort((a, b) => a - b);
        const p50 = sorted[Math.floor(sorted.length * 0.5)];
        const p95 = sorted[Math.floor(sorted.length * 0.95)];
        console.log('Batch P50:', (p50 / 1000).toFixed(1), 's  P95:', (p95 / 1000).toFixed(1), 's');
    }

    if (!opts.dryRun) {
        col.flush();
        console.log('nVDB docs:', col.stats?.memtableDocs || col.stats?.documentCount || '?');
    }

    cleanup();
}

function cleanup() {
    try { fs.unlinkSync(PROGRESS_FILE); } catch {}
}

run().catch(e => {
    console.error('\nFatal:', e.message);
    console.error('Progress saved — rerun with --resume to continue');
    process.exit(1);
});
