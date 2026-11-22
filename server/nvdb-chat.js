/**
 * Chat collection contract for nVDB v2 — the single source of truth for how a
 * chat session becomes v2 documents.
 *
 * One message becomes N chunk documents (id `user:session:msgIdx#chunkIdx`).
 * Both the writer and the reader (attach vectors, integrity checks, sweeps) must
 * derive ids and hashes from the same functions here, otherwise a search hit
 * stops resolving to a stored message. The Rust side is authoritative for the
 * wire shapes: `V2CollectionConfig` (nvdb-chat config) and `V2Document`.
 */

const {
    isEmbeddableMessage,
    splitTextIntoChunks,
    EMBEDDING_DIMS,
    EMBED_CHUNK_TOKENS,
    EMBED_CHUNK_OVERLAP_TOKENS,
    TOK_CHARS_RATIO
} = require('./embed');
const { documentHashes } = require('./nvdb-v2-hash');

const DEFAULT_QUERY_INSTRUCT = 'Given a web search query, retrieve relevant passages that answer the query';
const DEFAULT_RELEVANCE_FLOOR = 0.05;
const DEFAULT_MODEL_VERSION = 'qwen3-embedding-4b';
const MAX_EXCERPT_BYTES = 1024;

/** Exact `V2CollectionConfig` wire shape nVDB v2 accepts on create. */
function chatCollectionConfig({ embedDims = EMBEDDING_DIMS, embedModelVersion = DEFAULT_MODEL_VERSION } = {}) {
    return {
        store_excerpt: true,
        promoted_fields: [
            { name: 'role', field_type: 'String' },
            { name: 'mode', field_type: 'String' },
            { name: 'session_id', field_type: 'String' },
            { name: 'msg_idx', field_type: 'I64' }
        ],
        vector_lane: {
            dim: embedDims,
            distance: 'Cosine',
            model_version: embedModelVersion,
            flat_search_cutoff: 50000
        }
    };
}

/**
 * ACL principal for a user. Fail closed: an empty id would otherwise produce
 * `user:` — a group every account matches.
 */
function userPrincipal(userId) {
    if (typeof userId !== 'string' || !userId.trim()) {
        throw new Error(`userPrincipal: userId required (got ${JSON.stringify(userId)})`);
    }
    return `user:${userId}`;
}

function normalizeMode(mode) {
    return mode === 'arena' ? 'arena' : 'direct';
}

/** ISO string or epoch (ms/s) to unix seconds; anything unparseable is null. */
function toUnixSeconds(value) {
    if (value == null) return null;
    if (Number.isFinite(value)) {
        return value > 1e12 ? Math.floor(value / 1000) : Math.floor(value);
    }
    if (typeof value === 'string') {
        const ms = Date.parse(value);
        return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
    }
    return null;
}

/** Truncate to maxBytes UTF-8 bytes on a code-point boundary, never mid-character. */
function truncateUtf8(str, maxBytes = MAX_EXCERPT_BYTES) {
    const text = String(str ?? '');
    if (maxBytes <= 0) return '';
    if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
    let bytes = 0;
    let out = '';
    for (const ch of text) {
        const size = Buffer.byteLength(ch, 'utf8');
        if (bytes + size > maxBytes) break;
        bytes += size;
        out += ch;
    }
    return out;
}

/** Qwen3-Embedding instruct format: the query carries a task instruction, passages do not. */
function formatQueryForEmbedding(query, queryInstruct = DEFAULT_QUERY_INSTRUCT) {
    if (typeof query !== 'string') {
        throw new TypeError(`formatQueryForEmbedding: query must be a string (got ${typeof query})`);
    }
    if (!queryInstruct) return query;
    return `Instruct: ${queryInstruct}\nQuery: ${query}`;
}

function chatChunkId(userId, sessionId, msgIdx, chunkIdx) {
    if (typeof userId !== 'string' || !userId.trim()) {
        throw new Error('chatChunkId: userId required');
    }
    if (typeof sessionId !== 'string' || !sessionId.trim()) {
        throw new Error('chatChunkId: sessionId required');
    }
    if (!Number.isInteger(msgIdx) || msgIdx < 0) {
        throw new Error(`chatChunkId: msgIdx must be a non-negative integer (got ${msgIdx})`);
    }
    if (!Number.isInteger(chunkIdx) || chunkIdx < 0) {
        throw new Error(`chatChunkId: chunkIdx must be a non-negative integer (got ${chunkIdx})`);
    }
    return `${userId}:${sessionId}:${msgIdx}#${chunkIdx}`;
}

