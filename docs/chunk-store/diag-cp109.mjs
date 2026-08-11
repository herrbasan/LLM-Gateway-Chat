// diag-cp109.mjs — manual replay of the anomalous checkpoint
import { readFileSync } from 'fs';
import { buildChunkView } from './chunk-view.js';

const d = JSON.parse(readFileSync(new URL('./corpus/direct-kimi_k3___introduction-2026-08-11.json', import.meta.url)));
const messages = [];
for (const e of d.exchanges) {
    if (e.type === 'tool' && e.tool) {
        const callId = 'call_' + e.id;
        messages.push({ role: 'assistant', content: null, tool_calls: [{ id: callId, type: 'function', function: { name: e.tool.name, arguments: typeof e.tool.args === 'string' ? e.tool.args : JSON.stringify(e.tool.args || {}) } }] });
        if (e.tool.status === 'success' || e.tool.status === 'error') messages.push({ role: 'tool', tool_call_id: callId, content: e.tool.content || '' });
        if (e.assistant?.content) messages.push({ role: 'assistant', content: e.assistant.content });
    } else {
        if (e.user?.content) messages.push({ role: 'user', content: e.user.content });
        if (e.assistant?.content) messages.push({ role: 'assistant', content: e.assistant.content });
    }
}
const cp = 109;
const hist = messages.slice(0, cp);
const { messages: tx } = buildChunkView(hist);
const full = [...tx, messages[cp]];
const body = JSON.stringify({ model: 'deepseek-flash-chat', messages: full, temperature: 0, max_tokens: 1500 });
console.log('messages:', full.length, '| body chars:', body.length, '| ~tokens@3.5:', Math.round(body.length / 3.5));
console.log('next user msg:', JSON.stringify((messages[cp].content || '').slice(0, 150)));

const env = readFileSync(new URL('../../.env', import.meta.url), 'utf8');
const KEY = process.env.GATEWAY_API_KEY || env.match(/^GATEWAY_API_KEY=(.+)$/m)[1].trim();
const res = await fetch('http://192.168.0.100:3400/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + KEY },
    body
});
console.log('HTTP', res.status);
const json = await res.json();
console.log('usage:', JSON.stringify(json.usage));
console.log('finish:', json.choices?.[0]?.finish_reason);
console.log('content head:', JSON.stringify((json.choices?.[0]?.message?.content || '').slice(0, 400)));
if (json.error) console.log('gateway error:', JSON.stringify(json.error).slice(0, 400));
