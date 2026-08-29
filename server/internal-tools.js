// ============================================
// internal-tools.js — PB-b: server-side internal tool port.
// The chat_archive_* / browser_fetch / attachment_save / context_retire tools
// that used to execute in the browser (chat.js executeLocalTool) now execute
// here over dbInstance — no HTTP hop to our own API, no browser required.
// Tool names and result shapes are kept identical so model behavior carries over.
// Single source of truth: /api/search and /api/references routes call the
// searchArchive/findReferences functions below (extracted 2026-08-24).
// ============================================

let LOG = { info() {}, warn() {}, error() {}, debug() {} };
// log may be a logger instance OR a factory (() => logger), matching how
// server.js passes L to mcpPool/runner.
function init({ log }) {
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
// Archive search — extracted from the /api/search route (byte-faithful port).
// deps = { embedBatch, embedAvailable }
// ============================================

async function searchArchive(dbInstance, body, deps = {}) {
    const { db, embeddingsCol } = dbInstance;
    const { embedBatch, embedAvailable } = deps;

    const query = (body.query || '').trim();
    const limit = body.limit || 10;
    const filterMode = body.mode || body.filter?.mode;
    const filterRole = body.role || body.filter?.role;
    const searchType = body.search_type || 'semantic';
    const dateFrom = body.date_from || null;
    const dateTo = body.date_to || null;

    LOG.info('Search request', { query: query.slice(0, 50), role: filterRole, type: searchType, mode: filterMode }, 'Search');

    if (!query) return { results: [], query, search_type: searchType, method: 'text' };

    const convs = db.find('_type', 'conversation');
    const userSessions = db.find('_type', 'session');
    const convById = new Map();
    const msgIndex = []; // flat list of { chatId, idx, msg, session }

    for (const c of convs) {
        convById.set(c.id, c);
        const session = userSessions.find(s => s.id === c.id);
        if (!c.messages) continue;
        for (const msg of c.messages) {
            if (dateFrom || dateTo) {
                const d = new Date(msg.createdAt);
                if (dateFrom && d < new Date(dateFrom)) continue;
                if (dateTo && d > new Date(dateTo)) continue;
            }
            if (filterMode && filterMode !== 'all' && session?.mode && session.mode !== filterMode) continue;
            if (filterRole && filterRole !== 'all' && msg.role !== filterRole) continue;
            msgIndex.push({ chatId: c.id, idx: msg.idx, msg, session });
        }
    }

    const results = [];
    const seen = new Set();

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

                let entry;
                if (chatId && msgIdx >= 0) {
                    entry = msgIndex.find(e => e.chatId === chatId && e.idx === msgIdx);
                    if (!entry) continue;
                } else {
                    entry = msgIndex.find(e => e.msg.id === msgId);
                    if (!entry) continue;
                }

                LOG.info('Search vector hit', { chatId: chatId?.slice(-20), msgIdx, score: hit.score.toFixed(3), role: entry.msg.role }, 'Search');

                results.push({
                    score: hit.score,
                    message: { id: entry.msg.id, idx: entry.idx, role: entry.msg.role, model: entry.msg.model, content: entry.msg.content.slice(0, 300), createdAt: entry.msg.createdAt },
                    session: entry.session ? { id: entry.session.id, title: entry.session.title, mode: entry.session.mode, createdAt: entry.session.createdAt } : null
                });
            }
        } catch (err) {
            LOG.error('Semantic search failed', err, {}, 'Search');
        }
    }

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

    LOG.info('Search', { query: query.slice(0, 80), results: results.length, type: searchType }, 'Search');
    return {
        results,
        query,
        search_type: searchType,
        method: searchType === 'keyword' ? 'text' : searchType === 'hybrid' ? (results.some(r => r.score > 0) ? 'hybrid' : 'text') : (results.some(r => r.score > 0) ? 'semantic' : 'text-fallback')
    };
}

// ============================================
// Reference tracing — extracted from the /api/references route (byte-faithful port).
// ============================================

