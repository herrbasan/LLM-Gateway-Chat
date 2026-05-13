// ============================================
// heal-embed.js — backfill missing nVDB vectors
// for a session, with reconciliation built in
// Usage: node server/heal-embed.js [sessionId]
// ============================================

const path = require('path');
const fs = require('fs');
const { Database: nDB } = require('../lib/ndb/napi');
const { Database: nVDB } = require('../lib/nvdb/napi');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const EMBED_URL = process.env.CHAT_EMBED_URL || cfg.embedUrl || 'http://192.168.0.100:3400/v1/embeddings';
const EMBED_MODEL = process.env.CHAT_EMBED_MODEL || cfg.embedModel || null;
const EMBED_DIMS = parseInt(process.env.CHAT_EMBED_DIMS || cfg.embedDims) || 2560;
const EMBED_TOK_RATIO = parseFloat(process.env.CHAT_EMBED_TOK_RATIO || cfg.embedTokRatio) || 2.5;
const EMBED_MAX_TOKENS = parseInt(process.env.CHAT_EMBED_MAX_TOKENS || cfg.embedMaxTokens) || 30000;

const sessionId = process.argv[2] || 'chat_1778252213933_b2c90w5vo';

console.log('Opening nDB...');
const db = nDB.open(process.env.CHAT_NDB_PATH || 'server/data/chat_app');
console.log('Opening nVDB...');
const vdb = new nVDB(process.env.CHAT_NVDB_DIR || 'server/data/nvdb');
const col = vdb.getCollection('embeddings');

// Find the conversation doc
const convs = db.find('id', sessionId).filter(d => d._type === 'conversation');
if (convs.length === 0) {
    console.error('No conversation found for', sessionId);
    process.exit(1);
}
const conv = convs[0];
const sessions = {};
for (const s of db.find('_type', 'session')) sessions[s.id] = s;

console.log('Conversation:', sessionId, '| Messages:', conv.messages?.length || 0);

// Build embed text (same as server.js)
function buildEmbedText(msg, session) {
    const parts = [];
    if (session?.mode === 'arena') {
        parts.push(`[Arena: ${(session.title || '').slice(0, 60)}]`);
        if (msg.speaker) parts.push(`[${msg.speaker}]`);
    } else {
        parts.push(`[Chat: ${(session.title || '').slice(0, 60)}]`);
        parts.push(`[${msg.role}]`);
    }
    if (msg.model) parts.push(`[${msg.model}]`);
    parts.push(msg.content || '');
    return parts.join(' ');
}

function middleTruncate(text) {
    const estTok = Math.ceil(text.length / EMBED_TOK_RATIO);
    if (estTok <= EMBED_MAX_TOKENS) return text;
    const maxChars = Math.floor(EMBED_MAX_TOKENS * EMBED_TOK_RATIO);
    const headLen = Math.floor(maxChars * 0.4);
    const tailLen = maxChars - headLen;
    return text.slice(0, headLen) + '\n\n[... truncated middle ...]\n\n' + text.slice(-tailLen);
}

async function embedText(text) {
    const reqBody = { input: [text], dimensions: EMBED_DIMS };
    if (EMBED_MODEL) reqBody.model = EMBED_MODEL;
    const res = await fetch(EMBED_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reqBody)
    });
    if (!res.ok) throw new Error(`Embed ${res.status}: ${await res.text().catch(() => '')}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    return data.data?.[0]?.embedding;
}

async function main() {
    let missing = 0, embedded = 0, skipped = 0, failed = 0;

    for (let idx = 0; idx < conv.messages.length; idx++) {
        const msg = conv.messages[idx];

        // Check nVDB
        const hasVector = !!(col.get(msg.id));
        if (hasVector && (msg.embedStatus === 'embedded' || msg.embedStatus === 'ready')) {
            skipped++;
            continue;
        }

        missing++;
        console.log(`[${idx}/${conv.messages.length}] Embedding: role=${msg.role} id=${msg.id?.slice(0,30)}...`);

        try {
            const rawText = buildEmbedText(msg, sessions[sessionId] || {});
            const text = middleTruncate(rawText);
            const vector = await embedText(text);

            if (!Array.isArray(vector) || vector.length !== EMBED_DIMS) {
                throw new Error('invalid_vector_shape');
            }

            col.insert(msg.id, vector, JSON.stringify({
                chatId: sessionId, msgIdx: idx
            }));

            msg.embedStatus = 'embedded';
            msg.embedAttempts = 1;
            msg.embedError = null;
            embedded++;
            console.log(`  OK: ${vector.length}d, textLen=${text.length}`);

        } catch (err) {
            console.error(`  FAILED: ${err.message?.slice(0, 100)}`);
            msg.embedStatus = msg.embedStatus || 'failed';
            msg.embedAttempts = (msg.embedAttempts || 0) + 1;
            msg.embedError = (err.message || '').slice(0, 200);
            failed++;
        }
    }

    // Save updated status to nDB
    db.update(conv._id, conv);
    col.flush();

    console.log('\nDone:', { missing, embedded, skipped, failed });
    vdb.close();
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
