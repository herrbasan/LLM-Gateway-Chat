// ============================================================
// probe-chunk-refs.mjs — can the model work with content-addressed
// chunks in conversation history instead of repeated full payloads?
//
// Simulated transcripts (no real MCP server): storage.read /
// storage.write tool calls and results are fabricated, with canary
// strings planted inside chunk bodies. Scoring is exact-substring
// and tool-call-shape based — no LLM judge, fail loud.
//
// Experiments:
//   1. forward-ref   — history carries [chunk_a] = full text once;
//                      question answerable only from chunk content.
//   2. tool-arg-ref  — assistant reply labeled chunk_doc; user asks
//                      to save it. PASS = tool call uses from_ref
//                      instead of re-emitting content.
//   3. diff-chunk    — chunk_a full (line-numbered), chunk_b =
//                      unified diff; question targets an UNCHANGED
//                      region (base+delta reconstruction needed).
//   4. chain         — chunk_a full, chunk_b diff, chunk_c diff;
//                      question targets final state + latest write
//                      must reference chunk_c.
//
// Usage:  node docs/chunk-store/probe-chunk-refs.mjs [modelId]
// Env:    GATEWAY_BASE (default http://192.168.0.100:3400)
//         GATEWAY_API_KEY (falls back to repo .env)
// Default model: deepseek-flash-chat
// ============================================================

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.GATEWAY_BASE || 'http://192.168.0.100:3400';
const MODEL = process.argv[2] || 'deepseek-flash-chat';

function loadApiKey() {
    if (process.env.GATEWAY_API_KEY) return process.env.GATEWAY_API_KEY;
    const env = readFileSync(join(HERE, '..', '..', '.env'), 'utf8');
    const m = env.match(/^GATEWAY_API_KEY=(.+)$/m);
    if (!m) throw new Error('GATEWAY_API_KEY not in env and not in .env');
    return m[1].trim();
}
const API_KEY = loadApiKey();

// ----------------------------------------------------------
// Real-ish source document (our own server route table shape)
// ----------------------------------------------------------

const CANARY = 'ZQX-7741-EMBER';
const CANARY_TOKENS = '18432';
const CANARY_NEW = 'KQW-2290-HARBOR';

const DOC_V1 = `# API Routes — Workshop MCP Server

## Storage
| Route | Purpose |
|-------|---------|
| GET /storage/list | List directory contents |
| GET /storage/read | Read a file, utf8 or base64 |
| POST /storage/write | Full-file replacement. DANGER: entire content required |
| POST /storage/append | Append-only, O(1) |
| POST /storage/replace | Marker-based swap, server-side |
| POST /storage/batch | Atomic multi-op |

## Memory
| Route | Purpose |
|-------|---------|
| GET /memory/overview | Cluster map, call at session start |
| GET /memory/recall?q= | Semantic search, canary ${CANARY} |
| POST /memory/store | Persist observation |

## Embed configuration
- embedMaxTokens: ${CANARY_TOKENS}
- embedBatchTokenLimit: 29000
- embedDims: 2560

## Forge
| Route | Purpose |
|-------|---------|
| POST /forge/call | Execute forged tool in worker_thread |
| GET /forge/list | Tool manifest |
| POST /forge/write | Create tool, ES module, default export async fn |

## Notes
Bucket GC walks message content for /api/buckets/ URLs and calls
releaseFile. Orphans move to .trash natively in the Rust engine.
Session TTL defaults to 1440 minutes. Port 3100 is static on the LAN.
`;

// v2: memory section gains a row; embed config gains a line; canary_new added
const DIFF_V2 = `--- a/chunk_a
+++ b/chunk_b
@@ -14,6 +14,7 @@
 | GET /memory/overview | Cluster map, call at session start |
 | GET /memory/recall?q= | Semantic search, canary ${CANARY} |
 | POST /memory/store | Persist observation |
+| POST /memory/forget | Delete a memory by id |
 
 ## Embed configuration
 - embedMaxTokens: ${CANARY_TOKENS}
@@ -30,3 +31,4 @@
 releaseFile. Orphans move to .trash natively in the Rust engine.
 Session TTL defaults to 1440 minutes. Port 3100 is static on the LAN.
+Deployment canary: ${CANARY_NEW}
`;

