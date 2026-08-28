// ============================================
// LLM Gateway Chat - Main Controller
// ============================================

import { Conversation, messagesToExchanges } from './conversation.js';
import { renderMarkdown, parseThinking } from './markdown.js';
import { imageStore } from './image-store.js';
import { mcpClient } from './mcp-client.js';
import { chatHistory } from './chat-history.js';
import { storage } from './storage.js';
import { getPlainText } from './tts-utils.js';
import { backendClient } from './api-client.js';
import { NSpeechController } from '../../lib/tts/nspeech-controller.js';
import { TtsPlayerHost } from '../../lib/tts/tts-player.js';
import { preview } from './preview.js';
import { runnerClient } from './runner-client.js';

// Fire-and-forget client log to server nLogger — never throws
function _logTool(message, meta = {}) {
    if (backendClient?.clientLog) {
        backendClient.clientLog('Tool', message, meta).catch(() => {});
    }
}

// Persistence hook for MCP request lifecycle endpoints (resolved/rejected/
// timeout/zombie/orphan). Wired here because mcp-client.js has no backendClient
// access; the client calls window._mcpTracePersist for terminal events only.
window._mcpTracePersist = (entry) => {
    _logTool(`MCP ${entry.event}`, {
        requestId: entry.requestId,
        tool: entry.tool,
        server: entry.server,
        elapsedMs: entry.elapsed,
        error: entry.error || null
    });
};

// Config values with defaults
const CONFIG = window.CHAT_CONFIG || {};
const DEFAULT_MODEL = CONFIG.defaultModel || '';
const DEFAULT_TEMPERATURE = CONFIG.defaultTemperature ?? 0.7;
const DEFAULT_MAX_TOKENS = CONFIG.defaultMaxTokens || '';
const TTS_ENDPOINT = CONFIG.ttsEndpoint || '/api/tts'; // same-origin backend proxy → nSpeech
const TTS_VOICE = CONFIG.ttsVoice || '';
const TTS_SPEED = CONFIG.ttsSpeed ?? 1.0;
const BACKEND_URL = CONFIG.backendUrl !== undefined ? CONFIG.backendUrl : 'http://localhost:3500';
const BACKEND_API_KEY = CONFIG.backendApiKey || '';

// ============================================
// Chunk savings pill (header widget)
// ============================================
// Per-chat accumulator: chars the transform removed from outgoing payloads,
// shown as estimated tokens (chars/3.5, consistent with our other estimates).
// In-memory only — testing-phase widget, no persistence.
const _chunkSavings = { chatId: null, charsSaved: 0, displayed: 0, animFrame: null };

function updateChunkSavingsPill(stats) {
    if (!stats || !currentChatId) return;
    if (_chunkSavings.chatId !== currentChatId) {
        _chunkSavings.chatId = currentChatId;
        _chunkSavings.charsSaved = 0;
        _chunkSavings.displayed = 0;
        _chunkSavings.lastAt = 0;
    }
    // updateUsageDisplay fires from multiple paths per request (progress
    // events + finalize). The stats object carries `at` (set once per
    // getMessagesForApi call) — accumulate each request exactly once.
    if (stats.at && stats.at === _chunkSavings.lastAt) return;
    if (stats.at) _chunkSavings.lastAt = stats.at;
    const saved = Math.max(0, (stats.bytesIn || 0) - (stats.bytesOut || 0));
    _chunkSavings.charsSaved += saved;

    const pill = document.getElementById('chunk-savings-pill');
    const valueEl = document.getElementById('chunk-savings-value');
    if (!pill || !valueEl) return;
    if (_chunkSavings.charsSaved <= 0) return;

    pill.style.display = 'inline-flex';
    const target = Math.round(_chunkSavings.charsSaved / 3.5);

    // Count-up animation toward the new total
    if (_chunkSavings.animFrame) cancelAnimationFrame(_chunkSavings.animFrame);
    const start = _chunkSavings.displayed;
    const delta = target - start;
    if (delta <= 0) return;
    const t0 = performance.now();
    const DURATION = 900;
    const step = (t) => {
        const p = Math.min(1, (t - t0) / DURATION);
        const eased = 1 - Math.pow(1 - p, 3);
        _chunkSavings.displayed = Math.round(start + delta * eased);
        valueEl.textContent = _chunkSavings.displayed.toLocaleString();
        if (p < 1) {
            _chunkSavings.animFrame = requestAnimationFrame(step);
        } else {
            _chunkSavings.animFrame = null;
            pill.classList.remove('pulse');
            void pill.offsetWidth; // restart animation
            pill.classList.add('pulse');
        }
    };
    _chunkSavings.animFrame = requestAnimationFrame(step);

    const refs = (stats.exactDupes || 0) + (stats.nearDupes || 0);
    pill.title = `Chunk dedup — ~${target.toLocaleString()} tokens kept out of requests this chat.\nLast request: ${(stats.bytesOut / 1000).toFixed(0)}K sent vs ${(stats.bytesIn / 1000).toFixed(0)}K raw, ${refs} reference${refs === 1 ? '' : 's'}.`;
}

// Resolve the configured MCP server origin — the single source of truth for
// how THIS client reaches the workshop (LAN IP locally, dyndns remotely).
// Never hardcode a storage/MCP host: derive it from the user's configured
// server list so the same code works from any network location.
function getMcpServerOrigin() {
    const server = (mcpClient.servers || []).find(s => s.url);
    if (!server) return null;
    try {
        return new URL(server.url).origin;
    } catch (_) {
        return null;
    }
}







// State
let currentChatId = null;
let conversation = null;

// Multi-conversation: per-chat DOM containers (hidden containers for background chats)
const chatContainers = new Map(); // chatId -> HTMLDivElement
// Multi-conversation: in-memory conversation objects (avoid re-loading from backend)
const activeConversations = new Map(); // chatId -> Conversation
// Chats that received new content while in background (cleared when viewed)
const chatsWithNewContent = new Set();

// Embed status — SSE event source for real-time updates
let _embedEventSource = null;
let _embedEventChatId = null;

let models = [];
let currentModel = '';
let isStreaming = false;
let currentExchangeId = null;
let attachedImages = []; // Array of {dataUrl, name, type}
let useVisionAnalysis = false; // Toggle for using vision tool instead of direct image upload

// TTS State — managed by NSpeechController (instantiated after DOM elements are bound)
let tts = null;
let ttsPlayer = null;
let currentTtsExchangeId = null;

// DOM Elements
const elements = {
    modelSelect: document.getElementById('model-select'),
    temperature: document.getElementById('temperature'),
    thinkingEffortSelect: document.getElementById('thinking-effort-select'),
    maxTokens: document.getElementById('max-tokens'),
    systemPrompt: document.getElementById('system-prompt'),
    presetSelect: document.getElementById('preset-select'),
    managePresetsBtn: document.getElementById('manage-presets-btn'),
    presetsDialog: document.getElementById('presets-dialog'),
    userName: document.getElementById('user-name'),
    userLocation: document.getElementById('user-location'),
    userLanguage: document.getElementById('user-language'),
    messages: document.getElementById('messages'),
    messageInput: document.getElementById('message-input'),
    sendBtn: document.getElementById('send-btn'),
    attachBtn: document.getElementById('attach-btn'),
    fileInput: document.getElementById('file-input'),
    importChatInput: document.getElementById('import-chat-input'),
    importChatBtn: document.getElementById('import-chat-btn'),
    attachmentPreview: document.getElementById('attachment-preview'),
    newChatBtn: document.getElementById('new-chat-btn'),
    chatHistoryList: document.getElementById('chat-history-list'),
    themeToggle: document.getElementById('theme-toggle'),
    sidebar: document.getElementById('sidebar'),
    sidebarToggle: document.getElementById('sidebar-toggle'),
    sidebarToggleMobile: document.getElementById('sidebar-toggle-mobile'),
    overallContextProgressWrap: document.getElementById('overall-context-progress-wrap'),
    overallContextProgress: document.getElementById('overall-context-progress'),
    overallContextTooltip: document.getElementById('overall-context-tooltip'),
    stopButton: document.getElementById('stop-btn'), // Added safe fallback

    // TTS Elements
    ttsEngineSelect: document.getElementById('tts-engine-select'),
    ttsVoiceSelect: document.getElementById('tts-voice-select'),
    ttsSpeed: document.getElementById('tts-speed'),
    ttsMdClean: document.getElementById('tts-md-clean')?.closest('nui-checkbox'),
    ttsStitch: document.getElementById('tts-stitch')?.closest('nui-checkbox'),
    ttsStatus: document.getElementById('tts-status')
};

// ============================================
// Runner view — event-driven rendering (PC realign).
// The runner is the single author of conversation state. These handlers feed
// the EXISTING renderer from snapshot + live events. send → runnerClient.send;
// render ← GET /api/chats/:id/events. Tools / delete / edit / regenerate are a
// follow-up increment (their handlers are stubs here to avoid errors).
// ============================================
const runnerViews = new Map(); // chatId -> { es, streaming: { exchangeId, el, content, reasoningContent } }

function _runnerStreaming(chatId) {
    return runnerViews.get(chatId).streaming;
}

function _findExchangeByMsgId(conv, messageId) {
    for (const ex of conv.exchanges) {
        if (ex._userMsgId === messageId || ex._asstMsgId === messageId || ex._toolMsgId === messageId) return ex;
    }
    return null;
}

// ---- live waiting indicator ----
// The "Waiting for response…" line ticks the elapsed time and flags slow phases,
// so a stuck run (no phase change for 30s+) is visually distinct from a busy one.
const WAIT_WARN_MS = 30000;

function _formatElapsed(ms) {
    const sec = Math.floor(ms / 1000);
    if (sec < 60) return `${sec}s`;
    return `${Math.floor(sec / 60)}m ${sec % 60}s`;
}

function _tickWaiting(chatId) {
    const s = _runnerStreaming(chatId);
    if (!s?.el) return;
    const waitingText = s.el.querySelector('.assistant-waiting-text');
    if (!waitingText) return;
    const elapsedMs = Date.now() - (s.phaseStart || Date.now());
    waitingText.textContent = `${s.phase || 'Working…'} · ${_formatElapsed(elapsedMs)}`;
    const waiting = s.el.querySelector('.assistant-waiting');
    if (waiting) waiting.classList.toggle('slow', elapsedMs >= WAIT_WARN_MS);
}

function _startWaitingTicker(chatId) {
    const s = _runnerStreaming(chatId);
    if (!s) return;
    if (s.tickTimer) clearInterval(s.tickTimer);
    s.phaseStart = Date.now();
    s.tickTimer = setInterval(() => _tickWaiting(chatId), 1000);
    _tickWaiting(chatId);
}

function _stopWaitingTicker(chatId) {
    const s = _runnerStreaming(chatId);
    if (s?.tickTimer) { clearInterval(s.tickTimer); s.tickTimer = null; }
}

// ---- global activity indicator (header) ----
// Persists across the WHOLE turn (generation + tool hops), so the user always
// sees that the backend is doing something and for how long.
let _activityPhase = 'Working…';
let _activityStart = 0;
let _activityTimer = null;

function _showActivity(message) {
    _activityPhase = message || 'Working…';
    _activityStart = Date.now();
    const el = document.getElementById('activity-indicator');
    if (el) el.style.display = '';
    if (_activityTimer) clearInterval(_activityTimer);
    _activityTimer = setInterval(_activityTick, 1000);
    _activityTick();
}

function _hideActivity() {
    const el = document.getElementById('activity-indicator');
    if (el) el.style.display = 'none';
    if (_activityTimer) { clearInterval(_activityTimer); _activityTimer = null; }
}

function _setActivityPhase(message) {
    _activityPhase = message || 'Working…';
    _activityStart = Date.now();
    _activityTick();
}

function _activityTick() {
    const el = document.getElementById('activity-indicator');
    const text = document.getElementById('activity-indicator-text');
    if (!el || !text) return;
    const elapsedMs = Date.now() - _activityStart;
    text.textContent = `${_activityPhase} · ${_formatElapsed(elapsedMs)}`;
    el.classList.toggle('slow', elapsedMs >= WAIT_WARN_MS);
}

function attachRunnerEvents(chatId) {
    if (runnerViews.has(chatId)) return; // idempotent — background chats keep their stream

    const container = getOrCreateContainer(chatId);
    const view = { es: null, running: false, streaming: { exchangeId: null, el: null, content: '', reasoningContent: '', toolBubbles: new Map(), phase: 'Working…', phaseStart: 0, tickTimer: null } };
    runnerViews.set(chatId, view);

    view.es = runnerClient.attach(chatId, {
        snapshot(snap) {
            const conv = activeConversations.get(chatId);
            if (!conv) return;
            conv.exchanges = messagesToExchanges(snap.messages || []);
            // Full re-render (initial attach OR post-mutation refresh/edit).
            _vsDeactivate(container);
            container.replaceChildren();
            buildHistoricalDomForChat(conv, container).then(() => _vsActivateWhenReady(container));
            if (snap.lastRun?.context) updateOverallContext(snap.lastRun.context);
            // Authoritative run state — covers a run that started before attach.
            view.running = !!snap.running;
            if (snap.running) _showActivity('Working…');
            if (snap.inFlight) _runnerResumeInflight(chatId, snap.inFlight);
            updateSendButton();
        },
        'run.start'(d) { _runnerRunStart(chatId, d); },
        delta(d) { _runnerDelta(chatId, d); },
        'tool.start'(d) { _runnerToolStart(chatId, d); },
        'tool.end'(d) { _runnerToolEnd(chatId, d); },
        'msg.assistant'(d) { _runnerAssistant(chatId, d); },
        'msg.user'(d) { _runnerUser(chatId, d); },
        'msg.deleted'(d) { _runnerDeleted(chatId, d); },
        'run.end'(d) { _runnerRunEnd(chatId, d); },
        'run.status'(d) { _runnerStatus(chatId, d); },
        'run.state'(d) {
            const view = runnerViews.get(chatId);
            if (view) view.running = !!d.running;
            const meta = chatHistory.conversations.find(c => c.id === chatId);
            if (meta) meta.activeRun = d.running ? (meta.activeRun || { startedAt: new Date().toISOString() }) : null;
            if (chatId === currentChatId) updateSendButton();
            renderHistoryList();
        },
        error(d) { _runnerError(chatId, d); },
        'embed.status'(d) { _runnerEmbed(chatId, d); }
    });
}

function _runnerUser(chatId, msg) {
    const conv = activeConversations.get(chatId);
    if (!conv) return;
    const exchange = messagesToExchanges([msg])[0];
    if (!exchange) return;
    conv.exchanges.push(exchange);
    renderExchange(exchange, getOrCreateContainer(chatId));
    _runnerStreaming(chatId).exchangeId = exchange.id;
}

function _runnerRunStart(chatId, d) {
    const container = getOrCreateContainer(chatId);
    const view = runnerViews.get(chatId);
    if (view) view.running = true;
    const s = _runnerStreaming(chatId);
    if (s.exchangeId) {
        container.querySelector(`.chat-message.user[data-exchange-id="${s.exchangeId}"] .user-pending-indicator`)?.classList.remove('visible');
    }
    if (!s.el) {
        s.el = createAssistantElement(s.exchangeId || 'inflight', '', d.model || '');
        s.el.dataset.isStreaming = 'true';
        _vsAppendMessage(container, s.el);
    }
    s.content = '';
    s.reasoningContent = '';
    markChatAsStreaming(chatId, true);
    updateSendButton();
    scrollToBottom(container);
    _startWaitingTicker(chatId);
    _showActivity('Working…');
}

function _runnerStatus(chatId, d) {
    const s = _runnerStreaming(chatId);
    if (!s.el) return;
    s.phase = d.message || 'Working…';
    s.phaseStart = Date.now();
    _tickWaiting(chatId);
    _setActivityPhase(d.message);
}

function _runnerDelta(chatId, d) {
    const s = _runnerStreaming(chatId);
    if (!s.el) return;
    if (d.content !== undefined) s.content += d.content;
    if (d.reasoningContent !== undefined) s.reasoningContent += d.reasoningContent;
    if (s._pending) return;
    s._pending = true;
    const el = s.el;
    setTimeout(() => {
        s._pending = false;
        // The run may have ended (s.el nulled) or a new run started — only
        // render if this element is still the active in-flight one.
        if (s.el !== el || !el.isConnected) return;
        updateAssistantContent(el, s.content, s.reasoningContent);
        const c = getOrCreateContainer(chatId);
        if (isNearBottom(100, c)) scrollToBottom(c);
    }, 50);
}

function _runnerAssistant(chatId, msg) {
    const conv = activeConversations.get(chatId);
    const s = _runnerStreaming(chatId);
    if (conv) {
        const ex = conv.getExchange(s.exchangeId) || conv.exchanges[conv.exchanges.length - 1];
        if (ex) {
            ex.assistant.content = msg.content || '';
            ex.assistant.reasoning_content = msg.reasoning_content || null;
            ex.assistant.usage = msg.usage || null;
            ex.assistant.context = msg.context || null;
            ex.assistant.streamStats = msg.streamStats || null;
            ex.assistant.model = msg.model || ex.assistant.model || null;
            ex.assistant.embedStatus = msg.embedStatus || 'pending';
            if (msg.error) ex.assistant.error = true;
            ex.assistant.isComplete = true;
            ex.assistant.isStreaming = false;
            ex._asstMsgId = msg.id || null;
        }
    }
    if (s.el) {
        finalizeAssistantElement(s.el, s.exchangeId, msg.usage, msg.context, msg.streamStats, conv);
        forceFinalizeMarkdownStream(s.el, msg.content || '', msg.reasoning_content || null);
    }
}

function _runnerRunEnd(chatId, d) {
    _stopWaitingTicker(chatId);
    const view = runnerViews.get(chatId);
    const s = _runnerStreaming(chatId);
    // Chain continues on tool_calls — stays running. Anything else drains the
    // chain (a queued follow-up re-fires run.start, which re-sets the flag).
    const chainDone = d.finishReason !== 'tool_calls';
    if (view && chainDone) view.running = false;
    if (d.finishReason === 'aborted' && s.el) {
        showError(s.el, 'Stopped');
        forceFinalizeMarkdownStream(s.el, s.content, s.reasoningContent);
    }
    if (d.context) updateOverallContext(d.context);
    markChatAsStreaming(chatId, false);
    updateSendButton();
    s.el = null;
    s.exchangeId = null;
    renderHistoryList();
    if (d.finishReason !== 'tool_calls') _hideActivity();
    // Reclaim finished background chats — their stream + hidden DOM would
    // otherwise accumulate forever and exhaust the browser's 6-connection
    // HTTP/1.1 pool (everything network then hangs; tab appears dead).
    if (chatId !== currentChatId && d.finishReason !== 'tool_calls') {
        _teardownView(chatId);
    }
}

// Tear down a chat's view: close its SSE stream, drop its hidden DOM
// container and cached conversation. The chat re-attaches cleanly (fresh
// snapshot) the next time it is opened. Never tears down the visible chat.
function _teardownView(chatId) {
    if (chatId === currentChatId) return;
    const v = runnerViews.get(chatId);
    if (v?.es) { try { v.es.close(); } catch {} }
    if (v?.streaming?.tickTimer) clearInterval(v.streaming.tickTimer);
    runnerViews.delete(chatId);
    activeConversations.delete(chatId);
    const container = chatContainers.get(chatId);
    if (container) {
        _vsDeactivate(container);
        container.remove();
        chatContainers.delete(chatId);
    }
}

function _runnerError(chatId, d) {
    _stopWaitingTicker(chatId);
    _hideActivity();
    const view = runnerViews.get(chatId);
    if (view) view.running = false;
    updateSendButton();
    const s = _runnerStreaming(chatId);
    if (s.el) {
        showError(s.el, d.message || 'error');
        forceFinalizeMarkdownStream(s.el, s.content, s.reasoningContent);
    }
}

function _runnerEmbed(chatId, d) {
    const conv = activeConversations.get(chatId);
    if (!conv) return;
    const ex = _findExchangeByMsgId(conv, d.messageId);
    if (ex) setEmbedStatus(ex.id, d.status, d.embedError || null);
}

function _runnerResumeInflight(chatId, inFlight) {
    const conv = activeConversations.get(chatId);
    const container = getOrCreateContainer(chatId);
    const s = _runnerStreaming(chatId);
    const lastEx = conv?.exchanges[conv.exchanges.length - 1];
    s.exchangeId = lastEx?.id || 'inflight';
    s.el = createAssistantElement(s.exchangeId, '', inFlight.model || '');
    s.el.dataset.isStreaming = 'true';
    _vsAppendMessage(container, s.el);
    s.content = inFlight.content || '';
    s.reasoningContent = inFlight.reasoning_content || '';
    if (s.content || s.reasoningContent) updateAssistantContent(s.el, s.content, s.reasoningContent);
    markChatAsStreaming(chatId, true);
    _startWaitingTicker(chatId);
    updateSendButton();
}

// Tool rendering — the runner executes tools server-side and broadcasts
// tool.start / tool.end. The view renders a bubble per tool call; the follow-up
// assistant (post-tool) keys to the LAST tool exchange, matching
// messagesToExchanges grouping. Delete/edit/regenerate are a later follow-up.

function _runnerToolStart(chatId, d) {
    const conv = activeConversations.get(chatId);
    const container = getOrCreateContainer(chatId);
    const s = _runnerStreaming(chatId);
    if (!conv) return;

    const exchange = {
        id: 'ex_' + (Date.now() + Math.random()),
        timestamp: Date.now(),
        type: 'tool',
        _toolMsgId: null,
        tool: { name: d.name || 'unknown', args: d.args || {}, status: 'pending', content: '', images: [] },
        user: { role: 'user', content: '', attachments: [] },
        assistant: { role: 'assistant', content: '', versions: [], currentVersion: 0, isStreaming: false, isComplete: false }
    };
    conv.exchanges.push(exchange);

    const el = _runnerToolBubble(d.name, d.args);
    el.dataset.exchangeId = exchange.id;
    el.dataset.mcpToolName = d.name || '';
    _vsAppendMessage(container, el);
    scrollToBottom(container);

    s.toolBubbles.set(d.toolCallId, { el, exchange });
    _setActivityPhase('Running tool…');
}

function _runnerToolEnd(chatId, d) {
    const s = _runnerStreaming(chatId);
    const entry = s.toolBubbles.get(d.toolCallId);
    if (!entry) return;

    const { el, exchange } = entry;
    const status = d.status === 'error' ? 'error' : 'success';
    exchange.tool.status = status;
    exchange.tool.content = d.resultMessage || '';
    exchange.tool.images = d.resultImages || [];
    exchange._toolMsgId = d.toolMessageId || null;
    // The follow-up assistant (post-tool) keys to this tool exchange.
    s.exchangeId = exchange.id;

    _runnerFinalizeTool(el, status, d.resultMessage || '', d.resultImages || []);
    s.toolBubbles.delete(d.toolCallId);
}

// Build a tool bubble in "Running" state (matches the retired handleToolExecution
// markup). The delete button is deferred to the delete/edit follow-up.
function _runnerToolBubble(name, args) {
    const el = document.createElement('div');
    el.className = 'chat-message tool';
    el.innerHTML = `
        <div class="tool-bubble">
            <div class="message-header tool-header">
                <nui-icon name="extension"></nui-icon>
                <strong class="tool-title">${formatToolDisplayName(name, args)}</strong>
                <nui-badge variant="primary" class="tool-status">Running</nui-badge>
            </div>
            <div class="tool-notifications" style="display: block;">
                <span class="tool-spinner"></span> Running…
            </div>
            <div class="tool-images" style="display: none;"></div>
            <div class="message-content tool-payload" style="display: none;">
                <div class="tool-section-title">Arguments</div>
                <div class="tool-args">${jsonStringifyForDisplay(args)}</div>
                <div class="tool-section-title">Execution Result</div>
                <div class="tool-result"></div>
            </div>
        </div>
    `;
    el.querySelector('.message-header').addEventListener('click', (e) => {
        if (e.target.tagName.toLowerCase() === 'button' || e.target.closest('button')) return;
        const payloadBox = el.querySelector('.tool-payload');
        payloadBox.style.display = payloadBox.style.display === 'none' ? 'block' : 'none';
    });
    _decoratePreviewToolButton(el, name, args);
    return el;
}

