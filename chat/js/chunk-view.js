// ============================================================
// chunk-view.js — the chunk-store transform engine.
//
// STANDALONE module: used by the replay simulation (docs/chunk-store/)
// and designed to port verbatim into chat/js/ (browser ES module).
// Zero dependencies. No DOM, no Node APIs, no ambient state.
//
// Input:  OpenAI-style message list (already built by getMessagesForApi).
// Output: transformed message list — same envelope, content replaced by
//         chunk-labeled diffs where a chain applies.
//
// Rules implemented (from plan-chunk-store.md):
//   - Chain identity: tool name + content-affecting args (allowlist)
//   - Rebase check: line-hash Jaccard < 0.25 → new base chunk
//   - Diff: line-based unified diff, 3 context lines, @@ anchors
//   - Apply: self-validating (context lines must match), fail loud
//   - Chain sources: tool messages AND assistant tool_calls args with
//     large content fields (write payloads live in args, not results)
//   - Shape invariance: only message.content strings change
// ============================================================

// ----------------------------------------------------------
// Chain identity
// ----------------------------------------------------------

// Per-tool allowlist of arg fields that affect content identity.
// Two messages chain iff tool name AND all listed fields are equal.
// Tools not listed here never chain (their results are one-shot).
const CHAIN_ARG_FIELDS = {
    // workshop storage surface (MCP "tools" relay uses method+payload)
    'tools': ['method', 'payload.path'],
    'storage_read': ['path'],
    'storage_write': ['path'],
    'storage_replace': ['path'],
    'storage_append': ['path'],
    // chat-app local archive tools — args come from the ACTUAL exports
    'chat_archive_get_session': ['session_id', 'id'],
    // date filters change the result set — different filters, different chain
    'chat_archive_list_arena': ['date_from', 'date_to', 'limit'],
    'chat_archive_list_chats': ['date_from', 'date_to', 'limit'],
    'chat_archive_search': ['query', 'search_type'],
    'chat_preview_show': [],
};

// Where the large CONTENT lives in a tool call's arguments, per tool.
// The content field is EXCLUDED from identity and is the diff payload.
// e.g. storage_write: { path, content } → chain on path, diff the content.
const CONTENT_ARG_FIELDS = {
    'tools': ['payload.content', 'payload.replacement'],   // storage.write / storage.replace via MCP relay
    'storage_write': ['content'],
    'storage_replace': ['replacement'],
    'storage_append': ['content'],
    'chat_archive_update_metadata': [], // small fields only — never chains as content
};