function findReferences(db, body) {
    const sid = (body.session_id || '').trim();
    const dir = body.direction || 'both';
    if (!sid) throw new Error('Missing session_id');

    const arenaSessions = db.find('_type', 'session')
        .filter(s => s.mode === 'arena' || s.mode === 'direct');

    const refPattern = /arena-\d+[-\w]*/g;

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
            description: `${SERVER_EXEC_NOTE}\\n\\nDirect HTTP fetch from the chat backend — no MCP JSON-RPC size limits, no CORS. Use this to download a file or resource from ANY URL when the response may be too large for MCP (typically capped around 64 KB). Works for storage files, LAN addresses, and public internet URLs alike.\\n\\n**Binary upload**: use body_type="data_url" with a data URL body to send binary data to HTTP endpoints (e.g. PUT /storage/* on the MCP server). NOTE: to save a chat attachment to workshop storage, use attachment_save instead — it handles the transfer in one call.\\n\\n**Response handling**: small text (≤ 32 KB) is returned inline. Text larger than 32 KB is auto-CHUNKED (bucketFile + chunk count; read chunks via bucket_file/chunk, retire consumed chunks with context_retire). Binary types (images, PDFs, audio, etc.) are uploaded to the chat's bucket and a \\/api\\/buckets\\/images\\/... URL is returned instead.\\n\\n**When to use**: whenever you already have a direct URL and expect the payload to exceed MCP limits, or when storage_read returns a relative path pointer (prepend your MCP origin and fetch it).`,
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
                    role: { type: 'string', enum: ['user', 'assistant', 'tool', 'all'], description: 'Filter by message role (default: all). Use "user" to exclude tool output noise.' },
                    search_type: { type: 'string', enum: ['semantic', 'keyword', 'hybrid'], description: 'Search method (default: semantic)' },
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
            description: `${SERVER_EXEC_NOTE}\\n\\nRetrieve a specific conversation session by ID. Results over 32 KB are auto-CHUNKED like browser_fetch (returns bucketFile + chunk count; page with browser_fetch bucket_file/chunk and retire consumed chunks with context_retire) — a full session can be far larger than your context window, so never try to inline it whole.\\n\\nTo process session data with a forge tool: (1) call this tool to get session data, (2) call storage.write to persist it, (3) pass the storage URL as forge.call payload.\\n\\nWhen saveToStorage is true, this tool writes the full session JSON directly to workshop storage and returns ONLY the URL — use this when you need to pass large session data to a forge tool that would overflow the context window.`,
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
            description: `${SERVER_EXEC_NOTE}\n\nQueue content or a file/URL for rendering in the chat's preview pane (a second rendering surface). Pass EXACTLY ONE of content (text to render, markdown or code) or url (a /storage/... path or absolute http(s) URL to fetch). The preview renders CLIENT-side: this tool returns a confirmation and the user clicks "Show in preview" on the tool bubble to render it. Use content mode for generated work product (edits, diffs, code); url mode for existing files.`,
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
            description: `${SERVER_EXEC_NOTE}\\n\\nRetire chunks you have fully consumed. Their full text leaves your context on the next request; your distillation stays in their place as a tombstone.\\n\\nWrite distillations as your future working memory: key facts, figures, decisions, open items, and anything you would need to decide whether restoring the original is worth it. A vague distillation ("discusses infrastructure") is a failed retirement — if you cannot distill it specifically, you have not consumed it; do not retire it.\\n\\nRetire in BATCHES, not one chunk per turn: each retirement rewrites mid-history content and invalidates the provider's prompt cache from that point. Note chunks as consumed during the turn, then retire them together.\\n\\nThe original always stays intact in canonical history — context_unretire(chunk_ids) restores full text on the next request.`,
            parameters: {
                type: 'object',
                properties: {
                    chunk_ids: { type: 'array', items: { type: 'string' }, description: 'Chunk labels to retire, e.g. ["chunk_2x4f8k1a9z3q", "chunk_7hm2p9w1x4vb"]. Batch multiple ids in one call.' },
                    distill: { type: 'string', description: 'Your distillation of what to keep from these chunks: key facts, decisions, open items — written for your future self.' }
                },
                required: ['chunk_ids', 'distill']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'context_unretire',
            description: `${SERVER_EXEC_NOTE}\\n\\nRestore previously retired chunks — their full text returns to your context on the next request. Use when a tombstone's distillation is insufficient for the current task.`,
            parameters: {
                type: 'object',
                properties: {
                    chunk_ids: { type: 'array', items: { type: 'string' }, description: 'Chunk labels to restore, e.g. ["chunk_2x4f8k1a9z3q"].' }
                },
                required: ['chunk_ids']
            }
        }
    }
];

const INTERNAL_TOOL_NAMES = new Set([...ARCHIVE_TOOL_DEFS, ...RETIREMENT_TOOL_DEFS].map(t => t.function.name));

