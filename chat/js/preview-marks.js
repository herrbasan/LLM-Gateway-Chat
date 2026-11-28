// ============================================
// Preview passage marks — pure helpers + DOM range utilities
// ============================================
//
// A mark identifies a passage by its NORMALIZED text (whitespace collapsed),
// never by DOM offsets: the preview re-renders from scratch on every update
// (nui-markdown's _processed guard forbids element reuse), so offsets are
// stale the moment anything changes while the text itself survives.
// `occurrence` disambiguates a quote that appears more than once.
//
// Range.surroundContents() is deliberately never used: it throws whenever the
// range crosses an element boundary (a selection spanning <strong>, <code> or
// <a> is the normal case), so every intersecting text node is split and
// wrapped on its own.

export const MAX_MARKS = 20;
export const MAX_QUOTE_CHARS = 4000;
export const MAX_HEADING_CHARS = 300;
export const MAX_NOTE_CHARS = 1000;

const SKIP_SELECTOR = '.nui-narration-control, script, style, button, .preview-selection-toolbar, [aria-hidden="true"]';
const BLOCK_TAGS = new Set([
    'P', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE', 'TR',
    'DIV', 'SECTION', 'ARTICLE', 'ASIDE', 'FIGCAPTION', 'DT', 'DD'
]);
const MARK_CLASS = 'preview-passage-mark';

// NodeFilter constants as numbers: this module is imported by Node tests, where
// the DOM globals do not exist.
const SHOW_TEXT = 4;
const FILTER_ACCEPT = 1;
const FILTER_REJECT = 2;

export function normalizeWhitespace(str) {
    return (typeof str === 'string' ? str : '').replace(/\s+/g, ' ').trim();
}

/**
 * Flatten every visible text node under `root` into one whitespace-normalized
 * string plus a per-character map back to `{ node, offset }`.
 *
 * The character map is what makes multi-node selections exact: a normalized
 * offset resolves to the real text node and offset even when the selection
 * crosses <strong>, <code>, <a>, <p> and <li> boundaries.
 *
 * @returns {{ fullNorm: string, charMap: Array<{node: Text, offset: number}> }}
 */
export function collectTextEntries(root) {
    if (!root || !root.ownerDocument) throw new Error('collectTextEntries: root element required');
    const walker = root.ownerDocument.createTreeWalker(root, SHOW_TEXT, {
        acceptNode(node) {
            if (!node.nodeValue) return FILTER_REJECT;
            const parent = node.parentElement;
            if (parent && parent.closest(SKIP_SELECTOR)) return FILTER_REJECT;
            return FILTER_ACCEPT;
        }
    });

    const charMap = [];
    let fullNorm = '';
    let pendingSpace = false;
    let node = walker.nextNode();
    while (node) {
        const value = node.nodeValue;
        for (let i = 0; i < value.length; i++) {
            const ch = value[i];
            if (/\s/.test(ch)) {
                pendingSpace = true;
                continue;
            }
            if (pendingSpace && fullNorm.length > 0) {
                fullNorm += ' ';
                charMap.push({ node, offset: Math.max(0, i - 1) });
            }
            pendingSpace = false;
            fullNorm += ch;
            charMap.push({ node, offset: i });
        }
        node = walker.nextNode();
    }
    return { fullNorm, charMap };
}

/**
 * Plain TTS-ready text for a selection. Block elements contribute a line break
 * at their boundaries, <br> is a line break, and controls/code fences that are
 * never read aloud are skipped.
 *
 * @param {Range} range
 * @param {Element} root
 * @param {{toEnd?: boolean}} [options] toEnd reads from the range start to the
 *        end of `root` (the "speak from here" gesture).
 */
