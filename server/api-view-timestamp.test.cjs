const test = require('node:test');
const assert = require('node:assert/strict');
const { buildApiMessages } = require('./api-view');

const OPTS = { systemPrompt: '', publicOrigin: 'http://localhost:8080' };
const tsOf = msg => msg.content.match(/^\[\d{4}-\d{2}-\d{2}@\d{2}:\d{2}\]\s*/)?.[0];

test('assistant history carries no timestamp prefix (mimicry template)', () => {
    const { messages } = buildApiMessages([
        { role: 'user', content: 'hello', createdAt: '2026-01-01T10:00:00' },
        { role: 'assistant', content: 'hi there', createdAt: '2026-01-01T10:00:30' }
    ], OPTS);
    assert.equal(tsOf(messages[1]), undefined);
    assert.equal(messages[1].content, 'hi there');
});

test('user turns keep exactly one prefix, derived from createdAt', () => {
    const { messages } = buildApiMessages([
        { role: 'user', content: '[2026-01-01@09:59] model-echoed', createdAt: '2026-01-01T10:00:00' }
    ], OPTS);
    assert.equal(messages[0].content, '[2026-01-01@10:00] model-echoed');
});

test('a prefix stored on an assistant message is stripped, not re-emitted', () => {
    const { messages } = buildApiMessages([
        { role: 'user', content: 'q', createdAt: '2026-01-01T10:00:00' },
        { role: 'assistant', content: '[2026-01-01@10:00] stale', createdAt: '2026-01-01T10:01:00' }
    ], OPTS);
    assert.equal(messages[1].content, 'stale');
});

test('model-invented separator variants are stripped too (T / space / seconds)', () => {
    const { messages } = buildApiMessages([
        { role: 'user', content: 'q', createdAt: '2026-01-01T10:00:00' },
        { role: 'assistant', content: '[2026-01-01T10:00] iso echo', createdAt: '2026-01-01T10:01:00' },
        { role: 'user', content: 'q2', createdAt: '2026-01-01T10:02:00' },
        { role: 'assistant', content: '[2026-01-01 10:02:07] space echo', createdAt: '2026-01-01T10:03:00' },
        { role: 'user', content: 'q3', createdAt: '2026-01-01T10:04:00' },
        { role: 'assistant', content: '[2026-01-01@10:04] doubled [2026-01-01@10:04] echo', createdAt: '2026-01-01T10:05:00' }
    ], OPTS);
    assert.equal(messages[1].content, 'iso echo');
    assert.equal(messages[3].content, 'space echo');
    assert.equal(messages[5].content, 'doubled [2026-01-01@10:04] echo');
});
