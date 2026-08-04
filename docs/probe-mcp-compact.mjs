// ============================================================
// probe-mcp-compact.mjs — reproduce + time the MCP "compact"
// pipeline exactly as the chat app (mcp-client.js) drives it.
//
// Transport (legacy SSE):
//   GET  /sse/compact                  → opens stream, receives endpoint event
//   POST /message/compact?sessionId=…  → sends JSON-RPC; the response
//        arrives as `event: message` on the SSE stream
//
// Battery:
//   1. initialize                       — baseline round trip
//   2. tools/list                       — what does the compact endpoint advertise?
//   3. tools/call storage.readMany      — reproduce the "Unknown method" failure
//   4. tools/call storage.read          — known-good path, timed
//   5. tools/call storage.readmany (lc) — diagnostic: does the handler exist
//                                         when routed under a lowercase key?
//
// Usage: node docs/probe-mcp-compact.mjs
// Env:   MCP_BASE (default http://localhost:3100)
// ============================================================

const BASE = process.env.MCP_BASE || 'http://localhost:3100';

class CompactProbe {
    constructor(base) {
        this.base = base;
        this.waiters = new Map();
        this.events = [];
        this.postEndpoint = null;
        this.connectedAt = 0;
    }

    log(ev, detail) {
        const at = Date.now() - this.connectedAt;
        this.events.push({ at, ev, detail });
        console.log(`[+${at}ms] ${ev}  ${detail}`);
    }

    async connect() {
        const t = Date.now();
        const resp = await fetch(`${this.base}/sse/compact`, { headers: { Accept: 'text/event-stream' } });
        if (!resp.ok) throw new Error(`SSE connect HTTP ${resp.status}`);
        this.connectedAt = Date.now();
        this.log('SSE', `connected (HTTP ${resp.status})`);

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        const pump = async () => {
            try {
                const { done, value } = await reader.read();
                if (done) { this.log('SSE', 'stream ended'); return; }
                buffer += decoder.decode(value, { stream: true });
                buffer = buffer.replace(/\r\n/g, '\n');
                let idx;
                while ((idx = buffer.indexOf('\n\n')) !== -1) {
                    const raw = buffer.slice(0, idx);
                    buffer = buffer.slice(idx + 2);
                    if (raw.startsWith(':')) continue; // keepalive comment
                    let ev = '', data = '';
                    for (const line of raw.split('\n')) {
                        if (line.startsWith('event:')) ev = line.slice(6).trim();
                        else if (line.startsWith('data:')) data = line.slice(5).trim();
                    }
                    if (ev === 'endpoint') {
                        this.postEndpoint = data.startsWith('/') ? `${this.base}${data}` : data;
                        this.log('SSE', `endpoint → ${this.postEndpoint}`);
                    } else if (ev === 'message' && data) {
                        let msg;
                        try { msg = JSON.parse(data); } catch { continue; }
                        const key = String(msg.id);
                        const w = this.waiters.get(key);
                        if (w) { this.waiters.delete(key); w.resolve({ msg, at: Date.now() }); }
                        else this.log('SSE', `unmatched message id=${key} method=${msg.method || '?'}`);
                    }
                }
                pump();
            } catch (err) {
                this.log('SSE', `stream error: ${err.message}`);
            }
        };
        pump();

        const t0 = Date.now();
        while (!this.postEndpoint && Date.now() - t0 < 10000) await new Promise(r => setTimeout(r, 25));
        if (!this.postEndpoint) throw new Error('endpoint event not received within 10s');
        this.log('SSE', `endpoint received (${Date.now() - this.connectedAt}ms after connect)`);
    }

    /** Send a raw JSON-RPC request. */
    async post(label, method, params) {
        if (!this.postEndpoint) throw new Error('not connected');
        const requestId = `probe-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const body = { jsonrpc: '2.0', id: requestId, method, params };

        const respPromise = new Promise((resolve, reject) => {
            this.waiters.set(requestId, { resolve, reject });
            setTimeout(() => {
                if (this.waiters.delete(requestId)) reject(new Error(`${label}: response timeout 30s`));
            }, 30000);
        });

        const tPost = Date.now();
        const resp = await fetch(this.postEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
            body: JSON.stringify(body)
        });
        const tResp = Date.now();
        const ct = resp.headers.get('content-type') || '';
        const respText = (await resp.text()).replace(/\n/g, ' ').slice(0, 200);
        this.log('POST', `${label}: HTTP ${resp.status} ${ct.split(';')[0]} in ${tResp - tPost}ms body="${respText}"`);

        const { msg, at } = await respPromise;
        const rtt = at - tPost;
        const size = JSON.stringify(msg).length;
        const summary = msg.error ? `ERROR ${msg.error.message}` : 'OK';
        this.log('RESP', `${label}: ${summary} (rtt ${rtt}ms, ${size}B)`);
        return { msg, rtt, size };
    }

    /** Send a compact-protocol tool call (name="tools"). */
    async callTool(label, method, payload) {
        return this.post(label, 'tools/call', { name: 'tools', arguments: { method, payload } });
    }
}

const probe = new CompactProbe(BASE);
await probe.connect();

console.log('\n===== BASELINE =====');
await probe.post('initialize', 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe', version: '0' } });
const toolsResp = await probe.post('tools/list', 'tools/list', {});
if (toolsResp.msg?.result?.tools) {
    const tools = toolsResp.msg.result.tools;
    console.log(`advertised tools: ${tools.length}`);
    for (const t of tools) console.log(`  - ${t.name}`);
}

console.log('\n===== REPRODUCE: storage.readMany =====');
const rm = await probe.callTool('storage.readMany', 'storage.readMany', { paths: ['Agents.md'] });
console.log('  → full response:', JSON.stringify(rm.msg).slice(0, 400));

console.log('\n===== KNOWN-GOOD: storage.read =====');
const rd = await probe.callTool('storage.read', 'storage.read', { path: 'Agents.md' });
console.log('  → full response:', JSON.stringify(rd.msg).slice(0, 400));

console.log('\n===== DIAGNOSTIC: storage.readmany (lowercase) =====');
const rmlc = await probe.callTool('storage.readmany', 'storage.readmany', { paths: ['Agents.md'] });
console.log('  → full response:', JSON.stringify(rmlc.msg).slice(0, 400));

console.log('\n===== SUMMARY =====');
console.log(JSON.stringify(probe.events, null, 2));
process.exit(0);
