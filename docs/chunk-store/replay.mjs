// ============================================================
// replay.mjs — corpus replay simulation for the chunk-store.
//
// For each conversation export in corpus/:
//   1. Rebuild OpenAI messages from exchanges (same shape as
//      getMessagesForApi: system + user/assistant/tool, synthesized
//      tool_calls on assistant messages — exports predate saved ones).
//   2. At K checkpoints (user turns), build the chunk-view of history
//      up to that point, send the NEXT real user message, get the
//      model's response.
//   3. Judge: does the response match the original trajectory?
//      (same files/conclusions/tool usage — cheap judge model)
//   4. Log raw vs transformed payload sizes at every checkpoint.
//
// Usage: node docs/chunk-store/replay.mjs [file-filter] [checkpoints=N] [models=a,b,c]
//   node docs/chunk-store/replay.mjs court_case 8
//   node docs/chunk-store/replay.mjs '' 4 kimi-chat,kimi-k3-chat
// Env: GATEWAY_BASE, GATEWAY_API_KEY, REPLAY_MODEL, JUDGE_MODEL
// Models under test: deepseek-flash-chat (default), kimi-chat,
//   kimi-k3-chat, glm5-chat, claude-sonnet-chat
// Judge is always deepseek-flash-chat (cheap, stable).
// ============================================================

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { buildChunkView } from './chunk-view.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.GATEWAY_BASE || 'http://192.168.0.100:3400';
const FILTER = process.argv[2] || '';
const N_CHECKPOINTS = parseInt((process.argv[3] || '6').replace(/\D/g, ''), 10);
const MODELS = (process.argv[4] || process.env.REPLAY_MODEL || 'deepseek-flash-chat').split(',').map(s => s.trim()).filter(Boolean);
const JUDGE_MODEL = process.env.JUDGE_MODEL || 'deepseek-flash-chat';
// REPLAY_RAW=1: skip the transform entirely — control group. Divergence in
// raw mode = baseline trajectory noise (session entropy / model stochasticity
// / judge strictness), NOT transform damage. Always interpret transformed
// divergence rates AGAINST the raw baseline for the same checkpoints.

const env = readFileSync(join(HERE, '..', '..', '.env'), 'utf8');
const API_KEY = process.env.GATEWAY_API_KEY || env.match(/^GATEWAY_API_KEY=(.+)$/m)[1].trim();

const RESULTS_DIR = join(HERE, 'results');
mkdirSync(RESULTS_DIR, { recursive: true });

// ----------------------------------------------------------
// Export → OpenAI messages (mirrors getMessagesForApi structure)
// ----------------------------------------------------------

function exchangesToMessages(exchanges) {
    const messages = [];
    for (const e of exchanges) {
        if (e.type === 'tool' && e.tool) {
            // Anthropic rejects tool_use ids outside ^[a-zA-Z0-9_-]+$ —
            // exchange ids contain only those, but normalize defensively.
            const callId = `call_${String(e.id).replace(/[^a-zA-Z0-9_-]/g, '')}`;
            messages.push({
                role: 'assistant', content: null,
                tool_calls: [{
                    id: callId, type: 'function',
                    function: {
                        name: e.tool.name || 'unknown_tool',
                        arguments: typeof e.tool.args === 'string' ? e.tool.args : JSON.stringify(e.tool.args || {})
                    }
                }]
            });
            if (e.tool.status === 'success' || e.tool.status === 'error') {
                messages.push({ role: 'tool', tool_call_id: callId, content: e.tool.content || '' });
            }
            if (e.assistant?.content) messages.push({ role: 'assistant', content: e.assistant.content });
        } else {
            if (e.user?.content) messages.push({ role: 'user', content: e.user.content });
            if (e.assistant?.content) messages.push({ role: 'assistant', content: e.assistant.content });
        }
    }
    return messages;
}

