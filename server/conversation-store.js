// ============================================
// conversation-store.js — shared stored-form helpers for conversation messages.
// Single source for attachment `_file` nURI handling, message normalization,
// append+embed, variant append, and whole-array replace.
// Consumers: the REST routes (server.js) and the ConversationRunner (runner.js).
// NO HTTP here — routes keep requireAuth/readBody/res. Helpers throw on violated
// invariants (fail fast); routes map those to status codes.
// Spec: docs/pa-implementation-spec.md (Part 2).
// ============================================

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
    if (msg.reasoning_content) message.reasoning_content = msg.reasoning_content;
    if (msg.thinking_signature) message.thinking_signature = msg.thinking_signature;
    if (msg.streamStats) message.streamStats = msg.streamStats;
    if (msg.usage) message.usage = msg.usage;
    if (msg.context) message.context = msg.context;
    if (msg.tool_calls) message.tool_calls = msg.tool_calls;
    if (Array.isArray(msg.versions)) {
        message.versions = msg.versions;
        message.currentVersion = msg.currentVersion !== undefined ? msg.currentVersion : msg.versions.length - 1;
    }
    return message;
}

function findSessionOrThrow(db, conversationId) {
    const session = db.find('id', conversationId).find(s => s._type === 'session');
    if (!session) throw new Error(`session not found: ${conversationId}`);
    return session;
}

function findConversationOrThrow(db, conversationId) {
    const conv = db.find('id', conversationId).find(d => d._type === 'conversation');
    if (!conv) throw new Error(`conversation doc not found: ${conversationId}`);
    return conv;
}

function findOrCreateConversation(db, session, user) {
    const convs = db.find('id', session.id).filter(d => d._type === 'conversation');
    if (convs.length > 0) return convs[0];
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
    db.insert(conv);
    return conv;
}

function guardCtx(fnName, ctx) {
    if (!ctx?.user?.id) throw new Error(`${fnName}: ctx.user required`);
    if (!ctx?.dbInstance?.db) throw new Error(`${fnName}: ctx.dbInstance required`);
    if (typeof ctx?.embedMessageAsync !== 'function') throw new Error(`${fnName}: ctx.embedMessageAsync required`);
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

    const session = findSessionOrThrow(db, msg.conversationId);
    const conv = findOrCreateConversation(db, session, ctx.user);

    const idx = conv.messages.length;
    const msgId = msg.id || 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
    const message = normalizeStoredMessage({ ...msg, id: msgId, idx, createdAt: new Date().toISOString() });

    conv.messages.push(message);
    conv.messageCount = conv.messages.length;
    conv.updatedAt = new Date().toISOString();
    db.arrayPush(conv._id, 'messages', message);
    db.set(conv._id, 'messageCount', conv.messageCount);
    db.set(conv._id, 'updatedAt', conv.updatedAt);

    session.messageCount = conv.messageCount;
    session.updatedAt = conv.updatedAt;
    if (message.role === 'user' && session.title === 'New Chat') {
        const excerpt = (message.content || '').split('\n')[0].substring(0, 40);
        session.title = excerpt || 'New Chat';
        db.set(session._id, 'title', session.title);
    }
    db.set(session._id, 'messageCount', session.messageCount);
    db.set(session._id, 'updatedAt', session.updatedAt);

    log.info('Message added', { sessionId: msg.conversationId, role: message.role, idx, contentLen: (message.content || '').length }, 'Message');

    // Fire-and-forget embed. MUST swallow the rejection: embedMessageAsync re-throws
    // after re-queueing a transient failure; an unhandled rejection kills the process.
    ctx.embedMessageAsync(ctx.dbInstance, message, session, conv._id, idx).catch(err => {
        log.warn('Fire-and-forget embed rejected (already re-queued)', { sessionId: msg.conversationId, idx, kind: err?.kind, error: err?.message }, 'Embed');
    });

    return { message, session, conv };
}

