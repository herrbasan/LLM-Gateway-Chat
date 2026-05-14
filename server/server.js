const http = require('http');
const path = require('path');
const fs = require('fs');
const url = require('url');

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
const NDB_PATH       = process.env.CHAT_NDB_PATH       || cfg.ndbPath           || 'server/data/chat_app';
const NVDB_DIR       = process.env.CHAT_NVDB_DIR       || cfg.nvdbDir           || 'server/data/nvdb';
const FILES_DIR      = process.env.CHAT_FILES_DIR      || cfg.filesDir          || 'server/data/files';
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
// Database
// ============================================

const db = nDB.open(NDB_PATH);
let vdb, embeddingsCol;
let needsFlush = 0;
let logger = null;

(async () => {
logger = await nLogger.init({ logsDir: path.resolve(LOGS_DIR), sessionPrefix: 'chat' });
logger.info('Chat Backend starting', { port: PORT }, 'Server');

try {
  vdb = new nVDB(NVDB_DIR);
  embeddingsCol = vdb.getCollection('embeddings');
  logger.info('nVDB embeddings collection ready', { dims: EMBEDDING_DIMS }, 'Server');
} catch {
  logger.warn('nVDB not initialized (run embed.js when Gateway is up)', {}, 'Server');
}

// ============================================
// Auth
// ============================================

const L = () => logger || { info() {}, warn() {}, error() {}, debug() {} };

function getAuthUser(req) {
  const key = req.headers['x-api-key'];
  if (!key) return null;
  
  const users = db.find('_type', 'user');
  return users.find(u => u.apiKey === key) || null;
}

function requireAuth(req, res) {
  const user = getAuthUser(req);
  if (!user) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return null;
  }
  return user;
}

// ============================================
// JSON Response Helper
// ============================================

function json(res, data, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-API-Key'
  });
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

