/**
 * Overnight multi-user backfill for the shared nVDB v2 daemon (`nvdb serve`).
 *
 *   node server/backfill-embed.js --probe
 *   node server/backfill-embed.js                          # sync + vectors + check
 *   node server/backfill-embed.js --user=chat_user --dry-run
 *   node server/backfill-embed.js --no-check               # overnight, verify later
 *
 * Three resumable steps, each safe to interrupt:
 *   1  lexical sync   — upsert/delete v2 docs so keyword search is live at once
 *   2  vector drain   — pending_embeddings -> embed -> ONE attach_vectors per
 *                       buffered batch. nVDB#3: every attach_vectors call
 *                       rewrites vectors.bin atomically, so per-message or
 *                       per-8-vector calls collapse overnight throughput;
 *                       256-512 vectors per call keeps it flat.
 *   3  integrity check — expected docs + vectors must come back clean.
 *
 * Read-only on nDB: every user DB is opened with persistence 'lazy', read into
 * memory, and closed immediately. `llm_chat` may be writing concurrently — this
 * script never writes data.jsonl.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const { Database: nDB } = require('../lib/ndb/napi');
const { createV2Client, NvdbHttpError } = require('./nvdb-v2-client');
const { chatCollectionConfig, buildChatVectorInput, buildUserExpectedDocs } = require('./nvdb-chat');
const { gatewayIdentityHeaders } = require('./gateway-identity');
const {
    EMBEDDING_DIMS: DEFAULT_EMBED_DIMS,
    EMBED_CHUNK_TOKENS,
    EMBED_CHUNK_OVERLAP_TOKENS,
    TOK_CHARS_RATIO
} = require('./embed');

// Load minimal .env natively (same loader as server.js).
try {
    const envStr = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    for (const line of envStr.split('\n')) {
        const match = line.match(/^\s*([\w_]+)\s*=\s*(.*)?\s*$/);
        if (match) {
            const key = match[1];
            let val = match[2] || '';
            val = val.replace(/\s*#.*$/, '');
            val = val.replace(/^(['"])(.*)\1$/, '$2').trim();
            if (!(key in process.env)) process.env[key] = val;
        }
    }
} catch { /* no .env — env vars are the only source */ }

let cfg = {};
try {
    cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
} catch { /* defaults below */ }

const USERS_DB_PATH = process.env.CHAT_USERS_DB || cfg.usersDbPath || 'server/data/users_db/data.jsonl';
const NVDB_URL = process.env.CHAT_NVDB_URL || cfg.nvdbUrl || 'http://127.0.0.1:3510';
const NVDB_COLLECTION = process.env.CHAT_NVDB_COLLECTION || cfg.nvdbCollection || 'chat';
const EMBED_URL = process.env.CHAT_EMBED_URL || cfg.embedUrl || 'http://192.168.0.100:3400/v1/embeddings';
const EMBEDDING_DIMS = parseInt(process.env.CHAT_EMBED_DIMS || cfg.embedDims, 10) || DEFAULT_EMBED_DIMS;
const EMBED_MODEL_VERSION = process.env.CHAT_EMBED_MODEL_VERSION || cfg.embedModelVersion || 'qwen3-embedding-4b';
const EMBED_API_KEY = process.env.EMBED_API_KEY || process.env.GATEWAY_API_KEY || cfg.embedApiKey || null;

// Overlap is the one setting where an explicit 0 is meaningful, so it is read
// without the `|| default` shortcut that would turn 0 into the default.
const _overlapCfg = process.env.CHAT_EMBED_CHUNK_OVERLAP_TOKENS ?? cfg.embedChunkOverlapTokens;
const CHUNK_OPTS = {
    chunkTokens: Math.max(64, parseInt(process.env.CHAT_EMBED_CHUNK_TOKENS || cfg.embedChunkTokens, 10) || EMBED_CHUNK_TOKENS),
    overlapTokens: _overlapCfg === undefined || _overlapCfg === null
        ? EMBED_CHUNK_OVERLAP_TOKENS
        : Math.max(0, parseInt(_overlapCfg, 10) || 0),
    tokRatio: parseFloat(process.env.CHAT_EMBED_TOK_RATIO || cfg.embedTokRatio) || TOK_CHARS_RATIO
};

const EMBED_TIMEOUT_MS = 180_000;
const EMBED_RETRY_BASE_MS = 1_000;
const NVDB_TIMEOUT_MS = 120_000;
const MAX_STALE_ROUNDS = 5;

