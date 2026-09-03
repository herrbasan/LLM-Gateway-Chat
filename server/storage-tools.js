// ============================================
// storage-tools.js — native storage ops for the chat backend.
// Direct filesystem access to the MCP storage box (the backend runs on the
// same machine), bypassing the workshop tools dispatcher: no JSON-RPC
// framing, no MCP size caps, no pointer responses. The workshop storage.*
// methods stay available through the dispatcher as fallback (grep, batch,
// resources) and for other platforms (VS Code), but models in chat should
// prefer these — the tool descriptions and system prompt steer accordingly.
//
// Root is configured once at startup (MCP_STORAGE_PATH, default D:\MCP_Storage).
// Missing root = throw at init (fail loud). safeResolve confines every op to
// the root: no absolute paths, no drive letters, no '..' escapes.
// ============================================

const fs = require('fs');
const path = require('path');

let ROOT = null;
let LOG = { info() {}, warn() {}, error() {}, debug() {} };

function init({ log, storageRoot }) {
    if (log) LOG = log;
    const root = storageRoot || 'D:\\MCP_Storage';
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
        throw new Error(`storage-tools: storage root "${root}" does not exist or is not a directory — set MCP_STORAGE_PATH`);
    }
    ROOT = path.resolve(root);
    LOG.info('storage-tools ready', { root: ROOT }, 'StorageTools');
}

// Confine to ROOT. Throws on escape attempts (absolute paths, drive letters,
// '..' traversal). Returns the absolute local path.
function safeResolve(rel) {
    if (!ROOT) throw new Error('storage-tools: not initialized');
    if (typeof rel !== 'string' || rel.trim() === '') throw new Error('storage: path must be a non-empty string');
    if (path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel) || rel.startsWith('\\\\')) {
        throw new Error(`storage: path must be relative to the storage root (got "${rel}")`);
    }
    const abs = path.resolve(ROOT, rel);
    if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) {
        throw new Error(`storage: path escapes the storage root (got "${rel}")`);
    }
    return abs;
}

function statOut(abs) {
    const st = fs.statSync(abs);
    return { bytes: st.size, mtime: st.mtime.toISOString() };
}

// ============================================
// Tool definitions
// ============================================

const SERVER_EXEC_NOTE = 'Execution: runs natively in the chat BACKEND (server-side), with DIRECT filesystem access to the workshop storage box. Call this tool by name — do NOT route storage operations through the workshop tools dispatcher (tools → storage.*); these native tools are faster, have no MCP size limits, and never return pointer responses.';

const PATH_DESC = 'Path relative to the storage root (e.g. "digital-twin/images/photo.jpg", "documentation/Workshop"). Never absolute, never with drive letters or "..".';

