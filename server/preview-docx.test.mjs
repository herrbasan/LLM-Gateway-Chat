import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';

import {
    extractZipEntry,
    docxDocumentXml,
    docxModel,
    parseWordprocessingModel
} from '../chat/js/preview-docx.js';

// The DOCX lane is DOM-free until renderDocxModel(): ZIP/deflate and the
// WordprocessingML → paragraph model conversion run in Node unchanged, so the
// fixture below is a real ZIP built with Node's own zlib.

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[i] = c >>> 0;
    }
    return table;
})();

function crc32(buffer) {
    let c = 0xffffffff;
    for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function buildZip(entries) {
    const locals = [];
    const centrals = [];
    let offset = 0;
    for (const entry of entries) {
        const name = Buffer.from(entry.name, 'utf8');
        const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
        const method = entry.method ?? 8;
        const compressed = method === 8 ? zlib.deflateRawSync(data) : data;
        const crc = crc32(data);

        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(entry.flags ?? 0, 6);
        local.writeUInt16LE(method, 8);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(compressed.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(name.length, 26);
        local.writeUInt16LE(0, 28);

        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(entry.flags ?? 0, 8);
        central.writeUInt16LE(method, 10);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(entry.centralCsize ?? compressed.length, 20);
        central.writeUInt32LE(entry.centralUsize ?? data.length, 24);
        central.writeUInt16LE(name.length, 28);
        central.writeUInt16LE(0, 30);
        central.writeUInt16LE(0, 32);
        central.writeUInt32LE(offset, 42);

        locals.push(local, name, compressed);
        centrals.push(central, name);
        offset += local.length + name.length + compressed.length;
    }

    const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(centralSize, 12);
    eocd.writeUInt32LE(offset, 16);

    return new Uint8Array(Buffer.concat([...locals, ...centrals, eocd]));
}

const DOCUMENT_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
    <w:body>
        <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Report Title</w:t></w:r></w:p>
        <w:p>
            <w:r><w:rPr><w:b/></w:rPr><w:t>Bold start</w:t></w:r>
            <w:r><w:rPr><w:i/><w:u/></w:rPr><w:t xml:space="preserve"> italic underlined</w:t></w:r>
            <w:r><w:t xml:space="preserve"> &amp; plain</w:t></w:r>
            <w:r><w:br/><w:t>next line</w:t></w:r>
        </w:p>
        <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/></w:numPr></w:pPr><w:r><w:t>First item</w:t></w:r></w:p>
        <w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Section</w:t></w:r></w:p>
        <w:p><w:r><w:t>Closing prose</w:t></w:r></w:p>
    </w:body>
</w:document>`;

function docxBytes(entries = [{ name: 'word/document.xml', data: DOCUMENT_XML }]) {
    return buildZip(entries);
}

test('extractZipEntry inflates a deflated entry', async () => {
    const xml = await docxDocumentXml(docxBytes());
    assert.match(xml, /Report Title/);
    assert.match(xml, /<\/w:document>/);
});

test('extractZipEntry supports stored (uncompressed) entries', async () => {
    const bytes = buildZip([{ name: 'word/document.xml', data: DOCUMENT_XML, method: 0 }]);
    const xml = await docxDocumentXml(bytes);
    assert.match(xml, /Report Title/);
    const other = await extractZipEntry(buildZip([{ name: 'a.txt', data: 'hello', method: 0 }]), 'a.txt');
    assert.equal(new TextDecoder().decode(other), 'hello');
});

test('docxModel converts paragraphs, headings and run formatting', async () => {
    const model = await docxModel(docxBytes());
    assert.equal(model.length, 5);

    assert.equal(model[0].style, 'Heading1');
    assert.deepEqual(model[0].runs, [{ text: 'Report Title', bold: false, italic: false, underline: false }]);

    assert.deepEqual(model[1].runs, [
        { text: 'Bold start', bold: true, italic: false, underline: false },
        { text: ' italic underlined', bold: false, italic: true, underline: true },
        { text: ' & plain', bold: false, italic: false, underline: false },
        { text: '\nnext line', bold: false, italic: false, underline: false }
    ]);

    assert.equal(model[2].numbered, true);
    assert.equal(model[2].runs[0].text, 'First item');
    assert.equal(model[3].style, 'Heading2');
    assert.equal(model[4].runs[0].text, 'Closing prose');
});

test('formatting flags honour an explicit w:val="0"', () => {
    const model = parseWordprocessingModel(
        '<w:document xmlns:w="x"><w:body><w:p>' +
        '<w:r><w:rPr><w:b w:val="0"/><w:i w:val="false"/></w:rPr><w:t>plain</w:t></w:r>' +
        '</w:p></w:body></w:document>'
    );
    assert.deepEqual(model[0].runs[0], { text: 'plain', bold: false, italic: false, underline: false });
});

test('tabs, breaks and entities survive the walk', () => {
    const model = parseWordprocessingModel(
        '<w:document><w:body><w:p><w:r>' +
        '<w:t>col1</w:t><w:tab/><w:t>col2</w:t><w:cr/><w:t>a &lt; b &amp; c &#65;</w:t>' +
        '</w:r></w:p></w:body></w:document>'
    );
    assert.equal(model[0].runs[0].text, 'col1\tcol2\na < b & c A');
});

test('paragraphs inside text boxes are skipped, the outer one survives', () => {
    const model = parseWordprocessingModel(
        '<w:document><w:body><w:p><w:r><w:t>Outer</w:t></w:r>' +
        '<w:r><w:pict><w:txbxContent><w:p><w:r><w:t>Inside box</w:t></w:r></w:p></w:txbxContent></w:pict></w:r>' +
        '</w:p></w:body></w:document>'
    );
    assert.equal(model.length, 1);
    assert.deepEqual(model[0].runs.map(run => run.text), ['Outer']);
});

test('not a ZIP archive fails loudly', async () => {
    await assert.rejects(async () => docxModel(new TextEncoder().encode('hello world')), /not a ZIP archive/);
});

test('a ZIP without word/document.xml fails loudly', async () => {
    await assert.rejects(async () => docxModel(buildZip([{ name: 'other.txt', data: 'x' }])), /no word\/document\.xml/);
});

test('encrypted entries are rejected', async () => {
    const bytes = buildZip([{ name: 'word/document.xml', data: DOCUMENT_XML, flags: 1 }]);
    await assert.rejects(async () => docxModel(bytes), /encrypted/);
});

test('unsupported compression methods are rejected', async () => {
    const bytes = buildZip([{ name: 'word/document.xml', data: DOCUMENT_XML, method: 99 }]);
    await assert.rejects(async () => docxModel(bytes), /compression method 99/);
});

test('ZIP64 entries are rejected', async () => {
    const bytes = buildZip([{
        name: 'word/document.xml',
        data: DOCUMENT_XML,
        centralCsize: 0xffffffff,
        centralUsize: 0xffffffff
    }]);
    await assert.rejects(async () => docxModel(bytes), /ZIP64/);
});

test('oversized entries are rejected before decompression', async () => {
    const bytes = buildZip([{
        name: 'word/document.xml',
        data: DOCUMENT_XML,
        centralUsize: 30 * 1024 * 1024
    }]);
    await assert.rejects(async () => docxModel(bytes), /over the .* byte cap/);
});