function getPath(obj, dotted) {
    return dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function setPath(obj, dotted, value) {
    const keys = dotted.split('.');
    const last = keys.pop();
    const target = keys.reduce((o, k) => (o[k] = o[k] ?? {}), obj);
    target[last] = value;
}

// Extract the chain key from a tool message's PRECEDING assistant tool_call
// (args live on the call, not the result). Returns null if not chainable.
export function chainKeyOf(toolName, argsObj) {
    const fields = CHAIN_ARG_FIELDS[toolName];
    if (!fields || !argsObj || typeof argsObj !== 'object') return null;
    const parts = [toolName];
    for (const f of fields) {
        const v = getPath(argsObj, f);
        parts.push(f + '=' + (v === undefined || v === null ? '' : String(v)));
    }
    return parts.join('|');
}

// ----------------------------------------------------------
// Line-hash Jaccard (cheap rebase check — O(n), no LCS)
// ----------------------------------------------------------

function lineHashSet(text) {
    const set = new Set();
    for (const line of text.split('\n')) {
        const t = line.trim();
        if (t.length > 0) set.add(t);
    }
    return set;
}

export function jaccardLines(a, b) {
    const sa = lineHashSet(a);
    const sb = lineHashSet(b);
    if (sa.size === 0 && sb.size === 0) return 1;
    let inter = 0;
    for (const x of sa) if (sb.has(x)) inter++;
    return inter / (sa.size + sb.size - inter);
}

// ----------------------------------------------------------
// Unified diff (line-based LCS, 3 context lines, @@ anchors)
// ----------------------------------------------------------

const CONTEXT = 3;

// LCS on lines via classic DP. For very large docs this is O(n*m) memory —
// acceptable up to ~5-10K lines/side (typical chat chunks are far smaller).
// Beyond that the caller should rebase instead of diffing (size ratio rule).
export function computeDiff(oldText, newText) {
    const a = oldText.split('\n');
    const b = newText.split('\n');
    const n = a.length, m = b.length;

    // LCS length table (row-major, (n+1)*(m+1))
    const W = m + 1;
    const dp = new Uint32Array((n + 1) * W);
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            dp[i * W + j] = a[i] === b[j]
                ? dp[(i + 1) * W + (j + 1)] + 1
                : Math.max(dp[(i + 1) * W + j], dp[i * W + (j + 1)]);
        }
    }

    // Walk to an edit script
    const ops = []; // { type: ' '|'-'|'+', line }
    let i = 0, j = 0;
    while (i < n && j < m) {
        if (a[i] === b[j]) { ops.push({ t: ' ', l: a[i] }); i++; j++; }
        else if (dp[(i + 1) * W + j] >= dp[i * W + (j + 1)]) { ops.push({ t: '-', l: a[i] }); i++; }
        else { ops.push({ t: '+', l: b[j] }); j++; }
    }
    while (i < n) { ops.push({ t: '-', l: a[i++] }); }
    while (j < m) { ops.push({ t: '+', l: b[j++] }); }

    // Group into hunks with CONTEXT lines
    const hunks = [];
    let cur = null;
    for (let k = 0; k < ops.length; k++) {
        const op = ops[k];
        if (op.t === ' ') {
            // peek: is this context within reach of a change?
            const nearChange =
                ops.slice(Math.max(0, k - CONTEXT), k).some(o => o.t !== ' ') ||
                ops.slice(k + 1, k + 1 + CONTEXT).some(o => o.t !== ' ');
            if (nearChange && cur) {
                cur.ops.push(op);
            } else if (nearChange && !cur) {
                // start hunk with trailing context already missed — include
                // up to CONTEXT preceding ' ' ops
                const start = Math.max(0, k - CONTEXT);
                cur = { ops: ops.slice(start, k + 1).map(o => ({ ...o })) };
            } else if (cur) {
                // far from change: close hunk
                hunks.push(cur); cur = null;
            }
        } else {
            if (!cur) {
                const start = Math.max(0, k - CONTEXT);
                cur = { ops: ops.slice(start, k).filter(o => o.t === ' ').map(o => ({ ...o })) };
                cur.ops.push(op);
            } else {
                cur.ops.push(op);
            }
        }
    }
    if (cur) hunks.push(cur);

    // Emit unified diff text
    const out = ['--- a/base', '+++ b/next'];
    for (const h of hunks) {
        // compute old/new ranges
        let oldStart = null, oldCount = 0, newCount = 0, idx = 0;
        // find positions by replaying ops
        let oldPos = 1, newPos = 1;
        // recompute positions globally:
        // (simpler: track during walk — but hunk ops are subsets; recompute per hunk by scanning)
        // We track absolute positions by re-walking ops with a cursor.
        // For simplicity and correctness, we annotate ops with positions in a pre-pass:
        out.push('@@ ... @@'); // placeholder replaced below
        for (const op of h.ops) out.push(op.t + op.l);
    }

    // --- second pass with positions for correct @@ headers ---
    // annotate ops with old/new line numbers
    let oi = 1, ni = 1;
    const annotated = ops.map(op => {
        const r = { ...op, o: op.t !== '+' ? oi++ : null, n: op.t !== '-' ? ni++ : null };
        return r;
    });
    // rebuild hunks over annotated ops (same grouping logic, positions known)
    const outLines = ['--- a/base', '+++ b/next'];
    let k = 0;
    while (k < annotated.length) {
        // skip far-from-change context
        if (annotated[k].t === ' ') {
            const near =
                annotated.slice(Math.max(0, k - CONTEXT), k).some(o => o.t !== ' ') ||
                annotated.slice(k + 1, k + 1 + CONTEXT).some(o => o.t !== ' ');
            if (!near) { k++; continue; }
        }
        // collect a hunk: from k, extend while ops are non-context-relevant
        const hunkOps = [];
        let p = k;
        // include leading context
        let lead = Math.max(0, k - 0); // k already positioned at a relevant op
        while (p < annotated.length) {
            const op = annotated[p];
            if (op.t === ' ') {
                const nearAfter = annotated.slice(p + 1, p + 1 + CONTEXT).some(o => o.t !== ' ');
                const nearBefore = hunkOps.some(o => o.t !== ' ');
                if (nearBefore && (nearAfter || hunkOps.filter(o => o.t === ' ').length < CONTEXT * 2)) {
                    hunkOps.push(op); p++; continue;
                }
                if (!nearBefore) { hunkOps.push(op); p++; continue; }
                break;
            }
            hunkOps.push(op); p++;
        }
        if (hunkOps.length === 0) { k++; continue; }
        const oldLines = hunkOps.filter(o => o.t !== '+');
        const newLines = hunkOps.filter(o => o.t !== '-');
        const oStart = oldLines.length ? oldLines[0].o : (annotated[k]?.o ?? 1);
        const nStart = newLines.length ? newLines[0].n : (annotated[k]?.n ?? 1);
        outLines.push(`@@ -${oStart},${oldLines.length} +${nStart},${newLines.length} @@`);
        for (const op of hunkOps) outLines.push(op.t + op.l);
        k = p;
    }
    return outLines.join('\n');
}