const TOOL_DEFS = [
    {
        type: 'function',
        function: {
            name: 'storage_read',
            description: `${SERVER_EXEC_NOTE}\n\nRead a file from workshop storage as UTF-8 text. Files larger than 32 KB are auto-CHUNKED (returns bucketFile + chunk count; page with browser_fetch bucket_file/chunk, retire consumed chunks with context_retire) — same pattern as browser_fetch. Reading a directory is an error; use storage_list instead.`,
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: PATH_DESC }
                },
                required: ['path']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'storage_write',
            description: `${SERVER_EXEC_NOTE}\n\nWrite a file to workshop storage — FULL-FILE REPLACEMENT. "content" must be the ENTIRE file content, not a section. Writing a partial update destroys all other content. For targeted edits use storage_replace; for adding to the end use storage_append. Parent directories are created automatically. Self-verifying: the file is re-statted after writing and the verified byte count is returned.`,
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: PATH_DESC },
                    content: { type: 'string', description: 'The complete file content (UTF-8).' }
                },
                required: ['path', 'content']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'storage_append',
            description: `${SERVER_EXEC_NOTE}\n\nAppend content to the end of a file. Safer than storage_write for adding to logs and journals — no need to re-send the existing content. Self-verifying: returns the new total byte count.`,
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: PATH_DESC },
                    content: { type: 'string', description: 'Content to append (UTF-8).' }
                },
                required: ['path', 'content']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'storage_list',
            description: `${SERVER_EXEC_NOTE}\n\nList directory contents in workshop storage. Omit path (or use "/") for the storage root. Set recursive:true for a full subtree listing. Returns one line per entry: type (f/d), size, and path.`,
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Directory path relative to the storage root. Omit for root.' },
                    recursive: { type: 'boolean', description: 'Recurse into subdirectories (default false).' }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'storage_replace',
            description: `${SERVER_EXEC_NOTE}\n\nTargeted edit: replace the string "marker" with "replacement" inside the file, without re-sending the whole file. Line-ending-agnostic: write multi-line markers with '\\n' regardless of the file's CRLF/LF convention; the file keeps its own convention. Marker not found is an ERROR — re-read the file section and repair the marker. occurrence: "first" (default), "last", or "all". Self-verifying write.`,
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: PATH_DESC },
                    marker: { type: 'string', description: 'The exact string to replace (aliases oldString). Must exist in the file.' },
                    replacement: { type: 'string', description: 'The string to put in its place (aliases newString).' },
                    occurrence: { type: 'string', enum: ['first', 'last', 'all'], description: 'Which occurrence(s) to replace (default "first").' }
                },
                required: ['path', 'marker', 'replacement']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'storage_delete',
            description: `${SERVER_EXEC_NOTE}\n\nDelete a file or directory. Directories require recursive:true. There is no trash and no undo — this is permanent.`,
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: PATH_DESC },
                    recursive: { type: 'boolean', description: 'Required to delete a non-empty directory.' }
                },
                required: ['path']
            }
        }
    }
];

const NAMES = new Set(TOOL_DEFS.map(t => t.function.name));
function isStorageTool(name) { return NAMES.has(name); }

// ============================================
// Execution. deps = { chunkText } — chunkText(buffer, contentType, prefix)
// returns an MCP-style chunked result (provided by internal-tools so large
// reads land in the chat bucket like browser_fetch chunks).
// ============================================

function jsonResult(obj) {
    return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] };
}

const READ_CHUNK_THRESHOLD = 32 * 1024;

