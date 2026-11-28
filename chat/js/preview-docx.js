// ============================================
// DOCX renderer — zero dependency, browser-native
// ============================================
//
// A .docx is a ZIP holding word/document.xml. This walks the ZIP end-of-central-
// directory record, inflates that one entry with DecompressionStream, and turns
// the WordprocessingML into a paragraph model that renderDocxModel() builds into
// DOM nodes — textContent/createElement only, never innerHTML from document XML.
//
// Fidelity is deliberately partial and the limits are real: paragraphs,
// Heading1-6, bold/italic/underline, line breaks, tabs and bulleted/numbered
// paragraphs render. Tables, images, headers/footers, columns and embedded
// objects do not — a table's cell text appears as consecutive paragraphs. This
// is a reader's view, not Word.
//
// The ZIP/deflate lane and the XML → model conversion run without DOM, so Node
// tests exercise them directly; only renderDocxModel() needs a document.

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;
const ZIP64 = 0xffffffff;
const DOCUMENT = 'word/document.xml';
const MAX_ENTRY_BYTES = 25 * 1024 * 1024;

function toBytes(input) {
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    throw new Error('DOCX: expected bytes (ArrayBuffer or Uint8Array)');
}

function readU16(bytes, offset) {
    return bytes[offset] | (bytes[offset + 1] << 8);
}

