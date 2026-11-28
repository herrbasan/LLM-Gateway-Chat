import test from 'node:test';
import assert from 'node:assert/strict';

import {
    extensionOf,
    kindFromName,
    kindFromMime,
    languageFromName,
    KIND_MEDIA,
    KIND_BINARY
} from '../chat/js/preview-file-types.js';

test('extensionOf ignores query strings, fragments and case', () => {
    assert.equal(extensionOf('report.MD'), 'md');
    assert.equal(extensionOf('/storage/a/b/Notes.Markdown?x=1'), 'markdown');
    assert.equal(extensionOf('https://host/f.mov#t=10'), 'mov');
    assert.equal(extensionOf('Makefile'), null);
    assert.equal(extensionOf(''), null);
    assert.equal(extensionOf(null), null);
});

test('kindFromName classifies every table entry, mixed case', () => {
    assert.equal(kindFromName('README.MD').kind, 'markdown');
    assert.equal(kindFromName('doc.DOCX').kind, 'docx');
    assert.equal(kindFromName('photo.JPeG').kind, 'image');
    assert.equal(kindFromName('logo.SVG').kind, 'svg');
    assert.equal(kindFromName('take.M4A').kind, 'audio');
    assert.equal(kindFromName('clip.OGV').kind, 'video');
    assert.equal(kindFromName('page.HTM').kind, 'html');
    assert.equal(kindFromName('paper.PDF').kind, 'pdf');
});

test('kindFromName carries the code language', () => {
    assert.deepEqual(kindFromName('app.mjs'), { kind: 'code', language: 'javascript' });
    assert.deepEqual(kindFromName('lib.rs'), { kind: 'code', language: 'rust' });
    assert.deepEqual(kindFromName('conf.YML'), { kind: 'code', language: 'yaml' });
    assert.deepEqual(kindFromName('run.ps1'), { kind: 'code', language: 'powershell' });
    assert.equal(languageFromName('index.ts'), 'typescript');
    assert.equal(languageFromName('notes.md'), 'markdown');
    assert.equal(languageFromName('page.html'), 'html');
    assert.equal(languageFromName('photo.png'), null);
    assert.equal(languageFromName('unknown.zzz'), null);
});

test('unknown and extension-less names are unclassified', () => {
    assert.equal(kindFromName('data.zzz'), null);
    assert.equal(kindFromName('archive.tar.gz'), null);
    assert.equal(kindFromName('Makefile'), null);
    assert.equal(kindFromName(undefined), null);
});

test('kindFromMime maps the formats the proxy and browsers report', () => {
    assert.equal(kindFromMime('text/markdown; charset=utf-8'), 'markdown');
    assert.equal(kindFromMime('text/html'), 'html');
    assert.equal(kindFromMime('image/svg+xml'), 'svg');
    assert.equal(kindFromMime('image/png'), 'image');
    assert.equal(kindFromMime('audio/mpeg'), 'audio');
    assert.equal(kindFromMime('video/mp4'), 'video');
    assert.equal(kindFromMime('application/pdf'), 'pdf');
    assert.equal(
        kindFromMime('application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
        'docx'
    );
    assert.equal(kindFromMime('application/json'), 'code');
    assert.equal(kindFromMime('application/ld+json'), 'code');
    assert.equal(kindFromMime('application/xml'), 'code');
    assert.equal(kindFromMime('application/javascript'), 'code');
    assert.equal(kindFromMime('application/x-yaml'), 'code');
    assert.equal(kindFromMime('application/problem+json'), 'code');
    assert.equal(kindFromMime('text/plain'), 'code');
    assert.equal(kindFromMime('application/octet-stream'), null);
    assert.equal(kindFromMime(''), null);
    assert.equal(kindFromMime(null), null);
});

test('media and binary kind sets cover the passive renderers only', () => {
    for (const kind of ['image', 'svg', 'audio', 'video']) {
        assert.ok(KIND_MEDIA.has(kind));
        assert.ok(KIND_BINARY.has(kind));
    }
    assert.ok(KIND_BINARY.has('docx'));
    assert.ok(KIND_BINARY.has('pdf'));
    assert.ok(!KIND_BINARY.has('markdown'));
    assert.ok(!KIND_MEDIA.has('docx'));
});