function log(msg) {
    console.log(`[${new Date().toISOString()}] [backfill] ${msg}`);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function resolveRootPath(p) {
    if (typeof p !== 'string' || !p.trim()) {
        throw new Error(`Path is required (got ${JSON.stringify(p)})`);
    }
    return path.isAbsolute(p) ? p : path.resolve(ROOT, p);
}

// ============================================
// CLI
// ============================================

function positiveInt(arg, name) {
    const raw = arg.slice(arg.indexOf('=') + 1);
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`Invalid --${name}=${raw}: expected a positive integer`);
    }
    return value;
}

function parseArgs(argv) {
    const opts = {
        probe: false,
        user: null,
        batch: 8,
        attachBatch: 256,
        upsertBatch: 200,
        sync: true,
        embed: true,
        check: true,
        dryRun: false,
        retries: 3
    };

    for (const arg of argv) {
        if (arg === '--probe') opts.probe = true;
        else if (arg === '--no-sync') opts.sync = false;
        else if (arg === '--no-embed') opts.embed = false;
        else if (arg === '--no-check') opts.check = false;
        else if (arg === '--dry-run') opts.dryRun = true;
        else if (arg.startsWith('--user=')) opts.user = arg.slice('--user='.length).trim();
        else if (arg.startsWith('--batch=')) opts.batch = positiveInt(arg, 'batch');
        else if (arg.startsWith('--attach-batch=')) opts.attachBatch = positiveInt(arg, 'attach-batch');
        else if (arg.startsWith('--upsert-batch=')) opts.upsertBatch = positiveInt(arg, 'upsert-batch');
        else if (arg.startsWith('--retries=')) {
            const value = Number(arg.slice('--retries='.length));
            if (!Number.isInteger(value) || value < 0) {
                throw new Error(`Invalid ${arg}: expected a non-negative integer`);
            }
            opts.retries = value;
        } else {
            throw new Error(`Unknown argument: ${arg}`);
        }
    }

    if (opts.user === '') {
        throw new Error('--user requires a value (id or username)');
    }
    return opts;
}

// ============================================
// Embedding over the gateway
// ============================================

async function embedRequest(texts) {
    const headers = { 'Content-Type': 'application/json', ...gatewayIdentityHeaders() };
    if (EMBED_API_KEY) headers.Authorization = `Bearer ${EMBED_API_KEY}`;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), EMBED_TIMEOUT_MS);
    let res;
    try {
        res = await fetch(EMBED_URL, {
            method: 'POST',
            headers,
            body: JSON.stringify({ input: texts, dimensions: EMBEDDING_DIMS }),
            signal: ctrl.signal
        });
    } catch (err) {
        if (err.name === 'AbortError') {
            throw new Error(`embed ${EMBED_URL} timed out after ${EMBED_TIMEOUT_MS}ms`);
        }
        throw new Error(`embed ${EMBED_URL} unreachable: ${err.message}`);
    } finally {
        clearTimeout(timer);
    }

    const raw = await res.text();
    if (!res.ok) {
        const err = new Error(`embed ${EMBED_URL} (${res.status}): ${raw.slice(0, 300)}`);
        err.status = res.status;
        throw err;
    }

    let data;
    try {
        data = JSON.parse(raw);
    } catch {
        throw new Error(`embed ${EMBED_URL} returned non-JSON: ${raw.slice(0, 200)}`);
    }

    const items = Array.isArray(data) ? data : data?.data;
    if (!Array.isArray(items)) {
        throw new Error(`embed ${EMBED_URL} response has no data[]: ${raw.slice(0, 200)}`);
    }

    const vectors = [...items].sort((a, b) => (a?.index ?? 0) - (b?.index ?? 0)).map(d => d?.embedding);
    if (vectors.length !== texts.length) {
        throw new Error(`embed returned ${vectors.length} vectors for ${texts.length} inputs`);
    }
    for (let i = 0; i < vectors.length; i++) {
        const vector = vectors[i];
        const dims = Array.isArray(vector) ? vector.length : typeof vector;
        if (dims !== EMBEDDING_DIMS) {
            throw new Error(`embed vector ${i} has ${dims} dims, expected ${EMBEDDING_DIMS}`);
        }
    }
    return vectors;
}

