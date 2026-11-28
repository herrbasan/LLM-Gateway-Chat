const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const zlib = require('zlib');
const { Readable } = require('stream');
const { EventEmitter } = require('events');

const { createNdbClient, NdbError } = require('./ndb-client');
const { createNvdbSync, createVectorDrainer } = require('./nvdb-sync');
const nLogger = require('../lib/nlogger-cjs');
const convStore = require('./conversation-store');
const runner = require('./runner');
const arenaRunner = require('./arena-runner');
const mcpPool = require('./mcp-pool');
const sttRelay = require('./stt-relay');
const { decodePreviewText } = require('./preview-content');
const {
    isEmbeddableMessage,
    splitTextIntoChunks, planEmbedBatches,
    EMBED_CHUNK_TOKENS: DEFAULT_EMBED_CHUNK_TOKENS,
    EMBED_CHUNK_OVERLAP_TOKENS: DEFAULT_EMBED_CHUNK_OVERLAP_TOKENS,
    EMBED_MAX_INPUT_TOKENS: DEFAULT_EMBED_MAX_INPUT_TOKENS,
    EMBED_REQUEST_TOKENS: DEFAULT_EMBED_REQUEST_TOKENS,
    EMBED_MAX_CONCURRENCY
} = require('./embed');
const { createV2Client, NvdbHttpError, isNvdbUnavailableError } = require('./nvdb-v2-client');
const { documentHashes } = require('./nvdb-v2-hash');
const {
    DEFAULT_QUERY_INSTRUCT,
    DEFAULT_RELEVANCE_FLOOR,
    DEFAULT_MODEL_VERSION,
    chatCollectionConfig,
    chatChunkId,
    buildMessageV2Docs,
    buildChatVectorInput,
    collectMessageChunkIds,
    buildUserExpectedDocs,
    parseChatChunkId,
    expectedDocsFromDocs
} = require('./nvdb-chat');

// Load minimal .env natively
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

// Load config
let cfg = {};
try {
    cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
} catch (err) { /* use defaults below */ }

const PORT           = process.env.CHAT_PORT           || cfg.port              || 3500;
const LOGS_DIR       = process.env.CHAT_LOGS_DIR       || cfg.logsDir           || 'server/logs';
const LOG_RETENTION  = process.env.CHAT_LOG_RETENTION  || cfg.logRetentionDays  || 1;
const USERS_DB_PATH  = process.env.CHAT_USERS_DB       || cfg.usersDbPath       || 'server/data/users_db/data.jsonl';
// nDB v2 is a shared `ndb serve` daemon (System of Record). Every document the
// chat owns lives there — no NAPI bindings, no in-process database.
const NDB_URL        = process.env.CHAT_NDB_URL        || cfg.ndbUrl             || 'http://127.0.0.1:8323';
const NDB_TOKEN      = process.env.CHAT_NDB_TOKEN      || cfg.ndbToken           || null;
const NDB_USERS_DB   = process.env.CHAT_NDB_USERS_DB   || cfg.ndbUsersDb         || 'chat_users';
const NDB_USER_PREFIX = process.env.CHAT_NDB_USER_PREFIX || cfg.ndbUserPrefix    || 'chat_';
const SESSION_TTL    = (cfg.sessionTtlMinutes || 1440) * 60 * 1000;
const EMBED_URL      = process.env.CHAT_EMBED_URL      || cfg.embedUrl          || 'http://192.168.0.100:3400/v1/embeddings';
const EMBEDDING_DIMS = parseInt(process.env.CHAT_EMBED_DIMS || cfg.embedDims)   || 2560;
// Chunking caps (see server/embed.js): prefill on the box is quadratic in input
// length and it serves ONE embedding slot, so a whole-message request costs
// minutes and queues interactive search behind it. Hard-clamped — a stale config
// value must not resurrect the 20k-token requests that queued the box on
// 2026-10-03.
const EMBED_CHUNK_TOKENS = Math.max(64, parseInt(process.env.CHAT_EMBED_CHUNK_TOKENS || cfg.embedChunkTokens) || DEFAULT_EMBED_CHUNK_TOKENS);
// Overlap is the one setting where an explicit 0 is meaningful, so it is read
// without the `|| default` shortcut that would turn 0 into the default.
const _overlapCfg = process.env.CHAT_EMBED_CHUNK_OVERLAP_TOKENS ?? cfg.embedChunkOverlapTokens;
const EMBED_CHUNK_OVERLAP_TOKENS = _overlapCfg === undefined || _overlapCfg === null
    ? DEFAULT_EMBED_CHUNK_OVERLAP_TOKENS
    : Math.max(0, parseInt(_overlapCfg) || 0);
const EMBED_MAX_INPUT_TOKENS = Math.min(Math.max(EMBED_CHUNK_TOKENS, parseInt(process.env.CHAT_EMBED_MAX_INPUT_TOKENS || cfg.embedMaxInputTokens) || DEFAULT_EMBED_MAX_INPUT_TOKENS), 32768);
const EMBED_REQUEST_TOKENS = Math.min(Math.max(EMBED_MAX_INPUT_TOKENS, parseInt(process.env.CHAT_EMBED_REQUEST_TOKENS || cfg.embedRequestTokenLimit) || DEFAULT_EMBED_REQUEST_TOKENS), 8192);
const EMBED_TOK_RATIO  = parseFloat(process.env.CHAT_EMBED_TOK_RATIO || cfg.embedTokRatio) || 2.5;
// nVDB v2 lives in ONE shared collection served by `nvdb serve` (HTTP), keyed
// per user by the chunk-id prefix — not one embedded index per user DB.
const NVDB_URL = process.env.CHAT_NVDB_URL || cfg.nvdbUrl || 'http://127.0.0.1:3510';
const NVDB_COLLECTION = process.env.CHAT_NVDB_COLLECTION || cfg.nvdbCollection || 'chat';
const EMBED_MODEL_VERSION = process.env.CHAT_EMBED_MODEL_VERSION || cfg.embedModelVersion || DEFAULT_MODEL_VERSION;
const QUERY_INSTRUCT = process.env.CHAT_QUERY_INSTRUCT ?? cfg.queryInstruct ?? DEFAULT_QUERY_INSTRUCT;
const RELEVANCE_FLOOR = Number(process.env.CHAT_RELEVANCE_FLOOR ?? cfg.relevanceFloor ?? DEFAULT_RELEVANCE_FLOOR);
// The writer and the integrity sweep must chunk identically, or every restart
// would rewrite every document.
const NVDB_CHUNK_OPTS = {
    chunkTokens: EMBED_CHUNK_TOKENS,
    overlapTokens: EMBED_CHUNK_OVERLAP_TOKENS,
    tokRatio: EMBED_TOK_RATIO
};
const FILES_DIR       = process.env.CHAT_FILES_DIR     || cfg.filesDir           || path.join(path.dirname(path.resolve(USERS_DB_PATH)), 'files');
// Workshop MCP server — backend-configured like gateway/TTS. The pool falls
// back to this when a user has no own mcp-servers entry (the normal case).
const MCP_URL         = process.env.MCP_URL            || cfg.mcpUrl             || null;

const { gatewayIdentityHeaders } = require('./gateway-identity.js');
const EMBED_API_KEY = process.env.GATEWAY_API_KEY || cfg.embedApiKey || null;

const EMBED_HEADERS = {
    'Content-Type': 'application/json',
    ...gatewayIdentityHeaders()
};
if (EMBED_API_KEY) {
    EMBED_HEADERS['Authorization'] = `Bearer ${EMBED_API_KEY}`;
}

let embedAvailable = true;
let embedFailCount = 0;

// ============================================
// Prime Directive (read fresh from MCP storage on every send)
// ============================================
// The chat app has its own hand-maintained directive:
// documentation/Workshop/Agents_Prime_Chat.md — sibling of the VS Code/agent
// canonical (Agents_Prime.md), authored for chat (no IDE content, includes
// the workshop tool catalog). The backend runs on the same machine as the MCP
// storage box, so it reads the file directly from disk: no HTTP hop, no
// timeout failure mode, and edits take effect on the next send. Only the YAML
// frontmatter is stripped. Retired 2026-08-25: the automated PLATFORM-marker
// extraction from the canonical (drift-prone, ~6.4K tokens every turn).

// MCP storage box root — the backend runs on the same machine, so native
// storage_* tools (server/storage-tools.js) hit the filesystem directly.
// Configurable via MCP_STORAGE_PATH; reliably D:\MCP_Storage on Badkid.
const MCP_STORAGE_PATH = process.env.MCP_STORAGE_PATH || 'D:\\MCP_Storage';

const PRIME_DIRECTIVE_PATH = path.join(MCP_STORAGE_PATH, 'documentation', 'Workshop', 'Agents_Prime_Chat.md');

async function fetchPrimeDirective() {
    try {
        let md = fs.readFileSync(PRIME_DIRECTIVE_PATH, 'utf8');
        // Strip YAML frontmatter (between first two --- lines)
        if (md.startsWith('---')) {
            const second = md.indexOf('---', 3);
            if (second !== -1) md = md.slice(second + 3).trimStart();
        }
        return md;
    } catch (e) {
        L().warn('Prime directive read failed', { path: PRIME_DIRECTIVE_PATH, error: e?.message }, 'Server');
        return '';
    }
}

// ============================================
// Database & Routing
// ============================================

let usersDb = null;
let ndbClient = null;
let logger = null;

// Names the service actually has mounted, refreshed on every createDb. A user
// DB that is neither mounted nor creatable is a loud startup/mount failure —
// never a silent fallback to a differently-named database.
const mountedDbNames = new Set();

// Registry of loaded user databases (userId -> { db, nvdbClient, pendingQueue, … })
const activeDbs = new Map();
// Shared nVDB v2 client + the reranker state probed at startup. Both are set
// once by initNvdb() before the listener opens, so nothing reads them early.
let nvdbClient = null;
let nvdbRerankerLoaded = false;
// nVDB is a MIRROR of nDB, not the system of record: while it is unreachable
// every post-commit mirror call degrades (logged, generation-marked) and the
// watchdog reconciles once it answers again. Searches fall back to nDB text.
let nvdbOnline = false;
const NVDB_WATCHDOG_MS = 15_000;
const NVDB_HEALTH_TIMEOUT_MS = 3_000;
let nvdbWatchdogRunning = false;
let modelsProxyCache = null; // { at, data } — 60 s cache for GET /api/models

// A post-commit mirror failure never fails the already-persisted nDB write: it
// logs, marks nVDB offline when the error means "unreachable", and bumps the
// instance's dirty generation so the watchdog re-reconciles on recovery.
function markNvdbFailure(instance, err, context) {
    L().warn('nVDB unavailable — continuing from nDB', {
        context,
        db: instance?.dbName || null,
        error: err?.message || String(err)
    }, 'Server');
    if (isNvdbUnavailableError(err)) nvdbOnline = false;
    if (instance) instance.nvdbDirtyGen = (instance.nvdbDirtyGen || 0) + 1;
}

// Idempotent indexes: every hot lookup filter gets a hash index; sorts use a
// btree so Rust paginates without a full scan. Returns true if any index was
// newly created (caller can compact once to persist zero-copy mmap indexes).
async function ensureDbIndexes(handle, label, extraHashFields = []) {
    let anyCreated = false;
    for (const field of ['_type', 'id', ...extraHashFields]) {
        const res = await handle.createIndex(field, 'hash');
        if (res?.created) anyCreated = true;
    }
    for (const field of ['updatedAt', 'createdAt']) {
        const res = await handle.createIndex(field, 'btree');
        if (res?.created) anyCreated = true;
    }
    logger.info('nDB indexes ensured', { db: label, created: anyCreated }, 'Server');
    return anyCreated;
}

