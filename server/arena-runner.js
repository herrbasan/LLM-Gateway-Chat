// ============================================
// arena-runner.js — the ArenaRunner (Phase D).
// A runner variant for autonomous N-participant conversations. Unlike the chat
// runner, the arena models are ISOLATED: no tools, no MCP pool, no internal
// tools, no archive/memory system-prompt context. Two models alternate turns
// over a bare topic + conversation history, streamed over the same SSE event
// surface as the chat runner. The view is a spectator — the conversation runs
// whether or not anyone is watching.
// Design: docs/architecture-conversation-runner.md §6.
// ============================================

const convStore = require('./conversation-store');

let DEPS = null;
// deps = { gatewayUrl, gatewayKey, embedMessageAsync, log }
function init(deps) { DEPS = deps; }

// Abort the gateway stream if no data arrives for this long (same guard as the
// chat runner — a hung gateway/model must not wedge the turn forever).
const STREAM_STALL_MS = 300000;

const registry = new Map(); // `${userId}:${conversationId}` -> ArenaRunner

function getArenaRunner(user, dbInstance, conversationId) {
    const key = `${user.id}:${conversationId}`;
    let r = registry.get(key);
    if (!r) {
        r = new ArenaRunner(user, dbInstance, conversationId);
        registry.set(key, r);
    }
    return r;
}

// Relay embed status onto the arena stream (same shape as the chat runner).
function handleEmbedStatus(evt) {
    if (!evt?.chatId) return;
    for (const r of registry.values()) {
        if (r.conversationId === evt.chatId) {
            r.broadcast('embed.status', { messageId: evt.messageId, status: evt.embedStatus, embedError: evt.embedError ?? null, idx: evt.msgIdx });
        }
    }
}

