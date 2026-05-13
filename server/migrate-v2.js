// ============================================
// migrate-v2: Repack per-message nDB docs into
// one conversation document per session
// ============================================
//
// Before: 3000+ _type='message' docs scattered in nDB
// After:  1 _type='conversation' doc per session with messages array
//
// Usage: node server/migrate-v2.js
// ============================================

const path = require('path');
const { Database: nDB } = require('../lib/ndb/napi');

const NDB_PATH = process.env.CHAT_NDB_PATH || 'server/data/chat_app';

console.log('Opening nDB at:', NDB_PATH);
const db = nDB.open(NDB_PATH);

const docs = db.iter();
const sessions = docs.filter(d => d._type === 'session');
const messages = docs.filter(d => d._type === 'message');
const conversations = docs.filter(d => d._type === 'conversation');

console.log('Sessions:', sessions.length);
console.log('Messages:', messages.length);
console.log('Existing conversations:', conversations.length);

if (conversations.length > 0) {
    console.log('\nConversation docs already exist. Deleting them first...');
    for (const c of conversations) {
        db.delete(c._id);
    }
    console.log('Deleted', conversations.length, 'conversation docs');
}

// Group messages by sessionId
const bySession = new Map();
for (const m of messages) {
    const list = bySession.get(m.sessionId) || [];
    list.push(m);
    bySession.set(m.sessionId, list);
}

// Sessions without any messages get empty message arrays
for (const s of sessions) {
    if (!bySession.has(s.id)) bySession.set(s.id, []);
}

let packed = 0;

for (const session of sessions) {
    const msgs = (bySession.get(session.id) || [])
        .sort((a, b) => a.turnIndex - b.turnIndex);

    const messagesArray = msgs.map((m, idx) => ({
        idx,
        id: m.id,
        role: m.role || 'user',
        content: m.content || '',
        rawContent: m.rawContent || m.content || '',
        model: m.model || null,
        createdAt: m.createdAt || session.createdAt,
        attachments: m.attachments || [],
        turnIndex: m.turnIndex,
        // Tool metadata (only present if synced with fixed sendMessage)
        toolName: m.toolName || undefined,
        toolArgs: m.toolArgs || undefined,
        toolStatus: m.toolStatus || undefined,
        toolImages: m.toolImages || undefined,
        // Embedding status
        embedStatus: m.embedStatus || undefined,
        embedAttempts: m.embedAttempts || 0,
        embedError: m.embedError || undefined,
        // Usage info
        usage: m.usage || undefined
    }));

    const conv = {
        _type: 'conversation',
        id: session.id,
        userId: session.userId || 'user-migrated-default',
        title: session.title || 'New Chat',
        mode: session.mode || 'direct',
        model: session.model || null,
        isPublic: session.isPublic || false,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        messageCount: messagesArray.length,
        messages: messagesArray
    };

    db.insert(conv);
    packed++;
}

console.log('Packed', packed, 'conversation documents');

// Delete old per-message documents
let deleted = 0;
for (const m of messages) {
    db.delete(m._id);
    deleted++;
}
console.log('Deleted', deleted, 'old message documents');

// Compact
console.log('Compacting...');
db.flush();
console.log('Done. nDB stats:', db.len(), 'total documents');