/** Retries transient failures only: network faults, timeouts, 408/429/5xx. */
async function embedViaGateway(texts, retries) {
    const attempts = Math.max(1, retries + 1);
    for (let attempt = 1; ; attempt++) {
        try {
            return await embedRequest(texts);
        } catch (err) {
            const transient = err.status === undefined || err.status === 408 || err.status === 429 || err.status >= 500;
            if (!transient || attempt >= attempts) throw err;
            const delay = EMBED_RETRY_BASE_MS * 2 ** (attempt - 1);
            log(`embed attempt ${attempt}/${attempts} failed (${err.message}) — retrying in ${delay}ms`);
            await sleep(delay);
        }
    }
}

// ============================================
// Users
// ============================================

function loadTargetUsers(filter) {
    const usersDb = nDB.open(resolveRootPath(USERS_DB_PATH), { persistence: 'lazy' });
    let rows;
    try {
        rows = usersDb.find('_type', 'user');
    } finally {
        usersDb.close();
    }

    const byId = new Map();
    const broken = [];
    for (const row of rows) {
        if (!row?.id || !row.dbPath) {
            broken.push(row?.username || row?.id || row?._id || '(unknown)');
            continue;
        }
        if (!byId.has(row.id)) {
            byId.set(row.id, { id: row.id, username: row.username || null, dbPath: row.dbPath });
        }
    }

    const all = [...byId.values()];
    if (!filter) {
        if (broken.length > 0) {
            throw new Error(`users_db entries without id or dbPath: ${broken.join(', ')} — cannot locate their data`);
        }
        if (all.length === 0) throw new Error(`No users found in ${USERS_DB_PATH}`);
        return all;
    }

    const matched = all.filter(u => u.id === filter || u.username === filter);
    if (matched.length === 0) {
        const known = all.map(u => (u.username ? `${u.username} (${u.id})` : u.id)).join(', ') || 'none';
        throw new Error(`--user=${filter} matched no user in ${USERS_DB_PATH} (known: ${known})`);
    }
    return matched;
}

function readUserDocs(user) {
    const ndbPath = path.join(resolveRootPath(user.dbPath), 'data.jsonl');
    const db = nDB.open(ndbPath, { persistence: 'lazy' });
    try {
        return buildUserExpectedDocs({ userId: user.id, db, chunkOpts: CHUNK_OPTS });
    } finally {
        db.close();
    }
}

// ============================================
// Probe
// ============================================

async function runProbe() {
    const client = createV2Client(NVDB_URL, { timeoutMs: NVDB_TIMEOUT_MS });

    const tHealth = Date.now();
    const health = await client.health();
    const healthMs = Date.now() - tHealth;

    const tSingle = Date.now();
    const single = await embedViaGateway(['nVDB v2 chat backfill probe'], 0);
    const singleMs = Date.now() - tSingle;

    const batchTexts = [
        'Consciousness Is the Record — epistemic grounding in AI',
        'MD-Blocks structured markdown authoring specification',
        'nVDB v2 vector lane with content-hash CAS attachments',
        'Overnight multi-user embedding backfill throughput'
    ];
    const tBatch = Date.now();
    const batch = await embedViaGateway(batchTexts, 0);
    const batchMs = Date.now() - tBatch;

    const report = {
        ok: health?.ok === true,
        nvdbUrl: NVDB_URL,
        collection: NVDB_COLLECTION,
        nvdbEngine: health?.engine ?? null,
        reranker_loaded: health?.reranker_loaded ?? null,
        healthMs,
        embedUrl: EMBED_URL,
        embedDims: EMBEDDING_DIMS,
        dim: single[0]?.length ?? null,
        singleMs,
        batch4Ms: batchMs,
        perItemMs: Math.round(batchMs / batch.length)
    };
    console.log(JSON.stringify(report, null, 2));

    if (!report.ok) throw new Error(`nvdb serve unhealthy at ${NVDB_URL}`);
}

// ============================================
// Step 1 — lexical sync
// ============================================

