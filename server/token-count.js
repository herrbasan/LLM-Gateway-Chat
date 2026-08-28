// ============================================
// token-count.js — authoritative token count of the EXACT payload the runner
// sends to the gateway. The gateway's context.used_tokens is a lossy heuristic
// (counts only m.content — misses reasoning_content and tool_calls JSON), so
// the side that holds the real payload does the counting. Same library the
// gateway uses (js-tiktoken, cl100k/o200k), but fed the full assembled list.
// ============================================

const { getEncoding } = require('js-tiktoken');

// Encodings are expensive to build (multi-MB rank tables). Hoist to module level.
const CL100K = getEncoding('cl100k_base');
const O200K = getEncoding('o200k_base');

function encode(text, model) {
    if (!text) return 0;
    try {
        const isO200k = typeof model === 'string' && /gpt-4o|\bo1\b|o200k/.test(model);
        return (isO200k ? O200K : CL100K).encode(text).length;
    } catch {
        // Lone-surrogate encode failure → char-ratio fallback (telemetry only).
        return Math.ceil(String(text).length * 0.25);
    }
}

function textOf(content, model) {
    if (content == null) return 0;
    if (typeof content === 'string') return encode(content, model);
    if (Array.isArray(content)) {
        // OpenAI content parts: text parts count; image parts have a token cost.
        let t = 0;
        for (const part of content) {
            if (part?.type === 'text') t += encode(part.text, model);
            else if (part?.type === 'image_url') t += (part.image_url?.detail === 'high' ? 255 : 85);
        }
        return t;
    }
    return encode(String(content), model);
}

// Count the full assembled apiMessages array — every field that goes on the wire.
function countApiMessages(apiMessages, model) {
    let total = 3; // request formatting overhead (matches gateway heuristic)
    for (const m of apiMessages) {
        total += 4; // per-message role/formatting overhead
        total += textOf(m.content, model);
        if (m.reasoning_content) total += encode(m.reasoning_content, model);
        if (m.tool_calls) total += encode(JSON.stringify(m.tool_calls), model);
    }
    return total;
}

// Count the STORED message list (the runner's canonical conversation form) —
// used to give the snapshot a fresh, honest context figure for an already-
// loaded conversation whose persisted per-message context predates the real
// counting (the gateway only ever counted m.content). Covers the same fields
// as countApiMessages plus tool-result content (stored role:'tool' messages).
function countStoredMessages(messages, model) {
    let total = 3;
    for (const m of messages) {
        total += 4;
        total += textOf(m.content, model);
        if (m.reasoning_content) total += encode(m.reasoning_content, model);
        if (m.tool_calls) total += encode(JSON.stringify(m.tool_calls), model);
        if (m.role === 'tool' && m.toolArgs) total += encode(JSON.stringify(m.toolArgs), model);
    }
    return total;
}

module.exports = { countApiMessages, countStoredMessages, encode };
