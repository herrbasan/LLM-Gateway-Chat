import test from 'node:test';
import assert from 'node:assert/strict';

// preview.js is imported into Node: it touches no DOM at module level, and the
// session bookkeeping paths exercised here (background show, setSession,
// clearSession, getState) never reach a DOM-mutating call. localStorage is the
// only ambient it reads on a content-mode show (per-item view default).
globalThis.localStorage = {
    _v: new Map(),
    getItem(key) { return this._v.has(key) ? this._v.get(key) : null; },
    setItem(key, value) { this._v.set(key, String(value)); }
};

const { preview } = await import('../chat/js/preview.js');

function state() {
    return JSON.parse(preview.getState().content[0].text);
}

async function record(sessionId, id) {
    // No sessionId === currentSessionId here: the target is a background chat,
    // which is exactly the path that must not touch the visible pane.
    await preview.show({ id, title: id, content: `# ${id}` }, { sessionId });
}

test('a background session records its item without hijacking the visible one', async () => {
    preview.reset();
    preview.setSession('chat-a');

    await record('chat-b', 'bg-doc');

    assert.deepEqual(state().items, [], 'visible session must stay untouched');
    assert.equal(state().activeId, null);

    preview.setSession('chat-b');
    const b = state();
    assert.equal(b.items.length, 1);
    assert.equal(b.activeId, 'bg-doc');
    assert.equal(b.items[0].id, 'bg-doc');
});

test('switching sessions restores that session instead of wiping it', async () => {
    preview.reset();
    await record('one', 'first');
    await record('two', 'second');

    preview.setSession('one');
    assert.equal(state().activeId, 'first');

    preview.setSession('two');
    assert.equal(state().activeId, 'second');

    preview.setSession('one');
    assert.equal(state().activeId, 'first', 'returning restores the earlier item');
});

test('clearSession removes only the named session', async () => {
    preview.reset();
    await record('gone', 'x');
    await record('kept', 'y');

    preview.clearSession('gone');

    preview.setSession('gone');
    assert.deepEqual(state().items, []);
    assert.equal(state().activeId, null);

    preview.setSession('kept');
    assert.equal(state().items.length, 1);
    assert.equal(state().activeId, 'y');
});

test('consumeMarks targets the sending session and tolerates unknown sessions', async () => {
    preview.reset();
    await record('sender', 'doc');
    preview.setSession('other');

    // No throw, and the visible session is not consulted for the bookkeeping.
    preview.consumeMarks(['mark-1'], { sessionId: 'sender' });
    preview.consumeMarks(['mark-1'], { sessionId: 'never-existed' });
    preview.consumeMarks([]);

    assert.deepEqual(state().items, []);
    preview.setSession('sender');
    assert.equal(state().activeId, 'doc');
});

test('reset drops every session', async () => {
    preview.reset();
    await record('a', 'x');
    await record('b', 'y');

    preview.reset();

    preview.setSession('a');
    assert.deepEqual(state().items, []);
    preview.setSession('b');
    assert.deepEqual(state().items, []);
});