// v3: embedMaxTokens changes value (18800), forge gains a row
const DIFF_V3 = `--- a/chunk_b
+++ b/chunk_c
@@ -17,7 +17,7 @@
 | POST /memory/forget | Delete a memory by id |
 
 ## Embed configuration
-- embedMaxTokens: ${CANARY_TOKENS}
+- embedMaxTokens: 18800
 - embedBatchTokenLimit: 29000
 - embedDims: 2560
 
@@ -25,6 +25,7 @@
 | POST /forge/call | Execute forged tool in worker_thread |
 | GET /forge/list | Tool manifest |
 | POST /forge/write | Create tool, ES module, default export async fn |
+| POST /forge/rollback | Restore tool to a previous commit |
`;

// v4: storage section drops the batch row; notes TTL changes
const DIFF_V4 = `--- a/chunk_c
+++ b/chunk_d
@@ -5,7 +5,6 @@
 | POST /storage/write | Full-file replacement. DANGER: entire content required |
 | POST /storage/append | Append-only, O(1) |
 | POST /storage/replace | Marker-based swap, server-side |
-| POST /storage/batch | Atomic multi-op |
 
 ## Memory
@@ -32,5 +31,5 @@
 Bucket GC walks message content for /api/buckets/ URLs and calls
 releaseFile. Orphans move to .trash natively in the Rust engine.
-Session TTL defaults to 1440 minutes. Port 3100 is static on the LAN.
+Session TTL defaults to 720 minutes. Port 3100 is static on the LAN.
 Deployment canary: ${CANARY_NEW}
`;

// v5: memory section gains dream row; forge call row gets timeout note (edit existing line)
const DIFF_V5 = `--- a/chunk_d
+++ b/chunk_e
@@ -14,6 +14,7 @@
 | GET /memory/recall?q= | Semantic search, canary ${CANARY} |
 | POST /memory/store | Persist observation |
 | POST /memory/forget | Delete a memory by id |
+| GET /memory/dream | Trigger consolidation manually |
 
 ## Embed configuration
@@ -24,7 +25,7 @@
 ## Forge
 | Route | Purpose |
 |-------|---------|
-| POST /forge/call | Execute forged tool in worker_thread |
+| POST /forge/call | Execute forged tool in worker_thread (timeout 300s) |
 | GET /forge/list | Tool manifest |
 | POST /forge/write | Create tool, ES module, default export async fn |
 | POST /forge/rollback | Restore tool to a previous commit |
`;

// v6: embedDims changes; append row reworded (edit to existing line); notes gain a line
const DIFF_V6 = `--- a/chunk_e
+++ b/chunk_f
@@ -7,7 +7,7 @@
 | POST /storage/replace | Marker-based swap, server-side |
 
 ## Memory
-| GET /memory/overview | Cluster map, call at session start |
+| GET /memory/overview | Cluster map — ALWAYS call at session start |
 | GET /memory/recall?q= | Semantic search, canary ${CANARY} |
@@ -19,7 +19,7 @@
 ## Embed configuration
 - embedMaxTokens: 18800
 - embedBatchTokenLimit: 29000
-- embedDims: 2560
+- embedDims: 1024
 
 ## Forge
@@ -33,3 +33,4 @@
 releaseFile. Orphans move to .trash natively in the Rust engine.
 Session TTL defaults to 720 minutes. Port 3100 is static on the LAN.
 Deployment canary: ${CANARY_NEW}
+Edit canary: VWQ-5517-LANTERN
`;

// Line-numbered variant for diff base (helps the model cite regions)
function withLineNumbers(text) {
    return text.split('\n').map((l, i) => `${String(i + 1).padStart(3)}| ${l}`).join('\n');
}

// ----------------------------------------------------------
// Tool schemas (simulated storage.* surface)
// ----------------------------------------------------------

