// ============================================
// mcp-pool.js — server-side MCP client pool (PB-a).
// Port of chat/js/mcp-client.js transport into the runner world: per-user
// connection pool, SSE endpoint discovery, JSON-RPC over streamable-HTTP or
// legacy-SSE (dual-path, first wins), collision naming (serverName__tool),
// read_resource synthesis.
//
// Config source: the per-user settings doc (settings.mcpServers /
// settings.mcpEnabledTools) — the browser's localStorage config moves here
// (deep-dive G5). Tools default to ENABLED (2026-08-25, user direction): the
// chat always advertises all MCP tools; mcpEnabledTools is an opt-OUT map
// (false disables). The workshop dispatcher's ~24K-char description — the
// thing that made small models roleplay the agent protocol (2026-08-25
// incident) — is replaced with a compact one in getFormattedTools; the chat
// prime directive (Agents_Prime_Chat.md) carries the tool catalog instead.
// UI hooks and the trace buffer are not ported.
// ============================================

const TOOL_TIMEOUT_MS = 120000; // matches the browser client

// The server passes its L getter (() => logger || noop). Calling it returns the
// live logger — wrap it once so pool code can use log.info() directly.
function wrapLog(logFn) {
    return {
        info: (...a) => logFn().info(...a),
        warn: (...a) => logFn().warn(...a),
        error: (...a) => logFn().error(...a),
        debug: (...a) => logFn().debug(...a)
    };
}

function deriveSseUrl(url) {
    if (url.includes('/message')) return url.replace('/message', '/sse');
    if (url.endsWith('/mcp/compact')) return url.replace('/mcp/compact', '/sse/compact');
    if (url.endsWith('/mcp')) return url.replace(/\/mcp$/, '/sse');
    return url;
}