async function execute(name, args, deps = {}) {
    if (!ROOT) throw new Error('storage-tools: not initialized');
    args = args || {};

    switch (name) {
        case 'storage_read': {
            const abs = safeResolve(args.path);
            const st = fs.statSync(abs);
            if (st.isDirectory()) throw new Error(`storage_read: "${args.path}" is a directory — use storage_list`);
            const buffer = fs.readFileSync(abs);
            LOG.info('storage_read', { path: args.path, bytes: buffer.length }, 'StorageTools');
            if (buffer.length > READ_CHUNK_THRESHOLD && deps.chunkText) {
                return deps.chunkText(buffer, 'text/plain', 'storage_read');
            }
            return { content: [{ type: 'text', text: buffer.toString('utf8') }] };
        }

        case 'storage_write': {
            if (typeof args.content !== 'string') throw new Error('storage_write: content (string) required');
            const abs = safeResolve(args.path);
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            fs.writeFileSync(abs, args.content, 'utf8');
            const out = statOut(abs);
            LOG.info('storage_write', { path: args.path, bytes: out.bytes }, 'StorageTools');
            return jsonResult({ ok: true, path: args.path, ...out });
        }

        case 'storage_append': {
            if (typeof args.content !== 'string') throw new Error('storage_append: content (string) required');
            const abs = safeResolve(args.path);
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            fs.appendFileSync(abs, args.content, 'utf8');
            const out = statOut(abs);
            LOG.info('storage_append', { path: args.path, bytes: out.bytes }, 'StorageTools');
            return jsonResult({ ok: true, path: args.path, ...out });
        }

        case 'storage_list': {
            const rel = (!args.path || args.path === '/') ? '' : args.path;
            const abs = rel ? safeResolve(rel) : ROOT;
            const st = fs.statSync(abs);
            if (!st.isDirectory()) throw new Error(`storage_list: "${args.path}" is a file — use storage_read`);
            const lines = [];
            const walk = (dirAbs, dirRel) => {
                for (const entry of fs.readdirSync(dirAbs, { withFileTypes: true })) {
                    const eAbs = path.join(dirAbs, entry.name);
                    const eRel = dirRel ? `${dirRel}/${entry.name}` : entry.name;
                    if (entry.isDirectory()) {
                        lines.push(`d        ${eRel}`);
                        if (args.recursive) walk(eAbs, eRel);
                    } else {
                        const sz = fs.statSync(eAbs).size;
                        lines.push(`f ${String(sz).padStart(8)} ${eRel}`);
                    }
                }
            };
            walk(abs, rel);
            LOG.info('storage_list', { path: rel || '/', entries: lines.length, recursive: !!args.recursive }, 'StorageTools');
            return { content: [{ type: 'text', text: lines.join('\n') || '(empty)' }] };
        }

        case 'storage_replace': {
            const marker = args.marker ?? args.oldString;
            const replacement = args.replacement ?? args.newString;
            if (typeof marker !== 'string' || marker === '') throw new Error('storage_replace: marker (non-empty string) required');
            if (typeof replacement !== 'string') throw new Error('storage_replace: replacement (string) required');
            const occurrence = args.occurrence || 'first';
            const abs = safeResolve(args.path);
            const content = fs.readFileSync(abs, 'utf8');
            // Line-ending-agnostic: exact match first, else retry the marker
            // with the file's own CRLF convention.
            let effectiveMarker = marker;
            let idx = content.indexOf(effectiveMarker);
            if (idx === -1 && content.includes('\r\n') && !marker.includes('\r\n')) {
                effectiveMarker = marker.replace(/\n/g, '\r\n');
                idx = content.indexOf(effectiveMarker);
            }
            if (idx === -1) {
                const anchor = marker.slice(0, 40);
                const near = content.indexOf(anchor.slice(0, 16));
                const snippet = near !== -1 ? content.slice(near, near + 200) : '(no anchor found)';
                throw new Error(`storage_replace: marker not found in "${args.path}" (file ${content.length} chars). Near-miss snippet: ${JSON.stringify(snippet)}`);
            }
            let next;
            if (occurrence === 'all') {
                next = content.split(effectiveMarker).join(replacement);
            } else if (occurrence === 'last') {
                const last = content.lastIndexOf(effectiveMarker);
                next = content.slice(0, last) + replacement + content.slice(last + effectiveMarker.length);
            } else {
                next = content.slice(0, idx) + replacement + content.slice(idx + effectiveMarker.length);
            }
            fs.writeFileSync(abs, next, 'utf8');
            const out = statOut(abs);
            LOG.info('storage_replace', { path: args.path, occurrence, bytes: out.bytes }, 'StorageTools');
            return jsonResult({ ok: true, path: args.path, occurrence, ...out });
        }

        case 'storage_delete': {
            const abs = safeResolve(args.path);
            if (abs === ROOT) throw new Error('storage_delete: refusing to delete the storage root');
            const st = fs.statSync(abs);
            if (st.isDirectory()) {
                if (!args.recursive) throw new Error(`storage_delete: "${args.path}" is a directory — pass recursive:true`);
                fs.rmSync(abs, { recursive: true });
            } else {
                fs.rmSync(abs);
            }
            LOG.info('storage_delete', { path: args.path, wasDirectory: st.isDirectory() }, 'StorageTools');
            return jsonResult({ ok: true, deleted: args.path, wasDirectory: st.isDirectory() });
        }

        default:
            throw new Error(`Unknown storage tool: ${name}`);
    }
}

module.exports = { init, TOOL_DEFS, isStorageTool, execute, safeResolve };
