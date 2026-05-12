// ============================================
// Migration Script: NeDB → nDB + nVDB
// ============================================
// Run: node server/migrate.js

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { Database: nDB } = require('../lib/ndb/napi');
const { Database: nVDB } = require('../lib/nvdb/napi');

// ============================================
// Config
// ============================================

const DATA_DIR = path.join(__dirname, 'data');
const NDB_PATH = path.join(DATA_DIR, 'chat_app');
const NVDB_DIR = path.join(DATA_DIR, 'nvdb');
const FILES_DIR = path.join(DATA_DIR, 'files');
const OLD_DATA_DIR = path.join(__dirname, 'data');
const OLD_FILES_DIR = path.join(OLD_DATA_DIR, 'files');
const GATEWAY_URL = process.env.GATEWAY_URL || 'http://localhost:3400';
const EMBEDDING_MODEL = 'fatten-llama-embed';

const MIGRATION_USER = {
  _type: 'user',
  id: 'user-migrated-default',
  apiKey: 'migrated-' + crypto.randomUUID(),
  displayName: 'Legacy User',
  createdAt: new Date().toISOString(),
  isMigrated: true
};

// ============================================
// Helpers
// ============================================

function stripTimestamp(content) {
  if (!content) return '';
  return content.replace(/^\[\d{4}-\d{2}-\d{2}@\d{2}:\d{2}\]\s*/, '').trim();
}