async function startBackend() {
console.time('nLogger.init');
logger = await nLogger.init({ logsDir: path.resolve(LOGS_DIR), sessionPrefix: 'chat' });
console.timeEnd('nLogger.init');

logger.info('Chat Backend starting, loading users_db...', { port: PORT }, 'Server');

// Survival net: an unhandled rejection must NOT kill the server (Node 24
// default). Log loud with stack — every hit is a bug to fix (e.g. the
// mcp-pool floating-timeout crash, 2026-08-24; suspected live-incident class).
process.on('unhandledRejection', (reason) => {
    logger.error('UNHANDLED REJECTION (server kept alive)', reason instanceof Error ? `${reason.stack || reason.message}` : String(reason), {}, 'Server');
});
process.on('uncaughtException', (err) => {
    logger.error('UNCAUGHT EXCEPTION (server kept alive)', err.stack || err.message, {}, 'Server');
});

// 1. Connect to the nDB v2 service and verify the required database is mounted.
//    Both are hard dependencies: an unreachable service or a missing DB would
//    otherwise surface as "user vanished" later — fail loud HERE, with the URL.
ndbClient = createNdbClient(NDB_URL, { token: NDB_TOKEN, timeoutMs: 30_000 });
const ndbHealth = await ndbClient.health();
if (!ndbHealth?.ok) {
    throw new Error(`ndb serve unhealthy at ${NDB_URL}: ${JSON.stringify(ndbHealth)}`);
}
const ndbDbList = await ndbClient.listDbs();
mountedDbNames.clear();
for (const entry of ndbDbList) mountedDbNames.add(entry.name);
if (!mountedDbNames.has(NDB_USERS_DB)) {
    throw new Error(
        `ndb serve at ${NDB_URL} has no '${NDB_USERS_DB}' database mounted ` +
        `(mounted: ${[...mountedDbNames].sort().join(', ') || 'none'})`
    );
}
usersDb = ndbClient.db(NDB_USERS_DB);
logger.info('nDB v2 connected', {
    url: NDB_URL,
    engine: ndbHealth.engine,
    version: ndbHealth.version,
    usersDb: NDB_USERS_DB,
    mounted: [...mountedDbNames].sort(),
    allowCreate: ndbHealth.allow_create === true
}, 'Auth');

await ensureDbIndexes(usersDb, NDB_USERS_DB);
for (const field of ['username', 'token', 'userId']) await usersDb.createIndex(field, 'hash');

// 2. User Seeding (Auth + Routing schema)
const usersToSeed = [];

// Source 1: SUPERADMIN env vars
const superAdminUser = process.env.SUPERADMIN_USERNAME;
const superAdminPass = process.env.SUPERADMIN_PASSWORD;
const superAdminDbPath = process.env.SUPERADMIN_DBPATH || 'server/data/admin_data';
if (superAdminUser && superAdminPass) {
    usersToSeed.push({
        id: 'user-superadmin',
        username: superAdminUser,
        password: superAdminPass,
        displayName: 'Superadmin',
        dbPath: superAdminDbPath,
        rights: { login: true, read: true, write: true, admin: true }
    });
}

// Source 2: config.json
for (const u of (cfg.users || [])) {
    if (!u.username) {
        logger.error('User missing username, skipping', { id: u.id }, 'Auth');
        continue;
    }
    usersToSeed.push(u);
}

if (usersToSeed.length === 0) {
    logger.error('FATAL: No valid users configured (need at least one with a username via ENV or config.users)', {}, 'Auth');
    console.error('FATAL: No valid users configured.');
    process.exit(1);
}

for (const userDef of usersToSeed) {
    const existing = (await usersDb.findAll('id', userDef.id)).filter(d => d._type === 'user');
    if (existing.length === 0) {
        // Hash password with scryptSync and random salt
        const salt = crypto.randomBytes(16).toString('hex');
        const hash = crypto.scryptSync(userDef.password, salt, 64).toString('hex');
        await usersDb.insert({
            _type: 'user',
            id: userDef.id,
            username: userDef.username,
            displayName: userDef.displayName || userDef.username,
            dbPath: userDef.dbPath,
            passwordHash: salt + ':' + hash,
            rights: userDef.rights || { login: true },
            lastAccess: null,
            createdAt: new Date().toISOString()
        });
        logger.info('User created', { id: userDef.id, username: userDef.username }, 'Auth');
    } else {
        const doc = existing[0];
        let changed = false;
        let changeReason = "";

        const storedParts = doc.passwordHash.split(':');
        const storedSalt = storedParts[0];
        const storedHash = storedParts.slice(1).join(':');
        const configHash = crypto.scryptSync(userDef.password, storedSalt, 64).toString('hex');

        if (storedHash !== configHash) {
            const newSalt = crypto.randomBytes(16).toString('hex');
            doc.passwordHash = newSalt + ':' + crypto.scryptSync(userDef.password, newSalt, 64).toString('hex');
            changed = true;
            changeReason += "password_mismatch ";
        }
        if (userDef.displayName && doc.displayName !== userDef.displayName) {
            doc.displayName = userDef.displayName;
            changed = true;
            changeReason += "display_name_mismatch ";
        }
        if (userDef.dbPath && doc.dbPath !== userDef.dbPath) {
            doc.dbPath = userDef.dbPath;
            changed = true;
            changeReason += "dbPath_mismatch ";
        }
        const serializeShallow = (obj) => JSON.stringify(Object.keys(obj || {}).sort().reduce((acc, key) => { acc[key] = obj[key]; return acc; }, {}));
        if (userDef.rights && serializeShallow(doc.rights) !== serializeShallow(userDef.rights)) {
            doc.rights = userDef.rights;
            changed = true;
        }

        if (changed) {
            await revokeAllSessions(userDef.id); // force re-login on config footprint change
            await usersDb.update(doc._id, doc);
            logger.info('User updated', { id: userDef.id, username: userDef.username, reason: changeReason }, 'Auth');
        }
    }
}
await usersDb.compact();

// 3. Every seeded user needs a mounted `chat_<username>` database, and EVERY
//    already-mounted `chat_*` user database (e.g. `chat_herrbasan`) must have
//    its persisted indexes ensured so hot lookups never fall back to full scans.
const ensuredUserDbs = new Set();
for (const userDef of usersToSeed) {
    const name = await ensureUserDb(userDef.username);
    ensuredUserDbs.add(name);
}
for (const name of mountedDbNames) {
    if (name === NDB_USERS_DB || !name.startsWith(NDB_USER_PREFIX) || ensuredUserDbs.has(name)) continue;
    const handle = ndbClient.db(name);
    const created = await ensureDbIndexes(handle, name, ['sessionId']);
    if (created) {
        await handle.compact();
        logger.info('nDB compacted to persist new indexes', { db: name }, 'Server');
    }
    ensuredUserDbs.add(name);
}

// ============================================
// Maintenance Loops (Global across mounted DBs)
// ============================================

// Maintenance timers must never overlap and must NOT rewrite multi-hundred-MB
// bases when idle. Only compact a DB once its WAL has accumulated enough
// mutations since the last base snapshot.
const COMPACT_MIN_WAL_OPS = 200;
async function compactIfDirty(handle, meta) {
  const lineage = await handle.lineage();
  const pendingOps = lineage.last_seq >= lineage.min_available_seq
    ? (lineage.last_seq - lineage.min_available_seq + 1)
    : 0;
  if (pendingOps < COMPACT_MIN_WAL_OPS) return;
  await handle.compact();
  logger.info('nDB compacted', { ...meta, pendingOps }, 'Server');
}

let compactInFlight = false;
setInterval(async () => {
  if (compactInFlight) {
    logger.warn('nDB compaction still running — skipping this tick', {}, 'Server');
    return;
  }
  compactInFlight = true;
  try {
    try {
      await compactIfDirty(usersDb, { db: NDB_USERS_DB });
    } catch (err) {
      logger.error('nDB compact failed', err, { db: NDB_USERS_DB }, 'Server');
    }
    for (const [userId, instance] of activeDbs.entries()) {
      try {
        await compactIfDirty(instance.db, { userId, db: instance.dbName });
      } catch (err) {
        logger.error('nDB compact failed', err, { userId, db: instance.dbName }, 'Server');
      }
    }
  } finally {
    compactInFlight = false;
  }
}, 5 * 60 * 1000);

// File Bucket Garbage Collection (runs every 6 hours)
// gcBuckets() resolves to { moved } — log unconditionally when >0 so orphaning
// is always visible in logs.
setInterval(async () => {
  for (const [userId, instance] of activeDbs.entries()) {
    try {
      const { moved } = await instance.db.gcBuckets();
      if (moved > 0) {
        logger.info('File GC completed', { userId, db: instance.dbName, trashed: moved }, 'Storage');
      }
    } catch (err) {
      logger.error('nDB gcBuckets failed', err, { userId, db: instance.dbName }, 'Storage');
    }
  }
}, 6 * 60 * 60 * 1000);

// Embeddings check & flush loop across all mounted isolated DBs
setInterval(async () => {
    // 1. Recover embedding health if down
    if (!embedAvailable) {
        try {
            const reqBody = { input: ['health check'], dimensions: EMBEDDING_DIMS };
            const res = await fetch(EMBED_URL, {
                method: 'POST', headers: EMBED_HEADERS,
                body: JSON.stringify(reqBody),
                signal: AbortSignal.timeout(10000)
            });
            if (res.ok) {
                embedAvailable = true;
                embedFailCount = 0;
                logger.info('Embed endpoint recovered', {}, 'Embed');
            }
        } catch (err) {}
    }

    // 2. Iterate each mounted database instance for pending embeds
    for (const [userId, instance] of activeDbs.entries()) {
        if (!instance.nvdbClient) continue;

        if (instance.pendingQueue.length > 0 && embedAvailable) {
            // Find the first item ready for retry (skip items in backoff)
            let item = null;
            let itemIdx = -1;
            for (let i = 0; i < instance.pendingQueue.length; i++) {
                if (Date.now() >= (instance.pendingQueue[i].nextRetryAt || 0)) {
                    item = instance.pendingQueue[i];
                    itemIdx = i;
                    break;
                }
            }
            if (item) {
                instance.pendingQueue.splice(itemIdx, 1);
                embedMessageAsync(instance, item.msg, item.session, item.convNdbId, item.msgIdx, item.failCount || 0)
                    .catch(err => {
                        // embedMessageAsync already logged/re-queued the failure;
                        // only an nVDB outage needs the watchdog's bookkeeping.
                        if (isNvdbUnavailableError(err)) markNvdbFailure(instance, err, 'embedMessageAsync retry');
                    });
            }
        }
    }
}, 5000);

}

// ============================================
// Database Instantiation (nDB v2 shared service)
// ============================================

/** The nDB database name a username owns, and its validity. */
function userDbName(username) {
    if (typeof username !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(username)) {
        throw new Error(`userDbName: invalid username '${String(username)}' (expected [a-zA-Z0-9_-]+)`);
    }
    return `${NDB_USER_PREFIX}${username}`;
}

/**
 * Verify that `chat_<username>` is mounted, creating it when the service allows
 * creation (`--dir` given). A second resolved database that the user record does
 * not own is an operator error, not something to paper over.
 */
async function ensureUserDb(username) {
    const name = userDbName(username);
    if (!mountedDbNames.has(name)) {
        let descriptor;
        try {
            descriptor = await ndbClient.createDb(name, { format: 'ram', persistence: 'immediate' });
        } catch (err) {
            if (err instanceof NdbError && err.code === 'create_disabled') {
                throw new Error(
                    `ndb at ${NDB_URL} refuses to create '${name}' (create_disabled): ` +
                    `start ndb serve with --dir <root> so per-user databases can be created`
                );
            }
            throw new Error(`ndb at ${NDB_URL} could not create '${name}': ${err.code || err.name}: ${err.message}`);
        }
        mountedDbNames.add(name);
        logger.info('nDB user database created', { db: name, documents: descriptor?.documents ?? 0 }, 'Server');
    }
    const handle = ndbClient.db(name);
    const created = await ensureDbIndexes(handle, name, ['sessionId']);
    if (created) {
        await handle.compact();
        logger.info('nDB compacted to persist new indexes', { db: name }, 'Server');
    }
    return name;
}

/**
 * Mount (once) the user's database handle. Both verified at startup / user
 * creation, so this is pure handle construction — no I/O, no silent creation.
 */
function getOrLoadUserDb(user) {
    const name = userDbName(user.username);
    if (!mountedDbNames.has(name)) {
        throw new Error(
            `user database '${name}' is not mounted on ndb serve at ${NDB_URL} ` +
            `(user ${user.id}); restart the service or re-create the database`
        );
    }
    const existing = activeDbs.get(user.id);
    if (existing) {
        existing.username = user.username;
        return existing;
    }

    logger.info('Mounting user database', { userId: user.id, db: name }, 'Server');

    // nVDB v2 is ONE shared HTTP collection for every user — the instance carries
    // the client, collection and chunk contract so writers never reach for a
    // module global (tests mount instances without one).
    const instance = {
        userId: user.id,
        username: user.username,
        dbName: name,
        db: ndbClient.db(name),
        nvdbClient,
        nvdbCollection: NVDB_COLLECTION,
        nvdbChunkOpts: NVDB_CHUNK_OPTS,
        pendingQueue: [],
        embedInFlight: 0,
        embedWaiters: [],
        drainRunning: false,
        reconcileRunning: null,
        nvdbDirtyGen: 0,
        nvdbSyncedGen: 0
    };

    activeDbs.set(user.id, instance);

    // Reconcile this user's slice of the shared collection after mount: the
    // incremental change feed (or a pinned-snapshot rebuild) repairs lexical
    // state, then the drain attaches whatever vectors nVDB is still missing
    // (herrbasan/nVDB#3 keeps them queued).
    if (instance.nvdbClient) {
        setTimeout(() => reconcileUserNvdb(instance).catch(err => {
            if (isNvdbUnavailableError(err)) {
                markNvdbFailure(instance, err, 'mount reconcile');
                return;
            }
            logger.error('nVDB reconciliation failed', err, { userId: user.id, db: name }, 'Server');
        }), 3000);
    }

    return instance;
}

// Attach a batch of vectors, treating a stale CAS as "a newer edit won" rather
// than an outage: the newer document keeps its vectors, this batch is dropped and
// the next reconciliation pass decides what is still missing. Returns false when
// the batch was skipped — the caller must then stop draining, because those ids
// would stay pending and the loop would spin.
async function attachVectorsQuietly(instance, attachments) {
    try {
        await instance.nvdbClient.attachVectors(instance.nvdbCollection, attachments);
        return true;
    } catch (err) {
        if (err instanceof NvdbHttpError && err.status === 409 && err.code === 'stale_vector_cas') {
            L().debug('nVDB attach skipped: stale_vector_cas', { ids: attachments.length, db: instance.dbName }, 'Embed');
            return false;
        }
        throw err;
    }
}

// ============================================
// nVDB reconciliation (Phase 4b - incremental nDB -> nVDB sync)
// ============================================
//
// The engine lives in ./nvdb-sync.js (testable against a throwaway ndb serve).
// The watermark lives in `chat_users` � deliberately NOT in the user's own DB,
// because writing it there would advance that DB's own `last_seq` and the sync
// would chase its own tail forever.
const nvdbSync = createNvdbSync({
    usersDb: () => usersDb,
    log: () => L(),
    chunkOpts: NVDB_CHUNK_OPTS,
    expectedDocsFromDocs,
    parseChatChunkId,
    afterSync: (instance, result) => drainPendingVectors(instance, result)
});
const reconcileUserNvdb = nvdbSync.reconcileUserNvdb;

// The real drain (the one the timers, afterSync and the tests call). It lives
// in ./nvdb-sync.js so a test can exercise this exact function with stub embed
// deps — the #69 bug was a bare `userFingerprints` reference in a copy of this
// loop that only existed here.
const drainPendingVectors = createVectorDrainer({
    buildUserExpectedDocs,
    userFingerprints: nvdbSync.userFingerprints,
    acquireEmbedSlot,
    releaseEmbedSlot,
    embedBatch,
    attachVectorsQuietly,
    isEmbedAvailable: () => embedAvailable,
    buildChatVectorInput,
    parseChatChunkId,
    embeddingDims: EMBEDDING_DIMS,
    embedModelVersion: EMBED_MODEL_VERSION,
    log: () => L(),
    onNvdbError: (instance, err, context) => markNvdbFailure(instance, err, context),
    isNvdbUnavailableError
});

// Embed event bus — SSE clients subscribe to receive real-time embed status updates
const embedEvents = new EventEmitter();
embedEvents.setMaxListeners(100);

// List-level mutations (chat created/updated/deleted) broadcast to all of a
// user's attached list views, so the sidebar stays in sync across devices.
const listEvents = new EventEmitter();
listEvents.setMaxListeners(100);

function emitListEvent(userId, event, data) {
    listEvents.emit('event', { userId, event, data });
}

