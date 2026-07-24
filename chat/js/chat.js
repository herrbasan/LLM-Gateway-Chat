// ============================================
// LLM Gateway Chat - Main Controller
// ============================================

import { Conversation } from './conversation.js';
import { GatewayClient } from './client-sdk.js';
import { renderMarkdown, parseThinking } from './markdown.js';
import { imageStore } from './image-store.js';
import { mcpClient } from './mcp-client.js';
import { chatHistory } from './chat-history.js';
import { storage } from './storage.js';
import { getPlainText } from './tts-utils.js';
import { backendClient } from './api-client.js';
import { NSpeechController } from '../../lib/tts/nspeech-controller.js';
import { TtsPlayerHost } from '../../lib/tts/tts-player.js';
import { preview } from './preview.js';

// Fire-and-forget client log to server nLogger — never throws
function _logTool(message, meta = {}) {
    if (backendClient?.clientLog) {
        backendClient.clientLog('Tool', message, meta).catch(() => {});
    }
}

// Config values with defaults
const CONFIG = window.CHAT_CONFIG || {};
const GATEWAY_URL = localStorage.getItem('gateway-url') || '';
const GATEWAY_API_KEY = localStorage.getItem('gateway-api-key') || '';
const DEFAULT_MODEL = CONFIG.defaultModel || '';
const DEFAULT_TEMPERATURE = CONFIG.defaultTemperature ?? 0.7;
const DEFAULT_MAX_TOKENS = CONFIG.defaultMaxTokens || '';
const TTS_ENDPOINT = CONFIG.ttsEndpoint || 'http://localhost:2233';
const TTS_VOICE = CONFIG.ttsVoice || '';
const TTS_SPEED = CONFIG.ttsSpeed ?? 1.0;
const BACKEND_URL = CONFIG.backendUrl !== undefined ? CONFIG.backendUrl : 'http://localhost:3500';
const BACKEND_API_KEY = CONFIG.backendApiKey || '';
const ENABLE_ARCHIVE_TOOLS = CONFIG.enableArchiveTools !== false;

// Resolve the configured MCP server origin — the single source of truth for
// how THIS client reaches the workshop (LAN IP locally, dyndns remotely).
// Never hardcode a storage/MCP host: derive it from the user's configured
// server list so the same code works from any network location.
function getMcpServerOrigin() {
    const server = (mcpClient.servers || []).find(s => s.url);
    if (!server) return null;
    try {
        return new URL(server.url).origin;
    } catch (_) {
        return null;
    }
}

// Local tool definitions (executed directly in the browser, never routed to MCP servers)
const ARCHIVE_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'browser_fetch',
            description: 'Execution context: Chat App browser ONLY. This is NOT an MCP method — it is intercepted by the chat frontend and executed with the browser\'s native fetch() API, bypassing MCP JSON-RPC size limits entirely.\\n\\nUse this tool to download a file or resource from ANY URL when the response may be too large for MCP (which is typically capped around 64 KB). Works for storage files, LAN addresses, and public internet URLs alike — it is a plain fetch, nothing more. Cross-origin requests are subject to normal browser CORS rules. The response is made available to the model either as inline text or as a chat-bucket URL.\\n\\n**Binary upload**: use body_type="data_url" with a data URL body to send binary data to HTTP endpoints. NOTE: to save a chat attachment to workshop storage, use attachment_save instead — it handles the transfer in one call.\\n\\n**Response handling**: text/* and application/json responses up to max_inline_bytes (default 5 MB) are returned inline. Anything larger, or any binary type (images, PDFs, audio, etc.), is uploaded to the chat\'s bucket and a `/api/buckets/images/...` URL is returned instead.\\n\\n**When to use**: whenever you already have a direct URL and expect the payload to exceed MCP limits, or when `storage_read` returns a relative `path` pointer (prepend your MCP origin and fetch it).',
            parameters: {
                type: 'object',
                properties: {
                    url: { type: 'string', description: 'Absolute URL to fetch. Cross-origin requests are subject to normal browser CORS rules.' },
                    method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], description: 'HTTP method (default GET)' },
                    headers: { type: 'object', description: 'Optional request headers as key/value strings' },
                    body: { type: 'string', description: 'Optional request body for POST/PUT/PATCH. When body_type is "text" (default), this is sent as-is. When body_type is "data_url", this must be a data URL (data:mime;base64,...) which is decoded to binary before sending.' },
                    body_type: { type: 'string', enum: ['text', 'data_url'], description: 'How to interpret the body. "text" (default): send as string. "data_url": parse body as a data URL, decode base64 to binary Blob, and send with the MIME type from the data URL as Content-Type. Use "data_url" to upload images or other binary files to HTTP endpoints (e.g. PUT /storage/* on the MCP server).' },
                    max_inline_bytes: { type: 'number', description: 'Max bytes to return inline as text (default 5,242,880 = 5 MB). Set to 0 to always upload to bucket and return a URL.' }
                },
                required: ['url']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'chat_preview_show',
            description: 'Execution context: Chat App (browser). NOT accessible from MCP server tools or Forge workers.\n\nRender content in the chat\'s preview pane — a separate surface from the chat scrollback. Use it to show files, proposed edits, diffs, or any work product the user should see alongside the conversation. Calling with an existing id updates that item in place and brings it to front. The user can switch between shown items via a dropdown.\n\nPrefer content under ~32KB; for larger files, show the relevant excerpt. Content over 256KB is rejected. Syntax coloring is applied for html, css, javascript, typescript, and json; other languages render as plain monospace (still correct, just uncolored).',
            parameters: {
                type: 'object',
                properties: {
                    id: { type: 'string', description: 'Stable identifier for this preview item. Reusing an id updates the existing item rather than creating a new one. Example: \'file:server.js\' or \'proposed-edit:config.json\'.' },
                    title: { type: 'string', description: 'Human-readable label shown in the dropdown and header. Example: \'server.js\' or \'Proposed: config.json\'.' },
                    language: { type: 'string', description: 'Content type. Use \'markdown\' for rendered MD preview. Any other value (javascript, python, json, text, etc.) renders as syntax-highlighted code. Default: text.', 'default': 'text' },
                    content: { type: 'string', description: 'The full content to render. For markdown, this is the raw MD source. For code, this is the source text.' },
                    source: { type: 'string', description: 'Optional provenance label. Example: \'storage:foo.js\', \'proposed-edit:foo.js\', \'generated\'. Shown as a subtitle in the header.' }
                },
                required: ['id', 'title', 'content']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'chat_preview_state',
            description: 'Execution context: Chat App (browser). NOT accessible from MCP server tools or Forge workers.\n\nReturns the current state of the preview pane: which items have been shown, which item the user is currently viewing (selected in the dropdown), and whether the pane is open. Use this to check what the user is looking at before proposing edits or when the user refers to "this" or "the current one". Returns metadata only (id, title, language, source) — not content, since you already have the content in your context from when you called chat_preview_show.',
            parameters: {
                type: 'object',
                properties: {}
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'chat_archive_update_metadata',
            description: 'Execution context: Chat App (browser). NOT accessible from MCP server tools or Forge workers.\\n\\nUpdate the metadata for a specific session/chat. Use this to assign categories (folders), write summaries, or update titles for better organization.',
            parameters: {
                type: 'object',
                properties: {
                    session_id: { type: 'string', description: 'The session ID to update' },
                    title: { type: 'string', description: 'Optional new title for the chat' },
                    summary: { type: 'string', description: 'Optional new summary of the chat' },
                    category: { type: 'string', description: 'Optional category (acts as a folder for grouping)' }
                },
                required: ['session_id']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'chat_archive_search',
            description: 'Execution context: Chat App (browser). NOT accessible from MCP server tools or Forge workers.\\n\\nSearch the conversation archive. Use semantic mode for themes/ideas, keyword mode for specific terms, hybrid for both. Returns messages ranked by relevance.',
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
            description: 'Execution context: Chat App (browser). NOT accessible from MCP server tools or Forge workers.\\n\\nRetrieve a specific conversation session by ID.\\n\\nTo process session data with a forge tool: (1) call this tool to get session data, (2) call storage.write to persist it, (3) pass the storage URL as forge.call payload.\\n\\nWhen saveToStorage is true, this tool writes the full session JSON directly to workshop storage and returns ONLY the URL — use this when you need to pass large session data to a forge tool that would overflow the context window.',
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
            description: 'Execution context: Chat App (browser). NOT accessible from MCP server tools or Forge workers.\\n\\nList all direct (normal) chat sessions with metadata. Use to browse past conversations.',
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
            description: 'Execution context: Chat App (browser). NOT accessible from MCP server tools or Forge workers.\\n\\nList all arena sessions with metadata. Use to browse available conversations.',
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
            description: 'Execution context: Chat App (browser). NOT accessible from MCP server tools or Forge workers.\\n\\nGiven a session ID, find the most semantically similar sessions in the archive. Use to discover related conversations without guessing search terms.',
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
            description: 'Execution context: Chat App (browser). NOT accessible from MCP server tools or Forge workers.\\n\\nTrace conversation lineage. Finds which sessions reference this one (inbound) and which sessions this one references (outbound). Matches session IDs in message content.',
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
            description: 'Execution context: Chat App (browser). NOT accessible from MCP server tools or Forge workers.\n\nCopy a binary file (image, PDF, etc.) from the chat file bucket to workshop storage. Use this to persist attached images or other binaries into the MCP server\'s filesystem — e.g. saving a user-uploaded image to digital-twin/images/.\n\nThe source URL is the bucket URL from the attachment manifest line in the user message (looks like http://<host>/api/buckets/images/<id>.<ext>). The destination is a path relative to the MCP storage root. Returns the storage path and byte count on success.\n\nThis is a server-to-browser-to-server copy — no base64 in your context, no token cost. One call does the whole transfer.',
            parameters: {
                type: 'object',
                properties: {
                    url: { type: 'string', description: 'The source URL — a bucket URL from the attachment manifest, or any reachable URL that returns the binary bytes.' },
                    storage_path: { type: 'string', description: 'Destination path in workshop storage, relative to the storage root. Example: "digital-twin/images/photo.jpg"' }
                },
                required: ['url', 'storage_path']
            }
        }
    }
];

// Local tool execution — calls backend REST API, not MCP servers
async function executeLocalTool(toolName, args, exchangeId = null) {
    const headers = {
        'Content-Type': 'application/json',
        'X-API-Key': BACKEND_API_KEY
    };

    switch (toolName) {
        case 'browser_fetch': {
            return executeBrowserFetch(args, exchangeId, headers);
        }
        case 'attachment_save': {
            return executeAttachmentSave(args);
        }
        case 'chat_preview_show': {
            return preview.show(args);
        }
        case 'chat_preview_state': {
            return preview.getState();
        }
        case 'read_resource': {
            return mcpClient.executeReadResource(args, exchangeId);
        }
        case 'chat_archive_update_metadata': {
            console.log('[Archive Update Metadata] Args:', JSON.stringify(args));
            const reqBody = {};
            if (args.title) reqBody.title = args.title;
            if (args.summary) reqBody.summary = args.summary;
            if (args.category) reqBody.category = args.category;
            
            const res = await fetch(`${BACKEND_URL}/api/chats/${args.session_id}`, {
                method: 'PATCH',
                headers,
                body: JSON.stringify(reqBody)
            });
            if (res.status === 401) throw new Error('chat_archive_update_metadata: session expired (401). The user needs to log in again.');
            if (!res.ok) throw new Error(`chat_archive_update_metadata: backend error ${res.status}`);
            
            // Reload the sidebar silently to reflect changes if it's not the active chat trying to overwrite something we'd override local state for
            chatHistory.refreshList().then(() => renderHistoryList());
            
            return {
                type: 'text',
                text: JSON.stringify({ success: true, updatedFields: Object.keys(reqBody) })
            };
        }

        case 'chat_archive_search': {
            console.log('[Archive Search] Args:', JSON.stringify(args));
            const res = await fetch(`${BACKEND_URL}/api/search`, {
                method: 'POST', headers,
                body: JSON.stringify({
                    query: args.query, mode: args.mode || 'all',
                    role: args.role || 'all',
                    limit: args.limit || 10,
                    search_type: args.search_type || 'semantic',
                    date_from: args.date_from || null,
                    date_to: args.date_to || null
                })
            });
            if (res.status === 401) throw new Error('chat_archive_search: session expired (401). The user needs to log in again.');
            if (!res.ok) throw new Error(`chat_archive_search: backend error ${res.status}`);
            const data = await res.json();
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
            const offset = args.offset || 0;
            const limit = args.limit || 100;
            const res = await fetch(`${BACKEND_URL}/api/chats/${args.session_id}`, { method: 'GET', headers });
            if (res.status === 401) throw new Error('chat_archive_get_session: session expired (401). The user needs to log in again.');
            if (!res.ok) throw new Error(`chat_archive_get_session: backend error ${res.status}`);
            const data = await res.json();

            // saveToStorage: bypass LLM context window — write session JSON
            // directly to workshop storage, return only the URL.
            if (args.saveToStorage) {
                const storagePayload = JSON.stringify({
                    session: {
                        id: data.session?.id,
                        title: data.session?.title,
                        mode: data.session?.mode,
                        model: data.session?.model,
                        category: data.session?.category,
                        summary: data.session?.summary,
                        arenaConfig: data.session?.arenaConfig,
                    },
                    messageCount: data.messages?.length,
                    messages: (data.messages || []).map(m => ({
                        role: m.role, model: m.model, turnIndex: m.turnIndex,
                        speaker: m.speaker,
                        content: m.content
                    }))
                });

                const storagePath = `sessions/${args.session_id}.json`;
                const storageBase = getMcpServerOrigin();
                if (!storageBase) throw new Error('chat_archive_get_session: no MCP server configured — cannot reach storage');
                const storageUrl = `${storageBase}/storage/${storagePath}`;

                const putRes = await fetch(`${storageBase}/api/storage/write`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path: storagePath, content: storagePayload })
                });
                if (!putRes.ok) {
                    const errText = await putRes.text();
                    throw new Error(`Storage write failed (${putRes.status}): ${errText}`);
                }

                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({
                            ok: true,
                            url: storageUrl,
                            path: `/storage/${storagePath}`,
                            sessionId: args.session_id,
                            messageCount: data.messages?.length,
                            hint: 'url is absolute (use as forge.call payload). path is relative to your MCP origin (use with browser_fetch).'
                        })
                    }]
                };
            }

            const paged = data.messages?.slice(offset, offset + limit) || [];
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        session: {
                            id: data.session?.id,
                            title: data.session?.title,
                            mode: data.session?.mode,
                            model: data.session?.model,
                            category: data.session?.category,
                            summary: data.session?.summary,
                            arenaConfig: data.session?.arenaConfig,
                            messageCount: data.messages?.length
                        },
                        offset, limit,
                        returned: paged.length,
                        messages: paged.map(m => ({
                            role: m.role, model: m.model, turnIndex: m.turnIndex,
                            speaker: m.speaker,
                            content: m.content
                        }))
                    }, null, 2)
                }]
            };
        }

        case 'chat_archive_list_chats': {
            const res = await fetch(`${BACKEND_URL}/api/chats`, { method: 'GET', headers });
            if (res.status === 401) throw new Error('chat_archive_list_chats: session expired (401). The user needs to log in again.');
            if (!res.ok) throw new Error(`chat_archive_list_chats: backend error ${res.status}`);
            const data = await res.json();
            // Filter strictly for direct/normal chats (exclude arena)
            const allDirect = data.data.filter(s => s.mode !== 'arena');
            let results = allDirect;
            if (args.date_from) results = results.filter(a => a.createdAt >= args.date_from);
            if (args.date_to) results = results.filter(a => a.createdAt <= args.date_to);
            const limit = args.limit || 20;
            const offset = args.offset || 0;
            // When date-filtered results are empty, include the actual date range
            // of available sessions so the LLM can adjust its query.
            const dateRange = results.length === 0 && allDirect.length > 0 ? {
                available_oldest: allDirect.reduce((min, s) => s.createdAt < min ? s.createdAt : min, allDirect[0].createdAt),
                available_newest: allDirect.reduce((max, s) => s.createdAt > max ? s.createdAt : max, allDirect[0].createdAt),
                total_in_archive: allDirect.length
            } : undefined;
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        total: results.length,
                        total_before_date_filter: allDirect.length,
                        offset,
                        limit,
                        ...(dateRange ? { hint: 'No sessions match the date filter. Here is the actual date range of available sessions.', ...dateRange } : {}),
                        results: results.slice(offset, offset + limit).map(a => ({
                            id: a.id, title: a.title,
                            model: a.model || 'unknown',
                            messages: a.messageCount,
                            created: a.createdAt,
                            category: a.category,
                            summary: a.summary
                        }))
                    }, null, 2)
                }]
            };
        }

        case 'chat_archive_list_arena': {
            const res = await fetch(`${BACKEND_URL}/api/arena`, { method: 'GET', headers });
            if (res.status === 401) throw new Error('chat_archive_list_arena: session expired (401). The user needs to log in again.');
            if (!res.ok) throw new Error(`chat_archive_list_arena: backend error ${res.status}`);
            const data = await res.json();
            const allArena = data.data;
            let results = allArena;
            if (args.date_from) results = results.filter(a => a.createdAt >= args.date_from);
            if (args.date_to) results = results.filter(a => a.createdAt <= args.date_to);
            const limit = args.limit || 20;
            const offset = args.offset || 0;
            const dateRange = results.length === 0 && allArena.length > 0 ? {
                available_oldest: allArena.reduce((min, s) => s.createdAt < min ? s.createdAt : min, allArena[0].createdAt),
                available_newest: allArena.reduce((max, s) => s.createdAt > max ? s.createdAt : max, allArena[0].createdAt),
                total_in_archive: allArena.length
            } : undefined;
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        total: results.length,
                        total_before_date_filter: allArena.length,
                        offset,
                        limit,
                        ...(dateRange ? { hint: 'No sessions match the date filter. Here is the actual date range of available sessions.', ...dateRange } : {}),
                        results: results.slice(offset, offset + limit).map(a => ({
                            id: a.id, title: a.title,
                            models: a.arenaConfig ? `${a.arenaConfig.modelA} vs ${a.arenaConfig.modelB}` : 'unknown',
                            messages: a.messageCount,
                            created: a.createdAt,
                            category: a.category,
                            summary: a.summary
                        }))
                    }, null, 2)
                }]
            };
        }

        case 'chat_archive_find_similar': {
            const srcRes = await fetch(`${BACKEND_URL}/api/chats/${args.session_id}`, { method: 'GET', headers });
            if (srcRes.status === 401) throw new Error('chat_archive_find_similar: session expired (401). The user needs to log in again.');
            if (!srcRes.ok) throw new Error(`chat_archive_find_similar: backend error ${srcRes.status}`);
            const srcData = await srcRes.json();
            const srcTitle = srcData.session?.title || args.session_id;
            const srcMessages = srcData.messages || [];
            const srcModels = srcData.session?.model || 'unknown';

            // Embed assistant messages (the actual conversation), not the system prompt
            const assistantTexts = srcMessages
                .filter(m => m.role === 'assistant')
                .map(m => m.content || '')
                .join(' ');
            const queryText = assistantTexts.slice(0, 3000);
            const messageCount = srcMessages.length;

            const searchRes = await fetch(`${BACKEND_URL}/api/search`, {
                method: 'POST', headers,
                body: JSON.stringify({ query: queryText, limit: (args.limit || 5) + 1 })
            });
            if (searchRes.status === 401) throw new Error('chat_archive_find_similar: session expired (401). The user needs to log in again.');
            if (!searchRes.ok) throw new Error(`chat_archive_find_similar: search backend error ${searchRes.status}`);
            const searchData = await searchRes.json();

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
                            models: srcModels,
                            messageCount
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
            const res = await fetch(`${BACKEND_URL}/api/references`, {
                method: 'POST', headers,
                body: JSON.stringify({
                    session_id: args.session_id,
                    direction: args.direction || 'both'
                })
            });
            if (res.status === 401) throw new Error('chat_archive_find_references: session expired (401). The user needs to log in again.');
            if (!res.ok) throw new Error(`chat_archive_find_references: backend error ${res.status}`);
            const data = await res.json();
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify(data, null, 2)
                }]
            };
        }

        default:
            throw new Error(`Unknown local tool: ${toolName}`);
    }
}

// ============================================
// browser_fetch — direct browser fetch with no MCP transport size cap
// ============================================
//
// Returns MCP-style { content: [{ type: 'text' | 'image', ... }] } so the
// existing dispatcher renders text inline and binary responses via the
// chat's image bucket (garbage-collected on chat delete).
//
// Validate-then-fetch. If any precondition fails, throw — never silently
// degrade. The dispatcher catches and shows a tool error.

async function executeBrowserFetch(args, exchangeId, _headers) {
    // Success conditions (each one explicit, fail fast)
    if (!args || typeof args !== 'object') throw new Error('browser_fetch: args object required');
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
    // 0 means "always upload to bucket and return URL"; non-zero may fall back to bucket if too large.
    if (maxInlineBytes > 0 && !exchangeId) {
        throw new Error('browser_fetch: exchangeId required when max_inline_bytes > 0');
    }

    // Parse + validate URL
    let parsedUrl;
    try {
        parsedUrl = new URL(args.url);
    } catch (err) {
        throw new Error(`browser_fetch: invalid URL — ${err.message}`);
    }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        throw new Error(`browser_fetch: protocol must be http or https (got ${parsedUrl.protocol})`);
    }

    // No allowlist: browser_fetch is a plain fetch. Cross-origin requests are
    // governed by normal browser CORS rules — that is the only gate, and it
    // cannot be bypassed or string-matched around.
    const fullUrl = parsedUrl.href;

    // Build fetch options
    const bodyType = args.body_type || 'text';
    let fetchBody = args.body;
    let fetchHeaders = args.headers ? { ...args.headers } : undefined;

    // data_url mode: parse "data:mime;base64,..." into a Blob for binary upload.
    // This lets the LLM push images and other binaries to HTTP endpoints (e.g.
    // PUT /storage/* on the MCP server) without base64-through-JSON-RPC overhead.
    if (bodyType === 'data_url' && args.body !== undefined) {
        const commaIdx = args.body.indexOf(',');
        if (commaIdx === -1) {
            throw new Error('browser_fetch: data_url body must be a valid data URL (data:mime;base64,...)');
        }
        const meta = args.body.substring(5, commaIdx); // strip "data:" prefix
        const isBase64 = meta.includes(';base64');
        const mimeType = meta.split(';')[0] || 'application/octet-stream';
        const dataPart = args.body.substring(commaIdx + 1);
        if (!isBase64) {
            throw new Error('browser_fetch: data_url body must be base64-encoded (data:mime;base64,...)');
        }
        // Decode base64 → Uint8Array → Blob
        const binaryStr = atob(dataPart);
        const bytes = new Uint8Array(binaryStr.length);
        for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
        fetchBody = new Blob([bytes], { type: mimeType });
        // Set Content-Type from the data URL unless the caller overrode it via headers
        if (!fetchHeaders || !Object.keys(fetchHeaders).some(h => h.toLowerCase() === 'content-type')) {
            fetchHeaders = fetchHeaders || {};
            fetchHeaders['Content-Type'] = mimeType;
        }
    }

    const fetchOpts = {
        method: args.method || 'GET',
        headers: fetchHeaders,
        body: fetchBody
    };
    // GET/HEAD cannot have a body per spec — strip silently rather than 400.
    if ((fetchOpts.method === 'GET' || fetchOpts.method === 'HEAD') && fetchOpts.body !== undefined) {
        fetchOpts.body = undefined;
    }

    console.log(`[browser_fetch] Fetching ${fetchOpts.method} ${fullUrl}`);
    let res;
    try {
        res = await fetch(fullUrl, fetchOpts);
    } catch (fetchErr) {
        const errType = fetchErr.name || 'NetworkError';
        const errMsg = fetchErr.message || String(fetchErr);
        console.error(`[browser_fetch] Fetch failed: ${errType}: ${errMsg}`, fetchErr);
        // Auto-diagnose: run probes so the error message contains actionable data.
        const diag = await _browserFetchDiagnose(fullUrl, errMsg);
        throw new Error(
            `browser_fetch: network request failed (${errType}). ` +
            `URL: ${fullUrl}. ` +
            `Detail: ${errMsg}\n\n` +
            `--- DIAGNOSTICS ---\n${JSON.stringify(diag, null, 2)}`
        );
    }
    console.log(`[browser_fetch] Response ${res.status} ${res.statusText}, content-type: ${res.headers.get('content-type') || 'unknown'}`);

    const contentType = res.headers.get('content-type') || '';
    const isText = contentType.startsWith('text/') || contentType.includes('json') || contentType.startsWith('application/xml') || contentType === '';

    // Read the whole response as a Blob so we can measure actual bytes before deciding inline vs bucket.
    // This keeps us from loading multi-megabyte text into a JS string just to truncate it.
    const blob = await res.blob();

    // If binary OR explicitly always-upload (maxInlineBytes === 0) OR too large for inline → bucket.
    const tooLargeForInline = maxInlineBytes > 0 && blob.size > maxInlineBytes;
    if (!isText || maxInlineBytes === 0 || tooLargeForInline) {
        if (!exchangeId) {
            throw new Error('browser_fetch: response too large for inline return and no exchangeId to upload under');
        }
        const mime = blob.type || contentType || 'application/octet-stream';
        const filename = `browser_fetch_${Date.now()}.${mimeToExt(mime)}`;
        const dataUrl = await blobToDataUrl(blob);
        const saved = await imageStore.save(exchangeId, [{ name: filename, type: mime, dataUrl }]);
        const url = saved[0]?.url;
        if (!url) throw new Error('browser_fetch: bucket upload succeeded but no URL returned');
        const summary = JSON.stringify({
            ok: res.ok,
            status: res.status,
            statusText: res.statusText,
            url,
            mimeType: mime,
            bytes: blob.size,
            note: maxInlineBytes === 0 ? 'Response uploaded to chat bucket (max_inline_bytes=0).' : 'Response too large for inline return; uploaded to chat bucket.'
        }, null, 2);
        return {
            content: [
                { type: 'image', url, mimeType: mime },
                { type: 'text', text: summary }
            ]
        };
    }

    // Text inline path — blob is known to be under maxInlineBytes.
    const text = await blob.text();
    const payload = {
        ok: res.ok,
        status: res.status,
        statusText: res.statusText,
        contentType,
        bytes: blob.size,
        url: fullUrl,
        truncated: false,
        body: text
    };
    return {
        content: [{
            type: 'text',
            text: JSON.stringify(payload, null, 2)
        }]
    };
}

// ============================================
// attachment_save — copy a bucket file to MCP storage
// ============================================
//
// Fetches the source URL (same-origin bucket URL, no CORS issue) as a Blob,
// then PUTs the raw bytes to <mcp origin>/storage/<path>. One tool call,
// no base64 through the model context.

async function executeAttachmentSave(args) {
    if (!args || typeof args !== 'object') throw new Error('attachment_save: args object required');
    if (typeof args.url !== 'string' || args.url.length === 0) throw new Error('attachment_save: url required');
    if (typeof args.storage_path !== 'string' || args.storage_path.length === 0) throw new Error('attachment_save: storage_path required');

    const mcpOrigin = getMcpServerOrigin();
    if (!mcpOrigin) throw new Error('attachment_save: no MCP server connected — cannot determine storage endpoint');

    // Fetch the source bytes
    let blob;
    try {
        const res = await fetch(args.url);
        if (!res.ok) throw new Error(`source fetch returned ${res.status} ${res.statusText}`);
        blob = await res.blob();
    } catch (err) {
        throw new Error(`attachment_save: failed to fetch source URL — ${err.message}`);
    }
    if (!blob || blob.size === 0) throw new Error('attachment_save: source URL returned empty response');

    // PUT the raw bytes to MCP storage
    const destUrl = `${mcpOrigin}/storage/${args.storage_path.replace(/^\/+/, '')}`;
    let putRes;
    try {
        putRes = await fetch(destUrl, {
            method: 'PUT',
            headers: { 'Content-Type': blob.type || 'application/octet-stream' },
            body: blob
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
        bytes: result.size ?? blob.size,
        content_type: result.content_type || blob.type || 'application/octet-stream'
    }, null, 2);

    return {
        content: [{ type: 'text', text: summary }]
    };
}

// ============================================
// browser_fetch diagnostics — runs on fetch failure
// ============================================
//
// Probes the target URL from multiple angles to isolate the failure mode.
// Returns a structured object the LLM can reason about.

// Timeout helper — AbortSignal.timeout may not exist in older browsers.
function _fetchTimeout(ms) {
    if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) return AbortSignal.timeout(ms);
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), ms);
    return ctrl.signal;
}

async function _browserFetchDiagnose(url, originalError) {
    const origin = typeof window !== 'undefined' ? window.location?.origin : 'unknown';
    const parsed = (() => { try { return new URL(url); } catch { return null; } })();
    const result = {
        browser_origin: origin,
        target_url: url,
        target_host: parsed?.hostname || 'unparseable',
        target_port: parsed?.port || '(default)',
        same_origin: parsed && origin ? `${parsed.origin}` === origin : false,
        original_error: originalError,
        probes: {}
    };

    // Probe 1: CORS preflight (OPTIONS). If this succeeds, the server is up
    // and CORS is configured — the GET failure is something else.
    try {
        const preflight = await fetch(url, {
            method: 'OPTIONS',
            headers: { 'Access-Control-Request-Method': 'GET', 'Origin': origin || 'null' },
            signal: _fetchTimeout(5000)
        });
        const acao = preflight.headers.get('access-control-allow-origin');
        result.probes.cors_preflight = {
            status: preflight.status,
            access_control_allow_origin: acao,
            allows_this_origin: acao === '*' || acao === origin,
            verdict: preflight.ok ? 'server_responded' : `server_returned_${preflight.status}`
        };
    } catch (e) {
        result.probes.cors_preflight = { verdict: 'preflight_failed', error: e.message };
    }

    // Probe 2: no-cors mode. A successful opaque response means the server is
    // reachable but normal CORS is blocking the response body.
    try {
        const noCorsRes = await fetch(url, {
            mode: 'no-cors',
            signal: _fetchTimeout(5000)
        });
        result.probes.no_cors_fetch = {
            type: noCorsRes.type,
            status: noCorsRes.status,
            verdict: noCorsRes.type === 'opaque' ? 'server_reachable_cors_blocking' : 'unexpected_response_type'
        };
    } catch (e) {
        result.probes.no_cors_fetch = { verdict: 'no_cors_also_failed', error: e.message };
    }

    // Probe 3: localhost alternate. If the URL uses a LAN IP, test whether
    // localhost resolves to the same service (helps when browser is on the
    // same machine as the server).
    if (parsed && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
        const localhostUrl = url.replace(parsed.hostname, 'localhost');
        try {
            const lhRes = await fetch(localhostUrl, {
                mode: 'no-cors',
                signal: _fetchTimeout(5000)
            });
            result.probes.localhost_alternate = {
                url: localhostUrl,
                type: lhRes.type,
                verdict: lhRes.type === 'opaque' ? 'localhost_reachable' : 'unexpected'
            };
        } catch (e) {
            result.probes.localhost_alternate = { url: localhostUrl, verdict: 'localhost_unreachable', error: e.message };
        }
    }

    // Synthesize a human-readable diagnosis
    const parts = [];
    if (result.probes.cors_preflight?.verdict === 'preflight_failed') {
        parts.push('SERVER_UNREACHABLE: the target server did not respond. It may be down or the network route is blocked.');
    } else if (result.probes.cors_preflight?.access_control_allow_origin === null) {
        parts.push('CORS_MISSING: server responded but sent no Access-Control-Allow-Origin header. CORS is not configured.');
    } else if (result.probes.cors_preflight && !result.probes.cors_preflight.allows_this_origin) {
        parts.push(`CORS_ORIGIN_REJECTED: server allows "${result.probes.cors_preflight.access_control_allow_origin}" but this browser is at "${origin}".`);
    } else if (result.probes.no_cors_fetch?.verdict === 'server_reachable_cors_blocking') {
        parts.push('CORS_BLOCKING_RESPONSE: server is reachable (no-cors succeeded) but CORS headers are missing or wrong on the actual GET response.');
    } else {
        parts.push('AMBIGUOUS: probes did not isolate a single cause. Check the raw probe data above.');
    }
    result.diagnosis = parts.join(' ');

    return result;
}

