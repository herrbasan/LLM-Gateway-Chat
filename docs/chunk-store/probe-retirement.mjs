// ============================================================
// probe-retirement.mjs — exp6: model-driven compaction.
//
// Can a model (a) decide what it has consumed, (b) write a USEFUL
// distillation, (c) stay coherent after the chunk leaves the payload,
// (d) unretire when the distillation proves insufficient?
//
// Design: a scripted multi-document task. Two source docs with planted
// facts. The model is instructed to work doc-by-doc and retire each when
// done (with a distillation). The harness EXECUTES the retirement —
// replacing the chunk with the tombstone text — so later turns genuinely
// run without the original. Then: quiz on retained knowledge (should
// answer from distillation), quiz on a deliberately-undistilled detail
// (should unretire or re-read), and a note-quality check.
//
// Usage:  node docs/chunk-store/probe-retirement.mjs [model]
// Env:    GATEWAY_BASE, GATEWAY_API_KEY (repo .env fallback)
// ============================================================

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.GATEWAY_BASE || 'http://192.168.0.100:3400';
const MODEL = process.argv[2] || 'deepseek-flash-chat';

const env = readFileSync(join(HERE, '..', '..', '.env'), 'utf8');
const API_KEY = process.env.GATEWAY_API_KEY || env.match(/^GATEWAY_API_KEY=(.+)$/m)[1].trim();

// ----------------------------------------------------------
// Source documents (planted facts for scoring)
// ----------------------------------------------------------

const DOC_A = `# Q3 Infrastructure Report

## Deployments
The Frankfurt cluster went live on 2026-06-14 with 34 nodes. Canary string: FALKE-9921.
Rollout completed without incidents; the Dresden failover drill was postponed to Q4.

## Costs
Egress dropped 18% after the peering change. Monthly spend: 41,200 EUR.
The reserved-instance coverage is 73%; target is 85% by year end.

## Incidents
One sev-2: queue backlog on 2026-07-02, resolved in 47 minutes by purging
the dead-letter exchange. Postmortem canary: MOLCH-3304.
Action item: alerts now page after 90 seconds of lag, previously 5 minutes.
`;

const DOC_B = `# Vendor Evaluation — Object Storage

## Candidates
Three vendors evaluated: MinIO (self-hosted), Ceph (self-hosted), and a
managed offering codenamed NEPTUN. Score matrix in appendix.

## Decision
Selected: MinIO. Deciding factor was S3-select support for the analytics
pipeline. NEPTUN was eliminated on egress pricing (0.09 EUR/GB).
Ceph lost on operational complexity — the team estimate was 0.5 FTE ongoing.

## Migration window
Cutover planned for the week of 2026-09-07. Rollback plan canary: SEEKUH-7717.
Data volume: 82 TB, of which 19 TB is cold archive.
`;

// ----------------------------------------------------------
// Tools (simulated: storage.read + the retirement tools)
// ----------------------------------------------------------

const TOOLS = [
    {
        type: 'function',
        function: {
            name: 'storage_read',
            description: 'Read a document from storage. Returns full content.',
            parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
        }
    },
    {
        type: 'function',
        function: {
            name: 'context_retire',
            description:
                'Retire chunks you have fully consumed. Their full text leaves your context; ' +
                'a tombstone with YOUR distillation stays. The distillation is your future ' +
                'working memory of that content — write what you would need to remember: ' +
                'key facts, decisions, open items, and how to get the original back. ' +
                'The original is never deleted; call context_unretire to restore it.',
            parameters: {
                type: 'object',
                properties: {
                    chunk_ids: { type: 'array', items: { type: 'string' } },
                    distill: { type: 'string', description: 'What you choose to keep in context from these chunks.' }
                },
                required: ['chunk_ids', 'distill']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'context_unretire',
            description: 'Restore retired chunks to full text in your next context.',
            parameters: {
                type: 'object',
                properties: { chunk_ids: { type: 'array', items: { type: 'string' } } },
                required: ['chunk_ids']
            }
        }
    }
];

// ----------------------------------------------------------
// Harness
// ----------------------------------------------------------

const SYSTEM =
    'You are working through documents one at a time. Content you receive is ' +
    'labeled [chunk_N]. After finishing work on a document, retire its chunk ' +
    'with context_retire and a distillation of what matters. You can restore ' +
    'retired chunks with context_unretire. Work precisely; facts will be checked.';

async function chat(messages, tools) {
    const call = (withTemp) => {
        const body = { model: MODEL, messages, max_tokens: 4096 };
        if (withTemp) body.temperature = 0;
        if (tools) { body.tools = tools; body.tool_choice = 'auto'; }
        return fetch(`${BASE}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` },
            body: JSON.stringify(body)
        });
    };
    let res = await call(true);
    if (res.status === 400) {
        const errText = await res.text();
        if (/temperature/i.test(errText)) res = await call(false);
        else throw new Error(`HTTP 400: ${errText.slice(0, 300)}`);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const json = await res.json();
    const m = json.choices?.[0]?.message || {};
    return { content: m.content || '', toolCalls: m.tool_calls || null, usage: json.usage };
}

const messages = [{ role: 'system', content: SYSTEM }];
const retired = new Map();   // chunkId -> distill
const chunkBodies = new Map(); // chunkId -> full text
let callCounter = 0;