// Message activity (send append, assistant persist, tool hop, edit/delete)
// changes a conversation's updatedAt/messageCount in the store but fired no
// list event, so the sidebar's Modified sort (#66) stayed stale until an
// unrelated metadata save happened to emit one. Tap the runner's event flow
// here — broadcast() reaches it with zero attached views, so headless and
// background conversations are covered — and debounce per USER: the client's
// reaction is one refreshList() over all chats, so per-chat timers would only
// multiply fetches. Leading edge lands the send's reposition instantly;
// trailing catches the run's assistant persist.
const ACTIVITY_EVENTS = new Set(['msg.user', 'msg.assistant', 'tool.end', 'msg.deleted']);
const ACTIVITY_DEBOUNCE_MS = 750;
const activityTimers = new Map();   // userId → { timer, chatId }
function scheduleActivityListEvent(userId, chatId) {
    const prev = activityTimers.get(userId);
    if (prev) clearTimeout(prev.timer);
    if (!prev) emitListEvent(userId, 'chat.updated', { id: chatId, activity: true });
    activityTimers.set(userId, {
        chatId,
        timer: setTimeout(() => {
            const cur = activityTimers.get(userId);
            activityTimers.delete(userId);
            if (cur) emitListEvent(userId, 'chat.updated', { id: cur.chatId, activity: true });
        }, ACTIVITY_DEBOUNCE_MS)
    });
}

const L = () => logger || { info() {}, warn() {}, error() {}, debug() {} };

// ConversationRunner (PA-3) — server-side conversation sessions.
const internalTools = require('./internal-tools');
runner.init({
    gatewayUrl: process.env.LLM_GATEWAY_URL || cfg.gatewayUrl || 'http://127.0.0.1:3400',
    gatewayKey: process.env.GATEWAY_API_KEY || null,
    publicOrigin: process.env.CHAT_PUBLIC_ORIGIN || `http://localhost:${PORT}`,
    embedMessageAsync,
    log: L,
    getInstructions: async () => (await fetchPrimeDirective())
        || 'You are a helpful, conversational AI assistant in LLM Gateway Chat. Respond naturally and directly to the user. Use the archive and memory tools (described below) when they help, otherwise just have a natural conversation.',
    idleMs: 10 * 60 * 1000,
    embedBatch,
    getEmbedAvailable: () => embedAvailable,
    getNvdbClient: () => nvdbClient,
    nvdbCollection: NVDB_COLLECTION,
    getRerankerLoaded: () => nvdbRerankerLoaded,
    onNvdbError: (instance, err, context) => markNvdbFailure(instance, err, context),
    queryInstruct: QUERY_INSTRUCT,
    relevanceFloor: RELEVANCE_FLOOR,
    // Multiplexing (issue #19): forward every runner event into the user-level
    // listEvents pipe as an `r.<event>` frame carrying chatId — one SSE per TAB
    // instead of one per open chat (browser HTTP/1.1 cap is ~6 conns per host).
    emitUserEvent: (userId, chatId, event, data) => {
        listEvents.emit('event', { userId, event: 'r.' + event, data: { chatId, ...data } });
        if (ACTIVITY_EVENTS.has(event)) scheduleActivityListEvent(userId, chatId);
    }
});
internalTools.init({ log: L, emitListEvent });
convStore.init({ onNvdbError: (instance, err, context) => markNvdbFailure(instance, err, context) });
require('./storage-tools').init({ log: L(), storageRoot: MCP_STORAGE_PATH });
embedEvents.on('status', runner.handleEmbedStatus);
mcpPool.init({
    log: L,
    defaultServers: MCP_URL ? [{ id: 'workshop', name: 'workshop', url: MCP_URL }] : []
});
arenaRunner.init({
    gatewayUrl: process.env.LLM_GATEWAY_URL || cfg.gatewayUrl || 'http://127.0.0.1:3400',
    gatewayKey: process.env.GATEWAY_API_KEY || null,
    embedMessageAsync,
    log: L
});
embedEvents.on('status', arenaRunner.handleEmbedStatus);

function parseCookies(req) {
    const list = {};
    const rc = req.headers.cookie;
    if (rc) {
        rc.split(';').forEach((cookie) => {
            const parts = cookie.split('=');
            list[parts.shift().trim()] = decodeURI(parts.join('='));
        });
    }
    return list;
}

async function getAuthUser(req) {
    const cookies = parseCookies(req);
    const token = cookies.userToken;
    if (!token) return null;

    // Multi-session auth: one _type:'auth_session' doc per login, validated
    // independently so the same credentials can attach from several devices at
    // once (stress-testing the runner's multi-view model). nPort will own the
    // token/identity eventually; here the token maps to a user via userId.
    const sessionRows = await usersDb.findAll('token', token);
    const session = sessionRows.find(d => d._type === 'auth_session');
    if (!session) return null;

    const userRows = await usersDb.findAll('id', session.userId);
    const user = userRows.find(d => d._type === 'user');
    if (!user) return null;

    if (SESSION_TTL > 0 && session.lastAccess) {
        if (Date.now() - new Date(session.lastAccess).getTime() > SESSION_TTL) {
            await usersDb.delete(session._id); // expired session
            return null;
        }
        // Refresh lastAccess only if more than half the TTL has elapsed
        if (Date.now() - new Date(session.lastAccess).getTime() > SESSION_TTL / 2) {
            await touchSession(session, user);
        }
    } else if (SESSION_TTL > 0) {
        await touchSession(session, user);
    }

    return user;
}

// Refresh a session's lastAccess (caller throttles) and mirror to the user doc
// so admin's last-seen stays current. One PATCH per doc — never a read-modify-write.
async function touchSession(session, user) {
    const now = new Date().toISOString();
    await usersDb.set(session._id, 'lastAccess', now);
    user.lastAccess = now;
    await usersDb.set(user._id, 'lastAccess', now);
}

// Revoke every active session for a user (password change, config change, admin edit).
async function revokeAllSessions(userId) {
    const sessions = (await usersDb.findAll('userId', userId)).filter(d => d._type === 'auth_session');
    for (const s of sessions) await usersDb.delete(s._id);
}

/**
 * Resolve the request's identity ONCE, in the router, before any handler runs.
 * Auth docs live behind `ndb serve`, so every lookup is a network round-trip;
 * doing it per request (not per requireAuth call) keeps the handlers readable
 * and the cost flat.
 */
async function resolveAuth(req) {
    const user = await getAuthUser(req);
    if (!user || user.rights?.login === false) return null;
    // A mount failure is an infrastructure fault, not a rejected credential: it
    // propagates so the router can answer 5xx instead of pretending 401.
    const dbInstance = getOrLoadUserDb(user);
    return { user, dbInstance };
}

// Synchronous gate for handlers: the router resolved `req.auth` before dispatch.
// An unresolved request is a routing bug and says so.
function requireAuth(req, res) {
    if (req.auth === undefined) {
        throw new Error(`requireAuth: auth was not resolved for ${req.method} ${req.url}`);
    }
    const authResult = req.auth;
    if (!authResult || authResult.user?.rights?.login === false) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return null;
    }
    return authResult;
}

// ============================================
// JSON Response Helper
// ============================================

// ============================================
// nSpeech proxy helper — stream a request through to nSpeech.
// GET: catalog calls (JSON). POST: speech synthesis — the request body is a
// small JSON payload (buffered), the audio response is streamed to the client.
// ============================================

const stt = sttRelay.createRelay({ cfg, getAuthUser, requireAuth, L });

// ============================================
// Storage proxy (issue #36): /storage/* → workshop MCP storage server,
// cookie-auth'd same-origin. Referencing storage images as /storage/<path>
// works from every machine — the origin resolves against whatever host
// served the chat, unlike absolute localhost/LAN spellings.
// ============================================

function storageBase() {
  if (!MCP_URL) throw new Error('Storage proxy: MCP_URL not configured');
  // MCP_URL may carry an endpoint path (e.g. http://host:3100/mcp/compact) —
  // the storage HTTP surface hangs off the ORIGIN, not the endpoint.
  try {
    return new URL(MCP_URL).origin;
  } catch (e) {
    throw new Error(`Storage proxy: MCP_URL unparsable (${MCP_URL})`);
  }
}

// Canonicalize storage URLs in text bodies served to views (issue #36): every
// absolute spelling of the storage origin becomes the host-less /storage/...
// path this backend serves. Applied to fetched preview documents so renderers
// never see a storage host. Mirrors runner.canonicalizeStorageUrls.
const STORAGE_SPELLING_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|192\.168\.0\.100):3100\/storage\//gi;
function canonicalizeStorageUrls(content) {
  if (typeof content !== 'string' || !content.includes('/storage/')) return content;
  let out = content.replace(STORAGE_SPELLING_RE, '/storage/');
  if (MCP_URL) {
    try {
      const origin = new URL(MCP_URL).origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      out = out.replace(new RegExp(origin + '/storage/', 'gi'), '/storage/');
    } catch { /* unparsable MCP_URL — the spelling regex already ran */ }
  }
  return out;
}

async function proxyStorage(req, res, storagePath) {
  const authResult = requireAuth(req, res);
  if (!authResult) return;

  const url = new URL(req.url, 'http://localhost');
  let target;
  try {
    target = storageBase() + '/storage/' + storagePath + url.search;
  } catch (e) {
    json(res, { error: e.message }, 503, req);
    return;
  }

  let upstream;
  try {
    // Forward the client's Range header: media seeking depends on the storage
    // server answering 206 with an exact byte span. HEAD is passed through too
    // so the browser can size a resource without pulling the body.
    const method = req.method === 'HEAD' ? 'HEAD' : 'GET';
    const upstreamHeaders = {};
    if (req.headers.range) upstreamHeaders.Range = req.headers.range;
    if (req.headers['if-none-match']) upstreamHeaders['If-None-Match'] = req.headers['if-none-match'];
    if (req.headers['if-modified-since']) upstreamHeaders['If-Modified-Since'] = req.headers['if-modified-since'];
    upstream = await fetch(target, { method, headers: upstreamHeaders });
  } catch (e) {
    json(res, { error: `Storage server unreachable: ${e.message}` }, 502, req);
    return;
  }
  if (!upstream.ok && upstream.status !== 304) {
    json(res, { error: `Storage: ${upstream.status} ${upstream.statusText}` }, upstream.status, req);
    return;
  }

  // Propagate the headers that make a response correctly sized and seekable.
  // Content-Length in particular MUST pass through: the previous version sent
  // only Content-Type, so Node fell back to chunked transfer encoding and the
  // browser reported a NaN duration with an empty seekable range (no seek bar).
  // The status passes through unchanged (206 for a satisfied range, else 200).
  const outHeaders = {};
  const upstreamEncoding = upstream.headers.get('content-encoding');
  for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag']) {
    // A compressed body's Content-Length describes the encoded bytes, not what
    // fetch hands back after decompression — never forward it alongside a
    // decoded stream, or the response is truncated/mispaced.
    if (h === 'content-length' && upstreamEncoding) continue;
    const v = upstream.headers.get(h);
    if (v) outHeaders[h] = v;
  }
  if (!outHeaders['content-type']) outHeaders['content-type'] = 'application/octet-stream';
  // Revalidate on every reuse: edited storage assets keep the same URL (#47).
  // Validators still let unchanged responses answer 304 without a body.
  outHeaders['Cache-Control'] = 'no-cache';
  res.writeHead(upstream.status, outHeaders);

  if (req.method === 'HEAD' || !upstream.body) {
    res.end();
    return;
  }
  const stream = Readable.fromWeb(upstream.body);
  stream.on('error', (e) => { logger?.error('Storage proxy stream failed', e, { storagePath }, 'Storage'); stream.destroy(); res.destroy(); });
  stream.pipe(res);
}

function ttsBase() {
  return (process.env.TTS_ENDPOINT || cfg.ttsEndpoint || 'http://localhost:2233').replace(/\/+$/, '');
}

async function proxyTts(req, res, nspeechPath) {
  const authResult = requireAuth(req, res);
  if (!authResult) return;

  const url = new URL(req.url, 'http://localhost');
  const target = ttsBase() + nspeechPath + url.search;

  const init = { method: req.method, headers: {} };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    init.body = Buffer.concat(chunks);
    if (req.headers['content-type']) init.headers['Content-Type'] = req.headers['content-type'];
  }

  // Propagate a client abort (e.g. the player closed mid-generation) upstream
  // to nSpeech so the generation actually stops. Without this, closing the
  // player leaves the proxy streaming and nSpeech burning resources generating
  // audio nobody is listening to. 'res' close fires on normal completion too,
  // so only abort when the response did NOT finish normally (client went away).
  const ac = new AbortController();
  init.signal = ac.signal;
  let finished = false;
  res.on('finish', () => { finished = true; });
  res.on('close', () => { if (!finished) ac.abort(); });

  let upstream;
  try {
    upstream = await fetch(target, init);
  } catch (e) {
    if (ac.signal.aborted) return; // client went away — nothing to send
    json(res, { error: `nSpeech unreachable: ${e.message}` }, 502, req);
    return;
  }

  const outHeaders = {
    'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream'
  };
  res.writeHead(upstream.status, outHeaders);
  if (upstream.body) {
    const stream = Readable.fromWeb(upstream.body);
    stream.on('error', (e) => { logger?.error('TTS proxy stream failed', e, {}, 'TTS'); stream.destroy(); res.destroy(); });
    stream.pipe(res);
  } else {
    res.end();
  }
}

function json(res, data, status = 200, req = null) {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Headers': 'Content-Type, X-API-Key'
  };
  
  if (req && req.headers.origin) {
    headers['Access-Control-Allow-Origin'] = req.headers.origin;
    headers['Access-Control-Allow-Credentials'] = 'true';
  } else {
    headers['Access-Control-Allow-Origin'] = '*';
  }

  const body = JSON.stringify(data);
  if (req) {
    sendBody(req, res, body, headers, status);
  } else {
    headers['Content-Length'] = Buffer.byteLength(body);
    res.writeHead(status, headers);
    res.end(body);
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(new Error('Invalid JSON'));
      }
    });
  });
}

// ============================================
// Compressed Response Helper
// ============================================

const COMPRESSIBLE_MIMES = new Set([
  'text/html',
  'text/css',
  'text/plain',
  'text/xml',
  'text/event-stream',
  'application/javascript',
  'application/json',
  'application/xml',
  'image/svg+xml'
]);
const COMPRESS_THRESHOLD = 1024; // bytes — skip compression for tiny payloads

function acceptsEncoding(req, encoding) {
  const accept = req.headers['accept-encoding'] || '';
  return accept.includes(encoding);
}

