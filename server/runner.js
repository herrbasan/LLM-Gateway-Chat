// ============================================
// runner.js — the ConversationRunner (PA-3).
// One runner per active conversation, keyed {userId}:{conversationId}.
// The runner is the ONLY author of conversation state (single-author principle).
// Views attach over SSE: snapshot + live events. Connection state carries no
// semantics — abort is an explicit API call; a closed view is one less listener.
// Design: docs/architecture-conversation-runner.md · frames: docs/pa-implementation-spec.md
// PA scope: TOOLS DISABLED (no tools advertised; tool_calls finish persists as-is).
// ============================================

const convStore = require('./conversation-store');
const { buildApiMessages } = require('./api-view');
const { buildSystemPrompt } = require('./system-prompt');
const mcpPool = require('./mcp-pool');
const internalTools = require('./internal-tools');

let DEPS = null;
// deps = { gatewayUrl, gatewayKey, publicOrigin, embedMessageAsync, log, getInstructions, idleMs,
//          embedBatch, getEmbedAvailable }
function init(deps) { DEPS = deps; }

// Model capabilities cache (vision filter) — gateway /v1/models, 5 min TTL.
let _modelsCache = { at: 0, models: [] };
async function getModels() {
    if (Date.now() - _modelsCache.at < 5 * 60 * 1000 && _modelsCache.models.length) return _modelsCache.models;
    const resp = await fetch(`${DEPS.gatewayUrl}/v1/models`, {
        headers: DEPS.gatewayKey ? { Authorization: `Bearer ${DEPS.gatewayKey}` } : {}
    });
    if (!resp.ok) throw new Error(`gateway /v1/models ${resp.status}`);
    const data = await resp.json();
    _modelsCache = { at: Date.now(), models: data.data || [] };
    return _modelsCache.models;
}

const registry = new Map(); // `${userId}:${conversationId}` -> Runner

function getRunner(user, dbInstance, conversationId) {
    const key = `${user.id}:${conversationId}`;
    let r = registry.get(key);
    if (!r) {
        r = new Runner(user, dbInstance, conversationId);
        registry.set(key, r);
    }
    return r;
}

// server.js embedEvents 'status' → conversation stream embed.status event
function handleEmbedStatus(evt) {
    if (!evt?.chatId) return;
    for (const r of registry.values()) {
        if (r.conversationId === evt.chatId) {
            r.broadcast('embed.status', { messageId: evt.messageId, status: evt.embedStatus, embedError: evt.embedError ?? null, idx: evt.msgIdx });
        }
    }
}

class Runner {
    constructor(user, dbInstance, conversationId) {
        this.user = user;
        this.dbInstance = dbInstance;
        this.conversationId = conversationId;
        const { db } = dbInstance;
        this.session = convStore.findSessionOrThrow(db, conversationId); // throws → route maps 404
        this.conv = convStore.findOrCreateConversation(db, this.session, user);
        this.views = new Set();
        this.inFlight = null;
        this.running = false;
        this.pendingSends = 0;
        this.abortRequested = false;
        this.idleTimer = null;
        this.chunkView = null; // lazy dynamic import (shared file, no port)
        this._chunkTable = new Map(); // last assembly's chunk labels → hashes (context_retire)
        this.scheduleIdle();
    }

    ctx() {
        return { user: this.user, dbInstance: this.dbInstance, embedMessageAsync: DEPS.embedMessageAsync, log: DEPS.log() };
    }
    // nDB find() does NOT return live references — the conv/session objects held
    // here go stale when appendConversationMessage (or the old client) writes.
    // Re-read at every state-consuming point. (First acceptance bug, 2026-08-24.)
    refresh() {
        const { db } = this.dbInstance;
        this.session = convStore.findSessionOrThrow(db, this.conversationId);
        this.conv = convStore.findOrCreateConversation(db, this.session, this.user);
    }
    scheduleIdle() {
        clearTimeout(this.idleTimer);
        this.idleTimer = setTimeout(() => this.maybeUnload(), DEPS.idleMs || 10 * 60 * 1000);
    }
    maybeUnload() {
        if (this.views.size === 0 && !this.running) {
            clearTimeout(this.idleTimer);
            registry.delete(`${this.user.id}:${this.conversationId}`);
        } else {
            this.scheduleIdle();
        }
    }
    touch() { this.scheduleIdle(); }