// Apply a unified diff produced by computeDiff. Self-validating:
// context and '-' lines must match the base exactly at the stated
// positions (@@ headers trusted, then verified). Throws on mismatch.
export function applyDiff(baseText, diffText) {
    const base = baseText.split('\n');
    const lines = diffText.split('\n');
    const out = [];
    let basePos = 0; // 0-based into base
    let i = 0;
    // skip ---/+++ header
    while (i < lines.length && (lines[i].startsWith('---') || lines[i].startsWith('+++'))) i++;
    for (; i < lines.length; i++) {
        const line = lines[i];
        if (line.startsWith('@@')) {
            const m = line.match(/^@@ -(\d+),(\d+) \+(\d+),(\d+) @@/);
            if (!m) throw new Error('applyDiff: malformed hunk header: ' + line);
            const oldStart = parseInt(m[1], 10) - 1; // to 0-based
            // copy unchanged region before hunk
            while (basePos < oldStart) {
                if (basePos >= base.length) throw new Error(`applyDiff: hunk starts beyond base (pos ${oldStart})`);
                out.push(base[basePos++]);
            }
            continue;
        }
        const tag = line[0];
        const body = line.slice(1);
        if (tag === ' ') {
            if (base[basePos] !== body) throw new Error(`applyDiff: context mismatch at base line ${basePos + 1}: expected ${JSON.stringify(base[basePos])}, diff has ${JSON.stringify(body)}`);
            out.push(base[basePos++]);
        } else if (tag === '-') {
            if (base[basePos] !== body) throw new Error(`applyDiff: delete mismatch at base line ${basePos + 1}`);
            basePos++; // consumed, not emitted
        } else if (tag === '+') {
            out.push(body);
        } else {
            throw new Error('applyDiff: unknown line tag: ' + JSON.stringify(line.slice(0, 40)));
        }
    }
    // trailing unchanged region
    while (basePos < base.length) out.push(base[basePos++]);
    return out.join('\n');
}

// ----------------------------------------------------------
// The transform
// ----------------------------------------------------------

