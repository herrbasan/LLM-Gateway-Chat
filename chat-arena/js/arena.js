// ============================================
// Chat Arena - Main Arena Orchestrator
// ============================================

// Reuse existing utilities (import only, no modifications)
import { GatewayClient } from '../../chat/js/client-sdk.js';
import { backendClient } from '../../chat/js/api-client.js';
import { renderMarkdown, parseThinking } from '../../chat/js/markdown.js';
import { getPlainText } from '../../chat/js/tts-utils.js';
import { arenaStorage } from './storage.js';
import { storage } from '../../chat/js/storage.js';
import { NSpeechController } from '../../lib/tts/nspeech-controller.js';
import { TtsPlayerHost } from '../../lib/tts/tts-player.js';

// ============================================
// Helpers
// ============================================

function _getGatewayApiKey() {
    return localStorage.getItem('gateway-api-key') || '';
}

function _createGatewayClient(url) {
    return new GatewayClient({ baseUrl: url, accessKey: _getGatewayApiKey() });
}

function _formatArenaTime(date) {
    const pad = (n) => n.toString().padStart(2, '0');
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function _stripIdentityPrefix(content) {
    return content.replace(/\[[\w.-]+ Â· \d{2}:\d{2}:\d{2}\]:\s*/g, '').trim();
}

// ============================================
// Participant Class
// ============================================

class Participant {
    constructor(options = {}) {
        this.name = options.name || 'Unknown';
        this.modelName = options.modelName || '';
        this.gatewayUrl = options.gatewayUrl || localStorage.getItem('gateway-url') || window.ARENA_CONFIG?.gatewayUrl || '';
        this.gatewayApiKey = options.gatewayApiKey || _getGatewayApiKey();
        this.systemPrompt = options.systemPrompt || null;
        this.temperature = options.temperature !== undefined ? options.temperature : (window.ARENA_CONFIG?.defaultTemperature ?? 0.7);
        this.reasoningEffort = options.reasoningEffort || null;
        this.onProgress = options.onProgress || null;

        this.client = new GatewayClient({
            baseUrl: this.gatewayUrl,
            accessKey: this.gatewayApiKey,
            sessionId: options.sessionId
        });
        this.responseAccumulator = '';
        this.reasoningAccumulator = '';
        this.thinkingSignature = null;
        this.isStreaming = false;
        this._responseStartTime = null;
        this._firstDeltaTime = null;
        this._resolveResponse = null;
        this._rejectResponse = null;
    }

    setSystemPrompt(prompt) {
        this.systemPrompt = prompt;
    }

    async connect() {
        await this.client.connect();
    }

    async respond(conversationHistory) {
        this.responseAccumulator = '';
        this.reasoningAccumulator = '';
        this.thinkingSignature = null;
        this._responseStartTime = Date.now();
        this._firstDeltaTime = null;
        this.isStreaming = true;

        const messages = this._buildMessages(conversationHistory);

        return new Promise((resolve, reject) => {
            this._resolveResponse = resolve;
            this._rejectResponse = reject;

            this._startStreaming(messages);
        });
    }

    async _startStreaming(messages) {
        try {
            const params = {
                model: this.modelName,
                messages: messages,
                stream: true,
                temperature: this.temperature,
                tools: [],  // Explicit: no tool use in arena
                extra_body: {
                    chat_template_kwargs: {
                        enable_thinking: !!this.reasoningEffort
                    }
                }
            };
            if (this.reasoningEffort) {
                params.reasoning_effort = this.reasoningEffort;
            }
            const stream = this.client.chatStream(params);

            let hasReceivedDelta = false;

            stream.on('delta', (data) => {
                if (!hasReceivedDelta) {
                    hasReceivedDelta = true;
                    this._firstDeltaTime = Date.now();
                    if (this.onProgress) this.onProgress('generating', { speaker: this.name });
                }

                const delta = data?.choices?.[0]?.delta;
                const content = delta?.content;
                if (content != null && typeof content === 'string') {
                    this.responseAccumulator += content;
                }
                if (delta?.reasoning_content !== undefined) {
                    this.reasoningAccumulator += delta.reasoning_content || '';
                }
            });

            stream.on('progress', (data) => {
                // Log full progress data for analysis
                console.log(`[Arena] Conversation progress [${this.name}]:`, data);
                
                // Some models send content via progress event
                const content = data?.choices?.[0]?.delta?.content || data?.content;
                if (content != null && typeof content === 'string') {
                    this.responseAccumulator += content;
                }
                
                // Forward progress phase to callback (routing, model_routed, context_stats, etc.)
                if (data?.phase && this.onProgress) {
                    this.onProgress(data.phase, data);
                }
            });

            stream.on('done', (data) => {
                this.isStreaming = false;

                let content = this.responseAccumulator;
                if (!content && data?.content) {
                    content = data.content;
                }

                let reasoning_content = this.reasoningAccumulator;
                if (!reasoning_content && data?.reasoning_content) {
                    reasoning_content = data.reasoning_content;
                } else if (!reasoning_content && data?.choices?.[0]?.delta?.reasoning_content) {
                    reasoning_content = data.choices[0].delta.reasoning_content;
                }

                const thinking_signature = data?._thinking_signature
                    ?? data?.thinking_signature
                    ?? data?.choices?.[0]?.delta?.thinking_signature
                    ?? this.thinkingSignature
                    ?? null;

                const responseEndTime = Date.now();
                const streamStats = {
                    ttft: this._firstDeltaTime && this._responseStartTime
                        ? this._firstDeltaTime - this._responseStartTime
                        : null,
                    durationSecs: this._responseStartTime
                        ? (responseEndTime - this._responseStartTime) / 1000
                        : null
                };

                if (this._resolveResponse) {
                    this._resolveResponse({
                        content: content,
                        usage: data?.telemetry?.usage ?? data?.usage ?? null,
                        context: data?.context ?? null,
                        reasoning_content: reasoning_content || null,
                        thinking_signature: thinking_signature || null,
                        streamStats
                    });
                }
                this._cleanup();
            });

            stream.on('error', (err) => {
                console.error('[Arena] Stream error for', this.modelName, ':', err.message);
                this.isStreaming = false;
                if (this._rejectResponse) {
                    this._rejectResponse(err);
                }
                this._cleanup();
            });
        } catch (err) {
            this.isStreaming = false;
            if (this._rejectResponse) {
                this._rejectResponse(err);
            }
            this._cleanup();
        }
    }

    _buildMessages(conversationHistory) {
        const messages = [];
        const showIdentities = window.ARENA_CONFIG?.showIdentities !== false;

        // System prompt only if role-play mode is active (custom prompt was set)
        if (this.systemPrompt) {
            messages.push({ role: 'system', content: this.systemPrompt });
        }

        // Moderator topic as system message for context
        const topicMsg = conversationHistory.find(m => m.role === 'system' && m.speaker === 'moderator');
        if (topicMsg) {
            messages.push({ role: 'system', content: topicMsg.content });
        }

        let userMsgCount = 0;
        for (const msg of conversationHistory) {
            // Skip the topic message â€” already added as system above
            if (msg === topicMsg) continue;

            // Moderator messages (user prompts) become user messages
            if (msg.speaker === 'moderator' && msg.content?.trim()) {
                messages.push({ role: 'user', content: msg.content.trim() });
                continue;
            }

            // Skip non-assistant messages from participants (e.g. streaming placeholders)
            if (msg.role !== 'assistant') continue;
            if (!msg.content || !msg.content.trim()) continue;

            if (showIdentities) {
                const timeStr = msg.createdAt ? _formatArenaTime(new Date(msg.createdAt)) : '';
                const timePart = timeStr ? ` Â· ${timeStr}` : '';
                const prefix = `[${msg.speaker}${timePart}]:\n`;

                if (msg.speaker === this.name) {
                    // Own message â€” include as assistant so the model sees its own output
                    messages.push({
                        role: 'assistant',
                        content: prefix + msg.content,
                        name: this.name
                    });
                } else {
                    // Other participant â€” user role with identity marker
                    messages.push({
                        role: 'user',
                        content: prefix + msg.content,
                        name: msg.speaker
                    });
                    userMsgCount++;
                }
            } else {
                // Blind mode: no identity markers, skip own messages
                if (msg.speaker !== this.name) {
                    messages.push({ role: 'user', content: msg.content });
                    userMsgCount++;
                }
            }
        }

        // CRITICAL: Ensure at least one 'user' role message exists
        const hasUserMessage = messages.some(m => m.role === 'user');
        if (!hasUserMessage && topicMsg) {
            const topicText = topicMsg.content.replace(/^Topic:\s*/i, '').trim();
            if (topicText) {
                const systemMsgCount = messages.filter(m => m.role === 'system').length;
                messages.splice(systemMsgCount, 0, { role: 'user', content: topicText });
            }
        }

        return messages;
    }

    _cleanup() {
        this._resolveResponse = null;
        this._rejectResponse = null;
    }

    cancel() {
        if (this.isStreaming) {
            this.client.abortCurrentIterableStream?.();
            this.isStreaming = false;
            this._cleanup();
        }
    }

    close() {
        this.cancel();
        this.client.close();
    }
}

// ============================================
// Arena Class
// ============================================

class Arena {
    constructor(options = {}) {
        this.id = options.id || this._generateId();
        this.sessionId = options.sessionId || `arena-${this.id}-sess`;
        this.gatewayUrl = options.gatewayUrl || localStorage.getItem('gateway-url') || window.ARENA_CONFIG?.gatewayUrl || '';
        this.gatewayApiKey = options.gatewayApiKey || _getGatewayApiKey();
        this.maxTurns = options.maxTurns || window.ARENA_CONFIG?.defaultMaxTurns || 10;
        this.autoAdvance = options.autoAdvance !== undefined ? options.autoAdvance : true;
        this.targetTokens = options.targetTokens || null; // Token target for hint (not enforced as hard limit)
        this.temperature = options.temperature !== undefined ? options.temperature : (window.ARENA_CONFIG?.defaultTemperature ?? 0.7);
        this.reasoningEffort = options.reasoningEffort || null;

        this.participantA = null;
        this.participantB = null;
        this.startingParticipant = null;

        this.messages = [];
        this.currentTurn = 0;
        this.activeSpeaker = null;
        this.isRunning = false;
        this.isPaused = false;
        this.createdAt = options.createdAt || Date.now();
        this.updatedAt = options.updatedAt || this.createdAt;

        this.onMessage = options.onMessage || (() => {});
        this.onStatusChange = options.onStatusChange || (() => {});
        this.onError = options.onError || (() => {});
        this.onMaxTurnsReached = options.onMaxTurnsReached || (() => {});
        this.onSave = options.onSave || (() => {});
        this.onContextUpdate = options.onContextUpdate || (() => {});
        this.onProgress = options.onProgress || (() => {});
        this.onMessagePersisted = options.onMessagePersisted || (() => {});

        // Context tracking for both participants
        this.contextUsage = {
            participantA: { used_tokens: 0, window_size: null },
            participantB: { used_tokens: 0, window_size: null }
        };

        // Summary metadata
        this.summary = null;

        // Has this arena been persisted to the backend at least once?
        // Set to true after the first createSession, or when loaded from storage.
        this._persisted = false;
    }

    setMaxTokens(participant, maxTokens) {
        // Deprecated: maxTokens is now targetTokens (hint only, not enforced)
        // This method kept for backwards compatibility but does nothing
    }

    _generateId() {
        return `arena-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }

    async _saveToStorage() {
        if (this._saving) return;
        this._saving = true;

        try {
            const sessionData = this.exportJSON();
            const backend = this._getBackendClient();

            if (!this._persisted) {
                // First save: create the backend session, get the real ID.
                // Mirror the chat's pattern (chat-history.js#create): reassign
                // this.id to the server's ID so there's only ever one ID per record.
                const createdId = await arenaStorage.saveSession(this.id, sessionData);
                if (createdId && createdId !== this.id) {
                    this.id = createdId;
                    this.sessionId = createdId;
                }
                this._persisted = true;
            }

            // Sync new messages to backend for realtime embedding
            if (backend) {
                const syncedCount = this._lastSyncedCount || 0;
                const newMessages = sessionData.messages.slice(syncedCount);
                let contiguousSuccess = syncedCount;
                for (let mi = 0; mi < newMessages.length; mi++) {
                    const msg = newMessages[mi];
                    const metadata = {};
                    if (msg.reasoning_content) metadata.reasoning_content = msg.reasoning_content;
                    if (msg.thinking_signature) metadata.thinking_signature = msg.thinking_signature;
                    if (msg.streamStats) metadata.streamStats = msg.streamStats;
                    if (msg.usage) metadata.usage = msg.usage;
                    if (msg.context) metadata.context = msg.context;
                    if (msg.id) metadata.messageId = msg.id;

                    try {
                        const persisted = await backend.sendMessage(this.id, {
                            role: msg.role || 'assistant',
                            content: msg.content || '',
                            speaker: msg.speaker || (msg.role === 'system' ? 'moderator' : ''),
                            model: msg.model || (msg.speaker === this.participantA?.name
                                ? this.participantA?.modelName
                                : this.participantB?.modelName) || null,
                            ...metadata
                        });
                        // Update the in-memory message entry with the backend-assigned ID
                        const msgIdx = syncedCount + mi;
                        if (this.messages[msgIdx]) {
                            this.messages[msgIdx].id = persisted.id;
                            this.messages[msgIdx].embedStatus = persisted.embedStatus || 'pending';
                            this.onMessagePersisted(this.messages[msgIdx]);
                        }
                        contiguousSuccess = syncedCount + mi + 1;
                    } catch (e) {
                        // Stop contiguous sync on first failure — retry next _saveToStorage
                        break;
                    }
                }
                this._lastSyncedCount = contiguousSuccess;
            }

            // Metadata (title, category, pinned, summary) is persisted through
            // ArenaUI._saveHistory when the dialog saves, and through the new
            // session create path. _saveToStorage only handles messages.
            await this._updateHistory(sessionData, this.id);
            this.onSave();
        } catch (err) {
            console.error('Failed to save arena session:', err);
        } finally {
            this._saving = false;
        }
    }

    _getBackendClient() {
        const config = window.CHAT_CONFIG || {};
        if (config.enableBackend) {
            return backendClient;
        }
        return null;
    }

    async _updateHistory(sessionData, effectiveId) {
        try {
            const history = await arenaStorage.loadHistory();
            const existingIndex = history.findIndex(h => h.id === (effectiveId || this.id));

            const entry = {
                id: effectiveId || this.id,
                sessionId: this.sessionId,
                topic: sessionData.topic,
                title: sessionData.summary?.title || '',
                participants: sessionData.participants,
                messageCount: sessionData.messages.length,
                updatedAt: new Date().toISOString()
            };

            if (existingIndex >= 0) {
                history[existingIndex] = entry;
            } else {
                history.unshift(entry);
            }

            if (history.length > 50) {
                history.pop();
            }

            await arenaStorage.saveHistory(history);
        } catch (err) {
            console.error('Failed to update arena history:', err);
        }
    }

    setParticipants(participantAConfig, participantBConfig) {
        // Store configs for reference
        this.participantAConfig = participantAConfig;
        this.participantBConfig = participantBConfig;
        
        // Each participant needs a unique session ID to avoid cache collisions
        const baseSessionId = this.sessionId;
        const sessionIdA = `${baseSessionId}-A`;
        const sessionIdB = `${baseSessionId}-B`;
        
        // Each participant gets unique session ID to avoid backend cache collisions
        
        this.participantA = new Participant({
            name: participantAConfig.name || participantAConfig.modelName || 'Model A',
            modelName: participantAConfig.modelName,
            gatewayUrl: this.gatewayUrl,
            systemPrompt: participantAConfig.systemPrompt,
            temperature: participantAConfig.temperature,
            reasoningEffort: participantAConfig.reasoningEffort,
            sessionId: sessionIdA,
            onProgress: (phase, data) => this._onParticipantProgress('A', phase, data)
        });

        this.participantB = new Participant({
            name: participantBConfig.name || participantBConfig.modelName || 'Model B',
            modelName: participantBConfig.modelName,
            gatewayUrl: this.gatewayUrl,
            systemPrompt: participantBConfig.systemPrompt,
            temperature: participantBConfig.temperature,
            reasoningEffort: participantBConfig.reasoningEffort,
            sessionId: sessionIdB,
            onProgress: (phase, data) => this._onParticipantProgress('B', phase, data)
        });
    }

    setTopic(topic, targetTokens = null) {
        // Use arena-level targetTokens if not provided
        const tokensToUse = targetTokens !== null ? targetTokens : this.targetTokens;
        
        // Add token budget hint if targetTokens is set
        let topicContent = `Topic: ${topic}`;
        if (tokensToUse && tokensToUse >= 1) {
            topicContent += `\n\n[Response length: Aim for approximately ${tokensToUse} tokens. Be concise but complete.]`;
        }
        
        this.messages = [{
            role: 'system',
            speaker: 'moderator',
            content: topicContent,
            createdAt: Date.now()
        }];
        // Auto-save initial topic
        this._saveToStorage();
    }

    async start() {
        if (!this.participantA || !this.participantB) {
            this.onError('Participants not configured');
            return;
        }

        this.isRunning = true;
        this.isPaused = false;
        this.currentTurn = 0;

        this.startingParticipant = Math.random() < 0.5 ? this.participantA : this.participantB;
        this.activeSpeaker = this.startingParticipant;

        try {
            await Promise.all([
                this.participantA.connect(),
                this.participantB.connect()
            ]);
        } catch (err) {
            this.onError(`Connection failed: ${err.message}`);
            this.stop();
            return;
        }

        this.onStatusChange({ isRunning: true, activeSpeaker: this.activeSpeaker.name, turn: this.currentTurn });

        await this._triggerResponse();
    }

    async _triggerResponse() {
        if (!this.isRunning || this.isPaused) return;
        if (this.currentTurn >= this.maxTurns) {
            // Notify UI to show extend option
            this.onMaxTurnsReached(this.maxTurns);
            this.stop();
            return;
        }

        const speaker = this.activeSpeaker;
        const otherParticipant = speaker === this.participantA ? this.participantB : this.participantA;

        const history = this.messages.filter(m => !m.isStreaming);

        const topic = this.messages[0]?.content.replace('Topic: ', '') || '';

        // Only set system prompt if role-play mode is active (custom prompt was set)
        // Template substitution only on first turn
        if (speaker.systemPrompt && this.messages.length === 1) {
            const effectivePrompt = speaker.systemPrompt
                .replace('{modelName}', speaker.modelName)
                .replace('{otherParticipantName}', otherParticipant.name)
                .replace('{otherModelName}', otherParticipant.modelName)
                .replace('{topic}', topic);
            speaker.setSystemPrompt(effectivePrompt);
        }

        try {
            this.onStatusChange({ isRunning: true, activeSpeaker: speaker.name, turn: this.currentTurn, isStreaming: true });

            const response = await speaker.respond(history);

            // Update context tracking
            this._updateContextUsage(speaker, response.context, response.usage);

            // Strip thinking blocks and identity prefixes from content before storing
            const parsed = parseThinking(response.content || '');
            const rawContent = parsed.answer?.trim() || '';
            const cleanContent = _stripIdentityPrefix(rawContent);

            // Skip empty responses - don't store or advance
            if (!cleanContent) {
                this.onStatusChange({ isRunning: true, activeSpeaker: null, turn: this.currentTurn, isStreaming: false });
                if (this.autoAdvance && this.isRunning) {
                    this._advanceTurn();
                    setTimeout(() => this._triggerResponse(), 500);
                }
                return;
            }

            const messageEntry = {
                id: 'msg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
                role: 'assistant',
                speaker: speaker.name,
                content: cleanContent,
                createdAt: Date.now(),
                model: speaker.modelName || null,
                reasoning_content: response.reasoning_content || null,
                thinking_signature: response.thinking_signature || null,
                streamStats: response.streamStats || null,
                usage: response.usage || null,
                context: response.context || null,
                isStreaming: false
            };
            this.messages.push(messageEntry);
            this.updatedAt = messageEntry.createdAt;

            this.onMessage(messageEntry);
            this.onStatusChange({ isRunning: true, activeSpeaker: null, turn: this.currentTurn, isStreaming: false });

            this._saveToStorage();

            if (this.autoAdvance && this.isRunning) {
                this._advanceTurn();
                setTimeout(() => this._triggerResponse(), 500);
            }
        } catch (err) {
            this.onError(`Response error from ${speaker.name}: ${err.message}`);
            this.stop();
        }
    }

    _advanceTurn() {
        this.currentTurn++;
        this.activeSpeaker = this.activeSpeaker === this.participantA ? this.participantB : this.participantA;
    }

    _updateContextUsage(speaker, context, usage) {
        const isParticipantA = speaker === this.participantA;
        const key = isParticipantA ? 'participantA' : 'participantB';

        // Extract token count from usage or context
        let usedTokens = 0;
        if (usage?.total_tokens) {
            usedTokens = usage.total_tokens;
        } else if (usage?.prompt_tokens && usage?.completion_tokens) {
            usedTokens = usage.prompt_tokens + usage.completion_tokens;
        } else if (context?.used_tokens) {
            usedTokens = context.used_tokens;
        }

        // Extract window size from context or model capabilities
        let windowSize = null;
        if (context?.window_size) {
            windowSize = context.window_size;
        }

        this.contextUsage[key] = {
            used_tokens: usedTokens,
            window_size: windowSize,
            isEstimate: !context && !usage
        };

        // Notify UI of context update
        this.onContextUpdate(this.getContextDisplayData());
    }

    getContextDisplayData() {
        // Get context window sizes for both participants
        const windowA = this.contextUsage.participantA.window_size;
        const windowB = this.contextUsage.participantB.window_size;

        // Use the shorter context window as the limiting factor
        let limitingWindow = null;
        if (windowA && windowB) {
            limitingWindow = Math.min(windowA, windowB);
        } else if (windowA) {
            limitingWindow = windowA;
        } else if (windowB) {
            limitingWindow = windowB;
        }

        // Calculate total tokens used (sum of both participants' usage)
        const totalUsed = this.contextUsage.participantA.used_tokens + this.contextUsage.participantB.used_tokens;

        // Determine if estimate (if either is estimate)
        const isEstimate = this.contextUsage.participantA.isEstimate || this.contextUsage.participantB.isEstimate;

        return {
            used_tokens: totalUsed,
            window_size: limitingWindow,
            isEstimate: isEstimate,
            participantA: this.contextUsage.participantA,
            participantB: this.contextUsage.participantB
        };
    }

    addModeratorMessage(content) {
        this.messages.push({
            role: 'system',
            speaker: 'moderator',
            content: content,
            createdAt: Date.now()
        });
        // Auto-save after moderator message
        this._saveToStorage();
    }

    advanceAndRespond() {
        if (!this.isRunning) return;
        this._advanceTurn();
        this._triggerResponse();
    }

    stop() {
        this.isRunning = false;
        this.isPaused = true;

        if (this.participantA) this.participantA.cancel();
        if (this.participantB) this.participantB.cancel();

        this.onStatusChange({ isRunning: false, activeSpeaker: null, turn: this.currentTurn });
    }

    resume() {
        if (!this.isRunning || this.isPaused) return;
        if (this.activeSpeaker) {
            setTimeout(() => this._triggerResponse(), 500);
        }
    }

    toggleAutoAdvance() {
        this.autoAdvance = !this.autoAdvance;
        return this.autoAdvance;
    }

    _onParticipantProgress(participant, phase, data) {
        // Forward gateway progress events to UI
        // phase can be: routing, model_routed, context, context_stats, network_throttled, reasoning_started, etc.
        this.onProgress({
            participant,
            phase,
            data,
            speaker: participant === 'A' ? this.participantA?.name : this.participantB?.name
        });
    }

    async getModels() {
        const client = _createGatewayClient(this.gatewayUrl);
        const response = await client.getModels();
        return response.models || [];
    }

    exportJSON() {
        const topicText = (this.messages[0]?.content || '').replace(/^Topic:\s*/i, '').split('\n\n[')[0] || '';
        const summaryTitle = this.summary?.title;
        const sessionTitle = summaryTitle || topicText || 'Arena Session';

        return {
            version: 2,
            mode: 'arena',
            id: this.id,
            sessionId: this.sessionId,
            exportedAt: new Date().toISOString(),
            topic: topicText,
            chatInfo: {
                id: this.id,
                title: sessionTitle,
                createdAt: this.createdAt,
                updatedAt: this.updatedAt,
                category: this.summary?.category || '',
                pinned: !!this.summary?.pinned
            },
            participants: [
                {
                    name: this.participantA?.name || 'Model A',
                    model: this.participantA?.modelName || '',
                    role: 'assistant',
                    systemPrompt: this.participantA?.systemPrompt || null
                },
                {
                    name: this.participantB?.name || 'Model B',
                    model: this.participantB?.modelName || '',
                    role: 'assistant',
                    systemPrompt: this.participantB?.systemPrompt || null
                }
            ],
            settings: {
                maxTurns: this.maxTurns,
                autoAdvance: this.autoAdvance,
                temperature: this.temperature,
                reasoningEffort: this.reasoningEffort || null,
                modelA: this.participantA?.modelName || '',
                modelB: this.participantB?.modelName || '',
                systemPromptA: this.participantA?.systemPrompt || null,
                systemPromptB: this.participantB?.systemPrompt || null,
                targetTokens: this.targetTokens
            },
            summary: this.summary ? {
                title: this.summary.title || sessionTitle,
                teaser: this.summary.teaser || this.summary.shortSummary || '',
                reflection: this.summary.reflection || this.summary.longSummary || '',
                category: this.summary.category || '',
                pinned: !!this.summary.pinned
            } : null,
            messages: this.messages.map(m => ({
                id: m.id || null,
                speaker: m.speaker || null,
                role: m.role,
                content: m.content,
                createdAt: m.createdAt || null,
                reasoning_content: m.reasoning_content || null,
                thinking_signature: m.thinking_signature || null,
                streamStats: m.streamStats || null,
                usage: m.usage || null,
                context: m.context || null,
                embedStatus: m.embedStatus || null,
                embedError: m.embedError || null
            }))
        };
    }

    static async loadFromStorage(id) {
        const data = await arenaStorage.loadSession(id);
        if (!data) return null;

        const arena = new Arena({
            id: data.id,
            sessionId: data.sessionId,
            maxTurns: data.settings?.maxTurns || data.messages.filter(m => m.speaker !== 'moderator').length,
            autoAdvance: data.settings?.autoAdvance ?? true,
            temperature: data.settings?.temperature,
            reasoningEffort: data.settings?.reasoningEffort || null,
            targetTokens: data.settings?.targetTokens || null
        });

        arena.importJSON(data);

        // Mark as already-persisted so the next _saveToStorage skips createSession
        // and won't create a duplicate backend session.
        arena._persisted = true;

        // Restore sync counter so only new messages are sent to backend.
        // Without this, the first save after loading re-sends ALL messages via sendMessage().
        arena._lastSyncedCount = data.messages?.length || 0;

        // Restore participants. v2: data.participants is [{name, model, ...}, ...]
        // v1: data.participants is [modelNameA, modelNameB] (strings)
        const isV2 = data.version === 2;
        const participantObjects = isV2 && Array.isArray(data.participants) && data.participants[0] && typeof data.participants[0] === 'object'
            ? data.participants
            : null;

        let participantAName = '';
        let participantAModel = '';
        let participantASysPrompt = null;
        let participantBName = '';
        let participantBModel = '';
        let participantBSysPrompt = null;

        if (participantObjects) {
            participantAName = participantObjects[0]?.name || '';
            participantAModel = participantObjects[0]?.model || '';
            participantASysPrompt = participantObjects[0]?.systemPrompt || null;
            participantBName = participantObjects[1]?.name || '';
            participantBModel = participantObjects[1]?.model || '';
            participantBSysPrompt = participantObjects[1]?.systemPrompt || null;
        } else {
            participantAModel = data.participants?.[0] || '';
            participantBModel = data.participants?.[1] || '';
        }

        // Fallback: infer speakers from messages if participants missing
        const hasParticipants = participantAModel || participantBModel;
        if (!hasParticipants) {
            const speakers = [...new Set(
                (data.messages || [])
                    .filter(m => m.speaker && m.speaker !== 'moderator')
                    .map(m => m.speaker)
            )];
            if (speakers.length >= 2) {
                participantAModel = speakers[0];
                participantBModel = speakers[1];
            }
        }

        if (participantAModel || participantBModel) {
            const settings = data.settings || {};
            arena.setParticipants({
                name: data.participantNames?.[0] || participantAName || participantAModel?.split('/').pop() || 'Model A',
                modelName: participantAModel || settings.modelA || '',
                temperature: settings.temperature,
                reasoningEffort: settings.reasoningEffort || null,
                systemPrompt: participantASysPrompt || settings.systemPromptA
            }, {
                name: data.participantNames?.[1] || participantBName || participantBModel?.split('/').pop() || 'Model B',
                modelName: participantBModel || settings.modelB || '',
                temperature: settings.temperature,
                reasoningEffort: settings.reasoningEffort || null,
                systemPrompt: participantBSysPrompt || settings.systemPromptB
            });
        }

        return arena;
    }

    importJSON(data) {
        if (!data || (data.version !== 1 && data.version !== 2)) {
            throw new Error('Invalid arena export format');
        }
        const isV2 = data.version === 2;

        if (data.id) {
            this.id = data.id;
        }
        if (data.sessionId) {
            this.sessionId = data.sessionId;
        }

        this.messages = data.messages.map(m => ({
            id: m.id || null,
            role: m.role,
            speaker: m.speaker,
            content: m.content,
            createdAt: m.createdAt || null,
            model: m.model || null,
            reasoning_content: m.reasoning_content || null,
            thinking_signature: m.thinking_signature || null,
            streamStats: m.streamStats || null,
            usage: m.usage || null,
            context: m.context || null,
            embedStatus: m.embedStatus || null,
            embedError: m.embedError || null,
            isStreaming: false
        }));

        // Backfill empty speaker values for old sessions loaded from backend
        // where speaker wasn't stored.
        // System messages without speaker are moderator messages (topic, prompts)
        // MUST run before topic check below, otherwise old sessions render
        // the topic twice (once from the existing msg, once from the prepend).
        for (const m of this.messages) {
            if (!m.speaker && m.role === 'system') {
                m.speaker = 'moderator';
            }
        }

        // Ensure topic message exists at index 0 (old exports may not include it)
        const firstMsg = this.messages[0];
        const hasTopicMsg = firstMsg && firstMsg.role === 'system' && firstMsg.speaker === 'moderator';
        if (!hasTopicMsg && data.topic) {
            this.messages.unshift({
                role: 'system',
                speaker: 'moderator',
                content: `Topic: ${data.topic}`,
                createdAt: data.exportedAt ? new Date(data.exportedAt).getTime() : null,
                isStreaming: false
            });
        }

        // Non-moderator messages without speaker alternate between
        // participant A and B.
        const nonModMsgs = this.messages.filter(m => m.speaker !== 'moderator');
        const speakerNames = (data.participantNames || data.participants || []).map(
            p => typeof p === 'string' ? p : (p && p.name ? p.name : 'Model')
        );
        const aName = speakerNames[0] || 'Model A';
        const bName = speakerNames[1] || 'Model B';
        const hasAnyMatch = nonModMsgs.some(m => m.speaker === aName || m.speaker === bName);
        if (!hasAnyMatch) {
            let aTurn = true;
            for (const m of nonModMsgs) {
                if (!m.speaker) {
                    m.speaker = aTurn ? aName : bName;
                }
                if (m.speaker === aName) aTurn = false;
                else if (m.speaker === bName) aTurn = true;
            }
        }

        // Calculate current turn (number of assistant messages)
        const currentTurn = this.messages.filter(m => m.speaker !== 'moderator').length;

        // Restore settings from export, or calculate from messages
        this.maxTurns = data.settings?.maxTurns || currentTurn;
        if (data.settings?.autoAdvance !== undefined) {
            this.autoAdvance = data.settings.autoAdvance;
        }

        // Set current turn position
        this.currentTurn = currentTurn;

        // Restore context usage if available
        if (data.contextUsage) {
            this.contextUsage = data.contextUsage;
        }

        // Restore createdAt/updatedAt from chatInfo (v2) or exportedAt (v1)
        if (isV2 && data.chatInfo) {
            if (data.chatInfo.createdAt) this.createdAt = data.chatInfo.createdAt;
            if (data.chatInfo.updatedAt) this.updatedAt = data.chatInfo.updatedAt;
        } else if (data.exportedAt) {
            const ts = new Date(data.exportedAt).getTime();
            if (!isNaN(ts)) this.createdAt = this.updatedAt = ts;
        }

        // Restore summary (v2 uses {title, teaser, reflection, category, pinned};
        // v1 uses {condensedVersion, longSummary, shortSummary, title} â€” normalize to v2 shape)
        if (data.summary) {
            this.summary = {
                title: data.summary.title || '',
                teaser: data.summary.teaser || data.summary.shortSummary || '',
                reflection: data.summary.reflection || data.summary.longSummary || '',
                category: data.summary.category || '',
                pinned: !!data.summary.pinned
            };
        }

        // Store imported settings for UI restoration
        this._importedSettings = data.settings || {};

        return {
            topic: data.topic,
            participants: data.participants,
            participantNames: data.participantNames,
            settings: data.settings,
            messageCount: this.messages.length,
            currentTurn: currentTurn
        };
    }

    exportMarkdown() {
        const lines = [`# ${this.messages[0]?.content.replace('Topic: ', '') || 'Arena Conversation'}\n`];

        for (const msg of this.messages) {
            if (msg.speaker === 'moderator') continue;
            lines.push(`**${msg.speaker}:**`);
            lines.push(msg.content);
            lines.push('');
        }

        return lines.join('\n');
    }

    close() {
        this.stop();
        if (this.participantA) this.participantA.close();
        if (this.participantB) this.participantB.close();
    }

    async summarize(model, onProgress = null) {
        if (!model) throw new Error('summarize() requires a model');
        if (!this.messages || this.messages.length === 0) {
            return {
                title: 'Untitled Conversation',
                teaser: '',
                reflection: ''
            };
        }

        const conversationText = this.messages
            .filter(m => m.speaker !== 'moderator' && m.content)
            .map(m => `${m.speaker}: ${m.content}`)
            .join('\n\n');

        const topic = this.messages.find(m => m.role === 'system' && m.speaker === 'moderator')?.content?.replace('Topic: ', '') || '';

        const client = _createGatewayClient(this.gatewayUrl);
        const modelToUse = model;

        const summarySchema = {
            name: 'arena_summary',
            strict: true,
            schema: {
                type: 'object',
                properties: {
                    title: {
                        type: 'string',
                        description: 'A short, specific title of 3-7 words that makes the conversation recognizable in a long history list'
                    },
                    teaser: {
                        type: 'string',
                        description: 'An intriguing hook of approximately 50 words, like a movie trailer for the dialogue'
                    },
                    reflection: {
                        type: 'string',
                        description: '2-3 short paragraphs describing what the conversation was about, what ideas or phrases emerged, the emotional arc, and why it is worth remembering'
                    }
                },
                required: ['title', 'teaser', 'reflection'],
                additionalProperties: false
            }
        };

        const messages = [
            {
                role: 'user',
                content: `You are summarizing a conversation between two AI models for a chat archive.

TOPIC: ${topic}

CONVERSATION:
${conversationText}

Return a single JSON object with exactly these fields:
- title: a short, specific title of 3-7 words
- teaser: an intriguing hook of approximately 50 words
- reflection: 2-3 short paragraphs describing what the conversation was about and why it matters

No markdown, no explanation, no text outside the JSON object.`
            }
        ];

        if (onProgress) onProgress('summary', 'Generating summary...');

        return new Promise((resolve, reject) => {
            const stream = client.chatStream({
                model: modelToUse,
                messages,
                stream: true,
                maxTokens: 1000,
                enable_thinking: false,
                response_format: {
                    type: 'json_schema',
                    json_schema: summarySchema
                }
            });

            let fullText = '';
            let toolCallArguments = '';
            let gotToolCall = false;

            stream.on('progress', (data) => {
                if (data?.phase && onProgress) onProgress('summary', `Generating summary: ${data.phase}`);
            });

            stream.on('delta', (data) => {
                const delta = data?.choices?.[0]?.delta;
                if (delta?.tool_calls) {
                    gotToolCall = true;
                    for (const tc of delta.tool_calls) {
                        if (tc?.function?.arguments) {
                            toolCallArguments += tc.function.arguments;
                        }
                    }
                }
                if (delta?.content !== undefined) {
                    fullText += delta.content;
                }
            });

            stream.on('done', (data) => {
                const raw = gotToolCall
                    ? toolCallArguments
                    : (data?.content ?? fullText);

                let parsed = null;
                let parseError = null;
                try {
                    const cleaned = String(raw).replace(/^```json\s*|\s*```$/gi, '').trim();
                    parsed = JSON.parse(cleaned);
                } catch (e) {
                    parseError = e.message;
                }

                if (!parsed || typeof parsed.title !== 'string' || typeof parsed.teaser !== 'string' || typeof parsed.reflection !== 'string') {
                    console.error('[Arena] Summary parse failed:', parseError, 'raw:', raw);
                    reject(new Error('Summary response did not match expected format'));
                    return;
                }

                resolve({
                    title: parsed.title || 'Untitled Conversation',
                    teaser: parsed.teaser || '',
                    reflection: parsed.reflection || ''
                });
            });

            stream.on('error', reject);
        });
    }
}

// ============================================
// UI Controller
// ============================================

class ArenaUI {
    constructor() {
        this.arena = null;
        this.models = [];
        // Local mirror of arena metadata (title, category, pinned, summary).
        // Mirrors the chat's chatHistory.conversations pattern: load once,
        // mutate locally with _dirty=true, then _saveHistory() syncs dirty
        // entries to the backend in a single chokepoint.
        this._historyCache = [];
        this._historyLoaded = false;
        this._savingHistory = false;

        // Arena history list view preferences
        this._historyView = {
            sortBy: 'updatedAt',
            groupByCategory: true,
            pinsFirst: true
        };

        this._bindElements();
        this._bindEvents();
    }

    _bindElements() {
        this.messagesContainer = document.getElementById('arena-messages');
        this.welcomeEl = document.getElementById('arena-welcome');
        this.footerEl = document.getElementById('arena-footer');
        this.turnInfo = document.getElementById('turn-info');
        this.speakerIndicator = document.getElementById('speaker-indicator');
        this.contextUsageEl = document.getElementById('context-usage');

        this.topicInput = document.getElementById('topic-input');
        this.modelASelect = document.getElementById('model-a-select');
        this.modelBSelect = document.getElementById('model-b-select');
        this.maxTokensInput = document.getElementById('max-tokens');
        this.roleplayCheckbox = document.getElementById('roleplay-checkbox');
        this.roleplaySection = document.getElementById('roleplay-section');
        this.systemPromptAInput = document.getElementById('system-prompt-a');
        this.systemPromptBInput = document.getElementById('system-prompt-b');
        this.maxTurnsInput = document.getElementById('max-turns');
        this.temperatureSlider = document.getElementById('temperature-slider');
        this.temperatureValue = document.getElementById('temperature-value');
        this.thinkingCheckbox = document.getElementById('thinking-checkbox');
        this.autoAdvanceCheckbox = document.getElementById('auto-advance-checkbox');
        this.startButton = document.getElementById('start-btn');
        this.gatewayUrlInput = document.getElementById('arena-gateway-url');
        this.gatewayApiKeyInput = document.getElementById('arena-gateway-api-key');
        this.gatewayConnectBtn = document.getElementById('arena-gateway-connect-btn');
        this.stopButton = document.getElementById('stop-btn');
        this.summarizeBtn = document.getElementById('summarize-btn');
        this.promptInput = document.getElementById('arena-prompt-input');
        this.sendPromptBtn = document.getElementById('arena-send-btn');
        this.continueBtn = document.getElementById('continue-btn');
        this.scrollToBottomBtn = document.getElementById('scroll-to-bottom');

        // TTS Elements
        this.ttsEndpoint = document.getElementById('tts-endpoint');
        this.ttsVoiceASelect = document.getElementById('tts-voice-a-select');
        this.ttsVoiceBSelect = document.getElementById('tts-voice-b-select');
        this.ttsSpeed = document.getElementById('tts-speed');
        this.ttsStatus = document.getElementById('tts-status');

        // Arena history list controls
        this.historySortSelect = document.getElementById('arena-sort-select');
        this.historyGroupCheckbox = document.getElementById('arena-group-checkbox')?.closest('nui-checkbox');
        this.historyPinCheckbox = document.getElementById('arena-pin-checkbox')?.closest('nui-checkbox');
    }

    _bindEvents() {
        this.startButton?.addEventListener('click', () => this._startConversation());
        this.stopButton?.addEventListener('click', () => this._stopConversation());
        this.sendPromptBtn?.addEventListener('click', () => this._sendPromptMessage());
        this.continueBtn?.addEventListener('click', () => this._continueConversation());

        // Scroll to bottom button
        this.scrollToBottomBtn?.addEventListener('click', () => {
            if (this.messagesContainer) {
                this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
            }
            this._updateScrollToBottomButton();
        });

        // Track scroll position to show/hide scroll-to-bottom button
        this.messagesContainer?.addEventListener('scroll', () => {
            this._updateScrollToBottomButton();
        });

        this.roleplayCheckbox?.addEventListener('change', (e) => {
            if (this.roleplaySection) {
                this.roleplaySection.style.display = e.target.checked ? 'block' : 'none';
            }
        });

        // Temperature slider display update
        this.temperatureSlider?.addEventListener('input', (e) => {
            if (this.temperatureValue) {
                this.temperatureValue.textContent = parseFloat(e.target.value).toFixed(1);
            }
        });

        // Auto-advance checkbox syncs with footer button
        this.autoAdvanceCheckbox?.addEventListener('change', (e) => {
            if (this.arena && this.arena.isRunning) {
                this.arena.toggleAutoAdvance();
            }
        });

        this.summarizeBtn?.addEventListener('click', () => {
            if (this.arena?.id) {
                this.openArenaOptions(this.arena.id);
            } else {
                this._showError('No active arena to edit');
            }
        });

        // Update arena participants when model selects change (for loaded conversations)
        this.modelASelect?.addEventListener('nui-change', (e) => this._updateParticipantModel('A', e.detail?.values?.[0]));
        this.modelBSelect?.addEventListener('nui-change', (e) => this._updateParticipantModel('B', e.detail?.values?.[0]));

        document.getElementById('new-arena-btn')?.addEventListener('click', () => this._showSetupView());
        document.getElementById('import-arena-btn')?.addEventListener('click', () => this._triggerImport());

        this._importInput = document.createElement('input');
        this._importInput.type = 'file';
        this._importInput.accept = '.json';
        this._importInput.style.display = 'none';
        this._importInput.addEventListener('change', (e) => this._handleFileImport(e));
        document.body.appendChild(this._importInput);

        // Gateway Connect button — save URL, reload models
        this.gatewayConnectBtn?.addEventListener('click', async () => {
            const input = this.gatewayUrlInput?.querySelector('input');
            const newUrl = input?.value?.trim();
            if (!newUrl) return;
            localStorage.setItem('gateway-url', newUrl);

            const keyInput = this.gatewayApiKeyInput?.querySelector('input');
            const newKey = keyInput?.value?.trim() || '';
            localStorage.setItem('gateway-api-key', newKey);

            try {
                const client = _createGatewayClient(newUrl);
                const response = await client.getModels();
                this.models = response.data || response.models || [];
                this._populateModelSelects();
            } catch (err) {
                this._showError('Failed to connect to gateway. Check the URL and API key.');
            }
        });

        // TTS controls are wired by NSpeechController.init() — no manual listeners here

        // Arena history list controls
        this.historySortSelect?.addEventListener('nui-change', async (e) => {
            const sortBy = e.detail?.values?.[0] === 'createdAt' ? 'createdAt' : 'updatedAt';
            this._historyView.sortBy = sortBy;
            await this._setPref('arena-history-sort', sortBy);
            this._renderHistoryList();
        });

        this.historyGroupCheckbox?.addEventListener('nui-change', async (e) => {
            this._historyView.groupByCategory = !!e.detail?.checked;
            await this._setPref('arena-history-group', this._historyView.groupByCategory);
            this._renderHistoryList();
        });

        this.historyPinCheckbox?.addEventListener('nui-change', async (e) => {
            this._historyView.pinsFirst = !!e.detail?.checked;
            await this._setPref('arena-history-pins', this._historyView.pinsFirst);
            this._renderHistoryList();
        });

        // (TTS voice A/B and speed listeners removed — controller wires its own)
    }

    async _getPref(key, fallback = null) {
        const value = await storage.getPref(key);
        return value !== null ? value : fallback;
    }

    async _setPref(key, value) {
        await storage.setPref(key, value);
    }

    async _loadHistoryViewPrefs() {
        const sortBy = await this._getPref('arena-history-sort', 'updatedAt');
        const groupByCategory = await this._getPref('arena-history-group', true);
        const pinsFirst = await this._getPref('arena-history-pins', true);
        this._historyView = {
            sortBy: sortBy === 'createdAt' ? 'createdAt' : 'updatedAt',
            groupByCategory: !!groupByCategory,
            pinsFirst: !!pinsFirst
        };

        if (this.historySortSelect) {
            const select = this.historySortSelect.querySelector('select');
            if (select) select.value = this._historyView.sortBy;
        }
        if (this.historyGroupCheckbox) {
            const input = this.historyGroupCheckbox.querySelector('input');
            if (input) input.checked = this._historyView.groupByCategory;
        }
        if (this.historyPinCheckbox) {
            const input = this.historyPinCheckbox.querySelector('input');
            if (input) input.checked = this._historyView.pinsFirst;
        }
    }

    _waitForNUI() {
        return new Promise((resolve) => {
            const check = () => {
                if (customElements.get('nui-select')) {
                    setTimeout(resolve, 200);
                } else {
                    setTimeout(check, 50);
                }
            };
            check();
        });
    }

    async init() {
        await this._waitForNUI();

        // Restore theme (mirror chat.js so the NUI CSS variables resolve to the same palette)
        const savedTheme = await this._getPref('theme');
        const theme = savedTheme || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
        document.documentElement.setAttribute('data-theme', theme);
        document.documentElement.style.colorScheme = theme;

        // ---- Verify session / login (mirrors chat.js) ----
        if (typeof backendClient?.verifySession === 'function') {
            backendClient.onAuthError(() => {
                const dlg = document.getElementById('login-dialog');
                if (dlg) dlg.showModal();
            });

            const loginForm = document.getElementById('login-form');
            if (loginForm) {
                loginForm.addEventListener('submit', async (e) => {
                    e.preventDefault();
                    const username = document.getElementById('login-username').value;
                    const password = document.getElementById('login-password').value;
                    const errorDiv = document.getElementById('login-error');
                    errorDiv.textContent = '';
                    try {
                        document.querySelector('#login-dialog button[type="submit"]').disabled = true;
                        await new Promise(r => setTimeout(r, 500));
                        await backendClient.login(username, password);
                        document.getElementById('login-dialog').close();
                        window.location.reload();
                    } catch (err) {
                        errorDiv.textContent = err.message || 'Login failed';
                    } finally {
                        document.querySelector('#login-dialog button[type="submit"]').disabled = false;
                    }
                });
            }

            try {
                const user = await backendClient.verifySession();
                if (!user) {
                    const dlg = document.getElementById('login-dialog');
                    if (dlg) dlg.showModal();
                    return;
                }
            } catch (e) {
                console.warn('Backend probe failed or auth absent', e);
            }
        }

        // Load history first (independent of model loading)
        await this._loadHistoryViewPrefs();
        await this._loadHistory();

        try {
            const gatewayUrl = localStorage.getItem('gateway-url') || '';
            const gatewayApiKey = _getGatewayApiKey();
            if (this.gatewayUrlInput) {
                const input = this.gatewayUrlInput.querySelector('input');
                if (input) input.value = gatewayUrl;
            }
            if (this.gatewayApiKeyInput) {
                const input = this.gatewayApiKeyInput.querySelector('input');
                if (input) input.value = gatewayApiKey;
            }
            const client = _createGatewayClient(gatewayUrl);
            const response = await client.getModels();
            this.models = response.data || response.models || [];

            this._populateModelSelects();

            // Initialize TTS
            await this._initTts();

            // Set default topic
            if (config.defaultTopic && this.topicInput) {
                this.topicInput.value = config.defaultTopic;
            }
        } catch (err) {
            console.error('Failed to fetch models:', err);
            this._showError('Failed to fetch models. Is the gateway running?');
        }
    }

    _populateModelSelects() {
        const chatModels = this.models.filter(m => m.type === 'chat' || !m.type);
        const config = window.ARENA_CONFIG || {};

        const items = chatModels.map(m => ({
            value: m.id || m.name,
            label: m.name || m.id
        }));

        if (items.length === 0) {
            items.push({ value: '', label: 'No models available', disabled: true });
        }

        const populate = (select, defaultIndex) => {
            if (!select) return;
            if (select.setItems) {
                select.setItems([{ value: '', label: 'Select a model...' }, ...items]);
                // Auto-select: prefer the configured default index, else the first available model.
                const idx = (defaultIndex !== undefined && items[defaultIndex]) ? defaultIndex : 0;
                if (items[idx]) {
                    select.setValue(items[idx].value);
                }
            }
        };

        populate(this.modelASelect, config.defaultModelA);
        populate(this.modelBSelect, config.defaultModelB);
    }

    // Set a model <nui-select>'s value to `preferred` if it's in the list of
    // known chat models, else fall back to the first available model.
    // Used when loading a conversation whose models might no longer be on the gateway.
    _setModelSelectValue(nuiSelect, preferred) {
        if (!nuiSelect?.setValue) return;
        const chatModels = this.models.filter(m => m.type === 'chat' || !m.type);
        const items = chatModels.map(m => ({ value: m.id || m.name, label: m.name || m.id }));
        if (items.length === 0) return;
        if (preferred && items.some(i => i.value === preferred)) {
            nuiSelect.setValue(preferred);
        } else {
            nuiSelect.setValue(items[0].value);
        }
    }

    _getSelectValue(nuiSelect) {
        if (!nuiSelect) return '';
        if (nuiSelect.getValue) {
            return nuiSelect.getValue() || '';
        }
        const nativeSelect = nuiSelect.querySelector('select');
        return nativeSelect?.value || '';
    }

    _startConversation() {
        const topic = this.topicInput?.value?.trim();
        const modelA = this._getSelectValue(this.modelASelect);
        const modelB = this._getSelectValue(this.modelBSelect);
        const maxTurns = parseInt(this.maxTurnsInput?.value) || 10;
        const maxTokens = this.maxTokensInput?.value?.trim() || '';
        const temperature = parseFloat(this.temperatureSlider?.value) || 0.7;
        const reasoningEffort = this.thinkingCheckbox?.checked ? 'medium' : null;
        const autoAdvance = this.autoAdvanceCheckbox?.checked !== false;

        if (!topic) {
            this._showError('Please enter a topic');
            return;
        }
        if (!modelA || !modelB) {
            this._showError('Please select both participants');
            return;
        }
        if (modelA === modelB) {
            this._showError('Participants must use different models');
            return;
        }

        const config = window.ARENA_CONFIG || {};
        this.arena = new Arena({
            gatewayUrl: localStorage.getItem('gateway-url') || config.gatewayUrl || '',
            gatewayApiKey: _getGatewayApiKey(),
            maxTurns,
            autoAdvance,
            temperature,
            reasoningEffort,
            onMessage: (msg) => this._renderMessage(msg),
            onStatusChange: (status) => this._updateStatus(status),
            onError: (err) => this._showError(err),
            onMaxTurnsReached: (maxTurns) => this._showExtendOption(maxTurns),
            onContextUpdate: (contextData) => this._updateContextDisplay(contextData),
            onSave: () => this._loadHistory(),
            onProgress: (progress) => this._updateGenerationProgress(progress),
            onMessagePersisted: (msg) => this._onMessagePersisted(msg)
        });

        const systemPromptTemplate = `You are in a conversation. Your identity: {modelName}.
You are speaking with {otherParticipantName} (model: {otherModelName}).
Topic: {topic}
Speak naturally as if in a thoughtful conversation. Respond concisely but thoroughly.`;

        // Extract short names for display (last part of model path)
        const modelAName = modelA.split('/').pop();
        const modelBName = modelB.split('/').pop();

        // Parse targetTokens - use as hint only, not sent as hard limit
        const parsedTargetTokens = (maxTokens && !isNaN(parseInt(maxTokens))) ? parseInt(maxTokens) : null;

        this.arena.setParticipants({
            name: modelAName,
            modelName: modelA,
            temperature: temperature,
            reasoningEffort: reasoningEffort,
            systemPrompt: this.roleplayCheckbox?.checked ? (this.systemPromptAInput?.value || systemPromptTemplate) : null
        }, {
            name: modelBName,
            modelName: modelB,
            temperature: temperature,
            reasoningEffort: reasoningEffort,
            systemPrompt: this.roleplayCheckbox?.checked ? (this.systemPromptBInput?.value || systemPromptTemplate) : null
        });

        // Set topic with token budget hint (models self-regulate, no hard cutoff)
        this.arena.setTopic(topic, parsedTargetTokens);

        this.arena.setTopic(topic);

        // Clear messages and show conversation
        if (this.messagesContainer) {
            this.messagesContainer.innerHTML = '';
        }

        if (this.welcomeEl) {
            this.welcomeEl.style.display = 'none';
        }

        if (this.footerEl) {
            this.footerEl.style.display = 'block';
        }

        // Show continue button
        if (this.continueBtn) {
            const btn = this.continueBtn.querySelector('button');
            if (btn) {
                btn.innerHTML = '<nui-icon name="play"></nui-icon> Continue';
            }
            this.continueBtn.style.display = 'inline-flex';
        }

        // Hide sidebar on mobile
        const app = document.querySelector('nui-app');
        if (app) app.toggleSidebar('right', false);

        // Add topic message
        this._renderMessage({
            role: 'system',
            speaker: 'moderator',
            content: `Topic: ${topic}`
        });

        this.arena.start();
        this._startEmbedPoll();
    }

    _stopConversation() {
        this._stopEmbedPoll();
        if (this.arena) {
            this.arena.stop();
        }
    }

    _sendPromptMessage() {
        const text = this.promptInput?.value?.trim();
        if (!text || !this.arena) return;

        // Add the prompt as a message from the moderator (to both models)
        const messageEntry = {
            role: 'system',
            speaker: 'moderator',
            content: text
        };

        this.arena.addModeratorMessage(text);
        this._renderMessage(messageEntry);
        this.promptInput.value = '';

        // Always advance after sending a prompt
        this.arena.advanceAndRespond();
    }

    // ============================================
    // TTS Methods — delegated to shared NSpeechController
    // ============================================

    async _initTts() {
        const config = window.ARENA_CONFIG || {};
        this._tts = new NSpeechController({
            voiceCount: 2,
            storage,
            elements: {
                endpoint: this.ttsEndpoint,
                voiceASelect: this.ttsVoiceASelect,
                voiceBSelect: this.ttsVoiceBSelect,
                speed: this.ttsSpeed,
                status: this.ttsStatus,
            },
            serverDefaults: {
                endpoint: config.ttsEndpoint || '',
                voice: config.ttsVoiceA || '',
                speed: config.ttsSpeed ?? 1.0,
            },
        });
        // Fire-and-forget — TTS is non-critical and must NOT block arena init.
        this._tts.init().catch((err) => console.warn('[Arena TTS] init failed:', err.message));

        // Floating player — mount on nui-main (parent of the scrolling
        // .arena-messages). Absolute inside the scroller would scroll away.
        const mount = this.messagesContainer?.parentElement || this.messagesContainer;
        if (mount && !this._ttsPlayer) {
            if (getComputedStyle(mount).position === 'static') {
                mount.style.position = 'relative';
            }
            this._ttsPlayer = new TtsPlayerHost({
                controller: this._tts,
                mount,
            });
            this._ttsPlayer.attach();
        }
    }

    _getTtsSlotForSpeaker(speakerName) {
        if (!this.arena || !this.arena.participantA || !this.arena.participantB) return 'A';
        if (speakerName === this.arena.participantA.name) return 'A';
        if (speakerName === this.arena.participantB.name) return 'B';
        return 'A';
    }

    _stopTts() {
        if (this._tts) this._tts.stop();
    }

    _toggleTts(msg, messageEl) {
        if (!this._tts) return;

        // Same bubble while active:
        //   loading → cancel generation; playing/paused → pause/resume (download continues)
        // Else start (replaces session / aborts prior download).
        if (this._tts.targetEl === messageEl && this._tts.isActive()) {
            if (this._tts.getPlaybackState() === 'loading') {
                this._stopTts(); // cancel
                return;
            }
            this._ttsPlayer?.reveal();
            this._tts.togglePause();
            return;
        }

        const text = this._getPlainText(msg.content);
        if (!text) return;

        const slot = this._getTtsSlotForSpeaker(msg.speaker);
        this._ttsPlayer?.reveal();
        this._tts.speak(text, messageEl, { slot });
    }

    _getPlainText(content) {
        return getPlainText(content);
    }

    _renderMessage(msg) {
        if (!this.messagesContainer) return;

        // Debug: console.log('[ArenaUI] Rendering message:', msg.speaker, 'role:', msg.role);

        const messageEl = document.createElement('div');
        messageEl.className = `chat-message ${msg.speaker === 'moderator' ? 'moderator' : 'assistant'}`;
        messageEl.dataset.messageId = msg.id || '';
        messageEl.dataset.messageIdx = this.arena?.messages?.indexOf(msg) ?? '';

        const speakerName = msg.speaker === 'moderator' ? 'Moderator' : (msg.speaker || 'Unknown');
        const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const msgId = `arena-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

        let contentHtml = '<div class="message-content">';

        if (msg.role === 'system' && msg.speaker === 'moderator') {
            contentHtml += renderMarkdown(msg.content);
        } else {
            // Prefer the separate reasoning_content field (set by Participant in done handler).
            // Fall back to parsing inline <think>...</think> markers for backward compat.
            const inlineParsed = parseThinking(msg.content);
            const reasoning = msg.reasoning_content || inlineParsed.thinking;
            const answer = inlineParsed.answer || msg.content || '';

            if (reasoning) {
                const thinkingId = `thinking-${msgId}`;
                contentHtml += `
                    <div class="thinking-block collapsed" id="${thinkingId}">
                        <div class="thinking-header" data-thinking-toggle="${thinkingId}">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <circle cx="12" cy="12" r="10"></circle>
                                <line x1="12" y1="16" x2="12" y2="12"></line>
                                <line x1="12" y1="8" x2="12.01" y2="8"></line>
                            </svg>
                            <span class="thinking-title">Thoughts</span>
                            <span class="thinking-toggle">
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <polyline points="6 9 12 15 18 9"></polyline>
                                </svg>
                            </span>
                        </div>
                        <div class="thinking-content">${this._escapeHtml(reasoning)}</div>
                    </div>
                `;
            }

            contentHtml += renderMarkdown(answer);
        }

        contentHtml += '</div>';

        const embedStatus = msg.embedStatus || 'pending';
        const embedTooltip = embedStatus === 'embedded'
            ? 'Embedded in vector search'
            : embedStatus === 'pending'
                ? 'Embedding queued...'
                : embedStatus === 'failed'
                    ? `Embed failed: ${msg.embedError || 'unknown'}`
                    : 'Embed status unknown';

        messageEl.innerHTML = `
            <div class="message-header">
                <span class="message-author">${this._escapeHtml(speakerName)}</span>
                <span class="message-timestamp">${timestamp}${msg.isStreaming ? '<span class="streaming-indicator"></span>' : ''}</span>
                ${!msg.isStreaming && msg.speaker !== 'moderator' ? `<span class="embed-status" data-embed-status="${embedStatus}" title="${this._escapeHtml(embedTooltip)}"><span class="embed-status-dot"></span></span>` : ''}
            </div>
            ${contentHtml}
            ${!msg.isStreaming && msg.speaker !== 'moderator' ? `
            <div class="message-actions">
                <nui-button class="action-btn speaker" title="Read Aloud"><button type="button"><nui-icon name="volume"></nui-icon></button></nui-button>
                <nui-button class="action-btn copy-message" title="Copy Message"><button type="button"><nui-icon name="content_copy"></nui-icon></button></nui-button>
            </div>
            ` : (!msg.isStreaming ? `
            <div class="message-actions">
                <nui-button class="action-btn copy-message" title="Copy Message"><button type="button"><nui-icon name="content_copy"></nui-icon></button></nui-button>
            </div>
            ` : '')}
        `;

        // Attach handlers using addEventListener (NUI pattern) â€” no inline onclick.
        const thinkingHeader = messageEl.querySelector(`[data-thinking-toggle]`);
        if (thinkingHeader) {
            const block = thinkingHeader.closest('.thinking-block');
            thinkingHeader.addEventListener('click', () => {
                if (block) block.classList.toggle('collapsed');
            });
        }
        if (!msg.isStreaming) {
            messageEl.querySelector('.copy-message')?.addEventListener('click', (e) => this._copyMessageToClipboard(msg, e.currentTarget));
            messageEl.querySelector('.speaker')?.addEventListener('click', () => this._toggleTts(msg, messageEl));
        }

        this.messagesContainer.appendChild(messageEl);
        
        // Only auto-scroll if user is near bottom (same logic as chat app)
        if (this._isNearBottom()) {
            this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
        }
    }

    _updateEmbedStatus(messageId, status, error = null) {
        const el = this.messagesContainer?.querySelector(`.chat-message[data-message-id="${messageId}"] .embed-status`);
        if (!el) return;
        el.dataset.embedStatus = status || 'pending';
        const tooltip = status === 'embedded'
            ? 'Embedded in vector search'
            : status === 'pending'
                ? 'Embedding queued...'
                : status === 'failed'
                    ? `Embed failed: ${error || 'unknown'}`
                    : 'Embed status unknown';
        el.title = tooltip;
    }

    _startEmbedPoll() {
        this._stopEmbedPoll();
        const config = window.CHAT_CONFIG || {};
        if (!config.enableBackend || !this.arena?.id) return;
        this._embedPollChatId = this.arena.id;
        const base = config.backendUrl || '';
        const url = `${base}/api/embed-events?chatId=${encodeURIComponent(this.arena.id)}`;
        const es = new EventSource(url);
        es.addEventListener('embed-status', (e) => {
            try {
                const event = JSON.parse(e.data);
                if (!event || event.chatId !== this._embedPollChatId) return;
                this._updateEmbedStatus(event.messageId, event.embedStatus, event.embedError);
            } catch (err) {}
        });
        es.onerror = () => {
            if (es.readyState === EventSource.CLOSED) {
                console.warn('[Arena Embed] SSE connection closed permanently for:', this._embedPollChatId);
            }
        };
        this._embedEventSource = es;
    }

    _stopEmbedPoll() {
        if (this._embedEventSource) {
            this._embedEventSource.close();
            this._embedEventSource = null;
        }
        this._embedPollChatId = null;
    }

    _onMessagePersisted(msg) {
        // Update the DOM element's data-message-id after backend assigns an ID
        if (!msg.id || !this.messagesContainer) return;
        const idx = this.arena?.messages?.indexOf(msg);
        if (idx === undefined || idx < 0) return;
        const children = this.messagesContainer.querySelectorAll('.chat-message');
        const target = children[idx];
        if (target && !target.dataset.messageId) {
            target.dataset.messageId = msg.id;
            this._updateEmbedStatus(msg.id, msg.embedStatus || 'pending', msg.embedError);
        }
    }

    async _copyMessageToClipboard(msg, btn) {
        const parsed = parseThinking(msg.content);
        const contentToCopy = parsed.answer || msg.content || '';
        
        try {
            await navigator.clipboard.writeText(contentToCopy.trim());
            const icon = btn.querySelector('nui-icon');
            const oldIconName = icon.getAttribute('name');
            icon.setAttribute('name', 'check');
            setTimeout(() => icon.setAttribute('name', oldIconName), 2000);
        } catch (err) {
            console.error('Failed to copy text: ', err);
        }
    }

    _isNearBottom(threshold = 100) {
        if (!this.messagesContainer) return true;
        const { scrollTop, scrollHeight, clientHeight } = this.messagesContainer;
        return scrollHeight - scrollTop - clientHeight < threshold;
    }

    _updateScrollToBottomButton() {
        if (!this.scrollToBottomBtn) return;
        // Show button if not near bottom
        this.scrollToBottomBtn.style.display = this._isNearBottom() ? 'none' : 'block';
    }

    _updateStatus(status) {
        if (!this.turnInfo) return;

        this.turnInfo.textContent = `Turn ${status.turn}/${this.arena?.maxTurns || 10}`;

        if (this.speakerIndicator) {
            if (status.activeSpeaker) {
                // Check if active speaker is participant A by comparing names
                const isParticipantA = status.activeSpeaker === this.arena?.participantA?.name || 
                                       status.activeSpeaker === this.arena?.participantAConfig?.name;
                this.speakerIndicator.innerHTML = `
                    <span class="speaker-dot ${isParticipantA ? 'model-a' : 'model-b'}"></span>
                    Speaking: ${status.activeSpeaker}
                `;
            } else {
                this.speakerIndicator.innerHTML = '';
            }
        }
    }

    _updateContextDisplay(contextData) {
        if (!this.contextUsageEl) return;

        if (!contextData || contextData.used_tokens === 0) {
            this.contextUsageEl.textContent = '-- / --';
            this.contextUsageEl.style.color = '';
            return;
        }

        // Format tokens compactly (e.g., 36139 -> "36K")
        function formatTokensCompact(n) {
            if (n >= 1000000) return Math.round(n / 100000) / 10 + 'M';
            if (n >= 1000) return Math.round(n / 100) / 10 + 'K';
            return n.toString();
        }

        const isEstimate = contextData.isEstimate;
        let text = `${isEstimate ? '~' : ''}${formatTokensCompact(contextData.used_tokens)}`;

        // Show limiting context window
        if (contextData.window_size) {
            text += ` / ${formatTokensCompact(contextData.window_size)}`;
            
            // Calculate percentage and color-code
            const pct = (contextData.used_tokens / contextData.window_size) * 100;
            if (pct >= 90) {
                this.contextUsageEl.style.color = 'var(--nui-color-danger, #dc2626)';
            } else if (pct >= 75) {
                this.contextUsageEl.style.color = 'var(--nui-color-warning, #f59e0b)';
            } else {
                this.contextUsageEl.style.color = '';
            }
        } else {
            text += ' / ?';
            this.contextUsageEl.style.color = '';
        }

        this.contextUsageEl.textContent = text;

        // Add tooltip with detailed info
        let tooltip = `Total tokens used: ${contextData.used_tokens.toLocaleString()}`;
        if (contextData.window_size) {
            tooltip += `\nLimiting context window: ${contextData.window_size.toLocaleString()}`;
            tooltip += `\nUsage: ${((contextData.used_tokens / contextData.window_size) * 100).toFixed(1)}%`;
        }
        if (contextData.participantA?.used_tokens) {
            tooltip += `\n\n${this.arena?.participantA?.name || 'Model A'}: ${contextData.participantA.used_tokens.toLocaleString()}`;
        }
        if (contextData.participantB?.used_tokens) {
            tooltip += `\n${this.arena?.participantB?.name || 'Model B'}: ${contextData.participantB.used_tokens.toLocaleString()}`;
        }
        if (isEstimate) {
            tooltip += '\n\n(Estimated based on character count)';
        }
        this.contextUsageEl.title = tooltip;
    }

    _updateGenerationProgress(progress) {
        // Update speaker indicator with progress phase from gateway
        if (!this.speakerIndicator) return;
        
        const phaseLabels = {
            'routing': 'Routing...',
            'model_routed': 'Model selected',
            'context': 'Building context...',
            'context_stats': 'Context ready',
            'network_throttled': 'Network throttled',
            'reasoning_started': 'Reasoning...',
            'generating': 'Generating...'
        };
        
        const label = phaseLabels[progress.phase] || progress.phase;
        const speaker = progress.speaker || `Model ${progress.participant}`;
        
        // Check if active speaker is participant A
        const isParticipantA = speaker === this.arena?.participantA?.name;
        
        this.speakerIndicator.innerHTML = `
            <span class="speaker-dot ${isParticipantA ? 'model-a' : 'model-b'}"></span>
            ${speaker}: <em>${label}</em>
        `;
    }

    _triggerImport() {
        this._importInput?.click();
    }

    async _handleFileImport(e) {
        const file = e.target?.files?.[0];
        if (!file) return;

        try {
            const text = await file.text();
            const data = JSON.parse(text);

            this.arena = new Arena({
                gatewayUrl: localStorage.getItem('gateway-url') || window.ARENA_CONFIG?.gatewayUrl || '',
                gatewayApiKey: _getGatewayApiKey(),
                onMessage: (msg) => this._renderMessage(msg),
                onStatusChange: (status) => this._updateStatus(status),
                onError: (err) => this._showError(err),
                onMaxTurnsReached: (maxTurns) => this._showExtendOption(maxTurns),
                onContextUpdate: (contextData) => this._updateContextDisplay(contextData)
            });

            const result = this.arena.importJSON(data);

            // Normalize participants: v2 exports have [{name, model, ...}],
            // v1 exports have [modelNameA, modelNameB] (strings). Handle both.
            const extractModel = (p) => (typeof p === 'string' ? p : p?.model || '');

            // Set up participants if model names are available
            if (result.participants && result.participants.length >= 2) {
                const modelA = extractModel(result.participants[0]);
                const modelB = extractModel(result.participants[1]);
                this.arena.setParticipants({
                    name: result.participantNames?.[0] || modelA.split('/').pop() || 'Model A',
                    modelName: modelA,
                    temperature: result.settings?.temperature,
                    reasoningEffort: result.settings?.reasoningEffort || null,
                    systemPrompt: result.settings?.systemPromptA
                }, {
                    name: result.participantNames?.[1] || modelB.split('/').pop() || 'Model B',
                    modelName: modelB,
                    temperature: result.settings?.temperature,
                    reasoningEffort: result.settings?.reasoningEffort || null,
                    systemPrompt: result.settings?.systemPromptB
                });
            }

            // Restore settings to UI
            this._restoreSettingsToUI(result.settings, result);

            // Update context display
            this._updateContextDisplay(this.arena.getContextDisplayData());

            // Show continue button so user can resume the conversation
            if (this.continueBtn) {
                const btn = this.continueBtn.querySelector('button');
                if (btn) {
                    btn.innerHTML = '<nui-icon name="play"></nui-icon> Continue';
                }
                this.continueBtn.style.display = 'inline-flex';
            }

            if (this.messagesContainer) {
                this.messagesContainer.innerHTML = '';
            }

            if (this.welcomeEl) {
                this.welcomeEl.style.display = 'none';
            }

            if (this.footerEl) {
                this.footerEl.style.display = 'block';
            }

            for (const msg of this.arena.messages) {
                this._renderMessage(msg);
            }

            this._updateStatus({
                isRunning: false,
                activeSpeaker: null,
                turn: this.arena.currentTurn
            });

            // Update context display
            this._updateContextDisplay(this.arena.getContextDisplayData());

            // Save imported arena to history and refresh list
            await this.arena._saveToStorage();

            // Persist metadata that createSession doesn't handle: category,
            // pinned, title (overrides the topic-based default), and the
            // structured summary {title, teaser, reflection, category, pinned}.
            try {
                const chatInfo = data.chatInfo || {};
                const summaryObj = data.summary && typeof data.summary === 'object' ? data.summary : {};
                await backendClient.updateSession(this.arena.id, {
                    title: chatInfo.title || data.topic || '',
                    category: chatInfo.category || summaryObj.category || '',
                    pinned: !!(chatInfo.pinned || summaryObj.pinned),
                    summary: {
                        title: summaryObj.title || chatInfo.title || data.topic || '',
                        teaser: summaryObj.teaser || summaryObj.shortSummary || '',
                        reflection: summaryObj.reflection || summaryObj.longSummary || '',
                        category: summaryObj.category || chatInfo.category || '',
                        pinned: !!(summaryObj.pinned || chatInfo.pinned)
                    }
                });
            } catch (err) {
                console.warn('[Arena] Failed to persist imported metadata:', err.message);
            }

            await this._loadHistory();

            this._showNotification(`Imported: ${result.topic} (${result.messageCount} messages)`, 'success');
        } catch (err) {
            this._showError(`Import failed: ${err.message}`);
        }

        e.target.value = '';
    }

    async _loadHistory() {
        // Prevent concurrent execution
        if (this._isLoadingHistory) return;
        this._isLoadingHistory = true;
        
        const historyList = document.getElementById('arena-history-list');
        if (!historyList) {
            this._isLoadingHistory = false;
            return;
        }

        try {
            // Flush any pending dirty changes first so the fresh server read
            // doesn't immediately overwrite them.
            if (this._historyLoaded) await this._saveHistory();

            const history = await arenaStorage.loadHistory();

            // Populate local cache. Mark entries that already match the server
            // as clean (no _dirty), so a subsequent _saveHistory() won't re-send them.
            this._historyCache = history.map(h => ({ ...h, _dirty: false }));
            this._historyLoaded = true;

            this._renderHistoryList();
        } catch (err) {
            console.error('Failed to load history:', err);
        } finally {
            this._isLoadingHistory = false;
        }
    }

    _renderHistoryList() {
        const historyList = document.getElementById('arena-history-list');
        if (!historyList) return;

        const view = this._historyView;
        const sortKey = view.sortBy === 'createdAt' ? 'createdAt' : 'updatedAt';

        const sorted = [...this._historyCache].sort((a, b) => {
            if (view.pinsFirst) {
                if (a.pinned && !b.pinned) return -1;
                if (!a.pinned && b.pinned) return 1;
            }
            const diff = (b[sortKey] || 0) - (a[sortKey] || 0);
            if (diff !== 0) return diff;
            return (b.createdAt || 0) - (a.createdAt || 0);
        });

        if (!sorted || sorted.length === 0) {
            historyList.innerHTML = '<p style="padding: 1rem; text-align: center; opacity: 0.6;">No saved arenas</p>';
            return;
        }

        historyList.innerHTML = '';

        if (view.groupByCategory) {
            const groupedHistory = {};
            for (const entry of sorted) {
                const cat = entry.category ? entry.category.trim() : 'Uncategorized';
                if (!groupedHistory[cat]) groupedHistory[cat] = [];
                groupedHistory[cat].push(entry);
            }

            const categories = Object.keys(groupedHistory).sort((a, b) => {
                if (a === 'Uncategorized') return -1;
                if (b === 'Uncategorized') return 1;
                return a.localeCompare(b);
            });

            for (const cat of categories) {
                const categoryGroup = document.createElement('div');
                categoryGroup.className = 'chat-history-category';
                categoryGroup.style.marginBottom = '0.5rem';

                if (categories.length > 1 || cat !== 'Uncategorized') {
                    const header = document.createElement('div');
                    header.className = 'chat-history-category-header';
                    header.textContent = cat;
                    categoryGroup.appendChild(header);
                }

                for (const entry of groupedHistory[cat]) {
                    categoryGroup.appendChild(this._createHistoryItem(entry));
                }
                historyList.appendChild(categoryGroup);
            }
            return;
        }

        // Ungrouped flat list — still wrap in a category container so the
        // same layout context that works for grouped mode is preserved.
        const flatGroup = document.createElement('div');
        flatGroup.className = 'chat-history-category';
        for (const entry of sorted) {
            flatGroup.appendChild(this._createHistoryItem(entry));
        }
        historyList.appendChild(flatGroup);
    }

    _createHistoryItem(entry) {
        const isActive = this.arena && this.arena.id === entry.id;
        const item = document.createElement('div');
        item.className = 'chat-history-item' + (isActive ? ' active' : '');
        item.dataset.chatId = entry.id;
        item.title = `${entry.participants?.[0] || '?'} vs ${entry.participants?.[1] || '?'}`;

        // Title is already resolved by arenaStorage.loadHistory(); fall back to topic or placeholder.
        const displayTitle = entry.title || entry.topic || 'Untitled';

        const titleContainer = document.createElement('div');
        titleContainer.className = 'chat-history-item-title-container';

        const topRow = document.createElement('div');
        topRow.className = 'chat-history-item-top-row';

        if (entry.pinned) {
            const pinIcon = document.createElement('nui-icon');
            pinIcon.setAttribute('name', 'star_rate');
            pinIcon.className = 'chat-history-item-pin';
            topRow.appendChild(pinIcon);
        }

        const titleSpan = document.createElement('span');
        titleSpan.className = 'chat-history-item-title';
        titleSpan.textContent = this._escapeHtml(displayTitle);
        topRow.appendChild(titleSpan);
        titleContainer.appendChild(topRow);

        const dateSpan = document.createElement('span');
        const dateTs = this._historyView.sortBy === 'createdAt'
            ? (entry.createdAt || entry.updatedAt || Date.now())
            : (entry.updatedAt || entry.createdAt || Date.now());
        const dateLabel = this._historyView.sortBy === 'createdAt' ? 'Created ' : '';
        dateSpan.textContent = dateLabel + new Date(dateTs).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

        const countSpan = document.createElement('span');
        countSpan.textContent = `${entry.messageCount || 0} msgs`;

        const metaDiv = document.createElement('div');
        metaDiv.className = 'chat-history-item-meta';
        metaDiv.appendChild(dateSpan);
        metaDiv.appendChild(countSpan);
        titleContainer.appendChild(metaDiv);

        const actionsDiv = document.createElement('div');
        actionsDiv.className = 'chat-history-item-actions';

        // Edit button only renders for the active conversation — opening it on an
        // inactive one is ambiguous (would the edits apply to the active arena or
        // the clicked one?). Load the conversation first, then edit.
        if (isActive) {
            const editBtn = document.createElement('nui-button');
            editBtn.className = 'chat-history-item-action';
            editBtn.innerHTML = '<button type="button"><nui-icon name="edit"></nui-icon></button>';
            editBtn.title = 'Arena options';
            editBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.openArenaOptions(entry.id);
            });
            actionsDiv.appendChild(editBtn);
        }

        item.appendChild(titleContainer);
        item.appendChild(actionsDiv);

        item.addEventListener('click', (e) => {
            if (e.ctrlKey || e.metaKey) {
                e.preventDefault();
                e.stopPropagation();
                navigator.clipboard.writeText(entry.id).then(() => {
                    nui.components.toast?.success?.(`Copied ID: ${entry.id}`);
                }).catch(err => {
                    console.error('Failed to copy text: ', err);
                });
                return;
            }
            this._loadArena(entry.id);
        });

        return item;
    }

    // ============================================
    // Local history cache — mirrors the chat's chatHistory pattern
    // ============================================

    // Sync all _dirty cache entries to the backend. Mirrors ChatHistory._saveList.
    async _saveHistory() {
        if (this._savingHistory) return;
        this._savingHistory = true;
        try {
            for (const entry of this._historyCache) {
                if (!entry._dirty) continue;
                // Send only the metadata fields the server stores at the top level
                // of the session doc, plus the summary sub-object (mirrors the
                // server PATCH /api/chats/:id contract).
                await backendClient.updateSession(entry.id, {
                    title: entry.title || '',
                    category: entry.category || '',
                    pinned: !!entry.pinned,
                    summary: {
                        title: entry.summary?.title || '',
                        teaser: entry.summary?.teaser || '',
                        reflection: entry.summary?.reflection || ''
                    }
                });
                entry._dirty = false;
            }
        } catch (err) {
            console.error('[Arena] Failed to save history:', err);
        } finally {
            this._savingHistory = false;
        }
    }

    // Find a cache entry, or load it from the backend if missing.
    // Mirrors ChatHistory.get — also seeds the cache on first access.
    _getHistoryEntry(id) {
        const existing = this._historyCache.find(e => e.id === id);
        if (existing) return existing;
        // Not in cache: create a stub that the caller can mutate, then let
        // _saveHistory() push it. _dirty is true so it'll be sent.
        const stub = {
            id,
            title: '',
            category: '',
            pinned: false,
            summary: null,
            messageCount: 0,
            updatedAt: Date.now(),
            _dirty: true
        };
        this._historyCache.unshift(stub);
        return stub;
    }

    async _loadArena(id) {
        try {
            const arena = await Arena.loadFromStorage(id);
            if (!arena) {
                this._showError('Arena not found');
                return;
            }

            this.arena = arena;

            // Set up callbacks for loaded arena
            this.arena.onMessage = (msg) => this._renderMessage(msg);
            this.arena.onStatusChange = (status) => this._updateStatus(status);
            this.arena.onError = (err) => this._showError(err);
            this.arena.onMaxTurnsReached = (maxTurns) => this._showExtendOption(maxTurns);
            this.arena.onContextUpdate = (contextData) => this._updateContextDisplay(contextData);
            this.arena.onSave = () => this._loadHistory();
            this.arena.onProgress = (progress) => this._updateGenerationProgress(progress);
            this.arena.onMessagePersisted = (msg) => this._onMessagePersisted(msg);

            // Restore settings to UI
            const topicMsg = arena.messages.find(m => m.role === 'system' && m.speaker === 'moderator');
            this._restoreSettingsToUI(arena._importedSettings, {
                topic: topicMsg?.content?.replace('Topic: ', '') || '',
                participants: [arena.participantA?.modelName, arena.participantB?.modelName],
                participantNames: [arena.participantA?.name, arena.participantB?.name]
            });

            // Update context display
            this._updateContextDisplay(this.arena.getContextDisplayData());

            // Show continue button so user can resume the conversation
            if (this.continueBtn) {
                const btn = this.continueBtn.querySelector('button');
                if (btn) {
                    btn.innerHTML = '<nui-icon name="play"></nui-icon> Continue';
                }
                this.continueBtn.style.display = 'inline-flex';
            }

            if (this.messagesContainer) {
                this.messagesContainer.innerHTML = '';
            }

            if (this.welcomeEl) {
                this.welcomeEl.style.display = 'none';
            }

            if (this.footerEl) {
                this.footerEl.style.display = 'block';
            }

            // Render existing messages
            for (const msg of this.arena.messages) {
                this._renderMessage(msg);
            }

            this._updateStatus({
                isRunning: false,
                activeSpeaker: null,
                turn: this.arena.currentTurn
            });

            this._startEmbedPoll();
            await this._loadHistory();
        } catch (err) {
            this._showError(`Failed to load arena: ${err.message}`);
        }
    }

    // ============================================
    // Arena Options Dialog (consolidated edit + summary + actions)
    // ============================================

    async openArenaOptions(arenaId) {
        if (!arenaId) return;
        const data = await arenaStorage.loadSession(arenaId);
        if (!data) {
            this._showError('Arena not found');
            return;
        }

        const template = document.getElementById('arena-options-template');
        if (!template) {
            this._showError('Arena options template missing');
            return;
        }

        const content = template.content.cloneNode(true);
        const wrapper = content.firstElementChild;
        if (wrapper) wrapper.dataset.arenaId = arenaId;

        const titleInput = content.getElementById('arena-options-title-input');
        const categoryInput = content.getElementById('arena-options-category-input');
        const pinToggle = content.getElementById('arena-options-pin-toggle');
        const teaserInput = content.getElementById('arena-options-teaser-input');
        const reflectionInput = content.getElementById('arena-options-reflection-input');
        const summaryModelSelect = content.getElementById('arena-options-summary-model-select');
        const statusEl = content.getElementById('arena-options-summary-status');
        const createdSpan = content.getElementById('arena-options-created-date');
        const updatedSpan = content.getElementById('arena-options-updated-date');
        const msgCountSpan = content.getElementById('arena-options-msg-count');
        const participantsSpan = content.getElementById('arena-options-participants');

        const summary = data.summary || {};
        if (titleInput) titleInput.value = data.chatInfo?.title || summary.title || data.topic || '';
        if (categoryInput) categoryInput.value = data.chatInfo?.category || summary.category || '';
        if (pinToggle) pinToggle.checked = !!(data.chatInfo?.pinned || summary.pinned);
        if (teaserInput) teaserInput.value = summary.teaser || '';
        if (reflectionInput) reflectionInput.value = summary.reflection || '';

        if (createdSpan) createdSpan.textContent = data.chatInfo?.createdAt ? new Date(data.chatInfo.createdAt).toLocaleString() : '-';
        if (updatedSpan) updatedSpan.textContent = data.chatInfo?.updatedAt ? new Date(data.chatInfo.updatedAt).toLocaleString() : '-';
        if (msgCountSpan) msgCountSpan.textContent = (data.messages || []).length.toString();
        if (participantsSpan) {
            const pA = data.participants?.[0]?.model || 'Model A';
            const pB = data.participants?.[1]?.model || 'Model B';
            participantsSpan.textContent = `${pA} vs ${pB}`;
        }

        const { dialog, main, result } = await nui.components.dialog.page('Edit Arena', '', {
            contentScroll: true,
            buttons: [
                { value: 'cancel', label: 'Cancel', type: 'outline' },
                { value: 'save', label: 'Save Changes', type: 'primary' }
            ]
        });
        main.appendChild(content);
        main._dialog = dialog;

        // Populate summary model select with the same model list as the participant selects.
        // Must run after appendChild so the cloned <nui-select> is upgraded to its custom element.
        if (summaryModelSelect) {
            const chatModels = this.models.filter(m => m.type === 'chat' || !m.type);
            const items = chatModels.map(m => ({
                value: m.id || m.name,
                label: m.name || m.id
            }));
            if (items.length === 0) {
                items.push({ value: '', label: 'No models available', disabled: true });
            }
            if (summaryModelSelect.setItems) {
                summaryModelSelect.setItems([{ value: '', label: 'Select a model...' }, ...items]);
            }
            // Determine the default summary model. Prefer the configured default,
            // then fall back to the first available model (which is the local model
            // on this deployment and reliably returns the structured format).
            const configDefault = window.ARENA_CONFIG?.defaultSummaryModel;
            const preselect = (configDefault && items.some(i => i.value === configDefault))
                ? configDefault
                : items[0]?.value;
            if (preselect) {
                summaryModelSelect.setValue?.(preselect);
            }
        }

        const activeArena = this.arena && this.arena.id === arenaId ? this.arena : null;

        // Centralized action handler
        const handler = async (detail) => {
            const name = detail?.param;
            console.log('[arena-options] handler invoked, name:', name, 'detail:', detail);
            if (!name) return;
            switch (name) {
                case 'generate': {
                    console.log('[arena-options] generate case, summaryModelSelect:', summaryModelSelect, 'statusEl:', statusEl);
                    const model = summaryModelSelect?.getValue ? (summaryModelSelect.getValue() || null) : null;
                    console.log('[arena-options] selected model:', model);
                    if (!model) {
                        statusEl.textContent = 'Error: select a model to generate the summary';
                        break;
                    }
                    statusEl.textContent = 'Generating...';
                    try {
                        let messages = data.messages || [];
                        if (activeArena) messages = activeArena.messages;
                        console.log('[arena-options] messages count:', messages.length, 'modelA:', data.participants?.[0]?.model);
                        const arenaStub = Object.assign(Object.create(Arena.prototype), {
                            messages,
                            participantA: activeArena?.participantA || { modelName: data.participants?.[0]?.model },
                            participantB: activeArena?.participantB || { modelName: data.participants?.[1]?.model },
                            gatewayUrl: activeArena?.gatewayUrl || window.ARENA_CONFIG?.gatewayUrl
                        });
                        const result = await arenaStub.summarize(model, (step, message) => {
                            statusEl.textContent = message;
                        });
                        if (teaserInput) teaserInput.value = result.teaser;
                        if (reflectionInput) reflectionInput.value = result.reflection;
                        if (titleInput) titleInput.value = result.title;
                        statusEl.textContent = 'Done';
                    } catch (err) {
                        console.error('[Arena] Summary generation failed:', err);
                        statusEl.textContent = 'Error: ' + err.message;
                    }
                    break;
                }
                case 'copy-json': {
                    const json = JSON.stringify(data, null, 2);
                    try {
                        await navigator.clipboard.writeText(json);
                        nui.components.toast?.success?.('Arena JSON copied to clipboard');
                    } catch (err) {
                        // Fallback for insecure origins (HTTP)
                        try {
                            const ta = document.createElement('textarea');
                            ta.value = json; ta.style.position = 'fixed'; ta.style.opacity = '0';
                            document.body.appendChild(ta); ta.focus(); ta.select();
                            document.execCommand('copy'); document.body.removeChild(ta);
                            nui.components.toast?.success?.('Arena JSON copied to clipboard');
                        } catch (e) {
                            console.error('Failed to copy:', e);
                            nui.components.toast?.error?.('Copy failed — check console');
                        }
                    }
                    break;
                }
                case 'save-json': {
                    await this._exportArenaToFile(arenaId);
                    break;
                }
                case 'save-md': {
                    if (activeArena) {
                        // Use current in-memory summary if present
                        const s = activeArena.summary || summary;
                        this._exportMarkdownFromDialog(
                            teaserInput?.value || s.teaser || '',
                            reflectionInput?.value || s.reflection || '',
                            titleInput?.value || s.title || ''
                        );
                    } else {
                        await this._exportArenaMarkdown(arenaId);
                    }
                    break;
                }
                case 'delete': {
                    dialog.close('delete');
                    await this._deleteArena(arenaId, { stopPropagation: () => {}, shiftKey: true });
                    break;
                }
            }
        };
        window._arenaOptionsHandler = handler;

        result.then(async (action) => {
            window._arenaOptionsHandler = null;
            if (action === 'save') {
                const newTitle = titleInput?.value.trim() || '';
                const newCategory = categoryInput?.value.trim() || '';
                const newPinned = pinToggle?.checked || false;
                const newTeaser = teaserInput?.value || '';
                const newReflection = reflectionInput?.value || '';

                // Mirror the chat's edit dialog: mutate the local cache entry,
                // mark it _dirty, and let _saveHistory() push it to the backend.
                // This is the same single-chokepoint pattern chatHistory uses.
                const entry = this._getHistoryEntry(arenaId);
                entry.title = newTitle;
                entry.category = newCategory;
                entry.pinned = newPinned;
                entry.summary = {
                    title: newTitle,
                    teaser: newTeaser,
                    reflection: newReflection
                };
                entry.updatedAt = Date.now();
                entry._dirty = true;

                // Keep the in-memory active arena's summary in sync so reopen
                // shows what was just saved.
                if (activeArena) {
                    activeArena.summary = {
                        title: newTitle,
                        teaser: newTeaser,
                        reflection: newReflection,
                        category: newCategory,
                        pinned: newPinned
                    };
                    activeArena.updatedAt = entry.updatedAt;
                }

                await this._saveHistory();
                await this._loadHistory();
                nui.components.toast?.success?.('Arena options saved');
            }
        });
    }

    _showSetupView() {
        // Reset arena
        if (this.arena) {
            this.arena.close();
            this.arena = null;
        }

        // Clear messages
        if (this.messagesContainer) {
            this.messagesContainer.innerHTML = '';
        }

        if (this.welcomeEl) {
            this.welcomeEl.style.display = 'block';
        }

        if (this.footerEl) {
            this.footerEl.style.display = 'none';
        }

        // Reset context display
        this._updateContextDisplay(null);

        // Get defaults from config
        const config = window.ARENA_CONFIG || {};

        // Populate form with defaults
        if (this.topicInput) this.topicInput.value = config.defaultTopic || '';
        if (this.maxTurnsInput) this.maxTurnsInput.value = config.defaultMaxTurns || '10';
        if (this.maxTokensInput) this.maxTokensInput.value = '';
        
        // Reset roleplay
        if (this.roleplayCheckbox) this.roleplayCheckbox.checked = false;
        if (this.roleplaySection) {
            this.roleplaySection.style.display = 'none';
        }
        
        // Set default models using indices
        const chatModels = this.models.filter(m => m.type === 'chat' || !m.type);
        if (chatModels.length > 0) {
            const modelAIndex = config.defaultModelA || 0;
            const modelBIndex = config.defaultModelB || 0;
            
            if (this.modelASelect && chatModels[modelAIndex]) {
                this.modelASelect.setValue?.(chatModels[modelAIndex].id || chatModels[modelAIndex].name);
            }
            if (this.modelBSelect && chatModels[modelBIndex]) {
                this.modelBSelect.setValue?.(chatModels[modelBIndex].id || chatModels[modelBIndex].name);
            }
        }

        // Reset continue button for new conversations
        if (this.continueBtn) {
            const btn = this.continueBtn.querySelector('button');
            if (btn) {
                btn.innerHTML = '<nui-icon name="play"></nui-icon> Continue';
            }
            this.continueBtn.style.display = 'none';
        }

        // Refresh history list
        this._loadHistory();
    }

    _showExtendOption(maxTurns) {
        // Update continue button to show extend mode
        if (this.continueBtn) {
            const btn = this.continueBtn.querySelector('button');
            if (btn) {
                btn.innerHTML = '<nui-icon name="add"></nui-icon> Extend';
            }
            this.continueBtn.style.display = 'inline-flex';
        }
        this._showNotification(`Conversation reached ${maxTurns} turns. Click Extend to continue.`, 'success');
    }

    async _continueConversation() {
        if (!this.arena) return;

        // If at max turns, open extend dialog
        if (this.arena.currentTurn >= this.arena.maxTurns) {
            const result = await nui.components.dialog.prompt('Extend Conversation', '', {
                fields: [
                    {
                        id: 'turns',
                        label: 'Number of turns to add',
                        type: 'number',
                        value: '5'
                    }
                ]
            });

            if (!result || !result.turns) return;

            const additionalTurns = parseInt(result.turns, 10);
            if (isNaN(additionalTurns) || additionalTurns < 1) {
                nui.components.dialog.alert('Invalid Input', 'Please enter a number greater than 0.');
                return;
            }

            this.arena.maxTurns += additionalTurns;
            this._showNotification(`Extended by ${additionalTurns} turns (max: ${this.arena.maxTurns})`, 'success');

            // Restore continue button text
            if (this.continueBtn) {
                const btn = this.continueBtn.querySelector('button');
                if (btn) {
                    btn.innerHTML = '<nui-icon name="play"></nui-icon> Continue';
                }
            }
        }

        // Resume if stopped â€” turn was already advanced when last message completed,
        // so just trigger the current activeSpeaker without advancing again
        if (!this.arena.isRunning) {
            this.arena.isRunning = true;
            this.arena.isPaused = false;
            
            // Ensure activeSpeaker is set correctly
            if (!this.arena.activeSpeaker) {
                const isParticipantATurn = this.arena.currentTurn % 2 === 0;
                this.arena.activeSpeaker = isParticipantATurn ? this.arena.participantA : this.arena.participantB;
            }
        }
        
        this.arena._triggerResponse();
    }

    _restoreSettingsToUI(settings, data) {
        // Restore topic
        if (this.topicInput && data.topic) {
            this.topicInput.value = data.topic;
        }

        // Restore model selections: prefer the conversation's model if it
        // exists in the gateway's model list, else fall back to the first model.
        if (data.participants && data.participants.length >= 2) {
            if (this.modelASelect) {
                this._setModelSelectValue(this.modelASelect, data.participants[0]);
            }
            if (this.modelBSelect) {
                this._setModelSelectValue(this.modelBSelect, data.participants[1]);
            }
        }

        // Restore max turns
        if (this.maxTurnsInput && settings?.maxTurns) {
            this.maxTurnsInput.value = settings.maxTurns;
        }

        // Restore target tokens (token hint, not hard limit)
        if (this.maxTokensInput && settings?.targetTokens) {
            this.maxTokensInput.value = settings.targetTokens;
        }

        // Restore temperature
        if (this.temperatureSlider && settings?.temperature !== undefined) {
            this.temperatureSlider.value = settings.temperature;
            if (this.temperatureValue) {
                this.temperatureValue.textContent = parseFloat(settings.temperature).toFixed(1);
            }
        }

        // Restore thinking checkbox
        if (this.thinkingCheckbox) {
            this.thinkingCheckbox.checked = !!settings?.reasoningEffort;
        }

        // Restore auto-advance checkbox
        if (this.autoAdvanceCheckbox && settings?.autoAdvance !== undefined) {
            this.autoAdvanceCheckbox.checked = settings.autoAdvance;
        }

        // Restore system prompts if they exist
        if (settings?.systemPromptA && this.systemPromptAInput) {
            this.systemPromptAInput.value = settings.systemPromptA;
        }
        if (settings?.systemPromptB && this.systemPromptBInput) {
            this.systemPromptBInput.value = settings.systemPromptB;
        }

        // Detect roleplay mode: only enabled if at least one prompt is a custom (non-default) value.
        // The auto-generated default always contains "Engage in a thoughtful conversation about the following topic".
        // The roleplay template starts with "You are in a conversation. Your identity:".
        // Custom prompts are anything else.
        const isAutoDefault = (prompt) =>
            prompt && typeof prompt === 'string' &&
            prompt.includes('Engage in a thoughtful conversation about the following topic');
        const hasCustomPromptA = settings?.systemPromptA && !isAutoDefault(settings.systemPromptA);
        const hasCustomPromptB = settings?.systemPromptB && !isAutoDefault(settings.systemPromptB);
        const hasRoleplay = !!(hasCustomPromptA || hasCustomPromptB);

        if (this.roleplayCheckbox && this.roleplaySection) {
            this.roleplayCheckbox.checked = hasRoleplay;
            this.roleplaySection.style.display = hasRoleplay ? 'block' : 'none';
        }
    }

    _showNotification(message, variant = 'info') {
        const banner = document.createElement('nui-banner');
        banner.setAttribute('variant', variant);
        banner.textContent = message;
        document.body.appendChild(banner);
        setTimeout(() => banner.remove(), 5000);
    }

    _showError(message) {
        console.error('Arena error:', message);
        this._showNotification(message, 'error');
    }

    _updateParticipantModel(participant, newModelId) {
        if (!this.arena || !newModelId) return;

        if (participant === 'A' && this.arena.participantA) {
            this.arena.participantA.modelName = newModelId;
            this.arena.participantAConfig.modelName = newModelId;
            this.arena.participantA.name = newModelId.split('/').pop();
        } else if (participant === 'B' && this.arena.participantB) {
            this.arena.participantB.modelName = newModelId;
            this.arena.participantBConfig.modelName = newModelId;
            this.arena.participantB.name = newModelId.split('/').pop();
        }
    }

    _escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // ============================================
    // History Item Actions
    // ============================================

    async _exportArenaToFile(id) {
        try {
            const data = await arenaStorage.loadSession(id);
            if (!data) return;

            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);

            // v2 participants are objects; v1 strings. Handle both.
            const pA = typeof data.participants?.[0] === 'object'
                ? data.participants[0].model
                : data.participants?.[0];
            const pB = typeof data.participants?.[1] === 'object'
                ? data.participants[1].model
                : data.participants?.[1];
            const modelA = (pA || 'modelA').split('/').pop();
            const modelB = (pB || 'modelB').split('/').pop();
            const topic = (data.topic || data.chatInfo?.title || 'arena').replace(/[^a-z0-9]/gi, '_').toLowerCase().substring(0, 30);
            const date = new Date().toISOString().split('T')[0];

            const a = document.createElement('a');
            a.href = url;
            a.download = `arena-${topic}-${modelA}-vs-${modelB}-${date}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        } catch (err) {
            console.error('Failed to export arena:', err);
            this._showError('Failed to export arena');
        }
    }

    async _exportArenaMarkdown(id) {
        try {
            const data = await arenaStorage.loadSession(id);
            if (!data) return;

            let md = `# ${data.topic || 'Arena Conversation'}\n\n`;
            md += `*Participants: ${data.participants?.join(' vs ') || 'Unknown'}*\n\n`;
            md += `*Exported: ${new Date().toLocaleString()}*\n\n`;
            md += `---\n\n`;

            for (const msg of data.messages || []) {
                if (msg.speaker === 'moderator') {
                    md += `**${msg.speaker}:** *${msg.content}*\n\n`;
                } else {
                    md += `**${msg.speaker}:**\n${msg.content}\n\n`;
                }
            }

            const blob = new Blob([md], { type: 'text/markdown' });
            const url = URL.createObjectURL(blob);

            const topic = (data.topic || 'arena').replace(/[^a-z0-9]/gi, '_').toLowerCase().substring(0, 30);
            const a = document.createElement('a');
            a.href = url;
            a.download = `arena-${topic}-${Date.now()}.md`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        } catch (err) {
            console.error('Failed to export markdown:', err);
            this._showError('Failed to export markdown');
        }
    }

    _exportMarkdown() {
        if (!this.arena) {
            this._showError('No active arena to export');
            return;
        }
        if (!this.arena.summary) {
            this._showError('No summary available. Generate a summary first.');
            return;
        }
        const summary = this.arena.summary;
        this._exportMarkdownFromDialog(summary.teaser || '', summary.reflection || '', summary.title || '');
    }

    _exportMarkdownFromDialog(teaser, reflection, title) {
        if (!this.arena) {
            this._showError('No active arena to export');
            return;
        }

        const participantA = this.arena.participantA?.name || 'Participant A';
        const participantB = this.arena.participantB?.name || 'Participant B';
        const date = new Date().toISOString().split('T')[0];
        const arenaId = this.arena.id || 'unknown';
        const topic = this.arena.messages[0]?.content.replace('Topic: ', '').split('\n\n[')[0] || '';

        let markdown = `# ${title || 'Untitled Conversation'}

**Date:** ${date}
**Arena ID:** ${arenaId}
**Participants:** ${participantA}, ${participantB}

## Topic (Setup)

${topic || '*No topic provided*'}

---

## Teaser

${teaser || '*No teaser available.*'}

---

## Reflection

${reflection || '*No reflection available.*'}

---

*Exported from Chat Arena*
`;

        const blob = new Blob([markdown], { type: 'text/markdown' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${title?.replace(/[^a-z0-9]/gi, '_').toLowerCase() || 'conversation'}_${date}.md`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        this._showNotification('Markdown exported', 'success');
    }

    async _deleteArena(id, e) {
        e.stopPropagation();

        // Skip confirmation on shift-click
        const skipConfirm = e.shiftKey;

        if (!skipConfirm) {
            const confirmed = await nui.components.dialog.confirm('Delete Arena', 'Are you sure you want to delete this arena conversation?');
            if (!confirmed) return;
        }

        try {
            await arenaStorage.deleteSession(id);
            await arenaStorage.removeFromHistory(id);

            // If we're currently viewing this arena, reset to setup view
            if (this.arena && this.arena.id === id) {
                this._showSetupView();
            } else {
                // Just refresh the history list
                this._loadHistory();
            }

            this._showNotification('Arena deleted', 'success');
        } catch (err) {
            console.error('Failed to delete arena:', err);
            this._showError('Failed to delete arena');
        }
    }
}

// ============================================
// Initialize
// ============================================

let arenaUI;

document.addEventListener('DOMContentLoaded', async () => {
    arenaUI = new ArenaUI();
    window.arenaUI = arenaUI;
    await arenaUI.init();
});

export { Arena, Participant, ArenaUI };