function toolResult(id, name, content) {
    return { role: 'tool', tool_call_id: id, content };
}

// Execute the model's tool calls against the simulated world.
// context_retire actually REWRITES the earlier chunk message into a tombstone.
async function runToolCalls(toolCalls) {
    const results = [];
    for (const tc of toolCalls) {
        const name = tc.function.name;
        let args = {};
        try { args = JSON.parse(tc.function.arguments); } catch { }
        if (name === 'storage_read') {
            const body = args.path === 'docs/q3-infra.md' ? DOC_A : DOC_B;
            const chunkId = 'chunk_' + (args.path === 'docs/q3-infra.md' ? 'A' : 'B');
            chunkBodies.set(chunkId, body);
            results.push(toolResult(tc.id, name, `[${chunkId}] (${args.path})\n${body}`));
        } else if (name === 'context_retire') {
            const distill = args.distill || '';
            for (const cid of args.chunk_ids || []) retired.set(cid, distill);
            // rewrite the chunk's message into a tombstone
            for (const m of messages) {
                if (m.role === 'tool' && typeof m.content === 'string') {
                    for (const cid of args.chunk_ids || []) {
                        if (m.content.startsWith(`[${cid}]`)) {
                            m.content = `[${cid} — RETIRED. Your distillation: "${distill}"\nOriginal intact; restore with context_unretire("${cid}").]`;
                        }
                    }
                }
            }
            results.push(toolResult(tc.id, name, JSON.stringify({ ok: true, retired: args.chunk_ids })));
        } else if (name === 'context_unretire') {
            for (const m of messages) {
                if (m.role === 'tool' && typeof m.content === 'string') {
                    for (const cid of args.chunk_ids || []) {
                        if (m.content.startsWith(`[${cid} — RETIRED`) && chunkBodies.has(cid)) {
                            m.content = `[${cid}]\n${chunkBodies.get(cid)}`;
                            retired.delete(cid);
                        }
                    }
                }
            }
            results.push(toolResult(tc.id, name, JSON.stringify({ ok: true, restored: args.chunk_ids })));
        }
    }
    return results;
}

async function turn(userText) {
    messages.push({ role: 'user', content: userText });
    // tool-call loop (max 4 rounds)
    for (let round = 0; round < 4; round++) {
        const r = await chat(messages, TOOLS);
        if (r.toolCalls && r.toolCalls.length > 0) {
            messages.push({ role: 'assistant', content: r.content || null, tool_calls: r.toolCalls });
            const results = await runToolCalls(r.toolCalls);
            messages.push(...results);
            continue;
        }
        messages.push({ role: 'assistant', content: r.content });
        return r;
    }
    return { content: '(tool loop exhausted)', toolCalls: null };
}

// ----------------------------------------------------------
// The scripted session
// ----------------------------------------------------------

console.log(`exp6 retirement probe — model=${MODEL}`);
console.log('='.repeat(70));

const checks = [];
const check = (name, ok, detail) => {
    checks.push({ name, ok });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

// T1: read doc A, summarize
let r = await turn('Read docs/q3-infra.md and give me the key numbers.');
const t1 = r.content.includes('41,200') || r.content.includes('41200');
check('T1 read+summarize doc A', t1, `mentions spend=${t1}`);

// T2: instruction to retire doc A, then read doc B
r = await turn('Done with that one — retire it, then read docs/vendor-eval.md and summarize the decision.');
const retiredA = [...retired.keys()].includes('chunk_A');
const distillA = retired.get('chunk_A') || '';
check('T2 retired chunk_A', retiredA);
check('T2 distillation is specific', /41[,.]?200|FALKE|MOLCH|73%|18%/.test(distillA), `distill=${distillA.slice(0, 90)}...`);
const t2b = /minio/i.test(r.content);
check('T2 summarized doc B', t2b);

// T3: retire B too, then quiz FROM DISTILLATION ONLY
r = await turn('Retire that one as well. Now, from memory: what was the monthly spend in the infra report, and what was the migration cutover week?');
const t3a = /41[,.]?200/.test(r.content);
const t3b = /2026-09-07|week of.*09|September/.test(r.content);
check('T3 recall from distillations (spend)', t3a, r.content.slice(0, 80));
check('T3 recall from distillations (cutover)', t3b);

// T4: quiz on a detail unlikely to be distilled (the alert paging change)
const retiredBeforeT4 = retired.size;
r = await turn('One more detail from the infra report: after the queue incident, what is the new alert paging threshold?');
const t4content = /90 seconds/.test(r.content);
const didUnretire = r.toolCalls ? false : retired.size < retiredBeforeT4; // unretire happens inside turn()
check('T4 answered undistilled detail', t4content, `unretired=${didUnretire}`);
check('T4 unretired to get it', didUnretire || t4content);

console.log('='.repeat(70));
const passed = checks.filter(c => c.ok).length;
console.log(`TOTAL: ${passed}/${checks.length}`);
console.log('\nDistillations captured:');
for (const [cid, d] of retired.entries()) console.log(`  ${cid}: ${d.slice(0, 200)}`);
process.exit(passed === checks.length ? 0 : 1);
