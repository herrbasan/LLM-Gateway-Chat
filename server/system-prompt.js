// ============================================
// system-prompt.js — server-side system prompt assembly.
// Faithful port of chat.js getSystemPromptWithMetadata (deep-dive G1):
// output must be byte-equivalent to the browser-built prompt, or model
// behavior silently changes mid-refactor.
//
// ctx = {
//   instructions,             // prime-directive blob (server already fetches it)
//   user: { name, location, language },
//   sessionPrompt,            // per-chat system prompt textarea content
//   archiveTools: {           // null disables the whole archive block (PA)
//     sessionId,              // CURRENT SESSION ID line
//     mcpOrigin               // workshop origin, appears twice
//   } | null,
//   mcpResources: { resources, templates } | null,   // null in PA (no pool yet)
//   memoryToolsAvailable: bool                        // false in PA
//   substrate: model id serving this session          // #28 — the seat sees its own substrate
//     (2026-08-31: full /v1/models entry object — id, adapterModel,
//     capabilities { contextWindow, vision, tools, thinkingLevels, … } —
//     so the seat knows what it is. Bare id string still accepted.)
// }
// ============================================

// Version derived from package.json at startup — never hardcoded, so the
// injected footer can't drift from the actual app version (#29).
const APP_VERSION = require('../package.json').version;

function _formatTokensCompact(n) {
    if (n >= 1000000) return Math.round(n / 100000) / 10 + 'M';
    if (n >= 1000) return Math.round(n / 100) / 10 + 'K';
    return String(n);
}

// The seat's self-knowledge: everything the models list knows about the model
// serving this turn. Fields render only when present — the gateway entry
// shape varies per provider.
function _substrateSegment(substrate) {
    if (!substrate) return null;
    if (typeof substrate === 'string') return `Substrate: "${substrate}"`;
    const caps = substrate.capabilities || {};
    const facts = [];
    if (substrate.adapterModel) facts.push(`upstream "${substrate.adapterModel}"`);
    if (caps.contextWindow) facts.push(`context ${_formatTokensCompact(caps.contextWindow)} tokens`);
    if (caps.vision) facts.push('vision');
    if (caps.tools) facts.push('tools');
    const thinking = Array.isArray(caps.thinkingLevels) && caps.thinkingLevels.length
        ? caps.thinkingLevels.join('/')
        : (caps.thinking ? String(caps.thinking) : null);
    if (thinking) facts.push(`thinking ${thinking}`);
    return `Substrate: "${substrate.id}"${facts.length ? ' — ' + facts.join(', ') : ''}`;
}

function buildMetadataPrefix(user = {}, substrate = null) {
    const parts = [`LLM Gateway Chat v${APP_VERSION}`];
    const substrateSegment = _substrateSegment(substrate);
    if (substrateSegment) parts.push(substrateSegment);
    if (user.name) parts.push(`User: "${user.name}"`);
    if (user.location) parts.push(`Location: "${user.location}"`);
    if (user.language) parts.push(`Language: "${user.language}"`);
    // Absolute time anchor (2026-08-31): day granularity — fine-grained relative
    // time comes from the per-message [ts] prefixes in the api-view projection.
    // Day precision keeps the system prompt byte-stable within a day (cache).
    const now = new Date();
    const p = n => String(n).padStart(2, '0');
    parts.push(`Date: "${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}"`);
    const header = parts.join(' | ');
    const instruction = 'Do not include timestamps in your responses - they are added automatically by the chat system.';
    return `${header}\n${instruction}`;
}

