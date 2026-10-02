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
let NMEDIA_URL = 'http://localhost:3500';
let LOG = { info() {}, warn() {}, error() {}, debug() {} };

function init({ log, storageRoot }) {
    if (log) LOG = log;
    const root = storageRoot || 'D:\\MCP_Storage';
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
        throw new Error(`storage-tools: storage root "${root}" does not exist or is not a directory — set MCP_STORAGE_PATH`);
    }
    ROOT = path.resolve(root);
    NMEDIA_URL = process.env.MCP_NMEDIA_URL || 'http://localhost:3500';
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

// Snapshot-before-mutate (data-loss mitigation, #34 fallout): storage_write/
// replace/delete are full-file operations with no other safety net — a bad
// tool argument destroys the target. Before any destructive op on an existing
// FILE, copy it to .backups/<rel>.<timestamp> (last BACKUP_KEEP per path).
// Directories are not snapshotted (size unbounded) — noted loudly on delete.
const BACKUP_DIR = '.backups';
const BACKUP_KEEP = 10;
function backupIfExists(abs, rel) {
    if (rel.replace(/\//g, '\\').startsWith(BACKUP_DIR)) return null; // never back up backups
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const backupRel = `${BACKUP_DIR}/${rel}.${ts}`;
    const backupAbs = path.join(ROOT, backupRel);
    fs.mkdirSync(path.dirname(backupAbs), { recursive: true });
    fs.copyFileSync(abs, backupAbs);
    // Retention: prune oldest beyond BACKUP_KEEP for this exact path
    const dir = path.dirname(backupAbs);
    const prefix = path.basename(rel) + '.';
    const siblings = fs.readdirSync(dir)
        .filter(f => f.startsWith(prefix))
        .sort(); // ISO timestamps sort chronologically
    while (siblings.length > BACKUP_KEEP) {
        fs.rmSync(path.join(dir, siblings.shift()), { force: true });
    }
    LOG.info('snapshot before mutate', { path: rel, backup: backupRel }, 'StorageTools');
    return backupRel;
}

// ============================================
// Frontmatter guard: models see every message stamped '[YYYY-MM-DD@HH:MM] '
// (api-view withTimestamp) and echo that marker into file writes — glued
// before the YAML frontmatter opener, where it breaks the document (first
// line must be exactly '---'). Same failure class as chunk labels (#30).
// A marker in this position is NEVER content, so it is stripped — logged
// loud and flagged in the tool result (the model self-corrects in-band).
// Narrow class: bracketed timestamps and chunk labels only; a file that
// legitimately begins with other bracketed text is left alone, and a marker
// with no frontmatter behind it (journal-style opening line) is content.
// ============================================
const FM_MARKER_TS = /\d{4}-\d{2}-\d{2}([@T ]\d{2}:\d{2}(:\d{2})?)?/;
const FM_MARKER_CHUNK = /chunk_[a-z0-9]+/;
const FM_STAMP_NOTE = 'Context marker(s) were stripped from before the YAML frontmatter. Timestamps and chunk labels are conversation context — never write them into files; a YAML frontmatter block must open at line 1 with exactly "---".';

function isMarkerToken(token) {
    return FM_MARKER_TS.test(token) || FM_MARKER_CHUNK.test(token);
}

function stripFrontmatterMarkers(content) {
    if (typeof content !== 'string') return { content, stripped: [] };
    const stripped = [];
    let out = content;
    // Same-line: '[2026-09-25@22:39] ---' — marker glued onto the opener.
    out = out.replace(/^[ \t]*(\[[^\]\n]+\])[ \t]*(?=---[ \t]*(?:\r?\n|$))/, (m, tok) => {
        if (!isMarkerToken(tok)) return m;
        stripped.push(tok);
        return '';
    });
    // Own-line: marker line(s) directly above the '---' opener.
    out = out.replace(/^((?:[ \t]*\[[^\]\n]+\][ \t]*\r?\n)+)(?=[ \t]*---[ \t]*(?:\r?\n|$))/, (m, block) => {
        const lines = block.split(/\r?\n/).filter(l => l.trim() !== '');
        if (!lines.every(l => isMarkerToken(l.replace(/[ \t]/g, '')))) return m;
        stripped.push(...lines.map(l => l.trim()));
        return '';
    });
    return { content: out, stripped };
}

