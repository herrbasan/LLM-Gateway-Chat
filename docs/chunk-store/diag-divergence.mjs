// diag-divergence.mjs — was the diverged checkpoint's lost detail inside a
// collapsed (referenced) chunk, or present in full? Decides whether dedup
// caused the comprehension loss.
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { buildChunkView } from './chunk-view.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FILE = 'direct-digital_twin___archived_writin-2026-08-11.json';
const CP = 320;
const NEEDLE = process.argv[2] || 'Patrick';

const d = JSON.parse(readFileSync(join(HERE, 'corpus', FILE), 'utf8'));
const messages = [];
for (const e of d.exchanges) {
    if (e.type === 'tool' && e.tool) {
        const callId = 'call_' + String(e.id).replace(/[^a-zA-Z0-9_-]/g, '');
        messages.push({ role: 'assistant', content: null, tool_calls: [{ id: callId, type: 'function', function: { name: e.tool.name, arguments: typeof e.tool.args === 'string' ? e.tool.args : JSON.stringify(e.tool.args || {}) } }] });
        if (e.tool.status === 'success' || e.tool.status === 'error') messages.push({ role: 'tool', tool_call_id: callId, content: e.tool.content || '' });
        if (e.assistant?.content) messages.push({ role: 'assistant', content: e.assistant.content });
    } else {
        if (e.user?.content) messages.push({ role: 'user', content: e.user.content });
        if (e.assistant?.content) messages.push({ role: 'assistant', content: e.assistant.content });
    }
}

const hist = messages.slice(0, CP);
const { messages: tx } = buildChunkView(hist);

// Where does the needle appear in RAW history, and what happened to those
// messages in the TRANSFORMED history?
console.log(`Needle "${NEEDLE}" occurrences in raw history before cp${CP}:`);
hist.forEach((m, i) => {
    const c = typeof m.content === 'string' ? m.content : '';
    const args = (m.tool_calls || []).map(t => t.function?.arguments || '').join(' ');
    const inContent = c.includes(NEEDLE);
    const inArgs = args.includes(NEEDLE);
    if (!inContent && !inArgs) return;
    // what does the transformed version look like?
    const t = tx[i];
    const tc = typeof t.content === 'string' ? t.content : '';
    const isRef = /^\[chunk_\d+ [=≈]/.test(tc);
    const tArgs = (t.tool_calls || []).map(x => x.function?.arguments || '').join(' ');
    const argRef = /\[chunk_\d+ [=≈]/.test(tArgs);
    console.log(`  msg${i} (${m.role})${inArgs ? ' [in tool args]' : ''} → transformed: ${isRef ? 'REFERENCE: ' + tc.slice(0, 80) : argRef ? 'args contain a reference' : 'full text present (' + tc.length + ' chars)'}`);
});

// count how many messages became references at all
let refCount = 0, refChars = 0;
tx.forEach((m, i) => {
    const tc = typeof m.content === 'string' ? m.content : '';
    if (/^\[chunk_\d+ [=≈]/.test(tc)) {
        refCount++;
        refChars += (typeof hist[i].content === 'string' ? hist[i].content.length : 0);
    }
});
console.log(`\nTotal references emitted before cp${CP}: ${refCount} (collapsing ${(refChars / 1000).toFixed(0)}K chars of full text)`);