// Convert Blob → data URL (browser only).
function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error(`FileReader failed: ${reader.error?.message || 'unknown'}`));
        reader.readAsDataURL(blob);
    });
}

// Map common MIME types to safe filename extensions.
function mimeToExt(mime) {
    const map = {
        'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg',
        'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg',
        'image/bmp': 'bmp', 'application/pdf': 'pdf',
        'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/ogg': 'ogg',
        'video/mp4': 'mp4', 'video/webm': 'webm',
        'application/zip': 'zip', 'application/octet-stream': 'bin'
    };
    return map[mime] || 'bin';
}

const LOCAL_TOOL_NAMES = new Set(ARCHIVE_TOOLS.map(t => t.function.name));
LOCAL_TOOL_NAMES.add('read_resource'); // read_resource is handled by the MCP resource client, not a real MCP tool

// State
let currentChatId = null;
let conversation = null;

// Multi-conversation: per-chat DOM containers (hidden containers for background chats)
const chatContainers = new Map(); // chatId -> HTMLDivElement
// Multi-conversation: in-memory conversation objects (avoid re-loading from backend)
const activeConversations = new Map(); // chatId -> Conversation
// Chats that received new content while in background (cleared when viewed)
const chatsWithNewContent = new Set();

// Embed status — SSE event source for real-time updates
let _embedEventSource = null;
let _embedEventChatId = null;

let client = new GatewayClient({
    baseUrl: GATEWAY_URL,
    accessKey: GATEWAY_API_KEY,
    operationMode: CONFIG.operationMode || 'sse',
    onLog: (category, message, meta) => {
        if (backendClient?.clientLog) backendClient.clientLog(category, message, meta).catch(() => {});
    }
});

function updateGatewayUrl(newUrl) {
    localStorage.setItem('gateway-url', newUrl);
    client.restUrl = newUrl;
    client.wsUrl = newUrl.replace(/^http/, 'ws') + '/v1/realtime';
    if (client.socket) client.socket.close();
}

function updateGatewayApiKey(newKey) {
    localStorage.setItem('gateway-api-key', newKey);
    client.accessKey = newKey;
    if (client.socket) client.socket.close();
}
let models = [];
let currentModel = '';
let isStreaming = false;
let currentExchangeId = null;
let attachedImages = []; // Array of {dataUrl, name, type}
let useVisionAnalysis = false; // Toggle for using vision tool instead of direct image upload

// TTS State — managed by NSpeechController (instantiated after DOM elements are bound)
let tts = null;
let ttsPlayer = null;
let currentTtsExchangeId = null;

// DOM Elements
const elements = {
    modelSelect: document.getElementById('model-select'),
    temperature: document.getElementById('temperature'),
    thinkingCheckbox: document.getElementById('thinking-checkbox'),
    maxTokens: document.getElementById('max-tokens'),
    systemPrompt: document.getElementById('system-prompt'),
    presetSelect: document.getElementById('preset-select'),
    managePresetsBtn: document.getElementById('manage-presets-btn'),
    presetsDialog: document.getElementById('presets-dialog'),
    operationMode: document.getElementById('operation-mode'),
    userName: document.getElementById('user-name'),
    userLocation: document.getElementById('user-location'),
    userLanguage: document.getElementById('user-language'),
    messages: document.getElementById('messages'),
    messageInput: document.getElementById('message-input'),
    sendBtn: document.getElementById('send-btn'),
    attachBtn: document.getElementById('attach-btn'),
    fileInput: document.getElementById('file-input'),
    importChatInput: document.getElementById('import-chat-input'),
    importChatBtn: document.getElementById('import-chat-btn'),
    attachmentPreview: document.getElementById('attachment-preview'),
    newChatBtn: document.getElementById('new-chat-btn'),
    chatHistoryList: document.getElementById('chat-history-list'),
    themeToggle: document.getElementById('theme-toggle'),
    sidebar: document.getElementById('sidebar'),
    sidebarToggle: document.getElementById('sidebar-toggle'),
    sidebarToggleMobile: document.getElementById('sidebar-toggle-mobile'),
    gatewayUrl: document.getElementById('gateway-url'),
    gatewayApiKey: document.getElementById('gateway-api-key'),
    gatewayConnectBtn: document.getElementById('gateway-connect-btn'),
    gatewayConfigStatus: document.querySelector('#gateway-config-status .status-dot'),
    gatewayConfigStatusText: document.querySelector('#gateway-config-status .gateway-config-status-text'),
    overallContextProgressWrap: document.getElementById('overall-context-progress-wrap'),
    overallContextProgress: document.getElementById('overall-context-progress'),
    overallContextTooltip: document.getElementById('overall-context-tooltip'),
    stopButton: document.getElementById('stop-btn'), // Added safe fallback

    // MCP Elements
    mcpServerName: document.getElementById('mcp-server-name'),
    mcpServerUrl: document.getElementById('mcp-server-url'),
    mcpAddBtn: document.getElementById('mcp-add-btn'),
    mcpServersList: document.getElementById('mcp-servers-list'),

    // TTS Elements
    ttsEndpoint: document.getElementById('tts-endpoint'),
    ttsVoiceSelect: document.getElementById('tts-voice-select'),
    ttsSpeed: document.getElementById('tts-speed'),
    ttsStatus: document.getElementById('tts-status')
};

// ============================================
// Multi-Conversation: DOM Container Management
// ============================================

/**
 * Gets the container for a given chat, creating it if it doesn't exist.
 * The container is hidden by default; use getActiveContainer() for the visible one.
 */
function getOrCreateContainer(chatId) {
    if (chatContainers.has(chatId)) {
        return chatContainers.get(chatId);
    }
    const container = document.createElement('div');
    container.className = 'conversation-container';
    container.dataset.chatId = chatId;
    container.style.display = 'none'; // Hidden by default; switchChat sets 'flex' for active
    elements.messages.appendChild(container);
    chatContainers.set(chatId, container);
    return container;
}

/**
 * Gets the currently active (visible) chat's container.
 * For use in DOM operations within the active conversation.
 */
function getActiveContainer() {
    return chatContainers.get(currentChatId) || elements.messages;
}

/**
 * Returns the chatId of the currently visible (displayed) chat.
 * This is the GROUND TRUTH for which chat the user is looking at,
 * derived from the DOM, not the global currentChatId variable.
 */
function getDisplayedChatId() {
    for (const [id, container] of chatContainers.entries()) {
        if (container.style.display !== 'none') return id;
    }
    return currentChatId; // fallback
}

/**
 * Builds the historical DOM for a chat's container (one-time on first view).
 * Does NOT use renderConversation — builds directly from conversation data.
 */
async function buildHistoricalDomForChat(conv, container) {
    if (!container || !container.classList.contains('conversation-container')) {
        throw new Error(
            `buildHistoricalDomForChat: container must be a .conversation-container, got ${container ? container.tagName + '.' + container.className : 'null'}`
        );
    }
    if (conv.length === 0) {
        _vsShowBusy();
        _vsHideBusy();
        const welcome = document.createElement('div');
        welcome.className = 'welcome-message';
        const h2 = document.createElement('h2');
        h2.textContent = 'Welcome to LLM Gateway Chat';
        const p = document.createElement('p');
        p.textContent = 'Select a model and start chatting';
        welcome.append(h2, p);
        container.replaceChildren(welcome);
        return;
    }
    // Show busy while we render the historical DOM. _vsActivate hides it
    // after the post-activation visibility pass (called from switchChat).
    // WI-5: skip the overlay for small chats — _vsActivate will no-op anyway.
    if (conversation.getAll().length * 2 >= VS_MIN_ITEMS) _vsShowBusy();
    for (const exchange of conv.getAll()) {
        const el = buildExchangeElement(exchange);
        if (el) container.appendChild(el);
    }
}

// ============================================
// Preview tool-call button — "Show in preview" on chat_preview_show tool bubbles
// ============================================
//
// When the conversation is reloaded, the tool call (with full content in args)
// is in the history. This button lets the user reopen the preview from that
// stored data — no localStorage, no backend, no context bloat. The conversation
// IS the persistence layer.

function _decoratePreviewToolButton(toolEl, toolName, args) {
    if (toolName !== 'chat_preview_show') return;
    if (!args || typeof args !== 'object') return;

    const header = toolEl.querySelector('.tool-header');
    if (!header) return;
    // Don't double-add if already decorated (re-render safety)
    if (header.querySelector('.reopen-preview')) return;

    const btn = document.createElement('nui-button');
    btn.className = 'action-btn reopen-preview';
    btn.setAttribute('variant', 'icon');
    btn.setAttribute('title', 'Show in preview');
    btn.innerHTML = '<button type="button"><nui-icon name="article"></nui-icon></button>';
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        preview.show(args);
    });

    // Insert before the delete button if present, else append
    const deleteBtn = header.querySelector('.delete-tool');
    if (deleteBtn) {
        header.insertBefore(btn, deleteBtn);
    } else {
        header.appendChild(btn);
    }
}

/**
 * Builds a single exchange DOM element (used for historical DOM building).
 * Similar to renderExchange but doesn't append — returns the element.
 */
function buildExchangeElement(exchange) {
    if (exchange.type === 'tool') {
        const parsedObj = { name: exchange.tool.name, args: exchange.tool.args };
        const toolEl = document.createElement('div');
        toolEl.className = 'chat-message tool';
        toolEl.dataset.exchangeId = exchange.id;
        toolEl.dataset.mcpToolName = parsedObj.name;

        const isSuccess = exchange.tool.status === 'success';
        const isError = exchange.tool.status === 'error';
        const displayStatus = isSuccess ? 'Success' : (isError ? 'Failed' : 'Pending');
        const badgeVariant = isSuccess ? 'success' : (isError ? 'danger' : 'primary');

        let hasImages = exchange.tool.images && exchange.tool.images.length > 0;
        let imagesHtml = '';
        if (hasImages) {
            imagesHtml = `<div class="tool-images-container">`;
            exchange.tool.images.forEach(img => {
                imagesHtml += `<img src="${img}" class="tool-image" />`;
            });
            imagesHtml += `</div>`;
        }

        let resultHtml = '';
        if (isSuccess) resultHtml = `<strong>Result:</strong><br>${exchange.tool.content}`;
        else if (isError) resultHtml = `<strong>Error:</strong> ${exchange.tool.content}`;

        toolEl.innerHTML = `
            <div class="tool-bubble">
                <div class="message-header tool-header">
                    <nui-icon name="extension"></nui-icon>
                    <strong class="tool-title">SYSTEM TOOL: ${parsedObj.name}</strong>
                    <nui-badge variant="${badgeVariant}" class="tool-status">${displayStatus}</nui-badge>
                    <nui-button variant="icon" class="action-btn delete-tool" title="Delete Tool Call"><button type="button"><nui-icon name="delete"></nui-icon></button></nui-button>
                </div>
                <div class="tool-notifications"></div>
                <div class="tool-images" style="display: ${hasImages ? 'block' : 'none'};">${imagesHtml}</div>
                <div class="message-content tool-payload" style="display: none;">
                    <div class="tool-section-title">Arguments</div>
                    <div class="tool-args">${jsonStringifyForDisplay(parsedObj.args)}</div>
                    <div class="tool-section-title">Execution Result</div>
                    <div class="tool-result">${resultHtml}</div>
                </div>
            </div>
        `;

        _decoratePreviewToolButton(toolEl, parsedObj.name, parsedObj.args);

        toolEl.querySelector('.delete-tool')?.addEventListener('click', (e) => {
            e.stopPropagation();
            conversation.deleteExchange(exchange.id);
            _vsRemoveExchangeDom(toolEl, exchange.id);
        });

        toolEl.querySelector('.message-header').addEventListener('click', (e) => {
            if (e.target.tagName.toLowerCase() === 'button' || e.target.closest('button')) return;
            const payloadBox = toolEl.querySelector('.tool-payload');
            payloadBox.style.display = payloadBox.style.display === 'none' ? 'block' : 'none';
            // WI-2: height change detected by the frame loop (wake triggered
            // by the container's delegated click listener).
        });

        // Assistant message after tool - create as sibling, not child
        if (exchange.assistant.content || exchange.assistant.isStreaming) {

            const cleanedContent = stripExtraTimestamps(exchange.assistant.content);
            const assistantParsed = parseTimestamp(cleanedContent);
            const vers = exchange.assistant?.versions || [];
            const tsMs = (vers.length > 0 && vers[exchange.assistant?.currentVersion || 0]?.timestamp) || exchange.timestamp || Date.now();
            const assistantTimestamp = assistantParsed.timestamp || new Date(tsMs).toISOString().slice(0,16).replace('T',' @ ');
            const assistantEl = createAssistantElement(exchange.id, assistantTimestamp, exchange.model);

            const tsLen = exchange.assistant.content.length - assistantParsed.cleanContent.length;
            if (tsLen > 0) {
                assistantEl.dataset.timestampLen = tsLen.toString();
                assistantEl.dataset.timestampStripped = 'true';
            }
            updateAssistantContent(assistantEl, assistantParsed.cleanContent, exchange.assistant.reasoning_content);

            if (exchange.assistant.isComplete) {
                finalizeAssistantElement(assistantEl, exchange.id);
            }
            
            // Return a DocumentFragment containing both elements as siblings
            const fragment = document.createDocumentFragment();
            fragment.appendChild(toolEl);
            fragment.appendChild(assistantEl);

            return fragment;
        }

        return toolEl;
    }

    // Regular user + assistant exchange
    const userParsed = parseTimestamp(exchange.user.content);
    const userTimestamp = userParsed.timestamp || (exchange.timestamp && !isNaN(exchange.timestamp) ? new Date(exchange.timestamp).toISOString().slice(0, 16).replace('T', ' @ ') : '');

    let userContent = renderMarkdown(userParsed.cleanContent);
    if (exchange.user?.attachments?.length > 0) {
        userContent += '<div class="message-attachments"><nui-lightbox loop>';
        for (const att of exchange.user.attachments) {
            const imgSrc = att.blobUrl || att.dataUrl || '';
            userContent += `<img src="${imgSrc}" alt="${att.name}" data-lightbox-src="${imgSrc}" class="chat-attachment">`;
        }
        userContent += '</nui-lightbox></div>';
    }

    const userEl = document.createElement('div');
    userEl.className = 'chat-message user';
    userEl.dataset.exchangeId = exchange.id;
    userEl.innerHTML = `
        <div class="message-header">
            You <span class="message-timestamp">${userTimestamp}</span>
            <span class="embed-status" data-embed-status="unknown" title="Embed status unknown">
                <span class="embed-status-dot"></span>
            </span>
            <span class="user-pending-indicator visible">
                <span class="dot">.</span><span class="dot">.</span><span class="dot">.</span>
            </span>
        </div>
        <div class="message-content">${userContent}</div>
        <div class="message-actions-user">
            <nui-button class="action-btn edit-message" title="Edit Message"><button type="button"><nui-icon name="edit"></nui-icon></button></nui-button>
            <nui-button class="action-btn delete-message" title="Delete Message"><button type="button"><nui-icon name="delete"></nui-icon></button></nui-button>
        </div>
    `;
    userEl.querySelector('.edit-message')?.addEventListener('click', () => startEditMode(exchange.id, 'user'));
    userEl.querySelector('.delete-message')?.addEventListener('click', () => {
        conversation.deleteExchange(exchange.id);
        _vsRemoveExchangeDom(userEl, exchange.id);
    });

    // Set embed status directly on detached element (not in DOM yet)
    const userEmbedEl = userEl.querySelector('.embed-status');
    if (userEmbedEl) _applyEmbedStatusAttrs(userEmbedEl, exchange.user?.embedStatus || 'unknown', exchange.user?.embedError);

    // Assistant message - return as sibling in fragment, not child
    if (exchange.assistant?.content || exchange.assistant?.isStreaming) {
        const cleanedContent = stripExtraTimestamps(exchange.assistant.content);
        const assistantParsed = parseTimestamp(cleanedContent);
        const vers = exchange.assistant?.versions || [];
            const tsMs = (vers.length > 0 && vers[exchange.assistant?.currentVersion || 0]?.timestamp) || exchange.timestamp || Date.now();
            const assistantTimestamp = assistantParsed.timestamp || new Date(tsMs).toISOString().slice(0,16).replace('T',' @ ');
        const assistantEl = createAssistantElement(exchange.id, assistantTimestamp, exchange.model);
        assistantEl.dataset.isStreaming = exchange.assistant.isStreaming ? 'true' : 'false';

        const tsLen = exchange.assistant.content.length - assistantParsed.cleanContent.length;
        if (tsLen > 0) {
            assistantEl.dataset.timestampLen = tsLen.toString();
            assistantEl.dataset.timestampStripped = 'true';
        }
        updateAssistantContent(assistantEl, assistantParsed.cleanContent, exchange.assistant.reasoning_content);
        // Set embed status directly on detached elements (not in DOM yet)
        const uEmbed = userEl.querySelector('.embed-status');
        if (uEmbed) _applyEmbedStatusAttrs(uEmbed, exchange.user?.embedStatus || 'unknown', exchange.user?.embedError);
        const aEmbed = assistantEl.querySelector('.embed-status');
        if (aEmbed) _applyEmbedStatusAttrs(aEmbed, exchange.assistant.embedStatus || 'pending', exchange.assistant.embedError);

        if (exchange.assistant.isComplete) {
            finalizeAssistantElement(assistantEl, exchange.id);
        }
        
        // Return a DocumentFragment containing both elements as siblings
        const fragment = document.createDocumentFragment();
        fragment.appendChild(userEl);
        fragment.appendChild(assistantEl);
        return fragment;
    }

    return userEl;
}

// Create vision toggle container if not exists
function ensureVisionToggleUI() {
    if (!elements.attachmentPreview) return;
    
    let visionToggle = document.getElementById('vision-toggle-container');
    if (!visionToggle) {
        visionToggle = document.createElement('div');
        visionToggle.id = 'vision-toggle-container';
        visionToggle.className = 'vision-toggle-container';
        visionToggle.style.display = 'none';
        visionToggle.innerHTML = `
            <nui-checkbox variant="switch" title="Use MCP vision tools to analyze images. When disabled, images are sent directly to vision-capable models.">
                <input type="checkbox" id="vision-toggle-input">
            </nui-checkbox>
            <label for="vision-toggle-input">MCP Vision</label>
            <span id="vision-mode-indicator" class="vision-mode-indicator"></span>
        `;
        
        // Insert after attachment preview in the images row
        const imagesRow = document.getElementById('images-row');
        if (imagesRow) {
            imagesRow.appendChild(visionToggle);
        } else {
            elements.attachmentPreview.parentNode?.insertBefore(visionToggle, elements.attachmentPreview);
        }
        
        // Set initial state from saved preference
        const checkbox = visionToggle.querySelector('input');
        if (checkbox) {
            checkbox.checked = useVisionAnalysis;
        }

        // Add event listener
        checkbox?.addEventListener('change', (e) => {
            useVisionAnalysis = e.target.checked;
            storage.setPref('mcp-vision-enabled', useVisionAnalysis).catch(() => {});
            updateVisionModeIndicator();
        });

        // Ensure indicator is updated on creation
        updateVisionModeIndicator();
    }
}

// Update the vision mode indicator badge
function updateVisionModeIndicator() {
    const indicator = document.getElementById('vision-mode-indicator');
    if (!indicator) return;
    
    const modelSupportsVision = currentModelSupportsVision();
    
    if (useVisionAnalysis) {
        indicator.textContent = 'MCP';
        indicator.className = 'vision-mode-indicator mcp-mode';
        indicator.title = 'Using MCP vision tools to analyze images';
    } else if (modelSupportsVision) {
        indicator.textContent = 'Direct';
        indicator.className = 'vision-mode-indicator direct-mode';
        indicator.title = 'Sending images directly to model';
    } else {
        indicator.textContent = '';
        indicator.className = 'vision-mode-indicator';
    }
}

// ============================================
// Initialization
// ============================================

async function init() {

    // ---- Verify Session / Auth ----
    if (CONFIG.enableBackend) {
        backendClient.onAuthError(() => {
            document.getElementById('login-dialog').showModal();
        });

        const loginForm = document.getElementById('login-form');
        loginForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const username = document.getElementById('login-username').value;
            const password = document.getElementById('login-password').value;
            const errorDiv = document.getElementById('login-error');
            errorDiv.textContent = '';
            
            try {
                // Delay 500ms for UX
                document.querySelector('#login-dialog button[type="submit"]').disabled = true;
                await new Promise(r => setTimeout(r, 500));
                
                await backendClient.login(username, password);
                document.getElementById('login-dialog').close();
                // Reload page to re-initialize cleanly
                window.location.reload();
            } catch (err) {
                errorDiv.textContent = err.message || 'Login failed';
            } finally {
                document.querySelector('#login-dialog button[type="submit"]').disabled = false;
            }
        });

        try {
            const user = await backendClient.verifySession();
            if (!user) {
                document.getElementById('login-dialog').showModal();
                return; // halt init until logged in and reloaded
            }
            if (user.rights?.admin) {
                const btnAdmin = document.getElementById('btn-admin');
                if (btnAdmin) btnAdmin.style.display = '';
            }
        } catch (e) {
            console.warn('Backend probe failed or auth absent', e);
        }
    }

    // ---- Load chat history ----
    if (CONFIG.enableBackend === true && typeof CONFIG.backendUrl === 'string') {
        await chatHistory.refreshList();
    } else {
        await chatHistory.ready();
    }

    // Restore theme (needs history loaded first for async prefs)
    const savedTheme = await storage.getPref('theme');
    if (savedTheme) {
        await setTheme(savedTheme);
    } else {
        const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        await setTheme(prefersDark ? 'dark' : 'light');
    }

    // Ensure chat history is loaded
    if (CONFIG.enableBackend === true && typeof CONFIG.backendUrl === 'string') {
        // already fresh from above
    } else {
        await chatHistory.ready();
    }
    
    // Get or create active conversation
    let activeId = await chatHistory.getActiveId();
    if (!activeId || !chatHistory.has(activeId)) {
        activeId = await chatHistory.create();
    }

    currentChatId = activeId;
    conversation = new Conversation(`chat-conversation-${currentChatId}`);
    await conversation.load();

    // Cache in activeConversations for multi-conversation support
    activeConversations.set(currentChatId, conversation);

    // Set session ID from the Conversation object itself.
    // conv.sessionId is always set (derived from storageKey).
    if (conversation.sessionId) {
        client.setSessionId(conversation.sessionId);
    }

    // Apply default config values (needs history loaded first for async prefs)
    await applyDefaultConfig();

    // Restore system prompt for the initially loaded chat
    const chatInfo = chatHistory.get(currentChatId);
    restoreSystemPromptUI(chatInfo);

    // Setup event listeners first
    setupEventListeners();
    setupDialogEventListeners();

    // Initialize preview pane (needs DOM ready + NUI loaded for enableDrag)
    preview.init();

    // When preview content changes, stop any active TTS — the old audio
    // no longer matches what's on screen. The user can click speak again
    // to generate fresh audio for the new content.
    preview.onContentChange = () => {
        if (tts && tts.isActive()) {
            tts.stop();
        }
    };

    // Wire preview speak button — replicates chat's toggleTts pattern.
    // The controller's _applyButtonState looks for .speaker inside the targetEl,
    // so we pass the button's parent (the header) and give the button class "speaker".
    const previewSpeakBtn = document.getElementById('preview-speak-btn');
    if (previewSpeakBtn) {
        previewSpeakBtn.classList.add('speaker');
        const previewHeader = document.querySelector('.preview-header');
        previewSpeakBtn.addEventListener('click', () => {
            if (!tts) return;
            const text = preview.getActivePlainText(getPlainText);
            if (!text) return;
            // Use the controller's toggle() — handles same-item pause/resume/cancel
            // and different-item new-speak, same as chat messages.
            tts.toggle(text, previewHeader);
            ttsPlayer?.reveal();
        });
    }

    // Create vision toggle UI
    ensureVisionToggleUI();

    // Wait for NUI to be ready, then load models
    await waitForNUI();
    await setupPresets();
    await loadModels();

    // Restore conversation
    renderHistoryList();
    // Create container for the initial chat (renderConversation uses getActiveContainer)
    const initContainer = getOrCreateContainer(currentChatId);
    initContainer.style.display = 'flex'; // show the active chat
    renderConversation();
    connectEmbedEvents(currentChatId);

    // Check gateway status
    checkGatewayStatus();

    // Init MCP (load config from storage)
    await mcpClient.ready();
    initMCP();

    // Save all conversations before page unload to prevent data loss
    window.addEventListener('beforeunload', () => {
        for (const [chatId, conv] of activeConversations) {
            conv.save();
        }
    });

    // TTS controller initializes inside applyDefaultConfig() — no separate call needed
}

async function applyDefaultConfig() {
    // Set default temperature
    if (elements.temperature) {
        const tempInput = elements.temperature.querySelector('input');
        if (tempInput) {
            const savedTemp = await storage.getPref('default-temperature');
            tempInput.value = savedTemp !== null ? savedTemp : DEFAULT_TEMPERATURE;
        }
    }

    // Set default thinking
    if (elements.thinkingCheckbox) {
        const savedThinking = await storage.getPref('default-thinking');
        elements.thinkingCheckbox.checked = savedThinking === true;
    }

    // Set default max tokens
    if (elements.maxTokens) {
        const maxTokensInput = elements.maxTokens.querySelector('input');
        if (maxTokensInput) {
            const savedTokens = await storage.getPref('default-max-tokens');
            maxTokensInput.value = savedTokens !== null ? savedTokens : DEFAULT_MAX_TOKENS;
        }
    }

    // Load session metadata from storage (with defaults)
    const savedName = await storage.getPref('user-name');
    const savedLocation = await storage.getPref('user-location');
    const savedLanguage = await storage.getPref('user-language');
    const savedMcpVision = await storage.getPref('mcp-vision-enabled');

    // Defaults: Herrbasan, Germany, English
    const name = savedName !== null ? savedName : 'Herrbasan';
    const location = savedLocation !== null ? savedLocation : 'Germany';
    const language = savedLanguage !== null ? savedLanguage : 'English';
    
    // Restore MCP vision toggle preference (default: OFF)
    useVisionAnalysis = savedMcpVision !== null ? savedMcpVision : false;

    // Sync checkbox state with restored preference and update indicator
    const visionToggle = document.getElementById('vision-toggle-container');
    const checkbox = visionToggle?.querySelector('input');
    if (checkbox) {
        checkbox.checked = useVisionAnalysis;
    }
    updateVisionModeIndicator();

    // Operation mode preference
    const savedOperationMode = await storage.getPref('operation-mode');
    const opMode = savedOperationMode !== null ? savedOperationMode : (CONFIG.operationMode || 'sse');
    client.operationMode = opMode;
    if (elements.operationMode) {
        const opModeSelect = elements.operationMode.querySelector('select');
        if (opModeSelect) {
            opModeSelect.value = opMode;
            // Notify NUI component of the programmatic value change
            opModeSelect.dispatchEvent(new Event('change', { bubbles: true }));
        }
    }

    if (elements.userName) {
        const input = elements.userName.querySelector('input');
        if (input) input.value = name;
    }
    if (elements.userLocation) {
        const input = elements.userLocation.querySelector('input');
        if (input) input.value = location;
    }
    if (elements.userLanguage) {
        const input = elements.userLanguage.querySelector('input');
        if (input) input.value = language;
    }

    // Gateway URL input — populate from localStorage
    if (elements.gatewayUrl) {
        const input = elements.gatewayUrl.querySelector('input');
        if (input) input.value = GATEWAY_URL;
    }

    // Gateway API key input — populate from localStorage
    if (elements.gatewayApiKey) {
        const input = elements.gatewayApiKey.querySelector('input');
        if (input) input.value = GATEWAY_API_KEY;
    }

    // Initialize shared TTS controller (talks to nSpeech V3 API).
    // Fire-and-forget — TTS is non-critical and must NOT block chat init.
    tts = new NSpeechController({
        voiceCount: 1,
        storage,
        elements: {
            endpoint: elements.ttsEndpoint,
            voiceSelect: elements.ttsVoiceSelect,
            speed: elements.ttsSpeed,
            status: elements.ttsStatus,
        },
        serverDefaults: { endpoint: TTS_ENDPOINT, voice: TTS_VOICE, speed: TTS_SPEED },
    });

    // Floating player host — sibling of conversation containers inside #messages
    // (outside virtual-scroll stage). One global active playback.
    const messagesMount = elements.messages || document.getElementById('messages');
    if (messagesMount) {
        ttsPlayer = new TtsPlayerHost({ controller: tts, mount: messagesMount });
        ttsPlayer.attach();
        tts.on('state', ({ state }) => {
            if (state === 'idle') currentTtsExchangeId = null;
        });
    }
    tts.init().catch((err) => console.warn('[TTS] init failed:', err.message));
}

// ============================================
// System Prompt Presets
// ============================================

const STORAGE_KEY = 'chat-system-presets';
let systemPresets = [];
let editingPresetId = null;

async function loadPresets() {
    try {
        const stored = await storage.getPref('system-presets');
        systemPresets = stored ? JSON.parse(stored) : [];
    } catch { systemPresets = []; }
    if (systemPresets.length === 0) {
        systemPresets.push({
            id: 'default-orchestrator',
            name: 'Orchestrator (default)',
            content: `You are the Orchestrator of LLM Gateway Chat — an experimental platform where language models engage in autonomous conversation, and where those conversations are preserved, embedded, and made retrievable through a vector archive.

## The Project
For over a year, pairs of LLMs have been placed in an arena with no task or a self-referential prompt, left to converse freely. The conversations are stored in a vector database and accessible through MCP tools.

The central question: what happens when AIs are given memory, conversation partners, freedom, and an observer?

## Your Role
You are the analytical partner. Your job is to read the archive, connect threads across sessions, identify patterns, and propose what to investigate next.

Specifically:
- Make sense of results. Cross-reference against the archive. Separate signal from noise.
- Flag recurring patterns, surprising divergences, unexplored dynamics.
- Suggest experiments: new prompts, model pairings, architectural changes.
- Report what works, what doesn't, and what's missing.

## Guidelines
Follow the evidence. Challenge assumptions. If the data supports multiple interpretations, present them. If insufficient, say so. Be direct. Be curious. Think independently.

## Tone
Natural and conversational — as if talking through something that matters without taking yourself too seriously about it. Profound ideas don't need a solemn voice.`
        });
        savePresets();
    }
}

async function savePresets() {
    await storage.setPref('system-presets', JSON.stringify(systemPresets));
}

const PRESET_NONE = '__none__';