function getToolDefs({ chunkTransform = false } = {}) {
    return chunkTransform ? [...ARCHIVE_TOOL_DEFS, ...RETIREMENT_TOOL_DEFS] : [...ARCHIVE_TOOL_DEFS];
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
//   chunkTable,                // Map<label, hash> from the last assembly (retirement)
//   getRetirements,            // () => session.retirements (fresh read)
//   setRetirements,            // async (map) => persists to the session doc
//   embedDeps: { embedBatch, embedAvailable }
// }
// Returns MCP-style { content: [{type:'text'|'image', ...}] }.
// ============================================

async function executeInternalTool(name, args, ctx) {
    const { user, dbInstance, conversationId, mcpOrigin, publicOrigin, chunkTable, embedDeps } = ctx;
    const { db } = dbInstance;
    if (!user || !dbInstance) throw new Error(`${name}: ctx.user and ctx.dbInstance required`);

    switch (name) {
        case 'browser_fetch':
            return executeBrowserFetch(args, dbInstance);

        case 'attachment_save':
            return executeAttachmentSave(args, { mcpOrigin, publicOrigin, readBucketBytes: (b, i, e) => dbInstance.db.getFile(b, i, e) });

        case 'chat_preview_show':
            return executePreviewShow(args);

        case 'chat_preview_state':
            return executePreviewState(args, { dbInstance, conversationId });

        case 'chat_archive_update_metadata':
            return executeUpdateMetadata(args, { db, conversationId });

        case 'chat_archive_search': {
            const data = await searchArchive(dbInstance, {
                query: args.query, mode: args.mode || 'all',
                role: args.role || 'all',
                limit: args.limit || 10,
                search_type: args.search_type || 'semantic',
                date_from: args.date_from || null,
                date_to: args.date_to || null
            }, embedDeps || {});
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        query: data.query,
                        method: data.method,
                        results: data.results.map(r => ({
                            score: r.score,
                            sessionId: r.session?.id,
                            sessionTitle: r.session?.title,
                            mode: r.session?.mode,
                            role: r.message?.role,
                            model: r.message?.model,
                            date: r.session?.createdAt || r.message?.createdAt,
                            content: r.message?.content?.slice(0, 500)
                        }))
                    }, null, 2)
                }]
            };
        }

        case 'chat_archive_get_session': {
            const data = getSessionWithMessages(db, args.session_id);
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
                return chunkLargeText(Buffer.from(text, 'utf8'), 'application/json', dbInstance, 'archive_session');
            }
            return {
                content: [{
                    type: 'text',
                    text
                }]
            };
        }

        case 'chat_archive_list_chats': {
            const allDirect = db.find('_type', 'session')
                .filter(s => Array.isArray(s.messages) ? s.userId === user.id : true)
                .filter(s => s.mode !== 'arena')
                .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
            return formatSessionList(allDirect, args, 'direct');
        }

        case 'chat_archive_list_arena': {
            const allArena = db.find('_type', 'session')
                .filter(s => Array.isArray(s.messages) ? s.userId === user.id : true)
                .filter(s => s.mode === 'arena')
                .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
            return formatSessionList(allArena, args, 'arena');
        }

        case 'chat_archive_find_similar': {
            const srcData = getSessionWithMessages(db, args.session_id);
            const srcTitle = srcData.session?.title || args.session_id;
            const srcMessages = srcData.messages || [];

            const assistantTexts = srcMessages
                .filter(m => m.role === 'assistant')
                .map(m => m.content || '')
                .join(' ');
            const queryText = assistantTexts.slice(0, 3000);

            const searchData = await searchArchive(dbInstance, { query: queryText, limit: (args.limit || 5) + 1 }, embedDeps || {});
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
            const data = findReferences(db, args);
            return {
                content: [{ type: 'text', text: JSON.stringify(data, null, 2) }]
            };
        }

        case 'context_retire':
        case 'context_unretire': {
            if (!chunkTable || chunkTable.size === 0) {
                throw new Error(`${name}: no chunks exist in this conversation yet — nothing can be retired.`);
            }
            const ids = Array.isArray(args.chunk_ids) ? args.chunk_ids : [];
            if (ids.length === 0) throw new Error(`${name}: chunk_ids must be a non-empty array.`);
            const unknown = ids.filter(id => !chunkTable.has(id));
            if (unknown.length > 0) {
                throw new Error(`${name}: unknown chunk id(s): ${unknown.join(', ')}. Valid ids in the current view: ${[...chunkTable.keys()].join(', ')}`);
            }
            const retiring = name === 'context_retire';
            const distill = String(args.distill || '').trim();
            if (retiring && distill.length < 20) {
                throw new Error('context_retire: distill is too short to be useful working memory (<20 chars). Write the key facts, decisions, and open items your future self needs.');
            }
            const retirements = { ...(ctx.getRetirements ? ctx.getRetirements() : {}) };
            for (const id of ids) {
                const hash = chunkTable.get(id);
                if (retiring) retirements[hash] = { distill, at: new Date().toISOString(), label: id };
                else delete retirements[hash];
            }
            await ctx.setRetirements(retirements);
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify(retiring
                        ? { ok: true, retired: ids, distill, note: 'Tombstones replace these chunks from the next request onward. Originals remain in canonical history.' }
                        : { ok: true, unretired: ids, note: 'Full text restored from the next request onward.' })
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

function chunkLargeText(buffer, contentType, dbInstance, prefix = 'browser_fetch') {
    const text = buffer.toString('utf8');
    const chunkCount = Math.max(1, Math.ceil(text.length / CHUNK_BYTES));
    const filename = `${prefix}_${Date.now()}.txt`;
    const meta = dbInstance.db.storeFile('images', filename, buffer, contentType || 'text/plain');
    const bucketFile = `images:${meta._file.id}.${meta._file.ext}`;
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

function readBucketChunk(bucketFile, chunk, dbInstance) {
    const ref = parseFileRef(bucketFile);
    if (!ref) throw new Error(`browser_fetch: invalid bucket_file "${bucketFile}" (expected bucket:id.ext)`);
    const buffer = dbInstance.db.getFile(ref.bucket, ref.id, ref.ext);
    if (!buffer || buffer.length === 0) throw new Error(`browser_fetch: bucket file not found: ${bucketFile}`);
    const chunks = splitChunks(buffer.toString('utf8'), CHUNK_BYTES);
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
        return readBucketChunk(args.bucket_file, args.chunk, dbInstance);
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
        return chunkLargeText(buffer, contentType, dbInstance);
    }

    const tooLargeForInline = maxInlineBytes > 0 && buffer.length > maxInlineBytes;
    if (!isText || maxInlineBytes === 0 || tooLargeForInline) {
        const mime = contentType || 'application/octet-stream';
        const filename = `browser_fetch_${Date.now()}.${MIME_TO_EXT[mime] || 'bin'}`;
        const meta = dbInstance.db.storeFile('images', filename, buffer, mime);
        const url = `/api/buckets/images/${meta._file.id}.${meta._file.ext}`;
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
            buffer = readBucketBytes(bucketRef.bucket, bucketRef.id, bucketRef.ext);
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

function executeUpdateMetadata(args, { db, conversationId }) {
    return (async () => {
        if (!args.session_id) throw new Error('chat_archive_update_metadata: session_id required');
        const sessions = db.find('id', args.session_id);
        const session = sessions.find(s => s._type === 'session');
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
        db.update(session._id, session);

        return {
            type: 'text',
            text: JSON.stringify({ success: true, updatedFields, storedSummary: session.summary ?? null })
        };
    })();
}

// ============================================
// helpers
// ============================================

function getSessionWithMessages(db, sessionId) {
    const sessions = db.find('id', sessionId);
    const session = sessions.find(s => s._type === 'session');
    if (!session) throw new Error(`Session ${sessionId} not found`);

    const convs = db.find('id', sessionId).filter(d => d._type === 'conversation');
    if (convs.length > 0) {
        const conv = convs[0];
        const msgs = JSON.parse(JSON.stringify(conv.messages || []));
        return { session, messages: msgs };
    }
    const messages = db.find('sessionId', sessionId)
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
// that calls preview.show(args) using the args from tool.start.
function executePreviewShow(args) {
    if (!args || typeof args !== 'object') throw new Error('chat_preview_show: args object required');
    const hasContent = args.content !== undefined && args.content !== null;
    const hasUrl = typeof args.url === 'string' && args.url.length > 0;
    if (hasContent && hasUrl) throw new Error('chat_preview_show: pass content OR url, not both');
    if (!hasContent && !hasUrl) throw new Error('chat_preview_show: one of content or url required');
    const label = args.title || args.id || 'item';
    const mode = hasUrl ? `URL ${args.url}` : `${(args.content || '').length} chars`;
    return { content: [{ type: 'text', text: `Preview queued (${mode}). Click "Show in preview" on this tool bubble to render "${label}".` }] };
}

// chat_preview_state: reconstruct the preview items shown so far from the
// conversation's chat_preview_show tool calls (metadata only). Live view state
// (selected item, pane open/closed) is client-side and not queryable.
function executePreviewState(args, { dbInstance, conversationId }) {
    let items = [];
    try {
        const conv = dbInstance.db.find('id', conversationId).find(d => d._type === 'conversation');
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
    findReferences,
    getToolDefs,
    isInternalTool,
    filterVisionTools,
    executeInternalTool,
    ARCHIVE_TOOL_DEFS,
    RETIREMENT_TOOL_DEFS
};
