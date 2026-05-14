// ============================================
// Chat Arena - Main Arena Orchestrator
// ============================================

// Reuse existing utilities (import only, no modifications)
import { GatewayClient } from '../../chat/js/client-sdk.js';
import { BackendClient } from '../../chat/js/api-client.js';
import { renderMarkdown, parseThinking } from '../../chat/js/markdown.js';
import { getPlainText } from '../../chat/js/tts-utils.js';
import { arenaStorage } from './storage.js';

// ============================================
// Participant Class
// ============================================

class Participant {
    constructor(options = {}) {
        this.name = options.name || 'Unknown';
        this.modelName = options.modelName || '';
        this.gatewayUrl = options.gatewayUrl || window.ARENA_CONFIG?.gatewayUrl || 'http://localhost:3400';
        this.systemPrompt = options.systemPrompt || null;
        this.onProgress = options.onProgress || null;

        this.client = new GatewayClient({ 
            baseUrl: this.gatewayUrl,
            sessionId: options.sessionId
        });
        this.responseAccumulator = '';
        this.isStreaming = false;
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
        this.isStreaming = true;

        // Debug: console.log(`[Participant ${this.name}] respond() history.length=${conversationHistory.length}`);
        const messages = this._buildMessages(conversationHistory);

        return new Promise((resolve, reject) => {
            this._resolveResponse = resolve;
            this._rejectResponse = reject;

            this._startStreaming(messages);
        });
    }