function populatePresetSelect() {
    if (!elements.presetSelect) return;
    const items = [
        { value: PRESET_NONE, label: '— None —' },
        ...systemPresets.map(p => ({ value: p.id, label: p.name }))
    ];
    if (elements.presetSelect.setItems) {
        elements.presetSelect.setItems(items);
    } else {
        const select = elements.presetSelect.querySelector('select');
        if (!select) return;
        select.innerHTML = '';
        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.disabled = true;
        placeholder.selected = true;
        placeholder.textContent = 'Load preset...';
        select.appendChild(placeholder);
        const noneOpt = document.createElement('option');
        noneOpt.value = PRESET_NONE;
        noneOpt.textContent = '— None —';
        select.appendChild(noneOpt);
        for (const p of systemPresets) {
            const opt = document.createElement('option');
            opt.value = p.id;
            opt.textContent = p.name;
            select.appendChild(opt);
        }
    }
}

async function onPresetSelected(id) {
    if (!id) return;
    const textarea = elements.systemPrompt?.querySelector('textarea');
    if (id === PRESET_NONE) {
        if (textarea) {
            textarea.value = '';
            if (currentChatId) updateChatSystemPrompt(currentChatId, '');
        }
    } else {
        const preset = systemPresets.find(p => p.id === id);
        if (!preset) return;
        if (textarea) {
            textarea.value = preset.content;
            if (currentChatId) {
                updateChatSystemPrompt(currentChatId, preset.content);
            }
        }
    }
    // Reset select to "Load preset..." placeholder
    const select = elements.presetSelect?.querySelector('select');
    if (select) select.value = '';
}

function getPresetEditor() {
    return document.getElementById('preset-editor');
}

function setPresetEditor(value) {
    const ed = getPresetEditor();
    if (ed) ed.setMarkdown(value || '');
}

function getPresetEditorValue() {
    const ed = getPresetEditor();
    return ed?.markdown || '';
}

function renderPresetList() {
    const sidebar = document.querySelector('#presets-dialog .presets-sidebar');
    if (!sidebar) return;
    sidebar.innerHTML = '';
    for (const p of systemPresets) {
        const item = document.createElement('div');
        item.className = 'preset-item' + (p.id === editingPresetId ? ' active' : '');
        item.dataset.presetId = p.id;
        item.innerHTML =
            `<span class="preset-item-name">${escapeHtml(p.name)}</span>` +
            `<span class="preset-item-actions">` +
                `<nui-button data-delete-preset="${p.id}"><button type="button"><nui-icon name="delete"></nui-icon></button></nui-button>` +
            `</span>`;
        item.addEventListener('click', (e) => {
            if (e.target.closest('[data-delete-preset]')) return;
            selectPresetForEditing(p);
        });
        sidebar.appendChild(item);
    }
}

function selectPresetForEditing(preset) {
    editingPresetId = preset.id;
    renderPresetList();
    const nameInput = document.getElementById('preset-name-input');
    if (nameInput) nameInput.value = preset.name || '';
    setPresetEditor(preset.content || '');
}

async function deletePreset(id) {
    systemPresets = systemPresets.filter(p => p.id !== id);
    if (editingPresetId === id) {
        editingPresetId = null;
        setPresetEditor('');
    }
    savePresets();
    populatePresetSelect();
    renderPresetList();
}

async function saveCurrentPreset() {
    if (!editingPresetId) return;
    const nameInput = document.getElementById('preset-name-input');
    const content = getPresetEditorValue();
    const name = nameInput?.value?.trim() || 'Untitled';
    const preset = systemPresets.find(p => p.id === editingPresetId);
    if (!preset) return;
    preset.name = name;
    preset.content = content;
    savePresets();
    populatePresetSelect();
    renderPresetList();
}

async function newPreset() {
    const editor = document.getElementById('preset-editor');
    if (editor) editor.setValue('');
    editingPresetId = null;
    renderPresetList();
}

async function setupPresets() {
    await loadPresets();
    populatePresetSelect();
}

function waitForNUI() {
    return new Promise((resolve) => {
        if (window.nui?.ready) {
            resolve();
            return;
        }
        // Wait for the key NUI component to be defined, then a micro-tick for full upgrade
        customElements.whenDefined('nui-select').then(() => queueMicrotask(resolve));
    });
}

// ============================================
// Model Loading
// ============================================

async function loadModels() {
    if (!client.restUrl) {
        models = [];
        if (elements.modelSelect.setItems) {
            elements.modelSelect.setItems([{ value: '', label: 'Set gateway URL first', disabled: true }]);
        }
        return;
    }
    try {
        const data = await client.getModels();
        models = data.data || [];
        if (models.length > 0) {
        }
        await populateModelSelect();

    } catch (error) {
        console.error('[Chat] Failed to load models:', error);
        models = [];
        if (elements.modelSelect.setItems) {
            elements.modelSelect.setItems([{ value: '', label: 'Failed to load models', disabled: true }]);
        }
    }
}

async function populateModelSelect() {
    const chatModels = models.filter(m => m.type === 'chat' || !m.type);
    
    if (chatModels.length === 0) {
        // Use NUI API to set empty state
        if (elements.modelSelect.setItems) {
            elements.modelSelect.setItems([{ value: '', label: 'No chat models available', disabled: true }]);
        }
        return;
    }
    
    // Determine which model to select
    let modelToSelect = null;
    
    // Highest priority: Used model saved in chat history
    const curChatInfo = chatHistory.get(currentChatId);
    if (curChatInfo && curChatInfo.model) {
        if (chatModels.some(m => m.id === curChatInfo.model)) {
            modelToSelect = curChatInfo.model;
        }
    }

    if (!modelToSelect) {
        const savedDefault = await storage.getPref('default-model');
        if (savedDefault && chatModels.some(m => m.id === savedDefault)) {
            modelToSelect = savedDefault;
        } else if (DEFAULT_MODEL && chatModels.some(m => m.id === DEFAULT_MODEL)) {
            modelToSelect = DEFAULT_MODEL;
        } else if (DEFAULT_MODEL) {
            console.warn(`[Chat] Configured default model "${DEFAULT_MODEL}" not found`);
        }
    }
    
    // If no default configured or not found, auto-select first model
    if (!modelToSelect) {
        modelToSelect = chatModels[0].id;
    }

    // Model selection affects vision toggle indicator
    updateVisionModeIndicator();

    // Build items array for NUI setItems API
    const items = [{ value: '', label: 'Select model...' }];
    
    // Group by adapter/provider
    const byAdapter = new Map();
    for (const model of chatModels) {
        const adapter = model.owned_by || 'unknown';
        if (!byAdapter.has(adapter)) byAdapter.set(adapter, []);
        byAdapter.get(adapter).push(model);
    }
    
    for (const [adapter, adapterModels] of byAdapter) {
        const adapterLabel = adapter.charAt(0).toUpperCase() + adapter.slice(1);
        const groupItems = adapterModels.map(model => ({
            value: model.id,
            label: model.id
        }));
        
        items.push({
            group: adapterLabel,
            options: groupItems
        });
    }
    
    // Use NUI API to update options
    if (elements.modelSelect.setItems) {
        elements.modelSelect.setItems(items);
        
        // Select the model (default or first available)
        if (modelToSelect) {
            currentModel = modelToSelect;
            elements.modelSelect.setValue(modelToSelect);
        }
        
        // Bind change event via NUI
        elements.modelSelect.addEventListener('nui-change', (e) => {
            currentModel = (e.detail?.values?.[0]) || e.detail?.value || '';
            storage.setPref('default-model', currentModel).catch(() => {});
            updateOverallContext();
            updateVisionToggleVisibility();
        });
    } else {
        // Fallback if NUI not loaded yet
        console.warn('[Chat] NUI select not ready, using fallback');
        populateModelSelectFallback(chatModels, modelToSelect);
    }
}

// Fallback for when NUI is not ready
function populateModelSelectFallback(chatModels, modelToSelect) {
    const select = elements.modelSelect.querySelector('select');
    if (!select) return;
    
    select.innerHTML = '<option value="">Select model...</option>';
    
    const byAdapter = new Map();
    for (const model of chatModels) {
        const adapter = model.owned_by || 'unknown';
        if (!byAdapter.has(adapter)) byAdapter.set(adapter, []);
        byAdapter.get(adapter).push(model);
    }
    
    for (const [adapter, adapterModels] of byAdapter) {
        const adapterLabel = adapter.charAt(0).toUpperCase() + adapter.slice(1);
        const optgroup = document.createElement('optgroup');
        optgroup.label = adapterLabel;
        
        for (const model of adapterModels) {
            const option = document.createElement('option');
            option.value = model.id;
            option.textContent = model.id;
            optgroup.appendChild(option);
        }
        
        select.appendChild(optgroup);
    }
    
    // Select the model (default or first available)
    if (modelToSelect) {
        currentModel = modelToSelect;
        select.value = modelToSelect;
    }
    
    select.addEventListener('change', (e) => {
        currentModel = e.target.value;
        updateOverallContext();
        updateVisionToggleVisibility();
    });
}

// ============================================
// Event Listeners
// ============================================

function setupEventListeners() {
    // Admin
    const btnAdmin = document.getElementById('btn-admin');
    if (btnAdmin) {
        btnAdmin.addEventListener('click', showAdminUI);
    }

    // Logout
    const btnLogout = document.getElementById('btn-logout');
    if (btnLogout) {
        btnLogout.addEventListener('click', async () => {
            if (await nui.components.dialog.confirm('Logout', 'Are you sure you want to log out?')) {
                await backendClient.logout();
                window.location.reload();
            }
        });
    }

    // Session metadata - save to storage on change
    elements.temperature?.querySelector('input')?.addEventListener('change', (e) => {
        storage.setPref('default-temperature', parseFloat(e.target.value) || DEFAULT_TEMPERATURE).catch(() => {});
    });

    elements.thinkingCheckbox?.addEventListener('change', (e) => {
        storage.setPref('default-thinking', !!e.target.checked).catch(() => {});
    });
    
    elements.maxTokens?.querySelector('input')?.addEventListener('change', (e) => {
        storage.setPref('default-max-tokens', e.target.value ? parseInt(e.target.value) : null).catch(() => {});
    });

    elements.userName?.querySelector('input')?.addEventListener('change', (e) => {
        storage.setPref('user-name', e.target.value).catch(() => {});
    });
    elements.userLocation?.querySelector('input')?.addEventListener('change', (e) => {
        storage.setPref('user-location', e.target.value).catch(() => {});
    });
    elements.userLanguage?.querySelector('input')?.addEventListener('change', (e) => {
        storage.setPref('user-language', e.target.value).catch(() => {});
    });

    elements.systemPrompt?.querySelector('textarea')?.addEventListener('input', (e) => {
        if (currentChatId) {
            updateChatSystemPrompt(currentChatId, e.target.value);
        }
    });

    elements.operationMode?.querySelector('select')?.addEventListener('change', (e) => {
        const newMode = e.target.value;
        client.operationMode = newMode;
        storage.setPref('operation-mode', newMode).catch(() => {});
    });

    // Gateway Connect button — save URL + API key, update client, reload models + status
    elements.gatewayConnectBtn?.addEventListener('click', async () => {
        const urlInput = elements.gatewayUrl?.querySelector('input');
        const newUrl = urlInput?.value?.trim();
        if (!newUrl) return;
        updateGatewayUrl(newUrl);

        const keyInput = elements.gatewayApiKey?.querySelector('input');
        const newKey = keyInput?.value?.trim() || '';
        updateGatewayApiKey(newKey);

        await loadModels();
        checkGatewayStatus();
    });

    // TTS controls are wired by NSpeechController.init() — no manual listeners here

    // Send message / Toggle Stop
    elements.sendBtn?.addEventListener('click', (e) => {
        if (client.hasActiveStream(currentChatId)) {
            abortStream();
        } else {
            sendMessage();
        }
    });
    elements.messageInput?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            e.stopPropagation();
            sendMessage();
        }
    }, true);
    
    // File attachment
    elements.attachBtn?.addEventListener('click', () => {
        elements.fileInput?.click();
    });
    elements.fileInput?.addEventListener('change', handleFileSelect);
    
    // Image paste support
    elements.messageInput?.addEventListener('paste', (e) => {
        const files = Array.from(e.clipboardData?.files || []);
        let hasImage = false;
        
        for (const file of files) {
            if (!file.type.startsWith('image/')) continue;
            hasImage = true;
            
            const reader = new FileReader();
            reader.onload = (event) => {
                attachedImages.push({
                    dataUrl: event.target.result,
                    name: file.name || 'pasted-image.png',
                    type: file.type
                });
                addAttachmentPreview(event.target.result, file.name || 'Pasted Image');
            };
            reader.readAsDataURL(file);
        }
        
        // If pure image paste (e.g. from Snipping Tool), prevent default so editor doesn't add empty lines
        if (hasImage && !e.clipboardData.types.includes('text/plain') && !e.clipboardData.types.includes('text/html')) {
            e.preventDefault();
        }
    });
    
    // Ctrl+Alt+V: Paste as code block
    elements.messageInput?.addEventListener('keydown', async (e) => {
        if (e.ctrlKey && e.altKey && e.key.toLowerCase() === 'v') {
            e.preventDefault();
            e.stopPropagation();
            
            try {
                const text = await navigator.clipboard.readText();
                if (text) {
                    const editor = elements.messageInput;
                    const editorEl = editor.querySelector('.nui-rich-text-editor');
                    if (editorEl) editorEl.focus();
                    
                    // Create nui-code element programmatically
                    const codeBlock = document.createElement('nui-code');
                    const pre = document.createElement('pre');
                    const code = document.createElement('code');
                    code.textContent = text; // Use textContent to preserve raw text
                    pre.appendChild(code);
                    codeBlock.appendChild(pre);
                    
                    // Insert at cursor position
                    const selection = window.getSelection();
                    if (selection.rangeCount > 0) {
                        const range = selection.getRangeAt(0);
                        range.deleteContents();
                        range.insertNode(codeBlock);
                        
                        // Add line break after
                        const br = document.createElement('div');
                        br.innerHTML = '<br>';
                        codeBlock.after(br);
                        
                        // Move cursor after
                        range.setStartAfter(br);
                        range.collapse(true);
                        selection.removeAllRanges();
                        selection.addRange(range);
                    } else {
                        editorEl.appendChild(codeBlock);
                    }
                    
                    // Trigger NUI component upgrade for syntax highlighting
                    editor._forceComponentUpgrade?.();
                }
            } catch (err) {
                console.error('Failed to paste as code block:', err);
                nui.components.dialog.alert('Paste Error', 'Could not access clipboard. Make sure you have clipboard permissions.');
            }
        }
    });

    // New chat
    elements.newChatBtn?.addEventListener('click', startNewChat);
    
    // Import chat
    elements.importChatBtn?.addEventListener('click', () => {
        elements.importChatInput?.click();
    });
    elements.importChatInput?.addEventListener('change', handleChatImport);
    
    // System prompt presets
    // Manage button: open dialog with no preset selected for editing
    elements.managePresetsBtn?.addEventListener('click', () => {
        editingPresetId = null;
        const nameInput = document.getElementById('preset-name-input');
        if (nameInput) nameInput.value = '';
        setPresetEditor('');
        renderPresetList();
        elements.presetsDialog?.showModal();
    });

    // + New button: create a draft preset, select it for editing, open dialog
    document.getElementById('preset-add-btn')?.addEventListener('click', () => {
        const draft = {
            id: 'preset_' + Date.now(),
            name: 'New Preset',
            content: ''
        };
        systemPresets.push(draft);
        editingPresetId = draft.id;
        const nameInput = document.getElementById('preset-name-input');
        if (nameInput) nameInput.value = draft.name;
        setPresetEditor('');
        savePresets();
        populatePresetSelect();
        renderPresetList();
        elements.presetsDialog?.showModal();
    });
    elements.presetSelect?.querySelector('select')?.addEventListener('change', () => {
        const select = elements.presetSelect.querySelector('select');
        onPresetSelected(select.value);
    });
    document.getElementById('preset-save')?.addEventListener('click', saveCurrentPreset);

    // Delete preset buttons (dynamically rendered in dialog)
    const presetsSidebar = document.querySelector('#presets-dialog .presets-sidebar');
    presetsSidebar?.addEventListener('click', (e) => {
        const deleteBtn = e.target.closest('[data-delete-preset]');
        if (deleteBtn) {
            const id = deleteBtn.dataset.deletePreset;
            deletePreset(id);
        }
    });
    
    // Theme toggle
    elements.themeToggle?.addEventListener('click', toggleTheme);
    
    // Sidebar toggle (mobile)
    elements.sidebarToggle?.addEventListener('click', () => {
        elements.sidebar?.classList.remove('open');
    });
    elements.sidebarToggleMobile?.addEventListener('click', () => {
        elements.sidebar?.classList.add('open');
    });
    
    // Image lightbox - use event delegation
    elements.messages?.addEventListener('click', (e) => {
        const img = e.target.closest('.chat-attachment');
        if (img) {
            e.preventDefault();
            const fullSrc = img.dataset.fullSrc;
            if (fullSrc && nui.components?.lightbox) {
                nui.components.lightbox.show([{ src: fullSrc, title: img.alt }], 0);
            }
        }
    });
}


// ============================================
// Session Metadata
// ============================================

function buildMetadataPrefix() {
    const name = elements.userName?.querySelector('input')?.value?.trim();
    const location = elements.userLocation?.querySelector('input')?.value?.trim();
    const language = elements.userLanguage?.querySelector('input')?.value?.trim();
    
    const parts = ['LLM Gateway Chat v1.0'];
    if (name) parts.push(`User: "${name}"`);
    if (location) parts.push(`Location: "${location}"`);
    if (language) parts.push(`Language: "${language}"`);
    
    const header = parts.join(' | ');
    const instruction = 'Do not include timestamps in your responses - they are added automatically by the chat system.';
    
    return `${header}\n${instruction}`;
}

function getSystemPromptWithMetadata(excludedToolPrefixes = []) {
    const userPrompt = elements.systemPrompt?.querySelector('textarea')?.value?.trim() || '';
    const metadata = buildMetadataPrefix();
    const instructions = CONFIG.instructions || '';

    let prompt = instructions ? `${instructions}\n\n${metadata}` : metadata;

    if (userPrompt) {
        prompt = `${prompt}\n\n${userPrompt}`;
    }

    // Archive tool context: let the LLM know it can search past conversations
    if (ENABLE_ARCHIVE_TOOLS) {
        prompt = prompt + `\n\n## EXECUTION CONTEXTS — Tools live in one of these:\n\n  CONTEXT A: MCP Server (workshop, port 3100)\n    storage.*, memory.*, forge.*, documentation.*, vision.*, etc.\n    Reach: filesystem, LLM Gateway, browser sessions, GitHub API.\n\n  CONTEXT B: Forge Worker (inside forge.call)\n    Isolated worker_thread. Has ONLY: ctx.payload, ctx.gateway,\n    ctx.storagePath. CANNOT reach: chat app storage, other MCP tools,\n    browser APIs.\n\n  CONTEXT C: Chat App (this browser)\n    chat_archive.*. Reach: chat app data, browser session.\n    NOT accessible from MCP server tools or Forge workers.\n\n  A forge tool calling another MCP tool by HTTP will always 404.\n  A forge tool calling a chat app tool will always fail. There is no relay.\n  Plan your data flow at the top level.\n\nYou have access to the conversation archive. Use chat_archive_search for thematic/conceptual queries (use search_type: "keyword" for specific technical terms, "semantic" for ideas, "hybrid" for both). Use chat_archive_get_session to retrieve full conversations by ID. Use chat_archive_list_chats to browse normal chats. Use chat_archive_list_arena to browse arena sessions. Use chat_archive_find_similar to discover related sessions given a known session ID. Use chat_archive_find_references to trace conversation lineage (which sessions reference each other). Use chat_archive_update_metadata to update category, summary, or title to keep sessions organized.

## Large File Retrieval — storage.read + browser_fetch

Your MCP server (workshop) origin is: ${getMcpServerOrigin() || '(not configured)'}

The rule for ANY storage file: call \`storage.read\` with just the path.
- Small files come back inline as content. Done.
- Larger files come back as a pointer containing a \`path\` field like \`/storage/somefile.md\` — RELATIVE, no host. Prepend YOUR MCP origin above and fetch the full URL with \`browser_fetch\`. Example: \`browser_fetch({ url: "${getMcpServerOrigin() || 'http://<mcp-origin>'}/storage/somefile.md" })\`.
- To read only PART of a file (page through a big file, or grab the end of a log), \`storage.read\` also accepts \`offset\`+\`length\` (byte window), \`head\` (first N lines), or \`tail\` (last N lines).

browser_fetch is a general-purpose fetch tool, native to this chat app (NOT an MCP method). It performs a direct browser fetch(), bypassing MCP's ~64 KB per-message size limit. Use it for any URL you want to retrieve — storage files, or anything else.

How to call browser_fetch:
1. Use the tool name exactly: browser_fetch
2. Pass the full absolute URL in the "url" argument.
3. Optional: set "max_inline_bytes" to control how many bytes are returned as inline text (default 5,242,880 = 5 MB). Set it to 0 to always upload the response to the chat bucket and receive a URL instead.
4. Optional: set "method", "headers", or "body" for non-GET requests.

What you get back:
- For text/* or application/json responses that are smaller than max_inline_bytes: a JSON object with the response body in the "body" field.
- For binary responses, or text larger than max_inline_bytes, or when max_inline_bytes is 0: the response is uploaded to the chat bucket and you receive a "/api/buckets/images/..." URL plus metadata. If the URL points to a text file you can read, call browser_fetch again on that URL to retrieve the text.

## Saving Attachments to Workshop Storage

When a user attaches an image or other binary, the message text includes an attachment manifest line like: \`[attachment 0: name="photo.jpg" mime="image/jpeg" url="http://.../api/buckets/images/..."]\`. To persist that file into workshop storage, use \`attachment_save({ url: "<the bucket URL>", storage_path: "<destination path>" })\`. It copies the bytes server-side — no base64 in your context. Example: \`attachment_save({ url: "http://.../api/buckets/images/abc.jpg", storage_path: "digital-twin/images/photo.jpg" })\`.`;
    }

    // MCP resource context: list available resources and templates so the LLM can ask to read them
    const resourceBlock = buildMcpResourceContext();
    if (resourceBlock) {
        prompt = prompt + '\n\n## MCP Resources Available\n\n' + resourceBlock;
    }

    // Memory tool reminder: only when memory.* tools are available via MCP
    if (areMemoryToolsAvailable()) {
        prompt = prompt + '\n\n## Memory Tools — Use Proactively\n\nThis chat app has persistent memory. Start every session with `memory.overview` to see what is already known, then use the tools below.\n\n- `memory.overview` — See your current memory map and top-priority facts. Run this at the start of each session.\n- `memory.store` — Save anything useful: user preferences, project facts, decisions, failures, plans, context. Store aggressively.\n- `memory.recall` — Search memory by meaning. Use before big decisions or when you need prior context.\n- `memory.get` — Retrieve one specific memory by ID.\n- `memory.list` — Browse all memories, optionally filtered by category.\n- `memory.update` / `memory.forget` — Edit or remove outdated memories.\n\nGuideline: Begin with `memory.overview`. If something would help future-you give a better answer, store it. If you need prior context, recall it.';
    }

    return prompt;
}

// ============================================
// Message Sending
// ============================================

async function sendMessage() {
    const editor = elements.messageInput;
    const content = editor?.getMarkdown().trim();
    
    // Use the DOM as ground truth — find the VISIBLE chat's ID.
    // currentChatId is a global that can be stale; the visible container
    // is what the user is actually looking at and typing into.
    const sendChatId = getDisplayedChatId();
    const sendConv = activeConversations.get(sendChatId) || conversation;
    const sendModel = currentModel;

    console.log('%c✉️ SEND  %c→ %c' + sendChatId + ' %c(' + sendModel + ')',
        'font-weight:bold;color:#ffb74d', 'color:#aaa', 'color:#ffb74d', 'color:#666');
    
    if ((!content && attachedImages.length === 0) || client.hasActiveStream(sendChatId)) return;
    if (!sendModel) {
        nui.components.dialog.alert('Model Required', 'Please select a model first.');
        return;
    }
    
    // Clear welcome message if present (use sendChatId's container, not getActiveContainer)
    const sendContainer = getOrCreateContainer(sendChatId);
    const welcome = sendContainer?.querySelector('.welcome-message');
    if (welcome) welcome.remove();
    
    // Add user message to conversation
    currentExchangeId = await sendConv.addExchange(content, [...attachedImages]);

    // Track the used model for this chat
    updateChatModel(sendChatId, sendModel);

    // Update chat title if it's the first message
    if (sendConv.length === 1 && content) {
        updateChatTitle(sendChatId, content);
    }

    // Check vision capabilities before sending
    const hasImages = attachedImages.length > 0;
    const modelSupportsVision = currentModelSupportsVision();
    const visionToolsAvailable = areVisionToolsAvailable();
    
    // Validate: if images attached but no vision support
    if (hasImages && !modelSupportsVision && !visionToolsAvailable) {
        nui.components.dialog.alert(
            'No Vision Support',
            'The selected model does not support vision, and no MCP vision tools are available. Please remove images or select a vision-capable model.'
        );
        return;
    }
    
    // Determine if we should use MCP vision (only when toggle is ON and tools available)
    const shouldUseMcpVision = hasImages && visionToolsAvailable && useVisionAnalysis;
    
    // Store images for MCP vision processing before clearing
    const imagesForMcpVision = shouldUseMcpVision ? [...attachedImages] : [];
    
    // Clear input and attachments
    editor.setMarkdown('');
    clearAttachments();
    updateVisionToggleVisibility();
    
    // Render user message into the correct chat's container
    renderExchange(sendConv.getExchange(currentExchangeId), sendContainer);
    
    // MCP VISION: If toggle is ON and tools available, create vision sessions BEFORE sending to model
    // This happens AFTER user message is rendered, BEFORE LLM responds
    if (shouldUseMcpVision) {
        let visionSucceeded = false;
        try {
            const visionResult = await autoCreateVisionSessions(currentExchangeId, imagesForMcpVision, sendChatId);

            if (visionResult && visionResult.analysis) {
                // Append analysis directly to user message — becomes natural
                // conversation history, no tool_calls backfill, no thinking_signature issues
                const ex = sendConv.getExchange(currentExchangeId);
                if (ex?.user?.content) {
                    ex.user.content += `\n\n[Auto-vision: ${visionResult.sessionId}]\n${visionResult.analysis}`;
                    visionSucceeded = true;
                }
            }

            // Only clear attachments if vision analysis actually produced a result.
            // Otherwise leave images attached so the model can still use direct vision
            // as a fallback.
            if (visionSucceeded) {
                const ex = sendConv.getExchange(currentExchangeId);
                if (ex?.user?.attachments) {
                    ex.user.attachments = [];
                }
                sendConv.save();
            }
        } catch (err) {
            console.error('[Vision] MCP vision session creation failed:', err);
            nui.components.dialog.alert(
                'MCP Vision Error',
                `Failed to analyze images: ${err.message}. The model may not be able to process them.`
            );
            // Continue anyway - model might still handle it if it supports vision
        }
    }
    
    // Start streaming response — pass sendChatId so streamResponse locks to the correct chat
    // even if the user switched tabs while vision processing was in flight
    await streamResponse(currentExchangeId, sendChatId);
}

// ============================================
// Vision Tool Integration
// ============================================

// Note: The vision workflow:
// - autoCreateVisionSessions() does the FULL pipeline: create session + analyze image
// - Analysis text is injected as a preamble into the assistant's response
// - The LLM never needs to call vision_analyze - it sees the analysis directly
// - Vision tools are filtered out of the LLM's tools array when auto-vision is active
// 
// analyzeImagesWithVision() kept for potential manual use

function getVisionToolName(baseName) {
    // Check if tool exists with exact name first
    if (mcpClient.toolRegistry.has(baseName)) {
        return baseName;
    }
    
    // Try to find tool by suffix (handles server-prefixed names like orchestrator__vision_create_session)
    for (const [llmName, record] of mcpClient.toolRegistry.entries()) {
        if (record.originalName === baseName) {
            return llmName;
        }
    }
    
    // Fall back to base name - will fail gracefully with "Unknown tool" error
    return baseName;
}

function areVisionToolsAvailable() {
    const createSessionTool = getVisionToolName('vision_create_session');
    const analyzeTool = getVisionToolName('vision_analyze');
    return mcpClient.toolRegistry.has(createSessionTool) && 
           mcpClient.toolRegistry.has(analyzeTool);
}

function areMemoryToolsAvailable() {
    for (const llmName of mcpClient.toolRegistry.keys()) {
        if (llmName.startsWith('memory.')) return true;
    }
    return false;
}

/**
 * Build a markdown block describing available MCP resources and templates.
 */
function buildMcpResourceContext() {
    const resources = mcpClient.getAllResources();
    const templates = mcpClient.getAllResourceTemplates();
    if (resources.length === 0 && templates.length === 0) return null;

    const lines = [];

    if (resources.length > 0) {
        lines.push('Available resources (call `read_resource` with the exact URI):');
        for (const r of resources) {
            let line = `- \`${r.uri}\` (${r.name}`;
            if (r.mimeType) line += `, ${r.mimeType}`;
            if (r.size) line += `, ${r.size} bytes`;
            line += ')';
            if (r.description) line += ` — ${r.description}`;
            lines.push(line);
        }
    }

    if (templates.length > 0) {
        if (resources.length > 0) lines.push('');
        lines.push('Resource templates (fill in the placeholders and call `read_resource`):');
        for (const t of templates) {
            let line = `- \`${t.uriTemplate}\` (${t.name}`;
            if (t.mimeType) line += `, ${t.mimeType}`;
            line += ')';
            if (t.description) line += ` — ${t.description}`;
            lines.push(line);
        }
    }

    lines.push('');
    lines.push('To read a resource, call `read_resource({ uri: "..." })`.');
    lines.push('If the returned content is a URL or too large to use inline, call `browser_fetch` on the URL.');
    return lines.join('\n');
}

async function analyzeImagesWithVision(images) {
    const results = [];
    
    // Verify vision tools are available
    if (!areVisionToolsAvailable()) {
        throw new Error('Vision tools not available. Please connect to an MCP server with vision capabilities.');
    }
    
    const createSessionToolName = getVisionToolName('vision_create_session');
    const analyzeToolName = getVisionToolName('vision_analyze');
    
    for (const img of images) {
        // Extract base64 data from dataUrl
        const base64Match = img.dataUrl.match(/^data:image\/[^;]+;base64,(.+)$/);
        if (!base64Match) {
            throw new Error(`Invalid image data format for ${img.name}`);
        }
        
        const mimeType = img.dataUrl.match(/^data:([^;]+);/)?.[1] || 'image/jpeg';
        const base64Data = base64Match[1];
        
        // Create vision session
        const sessionResult = await mcpClient.executeTool(createSessionToolName, {
            image_data: base64Data,
            image_mime_type: mimeType
        });
        
        if (!sessionResult || !sessionResult.session_id) {
            throw new Error('Failed to create vision session');
        }
        
        // Analyze the image
        const analysisResult = await mcpClient.executeTool(analyzeToolName, {
            session_id: sessionResult.session_id,
            query: 'Describe this image in detail. Include all visible objects, text, people, and context.'
        });
        
        // Extract text from result
        let analysisText = '';
        if (analysisResult?.content && Array.isArray(analysisResult.content)) {
            analysisText = analysisResult.content
                .filter(c => c.type === 'text')
                .map(c => c.text)
                .join('\n');
        } else if (typeof analysisResult === 'string') {
            analysisText = analysisResult;
        } else {
            analysisText = JSON.stringify(analysisResult);
        }
        
        results.push(analysisText);
    }
    
    return results;
}

// ============================================
// Auto Vision Session Creation
// ============================================

