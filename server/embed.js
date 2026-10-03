const EMBEDDING_DIMS = parseInt(process.env.CHAT_EMBED_DIMS || 2560);
const TOK_CHARS_RATIO = parseFloat(process.env.CHAT_EMBED_TOK_RATIO || 2.5);

// Prefill cost on the embedding box is quadratic in input length, and the
// wrapper serves a single embedding slot (--parallel 1): one 20k-token input
// decays to ~60 tok/s (6-8 min) and queues every interactive lookup behind it,
// while ~1k-token inputs run at ~600 tok/s. So bulk paths embed small chunks
// and pack several chunks into one request, and no single input may exceed
// the hard cap. These are floors/defaults — callers pass config-derived
// overrides via the opts argument.
const EMBED_CHUNK_TOKENS = Math.max(64, parseInt(process.env.CHAT_EMBED_CHUNK_TOKENS || 1024));
// Tail of each chunk repeated at the head of the next, so an idea straddling a
// cut is fully present in at least one chunk. Cost: ~15% more chunks.
const EMBED_CHUNK_OVERLAP_TOKENS = Math.max(0, parseInt(process.env.CHAT_EMBED_CHUNK_OVERLAP_TOKENS || 128));
const EMBED_MAX_INPUT_TOKENS = Math.min(Math.max(EMBED_CHUNK_TOKENS, parseInt(process.env.CHAT_EMBED_MAX_INPUT_TOKENS || 4000)), 32768);
const EMBED_REQUEST_TOKENS = Math.min(Math.max(EMBED_MAX_INPUT_TOKENS, parseInt(process.env.CHAT_EMBED_REQUEST_TOKENS || 4096)), 32768);
// Hard ceiling on concurrent embedding requests: the box has ONE slot, so more
// in-flight requests than this only deepen its queue.
const EMBED_MAX_CONCURRENCY = Math.min(Math.max(1, parseInt(process.env.CHAT_EMBED_CONCURRENCY || 2)), 4);

function buildEmbedText(msg, session) {
    const parts = [];
    if (session?.mode === 'arena') {
        parts.push(`[Arena: ${(session.title || '').slice(0, 60)}]`);
        if (msg.speaker) parts.push(`[${msg.speaker}]`);
    } else {
        parts.push(`[Chat: ${(session?.title || '').slice(0, 60)}]`);
        parts.push(`[${msg.role}]`);
    }
    if (msg.model) parts.push(`[${msg.model}]`);
    parts.push(msg.content || '');
    return parts.join(' ');
}

// Cut-point preference: paragraph > line > sentence. Returns the offset to cut
// at inside `window`, or 0 when no usable boundary exists (hard cut instead).
function lastBreakOffset(window) {
    const para = window.lastIndexOf('\n\n');
    if (para >= 0) return para + 2;
    const line = window.lastIndexOf('\n');
    if (line >= 0) return line + 1;
    const re = /[.!?。！？][)\]"'\u2019\u201d]*\s/g;
    let last = 0;
    let m;
    while ((m = re.exec(window)) !== null) last = m.index + m[0].length;
    return last;
}

// Split a text into ~chunkTokens pieces, cutting on the largest boundary in the
// back half of each window so chunks stay near the target size instead of
// collapsing to whatever the last paragraph break happens to be. Consecutive
// chunks overlap by overlapTokens so nothing falls into a seam.
function splitTextIntoChunks(text, opts = {}) {
    const chunkTokens = Math.max(64, opts.chunkTokens || EMBED_CHUNK_TOKENS);
    const ratio = opts.tokRatio || TOK_CHARS_RATIO;
    const overlapTokens = Math.max(0, Math.min(
        opts.overlapTokens === undefined ? EMBED_CHUNK_OVERLAP_TOKENS : opts.overlapTokens,
        Math.floor(chunkTokens / 2)
    ));
    const maxChars = Math.max(1, Math.floor(chunkTokens * ratio));
    const overlapChars = Math.floor(overlapTokens * ratio);
    const src = String(text ?? '');
    if (src.length <= maxChars) return [{ text: src, tokEst: Math.ceil(src.length / ratio) }];

    const chunks = [];
    let cursor = 0;
    while (cursor < src.length) {
        let end = Math.min(cursor + maxChars, src.length);
        if (end < src.length) {
            const floor = cursor + Math.floor(maxChars * 0.5);
            const cut = lastBreakOffset(src.slice(floor, end));
            if (cut > 0) end = floor + cut;
        }
        const piece = src.slice(cursor, end);
        chunks.push({ text: piece, tokEst: Math.ceil(piece.length / ratio) });
        if (end >= src.length) break;
        // Step forward by the chunk minus the overlap; always at least 1 char so
        // a pathological overlap can never stall the loop.
        cursor += Math.max(1, (end - cursor) - overlapChars);
    }
    return chunks;
}

