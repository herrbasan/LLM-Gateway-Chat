import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// chat/ is a browser tree (no "type": "module"), so the module under test is
// loaded through a data URL — the same trick hosted-app.test.mjs uses.
const source = readFileSync(new URL('./research-note.js', import.meta.url), 'utf8');
const { resolveContentHref, noteUrlFromHref, splitNoteSource } =
    await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

const STORAGE = 'http://192.168.0.100:3100';
const getStorage = () => STORAGE;
const DRAFT = `${STORAGE}/storage/blog/drafts/the-1-2x-trap.md`;
const NOTE = `${STORAGE}/storage/blog/references/social-self-mead.md`;

test('resolveContentHref leaves in-page anchors and non-http schemes to the browser', () => {
    assert.equal(resolveContentHref('#section', DRAFT, getStorage), null);
    assert.equal(resolveContentHref('mailto:someone@example.com', DRAFT, getStorage), null);
    assert.equal(resolveContentHref('javascript:alert(1)', DRAFT, getStorage), null);
    assert.equal(resolveContentHref('', DRAFT, getStorage), null);
});

test('resolveContentHref resolves relative destinations against the document base', () => {
    assert.equal(resolveContentHref('../references/social-self-mead.md', DRAFT, getStorage), NOTE);
    assert.equal(resolveContentHref('https://plato.stanford.edu/entries/mead/', DRAFT, getStorage),
        'https://plato.stanford.edu/entries/mead/');
    assert.equal(resolveContentHref('/writing/the-haunting/', DRAFT, getStorage),
        `${STORAGE}/writing/the-haunting/`);
});

test('resolveContentHref refuses relative paths when the document has no location', () => {
    assert.equal(resolveContentHref('../references/social-self-mead.md', null, getStorage), null);
    assert.equal(resolveContentHref('/storage/blog/posts/x.md', null, getStorage),
        `${STORAGE}/storage/blog/posts/x.md`);
    assert.equal(resolveContentHref('/storage/blog/posts/x.md', null, () => null), null);
});

test('noteUrlFromHref detects the post→note form', () => {
    assert.equal(noteUrlFromHref('../references/social-self-mead.md', DRAFT, getStorage), NOTE);
    assert.equal(noteUrlFromHref(`../references/social-self-mead_de.md`, DRAFT, getStorage),
        `${STORAGE}/storage/blog/references/social-self-mead_de.md`);
});

test('noteUrlFromHref detects a bare note→note link inside a note', () => {
    assert.equal(noteUrlFromHref('narrative-self-illusionism.md', NOTE, getStorage),
        `${STORAGE}/storage/blog/references/narrative-self-illusionism.md`);
    assert.equal(noteUrlFromHref('narrative-self-illusionism.md', DRAFT, getStorage), null);
});

test('noteUrlFromHref leaves ordinary links alone', () => {
    assert.equal(noteUrlFromHref('/writing/the-haunting/', DRAFT, getStorage), null);
    assert.equal(noteUrlFromHref('https://plato.stanford.edu/entries/mead/', DRAFT, getStorage), null);
    assert.equal(noteUrlFromHref('#refs', DRAFT, getStorage), null);
});

test('noteUrlFromHref assumes the storage corpus when the document has no base', () => {
    assert.equal(noteUrlFromHref('../references/social-self-mead.md', null, getStorage), NOTE);
    assert.equal(noteUrlFromHref('/storage/blog/references/social-self-mead.md', null, getStorage), NOTE);
    assert.equal(noteUrlFromHref('../references/social-self-mead.md', null, () => null), null);
});

test('splitNoteSource lifts the frontmatter title and drops the duplicate H1', () => {
    const note = [
        '---',
        'title: "Research Notes: Mead\'s Social Self"',
        'slug: social-self-mead',
        '---',
        '',
        '# Research Notes: Mead\'s Social Self',
        '',
        '## Reflexiveness',
        '',
        'Mead starts inside social activity.'
    ].join('\n');
    const { title, body } = splitNoteSource(note);
    assert.equal(title, "Research Notes: Mead's Social Self");
    assert.equal(body, '## Reflexiveness\n\nMead starts inside social activity.');
});

test('splitNoteSource falls back to the H1 when there is no frontmatter title', () => {
    const { title, body } = splitNoteSource('\n\n# Research Notes: AlphaGo\n\nText.');
    assert.equal(title, 'Research Notes: AlphaGo');
    assert.equal(body, 'Text.');
});

test('splitNoteSource keeps the body intact when it has no title at all', () => {
    const { title, body } = splitNoteSource('Just a paragraph.\n\nSecond paragraph.');
    assert.equal(title, null);
    assert.equal(body, 'Just a paragraph.\n\nSecond paragraph.');
});