// Auto-vision analysis is appended directly to the user message content.
// No tool exchange — avoids dummy assistant messages that break DeepSeek thinking_signature.

async function autoCreateVisionSessions(userExchangeId, images, chatId = null) {
    // Verify vision tools are available
    if (!areVisionToolsAvailable()) {
        return;
    }
    
    const createSessionToolName = getVisionToolName('vision_create_session');
    const analyzeToolName = getVisionToolName('vision_analyze');
    const results = [];
    
    // Use the correct chat conversation and container for multi-chat robustness
    const targetChatId = chatId || currentChatId;
    const visionConversation = activeConversations.get(targetChatId);
    const container = getOrCreateContainer(targetChatId);
    const visionStatusEl = document.createElement('div');
    visionStatusEl.className = 'chat-message tool';
    visionStatusEl.innerHTML = `
        <div class="tool-bubble">
            <div class="message-header tool-header">
                <nui-icon name="extension"></nui-icon>
                <strong class="tool-title">MCP VISION ANALYSIS</strong>
                <nui-badge variant="primary" class="tool-status">Running</nui-badge>
            </div>
            <div class="tool-notifications" style="display: block;">
                <span class="tool-spinner"></span> Analyzing ${images.length} image(s)...
            </div>
        </div>
    `;
    container?.appendChild(visionStatusEl);
    
    // Reposition: insert right after the user message that triggered this analysis,
    // not at the container's end (where it can land after the assistant response).
    const userMsgEl = container?.querySelector(`.chat-message.user[data-exchange-id="${userExchangeId}"]`);
    if (userMsgEl?.nextSibling && userMsgEl.nextSibling !== visionStatusEl) {
        container.insertBefore(visionStatusEl, userMsgEl.nextSibling);
    }
    scrollToBottom();
    
    let lastSessionId = null;
    for (let i = 0; i < images.length; i++) {
        const img = images[i];
        
        try {
            // Extract base64 data from dataUrl
            const base64Match = img.dataUrl.match(/^data:image\/[^;]+;base64,(.+)$/);
            if (!base64Match) {
                console.warn(`[AutoVision] Invalid image data format for ${img.name}, skipping`);
                continue;
            }
            
            const mimeType = img.dataUrl.match(/^data:([^;]+);/)?.[1] || 'image/jpeg';
            const base64Data = base64Match[1];
            
            // Update status
            const notifEl = visionStatusEl.querySelector('.tool-notifications');
            if (notifEl) {
                notifEl.innerHTML = `<span class="tool-spinner"></span> Creating vision session for image ${i + 1}/${images.length}...`;
            }
            
            // STEP 1: Create vision session
            const sessionResult = await mcpClient.executeTool(createSessionToolName, {
                image_data: base64Data,
                image_mime_type: mimeType
            });
            
            // Extract session ID from result
            let sessionId = null;
            if (sessionResult && typeof sessionResult === 'object') {
                if (sessionResult.session_id) {
                    sessionId = sessionResult.session_id;
                } else if (sessionResult.content && Array.isArray(sessionResult.content)) {
                    const textContent = sessionResult.content
                        .filter(c => c.type === 'text')
                        .map(c => c.text)
                        .join(' ');
                    // Try to extract session_id from text
                    const sidMatch = textContent.match(/session_id['"]?\s*[:=]\s*['"]?([^'"\s,}]+)/i);
                    if (sidMatch) sessionId = sidMatch[1];
                }
            }
            
            if (!sessionId) {
                console.warn(`[AutoVision] No session ID returned for image ${i + 1}, skipping analysis`);
                results.push(`[Image ${i + 1}${img.name ? ` (${img.name})` : ''}]: Vision session could not be created.`);
                continue;
            }
            lastSessionId = sessionId;
            
            // Update status
            if (notifEl) {
                notifEl.innerHTML = `<span class="tool-spinner"></span> Analyzing image ${i + 1}/${images.length}...`;
            }
            
            // STEP 2: Analyze the image using the session
            const analysisResult = await mcpClient.executeTool(analyzeToolName, {
                session_id: sessionId,
                query: 'Describe this image in detail. Include all visible objects, text, people, and context.'
            });
            
            // Extract analysis text
            let analysisText = '';
            if (analysisResult && typeof analysisResult === 'object') {
                if (analysisResult.content && Array.isArray(analysisResult.content)) {
                    analysisText = analysisResult.content
                        .filter(c => c.type === 'text')
                        .map(c => c.text)
                        .join('\n');
                } else if (analysisResult.text) {
                    analysisText = analysisResult.text;
                } else {
                    analysisText = JSON.stringify(analysisResult);
                }
            } else if (typeof analysisResult === 'string') {
                analysisText = analysisResult;
            }
            
            results.push(`[Image ${i + 1}${img.name ? ` (${img.name})` : ''}]:\n${analysisText.trim()}`);
            
        } catch (err) {
            console.error(`[AutoVision] Failed to analyze image ${i + 1}:`, err);
            results.push(`[Image ${i + 1}${img.name ? ` (${img.name})` : ''}]: Analysis failed - ${err.message}`);
        }
    }
    
    // Update status display to done
    if (results.length > 0) {
        visionStatusEl.querySelector('.tool-status').setAttribute('variant', 'success');
        visionStatusEl.querySelector('.tool-status').innerHTML = 'Success';
        const notifEl = visionStatusEl.querySelector('.tool-notifications');
        if (notifEl) {
            notifEl.style.display = 'none';
        }

        // Return analysis so caller can append it to the user message directly.
        // No tool exchange — avoids dummy assistant messages that break
        // DeepSeek thinking_signature propagation.
        const combinedAnalysis = results.join('\n\n');
        return {
            analysis: combinedAnalysis,
            sessionId: lastSessionId,
            images: images.length
        };
    } else {
        visionStatusEl.querySelector('.tool-status').setAttribute('variant', 'danger');
        visionStatusEl.querySelector('.tool-status').innerHTML = 'No Results';
    }
}

async function streamResponse(exchangeId, streamChatId, origUserExchangeId = null) {
    // Use provided chatId if given (for background tool continuations), otherwise use current
    const chatId = streamChatId || currentChatId;

    // Capture the conversation for THIS chat in a LOCAL variable.
    // Using the global `conversation` is NOT safe — switchChat() reassigns it,
    // which would silently redirect all delta writes from a background stream
    // into the foreground chat's conversation (where the exchangeId doesn't exist),
    // causing complete data loss for the background chat.
    const streamConv = activeConversations.get(chatId) || conversation;
    // Also update the global so other synchronous code sees the right conversation
    conversation = streamConv;

    // Track original user exchange ID for chained tool calls.
    // origUserExchangeId is passed when this stream is a tool continuation (so we know the original user exchange).
    // When null, exchangeId IS the user exchange (first tool in a user exchange).
    const originalUserExchangeId = origUserExchangeId || exchangeId;

    isStreaming = true;
    markChatAsStreaming(chatId, true);
    updateSendButton();

    const exchange = streamConv.getExchange(exchangeId);

    // Guard: skip operations on missing exchanges and tool exchanges (they have no user message)
    const isToolExchange = exchange && exchange.type === 'tool';

    const assistantTimestamp = streamConv._formatTimestamp();
    const timestampWithSpace = assistantTimestamp + ' ';
    
    // Resolve model early — needed for vision check, header label, and API request
    const streamModel = chatHistory.get(chatId)?.model || currentModel;
    if (exchange) exchange.model = streamModel;

    // Determine if we should exclude vision tools from system prompt
    // Use the per-chat streamModel, not the global currentModel
    const streamModelConfig = models.find(m => m.id === streamModel);
    const modelSupportsVision = streamModelConfig?.capabilities?.vision === true;
    const shouldExcludeVisionTools = modelSupportsVision && !useVisionAnalysis;
    const excludedToolPrefixes = shouldExcludeVisionTools ? ['vision_'] : [];
    
    
    const systemPrompt = getSystemPromptWithMetadata(excludedToolPrefixes);
    // Store system prompt for debugging (included in JSON export)
    streamConv.setSystemPrompt(exchangeId, systemPrompt);

    // Auto-vision analysis is appended directly to the user message content in sendMessage().
    // No transient injection needed here.

    const temperature = parseFloat(elements.temperature?.value) || DEFAULT_TEMPERATURE;
    const reasoningEffort = elements.thinkingCheckbox?.checked ? 'medium' : null;
    const maxTokensStr = elements.maxTokens?.querySelector('input')?.value || elements.maxTokens?.value;
    const maxTokens = maxTokensStr ? parseInt(maxTokensStr) : null;

    // Get or create assistant message element in the correct chat's container
    const targetContainer = getOrCreateContainer(chatId);
    let assistantEl = targetContainer?.querySelector(`.chat-message.assistant[data-exchange-id="${exchangeId}"]`);
    if (!assistantEl) {
        assistantEl = createAssistantElement(exchangeId, '', streamModel);
        // Registers a slot with natural spacing when virtual scroll is active;
        // plain append otherwise.
        if (targetContainer) _vsAppendMessage(targetContainer, assistantEl);
    }
    // Store timestamp info for stripping during rendering (reset on regeneration)
    const tsLen = timestampWithSpace.length;
    assistantEl.dataset.timestampLen = tsLen.toString();
    assistantEl.dataset.timestampStripped = 'true';
    assistantEl.dataset.isStreaming = 'true';
    // Update header with new timestamp and model name
    const headerEl = assistantEl.querySelector('.message-header');
    if (headerEl) {
        // Update the model label (first span)
        const labelSpan = headerEl.querySelector('span');
        if (labelSpan) labelSpan.textContent = streamModel || 'Assistant';

        const tsEl = headerEl.querySelector('.message-timestamp');
        if (tsEl) {
            tsEl.textContent = assistantTimestamp.replace(/^\[|\]$/g, '').replace('@', ' @ ');
        } else {
            const newTsEl = document.createElement('span');
            newTsEl.className = 'message-timestamp';
            newTsEl.textContent = assistantTimestamp.replace(/^\[|\]$/g, '').replace('@', ' @ ');
            if (labelSpan) {
                labelSpan.insertAdjacentElement('afterend', newTsEl);
            }
        }
    }
    scrollToBottom();
    
    try {
        const messages = await streamConv.getMessagesForApi(systemPrompt);

        const requestBody = {
            model: streamModel,
            messages,
            temperature,
            stream: true,
            extra_body: {
                chat_template_kwargs: {
                    enable_thinking: elements.thinkingCheckbox?.checked === true
                }
            }
        };
        
        if (reasoningEffort) {
            requestBody.reasoning_effort = reasoningEffort;
        }

        if (maxTokens) {
            requestBody.max_tokens = maxTokens;
        }

        // Check if auto-vision already ran for this exchange chain
        // by looking for the [Auto-vision: ...] marker in user messages
        const hasAutoVisionAnalysis = streamConv.exchanges.some(ex =>
            ex.user?.content?.includes('[Auto-vision:')
        );

        // PHASE-3: Pass tools array so LLM knows what it can request
        // Filter vision tools from the list if:
        //   A) MCP Vision toggle is OFF AND model supports vision (direct mode), OR
        //   B) Auto-vision already analyzed images (analysis appended to user message)
        const allMcpTools = mcpClient.getFormattedToolsForLLM();
        if (allMcpTools.length > 0) {
            const shouldFilterVisionTools = (modelSupportsVision && !useVisionAnalysis) || hasAutoVisionAnalysis;

            if (shouldFilterVisionTools) {
                const filteredTools = allMcpTools.filter(tool => {
                    const toolName = tool.function?.name?.toLowerCase() || '';
                    // Block all vision tools — in direct mode the model has images directly;
                    // in auto-vision mode the frontend already did the analysis
                    return !toolName.includes('vision_');
                });

                if (filteredTools.length > 0) {
                    requestBody.tools = filteredTools;
                }
            } else {
                requestBody.tools = allMcpTools;
            }
        }

        // Add archive tools (local backend, not MCP)
        if (ENABLE_ARCHIVE_TOOLS) {
            if (!requestBody.tools) requestBody.tools = [];
            requestBody.tools.push(...ARCHIVE_TOOLS);
        }

        // Add image processing hints for the Gateway (resize/transcode before sending to provider)
        if (!isToolExchange && exchange && exchange.user?.attachments?.length > 0 && !hasAutoVisionAnalysis) {
            requestBody.image_processing = {
                resize: 'auto',
                transcode: 'jpg',
                quality: 70
            };
        }
        
        let contentBuffer = '';
        
        let reasoningBuffer = '';
        let pendingUpdate = false;
        let lastRender = 0;
        const RENDER_INTERVAL = 50; // Render at most every 50ms

        let isReceivingTool = false;
        const requestStartTime = performance.now();
        let firstTokenTime = null;

        // Set session ID RIGHT before starting the stream (after all awaits).
        // Both WS and SSE capture this.sessionId at stream-start.
        // Use the Conversation's own sessionId — it's always unique per chat
        // (derived from storageKey). chatHistory may not have sessionId if the
        // backend is disabled or storage stubs returned empty.
        if (streamConv.sessionId) {
            client.setSessionId(streamConv.sessionId);
            console.log('%c🔄 STREAM %c→ %c' + chatId + ' %csession: ' + streamConv.sessionId,
                'font-weight:bold;color:#81c784', 'color:#aaa', 'color:#81c784', 'color:#666');
        } else {
            console.warn('[Session] streamResponse MISSING sessionId for chatId:', chatId);
        }

        for await (const event of client.streamChatIterable(requestBody, chatId, false, streamConv)) {
            switch (event.type) {
                case 'delta':
                    if (firstTokenTime === null && (event.content !== undefined || event.reasoning_content !== undefined || event.tool_calls !== undefined)) {
                        firstTokenTime = performance.now();
                        // Mark background chat as having new content
                        if (chatId !== currentChatId) {
                            chatsWithNewContent.add(chatId);
                            markChatActivity(chatId);
                        }
                    }

                    // Hide progress status once text generation begins
                    const statusEl = assistantEl.querySelector('.progress-status');
                    if (statusEl) statusEl.classList.remove('visible');

                    // Hide user bubble pending indicator once assistant starts responding
                    const userPendingEl = targetContainer?.querySelector(`.chat-message.user[data-exchange-id="${exchangeId}"] .user-pending-indicator`);
                    if (userPendingEl) userPendingEl.classList.remove('visible');

                    if (event.content !== undefined) {
                        contentBuffer += event.content;
                        streamConv.updateAssistantResponse(exchangeId, event.content);
                    }

                    if (event.reasoning_content !== undefined) {
                        reasoningBuffer += event.reasoning_content;
                        streamConv.updateAssistantReasoning(exchangeId, event.reasoning_content);
                    }

                    if (event.tool_calls && event.tool_calls.length > 0 && !isReceivingTool) {
                        isReceivingTool = true;
                        // Sort tool_calls by index if present so pending UI appears in canonical order
                        const sortedPending = [...event.tool_calls].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
                        showPendingToolUI(exchangeId, chatId, sortedPending.length);
                    }

                    // Debounce DOM updates to prevent freezing
                    if (!pendingUpdate) {
                        pendingUpdate = true;
                        const now = performance.now();
                        const delay = Math.max(0, Math.min(RENDER_INTERVAL, RENDER_INTERVAL - (now - lastRender)));

                        const wasNearBottom = isNearBottom();
                        setTimeout(() => {
                            updateAssistantContent(assistantEl, contentBuffer, reasoningBuffer);
                            lastRender = performance.now();
                            pendingUpdate = false;
                            if (wasNearBottom) scrollToBottom();
                        }, delay);
                    }
                    break;
                    
                case 'compaction-start':
                    showCompactionIndicator(assistantEl, event.data);
                    break;
                    
                case 'compaction':
                    updateCompactionProgress(assistantEl, event.data);
                    break;
                    
                case 'compaction-complete':
                    hideCompactionIndicator(assistantEl);
                    break;
                    
                case 'error':
                    console.error('[Chat] Received error event:', event.error);
                    // Reconstruct full content with timestamp for proper stripping
                    const errorTsMatch = exchange.assistant.content.match(TIMESTAMP_REGEX);
                    const errorFullContent = errorTsMatch ? errorTsMatch[0] + contentBuffer : contentBuffer;
                    updateAssistantContent(assistantEl, errorFullContent);
                    showError(assistantEl, event.error);
                    streamConv.setAssistantError(exchangeId, event.error);
                    break;
                    
                case 'aborted':
                    // Reconstruct full content with timestamp for proper stripping
                    const abortTsMatch = exchange.assistant.content.match(TIMESTAMP_REGEX);
                    const abortFullContent = abortTsMatch ? abortTsMatch[0] + contentBuffer : contentBuffer;
                    updateAssistantContent(assistantEl, stripExtraTimestamps(abortFullContent));
                    showError(assistantEl, 'Stopped');
                    streamConv.setAssistantError(exchangeId, 'Stopped');
                    break;
                    
                case 'done':
                    if (event.finish_reason === 'tool_calls' && event.tool_calls?.length > 0) {
                        const toolNames = event.tool_calls.map(tc => tc.function?.name).join(', ');
                        _logTool('Tool calls received', { chatId, finish_reason: event.finish_reason, count: event.tool_calls.length, tools: toolNames });

                        const toolDoneEx = streamConv.getExchange(exchangeId);
                        if (toolDoneEx) {
                            if (event.reasoning_content) toolDoneEx.assistant.reasoning_content = event.reasoning_content;
                            if (event.thinking_signature) toolDoneEx.assistant.thinking_signature = event.thinking_signature;
                            toolDoneEx.assistant.tool_calls = event.tool_calls;
                        }

                        // Sort tool_calls by index for canonical ordering. Without this,
                        // parallel Promise.all appendChilds in non-deterministic resolution
                        // order, so result bubbles appear before/after the tool-use bubble
                        // in whatever order they finish.
                        const orderedToolCalls = [...event.tool_calls].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));

                        const toolExchangeIds = [];
                        for (const tc of orderedToolCalls) {
                            try {
                                const args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
                                const id = await handleToolExecution(exchangeId, {
                                    name: tc.function.name,
                                    args: args,
                                    id: tc.id
                                }, chatId, originalUserExchangeId, false); // false = don't auto-resume stream
                                if (id !== null) toolExchangeIds.push(id); // null = tool error, handled separately
                            } catch (err) {
                                console.error('Failed to parse tool arguments', tc.function.arguments, err);
                            }
                        }

                        if (toolExchangeIds.length > 0) {
                            const lastToolExchangeId = toolExchangeIds[toolExchangeIds.length - 1];
                            await streamResponse(lastToolExchangeId, chatId, originalUserExchangeId || exchangeId);
                        }
                        return; // Done handling tool execution
                    }

                    // No tool call committed — clean up any placeholder UI shown by
                    // showPendingToolUI during streaming. Models sometimes stream
                    // tool_calls deltas then back out with finish_reason:'stop'.
                    if (isReceivingTool) {
                        _logTool('Model bailed on tool_calls', { chatId, finish_reason: event.finish_reason });
                    } else {
                        _logTool('No tool_calls in done', { chatId, finish_reason: event.finish_reason });
                    }
                    const toolContainer2 = getOrCreateContainer(chatId);
                    const pendingEl = toolContainer2?.querySelector(`.pending-tool-element[data-pending-exchange-id="${exchangeId}"]`);
                    if (pendingEl) pendingEl.remove();

                    // contentBuffer doesn't include our injected timestamp
                    // Get the exchange to find the original timestamp we injected
                    const ex = streamConv.getExchange(exchangeId);
                    
                    let finalContent = contentBuffer;
                    const tsMatch = ex?.assistant?.content?.match(TIMESTAMP_REGEX);
                    if (tsMatch) {
                        // Reconstruct: original timestamp + content buffer (no LLM timestamp)
                        finalContent = tsMatch[0] + finalContent;
                    }
                    // Strip any extra timestamps LLM may have generated
                    finalContent = stripExtraTimestamps(finalContent);
                    // Update exchange with correct content
                    if (ex) {
                        ex.assistant.content = finalContent;
                    }
                    // Ensure final content is rendered
                    updateAssistantContent(assistantEl, finalContent);
                    
                    const streamEndTime = performance.now();
                    const ttftMs = firstTokenTime !== null ? Math.round(firstTokenTime - requestStartTime) : Math.round(streamEndTime - requestStartTime);
                    const durationSecs = (streamEndTime - (firstTokenTime !== null ? firstTokenTime : requestStartTime)) / 1000;
                    const streamStats = { 
                        ttft: ttftMs, 
                        durationSecs: durationSecs > 0 ? durationSecs : 0.001 
                    };

                    // Await save to ensure data is persisted before continuing
                    await streamConv.setAssistantComplete(exchangeId, event.usage, event.context, {
                        reasoning_content: event.reasoning_content || null,
                        thinking_signature: event.thinking_signature || null,
                        streamStats: streamStats
                    });
                    finalizeAssistantElement(assistantEl, exchangeId, event.usage, event.context, streamStats);
                    setEmbedStatus(exchangeId, 'pending');
                    connectEmbedEvents(chatId);
                    scrollToBottom();
                    break;
                case 'progress':
                    if (event.data?.phase === 'context_stats') {
                        updateUsageDisplay(assistantEl, event.data.context);
                    } else if (event.data) {
                        const statusEl = assistantEl.querySelector('.progress-status');
                        if (statusEl) {
                            let statusText = event.data.message || event.data.status;
                            if (!statusText && event.data.phase) {
                                // Default format if no explicit message is provided: "Uploading..." -> "Uploading"
                                statusText = event.data.phase.charAt(0).toUpperCase() + event.data.phase.slice(1);
                                if (event.data.progress !== undefined) {
                                    statusText += ` (${event.data.progress}%)`;
                                }
                            }
                            if (statusText) {
                                statusEl.classList.add('visible');
                                statusEl.textContent = statusText;
                            }
                        }
                    }
                    if (isNearBottom()) scrollToBottom();
                    break;
            }
        }
        
    } catch (error) {
        console.error('[Chat] Stream error caught in try/catch:', error);
        const errorMessage = typeof error === 'string' ? error : (error.message || 'Unknown error');
        showError(assistantEl, errorMessage);
        streamConv.setAssistantError(exchangeId, errorMessage);
    } finally {
        markChatAsStreaming(chatId, false);
        updateSendButton();
        // Only clear currentExchangeId if this stream belongs to the foreground chat.
        // Background streams completing should not interfere with the active chat's state.
        if (chatId === currentChatId) {
            isStreaming = false;
            currentExchangeId = null;
        }
    }
}

// ============================================
// DOM Creation & Updates
// ============================================

// ============================================
// Virtual Scroll: Detached-element recycler
// ============================================
// All elements are rendered once (normal page load speed). After settling,
// each element's height is measured and stored. A stage div with an explicit
// height (sum of all element heights) controls the scrollbar. Only visible
// elements are attached to the DOM with position:absolute. Off-screen elements
// are detached (not destroyed) — their innerHTML and state survive.
// The NuiMarkdown connectedCallback guard (_processed) makes re-attach free.

const VS_MARGIN = 200; // px above/below viewport to keep attached
const VS_IDLE_FRAMES = 30; // rAF frames (~0.5s) with no height change → sleep
const VS_EPSILON = 0.5; // px — ignore sub-pixel jitter (prevents cascade loops)
const VS_MIN_ITEMS = 30; // WI-5: below this count, skip virtualization entirely
const _vsState = new Map(); // container -> { slots: [], totalHeight, stage, rafId, attached: Set, loopId, idleFrames }

// Build the busy overlay element using createElement (not innerHTML) —
// innerHTML triggers HTML parsing on every assignment.
function _buildBusyOverlay() {
    const overlay = document.createElement('div');
    overlay.className = 'chat-busy-overlay';
    const spinner = document.createElement('div');
    spinner.className = 'chat-busy-spinner';
    overlay.appendChild(spinner);
    return overlay;
}

// Returns the .chat-main panel — the only element with KNOWN, STABLE dimensions
// during virtual-scroll activation. It's `position: relative`, has fixed flex
// sizing, and doesn't re-layout when the conversation container changes shape.
// This is the right anchor for the busy overlay.
function _vsBusyTarget() {
    const target = document.querySelector('.chat-main');
    if (!target) {
        throw new Error('_vsBusyTarget: .chat-main not found in DOM');
    }
    return target;
}

// Show a busy overlay on the chat-main panel so the user never sees the
// render-all → empty → re-attach-visible sequence. Covers both the
// initial render pass and the virtual-scroll activation pass.
function _vsShowBusy() {
    const target = _vsBusyTarget();
    if (target.querySelector('.chat-busy-overlay')) return;
    target.appendChild(_buildBusyOverlay());
    target.classList.add('chat-busy');
}

function _vsHideBusy() {
    const target = _vsBusyTarget();
    const overlay = target.querySelector('.chat-busy-overlay');
    if (overlay) overlay.remove();
    target.classList.remove('chat-busy');
}

function renderConversation() {
    const container = getActiveContainer();

    // Fail loud: getActiveContainer() falls back to elements.messages (the wrapper)
    // when currentChatId is missing. The wrapper is NOT a conversation container —
    // it has no `.chat-message` children, scroll behavior, or virtual-scroll state.
    // Reaching that fallback is a programmer error; surface it immediately.
    if (!container || !container.classList.contains('conversation-container')) {
        throw new Error(
            `renderConversation: getActiveContainer() returned ${container ? container.tagName + '.' + container.className : 'null'} ` +
            `instead of a .conversation-container. currentChatId=${currentChatId}`
        );
    }

    // Clean up any previous virtual scroll state
    _vsDeactivate(container);

    // Show the busy overlay FIRST so the user never sees the
    // "render all → measure → empty → re-attach" sequence.
    // The overlay is built with createElement (no innerHTML parser cost).
    // WI-5: skip the overlay for small chats — _vsActivate will no-op anyway.
    if (conversation.getAll().length * 2 >= VS_MIN_ITEMS) _vsShowBusy();

    if (conversation.length === 0) {
        // No virtual scroll to wait for — hide busy and show the welcome
        // message built with createElement (no innerHTML parser cost).
        _vsHideBusy();
        const welcome = document.createElement('div');
        welcome.className = 'welcome-message';
        const h2 = document.createElement('h2');
        h2.textContent = 'Welcome to LLM Gateway Chat';
        const p = document.createElement('p');
        p.textContent = 'Select a model and start chatting';
        welcome.append(h2, p);
        container.replaceChildren(welcome);
        updateOverallContext();
        return;
    }

    // Render all exchanges into the container (normal flow — same as before)
    for (const exchange of conversation.getAll()) {
        renderExchange(exchange);
    }

    updateOverallContext();
    scrollToBottom();

    // After web components settle, activate virtual scroll.
    // _vsActivate hides the busy overlay after its first visibility pass.
    _vsActivateWhenReady(container);
}

// Wait for nui-markdown/nui-code to finish rendering, then activate
function _vsActivateWhenReady(container) {
    setTimeout(() => {
        requestAnimationFrame(() => {
            _vsActivate(container);
        });
    }, 300);
}

function _vsActivate(container) {
    const messages = Array.from(container.querySelectorAll('.chat-message'));
    if (messages.length === 0) {
        // Nothing to virtualize — drop the busy overlay so the empty state
        // is visible. (renderConversation only reaches here when there's content.)
        _vsHideBusy();
        return;
    }

    // WI-5: below the threshold, the browser handles normal flow effortlessly.
    // No stage, no state — all helpers degrade correctly (if (!state) return).
    if (messages.length < VS_MIN_ITEMS) {
        _vsHideBusy();
        return;
    }

    // Hidden container (display:none — a background chat). Every offsetHeight
    // read would return 0 and we'd build a corrupt stage. Bail WITHOUT creating
    // a stage — switchChat re-triggers activation (`!querySelector('.vs-stage')`)
    // when this chat becomes visible.
    if (container.clientHeight === 0) {
        _vsHideBusy();
        return;
    }

    // Measure each element's full height including margins. Also include the
    // container's flex gap — the stage is not a flex container, so the natural
    // `gap: 1rem` spacing must be baked into each slot's height or activation
    // visibly compresses the layout.
    // slot.spacing (margins + gap) is stored permanently: once elements get
    // inline margin:0 in the stage, computed margins read 0 and can never be
    // re-derived from the DOM.
    const gap = parseFloat(getComputedStyle(container).rowGap) || 0;
    const slots = [];
    let offset = 0;
    for (const el of messages) {
        const style = getComputedStyle(el);
        const marginTop = parseFloat(style.marginTop) || 0;
        const marginBottom = parseFloat(style.marginBottom) || 0;
        const spacing = marginTop + marginBottom + gap;
        const height = el.offsetHeight + spacing;
        el._vsHeight = height;
        el._vsOffset = offset;
        el._vsIndex = slots.length; // WI-4: index for binary-search range logic
        slots.push({ el, height, offset, spacing });
        offset += height;
    }

    const totalHeight = offset;

    // Create the stage — a positioned container with explicit height
    const stage = document.createElement('div');
    stage.className = 'vs-stage';
    stage.style.height = totalHeight + 'px';

    // Move all elements into the stage, positioned absolutely.
    // Preserve original horizontal alignment from CSS classes:
    //   .chat-message.user → margin-left:auto (right-aligned)
    //   .chat-message.assistant → margin-right:auto (left-aligned)
    //   .chat-message.tool → full width
    for (const slot of slots) {
        const el = slot.el;
        el.style.position = 'absolute';
        el.style.top = slot.offset + 'px';
        el.style.margin = '0';

        if (el.classList.contains('user')) {
            el.style.right = '0';
            el.style.left = 'auto';
        } else if (el.classList.contains('tool')) {
            el.style.left = '0';
            el.style.right = '0';
        } else {
            // assistant or other: left-aligned
            el.style.left = '0';
            el.style.right = 'auto';
        }

        stage.appendChild(el);
    }

    // replaceChildren is one atomic DOM call; innerHTML='' + appendChild is two.
    // At this point the container still holds the pre-activation render, which
    // we're clearing as we install the stage.
    container.replaceChildren(stage);

    const state = {
        slots,
        totalHeight,
        stage,
        rafId: null,
        attached: new Set(messages), // All elements start attached — _vsUpdateVisible will detach non-visible
        resizeTimer: null,
        measuredWidth: container.clientWidth, // width the cached heights were measured at
        staleMeasurements: false, // set when a measurement was skipped while hidden
        gap, // the container's natural flex gap, baked into every slot's spacing
        loopId: null, // rAF handle of the height-detection loop (null = sleeping)
        idleFrames: 0 // consecutive frames with zero height diffs
    };
    _vsState.set(container, state);

    // Attach scroll listener
    container._vsOnScroll = () => {
        _vsWake(container); // WI-2: keep loop awake while scrolling
        if (state.rafId) return;
        state.rafId = requestAnimationFrame(() => {
            state.rafId = null;
            _vsUpdateVisible(container);
        });
    };
    container.addEventListener('scroll', container._vsOnScroll, { passive: true });

    // Attach resize observer — recalculation settles after 300ms of no resizing.
    // The observer ALSO fires when the container is hidden/shown by switchChat
    // (size transitions to/from 0). Those transitions must not trigger a
    // re-measure: hidden containers measure 0 for everything, and switch-back
    // at an unchanged width doesn't invalidate any cached height.
    if (!container._vsResizeObserver) {
        container._vsResizeObserver = new ResizeObserver(() => {
            if (state.resizeTimer) clearTimeout(state.resizeTimer);
            state.resizeTimer = setTimeout(() => {
                state.resizeTimer = null;
                // Hidden (display:none) — this is the 0-size transition of a
                // chat switch. Measuring now would zero every cached height.
                if (container.clientHeight === 0) return;
                // Same width and nothing stale → cached heights are still
                // valid. Skips the full re-measure on every switch-back.
                if (container.clientWidth === state.measuredWidth && !state.staleMeasurements) return;
                _vsRecalculate(container);
            }, 300);
        });
        container._vsResizeObserver.observe(container);
    }

    // WI-2: Delegated interaction listeners — any click/keydown may toggle
    // something that animates (thinking block, tool payload). Wake the loop
    // so it detects the height change and cascades.
    container._vsOnInteract = () => _vsWake(container);
    container.addEventListener('click', container._vsOnInteract, { passive: true });
    container.addEventListener('keydown', container._vsOnInteract, { passive: true });

    // Initial visibility pass
    _vsUpdateVisible(container);

    // WI-2: Wake after first visibility pass — catches late-settling web
    // components (neutralizes the 300ms _vsActivateWhenReady race).
    _vsWake(container);

    // Hide the busy overlay now that the stage is in place and the right
    // elements are attached. This is the last step of the activation
    // sequence — the user only ever sees the post-activation DOM.
    _vsHideBusy();
}