/**
 * Inverse of chatChunkId. Parsed from the right because session ids may contain
 * any character; `expectedUserId` disambiguates ids whose user id itself holds a
 * colon.
 */
function parseChatChunkId(id, expectedUserId = null) {
    if (typeof id !== 'string') return null;
    const hashAt = id.lastIndexOf('#');
    if (hashAt < 0) return null;
    const chunkPart = id.slice(hashAt + 1);
    if (!/^\d+$/.test(chunkPart)) return null;
    const chunkIdx = Number(chunkPart);

    const msgEnd = id.lastIndexOf(':', hashAt - 1);
    if (msgEnd < 0) return null;
    const msgPart = id.slice(msgEnd + 1, hashAt);
    if (!/^\d+$/.test(msgPart)) return null;
    const msgIdx = Number(msgPart);

    const prefix = id.slice(0, msgEnd);
    let userId;
    let sessionId;
    if (expectedUserId) {
        const marker = `${expectedUserId}:`;
        if (!prefix.startsWith(marker)) return null;
        userId = expectedUserId;
        sessionId = prefix.slice(marker.length);
    } else {
        const firstColon = prefix.indexOf(':');
        if (firstColon < 0) return null;
        userId = prefix.slice(0, firstColon);
        sessionId = prefix.slice(firstColon + 1);
    }
    if (!userId || !sessionId) return null;
    return { userId, sessionId, msgIdx, chunkIdx };
}

function extractSummaryText(session) {
    const summary = session?.summary;
    if (!summary || typeof summary !== 'object' || Array.isArray(summary)) return '';
    return [summary.title, summary.teaser, summary.reflection]
        .filter(part => typeof part === 'string' && part.trim() !== '')
        .join(' ')
        .slice(0, 800);
}

/** Every v2 document one stored message contributes (one per chunk). */
function buildMessageV2Docs({ userId, session, msg, msgIdx, chunkOpts = {} }) {
    if (typeof userId !== 'string' || !userId.trim()) {
        throw new Error('buildMessageV2Docs: userId required');
    }
    if (!session?.id) {
        throw new Error('buildMessageV2Docs: session.id required');
    }
    if (!Number.isInteger(msgIdx) || msgIdx < 0) {
        throw new Error(`buildMessageV2Docs: msgIdx must be a non-negative integer (got ${msgIdx})`);
    }
    if (!isEmbeddableMessage(msg)) return [];

    const content = String(msg.content ?? '');
    const chunks = splitTextIntoChunks(content, {
        chunkTokens: chunkOpts.chunkTokens || EMBED_CHUNK_TOKENS,
        overlapTokens: chunkOpts.overlapTokens === undefined ? EMBED_CHUNK_OVERLAP_TOKENS : chunkOpts.overlapTokens,
        tokRatio: chunkOpts.tokRatio || TOK_CHARS_RATIO
    });

    const mode = normalizeMode(session.mode);
    const createdAt = toUnixSeconds(msg.createdAt) ?? toUnixSeconds(session.createdAt);
    const updatedAt = toUnixSeconds(msg.updatedAt) ?? createdAt;
    const summaryHeadings = msgIdx === 0 ? extractSummaryText(session) : '';
    const acl = [userPrincipal(userId)];
    const title = session.title || '';

    return chunks.map((chunk, chunkIdx) => ({
        id: chatChunkId(userId, session.id, msgIdx, chunkIdx),
        parent_id: session.id,
        chunk_index: chunkIdx,
        kind: 'chat',
        title,
        name: '',
        path: session.id,
        headings: chunkIdx === 0 ? summaryHeadings : '',
        categories: [],
        tags: [],
        body: chunk.text,
        folder: mode,
        ext: null,
        mime: null,
        status: 'active',
        created_at: createdAt,
        updated_at: updatedAt,
        acl,
        metadata: {
            chatId: session.id,
            session_id: session.id,
            msgIdx,
            msg_idx: msgIdx,
            messageId: msg.id || null,
            role: msg.role || 'user',
            model: msg.model || null,
            speaker: msg.speaker || null,
            mode
        },
        excerpt: truncateUtf8(chunk.text, MAX_EXCERPT_BYTES)
    }));
}

/**
 * Passage text for embedding. Qwen3-Embedding expects plain passages without an
 * instruct prefix — a chat message is presented as a short titled passage, which
 * keeps the title/speaker context that a bare body loses.
 */
