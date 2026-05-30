// ============================================
// analyze-arena-dupes.js — READ-ONLY analysis
// Run from project root:
//   node _Archive/analyze-arena-dupes.js "\\BADKID\Stuff\SRV\LLM-Gateway-Chat\server\data\chat_user"
// Or locally:
//   node _Archive/analyze-arena-dupes.js server/data/chat_user
// ============================================

const path = require('path');
const fs = require('fs');
const { Database: nDB } = require('../lib/ndb/napi');

const dataPath = process.argv[2];
if (!dataPath) {
    console.error('Usage: node analyze-arena-dupes.js <path/to/chat_user/data.jsonl>');
    process.exit(1);
}

const dbFile = path.resolve(dataPath, 'data.jsonl');
if (!fs.existsSync(dbFile)) {
    console.error('Database not found at:', dbFile);
    process.exit(1);
}

console.log('Opening database (read-only)...');
const db = nDB.open(dbFile);

// Find all arena sessions
const allSessions = db.find('_type', 'session');
const arenaSessions = allSessions.filter(s => s.mode === 'arena');

console.log(`\nTotal sessions: ${allSessions.length}`);
console.log(`Arena sessions: ${arenaSessions.length}`);
console.log(`Direct chats: ${allSessions.length - arenaSessions.length}`);

// Group arena sessions by topic + model combination to find duplicates
const groups = new Map();
for (const s of arenaSessions) {
    const modelA = s.arenaConfig?.modelA || '?';
    const modelB = s.arenaConfig?.modelB || '?';
    const title = s.title || 'Untitled';
    // Group by title + model pair + message count (exact match for duplicates)
    const key = `${title}|||${modelA}|||${modelB}|||${s.messageCount || 0}`;

    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
}

// Find groups with duplicates (>1 session with same title/models/msgCount)
const dupes = [...groups.entries()].filter(([_, sessions]) => sessions.length > 1);

console.log(`\n=== DUPLICATE GROUPS: ${dupes.length} ===\n`);

for (const [key, sessions] of dupes) {
    const [title, modelA, modelB, msgCount] = key.split('|||');
    console.log(`Group: "${title}" (${modelA} vs ${modelB}, ${msgCount} msgs)`);
    console.log(`  Duplicates: ${sessions.length}`);

    // Sort by createdAt to identify the original vs copies
    const sorted = [...sessions].sort((a, b) =>
        new Date(a.createdAt) - new Date(b.createdAt)
    );

    for (const s of sorted) {
        const convs = db.find('id', s.id).filter(d => d._type === 'conversation');
        const actualMsgs = convs.length > 0 ? (convs[0].messages?.length || 0) : '?';
        console.log(`    id: ${s.id}`);
        console.log(`      created: ${s.createdAt}, updated: ${s.updatedAt}`);
        console.log(`      title: "${s.title}", msgs in session: ${s.messageCount}, actual msgs: ${actualMsgs}`);
        // Check if it has a summary
        if (s.summary) {
            console.log(`      summary: YES (title: "${s.summary.title || '?'}")`);
        } else {
            console.log(`      summary: none`);
        }
    }
    console.log();
}

// Summary stats
console.log('=== SUMMARY ===');
console.log(`Total arena sessions: ${arenaSessions.length}`);
console.log(`Duplicate groups: ${dupes.length}`);
const totalDupeExtra = dupes.reduce((sum, [_, sessions]) => sum + sessions.length - 1, 0);
console.log(`Extra duplicate sessions (that could be removed): ${totalDupeExtra}`);
console.log(`Clean arena sessions (keeping only originals): ${arenaSessions.length - totalDupeExtra}`);

// Also list ALL arena sessions sorted by creation time for quick overview
console.log('\n=== ALL ARENA SESSIONS (sorted by creation time) ===\n');
const allSorted = [...arenaSessions].sort((a, b) =>
    new Date(a.createdAt) - new Date(b.createdAt)
);
for (const s of allSorted) {
    const modelA = s.arenaConfig?.modelA || '?';
    const modelB = s.arenaConfig?.modelB || '?';
    console.log(`${s.createdAt} | ${s.id} | "${s.title?.substring(0, 60) || '?'}" | ${modelA} vs ${modelB} | ${s.messageCount} msgs${s.summary ? ' | HAS_SUMMARY' : ''}`);
}

console.log('\nDone. No changes were made to the database.');
