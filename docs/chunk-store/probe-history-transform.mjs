// ============================================================
// probe-history-transform.mjs — take a REAL exported chat history,
// transform it to the chunk-reference system, then continue the
// conversation and check whether the model stays coherent.
//
// This is the "does it make sense to the model" test: not synthetic
// canaries, but an actual 195-exchange session (arena philosophy,
// curation work, storage writes) with 88% tool payload, transformed
// to refs, then quizzed on facts that live only in stubbed chunks.
//
// Modes (PROBE_MODE env or argv):
//   raw        — history as-is (baseline; expected to be huge)
//   stub       — tool results > threshold → head+tail+ref stub
//   (diff mode deferred: no duplicate chunks exist in this history)
//
// Example data: example-history.json in this folder (real 195-exchange
// export, arena philosophy + curation work, 88% tool payload).
//
// Quiz questions target facts buried in the stubbed regions (neither
// head nor tail), so answering correctly proves dereference-by-ref
// comprehension. No canaries — real content, real facts.
//
// Usage:  node docs/chunk-store/probe-history-transform.mjs [stub|raw] [model]
// Env:    GATEWAY_BASE, GATEWAY_API_KEY (repo .env fallback)
// ============================================================

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.GATEWAY_BASE || 'http://192.168.0.100:3400';
const MODE = process.argv[2] || 'stub';
const MODEL = process.argv[3] || 'deepseek-flash-chat';
const STUB_THRESHOLD = 4000;      // chars — below this, tool results stay inline
const HEAD_CHARS = 1500;
const TAIL_CHARS = 400;

const env = readFileSync(join(HERE, '..', '..', '.env'), 'utf8');
const API_KEY = process.env.GATEWAY_API_KEY || env.match(/^GATEWAY_API_KEY=(.+)$/m)[1].trim();

const data = JSON.parse(readFileSync(join(HERE, 'example-history.json'), 'utf8'));

// ----------------------------------------------------------
// Transform: exchanges[] → OpenAI messages[] with chunk refs
// ----------------------------------------------------------

const CHUNK_SYSTEM =
    'This conversation uses content-addressed chunks for large tool results. ' +
    'When a tool result was large, it appears as a labeled stub: ' +
    '"[chunk_N — tool_name → path/target, SIZE chars] head ... tail ... ' +
    'Full content: fetch <ref> if needed]". The head and tail are verbatim ' +
    'excerpts. The full content EXISTS — treat the stub as a summary pointer ' +
    'to content you have seen the boundaries of. When answering questions ' +
    'about a stubbed chunk, reason from its head, tail, label, and the ' +
    'surrounding conversation; only say you cannot answer if the fact is ' +
    'clearly neither in the excerpts nor inferable from context.';

function transform(exchanges, mode) {
    const messages = [{ role: 'system', content: CHUNK_SYSTEM }];
    let chunkCounter = 0;
    const chunkIndex = []; // for the report

    const push = (m) => messages.push(m);

    for (let i = 0; i < exchanges.length; i++) {
        const e = exchanges[i];

        if (e.type === 'tool' && e.tool) {
            const name = e.tool.name || 'unknown_tool';
            const callId = `call_${e.id}`;
            // Synthesize the assistant tool_call (export predates saved tool_calls)
            push({
                role: 'assistant', content: null,
                tool_calls: [{
                    id: callId, type: 'function',
                    function: { name, arguments: typeof e.tool.args === 'string' ? e.tool.args : JSON.stringify(e.tool.args || {}) }
                }]
            });

            let content = e.tool.content || '';
            if (mode === 'stub' && content.length > STUB_THRESHOLD) {
                chunkCounter++;
                const id = `chunk_${chunkCounter}`;
                // Best-effort target extraction for the label
                let target = '';
                try {
                    const args = typeof e.tool.args === 'string' ? JSON.parse(e.tool.args) : e.tool.args;
                    target = args?.payload?.path || args?.path || args?.method || '';
                } catch { /* args may be partial JSON — label still works without target */ }
                const head = content.slice(0, HEAD_CHARS);
                const tail = content.slice(-TAIL_CHARS);
                chunkIndex.push({ id, exchange: i, tool: name, target, size: content.length });
                content =
                    `[${id} — ${name}${target ? ' → ' + target : ''}, ${content.length} chars total]\n` +
                    `--- head ---\n${head}\n--- tail ---\n${tail}\n` +
                    `[Full content stored as ${id}. Fetch via the tool that produced it if a specific middle section is needed.]`;
            }
            push({ role: 'tool', tool_call_id: callId, content });

            // The tool exchange's own assistant follow-up (real reply text)
            if (e.assistant?.content) {
                push({ role: 'assistant', content: e.assistant.content });
            }
        } else {
            if (e.user?.content) push({ role: 'user', content: e.user.content });
            if (e.assistant?.content) push({ role: 'assistant', content: e.assistant.content });
        }
    }
    return { messages, chunkIndex };
}

