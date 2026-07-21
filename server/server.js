const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const zlib = require('zlib');
const { EventEmitter } = require('events');

const { Database: nDB } = require('../lib/ndb/napi');
const { Database: nVDB } = require('../lib/nvdb/napi');
const nLogger = require('../lib/nlogger-cjs');

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
const SESSION_TTL    = (cfg.sessionTtlMinutes || 1440) * 60 * 1000;
const EMBED_URL      = process.env.CHAT_EMBED_URL      || cfg.embedUrl          || 'http://192.168.0.100:3400/v1/embeddings';
const EMBED_MODEL    = process.env.CHAT_EMBED_MODEL    || cfg.embedModel        || null;
const EMBEDDING_DIMS = parseInt(process.env.CHAT_EMBED_DIMS || cfg.embedDims)   || 2560;
const EMBED_MAX_TOKENS = parseInt(process.env.CHAT_EMBED_MAX_TOKENS || cfg.embedMaxTokens) || 30000;
const EMBED_TOK_RATIO  = parseFloat(process.env.CHAT_EMBED_TOK_RATIO || cfg.embedTokRatio) || 2.5;

const EMBED_API_KEY = process.env.GATEWAY_API_KEY || cfg.embedApiKey || null;

const EMBED_HEADERS = {
    'Content-Type': 'application/json'
};
if (EMBED_API_KEY) {
    EMBED_HEADERS['Authorization'] = `Bearer ${EMBED_API_KEY}`;
}

// browser_fetch allowlist — exposed to the chat frontend as
// window.CHAT_CONFIG.browserFetchAllowedPrefixes. Each entry is
// { label, match } where match is a string prefix or RegExp source string.
// When omitted, the chat uses its built-in LAN-only default.
const BROWSER_FETCH_ALLOWLIST = Array.isArray(cfg.browserFetchAllowedPrefixes)
    ? cfg.browserFetchAllowedPrefixes
    : null;

let embedAvailable = true;
let embedFailCount = 0;

// ============================================
// Prime Directive (fetched from workshop, cached per-request)
// ============================================

async function fetchPrimeDirective() {
    try {
        const resp = await fetch('http://192.168.0.100:3100/docs/Workshop/Agents_Prime.md', {
            signal: AbortSignal.timeout(3000)
        });
        if (!resp.ok) return '';
        let md = await resp.text();
        // Strip YAML frontmatter (between first two --- lines)
        if (md.startsWith('---')) {
            const second = md.indexOf('---', 3);
            if (second !== -1) md = md.slice(second + 3).trimStart();
        }
        return md;
    } catch (_) { return ''; }
}

// ============================================
// Database & Routing
// ============================================

let usersDb = null;
let logger = null;

// Registry of loaded user databases (dbPath -> { db, vdb, embeddingsCol, ready, needsFlush, pendingQueue })
const activeDbs = new Map();

(async () => {
console.time('nLogger.init');
logger = await nLogger.init({ logsDir: path.resolve(LOGS_DIR), sessionPrefix: 'chat' });
console.timeEnd('nLogger.init');

logger.info('Chat Backend starting, loading users_db...', { port: PORT }, 'Server');

// 1. Initialise users_db global registry
const usersDbDir = path.dirname(path.resolve(USERS_DB_PATH));
if (!fs.existsSync(usersDbDir)) fs.mkdirSync(usersDbDir, { recursive: true });

usersDb = nDB.open(USERS_DB_PATH, {
    trash_ttl: 86400 * 7, // 7 days
    trash_purge_interval: 3600 // 1 hour
});
logger.info('users_db opened', { path: USERS_DB_PATH }, 'Auth');

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
    if (!u.dbPath) {
        logger.error('User missing dbPath, skipping', { username: u.username }, 'Auth');
        continue;
    }
    usersToSeed.push(u);
}

if (usersToSeed.length === 0) {
    logger.error('FATAL: No valid users configured (need at least one with a dbPath via ENV or config.users)', {}, 'Auth');
    console.error('FATAL: No valid users configured.');
    process.exit(1);
}

for (const userDef of usersToSeed) {
    const existing = usersDb.find('id', userDef.id).filter(d => d._type === 'user');
    if (existing.length === 0) {
        // Hash password with scryptSync and random salt
        const salt = crypto.randomBytes(16).toString('hex');
        const hash = crypto.scryptSync(userDef.password, salt, 64).toString('hex');
        usersDb.insert({
            _type: 'user',
            id: userDef.id,
            username: userDef.username,
            displayName: userDef.displayName || userDef.username,
            dbPath: userDef.dbPath,
            passwordHash: salt + ':' + hash,
            rights: userDef.rights || { login: true },
            userToken: null,
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
            doc.userToken = null; // force re-login on config footprint change
            usersDb.update(doc._id, doc);
            logger.info('User updated', { id: userDef.id, username: userDef.username, reason: changeReason }, 'Auth');
        }
    }
}
usersDb.compact();

// ============================================
// Maintenance Loops (Global across mounted DBs)
// ============================================

// Compaction for users_db and all mounted isolated DBs
setInterval(() => {
  if (usersDb) {
    try { usersDb.compact(); } catch(e) {}
  }
  for (const [dbPath, instance] of activeDbs.entries()) {
    try {
      instance.db.compact();
    } catch(err) {
      logger.error('nDB compact failed', err, { dbPath }, 'Server');
    }
  }
}, 5 * 60 * 1000);

// File Bucket Garbage Collection (runs every 6 hours)
// gcBuckets() returns a number (count of trashed files), not an object.
// Log unconditionally when >0 so orphaning is always visible in logs.
setInterval(() => {
  for (const [dbPath, instance] of activeDbs.entries()) {
    try {
      const trashed = instance.db.gcBuckets();
      if (trashed > 0) {
        logger.info('File GC completed', { dbPath, trashed }, 'Storage');
      }
    } catch(err) {
      logger.error('nDB gcBuckets failed', err, { dbPath }, 'Storage');
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

    // 2. Iterate each mounted database instance for pending embeds and flushing
    for (const [dbPath, instance] of activeDbs.entries()) {
        if (!instance.embeddingsCol) continue;

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
                embedMessageAsync(instance, item.msg, item.session, item.convNdbId, item.msgIdx, item.failCount || 0).catch(() => {});
            }
        }

        if (instance.needsFlush > 0) {
            try {
                const t0 = Date.now();
                instance.embeddingsCol.flush();
                logger.info('nVDB flushed', { dbPath, docs: instance.needsFlush, ms: Date.now() - t0 }, 'Embed');
                instance.needsFlush = 0;
            } catch (err) {
                logger.error('nVDB flush failed', err, { dbPath }, 'Embed');
            }
        }
    }
}, 5000);

})();