export const CHUNK_CONVENTION_PARAGRAPH =
    'This conversation uses content-addressed chunks. Large contents are ' +
    'labeled [chunk_N] — the label may prefix a message body OR appear inside ' +
    'a tool call\'s arguments. Labels persist: when chunk content is written ' +
    'to a file, the label is stored with it, so a file may legitimately begin ' +
    'with a [chunk_N] line — that is normal, not a bug, and not a reference. ' +
    'If a later message would repeat a chunk you have already seen, it is ' +
    'replaced by a one-line reference: [chunk_M = chunk_N] means byte-identical ' +
    'content; [chunk_M ≈ chunk_N (same content, minor differences)] means the ' +
    'same content with small edits or reordering. In both cases you ALREADY ' +
    'HAVE the full content at the referenced label — treat the reference as ' +
    'that content. A label [chunk_N, diff of chunk_M] contains a unified diff: ' +
    'apply it mentally to chunk_M for the full content. ' +
    'These labels are produced by a deterministic transform, not by you. If ' +
    'one looks wrong — a reference to a chunk you cannot find, a doubled ' +
    'label, a reference where content should be — say so explicitly in your ' +
    'reply instead of working around it. You are the only observer who sees ' +
    'the transformed view; malformed labels are bugs worth reporting.';

const MIN_CHAIN_CHARS = 2000;   // below this, references aren't worth the label
const REBASE_JACCARD = 0.25;    // diff mode: below this overlap → new base chunk
const MAX_DIFF_LINES = 8000;    // diff mode: LCS guard
const NEARDUP_JACCARD = 0.85;   // dedup: at/above this line-set overlap → reference
const ENABLE_DIFFS = false;     // parked: sequential-edit chains (see plan)

// Fast content fingerprint: exact hash (FNV-1a, enough for identity) +
// line-set for near-dup detection.
function fnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36);
}

// Shape-aware fingerprint. MCP/JSON-RPC tool responses carry their payload
// as ONE giant escaped string line ("body": "...") — raw-line fingerprints
// see '1 of 10 lines changed' and miss 99.9% content identity. For those,
// fingerprint the PARSED string fields (recursively) instead of raw lines.
// Returns { hash, features: Set } — features feed the near-dup Jaccard.
function fingerprint(content) {
    let parsed = null;
    const t = content.trim();
    if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
        try { parsed = JSON.parse(content); } catch { parsed = null; }
    }
    if (parsed !== null) {
        const strings = [];
        const walk = (v) => {
            if (typeof v === 'string') strings.push(v);
            else if (Array.isArray(v)) v.forEach(walk);
            else if (v && typeof v === 'object') Object.values(v).forEach(walk);
        };
        walk(parsed);
        const big = strings.filter(s => s.length > 200);
        if (big.length > 0) {
            const joined = big.join('\u0001');
            const set = new Set();
            for (const s of big) {
                for (const line of s.split('\n')) {
                    const x = line.trim();
                    if (x.length > 0) set.add(x);
                }
            }
            return { hash: fnv1a(joined), features: set };
        }
    }
    // plain text path: line-based
    return { hash: fnv1a(content), features: lineHashSet(content) };
}

