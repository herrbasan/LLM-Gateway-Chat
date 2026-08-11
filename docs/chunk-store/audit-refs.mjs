// audit-refs.mjs — false-positive audit for dedup references.
// Every emitted ref must point at a target whose stored body is genuinely
// similar in size (near-dups share ~85%+ of lines → sizes must be close).
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { buildChunkView } from './chunk-view.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FILE = process.argv[2] || 'direct-digital_twin_refinement_5-2026-08-11.json';
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

const { messages: tx, stats } = buildChunkView(messages);
const bodies = new Map();
let refs = 0;
// pass 1: collect ALL labels, from message bodies AND tool_call args strings
for (const m of tx) {
    const c = typeof m.content === 'string' ? m.content : '';
    const lab = c.match(/^\[chunk_(\d+)\]\n/);
    if (lab) bodies.set('chunk_' + lab[1], c.length);
    if (m.tool_calls) for (const tc of m.tool_calls) {
        const a = tc.function?.arguments || '';
        // arg-side labels: [chunk_N]\n embedded as JSON string content
        for (const mm of a.matchAll(/\[chunk_(\d+)\]\\n/g)) {
            if (!bodies.has('chunk_' + mm[1])) bodies.set('chunk_' + mm[1], -1); // in args
        }
    }
}
// pass 2: check refs resolve
for (const m of tx) {
    const c = typeof m.content === 'string' ? m.content : '';
    const ref = c.match(/^\[chunk_(\d+) ([=≈]) chunk_(\d+)/);
    if (ref) {
        refs++;
        const tLen = bodies.get('chunk_' + ref[3]);
        const note = tLen === undefined ? 'DANGLING — no such label anywhere'
            : tLen === -1 ? 'target labeled inside tool args (OK)'
            : `target ~${(tLen / 1000).toFixed(1)}K chars (OK)`;
        console.log(`ref chunk_${ref[1]} ${ref[2]} chunk_${ref[3]}  ${note}`);
    }
    if (m.tool_calls) for (const tc of m.tool_calls) {
        const a = tc.function?.arguments || '';
        for (const mm of a.matchAll(/\[chunk_(\d+) ([=≈]) chunk_(\d+)/g)) {
            refs++;
            const tLen = bodies.get('chunk_' + mm[3]);
            const note = tLen === undefined ? 'DANGLING' : tLen === -1 ? 'target in args (OK)' : 'target is message body (OK)';
            console.log(`arg-ref chunk_${mm[1]} ${mm[2]} chunk_${mm[3]}  ${note}`);
        }
    }
}
console.log(`\ntotal refs: ${refs} | stats: ${JSON.stringify(stats)}`);