    // ---- view attach (SSE: snapshot + live events) ----
    attach(req, res) {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive'
        });
        res.write(':ok\n\n');
        this.sendTo(res, 'snapshot', this.buildSnapshot());
        this.views.add(res);
        const ka = setInterval(() => { try { res.write(':ka\n\n'); } catch { /* view gone */ } }, 15000);
        req.on('close', () => { clearInterval(ka); this.views.delete(res); });
        this.touch();
    }

    sendTo(res, event, data) {
        try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* view gone */ }
    }
    broadcast(event, data) {
        for (const res of this.views) this.sendTo(res, event, data);
    }

    // View form (contract #1): densified attachments + {content, timestamp} split.
    viewMessage(m) {
        const cloned = JSON.parse(JSON.stringify(m));
        if (cloned.attachments) cloned.attachments = convStore.densifyAttachments(cloned.attachments);
        const match = typeof cloned.content === 'string'
            ? cloned.content.match(/^\[(\d{4}-\d{2}-\d{2})@(\d{2}:\d{2})\]\s*/)
            : null;
        if (match) {
            cloned.timestamp = new Date(`${match[1]}T${match[2]}:00`).getTime();
            cloned.content = cloned.content.slice(match[0].length);
        } else if (cloned.timestamp === undefined) {
            cloned.timestamp = Date.parse(cloned.createdAt) || null;
        }
        return cloned;
    }

    buildSnapshot() {
        this.refresh();
        const lastAssistant = [...this.conv.messages].reverse().find(m => m.role === 'assistant' && (m.usage || m.context));
        return {
            meta: {
                id: this.session.id,
                title: this.session.title,
                model: this.session.model,
                systemPrompt: this.session.systemPrompt || '',
                mode: this.session.mode || 'direct',
                chunkTransform: this.session.chunkTransform === true,
                category: this.session.category ?? null,
                summary: this.session.summary ?? null,
                pinned: !!this.session.pinned
            },
            messages: this.conv.messages.map(m => this.viewMessage(m)),
            inFlight: this.inFlight ? this.inFlightView() : null,
            lastRun: lastAssistant ? { usage: lastAssistant.usage ?? null, context: lastAssistant.context ?? null } : null
        };
    }

    inFlightView() {
        const f = this.inFlight;
        return {
            id: f.messageId, idx: f.idx, role: 'assistant', model: f.model,
            content: f.content, reasoning_content: f.reasoning_content,
            thinking_signature: f.thinkingSignature ?? null,
            streamStats: null, usage: null, context: null,
            tool_calls: f.toolCalls.filter(Boolean).length ? f.toolCalls.filter(Boolean) : null,
            timestamp: f.startedAt, exchangeId: f.exchangeId, finishReason: null,
            isStreaming: true, embedStatus: 'pending'
        };
    }

    // ---- send: append user message (single author), queue the run ----
    async send(body) {
        const { message } = await convStore.appendConversationMessage(this.ctx(), {
            conversationId: this.conversationId,
            role: 'user',
            content: body.content || '',
            attachments: body.attachments,
            model: body.model || this.session.model || null
        });
        if (body.model && body.model !== this.session.model) {
            this.session.model = body.model;
            this.dbInstance.db.set(this.session._id, 'model', body.model);
        }
        this.broadcast('msg.user', this.viewMessage(message));
        this.touch();
        this.pendingSends++;
        this.generationParams = {};
        for (const k of ['temperature', 'max_tokens', 'reasoning_effort']) {
            if (body[k] !== undefined) this.generationParams[k] = body[k];
        }
        this.kick();
        return { message };
    }

    kick() {
        if (this.running) return; // queued — the loop picks it up (batch)
        this.running = true;
        this.runLoop()
            .catch(err => {
                DEPS.log().error('Runner runLoop crashed', { chatId: this.conversationId, error: err?.message, stack: err?.stack }, 'Runner');
                this.broadcast('error', { code: 'runner', message: err?.message || 'runLoop crashed' });
            })
            .finally(() => {
                this.running = false;
                if (this.pendingSends > 0) this.kick();
            });
    }

    async runLoop() {
        let more = this.pendingSends > 0;
        this.pendingSends = 0;
        let hops = 0;
        while (more) {
            const toolChain = await this.runOnce();
            if (toolChain) {
                hops++;
                if (hops >= 12) {
                    DEPS.log().warn('Runner tool-hop cap reached', { chatId: this.conversationId, hops }, 'Runner');
                    this.broadcast('error', { code: 'tool-hop-cap', message: 'Tool chain stopped after 12 hops.' });
                    break;
                }
                more = true;
                continue;
            }
            if (this.pendingSends > 0) { this.pendingSends = 0; more = true; }
            else more = false;
        }
    }

    async runOnce() {
        this.refresh();
        const model = this.session.model;
        if (!model) {
            this.broadcast('error', { code: 'no-model', message: 'No model selected for this conversation.' });
            this.broadcast('run.end', { finishReason: 'error', usage: null, context: null, aborted: false, messageId: null });
            return;
        }

        const exchangeId = 'ex_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
        this.inFlight = {
            exchangeId,
            messageId: 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10),
            idx: this.conv.messages.length,
            model,
            content: '', reasoning_content: '', thinkingSignature: null,
            toolCalls: [], usage: null, context: null, finishReason: null,
            startedAt: Date.now(), firstDeltaAt: null,
            controller: new AbortController()
        };
        this.abortRequested = false;
        this.broadcast('run.start', { exchangeId, model, messageId: this.inFlight.messageId });

        let outcome = 'stop';
        try {
            const [instructions, chunkView] = await Promise.all([
                DEPS.getInstructions(),
                this.chunkView ? Promise.resolve(this.chunkView) : import('../chat/js/chunk-view.js').then(m => (this.chunkView = m))
            ]);
            const pool = mcpPool.getForUser(this.user, this.dbInstance);
            const mcpOrigin = pool.getStorageOrigin();
            const systemPrompt = buildSystemPrompt({
                instructions,
                user: this.userProfile(),
                sessionPrompt: this.session.systemPrompt || '',
                archiveTools: { sessionId: this.conversationId, mcpOrigin, serverSide: true },
                mcpResources: null,
                memoryToolsAvailable: pool.hasToolPrefix('memory.')
            });
            const { messages: apiMessages, chunkTable } = buildApiMessages(this.conv.messages, {
                systemPrompt,
                publicOrigin: DEPS.publicOrigin,
                chunkTransform: this.session.chunkTransform === true,
                retirements: this.session.retirements || {},
                chunkView,
                log: DEPS.log()
            });
            this._chunkTable = chunkTable;

            // PB-b: internal tools (archive/browser_fetch/attachment_save,
            // retirement in chunkTransform chats) + the user's MCP tools
            // (pool auto-connects lazily), vision-filtered like the client.
            let tools = internalTools.getToolDefs({ chunkTransform: this.session.chunkTransform === true });
            let mcpTools = [];
            try {
                mcpTools = await pool.getFormattedTools();
            } catch (e) {
                DEPS.log().warn('MCP pool unavailable', { chatId: this.conversationId, error: e.message }, 'Runner');
            }
            let modelSupportsVision = false;
            try {
                const models = await getModels();
                modelSupportsVision = models.find(m => m.id === model)?.capabilities?.vision === true;
            } catch (e) {
                DEPS.log().warn('Model capability lookup failed', { chatId: this.conversationId, error: e.message }, 'Runner');
            }
            const hasAutoVisionAnalysis = this.conv.messages.some(m => m.role === 'user' && typeof m.content === 'string' && m.content.includes('[Auto-vision:'));
            tools = tools.concat(internalTools.filterVisionTools(mcpTools, { modelSupportsVision, hasAutoVisionAnalysis }));
            this._toolsAdvertised = tools.length > 0;
            this._mcpOrigin = mcpOrigin;

            const resp = await fetch(`${DEPS.gatewayUrl}/v1/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(DEPS.gatewayKey ? { Authorization: `Bearer ${DEPS.gatewayKey}` } : {})
                },
                body: JSON.stringify({ model, messages: apiMessages, stream: true, session_id: this.conversationId, ...(tools.length ? { tools } : {}), ...(this.generationParams || {}) }),
                signal: this.inFlight.controller.signal
            });
            if (!resp.ok) {
                const text = await resp.text().catch(() => '');
                // Debug capture: the exact payload that failed (thinking-contract hunts)
                try {
                    require('fs').writeFileSync(require('path').join(__dirname, '..', '_scratch', 'last-error-payload.json'),
                        JSON.stringify({ status: resp.status, model, generationParams: this.generationParams, toolsCount: tools.length, messages: apiMessages }, null, 2));
                } catch { /* debug only */ }
                this.broadcast('error', { code: `gateway-${resp.status}`, message: `Gateway ${resp.status}`, raw: text.slice(0, 2000), exchangeId });
                outcome = 'error';
            } else {
                await this.consume(resp);
                outcome = this.abortRequested ? 'aborted' : (this.inFlight.finishReason || 'stop');
            }
        } catch (err) {
            if (this.abortRequested || err?.name === 'AbortError') {
                outcome = 'aborted';
            } else {
                DEPS.log().error('Runner stream error', { chatId: this.conversationId, error: err?.message }, 'Runner');
                this.broadcast('error', { code: 'stream', message: err?.message || 'stream error', exchangeId });
                outcome = 'error';
            }
        }
        const f = this.inFlight;
        await this.endRun(outcome);
        if (outcome === 'tool_calls' && this._toolsAdvertised && f) {
            return await this.executeToolCalls(f); // true → runLoop continues immediately
        }
        return false;
    }

    // PB: execute the run's tool calls server-side, persist each tool message
    // (single author), broadcast tool.start/tool.end. Returns true when at least
    // one tool ran (the runLoop then issues the follow-up gateway request).
    async executeToolCalls(f) {
        const toolCalls = f.toolCalls.filter(Boolean);
        if (toolCalls.length === 0) return false;
        const pool = mcpPool.getForUser(this.user, this.dbInstance);
        let executed = false;
        for (const tc of toolCalls) {
            let args = {};
            try { args = JSON.parse(tc.function.arguments || '{}'); } catch { args = {}; }
            DEPS.log().info('Runner tool call', { chatId: this.conversationId, tool: tc.function.name }, 'Runner');
            this.broadcast('tool.start', { toolCallId: tc.id, name: tc.function.name, args, exchangeId: f.exchangeId, messageId: f.messageId });
            let status = 'success', resultText = '', resultImages = [];
            try {
                const result = internalTools.isInternalTool(tc.function.name)
                    ? await internalTools.executeInternalTool(tc.function.name, args, this.internalToolCtx())
                    : await pool.callTool(tc.function.name, args);
                ({ text: resultText, images: resultImages } = this.extractToolResult(result));
            } catch (e) {
                status = 'error';
                resultText = `Tool error: ${e.message}`;
            }
            const { message: toolMsg } = await convStore.appendConversationMessage(this.ctx(), {
                conversationId: this.conversationId,
                role: 'tool',
                content: resultText,
                toolName: tc.function.name,
                toolArgs: args,
                toolStatus: status,
                toolImages: resultImages.length ? resultImages : undefined,
                tool_call_id: tc.id
            });
            executed = true;
            this.broadcast('tool.end', { toolCallId: tc.id, name: tc.function.name, status, resultMessage: resultText, resultImages, toolMessageId: toolMsg.id, messageId: f.messageId });
        }
        return executed;
    }

    // PB-b: ctx for internal tool execution — everything over dbInstance,
    // no HTTP hop to our own API. Retirement writes go through the session
    // doc (single author: this runner).
    internalToolCtx() {
        return {
            user: this.user,
            dbInstance: this.dbInstance,
            conversationId: this.conversationId,
            log: DEPS.log(),
            mcpOrigin: this._mcpOrigin || null,
            publicOrigin: DEPS.publicOrigin,
            chunkTable: this._chunkTable,
            embedDeps: { embedBatch: DEPS.embedBatch, embedAvailable: DEPS.getEmbedAvailable ? DEPS.getEmbedAvailable() : true },
            getRetirements: () => {
                this.refresh();
                return this.session.retirements || {};
            },
            setRetirements: async (map) => {
                this.refresh();
                this.session.retirements = map;
                this.session.updatedAt = new Date().toISOString();
                this.dbInstance.db.update(this.session._id, this.session);
            }
        };
    }

    // MCP result { content: [{type:'text'|'image', ...}] } → { text, images }.
    // Images: base64 → nDB bucket (internal storeFile — no HTTP hop, no 401s).
    extractToolResult(result) {
        const parts = result?.content;
        if (!Array.isArray(parts)) {
            return { text: typeof result === 'string' ? result : JSON.stringify(result ?? ''), images: [] };
        }
        const texts = [], images = [];
        for (const p of parts) {
            if (p?.type === 'text') texts.push(p.text || '');
            else if (p?.type === 'image' && p.data) {
                const ext = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg' })[p.mimeType] || 'bin';
                const filename = `tool_${Date.now()}_${images.length}.${ext}`;
                const meta = this.dbInstance.db.storeFile('images', filename, Buffer.from(p.data, 'base64'), p.mimeType || 'application/octet-stream');
                images.push(`/api/buckets/images/${meta._file.id}.${meta._file.ext}`);
            }
        }
        return { text: texts.join('\n'), images };
    }

    async consume(resp) {
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        const f = this.inFlight;

        const processFrame = (frame) => {
            const dataLines = [];
            for (const line of frame.split('\n')) {
                if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
            }
            if (dataLines.length === 0) return;
            const data = dataLines.join('\n');
            if (data === '[DONE]') return;
            let json;
            try { json = JSON.parse(data); } catch { return; }
            if (json.usage) f.usage = json.usage;
            if (json.context) f.context = json.context;
            const choice = json.choices?.[0];
            if (!choice) return;
            const delta = choice.delta || {};
            const out = { messageId: f.messageId, exchangeId: f.exchangeId };
            let any = false;
            if (typeof delta.content === 'string' && delta.content) {
                if (f.firstDeltaAt === null) f.firstDeltaAt = Date.now();
                f.content += delta.content;
                out.content = delta.content; any = true;
            }
            if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
                if (f.firstDeltaAt === null) f.firstDeltaAt = Date.now();
                f.reasoning_content += delta.reasoning_content;
                out.reasoningContent = delta.reasoning_content; any = true;
            }
            if (delta.thinking_signature) {
                f.thinkingSignature = delta.thinking_signature;
            }
            // Some adapters deliver the signature on the final message object, not deltas
            if (choice.message?.thinking_signature) f.thinkingSignature = choice.message.thinking_signature;
            if (json.thinking_signature) f.thinkingSignature = json.thinking_signature;
            if (Array.isArray(delta.tool_calls)) {
                for (const frag of delta.tool_calls) {
                    const ti = frag.index ?? 0;
                    if (!f.toolCalls[ti]) f.toolCalls[ti] = { id: frag.id || `call_${ti}`, type: 'function', function: { name: '', arguments: '' } };
                    if (frag.id) f.toolCalls[ti].id = frag.id;
                    if (frag.function?.name) f.toolCalls[ti].function.name += frag.function.name;
                    if (frag.function?.arguments) f.toolCalls[ti].function.arguments += frag.function.arguments;
                }
                out.toolCalls = delta.tool_calls; any = true;
            }
            if (choice.finish_reason) f.finishReason = choice.finish_reason;
            if (any) this.broadcast('delta', out);
        };

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let sep;
            while ((sep = buffer.indexOf('\n\n')) !== -1) {
                const frame = buffer.slice(0, sep);
                buffer = buffer.slice(sep + 2);
                if (frame.trim()) processFrame(frame);
            }
        }
        if (buffer.trim()) processFrame(buffer);
    }

    async endRun(outcome) {
        const f = this.inFlight;
        if (!f) return;
        const durationMs = Date.now() - f.startedAt;
        const streamStats = {
            ttftMs: f.firstDeltaAt ? f.firstDeltaAt - f.startedAt : null,
            durationMs,
            approxTokens: Math.ceil(f.content.length / 4),
            aborted: outcome === 'aborted'
        };
        const hasPayload = !!(f.content || f.reasoning_content || f.toolCalls.filter(Boolean).length > 0);
        if (hasPayload && outcome !== 'error') {
            const toolCalls = f.toolCalls.filter(Boolean);
            // Aborted runs persist CONTENT only. Reasoning cut mid-stream is a
            // truncated thinking block — persisting it poisons every follow-up
            // payload (provider thinking-mode contract: "content[].thinking must
            // be passed back" → 400). E2E queue+abort, 2026-08-24.
            const isAbort = outcome === 'aborted';
            const { message } = await convStore.insertConversationMessageAt(this.ctx(), {
                conversationId: this.conversationId,
                atIdx: f.idx, // reserved at run start — queued sends must not push the assistant past them
                message: {
                    id: f.messageId,
                    role: 'assistant',
                    content: f.content,
                    model: f.model,
                    reasoning_content: isAbort ? undefined : (f.reasoning_content || undefined),
                    thinking_signature: isAbort ? undefined : (f.thinkingSignature || undefined),
                    streamStats,
                    usage: f.usage || undefined,
                    context: f.context || undefined,
                    tool_calls: toolCalls.length ? toolCalls : undefined
                }
            });
            this.broadcast('msg.assistant', this.viewMessage(message));
        }
        this.broadcast('run.end', {
            finishReason: outcome,
            usage: f.usage, context: f.context,
            aborted: outcome === 'aborted',
            messageId: f.messageId
        });
        this.inFlight = null;
        this.touch();
    }

    abort() {
        if (!this.inFlight) return false;
        this.abortRequested = true;
        this.inFlight.controller.abort();
        return true;
    }

    async switchVariant({ messageId, index, direction }) {
        const { message } = await convStore.setMessageVariant(this.ctx(), {
            conversationId: this.conversationId, messageId, index, direction
        });
        const variant = message.versions[message.currentVersion];
        this.broadcast('msg.variant', {
            messageId: message.id,
            currentVersion: message.currentVersion,
            variant
        });
        this.touch();
        return { message };
    }

    // Single message delete (PC): the runner is the single author, so a view
    // deletes through it and every attached view hears msg.deleted.
    async deleteMessage(messageId) {
        const { removed } = await convStore.deleteConversationMessage(this.ctx(), {
            conversationId: this.conversationId, messageId
        });
        this.refresh(); // conv/session objects are stale after the write
        this.broadcast('msg.deleted', { messageId, role: removed.role });
        this.touch();
        return { deleted: true, messageId };
    }

    // Edit a user message in place, truncate after it, re-run (PC). The edited
    // message becomes the pending turn — kick() picks it up as a fresh send.
    async editMessage(messageId, content) {
        const { edited, removedCount } = await convStore.editUserMessageAndTruncate(this.ctx(), {
            conversationId: this.conversationId, messageId, content
        });
        this.refresh();
        // Full snapshot: one edit + N removals is cleaner as a re-render than
        // N incremental events.
        this.broadcast('snapshot', this.buildSnapshot());
        this.pendingSends++;
        this.kick();
        return { edited: true, messageId, removedCount };
    }

    userProfile() {
        const doc = this.dbInstance.db.find('id', this.user.id).find(d => d._type === 'user_settings');
        return {
            name: doc?.displayName || this.user.displayName || '',
            location: doc?.settings?.location || '',
            language: doc?.settings?.language || ''
        };
    }
}

module.exports = { init, getRunner, handleEmbedStatus };