async function syncLexical({ client, prefixes, allById, opts }) {
    let fp;
    try {
        fp = await client.fingerprints(NVDB_COLLECTION, { timeoutMs: NVDB_TIMEOUT_MS });
    } catch (err) {
        if (opts.dryRun && err instanceof NvdbHttpError && err.status === 404 && err.code === 'unknown_collection') {
            log(`dry-run: collection "${NVDB_COLLECTION}" does not exist yet — treating as empty`);
            fp = { entries: [] };
        } else {
            throw err;
        }
    }
    const existing = new Map();
    for (const entry of fp.entries || []) existing.set(entry.id, entry);

    const toUpsert = [];
    let unchanged = 0;
    for (const [id, entry] of allById) {
        const prev = existing.get(id);
        if (!prev || prev.envelope_hash !== entry.envelope_hash) toUpsert.push(entry.doc);
        else unchanged++;
    }

    const toDelete = [];
    for (const id of existing.keys()) {
        if (!prefixes.some(prefix => id.startsWith(prefix))) continue;
        if (!allById.has(id)) toDelete.push(id);
    }

    log(`diff ${JSON.stringify({
        users: prefixes.length,
        totalChunks: allById.size,
        upserted: toUpsert.length,
        deleted: toDelete.length,
        unchanged
    })}`);

    if (opts.dryRun || !opts.sync) return;

    for (let i = 0; i < toUpsert.length; i += opts.upsertBatch) {
        await client.upsert(NVDB_COLLECTION, toUpsert.slice(i, i + opts.upsertBatch), { commit: false });
    }
    for (let i = 0; i < toDelete.length; i += opts.upsertBatch) {
        await client.deleteIds(NVDB_COLLECTION, toDelete.slice(i, i + opts.upsertBatch), { commit: false });
    }
    if (toUpsert.length > 0 || toDelete.length > 0) {
        await client.commit(NVDB_COLLECTION);
        log(`lexical sync committed: upserted=${toUpsert.length} deleted=${toDelete.length}`);
    }
}

// ============================================
// Step 2 — resumable buffered vector drain
// ============================================

async function drainVectors({ client, prefixes, allById, allExpected, opts }) {
    const fp = await client.fingerprints(NVDB_COLLECTION, { timeoutMs: NVDB_TIMEOUT_MS });
    const initialVectors = (fp.entries || [])
        .filter(entry => entry.has_vector === true && prefixes.some(prefix => entry.id.startsWith(prefix)))
        .length;
    const total = allExpected.length;

    let attached = 0;
    let staleRounds = 0;
    const started = Date.now();
    log(`vector drain start: ${initialVectors}/${total} already embedded (attach-batch=${opts.attachBatch}, embed-batch=${opts.batch})`);

    while (true) {
        const res = await client.pendingEmbeddings(NVDB_COLLECTION, opts.attachBatch);
        const pending = res.pending || [];
        if (pending.length === 0) break;

        const work = [];
        for (const item of pending) {
            const entry = allById.get(item.id);
            if (!entry || entry.content_hash !== item.content_hash) continue;
            work.push({ id: item.id, content_hash: item.content_hash, doc: entry.doc });
        }
        if (work.length === 0) {
            log(`WARNING: pending items do not match local hashes / target user filter (${pending.length} pending) — stopping the drain`);
            break;
        }

        const tEmbed = Date.now();
        const attachments = [];
        for (let i = 0; i < work.length; i += opts.batch) {
            const slice = work.slice(i, i + opts.batch);
            const vectors = await embedViaGateway(slice.map(w => buildChatVectorInput(w.doc)), opts.retries);
            for (let j = 0; j < slice.length; j++) {
                attachments.push({
                    id: slice[j].id,
                    content_hash: slice[j].content_hash,
                    model_version: EMBED_MODEL_VERSION,
                    vector: vectors[j]
                });
            }
        }
        const embedMs = Date.now() - tEmbed;

        const tAttach = Date.now();
        try {
            const r = await client.attachVectors(NVDB_COLLECTION, attachments, { timeoutMs: NVDB_TIMEOUT_MS });
            attached += r?.attached ?? attachments.length;
            staleRounds = 0;
        } catch (err) {
            if (err instanceof NvdbHttpError && err.code === 'stale_vector_cas') {
                staleRounds++;
                log(`WARNING: attach rejected stale_vector_cas (${attachments.length} vectors, round ${staleRounds}) — docs changed under us, resuming`);
                if (staleRounds >= MAX_STALE_ROUNDS) {
                    throw new Error(`attach_vectors rejected stale_vector_cas ${staleRounds} times in a row — local hashes are behind the collection, re-run the sync step`);
                }
                continue;
            }
            throw err;
        }
        const attachMs = Date.now() - tAttach;

        const elapsedSec = (Date.now() - started) / 1000;
        const rate = attached / Math.max(0.1, elapsedSec);
        const doneNow = initialVectors + attached;
        const etaSec = rate > 0 ? Math.max(0, (total - doneNow) / rate) : 0;
        log(`[vectors] +${attachments.length} attached=${attached} total=${doneNow}/${total} rate=${rate.toFixed(1)}/s (embed=${(embedMs / 1000).toFixed(1)}s attach=${(attachMs / 1000).toFixed(2)}s) eta=${Math.round(etaSec)}s`);
    }

    const elapsedSec = (Date.now() - started) / 1000;
    log(`vector drain done: attached=${attached} in ${elapsedSec.toFixed(1)}s (${(attached / Math.max(0.1, elapsedSec)).toFixed(1)}/s)`);
    return attached;
}