// ============================================
// Database Instantiation (Lazy Mounting Engine)
// ============================================

function getOrLoadUserDb(dbPath) {
    if (activeDbs.has(dbPath)) {
        return activeDbs.get(dbPath);
    }
    
    // We arrive here and must block initially for nDB.open
    logger.info('Mounting isolated user DB lazily', { dbPath }, 'Server');
    
    const absDbPath = path.resolve(dbPath);
    if (!fs.existsSync(absDbPath)) fs.mkdirSync(absDbPath, { recursive: true });
    
    const ndbPath = path.join(absDbPath, 'data.jsonl');
    const nvdbDir = path.join(absDbPath, 'nvdb');
    if (!fs.existsSync(nvdbDir)) fs.mkdirSync(nvdbDir, { recursive: true });
    
    console.time(`nDB.open:${dbPath}`);
    const db = nDB.open(ndbPath, {
        trash_ttl: 86400 * 7, // 7 days
        trash_purge_interval: 3600 // 1 hour
    });
    console.timeEnd(`nDB.open:${dbPath}`);
    
    let vdb, embeddingsCol;
    try {
        vdb = new nVDB(nvdbDir);
        const collections = vdb.listCollections();
        if (collections.includes('embeddings')) {
            embeddingsCol = vdb.getCollection('embeddings');
        } else {
            logger.info('Creating nVDB embeddings collection', { dbPath, dims: EMBEDDING_DIMS }, 'Server');
            embeddingsCol = vdb.createCollection('embeddings', EMBEDDING_DIMS);
        }
        logger.info('nVDB collection ready for user', { dbPath }, 'Server');
    } catch (err) {
        logger.warn('nVDB failed init for user', { dbPath, error: err.message, stack: err.stack }, 'Server');
    }
    
    const instance = {
        dbPath,
        db,
        vdb,
        embeddingsCol,
        pendingQueue: [],
        needsFlush: 0
    };
    
    activeDbs.set(dbPath, instance);
    
    // Reconcile pending embeddings on mount after a tiny delay
    if (embeddingsCol) {
        setTimeout(() => {
            try { embeddingsCol.flush(); } catch(e){}
            
            const sessions = {};
            for (const s of db.find('_type', 'session')) sessions[s.id] = s;
            const stale = [];
            const missingStatus = {}; // convNdbId -> Set of msg indices needing status backfill
            for (const c of db.find('_type', 'conversation')) {
                if (!c.messages) continue;
                const missing = [];
                for (let idx = 0; idx < c.messages.length; idx++) {
                    const m = c.messages[idx];
                    if (!m.id) continue;
                    if (m.role === 'tool') continue;
                    if (!embeddingsCol.get(m.id)) {
                        // Not in nVDB at all — re-embed regardless of prior status.
                        // 'failed' messages are retried too (gap filling): transient
                        // provider failures must not become permanent holes.
                        stale.push({ msg: m, session: sessions[c.id] || {}, convNdbId: c._id, idx });
                    } else if (!m.embedStatus || m.embedStatus === 'pending' || m.embedStatus === 'failed') {
                        // In nVDB but status was never written, still pending, or previously failed — backfill to embedded
                        missing.push(idx);
                    }
                }
                if (missing.length > 0) missingStatus[c._id] = missing;
            }
            if (stale.length > 0) {
                logger.info('Lazy reconciliation', { count: stale.length, dbPath }, 'Server');
                (async () => {
                    let succeeded = 0;
                    let failed = 0;
                    let retriedLater = 0;
                    const t0 = Date.now();
                    let gapMs = 500;
                    for (let i = 0; i < stale.length; i++) {
                        const { msg, session, convNdbId, idx } = stale[i];
                        try {
                            await embedMessageAsync(instance, msg, session, convNdbId, idx);
                            succeeded++;
                        } catch (err) {
                            // embedMessageAsync already retried internally and re-queued
                            // transient failures into pendingQueue. Permanent failures
                            // return without throwing, so a throw here means the message
                            // was re-queued for the background drain — count it separately.
                            retriedLater++;
                            logger.warn('Reconciliation item deferred', { msgId: msg.id, kind: err.kind, error: err.message }, 'Embed');
                        }
                        await new Promise(r => setTimeout(r, gapMs));
                        gapMs = Math.max(gapMs * 0.95, 200);
                        if ((i + 1) % 50 === 0 || i === stale.length - 1) {
                            const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
                            const done = i + 1;
                            const remaining = stale.length - done;
                            const rate = elapsed > 0 ? (done / (Date.now() - t0) * 60000).toFixed(1) : '0';
                            logger.info('Reconciliation progress', { done, total: stale.length, succeeded, failed, retriedLater, remaining, elapsedSec: elapsed, ratePerMin: rate, dbPath }, 'Server');
                        }
                    }
                    const totalSec = ((Date.now() - t0) / 1000).toFixed(1);
                    logger.info('Reconciliation complete', { total: stale.length, succeeded, failed, retriedLater, elapsedSec: totalSec, dbPath }, 'Server');
                })();
            }
            if (Object.keys(missingStatus).length > 0) {
                let count = 0;
                for (const [convNdbId, indices] of Object.entries(missingStatus)) {
                    for (const idx of indices) {
                        db.set(convNdbId, `messages.${idx}.embedStatus`, 'embedded');
                        db.set(convNdbId, `messages.${idx}.embedError`, null);
                        count++;
                    }
                }
                logger.info('Embed status backfilled', { count, dbPath }, 'Server');
            }
        }, 3000);
    }
    
    return instance;
}