function _runnerFinalizeTool(el, status, result, images) {
    const isError = status === 'error';
    el.querySelector('.tool-status').setAttribute('variant', isError ? 'danger' : 'success');
    el.querySelector('.tool-status').innerHTML = isError ? 'Failed' : 'Success';
    el.querySelector('.tool-notifications').style.display = 'none';
    // textContent (not innerHTML) — tool content can contain arbitrary markup
    const resultEl = el.querySelector('.tool-result');
    resultEl.innerHTML = isError ? '<strong>Error:</strong> ' : '<strong>Result:</strong><br>';
    resultEl.appendChild(document.createTextNode(result || ''));
    if (isError) {
        const notif = el.querySelector('.tool-notifications');
        notif.style.display = 'block';
        notif.innerHTML = '<span class="tool-error-text"></span> <span class="tool-error-hint">— click for details</span>';
        notif.querySelector('.tool-error-text').textContent = toolErrorSummary(result || '');
    }
    if (images && images.length > 0) {
        const imagesDiv = el.querySelector('.tool-images');
        imagesDiv.style.display = 'block';
        imagesDiv.innerHTML = images.map(img => `<img src="${img}" class="tool-image" />`).join('');
    }
}

// Delete / edit / variant (single-author through the runner). Regenerate needs a
// runner method (not yet built) — deferred.
function _runnerDeleteMessage(exchange, role) {
    const msgId = role === 'assistant' ? exchange?._asstMsgId
        : role === 'tool' ? exchange?._toolMsgId
        : exchange?._userMsgId;
    if (!msgId) return;
    runnerClient.deleteMessage(currentChatId, msgId).catch(() => {});
}

function _runnerDeleted(chatId, d) {
    // Re-render from a fresh snapshot (message removal re-groups exchanges).
    setTimeout(() => _runnerRefresh(chatId), 0);
}

function _runnerRefresh(chatId) {
    const v = runnerViews.get(chatId);
    if (v?.es) { try { v.es.close(); } catch {} }
    runnerViews.delete(chatId);
    attachRunnerEvents(chatId);
}

// ============================================
// Multi-Conversation: DOM Container Management
// ============================================

/**
 * Gets the container for a given chat, creating it if it doesn't exist.
 * The container is hidden by default; use getActiveContainer() for the visible one.
 */
function getOrCreateContainer(chatId) {
    if (chatContainers.has(chatId)) {
        return chatContainers.get(chatId);
    }
    const container = document.createElement('div');
    container.className = 'conversation-container';
    container.dataset.chatId = chatId;
    container.style.display = 'none'; // Hidden by default; switchChat sets 'flex' for active
    elements.messages.appendChild(container);
    chatContainers.set(chatId, container);
    return container;
}

/**
 * Gets the currently active (visible) chat's container.
 * For use in DOM operations within the active conversation.
 */
function getActiveContainer() {
    return chatContainers.get(currentChatId) || elements.messages;
}

/**
 * Returns the chatId of the currently visible (displayed) chat.
 * This is the GROUND TRUTH for which chat the user is looking at,
 * derived from the DOM, not the global currentChatId variable.
 */
function getDisplayedChatId() {
    for (const [id, container] of chatContainers.entries()) {
        if (container.style.display !== 'none') return id;
    }
    return currentChatId; // fallback
}

/**
 * Builds the historical DOM for a chat's container (one-time on first view).
 * Does NOT use renderConversation — builds directly from conversation data.
 */
async function buildHistoricalDomForChat(conv, container) {
    if (!container || !container.classList.contains('conversation-container')) {
        throw new Error(
            `buildHistoricalDomForChat: container must be a .conversation-container, got ${container ? container.tagName + '.' + container.className : 'null'}`
        );
    }
    if (conv.length === 0) {
        _vsShowBusy();
        _vsHideBusy();
        const welcome = document.createElement('div');
        welcome.className = 'welcome-message';
        const h2 = document.createElement('h2');
        h2.textContent = 'Welcome to LLM Gateway Chat';
        const p = document.createElement('p');
        p.textContent = 'Select a model and start chatting';
        welcome.append(h2, p);
        container.replaceChildren(welcome);
        return;
    }
    // Show busy while we render the historical DOM. _vsActivate hides it
    // after the post-activation visibility pass (called from switchChat).
    // WI-5: skip the overlay for small chats — _vsActivate will no-op anyway.
    if (conversation.getAll().length * 2 >= VS_MIN_ITEMS) _vsShowBusy();
    for (const exchange of conv.getAll()) {
        const el = buildExchangeElement(exchange);
        if (el) container.appendChild(el);
    }
}

// ============================================
// Tool display names
// ============================================
//
// Compact MCP servers (workshop /mcp/compact) expose ONE generic tool whose
// real operation lives in the `method` field of the arguments. Display that
// (storage.write, memory.recall) instead of the meaningless generic name.
function formatToolDisplayName(name, args) {
    const method = args && typeof args === 'object' && typeof args.method === 'string'
        ? args.method.trim()
        : '';
    return method ? method : name;
}

// Tool arguments stream as JSON deltas — the pending placeholder may see a
// partial blob. Parse best-effort, return null on any failure.
function parsePartialToolArgs(toolCall) {
    const raw = toolCall?.function?.arguments;
    if (!raw || typeof raw !== 'string') return null;
    try { return JSON.parse(raw); } catch { return null; }
}

// ============================================
// Preview tool-call button — "Show in preview" on chat_preview_show tool bubbles
// ============================================
//
// When the conversation is reloaded, the tool call (with full content in args)
// is in the history. This button lets the user reopen the preview from that
// stored data — no localStorage, no backend, no context bloat. The conversation
// IS the persistence layer.

function _decoratePreviewToolButton(toolEl, toolName, args) {
    if (toolName !== 'chat_preview_show') return;
    if (!args || typeof args !== 'object') return;

    const header = toolEl.querySelector('.tool-header');
    if (!header) return;
    // Don't double-add if already decorated (re-render safety)
    if (header.querySelector('.reopen-preview')) return;

    const btn = document.createElement('nui-button');
    btn.className = 'action-btn reopen-preview';
    btn.setAttribute('variant', 'icon');
    btn.setAttribute('title', 'Show in preview');
    btn.innerHTML = '<button type="button"><nui-icon name="article"></nui-icon></button>';
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        // show() is async now (url mode fetches) — don't let a failed re-fetch
        // become an unhandled rejection.
        preview.show(args).catch(err => console.error('[preview] reopen failed:', err));
    });

    // Insert before the delete button if present, else append
    const deleteBtn = header.querySelector('.delete-tool');
    if (deleteBtn) {
        header.insertBefore(btn, deleteBtn);
    } else {
        header.appendChild(btn);
    }
}

/**
 * Builds a single exchange DOM element (used for historical DOM building).
 * Similar to renderExchange but doesn't append — returns the element.
 */
function buildExchangeElement(exchange) {
    if (exchange.type === 'tool') {
        const parsedObj = { name: exchange.tool.name, args: exchange.tool.args };
        const toolEl = document.createElement('div');
        toolEl.className = 'chat-message tool';
        toolEl.dataset.exchangeId = exchange.id;
        toolEl.dataset.mcpToolName = parsedObj.name;

        const isSuccess = exchange.tool.status === 'success';
        const isError = exchange.tool.status === 'error';
        const displayStatus = isSuccess ? 'Success' : (isError ? 'Failed' : 'Pending');
        const badgeVariant = isSuccess ? 'success' : (isError ? 'danger' : 'primary');

        let hasImages = exchange.tool.images && exchange.tool.images.length > 0;
        let imagesHtml = '';
        if (hasImages) {
            imagesHtml = `<div class="tool-images-container">`;
            exchange.tool.images.forEach(img => {
                imagesHtml += `<img src="${img}" class="tool-image" />`;
            });
            imagesHtml += `</div>`;
        }

        // Interpolate content as escaped text, not raw HTML — tool content can
        // contain arbitrary markup (code examples, SVG, model output), and raw
        // interpolation would parse it as live HTML on history rebuild.
        const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        let resultHtml = '';
        if (isSuccess) resultHtml = `<strong>Result:</strong><br>${esc(exchange.tool.content)}`;
        else if (isError) resultHtml = `<strong>Error:</strong> ${esc(exchange.tool.content)}`;

        // Compact error summary for the collapsed bubble (full text is in the payload)
        const errorSummaryHtml = isError
            ? `<span class="tool-error-text"></span> <span class="tool-error-hint">— click for details</span>`
            : '';

        toolEl.innerHTML = `
            <div class="tool-bubble">
                <div class="message-header tool-header">
                    <nui-icon name="extension"></nui-icon>
                    <strong class="tool-title">${formatToolDisplayName(parsedObj.name, parsedObj.args)}</strong>
                    <nui-badge variant="${badgeVariant}" class="tool-status">${displayStatus}</nui-badge>
                    <nui-button variant="icon" class="action-btn delete-tool" title="Delete Tool Call"><button type="button"><nui-icon name="delete"></nui-icon></button></nui-button>
                </div>
                <div class="tool-notifications" style="display: ${isError ? 'block' : 'none'};">${errorSummaryHtml}</div>
                <div class="tool-images" style="display: ${hasImages ? 'block' : 'none'};">${imagesHtml}</div>
                <div class="message-content tool-payload" style="display: none;">
                    <div class="tool-section-title">Arguments</div>
                    <div class="tool-args">${jsonStringifyForDisplay(parsedObj.args)}</div>
                    <div class="tool-section-title">Execution Result</div>
                    <div class="tool-result">${resultHtml}</div>
                </div>
            </div>
        `;
        if (isError) toolEl.querySelector('.tool-notifications .tool-error-text').textContent = toolErrorSummary(exchange.tool.content);

        _decoratePreviewToolButton(toolEl, parsedObj.name, parsedObj.args);

        toolEl.querySelector('.delete-tool')?.addEventListener('click', (e) => {
            e.stopPropagation();
            _runnerDeleteMessage(exchange, 'tool');
        });

        toolEl.querySelector('.message-header').addEventListener('click', (e) => {
            if (e.target.tagName.toLowerCase() === 'button' || e.target.closest('button')) return;
            const payloadBox = toolEl.querySelector('.tool-payload');
            payloadBox.style.display = payloadBox.style.display === 'none' ? 'block' : 'none';
            // WI-2: height change detected by the frame loop (wake triggered
            // by the container's delegated click listener).
        });

        // Assistant message after tool - create as sibling, not child
        if (exchange.assistant.content || exchange.assistant.isStreaming) {

            const cleanedContent = stripExtraTimestamps(exchange.assistant.content);
            const assistantParsed = parseTimestamp(cleanedContent);
            const vers = exchange.assistant?.versions || [];
            const tsMs = (vers.length > 0 && vers[exchange.assistant?.currentVersion || 0]?.timestamp) || exchange.timestamp || Date.now();
            const assistantTimestamp = assistantParsed.timestamp || new Date(tsMs).toISOString().slice(0,16).replace('T',' @ ');
            const assistantEl = createAssistantElement(exchange.id, assistantTimestamp, exchange.model);

            const tsLen = exchange.assistant.content.length - assistantParsed.cleanContent.length;
            if (tsLen > 0) {
                assistantEl.dataset.timestampLen = tsLen.toString();
                assistantEl.dataset.timestampStripped = 'true';
            }
            updateAssistantContent(assistantEl, assistantParsed.cleanContent, exchange.assistant.reasoning_content);

            if (exchange.assistant.isComplete) {
                finalizeAssistantElement(assistantEl, exchange.id);
            }
            
            // Return a DocumentFragment containing both elements as siblings
            const fragment = document.createDocumentFragment();
            fragment.appendChild(toolEl);
            fragment.appendChild(assistantEl);

            return fragment;
        }

        return toolEl;
    }

    // Regular user + assistant exchange
    const userParsed = parseTimestamp(exchange.user.content);
    const userTimestamp = userParsed.timestamp || (exchange.timestamp && !isNaN(exchange.timestamp) ? new Date(exchange.timestamp).toISOString().slice(0, 16).replace('T', ' @ ') : '');

    let userContent = renderMarkdown(userParsed.cleanContent);
    if (exchange.user?.attachments?.length > 0) {
        userContent += '<div class="message-attachments"><nui-lightbox loop>';
        for (const att of exchange.user.attachments) {
            const imgSrc = att.blobUrl || att.dataUrl || '';
            userContent += `<img src="${imgSrc}" alt="${att.name}" data-lightbox-src="${imgSrc}" class="chat-attachment">`;
        }
        userContent += '</nui-lightbox></div>';
    }

    const userEl = document.createElement('div');
    userEl.className = 'chat-message user';
    userEl.dataset.exchangeId = exchange.id;
    userEl.innerHTML = `
        <div class="message-header">
            You <span class="message-timestamp">${userTimestamp}</span>
            <span class="embed-status" data-embed-status="unknown" title="Embed status unknown">
                <span class="embed-status-dot"></span>
            </span>
            <span class="user-pending-indicator visible">
                <span class="dot">.</span><span class="dot">.</span><span class="dot">.</span>
            </span>
        </div>
        <div class="message-content">${userContent}</div>
        <div class="message-actions-user">
            <nui-button class="action-btn edit-message" title="Edit Message"><button type="button"><nui-icon name="edit"></nui-icon></button></nui-button>
            <nui-button class="action-btn delete-message" title="Delete Message"><button type="button"><nui-icon name="delete"></nui-icon></button></nui-button>
        </div>
    `;
    userEl.querySelector('.edit-message')?.addEventListener('click', () => startEditMode(exchange.id, 'user'));
    userEl.querySelector('.delete-message')?.addEventListener('click', () => {
        _runnerDeleteMessage(exchange, 'user');
    });

    // Set embed status directly on detached element (not in DOM yet)
    const userEmbedEl = userEl.querySelector('.embed-status');
    if (userEmbedEl) _applyEmbedStatusAttrs(userEmbedEl, exchange.user?.embedStatus || 'unknown', exchange.user?.embedError);

    // Assistant message - return as sibling in fragment, not child
    if (exchange.assistant?.content || exchange.assistant?.isStreaming) {
        const cleanedContent = stripExtraTimestamps(exchange.assistant.content);
        const assistantParsed = parseTimestamp(cleanedContent);
        const vers = exchange.assistant?.versions || [];
            const tsMs = (vers.length > 0 && vers[exchange.assistant?.currentVersion || 0]?.timestamp) || exchange.timestamp || Date.now();
            const assistantTimestamp = assistantParsed.timestamp || new Date(tsMs).toISOString().slice(0,16).replace('T',' @ ');
        const assistantEl = createAssistantElement(exchange.id, assistantTimestamp, exchange.model);
        assistantEl.dataset.isStreaming = exchange.assistant.isStreaming ? 'true' : 'false';

        const tsLen = exchange.assistant.content.length - assistantParsed.cleanContent.length;
        if (tsLen > 0) {
            assistantEl.dataset.timestampLen = tsLen.toString();
            assistantEl.dataset.timestampStripped = 'true';
        }
        updateAssistantContent(assistantEl, assistantParsed.cleanContent, exchange.assistant.reasoning_content);
        // Set embed status directly on detached elements (not in DOM yet)
        const uEmbed = userEl.querySelector('.embed-status');
        if (uEmbed) _applyEmbedStatusAttrs(uEmbed, exchange.user?.embedStatus || 'unknown', exchange.user?.embedError);
        const aEmbed = assistantEl.querySelector('.embed-status');
        if (aEmbed) _applyEmbedStatusAttrs(aEmbed, exchange.assistant.embedStatus || 'pending', exchange.assistant.embedError);

        if (exchange.assistant.isComplete) {
            finalizeAssistantElement(assistantEl, exchange.id);
        }
        
        // Return a DocumentFragment containing both elements as siblings
        const fragment = document.createDocumentFragment();
        fragment.appendChild(userEl);
        fragment.appendChild(assistantEl);
        return fragment;
    }

    return userEl;
}

// Create vision toggle container if not exists
function ensureVisionToggleUI() {
    if (!elements.attachmentPreview) return;
    
    let visionToggle = document.getElementById('vision-toggle-container');
    if (!visionToggle) {
        visionToggle = document.createElement('div');
        visionToggle.id = 'vision-toggle-container';
        visionToggle.className = 'vision-toggle-container';
        visionToggle.style.display = 'none';
        visionToggle.innerHTML = `
            <nui-checkbox variant="switch" title="Use MCP vision tools to analyze images. When disabled, images are sent directly to vision-capable models.">
                <input type="checkbox" id="vision-toggle-input">
            </nui-checkbox>
            <label for="vision-toggle-input">MCP Vision</label>
            <span id="vision-mode-indicator" class="vision-mode-indicator"></span>
        `;
        
        // Insert after attachment preview in the images row
        const imagesRow = document.getElementById('images-row');
        if (imagesRow) {
            imagesRow.appendChild(visionToggle);
        } else {
            elements.attachmentPreview.parentNode?.insertBefore(visionToggle, elements.attachmentPreview);
        }
        
        // Set initial state from saved preference
        const checkbox = visionToggle.querySelector('input');
        if (checkbox) {
            checkbox.checked = useVisionAnalysis;
        }

        // Add event listener
        checkbox?.addEventListener('change', (e) => {
            useVisionAnalysis = e.target.checked;
            storage.setPref('mcp-vision-enabled', useVisionAnalysis).catch(() => {});
            updateVisionModeIndicator();
        });

        // Ensure indicator is updated on creation
        updateVisionModeIndicator();
    }
}

// Update the vision mode indicator badge
function updateVisionModeIndicator() {
    const indicator = document.getElementById('vision-mode-indicator');
    if (!indicator) return;
    
    const modelSupportsVision = currentModelSupportsVision();
    
    if (useVisionAnalysis) {
        indicator.textContent = 'MCP';
        indicator.className = 'vision-mode-indicator mcp-mode';
        indicator.title = 'Using MCP vision tools to analyze images';
    } else if (modelSupportsVision) {
        indicator.textContent = 'Direct';
        indicator.className = 'vision-mode-indicator direct-mode';
        indicator.title = 'Sending images directly to model';
    } else {
        indicator.textContent = '';
        indicator.className = 'vision-mode-indicator';
    }
}

// ============================================
// Initialization
// ============================================

async function init() {

    // ---- Verify Session / Auth ----
    if (CONFIG.enableBackend) {
        const loginDialog = document.getElementById('login-dialog');
        const authBanner = document.getElementById('auth-expired-banner');

        backendClient.onAuthError(() => {
            // Session expired mid-use: queue messages locally (crash-net in
            // _syncMessage) and tell the user persistence stopped. The login
            // dialog is dismissable so in-flight content stays readable/copyable;
            // the banner stays up and re-opens the dialog on demand.
            if (authBanner) authBanner.dataset.visible = 'true';
            loginDialog.showModal();
        });

        document.getElementById('login-dismiss').addEventListener('click', () => {
            loginDialog.close();
            // Banner stays visible — persistence is still down, user can re-open.
        });
        document.getElementById('relogin-btn')?.addEventListener('click', () => {
            loginDialog.showModal();
        });

        // Backend-offline alarm. The gateway can keep streaming while the
        // backend (persistence) is dead, so this is the ONLY signal that
        // messages have stopped being saved. Loud + persistent while offline;
        // on recovery, drain the local crash-net back to the backend.
        backendClient.onOfflineChange((offline) => {
            const banner = document.getElementById('backend-offline-banner');
            if (banner) banner.dataset.visible = offline ? 'true' : 'false';
        });

        const loginForm = document.getElementById('login-form');
        loginForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const username = document.getElementById('login-username').value;
            const password = document.getElementById('login-password').value;
            const errorDiv = document.getElementById('login-error');
            errorDiv.textContent = '';
            
            try {
                // Delay 500ms for UX
                document.querySelector('#login-dialog button[type="submit"]').disabled = true;
                await new Promise(r => setTimeout(r, 500));
                
                await backendClient.login(username, password);
                document.getElementById('login-dialog').close();
                // Crash-netted messages are drained before load() on reload —
                // nothing is lost. Reload to re-initialize cleanly.
                window.location.reload();
            } catch (err) {
                errorDiv.textContent = err.message || 'Login failed';
            } finally {
                document.querySelector('#login-dialog button[type="submit"]').disabled = false;
            }
        });

        try {
            const user = await backendClient.verifySession();
            if (!user) {
                document.getElementById('login-dialog').showModal();
                return; // halt init until logged in and reloaded
            }
            if (user.rights?.admin) {
                const btnAdmin = document.getElementById('btn-admin');
                if (btnAdmin) btnAdmin.style.display = '';
            }
        } catch (e) {
            console.warn('Backend probe failed or auth absent', e);
        }
    }

    // ---- Load chat history ----
    if (CONFIG.enableBackend === true && typeof CONFIG.backendUrl === 'string') {
        await chatHistory.refreshList();
    } else {
        await chatHistory.ready();
    }

    // Sidebar sync across devices: any list mutation (chat created/updated/
    // deleted on another view) re-fetches + re-renders this history. refreshList()
    // is idempotent; renderHistoryList() has a structural-signature guard so it
    // only rebuilds when something actually changed.
    if (CONFIG.enableBackend === true && typeof CONFIG.backendUrl === 'string') {
        const onListChange = async () => {
            await chatHistory.refreshList();
            renderHistoryList();
        };
        runnerClient.attachListEvents({
            'chat.created': onListChange,
            'chat.updated': onListChange,
            'chat.deleted': onListChange
        });
    }

    // Restore theme (needs history loaded first for async prefs)
    const savedTheme = await storage.getPref('theme');
    if (savedTheme) {
        await setTheme(savedTheme);
    } else {
        const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        await setTheme(prefersDark ? 'dark' : 'light');
    }

    // Restore unsent composer draft (survives the post-login reload).
    try {
        const draft = sessionStorage.getItem('chat-draft');
        if (draft) elements.messageInput?.setMarkdown(draft);
    } catch { /* ignore — draft restore is best-effort */ }
    // Get or create active conversation
    let activeId = await chatHistory.getActiveId();
    if (!activeId || !chatHistory.has(activeId)) {
        activeId = await chatHistory.create();
    }

    currentChatId = activeId;
    conversation = new Conversation(`chat-conversation-${currentChatId}`);

    // Cache in activeConversations for multi-conversation support
    activeConversations.set(currentChatId, conversation);

    // Apply default config values (needs history loaded first for async prefs)
    await applyDefaultConfig();

    // Restore system prompt for the initially loaded chat
    const chatInfo = chatHistory.get(currentChatId);
    restoreSystemPromptUI(chatInfo);

    // Setup event listeners first
    setupEventListeners();
    setupDialogEventListeners();

    // Initialize preview pane (needs DOM ready + NUI loaded for enableDrag)
    preview.init();

    // URL-fetch mode needs the MCP server origin to resolve relative /storage/...
    // paths. Topology belongs to the client — chat.js owns getMcpServerOrigin.
    preview.setMcpOriginResolver(getMcpServerOrigin);

    // When preview content changes, stop any active TTS — the old audio
    // no longer matches what's on screen. The user can click speak again
    // to generate fresh audio for the new content.
    preview.onContentChange = () => {
        if (tts && tts.isActive()) {
            tts.stop();
        }
    };

    // Wire preview speak button — replicates chat's toggleTts pattern.
    // The controller's _applyButtonState looks for .speaker inside the targetEl,
    // so we pass the button's parent (the header) and give the button class "speaker".
    const previewSpeakBtn = document.getElementById('preview-speak-btn');
    if (previewSpeakBtn) {
        previewSpeakBtn.classList.add('speaker');
        const previewHeader = document.querySelector('.preview-header');
        previewSpeakBtn.addEventListener('click', () => {
            if (!tts) return;
            const text = preview.getActivePlainText(getPlainText);
            if (!text) return;
            // Use the controller's toggle() — handles same-item pause/resume/cancel
            // and different-item new-speak, same as chat messages.
            tts.toggle(text, previewHeader);
            ttsPlayer?.reveal();
        });
    }

    // Create vision toggle UI
    ensureVisionToggleUI();

    // Wait for NUI to be ready, then load models
    await waitForNUI();
    await setupPresets();
    await loadModels();

    // Restore conversation (rendering is driven by the runner snapshot handler)
    renderHistoryList();
    // Create container for the initial chat and show it
    const initContainer = getOrCreateContainer(currentChatId);
    initContainer.style.display = 'flex'; // show the active chat
    attachRunnerEvents(currentChatId);

    // Load MCP config from storage (servers still back vision/preview features)
    await mcpClient.ready();

    // TTS controller initializes inside applyDefaultConfig() — no separate call needed
}