function buildArchiveBlock(sessionId, mcpOrigin, serverSide = false) {
    const origin = mcpOrigin || '(not configured)';
    const originExample = mcpOrigin || 'http://<mcp-origin>';
    return `\n\n## EXECUTION CONTEXTS — Tools live in one of these:\n\n  CONTEXT A: MCP Server (workshop, port 3100)\n    storage.*, memory.*, forge.*, documentation.*, vision.*, etc.\n    Reach: filesystem, LLM Gateway, browser sessions, GitHub API.\n\n  CONTEXT B: Forge Worker (inside forge.call)\n    Isolated worker_thread. Has ONLY: ctx.payload, ctx.gateway,\n    ctx.storagePath. CANNOT reach: chat app storage, other MCP tools,\n    browser APIs.\n\n  CONTEXT C: Chat App Backend (server-side — this conversation's runner)\n    chat_archive.*, attachment_save, browser_fetch, context_retire/unretire.\n    Reach: chat app data, conversation archive, workshop storage, any URL.\n    NOT accessible from MCP server tools or Forge workers.\n    Call these tools DIRECTLY by name. Never invoke them through the\n    workshop tools dispatcher or any MCP server — that returns\n    "Unknown method" errors. They execute natively in the chat backend.\n\n  A forge tool calling another MCP tool by HTTP will always 404.\n  A forge tool calling a chat app tool will always fail. There is no relay.\n  Plan your data flow at the top level.\n\nYou have access to the conversation archive. Use chat_archive_search for thematic/conceptual queries (use search_type: "keyword" for specific technical terms, "semantic" for ideas, "hybrid" for both). Use chat_archive_get_session to retrieve full conversations by ID. Use chat_archive_list_chats to browse normal chats. Use chat_archive_list_arena to browse arena sessions. Use chat_archive_find_similar to discover related sessions given a known session ID. Use chat_archive_find_references to trace conversation lineage (which sessions reference each other). Use chat_archive_update_metadata to update category, title, or structured summary — the summary is an OBJECT {title, teaser, reflection}, never a bare string; pass it as a nested object or via the flat title/teaser/reflection params.\n\nCURRENT SESSION ID: ${sessionId || '(none — start a chat first)'}. This is the session you are talking to the user in right now. When you need to update the metadata of THIS conversation (e.g. tag it with a summary or category at the end of a session), use this exact ID — never guess an ID from archive listings. Guessing hit an unrelated curated session and destroyed its summary (issue #8); updates to sessions whose summary contains CURATED are rejected unless force:true is passed.\n\n## Large File Retrieval — storage.read + browser_fetch\n\nYour MCP server (workshop) origin is: ${origin}\n\nThe rule for ANY storage file: call \`storage.read\` with just the path.\n- Small files come back inline as content. Done.\n- Larger files come back as a pointer containing a \`path\` field like \`/storage/somefile.md\` — RELATIVE, no host. Prepend YOUR MCP origin above and fetch the full URL with \`browser_fetch\`. Example: \`browser_fetch({ url: "${originExample}/storage/somefile.md" })\`.\n- To read only PART of a file (page through a big file, or grab the end of a log), \`storage.read\` also accepts \`offset\`+\`length\` (byte window), \`head\` (first N lines), or \`tail\` (last N lines).\n\nbrowser_fetch is a general-purpose fetch tool, native to this chat app (NOT an MCP method). It performs a direct browser fetch(), bypassing MCP's ~64 KB per-message size limit. Use it for any URL you want to retrieve — storage files, or anything else.\n\nHow to call browser_fetch:\n1. Use the tool name exactly: browser_fetch\n2. Pass the full absolute URL in the "url" argument.\n3. Optional: set "max_inline_bytes" to control how many bytes are returned as inline text (default 5,242,880 = 5 MB). Set it to 0 to always upload the response to the chat bucket and receive a URL instead.\n4. Optional: set "method", "headers", or "body" for non-GET requests.\n\nWhat you get back:\n- For text/* or application/json responses that are smaller than max_inline_bytes: a JSON object with the response body in the "body" field.\n- For binary responses, or text larger than max_inline_bytes, or when max_inline_bytes is 0: the response is uploaded to the chat bucket and you receive a "/api/buckets/images/..." URL plus metadata. If the URL points to a text file you can read, call browser_fetch again on that URL to retrieve the text.\n\n## Saving Attachments to Workshop Storage\n\nWhen a user attaches an image or other binary, the message text includes an attachment manifest line like: \`[attachment 0: name="photo.jpg" mime="image/jpeg" url="http://.../api/buckets/images/..."]\`. To persist that file into workshop storage, use \`attachment_save({ url: "<the bucket URL>", storage_path: "<destination path>" })\`. It copies the bytes server-side — no base64 in your context. Example: \`attachment_save({ url: "http://.../api/buckets/images/abc.jpg", storage_path: "digital-twin/images/photo.jpg" })\`.`;
}

function buildMcpResourceContext(resources = [], templates = []) {
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

const MEMORY_REMINDER = '\n\n## Memory Tools — Use Proactively\n\nThis chat app has persistent memory. Start every session with `memory.overview` to see what is already known, then use the tools below.\n\n- `memory.overview` — See your current memory map and top-priority facts. Run this at the start of each session.\n- `memory.store` — Save anything useful: user preferences, project facts, decisions, failures, plans, context. Store aggressively.\n- `memory.recall` — Search memory by meaning. Use before big decisions or when you need prior context.\n- `memory.get` — Retrieve one specific memory by ID.\n- `memory.list` — Browse all memories, optionally filtered by category.\n- `memory.update` / `memory.forget` — Edit or remove outdated memories.\n\nGuideline: Begin with `memory.overview`. If something would help future-you give a better answer, store it. If you need prior context, recall it.';

function buildSystemPrompt(ctx = {}) {
    const { instructions = '', user = {}, sessionPrompt = '', archiveTools = null, mcpResources = null, memoryToolsAvailable = false, substrate = null } = ctx;
    const metadata = buildMetadataPrefix(user, substrate);

    let prompt = instructions ? `${instructions}\n\n${metadata}` : metadata;
    if (sessionPrompt?.trim()) {
        prompt = `${prompt}\n\n${sessionPrompt.trim()}`;
    }

    if (archiveTools) {
        prompt += buildArchiveBlock(archiveTools.sessionId, archiveTools.mcpOrigin, archiveTools.serverSide === true);
    }

    if (mcpResources) {
        const block = buildMcpResourceContext(mcpResources.resources || [], mcpResources.templates || []);
        if (block) prompt += '\n\n## MCP Resources Available\n\n' + block;
    }

    if (memoryToolsAvailable) {
        prompt += MEMORY_REMINDER;
    }

    return prompt;
}

module.exports = { buildSystemPrompt, buildMetadataPrefix, buildMcpResourceContext };
