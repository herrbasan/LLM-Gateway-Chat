const EMBEDDING_DIMS = parseInt(process.env.CHAT_EMBED_DIMS || 2560);
const BATCH_TOKEN_LIMIT = parseInt(process.env.CHAT_EMBED_BATCH_TOKENS || 29000);
const MAX_SINGLE_TEXT_TOKENS = parseInt(process.env.CHAT_EMBED_MAX_TOKENS || 30000);
const TOK_CHARS_RATIO = parseFloat(process.env.CHAT_EMBED_TOK_RATIO || 2.5);

function buildEmbedText(msg, session) {
    const parts = [];
    if (session?.mode === 'arena') {
        parts.push(`[Arena: ${(session.title || '').slice(0, 60)}]`);
        if (msg.speaker) parts.push(`[${msg.speaker}]`);
    } else {
        parts.push(`[Chat: ${(session?.title || '').slice(0, 60)}]`);
        parts.push(`[${msg.role}]`);
    }
    if (msg.model) parts.push(`[${msg.model}]`);
    parts.push(msg.content || '');
    return parts.join(' ');
}

function chunkTextForEmbedding(originalItem, logger) {
    let textToProcess = originalItem.text;
    const maxChars = Math.floor(MAX_SINGLE_TEXT_TOKENS * TOK_CHARS_RATIO);
    let splitIdx = 0;
    let charCursor = 0;
    const chunks = [];

    while (textToProcess.length > 0) {
        let chunkText = textToProcess.slice(0, maxChars);
        textToProcess = textToProcess.slice(maxChars);
        
        const chunkTokEst = Math.ceil(chunkText.length / TOK_CHARS_RATIO);
        
        const item = {
            msg: originalItem.msg,
            text: chunkText,
            tokEst: chunkTokEst,
            splitIdx: splitIdx++,
            charOffset: charCursor,
            isLastChunk: textToProcess.length === 0
        };
        charCursor += chunkText.length;

        if (item.splitIdx > 0 && logger) {
            logger.info('Split huge message', { msgId: item.msg.id.slice(-20), splitIdx: item.splitIdx, chars: chunkText.length, estTok: chunkTokEst }, 'Embed');
        }

        chunks.push(item);
    }
    return chunks;
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchRetry(url, options, retries) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            // Add a generous 30-minute timeout for massive 25k-token chunks
            const res = await fetch(url, { ...options, signal: AbortSignal.timeout(30 * 60 * 1000), body: JSON.stringify(options.body) });
            if (!res.ok) {
                const err = await res.text().catch(() => 'unknown');
                throw new Error(`${res.status}: ${err.slice(0, 200)}`);
            }
            const data = await res.json();
            if (data.error) {
                throw new Error(data.error.message || JSON.stringify(data.error).slice(0, 200));
            }
            return data;
        } catch (err) {
            lastErr = err;
            if (attempt < retries) {
                const wait = Math.min(1000 * Math.pow(2, attempt), 10000);
                console.log(`\n  Retry ${attempt + 1}/${retries} in ${wait / 1000}s...`);
                await sleep(wait);
            }
        }
    }
    throw lastErr;
}

module.exports = {
    buildEmbedText,
    chunkTextForEmbedding,
    fetchRetry,
    EMBEDDING_DIMS,
    BATCH_TOKEN_LIMIT,
    MAX_SINGLE_TEXT_TOKENS,
    TOK_CHARS_RATIO,
    sleep
};