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

// Per-request breakdown: role/field token counts + a per-message table, so the
// console shows EXACTLY what was sent and where the tokens are. Verification
// tool for the context pill — answers "is this number real" by inspection.
function breakdownApiMessages(apiMessages, model) {
    const rows = [];
    let content = 0, reasoning = 0, toolCalls = 0, overhead = 3;
    apiMessages.forEach((m, i) => {
        const c = textOf(m.content, model);
        const r = m.reasoning_content ? encode(m.reasoning_content, model) : 0;
        const t = m.tool_calls ? encode(JSON.stringify(m.tool_calls), model) : 0;
        overhead += 4;
        content += c; reasoning += r; toolCalls += t;
        rows.push({ i, role: m.role, content: c, reasoning: r, toolCalls: t, total: c + r + t + 4 });
    });
    return {
        total: 3 + overhead - 3 + content + reasoning + toolCalls,
        byField: { content, reasoning, toolCalls, overhead },
        messages: rows
    };
}

module.exports = { countApiMessages, breakdownApiMessages, encode };
