// analyze-repetition.mjs — full-content overlap analysis of a chat export.
// For every message body (user/assistant/tool), find what's genuinely new
// vs repeated from earlier messages, using line-level and block-level
// similarity (not just exact hashes — near-dupes count).
//
// Usage: node docs/chunk-store/analyze-repetition.mjs [export.json]
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const HERE = dirname(fileURLToPath(import.meta.url));
const FILE = process.argv[2] || join(HERE, 'example-history.json');
const data = JSON.parse(readFileSync(FILE, 'utf8'));

// ---------- collect bodies ----------
const bodies = []; // { idx, kind, name, text }
data.exchanges.forEach((e, i) => {
    if (e.user?.content) bodies.push({ idx: i, kind: 'user', name: '', text: e.user.content });
    if (e.assistant?.content) bodies.push({ idx: i, kind: 'asst', name: '', text: e.assistant.content });
    if (e.tool?.content) bodies.push({ idx: i, kind: 'tool', name: e.tool.name || '', text: e.tool.content });
});

// ---------- overlap: what fraction of B's line-blocks already appeared in any earlier body? ----------
// Block = 3 consecutive non-empty lines (shingle). A block "repeats" if seen before.
function shingles(text) {
    const lines = text.split('\n').filter(l => l.trim().length > 0);
    const out = [];
    for (let i = 0; i + 3 <= lines.length; i++) out.push(lines.slice(i, i + 3).join('\n'));
    return { shingles: out, lineCount: lines.length };
}

const seen = new Map(); // shingle -> first body index
const report = [];
for (const b of bodies) {
    if (b.text.length < 800) continue; // small talk is cheap, skip
    const { shingles: sh, lineCount } = shingles(b.text);
    if (sh.length === 0) continue;
    let repeated = 0;
    const firstSeenIn = new Map(); // earlier body idx -> count
    for (const s of sh) {
        if (seen.has(s)) {
            repeated++;
            const src = seen.get(s);
            firstSeenIn.set(src, (firstSeenIn.get(src) || 0) + 1);
        } else {
            seen.set(s, b.idx + ':' + b.kind);
        }
    }
    const pct = Math.round((repeated / sh.length) * 100);
    // top source of repetition
    let topSrc = null, topN = 0;
    for (const [k, v] of firstSeenIn) if (v > topN) { topN = v; topSrc = k; }
    report.push({ idx: b.idx, kind: b.kind, name: b.name, chars: b.text.length, pct, topSrc, topN });
}

// ---------- print ----------
console.log(`Analyzing ${bodies.length} bodies from ${data.exchanges.length} exchanges\n`);
console.log('Bodies with >25% repeated content (3-line blocks seen earlier):');
console.log('idx  kind  name                            chars     %repeated  mostly-from');
let totalChars = 0, repeatedChars = 0;
for (const r of report) {
    totalChars += r.chars;
    const rep = Math.round(r.chars * r.pct / 100);
    repeatedChars += rep;
    if (r.pct > 25) {
        console.log(
            String(r.idx).padEnd(5),
            r.kind.padEnd(6),
            (r.name || '-').slice(0, 30).padEnd(32),
            String(r.chars).padEnd(10),
            String(r.pct + '%').padEnd(11),
            r.topSrc || '-'
        );
    }
}
console.log('\nAll bodies >800 chars:', report.length);
console.log('Total chars in analyzed bodies:', totalChars.toLocaleString());
console.log('Chars that are repetition of earlier content:', repeatedChars.toLocaleString(),
    '(' + Math.round(repeatedChars / totalChars * 100) + '%)');

// ---------- biggest pairwise overlaps for inspection ----------
console.log('\nTop 10 most-repeated bodies (by % of self that appeared earlier):');
[...report].sort((a, b) => b.pct - a.pct).slice(0, 10).forEach(r =>
    console.log(`  ex${r.idx} ${r.kind}${r.name ? '/' + r.name : ''} — ${r.pct}% repeated (${r.chars.toLocaleString()} chars, mostly from ${r.topSrc})`)
);
