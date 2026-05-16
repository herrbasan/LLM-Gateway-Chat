const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const { Database: nDB } = require('../lib/ndb/napi');
const { Database: nVDB } = require('../lib/nvdb/napi');
const nLogger = require('../lib/nlogger-cjs');

// Load config
let cfg = {};
try {
    cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
} catch { /* use defaults below */ }

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

const EMBED_HEADERS = {
    'Content-Type': 'application/json'
};

let embedAvailable = true;
let embedFailCount = 0;

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

usersDb = nDB.open(USERS_DB_PATH);
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

// Embeddings check & flush loop across all mounted isolated DBs
setInterval(async () => {
    // 1. Recover embedding health if down
    if (!embedAvailable) {
        try {
            const reqBody = { input: ['health check'], dimensions: EMBEDDING_DIMS };
            if (EMBED_MODEL) reqBody.model = EMBED_MODEL;
            const res = await fetch(EMBED_URL, {
                method: 'POST', headers: EMBED_HEADERS,
                body: JSON.stringify(reqBody)
            });
            if (res.ok) {
                embedAvailable = true;
                embedFailCount = 0;
                logger.info('Embed endpoint recovered', {}, 'Embed');
            }
        } catch {}
    }

    // 2. Iterate each mounted database instance for pending embeds and flushing
    for (const [dbPath, instance] of activeDbs.entries()) {
        if (!instance.embeddingsCol) continue;

        if (instance.pendingQueue.length > 0 && embedAvailable) {
            const item = instance.pendingQueue.shift();
            // Process queue asynchronously (fire & forget)
            embedMessageAsync(instance, item.msg, item.session, item.convNdbId, item.msgIdx).catch(() => {});
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
    const db = nDB.open(ndbPath);
    console.timeEnd(`nDB.open:${dbPath}`);
    
    let vdb, embeddingsCol;
    try {
        vdb = new nVDB(nvdbDir);
        embeddingsCol = vdb.getCollection('embeddings');
        logger.info('nVDB collection ready for user', { dbPath }, 'Server');
    } catch {
        logger.warn('nVDB failed init for user', { dbPath }, 'Server');
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
            for (const c of db.find('_type', 'conversation')) {
                if (!c.messages) continue;
                for (let idx = 0; idx < c.messages.length; idx++) {
                    const m = c.messages[idx];
                    if (!m.id) continue;
                    if (!embeddingsCol.get(m.id)) {
                        stale.push({ msg: m, session: sessions[c.id] || {}, convNdbId: c._id, idx });
                    }
                }
            }
            if (stale.length > 0) {
                logger.info('Lazy reconciliation', { count: stale.length, dbPath }, 'Server');
                (async () => {
                    for (let i = 0; i < stale.length; i++) {
                        const { msg, session, convNdbId, idx } = stale[i];
                        await embedMessageAsync(instance, msg, session, convNdbId, idx).catch(() => {});
                        if (i % 10 === 9 && i + 1 < stale.length) {
                            await new Promise(r => setTimeout(r, 2000));
                        }
                    }
                })();
            }
        }, 3000);
    }
    
    return instance;
}

// ============================================
// Auth & Routing
// ============================================

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
            usersDb.update(user._id, user);
            return null;
        }
        // Refresh lastAccess only if more than half the TTL has elapsed
        if (Date.now() - new Date(user.lastAccess).getTime() > SESSION_TTL / 2) {
            user.lastAccess = new Date().toISOString();
            usersDb.update(user._id, user);
        }
    } else if (SESSION_TTL > 0) {
        user.lastAccess = new Date().toISOString();
        usersDb.update(user._id, user);
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

  res.writeHead(status, headers);
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
  });
}

// ============================================
// Embed Query
// ============================================

async function embedQuery(text) {
    if (!embedAvailable) throw new Error('Embedding unavailable');
    try {
        const reqBody = { input: [text], dimensions: EMBEDDING_DIMS };
        if (EMBED_MODEL) reqBody.model = EMBED_MODEL;
        const res = await fetch(EMBED_URL, {
            method: 'POST',
            headers: EMBED_HEADERS,
            body: JSON.stringify(reqBody)
        });
        if (!res.ok) {
            embedFailCount++;
            if (embedFailCount >= 3) embedAvailable = false;
            throw new Error(`Embed ${res.status}`);
        }
        embedFailCount = 0;
        const data = await res.json();
        if (data.error) throw new Error(data.error.message);
        return data.data?.[0]?.embedding;
    } catch (err) {
        embedFailCount++;
        if (embedFailCount >= 3) embedAvailable = false;
        throw err;
    }
}