function _vsRecalculate(container) {
    const state = _vsState.get(container);
    if (!state) return;

    // Never measure a hidden container — offsetHeight is 0 for every slot,
    // which would corrupt all cached heights (and _vsUpdateVisible would then
    // re-attach ALL slots, since every [0,0] range overlaps the viewport).
    // Flag stale so the ResizeObserver settle handler re-measures on switch-back.
    if (container.clientHeight === 0) {
        state.staleMeasurements = true;
        return;
    }

    // Re-attach all elements and reset to natural flow for measurement
    for (const slot of state.slots) {
        const el = slot.el;
        el.style.position = '';
        el.style.top = '';
        el.style.left = '';
        el.style.right = '';
        el.style.margin = '';
        if (!state.attached.has(el)) {
            state.stage.appendChild(el);
            state.attached.add(el);
        }
    }

    // Force layout, then measure. Inline margins were cleared above, so the
    // natural CSS margins are readable again — refresh slot.spacing here.
    let offset = 0;
    for (let i = 0; i < state.slots.length; i++) {
        const slot = state.slots[i];
        const el = slot.el;
        const elStyle = getComputedStyle(el);
        const marginTop = parseFloat(elStyle.marginTop) || 0;
        const marginBottom = parseFloat(elStyle.marginBottom) || 0;
        const spacing = marginTop + marginBottom + state.gap;
        const height = el.offsetHeight + spacing;
        el._vsHeight = height;
        el._vsOffset = offset;
        el._vsIndex = i; // WI-4: index for binary-search range logic
        slot.spacing = spacing;
        slot.height = height;
        slot.offset = offset;
        offset += height;
    }

    // Re-position absolutely
    for (const slot of state.slots) {
        const el = slot.el;
        el.style.position = 'absolute';
        el.style.top = slot.offset + 'px';
        el.style.margin = '0';
        if (el.classList.contains('user')) {
            el.style.right = '0';
            el.style.left = 'auto';
        } else if (el.classList.contains('tool')) {
            el.style.left = '0';
            el.style.right = '0';
        } else {
            el.style.left = '0';
            el.style.right = 'auto';
        }
    }

    // Update stage height
    state.totalHeight = offset;
    state.stage.style.height = offset + 'px';

    // Heights are now valid for this width
    state.measuredWidth = container.clientWidth;
    state.staleMeasurements = false;

    // Detach non-visible
    _vsUpdateVisible(container);

    // WI-2: wake the loop — newly measured heights may still settle (web
    // components, images loading).
    _vsWake(container);
}

function _vsUpdateVisible(container) {
    const state = _vsState.get(container);
    if (!state) return;

    const scrollTop = container.scrollTop;
    const viewportBottom = scrollTop + container.clientHeight;
    const above = scrollTop - VS_MARGIN;
    const below = viewportBottom + VS_MARGIN;

    // WI-4: Binary search for the first visible slot, then walk forward to
    // the last. Slots are sorted by offset — O(log n + visible) per pass.
    const slots = state.slots;
    const first = _vsFirstVisibleIndex(slots, above);
    // Walk forward to find the last visible slot
    let last = first - 1;
    for (let i = first; i < slots.length; i++) {
        if (slots[i].offset <= below) last = i;
        else break;
    }

    // Detach elements that should no longer be visible.
    // Iterate the attached Set — anything outside [first, last] and not
    // streaming gets detached.
    for (const el of state.attached) {
        if (el.dataset.isStreaming === 'true') continue; // pinned
        const idx = el._vsIndex;
        if (idx < first || idx > last) {
            state.stage.removeChild(el);
            state.attached.delete(el);
        }
    }

    // Attach elements that should be visible.
    // Iterate the visible range — set style.top from slot.offset (WI-1).
    for (let i = first; i <= last; i++) {
        const slot = slots[i];
        if (!state.attached.has(slot.el)) {
            slot.el.style.top = slot.offset + 'px';
            state.stage.appendChild(slot.el);
            state.attached.add(slot.el);
        }
    }

    // Re-attach pinned (streaming) elements that may have been detached
    // before their range was known (e.g. streaming at the bottom).
    for (const slot of slots) {
        const el = slot.el;
        if (el.dataset.isStreaming === 'true' && !state.attached.has(el)) {
            el.style.top = slot.offset + 'px';
            state.stage.appendChild(el);
            state.attached.add(el);
        }
    }
}

// WI-4: Binary search — find the first slot whose bottom edge reaches into
// the viewport (offset + height >= above). Slots are sorted by offset.
function _vsFirstVisibleIndex(slots, above) {
    let lo = 0, hi = slots.length - 1, ans = slots.length;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (slots[mid].offset + slots[mid].height >= above) { ans = mid; hi = mid - 1; }
        else lo = mid + 1;
    }
    return ans;
}

// ============================================
// WI-2: Reactive Height Frame Loop (wake/sleep)
// ============================================
// A per-container rAF loop that detects height changes on attached slots and
// cascades automatically. Replaces all explicit _vsRecalcItem wiring.
// Sleeps after VS_IDLE_FRAMES consecutive frames with zero height diffs.

function _vsWake(container) {
    const state = _vsState.get(container);
    if (!state) return;                    // VS not active — legitimate no-op
    state.idleFrames = 0;
    if (state.loopId !== null) return;     // already awake — idempotent
    state.loopId = requestAnimationFrame(() => _vsOnFrame(container));
}

function _vsOnFrame(container) {
    const state = _vsState.get(container);
    if (!state) return;                               // deactivated — stop
    if (container.clientHeight === 0) {               // hidden — sleep, mark stale
        state.loopId = null;
        state.staleMeasurements = true;               // RO settle reconciles on switch-back
        return;
    }

    // READ phase: all measurements before any style write
    const scrollTop = container.scrollTop;
    let firstDirty = -1;
    let anchorDelta = 0; // WI-3: scroll compensation for changes above viewport
    for (let i = 0; i < state.slots.length; i++) {
        const slot = state.slots[i];
        if (!state.attached.has(slot.el)) continue;   // detached can't change height
        const h = slot.el.getBoundingClientRect().height + slot.spacing;
        if (Math.abs(h - slot.height) > VS_EPSILON) {
            // WI-3: if this slot is fully above the viewport top, its height
            // change shifts everything below it — compensate scrollTop so the
            // viewport content stays put.
            if (slot.offset + slot.height <= scrollTop) anchorDelta += (h - slot.height);
            slot.height = h;
            if (firstDirty === -1) firstDirty = i;    // slots are ordered — first hit is topmost
        }
    }

    // WRITE phase
    if (firstDirty !== -1) {
        // Cascade offsets from firstDirty (WI-1: data always, style.top only if attached)
        let offset = state.slots[firstDirty].offset;
        for (let i = firstDirty; i < state.slots.length; i++) {
            const s = state.slots[i];
            s.offset = offset;
            s.el._vsIndex = i; // WI-4: keep index current after cascade
            if (state.attached.has(s.el)) s.el.style.top = offset + 'px';
            offset += s.height;
        }
        state.totalHeight = offset;
        state.stage.style.height = offset + 'px';
        // WI-3: compensate for height changes above the viewport so content
        // under the user's eyes doesn't shift. Uses the scrollTop read at the
        // top of the frame (read phase), not a fresh read mid-write.
        if (anchorDelta !== 0) container.scrollTop = scrollTop + anchorDelta;
        _vsUpdateVisible(container);
        state.idleFrames = 0;
    } else {
        state.idleFrames++;
    }

    if (state.idleFrames >= VS_IDLE_FRAMES) { state.loopId = null; return; }  // sleep
    state.loopId = requestAnimationFrame(() => _vsOnFrame(container));
}

function _vsDeactivate(container) {
    const state = _vsState.get(container);
    if (state) {
        if (state.rafId) cancelAnimationFrame(state.rafId);
        if (state.loopId !== null) cancelAnimationFrame(state.loopId);
        if (state.resizeTimer) clearTimeout(state.resizeTimer);
        _vsState.delete(container);
    }
    if (container._vsOnScroll) {
        container.removeEventListener('scroll', container._vsOnScroll);
        delete container._vsOnScroll;
    }
    if (container._vsOnInteract) {
        container.removeEventListener('click', container._vsOnInteract);
        container.removeEventListener('keydown', container._vsOnInteract);
        delete container._vsOnInteract;
    }
    if (container._vsResizeObserver) {
        container._vsResizeObserver.disconnect();
        delete container._vsResizeObserver;
    }
}

// Append a chat-message element to a container. When virtual scroll is active,
// register it as a slot at the end of the stage; plain append otherwise.
// Natural CSS margins are read BEFORE being zeroed (inline margin:0 makes them
// unreadable afterwards) and stored as slot.spacing together with the
// container's flex gap — this preserves inter-message spacing across all
// future re-measurements.
function _vsAppendMessage(container, el) {
    if (!container) throw new Error('_vsAppendMessage: container required');
    const state = _vsState.get(container);
    if (!state) {
        container.appendChild(el);
        // WI-5: crossing the threshold upward — activate virtual scroll.
        // The settle delay lets web components render before measuring.
        if (container.querySelectorAll('.chat-message').length >= VS_MIN_ITEMS) {
            _vsActivateWhenReady(container);
        }
        return;
    }

    const offset = state.totalHeight;
    el.style.position = 'absolute';
    el.style.top = offset + 'px';
    if (el.classList.contains('user')) {
        el.style.right = '0';
        el.style.left = 'auto';
    } else if (el.classList.contains('tool')) {
        el.style.left = '0';
        el.style.right = '0';
    } else {
        el.style.left = '0';
        el.style.right = 'auto';
    }
    state.stage.appendChild(el);

    const cs = getComputedStyle(el);
    const spacing = (parseFloat(cs.marginTop) || 0) + (parseFloat(cs.marginBottom) || 0) + state.gap;
    el.style.margin = '0';

    // Streaming elements grow — their height is corrected by the frame loop
    // (WI-2). Static elements (tool bubbles) are correct immediately.
    const height = el.offsetHeight + spacing;
    el._vsIndex = state.slots.length; // WI-4: index for binary-search range logic
    state.slots.push({ el, height, offset, spacing });
    state.attached.add(el);
    state.totalHeight = offset + height;
    state.stage.style.height = state.totalHeight + 'px';

    // WI-2: wake the loop — the new element may grow (streaming) or settle
    // (web components finishing render).
    _vsWake(container);
}

// Remove every rendered element of an exchange without a full re-render —
// the deletion equivalent of _vsRecalcItem. The slots array is the source of
// truth: detached elements are NOT in the DOM, so querySelectorAll would miss
// them. clickedEl anchors the container lookup (the clicked element is always
// attached).
function _vsRemoveExchangeDom(clickedEl, exchangeId) {
    const container = clickedEl.closest('.conversation-container');
    if (!container) throw new Error(`_vsRemoveExchangeDom: element for exchange ${exchangeId} is not inside a conversation container`);

    const state = _vsState.get(container);
    if (!state) {
        // Virtual scroll inactive — plain flow removal
        for (const el of container.querySelectorAll(`.chat-message[data-exchange-id="${exchangeId}"]`)) el.remove();
        if (!container.querySelector('.chat-message')) {
            renderConversation(); // chat emptied — show the welcome message
            return;
        }
        updateOverallContext();
        return;
    }

    const removed = state.slots.filter(s => s.el.dataset.exchangeId === exchangeId);
    if (removed.length === 0) {
        // Element was never registered as a slot (edge: appended outside the stage)
        clickedEl.remove();
        updateOverallContext();
        return;
    }

    for (const s of removed) {
        if (state.attached.has(s.el)) {
            state.stage.removeChild(s.el);
            state.attached.delete(s.el);
        }
    }

    // WI-3: accumulate heights of removed slots that were fully above the
    // viewport — deleting them shifts content up by their total height.
    const scrollTop = container.scrollTop;
    let removedAbove = 0;
    for (const s of removed) {
        if (s.offset + s.height <= scrollTop) removedAbove += s.height;
    }

    state.slots = state.slots.filter(s => s.el.dataset.exchangeId !== exchangeId);

    if (state.slots.length === 0) {
        renderConversation(); // chat emptied — show the welcome message
        return;
    }

    // Cascade all offsets from the top (a deletion can remove multiple slots).
    // WI-1: only write style.top to attached elements — detached slots get
    // their top refreshed at attach time in _vsUpdateVisible.
    let offset = 0;
    for (let i = 0; i < state.slots.length; i++) {
        const s = state.slots[i];
        s.offset = offset;
        s.el._vsIndex = i; // WI-4: rebuild indices after slot removal
        if (state.attached.has(s.el)) s.el.style.top = offset + 'px';
        offset += s.height;
    }
    state.totalHeight = offset;
    state.stage.style.height = offset + 'px';

    // WI-3: keep viewport content stationary when deleting above the viewport.
    if (removedAbove > 0) container.scrollTop = scrollTop - removedAbove;

    _vsUpdateVisible(container);
    updateOverallContext();
}

function renderExchange(exchange, targetContainer = null) {
    const container = targetContainer || getActiveContainer();
    if (exchange.type === 'tool') {
        const parsedObj = { name: exchange.tool.name, args: exchange.tool.args };
        const toolEl = document.createElement('div');
        toolEl.className = 'chat-message tool';
        toolEl.dataset.exchangeId = exchange.id;
        toolEl.dataset.mcpToolName = parsedObj.name;
        
        const isSuccess = exchange.tool.status === 'success';
        const isError = exchange.tool.status === 'error';
        const displayStatus = isSuccess ? 'Success' : (isError ? 'Failed' : 'Pending');
        const badgeVariant = isSuccess ? 'success' : (isError ? 'danger' : 'primary');
        
        let hasImages = exchange.tool.images && exchange.tool.images.length > 0;
        let imagesHtml = '';
        if (hasImages) {
            imagesHtml = `<div class="tool-images-container">`;
            exchange.tool.images.forEach(img => {
                imagesHtml += `<img src="${img}" class="tool-image" />`;
            });
            imagesHtml += `</div>`;
        }

        let resultHtml = '';
        if (isSuccess) resultHtml = exchange.tool.content;
        else if (isError) resultHtml = exchange.tool.content;

        toolEl.innerHTML = `
            <div class="tool-bubble">
                <div class="message-header tool-header">
                    <nui-icon name="extension"></nui-icon>
                    <strong class="tool-title">SYSTEM TOOL: ${parsedObj.name}</strong>
                    <nui-badge variant="${badgeVariant}" class="tool-status">${displayStatus}</nui-badge>
                    <nui-button variant="icon" class="action-btn delete-tool" title="Delete Tool Call"><button type="button"><nui-icon name="delete"></nui-icon></button></nui-button>
                </div>
                <div class="tool-notifications">
                  </div>
                  <div class="tool-images" style="display: ${hasImages ? 'block' : 'none'};">${imagesHtml}</div>
                <div class="message-content tool-payload" style="display: none;">
                    <div class="tool-section-title">Arguments</div>
                    <div class="tool-args">${JSON.stringify(parsedObj.args, null, 2)}</div>
                    <div class="tool-section-title">Execution Result</div>
                    <div class="tool-result"></div>
                </div>
            </div>
        `;
        if (container) _vsAppendMessage(container, toolEl);

        _decoratePreviewToolButton(toolEl, parsedObj.name, parsedObj.args);

        // Use textContent to prevent SVG/code examples from being parsed as HTML
        const resultEl = toolEl.querySelector('.tool-result');
        if (isSuccess) resultEl.innerHTML = `<strong>Result:</strong><br>`;
        else if (isError) resultEl.innerHTML = `<strong>Error:</strong> `;
        resultEl.appendChild(document.createTextNode(exchange.tool.content));

        toolEl.querySelector('.delete-tool')?.addEventListener('click', (e) => {
            e.stopPropagation();
            conversation.deleteExchange(exchange.id);
            _vsRemoveExchangeDom(toolEl, exchange.id);
        });

        toolEl.querySelector('.message-header').addEventListener('click', (e) => {
            if (e.target.tagName.toLowerCase() === 'button' || e.target.closest('button')) return;
            const payloadBox = toolEl.querySelector('.tool-payload');
            payloadBox.style.display = payloadBox.style.display === 'none' ? 'block' : 'none';
            // WI-2: height change detected by the frame loop (container click listener wakes it).
        });

        // Assistant message (if exists after tool) - append as sibling after the tool element
        if (exchange.assistant.content || exchange.assistant.isStreaming) {
            const cleanedContent = stripExtraTimestamps(exchange.assistant.content);
            const assistantParsed = parseTimestamp(cleanedContent);
            const vers = exchange.assistant?.versions || [];
            const tsMs = (vers.length > 0 && vers[exchange.assistant?.currentVersion || 0]?.timestamp) || exchange.timestamp || Date.now();
            const assistantTimestamp = assistantParsed.timestamp || new Date(tsMs).toISOString().slice(0,16).replace('T',' @ ');
            const assistantEl = createAssistantElement(exchange.id, assistantTimestamp, exchange.model);

            const tsLen = exchange.assistant.content.length - assistantParsed.cleanContent.length;
            if (tsLen > 0) {
                assistantEl.dataset.timestampLen = tsLen.toString();
                assistantEl.dataset.timestampStripped = 'true';
            }
            updateAssistantContent(assistantEl, assistantParsed.cleanContent, exchange.assistant.reasoning_content);
            const aEmbed = assistantEl.querySelector('.embed-status');
            if (aEmbed) _applyEmbedStatusAttrs(aEmbed, exchange.assistant.embedStatus || 'pending', exchange.assistant.embedError);
            // toolEl was just appended as the last message, so appending the
            // assistant next preserves ordering. _vsAppendMessage registers a
            // slot when virtual scroll is active; plain append otherwise.
            if (container) _vsAppendMessage(container, assistantEl);
            // User embed status: userEl is already in DOM at this point, so setEmbedStatus works
            setEmbedStatus(exchange.id, exchange.user?.embedStatus || 'unknown', exchange.user?.embedError, 'user');
            if (exchange.assistant.isComplete) {
                finalizeAssistantElement(assistantEl, exchange.id);
            }
        }
        return;
    }

    // Parse timestamps from content
    const userParsed = parseTimestamp(exchange.user.content);
    const userTimestamp = userParsed.timestamp || (exchange.timestamp && !isNaN(exchange.timestamp) ? new Date(exchange.timestamp).toISOString().slice(0,16).replace('T',' @ ') : '');
    
    // User message
    const userEl = document.createElement('div');
    userEl.className = 'chat-message user';
    userEl.dataset.exchangeId = exchange.id;

    let userContent = renderMarkdown(userParsed.cleanContent);

    // Add attachment previews
    if (exchange.user?.attachments?.length > 0) {
        userContent += '<div class="message-attachments"><nui-lightbox loop>';
        for (const att of exchange.user.attachments) {
            // imgSrc resolves to a server URL (from API); blob: scheme no longer used
            const imgSrc = att.blobUrl || att.dataUrl || '';
            userContent += `<img src="${imgSrc}" alt="${att.name}" data-lightbox-src="${imgSrc}" class="chat-attachment">`
        }
        userContent += '</nui-lightbox></div>';
    }
    
    userEl.innerHTML = `
        <div class="message-header">
            You <span class="message-timestamp">${userTimestamp}</span>
            <span class="embed-status" data-embed-status="unknown" title="Embed status unknown">
                <span class="embed-status-dot"></span>
            </span>
            <span class="user-pending-indicator visible">
                <span class="dot">.</span><span class="dot">.</span><span class="dot">.</span>
            </span>
        </div>
        <div class="message-content">${userContent}</div>
        <div class="message-actions-user">
            <nui-button class="action-btn edit-message" title="Edit Message"><button type="button"><nui-icon name="edit"></nui-icon></button></nui-button>
            <nui-button class="action-btn delete-message" title="Delete Message"><button type="button"><nui-icon name="delete"></nui-icon></button></nui-button>
        </div>
    `;

    // Bind user message action buttons
    userEl.querySelector('.edit-message')?.addEventListener('click', () => startEditMode(exchange.id, 'user'));
    userEl.querySelector('.delete-message')?.addEventListener('click', () => {
        conversation.deleteExchange(exchange.id);
        _vsRemoveExchangeDom(userEl, exchange.id);
    });

    if (container) _vsAppendMessage(container, userEl);

    setEmbedStatus(exchange.id, exchange.user?.embedStatus || 'unknown', exchange.user?.embedError, 'user');

    // Initialize Lightbox declarative handlers for attached images
    if (exchange.user?.attachments?.length > 0) {
        const lightbox = userEl.querySelector('nui-lightbox');
        if (lightbox) {
            const imgs = lightbox.querySelectorAll('img');
            imgs.forEach((img, i) => {
                img.addEventListener('click', () => {
                    lightbox.open([], i);
                });
            });
        }
    }

    // Assistant message (if exists)
    if (exchange.assistant.content || exchange.assistant.isStreaming) {
        // Clean up any duplicate timestamps from historical data
        const cleanedContent = stripExtraTimestamps(exchange.assistant.content);
        const assistantParsed = parseTimestamp(cleanedContent);
        const vers = exchange.assistant?.versions || [];
            const tsMs = (vers.length > 0 && vers[exchange.assistant?.currentVersion || 0]?.timestamp) || exchange.timestamp || Date.now();
            const assistantTimestamp = assistantParsed.timestamp || new Date(tsMs).toISOString().slice(0,16).replace('T',' @ ');
        
        const assistantEl = createAssistantElement(exchange.id, assistantTimestamp, exchange.model);
        // For historical messages, we already have the clean content
        // Store expected length to prevent re-parsing issues
        const tsLen = exchange.assistant.content.length - assistantParsed.cleanContent.length;
        if (tsLen > 0) {
            assistantEl.dataset.timestampLen = tsLen.toString();
            assistantEl.dataset.timestampStripped = 'true';
        }
        updateAssistantContent(assistantEl, assistantParsed.cleanContent, exchange.assistant.reasoning_content);
        const aEmbed = assistantEl.querySelector('.embed-status');
        if (aEmbed) _applyEmbedStatusAttrs(aEmbed, exchange.assistant.embedStatus || 'pending', exchange.assistant.embedError);
        if (container) _vsAppendMessage(container, assistantEl);

        if (exchange.assistant.isComplete) {
            finalizeAssistantElement(assistantEl, exchange.id);
        }
    }
}

function createAssistantElement(exchangeId, timestamp = '', modelName = '') {
    const el = document.createElement('div');
    el.className = 'chat-message assistant';
    el.dataset.exchangeId = exchangeId;
    const label = modelName || 'Assistant';
    el.innerHTML = `
        <div class="message-header message-header-flex">
            <span>${label}</span>${timestamp ? ` <span class="message-timestamp">${timestamp}</span>` : ''}
            <span class="embed-status" data-embed-status="unknown" title="Embed status unknown">
                <span class="embed-status-dot"></span>
            </span>
            <span class="streaming-indicator visible">
                <span class="dot">.</span><span class="dot">.</span><span class="dot">.</span>
            </span>
            <span class="context-usage-display">
                <span class="usage-values">--</span>
            </span>
        </div>
        <div class="progress-status"></div>
        <div class="message-content"></div>
        <div class="message-actions">
            <nui-button class="action-btn speaker" title="Read Aloud"><button type="button"><nui-icon name="volume"></nui-icon></button></nui-button>
            <nui-button class="action-btn regenerate" title="Regenerate"><button type="button"><nui-icon name="sync"></nui-icon></button></nui-button>
            <nui-button class="action-btn prev-version" title="Previous version"><button type="button"><nui-icon name="arrow" class="arrow-rotated"></nui-icon></button></nui-button>
            <span class="version-info"></span>
            <nui-button class="action-btn next-version" title="Next version"><button type="button"><nui-icon name="arrow"></nui-icon></button></nui-button>
            <div class="spacer"></div>
            <nui-button class="action-btn copy-message" title="Copy Message"><button type="button"><nui-icon name="content_copy"></nui-icon></button></nui-button>
            <nui-button class="action-btn edit-message" title="Edit Message"><button type="button"><nui-icon name="edit"></nui-icon></button></nui-button>
            <nui-button class="action-btn delete-message" title="Delete Message"><button type="button"><nui-icon name="delete"></nui-icon></button></nui-button>
        </div>
    `;

    // Bind action buttons
    el.querySelector('.speaker')?.addEventListener('click', () => toggleTts(exchangeId, el));
    el.querySelector('.regenerate')?.addEventListener('click', () => regenerate(exchangeId));
    el.querySelector('.prev-version')?.addEventListener('click', () => switchVersion(exchangeId, 'prev'));
    el.querySelector('.next-version')?.addEventListener('click', () => switchVersion(exchangeId, 'next'));
    el.querySelector('.copy-message')?.addEventListener('click', (e) => copyMessageToClipboard(exchangeId, e.currentTarget));
    el.querySelector('.edit-message')?.addEventListener('click', () => startEditMode(exchangeId, 'assistant'));
    el.querySelector('.delete-message')?.addEventListener('click', () => {
        conversation.deleteExchange(exchangeId);
        _vsRemoveExchangeDom(el, exchangeId);
    });

    return el;
}

function updateUsageDisplay(el, contextData, usageData = null, streamStats = null) {
    if (!el || !contextData) return;
    const displaySpan = el.querySelector('.context-usage-display');
    const valueSpan = el.querySelector('.usage-values');
    if (!displaySpan || !valueSpan) return;

    if (contextData.used_tokens !== undefined) {
        displaySpan.style.display = 'inline-block';

        // Compact token formatting (e.g., 36139 -> "36K")
        function formatTokensCompact(n) {
            if (n >= 1000000) return Math.round(n / 100000) / 10 + 'M';
            if (n >= 1000) return Math.round(n / 100) / 10 + 'K';
            return n.toString();
        }

        const isEstimate = contextData.isEstimate;
        let text = `${isEstimate ? '~' : ''}${formatTokensCompact(contextData.used_tokens)}`;

        let windowSize = contextData.window_size;
        if (!windowSize) {
            const modelConfig = models.find(m => m.id === currentModel);
            if (modelConfig && modelConfig.capabilities?.contextWindow) {
                windowSize = modelConfig.capabilities.contextWindow;
            }
        }

        if (windowSize) {
            text += ` / ${formatTokensCompact(windowSize)}`;
        }
        text += ' Tokens';

        if (streamStats && usageData && usageData.completion_tokens) {
            const tps = (usageData.completion_tokens / streamStats.durationSecs).toFixed(1);
            text += ` | ${streamStats.ttft}ms TTFT | ${tps} T/s`;
        } else if (streamStats) {
            text += ` | ${streamStats.ttft}ms TTFT`;
        }

        // Only update if value changed - prevents tooltip flicker
        if (valueSpan.textContent !== text) {
            valueSpan.textContent = text;
        }

        // Add full context info as tooltip for debugging
        let debugText = [];
        for (const [key, val] of Object.entries(contextData)) {
            if (key !== 'isEstimate') {
                debugText.push(`${key}: ${val}`);
            }
        }
        const newTitle = debugText.length > 0 ? debugText.join('\n') : '';
        if (displaySpan.title !== newTitle) {
            displaySpan.title = newTitle;
        }

        updateOverallContext(contextData);
    }
}

async function updateOverallContext(contextData = null) {
    if (!elements.overallContextProgressWrap) return;

    if (!contextData) {
        // Try to get from last conversation exchange
        const lastEx = conversation.exchanges[conversation.exchanges.length - 1];
        
        let foundContext = lastEx?.assistant?.context;
        let foundUsage = lastEx?.assistant?.usage;

        // Fallback to version data if loading from history and surface variables are missing
        if (!foundContext && !foundUsage && lastEx?.assistant?.versions?.length > 0) {
            const curVersion = lastEx.assistant.versions[lastEx.assistant.currentVersion || 0];
            if (curVersion) {
                foundContext = curVersion.context;
                foundUsage = curVersion.usage;
            }
        }

        if (foundContext) {
            contextData = foundContext;
        } else {
            // Rough estimation fallback based on the data we have in the conversation text
            let textLength = 0;
            const msgs = await conversation.getMessagesForApi();
            for (const m of msgs) {
                let contentText = '';
                if (typeof m.content === 'string') {
                    contentText = m.content;
                } else if (Array.isArray(m.content)) {
                    for (const block of m.content) {
                        if (block.type === 'text') contentText += block.text;
                    }
                }
                
                // Strip <think>...</think> blocks
                contentText = contentText.replace(/<think>[\s\S]*?<\/think>/g, '');
                
                textLength += contentText.length;
                textLength += m.role.length;
            }
            if (textLength > 0) {
                // Heuristic: ~4 chars per token for English
                contextData = { used_tokens: Math.ceil(textLength / 4), isEstimate: true };
            }
        }
    }

    // The wrapper is always visible via CSS, context-progress-wrap class handles display

    const usedTokens = (contextData && contextData.used_tokens) ? contextData.used_tokens : 0;
    const isEstimate = contextData && contextData.isEstimate;
    
    // Compact token formatting (e.g., 36139 -> "36K")
    function formatTokensCompact(n) {
        if (n >= 1000000) return Math.round(n / 100000) / 10 + 'M';
        if (n >= 1000) return Math.round(n / 100) / 10 + 'K';
        return n.toString();
    }
    
    let text = `${isEstimate ? '~' : ''}${formatTokensCompact(usedTokens)}`;
    let pct = 0;
    let knownLimit = false;

    const modelConfig = models.find(m => m.id === currentModel);

    if (modelConfig && modelConfig.capabilities?.contextWindow) {
        text += ` / ${formatTokensCompact(modelConfig.capabilities.contextWindow)} Tokens`;
        pct = Math.min(100, Math.max(0, (usedTokens / modelConfig.capabilities.contextWindow) * 100));
        knownLimit = true;
    } else if (contextData && contextData.window_size) {
        // Fallback to backend reported window size if model list lacks it
        text += ` / ${formatTokensCompact(contextData.window_size)} Tokens`;
        pct = Math.min(100, Math.max(0, (usedTokens / contextData.window_size) * 100));
        knownLimit = true;
    } else {
        text += ` / ? Tokens`;
    }

    if (elements.overallContextProgressWrap) {
        let debugText = [];
        if (contextData) {
            for (const [key, val] of Object.entries(contextData)) {
                if (key !== 'isEstimate') {
                    debugText.push(`${key}: ${val}`);
                }
            }
        }
        elements.overallContextProgressWrap.title = debugText.length > 0 ? debugText.join('\n') : '';
    }

    if (elements.overallContextProgress) {
        elements.overallContextProgress.setAttribute('value', pct || 0);
        
        // Dim the icon if we genuinely do not know the context limit, or if no model is selected
        if (!knownLimit || !currentModel) {
            elements.overallContextProgress.style.opacity = '0.3';
            elements.overallContextProgress.removeAttribute('variant');
        } else {
            elements.overallContextProgress.style.opacity = '1';
            // Change variant to warning/orange if context is full
            if (pct >= 100) {
                elements.overallContextProgress.setAttribute('variant', 'warning');
            } else {
                elements.overallContextProgress.removeAttribute('variant');
            }
        }
    }

    if (elements.overallContextTooltip) {
        elements.overallContextTooltip.textContent = text;
    }
}