function tsToIso(timestamp) {
  return new Date(timestamp).toISOString();
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ============================================
// Migration
// ============================================

async function migrate() {
  console.log('=== Chat Data Migration ===\n');

  // Setup directories
  ensureDir(DATA_DIR);
  ensureDir(NVDB_DIR);
  ensureDir(FILES_DIR);

  // Open databases
  const db = nDB.open(NDB_PATH);
  const vdb = new nVDB(NVDB_DIR);
  const embeddingsCol = vdb.createCollection('embeddings', 2560, { durability: 'sync' });

  // Create migration user
  const userId = db.insert(MIGRATION_USER);
  console.log('[1/5] Created migration user:', MIGRATION_USER.id);
  console.log('      API Key:', MIGRATION_USER.apiKey);

  // Read NeDB storage
  const storagePath = path.join(OLD_DATA_DIR, 'storage.db');
  if (!fs.existsSync(storagePath)) {
    throw new Error('storage.db not found at ' + storagePath);
  }

  const lines = fs.readFileSync(storagePath, 'utf8').trim().split('\n');
  console.log('[2/5] Read', lines.length, 'records from NeDB');

  let sessionCount = 0;
  let messageCount = 0;
  const historyIndex = [];

  for (const line of lines) {
    let doc;
    try {
      doc = JSON.parse(line);
    } catch (e) {
      console.warn('  Skipping malformed line:', e.message);
      continue;
    }

    if (doc.key.startsWith('conv:')) {
      const result = migrateConversation(doc, db);
      sessionCount += result.sessions;
      messageCount += result.messages;
    }
    else if (doc.key.startsWith('arena:')) {
      const result = migrateArena(doc, db);
      sessionCount += result.sessions;
      messageCount += result.messages;
    }
    else if (doc.key === 'history:') {
      historyIndex.push(...doc.value);
    }
  }

  console.log('[3/5] Migrated', sessionCount, 'sessions,', messageCount, 'messages');

  // Enrich sessions from history index
  enrichFromHistory(historyIndex, db);

  // Copy image files
  if (fs.existsSync(OLD_FILES_DIR)) {
    const files = fs.readdirSync(OLD_FILES_DIR);
    for (const file of files) {
      fs.copyFileSync(
        path.join(OLD_FILES_DIR, file),
        path.join(FILES_DIR, file)
      );
    }
    console.log('[4/5] Copied', files.length, 'image files');
  } else {
    console.log('[4/5] No image files to copy');
  }

  // Flush nVDB
  embeddingsCol.flush();
  console.log('[5/5] Flushed nVDB to disk');

  // Stats
  console.log('\n=== Migration Complete ===');
  console.log('nDB documents:', db.len());
  console.log('nVDB embeddings:', embeddingsCol.stats?.documentCount || 'unknown');
  console.log('\nNext step: Generate embeddings');
  console.log('  node server/embed.js');
}

// ============================================
// Conversation Migration
// ============================================

function migrateConversation(doc, db) {
  const chatId = doc.key.replace('conv:', '');
  const exchanges = doc.value || [];
  
  // Extract model from first exchange context or default
  let model = 'unknown';
  const firstEx = exchanges.find(e => e.assistant?.context?.model || e.assistant?.context);
  if (firstEx?.assistant?.context?.model) {
    model = firstEx.assistant.context.model;
  }

  // Session
  const session = {
    _type: 'session',
    id: chatId,
    userId: MIGRATION_USER.id,
    title: exchanges[0]?.user?.content ? stripTimestamp(exchanges[0].user.content).slice(0, 100) : 'Untitled',
    mode: 'direct',
    model: model,
    createdAt: exchanges[0] ? tsToIso(exchanges[0].timestamp) : new Date().toISOString(),
    updatedAt: exchanges[exchanges.length - 1] ? tsToIso(exchanges[exchanges.length - 1].timestamp) : new Date().toISOString(),
    messageCount: 0,
    isPublic: false
  };

  db.insert(session);

  // Messages
  let turnIndex = 0;
  for (const ex of exchanges) {
    if (ex.user) {
      db.insert({
        _type: 'message',
        id: ex.id + '-user',
        sessionId: chatId,
        userId: MIGRATION_USER.id,
        role: 'user',
        model: null,
        content: stripTimestamp(ex.user.content),
        rawContent: ex.user.content,
        attachments: ex.user.attachments || [],
        turnIndex: turnIndex,
        createdAt: tsToIso(ex.timestamp)
      });
      session.messageCount++;
    }

    if (ex.assistant) {
      db.insert({
        _type: 'message',
        id: ex.id + '-assistant',
        sessionId: chatId,
        userId: MIGRATION_USER.id,
        role: 'assistant',
        model: model,
        content: stripTimestamp(ex.assistant.content),
        rawContent: ex.assistant.content,
        versions: ex.assistant.versions || [],
        attachments: [],
        turnIndex: turnIndex,
        createdAt: tsToIso(ex.timestamp)
      });
      session.messageCount++;
    }

    if (ex.type === 'tool' && ex.tool) {
      db.insert({
        _type: 'message',
        id: ex.id + '-tool',
        sessionId: chatId,
        userId: MIGRATION_USER.id,
        role: 'tool',
        model: null,
        content: ex.tool.content || '',
        rawContent: ex.tool.content || '',
        toolName: ex.tool.name,
        toolArgs: ex.tool.args,
        toolStatus: ex.tool.status,
        turnIndex: turnIndex,
        createdAt: tsToIso(ex.timestamp)
      });
      session.messageCount++;
    }

    turnIndex++;
  }

  return { sessions: 1, messages: session.messageCount };
}

// ============================================
// Arena Migration
// ============================================

function migrateArena(doc, db) {
  const arena = doc.value || {};
  const arenaId = arena.id || doc.key.replace('arena:session:', '');
  
  // Title from topic
  let title = arena.topic || 'Arena Session';
  if (title.length > 200) title = title.slice(0, 200) + '...';

  // Session
  const session = {
    _type: 'session',
    id: arenaId,
    userId: MIGRATION_USER.id,
    title: title,
    mode: 'arena',
    arenaConfig: {
      modelA: arena.participants?.[0] || 'unknown',
      modelB: arena.participants?.[1] || 'unknown',
      promptVersion: 'v1',
      maxTurns: arena.settings?.maxTurns || 20,
      autoAdvance: arena.settings?.autoAdvance || false
    },
    summary: arena.summary || null,
    createdAt: arena.exportedAt || new Date().toISOString(),
    updatedAt: arena.exportedAt || new Date().toISOString(),
    messageCount: 0,
    isPublic: false,
    publicSlug: null
  };

  db.insert(session);

  // Messages
  const msgs = arena.messages || [];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    const model = m.speaker === 'Model A' ? session.arenaConfig.modelA :
                  m.speaker === 'Model B' ? session.arenaConfig.modelB : null;

    db.insert({
      _type: 'message',
      id: arenaId + '-msg-' + i,
      sessionId: arenaId,
      userId: MIGRATION_USER.id,
      role: m.role === 'system' ? 'system' : 'assistant',
      model: model,
      content: m.content || '',
      rawContent: m.content || '',
      speaker: m.speaker,
      turnIndex: i,
      createdAt: arena.exportedAt || new Date().toISOString()
    });
    session.messageCount++;
  }

  return { sessions: 1, messages: session.messageCount };
}

// ============================================
// Enrich from History Index
// ============================================

function enrichFromHistory(history, db) {
  for (const entry of history) {
    const sessions = db.find('id', entry.id);
    for (const s of sessions) {
      if (s._type !== 'session') continue;
      
      // Update with history metadata if missing
      if (!s.title || s.title === 'Untitled') {
        s.title = entry.title || 'Untitled';
      }
      if (entry.model && s.model === 'unknown') {
        s.model = entry.model;
      }
      db.update(s._id, s);
    }
  }
}

// ============================================
// Run
// ============================================

migrate().catch(err => {
  console.error('Migration failed:', err.message);
  console.error(err.stack);
  process.exit(1);
});