function sendBody(req, res, body, headers, status = 200) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const mime = headers['Content-Type'] || '';
  const baseMime = mime.split(';')[0].trim();
  const compressible = COMPRESSIBLE_MIMES.has(baseMime);

  if (compressible && buf.length >= COMPRESS_THRESHOLD && acceptsEncoding(req, 'gzip')) {
    zlib.gzip(buf, (err, compressed) => {
      if (err) {
        // Fallback: send uncompressed
        headers['Content-Length'] = buf.length;
        res.writeHead(status, headers);
        res.end(buf);
      } else {
        headers['Content-Encoding'] = 'gzip';
        headers['Content-Length'] = compressed.length;
        res.writeHead(status, headers);
        res.end(compressed);
      }
    });
  } else {
    headers['Content-Length'] = buf.length;
    res.writeHead(status, headers);
    res.end(buf);
  }
}

// ============================================
// Embed API
//
// embedBatch(texts) — send batch to Gateway, return vectors.
// Throws Error with err.kind classifying the failure:
//   'rate_limit'   — 429 or upstream rate-limit; transient, wait Retry-After
//   'server'       — 5xx / network / timeout; transient, provider-side
//   'client'       — 4xx (non-429); permanent payload problem, do not retry blindly
//   'unavailable'  — circuit breaker open (embedAvailable === false)
//   'response'     — 200 but malformed body; treat as transient
// Retry-After (seconds or HTTP-date) is honored on err.retryAfterMs.
// Only 'server'/'response' failures count toward the circuit breaker —
// a rate-limit or a bad payload is not an outage.
// ============================================

class EmbedError extends Error {
    constructor(kind, message, retryAfterMs = 0, status = 0) {
        super(message);
        this.kind = kind;
        this.retryAfterMs = retryAfterMs;
        this.status = status;
    }
}

function _parseRetryAfterMs(res) {
    const h = res.headers.get('retry-after');
    if (!h) return 0;
    const secs = Number(h);
    if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
    const date = Date.parse(h);
    if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
    return 0;
}

async function embedBatch(texts) {
    if (!embedAvailable) throw new EmbedError('unavailable', 'Embedding unavailable');
    const reqBody = { input: texts, dimensions: EMBEDDING_DIMS };

    let res;
    try {
        res = await fetch(EMBED_URL, {
            method: 'POST',
            headers: EMBED_HEADERS,
            body: JSON.stringify(reqBody),
            signal: AbortSignal.timeout(120000)
        });
    } catch (err) {
        // Network failure / timeout — provider unreachable
        embedFailCount++;
        if (embedFailCount >= 3) embedAvailable = false;
        throw new EmbedError('server', `Embed network: ${err.message}`, 0, 0);
    }

    if (!res.ok) {
        const retryAfterMs = _parseRetryAfterMs(res);
        const body = await res.text().catch(() => '');
        const detail = body.slice(0, 300);
        if (res.status === 429) {
            // Rate-limit is NOT an outage — do not trip the breaker
            throw new EmbedError('rate_limit', `Embed 429: ${detail}`, retryAfterMs, 429);
        }
        if (res.status >= 500) {
            embedFailCount++;
            if (embedFailCount >= 3) embedAvailable = false;
            throw new EmbedError('server', `Embed ${res.status}: ${detail}`, retryAfterMs, res.status);
        }
        // 4xx — payload problem (auth, too long, malformed). Not an outage.
        throw new EmbedError('client', `Embed ${res.status}: ${detail}`, 0, res.status);
    }

    embedFailCount = 0;
    let data;
    try {
        data = await res.json();
    } catch (err) {
        embedFailCount++;
        if (embedFailCount >= 3) embedAvailable = false;
        throw new EmbedError('response', `Embed malformed JSON: ${err.message}`, 0, 200);
    }
    if (data.error) throw new EmbedError('server', `Embed upstream: ${data.error.message || JSON.stringify(data.error)}`, 0, 200);
    const embeddingData = data.data || [];
    const sorted = [...embeddingData].sort((a, b) => (a.index || 0) - (b.index || 0));
    return sorted.map(d => d.embedding);
}

// Per-DB gate on embedding requests. The box serves ONE embedding slot, so
// unbounded fan-out (arena turns, bursts of appended messages) only deepens its
// queue and starves interactive search. The slot is handed straight to the next
// waiter, so the in-flight count never dips below the limit.
function acquireEmbedSlot(instance) {
    if (instance.embedInFlight < EMBED_MAX_CONCURRENCY) {
        instance.embedInFlight++;
        return Promise.resolve();
    }
    return new Promise(resolve => instance.embedWaiters.push(resolve));
}

function releaseEmbedSlot(instance) {
    const next = instance.embedWaiters.shift();
    if (next) next();
    else instance.embedInFlight--;
}

async function embedMessageAsync(instance, msg, session, convNdbId, msgIdx, _prevFails = 0) {
    // Skip tool responses (massive JSON loads, duplicated session exports) and
    // empty messages (a vector with no content can only return content-free hits).
    if (!isEmbeddableMessage(msg)) {
        if (msg.role !== 'tool') {
            L().debug('Embed skipped (empty content)', { msgId: msg.id, role: msg.role, db: instance.dbName }, 'Embed');
        }
        return;
    }

    if (!instance.nvdbClient || !instance.userId) {
        if (msg.embedStatus === 'pending') {
            L().info('Embed skipped (nVDB v2 unavailable or userId unknown)', { msgId: msg.id, role: msg.role, db: instance.dbName }, 'Embed');
        }
        return;
    }

    const chunkOpts = { ...NVDB_CHUNK_OPTS };
    let docs = buildMessageV2Docs({ userId: instance.userId, session, msg, msgIdx, chunkOpts });
    if (docs.length === 0) return;

    // Lexical first: upserting the documents makes the message findable the
    // moment it is written — a queued or failing vector can no longer hide it
    // from keyword search.
    const upsertDocs = async () => {
        await instance.nvdbClient.upsert(NVDB_COLLECTION, docs, { commit: true });
        const prevChunks = Math.max(0, Number(msg.embedChunks) || 0);
        if (prevChunks > docs.length) {
            const shrunk = [];
            for (let i = docs.length; i <= prevChunks; i++) shrunk.push(chatChunkId(instance.userId, session.id, msgIdx, i));
            await instance.nvdbClient.deleteIds(NVDB_COLLECTION, shrunk, { commit: true });
        }
    };
    try {
        await upsertDocs();
    } catch (err) {
        // nVDB itself is the failing dependency here — retry the whole message
        // (lexical + vector) on the same backoff schedule as an embed failure.
        L().error('nVDB lexical upsert failed', err, { msgId: msg.id, chatId: session.id, idx: msgIdx }, 'Embed');
        markNvdbFailure(instance, err, 'embedMessageAsync');
        queueEmbedRetry(instance, { msg, session, convNdbId, msgIdx }, _prevFails);
        throw err;
    }

    if (!embedAvailable) {
        queueEmbedRetry(instance, { msg, session, convNdbId, msgIdx }, _prevFails);
        throw new Error('Embedding endpoint unavailable — queued for retry');
    }

    let lastError = null;

    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const attachments = [];
            for (let i = 0; i < docs.length; i += 8) {
                const slice = docs.slice(i, i + 8);
                // One slot per slice: a long message must not hold the box while
                // an interactive search waits behind it.
                await acquireEmbedSlot(instance);
                let vectors;
                try {
                    vectors = await embedBatch(slice.map(d => buildChatVectorInput(d)));
                } finally {
                    releaseEmbedSlot(instance);
                }
                for (let j = 0; j < slice.length; j++) {
                    const vector = vectors[j];
                    if (!Array.isArray(vector) || vector.length === 0 || vector.length !== EMBEDDING_DIMS) {
                        throw new EmbedError('response', 'invalid_vector_shape');
                    }
                    attachments.push({
                        id: slice[j].id,
                        content_hash: documentHashes(slice[j]).content_hash,
                        model_version: EMBED_MODEL_VERSION,
                        vector
                    });
                }
            }

            try {
                await instance.nvdbClient.attachVectors(NVDB_COLLECTION, attachments);
            } catch (err) {
                // A newer edit re-wrote these documents while we were embedding:
                // its vectors and content win, so this stale batch is dropped.
                if (err instanceof NvdbHttpError && err.status === 409 && err.code === 'stale_vector_cas') {
                    L().debug('Embed superseded (stale_vector_cas)', { msgId: msg.id, chatId: session.id, idx: msgIdx, chunks: docs.length }, 'Embed');
                    return;
                }
                markNvdbFailure(instance, err, 'embedMessageAsync');
                throw err;
            }

            // Mark message as embedded in the conversation doc (one atomic PATCH — no read-modify-write race)
            try {
                await instance.db.patch(convNdbId, [
                    { op: 'set', path: `messages.${msgIdx}.embedStatus`, value: 'embedded' },
                    { op: 'set', path: `messages.${msgIdx}.embedChunks`, value: docs.length },
                    { op: 'set', path: `messages.${msgIdx}.embedAttempts`, value: attempt + 1 },
                    { op: 'set', path: `messages.${msgIdx}.embedError`, value: null }
                ]);
                embedEvents.emit('status', {
                    chatId: session.id, msgIdx, messageId: msg.id,
                    embedStatus: 'embedded', embedError: null
                });
            } catch (e) {
                L().error('Failed to persist embed status', e, { msgId: msg.id, convNdbId }, 'Embed');
            }

            L().info('Embedded', { msgId: msg.id, role: msg.role, chatId: session.id, idx: msgIdx, charLen: String(msg.content ?? '').length, chunks: docs.length, attempt: attempt + 1 }, 'Embed');
            return;
        } catch (err) {
            lastError = err;

            // Permanent payload problems — retrying cannot help
            const isTokenOverflow = err.message?.includes('too many') && err.message?.includes('token');
            const isClientError = err.kind === 'client';

            // A token-ratio miss means the estimate under-counted this text: split
            // it finer and rewrite the documents rather than declaring the message
            // unembeddable.
            if (isTokenOverflow && attempt < 2) {
                chunkOpts.chunkTokens = Math.max(64, Math.floor(chunkOpts.chunkTokens / 2));
                docs = buildMessageV2Docs({ userId: instance.userId, session, msg, msgIdx, chunkOpts });
                try {
                    await upsertDocs();
                } catch (redoErr) {
                    L().error('nVDB lexical re-upsert failed', redoErr, { msgId: msg.id, chatId: session.id, idx: msgIdx }, 'Embed');
                    queueEmbedRetry(instance, { msg, session, convNdbId, msgIdx }, _prevFails);
                    throw redoErr;
                }
                L().warn('Embed input overflowed — re-splitting smaller', { msgId: msg.id, chunkTokens: chunkOpts.chunkTokens, chunks: docs.length }, 'Embed');
                continue;
            }

            if (isTokenOverflow || isClientError) {
                const reason = isTokenOverflow ? 'too_many_tokens' : (err.message || 'client_error');
                L().error('Embed permanent failure', err, { msgId: msg.id, kind: err.kind }, 'Embed');
                try {
                    await instance.db.patch(convNdbId, [
                        { op: 'set', path: `messages.${msgIdx}.embedStatus`, value: 'failed' },
                        { op: 'set', path: `messages.${msgIdx}.embedError`, value: reason }
                    ]);
                    embedEvents.emit('status', {
                        chatId: session.id, msgIdx, messageId: msg.id,
                        embedStatus: 'failed', embedError: reason
                    });
                } catch (e) {
                    L().error('Failed to persist embed failure status', e, { msgId: msg.id }, 'Embed');
                }
                // Do NOT re-queue — this is a content problem, not a transient one
                return;
            }

            // Transient — back off before next attempt. Honor Retry-After if given.
            if (attempt < 2) {
                const retryAfter = err.retryAfterMs || 0;
                const delay = Math.max(Math.pow(4, attempt) * 1000, retryAfter);
                await new Promise(r => setTimeout(r, delay));
            }
        }
    }

    // Transient failure after all retries — re-queue for the background drain loop.
    // Status stays 'pending' so reconciliation will pick it up again on restart.
    L().error('Embed failed after retries (transient, re-queued)', lastError, { msgId: msg.id, kind: lastError?.kind, attempts: 3, prevFails: _prevFails }, 'Embed');
    embedEvents.emit('status', {
        chatId: session.id, msgIdx, messageId: msg.id,
        embedStatus: 'pending', embedError: lastError?.message || 'unknown'
    });

    queueEmbedRetry(instance, { msg, session, convNdbId, msgIdx }, _prevFails);
    throw lastError;
}

// Backoff schedule for a transient embed failure (or an nVDB outage). The item is
// picked up by the 5-second drain once its time comes.
function queueEmbedRetry(instance, item, prevFails) {
    if (instance.pendingQueue.length >= 500) {
        L().warn('Embed queue full — message dropped', { msgId: item.msg?.id, role: item.msg?.role, queueLen: instance.pendingQueue.length, db: instance.dbName }, 'Embed');
        return;
    }
    const delays = [5000, 30000, 120000, 600000, 1800000];
    const failCount = prevFails + 1;
    const delay = delays[Math.min(failCount - 1, delays.length - 1)];
    instance.pendingQueue.push({ ...item, failCount, nextRetryAt: Date.now() + delay });
    L().info('Embed re-queued with backoff', { msgId: item.msg?.id, failCount, delayMs: delay, nextRetry: new Date(Date.now() + delay).toISOString() }, 'Embed');
}


// ============================================
// API Routes
// ============================================