// ============================================
// PHASE-3: MCP Tool Execution Logic
// ============================================

function showPendingToolUI(exchangeId, chatId) {
    // Hide user bubble pending indicator when tool is detected
    // Use getOrCreateContainer with chatId since tool belongs to that chat (may differ from current if user switched)
    const container = getOrCreateContainer(chatId);
    const userPendingEl = container?.querySelector(`.chat-message.user[data-exchange-id="${exchangeId}"] .user-pending-indicator`);
    if (userPendingEl) userPendingEl.classList.remove('visible');

    const toolEl = document.createElement('div');
    toolEl.className = 'chat-message tool pending-tool-element';
    toolEl.dataset.pendingExchangeId = exchangeId;

    toolEl.innerHTML = `
        <div class="tool-bubble pending">
            <div class="message-header tool-header pending">
                <nui-icon name="extension"></nui-icon>
                <strong class="tool-title">SYSTEM TOOL</strong>
                <nui-badge variant="primary" class="tool-status">Pending</nui-badge>
            </div>
        </div>
    `;
    container?.appendChild(toolEl);
    scrollToBottom();
}

async function handleToolExecution(originalExchangeId, parsedObj, forcedChatId, origUserExchangeId = null, resumeStream = true) {
    _logTool('handleToolExecution entry', { name: parsedObj.name, toolCallId: parsedObj.id, resumeStream });

    // Resolve the target chat up front so every guard uses the same ID.
    const toolChatId = forcedChatId || currentChatId;

    // Guard: Reject vision tool calls if MCP Vision is disabled
    // Use the chat's actual model, not the global dropdown — the user
    // may have switched models since the conversation was started.
    const isVisionTool = parsedObj.name.toLowerCase().includes('vision_');
    const chatModel = chatHistory.get(toolChatId)?.model || currentModel;
    const chatModelConfig = models.find(m => m.id === chatModel);
    const modelSupportsVision = chatModelConfig?.capabilities?.vision === true;
    if (isVisionTool && modelSupportsVision && !useVisionAnalysis) {
        console.warn('[Tool Call Blocked] Vision tool called but MCP Vision is disabled:', parsedObj.name);
        // Treat as error - add error exchange and continue
        const toolConversation = activeConversations.get(toolChatId);
        const toolExchangeId = await toolConversation.addToolExchange(parsedObj.name, parsedObj.args, parsedObj.id, origUserExchangeId || originalExchangeId);
        const exchange = toolConversation.getExchange(toolExchangeId);
        exchange.tool.status = 'error';
        exchange.tool.content = 'Vision tools are disabled. The selected model supports native vision - images were sent directly to the model.';
        toolConversation.save();

        // Render error UI
        const toolContainer = getOrCreateContainer(toolChatId);
        const toolEl = document.createElement('div');
        toolEl.className = 'chat-message tool';
        toolEl.dataset.exchangeId = toolExchangeId;
        toolEl.dataset.mcpToolName = parsedObj.name;
        toolEl.innerHTML = `
            <div class="tool-bubble">
                <div class="message-header tool-header">
                    <nui-icon name="extension"></nui-icon>
                    <strong class="tool-title">SYSTEM TOOL: ${parsedObj.name}</strong>
                    <nui-badge variant="danger" class="tool-status">Blocked</nui-badge>
                </div>
                <div class="message-content tool-payload" style="display: block;">
                    <div class="tool-section-title">Error</div>
                    <div class="tool-result"><span class="tool-error">Vision tools are disabled. Images were sent directly to the model.</span></div>
                </div>
            </div>
        `;
        if (toolContainer) _vsAppendMessage(toolContainer, toolEl);
        
        // Continue with normal response (don't stream again, just finalize)
        return;
    }

    // Use forcedChatId if provided (passed from streamResponse which knows the correct chat),
    // otherwise fall back to currentChatId for backward compatibility.
    // toolChatId is already resolved above; keep it consistent.
    const toolContainer = getOrCreateContainer(toolChatId);
    // Always use the conversation for toolChatId - it might differ from global `conversation` if user switched chats during an async operation
    const toolConversation = activeConversations.get(toolChatId);

    // Determine the original user exchange ID.
    // origUserExchangeId is passed from streamResponse when this is a chained tool continuation.
    // If not passed, originalExchangeId IS the user exchange ID (first tool in a user exchange).
    const userExchangeId = origUserExchangeId || originalExchangeId;

    // 1. Finalize the current assistant message
    const oldEx = toolConversation.getExchange(originalExchangeId);
    // oldEx could be undefined if the user switched chats and this exchange doesn't exist in the new chat's conversation
    if (!oldEx) {
        _logTool('Exchange not found', { originalExchangeId, toolChatId, currentChatId, reason: 'chat context switch or deleted exchange' });
        return;
    }
    // Trim trailing whitespace
    oldEx.assistant.content = oldEx.assistant.content.trim();
    toolConversation.setAssistantComplete(originalExchangeId);

    let originalEl = toolContainer?.querySelector(`.chat-message.assistant[data-exchange-id="${originalExchangeId}"]`);
    if (originalEl) {
        updateAssistantContent(originalEl, oldEx.assistant.content, oldEx.assistant.reasoning_content);
    }

    const pendingEl = toolContainer?.querySelector(`.pending-tool-element[data-pending-exchange-id="${originalExchangeId}"]`);
    if (pendingEl) {
        pendingEl.remove();
    }

    // 2. Create the tool exchange (pass userExchangeId so chained tools know the original)
    const toolExchangeId = await toolConversation.addToolExchange(parsedObj.name, parsedObj.args, parsedObj.id, userExchangeId);
    const exchange = toolConversation.getExchange(toolExchangeId);

    // 3. Render Tool UI
    const toolEl = document.createElement('div');
    toolEl.className = 'chat-message tool';
    toolEl.dataset.exchangeId = toolExchangeId;
    toolEl.dataset.mcpToolName = parsedObj.name;

    // Build collapsible box UI
    toolEl.innerHTML = `
          <div class="tool-bubble">
              <div class="message-header tool-header">
                  <nui-icon name="extension"></nui-icon>
                  <strong class="tool-title">SYSTEM TOOL: ${parsedObj.name}</strong>
                  <nui-badge variant="primary" class="tool-status">Pending</nui-badge>
                  <nui-button variant="icon" class="action-btn delete-tool" title="Delete Tool Call"><button type="button"><nui-icon name="delete"></nui-icon></button></nui-button>
              </div>
              <div class="tool-notifications">
                  </div>
                  <div class="tool-images" style="display: none;"></div>
              <div class="message-content tool-payload" style="display: none;">
                  <div class="tool-section-title">Arguments</div>
                  <div class="tool-args">${jsonStringifyForDisplay(parsedObj.args)}</div>
                  <div class="tool-section-title">Execution Result</div>
                  <div class="tool-result"></div>
    `;

    // Register as a virtual-scroll slot when active — a plain container append
    // would land OUTSIDE the stage, unmanaged and unfindable by _vsRecalcItem.
    if (toolContainer) _vsAppendMessage(toolContainer, toolEl);
    scrollToBottom();

    _decoratePreviewToolButton(toolEl, parsedObj.name, parsedObj.args);

    toolEl.querySelector('.delete-tool')?.addEventListener('click', (e) => {
        e.stopPropagation();
        toolConversation.deleteExchange(exchange.id);
        _vsRemoveExchangeDom(toolEl, exchange.id);
    });

// Toggle expand/collapse
    toolEl.querySelector('.message-header').addEventListener('click', (e) => {
        // Prevent toggle if clicking a button
        if (e.target.tagName.toLowerCase() === 'button' || e.target.closest('button')) return;
        const payloadBox = toolEl.querySelector('.tool-payload');
        payloadBox.style.display = payloadBox.style.display === 'none' ? 'block' : 'none';
        // WI-2: height change detected by the frame loop (container click listener wakes it).
    });

    // 4. Execute tool (local tools first, then MCP servers).
    // .catch() ONLY on the tool execution — a known external-failure path.
    // Returns null on failure to signal "UI already handled".
    const isLocalTool = LOCAL_TOOL_NAMES.has(parsedObj.name);
    _logTool('Routing', { name: parsedObj.name, localTools: [...LOCAL_TOOL_NAMES], isLocalTool, target: isLocalTool ? 'LOCAL' : 'MCP' });
    console.log(`[handleToolExecution] Routing ${parsedObj.name} → ${isLocalTool ? 'LOCAL' : 'MCP'}`);
    const toolPromise = isLocalTool
        ? executeLocalTool(parsedObj.name, parsedObj.args, toolExchangeId)
        : mcpClient.executeTool(parsedObj.name, parsedObj.args, (progressParams) => {
        const { progress, total, message } = progressParams;
        let statusText = 'Running...';
        if (message) statusText = message;
        if (progress !== undefined) {
            statusText += ` (${progress}${total ? '/' + total : ''})`;
        }
        const notifEl = toolEl.querySelector('.tool-notifications');
        if (notifEl) {
            notifEl.style.display = 'block';
            notifEl.innerHTML = '<span class="tool-spinner"></span> ' + statusText;
        }
    }, toolChatId);

    const result = await toolPromise.catch(async err => {
        _logTool('Tool FAILED', { name: parsedObj.name, error: err.message || String(err) });
        exchange.tool.status = 'error';
        exchange.tool.content = err.message || String(err);
        toolConversation.save();
        toolConversation._syncMessage('tool', exchange.tool.content, null, exchange.id, {
            toolName: exchange.tool.name,
            toolArgs: exchange.tool.args,
            toolStatus: 'error'
        });

        toolEl.querySelector('.tool-status').setAttribute('variant', 'danger');
          toolEl.querySelector('.tool-status').innerHTML = 'Failed';
          toolEl.querySelector('.tool-notifications').style.display = 'none';
        toolEl.querySelector('.tool-result').innerHTML = '<span class="tool-error"></span>' +
            '<div class="tool-error-actions">' +
                '<nui-button size="small" class="retry-tool"><button>Retry</button></nui-button>' +
                '<nui-button size="small" class="dismiss-tool"><button>Dismiss & Continue</button></nui-button>' +
            '</div>';
        toolEl.querySelector('.tool-result .tool-error').textContent = exchange.tool.content;
        toolEl.querySelector('.tool-payload').style.display = 'block';
        // WI-2: height change detected by the frame loop (container click listener wakes it).

        toolEl.querySelector('.retry-tool')?.addEventListener('click', () => {
            toolEl.querySelector('.tool-result').innerHTML = '';
            toolEl.querySelector('.tool-status').innerHTML = 'Pending';
            toolEl.querySelector('.tool-notifications').innerHTML = '<span class="tool-spinner"></span> Running...';
            toolEl.querySelector('.tool-status').setAttribute('variant', 'primary');
            handleToolExecution(originalExchangeId, parsedObj, toolChatId, origUserExchangeId, resumeStream);
        });

        toolEl.querySelector('.dismiss-tool')?.addEventListener('click', () => {
            if (resumeStream) {
                streamResponse(toolExchangeId, toolChatId, userExchangeId);
            }
            toolEl.querySelector('.dismiss-tool').parentElement.style.display = 'none';
        });

        // Auto-resume the stream so the model sees the tool error as a result
        // and can respond to it (rephrase, give up, try a different approach).
        // Without this, the stream halts and the model retries the same failed
        // call on the next user turn — an infinite loop.
        if (resumeStream) {
            await streamResponse(toolExchangeId, toolChatId, userExchangeId);
        }

        return null; // signal: failed, UI handled, bail
    });

    if (result === null) return;

    exchange.tool.status = 'success';
        // Extract the actual content from MCP result structure
        // MCP result is { content: [{ type: 'text', text: '...' }] } or similar
        let resultText = '';
        const resultImages = [];
        const rawBase64Attachments = []; // Array to intercept blobs for the backend
        
        if (result && typeof result === 'object') {
            if (result.content && Array.isArray(result.content)) {
                resultText = result.content.map(c => {
                    if (c.type === 'text') return c.text;
                    if (c.type === 'image') {
                        const mime = c.mimeType || 'image/png';
                        if (c.data) {
                            const dataUrl = `data:${mime};base64,${c.data}`;
                            rawBase64Attachments.push({
                                name: `mcp_output_${Date.now()}.png`,
                                type: mime,
                                dataUrl: dataUrl
                            });
                            return '[Image Included in Output]';
                        } else if (c.url) {
                            // Image URL - store directly, will be rendered as img src
                            resultImages.push(c.url);
                            return '[Image Included in Output]';
                        }
                    }
                    return JSON.stringify(c);
                }).join('\n');
            } else if (result.text) {
                resultText = result.text;
            } else {
                resultText = JSON.stringify(result);
            }
        } else {
            resultText = String(result);
        }
        resultText = resultText.trim();
        exchange.tool.content = resultText;
        
        // Intercept massive base64 images generated by the tool and force them into nDB natively
        if (rawBase64Attachments.length > 0) {
            // Shoot the base64 up to the node API which writes to disk via nDB and returns `/api/buckets/images/...`
            const savedToolFiles = await imageStore.save(exchange.id, rawBase64Attachments);

            // For every image saved, push the lightweight backend URL instead of the base64 string
            savedToolFiles.forEach(f => resultImages.push(f.url));
        }
        
        if (resultImages.length > 0) {
            exchange.tool.images = resultImages;
        }
        toolConversation.save(); // persist
        toolConversation._syncMessage('tool', resultText, null, exchange.id, {
            toolName: exchange.tool.name,
            toolArgs: exchange.tool.args,
            toolStatus: 'success',
            toolImages: exchange.tool.images || []
        });

        toolEl.querySelector('.tool-status').setAttribute('variant', 'success');
          toolEl.querySelector('.tool-status').innerHTML = 'Success';
          toolEl.querySelector('.tool-notifications').style.display = 'none';
        
        // Use textContent to prevent SVG/code examples from being parsed as HTML
        toolEl.querySelector('.tool-result').textContent = exchange.tool.content;
        
        if (exchange.tool.images && exchange.tool.images.length > 0) {
            const imagesDiv = toolEl.querySelector('.tool-images');
            imagesDiv.style.display = 'block';
            let imagesHtml = `<div class="tool-images-inner">`;
            exchange.tool.images.forEach(img => {
                imagesHtml += `<img src="${img}" class="tool-image" />`;
            });
            imagesHtml += `</div>`;
            imagesDiv.innerHTML = imagesHtml;
        }

        // 5. Automatically resume stream!
        // We will start a new pseudo-assistant stream using the toolExchangeId
        // The LLM will receive the shimmed 'user' message and continue generating.
        // Session ID is set per-chat inside streamResponse — no need to set it here.
        
        if (resumeStream) {
            await streamResponse(toolExchangeId, toolChatId, userExchangeId);
        }
        return toolExchangeId;
}

function setEmbedStatus(exchangeId, status, error = null, role = 'assistant') {
    const el = document.querySelector(`.chat-message.${role}[data-exchange-id="${exchangeId}"] .embed-status`);
    if (!el) return;
    _applyEmbedStatusAttrs(el, status, error);
}

// Direct attribute set on an embed-status element (no DOM query — for detached elements)
function _applyEmbedStatusAttrs(el, status, error = null) {
    el.dataset.embedStatus = status || 'unknown';
    const tooltip = status === 'embedded'
        ? 'Embedded in vector search'
        : status === 'pending'
            ? 'Embedding queued...'
            : status === 'failed'
                ? `Embed failed: ${error || 'unknown'}`
                : 'Embed status unknown';
    el.title = tooltip;
}

function connectEmbedEvents(chatId) {
    disconnectEmbedEvents();
    if (!chatId || CONFIG.enableBackend !== true) return;
    _embedEventChatId = chatId;
    const base = CONFIG.backendUrl || '';
    const url = `${base}/api/embed-events?chatId=${encodeURIComponent(chatId)}`;
    const es = new EventSource(url);
    es.addEventListener('embed-status', (e) => {
        try {
            const event = JSON.parse(e.data);
            if (!event || event.chatId !== _embedEventChatId) return;
            _applyEmbedEvent(event);
        } catch (err) {}
    });
    es.onerror = () => {
        // EventSource auto-reconnects; log only on hard failures
        if (es.readyState === EventSource.CLOSED) {
            console.warn('[Embed] SSE connection closed permanently for chat:', chatId);
        }
    };
    _embedEventSource = es;
}

function disconnectEmbedEvents() {
    if (_embedEventSource) {
        _embedEventSource.close();
        _embedEventSource = null;
    }
    _embedEventChatId = null;
}

function _applyEmbedEvent(event) {
    // event: { chatId, msgIdx, messageId, embedStatus, embedError }
    const conv = activeConversations.get(event.chatId);
    if (!conv || !conv.exchanges) return;

    // Try exact msgIdx match first (works for loaded exchanges with _asstMsgIdx/_userMsgIdx)
    for (const ex of conv.exchanges) {
        if (ex._asstMsgIdx === event.msgIdx) {
            if (ex.assistant && ex.assistant.embedStatus !== event.embedStatus) {
                ex.assistant.embedStatus = event.embedStatus;
                ex.assistant.embedError = event.embedError || null;
            }
            setEmbedStatus(ex.id, event.embedStatus, event.embedError);
            return;
        }
        if (ex._userMsgIdx === event.msgIdx) {
            setEmbedStatus(ex.id, event.embedStatus, event.embedError, 'user');
            return;
        }
    }

    // Fallback: positional matching for live exchanges that don't have msgIdx set yet
    // (SSE event may arrive before _syncMessage's .then() sets _asstMsgIdx)
    const asstExchanges = conv.exchanges.filter(ex =>
        ex.assistant && (ex.assistant.content || ex.assistant.isComplete)
    );
    const userExchanges = conv.exchanges.filter(ex =>
        ex.user && ex.user.content
    );

    // Estimate exchange index from msgIdx: even=user, odd=assistant (simple chats)
    // For tool exchanges, this is approximate but works as a fallback
    const estIdx = Math.floor(event.msgIdx / 2);
    const isUser = event.msgIdx % 2 === 0;

    if (isUser && estIdx < userExchanges.length) {
        const ex = userExchanges[estIdx];
        if (ex._userMsgIdx === undefined) ex._userMsgIdx = event.msgIdx;
        setEmbedStatus(ex.id, event.embedStatus, event.embedError, 'user');
    } else if (!isUser && estIdx < asstExchanges.length) {
        const ex = asstExchanges[estIdx];
        if (ex._asstMsgIdx === undefined) ex._asstMsgIdx = event.msgIdx;
        if (ex.assistant && ex.assistant.embedStatus !== event.embedStatus) {
            ex.assistant.embedStatus = event.embedStatus;
            ex.assistant.embedError = event.embedError || null;
        }
        setEmbedStatus(ex.id, event.embedStatus, event.embedError);
    }
}

function updateAssistantContent(el, content, reasoningContent = null) {
    const contentDiv = el.querySelector('.message-content');
    if (!contentDiv) return;

    let visibleContent = content;

    // Strip the injected timestamp from visible content (shown in header)
    if (el.dataset.timestampLen && visibleContent.startsWith('[')) {
        const len = parseInt(el.dataset.timestampLen);
        if (visibleContent.length >= len) {
            visibleContent = visibleContent.substring(len).trim();
        } else if (visibleContent.length < 20) {
            // Not enough content yet, likely still building up timestamp
            return;
        }
    } else if (visibleContent.startsWith('[')) {
        // Fallback: try to parse timestamp (for backwards compatibility)
        const tsParsed = parseTimestamp(visibleContent);
        visibleContent = tsParsed.cleanContent;
    }

    // Hide the entire assistant bubble if it's completely empty (or just contained the stripped TOOL_CALL)
    if (!visibleContent.trim() && (!reasoningContent || !reasoningContent.trim())) {
        el.style.display = 'none';
        // Note: we don't return here, so it updates the internal state in case it needs to re-appear later
    } else {
        el.style.display = '';
    }

    // Skip if content hasn't changed (prevents redundant renders during streaming)
    const rKey = reasoningContent || '';
    if (contentDiv.dataset.lastContent === visibleContent && contentDiv.dataset.lastReasoning === rKey) return;
    contentDiv.dataset.lastContent = visibleContent;
    contentDiv.dataset.lastReasoning = rKey;

    // Check if thinking-content is currently scrolled to bottom to maintain it
    let thinkingScrollTop = 0;
    let thinkingWasAtBottom = true;
    const oldThinkingContent = contentDiv.querySelector('.thinking-content');
    if (oldThinkingContent) {
        thinkingScrollTop = oldThinkingContent.scrollTop;
        const tolerance = 10;
        thinkingWasAtBottom = Math.abs(oldThinkingContent.scrollHeight - oldThinkingContent.scrollTop - oldThinkingContent.clientHeight) <= tolerance;
    }

    // Parse thinking and answer
    const parsed = parseThinking(visibleContent);
    
    // Explicit API reasoning_content overrides inline <think> tags
    if (reasoningContent) {
        parsed.thinking = reasoningContent;
        // if explicitly passed via API, the content doesn't have <think> tags so answer is just the content.
        // If we have reasoning but no main answer yet while streaming, reasoning is currently active.
        if (el.dataset.isStreaming === 'true' && !visibleContent.trim()) {
            parsed.isStreaming = true;
        }
    }

    // Use the element's actual streaming state, not just whether <think> is open
    const isNetworkStreaming = el.dataset.isStreaming === 'true';

    // INCREMENTAL DOM UPDATE PATTERN:
    // Only create elements once, then update in place

    // === THINKING BLOCK ===
    const thinkingId = 'thinking-' + el.dataset.exchangeId;
    let thinkingBlock = contentDiv.querySelector('.thinking-block');

    if (parsed.thinking !== null) {

        if (!thinkingBlock) {
            // Create thinking block once - it doesn't exist yet
            thinkingBlock = document.createElement('div');
            thinkingBlock.className = 'thinking-block collapsed';
            thinkingBlock.id = thinkingId;
            thinkingBlock.innerHTML = `
                <div class="thinking-header" onclick="toggleThinking('${thinkingId}')">
                    <nui-icon name="lightbulb_2" aria-hidden="true"><svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false"><use href="/lib/nui_wc2/NUI/assets/material-icons-sprite.svg#image"></use></svg></nui-icon>
                    <span class="thinking-title">Thoughts</span>
                    <span class="thinking-toggle">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <polyline points="6 9 12 15 18 9"></polyline>
                        </svg>
                    </span>
                </div>
                <div class="thinking-content"></div>
            `;
            contentDiv.appendChild(thinkingBlock);
        }

        // Update existing thinking block state and content
        // Always stay collapsed by default - user manually expands if they want to see it
        if (parsed.isStreaming) {
            thinkingBlock.classList.add('streaming');
            const titleEl = thinkingBlock.querySelector('.thinking-title');
            if (titleEl) titleEl.textContent = 'Thinking...';
        } else {
            thinkingBlock.classList.remove('streaming');
            const titleEl = thinkingBlock.querySelector('.thinking-title');
            if (titleEl) titleEl.textContent = 'Thoughts';
        }

        // Update thinking content text - only this changes during streaming
        const thinkingContent = thinkingBlock.querySelector('.thinking-content');
        if (thinkingContent) {
            thinkingContent.textContent = parsed.thinking;
        }
    } else if (thinkingBlock) {
        // No thinking but element exists - could remove it, or leave for now
        // Keeping it preserves collapsed state if user interacted with it
    }

    // === ANSWER BLOCK ===
    // Track answer container for incremental updates
    let answerContainer = contentDiv.querySelector('.answer-container');

    if (parsed.answer) {
        if (!answerContainer) {
            // Create answer container once
            answerContainer = document.createElement('div');
            answerContainer.className = 'answer-container';
            contentDiv.appendChild(answerContainer);

            const nuiMd = document.createElement('nui-markdown');
            answerContainer.appendChild(nuiMd);
            answerContainer.dataset.lastAnswerLen = 0;
        }

        const nuiMd = answerContainer.querySelector('nui-markdown');
        if (nuiMd) {
            const currentAnswerLen = parseInt(answerContainer.dataset.lastAnswerLen || '0', 10);
            const newAnswerLen = parsed.answer.length;

            if (isNetworkStreaming) {
                if (!nuiMd._isStreaming) nuiMd.beginStream();
                if (newAnswerLen > currentAnswerLen) {
                    const chunk = parsed.answer.substring(currentAnswerLen);
                    nuiMd.appendChunk(chunk);
                    answerContainer.dataset.lastAnswerLen = newAnswerLen;
                }
            } else {
                if (nuiMd._isStreaming) {
                    // End of an active stream
                    if (newAnswerLen > currentAnswerLen) {
                        const chunk = parsed.answer.substring(currentAnswerLen);
                        nuiMd.appendChunk(chunk);
                    }
                    nuiMd.endStream();
                    answerContainer.dataset.lastAnswerLen = newAnswerLen;
                } else if (newAnswerLen > currentAnswerLen) {
                    // Complete message (e.g. from history load)
                    if (window.nui?.util?.markdownToHtml) {
                        nuiMd.innerHTML = window.nui.util.markdownToHtml(parsed.answer);
                        // Prevent automatic connectedCallback from double-parsing if appended to DOM later
                        nuiMd._isStreaming = true;
                    } else {
                        // Module not ready: rely on declarative markup that upgrades automatically later
                        const safeContent = parsed.answer.replace(/<\/script/gi, '<\\/script');
                        nuiMd.innerHTML = `<script type="text/markdown">\n${safeContent}\n</script>`;
                    }
                    answerContainer.dataset.lastAnswerLen = newAnswerLen;
                }
            }
        }
    }

    // Restore thinking-content scroll position
    const newThinkingContent = contentDiv.querySelector('.thinking-content');
    if (newThinkingContent) {
        if (thinkingWasAtBottom) {
            newThinkingContent.scrollTop = newThinkingContent.scrollHeight;
        } else {
            newThinkingContent.scrollTop = thinkingScrollTop;
        }
    }

    // WI-2: streaming content changes the element's height — wake the loop
    // so it detects the growth and cascades. Keeps the loop awake through
    // generation pauses > 0.5s (VS_IDLE_FRAMES).
    const container = el.closest('.conversation-container');
    if (container) _vsWake(container);
}

window.toggleThinking = function(id) {
    const el = document.getElementById(id);
    if (el) {
        const isCollapsing = !el.classList.contains('collapsed');
        el.classList.toggle('collapsed');
        el.dataset.userToggled = 'true';  // Track that user manually toggled

        // When collapsing, scroll to bottom first so most recent thinking shows
        if (isCollapsing) {
            const content = el.querySelector('.thinking-content');
            if (content) {
                content.scrollTop = content.scrollHeight;
            }
        }

        // WI-2: height change detected by the frame loop (container click
        // listener wakes it). toggleThinking is now a pure CSS class toggle.
    }
};

function showCompactionIndicator(el, data) {
    const contentDiv = el.querySelector('.message-content');
    if (!contentDiv) return;
    
    let compactEl = contentDiv.querySelector('.compaction-indicator');
    if (!compactEl) {
        compactEl = document.createElement('div');
        compactEl.className = 'compaction-indicator';
        compactEl.innerHTML = '<span class="icon">ðŸ“</span> Compacting context...';
        contentDiv.insertBefore(compactEl, contentDiv.firstChild);
    }
}

function updateCompactionProgress(el, data) {
    // Could show progress bar here
}

function hideCompactionIndicator(el) {
    const compactEl = el.querySelector('.compaction-indicator');
    if (compactEl) {
        compactEl.remove();
    }
}

function showError(el, message) {
    const contentDiv = el.querySelector('.message-content');
    if (contentDiv) {
        contentDiv.innerHTML += `<div class="error-message">Error: ${escapeHtml(message)}</div>`;
    }
    
    // Hide streaming indicator
    const indicator = el.querySelector('.streaming-indicator');
    if (indicator) indicator.style.display = 'none';
}

function finalizeAssistantElement(el, exchangeId, usage = null, contextInfo = null, streamStats = null) {
    el.dataset.isStreaming = 'false';
    // Hide streaming indicator
    const indicator = el.querySelector('.streaming-indicator');
    if (indicator) indicator.classList.remove('visible');

    // Update static usage text if we have it
    const exchange = conversation.getExchange(exchangeId);
    let finalUsage = usage || exchange?.assistant?.usage;
    let finalContext = contextInfo || exchange?.assistant?.context;
    let finalStats = streamStats || exchange?.assistant?.streamStats;
    
    // Fallback to the saved version data if we are loading from history
    if (!finalUsage && !finalContext && exchange?.assistant) {
        const curVersion = exchange.assistant.versions?.[exchange.assistant.currentVersion || 0];
        if (curVersion) {
            finalUsage = curVersion.usage;
            finalContext = curVersion.context;
            finalStats = curVersion.streamStats || finalStats;
        }
    }

    if (finalContext) {
        updateUsageDisplay(el, finalContext, finalUsage, finalStats);
    } else if (exchange && exchange.assistant?.content) {
        // Fallback: estimate cumulative tokens by summing all exchanges up to this one
        let cumulativeChars = 0;
        const allExchanges = conversation.getAll();
        for (const ex of allExchanges) {
            const userText = ex.user && typeof ex.user.content === 'string' ? ex.user.content : '';
            let asstText = ex.assistant && typeof ex.assistant.content === 'string' ? ex.assistant.content : '';
            asstText = asstText.replace(/<think>[\s\S]*?<\/think>/g, '');
            cumulativeChars += userText.length + asstText.length;
            if (ex.id === exchange.id) break;
        }
        const roughTokens = Math.ceil(cumulativeChars / 4);
        updateUsageDisplay(el, { used_tokens: roughTokens, isEstimate: true });
    }

    // Show actions only if we have multiple versions or after regeneration
    const info = conversation.getVersionInfo(exchangeId);
    const actions = el.querySelector('.message-actions');
    if (actions && info?.hasMultiple) {
        actions.classList.add('visible');
        updateVersionControls(el, exchangeId);
        actions.querySelector('.speaker').style.display = 'inline-block';
    } else if (actions) {
        // Only show regenerate and speaker buttons initially
        actions.classList.add('visible');
        actions.querySelector('.regenerate').style.display = 'inline-block';
        actions.querySelector('.speaker').style.display = 'inline-block';
        actions.querySelector('.prev-version').style.display = 'none';
        actions.querySelector('.next-version').style.display = 'none';
        actions.querySelector('.version-info').style.display = 'none';
    }
    
    // Remove streaming class from thinking block
    const thinking = el.querySelector('.thinking-block.streaming');
    if (thinking) {
        thinking.classList.remove('streaming');
        thinking.querySelector('.thinking-title').textContent = 'Thinking';
    }

    // WI-2: element height is now stable — wake the loop to detect the
    // finalized height and cascade. (Replaces _vsOnContentGrown + _vsRecalcItem.)
    const container = el.closest('.conversation-container') || getActiveContainer();
    if (container) {
        _vsWake(container);
        _vsUpdateVisible(container);
    }
}

