/**
 * BLAKE3 and nVDB v2 document hashing — vanilla CommonJS, zero dependencies.
 *
 * Mirrors the Rust implementation the v2 index hashes with:
 *   - src/nVDB/src/v2/schema.rs  `V2Document::indexable_text`
 *   - src/nVDB/src/sync.rs       `compute_content_hash`, `compute_envelope_hash`,
 *                                `hash_field`, `write_canonical_json`, `write_json_string`
 *
 * The Rust side is authoritative. `tests/v2-hash.test.mjs` in mcp_server checks
 * the ESM original against golden vectors produced by that exact code, so any
 * divergence here must be treated as a bug in this file.
 *
 * Known divergence, deliberately not papered over: `metadata` numbers are
 * rendered exactly as serde_json renders them after the JSON round trip —
 * integers inside the i64/u64 range print as integers, everything else with
 * ryu's shortest digits and notation — except that for a handful of doubles JS
 * and Rust pick different (equally valid, equally round-tripping) shortest digit
 * sequences — e.g. the f64 nearest 1.2345678901234567e21 prints
 * `1.2345678901234568e+21` from ryu and `1.2345678901234567e+21` from V8. An
 * integral number here is therefore an integer; a JSON literal such as `1.0`
 * has no JS representation to keep.
 */

const CURRENT_SCHEMA_VERSION = 2;
const CURRENT_ANALYZER_VERSION = 2;

const OUT_LEN = 32;
const BLOCK_LEN = 64;
const CHUNK_LEN = 1024;

const IV = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

const MSG_PERMUTATION = [2, 6, 3, 10, 7, 0, 4, 13, 1, 11, 12, 5, 9, 14, 15, 8];

const CHUNK_START = 1;
const CHUNK_END = 2;
const PARENT = 4;
const ROOT = 8;

function rotr(value, bits) {
    return ((value >>> bits) | (value << (32 - bits))) >>> 0;
}

function g(v, a, b, c, d, mx, my) {
    v[a] = (v[a] + v[b] + mx) >>> 0;
    v[d] = rotr(v[d] ^ v[a], 16);
    v[c] = (v[c] + v[d]) >>> 0;
    v[b] = rotr(v[b] ^ v[c], 12);
    v[a] = (v[a] + v[b] + my) >>> 0;
    v[d] = rotr(v[d] ^ v[a], 8);
    v[c] = (v[c] + v[d]) >>> 0;
    v[b] = rotr(v[b] ^ v[c], 7);
}

function compress(cv, blockWords, counter, blockLen, flags) {
    const v = new Uint32Array(16);
    v.set(cv, 0);
    v[8] = IV[0];
    v[9] = IV[1];
    v[10] = IV[2];
    v[11] = IV[3];
    v[12] = counter >>> 0;
    v[13] = Math.floor(counter / 0x100000000) >>> 0;
    v[14] = blockLen;
    v[15] = flags;

    let m = blockWords;
    for (let round = 0; round < 7; round++) {
        g(v, 0, 4, 8, 12, m[0], m[1]);
        g(v, 1, 5, 9, 13, m[2], m[3]);
        g(v, 2, 6, 10, 14, m[4], m[5]);
        g(v, 3, 7, 11, 15, m[6], m[7]);
        g(v, 0, 5, 10, 15, m[8], m[9]);
        g(v, 1, 6, 11, 12, m[10], m[11]);
        g(v, 2, 7, 8, 13, m[12], m[13]);
        g(v, 3, 4, 9, 14, m[14], m[15]);
        if (round < 6) {
            const permuted = new Uint32Array(16);
            for (let i = 0; i < 16; i++) permuted[i] = m[MSG_PERMUTATION[i]];
            m = permuted;
        }
    }

    const out = new Uint32Array(16);
    for (let i = 0; i < 8; i++) {
        out[i] = v[i] ^ v[i + 8];
        out[i + 8] = v[i + 8] ^ cv[i];
    }
    return out;
}

function chainValue(compressed) {
    return compressed.slice(0, 8);
}

function readBlockWords(bytes, start, blockLen) {
    const words = new Uint32Array(16);
    for (let i = 0; i < blockLen; i++) {
        words[i >>> 2] |= bytes[start + i] << ((i & 3) * 8);
    }
    return words;
}

/** The single block of a chunk left un-compressed, so ROOT can be applied later. */
function chunkOutput(bytes, start, chunkLen, counter) {
    const blockCount = chunkLen === 0 ? 1 : Math.ceil(chunkLen / BLOCK_LEN);
    let cv = IV;
    for (let block = 0; block < blockCount; block++) {
        const blockStart = start + block * BLOCK_LEN;
        const blockLen = Math.min(BLOCK_LEN, start + chunkLen - blockStart);
        const words = readBlockWords(bytes, blockStart, blockLen);
        const flags = (block === 0 ? CHUNK_START : 0) | (block === blockCount - 1 ? CHUNK_END : 0);
        if (block === blockCount - 1) {
            return { inputCV: cv, words, counter, blockLen, flags };
        }
        cv = chainValue(compress(cv, words, counter, blockLen, flags));
    }
    throw new Error('chunkOutput: no terminal block (unreachable)');
}