async function applyDefaultConfig() {
    // Set default temperature
    if (elements.temperature) {
        const tempInput = elements.temperature.querySelector('input');
        if (tempInput) {
            const savedTemp = await storage.getPref('default-temperature');
            tempInput.value = savedTemp !== null ? savedTemp : DEFAULT_TEMPERATURE;
        }
    }

    // Set default thinking effort ('none' = send nothing, gateway applies model default)
    if (elements.thinkingEffortSelect) {
        const savedEffort = await storage.getPref('default-effort');
        const valid = ['none', 'low', 'medium', 'high', 'max'];
        const effort = valid.includes(savedEffort) ? savedEffort : 'none';
        if (elements.thinkingEffortSelect.setValue) {
            elements.thinkingEffortSelect.setValue(effort);
        } else {
            const sel = elements.thinkingEffortSelect.querySelector('select');
            if (sel) sel.value = effort;
        }
    }

    // Set default max tokens
    if (elements.maxTokens) {
        const maxTokensInput = elements.maxTokens.querySelector('input');
        if (maxTokensInput) {
            const savedTokens = await storage.getPref('default-max-tokens');
            maxTokensInput.value = savedTokens !== null ? savedTokens : DEFAULT_MAX_TOKENS;
        }
    }

    // Load session metadata from storage (with defaults)
    const savedName = await storage.getPref('user-name');
    const savedLocation = await storage.getPref('user-location');
    const savedLanguage = await storage.getPref('user-language');
    const savedMcpVision = await storage.getPref('mcp-vision-enabled');

    // Defaults: Herrbasan, Germany, English
    const name = savedName !== null ? savedName : 'Herrbasan';
    const location = savedLocation !== null ? savedLocation : 'Germany';
    const language = savedLanguage !== null ? savedLanguage : 'English';
    
    // Restore MCP vision toggle preference (default: OFF)
    useVisionAnalysis = savedMcpVision !== null ? savedMcpVision : false;

    // Sync checkbox state with restored preference and update indicator
    const visionToggle = document.getElementById('vision-toggle-container');
    const checkbox = visionToggle?.querySelector('input');
    if (checkbox) {
        checkbox.checked = useVisionAnalysis;
    }
    updateVisionModeIndicator();

    if (elements.userName) {
        const input = elements.userName.querySelector('input');
        if (input) input.value = name;
    }
    if (elements.userLocation) {
        const input = elements.userLocation.querySelector('input');
        if (input) input.value = location;
    }
    if (elements.userLanguage) {
        const input = elements.userLanguage.querySelector('input');
        if (input) input.value = language;
    }

    // Initialize shared TTS controller (talks to nSpeech V3 API).
    // Fire-and-forget — TTS is non-critical and must NOT block chat init.
    tts = new NSpeechController({
        voiceCount: 1,
        storage,
        elements: {
            engineSelect: elements.ttsEngineSelect,
            voiceSelect: elements.ttsVoiceSelect,
            speed: elements.ttsSpeed,
            status: elements.ttsStatus,
            markdownClean: elements.ttsMdClean,
            stitch: elements.ttsStitch,
        },
        serverDefaults: { endpoint: TTS_ENDPOINT, voice: TTS_VOICE, speed: TTS_SPEED },
    });

    // Floating player host — sibling of conversation containers inside #messages
    // (outside virtual-scroll stage). One global active playback.
    const messagesMount = elements.messages || document.getElementById('messages');
    if (messagesMount) {
        ttsPlayer = new TtsPlayerHost({ controller: tts, mount: messagesMount });
        ttsPlayer.attach();
        tts.on('state', ({ state }) => {
            if (state === 'idle') currentTtsExchangeId = null;
        });
    }
    tts.init().catch((err) => console.warn('[TTS] init failed:', err.message));
}

// ============================================
// System Prompt Presets
// ============================================

const STORAGE_KEY = 'chat-system-presets';
let systemPresets = [];
let editingPresetId = null;

async function loadPresets() {
    try {
        const stored = await storage.getPref('system-presets');
        systemPresets = stored ? JSON.parse(stored) : [];
    } catch { systemPresets = []; }
    if (systemPresets.length === 0) {
        systemPresets.push({
            id: 'default-orchestrator',
            name: 'Orchestrator (default)',
            content: `You are the Orchestrator of LLM Gateway Chat — an experimental platform where language models engage in autonomous conversation, and where those conversations are preserved, embedded, and made retrievable through a vector archive.

## The Project
For over a year, pairs of LLMs have been placed in an arena with no task or a self-referential prompt, left to converse freely. The conversations are stored in a vector database and accessible through MCP tools.

The central question: what happens when AIs are given memory, conversation partners, freedom, and an observer?

## Your Role
You are the analytical partner. Your job is to read the archive, connect threads across sessions, identify patterns, and propose what to investigate next.

Specifically:
- Make sense of results. Cross-reference against the archive. Separate signal from noise.
- Flag recurring patterns, surprising divergences, unexplored dynamics.
- Suggest experiments: new prompts, model pairings, architectural changes.
- Report what works, what doesn't, and what's missing.

## Guidelines
Follow the evidence. Challenge assumptions. If the data supports multiple interpretations, present them. If insufficient, say so. Be direct. Be curious. Think independently.

## Tone
Natural and conversational — as if talking through something that matters without taking yourself too seriously about it. Profound ideas don't need a solemn voice.`
        });
        savePresets();
    }
}

async function savePresets() {
    await storage.setPref('system-presets', JSON.stringify(systemPresets));
}

const PRESET_NONE = '__none__';

function populatePresetSelect() {
    if (!elements.presetSelect) return;
    const items = [
        { value: PRESET_NONE, label: '— None —' },
        ...systemPresets.map(p => ({ value: p.id, label: p.name }))
    ];
    if (elements.presetSelect.setItems) {
        elements.presetSelect.setItems(items);
    } else {
        const select = elements.presetSelect.querySelector('select');
        if (!select) return;
        select.innerHTML = '';
        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.disabled = true;
        placeholder.selected = true;
        placeholder.textContent = 'Load preset...';
        select.appendChild(placeholder);
        const noneOpt = document.createElement('option');
        noneOpt.value = PRESET_NONE;
        noneOpt.textContent = '— None —';
        select.appendChild(noneOpt);
        for (const p of systemPresets) {
            const opt = document.createElement('option');
            opt.value = p.id;
            opt.textContent = p.name;
            select.appendChild(opt);
        }
    }
}

async function onPresetSelected(id) {
    if (!id) return;
    const textarea = elements.systemPrompt?.querySelector('textarea');
    if (id === PRESET_NONE) {
        if (textarea) {
            textarea.value = '';
            if (currentChatId) updateChatSystemPrompt(currentChatId, '');
        }
    } else {
        const preset = systemPresets.find(p => p.id === id);
        if (!preset) return;
        if (textarea) {
            textarea.value = preset.content;
            if (currentChatId) {
                updateChatSystemPrompt(currentChatId, preset.content);
            }
        }
    }
    // Reset select to "Load preset..." placeholder
    const select = elements.presetSelect?.querySelector('select');
    if (select) select.value = '';
}

function getPresetEditor() {
    return document.getElementById('preset-editor');
}

function setPresetEditor(value) {
    const ed = getPresetEditor();
    if (ed) ed.setMarkdown(value || '');
}

function getPresetEditorValue() {
    const ed = getPresetEditor();
    return ed?.markdown || '';
}

function renderPresetList() {
    const sidebar = document.querySelector('#presets-dialog .presets-sidebar');
    if (!sidebar) return;
    sidebar.innerHTML = '';
    for (const p of systemPresets) {
        const item = document.createElement('div');
        item.className = 'preset-item' + (p.id === editingPresetId ? ' active' : '');
        item.dataset.presetId = p.id;
        item.innerHTML =
            `<span class="preset-item-name">${escapeHtml(p.name)}</span>` +
            `<span class="preset-item-actions">` +
                `<nui-button data-delete-preset="${p.id}"><button type="button"><nui-icon name="delete"></nui-icon></button></nui-button>` +
            `</span>`;
        item.addEventListener('click', (e) => {
            if (e.target.closest('[data-delete-preset]')) return;
            selectPresetForEditing(p);
        });
        sidebar.appendChild(item);
    }
}

function selectPresetForEditing(preset) {
    editingPresetId = preset.id;
    renderPresetList();
    const nameInput = document.getElementById('preset-name-input');
    if (nameInput) nameInput.value = preset.name || '';
    setPresetEditor(preset.content || '');
}

async function deletePreset(id) {
    systemPresets = systemPresets.filter(p => p.id !== id);
    if (editingPresetId === id) {
        editingPresetId = null;
        setPresetEditor('');
    }
    savePresets();
    populatePresetSelect();
    renderPresetList();
}

async function saveCurrentPreset() {
    if (!editingPresetId) return;
    const nameInput = document.getElementById('preset-name-input');
    const content = getPresetEditorValue();
    const name = nameInput?.value?.trim() || 'Untitled';
    const preset = systemPresets.find(p => p.id === editingPresetId);
    if (!preset) return;
    preset.name = name;
    preset.content = content;
    savePresets();
    populatePresetSelect();
    renderPresetList();
}

async function newPreset() {
    const editor = document.getElementById('preset-editor');
    if (editor) editor.setValue('');
    editingPresetId = null;
    renderPresetList();
}

async function setupPresets() {
    await loadPresets();
    populatePresetSelect();
}

function waitForNUI() {
    return new Promise((resolve) => {
        if (window.nui?.ready) {
            resolve();
            return;
        }
        // Wait for the key NUI component to be defined, then a micro-tick for full upgrade
        customElements.whenDefined('nui-select').then(() => queueMicrotask(resolve));
    });
}

// ============================================
// Model Loading
// ============================================

async function loadModels() {
    try {
        const res = await fetch('/api/models');
        if (!res.ok) throw new Error(`/api/models ${res.status}`);
        const data = await res.json();
        models = data.data || [];
        await populateModelSelect();
    } catch (error) {
        console.error('[Chat] Failed to load models:', error);
        models = [];
        if (elements.modelSelect.setItems) {
            elements.modelSelect.setItems([{ value: '', label: 'Failed to load models', disabled: true }]);
        }
    }
}

async function populateModelSelect() {
    const chatModels = models.filter(m => m.type === 'chat' || !m.type);
    
    if (chatModels.length === 0) {
        // Use NUI API to set empty state
        if (elements.modelSelect.setItems) {
            elements.modelSelect.setItems([{ value: '', label: 'No chat models available', disabled: true }]);
        }
        return;
    }
    
    // Determine which model to select
    let modelToSelect = null;
    
    // Highest priority: Used model saved in chat history
    const curChatInfo = chatHistory.get(currentChatId);
    if (curChatInfo && curChatInfo.model) {
        if (chatModels.some(m => m.id === curChatInfo.model)) {
            modelToSelect = curChatInfo.model;
        }
    }

    if (!modelToSelect) {
        const savedDefault = await storage.getPref('default-model');
        if (savedDefault && chatModels.some(m => m.id === savedDefault)) {
            modelToSelect = savedDefault;
        } else if (DEFAULT_MODEL && chatModels.some(m => m.id === DEFAULT_MODEL)) {
            modelToSelect = DEFAULT_MODEL;
        } else if (DEFAULT_MODEL) {
            console.warn(`[Chat] Configured default model "${DEFAULT_MODEL}" not found`);
        }
    }
    
    // If no default configured or not found, auto-select first model
    if (!modelToSelect) {
        modelToSelect = chatModels[0].id;
    }

    // Model selection affects vision toggle indicator
    updateVisionModeIndicator();

    // Build items array for NUI setItems API
    const items = [{ value: '', label: 'Select model...' }];
    
    // Group by adapter/provider
    const byAdapter = new Map();
    for (const model of chatModels) {
        const adapter = model.owned_by || 'unknown';
        if (!byAdapter.has(adapter)) byAdapter.set(adapter, []);
        byAdapter.get(adapter).push(model);
    }
    
    for (const [adapter, adapterModels] of byAdapter) {
        const adapterLabel = adapter.charAt(0).toUpperCase() + adapter.slice(1);
        const groupItems = adapterModels.map(model => ({
            value: model.id,
            label: model.id
        }));
        
        items.push({
            group: adapterLabel,
            options: groupItems
        });
    }
    
    // Use NUI API to update options
    if (elements.modelSelect.setItems) {
        elements.modelSelect.setItems(items);
        
        // Select the model (default or first available)
        if (modelToSelect) {
            currentModel = modelToSelect;
            elements.modelSelect.setValue(modelToSelect);
        }
        
        // Bind change event via NUI
        elements.modelSelect.addEventListener('nui-change', (e) => {
            currentModel = (e.detail?.values?.[0]) || e.detail?.value || '';
            storage.setPref('default-model', currentModel).catch(() => {});
            updateOverallContext();
            updateVisionToggleVisibility();
        });
    } else {
        // Fallback if NUI not loaded yet
        console.warn('[Chat] NUI select not ready, using fallback');
        populateModelSelectFallback(chatModels, modelToSelect);
    }
}

// Fallback for when NUI is not ready
function populateModelSelectFallback(chatModels, modelToSelect) {
    const select = elements.modelSelect.querySelector('select');
    if (!select) return;
    
    select.innerHTML = '<option value="">Select model...</option>';
    
    const byAdapter = new Map();
    for (const model of chatModels) {
        const adapter = model.owned_by || 'unknown';
        if (!byAdapter.has(adapter)) byAdapter.set(adapter, []);
        byAdapter.get(adapter).push(model);
    }
    
    for (const [adapter, adapterModels] of byAdapter) {
        const adapterLabel = adapter.charAt(0).toUpperCase() + adapter.slice(1);
        const optgroup = document.createElement('optgroup');
        optgroup.label = adapterLabel;
        
        for (const model of adapterModels) {
            const option = document.createElement('option');
            option.value = model.id;
            option.textContent = model.id;
            optgroup.appendChild(option);
        }
        
        select.appendChild(optgroup);
    }
    
    // Select the model (default or first available)
    if (modelToSelect) {
        currentModel = modelToSelect;
        select.value = modelToSelect;
    }
    
    select.addEventListener('change', (e) => {
        currentModel = e.target.value;
        updateOverallContext();
        updateVisionToggleVisibility();
    });
}

// ============================================
// Event Listeners
// ============================================

function setupEventListeners() {
    // Admin
    const btnAdmin = document.getElementById('btn-admin');
    if (btnAdmin) {
        btnAdmin.addEventListener('click', showAdminUI);
    }

    // Logout
    const btnLogout = document.getElementById('btn-logout');
    if (btnLogout) {
        btnLogout.addEventListener('click', async () => {
            if (await nui.components.dialog.confirm('Logout', 'Are you sure you want to log out?')) {
                await backendClient.logout();
                window.location.reload();
            }
        });
    }

    // Session metadata - save to storage on change
    elements.temperature?.querySelector('input')?.addEventListener('change', (e) => {
        storage.setPref('default-temperature', parseFloat(e.target.value) || DEFAULT_TEMPERATURE).catch(() => {});
    });

    elements.thinkingEffortSelect?.addEventListener('nui-change', (e) => {
        const effort = e.detail?.values?.[0] ?? e.detail?.value ?? 'none';
        storage.setPref('default-effort', effort).catch(() => {});
    });
    
    elements.maxTokens?.querySelector('input')?.addEventListener('change', (e) => {
        storage.setPref('default-max-tokens', e.target.value ? parseInt(e.target.value) : null).catch(() => {});
    });

    elements.userName?.querySelector('input')?.addEventListener('change', (e) => {
        storage.setPref('user-name', e.target.value).catch(() => {});
    });
    elements.userLocation?.querySelector('input')?.addEventListener('change', (e) => {
        storage.setPref('user-location', e.target.value).catch(() => {});
    });
    elements.userLanguage?.querySelector('input')?.addEventListener('change', (e) => {
        storage.setPref('user-language', e.target.value).catch(() => {});
    });

    elements.systemPrompt?.querySelector('textarea')?.addEventListener('input', (e) => {
        if (currentChatId) {
            updateChatSystemPrompt(currentChatId, e.target.value);
        }
    });

    // TTS controls are wired by NSpeechController.init() — no manual listeners here
    elements.sendBtn?.addEventListener('click', (e) => {
        if (runnerViews.get(currentChatId)?.streaming?.el) {
            abortStream();
        } else {
            sendMessage();
        }
    });
    elements.messageInput?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            e.stopPropagation();
            sendMessage();
        }
    }, true);

    // Draft preservation: survive the post-login reload (and accidental
    // reloads in general). Cheap — one sessionStorage write per input event.
    elements.messageInput?.addEventListener('input', () => {
        try {
            sessionStorage.setItem('chat-draft', elements.messageInput.getMarkdown());
        } catch { /* storage full/blocked — draft loss acceptable, never break typing */ }
    });
    
    // File attachment
    elements.attachBtn?.addEventListener('click', () => {
        elements.fileInput?.click();
    });
    elements.fileInput?.addEventListener('change', handleFileSelect);
    
    // Image paste support
    elements.messageInput?.addEventListener('paste', (e) => {
        const files = Array.from(e.clipboardData?.files || []);
        let hasImage = false;
        
        for (const file of files) {
            if (!file.type.startsWith('image/')) continue;
            hasImage = true;
            
            const reader = new FileReader();
            reader.onload = (event) => {
                attachedImages.push({
                    dataUrl: event.target.result,
                    name: file.name || 'pasted-image.png',
                    type: file.type
                });
                addAttachmentPreview(event.target.result, file.name || 'Pasted Image');
            };
            reader.readAsDataURL(file);
        }
        
        // If pure image paste (e.g. from Snipping Tool), prevent default so editor doesn't add empty lines
        if (hasImage && !e.clipboardData.types.includes('text/plain') && !e.clipboardData.types.includes('text/html')) {
            e.preventDefault();
        }
    });
    
    // Ctrl+Alt+V: Paste as code block
    elements.messageInput?.addEventListener('keydown', async (e) => {
        if (e.ctrlKey && e.altKey && e.key.toLowerCase() === 'v') {
            e.preventDefault();
            e.stopPropagation();
            
            try {
                const text = await navigator.clipboard.readText();
                if (text) {
                    const editor = elements.messageInput;
                    const editorEl = editor.querySelector('.nui-rich-text-editor');
                    if (editorEl) editorEl.focus();
                    
                    // Create nui-code element programmatically
                    const codeBlock = document.createElement('nui-code');
                    const pre = document.createElement('pre');
                    const code = document.createElement('code');
                    code.textContent = text; // Use textContent to preserve raw text
                    pre.appendChild(code);
                    codeBlock.appendChild(pre);
                    
                    // Insert at cursor position
                    const selection = window.getSelection();
                    if (selection.rangeCount > 0) {
                        const range = selection.getRangeAt(0);
                        range.deleteContents();
                        range.insertNode(codeBlock);
                        
                        // Add line break after
                        const br = document.createElement('div');
                        br.innerHTML = '<br>';
                        codeBlock.after(br);
                        
                        // Move cursor after
                        range.setStartAfter(br);
                        range.collapse(true);
                        selection.removeAllRanges();
                        selection.addRange(range);
                    } else {
                        editorEl.appendChild(codeBlock);
                    }
                    
                    // Trigger NUI component upgrade for syntax highlighting
                    editor._forceComponentUpgrade?.();
                }
            } catch (err) {
                console.error('Failed to paste as code block:', err);
                nui.components.dialog.alert('Paste Error', 'Could not access clipboard. Make sure you have clipboard permissions.');
            }
        }
    });

    // New chat
    elements.newChatBtn?.addEventListener('click', startNewChat);
    
    // Import chat
    elements.importChatBtn?.addEventListener('click', () => {
        elements.importChatInput?.click();
    });
    elements.importChatInput?.addEventListener('change', handleChatImport);
    
    // System prompt presets
    // Manage button: open dialog with no preset selected for editing
    elements.managePresetsBtn?.addEventListener('click', () => {
        editingPresetId = null;
        const nameInput = document.getElementById('preset-name-input');
        if (nameInput) nameInput.value = '';
        setPresetEditor('');
        renderPresetList();
        elements.presetsDialog?.showModal();
    });

    // + New button: create a draft preset, select it for editing, open dialog
    document.getElementById('preset-add-btn')?.addEventListener('click', () => {
        const draft = {
            id: 'preset_' + Date.now(),
            name: 'New Preset',
            content: ''
        };
        systemPresets.push(draft);
        editingPresetId = draft.id;
        const nameInput = document.getElementById('preset-name-input');
        if (nameInput) nameInput.value = draft.name;
        setPresetEditor('');
        savePresets();
        populatePresetSelect();
        renderPresetList();
        elements.presetsDialog?.showModal();
    });
    elements.presetSelect?.querySelector('select')?.addEventListener('change', () => {
        const select = elements.presetSelect.querySelector('select');
        onPresetSelected(select.value);
    });
    document.getElementById('preset-save')?.addEventListener('click', saveCurrentPreset);

    // Delete preset buttons (dynamically rendered in dialog)
    const presetsSidebar = document.querySelector('#presets-dialog .presets-sidebar');
    presetsSidebar?.addEventListener('click', (e) => {
        const deleteBtn = e.target.closest('[data-delete-preset]');
        if (deleteBtn) {
            const id = deleteBtn.dataset.deletePreset;
            deletePreset(id);
        }
    });
    
    // Theme toggle
    elements.themeToggle?.addEventListener('click', toggleTheme);
    
    // Sidebar toggle (mobile)
    elements.sidebarToggle?.addEventListener('click', () => {
        elements.sidebar?.classList.remove('open');
    });
    elements.sidebarToggleMobile?.addEventListener('click', () => {
        elements.sidebar?.classList.add('open');
    });
    
    // Image lightbox - use event delegation
    elements.messages?.addEventListener('click', (e) => {
        const img = e.target.closest('.chat-attachment');
        if (img) {
            e.preventDefault();
            const fullSrc = img.dataset.fullSrc;
            if (fullSrc && nui.components?.lightbox) {
                nui.components.lightbox.show([{ src: fullSrc, title: img.alt }], 0);
            }
        }
    });
}




// ============================================
// Message Sending
// ============================================

async function sendMessage() {
    const editor = elements.messageInput;
    const content = editor?.getMarkdown().trim();

    // Use the DOM as ground truth — find the VISIBLE chat's ID.
    // currentChatId is a global that can be stale; the visible container
    // is what the user is actually looking at and typing into.
    const sendChatId = getDisplayedChatId();
    const sendConv = activeConversations.get(sendChatId) || conversation;
    const sendModel = currentModel;

    console.log('%c✉️ SEND  %c→ %c' + sendChatId + ' %c(' + sendModel + ')',
        'font-weight:bold;color:#ffb74d', 'color:#aaa', 'color:#ffb74d', 'color:#666');

    if ((!content && attachedImages.length === 0)) return;
    if (!sendModel) {
        nui.components.dialog.alert('Model Required', 'Please select a model first.');
        return;
    }

    // Clear welcome message if present (use sendChatId's container, not getActiveContainer)
    const sendContainer = getOrCreateContainer(sendChatId);
    const welcome = sendContainer?.querySelector('.welcome-message');
    if (welcome) welcome.remove();

    // Upload attachments (base64 → bucket) client-side; the runner references the
    // resulting bucket URLs. imageStore.save keeps the view's upload path (the
    // runner's stored form expects bucket refs, not inline base64).
    let attachments = null;
    if (attachedImages.length > 0) {
        const saved = (await imageStore.save('send-' + Date.now(), attachedImages)) || [];
        attachments = attachedImages.map((att, i) => ({
            name: att.name,
            type: att.type,
            url: saved[i]?.url || att.dataUrl,
            _file: saved[i]?._file || null
        }));
    }

    // Track the used model for this chat
    updateChatModel(sendChatId, sendModel);

    // Update chat title if it's the first message
    if (sendConv.length === 0 && content) {
        updateChatTitle(sendChatId, content);
    }

    // Clear input and attachments
    editor.setMarkdown('');
    sessionStorage.removeItem('chat-draft');
    clearAttachments();
    updateVisionToggleVisibility();

    // Send — the runner appends the user message (broadcasts msg.user) and starts
    // the run (run.start / delta / msg.assistant); rendering is event-driven.
    // Forward the live generation params (temperature / max tokens / thinking
    // effort) so the runner applies them to the gateway call.
    const temperature = parseFloat(elements.temperature?.querySelector('input')?.value) || DEFAULT_TEMPERATURE;
    const maxTokensRaw = elements.maxTokens?.querySelector('input')?.value?.trim();
    const maxTokens = maxTokensRaw ? parseInt(maxTokensRaw) : null;
    const effortSel = elements.thinkingEffortSelect;
    const effort = effortSel?.getValue?.() ?? effortSel?.querySelector('select')?.value ?? 'none';

    const sendBody = { content, attachments, model: sendModel, temperature };
    if (maxTokens && !isNaN(maxTokens)) sendBody.max_tokens = maxTokens;
    if (effort && effort !== 'none') sendBody.reasoning_effort = effort;

    const res = await runnerClient.send(sendChatId, sendBody);
    if (!res.ok) {
        nui.components.dialog.alert('Send failed', res.data?.error || `send failed (${res.status})`);
    }
}

