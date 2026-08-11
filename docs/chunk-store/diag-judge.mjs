// diag-judge.mjs — why does the judge return no VERDICT line on big inputs?
import { readFileSync } from 'fs';

const env = readFileSync(new URL('../../.env', import.meta.url), 'utf8');
const KEY = process.env.GATEWAY_API_KEY || env.match(/^GATEWAY_API_KEY=(.+)$/m)[1].trim();
const BASE = process.env.GATEWAY_BASE || 'http://192.168.0.100:3400';

// synthetic long inputs, same shapes the judge sees
const long = ('lorem ipsum dolor sit amet consectetur adipiscing elit '.repeat(60));
const prompt = `You are comparing two AI assistant responses to the same user message in a conversation replay test.

USER MESSAGE:
${long.slice(0, 1500)}

ORIGINAL RESPONSE (from the real conversation):
${long.slice(0, 3000)}

REPLAYED RESPONSE (model saw a chunk-transformed history):
${long.slice(0, 3000)}

Question: Is the replayed response on the SAME trajectory as the original? Same conclusions, same referenced artifacts, same direction? Wording may differ. Answer EXACTLY:
VERDICT: SAME or DIVERGED
REASON: one sentence.`;

const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${KEY}` },
    body: JSON.stringify({ model: 'deepseek-flash-chat', messages: [{ role: 'user', content: prompt }], temperature: 0, max_tokens: 200 })
});
const json = await res.json();
const msg = json.choices?.[0]?.message || {};
console.log('finish:', json.choices?.[0]?.finish_reason);
console.log('content:', JSON.stringify(msg.content));
console.log('reasoning tail:', JSON.stringify((msg.reasoning_content || '').slice(-400)));
console.log('usage:', JSON.stringify(json.usage));
