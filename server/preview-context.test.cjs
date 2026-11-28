const test = require('node:test');
const assert = require('node:assert/strict');
const { validatePreviewContext, normalizeStoredMessage } = require('./conversation-store');
const { buildApiMessages, formatPreviewContextBlock } = require('./api-view');

const OPTS = { systemPrompt: 'SYSTEM', publicOrigin: 'http://localhost:8080' };
const is400 = err => err.status === 400;

test('validatePreviewContext: file-only context is normalized', () => {
    const clean = validatePreviewContext({
        paneOpen: true,
        path: ' documentation/MD-Blocks/brief.md ',
        title: 'Brief',
        kind: 'markdown',
        view: 'document',
        page: 2,
        unknown: 'dropped'
    });
    assert.deepEqual(clean, {
        paneOpen: true,
        path: 'documentation/MD-Blocks/brief.md',
        title: 'Brief',
        kind: 'markdown',
        view: 'document',
        page: 2
    });
});

test('validatePreviewContext: marks are normalized, empty optional strings dropped', () => {
    const clean = validatePreviewContext({
        paneOpen: true,
        id: 'item-1',
        marks: [
            { quote: ' first quote ', heading: 'H1', note: 'why' },
            { quote: 'second', heading: '', note: '  ' }
        ]
    });
    assert.deepEqual(clean.marks, [
        { quote: 'first quote', heading: 'H1', note: 'why' },
        { quote: 'second' }
    ]);
});

test('validatePreviewContext: null and undefined return null', () => {
    assert.equal(validatePreviewContext(null), null);
    assert.equal(validatePreviewContext(undefined), null);
});

test('validatePreviewContext: non-object and non-boolean paneOpen are 400', () => {
    assert.throws(() => validatePreviewContext('open'), is400);
    assert.throws(() => validatePreviewContext([]), is400);
    assert.throws(() => validatePreviewContext({ paneOpen: 'yes' }), is400);
    assert.throws(() => validatePreviewContext({ paneOpen: true, page: 0 }), is400);
    assert.throws(() => validatePreviewContext({ paneOpen: true, page: 1.5 }), is400);
    assert.throws(() => validatePreviewContext({ paneOpen: true, path: 42 }), is400);
});

test('validatePreviewContext: oversize quote is 400, not truncated', () => {
    assert.throws(
        () => validatePreviewContext({ paneOpen: true, marks: [{ quote: 'x'.repeat(4001) }] }),
        err => is400(err) && /quote exceeds 4000/.test(err.message)
    );
    assert.throws(() => validatePreviewContext({ paneOpen: true, marks: [{ quote: '' }] }), is400);
});

test('validatePreviewContext: more than 20 marks is 400', () => {
    const marks = Array.from({ length: 21 }, (_, i) => ({ quote: `q${i}` }));
    assert.throws(
        () => validatePreviewContext({ paneOpen: true, marks }),
        err => is400(err) && /marks exceeds 20/.test(err.message)
    );
});

test('validatePreviewContext: total payload over 32KB is 400', () => {
    // Nine maximal quotes fit every per-field limit (36000 chars total).
    const marks = Array.from({ length: 9 }, () => ({ quote: 'q'.repeat(4000) }));
    assert.throws(
        () => validatePreviewContext({ paneOpen: true, marks }),
        err => is400(err) && /exceeds 32768 bytes/.test(err.message)
    );
});

test('normalizeStoredMessage keeps a validated previewContext on the stored message', () => {
    const stored = normalizeStoredMessage({
        role: 'user',
        content: 'x',
        previewContext: { paneOpen: true, path: 'a.md', marks: [] }
    });
    assert.deepEqual(stored.previewContext, { paneOpen: true, path: 'a.md', marks: [] });
    assert.equal('previewContext' in normalizeStoredMessage({ role: 'user', content: 'y' }), false);
});

test('formatPreviewContextBlock: closed pane without marks emits nothing', () => {
    assert.equal(formatPreviewContextBlock(null), '');
    assert.equal(formatPreviewContextBlock({ paneOpen: false, marks: [] }), '');
    assert.equal(formatPreviewContextBlock({ paneOpen: false }), '');
});

test('formatPreviewContextBlock: file state and marked passages are compact text', () => {
    const block = formatPreviewContextBlock({
        paneOpen: true,
        path: 'blog/a.md',
        kind: 'markdown',
        view: 'document',
        marks: [{ heading: 'Intro', quote: 'the quote', note: 'check' }]
    });
    assert.equal(block, [
        '[Preview State]',
        'File: blog/a.md (markdown, view: document)',
        'Marked passages (1):',
        '1. [Intro] "the quote" (Note: check)'
    ].join('\n'));
});

test('buildApiMessages: preview block rides the user turn wire payload only', () => {
    const stored = [
        { role: 'user', content: 'first question', createdAt: '2026-01-01T10:00:00' },
        { role: 'assistant', content: 'first answer', createdAt: '2026-01-01T10:00:30' },
        {
            role: 'user',
            content: 'what is this?',
            createdAt: '2026-01-01T10:01:00',
            previewContext: { paneOpen: true, path: 'docs/a.md', kind: 'markdown', marks: [{ quote: 'passage' }] }
        }
    ];
    const before = JSON.stringify(stored);
    const { messages } = buildApiMessages(stored, OPTS);

    assert.equal(messages[0].content, 'SYSTEM');
    assert.equal(messages[1].content, '[2026-01-01@10:00] first question');
    assert.equal(messages[2].content, 'first answer');
    assert.equal(
        messages[3].content,
        '[2026-01-01@10:01] what is this?\n\n'
        + '[Preview State]\nFile: docs/a.md (markdown)\nMarked passages (1):\n1. "passage"'
    );
    // Stored messages are never mutated (KV-cache prefix stability).
    assert.equal(JSON.stringify(stored), before);
});

test('buildApiMessages: preview block also reaches a multimodal user turn', () => {
    const { messages } = buildApiMessages([
        {
            role: 'user',
            content: 'describe',
            createdAt: '2026-01-01T10:00:00',
            attachments: [{ name: 'a.png', type: 'image/png', url: '/storage/images/a.png' }],
            previewContext: { paneOpen: true, title: 'Deck', page: 3 }
        }
    ], OPTS);
    const userMsg = messages.find(m => m.role === 'user');
    assert.ok(Array.isArray(userMsg.content));
    const text = userMsg.content.find(part => part.type === 'text').text;
    assert.match(text, /\[Preview State\]/);
    assert.match(text, /File: Deck \(page: 3\)/);
});

test('buildApiMessages: paneOpen false with no marks appends nothing', () => {
    const { messages } = buildApiMessages([
        { role: 'user', content: 'plain', createdAt: '2026-01-01T10:00:00', previewContext: { paneOpen: false } }
    ], OPTS);
    assert.equal(messages[1].content, '[2026-01-01@10:00] plain');
});