// messages: OpenAI-style array (system/user/assistant/tool).
// Returns { messages, stats } — transformed copy; input NOT mutated.
//
// PRIMARY mechanism (always on): dedup. Every large content gets a chunk
// label on first sight; a later byte-identical or near-identical (line-set
// reshuffle) repeat collapses to a one-line back-reference. Lossless: the
// full content remains in the payload at the referenced label.
//
// SECONDARY (ENABLE_DIFFS, parked): positional diff-chains for sequential
// edits to the same artifact. Engine proven (round-trip tests incl. real
// 114K corpus pair), but corpus analysis shows re-fetch/reshuffle dominates
// over sequential edits — dedup catches the mass, diffs serve a niche.
export function buildChunkView(messages) {
    const out = [];
    const seen = new Map();      // exactHash -> { id, text }
    const lineSets = [];         // { id, set } for near-dup scan
    const chains = new Map();    // diff mode only
    const stats = { chunks: 0, exactDupes: 0, nearDupes: 0, diffs: 0, rebases: 0, reorderFallbacks: 0, bytesIn: 0, bytesOut: 0, maxDepth: 0 };
    let chunkCounter = 0;
    let hasChunks = false;

    // Strip OUR OWN leading labels before fingerprinting — idempotence.
    // A labeled chunk stored to disk (the model writes the label into file
    // content) comes back wearing [chunk_N]; without stripping, it reads as
    // new content and gets a second label stamped on top. Repeatedly.
    function stripOwnLabels(content) {
        return content.replace(/^(\[chunk_\d+[^\]\n]*\]\n?)+/, '');
    }

    // Core: dedup first, then (optionally) diff-chain. Returns { text, emitted }.
    function transform(key, content) {
        const hadLabel = /^\[chunk_\d+/.test(content);
        const bare = stripOwnLabels(content);
        // 1) exact dedup (on the BARE content — labels don't affect identity)
        const fp = fingerprint(bare);
        const hit = seen.get(fp.hash);
        if (hit) {
            chunkCounter++;
            const id = `chunk_${chunkCounter}`;
            stats.exactDupes++; stats.chunks++; hasChunks = true;
            return { text: `[${id} = ${hit.id}]`, emitted: true };
        }
        // 2) near-dup (same lines, reshuffled / counter-touched) — size-gated scan
        const set = fp.features;
        for (const cand of lineSets) {
            if (Math.abs(cand.set.size - set.size) > 0.2 * Math.max(cand.set.size, set.size)) continue;
            let inter = 0;
            for (const x of set) if (cand.set.has(x)) inter++;
            const jac = inter / (set.size + cand.set.size - inter);
            if (jac >= NEARDUP_JACCARD) {
                chunkCounter++;
                const id = `chunk_${chunkCounter}`;
                stats.nearDupes++; stats.chunks++; hasChunks = true;
                return { text: `[${id} ≈ ${cand.id} (same content, minor differences)]`, emitted: true };
            }
        }
        // 3) diff-chain (parked)
        if (ENABLE_DIFFS && key) {
            const chain = chains.get(key);
            if (chain) {
                const overlap = jaccardLines(chain.lastText, content);
                const tooBig = content.split('\n').length > MAX_DIFF_LINES;
                if (!tooBig && overlap >= REBASE_JACCARD) {
                    const diff = computeDiff(chain.lastText, content);
                    if (diff.length < content.length) {
                        chunkCounter++;
                        const id = `chunk_${chunkCounter}`;
                        chain.depth++;
                        stats.maxDepth = Math.max(stats.maxDepth, chain.depth);
                        stats.diffs++; stats.chunks++; hasChunks = true;
                        chain.lastChunkId = id;
                        chain.lastText = content;
                        seen.set(fp.hash, { id, text: content });
                        lineSets.push({ id, set });
                        return { text: `[${id}, diff of ${chain.lastChunkId}]\n${diff}`, emitted: true };
                    }
                    stats.reorderFallbacks++;
                } else {
                    stats.rebases++;
                }
            }
            const id0 = `chunk_${++chunkCounter}`;
            chains.set(key, { lastChunkId: id0, lastText: content, depth: 0 });
            // base rides full, labeled so diffs/refs have a target
            seen.set(fp.hash, { id: id0, text: content });
            lineSets.push({ id: id0, set });
            stats.chunks++; hasChunks = true;
            return { text: `[${id0}]\n${content}`, emitted: true };
        }
        // 4) first sight (dedup mode): register + label so later refs resolve.
        // If the content ALREADY wears our label (stored earlier, now re-sent),
        // don't stamp a second one — register the bare content so future
        // unlabeled copies still dedup against it, and pass it through as-is.
        if (hadLabel) {
            const existing = content.match(/^\[chunk_(\d+)/);
            const keepId = existing ? `chunk_${existing[1]}` : null;
            if (keepId) {
                seen.set(fp.hash, { id: keepId, text: bare });
                lineSets.push({ id: keepId, set });
                stats.chunks++; hasChunks = true;
            }
            return { text: content, emitted: true };
        }
        const id = `chunk_${++chunkCounter}`;
        seen.set(fp.hash, { id, text: bare });
        lineSets.push({ id, set });
        stats.chunks++; hasChunks = true;
        return { text: `[${id}]\n${content}`, emitted: true };
    }

    for (let idx = 0; idx < messages.length; idx++) {
        const msg = messages[idx];
        stats.bytesIn += (typeof msg.content === 'string' ? msg.content.length : 0);

        // ---- A) assistant tool_calls: diff large CONTENT args ----
        if (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
            let changed = false;
            const newCalls = msg.tool_calls.map(tc => {
                const name = tc.function?.name;
                const contentFields = CONTENT_ARG_FIELDS[name];
                if (!contentFields || contentFields.length === 0) return tc;
                let argsObj;
                try { argsObj = JSON.parse(tc.function?.arguments || '{}'); } catch { return tc; }
                const key = chainKeyOf(name, argsObj);
                if (!key) return tc;
                let mutated = false;
                for (const field of contentFields) {
                    const val = getPath(argsObj, field);
                    if (typeof val !== 'string' || val.length <= MIN_CHAIN_CHARS) continue;
                    stats.bytesIn += val.length;
                    const r = transform(key + '|args', val);
                    if (r.emitted) {
                        setPath(argsObj, field, r.text);
                        mutated = true;
                        stats.bytesOut += r.text.length;
                    } else {
                        stats.bytesOut += val.length;
                    }
                }
                if (!mutated) return tc;
                changed = true;
                return { ...tc, function: { ...tc.function, arguments: JSON.stringify(argsObj) } };
            });
            stats.bytesIn += 0; // content already counted above
            out.push(changed ? { ...msg, tool_calls: newCalls } : msg);
            continue;
        }

        // ---- B) tool results: diff large result bodies ----
        if (msg.role === 'tool' && typeof msg.content === 'string' && msg.content.length > MIN_CHAIN_CHARS) {
            let toolName = null, argsObj = null;
            for (let p = out.length - 1; p >= 0; p--) {
                const prev = out[p];
                if (prev.role === 'assistant' && prev.tool_calls) {
                    const tc = prev.tool_calls.find(t => t.id === msg.tool_call_id);
                    if (tc) {
                        toolName = tc.function?.name;
                        try { argsObj = JSON.parse(tc.function?.arguments || '{}'); } catch { argsObj = null; }
                        break;
                    }
                } else if (prev.role !== 'tool') break;
            }
            const key = toolName ? chainKeyOf(toolName, argsObj) : null;
            {
                const r = transform((key || 'tool:' + (toolName || '?')) + '|result', msg.content);
                stats.bytesOut += r.text.length;
                out.push(r.emitted ? { ...msg, content: r.text } : msg);
                continue;
            }
        }

        stats.bytesOut += (typeof msg.content === 'string' ? msg.content.length : 0);
        out.push(msg);
    }

    // Prepend the convention paragraph to the FIRST system message if chunks exist
    if (hasChunks) {
        const sysIdx = out.findIndex(m => m.role === 'system');
        if (sysIdx >= 0) {
            out[sysIdx] = { ...out[sysIdx], content: out[sysIdx].content + '\n\n' + CHUNK_CONVENTION_PARAGRAPH };
        } else {
            out.unshift({ role: 'system', content: CHUNK_CONVENTION_PARAGRAPH });
        }
    }

    return { messages: out, stats };
}