// ============================================
// Step 3 — integrity check
// ============================================

async function runIntegrityCheck({ client, allExpected }) {
    const chk = await client.integrityCheck(NVDB_COLLECTION, allExpected, {
        checkVectors: true,
        timeoutMs: NVDB_TIMEOUT_MS
    });
    const summary = {
        clean: chk.clean === true,
        missing: (chk.missing || []).length,
        extra: (chk.extra || []).length,
        content_mismatched: (chk.content_mismatched || []).length,
        envelope_mismatched: (chk.envelope_mismatched || []).length,
        missing_vectors: (chk.missing_vectors || []).length
    };
    console.log(JSON.stringify(summary, null, 2));
    return summary;
}

// ============================================
// Main
// ============================================

async function main() {
    const opts = parseArgs(process.argv.slice(2));

    if (opts.probe) {
        await runProbe();
        return;
    }

    const client = createV2Client(NVDB_URL, { timeoutMs: NVDB_TIMEOUT_MS });
    const health = await client.health();
    if (!health?.ok) throw new Error(`nvdb serve unhealthy at ${NVDB_URL}`);
    log(`connected to nvdb serve (${NVDB_URL}, reranker_loaded=${health.reranker_loaded})`);

    const users = loadTargetUsers(opts.user);
    log(`target users: ${users.map(u => (u.username ? `${u.username} (${u.id})` : u.id)).join(', ')}`);

    if (!opts.dryRun) {
        await client.createCollection(
            NVDB_COLLECTION,
            chatCollectionConfig({ embedDims: EMBEDDING_DIMS, embedModelVersion: EMBED_MODEL_VERSION })
        );
        log(`collection ensured: ${NVDB_COLLECTION} (dims=${EMBEDDING_DIMS}, model=${EMBED_MODEL_VERSION})`);
    } else {
        log('dry-run: collection create, sync, embed and check are skipped');
    }

    const allById = new Map();
    const allExpected = [];
    for (const user of users) {
        const built = readUserDocs(user);
        for (const [id, entry] of built.byId) allById.set(id, entry);
        allExpected.push(...built.expected);
        log(`[user] ${user.id}: chunks=${built.expected.length}`);
    }
    const prefixes = users.map(u => `${u.id}:`);

    await syncLexical({ client, prefixes, allById, opts });

    let attached = 0;
    if (opts.dryRun || !opts.embed) {
        log(opts.dryRun ? 'dry-run: vector drain skipped' : '--no-embed: vector drain skipped');
    } else {
        attached = await drainVectors({ client, prefixes, allById, allExpected, opts });
    }

    let check = null;
    if (opts.dryRun) {
        log('dry-run: integrity check skipped');
    } else if (!opts.check) {
        log('integrity check skipped (--no-check)');
    } else if (!opts.embed) {
        log('integrity check skipped (--no-embed)');
    } else if (opts.user) {
        log(`integrity check skipped: --user=${opts.user} filters to a subset, so a full-collection check would report every other user's documents as extra`);
    } else {
        check = await runIntegrityCheck({ client, allExpected });
    }

    console.log(JSON.stringify({
        users: users.length,
        chunks: allById.size,
        attached,
        check,
        ok: check === null ? null : check.clean
    }, null, 2));

    if (check !== null && !check.clean) {
        throw new Error('integrity check is NOT clean — see the summary above');
    }
}

main().catch(err => {
    console.error(`[backfill] FATAL: ${err.stack || err.message}`);
    // Graceful: process.exit() here aborts libuv mid-close (nDB native handles,
    // pooled sockets) and turns a clean failure into a crash exit code.
    process.exitCode = 1;
});