const routes = {
  
  // Health + server type detection
  'GET /health': async (req, res) => {
    json(res, {
      status: 'ok',
      version: require('../package.json').version
    });
  },

  // SSE endpoint for real-time embed status updates
  'GET /api/embed-events': async (req, res) => {
    const authResult = requireAuth(req, res);
    if (!authResult) return;

    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const chatId = parsedUrl.searchParams.get('chatId');
    if (!chatId) {
      json(res, { error: 'Missing chatId query param' }, 400, req);
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });

    // Send initial comment to establish connection
    res.write(':ok\n\n');

    const onStatus = (event) => {
      if (event.chatId !== chatId) return;
      try {
        res.write(`event: embed-status\ndata: ${JSON.stringify(event)}\n\n`);
      } catch (e) {
        // Client disconnected — clean up below
      }
    };

    embedEvents.on('status', onStatus);

    // Keepalive every 15s
    const keepalive = setInterval(() => {
      try { res.write(':keepalive\n\n'); } catch (e) {}
    }, 15000);

    // Cleanup on disconnect
    req.on('close', () => {
      embedEvents.off('status', onStatus);
      clearInterval(keepalive);
    });
  },

  
    // --------------------------------------------------------
    // File Attachments (Images)
    // --------------------------------------------------------
    
    'PUT /api/chat-files/:exchangeId': async (req, res, { exchangeId }) => {
      try {
        const authResult = requireAuth(req, res);
        if (!authResult) return;
        const { dbInstance } = authResult;
        
        const body = await readBody(req);
        if (!body || !body.files || !Array.isArray(body.files)) {
          return json(res, { error: 'Invalid files payload' }, 400);
        }
        
        const savedFiles = [];
        for (let i = 0; i < body.files.length; i++) {
          const file = body.files[i];
          const extMap = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg' };
          const ext = extMap[file.type] || 'bin';
          const filename = `ex_${exchangeId}_${i}.${ext}`;
          
          const buffer = Buffer.from(file.data, 'base64');
          const meta = await dbInstance.db.storeFile('images', buffer, filename);
          
          savedFiles.push({
            name: file.name,
            type: file.type,
            url: `/api/buckets/images/${meta.hash}.${meta.ext}`,
            _file: meta.ref
          });
        }
        json(res, { success: true, files: savedFiles });
      } catch (err) {
        logger.error('Failed to save files:', err.message);
        json(res, { error: 'Failed to save files' }, 500);
      }
    },

    'GET /api/chat-files/:exchangeId': async (req, res, { exchangeId }) => {
      try {
        const exPath = require('path').join(FILES_DIR, exchangeId);
        if (!fs.existsSync(exPath)) {
          return json(res, []);
        }
        
        const files = await fs.promises.readdir(exPath);
        const result = files.map(file => {
          let type = 'application/octet-stream';
          if (file.endsWith('.png')) type = 'image/png';
          else if (file.endsWith('.jpg') || file.endsWith('.jpeg')) type = 'image/jpeg';
          else if (file.endsWith('.gif')) type = 'image/gif';
          else if (file.endsWith('.webp')) type = 'image/webp';
          else if (file.endsWith('.svg')) type = 'image/svg+xml';
          
          return {
            url: `/files/${exchangeId}/${file}`,
            name: file,
            type
          };
        });
        json(res, result);
      } catch (err) {
        logger.error('Failed to load files:', err.message);
        json(res, { error: 'Failed to load files' }, 500);
      }
    },

    'DELETE /api/chat-files/:exchangeId': async (req, res, { exchangeId }) => {
      // Legacy wrapper. Proper gc happens on chat deletion via releaseFile now.
      try {
        const exPath = require('path').join(FILES_DIR, exchangeId);
        if (fs.existsSync(exPath)) {
          await fs.promises.rm(exPath, { recursive: true, force: true });
        }
        json(res, { success: true });
      } catch (err) {
        logger.error('Failed to delete files:', err.message);
        json(res, { error: 'Failed to delete files' }, 500);
      }
    },

    'GET /api/buckets/:bucket/:filename': async (req, res, { bucket, filename }) => {
      try {
        const authResult = requireAuth(req, res);
        if (!authResult) return;
        const { dbInstance } = authResult;

        const dotPos = filename.lastIndexOf('.');
        if (dotPos === -1) throw new Error('invalid filename');
        const id = filename.slice(0, dotPos);
        const ext = filename.slice(dotPos + 1).toLowerCase();
        // Content addressing changed with nDB v2: new uploads carry the full
        // 64-hex SHA-256, older ones the legacy 8-hex prefix. Both are valid refs
        // and the engine serves either.
        if (!/^(?:[0-9a-f]{8}|[0-9a-f]{64})$/.test(id) || !/^[a-z0-9]{0,10}$/.test(ext)) {
          json(res, { error: 'Invalid file reference' }, 400);
          return;
        }

        const file = await dbInstance.db.getFile(bucket, `${id}.${ext}`);
        if (!file || file.buffer.length === 0) {
          json(res, { error: 'File not found' }, 404);
          return;
        }
        const buffer = file.buffer;

        const mime = {
          'png': 'image/png',
          'jpg': 'image/jpeg',
          'jpeg': 'image/jpeg',
          'gif': 'image/gif',
          'webp': 'image/webp',
          'svg': 'image/svg+xml'
        }[ext] || 'application/octet-stream';
        
        res.writeHead(200, { 'Content-Type': mime });
        res.end(buffer);
      } catch (err) {
        // Fallback for not found or errors
        json(res, { error: 'File not found' }, 404);
      }
    },

    'GET /api/files': async (req, res) => {
      try {
        if (!fs.existsSync(FILES_DIR)) {
          return json(res, { entries: 0, bytes: 0, mb: '0.00' });
        }
        
        let totalBytes = 0;
        let fileCount = 0;
        
        const dirs = await fs.promises.readdir(FILES_DIR);
        for (const dir of dirs) {
          const dirPath = require('path').join(FILES_DIR, dir);
          const stat = await fs.promises.stat(dirPath);
          if (stat.isDirectory()) {
            const files = await fs.promises.readdir(dirPath);
            for (const file of files) {
              const fStat = await fs.promises.stat(require('path').join(dirPath, file));
              if (fStat.isFile()) {
                fileCount++;
                totalBytes += fStat.size;
              }
            }
          } else if (stat.isFile()) {
             fileCount++;
             totalBytes += stat.size;
          }
        }
        
        json(res, { 
          entries: fileCount, 
          bytes: totalBytes, 
          mb: (totalBytes / 1024 / 1024).toFixed(2) 
        });
      } catch (err) {
        logger.error('Failed to stats files:', err.message);
        json(res, { entries: 0, bytes: 0, mb: '0.00' });
      }
    },

    'GET /api/server-type': async (req, res) => {
    json(res, { type: 'node-backend' });
  },

  // Thin same-origin model proxy (architecture §8): the view must not talk to
  // the gateway directly. Brief cache — model lists change rarely.
  'GET /api/models': async (req, res) => {
    const authResult = requireAuth(req, res);
    if (!authResult) return;

    if (modelsProxyCache && Date.now() - modelsProxyCache.at < 60 * 1000) {
      json(res, modelsProxyCache.data, 200, req);
      return;
    }
    try {
      const gwKey = process.env.GATEWAY_API_KEY || null;
      const r = await fetch(`${process.env.LLM_GATEWAY_URL || cfg.gatewayUrl || 'http://127.0.0.1:3400'}/v1/models`, {
        headers: { ...gatewayIdentityHeaders(), ...(gwKey ? { Authorization: `Bearer ${gwKey}` } : {}) }
      });
      if (!r.ok) { json(res, { error: `gateway ${r.status}` }, 502, req); return; }
      const data = await r.json();
      modelsProxyCache = { at: Date.now(), data };
      json(res, data, 200, req);
    } catch (e) {
      json(res, { error: e.message }, 502, req);
    }
  },

  // ============================================
  // nSpeech same-origin proxy (TTS)
  //
  // The view must not talk to nSpeech directly — nSpeech binds localhost on
  // the server host, so remote clients can't reach it. All TTS traffic
  // (engines/voices catalogs + binary speech streams) is proxied through the
  // backend. Audio responses are PIPED chunk-by-chunk, never buffered.
  'GET /api/tts/v1/voices': (req, res) => proxyTts(req, res, '/v1/voices'),
  'GET /api/tts/v1/admin/engines': (req, res) => proxyTts(req, res, '/v1/admin/engines'),
  // Model catalog for cloud engines (engine + slug list, OpenAI-style) — feeds
  // the TTS settings model selector.
  'GET /api/tts/v1/models': (req, res) => proxyTts(req, res, '/v1/models'),
  'POST /api/tts/v1/audio/speech': (req, res) => proxyTts(req, res, '/v1/audio/speech'),

  // Device diagnostics (issue #63): a phone has no devtools, so the Web Audio
  // path reports its own state here and it lands in the server log.
  'POST /api/client-diag': async (req, res) => {
    const authResult = requireAuth(req, res);
    if (!authResult) return;
    const body = await readBody(req);
    logger.info('client-diag', body, 'Diag');
    json(res, { ok: true }, 200, req);
  },

  // nVoice same-origin relay (STT) — same rationale as the TTS proxy above:
  // nVoice binds localhost on the server host. The WS half (realtime audio +
  // wakeword) is handled by the server 'upgrade' listener, not this table.
  'GET /api/stt/v1/realtime/sessions': (req, res) => stt.proxyRest(req, res),
  'POST /api/stt/v1/audio/cleanup': (req, res) => stt.proxyRest(req, res),

  // Preview fetch proxy (same-origin, architecture §8): the view must not
  // talk to the MCP server directly — it binds localhost on the server host,
  // so remote clients (and any browser when MCP is down) can't reach it.
  // /storage/... paths resolve against the user's MCP storage origin;
  // absolute http(s) URLs pass through. Bounded (10s), text-only.
  'GET /api/preview/fetch': async (req, res) => {
    const authResult = requireAuth(req, res);
    if (!authResult) return;
    const { user, dbInstance } = authResult;
    const raw = new URL(req.url, 'http://localhost').searchParams.get('url');
    if (!raw) { json(res, { error: 'url query param required' }, 400, req); return; }
    let target;
    if (/^https?:\/\//i.test(raw)) {
      target = raw;
    } else {
      const origin = await (await mcpPool.getForUser(user, dbInstance)).getStorageOrigin();
      target = origin.replace(/\/+$/, '') + (raw.startsWith('/') ? raw : '/' + raw);
    }
    try {
      const upstream = await fetch(target, { signal: AbortSignal.timeout(10000) });
      if (!upstream.ok) { json(res, { error: `upstream ${upstream.status} for ${target}` }, 502, req); return; }
      const bytes = Buffer.from(await upstream.arrayBuffer());
      const text = decodePreviewText(bytes, upstream.headers.get('content-type'));
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(canonicalizeStorageUrls(text));
    } catch (e) {
      json(res, { error: e.statusCode === 415 ? e.message : `preview fetch failed: ${e.message}` }, e.statusCode || 502, req);
    }
  },

  // Frontend telemetry — receive client-side log events and forward to nLogger
  'POST /api/client-log': async (req, res) => {
    const body = await readBody(req);
    const { category, message, meta } = body || {};
    if (!category || !message) {
      json(res, { error: 'category and message required' }, 400, req);
      return;
    }
    logger.info(message, meta || {}, category);
    json(res, { ok: true }, 200, req);
  },
  
  // Auth endpoints (Phase 1)
  'POST /api/auth/login': async (req, res) => {
    const body = await readBody(req);
    const { username, password } = body;
    
    if (!username || !password) {
        return json(res, { error: 'Username and password required' }, 400);
    }
    
    const userRows = await usersDb.findAll('username', username);
    const user = userRows.find(d => d._type === 'user');
    if (!user) {
        // Delay to mitigate brute force
        await new Promise(r => setTimeout(r, 2000));
        return json(res, { error: 'Invalid credentials' }, 401);
    }
    
    if (user.rights?.login === false) {
        return json(res, { error: 'Login disabled for this account' }, 403);
    }
    
    const storedParts = user.passwordHash.split(':');
    const storedSalt = storedParts[0];
    const storedHash = storedParts.slice(1).join(':');
    const requestHash = crypto.scryptSync(password, storedSalt, 64).toString('hex');
    
    if (storedHash !== requestHash) {
        await new Promise(r => setTimeout(r, 2000));
        return json(res, { error: 'Invalid credentials' }, 401);
    }
    
    // Login successful — mint a NEW session (do not overwrite existing ones:
    // the same credentials may attach from multiple devices simultaneously).
    const userToken = 'sess_' + crypto.randomUUID().replace(/-/g, '');
    const now = new Date().toISOString();
    await usersDb.insert({ _type: 'auth_session', token: userToken, userId: user.id, createdAt: now, lastAccess: now });
    user.lastAccess = now;
    await usersDb.set(user._id, 'lastAccess', now);
    
    // Check if user requires initialization of settings in their chat db
    const dbInstance = getOrLoadUserDb(user);
    const settingsDocs = await dbInstance.db.findAll('id', user.id);
    const settings = settingsDocs.find(d => d._type === 'user_settings');
    if (!settings) {
        await dbInstance.db.insert({
            _type: 'user_settings',
            id: user.id,
            displayName: user.displayName,
            settings: {} // Phase 3 placeholder
        });
    }

    res.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': `userToken=${userToken}; Path=/; Max-Age=86400; HttpOnly; SameSite=Lax`,
        'Access-Control-Allow-Origin': req.headers.origin || '*',
        'Access-Control-Allow-Credentials': 'true'
    });
    res.end(JSON.stringify({ 
        success: true, 
        userId: user.id, 
        displayName: user.displayName, 
        rights: user.rights 
    }));
  },

  'POST /api/auth/logout': async (req, res) => {
    // Revoke only THIS session — other devices stay logged in.
    const token = parseCookies(req).userToken;
    if (token) {
        const sessionRows = await usersDb.findAll('token', token);
        const session = sessionRows.find(d => d._type === 'auth_session');
        if (session) await usersDb.delete(session._id);
    }
    
    res.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': `userToken=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`,
        'Access-Control-Allow-Origin': req.headers.origin || '*',
        'Access-Control-Allow-Credentials': 'true'
    });
    res.end(JSON.stringify({ success: true }));
  },

  'GET /api/auth/session': async (req, res) => {
    // Only check if cookie has valid token, do not bounce or redirect
    const user = req.auth?.user || null;
    if (!user) {
        return json(res, { error: 'Unauthorized' }, 401);
    }
    
    // Provide CORS credentials capability
    res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': req.headers.origin || '*',
        'Access-Control-Allow-Credentials': 'true'
    });
    res.end(JSON.stringify({ 
        userId: user.id, 
        displayName: user.displayName, 
        rights: user.rights 
    }));
  },

  // Legacy key endpoint (removed or returning 410)
  'POST /api/auth/key': async (req, res) => {
    json(res, { error: 'Cookie authentication required. Update client.' }, 410);
  },

  // ============================================
  // Admin Endpoints
  // ============================================

  'GET /api/admin/users': async (req, res) => {
    const authResult = requireAuth(req, res);
    if (!authResult) return;
    if (!authResult.user.rights?.admin) return json(res, { error: 'Forbidden' }, 403, req);

    const users = (await usersDb.findAll('_type', 'user')).map(u => ({
        id: u.id,
        username: u.username,
        displayName: u.displayName,
        dbPath: u.dbPath,
        rights: u.rights,
        lastAccess: u.lastAccess,
        createdAt: u.createdAt
    }));
    json(res, { data: users }, 200, req);
  },

  'POST /api/admin/users': async (req, res) => {
    const authResult = requireAuth(req, res);
    if (!authResult) return;
    if (!authResult.user.rights?.admin) return json(res, { error: 'Forbidden' }, 403, req);

    const body = await readBody(req);
    const { username, password, displayName, dbPath, rights } = body;

    if (!username || !password) {
        return json(res, { error: 'Username and password are required' }, 400, req);
    }
    
    // Validate bounds — the username also names the user's nDB database, so it
    // must satisfy both the app rule and nDB's `[a-zA-Z0-9._-]` name rule.
    if (typeof username !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(username)) {
        return json(res, { error: 'Invalid username format' }, 400, req);
    }

    const existing = (await usersDb.findAll('username', username)).filter(d => d._type === 'user');
    if (existing.length > 0) {
        return json(res, { error: 'Username already exists' }, 400, req);
    }

    // The per-user database is created here: a registered user without a
    // readable database is a broken account, so a create failure aborts the
    // request loudly (nothing is registered).
    let dbName;
    try {
        dbName = await ensureUserDb(username);
    } catch (err) {
        logger.error('User database creation failed', err, { username }, 'Admin');
        return json(res, { error: `Could not create the user database: ${err.message}` }, 503, req);
    }

    const salt = require('crypto').randomBytes(16).toString('hex');
    const hash = require('crypto').scryptSync(password, salt, 64).toString('hex');
    const newUserId = `user-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`;

    const newUser = {
        _type: 'user',
        id: newUserId,
        username: username,
        displayName: displayName || username,
        dbPath: dbPath || dbName,
        passwordHash: salt + ':' + hash,
        rights: rights || { login: true, read: true, write: true },
        lastAccess: null,
        createdAt: new Date().toISOString()
    };

    await usersDb.insert(newUser);
    await usersDb.compact();

    logger.info('User created via admin API', { adminId: authResult.user.id, newUserId, username, db: dbName }, 'Admin');

    json(res, { 
        success: true, 
        user: {
            id: newUser.id,
            username: newUser.username,
            displayName: newUser.displayName,
            dbPath: newUser.dbPath,
            rights: newUser.rights
        }
    }, 201, req);
  },

  'DELETE /api/admin/users/:id': async (req, res, params) => {
    const authResult = requireAuth(req, res);
    if (!authResult) return;
    if (!authResult.user.rights?.admin) return json(res, { error: 'Forbidden' }, 403, req);

    const targetId = params.id;
    if (targetId === authResult.user.id) {
        return json(res, { error: 'Cannot delete yourself' }, 400, req);
    }

    const users = (await usersDb.findAll('id', targetId)).filter(d => d._type === 'user');
    if (users.length === 0) {
        return json(res, { error: 'User not found' }, 404, req);
    }

    const userToDelete = users[0];
    await usersDb.delete(userToDelete._id);
    await usersDb.compact();

    logger.info('User deleted via admin API', { adminId: authResult.user.id, targetId, username: userToDelete.username }, 'Admin');
    json(res, { success: true }, 200, req);
  },

  'PUT /api/admin/users/:id': async (req, res, params) => {
    const authResult = requireAuth(req, res);
    if (!authResult) return;
    if (!authResult.user.rights?.admin) return json(res, { error: 'Forbidden' }, 403, req);

    const body = await readBody(req);
    if (!body) return json(res, { error: 'Invalid payload' }, 400, req);

    const targetId = params.id;
    const users = (await usersDb.findAll('id', targetId)).filter(d => d._type === 'user');
    if (users.length === 0) {
        return json(res, { error: 'User not found' }, 404, req);
    }

    const targetUser = users[0];
    let changed = false;

    if (body.displayName !== undefined && targetUser.displayName !== body.displayName) {
        targetUser.displayName = body.displayName;
        changed = true;
    }
    if (body.dbPath !== undefined && targetUser.dbPath !== body.dbPath) {
        targetUser.dbPath = body.dbPath;
        changed = true;
    }
    if (body.rights) {
        // Enforce rights to prevent disabling yourself from admin
        if (targetId === authResult.user.id && !body.rights.admin) {
            body.rights.admin = true;
        }
        targetUser.rights = body.rights;
        changed = true;
    }
    if (body.password) {
        const newSalt = crypto.randomBytes(16).toString('hex');
        targetUser.passwordHash = newSalt + ':' + crypto.scryptSync(body.password, newSalt, 64).toString('hex');
        changed = true;
    }

    if (changed) {
        await revokeAllSessions(targetId); // force re-login
        await usersDb.update(targetUser._id, targetUser);
        await usersDb.compact();
        logger.info('User updated via admin API', { adminId: authResult.user.id, targetId, username: targetUser.username }, 'Admin');
    }

    json(res, { success: true }, 200, req);
  },
  'POST /api/admin/users/:id/reset-password': async (req, res, params) => {
    const authResult = requireAuth(req, res);
    if (!authResult) return;
    if (!authResult.user.rights?.admin) return json(res, { error: 'Forbidden' }, 403, req);

    const body = await readBody(req);
    if (!body || !body.password) return json(res, { error: 'Password required' }, 400, req);

    const targetId = params.id;
    const users = (await usersDb.findAll('id', targetId)).filter(d => d._type === 'user');
    if (users.length === 0) return json(res, { error: 'User not found' }, 404, req);

    const userToUpdate = users[0];
    const newSalt = crypto.randomBytes(16).toString('hex');
    userToUpdate.passwordHash = newSalt + ':' + crypto.scryptSync(body.password, newSalt, 64).toString('hex');
    await revokeAllSessions(targetId); // force re-login
    
    await usersDb.update(userToUpdate._id, userToUpdate);
    await usersDb.compact();

    logger.info('User password reset via admin API', { adminId: authResult.user.id, targetId, username: userToUpdate.username }, 'Admin');
    json(res, { success: true }, 200, req);
  },
  
  // ============================================
  // User Settings API
  // ============================================

  'GET /api/user/settings': async (req, res) => {
    const authResult = requireAuth(req, res);
    if (!authResult) return;
    const { user, dbInstance } = authResult;

    let settingsDoc = (await dbInstance.db.findAll('id', user.id)).find(d => d._type === 'user_settings');
    if (!settingsDoc) {
      settingsDoc = {
        _type: 'user_settings',
        id: user.id,
        displayName: user.displayName,
        settings: {
            location: 'Germany',
            language: 'English',
            defaultTemperature: 0.7,
            defaultModel: '',
            defaultMaxTokens: null,
            systemPresets: [],
            mcpServers: [],
            visionEnabled: false,
            ttsEndpoint: '',
            ttsVoice: '',
            ttsSpeed: 1.0
        }
      };
      await dbInstance.db.insert(settingsDoc);
    }
    json(res, settingsDoc, 200, req);
  },

  'PUT /api/user/settings': async (req, res) => {
    const authResult = requireAuth(req, res);
    if (!authResult) return;
    const { user, dbInstance } = authResult;

    const body = await readBody(req);
    if (!body || !body.settings) return json(res, { error: 'Invalid settings payload' }, 400, req);

    let settingsDoc = (await dbInstance.db.findAll('id', user.id)).find(d => d._type === 'user_settings');
    if (!settingsDoc) {
      settingsDoc = {
        _type: 'user_settings',
        id: user.id,
        displayName: user.displayName,
        settings: body.settings
      };
      await dbInstance.db.insert(settingsDoc);
    } else {
      settingsDoc.settings = body.settings;
      await dbInstance.db.update(settingsDoc._id, settingsDoc);
    }
    json(res, settingsDoc, 200, req);
  },

  // ============================================
  // Chat API
  // ============================================

  // List sessions
  // SSE stream of list-level mutations (chat created/updated/deleted) — the
  // sidebar lives across devices, so a new chat on one device must appear on
  // all others. Mirrors the embed-events framing.
  'GET /api/events': async (req, res) => {
    const authResult = requireAuth(req, res);
    if (!authResult) return;
    const { user } = authResult;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });
    res.write(':ok\n\n');

    const onEvent = (payload) => {
      if (payload.userId !== user.id) return;
      try {
        res.write(`event: ${payload.event}\ndata: ${JSON.stringify(payload.data)}\n\n`);
      } catch (e) { /* client gone — cleaned up on close */ }
    };
    listEvents.on('event', onEvent);

    const keepalive = setInterval(() => {
      try { res.write(':keepalive\n\n'); } catch (e) {}
    }, 15000);

    req.on('close', () => {
      listEvents.off('event', onEvent);
      clearInterval(keepalive);
    });
  },

  'GET /api/chats': async (req, res) => {
    const authResult = requireAuth(req, res);
    if (!authResult) return;
    const { user, dbInstance } = authResult;
    const url = new URL(req.url, 'http://localhost');
    const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);
    const limitParam = url.searchParams.get('limit');
    const limit = limitParam === null ? 1000 : Math.max(1, Math.min(10000, parseInt(limitParam, 10) || 0));

    // Filtering, sorting and pagination run in Rust; the projection keeps the
    // (large) message arrays out of the response.
    const page = await dbInstance.db.query({
      filter: { _type: 'session' },
      sort: { field: 'updatedAt', dir: 'desc' },
      offset,
      limit
    });
    // Structure safety, as before: a legacy session doc that still carries an
    // inline `messages` array must belong to this user.
    const sessions = page.results.filter(s => Array.isArray(s.messages) ? s.userId === user.id : true);

    json(res, { data: sessions, total: page.total, offset, limit }, 200, req);
  },
  
  // Get session with messages (from conversation doc)
  'GET /api/chats/:id': async (req, res, params) => {
    const authResult = requireAuth(req, res);
    if (!authResult) return;
    const { user, dbInstance } = authResult;
    const { db } = dbInstance;

    const docs = await db.findAll('id', params.id);
    const session = docs.find(s => s._type === 'session');
    
    if (!session) {
      json(res, { error: 'Not found' }, 404, req);
      return;
    }
    
    // Try conversation doc first (post-migration)
    const convs = docs.filter(d => d._type === 'conversation');
    if (convs.length > 0) {
      const conv = convs[0];
      const msgs = conv.messages || [];
      for (const m of msgs) {
        if (m.attachments) m.attachments = convStore.densifyAttachments(m.attachments);
      }
      json(res, { session, messages: msgs }, 200, req);
      return;
    }
    
    // Fallback: legacy per-message docs
    const messages = (await db.findAll('sessionId', params.id))
      .filter(m => m._type === 'message')
      .sort((a, b) => a.turnIndex - b.turnIndex);
    
    json(res, { session, messages }, 200, req);
  },
  
  // Backward pagination for long conversations (Track 2a): the snapshot carries
  // only the tail window, so the view pages older turns from here. One
  // `_id`-only query for the document id, then a peeked slice — the multi-MB
  // conversation body never crosses the wire.
  'GET /api/chats/:id/messages': async (req, res, params) => {
    const authResult = requireAuth(req, res);
    if (!authResult) return;
    const { dbInstance } = authResult;
    const { db } = dbInstance;

    const url = new URL(req.url, 'http://localhost');
    const beforeRaw = url.searchParams.get('before');
    const before = beforeRaw === null || beforeRaw.trim() === '' ? NaN : Number(beforeRaw);
    if (!Number.isInteger(before) || before < 0) {
      json(res, { error: 'before must be a non-negative integer' }, 400, req);
      return;
    }
    const limitRaw = url.searchParams.get('limit');
    const limit = limitRaw === null || limitRaw.trim() === '' ? convStore.TAIL_PAGE_SIZE : Number(limitRaw);
    // `all=1` returns the whole prefix `[0 .. before)` in one peek — the view's
    // background hydration after the instant tail paint.
    const allRaw = url.searchParams.get('all');
    const all = allRaw === '1' || allRaw === 'true';

    try {
      const convId = await convStore.findConversationId(db, params.id);
      if (!convId) {
        json(res, { error: 'Conversation not found' }, 404, req);
        return;
      }
      const page = await convStore.loadConversationPage(db, convId, all ? { before, all: true } : { before, limit });
      json(res, {
        messages: page.messages.map((m, i) => convStore.viewMessage(m, page.baseIdx + i)),
        baseIdx: page.baseIdx,
        endIdx: page.endIdx,
        totalMessages: page.totalMessages,
        hasMore: page.hasMore,
        seq: page.seq
      }, 200, req);
    } catch (e) {
      json(res, { error: e.message }, 400, req);
    }
  },

  // Create session
  'POST /api/chats': async (req, res) => {
    const authResult = requireAuth(req, res);
    if (!authResult) return;
    const { user, dbInstance } = authResult;
    const { db } = dbInstance;

    const body = await readBody(req);
    const id = 'chat_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
    
    const session = {
      _type: 'session',
      id,
      userId: user.id, // Keep userId for semantic continuity, even though DB is isolated
      title: body.title || 'New Chat',
      mode: body.mode || 'direct',
      model: body.model || null,
      systemPrompt: body.systemPrompt || '',
      arenaConfig: body.arenaConfig || null,
      chunkTransform: body.chunkTransform === true,
      retirements: (body.retirements && typeof body.retirements === 'object' && !Array.isArray(body.retirements)) ? body.retirements : {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messageCount: 0,
      isPublic: false
    };
    
    await db.insert(session);
    L().info('Session created', { id, title: body.title || 'New Chat', mode: body.mode || 'direct', userId: user.id }, 'Session');
    
    // Also create empty conversation document
    const conv = {
      _type: 'conversation',
      id,
      userId: user.id,
      title: body.title || 'New Chat',
      mode: body.mode || 'direct',
      model: body.model || null,
      isPublic: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messageCount: 0,
      messages: []
    };
    await db.insert(conv);
    
    emitListEvent(user.id, 'chat.created', session);
    json(res, session, 201, req);
  },
  
  // Update session metadata (pinned, title, etc.)
  'PATCH /api/chats/:id': async (req, res, params) => {
    const authResult = requireAuth(req, res);
    if (!authResult) return;
    const { user, dbInstance } = authResult;
    const { db } = dbInstance;

    const body = await readBody(req);
    const docs = await db.findAll('id', params.id);
    const session = docs.find(s => s._type === 'session');
    if (!session) { json(res, { error: 'Not found' }, 404, req); return; }
    if (body.pinned !== undefined) session.pinned = !!body.pinned;
    if (body.title !== undefined) session.title = body.title;
    if (body.model !== undefined) session.model = body.model;
    if (body.systemPrompt !== undefined) session.systemPrompt = body.systemPrompt;
    if (body.category !== undefined) session.category = body.category;
    if (body.chunkTransform !== undefined) session.chunkTransform = !!body.chunkTransform;
    if (body.assistantMode !== undefined) session.assistantMode = !!body.assistantMode;
    if (body.retirements !== undefined) {
      if (body.retirements === null || typeof body.retirements !== 'object' || Array.isArray(body.retirements)) {
        json(res, { error: 'retirements must be an object map { [contentHash]: { distill, at } }' }, 400, req); return;
      }
      session.retirements = body.retirements;
    }
    if (body.summary !== undefined && (body.summary === null || typeof body.summary !== 'object' || Array.isArray(body.summary))) {
      json(res, { error: 'summary must be an object {title, teaser, reflection}' }, 400, req); return;
    }
    if (body.summary !== undefined) session.summary = body.summary;
    if (body.arenaConfig !== undefined) session.arenaConfig = body.arenaConfig;
    session.updatedAt = new Date().toISOString();
    await db.update(session._id, session);
    emitListEvent(user.id, 'chat.updated', session);
    // #27 — model changed out-of-band (settings save): sync a mounted runner's
    // session copy (nDB returns detached objects) and converge its views.
    if (body.model !== undefined) {
      const r = runner.peekRunner(user.id, params.id);
      if (r) {
        r.session.model = body.model;
        r.broadcast('model.changed', { model: body.model });
      }
    }
    // assistantMode toggled out-of-band: sync the mounted runner's in-memory
    // session (nDB returns detached objects) so the next run's system prompt
    // carries/drops the voice block without a remount.
    if (body.assistantMode !== undefined) {
      const r = runner.peekRunner(user.id, params.id);
      if (r) r.session.assistantMode = !!body.assistantMode;
    }
    json(res, session, 200, req);
  },
  
  // Add message (appends to conversation doc) — thin HTTP wrapper over convStore
  'POST /api/chats/:id/messages': async (req, res, params) => {
    const authResult = requireAuth(req, res);
    if (!authResult) return;
    const { user, dbInstance } = authResult;
    const { db } = dbInstance;

    const body = await readBody(req);
    const docs = await db.findAll('id', params.id);
    const session = docs.find(s => s._type === 'session');
    
    if (!session) {
      json(res, { error: 'Not found' }, 404, req);
      return;
    }
    
    const { message } = await convStore.appendConversationMessage(
      { user, dbInstance, embedMessageAsync, log: L() },
      { ...body, conversationId: params.id }
    );
    json(res, message, 201, req);
  },
  
  // Replace entire messages array (delete/edit/truncate) — thin HTTP wrapper over convStore
  'PUT /api/chats/:id/messages': async (req, res, params) => {
    const authResult = requireAuth(req, res);
    if (!authResult) return;
    const { user, dbInstance } = authResult;
    const { db } = dbInstance;

    const body = await readBody(req);
    if (!Array.isArray(body.messages)) {
      json(res, { error: 'Expected { messages: [...] }' }, 400, req);
      return;
    }

    const convs = (await db.findAll('id', params.id)).filter(d => d._type === 'conversation');
    if (convs.length === 0) {
      json(res, { error: 'Conversation not found' }, 404, req);
      return;
    }

    const { messageCount } = await convStore.replaceConversationMessages(
      { user, dbInstance, embedMessageAsync, log: L() },
      { conversationId: params.id, messages: body.messages }
    );
    json(res, { success: true, messageCount }, 200, req);
  },
  
  // ---- ConversationRunner (PA-3): server-owned conversation surface ----
  // Append user message + start (or queue) a run
  'POST /api/chats/:id/send': async (req, res, params) => {
    const authResult = requireAuth(req, res);
    if (!authResult) return;
    const { user, dbInstance } = authResult;

    const body = await readBody(req);
    try {
      const r = await runner.getRunner(user, dbInstance, params.id);
      const { message } = await r.send(body);
      json(res, { message }, 201, req);
    } catch (e) {
      // Invalid previewContext (or any other caller-shaped rejection) is a 400 —
      // everything else on this route is a missing/unknown conversation.
      const invalid = e.status === 400 || e.statusCode === 400;
      json(res, { error: e.message }, invalid ? 400 : 404, req);
    }
  },
  
  // Hosted app lifecycle notification (#58 Stage 2). The browser parent has
  // already verified origin/source/instance; the runner re-validates the event
  // against the appInstanceId persisted in this conversation's chat_app_open
  // tool message before appending it to the canonical document.
  'POST /api/chats/:id/app-events': async (req, res, params) => {
    const authResult = requireAuth(req, res);
    if (!authResult) return;
    const { user, dbInstance } = authResult;

    const body = await readBody(req);
    try {
      const result = await (await runner.getRunner(user, dbInstance, params.id)).recordAppEvent(body);
      json(res, result, result.duplicate ? 200 : 201, req);
    } catch (e) {
      json(res, { error: e.message }, e.statusCode || 400, req);
    }
  },

  // Attach to the conversation event stream (SSE — response stays open)
  'GET /api/chats/:id/events': async (req, res, params) => {
    const authResult = requireAuth(req, res);
    if (!authResult) return;
    const { user, dbInstance } = authResult;

    try {
      const session = (await dbInstance.db.findAll('id', params.id)).find(s => s._type === 'session');
      if (session?.mode === 'arena') {
        await (await arenaRunner.getArenaRunner(user, dbInstance, params.id)).attach(req, res);
      } else {
        (await runner.getRunner(user, dbInstance, params.id)).attach(req, res); // do NOT json()/end — SSE stays open
      }
    } catch (e) {
      json(res, { error: e.message }, 404, req);
    }
  },

  // Snapshot over REST — the multiplexed view (runner-client.js) fetches state
  // here instead of holding a per-chat SSE open (issue #19). Arena keeps the
  // per-chat /events stream above.
  'GET /api/chats/:id/snapshot': async (req, res, params) => {
    const authResult = requireAuth(req, res);
    if (!authResult) return;
    const { user, dbInstance } = authResult;

    try {
      json(res, await (await runner.getRunner(user, dbInstance, params.id)).buildSnapshot(), 200, req);
    } catch (e) {
      json(res, { error: e.message }, 404, req);
    }
  },
  
  // Abort the active run
  'POST /api/chats/:id/abort': async (req, res, params) => {
    const authResult = requireAuth(req, res);
    if (!authResult) return;
    const { user, dbInstance } = authResult;

    try {
      const r = await runner.getRunner(user, dbInstance, params.id);
      json(res, { aborted: r.abort() }, 200, req);
    } catch (e) {
      json(res, { error: e.message }, 404, req);
    }
  },

  // Retry the last failed run: drops the trailing failure note(s) and re-kicks
  // the chain (the pending user message is still in history).
  'POST /api/chats/:id/retry': async (req, res, params) => {
    const authResult = requireAuth(req, res);
    if (!authResult) return;
    const { user, dbInstance } = authResult;

    try {
      const r = await runner.getRunner(user, dbInstance, params.id);
      if (r.running) {
        json(res, { error: 'A run is already in progress.' }, 409, req);
        return;
      }
      json(res, await r.retry(), 200, req);
    } catch (e) {
      json(res, { error: e.message }, 404, req);
    }
  },

  // ---- ArenaRunner (Phase D): server-owned autonomous arena ----
  // Start (or restart) the turn loop. Config is already on the session's
  // arenaConfig (set at creation); the body is optional overrides.
  'POST /api/arena/:id/start': async (req, res, params) => {
    const authResult = requireAuth(req, res);
    if (!authResult) return;
    const { user, dbInstance } = authResult;

    const body = await readBody(req);
    try {
      const r = await arenaRunner.getArenaRunner(user, dbInstance, params.id);
      await r.start(body || {});
      json(res, { started: true }, 200, req);
    } catch (e) {
      json(res, { error: e.message }, 404, req);
    }
  },

  // Stop the turn loop (aborts the in-flight turn).
  'POST /api/arena/:id/stop': async (req, res, params) => {
    const authResult = requireAuth(req, res);
    if (!authResult) return;
    const { user, dbInstance } = authResult;

    try {
      const r = await arenaRunner.getArenaRunner(user, dbInstance, params.id);
      r.stop();
      json(res, { stopped: true }, 200, req);
    } catch (e) {
      json(res, { error: e.message }, 404, req);
    }
  },
  
  // Delete one message (single-author write through the runner)
  'DELETE /api/chats/:id/messages/:messageId': async (req, res, params) => {
    const authResult = requireAuth(req, res);
    if (!authResult) return;
    const { user, dbInstance } = authResult;

    try {
      const r = await runner.getRunner(user, dbInstance, params.id);
      json(res, await r.deleteMessage(params.messageId), 200, req);
    } catch (e) {
      json(res, { error: e.message }, 404, req);
    }
  },

  // Edit a user message in place and re-run from it
  'PATCH /api/chats/:id/messages/:messageId': async (req, res, params) => {
    const authResult = requireAuth(req, res);
    if (!authResult) return;
    const { user, dbInstance } = authResult;

    const body = await readBody(req);
    try {
      const r = await runner.getRunner(user, dbInstance, params.id);
      json(res, await r.editMessage(params.messageId, body.content), 200, req);
    } catch (e) {
      json(res, { error: e.message }, 404, req);
    }
  },
  
  // Delete session
  'DELETE /api/chats/:id': async (req, res, params) => {
    const authResult = requireAuth(req, res);
    if (!authResult) return;
    const { user, dbInstance } = authResult;
    const { db } = dbInstance;

    const docs = await db.findAll('id', params.id);
    const session = docs.find(s => s._type === 'session');
    
    if (!session) {
      json(res, { error: 'Not found' }, 404, req);
      return;
    }
    
    // Soft delete session, conversation doc, and legacy messages
    await db.delete(session._id);
    const convs = docs.filter(d => d._type === 'conversation');
    
    // Extract file references for garbage collection + the nVDB chunk ids this
    // conversation owns (a shared collection, so nothing removes them implicitly).
    const fileRefsToRelease = [];
    const idsToDelete = [];
    
    for (const c of convs) {
        if (c.messages) {
          c.messages.forEach((m, idx) => {
            if (m.id) idsToDelete.push(...collectMessageChunkIds(user.id, params.id, m, m.idx ?? idx, NVDB_CHUNK_OPTS));
          });
          for (const m of c.messages) {
            if (m.attachments) {
              for (const att of m.attachments) {
                if (att._file) {
                  fileRefsToRelease.push(att._file);
                } else {
                  const url = att.url || att.dataUrl;
                  if (url && url.startsWith('/api/buckets/')) {
                    const parts = url.split('/');
                    if (parts.length >= 5) {
                      fileRefsToRelease.push(`${parts[3]}:${parts.pop().split('?')[0]}`);
                    }
                  } else if (url && /^\w+:\w+\.\w+$/.test(url)) {
                    fileRefsToRelease.push(url);
                  }
                }
              }
            }
          }
        }
        await db.delete(c._id);
      }

      if (idsToDelete.length > 0 && dbInstance.nvdbClient) {
        try {
          await dbInstance.nvdbClient.deleteIds(NVDB_COLLECTION, idsToDelete, { commit: true });
        } catch (err) {
          // The nDB delete is already done; an nVDB outage must not turn a
          // successful deletion into a 500. The chunks are orphaned until the
          // seq-sync delete sweep purges them (reconcile + forceVerify rebuild).
          if (!isNvdbUnavailableError(err)) throw err;
          markNvdbFailure(dbInstance, err, 'chatDelete');
        }
      }
      
      const messages = await db.findAll('sessionId', params.id);
      for (const m of messages) {
        if (m._type === 'message') await db.delete(m._id);
      }
      
      // Trigger bucket clean up through the engine's reference-aware release
      for (const ref of fileRefsToRelease) {
        try {
          const [bucket, file] = ref.split(':');
          if (!bucket || !file) throw new Error(`malformed file reference '${ref}'`);
          await db.releaseFile(bucket, file);
        } catch (e) {
          logger.error('Failed to release file', e.message, { ref }, 'Storage');
        }
      }
      
      emitListEvent(user.id, 'chat.deleted', { id: params.id });
      json(res, { success: true }, 200, req);
    },
    
  // Search (hybrid: nVDB semantic + text fallback)
  'POST /api/search': async (req, res) => {
    const authResult = requireAuth(req, res);
    if (!authResult) return;
    const { user, dbInstance } = authResult;

    const body = await readBody(req);
    // Single implementation: shared with the runner's chat_archive_search (PB-b).
    const data = await internalTools.searchArchive(dbInstance, body, {
      userId: user.id,
      nvdbClient,
      nvdbCollection: NVDB_COLLECTION,
      rerankerLoaded: nvdbRerankerLoaded,
      queryInstruct: QUERY_INSTRUCT,
      relevanceFloor: RELEVANCE_FLOOR,
      embedBatch,
      embedAvailable,
      onNvdbError: (err) => markNvdbFailure(dbInstance, err, 'searchArchive'),
      log: L()
    });
    json(res, data, 200, req);
  },

  // List arena sessions (public)
  'GET /api/arena': async (req, res) => {
    const authResult = requireAuth(req, res);
    if (!authResult) return;
    const { user, dbInstance } = authResult;
    
    const arenas = (await dbInstance.db.findAll('_type', 'session'))
      .filter(s => Array.isArray(s.messages) ? s.userId === user.id : true)
      .filter(s => s.mode === 'arena')
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    
    json(res, { data: arenas }, 200, req);
  },

  // Find session references (lineage tracking)
  'POST /api/references': async (req, res) => {
    const authResult = requireAuth(req, res);
    if (!authResult) return;
    const { user, dbInstance } = authResult;

    const body = await readBody(req);
    // Single implementation: shared with the runner's chat_archive_find_references (PB-b).
    try {
      const data = await internalTools.findReferences(dbInstance.db, body);
      json(res, data, 200, req);
    } catch (e) {
      json(res, { error: e.message }, 400, req);
    }
  },

  // (file serving handled below via prefix check)

};

