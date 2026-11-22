// ============================================
// internal-tools.js — PB-b: server-side internal tool port.
// The chat_archive_* / browser_fetch / attachment_save / context_retire tools
// that used to execute in the browser (chat.js executeLocalTool) now execute
// here over dbInstance — no HTTP hop to our own API, no browser required.
// Tool names and result shapes are kept identical so model behavior carries over.
// Single source of truth: /api/search and /api/references routes call the
// searchArchive/findReferences functions below (extracted 2026-08-24).
// storage_* ops (native, direct-fs to the MCP storage box) live in
// ./storage-tools.js and are folded into defs + dispatch here.
// ============================================

const storageTools = require('./storage-tools');
const retireView = require('./retire-view');
const { formatMessageTs } = require('./api-view');
const { preflightPreviewUrl } = require('./preview-content');
const { openHostedApp } = require('./hosted-apps');
const { resolveSearchOptions, describeSearchOptions } = require('./nvdb-search-options');
const {
    DEFAULT_QUERY_INSTRUCT,
    DEFAULT_RELEVANCE_FLOOR,
    userPrincipal,
    normalizeMode,
    toUnixSeconds,
    formatQueryForEmbedding,
    parseChatChunkId
} = require('./nvdb-chat');

let LOG = { info() {}, warn() {}, error() {}, debug() {} };
// List-event emitter (issue #33): metadata mutations broadcast chat.updated so
// attached sidebars refresh without a manual reload. Injected via init().
let EMIT_LIST_EVENT = null;
// log may be a logger instance OR a factory (() => logger), matching how
// server.js passes L to mcpPool/runner.
function init({ log, emitListEvent }) {
    if (typeof emitListEvent === 'function') EMIT_LIST_EVENT = emitListEvent;
    if (typeof log === 'function') {
        LOG = {
            info: (...a) => { try { log().info(...a); } catch { } },
            warn: (...a) => { try { log().warn(...a); } catch { } },
            error: (...a) => { try { log().error(...a); } catch { } },
            debug: (...a) => { try { log().debug(...a); } catch { } }
        };
    } else if (log) {
        LOG = log;
    }
}

// ============================================
// Archive search — nVDB v2 (native BM25 + dense RRF + level-2 rerank).
// deps = { embedBatch, embedAvailable, nvdbClient?, nvdbCollection?, userId?,
//          rerankerLoaded?, queryInstruct?, relevanceFloor? }
// ============================================

const HYBRID_DEFAULTS = {
    enabled: true,
    adaptive: true,
    rrfK: 20,
    candidateK: 200,
    lexicalWeight: 0.3,
    vectorWeight: 1.0,
    maxPerDocument: 2
};

const RERANK_DEFAULTS = {
    enabled: true,
    shortlist: 20,
    weight: 0.2
};

// Knowledge-role default: an unfiltered search is a knowledge search, so the
// legacy tool/system transcripts (some of them indexed before the tool-skip rule
// existed) are not candidates. An explicit role filter that names them may still
// inspect them. Empty content is never a result — no message, no identity.
const LEGACY_NON_KNOWLEDGE_ROLES = new Set(['tool', 'system']);

function isSearchEligible(msg, explicitRole) {
    if (!msg || String(msg.content ?? '').trim() === '') return false;
    if (explicitRole) return true; // role match already enforced while indexing
    return !LEGACY_NON_KNOWLEDGE_ROLES.has(msg.role);
}

async function searchArchive(dbInstance, body, deps = {}) {
    const { db } = dbInstance;

    const query = (body.query || '').trim();
    const limit = Math.max(1, Number(body.limit) || 10);
    const filterMode = body.mode || body.filter?.mode || null;
    const filterRole = body.role || body.filter?.role || null;
    const searchType = body.search_type || 'hybrid';
    const dateFrom = body.date_from || null;
    const dateTo = body.date_to || null;
    const searchOverrides = body.search || null;

    LOG.info('Search request', { query: query.slice(0, 50), role: filterRole, type: searchType, mode: filterMode }, 'Search');

    if (!query) return { results: [], query, search_type: searchType, method: searchType };

    const nvdbClient = deps.nvdbClient || dbInstance.nvdbClient;
    const collection = deps.nvdbCollection || dbInstance.nvdbCollection || 'chat';
    const userId = deps.userId || dbInstance.userId;
    const rerankerLoaded = deps.rerankerLoaded !== undefined ? Boolean(deps.rerankerLoaded) : Boolean(dbInstance.rerankerLoaded);
    const queryInstruct = deps.queryInstruct !== undefined ? deps.queryInstruct : DEFAULT_QUERY_INSTRUCT;
    const relevanceFloor = deps.relevanceFloor !== undefined ? Number(deps.relevanceFloor) : DEFAULT_RELEVANCE_FLOOR;
    const embedBatch = deps.embedBatch;
    const embedAvailable = deps.embedAvailable !== false;

    if (!nvdbClient) throw new Error('searchArchive: nvdbClient is required');
    const principals = [userPrincipal(userId)];

    let baseSwitches;
    let degradedMethod = null;
    if (searchType === 'hybrid') {
        baseSwitches = { dense: true, lexical: true, rerank: rerankerLoaded };
        if (!embedAvailable || !embedBatch) {
            LOG.warn('Hybrid search degraded to lexical-only: embedding unavailable', { query: query.slice(0, 50) }, 'Search');
            baseSwitches = { dense: false, lexical: true, rerank: false };
            degradedMethod = 'keyword-fallback';
        }
    } else if (searchType === 'semantic') {
        if (!embedAvailable || !embedBatch) throw new Error('Semantic search unavailable: embedding endpoint is down');
        baseSwitches = { dense: true, lexical: false, rerank: false };
    } else if (searchType === 'keyword') {
        baseSwitches = { dense: false, lexical: true, rerank: false };
    } else {
        throw new Error(`Invalid search_type: ${searchType}`);
    }

    const mergedOverrides = searchOverrides ? { ...baseSwitches, ...searchOverrides } : baseSwitches;
    const options = resolveSearchOptions({
        query,
        overrides: mergedOverrides,
        hybrid: HYBRID_DEFAULTS,
        rerank: RERANK_DEFAULTS,
        rerankerAvailable: rerankerLoaded,
        diversityField: 'parent_id'
    });

    let queryVector = null;
    if (options.dense) {
        try {
            const vectors = await embedBatch([formatQueryForEmbedding(query, queryInstruct)]);
            queryVector = vectors?.[0];
            if (!Array.isArray(queryVector) || queryVector.length === 0) {
                throw new Error('searchArchive: embedding endpoint returned no query vector');
            }
        } catch (err) {
            if (searchType === 'hybrid' && options.lexical) {
                LOG.warn('Hybrid search query embed failed — falling back to lexical', { query: query.slice(0, 50), error: err.message }, 'Search');
                options.dense = false;
                options.rerank = false;
                queryVector = null;
                degradedMethod = 'keyword-fallback';
            } else {
                throw err;
            }
        }
    }

    const filters = {};
    const promoted = [];
    const explicitRole = filterRole && filterRole !== 'all' ? filterRole : null;
    if (explicitRole) {
        promoted.push({ field: 'role', op: 'eq', value: explicitRole });
    }
    if (filterMode && filterMode !== 'all') {
        promoted.push({ field: 'mode', op: 'eq', value: normalizeMode(filterMode) });
    }
    if (promoted.length > 0) filters.promoted = promoted;

    const minTs = toUnixSeconds(dateFrom);
    const maxTs = toUnixSeconds(dateTo);
    if (minTs !== null || maxTs !== null) {
        filters.created_at = {};
        if (minTs !== null) filters.created_at.min = minTs;
        if (maxTs !== null) filters.created_at.max = maxTs;
    }

    const hybridTopK = options.rerank
        ? Math.max(limit * 2, options.shortlist)
        : Math.max(limit * 2, 10);
    const hybridQuery = {
        lexical: {
            text: query,
            top_k: hybridTopK,
            principals,
            fuzzy_edits: 1,
            explain: false,
            group_by_parent: options.diversity ? { max_per_parent: options.maxPerDocument } : null,
            filters
        },
        query_vector: queryVector,
        dense: options.dense,
        lexical_enabled: options.lexical,
        candidate_k: options.candidateK,
        rrf_k: options.rrfK,
        lexical_weight: options.lexicalWeight,
        vector_weight: options.vectorWeight
    };
    const hybridResult = await nvdbClient.hybridSearch(collection, hybridQuery);
    const rawHits = hybridResult?.hits || [];

    let orderedHits;
    if (options.rerank && rawHits.length > 0) {
        const l2 = await nvdbClient.level2(collection, {
            query_text: query,
            principals,
            hits: rawHits,
            shortlist: options.shortlist,
            rerank_weight: options.rerankWeight,
            relevance_floor: relevanceFloor
        });
        if (l2.rejected) {
            return {
                results: [],
                query,
                search_type: searchType,
                method: 'hybrid',
                mode: describeSearchOptions(options),
                rejected: true,
                bestRerankScore: l2.best_rerank_score ?? null,
                rejectedCount: (l2.hits || []).length
            };
        }
        orderedHits = (l2.hits || []).map(item => ({ hybrid: item.hybrid, rerankScore: item.rerank_score ?? null }));
    } else {
        orderedHits = rawHits.map(h => ({ hybrid: h, rerankScore: null }));
    }

    const results = [];
    const seen = new Set();
    const convCache = new Map();

    for (const entry of orderedHits) {
        if (results.length >= limit) break;
        const doc = entry.hybrid?.hit;
        if (!doc) continue;

        const parsed = parseChatChunkId(doc.id, userId);
        if (!parsed) continue;

        const seenKey = `${parsed.sessionId}#${parsed.msgIdx}`;
        if (seen.has(seenKey)) continue;
        seen.add(seenKey);

        let cached = convCache.get(parsed.sessionId);
        if (!cached) {
            const docs = await db.findAll('id', parsed.sessionId);
            cached = {
                conv: docs.find(d => d._type === 'conversation') || null,
                session: docs.find(d => d._type === 'session') || null
            };
            convCache.set(parsed.sessionId, cached);
        }
        const { conv, session } = cached;
        if (!conv?.messages) continue;

        let msg = conv.messages[parsed.msgIdx];
        if (!msg || (msg.idx !== undefined && msg.idx !== parsed.msgIdx)) {
            msg = conv.messages.find(m => m.idx === parsed.msgIdx);
        }
        if (!msg) continue;
        if (!isSearchEligible(msg, explicitRole)) continue;

        const score = entry.rerankScore !== null
            ? entry.rerankScore
            : options.dense && !options.lexical && typeof entry.hybrid.vector_score === 'number'
                ? entry.hybrid.vector_score
                : entry.hybrid.rrf_score ?? doc.score ?? 0;

        results.push({
            score,
            rrfScore: entry.hybrid.rrf_score ?? null,
            rerankScore: entry.rerankScore,
            lexicalRank: entry.hybrid.lexical_rank ?? null,
            vectorRank: entry.hybrid.vector_rank ?? null,
            message: {
                id: msg.id,
                idx: msg.idx ?? parsed.msgIdx,
                role: msg.role,
                model: msg.model,
                content: msg.content.slice(0, 300),
                createdAt: msg.createdAt
            },
            session: session ? {
                id: session.id,
                title: session.title,
                mode: session.mode,
                createdAt: session.createdAt
            } : null
        });
    }

    LOG.info('Search', { query: query.slice(0, 80), results: results.length, type: searchType }, 'Search');
    return {
        results,
        query,
        search_type: searchType,
        method: degradedMethod || (searchType === 'keyword' ? 'keyword' : searchType === 'semantic' ? 'semantic' : 'hybrid'),
        mode: describeSearchOptions(options),
        rejected: false
    };
}

