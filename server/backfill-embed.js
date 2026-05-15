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
const nLogger = require('../lib/nlogger-cjs');
const { buildEmbedText, chunkTextForEmbedding, fetchRetry, EMBEDDING_DIMS, BATCH_TOKEN_LIMIT, TOK_CHARS_RATIO, sleep } = require('./embed');

// ============================================
// Config — loaded from server/config.json with env overrides
// ============================================

let cfg = {};
try {
    cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
} catch { /* use defaults */ }

const WRAPPER_BASE = 'http://192.168.0.145:4080';
const GATEWAY_URL = process.env.CHAT_EMBED_URL || cfg.embedUrl || 'http://192.168.0.100:3400/v1/embeddings';
const GATEWAY_MODEL = process.env.CHAT_EMBED_MODEL || cfg.embedModel || null;
const LOGS_DIR = process.env.CHAT_LOGS_DIR || cfg.logsDir || 'server/logs';

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

const NDB_PATH = process.env.CHAT_NDB_PATH || cfg.ndbPath || path.join(__dirname, 'data', 'chat_app', 'data.jsonl');
const NVDB_DIR = process.env.CHAT_NVDB_DIR || cfg.nvdbDir || 'server/data/nvdb';
const PROGRESS_FILE = path.join(path.dirname(NDB_PATH), 'embed-progress.json');
const BATCH_TOKEN_LIMIT_CFG = parseInt(process.env.CHAT_EMBED_BATCH_TOKENS || cfg.embedBatchTokenLimit) || BATCH_TOKEN_LIMIT;

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
        rechunkLarge: false,
        retryFailed: false,
        dryRun: false,
        retries: 3
    };

    for (const arg of args) {
        if (arg === '--gateway') opts.gateway = true;
        else if (arg === '--wrapper') opts.wrapper = true;
        else if (arg === '--openrouter') opts.openrouter = true;
        else if (arg === '--rechunk-large') opts.rechunkLarge = true;
        else if (arg === '--retry-failed') opts.retryFailed = true;
        else if (arg === '--dry-run') opts.dryRun = true;
        else if (arg.startsWith('--batch-size=')) opts.batchSize = parseInt(arg.split('=')[1], 10);
    }

    return opts;
}

// ============================================
// Helpers
// ============================================

function loadProgress() {
    try {
        if (fs.existsSync(PROGRESS_FILE)) return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
    } catch {}
    return {};
}