export function extractBlockText(range, root, { toEnd = false } = {}) {
    if (!range) throw new Error('extractBlockText: range required');
    if (!root || !root.ownerDocument) throw new Error('extractBlockText: root element required');
    const working = range.cloneRange();
    if (toEnd) working.setEnd(root, root.childNodes.length);
    const fragment = working.cloneContents();
    const parts = [];
    collectFragmentText(fragment, parts);
    return cleanBlockText(parts.join(''));
}

function collectFragmentText(node, out) {
    if (node.nodeType === 3) {
        out.push(node.nodeValue);
        return;
    }
    if (node.nodeType === 1) {
        if (node.tagName === 'BR') {
            out.push('\n');
            return;
        }
        if (node.matches(SKIP_SELECTOR)) return;
        const block = BLOCK_TAGS.has(node.tagName);
        if (block) out.push('\n');
        for (const child of node.childNodes) collectFragmentText(child, out);
        if (block) out.push('\n');
        return;
    }
    for (const child of node.childNodes || []) collectFragmentText(child, out);
}

function cleanBlockText(raw) {
    return raw
        .replace(/\u00a0/g, ' ')
        .replace(/[ \t]+/g, ' ')
        .split('\n')
        .map(line => line.trim())
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/**
 * Nearest heading above a node: previous siblings first (a heading inside a
 * preceding section wrapper counts too), then the ancestors' previous siblings.
 * Returns '' when the passage sits under no heading.
 */
export function findNearestHeading(node, root) {
    if (!node || !root) return '';
    let current = node.nodeType === 1 ? node : node.parentElement;
    while (current && current !== root && root.contains(current)) {
        let sibling = current.previousElementSibling;
        while (sibling) {
            const heading = headingWithin(sibling);
            if (heading) return normalizeWhitespace(heading.textContent).slice(0, MAX_HEADING_CHARS);
            sibling = sibling.previousElementSibling;
        }
        current = current.parentElement;
    }
    return '';
}

function headingWithin(element) {
    if (/^H[1-6]$/.test(element.tagName)) return element;
    const headings = element.querySelectorAll('h1, h2, h3, h4, h5, h6');
    return headings.length ? headings[headings.length - 1] : null;
}

/**
 * Build a mark from a live selection. Quote and heading are captured as text,
 * so the mark survives a re-render; `occurrence` points at the right repeat of
 * a duplicated quote.
 *
 * @returns {{mark: Object}|{error: string}}
 */
export function captureMarkFromRange(range, root) {
    if (!range || range.collapsed) return { error: 'Select some text first.' };
    const quote = normalizeWhitespace(extractBlockText(range, root));
    if (!quote) return { error: 'That selection has no readable text.' };
    if (quote.length > MAX_QUOTE_CHARS) {
        return {
            error: `That selection is ${quote.length} characters; a mark holds at most ${MAX_QUOTE_CHARS}. Select a smaller passage.`
        };
    }
    const { fullNorm } = collectTextEntries(root);
    if (!fullNorm.includes(quote)) {
        return { error: 'That passage could not be located in the document text. Try selecting a smaller range.' };
    }
    const occurrence = occurrenceNearest(fullNorm, quote, normalizedPrefixLength(root, range));
    return {
        mark: {
            id: 'mark_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
            quote,
            occurrence,
            heading: findNearestHeading(range.startContainer, root),
            note: ''
        }
    };
}

// Collapsed-whitespace length of everything before the selection start — an
// approximate index into fullNorm, only used to pick the nearest occurrence.
function normalizedPrefixLength(root, range) {
    const prefix = root.ownerDocument.createRange();
    prefix.setStart(root, 0);
    try {
        prefix.setEnd(range.startContainer, range.startOffset);
    } catch {
        return 0;
    }
    return prefix.toString().replace(/\s+/g, ' ').length;
}

function occurrenceNearest(fullNorm, quote, approxIndex) {
    let occurrence = 0;
    let best = 0;
    let bestDistance = Infinity;
    let index = fullNorm.indexOf(quote);
    while (index !== -1) {
        const distance = Math.abs(index - approxIndex);
        if (distance < bestDistance) {
            bestDistance = distance;
            best = occurrence;
        }
        occurrence++;
        index = fullNorm.indexOf(quote, index + 1);
    }
    return best;
}

/**
 * Index of the `occurrence`-th match of `quote`, falling back to the first
 * match when the document holds fewer repeats than the mark recorded, and -1
 * when the quote is gone entirely (a passage the model already revised).
 *
 * @returns {number}
 */
export function findQuoteSpan(fullNorm, quote, occurrence = 0) {
    if (typeof fullNorm !== 'string' || typeof quote !== 'string' || !quote) return -1;
    let index = -1;
    for (let i = 0; i <= Math.max(0, occurrence); i++) {
        index = fullNorm.indexOf(quote, index + 1);
        if (index === -1) break;
    }
    return index === -1 ? fullNorm.indexOf(quote) : index;
}

/**
 * Unwrap every passage mark, then normalize the parents so the split text
 * nodes merge back together (a re-highlight of the same passage must not walk
 * a growing pile of one-character nodes).
 */
export function clearMarksFromDom(root) {
    if (!root) return;
    const parents = new Set();
    for (const mark of root.querySelectorAll('mark.' + MARK_CLASS)) {
        const parent = mark.parentNode;
        if (!parent) continue;
        while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
        mark.remove();
        parents.add(parent);
    }
    for (const parent of parents) parent.normalize();
}

/**
 * Re-apply the item's marks to freshly rendered markdown.
 *
 * @returns {{resolvedIds: Set<string>, unresolvedIds: Set<string>}} which marks
 *          found their passage in the current text.
 */
export function applyMarksToDom(root, marks) {
    clearMarksFromDom(root);
    const resolvedIds = new Set();
    const unresolvedIds = new Set();
    const list = Array.isArray(marks) ? marks : [];
    if (!list.length || !root) return { resolvedIds, unresolvedIds };

    const { fullNorm } = collectTextEntries(root);
    const spans = [];
    for (const mark of list) {
        const start = findQuoteSpan(fullNorm, mark.quote, mark.occurrence || 0);
        if (start === -1) {
            unresolvedIds.add(mark.id);
            continue;
        }
        spans.push({ id: mark.id, start, end: start + mark.quote.length });
        resolvedIds.add(mark.id);
    }
    // Each span resolves against a freshly collected map: wrapping replaces
    // text nodes, so offsets from the first pass no longer describe the DOM.
    for (const span of spans) wrapSpan(root, span);
    return { resolvedIds, unresolvedIds };
}

function wrapSpan(root, span) {
    const { charMap } = collectTextEntries(root);
    if (!charMap.length) return;
    const end = Math.min(span.end, charMap.length);
    const segments = [];
    let i = span.start;
    while (i < end) {
        const entry = charMap[i];
        const node = entry.node;
        let startOffset = entry.offset;
        let endOffset = startOffset + 1;
        let j = i + 1;
        while (j < end && charMap[j].node === node) {
            const gap = node.nodeValue.slice(endOffset, charMap[j].offset);
            if (!/^\s*$/.test(gap)) break;
            endOffset = charMap[j].offset + 1;
            j++;
        }
        segments.push({ node, startOffset, endOffset });
        i = j;
    }
    // Backwards, so an earlier split inside the same node keeps its offsets.
    for (let k = segments.length - 1; k >= 0; k--) wrapTextSegment(segments[k], span.id);
}

function wrapTextSegment({ node, startOffset, endOffset }, markId) {
    const doc = node.ownerDocument;
    let target = node;
    if (startOffset > 0) target = target.splitText(startOffset);
    const length = endOffset - startOffset;
    if (length < target.nodeValue.length) target.splitText(length);
    const mark = doc.createElement('mark');
    mark.className = MARK_CLASS;
    mark.setAttribute('data-mark-id', markId);
    target.parentNode.insertBefore(mark, target);
    mark.appendChild(target);
}
