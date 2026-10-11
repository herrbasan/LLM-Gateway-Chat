// ============================================
// retire-view.js — the retirement transform.
//
// Issue #52/#53 rework (2026-10-11): the chunking machinery is GONE —
// no [chunk_hash] labels, no exact/near dedup, no Jaccard scan, no diff
// chains. What survives is the concept that paid off: the model retires
// what it has consumed, its distillation rides as a tombstone.
//
// Addressing is POSITIONAL. The outgoing payload stamps every message
// with an [mN] marker (N = index in the canonical stored messages[]).
// context_retire names message indexes (or ranges); resolution hashes the
// stored fields at call time; the retirement map stays keyed by CONTENT
// HASH so edits/deletions can never shift a tombstone onto the wrong
// content. No label table exists anywhere — there is nothing to
// reconstruct from memory, which was the #52 failure mode (36 confabulated
// ids, 0 retired).
//
// COMPAT — persisted retirement keys (do not change):
//   tool results  : fnv1a of the timestamped API form ([ts]content) — the
//                   form the old engine hashed post-merge.
//   write-args    : fnv1a of the raw content-field value.
//   prose/reasoning/user: fnv1a of the bare stored text (never chunked
//                   before — fresh keys).
// The fnv1a function below is byte-identical to the old engine's.
//
// Reasoning policy is per-message, self-describing (no provider table):
//   unsigned reasoning → tombstone REPLACES the value (field stays present
//     — Kimi echo / DeepSeek field-presence contracts hold).
//   signed reasoning (thinking_signature) → DROP reasoning + signature
//     together. Anthropic-style contracts require verbatim round-trip of
//     signed thinking, but permit dropping PRIOR-TURN thinking blocks.
//   The live chain is never touched: messages at/after the last user
//     message pass through verbatim.
// ============================================

const CONTENT_ARG_FIELDS = {
    'tools': ['payload.content', 'payload.replacement'],
    'storage_write': ['content'],
    'storage_replace': ['replacement'],
    'storage_append': ['content']
};

// FNV-1a 32-bit — IDENTITY KEY for the persisted retirement map.
function fnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36);
}

const MARKER_REGEX = /^\[m(\d+)\]\s?/;
const MARKER_ANY = /\[m\d+\]/g;

// Canonical cleanliness: markers never live in stored content (the runner
// scrubs echoes at persist + dispatch), but user edits can paste one in —
// strip before hashing so a marker can never fork a key.
function stripMarkers(text) {
    return String(text || '').replace(MARKER_ANY, '');
}

// Legacy defense kept from the chunk era: content stored with a leading
// [chunk_…] label (issue #30 era) must not hash under the label.
function stripLegacyLabels(content) {
    return String(content || '').replace(/^(\[chunk_[a-z0-9]+[^\]\n]*\]\n?)+/, '');
}

function hashBare(text) {
    return fnv1a(stripLegacyLabels(stripMarkers(text)));
}

// ---- stored-form field extraction --------------------------------------
// The single inventory of what is retirable. Shared by the transform
// (api-view projection), the resolver (context_retire execution) and the
// enumerator (context_units) — they cannot disagree.

function getPath(obj, dotted) {
    let cur = obj;
    for (const part of dotted.split('.')) {
        if (cur == null || typeof cur !== 'object') return undefined;
        cur = cur[part];
    }
    return cur;
}

function argContentValues(toolName, toolArgs) {
    const fields = CONTENT_ARG_FIELDS[toolName];
    if (!fields || fields.length === 0) return [];
    let argsObj = toolArgs;
    if (typeof argsObj === 'string') {
        try { argsObj = JSON.parse(argsObj); } catch { return []; }
    }
    if (!argsObj || typeof argsObj !== 'object') return [];
    const out = [];
    for (const f of fields) {
        const v = getPath(argsObj, f);
        if (typeof v === 'string' && v.length > 0) out.push({ field: f, value: v });
    }
    return out;
}

