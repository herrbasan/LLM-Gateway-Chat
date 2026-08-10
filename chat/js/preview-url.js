// ============================================
// Preview URL helpers — pure functions for the
// chat_preview_show url mode. Zero DOM, zero state.
// Imported by preview.js; unit-testable in Node.
// ============================================

/**
 * Resolve a preview url to an absolute fetchable url.
 * - http(s)://... → as-is (full URL)
 * - /... (relative storage pointer) → prepend the MCP server origin
 * - anything else → throw
 *
 * @param {string} url - the url the model passed
 * @param {() => string|null} [getMcpOrigin] - returns the MCP server origin or null
 * @returns {string} absolute fetchable url
 */
export function resolvePreviewUrl(url, getMcpOrigin) {
    if (typeof url !== 'string' || url.length === 0) throw new Error('preview: url must be a non-empty string');
    if (/^https?:\/\//i.test(url)) return url;
    if (url.startsWith('/')) {
        const origin = typeof getMcpOrigin === 'function' ? getMcpOrigin() : null;
        if (!origin) {
            throw new Error(`preview: cannot resolve relative url "${url}" — no MCP server origin configured. Pass an absolute http(s) url instead.`);
        }
        return origin + url;
    }
    throw new Error(`preview: unsupported url "${url}" — must start with http(s):// or /`);
}

const EXT_LANGUAGE = {
    md: 'markdown', markdown: 'markdown',
    js: 'javascript', mjs: 'javascript', cjs: 'javascript',
    ts: 'typescript', tsx: 'typescript',
    json: 'json',
    html: 'html', htm: 'html',
    css: 'css',
    py: 'python',
    txt: 'text', log: 'text'
};

/**
 * Infer the preview language from a file url's extension. Falls back to 'text'.
 * @param {string} url
 * @returns {string}
 */
export function inferLanguageFromUrl(url) {
    const path = url.split(/[?#]/)[0];
    const ext = (path.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase();
    return EXT_LANGUAGE[ext] || 'text';
}

/**
 * Derive a stable preview id from a url — 'file:' + last path segment.
 * @param {string} url
 * @returns {string}
 */
export function deriveIdFromUrl(url) {
    const path = url.split(/[?#]/)[0].replace(/\/+$/, '');
    const last = path.split('/').pop();
    return 'file:' + (last || path);
}

/**
 * Derive a dropdown title from a url — its basename.
 * @param {string} url
 * @returns {string}
 */
export function deriveTitleFromUrl(url) {
    const path = url.split(/[?#]/)[0].replace(/\/+$/, '');
    return path.split('/').pop() || path;
}