// ============================================
// Static Files
// ============================================

function serveFile(req, res, filepath) {
  fs.readFile(filepath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    
    const ext = path.extname(filepath).toLowerCase();
    const mime = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.svg': 'image/svg+xml'
    }[ext] || 'application/octet-stream';
    
    const headers = { 'Content-Type': mime };
    sendBody(req, res, data, headers, 200);
  });
}

// ============================================
// Router
// ============================================

const server = http.createServer(async (req, res) => {
  const startTime = Date.now();
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  let pathname = parsedUrl.pathname;

  const logRequest = (status) => {
    if (!pathname.startsWith('/api/') && pathname !== '/health') return;
    const ms = Date.now() - startTime;
    const method = req.method;
    const fullPath = pathname + parsedUrl.search;
    if (status < 400) {
      L().info(`${method} ${fullPath}`, { status, ms }, 'HTTP');
    } else if (status < 500) {
      L().warn(`${method} ${fullPath}`, { status, ms }, 'HTTP');
    } else {
      L().error(`${method} ${fullPath}`, null, { status, ms }, 'HTTP');
    }
  };

  // Wrap res.end to capture status
  const origEnd = res.end.bind(res);
  let _status = 200;
  res.end = function(...args) {
    logRequest(_status);
    return origEnd(...args);
  };
  const origWriteHead = res.writeHead.bind(res);
  res.writeHead = function(status, ...args) {
    if (typeof status === 'number') _status = status;
    return origWriteHead(status, ...args);
  };
  
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-API-Key'
    });
    res.end();
    return;
  }

  // Auth lives behind `ndb serve` now, so it is resolved ONCE per request here
  // rather than inside every handler (requireAuth reads req.auth). A failure to
  // reach that backend is a 503 — never a 401 that blames the caller.
  const authSurface = pathname.startsWith('/api/')
    || pathname.startsWith('/files/')
    || /^\/(?:chat\/)?storage(\/|$)/.test(pathname);
  if (authSurface) {
    try {
      req.auth = await resolveAuth(req);
    } catch (err) {
      L().error('Auth resolution failed', err, { url: pathname }, 'Auth');
      json(res, { error: `Authentication backend unavailable: ${err.message}` }, 503);
      return;
    }
  }

  // Storage proxy (issue #36) — same-origin /storage/* → MCP storage server,
  // cookie-auth'd. Handled BEFORE the static fallback so it can't be shadowed by
  // a file on disk, and BEFORE the trailing-slash index normalization below —
  // `/storage/` is a DIRECTORY LISTING request, not a directory holding an
  // index.html (that normalization turned it into `/storage/index.html` and the
  // listing 404'd).
  //
  // Accepts an optional /chat prefix: behind nPort the route is stripPath:false,
  // so the public path /chat/storage/... arrives here verbatim. Both forms, and
  // the bare `/storage` the file browser may ask for, reach the same handler.
  const storageMatch = pathname.match(/^\/(?:chat\/)?storage(?:\/(.*))?$/);
  if (storageMatch && (req.method === 'GET' || req.method === 'HEAD')) {
    let storagePath;
    try {
      storagePath = decodeURIComponent(storageMatch[1] || '');
    } catch (e) {
      json(res, { error: 'Malformed storage path' }, 400, req);
      return;
    }
    await proxyStorage(req, res, storagePath);
    return;
  }

  // Redirect root to /chat/ (needed for relative resource paths)
  if (pathname === '/' || pathname === '/chat') {
    res.writeHead(302, { 'Location': '/chat/' });
    res.end();
    return;
  }
  if (pathname === '/chat/') {
    pathname = '/chat/index.html';
  }
  // Directory URLs resolve to their index (fixes /view/ → EISDIR → 500)
  if (pathname.endsWith('/') && pathname !== '/') {
    pathname += 'index.html';
  }
  if (pathname === '/chat-arena') {
    res.writeHead(302, { 'Location': '/chat-arena/' });
    res.end();
    return;
  }
  if (pathname === '/chat-arena/') {
    pathname = '/chat-arena/index.html';
  }

  // File serving from data directory (issue #35). Cookie-auth'd like every
  // other data route, and the resolved path MUST stay inside FILES_DIR:
  // decodeURIComponent runs before the join, so %2e%2e%2f would otherwise
  // escape the root (unauthenticated arbitrary read).
  if (pathname.startsWith('/files/')) {
    const authResult = requireAuth(req, res);
    if (!authResult) return;
    const subPath = req.url.slice(7).split('?')[0];
    let decoded;
    try {
      decoded = decodeURIComponent(subPath);
    } catch (e) {
      json(res, { error: 'Malformed path' }, 400, req);
      return;
    }
    const filesRoot = path.resolve(FILES_DIR);
    const filePath = path.resolve(filesRoot, decoded);
    if (filePath !== filesRoot && !filePath.startsWith(filesRoot + path.sep)) {
      logger.warn('Rejected path traversal attempt', { subPath, resolved: filePath }, 'Security');
      json(res, { error: 'Forbidden' }, 403, req);
      return;
    }
    try {
      if ((await fs.promises.stat(filePath)).isFile()) {
        serveFile(req, res, filePath);
      } else {
        json(res, { error: 'File not found' }, 404);
      }
    } catch (err) {
      json(res, { error: 'File not found' }, 404);
    }
    return;
  }

  // Route matching
  for (const [pattern, handler] of Object.entries(routes)) {
    const [method, routePath] = pattern.split(' ');
    
    if (req.method !== method) continue;
    
    // Simple param matching
    const routeParts = routePath.split('/');
    const pathParts = pathname.split('/');
    
    if (routeParts.length !== pathParts.length) continue;
    
    const params = {};
    let match = true;
    
    for (let i = 0; i < routeParts.length; i++) {
      if (routeParts[i].startsWith(':')) {
        params[routeParts[i].slice(1)] = pathParts[i];
      } else if (routeParts[i] !== pathParts[i]) {
        match = false;
        break;
      }
    }
    
    if (match) {
      try {
        await handler(req, res, params);
      } catch (err) {
        console.error('Route error:', err.message);
        json(res, { error: err.message }, 500);
      }
      return;
    }
  }
  
  // Fallback: serve static frontend
  
  // Intercept JS config to inject environment variables dynamically
  if (pathname === '/chat/js/config.js') {
    const instructions = await fetchPrimeDirective();

    const configObj = {
      gatewayUrl: process.env.LLM_GATEWAY_URL || 'http://127.0.0.1:3400',
      defaultModel: process.env.UI_DEFAULT_MODEL || '',
      defaultTemperature: parseFloat(process.env.UI_DEFAULT_TEMP || 0.7),
      defaultMaxTokens: process.env.UI_DEFAULT_TOKENS ? parseInt(process.env.UI_DEFAULT_TOKENS) : null,
      ttsEndpoint: '/api/tts', // same-origin proxy → nSpeech (see proxyTts); TTS_ENDPOINT env is the server-side nSpeech address
      ttsVoice: process.env.TTS_VOICE || '',
      ttsSpeed: parseFloat(process.env.TTS_SPEED || 1.0),
      mcpOrigin: MCP_URL || null, // backend workshop origin — server-side tools only
      mcpPublicOrigin: process.env.MCP_PUBLIC_ORIGIN || 'same-origin', // browser-facing hosted-app mapping; never an internal fallback
      backendUrl: '',
      enableBackend: true,
      enableArchiveTools: true,
      instructions
    };
    const body = `// Generated dynamically by server.js from .env\nwindow.CHAT_CONFIG = ${JSON.stringify(configObj, null, 4)};`;
    sendBody(req, res, body, { 'Content-Type': 'application/javascript' }, 200);
    return;
  }

  // Serve arena config (no prime directive injection for arena)
  if (pathname === '/chat-arena/js/config.js') {
    const arenaPath = path.join(__dirname, '..', 'chat-arena', 'js', 'config.js');
    try {
      const content = await fs.promises.readFile(arenaPath, 'utf8');
      sendBody(req, res, content, { 'Content-Type': 'application/javascript' }, 200);
    } catch (_) {
      res.writeHead(404);
      res.end('Not found');
    }
    return;
  }

  let filePath = pathname === '/' ? '/chat/index.html' : pathname;
  let fullPath = path.join(__dirname, '..', filePath);

  try {
    await fs.promises.stat(fullPath);
  } catch (err) {
    filePath = '/chat' + pathname;
    fullPath = path.join(__dirname, '..', filePath);
  }

  fs.readFile(fullPath, (err, data) => {
    if (err) {
      res.writeHead(err.code === 'ENOENT' ? 404 : 500);
      res.end(err.code === 'ENOENT' ? 'Not found' : 'Error');
      return;
      }
      const ext = path.extname(fullPath).toLowerCase();
      const mime = {
        '.html': 'text/html',
        '.js': 'application/javascript',
        '.css': 'text/css',
        '.json': 'application/json',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.svg': 'image/svg+xml'
      }[ext] || 'application/octet-stream';
      // Text assets must never be served stale. Hand-bumped ?v= cache-busters
      // were the previous defense and repeatedly went stale — and a versioned
      // query on a module URL that other modules import by bare path creates a
      // SECOND module instance (app configures one copy, the other renders).
      // no-store removes both problems: every load gets the file on disk.
      //
      // SVG counts as text here because SVG in this app is CODE, not content: the
      // Material icon sprite is part of the UI, and the 1h cache it used to get
      // meant a fixed sprite kept rendering stale for an hour (2026-09-20 — the
      // mic icon was correct on disk and the browser served the broken copy).
      // User media is served by the bucket route, which does its own caching, so
      // nothing that genuinely benefits from a cache is affected.
      const CACHEABLE = !/^text\/|javascript|json|svg/.test(mime);
      const headers = {
        'Content-Type': mime,
        'Cache-Control': CACHEABLE ? 'public, max-age=3600' : 'no-store'
      };
      sendBody(req, res, data, headers, 200);
    });
});