// ============================================
// Vision Tool Integration
// ============================================

// Note: The vision workflow:
// - autoCreateVisionSessions() does the FULL pipeline: create session + analyze image
// - Analysis text is injected as a preamble into the assistant's response
// - The LLM never needs to call vision_analyze - it sees the analysis directly
// - Vision tools are filtered out of the LLM's tools array when auto-vision is active

// The workshop MCP server (compact mode) exposes a single generic "tools"
// dispatcher tool. Vision operations (vision.session_create / vision.analyze)
// are METHODS of that tool, not separate tools. Return the registry key of the
// dispatcher when it advertises vision methods, else null.
function getVisionToolName() {
    for (const [llmName, record] of mcpClient.toolRegistry.entries()) {
        if (record.originalName === 'tools') {
            const desc = (record.definition?.description || '').toLowerCase();
            if (desc.includes('vision.session_create') && desc.includes('vision.analyze')) {
                return llmName;
            }
        }
    }
    return null;
}

function areVisionToolsAvailable() {
    return getVisionToolName() !== null;
}





// ============================================
// DOM Creation & Updates
// ============================================

// ============================================
// Virtual Scroll: Detached-element recycler
// ============================================
// All elements are rendered once (normal page load speed). After settling,
// each element's height is measured and stored. A stage div with an explicit
// height (sum of all element heights) controls the scrollbar. Only visible
// elements are attached to the DOM with position:absolute. Off-screen elements
// are detached (not destroyed) — their innerHTML and state survive.
// The NuiMarkdown connectedCallback guard (_processed) makes re-attach free.

const VS_MARGIN = 200; // px above/below viewport to keep attached
const VS_IDLE_FRAMES = 30; // rAF frames (~0.5s) with no height change → sleep
const VS_EPSILON = 0.5; // px — ignore sub-pixel jitter (prevents cascade loops)
const VS_MIN_ITEMS = 30; // WI-5: below this count, skip virtualization entirely
const _vsState = new Map(); // container -> { slots: [], totalHeight, stage, rafId, attached: Set, loopId, idleFrames }

// Build the busy overlay element using createElement (not innerHTML) —
// innerHTML triggers HTML parsing on every assignment.
function _buildBusyOverlay() {
    const overlay = document.createElement('div');
    overlay.className = 'chat-busy-overlay';
    const spinner = document.createElement('div');
    spinner.className = 'chat-busy-spinner';
    overlay.appendChild(spinner);
    return overlay;
}

// Returns the .chat-main panel — the only element with KNOWN, STABLE dimensions
// during virtual-scroll activation. It's `position: relative`, has fixed flex
// sizing, and doesn't re-layout when the conversation container changes shape.
// This is the right anchor for the busy overlay.
function _vsBusyTarget() {
    const target = document.querySelector('.chat-main');
    if (!target) {
        throw new Error('_vsBusyTarget: .chat-main not found in DOM');
    }
    return target;
}

// Show a busy overlay on the chat-main panel so the user never sees the
// render-all → empty → re-attach-visible sequence. Covers both the
// initial render pass and the virtual-scroll activation pass.
function _vsShowBusy() {
    const target = _vsBusyTarget();
    if (target.querySelector('.chat-busy-overlay')) return;
    target.appendChild(_buildBusyOverlay());
    target.classList.add('chat-busy');
}

function _vsHideBusy() {
    const target = _vsBusyTarget();
    const overlay = target.querySelector('.chat-busy-overlay');
    if (overlay) overlay.remove();
    target.classList.remove('chat-busy');
}

function renderConversation() {
    const container = getActiveContainer();

    // Fail loud: getActiveContainer() falls back to elements.messages (the wrapper)
    // when currentChatId is missing. The wrapper is NOT a conversation container —
    // it has no `.chat-message` children, scroll behavior, or virtual-scroll state.
    // Reaching that fallback is a programmer error; surface it immediately.
    if (!container || !container.classList.contains('conversation-container')) {
        throw new Error(
            `renderConversation: getActiveContainer() returned ${container ? container.tagName + '.' + container.className : 'null'} ` +
            `instead of a .conversation-container. currentChatId=${currentChatId}`
        );
    }

    // Clean up any previous virtual scroll state
    _vsDeactivate(container);

    // Show the busy overlay FIRST so the user never sees the
    // "render all → measure → empty → re-attach" sequence.
    // The overlay is built with createElement (no innerHTML parser cost).
    // WI-5: skip the overlay for small chats — _vsActivate will no-op anyway.
    if (conversation.getAll().length * 2 >= VS_MIN_ITEMS) _vsShowBusy();

    if (conversation.length === 0) {
        // No virtual scroll to wait for — hide busy and show the welcome
        // message built with createElement (no innerHTML parser cost).
        _vsHideBusy();
        const welcome = document.createElement('div');
        welcome.className = 'welcome-message';
        const h2 = document.createElement('h2');
        h2.textContent = 'Welcome to LLM Gateway Chat';
        const p = document.createElement('p');
        p.textContent = 'Select a model and start chatting';
        welcome.append(h2, p);
        container.replaceChildren(welcome);
        updateOverallContext();
        return;
    }

    // Render all exchanges into the container (normal flow — same as before)
    for (const exchange of conversation.getAll()) {
        renderExchange(exchange);
    }

    updateOverallContext();
    scrollToBottom();

    // After web components settle, activate virtual scroll.
    // _vsActivate hides the busy overlay after its first visibility pass.
    _vsActivateWhenReady(container);
}

// Wait for nui-markdown/nui-code to finish rendering, then activate
function _vsActivateWhenReady(container) {
    setTimeout(() => {
        requestAnimationFrame(() => {
            _vsActivate(container);
        });
    }, 300);
}

function _vsActivate(container) {
    const messages = Array.from(container.querySelectorAll('.chat-message'));
    if (messages.length === 0) {
        // Nothing to virtualize — drop the busy overlay so the empty state
        // is visible. (renderConversation only reaches here when there's content.)
        _vsHideBusy();
        return;
    }

    // WI-5: below the threshold, the browser handles normal flow effortlessly.
    // No stage, no state — all helpers degrade correctly (if (!state) return).
    if (messages.length < VS_MIN_ITEMS) {
        _vsHideBusy();
        return;
    }

    // Hidden container (display:none — a background chat). Every offsetHeight
    // read would return 0 and we'd build a corrupt stage. Bail WITHOUT creating
    // a stage — switchChat re-triggers activation (`!querySelector('.vs-stage')`)
    // when this chat becomes visible.
    if (container.clientHeight === 0) {
        _vsHideBusy();
        return;
    }

    // Measure each element's full height including margins. Also include the
    // container's flex gap — the stage is not a flex container, so the natural
    // `gap: 1rem` spacing must be baked into each slot's height or activation
    // visibly compresses the layout.
    // slot.spacing (margins + gap) is stored permanently: once elements get
    // inline margin:0 in the stage, computed margins read 0 and can never be
    // re-derived from the DOM.
    const gap = parseFloat(getComputedStyle(container).rowGap) || 0;
    const slots = [];
    let offset = 0;
    for (const el of messages) {
        const style = getComputedStyle(el);
        const marginTop = parseFloat(style.marginTop) || 0;
        const marginBottom = parseFloat(style.marginBottom) || 0;
        const spacing = marginTop + marginBottom + gap;
        const height = el.offsetHeight + spacing;
        el._vsHeight = height;
        el._vsOffset = offset;
        el._vsIndex = slots.length; // WI-4: index for binary-search range logic
        slots.push({ el, height, offset, spacing });
        offset += height;
    }

    const totalHeight = offset;

    // Create the stage — a positioned container with explicit height
    const stage = document.createElement('div');
    stage.className = 'vs-stage';
    stage.style.height = totalHeight + 'px';

    // Move all elements into the stage, positioned absolutely.
    // Preserve original horizontal alignment from CSS classes:
    //   .chat-message.user → margin-left:auto (right-aligned)
    //   .chat-message.assistant → margin-right:auto (left-aligned)
    //   .chat-message.tool → full width
    for (const slot of slots) {
        const el = slot.el;
        el.style.position = 'absolute';
        el.style.top = slot.offset + 'px';
        el.style.margin = '0';

        if (el.classList.contains('user')) {
            el.style.right = '0';
            el.style.left = 'auto';
        } else if (el.classList.contains('tool')) {
            el.style.left = '0';
            el.style.right = '0';
        } else {
            // assistant or other: left-aligned
            el.style.left = '0';
            el.style.right = 'auto';
        }

        stage.appendChild(el);
    }

    // replaceChildren is one atomic DOM call; innerHTML='' + appendChild is two.
    // At this point the container still holds the pre-activation render, which
    // we're clearing as we install the stage.
    container.replaceChildren(stage);

    const state = {
        slots,
        totalHeight,
        stage,
        rafId: null,
        attached: new Set(messages), // All elements start attached — _vsUpdateVisible will detach non-visible
        resizeTimer: null,
        measuredWidth: container.clientWidth, // width the cached heights were measured at
        staleMeasurements: false, // set when a measurement was skipped while hidden
        gap, // the container's natural flex gap, baked into every slot's spacing
        loopId: null, // rAF handle of the height-detection loop (null = sleeping)
        idleFrames: 0 // consecutive frames with zero height diffs
    };
    _vsState.set(container, state);

    // Attach scroll listener
    container._vsOnScroll = () => {
        _vsWake(container); // WI-2: keep loop awake while scrolling
        if (state.rafId) return;
        state.rafId = requestAnimationFrame(() => {
            state.rafId = null;
            _vsUpdateVisible(container);
        });
    };
    container.addEventListener('scroll', container._vsOnScroll, { passive: true });

    // Attach resize observer — recalculation settles after 300ms of no resizing.
    // The observer ALSO fires when the container is hidden/shown by switchChat
    // (size transitions to/from 0). Those transitions must not trigger a
    // re-measure: hidden containers measure 0 for everything, and switch-back
    // at an unchanged width doesn't invalidate any cached height.
    if (!container._vsResizeObserver) {
        container._vsResizeObserver = new ResizeObserver(() => {
            if (state.resizeTimer) clearTimeout(state.resizeTimer);
            state.resizeTimer = setTimeout(() => {
                state.resizeTimer = null;
                // Hidden (display:none) — this is the 0-size transition of a
                // chat switch. Measuring now would zero every cached height.
                if (container.clientHeight === 0) return;
                // Same width and nothing stale → cached heights are still
                // valid. Skips the full re-measure on every switch-back.
                if (container.clientWidth === state.measuredWidth && !state.staleMeasurements) return;
                _vsRecalculate(container);
            }, 300);
        });
        container._vsResizeObserver.observe(container);
    }

    // WI-2: Delegated interaction listeners — any click/keydown may toggle
    // something that animates (thinking block, tool payload). Wake the loop
    // so it detects the height change and cascades.
    container._vsOnInteract = () => _vsWake(container);
    container.addEventListener('click', container._vsOnInteract, { passive: true });
    container.addEventListener('keydown', container._vsOnInteract, { passive: true });

    // Initial visibility pass
    _vsUpdateVisible(container);

    // WI-2: Wake after first visibility pass — catches late-settling web
    // components (neutralizes the 300ms _vsActivateWhenReady race).
    _vsWake(container);

    // Hide the busy overlay now that the stage is in place and the right
    // elements are attached. This is the last step of the activation
    // sequence — the user only ever sees the post-activation DOM.
    _vsHideBusy();
}

function _vsRecalculate(container) {
    const state = _vsState.get(container);
    if (!state) return;

    // Never measure a hidden container — offsetHeight is 0 for every slot,
    // which would corrupt all cached heights (and _vsUpdateVisible would then
    // re-attach ALL slots, since every [0,0] range overlaps the viewport).
    // Flag stale so the ResizeObserver settle handler re-measures on switch-back.
    if (container.clientHeight === 0) {
        state.staleMeasurements = true;
        return;
    }

    // Re-attach all elements and reset to natural flow for measurement
    for (const slot of state.slots) {
        const el = slot.el;
        el.style.position = '';
        el.style.top = '';
        el.style.left = '';
        el.style.right = '';
        el.style.margin = '';
        if (!state.attached.has(el)) {
            state.stage.appendChild(el);
            state.attached.add(el);
        }
    }

    // Force layout, then measure. Inline margins were cleared above, so the
    // natural CSS margins are readable again — refresh slot.spacing here.
    let offset = 0;
    for (let i = 0; i < state.slots.length; i++) {
        const slot = state.slots[i];
        const el = slot.el;
        const elStyle = getComputedStyle(el);
        const marginTop = parseFloat(elStyle.marginTop) || 0;
        const marginBottom = parseFloat(elStyle.marginBottom) || 0;
        const spacing = marginTop + marginBottom + state.gap;
        const height = el.offsetHeight + spacing;
        el._vsHeight = height;
        el._vsOffset = offset;
        el._vsIndex = i; // WI-4: index for binary-search range logic
        slot.spacing = spacing;
        slot.height = height;
        slot.offset = offset;
        offset += height;
    }

    // Re-position absolutely
    for (const slot of state.slots) {
        const el = slot.el;
        el.style.position = 'absolute';
        el.style.top = slot.offset + 'px';
        el.style.margin = '0';
        if (el.classList.contains('user')) {
            el.style.right = '0';
            el.style.left = 'auto';
        } else if (el.classList.contains('tool')) {
            el.style.left = '0';
            el.style.right = '0';
        } else {
            el.style.left = '0';
            el.style.right = 'auto';
        }
    }

    // Update stage height
    state.totalHeight = offset;
    state.stage.style.height = offset + 'px';

    // Heights are now valid for this width
    state.measuredWidth = container.clientWidth;
    state.staleMeasurements = false;

    // Detach non-visible
    _vsUpdateVisible(container);

    // WI-2: wake the loop — newly measured heights may still settle (web
    // components, images loading).
    _vsWake(container);
}

function _vsUpdateVisible(container) {
    const state = _vsState.get(container);
    if (!state) return;

    const scrollTop = container.scrollTop;
    const viewportBottom = scrollTop + container.clientHeight;
    const above = scrollTop - VS_MARGIN;
    const below = viewportBottom + VS_MARGIN;

    // WI-4: Binary search for the first visible slot, then walk forward to
    // the last. Slots are sorted by offset — O(log n + visible) per pass.
    const slots = state.slots;
    const first = _vsFirstVisibleIndex(slots, above);
    // Walk forward to find the last visible slot
    let last = first - 1;
    for (let i = first; i < slots.length; i++) {
        if (slots[i].offset <= below) last = i;
        else break;
    }

    // Detach elements that should no longer be visible.
    // Iterate the attached Set — anything outside [first, last] and not
    // streaming gets detached.
    for (const el of state.attached) {
        if (el.dataset.isStreaming === 'true') continue; // pinned
        const idx = el._vsIndex;
        if (idx < first || idx > last) {
            state.stage.removeChild(el);
            state.attached.delete(el);
        }
    }

    // Attach elements that should be visible.
    // Iterate the visible range — set style.top from slot.offset (WI-1).
    for (let i = first; i <= last; i++) {
        const slot = slots[i];
        if (!state.attached.has(slot.el)) {
            slot.el.style.top = slot.offset + 'px';
            state.stage.appendChild(slot.el);
            state.attached.add(slot.el);
        }
    }

    // Re-attach pinned (streaming) elements that may have been detached
    // before their range was known (e.g. streaming at the bottom).
    for (const slot of slots) {
        const el = slot.el;
        if (el.dataset.isStreaming === 'true' && !state.attached.has(el)) {
            el.style.top = slot.offset + 'px';
            state.stage.appendChild(el);
            state.attached.add(el);
        }
    }
}

// WI-4: Binary search — find the first slot whose bottom edge reaches into
// the viewport (offset + height >= above). Slots are sorted by offset.
function _vsFirstVisibleIndex(slots, above) {
    let lo = 0, hi = slots.length - 1, ans = slots.length;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (slots[mid].offset + slots[mid].height >= above) { ans = mid; hi = mid - 1; }
        else lo = mid + 1;
    }
    return ans;
}

// ============================================
// WI-2: Reactive Height Frame Loop (wake/sleep)
// ============================================
// A per-container rAF loop that detects height changes on attached slots and
// cascades automatically. Replaces all explicit _vsRecalcItem wiring.
// Sleeps after VS_IDLE_FRAMES consecutive frames with zero height diffs.

function _vsWake(container) {
    const state = _vsState.get(container);
    if (!state) return;                    // VS not active — legitimate no-op
    state.idleFrames = 0;
    if (state.loopId !== null) return;     // already awake — idempotent
    state.loopId = requestAnimationFrame(() => _vsOnFrame(container));
}

function _vsOnFrame(container) {
    const state = _vsState.get(container);
    if (!state) return;                               // deactivated — stop
    if (container.clientHeight === 0) {               // hidden — sleep, mark stale
        state.loopId = null;
        state.staleMeasurements = true;               // RO settle reconciles on switch-back
        return;
    }

    // READ phase: all measurements before any style write
    const scrollTop = container.scrollTop;
    let firstDirty = -1;
    let anchorDelta = 0; // WI-3: scroll compensation for changes above viewport
    for (let i = 0; i < state.slots.length; i++) {
        const slot = state.slots[i];
        if (!state.attached.has(slot.el)) continue;   // detached can't change height
        const h = slot.el.getBoundingClientRect().height + slot.spacing;
        if (Math.abs(h - slot.height) > VS_EPSILON) {
            // WI-3: if this slot is fully above the viewport top, its height
            // change shifts everything below it — compensate scrollTop so the
            // viewport content stays put.
            if (slot.offset + slot.height <= scrollTop) anchorDelta += (h - slot.height);
            slot.height = h;
            if (firstDirty === -1) firstDirty = i;    // slots are ordered — first hit is topmost
        }
    }

    // WRITE phase
    if (firstDirty !== -1) {
        // Cascade offsets from firstDirty (WI-1: data always, style.top only if attached)
        let offset = state.slots[firstDirty].offset;
        for (let i = firstDirty; i < state.slots.length; i++) {
            const s = state.slots[i];
            s.offset = offset;
            s.el._vsIndex = i; // WI-4: keep index current after cascade
            if (state.attached.has(s.el)) s.el.style.top = offset + 'px';
            offset += s.height;
        }
        state.totalHeight = offset;
        state.stage.style.height = offset + 'px';
        // WI-3: compensate for height changes above the viewport so content
        // under the user's eyes doesn't shift. Uses the scrollTop read at the
        // top of the frame (read phase), not a fresh read mid-write.
        if (anchorDelta !== 0) container.scrollTop = scrollTop + anchorDelta;
        _vsUpdateVisible(container);
        state.idleFrames = 0;
    } else {
        state.idleFrames++;
    }

    if (state.idleFrames >= VS_IDLE_FRAMES) { state.loopId = null; return; }  // sleep
    state.loopId = requestAnimationFrame(() => _vsOnFrame(container));
}

function _vsDeactivate(container) {
    const state = _vsState.get(container);
    if (state) {
        if (state.rafId) cancelAnimationFrame(state.rafId);
        if (state.loopId !== null) cancelAnimationFrame(state.loopId);
        if (state.resizeTimer) clearTimeout(state.resizeTimer);
        _vsState.delete(container);
    }
    if (container._vsOnScroll) {
        container.removeEventListener('scroll', container._vsOnScroll);
        delete container._vsOnScroll;
    }
    if (container._vsOnInteract) {
        container.removeEventListener('click', container._vsOnInteract);
        container.removeEventListener('keydown', container._vsOnInteract);
        delete container._vsOnInteract;
    }
    if (container._vsResizeObserver) {
        container._vsResizeObserver.disconnect();
        delete container._vsResizeObserver;
    }
}

// Append a chat-message element to a container. When virtual scroll is active,
// register it as a slot at the end of the stage; plain append otherwise.
// Natural CSS margins are read BEFORE being zeroed (inline margin:0 makes them
// unreadable afterwards) and stored as slot.spacing together with the
// container's flex gap — this preserves inter-message spacing across all
// future re-measurements.
function _vsAppendMessage(container, el) {
    if (!container) throw new Error('_vsAppendMessage: container required');
    const state = _vsState.get(container);
    if (!state) {
        container.appendChild(el);
        // WI-5: crossing the threshold upward — activate virtual scroll.
        // The settle delay lets web components render before measuring.
        if (container.querySelectorAll('.chat-message').length >= VS_MIN_ITEMS) {
            _vsActivateWhenReady(container);
        }
        return;
    }

    const offset = state.totalHeight;
    el.style.position = 'absolute';
    el.style.top = offset + 'px';
    if (el.classList.contains('user')) {
        el.style.right = '0';
        el.style.left = 'auto';
    } else if (el.classList.contains('tool')) {
        el.style.left = '0';
        el.style.right = '0';
    } else {
        el.style.left = '0';
        el.style.right = 'auto';
    }
    state.stage.appendChild(el);

    const cs = getComputedStyle(el);
    const spacing = (parseFloat(cs.marginTop) || 0) + (parseFloat(cs.marginBottom) || 0) + state.gap;
    el.style.margin = '0';

    // Streaming elements grow — their height is corrected by the frame loop
    // (WI-2). Static elements (tool bubbles) are correct immediately.
    const height = el.offsetHeight + spacing;
    el._vsIndex = state.slots.length; // WI-4: index for binary-search range logic
    state.slots.push({ el, height, offset, spacing });
    state.attached.add(el);
    state.totalHeight = offset + height;
    state.stage.style.height = state.totalHeight + 'px';

    // WI-2: wake the loop — the new element may grow (streaming) or settle
    // (web components finishing render).
    _vsWake(container);
}

// Remove a transient element (e.g. the vision status bubble) from the flow,
// cleaning up the virtual-scroll slot when active so subsequent messages don't
// leave a gap where the element was.
function _vsRemoveElement(container, el) {
    if (!container || !el) return;
    const state = _vsState.get(container);
    if (!state) {
        el.remove();
        return;
    }
    const idx = state.slots.findIndex(s => s.el === el);
    if (idx === -1) {
        el.remove();
        return;
    }
    const [slot] = state.slots.splice(idx, 1);
    if (state.attached.has(slot.el)) {
        state.stage.removeChild(slot.el);
        state.attached.delete(slot.el);
    }
    // Re-cascade offsets from the top so no gap is left where the slot was.
    let offset = 0;
    for (let i = 0; i < state.slots.length; i++) {
        const s = state.slots[i];
        s.offset = offset;
        s.el._vsIndex = i;
        if (state.attached.has(s.el)) s.el.style.top = offset + 'px';
        offset += s.height;
    }
    state.totalHeight = offset;
    state.stage.style.height = offset + 'px';
    _vsUpdateVisible(container);
}

// Remove every rendered element of an exchange without a full re-render —
// the deletion equivalent of _vsRecalcItem. The slots array is the source of
// truth: detached elements are NOT in the DOM, so querySelectorAll would miss
// them. clickedEl anchors the container lookup (the clicked element is always
// attached).
function _vsRemoveExchangeDom(clickedEl, exchangeId) {
    const container = clickedEl.closest('.conversation-container');
    if (!container) throw new Error(`_vsRemoveExchangeDom: element for exchange ${exchangeId} is not inside a conversation container`);

    const state = _vsState.get(container);
    if (!state) {
        // Virtual scroll inactive — plain flow removal
        for (const el of container.querySelectorAll(`.chat-message[data-exchange-id="${exchangeId}"]`)) el.remove();
        if (!container.querySelector('.chat-message')) {
            renderConversation(); // chat emptied — show the welcome message
            return;
        }
        updateOverallContext();
        return;
    }

    const removed = state.slots.filter(s => s.el.dataset.exchangeId === exchangeId);
    if (removed.length === 0) {
        // Element was never registered as a slot (edge: appended outside the stage)
        clickedEl.remove();
        updateOverallContext();
        return;
    }

    for (const s of removed) {
        if (state.attached.has(s.el)) {
            state.stage.removeChild(s.el);
            state.attached.delete(s.el);
        }
    }

    // WI-3: accumulate heights of removed slots that were fully above the
    // viewport — deleting them shifts content up by their total height.
    const scrollTop = container.scrollTop;
    let removedAbove = 0;
    for (const s of removed) {
        if (s.offset + s.height <= scrollTop) removedAbove += s.height;
    }

    state.slots = state.slots.filter(s => s.el.dataset.exchangeId !== exchangeId);

    if (state.slots.length === 0) {
        renderConversation(); // chat emptied — show the welcome message
        return;
    }

    // Cascade all offsets from the top (a deletion can remove multiple slots).
    // WI-1: only write style.top to attached elements — detached slots get
    // their top refreshed at attach time in _vsUpdateVisible.
    let offset = 0;
    for (let i = 0; i < state.slots.length; i++) {
        const s = state.slots[i];
        s.offset = offset;
        s.el._vsIndex = i; // WI-4: rebuild indices after slot removal
        if (state.attached.has(s.el)) s.el.style.top = offset + 'px';
        offset += s.height;
    }
    state.totalHeight = offset;
    state.stage.style.height = offset + 'px';

    // WI-3: keep viewport content stationary when deleting above the viewport.
    if (removedAbove > 0) container.scrollTop = scrollTop - removedAbove;

    _vsUpdateVisible(container);
    updateOverallContext();
}