function buildChatVectorInput(doc) {
    const headerParts = [
        doc.title ? `Title: ${doc.title}` : null,
        doc.headings ? `Summary: ${doc.headings}` : null,
        doc.metadata?.speaker ? `Speaker: ${doc.metadata.speaker}` : null
    ].filter(part => part !== null);
    const header = headerParts.join('\n');
    return header ? `${header}\n\n${doc.body}` : doc.body;
}

/**
 * Upper bound on the chunk ids a message can own, swept inclusively so a message
 * that shrank since it was embedded leaves no orphan vector behind.
 */
function collectMessageChunkIds(userId, sessionId, msg, msgIdx, chunkOpts = {}) {
    const content = String(msg?.content ?? '');
    const splitCount = isEmbeddableMessage(msg) ? splitTextIntoChunks(content, chunkOpts).length : 1;
    const count = Math.max(1, Number(msg?.embedChunks) || 1, splitCount);
    const ids = [];
    for (let chunkIdx = 0; chunkIdx <= count; chunkIdx++) {
        ids.push(chatChunkId(userId, sessionId, msgIdx, chunkIdx));
    }
    return ids;
}

/**
 * Every document + hash the user's chat data should already have in nVDB — the
 * `expected` list feeds integrity_check, `byId` resolves a hit back to its
 * stored message. Messages live on conversation docs; session docs supply the
 * metadata (title, mode, summary, createdAt).
 *
 * Accepts either `docs` (an already-read array — the pinned-snapshot path) or
 * an nDB `db` handle whose documents are fetched over HTTP.
 */
async function buildUserExpectedDocs({ userId, db, docs, chunkOpts = {} }) {
    if (typeof userId !== 'string' || !userId.trim()) {
        throw new Error('buildUserExpectedDocs: userId required');
    }
    let all = docs;
    if (all === undefined) {
        if (!db || typeof db.queryAll !== 'function') {
            throw new Error('buildUserExpectedDocs: docs array or an nDB handle with queryAll() required');
        }
        const sessions = await db.queryAll({ filter: { _type: 'session' } });
        const conversations = await db.queryAll({ filter: { _type: 'conversation' } });
        all = [...conversations, ...sessions];
    }
    if (!Array.isArray(all)) throw new Error('buildUserExpectedDocs: docs must be an array');
    return expectedDocsFromDocs({ userId, docs: all, chunkOpts });
}

/** Sync core: derive the expected v2 documents from an in-memory doc array. */
function expectedDocsFromDocs({ userId, docs, chunkOpts = {} }) {
    if (typeof userId !== 'string' || !userId.trim()) {
        throw new Error('expectedDocsFromDocs: userId required');
    }
    if (!Array.isArray(docs)) throw new Error('expectedDocsFromDocs: docs array required');

    const sessions = docs.filter(d => d && d._type === 'session');
    const conversations = docs.filter(d => d && d._type === 'conversation');
    const sessionById = new Map();
    for (const session of sessions) {
        if (session?.id) sessionById.set(session.id, session);
    }

    const out = [];
    const byId = new Map();
    const expected = [];
    const seen = new Set();

    for (const source of [...conversations, ...sessions]) {
        if (!source?.id || !Array.isArray(source.messages) || seen.has(source.id)) continue;
        seen.add(source.id);
        const session = sessionById.get(source.id) || source;
        const convNdbId = source._id ?? null;
        source.messages.forEach((msg, msgIdx) => {
            const messageDocs = buildMessageV2Docs({ userId, session, msg, msgIdx, chunkOpts });
            for (const doc of messageDocs) {
                const { content_hash, envelope_hash } = documentHashes(doc);
                out.push(doc);
                byId.set(doc.id, { doc, content_hash, envelope_hash, convNdbId, session, msg, msgIdx });
                expected.push({ id: doc.id, content_hash, envelope_hash });
            }
        });
    }

    return { docs: out, byId, expected };
}

module.exports = {
    DEFAULT_QUERY_INSTRUCT,
    DEFAULT_RELEVANCE_FLOOR,
    DEFAULT_MODEL_VERSION,
    MAX_EXCERPT_BYTES,
    chatCollectionConfig,
    userPrincipal,
    normalizeMode,
    toUnixSeconds,
    truncateUtf8,
    formatQueryForEmbedding,
    chatChunkId,
    parseChatChunkId,
    extractSummaryText,
    buildMessageV2Docs,
    buildChatVectorInput,
    collectMessageChunkIds,
    buildUserExpectedDocs,
    expectedDocsFromDocs
};