function outputChainValue(output) {
    return chainValue(compress(output.inputCV, output.words, output.counter, output.blockLen, output.flags));
}

function parentOutput(leftCV, rightCV) {
    const words = new Uint32Array(16);
    words.set(leftCV, 0);
    words.set(rightCV, 8);
    return { inputCV: IV, words, counter: 0, blockLen: BLOCK_LEN, flags: PARENT };
}

function outputDigest(output) {
    const root = compress(output.inputCV, output.words, output.counter, output.blockLen, output.flags | ROOT);
    const digest = new Uint8Array(OUT_LEN);
    for (let i = 0; i < OUT_LEN; i++) {
        digest[i] = (root[i >>> 2] >>> ((i & 3) * 8)) & 0xff;
    }
    return digest;
}

/** Raw 32-byte BLAKE3 digest of arbitrary bytes (single chunk or Merkle tree). */
function blake3Digest(bytes) {
    if (!(bytes instanceof Uint8Array)) {
        throw new TypeError(`blake3Digest: expected a Uint8Array (got ${typeof bytes})`);
    }
    const length = bytes.length;
    if (length <= CHUNK_LEN) {
        return outputDigest(chunkOutput(bytes, 0, length, 0));
    }

    const chunkCount = Math.ceil(length / CHUNK_LEN);
    const stack = [];
    for (let chunk = 0; chunk < chunkCount - 1; chunk++) {
        let cv = outputChainValue(chunkOutput(bytes, chunk * CHUNK_LEN, CHUNK_LEN, chunk));
        let completed = chunk + 1;
        while ((completed & 1) === 0) {
            cv = outputChainValue(parentOutput(stack.pop(), cv));
            completed >>>= 1;
        }
        stack.push(cv);
    }

    const lastStart = (chunkCount - 1) * CHUNK_LEN;
    let output = chunkOutput(bytes, lastStart, length - lastStart, chunkCount - 1);
    while (stack.length > 0) {
        output = parentOutput(stack.pop(), outputChainValue(output));
    }
    return outputDigest(output);
}

const HEX_DIGITS = '0123456789abcdef';

/** 64-character lowercase hex BLAKE3 digest. */
function blake3Hex(bytes) {
    const digest = blake3Digest(bytes);
    let out = '';
    for (let i = 0; i < digest.length; i++) {
        out += HEX_DIGITS[digest[i] >>> 4] + HEX_DIGITS[digest[i] & 0x0f];
    }
    return out;
}

const UTF8 = new TextEncoder();

function utf8(text) {
    return UTF8.encode(text);
}

function u64le(value, label) {
    if (!Number.isInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
        throw new TypeError(`${label}: expected a non-negative integer byte length (got ${value})`);
    }
    const out = new Uint8Array(8);
    const low = value % 0x100000000;
    const high = (value - low) / 0x100000000;
    for (let i = 0; i < 4; i++) {
        out[i] = (low >>> (8 * i)) & 0xff;
        out[4 + i] = (high >>> (8 * i)) & 0xff;
    }
    return out;
}

function u32le(value, label) {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
        throw new TypeError(`${label}: expected a u32 (got ${value})`);
    }
    const out = new Uint8Array(4);
    for (let i = 0; i < 4; i++) out[i] = (value >>> (8 * i)) & 0xff;
    return out;
}

/** `hash_field`: u64 LE label length, label, u64 LE value length, value. */
function hashFieldBytes(label, value) {
    const labelBytes = utf8(label);
    return [u64le(labelBytes.length, `hash_field(${label}) label`), labelBytes, u64le(value.length, `hash_field(${label}) value`), value];
}

function concat(parts) {
    let total = 0;
    for (const part of parts) total += part.length;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
}

function describe(value) {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    return typeof value;
}

function textField(doc, key) {
    const value = doc[key];
    if (value === undefined) return '';
    if (typeof value === 'string') return value;
    throw new TypeError(`V2Document.${key} must be a string, got ${describe(value)}`);
}

function requiredTextField(doc, key) {
    const value = doc[key];
    if (typeof value === 'string') return value;
    throw new TypeError(`V2Document.${key} is required and must be a string, got ${describe(value)}`);
}

function optionalTextField(doc, key) {
    const value = doc[key];
    if (value === undefined || value === null) return null;
    if (typeof value === 'string') return value;
    throw new TypeError(`V2Document.${key} must be a string or null, got ${describe(value)}`);
}