// Tool-facing shape of a searchArchive result. messageId + idx are the message
// identity: without them a content-free identity guess (which message was that?)
// is the only option, and the 500-char excerpt is not an identity.
function shapeSearchToolResult(data) {
    const out = {
        query: data.query,
        method: data.method,
        results: data.results.map(r => ({
            score: r.score,
            messageId: r.message?.id,
            idx: r.message?.idx,
            sessionId: r.session?.id,
            sessionTitle: r.session?.title,
            mode: r.session?.mode,
            role: r.message?.role,
            model: r.message?.model,
            date: r.session?.createdAt || r.message?.createdAt,
            content: r.message?.content?.slice(0, 500)
        }))
    };
    if (data.mode !== undefined) out.searchMode = data.mode;
    if (data.rejected) {
        out.rejected = true;
        out.bestRerankScore = data.bestRerankScore;
        out.note = 'No relevant matches passed the relevance floor.';
    }
    return out;
}

// ============================================
// Reference tracing — extracted from the /api/references route (byte-faithful port).
// ============================================

async function findReferences(db, body) {
    const sid = (body.session_id || '').trim();
    const dir = body.direction || 'both';
    if (!sid) throw new Error('Missing session_id');

    const arenaSessions = (await db.findAll('_type', 'session'))
        .filter(s => s.mode === 'arena' || s.mode === 'direct');

    const refPattern = /arena-\d+[-\w]*/g;

    const outbound = [];
    if (dir === 'outbound' || dir === 'both') {
        const msgs = (await db.findAll('_type', 'message')).filter(m => m.sessionId === sid);
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

    const inbound = [];
    if (dir === 'inbound' || dir === 'both') {
        const allMessages = await db.findAll('_type', 'message');
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

    return { source: { id: sid }, direction: dir, referenced_by: inbound, references: outbound };
}

// ============================================
// Tool definitions — names identical to the browser set; execution-context
// wording updated for server-side execution (PB-b).
// ============================================

const SERVER_EXEC_NOTE = 'Execution: runs natively in the chat BACKEND (server-side). Call this tool by name — do NOT route it through the workshop tools dispatcher or any MCP server; that returns Unknown method errors.';

const ARCHIVE_TOOL_DEFS = [
    {
        type: 'function',
        function: {
            name: 'browser_fetch',
            description: `${SERVER_EXEC_NOTE}\\n\\nDirect HTTP fetch from the chat backend — no MCP JSON-RPC size limits, no CORS. Use this to download a file or resource from ANY URL when the response may be too large for MCP (typically capped around 64 KB). Works for storage files, LAN addresses, and public internet URLs alike.\\n\\n**Binary upload**: use body_type="data_url" with a data URL body to send binary data to HTTP endpoints (e.g. PUT /storage/* on the MCP server). NOTE: to save a chat attachment to workshop storage, use attachment_save instead — it handles the transfer in one call.\\n\\n**Response handling**: small text (≤ 32 KB) is returned inline. Text larger than 32 KB is auto-paged into a bucket file (bucketFile + page count; read pages via bucket_file/chunk) — once fully consumed, retire those result messages with context_retire (their [mN] indexes). Binary types (images, PDFs, audio, etc.) are uploaded to the chat's bucket and a \\/api\\/buckets\\/images\\/... URL is returned instead.\\n\\n**When to use**: whenever you already have a direct URL and expect the payload to exceed MCP limits, or when storage_read returns a relative path pointer (prepend your MCP origin and fetch it).`,
            parameters: {
                type: 'object',
                properties: {
                    url: { type: 'string', description: 'Absolute URL to fetch.' },
                    method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], description: 'HTTP method (default GET)' },
                    headers: { type: 'object', description: 'Optional request headers as key/value strings' },
                    body: { type: 'string', description: 'Optional request body for POST/PUT/PATCH. When body_type is "text" (default), sent as-is. When body_type is "data_url", this must be a data URL (data:mime;base64,...) which is decoded to binary before sending.' },
                    body_type: { type: 'string', enum: ['text', 'data_url'], description: 'How to interpret the body. "text" (default): send as string. "data_url": parse body as a data URL, decode base64 to binary, send with the data URL MIME type as Content-Type.' },
                    max_inline_bytes: { type: 'number', description: 'Max bytes to return inline as text. Text larger than 32 KB is auto-CHUNKED (returns bucketFile + chunk count) regardless of this value. Set to 0 to always upload to bucket and return a URL.' },
                    bucket_file: { type: 'string', description: 'Chunk read mode: the bucketFile from a chunked response. Pair with chunk=N to read one chunk (omit url).' },
                    chunk: { type: 'number', description: 'Chunk read mode: 0-indexed chunk to read from bucket_file (omit url).' }
                },
                required: ['url']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'chat_archive_update_metadata',
            description: `${SERVER_EXEC_NOTE}\\n\\nUpdate the metadata for a specific session/chat. Use this to assign categories (folders), write structured summaries, or update titles for better organization. The summary is an OBJECT {title, teaser, reflection} — never a bare string. Pass it either as a nested object (summary: {title, teaser, reflection}) or as the flat title/teaser/reflection params, which are assembled into the object. The response echoes storedSummary so you can verify the object was stored correctly.`,
            parameters: {
                type: 'object',
                properties: {
                    session_id: { type: 'string', description: 'The session ID to update' },
                    title: { type: 'string', description: 'Optional new title — sets the top-level session title AND summary.title' },
                    summary: {
                        type: 'object',
                        description: 'Optional structured summary object. Schema: {title: string, teaser: string, reflection: string}. Stored as an object, never stringified.',
                        properties: {
                            title: { type: 'string', description: 'Short title for the session' },
                            teaser: { type: 'string', description: 'One-line teaser describing the session' },
                            reflection: { type: 'string', description: 'Longer reflection or notes on the session' }
                        }
                    },
                    teaser: { type: 'string', description: 'Optional flat teaser — merged into summary.teaser' },
                    reflection: { type: 'string', description: 'Optional flat reflection — merged into summary.reflection' },
                    category: { type: 'string', description: 'Optional category (acts as a folder for grouping)' },
                    force: { type: 'boolean', description: 'Required to overwrite a CURATED summary. Only pass true with explicit intent to replace curation artifacts.' }
                },
                required: ['session_id']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'chat_archive_search',
            description: `${SERVER_EXEC_NOTE}\\n\\nSearch the conversation archive. Use semantic mode for themes/ideas, keyword mode for specific terms, hybrid for both. Returns messages ranked by relevance.`,
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'The search query' },
                    mode: { type: 'string', enum: ['direct', 'arena', 'all'], description: 'Filter by session type (default: all)' },
                    role: { type: 'string', enum: ['user', 'assistant', 'tool', 'system', 'all'], description: 'Filter by message role (default: all — excludes tool and system noise; name "tool" or "system" explicitly to inspect those legacy messages, empty messages are never returned)' },
                    search_type: { type: 'string', enum: ['semantic', 'keyword', 'hybrid'], description: 'Search method (default: hybrid — native BM25 + dense RRF + rerank; use keyword for lexical-only or semantic for dense-only)' },
                    limit: { type: 'number', description: 'Max results (default 10)' },
                    date_from: { type: 'string', description: 'ISO date — messages after this date' },
                    date_to: { type: 'string', description: 'ISO date — messages before this date' }
                },
                required: ['query']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'chat_archive_get_session',
            description: `${SERVER_EXEC_NOTE}\\n\\nRetrieve a specific conversation session by ID. Results over 32 KB are auto-paged into a bucket file like browser_fetch (bucketFile + page count; read pages with browser_fetch bucket_file/chunk) — a full session can be far larger than your context window, so never try to inline it whole. Once consumed, retire those result messages with context_retire (their [mN] indexes).\\n\\nTo process session data with a forge tool: (1) call this tool to get session data, (2) call storage.write to persist it, (3) pass the storage URL as forge.call payload.\\n\\nWhen saveToStorage is true, this tool writes the full session JSON directly to workshop storage and returns ONLY the URL — use this when you need to pass large session data to a forge tool that would overflow the context window.`,
            parameters: {
                type: 'object',
                properties: {
                    session_id: { type: 'string', description: 'The session/channel ID to retrieve' },
                    offset: { type: 'number', description: 'Message offset for pagination (default 0)' },
                    limit: { type: 'number', description: 'Max messages to return (default 100)' },
                    saveToStorage: { type: 'boolean', description: 'If true, writes full session JSON to workshop storage and returns only the URL. Use when passing data to forge.call.' }
                },
                required: ['session_id']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'chat_archive_list_chats',
            description: `${SERVER_EXEC_NOTE}\\n\\nList all direct (normal) chat sessions with metadata. Use to browse past conversations.`,
            parameters: {
                type: 'object',
                properties: {
                    limit: { type: 'number', description: 'Max results (default 20)' },
                    offset: { type: 'number', description: 'Pagination offset (default 0)' },
                    date_from: { type: 'string', description: 'ISO date string — filter sessions created after this date' },
                    date_to: { type: 'string', description: 'ISO date string — filter sessions created before this date' }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'chat_archive_list_arena',
            description: `${SERVER_EXEC_NOTE}\\n\\nList all arena sessions with metadata. Use to browse available conversations.`,
            parameters: {
                type: 'object',
                properties: {
                    limit: { type: 'number', description: 'Max results (default 20)' },
                    offset: { type: 'number', description: 'Pagination offset (default 0)' },
                    date_from: { type: 'string', description: 'ISO date string — filter sessions created after this date' },
                    date_to: { type: 'string', description: 'ISO date string — filter sessions created before this date' }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'chat_archive_find_similar',
            description: `${SERVER_EXEC_NOTE}\\n\\nGiven a session ID, find the most semantically similar sessions in the archive. Use to discover related conversations without guessing search terms.`,
            parameters: {
                type: 'object',
                properties: {
                    session_id: { type: 'string', description: 'The session ID to find similar sessions for' },
                    limit: { type: 'number', description: 'Max results (default 5)' }
                },
                required: ['session_id']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'chat_archive_find_references',
            description: `${SERVER_EXEC_NOTE}\\n\\nTrace conversation lineage. Finds which sessions reference this one (inbound) and which sessions this one references (outbound). Matches session IDs in message content.`,
            parameters: {
                type: 'object',
                properties: {
                    session_id: { type: 'string', description: 'The session ID to trace references for' },
                    direction: { type: 'string', enum: ['inbound', 'outbound', 'both'], description: 'Reference direction (default: both)' }
                },
                required: ['session_id']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'attachment_save',
            description: `${SERVER_EXEC_NOTE}\\n\\nCopy a binary file (image, PDF, etc.) from the chat file bucket to workshop storage. Use this to persist attached images or other binaries into the MCP server's filesystem — e.g. saving a user-uploaded image to digital-twin/images/.\\n\\nThe source URL is the bucket URL from the attachment manifest line in the user message (looks like http://<host>/api/buckets/images/<id>.<ext>). The destination is a path relative to the MCP storage root. Returns the storage path and byte count on success.\\n\\nThis is a server-to-server copy — no base64 in your context, no token cost. One call does the whole transfer.`,
            parameters: {
                type: 'object',
                properties: {
                    url: { type: 'string', description: 'The source URL — a bucket URL from the attachment manifest, or any reachable URL that returns the binary bytes.' },
                    storage_path: { type: 'string', description: 'Destination path in workshop storage, relative to the storage root. Example: "digital-twin/images/photo.jpg"' }
                },
                required: ['url', 'storage_path']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'chat_preview_show',
            description: `${SERVER_EXEC_NOTE}\n\nQueue content or a file/URL for rendering in the chat's preview pane (a second rendering surface). Pass EXACTLY ONE of content (text to render, markdown or code) or url (a /storage/... path or absolute http(s) URL to fetch). URL mode is for existing text/Markdown/code files only: binary documents such as PDFs, images, and archives are rejected with an error; for rendered documents use raster page previews (PNG) instead. The preview renders CLIENT-side: this tool returns a confirmation and the user clicks "Show in preview" on the tool bubble to render it. Use content mode for generated work product (edits, diffs, code). Preview a file with its url (not its content) whenever it carries relative links — a blog draft links research notes as ../references/<slug>.md, and only a document with a location resolves them; such note links render as an in-pane dialog, all other links open in a new tab.`,
            parameters: {
                type: 'object',
                properties: {
                    id: { type: 'string', description: 'Stable identifier (reuse the same id to update an existing preview in place)' },
                    title: { type: 'string', description: 'Human-readable label shown in the preview dropdown' },
                    content: { type: 'string', description: 'Content mode: the text to render (markdown or code)' },
                    url: { type: 'string', description: 'URL mode: a /storage/... path or absolute http(s) URL to fetch and display' },
                    language: { type: 'string', description: "Language hint: 'markdown' for rendered markdown, else a code language name" },
                    source: { type: 'string', description: 'Optional provenance label' }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'chat_app_open',
            description: `${SERVER_EXEC_NOTE}\n\nPrepare an explicit hosted tool UI for the user to open manually. This does NOT open a dialog by itself and must not be used for ordinary headless rendering. Currently supported app: print (the MCP /print editor, for occasional manual page-break adjustment after print.render has produced its normal PDF and raster previews). Args: id (safe stable slug), title, app, url (the editorPath supplied by the tool, on the configured MCP origin). Returns a conversation-scoped appInstanceId and an Open button on the tool message. The hosted app talks directly to its own backend; chat never proxies document saves and never receives chat credentials.`,
            parameters: {
                type: 'object',
                properties: {
                    id: { type: 'string', description: 'Stable safe slug for this hosted app reference, e.g. print-vita' },
                    title: { type: 'string', description: 'Human-readable dialog title' },
                    app: { type: 'string', enum: ['print'], description: 'Allowlisted hosted app id' },
                    url: { type: 'string', description: 'The app editorPath supplied by the tool, e.g. /print?path=vita%2Fvita.md' }
                },
                required: ['id', 'title', 'app', 'url']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'chat_preview_state',
            description: `${SERVER_EXEC_NOTE}\n\nReturn the preview items shown so far in this conversation (metadata only: id, title, language, source — no content). Use to recall what you've already previewed when the user refers to "this" or "the current one". Live view state (which item is selected in the dropdown, whether the pane is open) is client-side and not queryable by the backend.`,
            parameters: {
                type: 'object',
                properties: {}
            }
        }
    }
];

const RETIREMENT_TOOL_DEFS = [
    {
        type: 'function',
        function: {
            name: 'context_retire',
            description: `${SERVER_EXEC_NOTE}\\n\\nEXCEPTIONAL measure, not routine hygiene — use ONLY when the context is genuinely running low or the user asks for a more focused context; full context is your best working material. Retires messages you have fully consumed: their full text (tool results, your reasoning and prose, user text) leaves your context on the next request; your distillation stays in its place as a tombstone. Address messages by the [mN] marker each one carries in the transcript — COUNT them from what you see, never reconstruct from memory. Use context_units() to list what exists.\\n\\nTHE COST, understood properly: providers cache the KV state of the prompt prefix. Retiring rewrites mid-history content, which invalidates that cache at the first tombstone — every token after it is processed as brand-new input at full price on the next request, instead of hitting the cached prefix. So one retirement makes exactly one request more expensive and every request after it cheaper (the payload stays smaller). Consequences: batch everything into ONE call — N separate retirements pay the cache re-entry N times; prefer retiring when context pressure is real, so the recurring saving actually collects; and expect the context-cost indicator to show a cache break on the turn after retiring.\\n\\nWrite distillations as your future working memory: key facts, figures, decisions, open items, and anything you would need to decide whether restoring the original is worth it. A vague distillation ("discusses infrastructure") is a failed retirement — if you cannot distill it specifically, you have not consumed it; do not retire it. Partial success is normal — unrecognized indexes are skipped and reported, the rest retire. The original always stays intact in canonical history; context_unretire restores full text (it breaks the cache the same way).`,
            parameters: {
                type: 'object',
                properties: {
                    messages: {
                        anyOf: [
                            { type: 'integer', description: 'A single message index, e.g. 42' },
                            { type: 'array', items: { anyOf: [{ type: 'integer' }, { type: 'string' }] }, description: 'Indexes and/or ranges, e.g. [30, 31, "40-55"]' },
                            { type: 'string', description: 'A range, e.g. "30-44"' }
                        ],
                        description: 'Message indexes to retire (the N in each message\'s [mN] marker). A number, a "from-to" range string, or a mixed array of both.'
                    },
                    distill: { type: 'string', description: 'Your distillation of what to keep from these messages: key facts, decisions, open items — written for your future self.' }
                },
                required: ['messages', 'distill']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'context_unretire',
            description: `${SERVER_EXEC_NOTE}\\n\\nRestore previously retired messages — their full text returns to your context on the next request. Use when a tombstone's distillation is insufficient for the current task. Note: like retiring, restoring rewrites history and breaks the KV cache at that point. Pass "all" to restore everything.`,
            parameters: {
                type: 'object',
                properties: {
                    messages: {
                        anyOf: [
                            { type: 'integer' },
                            { type: 'array', items: { anyOf: [{ type: 'integer' }, { type: 'string' }] } },
                            { type: 'string', enum: ['all'], description: 'Restore every retired message' }
                        ],
                        description: 'Message indexes (the N in [mN] markers), a range like "30-44", or "all".'
                    }
                },
                required: ['messages']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'context_units',
            description: `${SERVER_EXEC_NOTE}\\n\\nList every message of this conversation with its retirable content: index, kinds (tool-result / reasoning / prose / user / args), sizes, and retirement state. Use this BEFORE retiring to count exact [mN] indexes from ground truth instead of reconstructing them from memory, and to review what is already tombstoned.`,
            parameters: { type: 'object', properties: {}, required: [] }
        }
    }
];

const INTERNAL_TOOL_NAMES = new Set([...ARCHIVE_TOOL_DEFS, ...RETIREMENT_TOOL_DEFS, ...storageTools.TOOL_DEFS].map(t => t.function.name));

function getToolDefs({ chunkTransform = false } = {}) {
    const defs = chunkTransform ? [...ARCHIVE_TOOL_DEFS, ...RETIREMENT_TOOL_DEFS] : [...ARCHIVE_TOOL_DEFS];
    return [...defs, ...storageTools.TOOL_DEFS];
}

function isInternalTool(name) {
    return INTERNAL_TOOL_NAMES.has(name);
}

// Vision filter (PB-b): when the model supports vision it receives images
// natively (the runner/api-view always attach them), so the MCP vision tools
// are redundant indirection — filtered out. Non-vision models keep them as the
// fallback path. (The hasAutoVisionAnalysis content-sniff was dropped: nothing
// has produced the [Auto-vision: marker since the rework — see runner runOnce.)
function filterVisionTools(tools, { modelSupportsVision = false } = {}) {
    if (!modelSupportsVision) return tools;
    return tools.filter(tool => {
        const toolName = tool.function?.name?.toLowerCase() || '';
        return !toolName.includes('vision.') && !toolName.includes('vision_');
    });
}

// ============================================
// Execution. ctx = {
//   user, dbInstance, conversationId, log,
//   mcpOrigin,                 // workshop origin (storage PUTs) | null
//   getStoredMessages,         // () => stored messages array (fresh read) | null
//   getRetirements,            // () => session.retirements (fresh read)
//   setRetirements,            // async (map) => persists to the session doc
//   embedDeps: { embedBatch, embedAvailable }
// }
// Returns MCP-style { content: [{type:'text'|'image', ...}] }.
// ============================================

// Positional selector parsing: number | "from-to" | mixed array →
// { idxs: [...], bad: [...] } (unparseable/out-of-range entries, verbatim).
function parseSelector(raw, maxIdx) {
    const idxs = [];
    const bad = [];
    const push = (n) => {
        if (Number.isInteger(n) && n >= 0 && n <= maxIdx) idxs.push(n);
        else bad.push(String(n));
    };
    const one = (v) => {
        if (typeof v === 'number') return push(v);
        if (typeof v === 'string' && /^\s*\d+\s*-\s*\d+\s*$/.test(v)) {
            const [a, b] = v.split('-').map(s => parseInt(s.trim(), 10));
            if (a <= b && a >= 0 && b <= maxIdx) { for (let i = a; i <= b; i++) idxs.push(i); }
            else bad.push(v.trim());
            return;
        }
        if (typeof v === 'string' && /^\s*\d+\s*$/.test(v)) return push(parseInt(v.trim(), 10));
        bad.push(String(v).slice(0, 40));
    };
    if (Array.isArray(raw)) raw.forEach(one);
    else if (typeof raw === 'string' && raw.trim() === 'all') return { all: true, idxs: [], bad: [] };
    else one(raw);
    return { all: false, idxs: [...new Set(idxs)].sort((a, b) => a - b), bad };
}

// Live-chain rule, identical to the projection's: the last user message and
// everything after it is the current exchange — never retirable.
function lastUserIdx(msgs) {
    for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i]?.role === 'user') return i;
    return msgs.length;
}

async function executeInternalTool(name, args, ctx) {
    const { user, dbInstance, conversationId, mcpOrigin, publicOrigin, embedDeps } = ctx;
    const { db } = dbInstance;
    if (!user || !dbInstance) throw new Error(`${name}: ctx.user and ctx.dbInstance required`);

    // Native storage ops — direct fs on the MCP storage box (storage-tools.js).
    // chunkText wires the browser_fetch large-result chunking into storage_read.
    if (storageTools.isStorageTool(name)) {
        return storageTools.execute(name, args, {
            chunkText: (buffer, contentType, prefix) => chunkLargeText(buffer, contentType, dbInstance, prefix)
        });
    }

    switch (name) {
        case 'browser_fetch':
            return executeBrowserFetch(args, dbInstance);

        case 'attachment_save':
            return executeAttachmentSave(args, {
                mcpOrigin,
                publicOrigin,
                readBucketBytes: async (b, i, e) => {
                    const file = await dbInstance.db.getFile(b, `${i}.${e}`);
                    return file ? file.buffer : null;
                }
            });

        case 'chat_preview_show':
            return executePreviewShow(args, { mcpOrigin });

        case 'chat_app_open':
            return openHostedApp(args, { mcpOrigin, conversationId });

        case 'chat_preview_state':
            return await executePreviewState(args, { dbInstance, conversationId });

        case 'chat_archive_update_metadata':
            return await executeUpdateMetadata(args, { db, conversationId, user });

        case 'chat_archive_search': {
            const data = await searchArchive(dbInstance, {
                query: args.query, mode: args.mode || 'all',
                role: args.role || 'all',
                limit: args.limit || 10,
                search_type: args.search_type || 'hybrid',
                date_from: args.date_from || null,
                date_to: args.date_to || null
            }, embedDeps || {});
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify(shapeSearchToolResult(data), null, 2)
                }]
            };
        }

        case 'chat_archive_get_session': {
            const data = await getSessionWithMessages(db, args.session_id);
            const offset = args.offset || 0;
            const limit = args.limit || 100;

            if (args.saveToStorage) {
                if (!mcpOrigin) throw new Error('chat_archive_get_session: no MCP server configured — cannot reach storage');
                const storagePayload = JSON.stringify({
                    session: pickSessionMeta(data.session),
                    messageCount: data.messages?.length,
                    messages: (data.messages || []).map(m => ({ role: m.role, model: m.model, turnIndex: m.turnIndex, speaker: m.speaker, content: m.content }))
                });
                const storagePath = `sessions/${args.session_id}.json`;
                const putRes = await fetch(`${mcpOrigin}/storage/${storagePath}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: storagePayload
                });
                if (!putRes.ok) {
                    const errText = await putRes.text().catch(() => '');
                    throw new Error(`Storage write failed (${putRes.status}): ${errText}`);
                }
                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({
                            ok: true,
                            url: `${mcpOrigin}/storage/${storagePath}`,
                            path: `/storage/${storagePath}`,
                            sessionId: args.session_id,
                            messageCount: data.messages?.length,
                            hint: 'url is absolute (use as forge.call payload). path is relative to your MCP origin (use with browser_fetch).'
                        })
                    }]
                };
            }

            const paged = data.messages?.slice(offset, offset + limit) || [];
            const text = JSON.stringify({
                session: { ...pickSessionMeta(data.session), messageCount: data.messages?.length },
                offset, limit,
                returned: paged.length,
                messages: paged.map(m => ({
                    role: m.role, model: m.model, turnIndex: m.turnIndex,
                    speaker: m.speaker,
                    content: m.content
                }))
            }, null, 2);
            // Bound the result: a full session can be 100s of KB — enough to
            // blow a small model's context window in ONE tool message (gateway
            // 400, run dead, 2026-08-25). Same auto-chunk pattern as
            // browser_fetch: bucket the payload, page it in 16 KB chunks.
            if (Buffer.byteLength(text, 'utf8') > CHUNK_THRESHOLD_BYTES) {
                return await chunkLargeText(Buffer.from(text, 'utf8'), 'application/json', dbInstance, 'archive_session');
            }
            return {
                content: [{
                    type: 'text',
                    text
                }]
            };
        }

        case 'chat_archive_list_chats': {
            const allDirect = (await db.findAll('_type', 'session'))
                .filter(s => Array.isArray(s.messages) ? s.userId === user.id : true)
                .filter(s => s.mode !== 'arena')
                .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
            return formatSessionList(allDirect, args, 'direct');
        }

        case 'chat_archive_list_arena': {
            const allArena = (await db.findAll('_type', 'session'))
                .filter(s => Array.isArray(s.messages) ? s.userId === user.id : true)
                .filter(s => s.mode === 'arena')
                .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
            return formatSessionList(allArena, args, 'arena');
        }

        case 'chat_archive_find_similar': {
            const srcData = await getSessionWithMessages(db, args.session_id);
            const srcTitle = srcData.session?.title || args.session_id;
            const srcMessages = srcData.messages || [];

            const assistantTexts = srcMessages
                .filter(m => m.role === 'assistant')
                .map(m => m.content || '')
                .join(' ');
            const queryText = assistantTexts.slice(0, 3000);

            const searchData = await searchArchive(dbInstance, { query: queryText, search_type: 'semantic', limit: (args.limit || 5) + 3 }, embedDeps || {});
            const similar = searchData.results
                .filter(r => r.session?.id !== args.session_id)
                .slice(0, args.limit || 5);

            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        source: {
                            id: args.session_id,
                            title: srcTitle,
                            models: srcData.session?.model || 'unknown',
                            messageCount: srcMessages.length
                        },
                        similar: similar.map(r => ({
                            score: r.score,
                            sessionId: r.session?.id,
                            sessionTitle: r.session?.title,
                            mode: r.session?.mode,
                            date: r.session?.createdAt || r.message?.createdAt,
                            content: r.message?.content?.slice(0, 300)
                        }))
                    }, null, 2)
                }]
            };
        }

        case 'chat_archive_find_references': {
            const data = await findReferences(db, args);
            return {
                content: [{ type: 'text', text: JSON.stringify(data, null, 2) }]
            };
        }

        case 'context_retire':
        case 'context_unretire': {
            const msgs = ctx.getStoredMessages ? await ctx.getStoredMessages() : null;
            if (!msgs) throw new Error(`${name}: conversation not loaded — nothing can be retired.`);
            const selector = parseSelector(args.messages, msgs.length - 1);
            if (selector.idxs.length === 0 && !selector.all) {
                const badNote = selector.bad.length > 0 ? ` Unrecognized: ${selector.bad.join(', ')}.` : '';
                throw new Error(`${name}: no valid message indexes in request. Message indexes are 0-based, from the [mN] markers in the transcript; valid range here is 0-${msgs.length - 1}. Call context_units() to list them.${badNote}`);
            }
            const retiring = name === 'context_retire';
            const distill = String(args.distill || '').trim();
            if (retiring && distill.length < 20) {
                throw new Error('context_retire: distill is too short to be useful working memory (<20 chars). Write the key facts, decisions, and open items your future self needs.');
            }
            const liveFrom = lastUserIdx(msgs);
            const retirements = { ...(ctx.getRetirements ? await ctx.getRetirements() : {}) };
            const applied = [];   // { msg, kinds: [...], bytes }
            const skipped = [];   // { msg, reason }
            if (selector.all) {
                // unretire-all only (retire requires explicit indexes).
                if (retiring) throw new Error('context_retire: "all" is not accepted for retiring — name the indexes or ranges explicitly.');
                const n = Object.keys(retirements).length;
                for (const k of Object.keys(retirements)) delete retirements[k];
                await ctx.setRetirements(retirements);
                return { content: [{ type: 'text', text: JSON.stringify({ ok: true, unretired: 'all', count: n, note: 'Full text restored from the next request onward.' }) }] };
            }
            for (const idx of selector.idxs) {
                const units = retireView.retirableUnits(msgs[idx], formatMessageTs);
                if (units.length === 0) { skipped.push({ msg: idx, reason: 'nothing retirable in this message' }); continue; }
                if (retiring && idx >= liveFrom) { skipped.push({ msg: idx, reason: 'current exchange — not retirable until the next turn' }); continue; }
                const kinds = [];
                let bytes = 0;
                let touched = false;
                for (const u of units) {
                    if (retiring) {
                        retirements[u.hash] = { distill, at: new Date().toISOString(), msgIdx: idx, kind: u.kind };
                        touched = true;
                    } else if (u.hash in retirements) {
                        delete retirements[u.hash];
                        touched = true;
                    }
                    kinds.push(u.kind);
                    bytes += u.bytes;
                }
                if (touched) applied.push({ msg: idx, kinds, bytes });
                else skipped.push({ msg: idx, reason: 'not retired' });
            }
            if (applied.length === 0) {
                throw new Error(`${name}: nothing to do — every named message was skipped. ${JSON.stringify(skipped.slice(0, 10))}. Valid range is 0-${msgs.length - 1}; context_units() lists everything.`);
            }
            await ctx.setRetirements(retirements);
            const payload = retiring
                ? { ok: true, retired: applied, skipped, note: 'Tombstones replace these messages from the next request onward. Originals remain in canonical history.' }
                : { ok: true, unretired: applied, skipped, note: 'Full text restored from the next request onward.' };
            if (selector.bad.length > 0) payload.invalid = selector.bad;
            return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
        }

        case 'context_units': {
            const msgs = ctx.getStoredMessages ? await ctx.getStoredMessages() : null;
            if (!msgs) throw new Error('context_units: conversation not loaded.');
            const retirements = ctx.getRetirements ? await ctx.getRetirements() : {};
            const retiredHashes = new Set(Object.keys(retirements));
            const liveFrom = lastUserIdx(msgs);
            const lines = [];
            let retirableBytes = 0, retiredBytes = 0;
            for (let i = 0; i < msgs.length; i++) {
                const units = retireView.retirableUnits(msgs[i], formatMessageTs);
                if (units.length === 0) continue;
                const parts = [];
                for (const u of units) {
                    const isRet = retiredHashes.has(u.hash);
                    retirableBytes += u.bytes;
                    if (isRet) retiredBytes += u.bytes;
                    parts.push(`${u.kind} ${(u.bytes / 1024).toFixed(1)}K${isRet ? ' [RETIRED]' : ''}`);
                }
                const tag = i >= liveFrom ? ' (current exchange — not retirable yet)' : '';
                lines.push(`m${i}: ${parts.join(' | ')}${tag}`);
            }
            return {
                content: [{
                    type: 'text',
                    text: `context_units: ${msgs.length} messages, ${lines.length} with retirable content, ${(retirableBytes / 1024).toFixed(1)}K total, ${(retiredBytes / 1024).toFixed(1)}K already retired. Indexes are the N in each [mN] transcript marker (0-based).\n` + lines.join('\n')
                }]
            };
        }

        default:
            throw new Error(`Unknown internal tool: ${name}`);
    }
}

// ============================================
// browser_fetch — Node fetch port. Every call is logged (SSRF visibility:
// the backend can reach LAN/localhost the browser never could).
// ============================================

const MIME_TO_EXT = {
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg',
    'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg',
    'image/bmp': 'bmp', 'application/pdf': 'pdf',
    'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/ogg': 'ogg',
    'video/mp4': 'mp4', 'video/webm': 'webm',
    'application/zip': 'zip', 'application/octet-stream': 'bin'
};

// Chunking for large text responses: inlining a 400KB file bloats the model's
// context and stalls generation. Store the full text, return a summary + chunk
// count; the model reads chunks incrementally (browser_fetch bucket_file + chunk)
// and retires consumed chunks with context_retire.
const CHUNK_THRESHOLD_BYTES = 32 * 1024;
const CHUNK_BYTES = 16 * 1024;

// "images:43ba3326.txt" → { bucket, id, ext }.
function parseFileRef(_file) {
    if (!_file || typeof _file !== 'string') return null;
    const idx = _file.indexOf(':');
    if (idx === -1) return null;
    const bucket = _file.slice(0, idx);
    const rest = _file.slice(idx + 1);
    const dot = rest.lastIndexOf('.');
    if (dot === -1) return { bucket, id: rest, ext: '' };
    return { bucket, id: rest.slice(0, dot), ext: rest.slice(dot + 1) };
}

function splitChunks(text, chunkBytes) {
    const chunks = [];
    for (let i = 0; i < text.length; i += chunkBytes) chunks.push(text.slice(i, i + chunkBytes));
    return chunks;
}

async function chunkLargeText(buffer, contentType, dbInstance, prefix = 'browser_fetch') {
    const text = buffer.toString('utf8');
    const chunkCount = Math.max(1, Math.ceil(text.length / CHUNK_BYTES));
    const filename = `${prefix}_${Date.now()}.txt`;
    const meta = await dbInstance.db.storeFile('images', buffer, filename);
    const bucketFile = meta.ref;
    return {
        content: [{
            type: 'text',
            text: JSON.stringify({
                chunked: true,
                bucketFile,
                chunks: chunkCount,
                chunkBytes: CHUNK_BYTES,
                totalBytes: buffer.length,
                preview: text.slice(0, 400),
                note: `Large text response (${buffer.length} bytes) chunked to avoid context bloat. Read a chunk with browser_fetch(bucket_file="${bucketFile}", chunk=N) (0-indexed). Retire consumed chunks with context_retire.`
            }, null, 2)
        }]
    };
}

async function readBucketChunk(bucketFile, chunk, dbInstance) {
    const ref = parseFileRef(bucketFile);
    if (!ref) throw new Error(`browser_fetch: invalid bucket_file "${bucketFile}" (expected bucket:id.ext)`);
    const file = await dbInstance.db.getFile(ref.bucket, `${ref.id}.${ref.ext}`);
    if (!file || file.buffer.length === 0) throw new Error(`browser_fetch: bucket file not found: ${bucketFile}`);
    const chunks = splitChunks(file.buffer.toString('utf8'), CHUNK_BYTES);
    if (!Number.isInteger(chunk) || chunk < 0 || chunk >= chunks.length) {
        throw new Error(`browser_fetch: chunk ${chunk} out of range (0..${chunks.length - 1})`);
    }
    return { content: [{ type: 'text', text: JSON.stringify({ chunk, chunkCount: chunks.length, content: chunks[chunk] }, null, 2) }] };
}

async function executeBrowserFetch(args, dbInstance) {
    if (!args || typeof args !== 'object') throw new Error('browser_fetch: args object required');

    // Chunk read mode: browser_fetch(bucket_file, chunk) reads one chunk of a
    // previously chunked large response (see chunkLargeText).
    if (typeof args.bucket_file === 'string' && typeof args.chunk === 'number') {
        return await readBucketChunk(args.bucket_file, args.chunk, dbInstance);
    }

    if (typeof args.url !== 'string' || args.url.length === 0) throw new Error('browser_fetch: url required');
    if (args.method !== undefined && !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(args.method)) {
        throw new Error(`browser_fetch: invalid method "${args.method}"`);
    }
    if (args.headers !== undefined && (typeof args.headers !== 'object' || Array.isArray(args.headers))) {
        throw new Error('browser_fetch: headers must be an object');
    }
    if (args.body !== undefined && typeof args.body !== 'string') {
        throw new Error('browser_fetch: body must be a string');
    }
    if (args.body_type !== undefined && !['text', 'data_url'].includes(args.body_type)) {
        throw new Error(`browser_fetch: invalid body_type "${args.body_type}" — must be "text" or "data_url"`);
    }
    const maxInlineBytes = args.max_inline_bytes === 0 ? 0 : (args.max_inline_bytes ?? 5 * 1024 * 1024);
    if (typeof maxInlineBytes !== 'number' || maxInlineBytes < 0) {
        throw new Error('browser_fetch: max_inline_bytes must be a non-negative number');
    }

    let parsedUrl;
    try {
        parsedUrl = new URL(args.url);
    } catch (err) {
        throw new Error(`browser_fetch: invalid URL — ${err.message}`);
    }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        throw new Error(`browser_fetch: protocol must be http or https (got ${parsedUrl.protocol})`);
    }
    const fullUrl = parsedUrl.href;

    const bodyType = args.body_type || 'text';
    let fetchBody = args.body;
    let fetchHeaders = args.headers ? { ...args.headers } : undefined;

    if (bodyType === 'data_url' && args.body !== undefined) {
        const commaIdx = args.body.indexOf(',');
        if (commaIdx === -1) throw new Error('browser_fetch: data_url body must be a valid data URL (data:mime;base64,...)');
        const meta = args.body.substring(5, commaIdx);
        const isBase64 = meta.includes(';base64');
        const mimeType = meta.split(';')[0] || 'application/octet-stream';
        const dataPart = args.body.substring(commaIdx + 1);
        if (!isBase64) throw new Error('browser_fetch: data_url body must be base64-encoded (data:mime;base64,...)');
        fetchBody = Buffer.from(dataPart, 'base64');
        if (!fetchHeaders || !Object.keys(fetchHeaders).some(h => h.toLowerCase() === 'content-type')) {
            fetchHeaders = fetchHeaders || {};
            fetchHeaders['Content-Type'] = mimeType;
        }
    }

    const fetchOpts = {
        method: args.method || 'GET',
        headers: fetchHeaders,
        body: fetchBody,
        redirect: 'follow'
    };
    if ((fetchOpts.method === 'GET' || fetchOpts.method === 'HEAD') && fetchOpts.body !== undefined) {
        fetchOpts.body = undefined;
    }

    // SSRF visibility: the backend can reach hosts the browser never could.
    // Every outbound call is logged — url, method, body bytes.
    LOG.info('browser_fetch', { url: fullUrl, method: fetchOpts.method, bodyBytes: fetchBody ? Buffer.byteLength(fetchBody) : 0 }, 'InternalTools');

    let res;
    try {
        res = await fetch(fullUrl, fetchOpts);
    } catch (fetchErr) {
        throw new Error(`browser_fetch: network request failed (${fetchErr.name || 'NetworkError'}). URL: ${fullUrl}. Detail: ${fetchErr.message}`);
    }

    const contentType = res.headers.get('content-type') || '';
    const isText = contentType.startsWith('text/') || contentType.includes('json') || contentType.startsWith('application/xml') || contentType === '';

    const buffer = Buffer.from(await res.arrayBuffer());

    // Large text (within the inline budget) → chunk it instead of inlining, to
    // avoid bloating the model's context. max_inline_bytes is the escape hatch.
    if (isText && maxInlineBytes !== 0 && buffer.length > CHUNK_THRESHOLD_BYTES && buffer.length <= maxInlineBytes) {
        return await chunkLargeText(buffer, contentType, dbInstance);
    }

    const tooLargeForInline = maxInlineBytes > 0 && buffer.length > maxInlineBytes;
    if (!isText || maxInlineBytes === 0 || tooLargeForInline) {
        const mime = contentType || 'application/octet-stream';
        const filename = `browser_fetch_${Date.now()}.${MIME_TO_EXT[mime] || 'bin'}`;
        const meta = await dbInstance.db.storeFile('images', buffer, filename);
        const url = `/api/buckets/images/${meta.hash}.${meta.ext}`;
        const summary = JSON.stringify({
            ok: res.ok,
            status: res.status,
            statusText: res.statusText,
            url,
            mimeType: mime,
            bytes: buffer.length,
            note: maxInlineBytes === 0 ? 'Response uploaded to chat bucket (max_inline_bytes=0).' : 'Response too large for inline return; uploaded to chat bucket.'
        }, null, 2);
        return {
            content: [
                { type: 'image', url, mimeType: mime },
                { type: 'text', text: summary }
            ]
        };
    }

    const payload = {
        ok: res.ok,
        status: res.status,
        statusText: res.statusText,
        contentType,
        bytes: buffer.length,
        url: fullUrl,
        truncated: false,
        body: buffer.toString('utf8')
    };
    return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }]
    };
}

// ============================================
// attachment_save — server-to-server copy: bucket URL → MCP storage PUT.
// ============================================

// Bucket URL (/api/buckets/<bucket>/<id>.<ext>) → { bucket, id, ext }.
function parseBucketUrl(url) {
    if (!url || typeof url !== 'string') return null;
    const m = url.match(/\/api\/buckets\/([^/]+)\/([^/.]+)\.([^/?]+)/);
    if (!m) return null;
    return { bucket: m[1], id: m[2], ext: m[3].toLowerCase() };
}

const BUCKET_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };

async function executeAttachmentSave(args, { mcpOrigin, publicOrigin, readBucketBytes }) {
    if (!args || typeof args !== 'object') throw new Error('attachment_save: args object required');
    if (typeof args.url !== 'string' || args.url.length === 0) throw new Error('attachment_save: url required');
    if (typeof args.storage_path !== 'string' || args.storage_path.length === 0) throw new Error('attachment_save: storage_path required');
    if (!mcpOrigin) throw new Error('attachment_save: no MCP server configured — cannot determine storage endpoint');

    LOG.info('attachment_save', { src: args.url, storage_path: args.storage_path }, 'InternalTools');

    // Bucket-backed source: read INTERNALLY via db.getFile — the bucket GET
    // route requires cookie auth (issue #5), so HTTP-fetching a bucket URL 401s.
    // External http(s) URLs still go over HTTP.
    let buffer, mime;
    const bucketRef = parseBucketUrl(args.url);
    if (bucketRef && typeof readBucketBytes === 'function') {
        try {
            buffer = await readBucketBytes(bucketRef.bucket, bucketRef.id, bucketRef.ext);
            if (!buffer || buffer.length === 0) throw new Error('empty bucket file');
            mime = BUCKET_MIME[bucketRef.ext] || 'application/octet-stream';
        } catch (err) {
            throw new Error(`attachment_save: failed to read bucket file — ${err.message}`);
        }
    } else {
        let srcUrl = args.url;
        if (srcUrl.startsWith('/')) {
            if (!publicOrigin) throw new Error('attachment_save: relative url but no public origin configured');
            srcUrl = `${publicOrigin}${srcUrl}`;
        }
        try {
            const res = await fetch(srcUrl);
            if (!res.ok) throw new Error(`source fetch returned ${res.status} ${res.statusText}`);
            buffer = Buffer.from(await res.arrayBuffer());
            mime = res.headers.get('content-type') || 'application/octet-stream';
        } catch (err) {
            throw new Error(`attachment_save: failed to fetch source URL — ${err.message}`);
        }
    }
    if (!buffer || buffer.length === 0) throw new Error('attachment_save: source URL returned empty response');

    const destUrl = `${mcpOrigin}/storage/${args.storage_path.replace(/^\/+/, '')}`;
    let putRes;
    try {
        putRes = await fetch(destUrl, {
            method: 'PUT',
            headers: { 'Content-Type': mime },
            body: buffer
        });
    } catch (err) {
        throw new Error(`attachment_save: PUT to MCP storage failed — ${err.message}`);
    }
    if (!putRes.ok) {
        const errBody = await putRes.text().catch(() => '');
        throw new Error(`attachment_save: MCP storage returned ${putRes.status} ${putRes.statusText} — ${errBody}`);
    }

    const result = await putRes.json().catch(() => ({}));
    const summary = JSON.stringify({
        ok: true,
        source_url: args.url,
        storage_path: '/' + args.storage_path.replace(/^\/+/, ''),
        bytes: result.size ?? buffer.length,
        content_type: result.content_type || mime
    }, null, 2);
    return {
        content: [{ type: 'text', text: summary }]
    };
}

// ============================================
// chat_archive_update_metadata — CURATED guard + object-schema validation
// (issues #6 and #8), writing directly to the session doc.
// ============================================

function executeUpdateMetadata(args, { db, conversationId, user }) {
    return (async () => {
        if (!args.session_id) throw new Error('chat_archive_update_metadata: session_id required');
        const docs = await db.findAll('id', args.session_id);
        const session = docs.find(s => s._type === 'session');
        if (!session) throw new Error(`chat_archive_update_metadata: session ${args.session_id} not found`);

        // Overwrite guard (issue #8): a CURATED summary is a load-bearing arena
        // curation artifact — refuse to overwrite unless force:true.
        if (args.force !== true) {
            const existingSummary = session.summary ?? null;
            const existingSummaryStr = typeof existingSummary === 'string' ? existingSummary : JSON.stringify(existingSummary || {});
            if (existingSummaryStr.includes('CURATED')) {
                throw new Error(
                    `chat_archive_update_metadata: session ${args.session_id} has a CURATED summary — refusing to overwrite without explicit intent. ` +
                    `If you truly want to replace it, pass force: true. (Hint: if you meant to update the CURRENT session, its ID is ` +
                    `${conversationId || '(unknown)'} — use that instead of guessing.)`
                );
            }
        }

        // Summary must be stored as an OBJECT (issue #6).
        let summaryObj = {};
        const rawSummary = args.summary;
        if (rawSummary !== undefined && rawSummary !== null) {
            if (typeof rawSummary === 'object' && !Array.isArray(rawSummary)) {
                summaryObj = { ...rawSummary };
            } else if (typeof rawSummary === 'string') {
                const trimmed = rawSummary.trim();
                if (trimmed.startsWith('{')) {
                    try {
                        summaryObj = JSON.parse(trimmed);
                    } catch (e) {
                        throw new Error(`chat_archive_update_metadata: summary string is not valid JSON: ${e.message}`);
                    }
                } else {
                    throw new Error('chat_archive_update_metadata: summary must be an object {title, teaser, reflection} or a JSON object string — a plain string is rejected. Pass teaser/reflection as separate params instead.');
                }
            } else {
                throw new Error(`chat_archive_update_metadata: summary must be an object or JSON string, got ${typeof rawSummary}`);
            }
            if (typeof summaryObj !== 'object' || Array.isArray(summaryObj)) {
                throw new Error('chat_archive_update_metadata: summary JSON did not parse to an object {title, teaser, reflection}');
            }
        }

        if (args.title !== undefined && args.title !== null) summaryObj.title = args.title;
        if (args.teaser !== undefined && args.teaser !== null) summaryObj.teaser = args.teaser;
        if (args.reflection !== undefined && args.reflection !== null) summaryObj.reflection = args.reflection;

        const updatedFields = [];
        const effectiveTitle = args.title || summaryObj.title || '';
        if (effectiveTitle) { session.title = effectiveTitle; updatedFields.push('title'); }
        if (args.category) { session.category = args.category; updatedFields.push('category'); }
        if (Object.keys(summaryObj).length > 0) { session.summary = summaryObj; updatedFields.push('summary'); }

        if (updatedFields.length === 0) throw new Error('chat_archive_update_metadata: nothing to update — pass title, category, summary, teaser, or reflection.');

        session.updatedAt = new Date().toISOString();
        await db.update(session._id, session);

        // Issue #33: the mutation is invisible to attached views without this —
        // sidebars/headers only refresh on the list event (or a manual reload).
        if (EMIT_LIST_EVENT && user?.id) EMIT_LIST_EVENT(user.id, 'chat.updated', session);

        return {
            type: 'text',
            text: JSON.stringify({ success: true, updatedFields, storedSummary: session.summary ?? null })
        };
    })();
}

// ============================================
// helpers
// ============================================

async function getSessionWithMessages(db, sessionId) {
    const docs = await db.findAll('id', sessionId);
    const session = docs.find(s => s._type === 'session');
    if (!session) throw new Error(`Session ${sessionId} not found`);

    const convs = docs.filter(d => d._type === 'conversation');
    if (convs.length > 0) {
        const conv = convs[0];
        const msgs = JSON.parse(JSON.stringify(conv.messages || []));
        return { session, messages: msgs };
    }
    const messages = (await db.findAll('sessionId', sessionId))
        .filter(m => m._type === 'message')
        .sort((a, b) => a.turnIndex - b.turnIndex);
    return { session, messages };
}

function pickSessionMeta(session) {
    return {
        id: session?.id,
        title: session?.title,
        mode: session?.mode,
        model: session?.model,
        category: session?.category,
        summary: session?.summary,
        arenaConfig: session?.arenaConfig
    };
}

function formatSessionList(all, args, kind) {
    let results = all;
    if (args.date_from) results = results.filter(a => a.createdAt >= args.date_from);
    if (args.date_to) results = results.filter(a => a.createdAt <= args.date_to);
    const limit = args.limit || 20;
    const offset = args.offset || 0;
    const dateRange = results.length === 0 && all.length > 0 ? {
        available_oldest: all.reduce((min, s) => s.createdAt < min ? s.createdAt : min, all[0].createdAt),
        available_newest: all.reduce((max, s) => s.createdAt > max ? s.createdAt : max, all[0].createdAt),
        total_in_archive: all.length
    } : undefined;
    return {
        content: [{
            type: 'text',
            text: JSON.stringify({
                total: results.length,
                total_before_date_filter: all.length,
                offset,
                limit,
                ...(dateRange ? { hint: 'No sessions match the date filter. Here is the actual date range of available sessions.', ...dateRange } : {}),
                results: results.slice(offset, offset + limit).map(a => ({
                    id: a.id, title: a.title,
                    ...(kind === 'arena'
                        ? { models: a.arenaConfig ? `${a.arenaConfig.modelA} vs ${a.arenaConfig.modelB}` : 'unknown' }
                        : { model: a.model || 'unknown' }),
                    messages: a.messageCount,
                    created: a.createdAt,
                    category: a.category,
                    summary: a.summary
                }))
            }, null, 2)
        }]
    };
}

// chat_preview_show is the one tool whose EFFECT is client-side: the preview
// pane is a view surface (architecture §4 "preview becomes pure view"), so the
// runner can't render to it. Validate the args and return a confirmation; the
// view already renders a "Show in preview" button (chat.js _decoratePreviewToolButton)
// that calls preview.show(args) using the args from tool.start. URL mode also
// preflights the upstream declaration here so the MODEL gets a binary-type error;
// the proxy independently validates bytes for mislabeled responses (#57).
async function executePreviewShow(args, { mcpOrigin }) {
    if (!args || typeof args !== 'object') throw new Error('chat_preview_show: args object required');
    const hasContent = args.content !== undefined && args.content !== null;
    const hasUrl = typeof args.url === 'string' && args.url.length > 0;
    if (hasContent && hasUrl) throw new Error('chat_preview_show: pass content OR url, not both');
    if (!hasContent && !hasUrl) throw new Error('chat_preview_show: one of content or url required');
    if (hasUrl) await preflightPreviewUrl(args.url, mcpOrigin);
    const label = args.title || args.id || 'item';
    const mode = hasUrl ? `URL ${args.url}` : `${(args.content || '').length} chars`;
    return { content: [{ type: 'text', text: `Preview queued (${mode}). Click "Show in preview" on this tool bubble to render "${label}".` }] };
}

// chat_preview_state: reconstruct the preview items shown so far from the
// conversation's chat_preview_show tool calls (metadata only). Live view state
// (selected item, pane open/closed) is client-side and not queryable.
async function executePreviewState(args, { dbInstance, conversationId }) {
    let items = [];
    try {
        const docs = await dbInstance.db.findAll('id', conversationId);
        const conv = docs.find(d => d._type === 'conversation');
        if (conv && Array.isArray(conv.messages)) {
            items = conv.messages
                .filter(m => m.role === 'tool' && m.toolName === 'chat_preview_show' && m.toolArgs)
                .map(m => {
                    let a = m.toolArgs;
                    if (typeof a === 'string') { try { a = JSON.parse(a); } catch { a = null; } }
                    if (!a) return null;
                    return { id: a.id || null, title: a.title || null, language: a.language || null, source: a.source || null, mode: a.url ? 'url' : 'content' };
                })
                .filter(Boolean);
        }
    } catch (e) { /* best-effort */ }
    return { content: [{ type: 'text', text: JSON.stringify({
        previewItemsShown: items,
        note: 'Live view state (currently selected item, pane open/closed) is client-side and not queryable by the backend.'
    }, null, 2) }] };
}

module.exports = {
    init,
    searchArchive,
    shapeSearchToolResult,
    isSearchEligible,
    findReferences,
    getToolDefs,
    isInternalTool,
    filterVisionTools,
    executeInternalTool,
    ARCHIVE_TOOL_DEFS,
    RETIREMENT_TOOL_DEFS
};