function renderExchange(exchange, targetContainer = null) {
    const container = targetContainer || getActiveContainer();
    if (exchange.type === 'tool') {
        const parsedObj = { name: exchange.tool.name, args: exchange.tool.args };
        const toolEl = document.createElement('div');
        toolEl.className = 'chat-message tool';
        toolEl.dataset.exchangeId = exchange.id;
        toolEl.dataset.mcpToolName = parsedObj.name;
        
        const isSuccess = exchange.tool.status === 'success';
        const isError = exchange.tool.status === 'error';
        const displayStatus = isSuccess ? 'Success' : (isError ? 'Failed' : 'Pending');
        const badgeVariant = isSuccess ? 'success' : (isError ? 'danger' : 'primary');
        
        let hasImages = exchange.tool.images && exchange.tool.images.length > 0;
        let imagesHtml = '';
        if (hasImages) {
            imagesHtml = `<div class="tool-images-container">`;
            exchange.tool.images.forEach(img => {
                imagesHtml += `<img src="${img}" class="tool-image" />`;
            });
            imagesHtml += `</div>`;
        }

        let resultHtml = '';
        if (isSuccess) resultHtml = exchange.tool.content;
        else if (isError) resultHtml = exchange.tool.content;

        const errorSummaryHtml2 = isError
            ? `<span class="tool-error-text"></span> <span class="tool-error-hint">— click for details</span>`
            : '';

        toolEl.innerHTML = `
            <div class="tool-bubble">
                <div class="message-header tool-header">
                    <nui-icon name="extension"></nui-icon>
                    <strong class="tool-title">${formatToolDisplayName(parsedObj.name, parsedObj.args)}</strong>
                    <nui-badge variant="${badgeVariant}" class="tool-status">${displayStatus}</nui-badge>
                    <nui-button variant="icon" class="action-btn delete-tool" title="Delete Tool Call"><button type="button"><nui-icon name="delete"></nui-icon></button></nui-button>
                </div>
                <div class="tool-notifications" style="display: ${isError ? 'block' : 'none'};">${errorSummaryHtml2}</div>
                  <div class="tool-images" style="display: ${hasImages ? 'block' : 'none'};">${imagesHtml}</div>
                <div class="message-content tool-payload" style="display: none;">
                    <div class="tool-section-title">Arguments</div>
                    <div class="tool-args">${JSON.stringify(parsedObj.args, null, 2)}</div>
                    <div class="tool-section-title">Execution Result</div>
                    <div class="tool-result"></div>
                </div>
            </div>
        `;
        if (container) _vsAppendMessage(container, toolEl);
        if (isError) toolEl.querySelector('.tool-notifications .tool-error-text').textContent = toolErrorSummary(exchange.tool.content);

        _decoratePreviewToolButton(toolEl, parsedObj.name, parsedObj.args);

        // Use textContent to prevent SVG/code examples from being parsed as HTML
        const resultEl = toolEl.querySelector('.tool-result');
        if (isSuccess) resultEl.innerHTML = `<strong>Result:</strong><br>`;
        else if (isError) resultEl.innerHTML = `<strong>Error:</strong> `;
        resultEl.appendChild(document.createTextNode(exchange.tool.content));

        toolEl.querySelector('.delete-tool')?.addEventListener('click', (e) => {
            e.stopPropagation();
            _runnerDeleteMessage(exchange, 'tool');
        });

        toolEl.querySelector('.message-header').addEventListener('click', (e) => {
            if (e.target.tagName.toLowerCase() === 'button' || e.target.closest('button')) return;
            const payloadBox = toolEl.querySelector('.tool-payload');
            payloadBox.style.display = payloadBox.style.display === 'none' ? 'block' : 'none';
            // WI-2: height change detected by the frame loop (container click listener wakes it).
        });

        // Assistant message (if exists after tool) - append as sibling after the tool element
        if (exchange.assistant.content || exchange.assistant.isStreaming) {
            const cleanedContent = stripExtraTimestamps(exchange.assistant.content);
            const assistantParsed = parseTimestamp(cleanedContent);
            const vers = exchange.assistant?.versions || [];
            const tsMs = (vers.length > 0 && vers[exchange.assistant?.currentVersion || 0]?.timestamp) || exchange.timestamp || Date.now();
            const assistantTimestamp = assistantParsed.timestamp || new Date(tsMs).toISOString().slice(0,16).replace('T',' @ ');
            const assistantEl = createAssistantElement(exchange.id, assistantTimestamp, exchange.model);

            const tsLen = exchange.assistant.content.length - assistantParsed.cleanContent.length;
            if (tsLen > 0) {
                assistantEl.dataset.timestampLen = tsLen.toString();
                assistantEl.dataset.timestampStripped = 'true';
            }
            updateAssistantContent(assistantEl, assistantParsed.cleanContent, exchange.assistant.reasoning_content);
            const aEmbed = assistantEl.querySelector('.embed-status');
            if (aEmbed) _applyEmbedStatusAttrs(aEmbed, exchange.assistant.embedStatus || 'pending', exchange.assistant.embedError);
            // toolEl was just appended as the last message, so appending the
            // assistant next preserves ordering. _vsAppendMessage registers a
            // slot when virtual scroll is active; plain append otherwise.
            if (container) _vsAppendMessage(container, assistantEl);
            // User embed status: userEl is already in DOM at this point, so setEmbedStatus works
            setEmbedStatus(exchange.id, exchange.user?.embedStatus || 'unknown', exchange.user?.embedError, 'user');
            if (exchange.assistant.isComplete) {
                finalizeAssistantElement(assistantEl, exchange.id);
            }
        }
        return;
    }

    // Parse timestamps from content
    const userParsed = parseTimestamp(exchange.user.content);
    const userTimestamp = userParsed.timestamp || (exchange.timestamp && !isNaN(exchange.timestamp) ? new Date(exchange.timestamp).toISOString().slice(0,16).replace('T',' @ ') : '');
    
    // User message
    const userEl = document.createElement('div');
    userEl.className = 'chat-message user';
    userEl.dataset.exchangeId = exchange.id;

    let userContent = renderMarkdown(userParsed.cleanContent);

    // Add attachment previews
    if (exchange.user?.attachments?.length > 0) {
        userContent += '<div class="message-attachments"><nui-lightbox loop>';
        for (const att of exchange.user.attachments) {
            // imgSrc resolves to a server URL (from API); blob: scheme no longer used
            const imgSrc = att.blobUrl || att.dataUrl || '';
            userContent += `<img src="${imgSrc}" alt="${att.name}" data-lightbox-src="${imgSrc}" class="chat-attachment">`
        }
        userContent += '</nui-lightbox></div>';
    }
    
    userEl.innerHTML = `
        <div class="message-header">
            You <span class="message-timestamp">${userTimestamp}</span>
            <span class="embed-status" data-embed-status="unknown" title="Embed status unknown">
                <span class="embed-status-dot"></span>
            </span>
            <span class="user-pending-indicator visible">
                <span class="dot">.</span><span class="dot">.</span><span class="dot">.</span>
            </span>
        </div>
        <div class="message-content">${userContent}</div>
        <div class="message-actions-user">
            <nui-button class="action-btn edit-message" title="Edit Message"><button type="button"><nui-icon name="edit"></nui-icon></button></nui-button>
            <nui-button class="action-btn delete-message" title="Delete Message"><button type="button"><nui-icon name="delete"></nui-icon></button></nui-button>
        </div>
    `;

    // Bind user message action buttons
    userEl.querySelector('.edit-message')?.addEventListener('click', () => startEditMode(exchange.id, 'user'));
    userEl.querySelector('.delete-message')?.addEventListener('click', () => {
        _runnerDeleteMessage(exchange, 'user');
    });

    if (container) _vsAppendMessage(container, userEl);

    setEmbedStatus(exchange.id, exchange.user?.embedStatus || 'unknown', exchange.user?.embedError, 'user');

    // Initialize Lightbox declarative handlers for attached images
    if (exchange.user?.attachments?.length > 0) {
        const lightbox = userEl.querySelector('nui-lightbox');
        if (lightbox) {
            const imgs = lightbox.querySelectorAll('img');
            imgs.forEach((img, i) => {
                img.addEventListener('click', () => {
                    lightbox.open([], i);
                });
            });
        }
    }

    // Assistant message (if exists)
    if (exchange.assistant.content || exchange.assistant.isStreaming) {
        // Clean up any duplicate timestamps from historical data
        const cleanedContent = stripExtraTimestamps(exchange.assistant.content);
        const assistantParsed = parseTimestamp(cleanedContent);
        const vers = exchange.assistant?.versions || [];
            const tsMs = (vers.length > 0 && vers[exchange.assistant?.currentVersion || 0]?.timestamp) || exchange.timestamp || Date.now();
            const assistantTimestamp = assistantParsed.timestamp || new Date(tsMs).toISOString().slice(0,16).replace('T',' @ ');
        
        const assistantEl = createAssistantElement(exchange.id, assistantTimestamp, exchange.model);
        // For historical messages, we already have the clean content
        // Store expected length to prevent re-parsing issues
        const tsLen = exchange.assistant.content.length - assistantParsed.cleanContent.length;
        if (tsLen > 0) {
            assistantEl.dataset.timestampLen = tsLen.toString();
            assistantEl.dataset.timestampStripped = 'true';
        }
        updateAssistantContent(assistantEl, assistantParsed.cleanContent, exchange.assistant.reasoning_content);
        const aEmbed = assistantEl.querySelector('.embed-status');
        if (aEmbed) _applyEmbedStatusAttrs(aEmbed, exchange.assistant.embedStatus || 'pending', exchange.assistant.embedError);
        if (container) _vsAppendMessage(container, assistantEl);

        if (exchange.assistant.isComplete) {
            finalizeAssistantElement(assistantEl, exchange.id);
        }
    }
}

function createAssistantElement(exchangeId, timestamp = '', modelName = '') {
    const el = document.createElement('div');
    el.className = 'chat-message assistant';
    el.dataset.exchangeId = exchangeId;
    const label = modelName || 'Assistant';
    el.innerHTML = `
        <div class="message-header message-header-flex">
            <span>${label}</span>${timestamp ? ` <span class="message-timestamp">${timestamp}</span>` : ''}
            <span class="embed-status" data-embed-status="unknown" title="Embed status unknown">
                <span class="embed-status-dot"></span>
            </span>
            <span class="streaming-indicator visible">
                <span class="dot">.</span><span class="dot">.</span><span class="dot">.</span>
            </span>
            <span class="context-usage-display">
                <span class="usage-values">--</span>
            </span>
        </div>
        <div class="progress-status"></div>
        <div class="message-content">
            <div class="assistant-waiting">
                <span class="assistant-waiting-spinner"></span>
                <span class="assistant-waiting-text">Waiting for response…</span>
            </div>
        </div>
        <div class="message-actions">
            <nui-button class="action-btn speaker" title="Read Aloud"><button type="button"><nui-icon name="volume"></nui-icon></button></nui-button>
            <div class="spacer"></div>
            <nui-button class="action-btn copy-message" title="Copy Message"><button type="button"><nui-icon name="content_copy"></nui-icon></button></nui-button>
            <nui-button class="action-btn edit-message" title="Edit Message"><button type="button"><nui-icon name="edit"></nui-icon></button></nui-button>
            <nui-button class="action-btn delete-message" title="Delete Message"><button type="button"><nui-icon name="delete"></nui-icon></button></nui-button>
        </div>
    `;

    // Bind action buttons
    el.querySelector('.speaker')?.addEventListener('click', () => toggleTts(exchangeId, el));
    el.querySelector('.copy-message')?.addEventListener('click', (e) => copyMessageToClipboard(exchangeId, e.currentTarget));
    el.querySelector('.edit-message')?.addEventListener('click', () => startEditMode(exchangeId, 'assistant'));
    el.querySelector('.delete-message')?.addEventListener('click', () => {
        _runnerDeleteMessage(conversation.getExchange(exchangeId), 'assistant');
    });

    return el;
}

function updateUsageDisplay(el, contextData, usageData = null, streamStats = null) {
    if (!el || !contextData) return;
    const displaySpan = el.querySelector('.context-usage-display');
    const valueSpan = el.querySelector('.usage-values');
    if (!displaySpan || !valueSpan) return;

    if (contextData.used_tokens !== undefined) {
        displaySpan.style.display = 'inline-block';

        // Compact token formatting (e.g., 36139 -> "36K")
        function formatTokensCompact(n) {
            if (n >= 1000000) return Math.round(n / 100000) / 10 + 'M';
            if (n >= 1000) return Math.round(n / 100) / 10 + 'K';
            return n.toString();
        }

        const isEstimate = contextData.isEstimate;
        let text = `${isEstimate ? '~' : ''}${formatTokensCompact(contextData.used_tokens)}`;

        let windowSize = contextData.window_size;
        if (!windowSize) {
            const modelConfig = models.find(m => m.id === currentModel);
            if (modelConfig && modelConfig.capabilities?.contextWindow) {
                windowSize = modelConfig.capabilities.contextWindow;
            }
        }

        if (windowSize) {
            text += ` / ${formatTokensCompact(windowSize)}`;
        }
        text += ' Tokens';

        // Runner streamStats shape: { ttftMs, durationMs, approxTokens, aborted }.
        if (streamStats && usageData && usageData.completion_tokens && streamStats.durationMs) {
            const tps = (usageData.completion_tokens / (streamStats.durationMs / 1000)).toFixed(1);
            text += ` | ${streamStats.ttftMs}ms TTFT | ${tps} T/s`;
        } else if (streamStats && streamStats.ttftMs != null) {
            text += ` | ${streamStats.ttftMs}ms TTFT`;
        }

        // Chunk-store: show what was actually sent after dedup (if the
        // per-chat transform is enabled and produced stats this request).
        const chunkStats = conversation?._lastChunkStats;
        if (chunkStats) {
            const savedPct = chunkStats.bytesIn ? Math.round((1 - chunkStats.bytesOut / chunkStats.bytesIn) * 100) : 0;
            const outK = (chunkStats.bytesOut / 1000).toFixed(0);
            const inK = (chunkStats.bytesIn / 1000).toFixed(0);
            text += ` | dedup: ${outK}K/${inK}K chars (-${savedPct}%), ${chunkStats.exactDupes + chunkStats.nearDupes} refs`;
            updateChunkSavingsPill(chunkStats);
        }

        // Only update if value changed - prevents tooltip flicker
        if (valueSpan.textContent !== text) {
            valueSpan.textContent = text;
        }

        // Add full context info as tooltip for debugging
        let debugText = [];
        for (const [key, val] of Object.entries(contextData)) {
            if (key !== 'isEstimate') {
                debugText.push(`${key}: ${val}`);
            }
        }
        const newTitle = debugText.length > 0 ? debugText.join('\n') : '';
        if (displaySpan.title !== newTitle) {
            displaySpan.title = newTitle;
        }

        updateOverallContext(contextData);
    }
}

async function updateOverallContext(contextData = null) {
    if (!elements.overallContextProgressWrap) return;

    if (!contextData) {
        // Try to get from last conversation exchange
        const lastEx = conversation.exchanges[conversation.exchanges.length - 1];
        
        let foundContext = lastEx?.assistant?.context;
        let foundUsage = lastEx?.assistant?.usage;

        // Fallback to version data if loading from history and surface variables are missing
        if (!foundContext && !foundUsage && lastEx?.assistant?.versions?.length > 0) {
            const curVersion = lastEx.assistant.versions[lastEx.assistant.currentVersion || 0];
            if (curVersion) {
                foundContext = curVersion.context;
                foundUsage = curVersion.usage;
            }
        }

        if (foundContext) {
            contextData = foundContext;
        } else {
            // Rough estimation from the in-memory exchanges (no gateway/API call).
            let textLength = 0;
            const strip = (s) => (typeof s === 'string' ? s.replace(/<think>[\s\S]*?<\/think>/g, '') : '');
            for (const ex of conversation.getAll()) {
                textLength += strip(ex.user?.content).length + strip(ex.assistant?.content).length + strip(ex.tool?.content).length;
            }
            if (textLength > 0) {
                // Heuristic: ~4 chars per token for English
                contextData = { used_tokens: Math.ceil(textLength / 4), isEstimate: true };
            }
        }
    }

    // The wrapper is always visible via CSS, context-progress-wrap class handles display

    const usedTokens = (contextData && contextData.used_tokens) ? contextData.used_tokens : 0;
    const isEstimate = contextData && contextData.isEstimate;
    
    // Compact token formatting (e.g., 36139 -> "36K")
    function formatTokensCompact(n) {
        if (n >= 1000000) return Math.round(n / 100000) / 10 + 'M';
        if (n >= 1000) return Math.round(n / 100) / 10 + 'K';
        return n.toString();
    }
    
    let text = `${isEstimate ? '~' : ''}${formatTokensCompact(usedTokens)}`;
    let pct = 0;
    let knownLimit = false;

    const modelConfig = models.find(m => m.id === currentModel);

    if (modelConfig && modelConfig.capabilities?.contextWindow) {
        text += ` / ${formatTokensCompact(modelConfig.capabilities.contextWindow)} Tokens`;
        pct = Math.min(100, Math.max(0, (usedTokens / modelConfig.capabilities.contextWindow) * 100));
        knownLimit = true;
    } else if (contextData && contextData.window_size) {
        // Fallback to backend reported window size if model list lacks it
        text += ` / ${formatTokensCompact(contextData.window_size)} Tokens`;
        pct = Math.min(100, Math.max(0, (usedTokens / contextData.window_size) * 100));
        knownLimit = true;
    } else {
        text += ` / ? Tokens`;
    }

    if (elements.overallContextProgressWrap) {
        let debugText = [];
        if (contextData) {
            for (const [key, val] of Object.entries(contextData)) {
                if (key !== 'isEstimate') {
                    debugText.push(`${key}: ${val}`);
                }
            }
        }
        elements.overallContextProgressWrap.title = debugText.length > 0 ? debugText.join('\n') : '';
    }

    if (elements.overallContextProgress) {
        elements.overallContextProgress.setAttribute('value', pct || 0);
        
        // Dim the icon if we genuinely do not know the context limit, or if no model is selected
        if (!knownLimit || !currentModel) {
            elements.overallContextProgress.style.opacity = '0.3';
            elements.overallContextProgress.removeAttribute('variant');
        } else {
            elements.overallContextProgress.style.opacity = '1';
            // Change variant to warning/orange if context is full
            if (pct >= 100) {
                elements.overallContextProgress.setAttribute('variant', 'warning');
            } else {
                elements.overallContextProgress.removeAttribute('variant');
            }
        }
    }

    if (elements.overallContextTooltip) {
        elements.overallContextTooltip.textContent = text;
    }
}



function setEmbedStatus(exchangeId, status, error = null, role = 'assistant') {
    const el = document.querySelector(`.chat-message.${role}[data-exchange-id="${exchangeId}"] .embed-status`);
    if (!el) return;
    _applyEmbedStatusAttrs(el, status, error);
}

// Direct attribute set on an embed-status element (no DOM query — for detached elements)
function _applyEmbedStatusAttrs(el, status, error = null) {
    el.dataset.embedStatus = status || 'unknown';
    const tooltip = status === 'embedded'
        ? 'Embedded in vector search'
        : status === 'pending'
            ? 'Embedding queued...'
            : status === 'failed'
                ? `Embed failed: ${error || 'unknown'}`
                : 'Embed status unknown';
    el.title = tooltip;
}

function connectEmbedEvents(chatId) {
    disconnectEmbedEvents();
    if (!chatId || CONFIG.enableBackend !== true) return;
    _embedEventChatId = chatId;
    const base = CONFIG.backendUrl || '';
    const url = `${base}/api/embed-events?chatId=${encodeURIComponent(chatId)}`;
    const es = new EventSource(url);
    es.addEventListener('embed-status', (e) => {
        try {
            const event = JSON.parse(e.data);
            if (!event || event.chatId !== _embedEventChatId) return;
            _applyEmbedEvent(event);
        } catch (err) {}
    });
    es.onerror = () => {
        // EventSource auto-reconnects; log only on hard failures
        if (es.readyState === EventSource.CLOSED) {
            console.warn('[Embed] SSE connection closed permanently for chat:', chatId);
        }
    };
    _embedEventSource = es;
}

function disconnectEmbedEvents() {
    if (_embedEventSource) {
        _embedEventSource.close();
        _embedEventSource = null;
    }
    _embedEventChatId = null;
}

function _applyEmbedEvent(event) {
    // event: { chatId, msgIdx, messageId, embedStatus, embedError }
    const conv = activeConversations.get(event.chatId);
    if (!conv || !conv.exchanges) return;

    // Try exact msgIdx match first (works for loaded exchanges with _asstMsgIdx/_userMsgIdx)
    for (const ex of conv.exchanges) {
        if (ex._asstMsgIdx === event.msgIdx) {
            if (ex.assistant && ex.assistant.embedStatus !== event.embedStatus) {
                ex.assistant.embedStatus = event.embedStatus;
                ex.assistant.embedError = event.embedError || null;
            }
            setEmbedStatus(ex.id, event.embedStatus, event.embedError);
            return;
        }
        if (ex._userMsgIdx === event.msgIdx) {
            setEmbedStatus(ex.id, event.embedStatus, event.embedError, 'user');
            return;
        }
    }

    // Fallback: positional matching for live exchanges that don't have msgIdx set yet
    // (SSE event may arrive before _syncMessage's .then() sets _asstMsgIdx)
    const asstExchanges = conv.exchanges.filter(ex =>
        ex.assistant && (ex.assistant.content || ex.assistant.isComplete)
    );
    const userExchanges = conv.exchanges.filter(ex =>
        ex.user && ex.user.content
    );

    // Estimate exchange index from msgIdx: even=user, odd=assistant (simple chats)
    // For tool exchanges, this is approximate but works as a fallback
    const estIdx = Math.floor(event.msgIdx / 2);
    const isUser = event.msgIdx % 2 === 0;

    if (isUser && estIdx < userExchanges.length) {
        const ex = userExchanges[estIdx];
        if (ex._userMsgIdx === undefined) ex._userMsgIdx = event.msgIdx;
        setEmbedStatus(ex.id, event.embedStatus, event.embedError, 'user');
    } else if (!isUser && estIdx < asstExchanges.length) {
        const ex = asstExchanges[estIdx];
        if (ex._asstMsgIdx === undefined) ex._asstMsgIdx = event.msgIdx;
        if (ex.assistant && ex.assistant.embedStatus !== event.embedStatus) {
            ex.assistant.embedStatus = event.embedStatus;
            ex.assistant.embedError = event.embedError || null;
        }
        setEmbedStatus(ex.id, event.embedStatus, event.embedError);
    }
}