// STT relay: WebSocket upgrades (realtime STT + wakeword) → nVoice.
// First-ever upgrade handling on this server — see stt-relay.js for the splice.
server.on('upgrade', (req, socket, head) => stt.handleUpgrade(req, socket, head));

// nVDB v2 is a MIRROR: a missing index or reranker degrades search quality, and
// an unreachable service degrades to nDB-only — it no longer stops the process.
// The watchdog below reconnects and reconciles what was written meanwhile.
async function ensureNvdbCollection({ requireReranker = false } = {}) {
    const health = await nvdbClient.health({ timeoutMs: NVDB_HEALTH_TIMEOUT_MS });
    if (!health?.ok) {
        throw new Error(`nvdb serve unhealthy at ${NVDB_URL}: ${JSON.stringify(health)}`);
    }
    if (requireReranker && !health.reranker_loaded) {
        throw new Error(`nvdb serve at ${NVDB_URL} has reranker_loaded=false — start with --reranker-model`);
    }
    if (!health.reranker_loaded) {
        L().warn('nvdb serve has reranker_loaded=false — Level-2 rerank disabled', { url: NVDB_URL }, 'Server');
    }
    nvdbRerankerLoaded = Boolean(health.reranker_loaded);
    await nvdbClient.createCollection(NVDB_COLLECTION, chatCollectionConfig({
        embedDims: EMBEDDING_DIMS,
        embedModelVersion: EMBED_MODEL_VERSION
    }));
    return health;
}