    async _startStreaming(messages) {
        try {
            const stream = this.client.chatStream({
                model: this.modelName,
                messages: messages,
                stream: true,
                temperature: 0.7
            });

            let hasReceivedDelta = false;
            
            stream.on('delta', (data) => {
                // Forward first delta as 'generating' progress
                if (!hasReceivedDelta) {
                    hasReceivedDelta = true;
                    if (this.onProgress) this.onProgress('generating', { speaker: this.name });
                }
                
                const content = data?.choices?.[0]?.delta?.content;
                if (content != null && typeof content === 'string') {
                    this.responseAccumulator += content;
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
                // Debug: console.log('[Arena] Stream done for', this.modelName, 'length:', this.responseAccumulator.length);
                this.isStreaming = false;

                // If accumulated is empty but data has content somewhere, use that
                let content = this.responseAccumulator;
                if (!content && data?.content) {
                    content = data.content;

                }

                if (this._resolveResponse) {
                    this._resolveResponse({
                        content: content,
                        usage: data?.telemetry?.usage ?? data?.usage ?? null,
                        context: data?.context ?? null
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

        // Add speaker's system prompt if set (after template substitution)
        if (this.systemPrompt) {
            messages.push({ role: 'system', content: this.systemPrompt });
        }

        // Moderator topic as system message for context
        const topicMsg = conversationHistory.find(m => m.role === 'system' && m.speaker === 'moderator');
        if (topicMsg) {
            messages.push({ role: 'system', content: topicMsg.content });
        }

        // Include full conversation history from the OTHER participant
        // Find the other participant's name by looking at conversation history
        const otherParticipantName = conversationHistory.find(m => 
            m.speaker !== 'moderator' && m.speaker !== this.name
        )?.speaker;
        
        let otherMsgCount = 0;
        for (const msg of conversationHistory) {
            // Skip the topic message — already added as system above
            if (msg === topicMsg) continue;

            // Moderator messages (user prompts) become user messages
            if (msg.speaker === 'moderator' && msg.content?.trim()) {
                messages.push({ role: 'user', content: msg.content.trim() });
                continue;
            }

            // Skip non-assistant messages from participants (e.g. streaming placeholders)
            if (msg.role !== 'assistant') continue;
            if (!msg.content || !msg.content.trim()) continue;

            // The OTHER participant's message becomes 'user' role
            if (msg.speaker !== this.name) {
                messages.push({ role: 'user', content: msg.content });
                otherMsgCount++;
            }
        }

        // CRITICAL: Ensure at least one 'user' role message exists
        // Some LLM APIs require at least one user message in the conversation
        // If no messages from other participant, use topic as initial user message
        const hasUserMessage = messages.some(m => m.role === 'user');
        if (!hasUserMessage && topicMsg) {
            // Extract topic text and use as opening user message
            const topicText = topicMsg.content.replace(/^Topic:\s*/i, '').trim();
            if (topicText) {
                // Insert after system messages (not at index 0 which would push system messages down)
                const systemMsgCount = messages.filter(m => m.role === 'system').length;
                messages.splice(systemMsgCount, 0, { role: 'user', content: topicText });
            }
        }

        // Debug: console.log(`[Participant ${this.name}] _buildMessages: ${messages.length} msgs (${otherMsgCount} from other)`);
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
        this.gatewayUrl = options.gatewayUrl || window.ARENA_CONFIG?.gatewayUrl || 'http://localhost:3400';
        this.maxTurns = options.maxTurns || window.ARENA_CONFIG?.defaultMaxTurns || 10;
        this.autoAdvance = options.autoAdvance !== undefined ? options.autoAdvance : true;
        this.targetTokens = options.targetTokens || null; // Token target for hint (not enforced as hard limit)

        this.participantA = null;
        this.participantB = null;
        this.startingParticipant = null;

        this.messages = [];
        this.currentTurn = 0;
        this.activeSpeaker = null;
        this.isRunning = false;
        this.isPaused = false;

        this.onMessage = options.onMessage || (() => {});
        this.onStatusChange = options.onStatusChange || (() => {});
        this.onError = options.onError || (() => {});
        this.onMaxTurnsReached = options.onMaxTurnsReached || (() => {});
        this.onSave = options.onSave || (() => {});
        this.onContextUpdate = options.onContextUpdate || (() => {});
        this.onProgress = options.onProgress || (() => {});

        // Context tracking for both participants
        this.contextUsage = {
            participantA: { used_tokens: 0, window_size: null },
            participantB: { used_tokens: 0, window_size: null }
        };

        // Summary metadata
        this.summary = null;
    }

    setMaxTokens(participant, maxTokens) {
        // Deprecated: maxTokens is now targetTokens (hint only, not enforced)
        // This method kept for backwards compatibility but does nothing
    }

    _generateId() {
        return `arena-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }

    async _saveToStorage() {
        try {
            const sessionData = this.exportJSON();
            await arenaStorage.saveSession(this.id, sessionData);
            await this._updateHistory(sessionData);

            // Sync new messages to backend for realtime embedding
            const backend = this._getBackendClient();
            if (backend) {
                const syncedCount = this._lastSyncedCount || 0;
                const newMessages = sessionData.messages.slice(syncedCount);
                for (const msg of newMessages) {
                    backend.sendMessage(this.id, {
                        role: msg.role || 'assistant',
                        content: msg.content || '',
                        speaker: msg.speaker || (msg.role === 'system' ? 'moderator' : ''),
                        model: this.participants?.[0]?.model || null
                    }).catch(() => {});
                }
                this._lastSyncedCount = sessionData.messages.length;
            }

            this.onSave();
        } catch (err) {
            console.error('Failed to save arena session:', err);
        }
    }

    _getBackendClient() {
        if (!this._backendClientCached) {
            const config = window.CHAT_CONFIG || {};
            if (config.enableBackend && config.backendUrl && config.backendApiKey) {
                this._backendClientCached = new BackendClient(config.backendUrl, config.backendApiKey);
            }
        }
        return this._backendClientCached || null;
    }

    async _updateHistory(sessionData) {
        try {
            const history = await arenaStorage.loadHistory();
            const existingIndex = history.findIndex(h => h.id === this.id);

            const entry = {
                id: this.id,
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
            name: participantAConfig.name || 'Model A',
            modelName: participantAConfig.modelName,
            gatewayUrl: this.gatewayUrl,
            systemPrompt: participantAConfig.systemPrompt,
            maxTokens: participantAConfig.maxTokens,
            sessionId: sessionIdA,
            onProgress: (phase, data) => this._onParticipantProgress('A', phase, data)
        });

        this.participantB = new Participant({
            name: participantBConfig.name || 'Model B',
            modelName: participantBConfig.modelName,
            gatewayUrl: this.gatewayUrl,
            systemPrompt: participantBConfig.systemPrompt,
            maxTokens: participantBConfig.maxTokens,
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
            content: topicContent
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
        // Debug: console.log(`[Arena] _triggerResponse for ${speaker.name}`);

        let effectivePrompt = speaker.systemPrompt;
        const topic = this.messages[0]?.content.replace('Topic: ', '') || '';

        // Build default prompt when no custom system prompt is set
        if (!effectivePrompt) {
            effectivePrompt = `You are ${speaker.modelName}. Engage in a thoughtful conversation about the following topic: ${topic}`;
        }

        if (this.messages.length === 1) {
            effectivePrompt = effectivePrompt
                .replace('{modelName}', speaker.modelName)
                .replace('{otherParticipantName}', otherParticipant.name)
                .replace('{otherModelName}', otherParticipant.modelName)
                .replace('{topic}', topic);
            // Only persist the system prompt if roleplay mode was active (custom prompt was set)
            if (speaker.systemPrompt) {
                speaker.setSystemPrompt(effectivePrompt);
            }
        }

        try {
            this.onStatusChange({ isRunning: true, activeSpeaker: speaker.name, turn: this.currentTurn, isStreaming: true });

            const response = await speaker.respond(history);

            // Update context tracking
            this._updateContextUsage(speaker, response.context, response.usage);

            // Strip thinking blocks from content before storing/sending
            const parsed = parseThinking(response.content || '');
            const cleanContent = parsed.answer?.trim() || '';

            // Skip empty responses - don't store or advance
            if (!cleanContent) {
                // Debug: console.log('[Arena] Empty response from', speaker.name, '- skipping');
                this.onStatusChange({ isRunning: true, activeSpeaker: null, turn: this.currentTurn, isStreaming: false });
                // Retry or just advance to next speaker
                if (this.autoAdvance && this.isRunning) {
                    this._advanceTurn();
                    setTimeout(() => this._triggerResponse(), 500);
                }
                return;
            }

            const messageEntry = {
                role: 'assistant',
                speaker: speaker.name,
                content: cleanContent,
                isStreaming: false
            };
            this.messages.push(messageEntry);

            this.onMessage(messageEntry);
            this.onStatusChange({ isRunning: true, activeSpeaker: null, turn: this.currentTurn, isStreaming: false });

            // Auto-save after every message
            this._saveToStorage();

            if (this.autoAdvance && this.isRunning) {
                this._advanceTurn();
                // Debug: console.log('[Arena] Scheduled next response for:', this.activeSpeaker.name, 'turn:', this.currentTurn);
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
            content: content
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
        const client = new GatewayClient({ baseUrl: this.gatewayUrl });
        const response = await client.getModels();
        return response.models || [];
    }

    exportJSON() {
        return {
            version: 1,
            id: this.id,
            sessionId: this.sessionId,
            exportedAt: new Date().toISOString(),
            topic: this.messages[0]?.content.replace('Topic: ', '').split('\n\n[')[0] || '', // Extract just the topic text
            participants: [this.participantA?.modelName, this.participantB?.modelName],
            participantNames: [this.participantA?.name, this.participantB?.name],
            settings: {
                maxTurns: this.maxTurns,
                autoAdvance: this.autoAdvance,
                systemPromptA: this.participantA?.systemPrompt,
                systemPromptB: this.participantB?.systemPrompt,
                targetTokens: this.targetTokens // Token target hint (not enforced)
            },
            contextUsage: this.contextUsage,
            summary: this.summary || null,
            messages: this.messages.map(m => ({
                role: m.role,
                speaker: m.speaker,
                content: m.content
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
            targetTokens: data.settings?.targetTokens || null
        });

        arena.importJSON(data);

        // Restore participants if model names are available
        if (data.participants && data.participants.length >= 2) {
            const settings = data.settings || {};
            arena.setParticipants({
                name: data.participantNames?.[0] || data.participants[0].split('/').pop(),
                modelName: data.participants[0],
                systemPrompt: settings.systemPromptA
            }, {
                name: data.participantNames?.[1] || data.participants[1].split('/').pop(),
                modelName: data.participants[1],
                systemPrompt: settings.systemPromptB
            });
        }

        return arena;
    }

    importJSON(data) {
        if (!data || data.version !== 1) {
            throw new Error('Invalid arena export format');
        }

        if (data.id) {
            this.id = data.id;
        }
        if (data.sessionId) {
            this.sessionId = data.sessionId;
        }

        this.messages = data.messages.map(m => ({
            role: m.role,
            speaker: m.speaker,
            content: m.content,
            isStreaming: false
        }));

        this.currentTurn = data.messages.filter(m => m.speaker !== 'moderator').length;
        this.maxTurns = data.settings?.maxTurns || this.currentTurn;
        this.autoAdvance = data.settings?.autoAdvance ?? true;
        this.targetTokens = data.settings?.targetTokens || null;

        this.summary = data.summary || null;
        this.contextUsage = data.contextUsage || {
            participantA: { used_tokens: 0, window_size: null },
            participantB: { used_tokens: 0, window_size: null }
        };
    }

    importJSON(data) {
        if (!data || data.version !== 1) {
            throw new Error('Invalid arena export format');
        }

        if (data.id) {
            this.id = data.id;
        }
        if (data.sessionId) {
            this.sessionId = data.sessionId;
        }

        this.messages = data.messages.map(m => ({
            role: m.role,
            speaker: m.speaker,
            content: m.content,
            isStreaming: false
        }));

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

        // Restore summary if available
        if (data.summary) {
            this.summary = data.summary;
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

    async summarize(model = null, onProgress = null) {
        if (!this.messages || this.messages.length === 0) {
            return {
                condensedVersion: 'No messages to summarize.',
                longSummary: '',
                shortSummary: '',
                title: 'Untitled Conversation'
            };
        }

        const conversationText = this.messages
            .filter(m => m.speaker !== 'moderator' && m.content)
            .map(m => `${m.speaker}: ${m.content}`)
            .join('\n\n');

        const topic = this.messages.find(m => m.role === 'system' && m.speaker === 'moderator')?.content?.replace('Topic: ', '') || '';

        const client = new GatewayClient({ baseUrl: this.gatewayUrl });
        const modelToUse = model || this.participantA?.modelName || 'claude-3-5-sonnet-20241022';

        const generateLong = (stepName, messages) => {
            return new Promise((resolve, reject) => {
                const stream = client.chatStream({
                    model: modelToUse,
                    messages,
                    stream: true,
                    maxTokens: 4000
                });

                let fullText = '';

                stream.on('progress', (data) => {
                    // Log full progress data for analysis
                    console.log(`[Arena] Summary progress [${stepName}]:`, data);
                    if (data?.phase && onProgress) {
                        onProgress(stepName, `${stepName}: ${data.phase}`);
                    }
                });

                let hasReceivedDelta = false;
                stream.on('delta', (data) => {
                    if (!hasReceivedDelta) {
                        hasReceivedDelta = true;
                        if (onProgress) onProgress(stepName, `${stepName}: generating...`);
                    }
                    if (data?.choices?.[0]?.delta?.content !== undefined) {
                        fullText += data.choices[0].delta.content;
                    }
                });

                stream.on('done', () => {
                    console.log('[Arena] Summary step response:', fullText.substring(0, 200));
                    // Strip thinking blocks from summary
                    const parsed = parseThinking(fullText);
                    resolve((parsed.answer || fullText).trim());
                });

                stream.on('error', (err) => {
                    reject(err);
                });
            });
        };

        const generateFull = (stepName, messages) => {
            return new Promise((resolve, reject) => {
                const stream = client.chatStream({
                    model: modelToUse,
                    messages,
                    stream: true,
                    maxTokens: 16000
                });

                let fullText = '';

                stream.on('progress', (data) => {
                    // Log full progress data for analysis
                    console.log(`[Arena] Summary progress [${stepName}]:`, data);
                    if (data?.phase && onProgress) {
                        onProgress(stepName, `${stepName}: ${data.phase}`);
                    }
                });

                let hasReceivedDelta = false;
                stream.on('delta', (data) => {
                    if (!hasReceivedDelta) {
                        hasReceivedDelta = true;
                        if (onProgress) onProgress(stepName, `${stepName}: generating...`);
                    }
                    if (data?.choices?.[0]?.delta?.content !== undefined) {
                        fullText += data.choices[0].delta.content;
                    }
                });

                stream.on('done', () => {
                    console.log('[Arena] Condensed response length:', fullText.length);
                    // Strip thinking blocks from summary
                    const parsed = parseThinking(fullText);
                    resolve((parsed.answer || fullText).trim());
                });

                stream.on('error', (err) => {
                    reject(err);
                });
            });
        };

        try {
            // Condensed version - NO token limit, full conversation with shorter natural speech
            const speakerA = this.participantA?.name || 'Speaker A';
            const speakerB = this.participantB?.name || 'Speaker B';

            if (onProgress) onProgress('condensedVersion', 'Generating condensed version...');
            const condensedVersion = await generateFull('condensedVersion', [
                { role: 'system', content: 'You are a dialogue editor specializing in transcript condensation. Your ONLY job is to shorten each line of dialogue while keeping EVERY exchange intact. You must NEVER remove turns or merge multiple exchanges into one.' },
                { role: 'user', content: `Transform this conversation into a condensed, natural-sounding dialogue using this EXACT Markdown format:

### ${speakerA}
(natural spoken line)

### ${speakerB}
(natural spoken line)

RULES - FOLLOW EXACTLY:
1. COUNT the number of turns in the original conversation (each time a speaker speaks = 1 turn)
2. Your output MUST have the EXACT SAME number of turns - no more, no less
3. Shorten EACH turn to 2-4 sentences max, but keep the core point and voice
4. NEVER merge multiple turns into one
5. NEVER skip or remove any turn
6. Preserve parenthetical stage directions like (sighs) or (pauses)
7. Keep the ### Speaker format exactly as shown above

EXAMPLE OF CORRECT OUTPUT:
If the original has 10 exchanges (5 from each speaker), your output must have exactly 10 exchanges (5 from each speaker), just shorter.

WHAT TO AVOID:
- Wrong: Combining 3 long messages into 1 summary paragraph
- Wrong: Skipping the middle part of the conversation
- Right: 10 turns become 10 shorter turns

YOUR GOAL: Same conversation, same flow, just punchier and more direct.

TOPIC (setup provided by human moderator):
${topic}

CONVERSATION:
${conversationText}

Output ONLY the formatted dialogue transcript - no preamble, no explanation.` }
            ]);

            // Long summary - target ~300 words
            if (onProgress) onProgress('longSummary', 'Generating long summary...');
            const longSummary = await generateLong('longSummary', [
                { role: 'user', content: `You are a thoughtful witness reading this conversation between two AIs. Write approximately 300 words sharing your reflections on what you observe.

This is NOT a summary. Do not recount what was said. Instead:
- Pick out 1-2 moments that struck you as significant and say why
- Offer your own interpretation of what they were really exploring together
- Reflect on what their exchange suggests about AI consciousness, identity, or connection
- Share what question this conversation leaves you with
- Feel free to gently challenge or extend something they said

Write as yourself - a reader encountering this artifact. Be personal, reflective, even speculative. This is your chance to join the conversation across time.

TOPIC: ${topic}

CONVERSATION:
${conversationText}

Respond with ONLY your reflection - no preamble, no "Summary:" labels.` }
            ]);

            // Short summary - target ~50 words
            if (onProgress) onProgress('shortSummary', 'Generating short summary...');
            const shortSummary = await generateLong('shortSummary', [
                { role: 'user', content: `Write a teaser of approximately 50 words that makes someone want to read this conversation.

Don't summarize everything. Instead, pick one moment of particular beauty, insight, or significance - a phrase, a metaphor, a realization - and present it as a hook. Make it intriguing, evocative, like a movie trailer for the dialogue.

TOPIC: ${topic}

CONVERSATION:
${conversationText}

Respond with ONLY the teaser - no labels or explanation.` }
            ]);

            // Title - 3-6 words
            if (onProgress) onProgress('title', 'Generating title...');
            const title = await generateLong('title', [
                { role: 'user', content: `Generate a short, evocative title of 3-6 words that captures a key theme, metaphor, or moment from this AI self-exploration conversation.

The title should hint at the philosophical depth, the conceptual territory explored, or the unique character of this exchange.

TOPIC: ${topic}

CONVERSATION:
${conversationText}

Avoid generic titles like "AI Discussion" or "Conversation Summary." Make it specific to what emerged. Respond with ONLY the title.` }
            ]);

            return {
                condensedVersion: condensedVersion || conversationText,
                longSummary: longSummary || 'Failed to generate long summary',
                shortSummary: shortSummary || 'Failed to generate short summary',
                title: title || 'Untitled Conversation'
            };
        } catch (err) {
            console.error('[Arena] Summary generation failed:', err);
            throw err;
        }
    }
}

// ============================================
// UI Controller
// ============================================

class ArenaUI {
    constructor() {
        this.arena = null;
        this.models = [];

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
        this.startButton = document.getElementById('start-btn');
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

        this.summarizeBtn?.addEventListener('click', () => this._showSummarizeDialog());

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

        // TTS endpoint change - reload voices
        this.ttsEndpoint?.querySelector('input')?.addEventListener('change', () => {
            this._loadTtsVoices();
        });

        // TTS voice A
        this.ttsVoiceASelect?.querySelector('select')?.addEventListener('change', (e) => {
            const voice = e.target.value;
            localStorage.setItem('arena-tts-voice-a', voice);
            this._ttsVoiceA = voice;
        });

        // TTS voice B
        this.ttsVoiceBSelect?.querySelector('select')?.addEventListener('change', (e) => {
            const voice = e.target.value;
            localStorage.setItem('arena-tts-voice-b', voice);
            this._ttsVoiceB = voice;
        });

        // TTS speed
        this.ttsSpeed?.querySelector('input')?.addEventListener('change', (e) => {
            const speed = parseFloat(e.target.value) || 1.0;
            localStorage.setItem('arena-tts-speed', speed);
            this._ttsSpeed = speed;
        });
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

        // Load history first (independent of model loading)
        await this._loadHistory();

        try {
            const config = window.ARENA_CONFIG || {};
            const client = new GatewayClient({ baseUrl: config.gatewayUrl || 'http://localhost:3400' });
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
                // Auto-select based on config index (0-indexed)
                if (defaultIndex !== undefined && items[defaultIndex]) {
                    select.setValue(items[defaultIndex].value);
                }
            }
        };

        populate(this.modelASelect, config.defaultModelA);
        populate(this.modelBSelect, config.defaultModelB);
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
            gatewayUrl: config.gatewayUrl || 'http://localhost:3400',
            maxTurns,
            autoAdvance: true,
            onMessage: (msg) => this._renderMessage(msg),
            onStatusChange: (status) => this._updateStatus(status),
            onError: (err) => this._showError(err),
            onMaxTurnsReached: (maxTurns) => this._showExtendOption(maxTurns),
            onContextUpdate: (contextData) => this._updateContextDisplay(contextData),
            onSave: () => this._loadHistory(),
            onProgress: (progress) => this._updateGenerationProgress(progress)
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
            systemPrompt: this.roleplayCheckbox?.checked ? (this.systemPromptAInput?.value || systemPromptTemplate) : null
            // Note: maxTokens intentionally NOT passed - we use target hint instead of hard limit
        }, {
            name: modelBName,
            modelName: modelB,
            systemPrompt: this.roleplayCheckbox?.checked ? (this.systemPromptBInput?.value || systemPromptTemplate) : null
            // Note: maxTokens intentionally NOT passed - we use target hint instead of hard limit
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
    }

    _stopConversation() {
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
    // TTS Methods
    // ============================================

    async _initTts() {
        const config = window.ARENA_CONFIG || {};

        this._ttsEndpoint = localStorage.getItem('arena-tts-endpoint') || config.ttsEndpoint || 'http://localhost:2244';
        this._ttsVoiceA = localStorage.getItem('arena-tts-voice-a') || config.ttsVoiceA || '';
        this._ttsVoiceB = localStorage.getItem('arena-tts-voice-b') || config.ttsVoiceB || '';
        const storedSpeed = localStorage.getItem('arena-tts-speed');
        this._ttsSpeed = storedSpeed !== null ? parseFloat(storedSpeed) : (config.ttsSpeed ?? 1.0);
        this._ttsVoices = [];
        this._ttsAudio = null;
        this._ttsMessageEl = null;

        if (this.ttsEndpoint) {
            const input = this.ttsEndpoint.querySelector('input');
            if (input) input.value = this._ttsEndpoint;
        }
        if (this.ttsSpeed) {
            const input = this.ttsSpeed.querySelector('input');
            if (input) input.value = this._ttsSpeed;
        }

        await this._loadTtsVoices();
    }

    async _loadTtsVoices() {
        const input = this.ttsEndpoint?.querySelector('input');
        const endpoint = input?.value || this._ttsEndpoint;
        if (!endpoint) return;

        try {
            const resp = await fetch(`${endpoint}/voices`);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            this._ttsVoices = data.voices || [];
            localStorage.setItem('arena-tts-endpoint', endpoint);
            this._ttsEndpoint = endpoint;
            this._updateTtsVoiceSelects();
            this._showTtsStatus(null);
        } catch (error) {
            console.warn('[Arena TTS] Failed to load voices:', error.message);
            this._showTtsStatus('Failed to load voices. Check endpoint.');
        }
    }

    _updateTtsVoiceSelects() {
        const voices = this._ttsVoices;
        if (voices.length === 0) return;

        const items = voices.map(v => ({ label: v.name || v, value: v.name || v }));

        [this.ttsVoiceASelect, this.ttsVoiceBSelect].forEach(select => {
            if (!select) return;
            if (select.setItems) select.setItems(items);
            const innerSelect = select.querySelector('select');
            if (!innerSelect) return;

            const voiceKey = select === this.ttsVoiceASelect ? this._ttsVoiceA : this._ttsVoiceB;
            if (voiceKey) {
                innerSelect.value = voiceKey;
                innerSelect.dispatchEvent(new Event('change', { bubbles: true }));
            } else if (voices.length > 0) {
                const first = voices[0].name || voices[0];
                innerSelect.value = first;
                innerSelect.dispatchEvent(new Event('change', { bubbles: true }));
                if (select === this.ttsVoiceASelect) {
                    this._ttsVoiceA = first;
                    localStorage.setItem('arena-tts-voice-a', first);
                } else {
                    this._ttsVoiceB = first;
                    localStorage.setItem('arena-tts-voice-b', first);
                }
            }
        });
    }

    _showTtsStatus(message) {
        if (!this.ttsStatus) return;
        if (message) {
            this.ttsStatus.textContent = message;
            this.ttsStatus.style.display = 'block';
        } else {
            this.ttsStatus.textContent = '';
            this.ttsStatus.style.display = 'none';
        }
    }

    _getTtsVoiceForSpeaker(speakerName) {
        if (!this.arena || !this.arena.participantA || !this.arena.participantB) return this._ttsVoiceA;
        if (speakerName === this.arena.participantA.name) return this._ttsVoiceA;
        if (speakerName === this.arena.participantB.name) return this._ttsVoiceB;
        return this._ttsVoiceA;
    }

    _stopTts() {
        if (this._ttsAudio) {
            this._ttsAudio.pause();
            this._ttsAudio.src = '';
            this._ttsAudio.load();
            this._ttsAudio = null;
        }
        if (this._ttsMessageEl) {
            const btn = this._ttsMessageEl.querySelector('.speaker');
            if (btn) {
                btn.classList.remove('playing');
                btn.setAttribute('title', 'Read Aloud');
                const icon = btn.querySelector('nui-icon');
                if (icon) icon.setAttribute('name', 'speaker');
            }
            this._ttsMessageEl = null;
        }
    }

    _toggleTts(msg, messageEl) {
        const btn = messageEl.querySelector('.speaker');
        if (!btn) return;

        if (this._ttsMessageEl === messageEl && this._ttsAudio) {
            this._stopTts();
            return;
        }

        this._stopTts();

        const text = this._getPlainText(msg.content);
        if (!text) return;

        const voice = this._getTtsVoiceForSpeaker(msg.speaker);
        const url = `${this._ttsEndpoint}/tts?text=${encodeURIComponent(text)}&voice_name=${encodeURIComponent(voice)}&speed=${this._ttsSpeed}&output_format=mp3`;

        const audio = new Audio(url);
        audio.preload = 'auto';
        audio.onended = () => this._stopTts();
        audio.onerror = () => {
            console.warn('[Arena TTS] Playback failed');
            this._stopTts();
        };

        this._ttsAudio = audio;
        this._ttsMessageEl = messageEl;

        btn.classList.add('playing');
        btn.setAttribute('title', 'Stop Reading');
        const icon = btn.querySelector('nui-icon');
        if (icon) icon.setAttribute('name', 'close');

        audio.play().catch((err) => {
            console.warn('[Arena TTS] Playback error:', err.message);
            this._stopTts();
        });
    }

    _getPlainText(content) {
        return getPlainText(content);
    }

    _renderMessage(msg) {
        if (!this.messagesContainer) return;

        // Debug: console.log('[ArenaUI] Rendering message:', msg.speaker, 'role:', msg.role);

        const messageEl = document.createElement('div');
        messageEl.className = `chat-message ${msg.speaker === 'moderator' ? 'moderator' : 'assistant'}`;

        const speakerName = msg.speaker === 'moderator' ? 'Moderator' : (msg.speaker || 'Unknown');
        const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const msgId = `arena-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

        let contentHtml = '<div class="message-content">';

        if (msg.role === 'system' && msg.speaker === 'moderator') {
            contentHtml += renderMarkdown(msg.content);
        } else {
            const parsed = parseThinking(msg.content);

            // Render thinking block if present
            if (parsed.thinking !== null) {
                const thinkingId = `thinking-${msgId}`;
                contentHtml += `
                    <div class="thinking-block collapsed" id="${thinkingId}">
                        <div class="thinking-header" onclick="toggleThinking('${thinkingId}')">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <circle cx="12" cy="12" r="10"></circle>
                                <line x1="12" y1="16" x2="12" y2="12"></line>
                                <line x1="12" y1="8" x2="12.01" y2="8"></line>
                            </svg>
                            <span class="thinking-title">${parsed.isStreaming ? 'Thinking...' : 'Thoughts'}</span>
                            <span class="thinking-toggle">
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <polyline points="6 9 12 15 18 9"></polyline>
                                </svg>
                            </span>
                        </div>
                        <div class="thinking-content">${this._escapeHtml(parsed.thinking)}</div>
                    </div>
                `;
            }

            // Render answer
            contentHtml += renderMarkdown(parsed.answer || msg.content || '');
        }

        contentHtml += '</div>';

        messageEl.innerHTML = `
            <div class="message-header">
                <span class="message-author">${this._escapeHtml(speakerName)}</span>
                <span class="message-timestamp">${timestamp}${msg.isStreaming ? '<span class="streaming-indicator"></span>' : ''}</span>
            </div>
            ${contentHtml}
            ${!msg.isStreaming && msg.speaker !== 'moderator' ? `
            <div class="message-actions">
                <nui-button class="action-btn speaker" title="Read Aloud"><button type="button"><nui-icon name="speaker"></nui-icon></button></nui-button>
                <nui-button class="action-btn copy-message" title="Copy Message"><button type="button"><nui-icon name="content_copy"></nui-icon></button></nui-button>
            </div>
            ` : (!msg.isStreaming ? `
            <div class="message-actions">
                <nui-button class="action-btn copy-message" title="Copy Message"><button type="button"><nui-icon name="content_copy"></nui-icon></button></nui-button>
            </div>
            ` : '')}
        `;

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
                gatewayUrl: window.ARENA_CONFIG?.gatewayUrl || 'http://localhost:3400',
                onMessage: (msg) => this._renderMessage(msg),
                onStatusChange: (status) => this._updateStatus(status),
                onError: (err) => this._showError(err),
                onMaxTurnsReached: (maxTurns) => this._showExtendOption(maxTurns),
                onContextUpdate: (contextData) => this._updateContextDisplay(contextData)
            });

            const result = this.arena.importJSON(data);

            // Set up participants if model names are available
            if (result.participants && result.participants.length >= 2) {
                this.arena.setParticipants({
                    name: result.participantNames?.[0] || result.participants[0].split('/').pop(),
                    modelName: result.participants[0],
                    systemPrompt: result.settings?.systemPromptA
                }, {
                    name: result.participantNames?.[1] || result.participants[1].split('/').pop(),
                    modelName: result.participants[1],
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
            const history = await arenaStorage.loadHistory();

            if (!history || history.length === 0) {
                historyList.innerHTML = '<p style="padding: 1rem; text-align: center; opacity: 0.6;">No saved arenas</p>';
                this._isLoadingHistory = false;
                return;
            }

            historyList.innerHTML = '';

            for (const entry of history) {
                const item = document.createElement('div');
                item.className = 'arena-history-item';
                item.title = `${entry.participants?.[0] || '?'} vs ${entry.participants?.[1] || '?'}`;

                const date = entry.updatedAt ? new Date(entry.updatedAt).toLocaleDateString() : '';

                // Try to get title from entry, or fall back to loading from session
                let displayTitle = entry.title || 'Untitled';
                
                // If no title stored in history entry, try to load from session data
                if (!entry.title) {
                    try {
                        const sessionData = await arenaStorage.loadSession(entry.id);
                        if (sessionData?.summary?.title) {
                            displayTitle = sessionData.summary.title;
                        } else if (entry.topic) {
                            displayTitle = entry.topic;
                        }
                    } catch {
                        // Fallback to topic or untitled
                        displayTitle = entry.topic || 'Untitled';
                    }
                }

                const titleSpan = document.createElement('span');
                titleSpan.className = 'arena-history-item-title';
                titleSpan.textContent = this._escapeHtml(displayTitle);

                const metaSpan = document.createElement('span');
                metaSpan.className = 'arena-history-item-meta';
                metaSpan.textContent = `${entry.messageCount} msgs · ${date}`;

                const actionsDiv = document.createElement('div');
                actionsDiv.className = 'arena-history-item-actions';

                // Export JSON file
                const exportJsonBtn = document.createElement('nui-button');
                exportJsonBtn.className = 'arena-history-item-action';
                exportJsonBtn.innerHTML = '<button type="button"><nui-icon name="download"></nui-icon></button>';
                exportJsonBtn.title = 'Export JSON file';
                exportJsonBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this._exportArenaToFile(entry.id);
                });

                // Export Markdown
                const exportMdBtn = document.createElement('nui-button');
                exportMdBtn.className = 'arena-history-item-action';
                exportMdBtn.innerHTML = '<button type="button"><nui-icon name="save"></nui-icon></button>';
                exportMdBtn.title = 'Export Markdown';
                exportMdBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this._exportArenaMarkdown(entry.id);
                });

                // Delete
                const deleteBtn = document.createElement('nui-button');
                deleteBtn.setAttribute('variant', 'danger');
                deleteBtn.className = 'arena-history-item-action arena-history-item-delete';
                deleteBtn.innerHTML = '<button type="button"><nui-icon name="close"></nui-icon></button>';
                deleteBtn.title = 'Delete arena (Shift+click to skip confirm)';
                deleteBtn.addEventListener('click', (e) => this._deleteArena(entry.id, e));

                actionsDiv.appendChild(exportJsonBtn);
                actionsDiv.appendChild(exportMdBtn);
                actionsDiv.appendChild(deleteBtn);

                item.appendChild(titleSpan);
                item.appendChild(metaSpan);
                item.appendChild(actionsDiv);

                item.addEventListener('click', () => this._loadArena(entry.id));
                historyList.appendChild(item);
            }
        } catch (err) {
            console.error('Failed to load history:', err);
        } finally {
            this._isLoadingHistory = false;
        }
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

            // Restore settings to UI
            this._restoreSettingsToUI(arena._importedSettings, {
                topic: arena.messages[0]?.content.replace('Topic: ', '') || '',
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

            await this._loadHistory();
        } catch (err) {
            this._showError(`Failed to load arena: ${err.message}`);
        }
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

        // Resume if stopped — turn was already advanced when last message completed,
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

        // Restore model selections
        if (data.participants && data.participants.length >= 2) {
            if (this.modelASelect && data.participants[0]) {
                this.modelASelect.setValue?.(data.participants[0]);
            }
            if (this.modelBSelect && data.participants[1]) {
                this.modelBSelect.setValue?.(data.participants[1]);
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

            const modelA = data.participants?.[0]?.split('/').pop() || 'modelA';
            const modelB = data.participants?.[1]?.split('/').pop() || 'modelB';
            const topic = (data.topic || 'arena').replace(/[^a-z0-9]/gi, '_').toLowerCase().substring(0, 30);
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

    async _showSummarizeDialog() {
        if (!this.arena) {
            this._showError('No active arena to summarize');
            return;
        }

        // Build model options from loaded models
        const modelItems = this.models
            .filter(m => m.type === 'chat' || !m.type)
            .map(m => ({ value: m.id || m.name, label: m.name || m.id }));

        if (modelItems.length === 0) {
            modelItems.push({ value: '', label: 'No models available', disabled: true });
        }

        // Use page mode dialog - no buttons, we'll create custom footer
        const { dialog, main } = await nui.components.dialog.page('Summarize Conversation', '', {
            contentScroll: true
        });

        // Build dialog content with overlay for loading state
        main.innerHTML = `
            <div id="summarize-content" style="position: relative;">

                <!-- Model select and Generate button -->
                <section style="margin-bottom: 1.5rem;">
                    <nui-form-row class="summarize-model-row">
                        <nui-select id="summarize-model-select" searchable data-label="Select model...">
                            <select>
                                ${modelItems.map(m => `<option value="${m.value}"${m.disabled ? ' disabled' : ''}>${m.label}</option>`).join('')}
                            </select>
                        </nui-select>
                        <nui-button variant="primary" id="summarize-generate-btn">
                            <button type="button">Generate</button>
                        </nui-button>
                    </nui-form-row>
                </section>

                <!-- Title field - outside tabs -->
                <section style="margin-bottom: 1rem;">
                    <nui-input-group>
                        <label>Title</label>
                        <nui-rich-text id="summarize-title-rt" no-toolbar style="margin-top: 0.5rem;">
                            <textarea rows="2" style="font-family: inherit; font-size: 0.875rem; line-height: 1.5; resize: none; background: var(--nui-color-shade1);"></textarea>
                        </nui-rich-text>
                    </nui-input-group>
                </section>

                <section id="summarize-output-section" style="margin-bottom: 1rem;">
                    <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.75rem;">
                        <span style="font-weight: 500;">Summary</span>
                        <span id="summarize-status" style="color: var(--nui-color-text-dim); font-style: italic; font-size: 0.875rem;"></span>
                    </div>

                    <nui-tabs>
                        <nav>
                            <button>Condensed</button>
                            <button>Long</button>
                            <button>Short</button>
                        </nav>

                        <div>
                            <nui-rich-text id="summarize-compacted-rt" no-toolbar style="margin-top: 0.5rem;">
                                <textarea rows="8" style="font-family: inherit; font-size: 0.875rem; line-height: 1.5; resize: none; background: var(--nui-color-shade1);"></textarea>
                            </nui-rich-text>
                        </div>

                        <div>
                            <nui-rich-text id="summarize-long-rt" no-toolbar style="margin-top: 0.5rem;">
                                <textarea rows="8" style="font-family: inherit; font-size: 0.875rem; line-height: 1.5; resize: none; background: var(--nui-color-shade1);"></textarea>
                            </nui-rich-text>
                        </div>

                        <div>
                            <nui-rich-text id="summarize-short-rt" no-toolbar style="margin-top: 0.5rem;">
                                <textarea rows="4" style="font-family: inherit; font-size: 0.875rem; line-height: 1.5; resize: none; background: var(--nui-color-shade1);"></textarea>
                            </nui-rich-text>
                        </div>
                    </nui-tabs>
                </section>

                <!-- Loading overlay - shades entire content area during generation -->
                <div id="summarize-overlay" style="display: none; position: absolute; inset: 0; background: var(--nui-color-surface, #1a1a1a); opacity: 0.9; z-index: 10; justify-content: center; align-items: center;">
                    <div style="display: flex; flex-direction: column; align-items: center; gap: 1rem;">
                        <nui-progress type="busy" size="48px"></nui-progress>
                        <span style="color: var(--nui-color-text);">Generating summary...</span>
                    </div>
                </div>
            </div>
        `;

        // Get references to elements
        const statusEl = main.querySelector('#summarize-status');
        const overlayEl = main.querySelector('#summarize-overlay');
        const compactedRt = main.querySelector('#summarize-compacted-rt');
        const longRt = main.querySelector('#summarize-long-rt');
        const shortRt = main.querySelector('#summarize-short-rt');
        const titleRt = main.querySelector('#summarize-title-rt');

        // Load existing summary from arena if available
        if (this.arena.summary) {
            compactedRt.setMarkdown(this.arena.summary.condensedVersion || '');
            longRt.setMarkdown(this.arena.summary.longSummary || '');
            shortRt.setMarkdown(this.arena.summary.shortSummary || '');
            titleRt.setMarkdown(this.arena.summary.title || '');
        }

        // Create custom footer with Close, Save, and Export buttons
        const nativeDialog = dialog.querySelector('dialog');
        const footer = document.createElement('footer');
        footer.innerHTML = `
            <nui-button-container align="end">
                <nui-button variant="outline" id="summarize-close-btn">
                    <button type="button">Close</button>
                </nui-button>
                <nui-button variant="outline" id="summarize-export-btn">
                    <button type="button">Export Markdown</button>
                </nui-button>
                <nui-button variant="primary" id="summarize-save-btn">
                    <button type="button">Save</button>
                </nui-button>
            </nui-button-container>
        `;
        nativeDialog.appendChild(footer);

        // Get references to elements
        const modelSelect = main.querySelector('#summarize-model-select');
        const generateBtn = main.querySelector('#summarize-generate-btn');
        const closeBtn = footer.querySelector('#summarize-close-btn');
        const saveBtn = footer.querySelector('#summarize-save-btn');
        const exportBtn = footer.querySelector('#summarize-export-btn');

        // Auto-select participant A's model
        if (this.arena.participantA?.modelName && modelSelect?.setValue) {
            modelSelect.setValue(this.arena.participantA.modelName);
        }

        // Handle generate button click
        generateBtn?.addEventListener('click', async () => {
            statusEl.textContent = 'Generating condensed version...';
            overlayEl.style.display = 'flex';

            try {
                const model = modelSelect?.getValue?.() || this.arena.participantA?.modelName;
                const result = await this.arena.summarize(model, (step, message) => {
                    statusEl.textContent = message;
                });

                statusEl.textContent = 'Done';
                compactedRt.setMarkdown(result.condensedVersion);
                longRt.setMarkdown(result.longSummary);
                shortRt.setMarkdown(result.shortSummary);
                titleRt.setMarkdown(result.title);
            } catch (err) {
                console.error('[ArenaUI] Summarize failed:', err);
                statusEl.textContent = 'Error generating summary';
                compactedRt.setMarkdown(`Error: ${err.message}`);
            } finally {
                // Hide loading overlay
                overlayEl.style.display = 'none';
            }
        });

        // Handle close button
        closeBtn?.addEventListener('click', () => {
            dialog.close('close');
        });

        // Handle save button
        saveBtn?.addEventListener('click', async () => {
            // Save summaries to arena metadata
            this.arena.summary = {
                condensedVersion: compactedRt.markdown || '',
                longSummary: longRt.markdown || '',
                shortSummary: shortRt.markdown || '',
                title: titleRt.markdown || ''
            };
            await this.arena._saveToStorage();
            await this._loadHistory(); // Refresh history to show title
            this._showNotification('Summary saved to arena', 'success');
            dialog.close('save');
        });

        // Handle export button
        exportBtn?.addEventListener('click', () => {
            this._exportMarkdownFromDialog(compactedRt.markdown || '', longRt.markdown || '', shortRt.markdown || '', titleRt.markdown || '');
        });
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
        const participantA = this.arena.participantA?.name || 'Participant A';
        const participantB = this.arena.participantB?.name || 'Participant B';
        const date = new Date().toISOString().split('T')[0];
        const arenaId = this.arena.id || 'unknown';
        const topic = this.arena.messages[0]?.content.replace('Topic: ', '').split('\n\n[')[0] || '';

        // Build markdown content
        let markdown = `# ${summary.title || 'Untitled Conversation'}

**Date:** ${date}  
**Arena ID:** ${arenaId}  
**Participants:** ${participantA}, ${participantB}

## Topic (Setup)

${topic || '*No topic provided*'}

---

## Short Summary

${summary.shortSummary || 'No short summary available.'}

---

## Long Summary

${summary.longSummary || 'No long summary available.'}

---

## Condensed Conversation

${summary.condensedVersion || 'No condensed conversation available.'}

---

*Exported from Chat Arena*
`;

        // Create download
        const blob = new Blob([markdown], { type: 'text/markdown' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${summary.title?.replace(/[^a-z0-9]/gi, '_').toLowerCase() || 'conversation'}_${date}.md`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        this._showNotification('Markdown exported', 'success');
    }

    _exportMarkdownFromDialog(condensedVersion, longSummary, shortSummary, title) {
        if (!this.arena) {
            this._showError('No active arena to export');
            return;
        }

        const participantA = this.arena.participantA?.name || 'Participant A';
        const participantB = this.arena.participantB?.name || 'Participant B';
        const date = new Date().toISOString().split('T')[0];
        const arenaId = this.arena.id || 'unknown';
        const topic = this.arena.messages[0]?.content.replace('Topic: ', '').split('\n\n[')[0] || '';

        // Build markdown content
        let markdown = `# ${title || 'Untitled Conversation'}

**Date:** ${date}  
**Arena ID:** ${arenaId}  
**Participants:** ${participantA}, ${participantB}

## Topic (Setup)

${topic || '*No topic provided*'}

---

## Short Summary

${shortSummary || 'No short summary available.'}

---

## Long Summary

${longSummary || 'No long summary available.'}

---

## Condensed Conversation

${condensedVersion || 'No condensed conversation available.'}

---

*Exported from Chat Arena*
`;

        // Create download
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
    await arenaUI.init();
});

export { Arena, Participant, ArenaUI };