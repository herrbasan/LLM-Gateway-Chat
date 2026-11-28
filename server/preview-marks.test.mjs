import test from 'node:test';
import assert from 'node:assert/strict';

import {
    MAX_MARKS,
    MAX_QUOTE_CHARS,
    MAX_HEADING_CHARS,
    MAX_NOTE_CHARS,
    normalizeWhitespace,
    findQuoteSpan
} from '../chat/js/preview-marks.js';

// The module is imported into Node: every DOM-touching helper must stay inside
// a function body, or this import would throw. That it loaded is itself the
// structural assertion for the server-side test run.

test('limits match the server-side validatePreviewContext contract', () => {
    assert.equal(MAX_MARKS, 20);
    assert.equal(MAX_QUOTE_CHARS, 4000);
    assert.equal(MAX_HEADING_CHARS, 300);
    assert.equal(MAX_NOTE_CHARS, 1000);
});

test('normalizeWhitespace collapses runs and trims both ends', () => {
    assert.equal(normalizeWhitespace('  a \n\n b\tc  '), 'a b c');
    assert.equal(normalizeWhitespace('single'), 'single');
    assert.equal(normalizeWhitespace(''), '');
    assert.equal(normalizeWhitespace('   '), '');
    assert.equal(normalizeWhitespace(null), '');
    assert.equal(normalizeWhitespace(undefined), '');
});

test('findQuoteSpan resolves a unique quote', () => {
    const full = 'alpha beta gamma';
    assert.equal(findQuoteSpan(full, 'beta'), 6);
    assert.equal(findQuoteSpan(full, 'beta', 0), 6);
});

test('findQuoteSpan selects the recorded repeat of a duplicated quote', () => {
    const full = 'one two one two one';
    assert.equal(findQuoteSpan(full, 'one', 0), 0);
    assert.equal(findQuoteSpan(full, 'one', 1), 8);
    assert.equal(findQuoteSpan(full, 'one', 2), 16);
});

test('findQuoteSpan falls back to the first match when the repeat is gone', () => {
    const full = 'only one occurrence here';
    assert.equal(findQuoteSpan(full, 'one', 3), 5);
});

test('findQuoteSpan returns -1 when the passage no longer exists', () => {
    assert.equal(findQuoteSpan('alpha beta', 'revised away'), -1);
    assert.equal(findQuoteSpan('alpha beta', ''), -1);
    assert.equal(findQuoteSpan('', 'alpha'), -1);
    assert.equal(findQuoteSpan(undefined, 'alpha'), -1);
    assert.equal(findQuoteSpan('alpha', undefined), -1);
});

test('findQuoteSpan spans a boundary between paragraphs', () => {
    // applyMarksToDom joins block texts with a single space, so a quote that
    // crosses a paragraph boundary is stored normalized.
    const full = 'end of one start of two';
    assert.equal(findQuoteSpan(full, 'one start'), 7);
});