function stringListField(doc, key) {
    const value = doc[key];
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
        throw new TypeError(`V2Document.${key} must be an array of strings, got ${describe(value)}`);
    }
    for (const item of value) {
        if (typeof item !== 'string') {
            throw new TypeError(`V2Document.${key} must contain only strings, got ${describe(item)}`);
        }
    }
    return value;
}

/**
 * `V2Document::indexable_text` — deterministic concatenation of every searchable
 * field. `title`, `name`, `path` and `headings` are each followed by `\n`,
 * `categories` and `tags` are space-joined and followed by `\n`, `body` follows
 * verbatim with no trailing separator.
 */
function indexableText(doc) {
    if (doc === null || typeof doc !== 'object') {
        throw new TypeError(`indexableText: expected a V2Document object (got ${describe(doc)})`);
    }
    let text = '';
    for (const key of ['title', 'name', 'path', 'headings']) {
        text += textField(doc, key) + '\n';
    }
    text += stringListField(doc, 'categories').join(' ') + '\n';
    text += stringListField(doc, 'tags').join(' ') + '\n';
    text += textField(doc, 'body');
    return text;
}

/** UTF-8 code-point order — Rust compares `&str` bytewise, which UTF-8 keeps in code-point order. */
function compareCodePoints(a, b) {
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
        const ca = a.codePointAt(i);
        const cb = b.codePointAt(j);
        if (ca !== cb) return ca < cb ? -1 : 1;
        i += ca > 0xffff ? 2 : 1;
        j += cb > 0xffff ? 2 : 1;
    }
    return (a.length - i) - (b.length - j);
}

// serde_json keeps a number as i64/u64 while the digits that reach it fit
// one; beyond that it parses f64 and prints back through ryu.
const I64_MIN = -(2n ** 63n);
const U64_LIMIT = 2n ** 64n;

function formatJsonNumber(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new TypeError(`canonical JSON: non-finite number ${String(value)}`);
    }
    if (Number.isInteger(value)) {
        const text = String(value);
        if (!text.includes('e')) {
            const digits = BigInt(text);
            if (digits >= I64_MIN && digits < U64_LIMIT) return text;
        }
    }
    const exponential = value.toExponential();
    const match = /^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(exponential);
    if (match === null) {
        throw new Error(`canonical JSON: cannot format ${exponential} (unreachable)`);
    }
    const sign = match[1];
    const digits = match[2] + (match[3] ?? '');
    const exponent = Number(match[4]);
    const pointPosition = exponent + 1;

    // ryu's pretty form: plain decimal notation while the point sits inside
    // (-5, 16], exponential (with an explicit '+') outside it.
    if (pointPosition > -5 && pointPosition <= 16) {
        if (pointPosition <= 0) {
            return `${sign}0.${'0'.repeat(-pointPosition)}${digits}`;
        }
        if (pointPosition >= digits.length) {
            return `${sign}${digits}${'0'.repeat(pointPosition - digits.length)}.0`;
        }
        return `${sign}${digits.slice(0, pointPosition)}.${digits.slice(pointPosition)}`;
    }
    const mantissa = digits.length === 1 ? digits : `${digits[0]}.${digits.slice(1)}`;
    return `${sign}${mantissa}e${exponent < 0 ? `-${-exponent}` : `+${exponent}`}`;
}

function writeJsonString(text, out) {
    out.push('"');
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        switch (code) {
            case 0x22:
                out.push('\\"');
                break;
            case 0x5c:
                out.push('\\\\');
                break;
            case 0x0a:
                out.push('\\n');
                break;
            case 0x0d:
                out.push('\\r');
                break;
            case 0x09:
                out.push('\\t');
                break;
            case 0x08:
                out.push('\\b');
                break;
            case 0x0c:
                out.push('\\f');
                break;
            default:
                if (code < 0x20) {
                    out.push(`\\u${code.toString(16).padStart(4, '0')}`);
                } else {
                    out.push(text[i]);
                }
        }
    }
    out.push('"');
}

function writeCanonical(value, out) {
    if (value === null) {
        out.push('null');
        return;
    }
    switch (typeof value) {
        case 'boolean':
            out.push(value ? 'true' : 'false');
            return;
        case 'number':
            out.push(formatJsonNumber(value));
            return;
        case 'string':
            writeJsonString(value, out);
            return;
        case 'object':
            if (Array.isArray(value)) {
                out.push('[');
                for (let i = 0; i < value.length; i++) {
                    if (i > 0) out.push(',');
                    writeCanonical(value[i], out);
                }
                out.push(']');
                return;
            }
            {
                const keys = Object.keys(value).sort(compareCodePoints);
                out.push('{');
                for (let i = 0; i < keys.length; i++) {
                    if (i > 0) out.push(',');
                    writeJsonString(keys[i], out);
                    out.push(':');
                    writeCanonical(value[keys[i]], out);
                }
                out.push('}');
                return;
            }
        default:
            throw new TypeError(`canonical JSON: unsupported value of type ${typeof value}`);
    }
}