function buildEmbedText(msg, session) {
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

async function embedMessageAsync(instance, msg, session, convNdbId, msgIdx) {
    // Skip embedding for tool responses (prevents indexing massive JSON loads or duplicated session exports)
    if (msg.role === 'tool') {
        return;
    }

    if (!instance.embeddingsCol || !embedAvailable) {
        if (msg.embedStatus === 'pending') {
            L().info('Embed skipped (nVDB unavailable)', { msgId: msg.id, role: msg.role, dbPath: instance.dbPath }, 'Embed');
        }
        return;
    }

    const rawText = buildEmbedText(msg, session);
    const { text, truncated } = middleTruncateEmbedText(rawText);

    if (truncated) {
        L().warn('Message truncated for embedding', { msgId: msg.id, charLen: rawText.length, truncLen: text.length }, 'Embed');
    }

    let lastError = null;

    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const vector = await embedQuery(text);

            if (!Array.isArray(vector) || vector.length === 0 || vector.length !== EMBEDDING_DIMS) {
                throw new Error('invalid_vector_shape');
            }

            // Store reference to conversation doc — coordinates, not data
            instance.embeddingsCol.insert(msg.id, vector, JSON.stringify({
                chatId: session.id, msgIdx
            }));
            instance.needsFlush++;

            L().info('Embedded', { msgId: msg.id, role: msg.role, chatId: session.id, idx: msgIdx, textLen: text.length, attempt: attempt + 1 }, 'Embed');
            return;
        } catch (err) {
            lastError = err;

            if (err.message?.includes('too many') && err.message?.includes('token')) {
                L().error('Embed too many tokens', err, { msgId: msg.id, charLen: text.length }, 'Embed');
                break;
            }

            if (attempt < 2) {
                const delay = Math.pow(4, attempt) * 1000;
                await new Promise(r => setTimeout(r, delay));
            }
        }
    }

    L().error('Embed failed after retries', lastError, { msgId: msg.id, attempts: 3 }, 'Embed');
    instance.pendingQueue.push({ msg, session, convNdbId, msgIdx });
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

        const buffer = dbInstance.db.getFile(bucket, id, ext);
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
    usersDb.update(user._id, user);
    
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
        usersDb.update(user._id, user);
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
            ttsEndpoint: 'http://localhost:2244',
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
            // Translate nURI compact strings to frontend URLs
            const ref = att._file || (att.url && /^\w+:/.test(att.url) ? att.url : null);
            if (ref) {
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
    
    const message = {
      idx,
      id: msgId,
      role: body.role || 'user',
      speaker: body.speaker || null,
      model: body.model || null,
      content: body.content || '',
      rawContent: body.content || '',
      attachments: body.attachments || [],
      createdAt: new Date().toISOString(),
      embedStatus: 'pending',
      embedAttempts: 0,
      embedError: null
    };
    
    if (body.toolName) message.toolName = body.toolName;
    if (body.toolArgs) message.toolArgs = body.toolArgs;
    if (body.toolStatus) message.toolStatus = body.toolStatus;
      if (body.toolImages) message.toolImages = body.toolImages;
      
      conv.messages.push(message);
      conv.messageCount = conv.messages.length;
        conv.updatedAt = new Date().toISOString();
        db.update(conv._id, conv);

      session.messageCount = conv.messageCount;
      session.updatedAt = conv.updatedAt;

      // Automatically assign chat title if it's the first user message
      if (body.role === 'user' && session.title === 'New Chat') {
        const titleExcerpt = (body.content || '').split('\n')[0].substring(0, 40);
        session.title = titleExcerpt || 'New Chat';
      }
      
      db.update(session._id, session);

    L().info('Message added', { sessionId: params.id, role: body.role, idx, contentLen: (body.content || '').length }, 'Message');
    
    // Async embed (fire-and-forget)
    embedMessageAsync(dbInstance, message, session, conv._id, idx);
    
    json(res, message, 201, req);
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

    // Load user's conversation docs + build message index
    const convs = db.find('_type', 'conversation').filter(c => c.userId === user.id);
    const userSessions = db.find('_type', 'session').filter(s => s.userId === user.id);
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
        const queryVector = await embedQuery(query);

        const vectorResults = embeddingsCol.search({
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
    
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
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
    } catch {
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
  let filePath = pathname === '/' ? '/chat/index.html' : pathname;
  let fullPath = path.join(__dirname, '..', filePath);

  try {
    await fs.promises.stat(fullPath);
  } catch {
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
      res.writeHead(200, { 'Content-Type': mime });
      res.end(data);
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