function readU32(bytes, offset) {
    return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function findEocd(bytes) {
    if (bytes.length < 22) throw new Error('DOCX: not a ZIP archive (file too short)');
    const lowest = Math.max(0, bytes.length - 0xffff - 22);
    for (let i = bytes.length - 22; i >= lowest; i--) {
        if (readU32(bytes, i) === EOCD_SIG) return i;
    }
    throw new Error('DOCX: not a ZIP archive (no end-of-central-directory record)');
}

function centralEntries(bytes) {
    const eocd = findEocd(bytes);
    const count = readU16(bytes, eocd + 10);
    const offset = readU32(bytes, eocd + 16);
    if (count === 0xffff || offset === ZIP64) throw new Error('DOCX: ZIP64 archives are not supported');
    const entries = new Map();
    let p = offset;
    for (let i = 0; i < count; i++) {
        if (p + 46 > bytes.length || readU32(bytes, p) !== CEN_SIG) {
            throw new Error(`DOCX: corrupt central directory at entry ${i}`);
        }
        const flags = readU16(bytes, p + 8);
        const method = readU16(bytes, p + 10);
        const csize = readU32(bytes, p + 20);
        const usize = readU32(bytes, p + 24);
        const nameLen = readU16(bytes, p + 28);
        const extraLen = readU16(bytes, p + 30);
        const commentLen = readU16(bytes, p + 32);
        const local = readU32(bytes, p + 42);
        const name = new TextDecoder('utf-8').decode(bytes.subarray(p + 46, p + 46 + nameLen));
        entries.set(name, { name, flags, method, csize, usize, local });
        p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
}

// The local header repeats name/extra lengths and they may differ from the
// central ones — the data offset must come from the LOCAL header.
function entryData(bytes, entry) {
    if (entry.flags & 1) throw new Error(`DOCX: encrypted ZIP entry "${entry.name}" is not supported`);
    if (entry.csize === ZIP64 || entry.usize === ZIP64) throw new Error(`DOCX: ZIP64 entry "${entry.name}" is not supported`);
    if (entry.usize > MAX_ENTRY_BYTES) {
        throw new Error(`DOCX: entry "${entry.name}" expands to ${entry.usize} bytes — over the ${MAX_ENTRY_BYTES} byte cap`);
    }
    const local = entry.local;
    if (local + 30 > bytes.length || readU32(bytes, local) !== LOC_SIG) {
        throw new Error(`DOCX: corrupt local header for "${entry.name}"`);
    }
    const nameLen = readU16(bytes, local + 26);
    const extraLen = readU16(bytes, local + 28);
    const start = local + 30 + nameLen + extraLen;
    const end = start + entry.csize;
    if (end > bytes.length) throw new Error(`DOCX: truncated data for "${entry.name}"`);
    return bytes.subarray(start, end);
}

async function inflateRaw(raw) {
    const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Read one ZIP entry out of a DOCX container.
 * @param {ArrayBuffer|Uint8Array} input
 * @param {string} [name]
 * @returns {Promise<Uint8Array>}
 */
export async function extractZipEntry(input, name = DOCUMENT) {
    const bytes = toBytes(input);
    const entry = centralEntries(bytes).get(name);
    if (!entry) throw new Error(`DOCX: not a Word document (no ${name})`);
    const raw = entryData(bytes, entry);
    if (entry.method === 0) return raw;
    if (entry.method === 8) return inflateRaw(raw);
    throw new Error(`DOCX: unsupported ZIP compression method ${entry.method} for "${name}"`);
}

/**
 * word/document.xml as text.
 * @param {ArrayBuffer|Uint8Array} input
 * @returns {Promise<string>}
 */
export async function docxDocumentXml(input) {
    return new TextDecoder('utf-8').decode(await extractZipEntry(input, DOCUMENT));
}

function* xmlEvents(xml) {
    const length = xml.length;
    let i = 0;
    while (i < length) {
        const lt = xml.indexOf('<', i);
        if (lt === -1) {
            yield { type: 'text', value: xml.slice(i) };
            return;
        }
        if (lt > i) yield { type: 'text', value: xml.slice(i, lt) };
        if (xml.startsWith('<!--', lt)) {
            const end = xml.indexOf('-->', lt + 4);
            i = end === -1 ? length : end + 3;
            continue;
        }
        if (xml.startsWith('<![CDATA[', lt)) {
            const end = xml.indexOf(']]>', lt + 9);
            yield { type: 'text', value: xml.slice(lt + 9, end === -1 ? length : end) };
            i = end === -1 ? length : end + 3;
            continue;
        }
        if (xml.startsWith('<?', lt) || xml.startsWith('<!', lt)) {
            const end = xml.indexOf('>', lt + 2);
            i = end === -1 ? length : end + 1;
            continue;
        }
        let j = lt + 1;
        let quote = null;
        for (; j < length; j++) {
            const ch = xml[j];
            if (quote) {
                if (ch === quote) quote = null;
            } else if (ch === '"' || ch === "'") {
                quote = ch;
            } else if (ch === '>') {
                break;
            }
        }
        if (j >= length) throw new Error('DOCX: unterminated XML tag');
        const raw = xml.slice(lt + 1, j);
        i = j + 1;
        if (raw.startsWith('/')) {
            yield { type: 'close', name: raw.slice(1).trim() };
            continue;
        }
        const selfClosing = raw.endsWith('/');
        const body = selfClosing ? raw.slice(0, -1) : raw;
        const nameMatch = /^[^\s/>]+/.exec(body);
        if (!nameMatch) throw new Error('DOCX: malformed XML tag');
        const attrs = {};
        const attrRe = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
        let match;
        while ((match = attrRe.exec(body))) attrs[match[1]] = match[3] !== undefined ? match[3] : match[4];
        yield { type: 'open', name: nameMatch[0], attrs, selfClosing };
    }
}

function decodeEntities(text) {
    if (!text.includes('&')) return text;
    return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, code) => {
        const lower = code.toLowerCase();
        if (lower === 'amp') return '&';
        if (lower === 'lt') return '<';
        if (lower === 'gt') return '>';
        if (lower === 'quot') return '"';
        if (lower === 'apos') return "'";
        const n = lower.startsWith('#x') ? parseInt(lower.slice(2), 16) : parseInt(lower.slice(1), 10);
        return Number.isFinite(n) ? String.fromCodePoint(n) : whole;
    });
}

function localName(name) {
    const colon = name.lastIndexOf(':');
    return colon === -1 ? name : name.slice(colon + 1);
}

function valAttr(attrs) {
    for (const key of Object.keys(attrs)) if (localName(key) === 'val') return attrs[key];
    return null;
}

function truthyFlag(value) {
    if (value === null) return true;
    const normal = String(value).toLowerCase();
    return normal !== '0' && normal !== 'false' && normal !== 'off';
}

/**
 * Turn word/document.xml into a paragraph model. Pure: no DOM, no ZIP.
 * @param {string} xml
 * @returns {Array<{heading: number|null, numbered: boolean, runs: Array<{text: string, bold: boolean, italic: boolean, underline: boolean}>}>}
 */
export function parseWordprocessingModel(xml) {
    if (typeof xml !== 'string' || !xml.trim()) throw new Error('DOCX: word/document.xml is empty');
    const paragraphs = [];
    const stack = [];
    let para = null;
    let run = null;
    let textBuffer = null;

    const inside = name => stack.includes(name);

    for (const event of xmlEvents(xml)) {
        if (event.type === 'text') {
            if (textBuffer !== null) textBuffer.push(decodeEntities(event.value));
            continue;
        }
        const name = localName(event.name);

        if (event.type === 'close') {
            const index = stack.lastIndexOf(name);
            if (index === -1) continue;
            stack.length = index;
            if (name === 't' && textBuffer !== null) {
                if (run) run.text += textBuffer.join('');
                textBuffer = null;
            } else if (name === 'r') {
                if (para && run && run.text !== '') para.runs.push(run);
                run = null;
            } else if (name === 'p') {
                // A paragraph inside a text box or a tracked deletion still has
                // that container on the stack here — it never became `para`.
                if (inside('txbxContent') || inside('del')) continue;
                if (para) paragraphs.push(para);
                para = null;
                run = null;
            }
            continue;
        }

        if (event.selfClosing) {
            if (name === 'tab' && run) run.text += '\t';
            else if ((name === 'br' || name === 'cr') && run) run.text += '\n';
            else if (name === 'b' || name === 'i' || name === 'u') {
                if (run && inside('rPr')) setRunFlag(run, name, valAttr(event.attrs));
            } else if (name === 'pStyle' && para) {
                para.style = valAttr(event.attrs) || '';
            } else if (name === 'numPr' && para) {
                para.numbered = true;
            }
            continue;
        }

        stack.push(name);
        if (name === 'p') {
            if (inside('txbxContent') || inside('del')) continue;
            para = { style: '', numbered: false, runs: [] };
            run = null;
        } else if (name === 'r') {
            if (para && !inside('txbxContent') && !inside('del')) {
                run = { text: '', bold: false, italic: false, underline: false };
            }
        } else if (name === 't') {
            if (run && !inside('txbxContent') && !inside('del')) textBuffer = [];
        } else if (name === 'b' || name === 'i' || name === 'u') {
            if (run && inside('rPr')) setRunFlag(run, name, valAttr(event.attrs));
        } else if (name === 'pStyle' && para) {
            para.style = valAttr(event.attrs) || '';
        } else if (name === 'numPr' && para) {
            para.numbered = true;
        }
    }
    return paragraphs;
}

function setRunFlag(run, name, value) {
    if (name === 'b') run.bold = truthyFlag(value);
    else if (name === 'i') run.italic = truthyFlag(value);
    else run.underline = truthyFlag(value);
}

/**
 * Build the DOM for a paragraph model. Elements only — DOCX text is untrusted
 * input and never becomes markup.
 * @param {Array} model
 * @param {Document} [doc]
 * @returns {DocumentFragment}
 */
export function renderDocxModel(model, doc = globalThis.document) {
    if (!doc) throw new Error('DOCX: renderDocxModel needs a document');
    if (!Array.isArray(model)) throw new Error('DOCX: renderDocxModel expects the paragraph model');
    const fragment = doc.createDocumentFragment();
    let list = null;

    for (const para of model) {
        const heading = /^(?:Heading|heading)\s*([1-6])$/.exec(para.style || '');
        let node;
        if (heading) {
            node = doc.createElement('h' + heading[1]);
            list = null;
        } else if (para.numbered) {
            if (!list) {
                list = doc.createElement('ul');
                fragment.appendChild(list);
            }
            node = doc.createElement('li');
        } else {
            node = doc.createElement('p');
            list = null;
        }

        for (const run of para.runs) {
            let target = node;
            if (run.bold || run.italic || run.underline) {
                const span = doc.createElement('span');
                if (run.bold) span.style.fontWeight = '600';
                if (run.italic) span.style.fontStyle = 'italic';
                if (run.underline) span.style.textDecoration = 'underline';
                node.appendChild(span);
                target = span;
            }
            const lines = run.text.split('\n');
            lines.forEach((line, index) => {
                if (index > 0) target.appendChild(doc.createElement('br'));
                if (line) target.appendChild(doc.createTextNode(line));
            });
        }

        if (node.textContent.trim() || heading) (list || fragment).appendChild(node);
    }
    return fragment;
}

/**
 * Plain text of a paragraph model — what TTS reads and what a render-key
 * comparison sees.
 * @param {Array} model
 * @returns {string}
 */
export function docxModelText(model) {
    if (!Array.isArray(model)) throw new Error('DOCX: docxModelText expects the paragraph model');
    return model.map(para => para.runs.map(run => run.text).join('')).join('\n\n');
}

function validateXml(xml) {
    // Node has no DOMParser; the tokenizer below is the parser there and the
    // tests feed it well-formed XML. In the browser, fail loudly on bad XML.
    if (typeof DOMParser !== 'function') return;
    const parsed = new DOMParser().parseFromString(xml, 'application/xml');
    if (parsed.querySelector('parsererror')) throw new Error('DOCX: word/document.xml is not well-formed XML');
}

/**
 * bytes → paragraph model (no DOM).
 * @param {ArrayBuffer|Uint8Array} input
 * @returns {Promise<Array>}
 */
export async function docxModel(input) {
    const xml = await docxDocumentXml(input);
    validateXml(xml);
    return parseWordprocessingModel(xml);
}

/**
 * bytes → DocumentFragment.
 * @param {ArrayBuffer|Uint8Array} input
 * @returns {Promise<DocumentFragment>}
 */
export async function docxToFragment(input) {
    return renderDocxModel(await docxModel(input));
}