/** `write_canonical_json` — sorted object keys, ryu number rendering, no whitespace. */
function canonicalJson(value) {
    const out = [];
    writeCanonical(value, out);
    return out.join('');
}

/** `compute_content_hash` — BLAKE3 over the domain tag plus the indexable text. */
function computeContentHash(indexableTextValue) {
    if (typeof indexableTextValue !== 'string') {
        throw new TypeError(`computeContentHash: expected a string (got ${describe(indexableTextValue)})`);
    }
    return blake3Hex(concat([
        ...hashFieldBytes('domain', utf8('nvdb.content.v1')),
        ...hashFieldBytes('text', utf8(indexableTextValue)),
    ]));
}

function envelopeHashFrom(doc, contentHash, schemaVersion, analyzerVersion) {
    const id = requiredTextField(doc, 'id');
    const kind = requiredTextField(doc, 'kind');
    const parentId = optionalTextField(doc, 'parent_id');
    const chunkIndex = doc.chunk_index ?? null;
    const chunkIndexBytes = chunkIndex === null ? null : u32le(chunkIndex, 'V2Document.chunk_index');
    const metadata = doc.metadata === undefined ? {} : doc.metadata;

    const acl = stringListField(doc, 'acl').slice().sort(compareCodePoints);
    let unique = 0;
    for (let i = 0; i < acl.length; i++) {
        if (i === 0 || acl[i] !== acl[i - 1]) acl[unique++] = acl[i];
    }
    acl.length = unique;

    const parts = [
        ...hashFieldBytes('domain', utf8('nvdb.envelope.v1')),
        ...hashFieldBytes('id', utf8(id)),
    ];
    if (parentId === null) {
        parts.push(...hashFieldBytes('parent_id.present', utf8('0')));
    } else {
        parts.push(...hashFieldBytes('parent_id.present', utf8('1')));
        parts.push(...hashFieldBytes('parent_id', utf8(parentId)));
    }
    parts.push(...hashFieldBytes('chunk_index.present', utf8(chunkIndex === null ? '0' : '1')));
    if (chunkIndexBytes !== null) {
        parts.push(...hashFieldBytes('chunk_index', chunkIndexBytes));
    }
    parts.push(...hashFieldBytes('kind', utf8(kind)));
    parts.push(...hashFieldBytes('content_hash', utf8(contentHash)));
    parts.push(...hashFieldBytes('acl.len', u64le(acl.length, 'acl length')));
    for (const group of acl) {
        parts.push(...hashFieldBytes('acl', utf8(group)));
    }
    parts.push(...hashFieldBytes('metadata', utf8(canonicalJson(metadata))));
    parts.push(...hashFieldBytes('schema_version', u32le(schemaVersion, 'schema version')));
    parts.push(...hashFieldBytes('analyzer_version', u32le(analyzerVersion, 'analyzer version')));

    return blake3Hex(concat(parts));
}

/** `compute_envelope_hash` — BLAKE3 over the canonicalised full envelope. */
function computeEnvelopeHash(doc, schemaVersion = CURRENT_SCHEMA_VERSION, analyzerVersion = CURRENT_ANALYZER_VERSION) {
    if (doc === null || typeof doc !== 'object') {
        throw new TypeError(`computeEnvelopeHash: expected a V2Document object (got ${describe(doc)})`);
    }
    const indexable = indexableText(doc);
    const contentHash = computeContentHash(indexable);
    return envelopeHashFrom(doc, contentHash, schemaVersion, analyzerVersion);
}

/** Both hashes a v2 source record carries. */
function documentHashes(doc, schemaVersion = CURRENT_SCHEMA_VERSION, analyzerVersion = CURRENT_ANALYZER_VERSION) {
    if (doc === null || typeof doc !== 'object') {
        throw new TypeError(`documentHashes: expected a V2Document object (got ${describe(doc)})`);
    }
    const indexable = indexableText(doc);
    const contentHash = computeContentHash(indexable);
    return {
        content_hash: contentHash,
        envelope_hash: envelopeHashFrom(doc, contentHash, schemaVersion, analyzerVersion),
    };
}

module.exports = {
    blake3Digest,
    blake3Hex,
    indexableText,
    canonicalJson,
    computeContentHash,
    computeEnvelopeHash,
    documentHashes,
    SCHEMA_VERSION: CURRENT_SCHEMA_VERSION,
    ANALYZER_VERSION: CURRENT_ANALYZER_VERSION,
};