function saveProgress(data) {
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify(data, null, 2), 'utf8');
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
    const body = { input: texts, dimensions: EMBEDDING_DIMS };
    if (GATEWAY_MODEL) body.model = GATEWAY_MODEL;
    const result = await fetchRetry(GATEWAY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body
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
        body: { model: 'qwen/qwen3-embedding-4b', input: texts, dimensions: EMBEDDING_DIMS }
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

    const logger = await nLogger.init({ logsDir: path.resolve(LOGS_DIR), sessionPrefix: 'embed' });
    logger.info('Embedding pipeline started', { route, mode: opts.retryFailed ? 'retry-failed' : opts.rechunkLarge ? 'rechunk-large' : 'default (skipping existing)', batchSize: opts.batchSize, dryRun: opts.dryRun }, 'Embed');

    const startTime = Date.now();

    const db = nDB.open(NDB_PATH);
    const vdb = new nVDB(NVDB_DIR);

    let col;
    try {
        col = vdb.getCollection('embeddings');
    } catch (err) {
        console.error('getCollection failed:', err);
        col = vdb.createCollection('embeddings', EMBEDDING_DIMS, { durability: 'buffered' });
    }

    const stats = col.stats || { memtableDocs: 0, totalSegmentDocs: 0 };
    const vectorCount = stats.memtableDocs + stats.totalSegmentDocs;

    const docs = db.iter();
    // Gather all messages from conversation documents
    const messages = [];
    for (const c of docs.filter(d => d._type === 'conversation')) {
        if (!c.messages) continue;
        for (const m of c.messages) {
            m._sessionId = c.id; // attach sessionId for buildText
            messages.push(m);
        }
    }
    const sessions = {};
    for (const s of docs.filter(d => d._type === 'session')) sessions[s.id] = s;

    // By default, do not re-embed if vector exists in nVDB or progress file
    const progress = (!opts.rechunkLarge) ? loadProgress() : {};

    let already = 0;
    const todo = [];

    for (const m of messages) {
        if (!opts.rechunkLarge && (col.get(m.id) || progress[m.id])) {
            already++;
        } else {
            todo.push(m);
        }
    }

    // --rechunk-large: specifically target messages that were previously crippled by old middle-truncation
    if (opts.rechunkLarge) {
        const withEst = todo.map(m => {
            const text = buildEmbedText(m, sessions[m._sessionId]);
            return { msg: m, text, tokEst: Math.ceil(text.length / TOK_CHARS_RATIO) };
        });
        const oldLimit = 5000;  // The old threshold where data was destructively deleted
        const affected = withEst.filter(w => w.tokEst > oldLimit);
        todo.length = 0;
        for (const w of affected) todo.push(w.msg);
        const skipped = withEst.length - todo.length;
        logger.info('Rechunk-large mode', { inNVDB: withEst.length, affected: todo.length, unchanged: skipped }, 'Embed');
    }

    // --retry-failed: scan nDB for failed + stale pending messages (ignore nVDB)
    if (opts.retryFailed) {
        const STALE_MS = 5 * 60 * 1000;
        const now = Date.now();
        const failed = messages.filter(m => {
            if (m.embedStatus === 'failed') return true;
            if (m.embedStatus === 'pending' && (now - new Date(m.createdAt).getTime()) > STALE_MS) return true;
            return false;
        });
        already = messages.length - failed.length;
        todo.length = 0;
        for (const m of failed) todo.push(m);
        logger.info('Retry-failed mode', { total: messages.length, failedStale: todo.length, ok: already }, 'Embed');
    }

    logger.info('Embedding stats', { total: messages.length, done: already, todo: todo.length }, 'Embed');

    if (todo.length === 0) {
        logger.info('Nothing to embed — all messages already embedded', {}, 'Embed');
        cleanup();
        return;
    }

    // Pre-build texts and estimate tokens
    const withText = todo.map(m => {
        const text = buildEmbedText(m, sessions[m._sessionId]);
        return { msg: m, text, tokEst: Math.ceil(text.length / TOK_CHARS_RATIO) };
    });

    // Dynamic batch sizing: stay under BATCH_TOKEN_LIMIT
    const batches = [];
    let currentBatch = [], currentTokens = 0;

    for (const originalItem of withText) {
        const chunks = chunkTextForEmbedding(originalItem, logger);
        
        for(const item of chunks) {
            if (currentBatch.length > 0 && currentTokens + item.tokEst > BATCH_TOKEN_LIMIT_CFG) {
                batches.push(currentBatch);
                currentBatch = [];
                currentTokens = 0;
            }

            currentBatch.push(item);
            currentTokens += item.tokEst;
        }
    }
    if (currentBatch.length > 0) batches.push(currentBatch);

    const totalTokEst = batches.reduce((sum, batch) => sum + batch.reduce((s, b) => s + b.tokEst, 0), 0);
    logger.info('Batches', { count: batches.length, totalTokEst: (totalTokEst / 1000).toFixed(0) + 'k', limit: BATCH_TOKEN_LIMIT_CFG }, 'Embed');

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
                    const b = batch[j];
                    const m = b.msg;
                    // Prevent ID collisions in nVDB for split messages
                    const vectorId = b.splitIdx > 0 ? `${m.id}_${b.splitIdx}` : m.id;
                    col.insert(vectorId, embeddings[j], JSON.stringify({
                        chatId: m._sessionId, msgIdx: m.idx, chunk: b.splitIdx, charOffset: b.charOffset
                    }));
                }
            }

            for (const b of batch) {
                // Only mark as fully complete if it is the final chunk
                if (b.isLastChunk) progress[b.msg.id] = true;
            }
            embedded += batch.length;

            col.flush();
        } catch (err) {
            failed += batch.length;
            logger.error(`Batch ${i + 1} failed`, err, { batchTokens, count: batch.length }, 'Embed');
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

    logger.info('Embedding pipeline complete', {
        route,
        embedded,
        failed,
        time: elapsed.toFixed(1),
        speed: (embedded / elapsed).toFixed(1),
        avgBatch: (avgBatchMs / 1000).toFixed(1),
        batches: batchTimes.length
    }, 'Embed');

    if (failed > 0) {
        logger.warn('Some embeddings failed — run again with --retry-failed', { failed }, 'Embed');
    }

    if (!opts.dryRun) {
        col.flush();
    }

    logger.close();
    cleanup();
}

function cleanup() {
    try { fs.unlinkSync(PROGRESS_FILE); } catch {}
}

run().catch(e => {
    console.error('\nFatal:', e.message);
    console.error('Progress saved - rerun the script to continue');
    process.exit(1);
});