// Shared flag for the tool result: the model sees the note in-band and does
// not repeat the marker in its next write.
function guardFields(guard) {
    if (!guard.stripped.length) return {};
    LOG.warn('stripped context marker(s) before YAML frontmatter', { markers: guard.stripped }, 'StorageTools');
    return { stripped: guard.stripped, note: FM_STAMP_NOTE };
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
            description: `${SERVER_EXEC_NOTE}\n\nWrite a file to workshop storage — FULL-FILE REPLACEMENT. "content" must be the ENTIRE file content, not a section. Writing a partial update destroys all other content. For targeted edits use storage_replace; for adding to the end use storage_append. Parent directories are created automatically. Self-verifying: the file is re-statted after writing and the verified byte count is returned.\n\nNever prepend timestamps, chunk labels or any other bracketed context marker to file content — the chat stamps context automatically, and a marker before a YAML frontmatter block breaks the document. Frontmatter (if any) must open at line 1 with exactly "---". Leading markers are stripped and reported.`,
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
    },
    {
        type: 'function',
        function: {
            name: 'image_attach',
            description: `${SERVER_EXEC_NOTE}\n\nPut one or two images from workshop storage into THIS conversation as REAL image content parts — you see the pixels (multimodal input), not a description of them. This is the render-inspect loop: render something (e.g. workshop media.process: SVG diagram → PNG), attach it, LOOK at it, fix it, re-render — no human in the middle. Also for screenshots a browser tool took, keyframes pulled from video, or generated images you need to verify.\n\nTRANSIENT by design: the image lives for the current run only; later turns see only the text stub, which names the source path — re-attach by path when you need to look again. Guardrails: storage-relative paths only, at most 2 images per call, each ≤ 4 MB; anything above 2048 px is auto-downscaled via nMedia before attaching. SVG is refused — rasterize it first.`,
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'One storage-relative image path (png/jpg/webp/gif), e.g. "temp/machine-overview.png".' },
                    paths: { type: 'array', items: { type: 'string' }, maxItems: 2, description: 'Alternatively: 1-2 storage-relative image paths (e.g. two revisions to compare).' },
                    note: { type: 'string', description: 'Optional context carried in the stub, e.g. "revision 4 — check label overflow".' }
                }
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

// ============================================
// image_attach (#49): pixels into the model's eyes. Reads the image from the
// storage box on disk (no MCP wire, no base64 in any prompt), auto-downscales
// > 2048 px via nMedia, and returns MCP-style image content parts — the runner
// buckets them and the next request carries image_url parts. Transiency is
// enforced by the runner: image_attach results are flagged and stripped from
// request-building at the next run start (api-view checks toolImagesStripped).
// ============================================
const ATTACH_MAX_BYTES = 4 * 1024 * 1024;
const ATTACH_MAX_DIMENSION = 2048;
const IMAGE_MIME_BY_EXT = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };

// PNG IHDR / JPEG SOFn dimension sniff — enough for the 2048 px rule. Exotic
// formats return null and skip the downscale path (tolerance with a trace).
function sniffImageDims(buf) {
    if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50) {
        return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
        let pos = 2;
        while (pos + 9 < buf.length) {
            if (buf[pos] !== 0xff) { pos++; continue; }
            const marker = buf[pos + 1];
            if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
                return { height: buf.readUInt16BE(pos + 5), width: buf.readUInt16BE(pos + 7) };
            }
            pos += 2 + buf.readUInt16BE(pos + 2);
        }
    }
    return null;
}