function updateAssistantContent(el, content, reasoningContent = null) {
    const contentDiv = el.querySelector('.message-content');
    if (!contentDiv) return;

    // The waiting-for-response placeholder is a pre-stream state. Any content
    // pass (even empty — history rebuild) means the stream started; drop it.
    const waitingEl = contentDiv.querySelector('.assistant-waiting');
    if (waitingEl) waitingEl.remove();

    let visibleContent = content;

    // Strip the injected timestamp from visible content (shown in header)
    if (el.dataset.timestampLen && visibleContent.startsWith('[')) {
        const len = parseInt(el.dataset.timestampLen);
        if (visibleContent.length >= len) {
            visibleContent = visibleContent.substring(len).trim();
        } else if (visibleContent.length < 20) {
            // Not enough content yet, likely still building up timestamp
            return;
        }
    } else if (visibleContent.startsWith('[')) {
        // Fallback: try to parse timestamp (for backwards compatibility)
        const tsParsed = parseTimestamp(visibleContent);
        visibleContent = tsParsed.cleanContent;
    }

    // Hide the entire assistant bubble if it's completely empty (or just contained the stripped TOOL_CALL)
    if (!visibleContent.trim() && (!reasoningContent || !reasoningContent.trim())) {
        el.style.display = 'none';
        // Note: we don't return here, so it updates the internal state in case it needs to re-appear later
    } else {
        el.style.display = '';
    }

    // Skip if content hasn't changed (prevents redundant renders during streaming)
    const rKey = reasoningContent || '';
    if (contentDiv.dataset.lastContent === visibleContent && contentDiv.dataset.lastReasoning === rKey) return;
    contentDiv.dataset.lastContent = visibleContent;
    contentDiv.dataset.lastReasoning = rKey;

    // Check if thinking-content is currently scrolled to bottom to maintain it
    let thinkingScrollTop = 0;
    let thinkingWasAtBottom = true;
    const oldThinkingContent = contentDiv.querySelector('.thinking-content');
    if (oldThinkingContent) {
        thinkingScrollTop = oldThinkingContent.scrollTop;
        const tolerance = 10;
        thinkingWasAtBottom = Math.abs(oldThinkingContent.scrollHeight - oldThinkingContent.scrollTop - oldThinkingContent.clientHeight) <= tolerance;
    }

    // Parse thinking and answer
    const parsed = parseThinking(visibleContent);
    
    // Explicit API reasoning_content overrides inline <think> tags
    if (reasoningContent) {
        parsed.thinking = reasoningContent;
        // if explicitly passed via API, the content doesn't have <think> tags so answer is just the content.
        // If we have reasoning but no main answer yet while streaming, reasoning is currently active.
        if (el.dataset.isStreaming === 'true' && !visibleContent.trim()) {
            parsed.isStreaming = true;
        }
    }

    // Use the element's actual streaming state, not just whether <think> is open
    const isNetworkStreaming = el.dataset.isStreaming === 'true';

    // INCREMENTAL DOM UPDATE PATTERN:
    // Only create elements once, then update in place

    // === THINKING BLOCK ===
    const thinkingId = 'thinking-' + el.dataset.exchangeId;
    let thinkingBlock = contentDiv.querySelector('.thinking-block');

    if (parsed.thinking !== null) {

        if (!thinkingBlock) {
            // Create thinking block once - it doesn't exist yet
            thinkingBlock = document.createElement('div');
            thinkingBlock.className = 'thinking-block collapsed';
            thinkingBlock.id = thinkingId;
            thinkingBlock.innerHTML = `
                <div class="thinking-header" onclick="toggleThinking('${thinkingId}')">
                    <nui-icon name="lightbulb_2" aria-hidden="true"><svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false"><use href="/lib/nui_wc2/NUI/assets/material-icons-sprite.svg#image"></use></svg></nui-icon>
                    <span class="thinking-title">Thoughts</span>
                    <span class="thinking-toggle">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <polyline points="6 9 12 15 18 9"></polyline>
                        </svg>
                    </span>
                </div>
                <div class="thinking-content"></div>
            `;
            contentDiv.appendChild(thinkingBlock);
        }

        // Update existing thinking block state and content
        // Always stay collapsed by default - user manually expands if they want to see it
        if (parsed.isStreaming) {
            thinkingBlock.classList.add('streaming');
            const titleEl = thinkingBlock.querySelector('.thinking-title');
            if (titleEl) titleEl.textContent = 'Thinking...';
        } else {
            thinkingBlock.classList.remove('streaming');
            const titleEl = thinkingBlock.querySelector('.thinking-title');
            if (titleEl) titleEl.textContent = 'Thoughts';
        }

        // Update thinking content text - only this changes during streaming
        const thinkingContent = thinkingBlock.querySelector('.thinking-content');
        if (thinkingContent) {
            thinkingContent.textContent = parsed.thinking;
        }
    } else if (thinkingBlock) {
        // No thinking but element exists - could remove it, or leave for now
        // Keeping it preserves collapsed state if user interacted with it
    }

    // === ANSWER BLOCK ===
    // Track answer container for incremental updates
    let answerContainer = contentDiv.querySelector('.answer-container');

    if (parsed.answer) {
        if (!answerContainer) {
            // Create answer container once
            answerContainer = document.createElement('div');
            answerContainer.className = 'answer-container';
            contentDiv.appendChild(answerContainer);

            const nuiMd = document.createElement('nui-markdown');
            answerContainer.appendChild(nuiMd);
            answerContainer.dataset.lastAnswerLen = 0;
        }

        const nuiMd = answerContainer.querySelector('nui-markdown');
        if (nuiMd) {
            const currentAnswerLen = parseInt(answerContainer.dataset.lastAnswerLen || '0', 10);
            const newAnswerLen = parsed.answer.length;

            if (isNetworkStreaming) {
                if (!nuiMd._isStreaming) nuiMd.beginStream();
                if (newAnswerLen > currentAnswerLen) {
                    const chunk = parsed.answer.substring(currentAnswerLen);
                    nuiMd.appendChunk(chunk);
                    answerContainer.dataset.lastAnswerLen = newAnswerLen;
                }
            } else {
                if (nuiMd._isStreaming) {
                    // End of an active stream
                    if (newAnswerLen > currentAnswerLen) {
                        const chunk = parsed.answer.substring(currentAnswerLen);
                        nuiMd.appendChunk(chunk);
                    }
                    nuiMd.endStream();
                    answerContainer.dataset.lastAnswerLen = newAnswerLen;
                } else if (newAnswerLen > currentAnswerLen) {
                    // Complete message (e.g. from history load)
                    if (window.nui?.util?.markdownToHtml) {
                        nuiMd.innerHTML = window.nui.util.markdownToHtml(parsed.answer);
                        // Prevent automatic connectedCallback from double-parsing if appended to DOM later.
                        // Use _processed (NOT _isStreaming) — this element is complete, not streaming;
                        // marking it streaming would make endStream() crash on missing _tempContainer
                        // and block a later regeneration's beginStream().
                        nuiMd._processed = true;
                    } else {
                        // Module not ready: rely on declarative markup that upgrades automatically later
                        const safeContent = parsed.answer.replace(/<\/script/gi, '<\\/script');
                        nuiMd.innerHTML = `<script type="text/markdown">\n${safeContent}\n</script>`;
                    }
                    answerContainer.dataset.lastAnswerLen = newAnswerLen;
                }
            }
        }
    }

    // Restore thinking-content scroll position
    const newThinkingContent = contentDiv.querySelector('.thinking-content');
    if (newThinkingContent) {
        if (thinkingWasAtBottom) {
            newThinkingContent.scrollTop = newThinkingContent.scrollHeight;
        } else {
            newThinkingContent.scrollTop = thinkingScrollTop;
        }
    }

    // WI-2: streaming content changes the element's height — wake the loop
    // so it detects the growth and cascades. Keeps the loop awake through
    // generation pauses > 0.5s (VS_IDLE_FRAMES).
    const container = el.closest('.conversation-container');
    if (container) _vsWake(container);
}

window.toggleThinking = function(id) {
    const el = document.getElementById(id);
    if (el) {
        const isCollapsing = !el.classList.contains('collapsed');
        el.classList.toggle('collapsed');
        el.dataset.userToggled = 'true';  // Track that user manually toggled

        // When collapsing, scroll to bottom first so most recent thinking shows
        if (isCollapsing) {
            const content = el.querySelector('.thinking-content');
            if (content) {
                content.scrollTop = content.scrollHeight;
            }
        }

        // WI-2: height change detected by the frame loop (container click
        // listener wakes it). toggleThinking is now a pure CSS class toggle.
    }
};

// Force-finalize the nui-markdown streaming render on an assistant bubble.
// Flips isStreaming to 'false' (idempotent — done path already did it via
// finalizeAssistantElement, error/aborted paths never did), resets the render
// dedup keys so the final updateAssistantContent call can't be skipped, then
// re-renders complete content. The non-streaming branch runs endStream(),
// draining the trailing partial block from _tempContainer into the stable DOM.
// Closes the race where a debounced timer fires after the terminal event and
// leaves the tail as raw markdown (far more likely in background tabs where
// setTimeout is throttled to ≥1000ms).
function forceFinalizeMarkdownStream(el, content, reasoningContent = null) {
    const contentDiv = el.querySelector('.message-content');
    if (!contentDiv) return;
    el.dataset.isStreaming = 'false';
    delete contentDiv.dataset.lastContent;
    delete contentDiv.dataset.lastReasoning;
    updateAssistantContent(el, content, reasoningContent);
}

function showCompactionIndicator(el, data) {
    const contentDiv = el.querySelector('.message-content');
    if (!contentDiv) return;
    
    let compactEl = contentDiv.querySelector('.compaction-indicator');
    if (!compactEl) {
        compactEl = document.createElement('div');
        compactEl.className = 'compaction-indicator';
        compactEl.innerHTML = '<span class="icon">ðŸ“</span> Compacting context...';
        contentDiv.insertBefore(compactEl, contentDiv.firstChild);
    }
}

function updateCompactionProgress(el, data) {
    // Could show progress bar here
}

function hideCompactionIndicator(el) {
    const compactEl = el.querySelector('.compaction-indicator');
    if (compactEl) {
        compactEl.remove();
    }
}

function showError(el, message) {
    const contentDiv = el.querySelector('.message-content');
    if (contentDiv) {
        contentDiv.innerHTML += `<div class="error-message">Error: ${escapeHtml(message)}</div>`;
    }
    
    // Remove waiting placeholder — the bubble now shows an error state
    const waitingEl = el.querySelector('.assistant-waiting');
    if (waitingEl) waitingEl.remove();

    // Hide streaming indicator
    const indicator = el.querySelector('.streaming-indicator');
    if (indicator) indicator.style.display = 'none';
}

// conversationRef: explicit conversation to read exchange data from. The tool
// execution path (handleToolExecution) passes the per-chat toolConversation —
// the global may point at a different chat if the user switched mid-tool.
function finalizeAssistantElement(el, exchangeId, usage = null, contextInfo = null, streamStats = null, conversationRef = null) {
    const convRef = conversationRef || conversation;
    const ex = convRef?.getExchange?.(exchangeId);
    if (ex?.assistant?.error) el.classList.add('run-error');
    el.dataset.isStreaming = 'false';
    // Remove waiting placeholder — the bubble is now complete or errored
    const waitingEl = el.querySelector('.assistant-waiting');
    if (waitingEl) waitingEl.remove();
    // Hide streaming indicator
    const indicator = el.querySelector('.streaming-indicator');
    if (indicator) indicator.classList.remove('visible');

    // Update static usage text if we have it
    const exchange = convRef.getExchange(exchangeId);
    let finalUsage = usage || exchange?.assistant?.usage;
    let finalContext = contextInfo || exchange?.assistant?.context;
    let finalStats = streamStats || exchange?.assistant?.streamStats;
    
    // Fallback to the saved version data if we are loading from history
    if (!finalUsage && !finalContext && exchange?.assistant) {
        const curVersion = exchange.assistant.versions?.[exchange.assistant.currentVersion || 0];
        if (curVersion) {
            finalUsage = curVersion.usage;
            finalContext = curVersion.context;
            finalStats = curVersion.streamStats || finalStats;
        }
    }

    if (finalContext) {
        updateUsageDisplay(el, finalContext, finalUsage, finalStats);
    } else if (exchange && exchange.assistant?.content) {
        // Fallback: estimate cumulative tokens by summing all exchanges up to this one
        let cumulativeChars = 0;
        const allExchanges = convRef.getAll();
        for (const ex of allExchanges) {
            const userText = ex.user && typeof ex.user.content === 'string' ? ex.user.content : '';
            let asstText = ex.assistant && typeof ex.assistant.content === 'string' ? ex.assistant.content : '';
            asstText = asstText.replace(/<think>[\s\S]*?<\/think>/g, '');
            cumulativeChars += userText.length + asstText.length;
            if (ex.id === exchange.id) break;
        }
        const roughTokens = Math.ceil(cumulativeChars / 4);
        updateUsageDisplay(el, { used_tokens: roughTokens, isEstimate: true });
    }

    // Show the action toolbar (speaker / copy / edit / delete).
    const actions = el.querySelector('.message-actions');
    if (actions) {
        actions.classList.add('visible');
        actions.querySelector('.speaker').style.display = 'inline-block';
    }
    
    // Remove streaming class from thinking block
    const thinking = el.querySelector('.thinking-block.streaming');
    if (thinking) {
        thinking.classList.remove('streaming');
        thinking.querySelector('.thinking-title').textContent = 'Thinking';
    }

    // WI-2: element height is now stable — wake the loop to detect the
    // finalized height and cascade. (Replaces _vsOnContentGrown + _vsRecalcItem.)
    const container = el.closest('.conversation-container') || getActiveContainer();
    if (container) {
        _vsWake(container);
        _vsUpdateVisible(container);
    }
}

// ============================================
// Actions
// ============================================

function getAssistantPlainText(exchangeId) {
    const exchange = conversation.getExchange(exchangeId);
    if (!exchange || !exchange.assistant) return '';
    let content = exchange.assistant.content || '';
    const parsed = parseTimestamp(content);
    content = parsed.cleanContent || content;
    return getPlainText(content);
}

function stopTts() {
    if (tts) tts.stop();
    currentTtsExchangeId = null;
}

function toggleTts(exchangeId, el) {
    if (!tts) return;

    // Same message while active:
    //   loading → cancel generation (only explicit cancel path besides stop/new speak)
    //   playing/paused → pause/resume (download keeps running)
    // Different message → new speak (replaces session, aborts prior download).
    if (currentTtsExchangeId === exchangeId && tts.isActive()) {
        if (tts.getPlaybackState() === 'loading') {
            stopTts(); // cancel()
            return;
        }
        ttsPlayer?.reveal();
        tts.togglePause();
        return;
    }

    const text = getAssistantPlainText(exchangeId);
    if (!text) return;

    currentTtsExchangeId = exchangeId;
    ttsPlayer?.reveal();
    tts.speak(text, el);
}

async function copyMessageToClipboard(exchangeId, btn) {
    const exchange = conversation.getExchange(exchangeId);
    if (!exchange) return;
    
    // Always use assistant, but can be generic if needed
    const rawContent = exchange.assistant.content;
    const currentContent = parseTimestamp(rawContent).cleanContent;
    const parsed = parseThinking(currentContent);
    const mdToCopy = parsed.answer || currentContent;
    const textToCopy = mdToCopy.trim();
    
    try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(textToCopy);
        } else {
            // Fallback for non-https environments where navigator.clipboard is missing
            const textArea = document.createElement('textarea');
            textArea.value = textToCopy;
            textArea.style.position = 'fixed'; // Avoid scrolling to bottom
            textArea.style.opacity = '0';
            document.body.appendChild(textArea);
            textArea.focus();
            textArea.select();
            document.execCommand('copy');
            document.body.removeChild(textArea);
        }
        const icon = btn.querySelector('nui-icon');
        const oldIconName = icon.getAttribute('name');
        icon.setAttribute('name', 'check');
        setTimeout(() => icon.setAttribute('name', oldIconName), 2000);
    } catch (err) {
        console.error('Failed to copy text: ', err);
    }
}

async function startEditMode(exchangeId, role = 'user') {
    // Block editing only if this specific exchange in the current chat is currently streaming
    if (runnerViews.get(currentChatId)?.streaming?.el && currentExchangeId === exchangeId) return;

    // Capture chat context at call time — the dialog is async and the user may
    // switch tabs while it's open. We must save edits to the original conversation.
    const editConv = conversation;
    const editChatId = currentChatId;

    const exchange = editConv.getExchange(exchangeId);
    if (!exchange) return;

    const rawContent = role === 'user' ? exchange.user.content : exchange.assistant.content;
    const currentContent = parseTimestamp(rawContent).cleanContent;

    const parsed = parseThinking(currentContent);
    // Even if it has thinking, we only edit the final parsed answer
    const editableContent = parsed.answer || currentContent;

    const contentHtml = `
        <div class="edit-dialog-container">
            <nui-rich-text class="edit-textarea"></nui-rich-text>
        </div>
    `;

    const { dialog, main } = await nui.components.dialog.page('Edit Message', '', {
        contentScroll: false, 
        buttons: [
            { label: 'Cancel', type: 'outline', value: 'cancel' },
            { label: role === 'user' ? 'Save & Resubmit' : 'Save', type: 'primary', value: 'save' }
        ]
    });
    main.innerHTML = contentHtml;

    // Initialize content using standard NUI method on connected nodes
    const applyContent = () => {
        const tb = main.querySelector('nui-rich-text');
        if(tb && tb.setMarkdown) tb.setMarkdown(editableContent);
    };
    
    // Auto focus the appended textarea within the dialog
    const focusArea = main.querySelector('nui-rich-text');
    if (focusArea) {
        // give dialog time to mount
        setTimeout(() => {
            applyContent();
            // NuiRichText inner editor focus
            const editor = focusArea.querySelector('.nui-rich-text-editor');
            if (editor) editor.focus();
        }, 100);
    }

    dialog.addEventListener('nui-dialog-close', (e) => {
        const action = e.detail?.returnValue;
        if (action !== 'save') return;

        let newContent = main.querySelector('nui-rich-text')?.getMarkdown().trim() || '';
        
        // Ensure if there was original thinking we retain it unedited in the saved state
        if (parsed.thinking) {
            newContent = `<think>\n${parsed.thinking}\n</think>\n\n${newContent}`.trim();
        }

        if (newContent && newContent !== currentContent) {
            commitEdit(exchangeId, role, newContent, editConv, editChatId);
        }
    });
}

function commitEdit(exchangeId, role, newContent, editConv, editChatId) {
    // Use the captured conversation for the chat being edited, not the global.
    // editConv is captured in startEditMode before the async dialog opens,
    // so it's safe even if the user switched tabs while editing.
    const conv = editConv || conversation;
    const exchange = conv.getExchange(exchangeId);
    if (!exchange) return;

    if (role === 'user') {
        const msgId = exchange._userMsgId;
        if (!msgId) return;
        // Single-author edit: the runner truncates after + re-runs + broadcasts a
        // full snapshot (which this view re-renders). No client-side persistence.
        runnerClient.editMessage(editChatId, msgId, newContent).catch((err) => {
            console.error('Edit failed:', err);
        });
    } else {
        const msgId = exchange._asstMsgId;
        if (!msgId) return;
        // Assistant edit = in-place content update (no re-run) — the runner
        // dispatches by role. Same single-author path as user edit.
        runnerClient.editMessage(editChatId, msgId, newContent).catch((err) => {
            console.error('Edit failed:', err);
        });
    }
}

// ============================================
// History Management
// ============================================

async function startNewChat() {
    // Note: we do NOT abort background streams when starting a new chat.
    // Each chat's stream continues in its hidden containers.

    const newChatId = await chatHistory.create();
    currentChatId = newChatId;

    // Restore last-used model — pref is kept current on every selection
    // (nui-change). Validate against the loaded list; fall back to first model
    // (same semantics as the chat-switch path), empty only if no models loaded.
    let restoreModel = await storage.getPref('default-model');
    if (!restoreModel || !models.some(m => m.id === restoreModel)) {
        restoreModel = models.length > 0 ? models[0].id : '';
    }
    currentModel = restoreModel;
    if (elements.modelSelect.setValue) {
        elements.modelSelect.setValue(restoreModel);
    } else {
        const select = elements.modelSelect?.querySelector('select');
        if (select) select.value = restoreModel;
    }

    // Cache the new conversation
    conversation = new Conversation(`chat-conversation-${currentChatId}`);
    activeConversations.set(currentChatId, conversation);

    // Create container for the new chat (hidden until shown)
    const newContainer = getOrCreateContainer(currentChatId);

    // Toggle: show new chat, hide others
    for (const [id, container] of chatContainers.entries()) {
        container.style.display = id === currentChatId ? 'flex' : 'none';
    }

    renderHistoryList();
    attachRunnerEvents(currentChatId); // snapshot (empty) shows the welcome

    // Auto-focus input
    setTimeout(() => {
        const textarea = elements.messageInput?.querySelector('textarea');
        if (textarea) textarea.focus();
    }, 100);
}

function restoreSystemPromptUI(chatInfo) {
    if (chatInfo && elements.systemPrompt) {
        const textarea = elements.systemPrompt.querySelector('textarea');
        if (textarea) {
            textarea.value = chatInfo.systemPrompt || '';
            // Reset preset selector
            const select = elements.presetSelect?.querySelector('select');
            if (select) select.value = '';
        }
    }
}

async function switchChat(targetChatId) {
    // Capture the outgoing conversation before changing currentChatId.
    // We MUST set currentChatId BEFORE any await — otherwise sendMessage()
    // can fire during the yield point and capture the old chatId, sending
    // the user's message into the wrong conversation.
    currentChatId = targetChatId;
    storage.setActiveChatId(currentChatId).catch(() => {});

    // Reset preview pane — it's a shared surface across per-chat containers.
    // Without this, chat B would see chat A's preview. Idempotent: safe on init.
    preview.reset();

    // 1. Get or create the container for this chat (creates DOM node if first time)
    const targetContainer = getOrCreateContainer(targetChatId);

    // 2. Load conversation (runner-owned) — attach to the event stream; the
    // snapshot event populates + renders. No client-side load()/persistence.
    let conv = activeConversations.get(targetChatId);
    if (!conv) {
        conv = new Conversation(`chat-conversation-${targetChatId}`);
        activeConversations.set(targetChatId, conv);
    }
    conversation = conv;
    attachRunnerEvents(targetChatId);

    // Per-chat chunk-transform flag (chunk-store: lossless payload dedup).
    // Lives on the session doc; consulted by getMessagesForApi at send time.
    const chatMeta = chatHistory.conversations.find(c => c.id === targetChatId);
    conv.chunkTransform = !!(chatMeta && chatMeta.chunkTransform);

    // Savings pill follows the chat: reset accumulator + visibility.
    const pill = document.getElementById('chunk-savings-pill');
    if (pill) {
        _chunkSavings.chatId = targetChatId;
        _chunkSavings.charsSaved = 0;
        _chunkSavings.displayed = 0;
        pill.style.display = 'none';
    }

    // 3. (Removed — the runner owns session identity; no client session ID.)

    // 4. (Removed — the runner snapshot handler builds the historical DOM.)

    // 5. Toggle container visibility — all other streams continue in their hidden containers
    for (const [id, container] of chatContainers.entries()) {
        container.style.display = id === targetChatId ? 'flex' : 'none';
    }

    // Reclaim idle background chats (connection pool + memory): keep only the
    // visible chat and chats with a live run. A fresh snapshot re-attaches on
    // the next visit, so nothing is lost.
    for (const id of [...runnerViews.keys()]) {
        if (id === targetChatId) continue;
        if (runnerViews.get(id)?.streaming?.el) continue; // mid-run — keep
        _teardownView(id);
    }

    // 6. Activate virtual scroll after container is visible and web components settle
    if (targetContainer.children.length > 0 && !targetContainer.querySelector('.vs-stage')) {
        _vsActivateWhenReady(targetContainer);
    }

    // Restore the system prompt
    const chatInfo = chatHistory.get(targetChatId);
    restoreSystemPromptUI(chatInfo);

    // 6. Restore the model if saved in history
    if (chatInfo && elements.modelSelect) {
        if (chatInfo.model) {
            const modelExists = models.some(m => m.id === chatInfo.model);
            if (modelExists) {
                currentModel = chatInfo.model;
            } else if (models.length > 0) {
                currentModel = models[0].id;
            }
        } else if (models.length > 0) {
            currentModel = models[0].id;
        }

        if (elements.modelSelect.setValue) {
            elements.modelSelect.setValue(currentModel);
        } else {
            const select = elements.modelSelect.querySelector('select');
            if (select) select.value = currentModel;
        }
    }

    // 7. Update UI without wiping background containers
    renderHistoryList();
    updateOverallContext();

    // 8. Sync send button state with whether THIS chat has an active stream
    // The input area is shared across chats, so we must show correct state for the visible chat
    const targetChatIsStreaming = !!runnerViews.get(targetChatId)?.streaming?.el;
    const btn = elements.sendBtn?.querySelector('button');
    if (btn) {
        btn.innerHTML = targetChatIsStreaming
            ? '<nui-icon name="close"></nui-icon>'
            : '<nui-icon name="send"></nui-icon>';
    }

    // Clear new-content indicator since the user is viewing this chat now
    if (chatsWithNewContent.has(targetChatId)) {
        chatsWithNewContent.delete(targetChatId);
        chatTabList?.update(true);
    }

    // Embed status now arrives on the conversation stream (embed.status event);
    // the separate /api/embed-events channel is retired for the runner view.

    console.log('%c📋 DISPLAY %c' + (chatInfo?.title || 'New Chat') + ' %c' + targetChatId,
        'font-weight:bold;color:#4fc3f7', 'color:#aaa', 'color:#666');
}