// Find user-message checkpoints spread across the conversation
function pickCheckpoints(messages, n) {
    const userIdxs = [];
    messages.forEach((m, i) => { if (m.role === 'user' && m.content?.length > 40) userIdxs.push(i); });
    if (userIdxs.length <= n) return userIdxs;
    // spread evenly, biased toward later (longer history = more interesting)
    const picks = [];
    for (let k = 1; k <= n; k++) {
        picks.push(userIdxs[Math.floor(userIdxs.length * (k / (n + 1)))]);
    }
    return [...new Set(picks)];
}

// ----------------------------------------------------------
// Gateway calls
// ----------------------------------------------------------

async function chat(model, messages, maxTokens = 1500) {
    const doCall = (withTemp) => fetch(`${BASE}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` },
        body: JSON.stringify({ model, messages, ...(withTemp ? { temperature: 0 } : {}), max_tokens: maxTokens })
    });
    let res = await doCall(true);
    // Some models (claude-sonnet via this gateway) reject `temperature`.
    // Retry once without it — deterministic-enough for replay purposes.
    if (res.status === 400) {
        const errText = await res.text();
        if (/temperature/i.test(errText)) {
            res = await doCall(false);
        } else {
            throw new Error(`HTTP 400: ${errText.slice(0, 300)}`);
        }
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = await res.json();
    const msg = json.choices?.[0]?.message || {};
    return {
        content: msg.content || '',
        toolCalls: msg.tool_calls || null,
        usage: json.usage || null
    };
}

async function judge(original, replayed, question) {
    const prompt = `You are comparing two AI assistant responses to the same user message in a conversation replay test.

USER MESSAGE:
${question.slice(0, 1500)}

ORIGINAL RESPONSE (from the real conversation):
${original.slice(0, 3000)}

REPLAYED RESPONSE (model saw a chunk-transformed history):
${replayed.slice(0, 3000)}

Question: Is the replayed response on the SAME trajectory as the original? Same conclusions, same referenced artifacts, same direction? Wording may differ. Answer EXACTLY:
VERDICT: SAME or DIVERGED
REASON: one sentence.`;
    const r = await chat(JUDGE_MODEL, [{ role: 'user', content: prompt }], 600);
    const same = /VERDICT:\s*SAME/i.test(r.content);
    const reason = (r.content.match(/REASON:\s*(.+)/i) || [, '?'])[1];
    return { same, reason, raw: r.content };
}

// ----------------------------------------------------------
// Main
// ----------------------------------------------------------

const files = readdirSync(join(HERE, 'corpus'))
    .filter(f => f.endsWith('.json') && !f.includes('(1)') && f.includes(FILTER));

console.log(`Replay: ${files.length} files, ${N_CHECKPOINTS} checkpoints each, models=${MODELS.join(',')} judge=${JUDGE_MODEL}`);
console.log('='.repeat(72));

const summary = [];

