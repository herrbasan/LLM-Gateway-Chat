// ============================================
// Preview file types — ONE explicit type table
// ============================================
//
// Every renderer decision in the preview surface reads this table: the storage
// file tree, preview.show in both modes, and the Content-Type fallback. A second
// extension map anywhere would let one path render a format the other cannot
// classify — the failure mode is decoding binary bytes as UTF-8 text and
// painting replacement characters on the reading surface.
//
// Pure data + pure functions: no DOM, so Node unit tests import it directly.

export const KIND_MEDIA = new Set(['image', 'svg', 'audio', 'video']);
export const KIND_BINARY = new Set(['image', 'svg', 'audio', 'video', 'docx', 'pdf']);

const EXTENSION_TABLE = {
    markdown: ['md', 'markdown', 'mdown', 'mkd'],
    code: [
        'js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx',
        'json', 'jsonc', 'json5', 'css', 'scss', 'less', 'xml', 'xsl', 'xsd',
        'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'env',
        'py', 'rs', 'go', 'java', 'kt', 'kts', 'c', 'h', 'cpp', 'cc', 'cxx', 'hpp', 'cs',
        'rb', 'php', 'lua', 'swift', 'dart', 'r', 'pl', 'sql',
        'sh', 'bash', 'zsh', 'ps1', 'psm1', 'bat', 'cmd',
        'log', 'txt', 'diff', 'patch', 'graphql', 'gql'
    ],
    image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico'],
    svg: ['svg'],
    audio: ['mp3', 'm4a', 'wav', 'ogg', 'oga', 'flac', 'opus', 'aac'],
    video: ['mp4', 'webm', 'mov', 'm4v', 'ogv'],
    docx: ['docx'],
    html: ['html', 'htm'],
    pdf: ['pdf']
};

const CODE_LANGUAGES = {
    js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx',
    ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'tsx',
    json: 'json', jsonc: 'json', json5: 'json',
    css: 'css', scss: 'scss', less: 'less',
    xml: 'xml', xsl: 'xml', xsd: 'xml',
    yml: 'yaml', yaml: 'yaml', toml: 'toml', ini: 'ini',
    cfg: 'ini', conf: 'ini', env: 'ini',
    py: 'python', rs: 'rust', go: 'go', java: 'java', kt: 'kotlin', kts: 'kotlin',
    c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', cs: 'csharp',
    rb: 'ruby', php: 'php', lua: 'lua', swift: 'swift', dart: 'dart', r: 'r', pl: 'perl',
    sql: 'sql', sh: 'bash', bash: 'bash', zsh: 'bash', ps1: 'powershell', psm1: 'powershell',
    bat: 'batch', cmd: 'batch', log: 'text', txt: 'text',
    diff: 'diff', patch: 'diff', graphql: 'graphql', gql: 'graphql'
};

const EXT_KIND = new Map();
for (const [kind, extensions] of Object.entries(EXTENSION_TABLE)) {
    for (const ext of extensions) EXT_KIND.set(ext, kind);
}

const MIME_KIND = {
    'text/markdown': 'markdown',
    'text/x-markdown': 'markdown',
    'text/html': 'html',
    'application/xhtml+xml': 'html',
    'image/svg+xml': 'svg',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/pdf': 'pdf',
    'application/json': 'code',
    'application/ld+json': 'code',
    'application/xml': 'code',
    'text/xml': 'code',
    'application/javascript': 'code',
    'application/x-javascript': 'code',
    'application/typescript': 'code',
    'application/yaml': 'code',
    'application/x-yaml': 'code',
    'application/toml': 'code',
    'application/sql': 'code',
    'application/x-sh': 'code',
    'application/x-httpd-php': 'code'
};

function mediaType(mime) {
    return typeof mime === 'string' ? mime.split(';', 1)[0].trim().toLowerCase() : '';
}

/**
 * Lowercased extension of a name or url, ignoring query string and fragment.
 * @param {string} nameOrUrl
 * @returns {string|null}
 */
export function extensionOf(nameOrUrl) {
    if (typeof nameOrUrl !== 'string' || !nameOrUrl) return null;
    const path = nameOrUrl.split('#')[0].split('?')[0];
    const match = /\.([A-Za-z0-9]+)$/.exec(path);
    return match ? match[1].toLowerCase() : null;
}

/**
 * Code language for a name/url, or null when the file is not code. Markdown and
 * HTML extensions report their own language name so a caller that only has a
 * language (content mode without a kind) still picks the right renderer.
 * @param {string} nameOrUrl
 * @returns {string|null}
 */
export function languageFromName(nameOrUrl) {
    const ext = extensionOf(nameOrUrl);
    if (!ext) return null;
    const kind = EXT_KIND.get(ext);
    if (kind === 'markdown') return 'markdown';
    if (kind === 'html') return 'html';
    if (kind !== 'code') return null;
    return CODE_LANGUAGES[ext] || 'text';
}

/**
 * Classify a name or url by extension.
 * @param {string} nameOrUrl
 * @returns {{kind: string, language?: string}|null} null for an unknown type —
 *          the caller decides between a Content-Type probe and a readable
 *          unsupported-format error.
 */
export function kindFromName(nameOrUrl) {
    const ext = extensionOf(nameOrUrl);
    if (!ext) return null;
    const kind = EXT_KIND.get(ext);
    if (!kind) return null;
    return kind === 'code' ? { kind, language: CODE_LANGUAGES[ext] || 'text' } : { kind };
}

/**
 * Classify by response Content-Type.
 * @param {string} mime
 * @returns {string|null}
 */
export function kindFromMime(mime) {
    const media = mediaType(mime);
    if (!media) return null;
    const mapped = MIME_KIND[media];
    if (mapped) return mapped;
    if (media.startsWith('image/')) return 'image';
    if (media.startsWith('audio/')) return 'audio';
    if (media.startsWith('video/')) return 'video';
    if (media.startsWith('text/')) return 'code';
    if (media.endsWith('+json') || media.endsWith('+xml') || media.endsWith('+yaml')) return 'code';
    return null;
}
