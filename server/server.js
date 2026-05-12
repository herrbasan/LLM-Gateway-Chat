const http = require('http');
const path = require('path');
const fs = require('fs');
const url = require('url');

const { Database: nDB } = require('../lib/ndb/napi');
const { Database: nVDB } = require('../lib/nvdb/napi');

const PORT = process.argv[2] || 3500;
const DATA_DIR = path.join(__dirname, 'data');
const NDB_PATH = path.join(DATA_DIR, 'chat_app');
const NVDB_DIR = path.join(DATA_DIR, 'nvdb');
const FILES_DIR = path.join(DATA_DIR, 'files');
const EMBEDDING_DIMS = 768;

// Embedding config (LLM Gateway — OpenRouter cloud)
const EMBED_URL = 'http://192.168.0.100:3400/v1/embeddings';
const EMBED_HEADERS = {
    'Content-Type': 'application/json'
};

// Fatten wrapper backup (use with --wrapper flag in embed.js)
// const WRAPPER_URL = 'http://192.168.0.145:4080/embedding';
// const WRAPPER_HEADERS = { ... };

let embedAvailable = true;
let embedFailCount = 0;

// ============================================
// Database
// ============================================

const db = nDB.open(NDB_PATH);
let vdb, embeddingsCol;

try {
  vdb = new nVDB(NVDB_DIR);
  embeddingsCol = vdb.getCollection('embeddings');
} catch {
  console.log('nVDB not initialized yet (run embed.js when Gateway is up)');
}

// ============================================
// Auth
// ============================================

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
        const res = await fetch(EMBED_URL, {
            method: 'POST',
            headers: EMBED_HEADERS,
            body: JSON.stringify({ input: [text], dimensions: 2560 })
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

async function embedMessageAsync(msg, session) {
    if (!embeddingsCol || !embedAvailable) return;
    try {
        const text = buildEmbedText(msg, session);
        const vector = await embedQuery(text);

        embeddingsCol.insert(msg.id, vector, JSON.stringify({
            messageId: msg.id, sessionId: msg.sessionId,
            role: msg.role, model: msg.model, turnIndex: msg.turnIndex
        }));
    } catch (err) {
        console.error('Async embed failed:', msg.id.slice(0, 16), err.message);
        // Non-blocking — message is already saved
    }
}

// ============================================
// API Routes
// ============================================

const routes = {
  
  // Health
  'GET /health': async (req, res) => {
    json(res, {
      status: 'ok',
      ndb: db.len(),
      nvdb: embeddingsCol?.stats?.documentCount || 0
    });
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
  
  // Get session with messages
  'GET /api/chats/:id': async (req, res, params) => {
    const user = requireAuth(req, res);
    if (!user) return;
    
    const sessions = db.find('id', params.id);
    const session = sessions.find(s => s._type === 'session' && s.userId === user.id);
    
    if (!session) {
      json(res, { error: 'Not found' }, 404);
      return;
    }
    
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
    json(res, session, 201);
  },
  
  // Add message
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
    
    const msgId = 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
    const turnIndex = session.messageCount || 0;
    
    const message = {
      _type: 'message',
      id: msgId,
      sessionId: params.id,
      userId: user.id,
      role: body.role || 'user',
      model: body.model || null,
      content: body.content || '',
      rawContent: body.content || '',
      attachments: body.attachments || [],
      turnIndex,
      createdAt: new Date().toISOString()
    };
    
    db.insert(message);
    
    session.messageCount = (session.messageCount || 0) + 1;
    session.updatedAt = new Date().toISOString();
    db.update(session._id, session);
    
    // Async embed (fire-and-forget, non-blocking)
    embedMessageAsync(message, session);
    
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
    
    // Soft delete session and messages
    db.delete(session._id);
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
    const searchType = body.search_type || 'semantic';
    const dateFrom = body.date_from || null;
    const dateTo = body.date_to || null;

    if (!query) {
      json(res, { results: [] });
      return;
    }

    // Scope to user's sessions
    let userSessions = db.find('_type', 'session').filter(s => s.userId === user.id);
    const userSessionIds = new Set(userSessions.map(s => s.id));
    let userMessages = db.find('_type', 'message').filter(m => userSessionIds.has(m.sessionId));

    // Date filtering
    if (dateFrom || dateTo) {
      userMessages = userMessages.filter(m => {
        const d = new Date(m.createdAt);
        if (dateFrom && d < new Date(dateFrom)) return false;
        if (dateTo && d > new Date(dateTo)) return false;
        return true;
      });
    }

    const results = [];
    const seenIds = new Set();

    // Semantic search via nVDB (skip if keyword-only)
    if ((searchType === 'semantic' || searchType === 'hybrid') && embeddingsCol && embedAvailable) {
      try {
        const queryVector = await embedQuery(query);

        const vectorResults = embeddingsCol.search({
          vector: queryVector,
          top_k: limit * 3,
          approximate: true,
          ef: 64
        });

        for (const hit of vectorResults) {
          if (results.length >= limit) break;

          const payload = hit.payload ? JSON.parse(hit.payload) : null;
          const msgId = payload?.messageId || hit.id;

          if (seenIds.has(msgId)) continue;
          seenIds.add(msgId);

          const msg = userMessages.find(m => m.id === msgId);
          if (!msg) continue;

          // Apply mode filter
          const session = userSessions.find(s => s.id === msg.sessionId);
          if (filterMode && filterMode !== 'all' && session?.mode !== filterMode) continue;

          results.push({
            score: hit.score,
            message: { id: msg.id, role: msg.role, model: msg.model, content: msg.content.slice(0, 300), turnIndex: msg.turnIndex, createdAt: msg.createdAt },
            session: session ? { id: session.id, title: session.title, mode: session.mode, createdAt: session.createdAt } : null
          });
        }
      } catch (err) {
        console.error('Semantic search failed, falling back to text:', err.message);
      }
    }

    // Text search (skip if semantic-only)
    if ((searchType === 'keyword' || searchType === 'hybrid') && results.length < limit) {
      const lowerQuery = query.toLowerCase();
      const textHits = userMessages
        .filter(m => !seenIds.has(m.id) && m.content?.toLowerCase().includes(lowerQuery))
        .slice(0, limit - results.length);

      for (const msg of textHits) {
        if (results.length >= limit) break;
        if (seenIds.has(msg.id)) continue;
        seenIds.add(msg.id);

        const session = userSessions.find(s => s.id === msg.sessionId);
        if (filterMode && filterMode !== 'all' && session?.mode !== filterMode) continue;

        results.push({
          score: 0,
          message: { id: msg.id, role: msg.role, model: msg.model, content: msg.content.slice(0, 300), turnIndex: msg.turnIndex, createdAt: msg.createdAt },
          session: session ? { id: session.id, title: session.title, mode: session.mode, createdAt: session.createdAt } : null,
          source: 'text-fallback'
        });
      }
    }

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
  const parsed = url.parse(req.url, true);
  let pathname = parsed.pathname;
  
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
  console.log(`Chat Backend running at http://localhost:${PORT}`);
  console.log(`Health:  http://localhost:${PORT}/health`);
  console.log(`API Key: ${db.find('_type', 'user')[0]?.apiKey || 'none'}`);
  console.log('Press Ctrl+C to stop');
});