async function deleteChat(chatId, e) {
    if (e) {
        e.stopPropagation(); // prevent row click
    }

    // Skip confirmation on shift-click
    const skipConfirm = e?.shiftKey;

    if (!skipConfirm && !await nui.components.dialog.confirm('Delete Chat', 'Are you sure you want to delete this chat?')) {
        return;
    }

    // Delete images from imageStore for this chat
    try {
        const exchanges = await storage.loadConversation(chatId);
        for (const ex of exchanges) {
            await imageStore.delete(ex.id);
        }
    } catch (err) {
        console.warn('[Chat] Failed to delete images for chat', chatId, err);
    }

    // Delete from chat history (handles backend deletion)
    chatHistory.delete(chatId);

    // Abort any ongoing run for this chat
    runnerClient.abort(chatId).catch(() => {});

    // Close the chat's event stream and drop its view. _teardownView skips
    // the visible chat, so close explicitly first — a leaked EventSource per
    // deleted chat exhausts the browser's per-origin connection pool.
    const v = runnerViews.get(chatId);
    if (v?.es) { try { v.es.close(); } catch {} }
    if (v?.streaming?.tickTimer) clearInterval(v.streaming.tickTimer);
    runnerViews.delete(chatId);

    // Clean up multi-conversation state
    activeConversations.delete(chatId);
    const container = chatContainers.get(chatId);
    if (container) {
        container.remove();
        chatContainers.delete(chatId);
    }

    // Immediately re-render the history list to reflect deletion
    renderHistoryList();

    if (currentChatId === chatId) {
        const allChats = chatHistory.getAll();
        if (allChats.length > 0) {
            await switchChat(allChats[0].id);
        } else {
            await startNewChat();
        }
    }
}

async function exportChatAsJson(chatId, btn) {
    // Export from in-memory conversation object (source of truth for current session state)
    const conv = activeConversations.get(chatId);
    const exchanges = conv ? conv.getAll() : [];
    if (!exchanges || exchanges.length === 0) {
        nui.components.toast?.error?.('No messages to export');
        return;
    }

    try {
        const meta = chatHistory.get(chatId) || {};

        const exportExchanges = exchanges.map(ex => {
            if (ex.type === 'tool') {
                return {
                    id: ex.id,
                    type: ex.type,
                    timestamp: ex.timestamp,
                    tool: { name: ex.tool?.name, status: ex.tool?.status },
                    assistant: ex.assistant ? {
                        content: ex.assistant.content,
                        isComplete: ex.assistant.isComplete,
                        isStreaming: ex.assistant.isStreaming,
                        usage: ex.assistant.usage,
                        context: ex.assistant.context,
                        embedStatus: ex.assistant.embedStatus || null,
                        embedError: ex.assistant.embedError || null,
                    } : null,
                };
            }
            return {
                id: ex.id,
                type: ex.type,
                timestamp: ex.timestamp,
                user: ex.user ? { content: ex.user.content, attachments: ex.user.attachments, embedStatus: ex.user.embedStatus || null, embedError: ex.user.embedError || null } : null,
                assistant: ex.assistant ? {
                    content: ex.assistant.content,
                    isComplete: ex.assistant.isComplete,
                    isStreaming: ex.assistant.isStreaming,
                    usage: ex.assistant.usage,
                    context: ex.assistant.context,
                    embedStatus: ex.assistant.embedStatus || null,
                    embedError: ex.assistant.embedError || null,
                    reasoning_content: ex.assistant.reasoning_content || null,
                    thinking_signature: ex.assistant.thinking_signature || null,
                    streamStats: ex.assistant.streamStats || null,
                } : null,
            };
        });

        const exportData = {
            version: 2,
            mode: 'direct',
            exportedAt: new Date().toISOString(),
            id: chatId,
            chatInfo: {
                id: meta.id || chatId,
                title: meta.title || 'New Chat',
                createdAt: meta.createdAt || Date.now(),
                updatedAt: meta.updatedAt || Date.now(),
                model: meta.model || '',
                systemPrompt: meta.systemPrompt || '',
                category: meta.category || '',
                pinned: !!meta.pinned
            },
            participants: [
                { name: 'user', model: null, role: 'user', systemPrompt: null },
                { name: 'assistant', model: meta.model || '', role: 'assistant', systemPrompt: null }
            ],
            settings: { model: meta.model || '', systemPrompt: meta.systemPrompt || '' },
            summary: null,
            exchanges: exportExchanges
        };

        const formattedJson = JSON.stringify(exportData, null, 2);
        try {
            await navigator.clipboard.writeText(formattedJson);
            nui.components.toast?.success?.('JSON copied to clipboard');
        } catch (clipErr) {
            // Clipboard API may fail on insecure origins (HTTP) — fall back to textarea
            try {
                const textArea = document.createElement('textarea');
                textArea.value = formattedJson;
                textArea.style.position = 'fixed';
                textArea.style.opacity = '0';
                document.body.appendChild(textArea);
                textArea.focus();
                textArea.select();
                document.execCommand('copy');
                document.body.removeChild(textArea);
                nui.components.toast?.success?.('JSON copied to clipboard');
            } catch (fallbackErr) {
                console.error('Failed to copy JSON to clipboard', fallbackErr);
                console.log(formattedJson);
                nui.components.toast?.success?.('JSON logged to console');
            }
        }
    } catch (e) {
        console.error('Failed to parse chat data', e);
    }
}

async function exportChatToFile(chatId) {
    console.log('[DEBUG] exportChatToFile called with chatId:', chatId);
    // Full export including images - for backup/restore
    // Prefer in-memory conversation (current session), fall back to storage
    const conv = activeConversations.get(chatId);
    const exchanges = conv ? conv.getAll() : await storage.loadConversation(chatId);
    console.log('[DEBUG] exportChatToFile exchanges:', exchanges?.length, 'from memory:', !!conv);
    if (!exchanges || exchanges.length === 0) {
        console.warn('[DEBUG] exportChatToFile: no exchanges found, aborting');
        return;
    }

    try {
        const meta = chatHistory.get(chatId) || {};
        const exportExchanges = [];

        // Load images for each exchange
        for (const ex of exchanges) {
            const exportExchange = { ...ex };

            if (ex.user?.attachments?.some(att => att.hasImage)) {
                const images = await imageStore.load(ex.id);
                exportExchange.user = {
                    ...ex.user,
                    attachments: await Promise.all(ex.user.attachments.map(async (att, idx) => {
                        const img = images[idx];
                        if (img) {
                            return {
                                ...att,
                                dataUrl: await img.getDataUrl()
                            };
                        }
                        return att;
                    }))
                };
            }
            exportExchanges.push(exportExchange);
        }

        const exportData = {
            version: 2,
            mode: 'direct',
            exportedAt: new Date().toISOString(),
            id: chatId,
            chatInfo: {
                id: meta.id || chatId,
                title: meta.title || 'New Chat',
                createdAt: meta.createdAt || Date.now(),
                updatedAt: meta.updatedAt || Date.now(),
                model: meta.model || '',
                systemPrompt: meta.systemPrompt || '',
                category: meta.category || '',
                pinned: !!meta.pinned
            },
            participants: [
                { name: 'user', model: null, role: 'user', systemPrompt: null },
                { name: 'assistant', model: meta.model || '', role: 'assistant', systemPrompt: null }
            ],
            settings: {
                model: meta.model || '',
                systemPrompt: meta.systemPrompt || ''
            },
            summary: null,
            exchanges: exportExchanges
        };

        const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const title = exportData.chatInfo.title
            ? exportData.chatInfo.title.replace(/[^a-z0-9]/gi, '_').toLowerCase().substring(0, 30)
            : 'chat';
        const date = new Date().toISOString().split('T')[0];
        const filename = `direct-${title}-${date}.json`;

        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        console.log('[DEBUG] exportChatToFile download triggered:', filename);

    } catch (e) {
        console.error('Failed to export chat to file', e);
        nui.components.dialog.alert('Export Failed', 'Could not export chat session.');
    }
}

async function handleChatImport(e) {
    const file = e.target.files?.[0];
    if (!file) return;

    e.target.value = '';

    try {
        const text = await file.text();
        const importData = JSON.parse(text);

        if (!importData.exchanges || !Array.isArray(importData.exchanges)) {
            throw new Error('Invalid format: missing exchanges array');
        }

        const newChatId = await chatHistory.create();
        const title = importData.chatInfo?.title || 'Imported Chat';

        const meta = chatHistory.conversations.find(c => c.id === newChatId);
        if (meta) {
            meta.title = title;
            meta.model = importData.chatInfo?.model || '';
            meta.systemPrompt = importData.chatInfo?.systemPrompt || '';
            meta.category = importData.chatInfo?.category || '';
            meta.pinned = !!importData.chatInfo?.pinned;
            meta._dirty = true;
        }
        await chatHistory._saveList();

        // Re-upload images to server so dataUrls become server URLs.
        // Then replay every message to the backend in order via sendMessage.
        // (storage.saveConversation is a no-op since offline caching was removed;
        // the backend conversation doc is the source of truth.)
        for (const ex of importData.exchanges) {
            let savedAttachments = null;
            if (ex.user?.attachments?.some(att => att.dataUrl)) {
                const attachmentImages = ex.user.attachments
                    .filter(att => att.dataUrl)
                    .map(att => ({ dataUrl: att.dataUrl, name: att.name, type: att.type }));
                if (attachmentImages.length > 0) {
                    const savedFiles = await imageStore.save(ex.id, attachmentImages);
                    savedAttachments = ex.user.attachments.map((att, idx) => ({
                        name: att.name,
                        type: att.type,
                        hasImage: true,
                        dataUrl: (savedFiles && savedFiles[idx]?.url) || att.dataUrl
                    }));
                }
            }

            if (ex.type === 'tool') {
                const toolBody = {
                    role: 'tool',
                    content: ex.tool?.content || '',
                    toolName: ex.tool?.name,
                    toolArgs: ex.tool?.args,
                    toolStatus: ex.tool?.status,
                    toolImages: ex.tool?.images || []
                };
                await backendClient.sendMessage(newChatId, toolBody).catch(err => {
                    console.warn('[Import] tool message failed:', err.message);
                });
            } else {
                if (ex.user?.content) {
                    await backendClient.sendMessage(newChatId, {
                        role: 'user',
                        content: ex.user.content,
                        attachments: savedAttachments || (ex.user.attachments || []).map(att => ({
                            name: att.name,
                            type: att.type,
                            dataUrl: att.dataUrl
                        }))
                    }).catch(err => {
                        console.warn('[Import] user message failed:', err.message);
                    });
                }

                if (ex.assistant?.isComplete && (ex.assistant.content || ex.assistant.reasoning_content || ex.assistant.tool_calls)) {
                    const metadata = {};
                    if (ex.assistant.reasoning_content) metadata.reasoning_content = ex.assistant.reasoning_content;
                    if (ex.assistant.thinking_signature) metadata.thinking_signature = ex.assistant.thinking_signature;
                    if (ex.assistant.streamStats) metadata.streamStats = ex.assistant.streamStats;
                    if (ex.assistant.usage) metadata.usage = ex.assistant.usage;
                    if (ex.assistant.context) metadata.context = ex.assistant.context;

                    await backendClient.sendMessage(newChatId, {
                        role: 'assistant',
                        content: ex.assistant.content || '',
                        model: importData.chatInfo?.model || ex.model || null,
                        ...metadata
                    }).catch(err => {
                        console.warn('[Import] assistant message failed:', err.message);
                    });
                }
            }
        }

        renderHistoryList();
        await switchChat(newChatId);

        nui.components.toast?.success?.('Chat imported successfully');

    } catch (err) {
        console.error('Failed to import chat', err);
        nui.components.dialog.alert('Import Failed', `Could not import chat: ${err.message}`);
    }
}

async function exportChatAsMarkdown(chatId) {
    // Prefer in-memory conversation (current session), fall back to storage
    const conv = activeConversations.get(chatId);
    const exchanges = conv ? conv.getAll() : await storage.loadConversation(chatId);
    console.log('[DEBUG] exportChatAsMarkdown exchanges:', exchanges?.length, 'from memory:', !!conv);
    if (!exchanges || exchanges.length === 0) {
        console.warn('[DEBUG] exportChatAsMarkdown: no exchanges found, aborting');
        return;
    }

    try {
        let md = "";

        const chatInfo = chatHistory.get(chatId);
        if (chatInfo) {
            md += `# ${chatInfo.title || 'Chat'}\n\n`;
            md += `*Model: ${chatInfo.model || 'Unknown'} | Date: ${new Date(chatInfo.timestamp).toLocaleString()}*\n\n---\n\n`;
        }

        for (const ex of exchanges) {
            md += `### User\n\n${ex.user.content}\n\n`;
            if (ex.assistant && ex.assistant.content) {
                md += `### Assistant\n\n${ex.assistant.content}\n\n`;
            }
            md += `---\n\n`;
        }

        const blob = new Blob([md], { type: 'text/markdown' });
        const url = URL.createObjectURL(blob);
        const title = chatInfo && chatInfo.title ? chatInfo.title.replace(/[^a-z0-9]/gi, '_').toLowerCase() : 'chat';
        const filename = `chat_${title}_${chatId}.md`;

        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        console.log('[DEBUG] exportChatAsMarkdown download triggered:', filename);
    } catch (e) {
        console.error("Failed to export markdown", e);
    }
}

function updateChatTitle(chatId, firstMessageContent) {
    const meta = chatHistory.conversations.find(c => c.id === chatId);
    if (meta && (meta.title === 'New Chat' || meta.title === 'Old Chat')) {
        meta.title = firstMessageContent.substring(0, 30) + (firstMessageContent.length > 30 ? '...' : '');
        meta._dirty = true;
        chatHistory._saveList();
        renderHistoryList();
    }
}

function updateChatModel(chatId, modelId) {
    const meta = chatHistory.conversations.find(c => c.id === chatId);
    if (meta && meta.model !== modelId) {
        meta.model = modelId;
        meta._dirty = true;
        chatHistory._saveList();
    }
}

function updateChatSystemPrompt(chatId, promptText) {
    const meta = chatHistory.conversations.find(c => c.id === chatId);
    if (meta && meta.systemPrompt !== promptText) {
        meta.systemPrompt = promptText;
        meta._dirty = true;
        chatHistory._saveList();
    }
}

// ============================================
// nui-list Chat Tabs (sidebar)
// ============================================
let chatTabList = null;          // nui-list element
let chatListCategories = null;   // cached category signature for filter rebuild
let chatListInitialized = false;
let chatListDataSig = null;      // structural signature of the chat list data
let chatListSortCache = null;    // cached {index, direction} sort pref

/**
 * Initialize the nui-list once. loadData() sets up the search + category filter
 * controls and the selection event that switches chats.
 */
async function initChatList() {
    if (chatListInitialized) return;
    const listEl = document.getElementById('chat-tab-list');
    if (!listEl || typeof listEl.loadData !== 'function') return;
    chatListInitialized = true;
    chatTabList = listEl;

    listEl.loadData({
        data: [],
        render: renderChatTabItem,
        search: [{ prop: 'title' }, { prop: 'searchText' }],
        sort: [
            { label: 'Date', prop: 'createdAt', numeric: true },
            { label: 'Title', prop: 'title' },
            { label: 'Messages', prop: 'messageCount', numeric: true }
        ],
        // Dropdowns span the full header width (the header is the containing
        // block) minus this right margin — set via nui-select.setPopup().
        popup: { right: 'var(--nui-space)' },
        sort_default: 0,
        sort_direction_default: 'down',
        single: true,
        events: (e) => {
            if (e.type === 'selection') {
                const chat = e.items?.[0]?.data;
                if (chat && chat.id !== currentChatId) {
                    switchChat(chat.id);
                }
            } else if (e.type === 'sort') {
                chatListSortCache = { index: e.index, direction: e.direction };
                storage.setPref('chat-list-sort', chatListSortCache).catch(() => {});
                forceChatListResort(chatTabList);
            }
        }
    });
}

/**
 * nui-list's sort() only re-applies when its column/direction memo CHANGES,
 * but filter() always rebuilds `filtered` from the unsorted clone. So a column
 * change whose memo already matches leaves the list in clone (unsorted) order.
 * Reset the memo and rebuild so the active sort actually reorders. Deferred so
 * it runs after nui-list's own change handler, and scroll is preserved.
 */
function forceChatListResort(listEl) {
    if (!listEl) return;
    setTimeout(() => {
        const vp = listEl.querySelector('.nui-list-viewport');
        const scrollTop = vp ? vp.scrollTop : 0;
        listEl.last_sort = undefined;
        listEl.last_direction = undefined;
        listEl.updateData(listEl.data);
        if (vp) vp.scrollTop = scrollTop;
    }, 0);
}

/**
 * Restore the persisted sort (index + direction) onto the freshly built header.
 * Must run AFTER updateData/initHeader, which reset currentSort to the default.
 */
async function restoreChatListSort(listEl) {
    if (!chatListSortCache) chatListSortCache = await storage.getPref('chat-list-sort');
    const saved = chatListSortCache;
    if (!saved) return;

    // Reset nui-list's sort memo BEFORE re-selecting the column. Dispatching the
    // native change runs nui-list's handler → filter(), which rebuilds `filtered`
    // from the unsorted clone. If the restored column equals the one updateData
    // already sorted by (the common case), sort() would no-op on the matching memo
    // and the list would fall back to the clone's mod-date order. Clearing the memo
    // makes the change-triggered filter() actually re-apply the sort.
    listEl.last_sort = undefined;
    listEl.last_direction = undefined;

    // Set the sort column through nui-list's own native change handler, then
    // match the direction by clicking its toggle. Going through nui-list's
    // handlers keeps currentSort/currentOrder/filtered consistent.
    const native = listEl.querySelector('.nui-list-sort > nui-select select');
    if (saved.index != null && native && native.options[saved.index]) {
        native.value = saved.index;
        native.dispatchEvent(new Event('change', { bubbles: true }));
    }

    if (saved.direction && listEl.currentOrder !== saved.direction) {
        const dirBtn = listEl.querySelector('.nui-list-sort-direction');
        if (dirBtn) dirBtn.click();
    }
}

/**
 * Build a single chat tab row. Mirrors the previous look: title (2-line clamp),
 * meta (date + msg count), pin icon, active highlight, edit action, and the
 * streaming / new-content indicators.
 */
function renderChatTabItem(chat) {
    const isActive = chat.id === currentChatId;
    const item = document.createElement('div');
    item.className = 'chat-history-item' + (isActive ? ' active' : '');
    item.dataset.chatId = chat.id;

    const titleDiv = document.createElement('div');
    titleDiv.className = 'chat-history-item-title-container';

    const topRow = document.createElement('div');
    topRow.className = 'chat-history-item-top-row';

    if (chat.pinned) {
        const pinIcon = document.createElement('nui-icon');
        pinIcon.setAttribute('name', 'star_rate');
        pinIcon.className = 'chat-history-item-pin';
        topRow.appendChild(pinIcon);
    }

    const titleSpan = document.createElement('span');
    titleSpan.className = 'chat-history-item-title';
    titleSpan.textContent = chat.title || 'New Chat';
    // summary may be an object {title, teaser, reflection} (arena schema) or a legacy string
    const summaryText = (typeof chat.summary === 'object' && chat.summary)
        ? (chat.summary.teaser || chat.summary.title || '')
        : (chat.summary || '');
    titleSpan.title = summaryText ? `${chat.title}\n\n${summaryText}` : chat.title;

    topRow.appendChild(titleSpan);
    titleDiv.appendChild(topRow);

    const metaDiv = document.createElement('div');
    metaDiv.className = 'chat-history-item-meta';

    const dateSpan = document.createElement('span');
    const dateObj = new Date(chat.createdAt || chat.updatedAt || Date.now());
    dateSpan.textContent = dateObj.toLocaleDateString(undefined, {month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'});

    const countSpan = document.createElement('span');
    countSpan.textContent = `${chat.messageCount || 0} msgs`;

    metaDiv.appendChild(dateSpan);
    metaDiv.appendChild(countSpan);
    titleDiv.appendChild(metaDiv);

    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'chat-history-item-actions';

    // Edit button only renders for the active conversation — opening it on an
    // inactive one is ambiguous. Load the conversation first, then edit.
    if (isActive) {
        const optionsBtn = document.createElement('nui-button');
        optionsBtn.className = 'chat-history-item-action';
        optionsBtn.innerHTML = '<button type="button"><nui-icon name="edit"></nui-icon></button>';
        optionsBtn.title = 'Chat Options';
        optionsBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            openChatOptions(chat.id);
        });
        actionsDiv.appendChild(optionsBtn);
    }

    item.appendChild(titleDiv);
    item.appendChild(actionsDiv);

    // Indicators derived from state (nui-list recycles elements, so these are
    // re-applied on every render rather than toggled on a persistent DOM node).
    // Active run: live view state, OR the durable server-side stamp (covers a
    // headless run with no attached view — first load shows it immediately).
    if (runnerViews.get(chat.id)?.running || chat.activeRun) item.classList.add('streaming');
    if (chatsWithNewContent.has(chat.id)) item.classList.add('new-content');

    return item;
}

/**
 * Rebuild the category filter options only when the set of categories changes.
 */
function refreshCategoryFilters(listData) {
    const cats = [...new Set(listData.map(c => c.category))];
    const sig = cats.slice().sort().join('\u0000');
    if (sig === chatListCategories) return;
    chatListCategories = sig;
    chatTabList.updateOptions({
        filters: [{
            prop: 'category',
            label: 'Category',
            options: cats.map(c => ({ value: c, label: c }))
        }]
    });
}

/**
 * Keep nui-list's selection aligned with the active chat and scroll it into view.
 */
function syncActiveChatSelection() {
    if (!chatTabList?.filtered) return;
    const idx = chatTabList.filtered.findIndex(it => it.data && it.data.id === currentChatId);
    chatTabList.setSelection(idx >= 0 ? idx : []);
}

async function renderHistoryList() {
    await initChatList();

    const allChats = chatHistory.getAll();
    const emptyEl = document.getElementById('chat-history-empty');

    if (allChats.length === 0) {
        if (emptyEl) emptyEl.hidden = false;
        if (chatTabList) chatTabList.style.display = 'none';
        return;
    }
    if (emptyEl) emptyEl.hidden = true;
    if (chatTabList) chatTabList.style.display = '';

    if (!chatTabList) {
        // nui-list not available — degrade to a plain flat list.
        const host = elements.chatHistoryList;
        if (!host) return;
        host.innerHTML = '';
        for (const chat of allChats) host.appendChild(renderChatTabItem(chat));
        return;
    }

    // Normalize category + precompute a searchable teaser on throwaway copies
    // (never mutate the underlying conversation docs).
    const listData = allChats.map(chat => {
        const summaryText = (typeof chat.summary === 'object' && chat.summary)
            ? (chat.summary.teaser || chat.summary.title || '')
            : (chat.summary || '');
        return {
            ...chat,
            category: chat.category ? chat.category.trim() : 'Uncategorized',
            searchText: summaryText
        };
    });

    refreshCategoryFilters(listData);

    // Structural signature (display fields, deliberately NOT updatedAt) so a plain
    // active-chat switch — which bumps updatedAt — doesn't rebuild the list and
    // make the scroll jump. Minor cost: "Recent" order refreshes on structural
    // changes rather than every chat touch.
    const sig = listData.map(c => `${c.id}|${c.title}|${c.category}|${c.messageCount}|${c.pinned}`).join('§');

    if (sig !== chatListDataSig) {
        chatListDataSig = sig;

        // nui-list's sort() only re-applies when the sort column/direction CHANGED,
        // but every updateData() -> filter() rebuilds `filtered` from the unsorted
        // clone. Reset the memo so the active sort re-applies on each data refresh.
        chatTabList.last_sort = undefined;
        chatTabList.last_direction = undefined;
        chatTabList.updateData(listData);

        // refreshCategoryFilters -> updateOptions -> initHeader resets
        // currentSort to the default, so re-apply the persisted sort here.
        await restoreChatListSort(chatTabList);

        // Seed itemHeight immediately. checkHeight() would otherwise correct it
        // ~300ms later, briefly rendering items at the 60px default (overlapping).
        const firstItem = chatTabList.querySelector('.nui-list-item');
        if (firstItem) {
            const cs = getComputedStyle(firstItem);
            chatTabList.itemHeight = firstItem.offsetHeight
                + (parseInt(cs.marginTop) || 0) + (parseInt(cs.marginBottom) || 0);
        }

        syncActiveChatSelection(); // scrolls the active chat into view
    } else {
        // Data unchanged (e.g. user clicked an already-visible row): only the
        // active chat changed. nui-list's update() reuses element refs without
        // re-running the render fn, so null them to force a re-render that
        // re-applies .active to the current chat (no scroll/reset — no jump).
        chatTabList.filtered.forEach(it => { it.el = null; });
        chatTabList.update(true);
    }
}