// → [{ kind, hash, bytes, text }] — every retirable unit of a STORED message.
function retirableUnits(msg, formatTs) {
    const units = [];
    if (!msg || typeof msg !== 'object') return units;
    if (msg.role === 'tool' && (msg.toolStatus === 'success' || msg.toolStatus === 'error')) {
        if (typeof msg.content === 'string' && msg.content.trim()) {
            // LEGACY KEY FORM: hash the timestamped API form the old engine saw.
            const text = toolResultKeyText(msg, formatTs);
            units.push({ kind: 'tool-result', hash: hashBare(text), bytes: text.length, text });
        }
        for (const { field, value } of argContentValues(msg.toolName, msg.toolArgs)) {
            units.push({ kind: `args:${field}`, hash: hashBare(value), bytes: value.length, text: value });
        }
    } else if (msg.role === 'assistant') {
        if (typeof msg.content === 'string' && msg.content.trim()) {
            units.push({ kind: 'prose', hash: hashBare(msg.content), bytes: msg.content.length, text: msg.content });
        }
        if (typeof msg.reasoning_content === 'string' && msg.reasoning_content.trim()) {
            units.push({ kind: 'reasoning', hash: hashBare(msg.reasoning_content), bytes: msg.reasoning_content.length, text: msg.reasoning_content });
        }
        // Write-payload args live on the assistant's tool_calls (the stored
        // form of record) — mirrored as toolArgs on the tool message; both
        // hash identically (same value).
        if (Array.isArray(msg.tool_calls)) {
            for (const tc of msg.tool_calls) {
                let argsObj = null;
                try { argsObj = JSON.parse(tc.function?.arguments || '{}'); } catch { argsObj = null; }
                for (const { field, value } of argContentValues(tc.function?.name, argsObj)) {
                    units.push({ kind: `args:${field}`, hash: hashBare(value), bytes: value.length, text: value });
                }
            }
        }
    } else if (msg.role === 'user') {
        if (typeof msg.content === 'string' && msg.content.trim()) {
            units.push({ kind: 'user', hash: hashBare(msg.content), bytes: msg.content.length, text: msg.content });
        }
    }
    return units;
}

// ---- shared key construction ---------------------------------------------
// The exact text form each field is hashed over. ONE definition — the
// resolver, the enumerator and the transform all key through these.

function toolResultKeyText(msg, formatTs) {
    const clean = String(msg.content || '').replace(/^\[\d{4}-\d{2}-\d{2}@\d{2}:\d{2}\]\s*/, '').trim();
    const ts = formatTs ? formatTs(msg.createdAt) : '';
    return ts + clean;
}

function tombstoneText(distill, msgIdx, kind) {
    const what = kind === 'reasoning' ? 'RETIRED thinking'
        : kind === 'user' ? 'RETIRED user message'
        : 'RETIRED content';
    return `[${what} m${msgIdx} — distillation: "${distill}". Original intact in history; context_unretire restores it.]`;
}

const RETIREMENT_CONVENTION_PARAGRAPH =
    'This conversation supports context retirement: messages you name leave ' +
    'your context on the next request, and your distillation stays in their ' +
    'place as a tombstone. Every message is numbered — the [mN] marker at the ' +
    'start of a message is its address, N counts from the start (0-based). ' +
    'Retirement is an EXCEPTIONAL measure, not routine hygiene: full context ' +
    'is your best working material, and retiring has a real cost — it rewrites ' +
    'mid-history content, which invalidates the provider\'s KV cache at the ' +
    'first tombstone, so every token after it is billed as brand-new input on ' +
    'the next request. One retirement makes one request more expensive and ' +
    'every request after it cheaper. Retire ONLY when the context is genuinely ' +
    'running low (the context indicator approaching the window) or when the ' +
    'user asks for a more focused context. Do not retire preemptively, tidily, ' +
    'or on your own initiative otherwise. When you do retire: whole messages ' +
    'only (tool results, your reasoning and prose, user text together), in ONE ' +
    'batched call (indexes or ranges like "30-44") — separate calls each pay ' +
    'the cache re-entry again. Write ' +
    'distillations as your future working memory — key facts, figures, ' +
    'decisions, open items, enough to decide whether restoring the original ' +
    'is worth it; a vague distillation ("discusses infrastructure") is a ' +
    'failed retirement — if you cannot distill it specifically, you have not ' +
    'consumed it; do not retire it. Use context_units() ' +
    'to list what is retirable and already retired — NEVER guess or ' +
    'reconstruct message numbers from memory; count them from the [mN] ' +
    'markers you can see. Partial success is normal: unrecognized indexes ' +
    'are skipped and reported, the rest retire. context_unretire(messages) ' +
    'restores full text; "all" restores everything.';

// ---- the transform -------------------------------------------------------
// Applied inside api-view's per-message projection loop, on the STORED
// message (canonical form — never mutated; replacements ride the projected
// copy only). liveFromIdx: index of the last user message; anything >= it
// passes through verbatim (the live chain must round-trip exactly).
// formatTs: api-view's timestamp formatter (legacy key compat).
// Returns { content, reasoning_content, thinking_signature, toolArgs } —
// replacement fields; absent keys pass through untouched.

