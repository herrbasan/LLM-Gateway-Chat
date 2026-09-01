// ============================================
// runner.js — the ConversationRunner (PA-3).
// One runner per active conversation, keyed {userId}:{conversationId}.
// The runner is the ONLY author of conversation state (single-author principle).
// Views attach over SSE: snapshot + live events. Connection state carries no
// semantics — abort is an explicit API call; a closed view is one less listener.
// Design: docs/architecture-conversation-runner.md · frames: docs/_Archive/pa-implementation-spec.md
// PA scope: TOOLS DISABLED (no tools advertised; tool_calls finish persists as-is).
// ============================================

const convStore = require('./conversation-store');
const { buildApiMessages, parseFileRef, LEADING_TS_REGEX } = require('./api-view');
const { buildSystemPrompt } = require('./system-prompt');
const { countApiMessages, breakdownApiMessages } = require('./token-count');
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

// Abort the gateway stream if no data arrives for this long — prevents a hung
// gateway/model from wedging the run forever (the fetch + body reader have no
// other timeout). Reset on every chunk, so slow-but-progressing generations are
// unaffected; only total silence for this window is treated as a stall.
const STREAM_STALL_MS = 300000;
// TTFT trip (2026-08-31): no first chunk within this window = hung request
// (gateway accepted, upstream deadlocked — observed with gemini-flash after
// image-store tool chains: twice silent until reload). Distinct from the
// mid-stream stall: slow-prefill local models still get 2 min of grace, but
// the user no longer stares at a dead bubble for 5 min.
const TTFT_MS = 120000;

// Two-tier tool-hop cap — a safety line against an infinite tool loop,
// distinguished by whether anyone is attached. It must never trip in normal
// operation; it exists to catch "walked away" / "forgot the tab", not to
// bound supervised work. Steps, not time: a loop IS repeated hops, so hops
// are the real failure signal (a wall-clock limit would punish slow-but-
// correct work). Supersedes the flat MAX_TOOL_HOPS = 50 (too low for legit
// archive jobs, and it bit even when a human was watching).
const MAX_TOOL_HOPS_ATTENDED = 200;    // a client is attached (views.size > 0)
const MAX_TOOL_HOPS_UNATTENDED = 100;  // headless — no view (the BFF case that bit us)