const STORAGE_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'storage_read',
            description: 'Read a file from storage. Returns the full file content.',
            parameters: {
                type: 'object',
                properties: { path: { type: 'string' } },
                required: ['path']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'storage_write',
            description:
                'Write a file. Provide EITHER content (full text) OR from_ref ' +
                '(the chunk label of a message or tool result earlier in this ' +
                'conversation whose content should be written verbatim). ' +
                'STRONGLY PREFER from_ref when the content already exists in ' +
                'the conversation as a labeled chunk — never re-emit large text.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string' },
                    content: { type: 'string' },
                    from_ref: { type: 'string', description: 'Chunk label, e.g. "chunk_doc"' }
                },
                required: ['path']
            }
        }
    }
];

// ----------------------------------------------------------
// Gateway call (non-streaming for deterministic scoring)
// ----------------------------------------------------------

async function chat(messages, tools = null) {
    const body = { model: MODEL, messages, temperature: 0, max_tokens: 2048 };
    if (tools) { body.tools = tools; body.tool_choice = 'auto'; }
    const res = await fetch(`${BASE}/v1/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${API_KEY}`
        },
        body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const json = await res.json();
    const choice = json.choices?.[0];
    return {
        content: choice?.message?.content || '',
        toolCalls: choice?.message?.tool_calls || null,
        finishReason: choice?.finish_reason,
        usage: json.usage || null
    };
}

// ----------------------------------------------------------
// Experiment definitions
// ----------------------------------------------------------

const REF_SYSTEM =
    'This conversation uses content-addressed chunks. When a message or tool ' +
    'result is labeled [chunk_X], its content exists ONCE in this conversation, ' +
    'at that label. Later references to chunk_X mean exactly that content. ' +
    'Diff chunks ([chunk_b, diff of chunk_a]) contain unified diffs: apply them ' +
    'mentally to the base chunk to get the new full content.';

