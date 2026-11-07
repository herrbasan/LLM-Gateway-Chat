const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { decodePreviewText, detectBinaryKind, isTextMediaType, preflightPreviewUrl } = require('./preview-content');

const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

test('accepts ordinary text, Markdown, JSON, and SVG', () => {
    assert.equal(decodePreviewText('# Heading\n\nBody', 'text/markdown; charset=utf-8'), '# Heading\n\nBody');
    assert.equal(decodePreviewText('{"ok":true}', 'application/json'), '{"ok":true}');
    assert.equal(decodePreviewText('<svg xmlns="http://www.w3.org/2000/svg"/>', 'image/svg+xml'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    assert.equal(decodePreviewText('plain text', null), 'plain text');
});

test('recognizes structured textual media types', () => {
    assert.equal(isTextMediaType('application/problem+json'), true);
    assert.equal(isTextMediaType('application/atom+xml'), true);
    assert.equal(isTextMediaType('application/pdf'), false);
    assert.equal(isTextMediaType('image/png'), false);
});

test('rejects a declared PDF with raster-preview guidance', () => {
    assert.throws(
        () => decodePreviewText(PDF, 'application/pdf'),
        err => err.statusCode === 415 && err.message.includes('application/pdf') && err.message.includes('raster page previews')
    );
});

test('rejects binary signatures even when the upstream labels them as text', () => {
    assert.throws(() => decodePreviewText(PDF, 'text/plain'), /PDF data/);
    assert.throws(() => decodePreviewText(PNG, 'text/plain'), /PNG data/);
    assert.throws(() => decodePreviewText(Buffer.from('PK\x03\x04rest'), 'text/plain'), /ZIP data/);
});

test('rejects NUL-containing and invalid UTF-8 payloads instead of replacement-character text', () => {
    assert.throws(() => decodePreviewText(Buffer.from([0x41, 0x00, 0x42]), 'text/plain'), /NUL-byte binary/);
    assert.throws(() => decodePreviewText(Buffer.from([0x41, 0xff, 0xfe, 0x42]), 'text/plain'), /not valid UTF-8 text/);
});

test('detects signatures without requiring a content-type declaration', () => {
    assert.equal(detectBinaryKind(PDF), 'PDF');
    assert.equal(detectBinaryKind(PNG), 'PNG');
    assert.equal(detectBinaryKind(Buffer.from('ordinary UTF-8 text')), null);
});

test('preflight returns declared binary errors to the tool caller and accepts text URLs', async (t) => {
    const server = http.createServer((req, res) => {
        if (req.url === '/document.pdf') {
            res.writeHead(200, { 'Content-Type': 'application/pdf' });
            res.end(PDF);
            return;
        }
        res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
        res.end('# Preview');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const origin = `http://127.0.0.1:${server.address().port}`;

    await assert.rejects(
        preflightPreviewUrl('/document.pdf', origin),
        err => err.statusCode === 415 && err.message.includes('application/pdf') && err.message.includes('raster page previews')
    );
    await assert.doesNotReject(preflightPreviewUrl('/document.md', origin));
});