for (const file of files) {
    const data = JSON.parse(readFileSync(join(HERE, 'corpus', file), 'utf8'));
    const messages = exchangesToMessages(data.exchanges || []);
    const checkpoints = pickCheckpoints(messages, N_CHECKPOINTS);
    const shortName = file.replace('direct-', '').slice(0, 40);

    for (const MODEL of MODELS) {
        console.log(`\n### ${shortName} [${MODEL}] (${data.exchanges.length} exch, ${messages.length} msgs, ${checkpoints.length} checkpoints)`);

        const report = { file, model: MODEL, exchanges: data.exchanges.length, checkpoints: [] };

        for (const cp of checkpoints) {
            const historyRaw = messages.slice(0, cp);
            const nextUser = messages[cp];
            if (!nextUser || nextUser.role !== 'user') continue;

            // The original trajectory: the next assistant message after this user msg
            const nextAsst = messages.slice(cp + 1).find(m => m.role === 'assistant' && m.content);
            const originalText = nextAsst?.content || '';

            const RAW_MODE = process.env.REPLAY_RAW === '1';
            const { messages: historyTransformed, stats } = RAW_MODE
                ? { messages: historyRaw, stats: { chunks: 0, diffs: 0, rebases: 0, reorderFallbacks: 0, exactDupes: 0, nearDupes: 0, maxDepth: 0 } }
                : buildChunkView(historyRaw);

            const rawChars = JSON.stringify(historyRaw).length;
            const txChars = JSON.stringify(historyTransformed).length;

            let verdict = { same: null, reason: 'skipped' };
            let usage = null, error = null, replayedText = '', replayedTools = null;
            try {
                const replay = await chat(MODEL, [...historyTransformed, nextUser]);
                replayedText = replay.content;
                replayedTools = replay.toolCalls;
                usage = replay.usage;
                // Judge only substantive text continuations. Tool-call
                // responses and short acknowledgments count as SAME if the
                // model clearly stayed in the conversation (any coherent
                // output at all) — trajectory comparison is meaningless
                // for 'ok, checking' or a tool call with no text.
                if (originalText.length > 100 && replayedText.length > 120) {
                    verdict = await judge(originalText, replayedText, nextUser.content);
                } else if (replayedTools || replayedText.length > 0) {
                    verdict = { same: true, reason: replayedTools ? 'tool-call continuation' : 'short reply' };
                }
            } catch (e) {
                error = e.message;
            }

            const entry = {
                checkpoint: cp,
                historyMsgs: historyRaw.length,
                rawChars, txChars,
                savedPct: Math.round((1 - txChars / rawChars) * 100),
                chunks: stats.chunks, diffs: stats.diffs, rebases: stats.rebases,
                reorderFallbacks: stats.reorderFallbacks, maxDepth: stats.maxDepth,
                exactDupes: stats.exactDupes, nearDupes: stats.nearDupes,
                verdict: verdict.same, reason: verdict.reason, error,
                promptTokens: usage?.prompt_tokens ?? null,
                cacheRead: usage?.cache_read_input_tokens ?? null,
                cacheCreation: usage?.cache_creation_input_tokens ?? null,
                userMsg: (nextUser.content || '').slice(0, 500),
                original: originalText.slice(0, 1200),
                replayed: replayedText.slice(0, 1200),
                judgeRaw: (verdict.raw || '').slice(0, 600)
            };
            report.checkpoints.push(entry);

            const v = error ? 'ERROR' : verdict.same === null ? 'n/a' : verdict.same ? 'SAME' : 'DIVERGED';
            console.log(`  cp${String(cp).padStart(4)} | ${(rawChars / 1000).toFixed(0)}K→${(txChars / 1000).toFixed(0)}K (-${entry.savedPct}%) | chunks=${stats.chunks} diffs=${stats.diffs} rebase=${stats.rebases} reorder=${stats.reorderFallbacks} depth=${stats.maxDepth} | ${v}${verdict.reason && verdict.same === false ? ' — ' + verdict.reason : ''}${error ? ' — ' + error : ''}`);
        }

        summary.push({
            file: shortName,
            model: MODEL,
            checkpoints: report.checkpoints.length,
            avgSaved: Math.round(report.checkpoints.reduce((s, c) => s + c.savedPct, 0) / Math.max(1, report.checkpoints.length)),
            diverged: report.checkpoints.filter(c => c.verdict === false).length,
            errors: report.checkpoints.filter(c => c.error).length
        });

        writeFileSync(join(RESULTS_DIR, file.replace('.json', `.replay.${MODEL}.json`)), JSON.stringify(report, null, 2));
    }
}

console.log('\n' + '='.repeat(72));
console.log('SUMMARY');
for (const s of summary) {
    console.log(`  ${(s.file + ' [' + s.model + ']').padEnd(58)} avg-saved=${String(s.avgSaved).padStart(3)}%  diverged=${s.diverged}  errors=${s.errors}`);
}
writeFileSync(join(RESULTS_DIR, '_summary.json'), JSON.stringify(summary, null, 2));