async function initNvdb() {
    nvdbClient = createV2Client(NVDB_URL, { timeoutMs: 30_000 });
    try {
        await ensureNvdbCollection({ requireReranker: true });
        nvdbOnline = true;
        L().info('nVDB v2 connected', { url: NVDB_URL, collection: NVDB_COLLECTION, rerankerLoaded: nvdbRerankerLoaded }, 'Server');
    } catch (err) {
        if (!isNvdbUnavailableError(err)) throw err;
        nvdbOnline = false;
        L().error('nVDB unreachable at startup — running in nDB-only degraded mode; watchdog will auto-connect and reconcile', err, {
            url: NVDB_URL,
            collection: NVDB_COLLECTION
        }, 'Server');
    }
}

// Single-flight watchdog: reconnect, then repair every mounted user slice on
// recovery; while online, drain the dirty generations left by failed mirrors.
setInterval(async () => {
    if (nvdbWatchdogRunning) return;
    nvdbWatchdogRunning = true;
    try {
        if (!nvdbOnline) {
            let health;
            try {
                health = await nvdbClient?.health({ timeoutMs: NVDB_HEALTH_TIMEOUT_MS });
            } catch (err) {
                return; // still down — markNvdbFailure already recorded it
            }
            if (!health?.ok) return;
            // A transient failure here must not kill the interval callback — the
            // handle stays offline and the next tick retries cleanly.
            try {
                await ensureNvdbCollection();
            } catch (err) {
                L().warn('nVDB watchdog recovery attempt failed — staying offline, retrying next tick', err, {
                    url: NVDB_URL,
                    collection: NVDB_COLLECTION
                }, 'Server');
                return;
            }
            nvdbOnline = true;
            L().info('nVDB recovered — reconciling mounted user DBs', { url: NVDB_URL, collection: NVDB_COLLECTION }, 'Server');
            for (const instance of activeDbs.values()) {
                if (!instance.nvdbClient) continue;
                const gen = instance.nvdbDirtyGen;
                try {
                    await reconcileUserNvdb(instance, { forceVerify: true });
                    instance.nvdbSyncedGen = Math.max(instance.nvdbSyncedGen, gen);
                } catch (err) {
                    if (isNvdbUnavailableError(err)) markNvdbFailure(instance, err, 'nvdbWatchdog recovery');
                    else L().error('nVDB recovery reconcile failed', err, { userId: instance.userId, db: instance.dbName }, 'Server');
                }
            }
            return;
        }
        for (const instance of activeDbs.values()) {
            if (!instance.nvdbClient) continue;
            if (instance.nvdbDirtyGen <= instance.nvdbSyncedGen) continue;
            if (instance.reconcileRunning) continue;
            const gen = instance.nvdbDirtyGen;
            try {
                await reconcileUserNvdb(instance);
                instance.nvdbSyncedGen = Math.max(instance.nvdbSyncedGen, gen);
            } catch (err) {
                // Bumping the generation on a non-outage error would retry the
                // same failing reconcile forever; log it and leave the gen alone.
                if (isNvdbUnavailableError(err)) markNvdbFailure(instance, err, 'nvdbWatchdog');
                else L().error('nVDB watchdog reconcile failed', err, { userId: instance.userId, db: instance.dbName }, 'Server');
            }
        }
    } finally {
        nvdbWatchdogRunning = false;
    }
}, NVDB_WATCHDOG_MS).unref();

// Start HTTP server — only once nDB v2 answered and users_db is mounted. nVDB is
// a mirror and may be down (degraded mode + watchdog); nDB is the record.
startBackend()
  .then(() => initNvdb())
  .then(() => {
    server.listen(PORT, () => {
      if (logger) {
          logger.info('Chat Backend running', { port: PORT }, 'Server');
          logger.info('Health endpoint', { url: `http://localhost:${PORT}/health` }, 'Server');
      } else {
          console.log(`Chat Backend running on port ${PORT}`);
      }
    });
  })
  .catch(err => {
    logger?.error('FATAL: startup failed', err, { ndbUrl: NDB_URL, ndbUsersDb: NDB_USERS_DB, nvdbUrl: NVDB_URL, collection: NVDB_COLLECTION }, 'Server');
    console.error(err);
    process.exit(1);
  });