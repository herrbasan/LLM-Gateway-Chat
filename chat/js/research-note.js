// ============================================
// Research-note (knowledge-base) link helpers — pure functions for the
// preview pane. Zero DOM, zero state. Imported by preview.js; unit-testable
// in Node.
// ============================================
//
// The blog's convention (raum.com): a link whose destination is a `.md` source
// inside a `references/` directory is a research note — the extended-reading
// companion the article cites. The site build bakes one <dialog> per cited
// note into the page. A preview has no build, so it detects the same links in
// the rendered markdown and resolves them at click time.
//
// Post→note links are written `../references/x.md`; a note citing a neighbour
// writes it bare (`x.md`, same folder). Detection therefore runs on the
// RESOLVED path, never on the authored text alone.

const NOTE_PATH = /\/references\/[^/?#]+\.md(?:$|[?#])/i;
const NOTE_TAIL = /(?:^|\/)references\/([^/?#]+\.md)(?:$|[?#])/i;
const NON_HTTP_SCHEME = /^(?:mailto|tel|data|javascript|blob):/i;
const ABSOLUTE = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Resolve a link destination found in rendered markdown to an absolute url.
 *
 * Returns null for everything that must keep native behavior: in-page anchors,
 * non-http schemes, and relative paths in a document with no base — a document
 * rendered from `content` has no location, so its relative paths cannot be
 * resolved (issue #38).
 *
 * @param {string} href - the destination as authored
 * @param {string|null} base - the document's absolute url, or null
 * @param {() => string|null} [getMcpOrigin] - MCP storage origin for /-rooted paths
 * @returns {string|null} absolute url, or null when unresolvable/native
 */
export function resolveContentHref(href, base, getMcpOrigin) {
    if (typeof href !== 'string') return null;
    const raw = href.trim();
    if (!raw || raw.startsWith('#') || NON_HTTP_SCHEME.test(raw)) return null;
    if (ABSOLUTE.test(raw)) {
        if (!/^https?:/i.test(raw)) return null;
        try {
            return new URL(raw).href;
        } catch (err) {
            return null;
        }
    }
    if (base) {
        try {
            return new URL(raw, base).href;
        } catch (err) {
            return null;
        }
    }
    if (raw.startsWith('/')) {
        const origin = typeof getMcpOrigin === 'function' ? getMcpOrigin() : null;
        return origin ? origin.replace(/\/+$/, '') + raw : null;
    }
    return null;
}

/**
 * The research-note url a link points at, or null when it is an ordinary link.
 *
 * Without a document base the corpus location is assumed: storage keeps every
 * note in blog/references/, and a locationless document's note link carries
 * nothing but that tail. The caller traces the assumption — this tolerance is
 * a guess about where the document lives, and it must stay visible.
 *
 * @param {string} href - the destination as authored
 * @param {string|null} base - the document's absolute url, or null
 * @param {() => string|null} [getMcpOrigin]
 * @returns {string|null} absolute url of the note source, or null
 */
export function noteUrlFromHref(href, base, getMcpOrigin) {
    if (typeof href !== 'string') return null;
    const resolved = resolveContentHref(href, base, getMcpOrigin);
    if (resolved) {
        const path = pathOf(resolved);
        return path && NOTE_PATH.test(path) ? resolved : null;
    }
    const tail = href.match(NOTE_TAIL);
    if (!tail) return null;
    const origin = typeof getMcpOrigin === 'function' ? getMcpOrigin() : null;
    return origin ? `${origin.replace(/\/+$/, '')}/storage/blog/references/${tail[1]}` : null;
}

/**
 * Split a note source into the dialog title and the body to render.
 *
 * Notes carry YAML frontmatter with `title` and open with a matching H1. The
 * dialog header already states the title, so the H1 is dropped rather than
 * repeated as the first line of the panel.
 *
 * @param {string} text - note source (frontmatter + markdown)
 * @returns {{title: string|null, body: string}}
 */
export function splitNoteSource(text) {
    if (typeof text !== 'string') throw new Error('splitNoteSource: note source required');
    let body = text;
    let title = null;

    const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
    if (frontmatter) {
        body = text.slice(frontmatter[0].length);
        const line = frontmatter[1].match(/^title:[ \t]*(.+?)[ \t]*$/m);
        if (line) title = unquote(line[1]);
    }

    const first = body.search(/\S/);
    if (first >= 0) {
        const heading = body.slice(first).match(/^#[ \t]+([^\n]+?)[ \t]*(?:\r?\n|$)/);
        if (heading) {
            if (!title) title = heading[1].trim();
            body = body.slice(first + heading[0].length);
        }
    }

    return { title: title || null, body: body.trimStart() };
}

function pathOf(url) {
    try {
        return new URL(url).pathname;
    } catch (err) {
        return null;
    }
}

function unquote(value) {
    const trimmed = value.trim();
    const quoted = (trimmed.startsWith('"') && trimmed.endsWith('"'))
        || (trimmed.startsWith("'") && trimmed.endsWith("'"));
    return quoted ? trimmed.slice(1, -1) : trimmed;
}
