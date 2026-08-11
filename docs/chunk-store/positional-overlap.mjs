// positional-overlap.mjs — is corpus repetition DIFFABLE (positional) or not?
// For each corpus file: find same-chain consecutive large contents and
// measure (a) Jaccard line-set overlap, (b) what fraction a positional LCS
// diff would actually save. The gap between (a) and (b) is the reorder penalty.
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { jaccardLines, computeDiff } from './chunk-view.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FILE = process.argv[2] || 'direct-digital_twin___archived_writin-2026-08-11.json';
const d = JSON.parse(readFileSync(join(HERE, 'corpus', FILE), 'utf8'));

// collect large contents per chain-ish key (tool name + path-ish)
const groups = new Map();
d.exchanges.forEach((e, i) => {
    if (!e.tool) return;
    let pathKey = null, contents = [];
    try {
        const a = typeof e.tool.args === 'string' ? JSON.parse(e.tool.args) : e.tool.args;
        pathKey = a?.payload?.path || a?.path || a?.session_id || null;
        // content lives in args (writes) or result (reads)
        const argContent = a?.payload?.content || a?.content || null;
        if (typeof argContent === 'string' && argContent.length > 2000) contents.push(['args', argContent]);
    } catch { }
    if (typeof e.tool.content === 'string' && e.tool.content.length > 2000) contents.push(['result', e.tool.content]);
    const key = (e.tool.name || '?') + '|' + (pathKey || '?');
    if (!groups.has(key)) groups.set(key, []);
    for (const [where, text] of contents) groups.get(key).push({ i, where, text });
});

console.log('chain groups with 2+ large contents:');
for (const [key, items] of groups) {
    if (items.length < 2) continue;
    console.log(`\n${key}  (${items.length} versions)`);
    for (let k = 1; k < items.length; k++) {
        const prev = items[k - 1].text, cur = items[k].text;
        const jac = jaccardLines(prev, cur);
        let diffPct = null;
        if (prev.split('\n').length < 8000 && cur.split('\n').length < 8000) {
            const diff = computeDiff(prev, cur);
            diffPct = Math.round((1 - diff.length / cur.length) * 100);
        }
        console.log(`  ex${items[k - 1].i}→ex${items[k].i} [${items[k].where}]  jaccard=${jac.toFixed(2)}  diff-saves=${diffPct === null ? 'too big' : diffPct + '%'}  size=${(cur.length / 1000).toFixed(1)}K`);
    }
}
