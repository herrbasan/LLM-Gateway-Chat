// ============================================
// Embedding Pipeline — chunked bulk backfill
//
//   node backfill-embed.js                    # embed via Gateway (default, cloud)
//   node backfill-embed.js --wrapper          # embed via Fatten wrapper (direct)
//   node backfill-embed.js --openrouter       # embed via OpenRouter directly
//   node backfill-embed.js --rechunk-large    # re-chunk messages still held as
//                                             #   one whole-document vector
//   node backfill-embed.js --retry-failed     # retry 'failed' / stale 'pending'
//   node backfill-embed.js --concurrency=2    # max embedding requests in flight
//
// Chunking contract (2026-10-03): the embedding box runs ONE slot and prefill
// cost is quadratic in input length, so a 20k-token request decays to ~60 tok/s
// (6-8 min) and queues every interactive lookup behind it, while ~1k-token
// requests run at ~600 tok/s. This job therefore never sends more than
// CHUNK_TOKENS_CFG per input and packs several chunks per request, bounded by
// REQUEST_TOKENS_CFG and --concurrency. Measured on Qwen3-Embedding-4B (f16):
//   ~1k tokens   -> ~600 tok/s -> ~2 s per embed
//   ~3.4k tokens -> ~580 tok/s -> ~6 s per embed
//   ~20k tokens  -> ~62 tok/s  -> 6-8 min per embed
// ============================================

const fs = require('fs');
const path = require('path');
const { Database: nDB } = require('../lib/ndb/napi');
const { Database: nVDB } = require('../lib/nvdb/napi');
const nLogger = require('../lib/nlogger-cjs');
const { buildEmbedText, splitTextIntoChunks, minEmbedChunkCount, planEmbedBatches, embedVectorId, fetchRetry, EMBEDDING_DIMS, TOK_CHARS_RATIO, EMBED_CHUNK_TOKENS, EMBED_CHUNK_OVERLAP_TOKENS, EMBED_MAX_INPUT_TOKENS, EMBED_REQUEST_TOKENS, EMBED_MAX_CONCURRENCY, sleep } = require('./embed');