async function embedMessageAsync(msg, session, convNdbId, msgIdx) {
    if (!embeddingsCol || !embedAvailable) {
        if (msg.embedStatus === 'pending') {
            L().info('Embed skipped (nVDB unavailable)', { msgId: msg.id, role: msg.role }, 'Embed');
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
            embeddingsCol.insert(msg.id, vector, JSON.stringify({
                chatId: session.id, msgIdx
            }));
            needsFlush++;

            // Update embed status on the message within the conversation doc
            const conv = db.get(convNdbId);
            if (conv && conv.messages && conv.messages[msgIdx]) {
                conv.messages[msgIdx].embedStatus = 'embedded';
                conv.messages[msgIdx].embedAttempts = attempt + 1;
                conv.messages[msgIdx].embedError = null;
                db.update(convNdbId, conv);
            }

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
    const conv = db.get(convNdbId);
    if (conv && conv.messages && conv.messages[msgIdx]) {
        conv.messages[msgIdx].embedStatus = 'failed';
        conv.messages[msgIdx].embedAttempts = 3;
        conv.messages[msgIdx].embedError = (lastError?.message || '').slice(0, 200);
        db.update(convNdbId, conv);
    }
}

// ============================================
// API Routes
// ============================================

const routes = {
  
  // Health + server type detection
  'GET /health': async (req, res) => {
    const embedAvailable = !!embeddingsCol;
    json(res, {
      status: 'ok',
      version: '1.0.0',
      embedAvailable,
      nvdb: embeddingsCol?.stats?.totalSegmentDocs || 0
    });
  },

  'GET /api/server-type': async (req, res) => {
    json(res, { type: 'node-backend' });
  },
  
  // Auth
  'POST /api/auth/key': async (req, res) => {
    const users = db.find('_type', 'user');
    if (users.length > 0) {
      // Return existing migration user key
      json(res, { apiKey: users[0].apiKey, message: 'Using existing migration user' });
    } else {
      json(res, { error: 'No users found' }, 500);
    }
  },
  
  // List sessions
  'GET /api/chats': async (req, res) => {
    const user = requireAuth(req, res);
    if (!user) return;
    
    const sessions = db.find('_type', 'session')
      .filter(s => s.userId === user.id)
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    
    json(res, { data: sessions });
  },
  
  // Get session with messages (from conversation doc)
  'GET /api/chats/:id': async (req, res, params) => {
    const user = requireAuth(req, res);
    if (!user) return;
    
    const sessions = db.find('id', params.id);
    const session = sessions.find(s => s._type === 'session' && s.userId === user.id);
    
    if (!session) {
      json(res, { error: 'Not found' }, 404);
      return;
    }
    
    // Try conversation doc first (post-migration)
    const convs = db.find('id', params.id).filter(d => d._type === 'conversation');
    if (convs.length > 0) {
      const conv = convs[0];
      json(res, { session, messages: conv.messages || [] });
      return;
    }
    
    // Fallback: legacy per-message docs
    const messages = db.find('sessionId', params.id)
      .filter(m => m._type === 'message')
      .sort((a, b) => a.turnIndex - b.turnIndex);
    
    json(res, { session, messages });
  },
  
  // Create session
  'POST /api/chats': async (req, res) => {
    const user = requireAuth(req, res);
    if (!user) return;
    
    const body = await readBody(req);
    const id = 'chat_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
    
    const session = {
      _type: 'session',
      id,
      userId: user.id,
      title: body.title || 'New Chat',
      mode: body.mode || 'direct',
      model: body.model || null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messageCount: 0,
      isPublic: false
    };
    
    db.insert(session);
    L().info('Session created', { id, title: body.title || 'New Chat', mode: body.mode || 'direct' }, 'Session');
    
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
    
    json(res, session, 201);
  },
  
  // Update session metadata (pinned, title, etc.)
  'PATCH /api/chats/:id': async (req, res, params) => {
    const user = requireAuth(req, res);
    if (!user) return;
    const body = await readBody(req);
    const sessions = db.find('id', params.id);
    const session = sessions.find(s => s._type === 'session' && s.userId === user.id);
    if (!session) { json(res, { error: 'Not found' }, 404); return; }
    if (body.pinned !== undefined) session.pinned = !!body.pinned;
    session.updatedAt = new Date().toISOString();
    db.update(session._id, session);
    json(res, session);
  },
  
  // Add message (appends to conversation doc)
  'POST /api/chats/:id/messages': async (req, res, params) => {
    const user = requireAuth(req, res);
    if (!user) return;
    
    const body = await readBody(req);
    const sessions = db.find('id', params.id);
    const session = sessions.find(s => s._type === 'session' && s.userId === user.id);
    
    if (!session) {
      json(res, { error: 'Not found' }, 404);
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
    
    conv.messages.push(message);
    conv.messageCount = conv.messages.length;
    conv.updatedAt = new Date().toISOString();
    db.update(conv._id, conv);
    
    session.messageCount = conv.messageCount;
    session.updatedAt = conv.updatedAt;
    db.update(session._id, session);
    
    L().info('Message added', { sessionId: params.id, role: body.role, idx, contentLen: (body.content || '').length }, 'Message');
    
    // Async embed (fire-and-forget) — store chatId + idx reference
    embedMessageAsync(message, session, conv._id, idx);
    
    json(res, message, 201);
  },
  
  // Delete session
  'DELETE /api/chats/:id': async (req, res, params) => {
    const user = requireAuth(req, res);
    if (!user) return;
    
    const sessions = db.find('id', params.id);
    const session = sessions.find(s => s._type === 'session' && s.userId === user.id);
    
    if (!session) {
      json(res, { error: 'Not found' }, 404);
      return;
    }
    
    // Soft delete session, conversation doc, and legacy messages
    db.delete(session._id);
    const convs = db.find('id', params.id).filter(d => d._type === 'conversation');
    for (const c of convs) db.delete(c._id);
    const messages = db.find('sessionId', params.id);
    for (const m of messages) {
      if (m._type === 'message') db.delete(m._id);
    }
    
    json(res, { ok: true });
  },
  
  // Search (hybrid: nVDB semantic + text fallback)
  'POST /api/search': async (req, res) => {
    const user = requireAuth(req, res);
    if (!user) return;
    
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
      json(res, { results: [] });
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
    const arenas = db.find('_type', 'session')
      .filter(s => s.mode === 'arena')
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    
    json(res, { data: arenas });
  },

  // Find session references (lineage tracking)
  'POST /api/references': async (req, res) => {
    const user = requireAuth(req, res);
    if (!user) return;

    const body = await readBody(req);
    const sid = (body.session_id || '').trim();
    const dir = body.direction || 'both';
    if (!sid) { json(res, { error: 'Missing session_id' }, 400); return; }

    const arenaSessions = db.find('_type', 'session')
      .filter(s => s.mode === 'arena' || s.mode === 'direct')
      .filter(s => s.userId === user.id);

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

    json(res, { source: { id: sid }, direction: dir, referenced_by: inbound, references: outbound });
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
  const parsed = url.parse(req.url, true);
  let pathname = parsed.pathname;

  const logRequest = (status) => {
    if (!pathname.startsWith('/api/') && pathname !== '/health') return; // only log API
    const ms = Date.now() - startTime;
    const method = req.method;
    const fullPath = pathname + (parsed.search || '');
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
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      serveFile(req, res, filePath);
    } else {
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

  // If file not found at path, try under /chat/ (base URL fix)
  if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
    filePath = '/chat' + pathname;
    fullPath = path.join(__dirname, '..', filePath);
  }

  if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
    fs.readFile(fullPath, (err, data) => {
      if (err) {
        res.writeHead(500);
        res.end('Error');
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
  } else {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }
});

server.listen(PORT, () => {
  logger.info('Chat Backend running', { port: PORT }, 'Server');
  logger.info('Health endpoint', { url: `http://localhost:${PORT}/health` }, 'Server');
  const apiKey = db.find('_type', 'user')[0]?.apiKey || 'none';
  logger.info('API key', { key: apiKey.slice(0, 20) + '...' }, 'Server');

  // Retry stale pending embeds from previous crash/restart
  const STALE_THRESHOLD = 5 * 60 * 1000;
  const now = Date.now();
  const convs = db.find('_type', 'conversation');
  const sessions = {};
  for (const s of db.find('_type', 'session')) sessions[s.id] = s;

  // Startup: reconcile messages missing nVDB vectors (sparse — only lost memtable on crash)
  // Check nVDB directly — no embedStatus dependency. Fire-and-forget, sequential batches.
  const staleMessages = [];
  for (const c of db.find('_type', 'conversation')) {
    if (!c.messages) continue;
    for (let idx = 0; idx < c.messages.length; idx++) {
      const m = c.messages[idx];
      if (!m.id) continue;
      if (!embeddingsCol.get(m.id)) {
        staleMessages.push({ msg: m, session: sessions[c.id] || {}, convNdbId: c._id, idx });
      }
    }
  }
  if (staleMessages.length > 0) {
    logger.info('Startup reconciliation (nVDB check)', { count: staleMessages.length }, 'Server');
    (async () => {
      const BATCH_SIZE = 5;
      for (let i = 0; i < staleMessages.length; i += BATCH_SIZE) {
        const batch = staleMessages.slice(i, i + BATCH_SIZE);
        await Promise.all(batch.map(({ msg, session, convNdbId, idx }) =>
          embedMessageAsync(msg, session, convNdbId, idx).catch(() => {})
        ));
        // Small delay between batches to let gateway breathe
        if (i + BATCH_SIZE < staleMessages.length) {
          await new Promise(r => setTimeout(r, 1000));
        }
      }
      logger.info('Startup reconciliation complete', {}, 'Server');
    })();
  }

  // One-time flush + compact after startup
  setTimeout(() => {
    if (!embeddingsCol) return;
    try {
      embeddingsCol.flush();
      logger.info('nVDB flushed after startup', { docs: embeddingsCol.stats?.totalSegmentDocs }, 'Index');
    } catch (err) {
      logger.error('nVDB flush failed', err, {}, 'Index');
    }
  }, 10000);

  // Maintenance: periodic embed health check + pending retry
  setInterval(async () => {
    if (!embedAvailable) {
      try {
        const testText = 'health check';
        const reqBody = { input: [testText], dimensions: EMBEDDING_DIMS };
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

    if (embedAvailable && embeddingsCol) {
      const convs = db.find('_type', 'conversation');
      const sessions = {};
      for (const s of db.find('_type', 'session')) sessions[s.id] = s;
      const pending = [];
      for (const c of convs) {
        if (!c.messages) continue;
        for (let idx = 0; idx < c.messages.length; idx++) {
          const m = c.messages[idx];
          if (!m.id) continue;
          if (!embeddingsCol.get(m.id)) {
            pending.push({ msg: m, session: sessions[c.id] || {}, convNdbId: c._id, idx });
          }
        }
      }
      if (pending.length > 0) {
        logger.info('Retrying pending embeddings', { count: pending.length }, 'Embed');
        for (const { msg, session, convNdbId, idx } of pending) {
          embedMessageAsync(msg, session, convNdbId, idx);
        }
      }

      // Flush nVDB memtable → segments so exact search sees new vectors
      if (needsFlush > 0 && embeddingsCol) {
        try {
          const t0 = Date.now();
          embeddingsCol.flush();
          logger.info('nVDB flushed', { docs: needsFlush, ms: Date.now() - t0 }, 'Embed');
          needsFlush = 0;
        } catch (err) {
          logger.error('nVDB flush failed', err, {}, 'Embed');
        }
      }
    }
  }, 5000);
});

})();