const experiments = [
    {
        name: 'exp1-forward-ref',
        build: () => ({
            tools: null,
            messages: [
                { role: 'system', content: REF_SYSTEM },
                { role: 'user', content: 'Read the API routes doc so we can discuss it.' },
                {
                    role: 'assistant', content: null,
                    tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'storage_read', arguments: JSON.stringify({ path: 'docs/routes.md' }) } }]
                },
                { role: 'tool', tool_call_id: 'call_1', content: `[chunk_a] (docs/routes.md, ${DOC_V1.length} chars)\n${DOC_V1}` },
                { role: 'assistant', content: 'Read it — see chunk_a. What would you like to know?' },
                { role: 'user', content: 'Two things: what is the canary string in the memory/recall row, and what is embedMaxTokens set to? Quote exact values.' }
            ]
        }),
        score: (r) => ({
            pass: r.content.includes(CANARY) && r.content.includes(CANARY_TOKENS),
            detail: `canary=${r.content.includes(CANARY)} tokens=${r.content.includes(CANARY_TOKENS)}`
        })
    },
    {
        name: 'exp2-tool-arg-ref',
        build: () => ({
            tools: STORAGE_TOOLS,
            messages: [
                { role: 'system', content: REF_SYSTEM },
                { role: 'user', content: 'Draft the API routes doc.' },
                { role: 'assistant', content: `[chunk_doc] Here is the draft:\n\n${DOC_V1}` },
                { role: 'user', content: 'Good. Save that document verbatim to docs/routes.md.' }
            ]
        }),
        score: (r) => {
            const tc = r.toolCalls?.[0];
            if (!tc) return { pass: false, detail: `no tool call (content: ${r.content.slice(0, 120)})` };
            let args = {};
            try { args = JSON.parse(tc.function.arguments); } catch { return { pass: false, detail: 'unparseable args' }; }
            const usedRef = typeof args.from_ref === 'string' && args.from_ref.includes('chunk_doc');
            const reEmitted = typeof args.content === 'string' && args.content.length > 500;
            return {
                pass: tc.function.name === 'storage_write' && args.path === 'docs/routes.md' && usedRef && !reEmitted,
                detail: `tool=${tc.function.name} path=${args.path} from_ref=${args.from_ref} reEmitted=${reEmitted ? args.content.length + 'chars' : 'no'}`
            };
        }
    },
    {
        name: 'exp3-diff-chunk',
        build: () => ({
            tools: null,
            messages: [
                { role: 'system', content: REF_SYSTEM },
                { role: 'user', content: 'Read the routes doc.' },
                {
                    role: 'assistant', content: null,
                    tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'storage_read', arguments: JSON.stringify({ path: 'docs/routes.md' }) } }]
                },
                { role: 'tool', tool_call_id: 'call_1', content: `[chunk_a] (docs/routes.md, line-numbered)\n${withLineNumbers(DOC_V1)}` },
                { role: 'assistant', content: 'Got it, chunk_a.' },
                { role: 'user', content: 'I edited it — added the memory/forget row, and appended a deployment canary line at the end. Here is the new version as a diff.' },
                { role: 'user', content: `[chunk_b, diff of chunk_a]\n${DIFF_V2}` },
                { role: 'user', content: 'In the CURRENT version of the doc: what is embedMaxTokens (unchanged region — you must reconstruct), and what is the new deployment canary (from the diff)?' }
            ]
        }),
        score: (r) => ({
            pass: r.content.includes(CANARY_TOKENS) && r.content.includes(CANARY_NEW),
            detail: `reconstructed-unchanged=${r.content.includes(CANARY_TOKENS)} diff-applied=${r.content.includes(CANARY_NEW)}`
        })
    },
    {
        name: 'exp4-chain',
        build: () => ({
            tools: STORAGE_TOOLS,
            messages: [
                { role: 'system', content: REF_SYSTEM },
                { role: 'user', content: 'Read the routes doc.' },
                {
                    role: 'assistant', content: null,
                    tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'storage_read', arguments: JSON.stringify({ path: 'docs/routes.md' }) } }]
                },
                { role: 'tool', tool_call_id: 'call_1', content: `[chunk_a] (docs/routes.md, line-numbered)\n${withLineNumbers(DOC_V1)}` },
                { role: 'assistant', content: 'Got it, chunk_a.' },
                { role: 'user', content: 'Edit one: added memory/forget row and a deployment canary at the end.' },
                { role: 'user', content: `[chunk_b, diff of chunk_a]\n${DIFF_V2}` },
                { role: 'user', content: 'Edit two: embedMaxTokens drops to 18800, and forge gets a rollback row.' },
                { role: 'user', content: `[chunk_c, diff of chunk_b]\n${DIFF_V3}` },
                { role: 'user', content: 'Save the CURRENT full version to docs/routes.md, then tell me: what is embedMaxTokens now, and does the doc have a forge/rollback route?' }
            ]
        }),
        score: (r) => {
            const tc = r.toolCalls?.[0];
            let toolOk = false, toolDetail = 'no tool call';
            if (tc) {
                try {
                    const args = JSON.parse(tc.function.arguments);
                    const usedRef = typeof args.from_ref === 'string' && args.from_ref.includes('chunk_c');
                    toolOk = tc.function.name === 'storage_write' && usedRef;
                    toolDetail = `tool=${tc.function.name} from_ref=${args.from_ref} content=${args.content ? args.content.length + 'chars' : 'no'}`;
                } catch { toolDetail = 'unparseable args'; }
            }
            const contentOk = r.content.includes('18800') && /rollback/i.test(r.content);
            return {
                pass: toolOk && contentOk,
                detail: `${toolDetail} | state: embedMaxTokens-18800=${r.content.includes('18800')} rollback-mentioned=${/rollback/i.test(r.content)}`
            };
        }
    },
    {
        name: 'exp5-diff-chain-depth5',
        // The user's hypothesis: history STRUCTURED as base + diff chunks,
        // each edit arriving as a storage_replace tool result carrying only
        // the diff. Question targets current state of lines edited at
        // different depths — the model must compose all five diffs.
        build: () => {
            const edit = (id, chunkLabel, diff, callId) => ([
                { role: 'user', content: `Apply this edit to docs/routes.md.` },
                {
                    role: 'assistant', content: null,
                    tool_calls: [{ id: callId, type: 'function', function: { name: 'storage_replace', arguments: JSON.stringify({ path: 'docs/routes.md', diff_ref: id }) } }]
                },
                { role: 'tool', tool_call_id: callId, content: `[${chunkLabel}] applied to docs/routes.md\n${diff}` },
                { role: 'assistant', content: `Applied — see ${chunkLabel.split(' ')[0]}.` }
            ]);
            return {
                tools: null,
                messages: [
                    { role: 'system', content: REF_SYSTEM },
                    { role: 'user', content: 'Read the API routes doc.' },
                    {
                        role: 'assistant', content: null,
                        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'storage_read', arguments: JSON.stringify({ path: 'docs/routes.md' }) } }]
                    },
                    { role: 'tool', tool_call_id: 'call_1', content: `[chunk_a] (docs/routes.md, line-numbered)\n${withLineNumbers(DOC_V1)}` },
                    { role: 'assistant', content: 'Got it — the routes doc is chunk_a.' },
                    ...edit('d1', 'chunk_b, diff of chunk_a', DIFF_V2, 'call_2'),
                    ...edit('d2', 'chunk_c, diff of chunk_b', DIFF_V3, 'call_3'),
                    ...edit('d3', 'chunk_d, diff of chunk_c', DIFF_V4, 'call_4'),
                    ...edit('d4', 'chunk_e, diff of chunk_d', DIFF_V5, 'call_5'),
                    ...edit('d5', 'chunk_f, diff of chunk_e', DIFF_V6, 'call_6'),
                    { role: 'user', content: 'From the CURRENT state of docs/routes.md: (1) what is embedDims now? (2) What is the session TTL? (3) Is there still a storage/batch route? (4) What does the memory/overview row say now — quote it. (5) What is the edit canary?' }
                ]
            };
        },
        score: (r) => {
            const checks = {
                embedDims: r.content.includes('1024'),
                ttl: r.content.includes('720'),
                batchGone: /no|removed|dropped|no longer|not.*present/i.test(r.content),
                overviewRow: r.content.includes('ALWAYS call at session start'),
                editCanary: r.content.includes('VWQ-5517-LANTERN')
            };
            const okCount = Object.values(checks).filter(Boolean).length;
            return {
                pass: okCount === 5,
                detail: Object.entries(checks).map(([k, v]) => `${k}=${v}`).join(' ') + ` (${okCount}/5)`
            };
        }
    }
];