// Embed event bus — SSE clients subscribe to receive real-time embed status updates
const embedEvents = new EventEmitter();
embedEvents.setMaxListeners(100);

const L = () => logger || { info() {}, warn() {}, error() {}, debug() {} };

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

function getAuthUser(req) {
    const cookies = parseCookies(req);
    const token = cookies.userToken;
    if (!token) return null;
    
    // Cookie-only auth. No X-API-Key fallback according to dev_plan
    const user = usersDb.find('userToken', token).find(d => d._type === 'user');
    if (!user) return null;

    if (SESSION_TTL > 0 && user.lastAccess) {
        if (Date.now() - new Date(user.lastAccess).getTime() > SESSION_TTL) {
            user.userToken = null; // Expire Token
            usersDb.set(user._id, 'userToken', null);
            return null;
        }
        // Refresh lastAccess only if more than half the TTL has elapsed
        if (Date.now() - new Date(user.lastAccess).getTime() > SESSION_TTL / 2) {
            user.lastAccess = new Date().toISOString();
            usersDb.set(user._id, 'lastAccess', user.lastAccess);
        }
    } else if (SESSION_TTL > 0) {
        user.lastAccess = new Date().toISOString();
        usersDb.set(user._id, 'lastAccess', user.lastAccess);
    }
    
    return user;
}

function requireAuth(req, res) {
    const user = getAuthUser(req);
    if (!user || user.rights?.login === false) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return null;
    }
    
    const dbInstance = getOrLoadUserDb(user.dbPath);
    return { user, dbInstance };
}

// ============================================
// JSON Response Helper
// ============================================

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
    if (EMBED_MODEL) reqBody.model = EMBED_MODEL;

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

function buildEmbedText(msg, session, msgIdx = -1) {
    const parts = [];
    if (session.mode === 'arena') {
        parts.push(`[Arena: ${(session.title || '').slice(0, 60)}]`);
        if (msg.speaker) parts.push(`[${msg.speaker}]`);
    } else {
        parts.push(`[Chat: ${(session.title || '').slice(0, 60)}]`);
        parts.push(`[${msg.role}]`);
    }
    if (msg.model) parts.push(`[${msg.model}]`);
    // For the first message of a session, prepend any user-authored summary
    // (title/teaser/reflection) so semantic search can surface the chat by
    // themes that may be only loosely represented in the message text itself.
    if (msgIdx === 0 && session.summary) {
        const s = session.summary;
        const summaryBits = [];
        if (s.title) summaryBits.push(s.title);
        if (s.teaser) summaryBits.push(s.teaser);
        if (s.reflection) summaryBits.push(s.reflection);
        if (summaryBits.length > 0) {
            parts.push(`[Summary: ${summaryBits.join(' ').slice(0, 800)}]`);
        }
    }
    parts.push(msg.content || '');
    return parts.join(' ');
}

function middleTruncateEmbedText(text) {
    const estTok = Math.ceil(text.length / EMBED_TOK_RATIO);
    if (estTok <= EMBED_MAX_TOKENS) return { text, truncated: false };
    const maxChars = Math.floor(EMBED_MAX_TOKENS * EMBED_TOK_RATIO);
    const headLen = Math.floor(maxChars * 0.4);
    const tailLen = maxChars - headLen;
    return {
        text: text.slice(0, headLen) + '\n\n[... truncated middle ...]\n\n' + text.slice(-tailLen),
        truncated: true
    };
}