function transformStored(msg, msgIdx, retirements, liveFromIdx, formatTs) {
    const out = {};
    let unitsRetired = 0;
    const appliedHashes = [];
    const account = (hash, originalText, tomb) => {
        const saved = Math.max(0, (originalText?.length || 0) - (tomb?.length || 0));
        unitsRetired++;
        appliedHashes.push({ hash, saved });
    };
    const finish = () => {
        if (unitsRetired > 0) out._retireStats = { units: unitsRetired, savedBytes: appliedHashes.reduce((a, b) => a + b.saved, 0), hashes: appliedHashes };
        return out;
    };
    if (!retirements || Object.keys(retirements).length === 0) return out;
    if (msgIdx >= liveFromIdx) return out; // live chain — verbatim by contract

    if (msg.role === 'tool' && (msg.toolStatus === 'success' || msg.toolStatus === 'error')) {
        const tsText = toolResultKeyText(msg, formatTs);
        const r = retirements[hashBare(tsText)];
        if (r && tsText) { out.content = tombstoneText(r.distill, msgIdx, 'tool-result'); account(hashBare(tsText), tsText, out.content); }
        const args = argContentValues(msg.toolName, msg.toolArgs);
        if (args.length > 0) {
            // Clone before mutating — never touch the stored object (nDB
            // detached copies are the runner's working state).
            let argsObj = typeof msg.toolArgs === 'string' ? JSON.parse(msg.toolArgs) : JSON.parse(JSON.stringify(msg.toolArgs));
            let mutated = false;
            for (const { field, value } of args) {
                const vHash = hashBare(value);
                const ra = retirements[vHash];
                if (!ra) continue;
                const path = field.split('.');
                let cur = argsObj;
                for (let i = 0; i < path.length - 1; i++) cur = cur[path[i]];
                const tomb = tombstoneText(ra.distill, msgIdx, 'args');
                cur[path[path.length - 1]] = tomb;
                account(vHash, value, tomb);
                mutated = true;
            }
            if (mutated) out.toolArgs = typeof msg.toolArgs === 'string' ? JSON.stringify(argsObj) : argsObj;
        }
        return finish();
    }

    if (msg.role === 'assistant') {
        if (typeof msg.reasoning_content === 'string' && msg.reasoning_content.trim()) {
            const rHash = hashBare(msg.reasoning_content);
            const rr = retirements[rHash];
            if (rr) {
                if (msg.thinking_signature) {
                    // Signed reasoning cannot be modified — drop it whole.
                    out.reasoning_content = undefined;
                    out.thinking_signature = undefined;
                    account(rHash, msg.reasoning_content, '');
                } else {
                    out.reasoning_content = tombstoneText(rr.distill, msgIdx, 'reasoning');
                    account(rHash, msg.reasoning_content, out.reasoning_content);
                }
            }
        }
        if (typeof msg.content === 'string' && msg.content.trim()) {
            const rcHash = hashBare(msg.content);
            const rc = retirements[rcHash];
            if (rc) { out.content = tombstoneText(rc.distill, msgIdx, 'prose'); account(rcHash, msg.content, out.content); }
        }
        // Write-payload args on the assistant's own tool_calls (the stored
        // form of record — the tool-message mirror covers legacy shapes).
        if (Array.isArray(msg.tool_calls)) {
            let mutated = false;
            const newCalls = msg.tool_calls.map(tc => {
                let argsObj = null;
                try { argsObj = JSON.parse(tc.function?.arguments || '{}'); } catch { argsObj = null; }
                const vals = argContentValues(tc.function?.name, argsObj);
                if (vals.length === 0) return tc;
                let hit = false;
                for (const { field, value } of vals) {
                    const vHash = hashBare(value);
                    const ra = retirements[vHash];
                    if (!ra) continue;
                    const path = field.split('.');
                    let cur = argsObj;
                    for (let i = 0; i < path.length - 1; i++) cur = cur[path[i]];
                    const tomb = tombstoneText(ra.distill, msgIdx, 'args');
                    cur[path[path.length - 1]] = tomb;
                    account(vHash, value, tomb);
                    hit = true;
                }
                if (!hit) return tc;
                mutated = true;
                return { ...tc, function: { ...tc.function, arguments: JSON.stringify(argsObj) } };
            });
            if (mutated) out.toolCalls = newCalls;
        }
        return finish();
    }

    if (msg.role === 'user' && typeof msg.content === 'string' && msg.content.trim()) {
        const uHash = hashBare(msg.content);
        const ru = retirements[uHash];
        if (ru) { out.content = tombstoneText(ru.distill, msgIdx, 'user'); account(uHash, msg.content, out.content); }
    }
    return finish();
}

// ---- marker stamping -----------------------------------------------------

function stampMarker(content, msgIdx) {
    if (typeof content !== 'string' || !content.trim()) return content;
    return `[m${msgIdx}] ${content}`;
}

function scrubMarkers(text) {
    return String(text || '').replace(MARKER_ANY, '').trim();
}

module.exports = {
    fnv1a, hashBare, retirableUnits, transformStored, stampMarker, scrubMarkers,
    tombstoneText, RETIREMENT_CONVENTION_PARAGRAPH, CONTENT_ARG_FIELDS
};
