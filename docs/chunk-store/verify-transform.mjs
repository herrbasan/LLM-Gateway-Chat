// verify-transform.mjs — offline savings verification over the corpus.
// No model calls: build the chunk view at several history depths per file,
// report raw vs transformed bytes and where the savings come from.
import { readFileSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { buildChunkView } from './chunk-view.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FILTER = process.argv[2] || '';

function exchangesToMessages(exchanges) {
    const messages = [];
    for (const e of exchanges) {
        if (e.type === 'tool' && e.tool) {
            const callId = `call_${String(e.id).replace(/[^a-zA-Z0-9_-]/g, '')}`;
            messages.push({
                role: 'assistant', content: null,
                tool_calls: [{ id: callId, type: 'function', function: { name: e.tool.name || 'unknown_tool', arguments: typeof e.tool.args === 'string' ? e.tool.args : JSON.stringify(e.tool.args || {}) } }]
            });
            if (e.tool.status === 'success' || e.tool.status === 'error') messages.push({ role: 'tool', tool_call_id: callId, content: e.tool.content || '' });
            if (e.assistant?.content) messages.push({ role: 'assistant', content: e.assistant.content });
        } else {
            if (e.user?.content) messages.push({ role: 'user', content: e.user.content });
            if (e.assistant?.content) messages.push({ role: 'assistant', content: e.assistant.content });
        }
    }
    return messages;
}

const files = readdirSync(join(HERE, 'corpus')).filter(f => f.endsWith('.json') && !f.includes('(1)') && f.includes(FILTER));
for (const file of files) {
    const d = JSON.parse(readFileSync(join(HERE, 'corpus', file), 'utf8'));
    const messages = exchangesToMessages(d.exchanges || []);
    // full-history transform (final state = what the LAST request would send)
    const { stats } = buildChunkView(messages);
    const saved = stats.bytesIn ? Math.round((1 - stats.bytesOut / stats.bytesIn) * 100) : 0;
    console.log(
        file.replace('direct-', '').slice(0, 44).padEnd(46),
        `msgs=${String(messages.length).padStart(4)}`,
        `in=${(stats.bytesIn / 1000).toFixed(0).padStart(5)}K`,
        `out=${(stats.bytesOut / 1000).toFixed(0).padStart(5)}K`,
        `saved=${String(saved).padStart(3)}%`,
        `exact=${stats.exactDupes} near=${stats.nearDupes} diffs=${stats.diffs} rebase=${stats.rebases} reorder=${stats.reorderFallbacks} depth=${stats.maxDepth}`
    );
}