function _formatArenaTime(date) {
    const pad = (n) => n.toString().padStart(2, '0');
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

// Models echo the identity prefix back — strip it before storing.
function _stripIdentityPrefix(content) {
    return content.replace(/\[[\w.-]+ · \d{2}:\d{2}:\d{2}\]:\s*/g, '').trim();
}

class ArenaRunner {
    constructor(user, dbInstance, conversationId) {
        this.user = user;
        this.dbInstance = dbInstance;
        this.conversationId = conversationId;
        const { db } = dbInstance;
        this.session = convStore.findSessionOrThrow(db, conversationId);
        this.conv = convStore.findOrCreateConversation(db, this.session, user);
        this.views = new Set();
        this.running = false;
        this.abortRequested = false;
        this.abortController = null;
        this.currentTurn = 0;
        this.activeSpeaker = null; // 'A' | 'B'
        this.inFlight = null;      // { speaker, speakerName, model, messageId, exchangeId, ... }
        this._stallTimer = null;
    }

    ctx() {
        return { user: this.user, dbInstance: this.dbInstance, embedMessageAsync: DEPS.embedMessageAsync, log: DEPS.log() };
    }

    refresh() {
        const { db } = this.dbInstance;
        this.session = convStore.findSessionOrThrow(db, this.conversationId);
        this.conv = convStore.findOrCreateConversation(db, this.session, this.user);
    }

    config() {
        return this.session.arenaConfig || {};
    }

    speakerName(key) {
        const cfg = this.config();
        if (key === 'A') return cfg.nameA || cfg.modelA || 'Model A';
        return cfg.nameB || cfg.modelB || 'Model B';
    }

    speakerModel(key) {
        const cfg = this.config();
        return key === 'A' ? cfg.modelA : cfg.modelB;
    }

    // ---- view attach (SSE: snapshot + live events) — same contract as chat ----
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
    }

    sendTo(res, event, data) {
        try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* view gone */ }
    }

    broadcast(event, data) {
        for (const res of this.views) this.sendTo(res, event, data);
    }

    viewMessage(m) {
        const cloned = JSON.parse(JSON.stringify(m));
        if (cloned.attachments) cloned.attachments = convStore.densifyAttachments(cloned.attachments);
        return cloned;
    }

    buildSnapshot() {
        this.refresh();
        return {
            meta: {
                id: this.session.id,
                title: this.session.title,
                mode: this.session.mode || 'arena',
                arenaConfig: this.session.arenaConfig || null,
                pinned: !!this.session.pinned
            },
            messages: this.conv.messages.map(m => this.viewMessage(m)),
            inFlight: this.inFlight ? this.inFlightView() : null,
            running: this.running,
            currentTurn: this.currentTurn,
            activeSpeaker: this.activeSpeaker
        };
    }

    inFlightView() {
        const f = this.inFlight;
        return {
            id: f.messageId, role: 'assistant', speaker: f.speakerName, model: f.model,
            content: f.content, reasoning_content: f.reasoning_content, isStreaming: true
        };
    }

    resetStallTimer() {
        clearTimeout(this._stallTimer);
        this._stallTimer = setTimeout(() => {
            if (this.inFlight && !this.inFlight.stalled) {
                this.inFlight.stalled = true;
                DEPS.log().warn('Arena stream stall', { chatId: this.conversationId, ms: STREAM_STALL_MS }, 'Arena');
                this.inFlight.controller.abort();
            }
        }, STREAM_STALL_MS);
    }

    // ---- start / stop ----
    // config = { modelA, modelB, nameA, nameB, topic, maxTurns, autoAdvance,
    //            systemPromptA, systemPromptB, temperature, reasoningEffort, showIdentities }
    async start(config) {
        if (this.running) return;
        const { db } = this.dbInstance;
        const cfg = { ...this.config(), ...config };
        this.session.arenaConfig = cfg;
        db.set(this.session._id, 'arenaConfig', cfg);
        db.set(this.session._id, 'updatedAt', new Date().toISOString());

        // Persist the topic as a moderator system message if the conversation is empty.
        this.refresh();
        if (this.conv.messages.length === 0 && cfg.topic) {
            const { message } = await convStore.appendConversationMessage(this.ctx(), {
                conversationId: this.conversationId,
                role: 'system',
                speaker: 'moderator',
                content: cfg.topic
            });
            this.broadcast('msg.moderator', this.viewMessage(message));
        }

        // Derive position from history (this.conv already refreshed above): the
        // turn counter is cumulative across starts, so continue/extend runs only
        // the remaining turns (maxTurns is a total), and the speaker alternates
        // from whoever spoke last instead of re-randomizing mid-conversation.
        const assistantMsgs = this.conv.messages.filter(m => m.role === 'assistant');
        this.currentTurn = assistantMsgs.length;
        const lastSpeaker = assistantMsgs.at(-1)?.speaker;
        this.activeSpeaker = lastSpeaker
            ? (lastSpeaker === this.speakerName('A') ? 'B' : 'A')
            : (Math.random() < 0.5 ? 'A' : 'B');
        this.abortRequested = false;
        this.kick();
    }

    stop() {
        this.abortRequested = true;
        if (this.inFlight?.controller) this.inFlight.controller.abort();
        this.broadcast('arena.end', { reason: 'stopped', turn: this.currentTurn });
    }

    kick() {
        if (this.running) return;
        this.running = true;
        this.broadcast('arena.start', { activeSpeaker: this.activeSpeaker, turn: this.currentTurn });
        this.runLoop()
            .catch(err => {
                DEPS.log().error('Arena runLoop crashed', { chatId: this.conversationId, error: err?.message, stack: err?.stack }, 'Arena');
                this.broadcast('error', { code: 'arena', message: err?.message || 'runLoop crashed' });
            })
            .finally(() => { this.running = false; });
    }

    async runLoop() {
        const maxTurns = this.config().maxTurns || 10;
        while (this.running && !this.abortRequested && this.currentTurn < maxTurns) {
            await this.runOneTurn();
            if (this.abortRequested) break;
            this._advanceTurn();
        }
        if (!this.abortRequested) {
            this.broadcast('arena.end', { reason: 'maxTurns', turn: this.currentTurn });
        }
    }

    _advanceTurn() {
        this.currentTurn++;
        this.activeSpeaker = this.activeSpeaker === 'A' ? 'B' : 'A';
    }

    async runOneTurn() {
        // nDB find() returns detached copies — this.conv is frozen at the last
        // refresh, so without this every turn would build the payload from the
        // conversation as it was at mount (topic-only → models repeat themselves).
        this.refresh();
        const speakerKey = this.activeSpeaker;
        const model = this.speakerModel(speakerKey);
        const speakerName = this.speakerName(speakerKey);
        if (!model) {
            this.broadcast('error', { code: 'no-model', message: `No model configured for ${speakerName}.` });
            this.abortRequested = true;
            return;
        }

        const exchangeId = 'ex_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
        const messageId = 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
        this.inFlight = {
            exchangeId,
            messageId,
            speaker: speakerKey,
            speakerName,
            model,
            content: '', reasoning_content: '', thinkingSignature: null,
            usage: null, context: null,
            startedAt: Date.now(), firstDeltaAt: null,
            controller: new AbortController(),
            stalled: false
        };
        this.broadcast('turn.start', { turn: this.currentTurn, speaker: speakerKey, speakerName, model });
        this.broadcast('run.start', { exchangeId, model, messageId, speaker: speakerKey, speakerName });

        const messages = this.buildMessages(speakerKey);
        const cfg = this.config();
        const body = {
            model,
            messages,
            stream: true,
            session_id: this.conversationId,
            tools: [] // ISOLATION: arena models have no tool access, ever.
        };
        if (cfg.temperature !== undefined) body.temperature = cfg.temperature;
        // Explicit thinking control — the local models default to enable_thinking
        // true in config, which leaks reasoning tokens into the conversation and
        // makes them loop. Disable unless the user asked for reasoning.
        body.extra_body = { chat_template_kwargs: { enable_thinking: !!cfg.reasoningEffort } };
        if (cfg.reasoningEffort) {
            body.reasoning_effort = cfg.reasoningEffort;
        }

        this.resetStallTimer();
        let outcome = 'stop';
        try {
            const resp = await fetch(`${DEPS.gatewayUrl}/v1/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(DEPS.gatewayKey ? { Authorization: `Bearer ${DEPS.gatewayKey}` } : {})
                },
                body: JSON.stringify(body),
                signal: this.inFlight.controller.signal
            });
            if (!resp.ok) {
                const text = await resp.text().catch(() => '');
                DEPS.log().error('Arena gateway error', null, { chatId: this.conversationId, status: resp.status, body: text.slice(0, 1000) }, 'Arena');
                this.broadcast('error', { code: `gateway-${resp.status}`, message: `Gateway ${resp.status}`, raw: text.slice(0, 2000), exchangeId });
                outcome = 'error';
            } else {
                await this.consume(resp);
                outcome = this.abortRequested ? 'aborted' : 'stop';
            }
        } catch (err) {
            if (this.abortRequested) {
                outcome = 'aborted';
            } else if (this.inFlight?.stalled) {
                DEPS.log().error('Arena stream stalled', null, { chatId: this.conversationId, ms: STREAM_STALL_MS }, 'Arena');
                this.broadcast('error', { code: 'stream-stall', message: `Gateway stream stalled — no data for ${STREAM_STALL_MS / 1000}s.`, exchangeId });
                outcome = 'error';
            } else if (err?.name === 'AbortError') {
                outcome = 'aborted';
            } else {
                DEPS.log().error('Arena stream error', { chatId: this.conversationId, error: err?.message }, 'Arena');
                this.broadcast('error', { code: 'stream', message: err?.message || 'stream error', exchangeId });
                outcome = 'error';
            }
        }

        await this.endTurn(outcome);
    }

    async endTurn(outcome) {
        clearTimeout(this._stallTimer);
        const f = this.inFlight;
        if (!f) return;
        const cleanContent = _stripIdentityPrefix(f.content);
        if (cleanContent) {
            const streamStats = {
                ttftMs: f.firstDeltaAt ? f.firstDeltaAt - f.startedAt : null,
                durationMs: Date.now() - f.startedAt,
                approxTokens: Math.ceil(f.content.length / 4),
                aborted: outcome === 'aborted'
            };
            const { message } = await convStore.appendConversationMessage(this.ctx(), {
                conversationId: this.conversationId,
                role: 'assistant',
                speaker: f.speakerName,
                model: f.model,
                content: cleanContent,
                reasoning_content: f.reasoning_content || undefined,
                thinking_signature: f.thinkingSignature || undefined,
                streamStats,
                usage: f.usage || undefined,
                context: f.context || undefined
            });
            this.broadcast('msg.assistant', this.viewMessage(message));
        }
        this.broadcast('run.end', {
            exchangeId: f.exchangeId, messageId: f.messageId, speaker: f.speaker, speakerName: f.speakerName,
            finishReason: outcome, usage: f.usage, context: f.context
        });
        this.inFlight = null;
    }

    // Port of the client's Participant._buildMessages. The topic (moderator
    // system message) becomes a system message; the speaker's own turns become
    // assistant messages, the other participant's turns become user messages,
    // both identity-prefixed when showIdentities is on.
    buildMessages(speakerKey) {
        const cfg = this.config();
        const speakerName = this.speakerName(speakerKey);
        const showIdentities = cfg.showIdentities !== false;
        const history = this.conv.messages;
        const messages = [];

        const topicMsg = history.find(m => m.role === 'system' && m.speaker === 'moderator');
        if (topicMsg) messages.push({ role: 'system', content: topicMsg.content });

        // Roleplay system prompt (template-substituted) for this speaker.
        const rawPrompt = speakerKey === 'A' ? cfg.systemPromptA : cfg.systemPromptB;
        if (rawPrompt) {
            const otherName = speakerKey === 'A' ? this.speakerName('B') : this.speakerName('A');
            const otherModel = speakerKey === 'A' ? this.speakerModel('B') : this.speakerModel('A');
            const topic = topicMsg ? topicMsg.content.replace(/^Topic:\s*/i, '') : (cfg.topic || '');
            const prompt = rawPrompt
                .replace('{modelName}', this.speakerModel(speakerKey) || '')
                .replace('{otherParticipantName}', otherName)
                .replace('{otherModelName}', otherModel || '')
                .replace('{topic}', topic);
            messages.push({ role: 'system', content: prompt });
        }

        let userMsgCount = 0;
        for (const msg of history) {
            if (msg === topicMsg) continue;
            if (msg.speaker === 'moderator' && msg.content?.trim()) {
                messages.push({ role: 'user', content: msg.content.trim() });
                continue;
            }
            if (msg.role !== 'assistant') continue;
            if (!msg.content || !msg.content.trim()) continue;

            if (showIdentities) {
                const timeStr = msg.createdAt ? _formatArenaTime(new Date(msg.createdAt)) : '';
                const timePart = timeStr ? ` · ${timeStr}` : '';
                const prefix = `[${msg.speaker}${timePart}]:\n`;
                if (msg.speaker === speakerName) {
                    messages.push({ role: 'assistant', content: prefix + msg.content, name: speakerName });
                } else {
                    messages.push({ role: 'user', content: prefix + msg.content, name: msg.speaker });
                    userMsgCount++;
                }
            } else {
                if (msg.speaker !== speakerName) {
                    messages.push({ role: 'user', content: msg.content });
                    userMsgCount++;
                }
            }
        }

        // Ensure at least one user-role message (topic text as fallback).
        if (!messages.some(m => m.role === 'user') && topicMsg) {
            const topicText = topicMsg.content.replace(/^Topic:\s*/i, '').trim();
            if (topicText) {
                const sysCount = messages.filter(m => m.role === 'system').length;
                messages.splice(sysCount, 0, { role: 'user', content: topicText });
            }
        }

        return messages;
    }

    // SSE parser — same shape as the chat runner's consume(), minus tool_calls
    // (the arena never advertises tools, so finish_reason is always stop).
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
            let any = false;
            if (typeof delta.content === 'string' && delta.content) {
                if (f.firstDeltaAt === null) f.firstDeltaAt = Date.now();
                f.content += delta.content;
                this.broadcast('delta', { messageId: f.messageId, exchangeId: f.exchangeId, content: delta.content, speaker: f.speaker });
                any = true;
            }
            if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
                if (f.firstDeltaAt === null) f.firstDeltaAt = Date.now();
                f.reasoning_content += delta.reasoning_content;
                this.broadcast('delta', { messageId: f.messageId, exchangeId: f.exchangeId, reasoningContent: delta.reasoning_content, speaker: f.speaker });
                any = true;
            }
            if (delta.thinking_signature) f.thinkingSignature = delta.thinking_signature;
            if (choice.message?.thinking_signature) f.thinkingSignature = choice.message.thinking_signature;
            if (json.thinking_signature) f.thinkingSignature = json.thinking_signature;
            if (any) this.resetStallTimer();
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
}

module.exports = { init, getArenaRunner, handleEmbedStatus };