// Lower bound on a text's chunk count. Boundary cuts only ever produce MORE
// chunks, so a stored count below this means the message was embedded whole (or
// middle-truncated by the old pipeline) and needs re-embedding.
function minEmbedChunkCount(text, opts = {}) {
    const chunkTokens = Math.max(64, opts.chunkTokens || EMBED_CHUNK_TOKENS);
    const ratio = opts.tokRatio || TOK_CHARS_RATIO;
    const maxChars = Math.max(1, Math.floor(chunkTokens * ratio));
    const len = String(text ?? '').length;
    return len <= maxChars ? 1 : Math.ceil(len / maxChars);
}

// Pack chunk items into requests: many small chunks per request, but never more
// than that many tokens of prefill queued at the box at once.
function planEmbedBatches(items, opts = {}) {
    const maxRequestTokens = Math.max(1, opts.maxRequestTokens || EMBED_REQUEST_TOKENS);
    const batches = [];
    let current = [];
    let currentTokens = 0;
    for (const item of items) {
        if (current.length > 0 && currentTokens + item.tokEst > maxRequestTokens) {
            batches.push(current);
            current = [];
            currentTokens = 0;
        }
        current.push(item);
        currentTokens += item.tokEst;
    }
    if (current.length > 0) batches.push(current);
    return batches;
}

function embedVectorId(messageId, splitIdx) {
    return splitIdx > 0 ? `${messageId}_${splitIdx}` : messageId;
}

// Drop every vector a message owns. `knownChunks` is the stored chunk count; one
// extra index is swept so a message that shrank since it was embedded leaves no
// orphan behind.
function deleteEmbedVectors(embeddingsCol, messageId, knownChunks, log) {
    if (!embeddingsCol || !messageId) return 0;
    const count = Math.max(1, Number(knownChunks) || 1);
    let deleted = 0;
    for (let i = 0; i <= count; i++) {
        try {
            if (embeddingsCol.delete(embedVectorId(messageId, i))) deleted++;
        } catch (err) {
            if (log) log.warn('Embed vector delete failed', { messageId, splitIdx: i, error: err.message }, 'Embed');
        }
    }
    return deleted;
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchRetry(url, options, retries) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            // Chunks are ~1k tokens, so a request that runs for minutes is hung,
            // not slow — don't let it hold the box's single embedding slot.
            const res = await fetch(url, { ...options, signal: AbortSignal.timeout(5 * 60 * 1000), body: JSON.stringify(options.body) });
            if (!res.ok) {
                const err = await res.text().catch(() => 'unknown');
                throw new Error(`${res.status}: ${err.slice(0, 200)}`);
            }
            const data = await res.json();
            if (data.error) {
                throw new Error(data.error.message || JSON.stringify(data.error).slice(0, 200));
            }
            return data;
        } catch (err) {
            lastErr = err;
            if (attempt < retries) {
                const wait = Math.min(1000 * Math.pow(2, attempt), 10000);
                console.log(`\n  Retry ${attempt + 1}/${retries} in ${wait / 1000}s...`);
                await sleep(wait);
            }
        }
    }
    throw lastErr;
}

module.exports = {
    buildEmbedText,
    splitTextIntoChunks,
    minEmbedChunkCount,
    planEmbedBatches,
    embedVectorId,
    deleteEmbedVectors,
    fetchRetry,
    EMBEDDING_DIMS,
    EMBED_CHUNK_TOKENS,
    EMBED_CHUNK_OVERLAP_TOKENS,
    EMBED_MAX_INPUT_TOKENS,
    EMBED_REQUEST_TOKENS,
    EMBED_MAX_CONCURRENCY,
    TOK_CHARS_RATIO,
    sleep
};