async function downscaleViaNMedia(buffer, mime) {
    const format = mime === 'image/jpeg' ? 'jpeg' : (mime === 'image/webp' ? 'webp' : 'png');
    const res = await fetch(`${NMEDIA_URL}/v1/process/image`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base64: buffer.toString('base64'), max_dimension: ATTACH_MAX_DIMENSION, format, response_type: 'base64' })
    });
    if (!res.ok) throw new Error(`nMedia downscale failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    return {
        buffer: Buffer.from(String(data.base64).replace(/^data:[^;]+;base64,/, ''), 'base64'),
        width: data.width,
        height: data.height
    };
}

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
            const guard = stripFrontmatterMarkers(args.content);
            const backup = backupIfExists(abs, args.path);
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            fs.writeFileSync(abs, guard.content, 'utf8');
            const out = statOut(abs);
            LOG.info('storage_write', { path: args.path, bytes: out.bytes }, 'StorageTools');
            return jsonResult({ ok: true, path: args.path, ...(backup ? { previousVersion: backup } : {}), ...out, ...guardFields(guard) });
        }

        case 'storage_append': {
            if (typeof args.content !== 'string') throw new Error('storage_append: content (string) required');
            const abs = safeResolve(args.path);
            // Frontmatter guard only when this append CREATES the file — a
            // marker prepended to an existing journal is a legitimate stamp.
            const fresh = !fs.existsSync(abs) || fs.statSync(abs).size === 0;
            const guard = fresh ? stripFrontmatterMarkers(args.content) : { content: args.content, stripped: [] };
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            fs.appendFileSync(abs, guard.content, 'utf8');
            const out = statOut(abs);
            LOG.info('storage_append', { path: args.path, bytes: out.bytes }, 'StorageTools');
            return jsonResult({ ok: true, path: args.path, ...out, ...guardFields(guard) });
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
            const guard = stripFrontmatterMarkers(next);
            const backup = backupIfExists(abs, args.path);
            fs.writeFileSync(abs, guard.content, 'utf8');
            const out = statOut(abs);
            LOG.info('storage_replace', { path: args.path, occurrence, bytes: out.bytes }, 'StorageTools');
            return jsonResult({ ok: true, path: args.path, occurrence, ...(backup ? { previousVersion: backup } : {}), ...out, ...guardFields(guard) });
        }

        case 'storage_delete': {
            const abs = safeResolve(args.path);
            if (abs === ROOT) throw new Error('storage_delete: refusing to delete the storage root');
            const st = fs.statSync(abs);
            let backup = null;
            if (st.isDirectory()) {
                if (!args.recursive) throw new Error(`storage_delete: "${args.path}" is a directory — pass recursive:true`);
                LOG.warn('storage_delete: directory deleted WITHOUT snapshot (size unbounded)', { path: args.path }, 'StorageTools');
                fs.rmSync(abs, { recursive: true });
            } else {
                backup = backupIfExists(abs, args.path);
                fs.rmSync(abs);
            }
            LOG.info('storage_delete', { path: args.path, wasDirectory: st.isDirectory() }, 'StorageTools');
            return jsonResult({ ok: true, deleted: args.path, wasDirectory: st.isDirectory(), ...(backup ? { previousVersion: backup } : {}) });
        }

        case 'image_attach': {
            const requested = [];
            if (typeof args.path === 'string' && args.path.trim()) requested.push(args.path.trim());
            if (Array.isArray(args.paths)) {
                for (const p of args.paths) if (typeof p === 'string' && p.trim()) requested.push(p.trim());
            }
            if (!requested.length) throw new Error('image_attach: path (string) or paths (array of 1-2) is required');
            if (requested.length > 2) throw new Error('image_attach: at most 2 images per call — attach in pairs');

            const attached = [];
            for (const rel of requested) {
                const ext = path.extname(rel).toLowerCase();
                const mime = IMAGE_MIME_BY_EXT[ext];
                if (!mime) {
                    if (ext === '.svg') {
                        throw new Error(`image_attach: "${rel}" is SVG — rasterize first (workshop: media.process, SVG → PNG), then attach the PNG`);
                    }
                    throw new Error(`image_attach: "${rel}" is not an attachable image type (${Object.values(IMAGE_MIME_BY_EXT).join(', ')})`);
                }
                const abs = safeResolve(rel);
                if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
                    throw new Error(`image_attach: not found in storage: ${rel}`);
                }
                let buffer = fs.readFileSync(abs);
                let dims = sniffImageDims(buffer);
                let downscaledFrom = null;

                const overBytes = buffer.length > ATTACH_MAX_BYTES;
                const overDims = dims ? Math.max(dims.width, dims.height) > ATTACH_MAX_DIMENSION : false;
                if ((overBytes || overDims) && mime !== 'image/gif') {
                    try {
                        const r = await downscaleViaNMedia(buffer, mime);
                        downscaledFrom = dims;
                        buffer = r.buffer;
                        dims = { width: r.width, height: r.height };
                    } catch (e) {
                        if (buffer.length > ATTACH_MAX_BYTES) {
                            throw new Error(`image_attach: "${rel}" exceeds the ${Math.round(ATTACH_MAX_BYTES / 1024 / 1024)} MB limit and nMedia downscale failed: ${e.message}`);
                        }
                        LOG.warn('image_attach: downscale unavailable — attaching raw', { path: rel, error: e.message }, 'StorageTools');
                    }
                } else if (overBytes && mime === 'image/gif') {
                    throw new Error(`image_attach: "${rel}" is ${buffer.length} bytes — over the ${ATTACH_MAX_BYTES} limit; animated GIFs are not downscaled`);
                }
                if (buffer.length > ATTACH_MAX_BYTES) {
                    throw new Error(`image_attach: "${rel}" is ${buffer.length} bytes after downscale — over the ${ATTACH_MAX_BYTES} limit`);
                }
                attached.push({ rel, buffer, mime, dims, downscaledFrom });
            }

            const note = typeof args.note === 'string' && args.note.trim() ? ` — ${args.note.trim()}` : '';
            const summary = attached.map(a => {
                const dimsStr = a.dims ? `${a.dims.width}×${a.dims.height}` : 'dimensions unknown';
                const kb = `${Math.max(1, Math.round(a.buffer.length / 1024))} KB`;
                const scale = a.downscaledFrom ? ` (downscaled from ${a.downscaledFrom.width}×${a.downscaledFrom.height})` : '';
                return `${a.rel} (${dimsStr}, ${kb})${scale}`;
            }).join(', ');
            const text = `attached ${summary}${note}. The image is in your context for THIS run; afterwards only this stub remains — re-attach by path when you need to look again.`;
            LOG.info('image_attach', { paths: attached.map(a => a.rel), bytes: attached.reduce((s, a) => s + a.buffer.length, 0) }, 'StorageTools');
            return {
                content: [
                    { type: 'text', text },
                    ...attached.map(a => ({ type: 'image', data: a.buffer.toString('base64'), mimeType: a.mime }))
                ]
            };
        }

        default:
            throw new Error(`Unknown storage tool: ${name}`);
    }
}

module.exports = { init, TOOL_DEFS, isStorageTool, execute, safeResolve };