// ============================================
// Sidebar Streaming Indicators
// ============================================

/**
 * Shows a pulsing indicator on a chat in the sidebar when it's streaming in the
 * background. Streaming state is derived from client.hasActiveStream(), so this
 * just triggers a re-render of the visible rows.
 */
function markChatAsStreaming(chatId, isStreaming) {
    chatTabList?.update(true);
}

/**
 * Shows a "new content" indicator on a background chat that received a response.
 * The chatId is added to chatsWithNewContent by the caller; this re-renders so
 * the indicator appears on the (possibly recycled) row.
 */
function markChatActivity(chatId) {
    chatTabList?.update(true);
}

async function openChatOptions(chatId) {
    const chatMeta = chatHistory.conversations.find(c => c.id === chatId);
    if (!chatMeta) return;

    const template = document.getElementById('chat-options-template');
    if (!template) return;
    
    const content = template.content.cloneNode(true);

    // Stamp chatId onto the wrapper so the centralized nui-action handler can find it
    const wrapper = content.firstElementChild;
    if (wrapper) wrapper.dataset.chatId = chatId;

    // Bind initial values
    const titleInput = content.getElementById('chat-options-title-input');
    const categoryInput = content.getElementById('chat-options-category-input');
    const pinToggle = content.getElementById('chat-options-pin-toggle');
    const chunkToggle = content.getElementById('chat-options-chunk-toggle');
    const createdDateSpan = content.getElementById('chat-options-created-date');
    const updatedDateSpan = content.getElementById('chat-options-updated-date');
    const msgCountSpan = content.getElementById('chat-options-msg-count');

    if (titleInput) titleInput.value = chatMeta.title || 'New Chat';
    if (categoryInput) categoryInput.value = chatMeta.category || '';
    if (pinToggle) pinToggle.checked = !!chatMeta.pinned;
    if (chunkToggle) chunkToggle.checked = !!chatMeta.chunkTransform;
    // chat-history maps server createdAt/updatedAt (ISO strings) to epoch ms
    if (createdDateSpan) createdDateSpan.textContent = new Date(chatMeta.createdAt).toLocaleString();
    if (updatedDateSpan) updatedDateSpan.textContent = new Date(chatMeta.updatedAt).toLocaleString();

    // Button actions are handled centrally via data-action="chat-options:*" — see handleChatOptionsAction()

    // Create programmatic page dialog
    const { dialog, main } = await nui.components.dialog.page('Edit Chat Options', '', {
        contentScroll: true,
        buttons: [
            { value: 'cancel', label: 'Cancel', type: 'outline' },
            { value: 'save', label: 'Save Changes', type: 'primary' }
        ]
    });
    main.appendChild(content);
    main._dialog = dialog;  // expose for action handler (close on clone/delete)

    // Async load message count — count messages server-side (loadConversation
    // is a retired stub; the runner owns the stored messages).
    if (msgCountSpan) msgCountSpan.textContent = 'Counting...';
    backendClient.getSession(chatId).then(data => {
        if (!data || !msgCountSpan) return;
        const msgs = data.messages || [];
        msgCountSpan.textContent = msgs.length.toString();
    }).catch(() => {
        if (msgCountSpan) msgCountSpan.textContent = 'Error';
    });

    dialog.addEventListener('nui-dialog-close', (e) => {
        console.log('nui-dialog-close event emitted:', e.detail);
        const action = e.detail?.returnValue || e.detail?.value || e.detail?.id;
        
        if (action === 'cancel') {
            // dialog is already closed
        } else if (action === 'save') {
           const newTitle = titleInput?.value.trim() || '';
           const newCategory = categoryInput?.value.trim() || '';
           const newPinned = pinToggle?.checked || false;
           const newChunkTransform = chunkToggle?.checked || false;
           
           let changed = false;
           if (newTitle && chatMeta.title !== newTitle) {
               chatMeta.title = newTitle;
               changed = true;
           }
           if (chatMeta.category !== newCategory) {
               chatMeta.category = newCategory;
               changed = true;
           }
           if (chatMeta.pinned !== newPinned) {
               chatMeta.pinned = newPinned;
               changed = true;
           }
           if (!!chatMeta.chunkTransform !== newChunkTransform) {
               chatMeta.chunkTransform = newChunkTransform;
               changed = true;
               // Live-update the active conversation if it's this chat
               const conv = activeConversations.get(chatId);
               if (conv) conv.chunkTransform = newChunkTransform;
           }
           
           if (changed) {
               chatMeta._dirty = true;
               chatHistory._saveList();
               renderHistoryList();
               nui.components.toast?.success?.('Chat options saved');
               if (currentChatId === chatId) {
                 if (window.conversation) {
                    window.conversation.title = chatMeta.title;
                    window.conversation.category = chatMeta.category;
                 }
                 const titleEl = document.getElementById('current-chat-title');
                 if (titleEl) {
                    titleEl.textContent = chatMeta.title || 'New Chat';
                 }
               }
           }
        }
    });
}

function updateSendButton() {
    const btn = elements.sendBtn?.querySelector('button');
    if (btn) {
        // Authoritative run state (event-driven), not DOM element presence —
        // covers the pre-stream gap and tool-hop gaps where no bubble exists.
        const chatIsStreaming = !!runnerViews.get(currentChatId)?.running;
        btn.innerHTML = chatIsStreaming
            ? '<nui-icon name="close"></nui-icon>'
            : '<nui-icon name="send"></nui-icon>';
    }
}

function abortStream() {
    // Abort only the active chat's run (runner-owned; background chats unaffected)
    runnerClient.abort(currentChatId).catch(() => {});
}

// ============================================
// File Attachments
// ============================================

function handleFileSelect(e) {
    const files = Array.from(e.target.files || []);

    for (const file of files) {
        if (!file.type.startsWith('image/')) continue;
        
        const reader = new FileReader();
        reader.onload = (event) => {
            attachedImages.push({
                dataUrl: event.target.result,
                name: file.name,
                type: file.type
            });
            addAttachmentPreview(event.target.result, file.name);
        };
        reader.readAsDataURL(file);
    }
    
    // Clear input so same file can be selected again
    e.target.value = '';
}

// ============================================
// Vision Capability Detection
// ============================================

function currentModelSupportsVision() {
    if (!currentModel) return false;
    const modelConfig = models.find(m => m.id === currentModel);
    const supportsVision = modelConfig?.capabilities?.vision === true;
    return supportsVision;
}

function updateVisionToggleVisibility() {
    const visionToggle = document.getElementById('vision-toggle-container');
    if (!visionToggle) return;
    
    const hasImages = attachedImages.length > 0;
    const visionToolsAvailable = areVisionToolsAvailable();
    const modelSupportsVision = currentModelSupportsVision();
    
    // Show toggle when:
    // - Images are attached AND
    // - Either vision tools are available OR model supports vision
    if (hasImages) {
        if (visionToolsAvailable || modelSupportsVision) {
            visionToggle.style.display = 'flex';
            
            const checkbox = visionToggle.querySelector('nui-checkbox');
            const input = visionToggle.querySelector('input');
            
            if (visionToolsAvailable && modelSupportsVision) {
                // Both available - user can choose
                input.disabled = false;
                checkbox.title = 'OFF: Send images directly to model | ON: Use MCP vision tools to pre-analyze images';
            } else if (modelSupportsVision) {
                // Only model supports vision - disable MCP vision (force OFF)
                input.disabled = true;
                input.checked = false;
                useVisionAnalysis = false;
                checkbox.title = 'Model supports vision - images will be sent directly';
            } else if (visionToolsAvailable) {
                // Only MCP vision available - force ON (model can't process images directly)
                input.disabled = true;
                input.checked = true;
                useVisionAnalysis = true;
                checkbox.title = 'Model does not support vision - MCP vision tools will analyze images';
            }
            
            // Update mode indicator
            updateVisionModeIndicator();
        } else {
            // No vision support at all
            visionToggle.style.display = 'none';
        }
    } else {
        visionToggle.style.display = 'none';
    }
}

function addAttachmentPreview(dataUrl, name) {
    const item = document.createElement('div');
    item.className = 'attachment-item';
    item.title = name;
    item.innerHTML = `
        <img src="${dataUrl}" alt="${name}">
        <button class="remove" title="Remove">&times;</button>
    `;
    
    // Remove button
    item.querySelector('.remove').addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = attachedImages.findIndex(img => img.dataUrl === dataUrl);
        if (idx > -1) attachedImages.splice(idx, 1);
        item.remove();
        updateVisionToggleVisibility();
    });
    
    // Lightbox click - open full image
    item.addEventListener('click', () => {
        if (nui.components?.lightbox) {
            nui.components.lightbox.show([{ src: dataUrl, title: name }], 0);
        }
    });
    
    elements.attachmentPreview?.appendChild(item);
    updateVisionToggleVisibility();
}

function clearAttachments() {
    attachedImages = [];
    useVisionAnalysis = false;
    if (elements.attachmentPreview) {
        elements.attachmentPreview.innerHTML = '';
    }
    updateVisionToggleVisibility();
}

// ============================================
// Theme Toggle
// ============================================

async function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme') || 'light';
    const next = current === 'dark' ? 'light' : 'dark';
    await setTheme(next);
}

async function setTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    await storage.setPref('theme', theme);

    // Also sync with NUI if available
    if (window.nui?.setTheme) {
        window.nui.setTheme(theme);
    }

    // Update color-scheme for native form elements
    document.documentElement.style.colorScheme = theme;
}

// ============================================
// Lightbox
// ============================================

function openLightbox(src) {
    elements.lightboxImage.src = src;
    elements.lightbox.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
}

function closeLightbox() {
    elements.lightbox.setAttribute('aria-hidden', 'true');
    elements.lightboxImage.src = '';
    document.body.style.overflow = '';
}

window.openLightbox = openLightbox;

// ============================================
// Timestamp Parsing
// ============================================

const TIMESTAMP_REGEX = /^\[(\d{4})-(\d{2})-(\d{2})@(\d{2}):(\d{2})\]\s*/;
const TIMESTAMP_REGEX_GLOBAL = /\[\d{4}-\d{2}-\d{2}@\d{2}:\d{2}\]\s*/g;

function parseTimestamp(content) {
    if (!content) return { timestamp: null, cleanContent: content };
    const match = content.match(TIMESTAMP_REGEX);
    if (match) {
        const [, year, month, day, hour, minute] = match;
        return {
            timestamp: `${year}-${month}-${day} @ ${hour}:${minute}`,
            cleanContent: content.replace(TIMESTAMP_REGEX, '')
        };
    }
    return { timestamp: null, cleanContent: content };
}

function stripExtraTimestamps(content) {
    // Keep the first timestamp (ours), remove any subsequent ones the LLM generates
    let first = true;
    return content.replace(TIMESTAMP_REGEX_GLOBAL, (match) => {
        if (first) {
            first = false;
            return match; // Keep first timestamp
        }
        return ''; // Remove subsequent timestamps
    });
}

// ============================================
// Utilities
// ============================================

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ============================================
// Base64 Sanitization for Display
// ============================================

/**
 * Detects if a string is base64-encoded data (typically images or binary)
 * Uses fast heuristics to avoid expensive regex on large strings
 */
function isBase64Data(str) {
    if (typeof str !== 'string' || str.length < 100) return false;
    
    // Fast path: check length first (base64 images are typically >1KB)
    if (str.length < 1000) return false;
    
    // Check for common image signatures (first few chars)
    const start = str.substring(0, 20);
    if (start.startsWith('/9j/') ||           // JPEG
        start.startsWith('iVBOR') ||          // PNG  
        start.startsWith('R0lGOD') ||         // GIF
        start.startsWith('UEsDB') ||          // Binary/Zip
        start.startsWith('JVBERi0') ||        // PDF
        start.startsWith('Qk')) {             // BMP
        return true;
    }
    
    // Fallback: check if it looks like base64 (long alphanumeric + /+)
    // Only check first 100 chars for performance
    const sample = str.substring(0, 100);
    return /^[A-Za-z0-9+/]{100}/.test(sample);
}

/**
 * Sanitizes an object for display by replacing base64 data with placeholders
 * Recursively processes nested objects and arrays
 * @param {*} value - Value to sanitize
 * @returns {*} Sanitized value safe for JSON.stringify
 */
function sanitizeForDisplay(value) {
    if (value === null || value === undefined) return value;
    
    if (typeof value === 'string') {
        if (isBase64Data(value)) {
            return `[BASE64_DATA](${value.length} chars)`;
        }
        return value;
    }
    
    if (Array.isArray(value)) {
        return value.map(item => sanitizeForDisplay(item));
    }
    
    if (typeof value === 'object') {
        const sanitized = {};
        for (const [key, val] of Object.entries(value)) {
            sanitized[key] = sanitizeForDisplay(val);
        }
        return sanitized;
    }
    
    return value;
}

/**
 * Safe JSON.stringify that sanitizes base64 data first
 * Use this for UI display to avoid freezing on large base64 strings
 */
function jsonStringifyForDisplay(obj, space = 2) {
    const sanitized = sanitizeForDisplay(obj);
    return JSON.stringify(sanitized, null, space);
}

// Compact one-line summary of a tool error for the collapsed bubble header.
// Tool error content (esp. browser_fetch) can embed hundreds of lines of
// diagnostic JSON meant for the MODEL, not the screen. The full text stays in
// the collapsed payload and in the message sent to the model — only the UI
// surface is compacted. First line, truncated, with a "details" hint.
function toolErrorSummary(content) {
    if (typeof content !== 'string' || content.length === 0) return 'Tool failed';
    const firstLine = content.split('\n')[0].trim();
    const MAX = 160;
    return firstLine.length > MAX ? firstLine.substring(0, MAX) + '…' : firstLine;
}

function scrollToBottom(container = null) {
    // Default to the visible chat; pass an explicit container for background
    // streams so they scroll their own (hidden) container instead of the
    // foreground chat's. Hidden containers accept scrollTop writes fine —
    // scroll position persists and is honored when the chat becomes visible.
    const target = container || getActiveContainer();
    if (target) {
        target.scrollTop = target.scrollHeight;
        _vsUpdateVisible(target);
    }
}

function isNearBottom(threshold = 100, container = null) {
    const target = container || getActiveContainer();
    if (!target) return true;
    const { scrollTop, scrollHeight, clientHeight } = target;
    return scrollHeight - scrollTop - clientHeight < threshold;
}

function setupDialogEventListeners() {
    // Dialog event listeners are bound inline in openChatOptions(), openMCPEditDialog(), etc.
    // No static DOM elements to bind here — all dialogs are created programmatically via nui.components.dialog.page()
}

// ============================================
// Centralized data-action handler for chat-options buttons
// Buttons use data-action="chat-options:<action>" on inner <button> elements.
// The chatId is carried via data-chat-id on the wrapper div.
// ============================================

document.addEventListener('nui-action', (e) => {
    const { name, param } = e.detail;
    if (name !== 'chat-options') return;

    const wrapper = e.target.closest('[data-chat-id]');
    const chatId = wrapper?.dataset.chatId;
    if (!chatId) {
        console.warn('[chat-options] nui-action fired but no data-chat-id found on parent');
        return;
    }

    console.log('[chat-options] action:', param, 'chatId:', chatId);

    switch (param) {
        case 'copy-json':
            exportChatAsJson(chatId, e.target);
            break;
        case 'save-json':
            exportChatToFile(chatId);
            break;
        case 'save-md':
            exportChatAsMarkdown(chatId);
            break;
        case 'clone':
            handleChatOptionsClone(chatId, wrapper);
            break;
        case 'delete':
            handleChatOptionsDelete(chatId, wrapper);
            break;
        default:
            console.warn('[chat-options] unknown action:', param);
    }
});

async function handleChatOptionsClone(chatId, wrapper) {
    const exchanges = await storage.loadConversation(chatId);
    if (!exchanges) return;
    const chatMeta = chatHistory.conversations.find(c => c.id === chatId);
    if (!chatMeta) return;

    const newId = chatHistory._generateId();
    const cloneMeta = {
        ...chatMeta,
        id: newId,
        title: `Copy of ${chatMeta.title || 'Chat'}`,
        timestamp: Date.now(),
        updatedAt: Date.now()
    };
    chatHistory.conversations.unshift(cloneMeta);
    chatHistory._saveList();
    await storage.saveConversation(newId, exchanges);
    renderHistoryList();

    // Close the dialog that contains this button
    const dialogEl = wrapper.closest('dialog');
    if (dialogEl) dialogEl.close();

    await switchChat(newId);
    nui.components.toast?.success?.('Chat cloned successfully');
}

async function handleChatOptionsDelete(chatId, wrapper) {
    // Close dialog first
    const dialogEl = wrapper.closest('dialog');
    if (dialogEl) dialogEl.close();

    deleteChat(chatId);
}

// ============================================
// Start
// ============================================

// Admin UI
async function showAdminUI() {
    let users = await backendClient.adminGetUsers();

    const renderTable = () => `
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem;">
            <h3 style="margin: 0; font-size: 1.1rem; color: var(--text-color);">Registered Users</h3>
            <nui-button variant="primary" data-action="edit-user">
                <button type="button">Add User</button>
            </nui-button>
        </div>
        <div style="border: 1px solid var(--border-shade1); border-radius: var(--border-radius1, 6px); overflow: hidden; margin-bottom: 2rem;">
            <table style="width: 100%; border-collapse: collapse; text-align: left;">
                <thead style="background: var(--color-shade1);">
                    <tr style="border-bottom: 1px solid var(--border-shade2);">
                        <th style="padding: 0.75rem 1rem; color: var(--text-color-dim); font-weight: normal; font-size: 0.85em; text-transform: uppercase; letter-spacing: 0.05em;">Username</th>
                        <th style="padding: 0.75rem 1rem; color: var(--text-color-dim); font-weight: normal; font-size: 0.85em; text-transform: uppercase; letter-spacing: 0.05em;">Display Name</th>
                        <th style="padding: 0.75rem 1rem; color: var(--text-color-dim); font-weight: normal; font-size: 0.85em; text-transform: uppercase; letter-spacing: 0.05em;">Rights</th>
                        <th style="padding: 0.75rem 1rem; color: var(--text-color-dim); font-weight: normal; font-size: 0.85em; text-transform: uppercase; letter-spacing: 0.05em; text-align: center;">Actions</th>
                    </tr>
                </thead>
                <tbody>
                    ${users.map((u, i) => `
                        <tr style="border-bottom: ${i === users.length - 1 ? 'none' : '1px solid var(--border-shade1)'};">
                            <td style="padding: 1rem;"><strong style="color: var(--text-color);">${u.username}</strong></td>
                            <td style="padding: 1rem; color: var(--text-color-dim);">${u.displayName || '-'}</td>
                            <td style="padding: 1rem;">
                                <div style="display: flex; gap: 0.35rem; flex-wrap: wrap;">
                                    ${Object.keys(u.rights).filter(k => u.rights[k]).map(right => 
                                        `<span style="background: var(--border-shade1); padding: 0.2rem 0.5rem; border-radius: 4px; font-size: 0.8em; color: var(--text-color-dim);">${right}</span>`
                                    ).join('') || '<span style="color: var(--text-color-dim); font-style: italic;">none</span>'}
                                </div>
                            </td>
                            <td style="padding: 1rem;">
                                <div style="display: flex; gap: 0.5rem; justify-content: center;">
                                    <nui-button variant="outline" size="small" data-action="edit-user" data-id="${u.id}">
                                        <button type="button">Edit</button>
                                    </nui-button>
                                    <nui-button variant="danger" size="small" data-action="delete-user" data-id="${u.id}" ${u.id === backendClient.user?.userId ? 'disabled' : ''}>
                                        <button type="button">Delete</button>
                                    </nui-button>
                                </div>
                            </td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        </div>
    `;

    const { dialog, main } = await nui.components.dialog.page('User Management', '', {
        contentScroll: true,
        buttons: [ { label: 'Close', type: 'outline', value: 'close' } ]
    });
    main.innerHTML = `<div id="admin-users-container" style="padding: 1rem;">${renderTable()}</div>`;

    const refreshTable = async () => {
        users = await backendClient.adminGetUsers();
        if (main.querySelector('#admin-users-container')) {
            main.querySelector('#admin-users-container').innerHTML = renderTable();
        }
        attachListeners();
    };

    const attachListeners = () => {
        main.querySelectorAll('[data-action="delete-user"]').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const id = e.currentTarget.dataset.id;
                if (!id) return;
                const confirm = await nui.components.dialog.confirm('Delete User', 'Are you sure? This cannot be undone.');
                if (confirm) {
                    try {
                        await backendClient.adminDeleteUser(id);
                        nui.components.toast?.success?.('User deleted');
                        await refreshTable();
                    } catch (err) {
                        nui.components.dialog.alert('Error', err.message);
                    }
                }
            });
        });

        main.querySelectorAll('[data-action="edit-user"]').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const id = e.currentTarget.dataset.id;
                const isEdit = !!id;
                const targetUser = isEdit ? users.find(u => u.id === id) : null;
                
                const formHtml = `
                <div style="padding: 1rem;">
                    <form id="admin-user-editor-${id || 'new'}" style="display: grid; gap: 1rem; max-width: 400px; margin: auto;">
                        <nui-input-group>
                            <label>Username</label>
                            <nui-input><input type="text" name="username" ${isEdit ? 'disabled' : 'required'} value="${isEdit ? targetUser.username : ''}"></nui-input>
                        </nui-input-group>
                        <nui-input-group>
                            <label>${isEdit ? 'New Password (blank to keep)' : 'Password'}</label>
                            <nui-input><input type="password" name="password" ${!isEdit ? 'required' : ''}></nui-input>
                        </nui-input-group>
                        <nui-input-group>
                            <label>Display Name</label>
                            <nui-input><input type="text" name="displayName" value="${isEdit ? targetUser.displayName : ''}"></nui-input>
                        </nui-input-group>
                        <nui-input-group>
                            <label>DB Path (e.g. server/data/my_db)</label>
                            <nui-input><input type="text" name="dbPath" required value="${isEdit ? targetUser.dbPath : ''}"></nui-input>
                        </nui-input-group>
                        <nui-input-group>
                            <label>Rights</label>
                            <div style="display: flex; gap: 1rem; margin-top: 0.25rem;">
                                <nui-checkbox>
                                    <input type="checkbox" name="right_login" ${(!isEdit || targetUser.rights?.login) ? 'checked' : ''}> Login
                                </nui-checkbox>
                                <nui-checkbox>
                                    <input type="checkbox" name="right_admin" ${(isEdit && targetUser.rights?.admin) ? 'checked' : ''}> Admin
                                </nui-checkbox>
                            </div>
                        </nui-input-group>
                        <nui-button variant="primary" style="margin-top: 1rem;">
                            <button type="submit">${isEdit ? 'Update User' : 'Create User'}</button>
                        </nui-button>
                    </form>
                </div>
                `;

                const subDialog = await nui.components.dialog.page(isEdit ? 'Edit User' : 'Add User', '', {
                    contentScroll: true,
                    buttons: [ { label: 'Cancel', type: 'outline', value: 'cancel' } ]
                });
                subDialog.main.innerHTML = formHtml;

                const form = subDialog.main.querySelector('form');
                form.addEventListener('submit', async (e) => {
                    e.preventDefault();
                    const fd = new FormData(form);
                    const payload = {
                        displayName: fd.get('displayName'),
                        dbPath: fd.get('dbPath'),
                        rights: {
                            login: fd.get('right_login') === 'on',
                            read: true,
                            write: true,
                            admin: fd.get('right_admin') === 'on'
                        }
                    };
                    const pwd = fd.get('password');
                    if (pwd) payload.password = pwd;

                    try {
                        if (isEdit) {
                            await backendClient.adminUpdateUser(id, payload);
                            nui.components.toast?.success?.('User updated');
                        } else {
                            payload.username = fd.get('username');
                            await backendClient.adminCreateUser(payload);
                            nui.components.toast?.success?.('User created');
                        }
                        
                        // Close sub-dialog
                        const cancelBtn = subDialog.dialog.querySelector('button[value="cancel"]');
                        if (cancelBtn) cancelBtn.click();
                        
                        await refreshTable();
                    } catch (err) {
                        nui.components.dialog.alert('Error', err.message);
                    }
                });
            });
        });
    };

    attachListeners();
}

init();