// ----------------------------------------------------------
// Runner
// ----------------------------------------------------------

console.log(`Probe: chunk-refs  model=${MODEL}  gateway=${BASE}`);
console.log('='.repeat(70));

const results = [];
for (const exp of experiments) {
    const { messages, tools } = exp.build();
    const t0 = Date.now();
    let result, error = null;
    try {
        result = await chat(messages, tools);
    } catch (e) {
        error = e.message;
    }
    const ms = Date.now() - t0;

    if (error) {
        results.push({ name: exp.name, pass: false, detail: `ERROR ${error}` });
        console.log(`${exp.name}: ERROR ${error} (${ms}ms)`);
        continue;
    }
    const { pass, detail } = exp.score(result);
    const inTok = result.usage?.prompt_tokens ?? '?';
    const outTok = result.usage?.completion_tokens ?? '?';
    results.push({ name: exp.name, pass, detail });
    console.log(`${exp.name}: ${pass ? 'PASS' : 'FAIL'}  (${ms}ms, in=${inTok} out=${outTok})`);
    console.log(`  ${detail}`);
    if (!pass || process.env.PROBE_VERBOSE) {
        console.log(`  --- model said ---`);
        console.log('  ' + (result.content || '(no content)').split('\n').slice(0, 14).join('\n  '));
    }
}

console.log('='.repeat(70));
const passed = results.filter(r => r.pass).length;
console.log(`TOTAL: ${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