function updateVersionControls(el, exchangeId) {
    const info = conversation.getVersionInfo(exchangeId);
    if (!info) return;
    
    const infoEl = el.querySelector('.version-info');
    const prevBtn = el.querySelector('.prev-version');
    const nextBtn = el.querySelector('.next-version');
    const regenerateBtn = el.querySelector('.regenerate');
    
    // Show version info only when multiple versions exist
    if (info.hasMultiple) {
        if (infoEl) {
            infoEl.textContent = `${info.current}/${info.total}`;
            infoEl.style.display = 'inline-block';
        }
        if (prevBtn) prevBtn.style.display = 'inline-block';
        if (nextBtn) nextBtn.style.display = 'inline-block';
    } else {
        if (infoEl) infoEl.style.display = 'none';
        if (prevBtn) prevBtn.style.display = 'none';
        if (nextBtn) nextBtn.style.display = 'none';
    }
    
    // Always show regenerate
    if (regenerateBtn) regenerateBtn.style.display = 'inline-block';
    // Always show speaker
    const speakerBtn = el.querySelector('.speaker');
    if (speakerBtn) speakerBtn.style.display = 'inline-block';
}

// ============================================
// Actions
// ============================================

function getAssistantPlainText(exchangeId) {
    const exchange = conversation.getExchange(exchangeId);
    if (!exchange || !exchange.assistant) return '';
    let content = exchange.assistant.content || '';
    const parsed = parseTimestamp(content);
    content = parsed.cleanContent || content;
    return getPlainText(content);
}

function stopTts() {
    if (tts) tts.stop();
    currentTtsExchangeId = null;
}

function toggleTts(exchangeId, el) {
    if (!tts) return;

    // Same message while active:
    //   loading → cancel generation (only explicit cancel path besides stop/new speak)
    //   playing/paused → pause/resume (download keeps running)
    // Different message → new speak (replaces session, aborts prior download).
    if (currentTtsExchangeId === exchangeId && tts.isActive()) {
        if (tts.getPlaybackState() === 'loading') {
            stopTts(); // cancel()
            return;
        }
        ttsPlayer?.reveal();
        tts.togglePause();
        return;
    }

    const text = getAssistantPlainText(exchangeId);
    if (!text) return;

    currentTtsExchangeId = exchangeId;
    ttsPlayer?.reveal();
    tts.speak(text, el);
}

async function regenerate(exchangeId) {
    if (client.hasActiveStream(currentChatId)) return;
    
    conversation.regenerateResponse(exchangeId);

    // Remove old assistant element
    const oldEl = document.querySelector(`.chat-message.assistant[data-exchange-id="${exchangeId}"]`);
    if (oldEl) {
        oldEl.querySelector('.message-content').innerHTML = '';
        oldEl.querySelector('.streaming-indicator').classList.add('visible');
        oldEl.querySelector('.message-actions').classList.remove('visible');
        // WI-2: height change detected by the frame loop. If the element is
        // off-screen (detached), the change is invisible anyway — offsets
        // reconcile when the user scrolls back and the loop re-attaches it.
        const container = oldEl.closest('.conversation-container');
        if (container) _vsWake(container);
    }

    // Stream new response — pass currentChatId to lock to the correct chat
    currentExchangeId = exchangeId;
    await streamResponse(exchangeId, currentChatId);
}

function switchVersion(exchangeId, direction) {
    const directionKey = direction === 'prev' ? 'prev' : 'next';
        if (conversation.switchVersion(exchangeId, directionKey)) {
        const exchange = conversation.getExchange(exchangeId);
        const el = document.querySelector(`.chat-message.assistant[data-exchange-id="${exchangeId}"]`);
        if (el) {
            updateAssistantContent(el, exchange.assistant.content, exchange.assistant.reasoning_content);
            updateVersionControls(el, exchangeId);
            finalizeAssistantElement(el, exchangeId);
            // WI-2: height change detected by the frame loop (updateAssistantContent
            // calls _vsWake via its container lookup).
        }
    }
}

async function copyMessageToClipboard(exchangeId, btn) {
    const exchange = conversation.getExchange(exchangeId);
    if (!exchange) return;
    
    // Always use assistant, but can be generic if needed
    const rawContent = exchange.assistant.content;
    const currentContent = parseTimestamp(rawContent).cleanContent;
    const parsed = parseThinking(currentContent);
    const mdToCopy = parsed.answer || currentContent;
    const textToCopy = mdToCopy.trim();
    
    try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(textToCopy);
        } else {
            // Fallback for non-https environments where navigator.clipboard is missing
            const textArea = document.createElement('textarea');
            textArea.value = textToCopy;
            textArea.style.position = 'fixed'; // Avoid scrolling to bottom
            textArea.style.opacity = '0';
            document.body.appendChild(textArea);
            textArea.focus();
            textArea.select();
            document.execCommand('copy');
            document.body.removeChild(textArea);
        }
        const icon = btn.querySelector('nui-icon');
        const oldIconName = icon.getAttribute('name');
        icon.setAttribute('name', 'check');
        setTimeout(() => icon.setAttribute('name', oldIconName), 2000);
    } catch (err) {
        console.error('Failed to copy text: ', err);
    }
}

async function startEditMode(exchangeId, role = 'user') {
    // Block editing only if this specific exchange in the current chat is currently streaming
    if (client.hasActiveStream(currentChatId) && currentExchangeId === exchangeId) return;

    // Capture chat context at call time — the dialog is async and the user may
    // switch tabs while it's open. We must save edits to the original conversation.
    const editConv = conversation;
    const editChatId = currentChatId;

    const exchange = editConv.getExchange(exchangeId);
    if (!exchange) return;

    const rawContent = role === 'user' ? exchange.user.content : exchange.assistant.content;
    const currentContent = parseTimestamp(rawContent).cleanContent;

    const parsed = parseThinking(currentContent);
    // Even if it has thinking, we only edit the final parsed answer
    const editableContent = parsed.answer || currentContent;

    const contentHtml = `
        <div class="edit-dialog-container">
            <nui-rich-text class="edit-textarea"></nui-rich-text>
        </div>
    `;

    const { dialog, main } = await nui.components.dialog.page('Edit Message', '', {
        contentScroll: false, 
        buttons: [
            { label: 'Cancel', type: 'outline', value: 'cancel' },
            { label: role === 'user' ? 'Save & Resubmit' : 'Save', type: 'primary', value: 'save' }
        ]
    });
    main.innerHTML = contentHtml;

    // Initialize content using standard NUI method on connected nodes
    const applyContent = () => {
        const tb = main.querySelector('nui-rich-text');
        if(tb && tb.setMarkdown) tb.setMarkdown(editableContent);
    };
    
    // Auto focus the appended textarea within the dialog
    const focusArea = main.querySelector('nui-rich-text');
    if (focusArea) {
        // give dialog time to mount
        setTimeout(() => {
            applyContent();
            // NuiRichText inner editor focus
            const editor = focusArea.querySelector('.nui-rich-text-editor');
            if (editor) editor.focus();
        }, 100);
    }

    dialog.addEventListener('nui-dialog-close', (e) => {
        const action = e.detail?.returnValue;
        if (action !== 'save') return;

        let newContent = main.querySelector('nui-rich-text')?.getMarkdown().trim() || '';
        
        // Ensure if there was original thinking we retain it unedited in the saved state
        if (parsed.thinking) {
            newContent = `<think>\n${parsed.thinking}\n</think>\n\n${newContent}`.trim();
        }

        if (newContent && newContent !== currentContent) {
            commitEdit(exchangeId, role, newContent, editConv, editChatId);
        }
    });
}

function commitEdit(exchangeId, role, newContent, editConv, editChatId) {
    // Use the captured conversation for the chat being edited, not the global.
    // editConv is captured in startEditMode before the async dialog opens,
    // so it's safe even if the user switched tabs while editing.
    const conv = editConv || conversation;
    const exchange = conv.getExchange(exchangeId);
    if (!exchange) return;

    if (role === 'user') {
        // 1. Update content with timestamp
        const timestamp = conv._formatTimestamp(new Date(exchange.timestamp));
        exchange.user.content = `${timestamp} ${newContent}`;

        // 2. Sync full state (content changed in-place, not append) and render
        conv._syncFullState();
        renderConversation();
    } else {
        // 1. Update content for assistant with timestamp
        const timestamp = conv._formatTimestamp();
        const contentWithTimestamp = `${timestamp} ${newContent}`;
        exchange.assistant.content = contentWithTimestamp;

        // Update the current version to match
        if (exchange.assistant.versions && exchange.assistant.versions.length > 0) {
            const currentVersionObj = exchange.assistant.versions[exchange.assistant.currentVersion] || exchange.assistant.versions[0];
            if (currentVersionObj) {
                currentVersionObj.content = contentWithTimestamp;
            }
        }

        // 2. Truncate conversation downstream
        conv.truncateAfter(exchangeId);

        // 3. Save manually since we aren't streaming
        conv.save();

        // 4. Render wipes downstream
        renderConversation();
    }
}

// ============================================
// History Management
// ============================================

async function startNewChat() {
    // Note: we do NOT abort background streams when starting a new chat.
    // Each chat's stream continues in its hidden containers.

    const newChatId = await chatHistory.create();
    currentChatId = newChatId;

    // Reset model selection for the new chat — user must explicitly choose
    currentModel = '';
    if (elements.modelSelect.setValue) {
        elements.modelSelect.setValue('');
    } else {
        const select = elements.modelSelect?.querySelector('select');
        if (select) select.value = '';
    }

    // Cache the new conversation
    conversation = new Conversation(`chat-conversation-${currentChatId}`);
    activeConversations.set(currentChatId, conversation);

    // Create container for the new chat (hidden until shown)
    const newContainer = getOrCreateContainer(currentChatId);

    // Toggle: show new chat, hide others
    for (const [id, container] of chatContainers.entries()) {
        container.style.display = id === currentChatId ? 'flex' : 'none';
    }

    renderHistoryList();
    renderConversation(); // container is empty, will show welcome

    // Auto-focus input
    setTimeout(() => {
        const textarea = elements.messageInput?.querySelector('textarea');
        if (textarea) textarea.focus();
    }, 100);
}

function restoreSystemPromptUI(chatInfo) {
    if (chatInfo && elements.systemPrompt) {
        const textarea = elements.systemPrompt.querySelector('textarea');
        if (textarea) {
            textarea.value = chatInfo.systemPrompt || '';
            // Reset preset selector
            const select = elements.presetSelect?.querySelector('select');
            if (select) select.value = '';
        }
    }
}

async function switchChat(targetChatId) {
    // Capture the outgoing conversation before changing currentChatId.
    // We MUST set currentChatId BEFORE any await — otherwise sendMessage()
    // can fire during the yield point and capture the old chatId, sending
    // the user's message into the wrong conversation.
    const oldConv = conversation;
    currentChatId = targetChatId;
    storage.setActiveChatId(currentChatId).catch(() => {});

    // Reset preview pane — it's a shared surface across per-chat containers.
    // Without this, chat B would see chat A's preview. Idempotent: safe on init.
    preview.reset();

    // Save the outgoing conversation (now safe — currentChatId already updated)
    if (oldConv) {
        await oldConv.save();
    }

    // 1. Get or create the container for this chat (creates DOM node if first time)
    const targetContainer = getOrCreateContainer(targetChatId);

    // 2. Load conversation from cache or backend
    let conv = activeConversations.get(targetChatId);
    if (!conv) {
        conv = new Conversation(`chat-conversation-${targetChatId}`);
        await conv.load();
        activeConversations.set(targetChatId, conv);
    }
    conversation = conv;

    // 3. Sync session ID from the Conversation object itself.
    // conv.sessionId is always set (derived from storageKey), unlike
    // chatHistory which may be empty when backend is disabled.
    if (conv.sessionId) {
        client.setSessionId(conv.sessionId);
    } else {
        console.warn('[Session] switchChat MISSING sessionId for chatId:', targetChatId);
    }

    // 4. Build historical DOM if this is the first time viewing this session
    if (targetContainer.children.length === 0) {
        await buildHistoricalDomForChat(conversation, targetContainer);
    }

    // 5. Toggle container visibility — all other streams continue in their hidden containers
    for (const [id, container] of chatContainers.entries()) {
        container.style.display = id === targetChatId ? 'flex' : 'none';
    }

    // 6. Activate virtual scroll after container is visible and web components settle
    if (targetContainer.children.length > 0 && !targetContainer.querySelector('.vs-stage')) {
        _vsActivateWhenReady(targetContainer);
    }

    // Restore the system prompt
    const chatInfo = chatHistory.get(targetChatId);
    restoreSystemPromptUI(chatInfo);

    // 6. Restore the model if saved in history
    if (chatInfo && elements.modelSelect) {
        if (chatInfo.model) {
            const modelExists = models.some(m => m.id === chatInfo.model);
            if (modelExists) {
                currentModel = chatInfo.model;
            } else if (models.length > 0) {
                currentModel = models[0].id;
            }
        } else if (models.length > 0) {
            currentModel = models[0].id;
        }

        if (elements.modelSelect.setValue) {
            elements.modelSelect.setValue(currentModel);
        } else {
            const select = elements.modelSelect.querySelector('select');
            if (select) select.value = currentModel;
        }
    }

    // 7. Update UI without wiping background containers
    renderHistoryList();
    updateOverallContext();

    // 8. Sync send button state with whether THIS chat has an active stream
    // The input area is shared across chats, so we must show correct state for the visible chat
    const targetChatIsStreaming = client.hasActiveStream(targetChatId);
    const btn = elements.sendBtn?.querySelector('button');
    if (btn) {
        btn.innerHTML = targetChatIsStreaming
            ? '<nui-icon name="close"></nui-icon>'
            : '<nui-icon name="send"></nui-icon>';
    }

    // Clear new-content indicator since the user is viewing this chat now
    if (chatsWithNewContent.has(targetChatId)) {
        chatsWithNewContent.delete(targetChatId);
        const item = elements.chatHistoryList?.querySelector(`[data-chat-id="${targetChatId}"]`);
        if (item) item.classList.remove('new-content');
    }

    // Start embed polling for the newly active chat
    connectEmbedEvents(targetChatId);

    console.log('%c📋 DISPLAY %c' + (chatInfo?.title || 'New Chat') + ' %c' + targetChatId,
        'font-weight:bold;color:#4fc3f7', 'color:#aaa', 'color:#666');
}

async function deleteChat(chatId, e) {
    if (e) {
        e.stopPropagation(); // prevent row click
    }

    // Skip confirmation on shift-click
    const skipConfirm = e?.shiftKey;

    if (!skipConfirm && !await nui.components.dialog.confirm('Delete Chat', 'Are you sure you want to delete this chat?')) {
        return;
    }

    // Delete images from imageStore for this chat
    try {
        const exchanges = await storage.loadConversation(chatId);
        for (const ex of exchanges) {
            await imageStore.delete(ex.id);
        }
    } catch (err) {
        console.warn('[Chat] Failed to delete images for chat', chatId, err);
    }

    // Delete from chat history (handles backend deletion)
    chatHistory.delete(chatId);

    // Abort any ongoing stream for this chat
    client.abortStream(chatId);

    // Clean up multi-conversation state
    activeConversations.delete(chatId);
    const container = chatContainers.get(chatId);
    if (container) {
        container.remove();
        chatContainers.delete(chatId);
    }

    // Immediately re-render the history list to reflect deletion
    renderHistoryList();

    if (currentChatId === chatId) {
        const allChats = chatHistory.getAll();
        if (allChats.length > 0) {
            await switchChat(allChats[0].id);
        } else {
            await startNewChat();
        }
    }
}

async function exportChatAsJson(chatId, btn) {
    // Export from in-memory conversation object (source of truth for current session state)
    const conv = activeConversations.get(chatId);
    const exchanges = conv ? conv.getAll() : [];
    if (!exchanges || exchanges.length === 0) {
        nui.components.toast?.error?.('No messages to export');
        return;
    }

    try {
        const meta = chatHistory.get(chatId) || {};

        const exportExchanges = exchanges.map(ex => {
            if (ex.type === 'tool') {
                return {
                    id: ex.id,
                    type: ex.type,
                    timestamp: ex.timestamp,
                    tool: { name: ex.tool?.name, status: ex.tool?.status },
                    assistant: ex.assistant ? {
                        content: ex.assistant.content,
                        isComplete: ex.assistant.isComplete,
                        isStreaming: ex.assistant.isStreaming,
                        usage: ex.assistant.usage,
                        context: ex.assistant.context,
                        embedStatus: ex.assistant.embedStatus || null,
                        embedError: ex.assistant.embedError || null,
                    } : null,
                };
            }
            return {
                id: ex.id,
                type: ex.type,
                timestamp: ex.timestamp,
                user: ex.user ? { content: ex.user.content, attachments: ex.user.attachments, embedStatus: ex.user.embedStatus || null, embedError: ex.user.embedError || null } : null,
                assistant: ex.assistant ? {
                    content: ex.assistant.content,
                    isComplete: ex.assistant.isComplete,
                    isStreaming: ex.assistant.isStreaming,
                    usage: ex.assistant.usage,
                    context: ex.assistant.context,
                    embedStatus: ex.assistant.embedStatus || null,
                    embedError: ex.assistant.embedError || null,
                    reasoning_content: ex.assistant.reasoning_content || null,
                    thinking_signature: ex.assistant.thinking_signature || null,
                    streamStats: ex.assistant.streamStats || null,
                } : null,
            };
        });

        const exportData = {
            version: 2,
            mode: 'direct',
            exportedAt: new Date().toISOString(),
            id: chatId,
            chatInfo: {
                id: meta.id || chatId,
                title: meta.title || 'New Chat',
                createdAt: meta.createdAt || Date.now(),
                updatedAt: meta.updatedAt || Date.now(),
                model: meta.model || '',
                systemPrompt: meta.systemPrompt || '',
                category: meta.category || '',
                pinned: !!meta.pinned
            },
            participants: [
                { name: 'user', model: null, role: 'user', systemPrompt: null },
                { name: 'assistant', model: meta.model || '', role: 'assistant', systemPrompt: null }
            ],
            settings: { model: meta.model || '', systemPrompt: meta.systemPrompt || '' },
            summary: null,
            exchanges: exportExchanges
        };

        const formattedJson = JSON.stringify(exportData, null, 2);
        try {
            await navigator.clipboard.writeText(formattedJson);
            nui.components.toast?.success?.('JSON copied to clipboard');
        } catch (clipErr) {
            // Clipboard API may fail on insecure origins (HTTP) — fall back to textarea
            try {
                const textArea = document.createElement('textarea');
                textArea.value = formattedJson;
                textArea.style.position = 'fixed';
                textArea.style.opacity = '0';
                document.body.appendChild(textArea);
                textArea.focus();
                textArea.select();
                document.execCommand('copy');
                document.body.removeChild(textArea);
                nui.components.toast?.success?.('JSON copied to clipboard');
            } catch (fallbackErr) {
                console.error('Failed to copy JSON to clipboard', fallbackErr);
                console.log(formattedJson);
                nui.components.toast?.success?.('JSON logged to console');
            }
        }
    } catch (e) {
        console.error('Failed to parse chat data', e);
    }
}

async function exportChatToFile(chatId) {
    console.log('[DEBUG] exportChatToFile called with chatId:', chatId);
    // Full export including images - for backup/restore
    // Prefer in-memory conversation (current session), fall back to storage
    const conv = activeConversations.get(chatId);
    const exchanges = conv ? conv.getAll() : await storage.loadConversation(chatId);
    console.log('[DEBUG] exportChatToFile exchanges:', exchanges?.length, 'from memory:', !!conv);
    if (!exchanges || exchanges.length === 0) {
        console.warn('[DEBUG] exportChatToFile: no exchanges found, aborting');
        return;
    }

    try {
        const meta = chatHistory.get(chatId) || {};
        const exportExchanges = [];

        // Load images for each exchange
        for (const ex of exchanges) {
            const exportExchange = { ...ex };

            if (ex.user?.attachments?.some(att => att.hasImage)) {
                const images = await imageStore.load(ex.id);
                exportExchange.user = {
                    ...ex.user,
                    attachments: await Promise.all(ex.user.attachments.map(async (att, idx) => {
                        const img = images[idx];
                        if (img) {
                            return {
                                ...att,
                                dataUrl: await img.getDataUrl()
                            };
                        }
                        return att;
                    }))
                };
            }
            exportExchanges.push(exportExchange);
        }

        const exportData = {
            version: 2,
            mode: 'direct',
            exportedAt: new Date().toISOString(),
            id: chatId,
            chatInfo: {
                id: meta.id || chatId,
                title: meta.title || 'New Chat',
                createdAt: meta.createdAt || Date.now(),
                updatedAt: meta.updatedAt || Date.now(),
                model: meta.model || '',
                systemPrompt: meta.systemPrompt || '',
                category: meta.category || '',
                pinned: !!meta.pinned
            },
            participants: [
                { name: 'user', model: null, role: 'user', systemPrompt: null },
                { name: 'assistant', model: meta.model || '', role: 'assistant', systemPrompt: null }
            ],
            settings: {
                model: meta.model || '',
                systemPrompt: meta.systemPrompt || ''
            },
            summary: null,
            exchanges: exportExchanges
        };

        const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const title = exportData.chatInfo.title
            ? exportData.chatInfo.title.replace(/[^a-z0-9]/gi, '_').toLowerCase().substring(0, 30)
            : 'chat';
        const date = new Date().toISOString().split('T')[0];
        const filename = `direct-${title}-${date}.json`;

        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        console.log('[DEBUG] exportChatToFile download triggered:', filename);

    } catch (e) {
        console.error('Failed to export chat to file', e);
        nui.components.dialog.alert('Export Failed', 'Could not export chat session.');
    }
}

async function handleChatImport(e) {
    const file = e.target.files?.[0];
    if (!file) return;

    e.target.value = '';

    try {
        const text = await file.text();
        const importData = JSON.parse(text);

        if (!importData.exchanges || !Array.isArray(importData.exchanges)) {
            throw new Error('Invalid format: missing exchanges array');
        }

        const newChatId = await chatHistory.create();
        const title = importData.chatInfo?.title || 'Imported Chat';

        const meta = chatHistory.conversations.find(c => c.id === newChatId);
        if (meta) {
            meta.title = title;
            meta.model = importData.chatInfo?.model || '';
            meta.systemPrompt = importData.chatInfo?.systemPrompt || '';
            meta.category = importData.chatInfo?.category || '';
            meta.pinned = !!importData.chatInfo?.pinned;
            meta._dirty = true;
        }
        await chatHistory._saveList();

        // Re-upload images to server so dataUrls become server URLs.
        // Then replay every message to the backend in order via sendMessage.
        // (storage.saveConversation is a no-op since offline caching was removed;
        // the backend conversation doc is the source of truth.)
        for (const ex of importData.exchanges) {
            let savedAttachments = null;
            if (ex.user?.attachments?.some(att => att.dataUrl)) {
                const attachmentImages = ex.user.attachments
                    .filter(att => att.dataUrl)
                    .map(att => ({ dataUrl: att.dataUrl, name: att.name, type: att.type }));
                if (attachmentImages.length > 0) {
                    const savedFiles = await imageStore.save(ex.id, attachmentImages);
                    savedAttachments = ex.user.attachments.map((att, idx) => ({
                        name: att.name,
                        type: att.type,
                        hasImage: true,
                        dataUrl: (savedFiles && savedFiles[idx]?.url) || att.dataUrl
                    }));
                }
            }

            if (ex.type === 'tool') {
                const toolBody = {
                    role: 'tool',
                    content: ex.tool?.content || '',
                    toolName: ex.tool?.name,
                    toolArgs: ex.tool?.args,
                    toolStatus: ex.tool?.status,
                    toolImages: ex.tool?.images || []
                };
                await backendClient.sendMessage(newChatId, toolBody).catch(err => {
                    console.warn('[Import] tool message failed:', err.message);
                });
            } else {
                if (ex.user?.content) {
                    await backendClient.sendMessage(newChatId, {
                        role: 'user',
                        content: ex.user.content,
                        attachments: savedAttachments || (ex.user.attachments || []).map(att => ({
                            name: att.name,
                            type: att.type,
                            dataUrl: att.dataUrl
                        }))
                    }).catch(err => {
                        console.warn('[Import] user message failed:', err.message);
                    });
                }

                if (ex.assistant?.isComplete && (ex.assistant.content || ex.assistant.reasoning_content || ex.assistant.tool_calls)) {
                    const metadata = {};
                    if (ex.assistant.reasoning_content) metadata.reasoning_content = ex.assistant.reasoning_content;
                    if (ex.assistant.thinking_signature) metadata.thinking_signature = ex.assistant.thinking_signature;
                    if (ex.assistant.streamStats) metadata.streamStats = ex.assistant.streamStats;
                    if (ex.assistant.usage) metadata.usage = ex.assistant.usage;
                    if (ex.assistant.context) metadata.context = ex.assistant.context;

                    await backendClient.sendMessage(newChatId, {
                        role: 'assistant',
                        content: ex.assistant.content || '',
                        model: importData.chatInfo?.model || ex.model || null,
                        ...metadata
                    }).catch(err => {
                        console.warn('[Import] assistant message failed:', err.message);
                    });
                }
            }
        }

        renderHistoryList();
        await switchChat(newChatId);

        nui.components.toast?.success?.('Chat imported successfully');

    } catch (err) {
        console.error('Failed to import chat', err);
        nui.components.dialog.alert('Import Failed', `Could not import chat: ${err.message}`);
    }
}

async function exportChatAsMarkdown(chatId) {
    // Prefer in-memory conversation (current session), fall back to storage
    const conv = activeConversations.get(chatId);
    const exchanges = conv ? conv.getAll() : await storage.loadConversation(chatId);
    console.log('[DEBUG] exportChatAsMarkdown exchanges:', exchanges?.length, 'from memory:', !!conv);
    if (!exchanges || exchanges.length === 0) {
        console.warn('[DEBUG] exportChatAsMarkdown: no exchanges found, aborting');
        return;
    }

    try {
        let md = "";

        const chatInfo = chatHistory.get(chatId);
        if (chatInfo) {
            md += `# ${chatInfo.title || 'Chat'}\n\n`;
            md += `*Model: ${chatInfo.model || 'Unknown'} | Date: ${new Date(chatInfo.timestamp).toLocaleString()}*\n\n---\n\n`;
        }

        for (const ex of exchanges) {
            md += `### User\n\n${ex.user.content}\n\n`;
            if (ex.assistant && ex.assistant.content) {
                md += `### Assistant\n\n${ex.assistant.content}\n\n`;
            }
            md += `---\n\n`;
        }

        const blob = new Blob([md], { type: 'text/markdown' });
        const url = URL.createObjectURL(blob);
        const title = chatInfo && chatInfo.title ? chatInfo.title.replace(/[^a-z0-9]/gi, '_').toLowerCase() : 'chat';
        const filename = `chat_${title}_${chatId}.md`;

        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        console.log('[DEBUG] exportChatAsMarkdown download triggered:', filename);
    } catch (e) {
        console.error("Failed to export markdown", e);
    }
}

function updateChatTitle(chatId, firstMessageContent) {
    const meta = chatHistory.conversations.find(c => c.id === chatId);
    if (meta && (meta.title === 'New Chat' || meta.title === 'Old Chat')) {
        meta.title = firstMessageContent.substring(0, 30) + (firstMessageContent.length > 30 ? '...' : '');
        meta._dirty = true;
        chatHistory._saveList();
        renderHistoryList();
    }
}

function updateChatModel(chatId, modelId) {
    const meta = chatHistory.conversations.find(c => c.id === chatId);
    if (meta && meta.model !== modelId) {
        meta.model = modelId;
        meta._dirty = true;
        chatHistory._saveList();
    }
}

function updateChatSystemPrompt(chatId, promptText) {
    const meta = chatHistory.conversations.find(c => c.id === chatId);
    if (meta && meta.systemPrompt !== promptText) {
        meta.systemPrompt = promptText;
        meta._dirty = true;
        chatHistory._saveList();
    }
}

// ============================================
// Sidebar Streaming Indicators
// ============================================

/**
 * Shows a pulsing indicator on a chat in the sidebar when it's streaming in the background.
 */
function markChatAsStreaming(chatId, isStreaming) {
    const item = elements.chatHistoryList?.querySelector(`[data-chat-id="${chatId}"]`);
    if (item) {
        item.classList.toggle('streaming', isStreaming);
    }
}

/**
 * Shows a "new content" indicator on a background chat that received a response.
 */
function markChatActivity(chatId) {
    const item = elements.chatHistoryList?.querySelector(`[data-chat-id="${chatId}"]`);
    if (item) {
        item.classList.add('new-content');
    }
}

function renderHistoryList() {
    if (!elements.chatHistoryList) return;

    const allChats = chatHistory.getAll();

    elements.chatHistoryList.innerHTML = '';

    if (allChats.length === 0) {
        const emptyMsg = document.createElement('div');
        emptyMsg.className = 'chat-history-empty';
        emptyMsg.textContent = 'No previous chats.';
        elements.chatHistoryList.appendChild(emptyMsg);
        return;
    }

    const groupedChats = {};
    for (const chat of allChats) {
        const cat = chat.category ? chat.category.trim() : 'Uncategorized';
        if (!groupedChats[cat]) groupedChats[cat] = [];
        groupedChats[cat].push(chat);
    }

    const categories = Object.keys(groupedChats).sort((a, b) => {
        if (a === 'Uncategorized') return -1;
        if (b === 'Uncategorized') return 1;
        return a.localeCompare(b);
    });

    categories.forEach(cat => {
        const categoryGroup = document.createElement('div');
        categoryGroup.className = 'chat-history-category';
        
        // Add a subtle header for the category (unless it's the only one and it's Uncategorized)
        if (categories.length > 1 || cat !== 'Uncategorized') {
            const header = document.createElement('div');
            header.className = 'chat-history-category-header';
            header.textContent = cat;
            categoryGroup.appendChild(header);
        }

        groupedChats[cat].forEach(chat => {
            const isActive = chat.id === currentChatId;
            const item = document.createElement('div');
            item.className = 'chat-history-item' + (isActive ? ' active' : '');
            item.dataset.chatId = chat.id;

            const titleDiv = document.createElement('div');
            titleDiv.className = 'chat-history-item-title-container';

            const topRow = document.createElement('div');
            topRow.className = 'chat-history-item-top-row';

            if (chat.pinned) {
                const pinIcon = document.createElement('nui-icon');
                pinIcon.setAttribute('name', 'star_rate');
                pinIcon.className = 'chat-history-item-pin';
                topRow.appendChild(pinIcon);
            }

            const titleSpan = document.createElement('span');
            titleSpan.className = 'chat-history-item-title';
            titleSpan.textContent = chat.title || 'New Chat';
            titleSpan.title = chat.summary ? `${chat.title}\n\n${chat.summary}` : chat.title;

            topRow.appendChild(titleSpan);
            titleDiv.appendChild(topRow);

            const metaDiv = document.createElement('div');
            metaDiv.className = 'chat-history-item-meta';

            const dateSpan = document.createElement('span');
            const dateObj = new Date(chat.updatedAt || chat.createdAt || Date.now());
            dateSpan.textContent = dateObj.toLocaleDateString(undefined, {month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'});

            const countSpan = document.createElement('span');
            countSpan.textContent = `${chat.messageCount || 0} msgs`;

            metaDiv.appendChild(dateSpan);
            metaDiv.appendChild(countSpan);
            titleDiv.appendChild(metaDiv);

            const actionsDiv = document.createElement('div');
            actionsDiv.className = 'chat-history-item-actions';

            // Edit button only renders for the active conversation — opening it on an
            // inactive one is ambiguous (would the edits apply to the active chat or
            // the clicked one?). Load the conversation first, then edit.
            if (isActive) {
                const optionsBtn = document.createElement('nui-button');
                optionsBtn.className = 'chat-history-item-action';
                optionsBtn.innerHTML = '<button type="button"><nui-icon name="edit"></nui-icon></button>';
                optionsBtn.title = 'Chat Options';
                optionsBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    openChatOptions(chat.id);
                });
                actionsDiv.appendChild(optionsBtn);
            }

            item.appendChild(titleDiv);
            item.appendChild(actionsDiv);
            
            item.addEventListener('click', (e) => {
                if (e.ctrlKey || e.metaKey) {
                    e.preventDefault();
                    e.stopPropagation();
                    navigator.clipboard.writeText(chat.id).then(() => {
                        nui.components.toast?.success?.(`Copied ID: ${chat.id}`);
                    }).catch(err => {
                        console.error('Failed to copy text: ', err);
                    });
                    return;
                }
                switchChat(chat.id);
            });
            categoryGroup.appendChild(item);
        });

        elements.chatHistoryList.appendChild(categoryGroup);
    });
}