// Load minimal .env natively (same loader as server.js). Without it the default
// Gateway route has no GATEWAY_API_KEY and every request 401s — which is why
// this script only ever worked through --wrapper before.
try {
    const envStr = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
    for (const line of envStr.split('\n')) {
        const match = line.match(/^\s*([\w_]+)\s*=\s*(.*)?\s*$/);
        if (match) {
            const key = match[1];
            let val = match[2] || '';
            val = val.replace(/\s*#.*$/, ''); // strip trailing comments
            val = val.replace(/^(['"])(.*)\1$/, '$2').trim(); // strip quotes
            if (!(key in process.env)) process.env[key] = val;
        }
    }
} catch (e) { /* ignore missing .env */ }

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
const EMBED_API_KEY = process.env.GATEWAY_API_KEY || cfg.embedApiKey || null;

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
const CHUNK_TOKENS_CFG = Math.max(64, parseInt(process.env.CHAT_EMBED_CHUNK_TOKENS || cfg.embedChunkTokens) || EMBED_CHUNK_TOKENS);
// Overlap is the one setting where an explicit 0 is meaningful, so it is read
// without the `|| default` shortcut that would turn 0 into the default.
const _overlapCfg = process.env.CHAT_EMBED_CHUNK_OVERLAP_TOKENS ?? cfg.embedChunkOverlapTokens;
const OVERLAP_TOKENS_CFG = _overlapCfg === undefined || _overlapCfg === null
    ? EMBED_CHUNK_OVERLAP_TOKENS
    : Math.max(0, parseInt(_overlapCfg) || 0);
const MAX_INPUT_TOKENS_CFG = Math.min(Math.max(CHUNK_TOKENS_CFG, parseInt(process.env.CHAT_EMBED_MAX_INPUT_TOKENS || cfg.embedMaxInputTokens) || EMBED_MAX_INPUT_TOKENS), 32768);
// Hard-clamped: a stale 29k value in config must not resurrect whole-document
// requests — that is what queued the embedding box for hours on 2026-10-03.
const REQUEST_TOKENS_CFG = Math.min(Math.max(MAX_INPUT_TOKENS_CFG, parseInt(process.env.CHAT_EMBED_REQUEST_TOKENS || cfg.embedRequestTokenLimit) || EMBED_REQUEST_TOKENS), 8192);

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
        concurrency: 1,
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
        else if (arg.startsWith('--concurrency=')) opts.concurrency = parseInt(arg.split('=')[1], 10);
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
    const headers = { 'Content-Type': 'application/json' };
    if (EMBED_API_KEY) headers['Authorization'] = `Bearer ${EMBED_API_KEY}`;
    const result = await fetchRetry(GATEWAY_URL, {
        method: 'POST',
        headers,
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
    let toolSkipped = 0;
    for (const c of docs.filter(d => d._type === 'conversation')) {
        if (!c.messages) continue;
        for (const m of c.messages) {
            // Tool payloads are deliberately not indexed — same rule as
            // embedMessageAsync and the startup reconciliation. They are huge
            // JSON blobs: embedding them wastes box time and pollutes search.
            if (m.role === 'tool') { toolSkipped++; continue; }
            m._sessionId = c.id; // attach sessionId for buildText
            messages.push(m);
        }
    }
    const sessions = {};
    for (const s of docs.filter(d => d._type === 'session')) sessions[s.id] = s;

    // Build the embed text once per message: the chunker, the size estimate and
    // the request planner all work off this.
    const withText = messages.map(m => {
        const text = buildEmbedText(m, sessions[m._sessionId]);
        return { msg: m, text, tokEst: Math.ceil(text.length / TOK_CHARS_RATIO) };
    });
    const chunkOpts = { chunkTokens: CHUNK_TOKENS_CFG, tokRatio: TOK_CHARS_RATIO, overlapTokens: OVERLAP_TOKENS_CFG };

    // Default runs heal genuine gaps only: a message with no vector at all (or
    // one the progress file already vouches for). Upgrading an already-embedded
    // message to chunked vectors is a deliberate pass (--rechunk-large), not
    // something every run decides to redo — that would re-embed the whole long
    // archive on every invocation.
    const progress = (!opts.rechunkLarge) ? loadProgress() : {};

    let already = 0;
    let todo = [];

    if (opts.rechunkLarge) {
        // Messages already embedded but held as one whole-document vector, i.e.
        // too long to be a single chunk — exactly what the old pipeline sent as
        // one huge request (or middle-truncated past 25k tokens).
        todo = withText.filter(w => col.get(w.msg.id) && minEmbedChunkCount(w.text, chunkOpts) > 1);
        already = withText.length - todo.length;
        logger.info('Rechunk-large mode', { total: withText.length, needsChunking: todo.length, unchanged: already }, 'Embed');
    } else if (opts.retryFailed) {
        const STALE_MS = 5 * 60 * 1000;
        const now = Date.now();
        todo = withText.filter(({ msg: m }) => {
            if (m.embedStatus === 'failed') return true;
            if (m.embedStatus === 'pending' && (now - new Date(m.createdAt).getTime()) > STALE_MS) return true;
            return false;
        });
        already = withText.length - todo.length;
        logger.info('Retry-failed mode', { total: withText.length, failedStale: todo.length, ok: already }, 'Embed');
    } else {
        for (const w of withText) {
            if (col.get(w.msg.id) || progress[w.msg.id]) already++;
            else todo.push(w);
        }
        logger.info('Gap heal', { gaps: todo.length, alreadyEmbedded: already }, 'Embed');
    }

    logger.info('Embedding stats', { total: messages.length, toolsSkipped: toolSkipped, done: already, todo: todo.length }, 'Embed');

    if (todo.length === 0) {
        logger.info('Nothing to embed — all messages already embedded', {}, 'Embed');
        cleanup();
        return;
    }

    // Chunk every message, then pack the chunks into small requests. ~1k-token
    // inputs run at ~600 tok/s on the box; 20k-token inputs at ~60.
    const chunkItems = [];
    const needChunks = new Map();
    for (const w of todo) {
        const chunks = splitTextIntoChunks(w.text, chunkOpts);
        let charOffset = 0;
        for (let splitIdx = 0; splitIdx < chunks.length; splitIdx++) {
            const c = chunks[splitIdx];
            chunkItems.push({ msg: w.msg, text: c.text, tokEst: c.tokEst, splitIdx, charOffset });
            charOffset += c.text.length;
        }
        needChunks.set(w.msg.id, chunks.length);
    }

    const batches = planEmbedBatches(chunkItems, { maxRequestTokens: REQUEST_TOKENS_CFG });

    const totalTokEst = chunkItems.reduce((sum, c) => sum + c.tokEst, 0);
    const largestInput = chunkItems.reduce((max, c) => Math.max(max, c.tokEst), 0);
    logger.info('Batches', {
        messages: todo.length,
        chunks: chunkItems.length,
        batches: batches.length,
        totalTokEst: (totalTokEst / 1000).toFixed(0) + 'k',
        chunkTokens: CHUNK_TOKENS_CFG,
        requestTokens: REQUEST_TOKENS_CFG,
        largestInput,
        concurrency: Math.min(Math.max(1, opts.concurrency || 1), EMBED_MAX_CONCURRENCY)
    }, 'Embed');

    const CONCURRENCY = Math.min(Math.max(1, opts.concurrency || 1), EMBED_MAX_CONCURRENCY);
    let embedded = 0;   // chunks embedded
    let failed = 0;     // chunks failed
    const batchTimes = [];
    const doneChunks = new Map();
    let nextBatch = 0;
    let completedBatches = 0;
    const wallStart = Date.now();

    async function runBatch(i, batch) {
        const texts = batch.map(b => b.text);
        const batchTokens = batch.reduce((s, b) => s + b.tokEst, 0);
        const batchStart = Date.now();

        let embeddings = null;
        let batchTexts = texts.slice();

        try {
            for (let truncAttempt = 0; truncAttempt <= 2; truncAttempt++) {
                try {
                    // opts.retries drives fetchRetry's own backoff — a batch that
                    // fails on a busy/timeout blip must not silently drop work.
                    embeddings = opts.dryRun
                        ? batchTexts.map(() => new Array(EMBEDDING_DIMS).fill(0))
                        : await embedFn(batchTexts, opts.retries);
                    break;
                } catch (err) {
                    // A chunk that still overflows the box is a token-ratio miss,
                    // not a content problem: shrink it and try again.
                    if (err.message.includes('too large') && truncAttempt < 2) {
                        const shrink = t => t.slice(0, Math.floor(t.length * 0.65));
                        batchTexts = batchTexts.length === 1 ? [shrink(batchTexts[0])] : batchTexts.map(shrink);
                        logger.warn('Chunk too large — shrunk for retry', { batch: i + 1, chars: batchTexts[0].length, attempt: truncAttempt + 1 }, 'Embed');
                        continue;
                    }
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
                    // One vector per chunk: chunk 0 keeps the bare message id, so
                    // single-chunk messages are indistinguishable from before.
                    col.insert(embedVectorId(m.id, b.splitIdx), embeddings[j], JSON.stringify({
                        chatId: m._sessionId, msgIdx: m.idx, chunk: b.splitIdx, charOffset: b.charOffset
                    }));
                }
            }

            for (const b of batch) {
                // Mark complete only once every chunk of the message landed: with
                // concurrent batches, "the last chunk finished" proves nothing
                // about the earlier ones.
                const id = b.msg.id;
                const done = (doneChunks.get(id) || 0) + 1;
                doneChunks.set(id, done);
                if (done >= needChunks.get(id)) progress[id] = true;
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

        completedBatches++;
        const wallSec = (Date.now() - wallStart) / 1000;
        const rate = wallSec > 0 ? (embedded / wallSec).toFixed(1) : '0';
        const remaining = chunkItems.length - embedded;
        const eta = remaining > 0 && embedded > 0
            ? ((remaining / (embedded / wallSec)) / 60).toFixed(1) + 'min'
            : 'done';

        process.stdout.write(
            `\r  chunks ${embedded}/${chunkItems.length} | Failed: ${failed} | ` +
            `Batch ${completedBatches}/${batches.length} ${(batchMs / 1000).toFixed(1)}s ` +
            `(${batchTokens}tk, ${rate} chunk/s) | ETA: ${eta}   `
        );
    }

    // Bounded fan-out: the box has ONE embedding slot, so extra workers only keep
    // its queue fed — they do not add throughput.
    await Promise.all(Array.from(
        { length: Math.min(CONCURRENCY, batches.length) },
        async () => {
            while (nextBatch < batches.length) {
                const idx = nextBatch++;
                await runBatch(idx, batches[idx]);
            }
        }
    ));
    process.stdout.write('\n');

    const elapsed = (Date.now() - startTime) / 1000;
    const avgBatchMs = batchTimes.reduce((a, b) => a + b, 0) / batchTimes.length;

    logger.info('Embedding pipeline complete', {
        route,
        messages: todo.length,
        chunksEmbedded: embedded,
        chunksFailed: failed,
        time: elapsed.toFixed(1),
        chunksPerSec: (embedded / elapsed).toFixed(1),
        avgBatch: (avgBatchMs / 1000).toFixed(1),
        batches: batchTimes.length
    }, 'Embed');

    if (failed > 0) {
        logger.warn('Some embeddings failed — run again with --retry-failed', { chunksFailed: failed }, 'Embed');
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
