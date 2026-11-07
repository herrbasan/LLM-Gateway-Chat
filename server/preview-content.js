// Preview URL mode is a text surface. Validate the upstream declaration AND
// the bytes: a mislabeled PDF must not become replacement-character soup merely
// because a storage server called it text/plain (#57).

const TEXT_MIME_TYPES = new Set([
    'application/json',
    'application/ld+json',
    'application/xml',
    'application/javascript',
    'application/x-javascript',
    'application/typescript',
    'application/yaml',
    'application/x-yaml',
    'application/toml',
    'application/sql',
    'application/x-sh',
    'image/svg+xml'
]);

const BINARY_SIGNATURES = [
    ['PDF', [0x25, 0x50, 0x44, 0x46, 0x2d]],
    ['PNG', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
    ['JPEG', [0xff, 0xd8, 0xff]],
    ['GIF', [0x47, 0x49, 0x46, 0x38]],
    ['ZIP', [0x50, 0x4b, 0x03, 0x04]],
    ['gzip', [0x1f, 0x8b]],
    ['RIFF', [0x52, 0x49, 0x46, 0x46]],
    ['OLE compound document', [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]],
    ['ELF', [0x7f, 0x45, 0x4c, 0x46]]
];

function mediaType(contentType) {
    return typeof contentType === 'string'
        ? contentType.split(';', 1)[0].trim().toLowerCase()
        : '';
}

function isTextMediaType(contentType) {
    const mime = mediaType(contentType);
    if (!mime) return true;
    return mime.startsWith('text/')
        || TEXT_MIME_TYPES.has(mime)
        || mime.endsWith('+json')
        || mime.endsWith('+xml')
        || mime.endsWith('+yaml');
}

function detectBinaryKind(value) {
    const bytes = Buffer.from(value);
    for (const [kind, signature] of BINARY_SIGNATURES) {
        if (bytes.length >= signature.length && signature.every((byte, i) => bytes[i] === byte)) return kind;
    }
    const probeLength = Math.min(bytes.length, 4096);
    for (let i = 0; i < probeLength; i++) {
        if (bytes[i] === 0) return 'NUL-byte binary';
    }
    return null;
}

function unsupported(detail) {
    const err = new Error(`preview URL mode supports text, Markdown, and code only; ${detail}. For rendered documents use raster page previews (PNG), or pass textual content in content mode`);
    err.statusCode = 415;
    return err;
}

function decodePreviewText(value, contentType) {
    const mime = mediaType(contentType);
    if (!isTextMediaType(mime)) throw unsupported(`received "${mime}"`);

    const bytes = Buffer.from(value);
    const binaryKind = detectBinaryKind(bytes);
    if (binaryKind) throw unsupported(`received ${binaryKind} data${mime ? ` declared as "${mime}"` : ''}`);

    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
        throw unsupported('the response is not valid UTF-8 text');
    }
}

async function preflightPreviewUrl(raw, mcpOrigin) {
    let target;
    if (/^https?:\/\//i.test(raw)) {
        target = raw;
    } else if (raw.startsWith('/') && mcpOrigin) {
        target = mcpOrigin.replace(/\/+$/, '') + raw;
    } else if (raw.startsWith('/')) {
        throw new Error(`chat_preview_show: cannot resolve relative URL "${raw}" — no MCP storage origin configured`);
    } else {
        throw new Error(`chat_preview_show: unsupported URL "${raw}" — must start with http(s):// or /`);
    }

    const upstream = await fetch(target, { signal: AbortSignal.timeout(10000) });
    if (!upstream.ok) {
        const err = new Error(`chat_preview_show: upstream ${upstream.status} for ${target}`);
        err.statusCode = 502;
        if (upstream.body) await upstream.body.cancel();
        throw err;
    }
    if (!isTextMediaType(upstream.headers.get('content-type'))) {
        const err = unsupported(`received "${mediaType(upstream.headers.get('content-type'))}"`);
        if (upstream.body) await upstream.body.cancel();
        throw err;
    }
    if (upstream.body) await upstream.body.cancel();
}

module.exports = { decodePreviewText, detectBinaryKind, isTextMediaType, preflightPreviewUrl };
