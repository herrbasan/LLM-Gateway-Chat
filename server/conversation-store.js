// ============================================
// conversation-store.js — shared stored-form helpers for conversation messages.
// Single source for attachment `_file` nURI handling, message normalization,
// append+embed, variant append, and whole-array replace.
// Consumers: the REST routes (server.js) and the ConversationRunner (runner.js).
// NO HTTP here — routes keep requireAuth/readBody/res. Helpers throw on violated
// invariants (fail fast); routes map those to status codes.
// Spec: docs/pa-implementation-spec.md (Part 2).
// ============================================

const { buildMessageV2Docs, collectMessageChunkIds } = require('./nvdb-chat');

// Derive the compact `_file` nURI ('bucket:file.ext') from an attachment's
// URL-ish fields. Returns null when nothing is derivable.
function deriveFileRef(att) {
    const u = att.url || att.dataUrl || att.blobUrl || '';
    if (typeof u === 'string' && /^\w+:[^/]+\.\w+$/.test(u)) return u; // already compact
    if (typeof u === 'string' && u.includes('/api/buckets/')) {
        const m = u.match(/\/api\/buckets\/([^/?#]+)\/([^/?#]+)/);
        if (m) return `${m[1]}:${m[2]}`;
    }
    return null;
}

function bucketUrl(ref) {
    const [bucket, file] = ref.split(':');
    return `/api/buckets/${bucket}/${file}`;
}

// POST-flavor normalization (canonical stored form): ensure `_file`, set `url`
// from it when absent. Does NOT touch blobUrl/dataUrl — matches the old
// POST /api/chats/:id/messages behavior exactly.
function normalizeAttachments(rawAtts) {
    const atts = Array.isArray(rawAtts) ? rawAtts : [];
    return atts.map((att) => {
        if (!att || typeof att !== 'object') return att;
        const out = { ...att };
        if (!out._file) {
            const ref = deriveFileRef(out);
            if (ref) out._file = ref;
        }
        if (out._file && !out.url) out.url = bucketUrl(out._file);
        return out;
    });
}

// GET/snapshot-flavor densification (view form): ensure `_file`, set `url` AND
// `blobUrl` from it, legacy dataUrl compat. Returns new objects — matches the
// old GET /api/chats/:id behavior exactly.
function densifyAttachments(rawAtts) {
    const atts = Array.isArray(rawAtts) ? rawAtts : [];
    return atts.map((att) => {
        if (!att || typeof att !== 'object') return att;
        const out = { ...att };
        const ref = out._file || deriveFileRef(out);
        if (ref) {
            out._file = ref;
            out.url = bucketUrl(ref);
            out.blobUrl = out.url;
            if (out.dataUrl && !out.dataUrl.startsWith('data:')) out.dataUrl = out.url;
        }
        return out;
    });
}

// Canonical stored form with defaults. Copies optional fields only when truthy
// (mirrors the old POST route). `tool_calls`/`versions` pass through for the
// runner (additive; the old route never received them).
function normalizeStoredMessage(msg = {}) {
    const message = {
        idx: msg.idx,
        id: msg.id,
        role: msg.role || 'user',
        speaker: msg.speaker || null,
        model: msg.model || null,
        content: msg.content || '',
        rawContent: msg.rawContent !== undefined ? msg.rawContent : (msg.content || ''),
        attachments: normalizeAttachments(msg.attachments),
        createdAt: msg.createdAt || new Date().toISOString(),
        embedStatus: msg.embedStatus || 'pending',
        embedAttempts: msg.embedAttempts || 0,
        embedError: msg.embedError !== undefined ? msg.embedError : null
    };
    if (msg.toolName) message.toolName = msg.toolName;
    if (msg.toolArgs) message.toolArgs = msg.toolArgs;
    if (msg.toolStatus) message.toolStatus = msg.toolStatus;
    if (msg.toolImages) message.toolImages = msg.toolImages;
    if (msg.toolImagesTransient) message.toolImagesTransient = true;
    if (msg.toolImagesStripped) message.toolImagesStripped = true;
    if (msg.toolUi) message.toolUi = msg.toolUi;
    if (msg.tool_call_id) message.tool_call_id = msg.tool_call_id;
    if (msg.callId) message.callId = msg.callId;
    if (msg.reasoning_content) message.reasoning_content = msg.reasoning_content;
    if (msg.thinking_signature) message.thinking_signature = msg.thinking_signature;
    if (msg.clientId) message.clientId = msg.clientId;
    if (msg.streamStats) message.streamStats = msg.streamStats;
    if (msg.usage) message.usage = msg.usage;
    if (msg.context) message.context = msg.context;
    if (msg.tool_calls) message.tool_calls = msg.tool_calls;
    if (msg.error) message.error = true;
    if (Array.isArray(msg.versions)) {
        message.versions = msg.versions;
        message.currentVersion = msg.currentVersion !== undefined ? msg.currentVersion : msg.versions.length - 1;
    }
    return message;
}

// A session and its conversation share `id` (the conversation id), so a legacy
// `find('id', x)` answered with BOTH documents — a 5–6 MB conversation copied
// twice per lookup, once for each half of the pair. Every read here is now a
// query narrowed by `_type` (both fields are hash-indexed, so the planner
// intersects to the same one or two docs): the session read stays tiny and the
// conversation is fetched exactly once.
async function querySession(db, conversationId) {
    const { results } = await db.query({ filter: { id: conversationId, _type: 'session' }, limit: 2 });
    return results.find(s => s._type === 'session') || null;
}

async function queryConversation(db, conversationId) {
    const { results } = await db.query({ filter: { id: conversationId, _type: 'conversation' }, limit: 2 });
    return results.find(d => d._type === 'conversation') || null;
}

async function findSessionOrThrow(db, conversationId) {
    const session = await querySession(db, conversationId);
    if (!session) throw new Error(`session not found: ${conversationId}`);
    return session;
}

async function findConversationOrThrow(db, conversationId) {
    const conv = await queryConversation(db, conversationId);
    if (!conv) throw new Error(`conversation doc not found: ${conversationId}`);
    return conv;
}

async function findOrCreateConversation(db, session, user) {
    const existing = await queryConversation(db, session.id);
    if (existing) return existing;
    return insertConversationDoc(db, session, user);
}

// Both halves of a runner hydration, fetched concurrently: one tiny session
// read plus exactly one conversation read.
async function loadSessionAndConversation(db, conversationId, user) {
    const [session, conv] = await Promise.all([
        querySession(db, conversationId),
        queryConversation(db, conversationId)
    ]);
    if (!session) throw new Error(`session not found: ${conversationId}`);
    return { session, conv: conv || (await insertConversationDoc(db, session, user)) };
}

async function insertConversationDoc(db, session, user) {
    const conv = {
        _type: 'conversation',
        id: session.id,
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
    const { doc } = await db.insert(conv);
    return doc;
}

function guardCtx(fnName, ctx) {
    if (!ctx?.user?.id) throw new Error(`${fnName}: ctx.user required`);
    if (!ctx?.dbInstance?.db) throw new Error(`${fnName}: ctx.dbInstance required`);
    if (typeof ctx?.embedMessageAsync !== 'function') throw new Error(`${fnName}: ctx.embedMessageAsync required`);
}

// A splice re-numbers every message after it, and chunk ids carry the stored
// index (`user:session:msgIdx#chunk`), so the shifted tail is re-keyed in nVDB:
// the old ids go, the new ones are written. The new documents hash identically
// to the old (same text), so nVDB relinks their vectors instead of re-embedding.
async function syncShiftedTailToNvdb(ctx, session, conv, startIdx, prevMessages) {
    const client = ctx.dbInstance?.nvdbClient;
    if (!client) return;
    const collection = ctx.dbInstance.nvdbCollection || 'chat';
    const chunkOpts = ctx.dbInstance.nvdbChunkOpts || {};
    const log = ctx.log || { info() {}, warn() {}, error() {}, debug() {} };
    const userId = ctx.user.id;

    const oldIds = [];
    for (let i = startIdx; i < prevMessages.length; i++) {
        oldIds.push(...collectMessageChunkIds(userId, session.id, prevMessages[i], i, chunkOpts));
    }

    const docs = [];
    for (let i = startIdx; i < conv.messages.length; i++) {
        docs.push(...buildMessageV2Docs({ userId, session, msg: conv.messages[i], msgIdx: i, chunkOpts }));
    }

    const newIds = new Set(docs.map(d => d.id));
    const removedIds = oldIds.filter(id => !newIds.has(id));
    if (removedIds.length > 0) await client.deleteIds(collection, removedIds, { commit: docs.length === 0 });
    if (docs.length > 0) await client.upsert(collection, docs, { commit: true });
    log.info('nVDB shifted tail re-keyed', { sessionId: session.id, from: startIdx, deleted: removedIds.length, upserted: docs.length }, 'Embed');
}

// ctx = { user, dbInstance, embedMessageAsync, log? }
// msg = { conversationId, role?, content?, attachments?, speaker?, model?,
//         toolName?/toolArgs?/toolStatus?/toolImages?, reasoning_content?/…, tool_calls? }
// Returns { message, session, conv } — message is the PERSISTED doc (real id + idx).
async function appendConversationMessage(ctx, msg) {
    guardCtx('appendConversationMessage', ctx);
    if (!msg?.conversationId) throw new Error('appendConversationMessage: msg.conversationId required');
    const { db } = ctx.dbInstance;
    const log = ctx.log || { info() {}, warn() {}, error() {}, debug() {} };

    const session = await findSessionOrThrow(db, msg.conversationId);
    const conv = await findOrCreateConversation(db, session, ctx.user);

    const idx = conv.messages.length;
    const msgId = msg.id || 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
    const message = normalizeStoredMessage({ ...msg, id: msgId, idx, createdAt: new Date().toISOString() });

    conv.messages.push(message);
    conv.messageCount = conv.messages.length;
    conv.updatedAt = new Date().toISOString();
    await db.patch(conv._id, [
        { op: 'array_push', path: 'messages', value: message },
        { op: 'set', path: 'messageCount', value: conv.messageCount },
        { op: 'set', path: 'updatedAt', value: conv.updatedAt }
    ]);

    session.messageCount = conv.messageCount;
    session.updatedAt = conv.updatedAt;
    const sessionOps = [];
    if (message.role === 'user' && session.title === 'New Chat') {
        const excerpt = (message.content || '').split('\n')[0].substring(0, 40);
        session.title = excerpt || 'New Chat';
        sessionOps.push({ op: 'set', path: 'title', value: session.title });
    }
    sessionOps.push({ op: 'set', path: 'messageCount', value: session.messageCount });
    sessionOps.push({ op: 'set', path: 'updatedAt', value: session.updatedAt });
    await db.patch(session._id, sessionOps);

    log.info('Message added', { sessionId: msg.conversationId, role: message.role, idx, contentLen: (message.content || '').length }, 'Message');

    // Fire-and-forget embed. MUST swallow the rejection: embedMessageAsync re-throws
    // after re-queueing a transient failure; an unhandled rejection kills the process.
    ctx.embedMessageAsync(ctx.dbInstance, message, session, conv._id, idx).catch(err => {
        log.warn('Fire-and-forget embed rejected (already re-queued)', { sessionId: msg.conversationId, idx, kind: err?.kind, error: err?.message }, 'Embed');
    });

    return { message, session, conv };
}

// Insert a message at a RESERVED position (the runner reserves idx at run start;
// queued user messages appended mid-run must not push the in-flight assistant
// past them — an assistant-final payload is a prefill and breaks the provider's
// thinking-mode contract). Splices at atIdx, re-indexes, whole-array persist.
async function insertConversationMessageAt(ctx, { conversationId, message: msg, atIdx } = {}) {
    guardCtx('insertConversationMessageAt', ctx);
    if (!conversationId) throw new Error('insertConversationMessageAt: conversationId required');
    if (!msg) throw new Error('insertConversationMessageAt: message required');
    const { db } = ctx.dbInstance;
    const log = ctx.log || { info() {}, warn() {}, error() {}, debug() {} };

    const session = await findSessionOrThrow(db, conversationId);
    const conv = await findConversationOrThrow(db, conversationId);
    const pos = Math.max(0, Math.min(atIdx ?? conv.messages.length, conv.messages.length));

    const message = normalizeStoredMessage({ ...msg, id: msg.id || 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10), idx: pos, createdAt: new Date().toISOString() });
    const prevMessages = conv.messages.slice();
    conv.messages.splice(pos, 0, message);
    for (let i = pos + 1; i < conv.messages.length; i++) conv.messages[i].idx = i;
    conv.messageCount = conv.messages.length;
    conv.updatedAt = new Date().toISOString();
    await db.patch(conv._id, [
        { op: 'set', path: 'messages', value: conv.messages },
        { op: 'set', path: 'messageCount', value: conv.messageCount },
        { op: 'set', path: 'updatedAt', value: conv.updatedAt }
    ]);
    session.messageCount = conv.messageCount;
    session.updatedAt = conv.updatedAt;
    await db.patch(session._id, [
        { op: 'set', path: 'messageCount', value: session.messageCount },
        { op: 'set', path: 'updatedAt', value: session.updatedAt }
    ]);

    log.info('Message inserted', { sessionId: conversationId, role: message.role, idx: pos }, 'Message');
    // The shifted tail is re-keyed before the embed fires: `conv.messages[pos]`
    // is the new message, and embedMessageAsync's own upsert is idempotent.
    if (pos < prevMessages.length) await syncShiftedTailToNvdb(ctx, session, conv, pos, prevMessages);
    ctx.embedMessageAsync(ctx.dbInstance, message, session, conv._id, pos).catch(err => {
        log.warn('Fire-and-forget embed rejected (already re-queued)', { sessionId: conversationId, idx: pos, kind: err?.kind, error: err?.message }, 'Embed');
    });
    return { message, session, conv };
}

// PUT /api/chats/:id/messages path (delete/edit/truncate persistence).
// NOTE: intentionally NOT full normalizeStoredMessage — the PUT payload is a
// re-serialization of existing messages and may carry fields outside the known
// list; spread-preserving them matches today's behavior exactly. Attachments
// still get _file normalization (GC-correct, additive only). No embed fire
// (matches today; re-embed-on-replace is a documented open question).
async function replaceConversationMessages(ctx, { conversationId, messages } = {}) {
    guardCtx('replaceConversationMessages', ctx);
    if (!conversationId) throw new Error('replaceConversationMessages: conversationId required');
    if (!Array.isArray(messages)) throw new Error('replaceConversationMessages: messages array required');
    const { db } = ctx.dbInstance;
    const log = ctx.log || { info() {}, warn() {}, error() {}, debug() {} };

    const conv = await findConversationOrThrow(db, conversationId);
    const newMessages = messages.map((m, idx) => ({ ...m, idx, attachments: normalizeAttachments(m.attachments) }));
    conv.messages = newMessages;
    conv.messageCount = newMessages.length;
    conv.updatedAt = new Date().toISOString();
    await db.patch(conv._id, [
        { op: 'set', path: 'messages', value: newMessages },
        { op: 'set', path: 'messageCount', value: conv.messageCount },
        { op: 'set', path: 'updatedAt', value: conv.updatedAt }
    ]);

    const session = await querySession(db, conversationId);
    if (session) {
        session.messageCount = newMessages.length;
        session.updatedAt = conv.updatedAt;
        await db.patch(session._id, [
            { op: 'set', path: 'messageCount', value: session.messageCount },
            { op: 'set', path: 'updatedAt', value: session.updatedAt }
        ]);
    }

    log.info('Messages replaced', { sessionId: conversationId, count: newMessages.length }, 'Message');
    return { messageCount: newMessages.length };
}

// Delete one message by id (single-author write). Removes the message, deletes
// its embedding vector, re-indexes everything after it (idx is positional and
// contractual), persists, and returns the removed message so the caller can
// broadcast. Orphan tool_calls/tool results are healed by the API view on the
// next assembly — no special-casing here.
async function deleteConversationMessage(ctx, { conversationId, messageId } = {}) {
    guardCtx('deleteConversationMessage', ctx);
    if (!conversationId) throw new Error('deleteConversationMessage: conversationId required');
    if (!messageId) throw new Error('deleteConversationMessage: messageId required');
    const { db } = ctx.dbInstance;
    const log = ctx.log || { info() {}, warn() {}, error() {}, debug() {} };

    const session = await findSessionOrThrow(db, conversationId);
    const conv = await findConversationOrThrow(db, conversationId);

    const pos = conv.messages.findIndex(m => m.id === messageId);
    if (pos === -1) throw new Error(`deleteConversationMessage: message not found: ${messageId}`);

    const prevMessages = conv.messages.slice();
    const removed = conv.messages.splice(pos, 1)[0];
    for (let i = 0; i < conv.messages.length; i++) conv.messages[i].idx = i;

    conv.messageCount = conv.messages.length;
    conv.updatedAt = new Date().toISOString();
    await db.patch(conv._id, [
        { op: 'set', path: 'messages', value: conv.messages },
        { op: 'set', path: 'messageCount', value: conv.messageCount },
        { op: 'set', path: 'updatedAt', value: conv.updatedAt }
    ]);

    session.messageCount = conv.messageCount;
    session.updatedAt = conv.updatedAt;
    await db.patch(session._id, [
        { op: 'set', path: 'messageCount', value: session.messageCount },
        { op: 'set', path: 'updatedAt', value: session.updatedAt }
    ]);

    // Re-key the shifted tail (and drop the removed message's chunks) in nVDB.
    await syncShiftedTailToNvdb(ctx, session, conv, pos, prevMessages);

    log.info('Message deleted', { sessionId: conversationId, messageId, role: removed.role, remaining: conv.messages.length }, 'Message');
    return { removed, messageCount: conv.messages.length };
}

// Edit a USER message in place and truncate everything after it (the edited
// message becomes the pending turn — the runner re-runs it). Rejects non-user
// targets. Re-indexes, persists, returns the removed count so the caller can
// log/broadcast. Embed vectors for the removed messages are dropped.
async function editUserMessageAndTruncate(ctx, { conversationId, messageId, content } = {}) {
    guardCtx('editUserMessageAndTruncate', ctx);
    if (!conversationId) throw new Error('editUserMessageAndTruncate: conversationId required');
    if (!messageId) throw new Error('editUserMessageAndTruncate: messageId required');
    if (typeof content !== 'string') throw new Error('editUserMessageAndTruncate: content (string) required');
    const { db } = ctx.dbInstance;
    const log = ctx.log || { info() {}, warn() {}, error() {}, debug() {} };

    const session = await findSessionOrThrow(db, conversationId);
    const conv = await findConversationOrThrow(db, conversationId);

    const pos = conv.messages.findIndex(m => m.id === messageId);
    if (pos === -1) throw new Error(`editUserMessageAndTruncate: message not found: ${messageId}`);
    const target = conv.messages[pos];
    if (target.role !== 'user') throw new Error(`editUserMessageAndTruncate: only user messages are editable (${messageId} is ${target.role})`);

    const removed = conv.messages.slice(pos + 1);
    const removedIds = removed.map(m => m.id);
    const removedStart = pos + 1;
    target.content = content;
    target.updatedAt = new Date().toISOString();
    conv.messages = conv.messages.slice(0, pos + 1);
    for (let i = 0; i < conv.messages.length; i++) conv.messages[i].idx = i;

    conv.messageCount = conv.messages.length;
    conv.updatedAt = new Date().toISOString();
    await db.patch(conv._id, [
        { op: 'set', path: 'messages', value: conv.messages },
        { op: 'set', path: 'messageCount', value: conv.messageCount },
        { op: 'set', path: 'updatedAt', value: conv.updatedAt }
    ]);

    session.messageCount = conv.messageCount;
    session.updatedAt = conv.updatedAt;
    await db.patch(session._id, [
        { op: 'set', path: 'messageCount', value: session.messageCount },
        { op: 'set', path: 'updatedAt', value: session.updatedAt }
    ]);

    if (ctx.dbInstance.nvdbClient && removed.length > 0) {
        const chunkOpts = ctx.dbInstance.nvdbChunkOpts || {};
        const ids = [];
        for (let i = 0; i < removed.length; i++) {
            ids.push(...collectMessageChunkIds(ctx.user.id, session.id, removed[i], removedStart + i, chunkOpts));
        }
        if (ids.length > 0) await ctx.dbInstance.nvdbClient.deleteIds(ctx.dbInstance.nvdbCollection || 'chat', ids, { commit: true });
    }

    // The edited message is the pending turn again: re-upsert + re-embed it so
    // search reflects the new text immediately.
    ctx.embedMessageAsync(ctx.dbInstance, target, session, conv._id, pos).catch(err => {
        log.warn('Fire-and-forget embed rejected (already re-queued)', { sessionId: conversationId, idx: pos, kind: err?.kind, error: err?.message }, 'Embed');
    });

    log.info('User message edited + truncated', { sessionId: conversationId, messageId, removed: removedIds.length }, 'Message');
    return { edited: target, removedCount: removedIds.length };
}

// Edit an ASSISTANT message's content in place (no truncate, no re-run — the user
// is correcting/trimming an answer, not re-generating the turn). Rejects non-
// assistant targets. Position is unchanged, so no re-index is needed.
async function editAssistantMessageContent(ctx, { conversationId, messageId, content } = {}) {
    guardCtx('editAssistantMessageContent', ctx);
    if (!conversationId) throw new Error('editAssistantMessageContent: conversationId required');
    if (!messageId) throw new Error('editAssistantMessageContent: messageId required');
    if (typeof content !== 'string') throw new Error('editAssistantMessageContent: content (string) required');
    const { db } = ctx.dbInstance;
    const log = ctx.log || { info() {}, warn() {}, error() {}, debug() {} };

    const session = await findSessionOrThrow(db, conversationId);
    const conv = await findConversationOrThrow(db, conversationId);

    const pos = conv.messages.findIndex(m => m.id === messageId);
    if (pos === -1) throw new Error(`editAssistantMessageContent: message not found: ${messageId}`);
    const target = conv.messages[pos];
    if (target.role !== 'assistant') throw new Error(`editAssistantMessageContent: only assistant messages are editable (${messageId} is ${target.role})`);

    target.content = content;
    target.updatedAt = new Date().toISOString();
    conv.updatedAt = new Date().toISOString();
    await db.patch(conv._id, [
        { op: 'set', path: 'messages', value: conv.messages },
        { op: 'set', path: 'updatedAt', value: conv.updatedAt }
    ]);
    session.updatedAt = conv.updatedAt;
    await db.set(session._id, 'updatedAt', session.updatedAt);

    ctx.embedMessageAsync(ctx.dbInstance, target, session, conv._id, pos).catch(err => {
        log.warn('Fire-and-forget embed rejected (already re-queued)', { sessionId: conversationId, idx: pos, kind: err?.kind, error: err?.message }, 'Embed');
    });

    log.info('Assistant message edited', { sessionId: conversationId, messageId }, 'Message');
    return { edited: target };
}

module.exports = {
    deriveFileRef,
    bucketUrl,
    normalizeAttachments,
    densifyAttachments,
    normalizeStoredMessage,
    findSessionOrThrow,
    findConversationOrThrow,
    findOrCreateConversation,
    loadSessionAndConversation,
    appendConversationMessage,
    insertConversationMessageAt,
    replaceConversationMessages,
    deleteConversationMessage,
    editUserMessageAndTruncate,
    editAssistantMessageContent
};