let reqCounter = 0;
function nextRequestId() {
    reqCounter = (reqCounter + 1) % 0xffff;
    return `${Date.now().toString(36)}-${reqCounter.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

class ServerConn {
    constructor(cfg, log) {
        this.id = cfg.id;
        this.url = cfg.url;
        this.name = cfg.name || cfg.url;
        this.status = 'disconnected';
        this.tools = null;
        this.postEndpoint = null;
        this.pending = new Map(); // requestId -> { resolve, reject, timeoutId }
        this.log = log;
        this._reader = null;
    }

    async connect() {
        const sseUrl = deriveSseUrl(this.url);
        const resp = await fetch(sseUrl, { headers: { Accept: 'text/event-stream' } });
        if (!resp.ok || !resp.body) throw new Error(`SSE connect HTTP ${resp.status}`);
        this.status = 'connected';
        this._readLoop(resp); // background, not awaited
        // Endpoint discovery arrives on the stream; wait for it
        const deadline = Date.now() + 10000;
        while (!this.postEndpoint && Date.now() < deadline && this.status === 'connected') {
            await new Promise(r => setTimeout(r, 50));
        }
        if (!this.postEndpoint) throw new Error('No POST endpoint discovered');
        await this.refreshTools();
    }

    async _readLoop(resp) {
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
                let sep;
                while ((sep = buffer.indexOf('\n\n')) !== -1) {
                    const frame = buffer.slice(0, sep);
                    buffer = buffer.slice(sep + 2);
                    this._handleFrame(frame, sseUrlBase(resp.url));
                }
            }
        } catch (e) {
            // stream error — fall through to reconnect
        }
        this.status = 'disconnected';
        this.postEndpoint = null;
        for (const [, p] of this.pending) {
            clearTimeout(p.timeoutId);
            p.reject(new Error('MCP connection lost (stream ended)'));
        }
        this.pending.clear();
    }

    _handleFrame(frame, base) {
        if (frame.startsWith(':')) return;
        let eventType = '', eventData = '';
        for (const line of frame.split('\n')) {
            if (line.startsWith('event:')) eventType = line.slice(6).trim();
            else if (line.startsWith('data:')) eventData = line.slice(5).trim();
        }
        if (!eventData) return;
        if (eventType === 'endpoint') {
            let ep = eventData;
            if (ep.startsWith('/')) ep = base + ep;
            this.postEndpoint = ep;
            return;
        }
        if (eventType === 'message') {
            let data;
            try { data = JSON.parse(eventData); } catch { return; }
            if (data.id !== undefined) {
                const p = this.pending.get(String(data.id));
                if (!p) return; // orphan
                this.pending.delete(String(data.id));
                clearTimeout(p.timeoutId);
                if (data.error) p.reject(new Error(`MCP error: ${data.error.message || JSON.stringify(data.error)}`));
                else p.resolve(data.result);
            }
        }
    }

    // JSON-RPC call with dual-path response: POST body (streamable HTTP, 200+SSE)
    // or the persistent SSE stream (legacy 202). First delivery wins.
    async rpc(method, params) {
        if (this.status !== 'connected' || !this.postEndpoint) throw new Error(`server ${this.name} not connected`);
        const requestId = nextRequestId();
        const payload = { jsonrpc: '2.0', id: requestId, method, params };

        const resultPromise = new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                this.pending.delete(requestId);
                reject(new Error(`MCP ${method} timeout after ${TOOL_TIMEOUT_MS / 1000}s (${this.name})`));
            }, TOOL_TIMEOUT_MS);
            this.pending.set(requestId, { resolve, reject, timeoutId });
        });
        // CRASH GUARD: if the POST fetch below hangs past the timeout, this
        // rejection fires while rpc() is still stuck in fetch — resultPromise
        // has no awaiter yet → unhandled rejection → Node 24 kills the server
        // (took down dev 2026-08-24; suspected live incident class too).
        // Callers still receive the rejection via their own await.
        resultPromise.catch(() => { /* handled at the call site */ });

        const resp = await fetch(this.postEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(TOOL_TIMEOUT_MS + 5000)
        });
        if (!resp.ok) {
            const p = this.pending.get(requestId);
            if (p) { this.pending.delete(requestId); clearTimeout(p.timeoutId); }
            const text = await resp.text().catch(() => '');
            throw new Error(`MCP HTTP ${resp.status}: ${text.slice(0, 300)}`);
        }

        const contentType = resp.headers.get('content-type') || '';
        const isStreamable = resp.status === 200 && contentType.includes('text/event-stream');
        if (isStreamable) {
            this._readPostBody(resp, requestId); // resolves via pending map
        } else {
            try { await resp.body?.cancel(); } catch { /* legacy 202: result comes on the SSE stream */ }
        }
        return resultPromise;
    }

    async _readPostBody(resp, requestId) {
        try {
            const reader = resp.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
                let sep;
                while ((sep = buffer.indexOf('\n\n')) !== -1) {
                    const frame = buffer.slice(0, sep);
                    buffer = buffer.slice(sep + 2);
                    this._handleFrame(frame, null);
                }
            }
            // Stream ended without an answer → zombie
            const p = this.pending.get(requestId);
            if (p) {
                this.pending.delete(requestId);
                clearTimeout(p.timeoutId);
                p.reject(new Error('MCP stream ended without response'));
            }
        } catch (e) {
            const p = this.pending.get(requestId);
            if (p) {
                this.pending.delete(requestId);
                clearTimeout(p.timeoutId);
                p.reject(e);
            }
        }
    }

    async refreshTools() {
        const result = await this.rpc('tools/list', {});
        this.tools = result?.tools || [];
    }

    async callTool(originalName, args) {
        return this.rpc('tools/call', { name: originalName, arguments: args });
    }

    async readResource(uri) {
        return this.rpc('resources/read', { uri });
    }
}

function sseUrlBase(url) {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
}

class UserPool {
    constructor(user, dbInstance, log) {
        this.user = user;
        this.dbInstance = dbInstance;
        this.log = wrapLog(log);
        this.servers = [];
        this.registry = new Map(); // llmName -> { server, originalName, definition }
        this._connected = false;

        const settingsDoc = dbInstance.db.find('id', user.id).find(d => d._type === 'user_settings');
        const s = settingsDoc?.settings || {};
        // The browser syncs its localStorage config into the kebab-case namespace
        // ('mcp-servers' / 'mcp-enabledTools'); the doc default uses camelCase.
        this.enabledCfg = s['mcp-enabledTools'] || s.mcpEnabledTools || null;
        const userList = (Array.isArray(s['mcp-servers']) && s['mcp-servers'].length)
            ? s['mcp-servers']
            : (Array.isArray(s.mcpServers) ? s.mcpServers : []);
        this.servers = (userList.length ? userList : DEFAULT_SERVERS).map(cfg => new ServerConn(cfg, this.log));
    }

    async ensureConnected() {
        if (this._connected) return;
        this._connected = true;
        await Promise.all(this.servers.map(async (srv) => {
            try {
                await srv.connect();
                this.log.info('MCP connected', { server: srv.name, tools: srv.tools?.length ?? 0 }, 'MCPPool');
            } catch (e) {
                this.log.warn('MCP connect failed', { server: srv.name, error: e.message }, 'MCPPool');
            }
        }));
        this.rebuildRegistry();
    }

    isEnabled(serverId, toolName) {
        // Default ENABLED (2026-08-25, user direction): the chat always has all
        // MCP tools. Config is opt-OUT per tool (`false` disables). An
        // enabledCfg keyed by a stale server id (the old browser-id trap:
        // '1781102824474' vs migrated 'workshop') can no longer silence every
        // tool — worst case it loses the ability to disable.
        const per = this.enabledCfg?.[serverId];
        if (!per) return true;
        return per[toolName] !== false;
    }

    rebuildRegistry() {
        this.registry = new Map();
        const nameCounts = new Map();
        for (const srv of this.servers) {
            if (srv.status !== 'connected' || !srv.tools) continue;
            for (const t of srv.tools) nameCounts.set(t.name, (nameCounts.get(t.name) || 0) + 1);
        }
        for (const srv of this.servers) {
            if (srv.status !== 'connected' || !srv.tools) continue;
            for (const t of srv.tools) {
                if (!this.isEnabled(srv.id, t.name)) continue;
                // Pass the tool through with its native name — exactly what
                // Copilot does. The name must stay OpenAI-spec legal
                // (^[a-zA-Z0-9_-]+$); a dot breaks Kimi/Deepseek validation.
                // Only disambiguate on a real name collision, with a valid
                // `__` separator.
                let llmName = t.name;
                if (nameCounts.get(t.name) > 1) {
                    llmName = `${srv.name.replace(/[^a-zA-Z0-9_-]/g, '_')}__${t.name}`;
                }
                this.registry.set(llmName, { server: srv, originalName: t.name, definition: t });
            }
        }
    }

    async getFormattedTools() {
        await this.ensureConnected();
        const out = [];
        for (const [llmName, rec] of this.registry) {
            out.push({
                type: 'function',
                function: {
                    name: llmName,
                    description: rec.definition.description,
                    parameters: rec.definition.inputSchema || { type: 'object', properties: {} }
                }
            });
        }
        return out;
    }

    async callTool(llmName, args) {
        await this.ensureConnected();
        if (llmName === 'read_resource') return this.executeReadResource(args);
        const rec = this.registry.get(llmName);
        if (!rec) throw new Error(`Unknown tool: ${llmName}`);
        if (rec.server.status !== 'connected') throw new Error(`Server for tool ${llmName} is disconnected`);
        return rec.server.callTool(rec.originalName, args);
    }

    // Workshop origin for storage PUTs (browser_fetch / attachment_save /
    // saveToStorage). Mirrors the client's getMcpServerOrigin: first
    // configured server URL's origin.
    getStorageOrigin() {
        const srv = this.servers.find(s => s.cfg?.url || s.url);
        const raw = srv?.cfg?.url || srv?.url;
        if (!raw) return null;
        try { return sseUrlBase(raw); } catch { return null; }
    }

    hasToolPrefix(prefix) {
        for (const llmName of this.registry.keys()) {
            if (llmName.startsWith(prefix)) return true;
        }
        return false;
    }

    async executeReadResource(args) {
        if (typeof args?.uri !== 'string' || !args.uri) throw new Error('read_resource: uri required');
        const connected = this.servers.filter(s => s.status === 'connected');
        if (connected.length === 0) throw new Error('read_resource: no connected MCP server');
        let lastErr = null;
        for (const srv of connected) {
            try { return await srv.readResource(args.uri); } catch (e) { lastErr = e; }
        }
        throw lastErr || new Error('read_resource: failed');
    }
}

const pools = new Map(); // userId -> UserPool
let LOG = { info() {}, warn() {}, error() {}, debug() {} };
// Backend-configured MCP servers (MCP_URL in .env / cfg.mcpUrl). Used when a
// user has no own mcp-servers entry — the rework's target: server URLs are
// backend config, not per-user data.
let DEFAULT_SERVERS = [];
function init({ log, defaultServers }) {
    LOG = log;
    DEFAULT_SERVERS = Array.isArray(defaultServers) ? defaultServers : [];
}

function getForUser(user, dbInstance) {
    let p = pools.get(user.id);
    if (!p) {
        p = new UserPool(user, dbInstance, LOG);
        pools.set(user.id, p);
    }
    return p;
}

module.exports = { init, getForUser };