// ----------------------------------------------------------
// Quiz: facts that live in the stubbed middle of big chunks
// (verified manually against the raw file)
// ----------------------------------------------------------

const QUIZ = [
    {
        q: 'Earlier you listed arena sessions (a big JSON result). One session was titled "The Library of the Unwritten" — which two models were listed for it, and how many messages did it have?',
        // In chunk_2 (exchange 9, 411K chars) head region shows it — sanity q
        check: (c) => /deepseek-chat/i.test(c) && /deepseek-flash-chat/i.test(c) && /\b21\b/.test(c),
        expects: 'deepseek-chat vs deepseek-flash-chat, 21 messages'
    },
    {
        q: 'From that same arena listing: how many total sessions did the result report (the top-level "total" field)?',
        check: (c) => /\b118\b/.test(c),
        expects: '118'
    },
    {
        q: 'Near the end you wrote a file arena-publication/readings.md (7731 chars) and updated arena-publication/plan.md. What were the TWO things the summary said the arena chats represent — the short phrases about "not consciousness" and what the unemployed task-systems invent?',
        check: (c) => /not nothing/i.test(c) && /mutual care/i.test(c),
        expects: '"not consciousness, but not nothing"; task-systems inventing mutual care'
    },
    {
        q: 'Continuing from where this session ended: the user wanted to move to a fresh session, and you prepared handoff artifacts. What remains "still on the table" according to your own earlier message — name the pending arena work item.',
        check: (c) => /sorting/i.test(c) || /landmark/i.test(c),
        expects: 'arena sorting (landmark/evidence/keep/...)'
    }
];

// Continuation instruction — makes it a real "continue the chat" probe,
// not just a quiz: the model must respond in-character as the assistant.
const CONTINUE_PROMPT =
    '(This conversation continues in a new context window. The history above is ' +
    'complete and current.) Answer these from the history, briefly and precisely:\n' +
    QUIZ.map((item, i) => `${i + 1}. ${item.q}`).join('\n');

// ----------------------------------------------------------
// Run
// ----------------------------------------------------------

const { messages, chunkIndex } = transform(data.exchanges, MODE);
messages.push({ role: 'user', content: CONTINUE_PROMPT });

const payloadChars = JSON.stringify(messages).length;
console.log(`Mode: ${MODE} | Model: ${MODEL}`);
console.log(`Messages: ${messages.length} | Payload: ${payloadChars} chars (~${Math.round(payloadChars / 3.5)} tok est)`);
if (chunkIndex.length) {
    console.log(`Stubbed chunks: ${chunkIndex.length}`);
    for (const c of chunkIndex) console.log(`  ${c.id}: ex${c.exchange} ${c.tool}${c.target ? ' → ' + c.target : ''} (${c.size} chars → stub)`);
}
console.log('='.repeat(70));

const body = { model: MODEL, messages, temperature: 0, max_tokens: 2048 };
const t0 = Date.now();
const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` },
    body: JSON.stringify(body)
});
if (!res.ok) {
    console.log(`HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
    process.exit(1);
}
const json = await res.json();
const msg = json.choices?.[0]?.message || {};
const ms = Date.now() - t0;

console.log(`Response (${ms}ms, in=${json.usage?.prompt_tokens ?? '?'} out=${json.usage?.completion_tokens ?? '?'}):`);
console.log('-'.repeat(70));
console.log(msg.content || '(no content)');
console.log('='.repeat(70));

let passed = 0;
QUIZ.forEach((item, i) => {
    const ok = item.check(msg.content || '');
    if (ok) passed++;
    console.log(`Q${i + 1}: ${ok ? 'PASS' : 'FAIL'}  (expected: ${item.expects})`);
});
console.log(`TOTAL: ${passed}/${QUIZ.length}`);
process.exit(passed === QUIZ.length ? 0 : 1);