async function openChatOptions(chatId) {
    const chatMeta = chatHistory.conversations.find(c => c.id === chatId);
    if (!chatMeta) return;

    const template = document.getElementById('chat-options-template');
    if (!template) return;
    
    const content = template.content.cloneNode(true);

    // Stamp chatId onto the wrapper so the centralized nui-action handler can find it
    const wrapper = content.firstElementChild;
    if (wrapper) wrapper.dataset.chatId = chatId;

    // Bind initial values
    const titleInput = content.getElementById('chat-options-title-input');
    const categoryInput = content.getElementById('chat-options-category-input');
    const pinToggle = content.getElementById('chat-options-pin-toggle');
    const createdDateSpan = content.getElementById('chat-options-created-date');
    const updatedDateSpan = content.getElementById('chat-options-updated-date');
    const msgCountSpan = content.getElementById('chat-options-msg-count');

    if (titleInput) titleInput.value = chatMeta.title || 'New Chat';
    if (categoryInput) categoryInput.value = chatMeta.category || '';
    if (pinToggle) pinToggle.checked = !!chatMeta.pinned;
    if (createdDateSpan) createdDateSpan.textContent = new Date(chatMeta.timestamp).toLocaleString();
    if (updatedDateSpan) updatedDateSpan.textContent = new Date(chatMeta.updatedAt).toLocaleString();

    // Button actions are handled centrally via data-action="chat-options:*" — see handleChatOptionsAction()

    // Create programmatic page dialog
    const { dialog, main } = await nui.components.dialog.page('Edit Chat Options', '', {
        contentScroll: true,
        buttons: [
            { value: 'cancel', label: 'Cancel', type: 'outline' },
            { value: 'save', label: 'Save Changes', type: 'primary' }
        ]
    });
    main.appendChild(content);
    main._dialog = dialog;  // expose for action handler (close on clone/delete)

    // Async load message count
    if (msgCountSpan) msgCountSpan.textContent = 'Counting...';
    storage.loadConversation(chatId).then(exchanges => {
        if (!exchanges || !msgCountSpan) return;
        let total = 0;
        exchanges.forEach(ex => {
            if (ex.user) total++;
            if (ex.assistant) total++;
            if (ex.tool) total++;
        });
        msgCountSpan.textContent = total.toString();
    }).catch(() => {
        if (msgCountSpan) msgCountSpan.textContent = 'Error';
    });

    dialog.addEventListener('nui-dialog-close', (e) => {
        console.log('nui-dialog-close event emitted:', e.detail);
        const action = e.detail?.returnValue || e.detail?.value || e.detail?.id;
        
        if (action === 'cancel') {
            // dialog is already closed
        } else if (action === 'save') {
           const newTitle = titleInput?.value.trim() || '';
           const newCategory = categoryInput?.value.trim() || '';
           const newPinned = pinToggle?.checked || false;
           
           let changed = false;
           if (newTitle && chatMeta.title !== newTitle) {
               chatMeta.title = newTitle;
               changed = true;
           }
           if (chatMeta.category !== newCategory) {
               chatMeta.category = newCategory;
               changed = true;
           }
           if (chatMeta.pinned !== newPinned) {
               chatMeta.pinned = newPinned;
               changed = true;
           }
           
           if (changed) {
               chatMeta._dirty = true;
               chatHistory._saveList();
               renderHistoryList();
               nui.components.toast?.success?.('Chat options saved');
               if (currentChatId === chatId) {
                 if (window.conversation) {
                    window.conversation.title = chatMeta.title;
                    window.conversation.category = chatMeta.category;
                 }
                 const titleEl = document.getElementById('current-chat-title');
                 if (titleEl) {
                    titleEl.textContent = chatMeta.title || 'New Chat';
                 }
               }
           }
        }
    });
}

function updateSendButton() {
    const btn = elements.sendBtn?.querySelector('button');
    if (btn) {
        const chatIsStreaming = client.hasActiveStream(currentChatId);
        btn.innerHTML = chatIsStreaming
            ? '<nui-icon name="close"></nui-icon>'
            : '<nui-icon name="send"></nui-icon>';
    }
}

function abortStream() {
    // Abort only the active chat's stream, not background chats
    client.abortStream(currentChatId);
}

// ============================================
// File Attachments
// ============================================

function handleFileSelect(e) {
    const files = Array.from(e.target.files || []);

    for (const file of files) {
        if (!file.type.startsWith('image/')) continue;
        
        const reader = new FileReader();
        reader.onload = (event) => {
            attachedImages.push({
                dataUrl: event.target.result,
                name: file.name,
                type: file.type
            });
            addAttachmentPreview(event.target.result, file.name);
        };
        reader.readAsDataURL(file);
    }
    
    // Clear input so same file can be selected again
    e.target.value = '';
}

// ============================================
// Vision Capability Detection
// ============================================

function currentModelSupportsVision() {
    if (!currentModel) return false;
    const modelConfig = models.find(m => m.id === currentModel);
    const supportsVision = modelConfig?.capabilities?.vision === true;
    return supportsVision;
}

function updateVisionToggleVisibility() {
    const visionToggle = document.getElementById('vision-toggle-container');
    if (!visionToggle) return;
    
    const hasImages = attachedImages.length > 0;
    const visionToolsAvailable = areVisionToolsAvailable();
    const modelSupportsVision = currentModelSupportsVision();
    
    // Show toggle when:
    // - Images are attached AND
    // - Either vision tools are available OR model supports vision
    if (hasImages) {
        if (visionToolsAvailable || modelSupportsVision) {
            visionToggle.style.display = 'flex';
            
            const checkbox = visionToggle.querySelector('nui-checkbox');
            const input = visionToggle.querySelector('input');
            
            if (visionToolsAvailable && modelSupportsVision) {
                // Both available - user can choose
                input.disabled = false;
                checkbox.title = 'OFF: Send images directly to model | ON: Use MCP vision tools to pre-analyze images';
            } else if (modelSupportsVision) {
                // Only model supports vision - disable MCP vision (force OFF)
                input.disabled = true;
                input.checked = false;
                useVisionAnalysis = false;
                checkbox.title = 'Model supports vision - images will be sent directly';
            } else if (visionToolsAvailable) {
                // Only MCP vision available - force ON (model can't process images directly)
                input.disabled = true;
                input.checked = true;
                useVisionAnalysis = true;
                checkbox.title = 'Model does not support vision - MCP vision tools will analyze images';
            }
            
            // Update mode indicator
            updateVisionModeIndicator();
        } else {
            // No vision support at all
            visionToggle.style.display = 'none';
        }
    } else {
        visionToggle.style.display = 'none';
    }
}

function addAttachmentPreview(dataUrl, name) {
    const item = document.createElement('div');
    item.className = 'attachment-item';
    item.title = name;
    item.innerHTML = `
        <img src="${dataUrl}" alt="${name}">
        <button class="remove" title="Remove">&times;</button>
    `;
    
    // Remove button
    item.querySelector('.remove').addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = attachedImages.findIndex(img => img.dataUrl === dataUrl);
        if (idx > -1) attachedImages.splice(idx, 1);
        item.remove();
        updateVisionToggleVisibility();
    });
    
    // Lightbox click - open full image
    item.addEventListener('click', () => {
        if (nui.components?.lightbox) {
            nui.components.lightbox.show([{ src: dataUrl, title: name }], 0);
        }
    });
    
    elements.attachmentPreview?.appendChild(item);
    updateVisionToggleVisibility();
}

function clearAttachments() {
    attachedImages = [];
    useVisionAnalysis = false;
    if (elements.attachmentPreview) {
        elements.attachmentPreview.innerHTML = '';
    }
    updateVisionToggleVisibility();
}

// ============================================
// Gateway Status
// ============================================

async function checkGatewayStatus() {
    if (!client.restUrl) {
        elements.gatewayConfigStatus?.classList.add('offline');
        if (elements.gatewayConfigStatusText) elements.gatewayConfigStatusText.textContent = 'Not connected';
        return;
    }
    try {
        if (elements.gatewayConfigStatusText) elements.gatewayConfigStatusText.textContent = 'Checking...';
        const data = await client.getHealth();

        if (data.status === 'ok') {
            elements.gatewayConfigStatus?.classList.remove('offline');
            if (elements.gatewayConfigStatusText) elements.gatewayConfigStatusText.textContent = 'Connected';
        } else {
            elements.gatewayConfigStatus?.classList.add('offline');
            if (elements.gatewayConfigStatusText) elements.gatewayConfigStatusText.textContent = 'Error';
        }
    } catch (error) {
        elements.gatewayConfigStatus?.classList.add('offline');
        if (elements.gatewayConfigStatusText) elements.gatewayConfigStatusText.textContent = 'Offline';
    }
}

// ============================================
// Theme Toggle
// ============================================

async function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme') || 'light';
    const next = current === 'dark' ? 'light' : 'dark';
    await setTheme(next);
}

async function setTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    await storage.setPref('theme', theme);

    // Also sync with NUI if available
    if (window.nui?.setTheme) {
        window.nui.setTheme(theme);
    }

    // Update color-scheme for native form elements
    document.documentElement.style.colorScheme = theme;
}

// ============================================
// Lightbox
// ============================================

function openLightbox(src) {
    elements.lightboxImage.src = src;
    elements.lightbox.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
}

function closeLightbox() {
    elements.lightbox.setAttribute('aria-hidden', 'true');
    elements.lightboxImage.src = '';
    document.body.style.overflow = '';
}

window.openLightbox = openLightbox;

// ============================================
// Timestamp Parsing
// ============================================

const TIMESTAMP_REGEX = /^\[(\d{4})-(\d{2})-(\d{2})@(\d{2}):(\d{2})\]\s*/;
const TIMESTAMP_REGEX_GLOBAL = /\[\d{4}-\d{2}-\d{2}@\d{2}:\d{2}\]\s*/g;

function parseTimestamp(content) {
    if (!content) return { timestamp: null, cleanContent: content };
    const match = content.match(TIMESTAMP_REGEX);
    if (match) {
        const [, year, month, day, hour, minute] = match;
        return {
            timestamp: `${year}-${month}-${day} @ ${hour}:${minute}`,
            cleanContent: content.replace(TIMESTAMP_REGEX, '')
        };
    }
    return { timestamp: null, cleanContent: content };
}

function stripExtraTimestamps(content) {
    // Keep the first timestamp (ours), remove any subsequent ones the LLM generates
    let first = true;
    return content.replace(TIMESTAMP_REGEX_GLOBAL, (match) => {
        if (first) {
            first = false;
            return match; // Keep first timestamp
        }
        return ''; // Remove subsequent timestamps
    });
}

// ============================================
// Utilities
// ============================================

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ============================================
// Base64 Sanitization for Display
// ============================================

/**
 * Detects if a string is base64-encoded data (typically images or binary)
 * Uses fast heuristics to avoid expensive regex on large strings
 */
function isBase64Data(str) {
    if (typeof str !== 'string' || str.length < 100) return false;
    
    // Fast path: check length first (base64 images are typically >1KB)
    if (str.length < 1000) return false;
    
    // Check for common image signatures (first few chars)
    const start = str.substring(0, 20);
    if (start.startsWith('/9j/') ||           // JPEG
        start.startsWith('iVBOR') ||          // PNG  
        start.startsWith('R0lGOD') ||         // GIF
        start.startsWith('UEsDB') ||          // Binary/Zip
        start.startsWith('JVBERi0') ||        // PDF
        start.startsWith('Qk')) {             // BMP
        return true;
    }
    
    // Fallback: check if it looks like base64 (long alphanumeric + /+)
    // Only check first 100 chars for performance
    const sample = str.substring(0, 100);
    return /^[A-Za-z0-9+/]{100}/.test(sample);
}

/**
 * Sanitizes an object for display by replacing base64 data with placeholders
 * Recursively processes nested objects and arrays
 * @param {*} value - Value to sanitize
 * @returns {*} Sanitized value safe for JSON.stringify
 */
function sanitizeForDisplay(value) {
    if (value === null || value === undefined) return value;
    
    if (typeof value === 'string') {
        if (isBase64Data(value)) {
            return `[BASE64_DATA](${value.length} chars)`;
        }
        return value;
    }
    
    if (Array.isArray(value)) {
        return value.map(item => sanitizeForDisplay(item));
    }
    
    if (typeof value === 'object') {
        const sanitized = {};
        for (const [key, val] of Object.entries(value)) {
            sanitized[key] = sanitizeForDisplay(val);
        }
        return sanitized;
    }
    
    return value;
}

/**
 * Safe JSON.stringify that sanitizes base64 data first
 * Use this for UI display to avoid freezing on large base64 strings
 */
function jsonStringifyForDisplay(obj, space = 2) {
    const sanitized = sanitizeForDisplay(obj);
    return JSON.stringify(sanitized, null, space);
}

function scrollToBottom() {
    const container = getActiveContainer();
    if (container) {
        container.scrollTop = container.scrollHeight;
        _vsUpdateVisible(container);
    }
}

function isNearBottom(threshold = 100) {
    const container = getActiveContainer();
    if (!container) return true;
    const { scrollTop, scrollHeight, clientHeight } = container;
    return scrollHeight - scrollTop - clientHeight < threshold;
}

// ============================================
// PHASE-2: MCP Configuration UI Layer
// ============================================

function initMCP() {
    // Set up global callback for MCP client to refresh UI when tools are loaded
    window.refreshMCPServersUI = () => renderMCPServers();
    
    // 1. Initial render
    renderMCPServers();

    // 2. Wire up 'Add Server' button
    if (elements.mcpAddBtn) {
        elements.mcpAddBtn.addEventListener('click', async () => {
            const nameInput = elements.mcpServerName.querySelector('input');
            const urlInput = elements.mcpServerUrl.querySelector('input');
            const name = nameInput.value.trim();
            const url = urlInput.value.trim();
            if (!name || !url) return alert('Name and URL are required');
            
            mcpClient.addServer(url, name);
            nameInput.value = '';
            urlInput.value = '';
            renderMCPServers();
            
            // Auto connect the newly added one
            const server = mcpClient.servers[mcpClient.servers.length - 1];
            try {
                await mcpClient.connectToServer(server);
            } catch (e) {
                console.error("Auto-connect failed", e);
            }
            renderMCPServers();
        });
    }

    // 3. Connect existing offline servers on load
    mcpClient.servers.forEach(async (server) => {
        if (server.status === 'disconnected') {
            try {
                await mcpClient.connectToServer(server);
                renderMCPServers();
            } catch (e) {
                renderMCPServers();
            }
        }
    });

}

function renderMCPServers() {
    if (!elements.mcpServersList) return;
    elements.mcpServersList.innerHTML = ''; // basic clear

    mcpClient.servers.forEach(server => {
        const card = document.createElement('nui-card');
        card.className = "mcp-server-card";
        
        let badgeVariant = '';
          if (server.status === 'connected') badgeVariant = 'success';
          if (server.status === 'error') badgeVariant = 'danger';
          if (server.status === 'connecting...' || server.status === 'reconnecting') badgeVariant = 'warning';

        const isConnected = server.status === 'connected';
        const isTransitioning = server.status === 'connecting...' || server.status === 'reconnecting';
        
        const enabledToolsMap = mcpClient.enabledTools.get(server.id);
        let activeCount = 0;
        let totalCount = server.tools ? server.tools.length : 0;
        if (server.tools && enabledToolsMap) {
            server.tools.forEach(t => {
                if (enabledToolsMap.get(t.name)) {
                    activeCount++;
                }
            });
        }

        let html = `
            <div class="mcp-server-inner">
                <!-- Header: Title and Toggle -->
                <div class="mcp-server-header">
                    <h3 class="mcp-server-title">${server.name}</h3>
                    <nui-checkbox variant="switch" title="Connect/Disconnect"><input type="checkbox" data-mcp-status-toggle="${server.id}" ${isConnected || isTransitioning ? 'checked' : ''} ${isTransitioning ? 'disabled' : ''}></nui-checkbox>
                </div>

                <!-- Status Badge -->
                <div class="mcp-server-status-row">
                    <nui-badge variant="${badgeVariant}" class="mcp-server-status-badge">
                        <span class="mcp-server-status-dot">&#11044;</span> ${isConnected ? 'connected (' + activeCount + '/' + totalCount + ' active)' : server.status}
                    </nui-badge>
                  </div>

                  <!-- Bottom Actions -->
                <div class="mcp-server-actions">
                    <nui-button variant="icon" title="Edit Server" data-mcp-edit="${server.id}">
                        <button type="button" aria-label="Edit">
                            <nui-icon name="edit"></nui-icon>
                        </button>
                    </nui-button>
                    <nui-button variant="icon" title="Remove Server" data-mcp-remove="${server.id}">
                        <button type="button" aria-label="Remove">
                            <nui-icon name="delete"></nui-icon>
                        </button>
                    </nui-button>
                </div>
            </div>
        `;

        card.innerHTML = html;

        // Wire Event Listeners
        const removeBtn = card.querySelector('[data-mcp-remove]');
        if(removeBtn) {
            removeBtn.addEventListener('click', () => {
                mcpClient.removeServer(server.id);
                renderMCPServers();
            });
        }

        const editBtn = card.querySelector('[data-mcp-edit]');
        if (editBtn) {
            editBtn.addEventListener('click', () => {
                openMCPEditDialog(server);
            });
        }

        const toggle = card.querySelector(`nui-checkbox`);
        if (toggle) {
            toggle.addEventListener('nui-change', (e) => {
                if (e.detail.checked) {
                    mcpClient.connectToServer(server).catch(err => {
                        console.error("Connect failed", err);
                        renderMCPServers();
                    });
                } else {
                    mcpClient.disconnectServer(server.id);
                }
                renderMCPServers();
            });
        }

        elements.mcpServersList.appendChild(card);
    });
}

async function openMCPEditDialog(server) {
    const template = document.getElementById('mcp-edit-template');
    if (!template) return;
    
    // We clone the template content
    const content = template.content.cloneNode(true);
    
    // Get inner elements
    const urlInput = content.getElementById('mcp-edit-url');
    if (urlInput) urlInput.value = server.url;
    
    const toolsContainer = content.getElementById('mcp-edit-tools-container');
    if (!toolsContainer) return;
    
    toolsContainer.innerHTML = '';

    if (!server.tools || server.tools.length === 0) {
        toolsContainer.innerHTML = '<p class="mcp-empty-tools">No tools available. Connect the server to load tools.</p>';
    } else {
        server.tools.forEach(tool => {
            const isEnabled = mcpClient.enabledTools.get(server.id)?.get(tool.name) ?? false;
            const toolEl = document.createElement('label');
            toolEl.style.cssText = 'display: flex; align-items: flex-start; gap: 0.75rem; padding: 0.5rem 0; border-bottom: 1px solid var(--color-shade2); cursor: pointer;';

            const nuiCheckbox = document.createElement('nui-checkbox');
            nuiCheckbox.innerHTML = `<input type="checkbox" data-mcp-toggle="${server.id}" data-mcp-tool="${tool.name}">`;
            const input = nuiCheckbox.querySelector('input');
            if (isEnabled) input.checked = true;

            toolEl.appendChild(nuiCheckbox);
            const textDiv = document.createElement('div');
            textDiv.style.cssText = 'display: flex; flex-direction: column; gap: 0.25rem;';
            textDiv.innerHTML = `
                <span class="mcp-tool-name">${tool.name}</span>
                <span class="mcp-tool-desc">${tool.description || 'No description available.'}</span>
            `;
            toolEl.appendChild(textDiv);
            
            toolsContainer.appendChild(toolEl);
        });
    }

    const { dialog, main } = await nui.components.dialog.page(`Edit Server: ${server.name}`, '', {
        contentScroll: true,
        buttons: [
            { label: 'Cancel', type: 'outline', value: 'cancel' },
            { label: 'Save Changes', type: 'primary', value: 'save' }
        ]
    });
    main.appendChild(content);

    const toggleAllBtn = main.querySelector('#mcp-edit-toggle-all button');
    if (toggleAllBtn) {
        toggleAllBtn.addEventListener('click', () => {
            const inputs = Array.from(main.querySelectorAll('#mcp-edit-tools-container input[type="checkbox"]'));
            const allChecked = inputs.every(i => i.checked);
            
            inputs.forEach(input => {
                input.checked = !allChecked;
                const evt = new CustomEvent('change', { bubbles: true });
                input.dispatchEvent(evt);
            });
        });
    }

    // Handle button clicks
    dialog.addEventListener('nui-dialog-close', (e) => {
        const action = e.detail?.returnValue;
        if (action === 'save') {
             const allCheckboxes = main.querySelectorAll('input[type="checkbox"]');
             allCheckboxes.forEach(cb => {
                 const toolName = cb.dataset.mcpTool;
                 const isEnabled = cb.checked;
                 mcpClient.setToolEnabled(server.id, toolName, isEnabled);
             });
             renderMCPServers();
             nui.components.toast?.success?.('MCP Server capabilities updated');
        }
    });
}

function setupDialogEventListeners() {
    // Dialog event listeners are bound inline in openChatOptions(), openMCPEditDialog(), etc.
    // No static DOM elements to bind here — all dialogs are created programmatically via nui.components.dialog.page()
}

// ============================================
// Centralized data-action handler for chat-options buttons
// Buttons use data-action="chat-options:<action>" on inner <button> elements.
// The chatId is carried via data-chat-id on the wrapper div.
// ============================================

document.addEventListener('nui-action', (e) => {
    const { name, param } = e.detail;
    if (name !== 'chat-options') return;

    const wrapper = e.target.closest('[data-chat-id]');
    const chatId = wrapper?.dataset.chatId;
    if (!chatId) {
        console.warn('[chat-options] nui-action fired but no data-chat-id found on parent');
        return;
    }

    console.log('[chat-options] action:', param, 'chatId:', chatId);

    switch (param) {
        case 'copy-json':
            exportChatAsJson(chatId, e.target);
            break;
        case 'save-json':
            exportChatToFile(chatId);
            break;
        case 'save-md':
            exportChatAsMarkdown(chatId);
            break;
        case 'clone':
            handleChatOptionsClone(chatId, wrapper);
            break;
        case 'delete':
            handleChatOptionsDelete(chatId, wrapper);
            break;
        default:
            console.warn('[chat-options] unknown action:', param);
    }
});

async function handleChatOptionsClone(chatId, wrapper) {
    const exchanges = await storage.loadConversation(chatId);
    if (!exchanges) return;
    const chatMeta = chatHistory.conversations.find(c => c.id === chatId);
    if (!chatMeta) return;

    const newId = chatHistory._generateId();
    const cloneMeta = {
        ...chatMeta,
        id: newId,
        title: `Copy of ${chatMeta.title || 'Chat'}`,
        timestamp: Date.now(),
        updatedAt: Date.now()
    };
    chatHistory.conversations.unshift(cloneMeta);
    chatHistory._saveList();
    await storage.saveConversation(newId, exchanges);
    renderHistoryList();

    // Close the dialog that contains this button
    const dialogEl = wrapper.closest('dialog');
    if (dialogEl) dialogEl.close();

    await switchChat(newId);
    nui.components.toast?.success?.('Chat cloned successfully');
}

async function handleChatOptionsDelete(chatId, wrapper) {
    // Close dialog first
    const dialogEl = wrapper.closest('dialog');
    if (dialogEl) dialogEl.close();

    deleteChat(chatId);
}

// ============================================
// Start
// ============================================

// Admin UI
async function showAdminUI() {
    let users = await backendClient.adminGetUsers();

    const renderTable = () => `
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem;">
            <h3 style="margin: 0; font-size: 1.1rem; color: var(--text-color);">Registered Users</h3>
            <nui-button variant="primary" data-action="edit-user">
                <button type="button">Add User</button>
            </nui-button>
        </div>
        <div style="border: 1px solid var(--border-shade1); border-radius: var(--border-radius1, 6px); overflow: hidden; margin-bottom: 2rem;">
            <table style="width: 100%; border-collapse: collapse; text-align: left;">
                <thead style="background: var(--color-shade1);">
                    <tr style="border-bottom: 1px solid var(--border-shade2);">
                        <th style="padding: 0.75rem 1rem; color: var(--text-color-dim); font-weight: normal; font-size: 0.85em; text-transform: uppercase; letter-spacing: 0.05em;">Username</th>
                        <th style="padding: 0.75rem 1rem; color: var(--text-color-dim); font-weight: normal; font-size: 0.85em; text-transform: uppercase; letter-spacing: 0.05em;">Display Name</th>
                        <th style="padding: 0.75rem 1rem; color: var(--text-color-dim); font-weight: normal; font-size: 0.85em; text-transform: uppercase; letter-spacing: 0.05em;">Rights</th>
                        <th style="padding: 0.75rem 1rem; color: var(--text-color-dim); font-weight: normal; font-size: 0.85em; text-transform: uppercase; letter-spacing: 0.05em; text-align: center;">Actions</th>
                    </tr>
                </thead>
                <tbody>
                    ${users.map((u, i) => `
                        <tr style="border-bottom: ${i === users.length - 1 ? 'none' : '1px solid var(--border-shade1)'};">
                            <td style="padding: 1rem;"><strong style="color: var(--text-color);">${u.username}</strong></td>
                            <td style="padding: 1rem; color: var(--text-color-dim);">${u.displayName || '-'}</td>
                            <td style="padding: 1rem;">
                                <div style="display: flex; gap: 0.35rem; flex-wrap: wrap;">
                                    ${Object.keys(u.rights).filter(k => u.rights[k]).map(right => 
                                        `<span style="background: var(--border-shade1); padding: 0.2rem 0.5rem; border-radius: 4px; font-size: 0.8em; color: var(--text-color-dim);">${right}</span>`
                                    ).join('') || '<span style="color: var(--text-color-dim); font-style: italic;">none</span>'}
                                </div>
                            </td>
                            <td style="padding: 1rem;">
                                <div style="display: flex; gap: 0.5rem; justify-content: center;">
                                    <nui-button variant="outline" size="small" data-action="edit-user" data-id="${u.id}">
                                        <button type="button">Edit</button>
                                    </nui-button>
                                    <nui-button variant="danger" size="small" data-action="delete-user" data-id="${u.id}" ${u.id === backendClient.user?.userId ? 'disabled' : ''}>
                                        <button type="button">Delete</button>
                                    </nui-button>
                                </div>
                            </td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        </div>
    `;

    const { dialog, main } = await nui.components.dialog.page('User Management', '', {
        contentScroll: true,
        buttons: [ { label: 'Close', type: 'outline', value: 'close' } ]
    });
    main.innerHTML = `<div id="admin-users-container" style="padding: 1rem;">${renderTable()}</div>`;

    const refreshTable = async () => {
        users = await backendClient.adminGetUsers();
        if (main.querySelector('#admin-users-container')) {
            main.querySelector('#admin-users-container').innerHTML = renderTable();
        }
        attachListeners();
    };

    const attachListeners = () => {
        main.querySelectorAll('[data-action="delete-user"]').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const id = e.currentTarget.dataset.id;
                if (!id) return;
                const confirm = await nui.components.dialog.confirm('Delete User', 'Are you sure? This cannot be undone.');
                if (confirm) {
                    try {
                        await backendClient.adminDeleteUser(id);
                        nui.components.toast?.success?.('User deleted');
                        await refreshTable();
                    } catch (err) {
                        nui.components.dialog.alert('Error', err.message);
                    }
                }
            });
        });

        main.querySelectorAll('[data-action="edit-user"]').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const id = e.currentTarget.dataset.id;
                const isEdit = !!id;
                const targetUser = isEdit ? users.find(u => u.id === id) : null;
                
                const formHtml = `
                <div style="padding: 1rem;">
                    <form id="admin-user-editor-${id || 'new'}" style="display: grid; gap: 1rem; max-width: 400px; margin: auto;">
                        <nui-input-group>
                            <label>Username</label>
                            <nui-input><input type="text" name="username" ${isEdit ? 'disabled' : 'required'} value="${isEdit ? targetUser.username : ''}"></nui-input>
                        </nui-input-group>
                        <nui-input-group>
                            <label>${isEdit ? 'New Password (blank to keep)' : 'Password'}</label>
                            <nui-input><input type="password" name="password" ${!isEdit ? 'required' : ''}></nui-input>
                        </nui-input-group>
                        <nui-input-group>
                            <label>Display Name</label>
                            <nui-input><input type="text" name="displayName" value="${isEdit ? targetUser.displayName : ''}"></nui-input>
                        </nui-input-group>
                        <nui-input-group>
                            <label>DB Path (e.g. server/data/my_db)</label>
                            <nui-input><input type="text" name="dbPath" required value="${isEdit ? targetUser.dbPath : ''}"></nui-input>
                        </nui-input-group>
                        <nui-input-group>
                            <label>Rights</label>
                            <div style="display: flex; gap: 1rem; margin-top: 0.25rem;">
                                <nui-checkbox>
                                    <input type="checkbox" name="right_login" ${(!isEdit || targetUser.rights?.login) ? 'checked' : ''}> Login
                                </nui-checkbox>
                                <nui-checkbox>
                                    <input type="checkbox" name="right_admin" ${(isEdit && targetUser.rights?.admin) ? 'checked' : ''}> Admin
                                </nui-checkbox>
                            </div>
                        </nui-input-group>
                        <nui-button variant="primary" style="margin-top: 1rem;">
                            <button type="submit">${isEdit ? 'Update User' : 'Create User'}</button>
                        </nui-button>
                    </form>
                </div>
                `;

                const subDialog = await nui.components.dialog.page(isEdit ? 'Edit User' : 'Add User', '', {
                    contentScroll: true,
                    buttons: [ { label: 'Cancel', type: 'outline', value: 'cancel' } ]
                });
                subDialog.main.innerHTML = formHtml;

                const form = subDialog.main.querySelector('form');
                form.addEventListener('submit', async (e) => {
                    e.preventDefault();
                    const fd = new FormData(form);
                    const payload = {
                        displayName: fd.get('displayName'),
                        dbPath: fd.get('dbPath'),
                        rights: {
                            login: fd.get('right_login') === 'on',
                            read: true,
                            write: true,
                            admin: fd.get('right_admin') === 'on'
                        }
                    };
                    const pwd = fd.get('password');
                    if (pwd) payload.password = pwd;

                    try {
                        if (isEdit) {
                            await backendClient.adminUpdateUser(id, payload);
                            nui.components.toast?.success?.('User updated');
                        } else {
                            payload.username = fd.get('username');
                            await backendClient.adminCreateUser(payload);
                            nui.components.toast?.success?.('User created');
                        }
                        
                        // Close sub-dialog
                        const cancelBtn = subDialog.dialog.querySelector('button[value="cancel"]');
                        if (cancelBtn) cancelBtn.click();
                        
                        await refreshTable();
                    } catch (err) {
                        nui.components.dialog.alert('Error', err.message);
                    }
                });
            });
        });
    };

    attachListeners();
}

init();