async function embedMessageAsync(instance, msg, session, convNdbId, msgIdx, _prevFails = 0) {
    // Skip embedding for tool responses (prevents indexing massive JSON loads or duplicated session exports)
    if (msg.role === 'tool') {
        return;
    }

    if (!instance.embeddingsCol) {
        if (msg.embedStatus === 'pending') {
            L().info('Embed skipped (nVDB unavailable)', { msgId: msg.id, role: msg.role, dbPath: instance.dbPath }, 'Embed');
        }
        return;
    }

    if (!embedAvailable) {
        if (instance.pendingQueue.length < 500) {
            instance.pendingQueue.push({ msg, session, convNdbId, msgIdx, failCount: _prevFails, nextRetryAt: 0 });
        } else {
            L().warn('Embed queue full — message dropped', { msgId: msg.id, role: msg.role, queueLen: instance.pendingQueue.length, dbPath: instance.dbPath }, 'Embed');
        }
        throw new Error('Embedding endpoint unavailable — queued for retry');
    }

    const rawText = buildEmbedText(msg, session, msgIdx);
    const { text, truncated } = middleTruncateEmbedText(rawText);

    if (truncated) {
        L().warn('Message truncated for embedding', { msgId: msg.id, charLen: rawText.length, truncLen: text.length }, 'Embed');
    }

    let lastError = null;

    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const vectors = await embedBatch([text]);
            const vector = vectors[0];

            if (!Array.isArray(vector) || vector.length === 0 || vector.length !== EMBEDDING_DIMS) {
                throw new EmbedError('response', 'invalid_vector_shape');
            }

            instance.embeddingsCol.insert(msg.id, vector, JSON.stringify({
                chatId: session.id, msgIdx
            }));
            instance.needsFlush++;

            // Mark message as embedded in the conversation doc (atomic field writes — no read-modify-write race)
            try {
                instance.db.set(convNdbId, `messages.${msgIdx}.embedStatus`, 'embedded');
                instance.db.set(convNdbId, `messages.${msgIdx}.embedAttempts`, attempt + 1);
                instance.db.set(convNdbId, `messages.${msgIdx}.embedError`, null);
                embedEvents.emit('status', {
                    chatId: session.id, msgIdx, messageId: msg.id,
                    embedStatus: 'embedded', embedError: null
                });
            } catch (e) {
                L().error('Failed to persist embed status', e, { msgId: msg.id, convNdbId }, 'Embed');
            }

            L().info('Embedded', { msgId: msg.id, role: msg.role, chatId: session.id, idx: msgIdx, textLen: text.length, attempt: attempt + 1 }, 'Embed');
            return;
        } catch (err) {
            lastError = err;

            // Permanent payload problems — retrying cannot help
            const isTokenOverflow = err.message?.includes('too many') && err.message?.includes('token');
            const isClientError = err.kind === 'client';
            if (isTokenOverflow || isClientError) {
                const reason = isTokenOverflow ? 'too_many_tokens' : (err.message || 'client_error');
                L().error('Embed permanent failure', err, { msgId: msg.id, kind: err.kind, charLen: text.length }, 'Embed');
                try {
                    instance.db.set(convNdbId, `messages.${msgIdx}.embedStatus`, 'failed');
                    instance.db.set(convNdbId, `messages.${msgIdx}.embedError`, reason);
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

    const delays = [5000, 30000, 120000, 600000, 1800000];
    const newFailCount = _prevFails + 1;
    const delay = delays[Math.min(newFailCount - 1, delays.length - 1)];
    instance.pendingQueue.push({
        msg, session, convNdbId, msgIdx,
        failCount: newFailCount,
        nextRetryAt: Date.now() + delay
    });
    L().info('Embed re-queued with backoff', { msgId: msg.id, failCount: newFailCount, delayMs: delay, nextRetry: new Date(Date.now() + delay).toISOString() }, 'Embed');
    throw lastError;
}


// ============================================
// API Routes
// ============================================

const routes = {
  
  // Health + server type detection
  'GET /health': async (req, res) => {
    json(res, {
      status: 'ok',
      version: '1.0.0'
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
          const meta = dbInstance.db.storeFile('images', filename, buffer, file.type);
          
          savedFiles.push({
            name: file.name,
            type: file.type,
            url: `/api/buckets/images/${meta._file.id}.${meta._file.ext}`,
            _file: `images:${meta._file.id}.${meta._file.ext}`
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

        // Active bucket first; if missing, try restore from trash then retry.
        // GC previously trashed URL-only refs (no compact _file) — recover them.
        let buffer = null;
        try {
          buffer = dbInstance.db.getFile(bucket, id, ext);
        } catch (_) {
          buffer = null;
        }
        if (!buffer && typeof dbInstance.db.restoreFile === 'function') {
          try {
            const restored = dbInstance.db.restoreFile(bucket, id, ext);
            if (restored) {
              logger.info('Restored bucket file from trash', { bucket, id, ext }, 'Storage');
              buffer = dbInstance.db.getFile(bucket, id, ext);
            }
          } catch (restoreErr) {
            logger.warn('Bucket restore attempt failed', { bucket, id, ext, err: restoreErr.message }, 'Storage');
          }
        }
        if (!buffer) {
          json(res, { error: 'File not found' }, 404);
          return;
        }

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
    
    const user = usersDb.find('username', username).find(d => d._type === 'user');
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
    
    // Login successful
    const userToken = 'sess_' + crypto.randomUUID().replace(/-/g, '');
    user.userToken = userToken;
    user.lastAccess = new Date().toISOString();
    usersDb.set(user._id, 'userToken', user.userToken);
    usersDb.set(user._id, 'lastAccess', user.lastAccess);
    
    // Check if user requires initialization of settings in their chat db
    const dbInstance = getOrLoadUserDb(user.dbPath);
    let settings = dbInstance.db.find('id', user.id).find(d => d._type === 'user_settings');
    if (!settings) {
        dbInstance.db.insert({
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
    const user = getAuthUser(req);
    if (user) {
        user.userToken = null;
        usersDb.set(user._id, 'userToken', null);
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
    const user = getAuthUser(req);
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

    const users = usersDb.find('_type', 'user').map(u => ({
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

    if (!username || !password || !dbPath) {
        return json(res, { error: 'Username, password, and dbPath are required' }, 400, req);
    }
    
    // Validate bounds
    if (typeof username !== 'string' || !/^[a-zA-Z0-9_\-]+$/.test(username)) {
        return json(res, { error: 'Invalid username format' }, 400, req);
    }

    const existing = usersDb.find('username', username).filter(d => d._type === 'user');
    if (existing.length > 0) {
        return json(res, { error: 'Username already exists' }, 400, req);
    }

    const salt = require('crypto').randomBytes(16).toString('hex');
    const hash = require('crypto').scryptSync(password, salt, 64).toString('hex');
    const newUserId = `user-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`;

    const newUser = {
        _type: 'user',
        id: newUserId,
        username: username,
        displayName: displayName || username,
        dbPath: dbPath,
        passwordHash: salt + ':' + hash,
        rights: rights || { login: true, read: true, write: true },
        userToken: null,
        lastAccess: null,
        createdAt: new Date().toISOString()
    };

    usersDb.insert(newUser);
    usersDb.compact();

    logger.info('User created via admin API', { adminId: authResult.user.id, newUserId, username }, 'Admin');

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

    const users = usersDb.find('id', targetId).filter(d => d._type === 'user');
    if (users.length === 0) {
        return json(res, { error: 'User not found' }, 404, req);
    }

    const userToDelete = users[0];
    usersDb.delete(userToDelete._id);
    usersDb.compact();

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
    const users = usersDb.find('id', targetId).filter(d => d._type === 'user');
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
        targetUser.userToken = null; // force re-login
        usersDb.update(targetUser._id, targetUser);
        usersDb.compact();
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
    const users = usersDb.find('id', targetId).filter(d => d._type === 'user');
    if (users.length === 0) return json(res, { error: 'User not found' }, 404, req);

    const userToUpdate = users[0];
    const newSalt = crypto.randomBytes(16).toString('hex');
    userToUpdate.passwordHash = newSalt + ':' + crypto.scryptSync(body.password, newSalt, 64).toString('hex');
    userToUpdate.userToken = null; // force re-login
    
    usersDb.update(userToUpdate._id, userToUpdate);
    usersDb.compact();

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

    let settingsDoc = dbInstance.db.find('id', user.id).find(d => d._type === 'user_settings');
    if (!settingsDoc) {
      settingsDoc = {
        _type: 'user_settings',
        id: user.id,
        displayName: user.displayName,
        settings: {
            location: 'Germany',
            language: 'English',
            operationMode: 'sse',
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
      dbInstance.db.insert(settingsDoc);
    }
    json(res, settingsDoc, 200, req);
  },

  'PUT /api/user/settings': async (req, res) => {
    const authResult = requireAuth(req, res);
    if (!authResult) return;
    const { user, dbInstance } = authResult;

    const body = await readBody(req);
    if (!body || !body.settings) return json(res, { error: 'Invalid settings payload' }, 400, req);

    let settingsDoc = dbInstance.db.find('id', user.id).find(d => d._type === 'user_settings');
    if (!settingsDoc) {
      settingsDoc = {
        _type: 'user_settings',
        id: user.id,
        displayName: user.displayName,
        settings: body.settings
      };
      dbInstance.db.insert(settingsDoc);
    } else {
      settingsDoc.settings = body.settings;
      dbInstance.db.update(settingsDoc._id, settingsDoc);
    }
    json(res, settingsDoc, 200, req);
  },

  // ============================================
  // Chat API
  // ============================================

  // List sessions
  'GET /api/chats': async (req, res) => {
    const authResult = requireAuth(req, res);
    if (!authResult) return;
    const { user, dbInstance } = authResult;
    
    // DB is isolated, no need to filter by userId, but harmless
    const sessions = dbInstance.db.find('_type', 'session')
      .filter(s => Array.isArray(s.messages) ? s.userId === user.id : true) // Ensure structure safety
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    
    json(res, { data: sessions }, 200, req);
  },
  
  // Get session with messages (from conversation doc)
  'GET /api/chats/:id': async (req, res, params) => {
    const authResult = requireAuth(req, res);
    if (!authResult) return;
    const { user, dbInstance } = authResult;
    const { db } = dbInstance;

    const sessions = db.find('id', params.id);
    const session = sessions.find(s => s._type === 'session');
    
    if (!session) {
      json(res, { error: 'Not found' }, 404, req);
      return;
    }
    
    // Try conversation doc first (post-migration)
    const convs = db.find('id', params.id).filter(d => d._type === 'conversation');
    if (convs.length > 0) {
      const conv = convs[0];
      const msgs = JSON.parse(JSON.stringify(conv.messages || [])); // clone to avoid mutating db memory
      for (const m of msgs) {
        if (m.attachments) {
          for (const att of m.attachments) {
            // Prefer compact nURI; derive from URL if older docs only stored the path.
            let ref = att._file || null;
            if (!ref) {
              const u = att.url || att.dataUrl || att.blobUrl || '';
              if (typeof u === 'string' && /^\w+:[^/]+\.\w+$/.test(u)) {
                ref = u; // already compact
              } else if (typeof u === 'string' && u.includes('/api/buckets/')) {
                const mUrl = u.match(/\/api\/buckets\/([^/?#]+)\/([^/?#]+)/);
                if (mUrl) ref = `${mUrl[1]}:${mUrl[2]}`;
              }
            }
            if (ref) {
              att._file = ref;
              const [bucket, file] = ref.split(':');
              att.url = `/api/buckets/${bucket}/${file}`;
              att.blobUrl = att.url;
              if (att.dataUrl && !att.dataUrl.startsWith('data:')) {
                att.dataUrl = att.url; // legacy compat
              }
            }
          }
        }
      }
      json(res, { session, messages: msgs }, 200, req);
      return;
    }
    
    // Fallback: legacy per-message docs
    const messages = db.find('sessionId', params.id)
      .filter(m => m._type === 'message')
      .sort((a, b) => a.turnIndex - b.turnIndex);
    
    json(res, { session, messages }, 200, req);
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
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messageCount: 0,
      isPublic: false
    };
    
    db.insert(session);
    L().info('Session created', { id, title: body.title || 'New Chat', mode: body.mode || 'direct', dbPath: user.dbPath }, 'Session');
    
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
    db.insert(conv);
    
    json(res, session, 201, req);
  },
  
  // Update session metadata (pinned, title, etc.)
  'PATCH /api/chats/:id': async (req, res, params) => {
    const authResult = requireAuth(req, res);
    if (!authResult) return;
    const { user, dbInstance } = authResult;
    const { db } = dbInstance;

    const body = await readBody(req);
    const sessions = db.find('id', params.id);
    const session = sessions.find(s => s._type === 'session');
    if (!session) { json(res, { error: 'Not found' }, 404, req); return; }
    if (body.pinned !== undefined) session.pinned = !!body.pinned;
    if (body.title !== undefined) session.title = body.title;
    if (body.model !== undefined) session.model = body.model;
    if (body.systemPrompt !== undefined) session.systemPrompt = body.systemPrompt;
    if (body.category !== undefined) session.category = body.category;
    if (body.summary !== undefined) session.summary = body.summary;
    if (body.arenaConfig !== undefined) session.arenaConfig = body.arenaConfig;
    session.updatedAt = new Date().toISOString();
    db.update(session._id, session);
    json(res, session, 200, req);
  },
  
  // Add message (appends to conversation doc)
  'POST /api/chats/:id/messages': async (req, res, params) => {
    const authResult = requireAuth(req, res);
    if (!authResult) return;
    const { user, dbInstance } = authResult;
    const { db } = dbInstance;

    const body = await readBody(req);
    const sessions = db.find('id', params.id);
    const session = sessions.find(s => s._type === 'session');
    
    if (!session) {
      json(res, { error: 'Not found' }, 404, req);
      return;
    }
    
    // Find or create conversation document
    let convs = db.find('id', params.id).filter(d => d._type === 'conversation');
    let conv;
    if (convs.length > 0) {
      conv = convs[0];
    } else {
      conv = {
        _type: 'conversation',
        id: params.id,
        userId: user.id,
        title: session.title || 'New Chat',
        mode: session.mode || 'direct',
        model: session.model || null,
        isPublic: false,
        createdAt: session.createdAt,
        updatedAt: new Date().toISOString(),
        messageCount: 0,
        messages: []
      };
      db.insert(conv);
    }
    
    const idx = conv.messages.length;
    const msgId = 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);

    // Ensure every attachment carries compact _file nURI for nDB GC.
    // Older clients only sent dataUrl/url paths — derive _file from those.
    const rawAtts = Array.isArray(body.attachments) ? body.attachments : [];
    const attachments = rawAtts.map((att) => {
      if (!att || typeof att !== 'object') return att;
      const out = { ...att };
      if (!out._file) {
        const u = out.url || out.dataUrl || out.blobUrl || '';
        if (typeof u === 'string' && /^\w+:[^/]+\.\w+$/.test(u)) {
          out._file = u;
        } else if (typeof u === 'string' && u.includes('/api/buckets/')) {
          const mUrl = u.match(/\/api\/buckets\/([^/?#]+)\/([^/?#]+)/);
          if (mUrl) out._file = `${mUrl[1]}:${mUrl[2]}`;
        }
      }
      if (out._file && !out.url) {
        const [bucket, file] = out._file.split(':');
        out.url = `/api/buckets/${bucket}/${file}`;
      }
      return out;
    });
    
    const message = {
      idx,
      id: msgId,
      role: body.role || 'user',
      speaker: body.speaker || null,
      model: body.model || null,
      content: body.content || '',
      rawContent: body.content || '',
      attachments,
      createdAt: new Date().toISOString(),
      embedStatus: 'pending',
      embedAttempts: 0,
      embedError: null
    };
    
    if (body.toolName) message.toolName = body.toolName;
    if (body.toolArgs) message.toolArgs = body.toolArgs;
    if (body.toolStatus) message.toolStatus = body.toolStatus;
      if (body.toolImages) message.toolImages = body.toolImages;
      if (body.reasoning_content) message.reasoning_content = body.reasoning_content;
      if (body.thinking_signature) message.thinking_signature = body.thinking_signature;
      if (body.streamStats) message.streamStats = body.streamStats;
      if (body.usage) message.usage = body.usage;
      if (body.context) message.context = body.context;
      
      conv.messages.push(message);
      conv.messageCount = conv.messages.length;
      conv.updatedAt = new Date().toISOString();
      
      // Atomic delta patching for massive conversation object
      db.arrayPush(conv._id, 'messages', message);
      db.set(conv._id, 'messageCount', conv.messageCount);
      db.set(conv._id, 'updatedAt', conv.updatedAt);

      session.messageCount = conv.messageCount;
      session.updatedAt = conv.updatedAt;

      // Automatically assign chat title if it's the first user message
      if (body.role === 'user' && session.title === 'New Chat') {
        const titleExcerpt = (body.content || '').split('\n')[0].substring(0, 40);
        session.title = titleExcerpt || 'New Chat';
        db.set(session._id, 'title', session.title);
      }
      
      db.set(session._id, 'messageCount', session.messageCount);
      db.set(session._id, 'updatedAt', session.updatedAt);

      L().info('Message added', { sessionId: params.id, role: body.role, idx, contentLen: (body.content || '').length }, 'Message');
    
    // Async embed (fire-and-forget)
    embedMessageAsync(dbInstance, message, session, conv._id, idx);
    
    json(res, message, 201, req);
  },
  
  // Replace entire messages array (for delete/edit/truncate persistence)
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

    const convs = db.find('id', params.id).filter(d => d._type === 'conversation');
    if (convs.length === 0) {
      json(res, { error: 'Conversation not found' }, 404, req);
      return;
    }
    const conv = convs[0];

    // Re-index messages sequentially and replace the array atomically
    const newMessages = body.messages.map((m, idx) => ({ ...m, idx }));
    conv.messages = newMessages;
    conv.messageCount = newMessages.length;
    conv.updatedAt = new Date().toISOString();
    db.update(conv._id, conv);

    // Sync session metadata
    const session = db.find('id', params.id).find(s => s._type === 'session');
    if (session) {
      session.messageCount = newMessages.length;
      session.updatedAt = conv.updatedAt;
      db.set(session._id, 'messageCount', session.messageCount);
      db.set(session._id, 'updatedAt', session.updatedAt);
    }

    L().info('Messages replaced', { sessionId: params.id, count: newMessages.length }, 'Message');
    json(res, { success: true, messageCount: newMessages.length }, 200, req);
  },
  
  // Delete session
  'DELETE /api/chats/:id': async (req, res, params) => {
    const authResult = requireAuth(req, res);
    if (!authResult) return;
    const { user, dbInstance } = authResult;
    const { db } = dbInstance;

    const sessions = db.find('id', params.id);
    const session = sessions.find(s => s._type === 'session');
    
    if (!session) {
      json(res, { error: 'Not found' }, 404, req);
      return;
    }
    
    // Soft delete session, conversation doc, and legacy messages
    db.delete(session._id);
    const convs = db.find('id', params.id).filter(d => d._type === 'conversation');
    
    // Extract file references for garbage collection
    const fileRefsToRelease = [];
    
    for (const c of convs) {
        if (c.messages) {
          for (const m of c.messages) {
            if (dbInstance.embeddingsCol && m.id) {
              try { dbInstance.embeddingsCol.delete(m.id); dbInstance.needsFlush++; } catch(e) {}
            }
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
        db.delete(c._id);
      }
      
      const messages = db.find('sessionId', params.id);
      for (const m of messages) {
        if (m._type === 'message') db.delete(m._id);
      }
      
      // Trigger bucket clean up using the safe Rust method
      for (const ref of fileRefsToRelease) {
        try {
          db.releaseFile(ref);
        } catch (e) {
          logger.error('Failed to release file', e.message, { ref }, 'Storage');
        }
      }
      
      json(res, { success: true }, 200, req);
    },
    
  // Search (hybrid: nVDB semantic + text fallback)
  'POST /api/search': async (req, res) => {
    const authResult = requireAuth(req, res);
    if (!authResult) return;
    const { user, dbInstance } = authResult;
    const { db, vdb, embeddingsCol } = dbInstance;
    
    const body = await readBody(req);
    const query = (body.query || '').trim();
    const limit = body.limit || 10;
    const filterMode = body.mode || body.filter?.mode;
    const filterRole = body.role || body.filter?.role;
    const searchType = body.search_type || 'semantic';
    const dateFrom = body.date_from || null;
    const dateTo = body.date_to || null;

    L().info('Search request', { query: query.slice(0, 50), role: filterRole, type: searchType, mode: filterMode }, 'Search');

    if (!query) {
      json(res, { results: [] }, 200, req);
      return;
    }

    // DB is isolated per user, so we don't strictly filter by userId to allow legacy migrated data
    const convs = db.find('_type', 'conversation');
    const userSessions = db.find('_type', 'session');
    const convById = new Map();
    const msgIndex = []; // flat list of { chatId, idx, msg, session }

    for (const c of convs) {
      convById.set(c.id, c);
      const session = userSessions.find(s => s.id === c.id);
      if (!c.messages) continue;
      for (const msg of c.messages) {
        // Date filtering
        if (dateFrom || dateTo) {
          const d = new Date(msg.createdAt);
          if (dateFrom && d < new Date(dateFrom)) continue;
          if (dateTo && d > new Date(dateTo)) continue;
        }
        // Mode filtering
        if (filterMode && filterMode !== 'all' && session?.mode && session.mode !== filterMode) continue;
        if (filterRole && filterRole !== 'all' && msg.role !== filterRole) continue;
        msgIndex.push({ chatId: c.id, idx: msg.idx, msg, session });
      }
    }

    const results = [];
    const seen = new Set();

    // Semantic search via nVDB (skip if keyword-only)
    if ((searchType === 'semantic' || searchType === 'hybrid') && embeddingsCol && embedAvailable) {
      try {
        const vectors = await embedBatch([query]);
        const queryVector = vectors[0];

        const vectorResults = await embeddingsCol.search({
          vector: queryVector,
          top_k: limit * 3
        });

        for (const hit of vectorResults) {
          if (results.length >= limit) break;

          const payload = hit.payload ? JSON.parse(hit.payload) : null;
          const chatId = payload?.chatId;
          const msgIdx = typeof payload?.msgIdx === 'number' ? payload.msgIdx : -1;
          const msgId = payload?.messageId || hit.id;
          const seenKey = chatId ? `${chatId}#${msgIdx}` : msgId;

          if (seen.has(seenKey)) continue;
          seen.add(seenKey);

          // Lookup via chatId+idx (new format) or msgId (legacy)
          let entry;
          if (chatId && msgIdx >= 0) {
            entry = msgIndex.find(e => e.chatId === chatId && e.idx === msgIdx);
            if (!entry) {
              // Vector hit but no corresponding message in filtered index
              continue;
            }
          } else {
            entry = msgIndex.find(e => e.msg.id === msgId);
            if (!entry) continue;
          }

          logger.info('Search vector hit', { chatId: chatId?.slice(-20), msgIdx, score: hit.score.toFixed(3), role: entry.msg.role }, 'Search');

          results.push({
            score: hit.score,
            message: { id: entry.msg.id, idx: entry.idx, role: entry.msg.role, model: entry.msg.model, content: entry.msg.content.slice(0, 300), createdAt: entry.msg.createdAt },
            session: entry.session ? { id: entry.session.id, title: entry.session.title, mode: entry.session.mode, createdAt: entry.session.createdAt } : null
          });
        }
      } catch (err) {
        L().error('Semantic search failed', err, {}, 'Search');
      }
    }

    // Text search (skip if semantic-only with results already found)
    const semanticHadResults = results.length > 0;
    if ((searchType === 'keyword' || searchType === 'hybrid' || (searchType === 'semantic' && !semanticHadResults)) && results.length < limit) {
      const lowerQuery = query.toLowerCase();
      const textHits = msgIndex
        .filter(e => e.msg.content?.toLowerCase().includes(lowerQuery))
        .slice(0, limit - results.length);

      for (const entry of textHits) {
        if (results.length >= limit) break;
        const seenKey = `${entry.chatId}#${entry.idx}`;
        if (seen.has(seenKey)) continue;
        seen.add(seenKey);

        results.push({
          score: 0,
          message: { id: entry.msg.id, idx: entry.idx, role: entry.msg.role, model: entry.msg.model, content: entry.msg.content.slice(0, 300), createdAt: entry.msg.createdAt },
          session: entry.session ? { id: entry.session.id, title: entry.session.title, mode: entry.session.mode, createdAt: entry.session.createdAt } : null,
          source: 'text-fallback'
        });
      }
    }

    L().info('Search', { query: query.slice(0, 80), results: results.length, type: searchType }, 'Search');
    json(res, {
      results,
      query,
      search_type: searchType,
      method: searchType === 'keyword' ? 'text' : searchType === 'hybrid' ? (results.some(r => r.score > 0) ? 'hybrid' : 'text') : (results.some(r => r.score > 0) ? 'semantic' : 'text-fallback')
    });
  },
  
  // List arena sessions (public)
  'GET /api/arena': async (req, res) => {
    const authResult = requireAuth(req, res);
    if (!authResult) return;
    const { user, dbInstance } = authResult;
    
    const arenas = dbInstance.db.find('_type', 'session')
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
    const { db } = dbInstance;

    const body = await readBody(req);
    const sid = (body.session_id || '').trim();
    const dir = body.direction || 'both';
    if (!sid) { json(res, { error: 'Missing session_id' }, 400, req); return; }

    const arenaSessions = db.find('_type', 'session')
      .filter(s => s.mode === 'arena' || s.mode === 'direct');

    const refPattern = /arena-\d+[-\w]*/g;

    // Outbound: scan THIS session for references to other IDs
    const outbound = [];
    if (dir === 'outbound' || dir === 'both') {
      const msgs = db.find('_type', 'message').filter(m => m.sessionId === sid);
      for (const m of msgs) {
        const matches = (m.content || '').match(refPattern) || [];
        for (const match of matches) {
          if (match === sid) continue;
          if (outbound.some(r => r.sessionId === match)) continue;
          const target = arenaSessions.find(s => s.id === match);
          outbound.push({
            sessionId: match,
            sessionTitle: target?.title || 'unknown',
            messageCount: target?.messageCount,
            models: target?.arenaConfig ? `${target.arenaConfig.modelA} vs ${target.arenaConfig.modelB}` : (target?.model || 'unknown'),
            matchedIn: m.role,
            date: target?.createdAt
          });
        }
      }
    }

    // Inbound: scan ALL sessions for references to THIS session_id
    const inbound = [];
    if (dir === 'inbound' || dir === 'both') {
      const allMessages = db.find('_type', 'message');
      const referencing = new Map(); // sessionId -> matchedRole
      for (const m of allMessages) {
        if (m.sessionId === sid) continue;
        if ((m.content || '').includes(sid)) {
          if (!referencing.has(m.sessionId)) referencing.set(m.sessionId, m.role);
        }
      }
      for (const [refSid, matchedRole] of referencing) {
        const session = arenaSessions.find(s => s.id === refSid);
        if (session) {
          inbound.push({
            sessionId: refSid,
            sessionTitle: session.title || 'unknown',
            messageCount: session.messageCount,
            models: session.arenaConfig ? `${session.arenaConfig.modelA} vs ${session.arenaConfig.modelB}` : (session.model || 'unknown'),
            matchedIn: matchedRole,
            date: session.createdAt
          });
        }
      }
    }

    json(res, { source: { id: sid }, direction: dir, referenced_by: inbound, references: outbound }, 200, req);
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

  // Redirect root to /chat/ (needed for relative resource paths)
  if (pathname === '/' || pathname === '/chat') {
    res.writeHead(302, { 'Location': '/chat/' });
    res.end();
    return;
  }
  if (pathname === '/chat/') {
    pathname = '/chat/index.html';
  }
  if (pathname === '/chat-arena') {
    res.writeHead(302, { 'Location': '/chat-arena/' });
    res.end();
    return;
  }
  if (pathname === '/chat-arena/') {
    pathname = '/chat-arena/index.html';
  }

  // File serving from data directory
  if (pathname.startsWith('/files/')) {
    const subPath = req.url.slice(7).split('?')[0];
    const filePath = path.join(FILES_DIR, decodeURIComponent(subPath));
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
      operationMode: process.env.UI_OPERATION_MODE || 'sse',
      ttsEndpoint: process.env.TTS_ENDPOINT || 'http://localhost:2233',
      ttsVoice: process.env.TTS_VOICE || '',
      ttsSpeed: parseFloat(process.env.TTS_SPEED || 1.0),
      backendUrl: '',
      enableBackend: true,
      enableArchiveTools: true,
      browserFetchAllowedPrefixes: BROWSER_FETCH_ALLOWLIST,
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
      const headers = { 'Content-Type': mime };
      sendBody(req, res, data, headers, 200);
    });
});

// Start HTTP server
server.listen(PORT, () => {
  if (logger) {
      logger.info('Chat Backend running', { port: PORT }, 'Server');
      logger.info('Health endpoint', { url: `http://localhost:${PORT}/health` }, 'Server');
  } else {
      console.log(`Chat Backend running on port ${PORT}`);
  }
});