// §2.4 durable variants: append a full-shape variant to an assistant message,
// flip currentVersion, mirror the variant onto the top-level fields.
// ctx as above. variant = { content, reasoning_content?, thinking_signature?,
//                           usage?, context?, streamStats?, model?, timestamp? }
async function appendMessageVariant(ctx, { conversationId, messageId, variant } = {}) {
    guardCtx('appendMessageVariant', ctx);
    if (!conversationId) throw new Error('appendMessageVariant: conversationId required');
    if (!messageId) throw new Error('appendMessageVariant: messageId required');
    if (!variant || typeof variant.content !== 'string') throw new Error('appendMessageVariant: variant.content (string) required');
    const { db } = ctx.dbInstance;
    const log = ctx.log || { info() {}, warn() {}, error() {}, debug() {} };

    const session = findSessionOrThrow(db, conversationId);
    const conv = findConversationOrThrow(db, conversationId);
    const message = conv.messages.find(m => m.id === messageId);
    if (!message) throw new Error(`appendMessageVariant: message not found: ${messageId}`);
    if (message.role !== 'assistant') throw new Error(`appendMessageVariant: not an assistant message: ${messageId}`);

    if (!Array.isArray(message.versions)) message.versions = [];
    message.versions.push(variant);
    message.currentVersion = message.versions.length - 1;
    for (const k of ['content', 'reasoning_content', 'thinking_signature', 'usage', 'context', 'streamStats', 'model', 'timestamp']) {
        if (variant[k] !== undefined) message[k] = variant[k];
    }
    conv.updatedAt = new Date().toISOString();
    // Whole-array write: db.set with a dotted array path is proven for scalars
    // (embedStatus) but not for objects — keep to the top-level key shape.
    db.set(conv._id, 'messages', conv.messages);
    db.set(conv._id, 'updatedAt', conv.updatedAt);

    log.info('Variant added', { sessionId: conversationId, messageId, version: message.currentVersion }, 'Message');

    // Embed fires per variant creation (§2.4). NOTE: the vector payload still keys
    // by {chatId, msgIdx} — variant indexing lands with the embed-payload change.
    ctx.embedMessageAsync(ctx.dbInstance, message, session, conv._id, message.idx).catch(err => {
        log.warn('Fire-and-forget variant embed rejected', { sessionId: conversationId, messageId, kind: err?.kind, error: err?.message }, 'Embed');
    });

    return { message };
}

// §2.4: flip currentVersion to an EXISTING variant (pointer change), mirror the
// selected variant onto top-level fields, persist. No embed fire (the variant
// was embedded at creation).
async function setMessageVariant(ctx, { conversationId, messageId, index, direction } = {}) {
    guardCtx('setMessageVariant', ctx);
    if (!conversationId) throw new Error('setMessageVariant: conversationId required');
    if (!messageId) throw new Error('setMessageVariant: messageId required');
    const { db } = ctx.dbInstance;
    const log = ctx.log || { info() {}, warn() {}, error() {}, debug() {} };

    const conv = findConversationOrThrow(db, conversationId);
    const message = conv.messages.find(m => m.id === messageId);
    if (!message) throw new Error(`setMessageVariant: message not found: ${messageId}`);
    if (!Array.isArray(message.versions) || message.versions.length === 0) {
        throw new Error(`setMessageVariant: message has no variants: ${messageId}`);
    }
    const count = message.versions.length;
    let next;
    if (Number.isInteger(index)) {
        if (index < 0 || index >= count) throw new Error(`setMessageVariant: index out of range: ${index} (0..${count - 1})`);
        next = index;
    } else if (direction === 'prev' || direction === 'next') {
        const cur = Number.isInteger(message.currentVersion) ? message.currentVersion : count - 1;
        next = direction === 'next' ? (cur + 1) % count : (cur - 1 + count) % count;
    } else {
        throw new Error('setMessageVariant: index (int) or direction ("prev"|"next") required');
    }
    message.currentVersion = next;
    const variant = message.versions[next];
    for (const k of ['content', 'reasoning_content', 'thinking_signature', 'usage', 'context', 'streamStats', 'model', 'timestamp']) {
        if (variant[k] !== undefined) message[k] = variant[k];
    }
    conv.updatedAt = new Date().toISOString();
    db.set(conv._id, 'messages', conv.messages);
    db.set(conv._id, 'updatedAt', conv.updatedAt);

    log.info('Variant switched', { sessionId: conversationId, messageId, currentVersion: next }, 'Message');
    return { message };
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

    const conv = findConversationOrThrow(db, conversationId);
    const newMessages = messages.map((m, idx) => ({ ...m, idx, attachments: normalizeAttachments(m.attachments) }));
    conv.messages = newMessages;
    conv.messageCount = newMessages.length;
    conv.updatedAt = new Date().toISOString();
    db.update(conv._id, conv);

    const session = db.find('id', conversationId).find(s => s._type === 'session');
    if (session) {
        session.messageCount = newMessages.length;
        session.updatedAt = conv.updatedAt;
        db.set(session._id, 'messageCount', session.messageCount);
        db.set(session._id, 'updatedAt', session.updatedAt);
    }

    log.info('Messages replaced', { sessionId: conversationId, count: newMessages.length }, 'Message');
    return { messageCount: newMessages.length };
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
    appendConversationMessage,
    appendMessageVariant,
    setMessageVariant,
    replaceConversationMessages
};