// Pull a readable one-liner out of a gateway/provider error body. The gateway
// wraps the provider's JSON inside its own message string (double-encoded), so
// peel layers until the innermost "message" surfaces, then flatten whitespace.
function errorDetailFromBody(text, fallback) {
    let msg = String(text || '');
    for (let i = 0; i < 3; i++) {
        let next = null;
        try { next = JSON.parse(msg)?.error?.message ?? null; } catch { /* not pure JSON */ }
        if (!next) {
            const m = msg.match(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/);
            next = m ? m[1].replace(/\\"/g, '"').replace(/\\n/g, ' ') : null;
        }
        if (!next || next === msg) break;
        msg = next;
    }
    msg = msg.replace(/\s+/g, ' ').trim();
    if (!msg) return fallback;
    return msg.length > 300 ? msg.slice(0, 300) + '…' : msg;
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
        // Model captured per send (first-wins per batch run): a later send
        // from another view must not retcon an already-queued run (#27).
        // session.model stays as "last used" — the default for new views.
        this.pendingModel = null;
        this.running = false;
        this.pendingSends = 0;
        this.abortRequested = false;
        this.idleTimer = null;
        this._stallTimer = null;
        this._ttftTimer = null;
        this.chunkView = null; // lazy dynamic import (shared file, no port)
        this._chunkTable = new Map(); // last assembly's chunk labels → hashes (context_retire)
        // §5a reporting: per-turn context records (raw/wire/savings/cache hint),
        // ring buffer of the last N turns — the data source for the report view.
        this.contextHistory = [];
        this._lastMsgHashes = null;
        // Orphaned run? The previous process died mid-chain and left its stamp
        // behind — mark the conversation LOUDLY, then clear the stamp. Without
        // this a restart mid-run is a permanent silent stall (2026-08-25).
        if (this.session.activeRun) {
            this._persistFailureNote('Run interrupted — the server restarted while a run was in flight. Send a message to continue.')
                .catch(err => DEPS.log().error('Orphan-run note failed', { chatId: conversationId, error: err?.message }, 'Runner'));
            this._clearActiveRunStamp();
        }
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

    // Active-run stamp: durable "a run chain is in flight" marker on the
    // session doc — set when the loop starts, cleared when it drains. Survives
    // a process kill, which is exactly when it's needed (orphan detection).
    _setActiveRunStamp() {
        this.refresh();
        this.session.activeRun = { startedAt: new Date().toISOString() };
        this.dbInstance.db.update(this.session._id, this.session);
        // Let attached views reflect in-flight state in the chat list (#23).
        this.broadcast('run.state', { running: true });
    }

    _clearActiveRunStamp() {
        this.refresh();
        if (!this.session.activeRun) return;
        delete this.session.activeRun;
        this.dbInstance.db.update(this.session._id, this.session);
        this.broadcast('run.state', { running: false });
    }

    // Persist a run failure as an assistant message (error flag) — the durable
    // counterpart of the transient 'error' broadcast, which only reaches
    // continuously-attached views. Everyone else (reconnect, background
    // reclaim, restart) got a quiet stop; this makes the failure part of the
    // conversation record. ⚠️ in the content makes it unmistakable; error:true
    // lets the view style the bubble.
    async _persistFailureNote(detail, { atIdx = null, messageId = null, model = null } = {}) {
        const msg = {
            conversationId: this.conversationId,
            role: 'assistant',
            content: `⚠️ ${detail}`,
            model: model || this.conv?.model || undefined,
            error: true
        };
        if (messageId) msg.id = messageId;
        const { message: stored } = atIdx !== null
            ? await convStore.insertConversationMessageAt(this.ctx(), { conversationId: this.conversationId, message: msg, atIdx })
            : await convStore.appendConversationMessage(this.ctx(), msg);
        this.broadcast('msg.assistant', this.viewMessage(stored));
        return stored;
    }

    // Stall detector: abort the in-flight gateway request if no data flows for
    // STREAM_STALL_MS. Reset on every chunk (consume) — a hung stream (gateway
    // accepted but never streams, or stalls mid-generation) is the failure mode
    // this guards against.
    resetStallTimer() {
        clearTimeout(this._stallTimer);
        this._stallTimer = setTimeout(() => {
            if (this.inFlight && !this.inFlight.stalled) {
                this.inFlight.stalled = true;
                DEPS.log().warn('Runner stream stall', { chatId: this.conversationId, ms: STREAM_STALL_MS }, 'Runner');
                this.inFlight.controller.abort();
            }
        }, STREAM_STALL_MS);
    }

    // ---- view attach (SSE: snapshot + live events) ----
    attach(req, res) {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive'
        });
        res.write(':ok\n\n');
        // buildSnapshot is async (real payload count) — send when ready.
        this.buildSnapshot().then(snap => this.sendTo(res, 'snapshot', snap))
            .catch(e => DEPS.log().warn('Snapshot build failed', { chatId: this.conversationId, error: e.message }, 'Runner'));
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
        // Multiplex into the user-level stream (issue #19): the browser view
        // listens on ONE shared /api/events SSE and routes by chatId, instead of
        // holding one EventSource open per chat.
        DEPS.emitUserEvent?.(this.user.id, this.conversationId, event, data);
    }

    // Progress indication: log + broadcast a phase transition so a view (and the
    // logs) can show what the backend is doing between run.start and the first
    // delta. Phases: assembling → streaming → (tool.start/end) → run.end.
    _status(phase, message) {
        DEPS.log().info('Runner phase', { chatId: this.conversationId, phase, message }, 'Runner');
        this.broadcast('run.status', { messageId: this.inFlight?.messageId ?? null, phase, message });
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

    async buildSnapshot() {
        this.refresh();
        const lastAssistant = [...this.conv.messages].reverse().find(m => m.role === 'assistant' && (m.usage || m.context));
        // The pill means "how close am I to the limit" — the on-the-wire payload
        // (post chunk-view dedup + retirements), NOT the raw stored history. Run
        // the same assembly a turn would, and count that, so load and live agree.
        let realUsed = null;
        let rawUsed = null;
        let windowSize = lastAssistant?.context?.window_size ?? null;
        try {
            const { apiMessages, rawMessages } = await this._assemblePayload();
            realUsed = countApiMessages(apiMessages, this.session.model);
            rawUsed = countApiMessages(rawMessages, this.session.model);
            if (windowSize == null) {
                const models = await getModels();
                windowSize = models.find(m => m.id === this.session.model)?.capabilities?.contextWindow ?? null;
            }
        } catch (e) {
            DEPS.log().warn('Snapshot context count failed', { chatId: this.conversationId, error: e.message }, 'Runner');
        }
        const realContext = realUsed == null ? (lastAssistant?.context ?? null) : {
            window_size: windowSize,
            used_tokens: realUsed,
            raw_tokens: rawUsed,
            available_tokens: windowSize != null ? Math.max(0, windowSize - realUsed) : null,
            strategy_applied: false,
            counted: 'runner'
        };
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
                pinned: !!this.session.pinned,
                // Active retirements ({ hash: { distill, at, label } }) so the view
                // can show WHICH chunks the model retired + read each distillation.
                retirements: this.session.retirements || {}
            },
            messages: this.conv.messages.map(m => this.viewMessage(m)),
            inFlight: this.inFlight ? this.inFlightView() : null,
            running: this.running,
            contextHistory: this.contextHistory,
            lastRun: lastAssistant ? { usage: lastAssistant.usage ?? null, context: realContext } : { usage: null, context: realContext }
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
        if (!this.pendingModel) this.pendingModel = message.model || null;
        if (body.model && body.model !== this.session.model) {
            this.session.model = body.model;
            this.dbInstance.db.set(this.session._id, 'model', body.model);
            // #27 — converge all attached views on the actual conversation model.
            this.broadcast('model.changed', { model: body.model });
        }
        this.broadcast('msg.user', this.viewMessage(message));
        this.touch();
        this.pendingSends++;
        this.generationParams = {};
        for (const k of ['temperature', 'max_tokens', 'reasoning_effort', 'enable_thinking']) {
            if (body[k] !== undefined) this.generationParams[k] = body[k];
        }
        // PARITY with the old chat: never force enable_thinking. When no
        // reasoning_effort is selected, send NOTHING and let the gateway apply
        // its per-model default (thinking on for local models). Forcing
        // enable_thinking=false made small models roleplay the tool manual
        // (2026-08-25) — thinking is the scratchpad that digests it.
        this.kick();
        return { message };
    }

    kick() {
        if (this.running) return; // queued — the loop picks it up (batch)
        this.running = true;
        this._setActiveRunStamp();
        this.runLoop()
            .catch(async err => {
                DEPS.log().error('Runner runLoop crashed', { chatId: this.conversationId, error: err?.message, stack: err?.stack }, 'Runner');
                this.broadcast('error', { code: 'runner', message: err?.message || 'runLoop crashed' });
                await this._persistFailureNote(`Runner crashed: ${err?.message || 'unknown error'}`).catch(() => {});
            })
            .finally(() => {
                this.running = false;
                if (this.pendingSends > 0) this.kick();
                else this._clearActiveRunStamp();
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
                // Dynamic per-hop comparison, NOT a reset: attaching mid-run
                // (views.size goes non-zero) naturally raises the ceiling — at
                // hop 20 unattended you open the session and the bar becomes the
                // attended tier, so it keeps going. Detaching lowers it again.
                const limit = this.views.size > 0 ? MAX_TOOL_HOPS_ATTENDED : MAX_TOOL_HOPS_UNATTENDED;
                if (hops >= limit) {
                    const tier = this.views.size > 0 ? 'attended' : 'unattended';
                    DEPS.log().warn('Runner tool-hop cap reached', { chatId: this.conversationId, hops, tier, limit }, 'Runner');
                    this.broadcast('error', { code: 'tool-hop-cap', message: `Tool chain stopped after ${limit} hops (${tier}).` });
                    await this._persistFailureNote(`Tool chain stopped after ${limit} hops (${tier}) — send "continue" to resume.`);
                    break;
                }
                more = true;
                continue;
            }
            if (this.pendingSends > 0) { this.pendingSends = 0; more = true; }
            else more = false;
        }
    }

    // Assemble the exact outgoing payload (system prompt + chunk-view/dedup/
    // retirement transform + image resolution). Single source of truth shared by
    // runOnce (the live turn) and buildSnapshot (the on-load context figure), so
    // the pill counts the SAME thing whether the conversation is fresh-loaded or
    // mid-stream — fixing the load-vs-live divergence (#10).
    async _assemblePayload(turnModel = null) {
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
            memoryToolsAvailable: pool.hasToolPrefix('memory.'),
            // #28 — the model of THIS turn, so the seat knows its own substrate.
            // turnModel is authoritative: runOnce clears pendingModel BEFORE
            // assembly, so pendingModel here would already be null (2026-08-31
            // blank-substrate bug). Resolved to the full models-list entry
            // (5-min TTL cache — same poll the model select uses) so the seat
            // knows its upstream, context window, vision, thinking levels.
            substrate: await this._substrateEntry(turnModel || this.pendingModel || this.session.model || null)
        });
        const { messages, chunkTable, chunkStats, rawMessages } = buildApiMessages(this.conv.messages, {
            systemPrompt,
            publicOrigin: DEPS.publicOrigin,
            chunkTransform: this.session.chunkTransform === true,
            retirements: this.session.retirements || {},
            chunkView,
            log: DEPS.log(),
            readImageBytes: (bucket, id, ext) => this.dbInstance.db.getFile(bucket, id, ext)
        });
        return { apiMessages: messages, rawMessages, chunkStats, chunkTable, mcpOrigin };
    }

    // Auto-vision (restored server-side 2026-08-29; the pre-BFF client-side
    // workflow was dropped in 4367b54 and never re-homed): a non-vision model
    // can't see attached images natively, so run the MCP vision pipeline
    // (session_create → analyze → session_close) over each NEW image
    // attachment and store the analysis ON the attachment. api-view injects it
    // into the payload text — the model receives real image understanding with
    // the request instead of a bare manifest. Vision models never enter here
    // (native path). The analysis persists, so later turns keep it as context.
    async _ensureVisionAnalysis(modelSupportsVision) {
        if (modelSupportsVision) return;
        this.refresh();
        const msgs = this.conv.messages;
        // Only TRAILING user messages (since the last assistant reply) — new,
        // unprocessed sends. History must not re-analyze on a model switch.
        let start = msgs.length - 1;
        while (start >= 0 && msgs[start].role !== 'assistant') start--;
        const pending = [];
        for (let i = start + 1; i < msgs.length; i++) {
            const m = msgs[i];
            if (m.role !== 'user' || !Array.isArray(m.attachments)) continue;
            for (const att of m.attachments) {
                if (!att || typeof att !== 'object') continue;
                if (att.visionAnalysis || att.visionAnalysisError) continue;
                const ref = parseFileRef(att._file);
                if (!ref && !(typeof att.dataUrl === 'string' && att.dataUrl.startsWith('data:'))) continue;
                pending.push({ msg: m, att, ref });
            }
        }
        if (pending.length === 0) return;

        const pool = mcpPool.getForUser(this.user, this.dbInstance);
        await pool.ensureConnected();
        // The workshop MCP server (mcp/compact, sse/compact) exposes a SINGLE
        // dispatcher tool named 'tools' — vision.session_create / vision.analyze
        // are agent.action METHODS routed through it, not individual tools.
        let dispatcher = null;
        for (const name of pool.registry.keys()) {
            if (name === 'tools' || name.endsWith('__tools')) { dispatcher = name; break; }
        }
        if (!dispatcher) {
            // Boundary tolerance WITH a trace: attachments ride as manifest only.
            DEPS.log().warn('Auto-vision: MCP dispatcher tool unavailable — attachments ride as manifest only', { chatId: this.conversationId }, 'Runner');
            return;
        }
        const callVision = async (method, payload) => {
            const result = await pool.callTool(dispatcher, { method, payload });
            const text = this.extractToolResult(result).text;
            let obj = null;
            try { obj = JSON.parse(text); } catch { obj = null; }
            return { obj, text };
        };

        const EXT_MIME_LOCAL = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };
        let dirty = false;
        for (const { msg, att, ref } of pending) {
            this._status('vision', `Analyzing attached image "${att.name || 'image'}" (model has no native vision)…`);
            this.broadcast('vision.start', { messageId: msg.id, name: att.name || null });
            let visionSession = null;
            try {
                let b64, mime;
                if (ref) {
                    const buffer = this.dbInstance.db.getFile(ref.bucket, ref.id, ref.ext);
                    if (!buffer) throw new Error(`bucket read empty for ${att._file}`);
                    b64 = Buffer.from(buffer).toString('base64');
                    mime = att.type || EXT_MIME_LOCAL[ref.ext] || 'application/octet-stream';
                } else {
                    const comma = att.dataUrl.indexOf(',');
                    mime = att.type || att.dataUrl.slice(5, comma).split(';')[0] || 'image/png';
                    b64 = att.dataUrl.slice(comma + 1);
                }
                const created = await callVision('vision.session_create', { image_data: b64, image_mime_type: mime });
                // session_create answers PROSE ("Session created: img_……. …"),
                // not JSON — take the structured id when present, else extract
                // it from the text.
                visionSession = created.obj?.sessionId || created.obj?.session_id || created.obj?.id
                    || (String(created.text).match(/Session created:\s*([A-Za-z0-9_-]+)/)?.[1])
                    || (String(created.text).match(/\b(img_[A-Za-z0-9_-]+)\b/)?.[1])
                    || null;
                if (!visionSession) throw new Error('vision session_create returned no session id: ' + String(created.text).slice(0, 200));

                const analyzed = await callVision('vision.analyze', {
                    session_id: visionSession,
                    query: 'Describe this image in detail for a text-only model that cannot see it: any visible text (verbatim), objects, people, layout, colors, and anything needed to answer questions about it.'
                });
                const analysis = (typeof analyzed.obj === 'string' ? analyzed.obj : null)
                    || analyzed.obj?.analysis || analyzed.obj?.text || analyzed.obj?.result
                    || (typeof analyzed.text === 'string' ? analyzed.text.trim() : '');
                if (!analysis) throw new Error('vision analyze returned no text');
                att.visionAnalysis = analysis;
                att.visionAnalyzedAt = new Date().toISOString();
                dirty = true;
                this.broadcast('vision.end', { messageId: msg.id, name: att.name || null, status: 'success', analysis });
                DEPS.log().info('Auto-vision analysis stored', { chatId: this.conversationId, messageId: msg.id, name: att.name || null, analysisLen: analysis.length }, 'Runner');
            } catch (e) {
                att.visionAnalysisError = e.message;
                dirty = true; // persist the error marker — no silent retry-loop every turn
                this.broadcast('vision.end', { messageId: msg.id, name: att.name || null, status: 'error', error: e.message });
                DEPS.log().warn('Auto-vision analysis failed', { chatId: this.conversationId, messageId: msg.id, name: att.name || null, error: e.message }, 'Runner');
            } finally {
                if (visionSession) {
                    try { await callVision('vision.session_close', { session_id: visionSession }); } catch { /* session hygiene — the vision server times sessions out itself */ }
                }
            }
        }
        if (dirty) {
            this.dbInstance.db.set(this.conv._id, 'messages', msgs);
        }
    }

    // §5a: per-turn context report — the two numbers (raw = no-measures payload,
    // wire = exact payload sent) + per-measure savings + a cache hint (did this
    // turn's prefix survive from last turn). reasoningStripped is not reported
    // here: the reasoning policy is gateway-side (§3) and invisible to the
    // runner — reasoningTokens (what's ON the wire) is the honest number.
    _contextReport({ apiMessages, rawMessages, chunkStats, breakdown, model }) {
        const rawTokens = countApiMessages(rawMessages, model);
        // Cache hint: per-message hashes compared against last turn at the same
        // indices. Append-only history → all previous messages match → 'stable'.
        // A mutation (retirement, edit, reasoning change) breaks at its index —
        // report WHERE, not just that. (Whole-prefix hash can't work: every
        // turn appends, so the prefix legitimately grows each turn.)
        const mix = (h, s) => { for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h; };
        const hashes = apiMessages.map(m => {
            let h = 0x811c9dc5;
            h = mix(h, m.role);
            h = mix(h, typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
            if (m.reasoning_content) h = mix(h, m.reasoning_content);
            if (m.tool_calls) h = mix(h, JSON.stringify(m.tool_calls));
            return h;
        });
        let cacheHint = null;
        if (this._lastMsgHashes) {
            const prev = this._lastMsgHashes;
            let breakAt = -1;
            for (let i = 0; i < prev.length; i++) {
                if (i >= hashes.length || hashes[i] !== prev[i]) { breakAt = i; break; }
            }
            cacheHint = breakAt === -1 ? 'stable' : `broken at msg[${breakAt}]`;
        }
        this._lastMsgHashes = hashes;
        return {
            at: new Date().toISOString(),
            rawTokens,
            wireTokens: breakdown.total,
            reasoningTokens: breakdown.byField.reasoning,
            dedupSavedBytes: chunkStats?.dedupSavedBytes ?? 0,
            retiredSavedBytes: chunkStats?.retiredSavedBytes ?? 0,
            retiredCount: chunkStats?.retired ?? 0,
            chunkCount: chunkStats?.chunks ?? 0,
            cacheHint
        };
    }

    // The full models-list entry for a model id (cached poll), or the bare id
    // when the gateway list is unreachable — substrate is informational, a
    // lookup failure must never kill a run.
    async _substrateEntry(modelId) {
        if (!modelId) return null;
        try {
            const entries = await getModels();
            return entries.find(m => m.id === modelId) || modelId;
        } catch (e) {
            DEPS.log().warn('Substrate lookup failed, using bare model id', { chatId: this.conversationId, model: modelId, error: e.message }, 'Runner');
            return modelId;
        }
    }

    async runOnce() {
        this.refresh();
        // Per-send capture: the model the FIRST queued send chose, not whatever
        // session.model says now (a second view may have switched it mid-queue).
        const model = this.pendingModel || this.session.model;
        this.pendingModel = null;
        if (!model) {
            this.broadcast('error', { code: 'no-model', message: 'No model selected for this conversation.' });
            await this._persistFailureNote('No model selected for this conversation — pick a model and resend.');
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
        this._status('assembling', 'Assembling context + tool definitions…');

        let outcome = 'stop';
        try {
            // Vision capability BEFORE assembly: for non-vision models the
            // auto-vision step below produces + persists the analysis that
            // api-view then injects into the payload.
            let modelSupportsVision = false;
            try {
                const models = await getModels();
                modelSupportsVision = models.find(m => m.id === model)?.capabilities?.vision === true;
            } catch (e) {
                DEPS.log().warn('Model capability lookup failed', { chatId: this.conversationId, error: e.message }, 'Runner');
            }
            await this._ensureVisionAnalysis(modelSupportsVision);

            const { apiMessages, rawMessages, chunkStats, chunkTable, mcpOrigin } = await this._assemblePayload(model);
            this._chunkTable = chunkTable;
            // Keep the exact payload for the run-end context count (the real
            // on-the-wire size — the limit-relevant number).
            this.inFlight.apiMessages = apiMessages;

            // Verification log: the full token breakdown of what's actually sent,
            // so the console shows exactly where the tokens are each turn.
            {
                const b = breakdownApiMessages(apiMessages, model);
                this.inFlight.contextReport = this._contextReport({ apiMessages, rawMessages, chunkStats, breakdown: b, model });
                const head = `[token-count] ${this.conversationId.slice(-8)} turn payload: ${b.total} tok ` +
                    `(content ${b.byField.content} + reasoning ${b.byField.reasoning} + toolCalls ${b.byField.toolCalls} + overhead ${b.byField.overhead}) across ${apiMessages.length} msgs`;
                console.log(head); // stdout — visible in the nPM console, not just the JSON log
                DEPS.log().info(head, null, 'Runner');
                for (const row of b.messages) {
                    DEPS.log().info(`[token-count]   msg[${row.i}] ${row.role}: total=${row.total} (content=${row.content} reasoning=${row.reasoning} toolCalls=${row.toolCalls})`, null, 'Runner');
                }
            }

            // Keep the model's true window for the context denominator. (The
            // used_tokens figure is computed at run end from the full stored
            // history — see endRun — not from this dedup'd request payload.)
            try {
                const modelsForWindow = await getModels();
                const win = modelsForWindow.find(m => m.id === model)?.capabilities?.contextWindow;
                if (win) this.inFlight.realWindowSize = win;
            } catch { /* window lookup is cosmetic — the count is the fix */ }

            // PB-b: internal tools (archive/browser_fetch/attachment_save,
            // retirement in chunkTransform chats) + the user's MCP tools
            // (pool auto-connects lazily), vision-filtered like the client.
            // pool must be defined HERE — the _assemblePayload extraction
            // (394f965) moved the original declaration away and 04a415d fixed
            // mcpOrigin but left this dangling: every turn since logged
            // "MCP pool unavailable: pool is not defined" and ran tool-less.
            const pool = mcpPool.getForUser(this.user, this.dbInstance);
            let tools = internalTools.getToolDefs({ chunkTransform: this.session.chunkTransform === true });
            let mcpTools = [];
            try {
                mcpTools = await pool.getFormattedTools();
            } catch (e) {
                DEPS.log().warn('MCP pool unavailable', { chatId: this.conversationId, error: e.message }, 'Runner');
            }
            // Vision-tool gating on capability alone (lookup done above, before
            // assembly). The old [Auto-vision: marker sniff was dead — nothing
            // produced that marker between the rework and the server-side
            // auto-vision restore (2026-08-29). Vision model → sees images
            // natively, vision tools are redundant indirection → filtered.
            // Non-vision model → tools kept as the fallback path. (#21 / #18)
            tools = tools.concat(internalTools.filterVisionTools(mcpTools, { modelSupportsVision }));
            this._toolsAdvertised = tools.length > 0;
            this._mcpOrigin = mcpOrigin;
            this.resetStallTimer();
            this._ttftTimer = setTimeout(() => {
                if (this.inFlight && !this.inFlight.firstDeltaAt && !this.inFlight.stalled) {
                    this.inFlight.stalled = true;
                    this.inFlight.ttftTimeout = true;
                    DEPS.log().warn('Runner TTFT timeout', { chatId: this.conversationId, ms: TTFT_MS, model }, 'Runner');
                    this.inFlight.controller.abort();
                }
            }, TTFT_MS);
            this._status('streaming', 'Calling model…');

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
                // FAIL LOUD: a gateway non-2xx is a real error. Log it (nLogger) so
                // it's never a silent hang, and broadcast to attached views.
                DEPS.log().error('Gateway error', null, { chatId: this.conversationId, status: resp.status, body: text.slice(0, 1000) }, 'Runner');
                // Debug capture: the exact payload that failed (thinking-contract hunts)
                try {
                    require('fs').writeFileSync(require('path').join(__dirname, '..', '_scratch', 'last-error-payload.json'),
                        JSON.stringify({ status: resp.status, model, generationParams: this.generationParams, toolsCount: tools.length, messages: apiMessages }, null, 2));
                } catch { /* debug only */ }
                this.broadcast('error', { code: `gateway-${resp.status}`, message: `Gateway ${resp.status}`, raw: text.slice(0, 2000), exchangeId });
                this.inFlight.errorDetail = `Gateway ${resp.status}: ${errorDetailFromBody(text, 'no error body')}`;
                outcome = 'error';
            } else {
                await this.consume(resp);
                outcome = this.abortRequested ? 'aborted' : (this.inFlight.finishReason || 'stop');
            }
        } catch (err) {
            if (this.abortRequested) {
                outcome = 'aborted';
            } else if (this.inFlight?.stalled) {
                const stallMsg = this.inFlight.ttftTimeout
                    ? `No response from gateway within ${TTFT_MS / 1000}s — first token never arrived (hung request).`
                    : `Gateway stream stalled — no data for ${STREAM_STALL_MS / 1000}s.`;
                DEPS.log().error('Runner stream stalled', null, { chatId: this.conversationId, ttft: this.inFlight.ttftTimeout === true, ms: this.inFlight.ttftTimeout ? TTFT_MS : STREAM_STALL_MS }, 'Runner');
                this.broadcast('error', { code: this.inFlight.ttftTimeout ? 'ttft-timeout' : 'stream-stall', message: stallMsg, exchangeId });
                this.inFlight.errorDetail = stallMsg;
                outcome = 'error';
            } else if (err?.name === 'AbortError') {
                outcome = 'aborted';
            } else {
                DEPS.log().error('Runner stream error', { chatId: this.conversationId, error: err?.message }, 'Runner');
                this.broadcast('error', { code: 'stream', message: err?.message || 'stream error', exchangeId });
                this.inFlight.errorDetail = err?.message || 'stream error';
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
        for (let i = 0; i < toolCalls.length; i++) {
            const tc = toolCalls[i];
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
            // Insert the tool result at its RESERVED position — right after the
            // assistant (f.idx + 1 + i). A queued user send that landed between
            // endRun and here must NOT split the assistant's tool_calls from its
            // result (anthropic rejects "tool_use without tool_result"). The insert
            // re-indexes everything after it.
            const { message: toolMsg } = await convStore.insertConversationMessageAt(this.ctx(), {
                conversationId: this.conversationId,
                atIdx: f.idx + 1 + i,
                message: {
                    role: 'tool',
                    content: resultText,
                    toolName: tc.function.name,
                    toolArgs: args,
                    toolStatus: status,
                    toolImages: resultImages.length ? resultImages : undefined,
                    tool_call_id: tc.id
                }
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
                // Let attached views update the retirement indicator live.
                this.broadcast('retirements', { retirements: map });
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
            // Any real upstream frame disarms the TTFT trip — a tool_calls-only
            // stream never produces content deltas and must not trip it.
            clearTimeout(this._ttftTimer);
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
            if (any) { this.broadcast('delta', out); this.resetStallTimer(); }
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
        clearTimeout(this._stallTimer);
        clearTimeout(this._ttftTimer);
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

        // Authoritative context = the actual on-the-wire payload (what hits the
        // context-window limit), counted from the exact apiMessages array sent.
        // This is "how close am I to the limit" — the limit-relevant number.
        // f.apiMessages was captured at assembly time in runOnce.
        let context = f.context || null;
        if (f.apiMessages) {
            const windowSize = f.realWindowSize || context?.window_size || null;
            const used = countApiMessages(f.apiMessages, f.model);
            context = {
                window_size: windowSize,
                used_tokens: used,
                available_tokens: windowSize != null ? Math.max(0, windowSize - used) : null,
                strategy_applied: context?.strategy_applied ?? false,
                counted: 'runner' // provenance: real on-the-wire payload count
            };
            // §5a: fold the per-turn report into the context payload so views
            // get raw/wire/savings/cache-hint with run.end — no second request.
            if (f.contextReport) {
                context.raw_tokens = f.contextReport.rawTokens;
                context.reasoning_tokens = f.contextReport.reasoningTokens;
                context.savings = {
                    dedup_bytes: f.contextReport.dedupSavedBytes,
                    retired_bytes: f.contextReport.retiredSavedBytes,
                    retired_count: f.contextReport.retiredCount,
                    chunks: f.contextReport.chunkCount
                };
                context.cache_hint = f.contextReport.cacheHint;
            }
        }
        if (f.contextReport) {
            f.contextReport.outcome = outcome;
            this.contextHistory.push(f.contextReport);
            if (this.contextHistory.length > 50) this.contextHistory.shift();
        }

        if (outcome === 'error') {
            // FAIL LOUD, durably: persist the failure at the reserved slot so
            // every current AND future view sees where and why the run died.
            // The transient 'error' broadcast alone only reaches continuously-
            // attached views — everyone else got a quiet stop (2026-08-25).
            await this._persistFailureNote(f.errorDetail || 'Run failed.', { atIdx: f.idx, messageId: f.messageId, model: f.model });
        } else if (hasPayload) {
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
                    // Stored content is timestamp-free by invariant (2026-08-31):
                    // timestamps live in the api-view projection from createdAt.
                    // Strip any model-echoed leading prefix so it can never double.
                    content: f.content.replace(LEADING_TS_REGEX, ''),
                    model: f.model,
                    reasoning_content: isAbort ? undefined : (f.reasoning_content || undefined),
                    thinking_signature: isAbort ? undefined : (f.thinkingSignature || undefined),
                    streamStats,
                    usage: f.usage || undefined,
                    context: context || undefined,
                    tool_calls: toolCalls.length ? toolCalls : undefined
                }
            });
            this.broadcast('msg.assistant', this.viewMessage(message));
        }
        this.broadcast('run.end', {
            finishReason: outcome,
            usage: f.usage, context,
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

    // Delete a message (PC): the runner is the single author, so a view deletes
    // through it and every attached view hears msg.deleted. Deleting a USER
    // message cascades — the whole turn (user + its assistant + any tool
    // messages) goes, matching the old exchange-level delete and preventing an
    // orphaned assistant (which would 400 the next gateway payload).
    async deleteMessage(messageId) {
        this.refresh();
        const pos = this.conv.messages.findIndex(m => m.id === messageId);
        if (pos === -1) throw new Error(`deleteMessage: message not found: ${messageId}`);

        const target = this.conv.messages[pos];
        const ids = [messageId];
        if (target.role === 'user') {
            for (let i = pos + 1; i < this.conv.messages.length; i++) {
                if (this.conv.messages[i].role === 'user') break;
                ids.push(this.conv.messages[i].id);
            }
        }

        for (const id of ids) {
            await convStore.deleteConversationMessage(this.ctx(), {
                conversationId: this.conversationId, messageId: id
            });
        }
        this.refresh(); // conv/session objects are stale after the writes
        this.broadcast('msg.deleted', { messageId, role: target.role });
        this.touch();
        return { deleted: true, messageId, removedCount: ids.length };
    }

    // Edit a message in place (PC). Dispatch by role: USER edit truncates after
    // it and re-runs (the edited message becomes the pending turn); ASSISTANT
    // edit updates the answer in place WITHOUT re-running (correcting/trimming,
    // not re-generating the turn).
    async editMessage(messageId, content) {
        this.refresh();
        const target = this.conv.messages.find(m => m.id === messageId);
        if (!target) throw new Error(`editMessage: message not found: ${messageId}`);

        if (target.role === 'assistant') {
            await convStore.editAssistantMessageContent(this.ctx(), {
                conversationId: this.conversationId, messageId, content
            });
            this.refresh();
            this.broadcast('snapshot', await this.buildSnapshot());
            return { edited: true, messageId };
        }

        const { edited, removedCount } = await convStore.editUserMessageAndTruncate(this.ctx(), {
            conversationId: this.conversationId, messageId, content
        });
        this.refresh();
        // Full snapshot: one edit + N removals is cleaner as a re-render than
        // N incremental events.
        this.broadcast('snapshot', await this.buildSnapshot());
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

// Return a mounted runner without creating one (route handlers that mutate
// session state outside send() — e.g. PATCH model — use this to notify views).
function peekRunner(userId, conversationId) {
    return registry.get(`${userId}:${conversationId}`) || null;
}

module.exports = { init, getRunner, peekRunner, handleEmbedStatus };
