// ============================================
// Chat Arena - Main Arena Orchestrator
// ============================================

// Reuse existing utilities (import only, no modifications)
import { GatewayClient } from '../../chat/js/client-sdk.js';
import { renderMarkdown, parseThinking } from '../../chat/js/markdown.js';
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
        // Convert empty/null/undefined to null (gateway default), otherwise parse as integer
        this.maxTokens = (!options.maxTokens || options.maxTokens === '' || isNaN(parseInt(options.maxTokens))) ? null : parseInt(options.maxTokens);

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

    setMaxTokens(maxTokens) {
        // Convert empty/null/undefined to null (gateway default), otherwise parse as integer
        this.maxTokens = (!maxTokens || maxTokens === '' || isNaN(parseInt(maxTokens))) ? null : parseInt(maxTokens);
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
            console.log('[Participant] _startStreaming:', {
                model: this.modelName,
                messageCount: messages.length,
                maxTokens: this.maxTokens,
                maxTokensType: typeof this.maxTokens
            });
            
            const streamParams = {
                model: this.modelName,
                messages: messages,
                stream: true,
                temperature: 0.7
            };
            
            // Only include maxTokens if explicitly set to a valid number (null/undefined/empty = gateway default)
            if (this.maxTokens !== null && this.maxTokens !== undefined && this.maxTokens !== '') {
                const parsedMaxTokens = parseInt(this.maxTokens);
                console.log('[Participant] Adding maxTokens to request:', parsedMaxTokens);
                if (!isNaN(parsedMaxTokens) && parsedMaxTokens >= 1) {
                    streamParams.maxTokens = parsedMaxTokens;
                }
            } else {
                console.log('[Participant] maxTokens not set, using gateway default');
            }
            
            console.log('[Participant] Final streamParams:', JSON.stringify(streamParams, null, 2));
            
            const stream = this.client.chatStream(streamParams);

            stream.on('delta', (data) => {
                const content = data?.choices?.[0]?.delta?.content;
                if (content != null && typeof content === 'string') {
                    this.responseAccumulator += content;
                }
            });

            stream.on('progress', (data) => {
                // Some models send content via progress event
                const content = data?.choices?.[0]?.delta?.content || data?.content;
                if (content != null && typeof content === 'string') {
                    this.responseAccumulator += content;
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
            if (msg.speaker === 'moderator') continue;
            if (msg.role !== 'assistant') continue;
            if (!msg.content || !msg.content.trim()) continue; // Skip empty

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
                messages.unshift({ role: 'user', content: topicText });
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

        // Context tracking for both participants
        this.contextUsage = {
            participantA: { used_tokens: 0, window_size: null },
            participantB: { used_tokens: 0, window_size: null }
        };

        // Summary metadata
        this.summary = null;
    }

    setMaxTokens(participant, maxTokens) {
        if (participant === 'A' && this.participantA) {
            this.participantA.maxTokens = maxTokens || null;
        } else if (participant === 'B' && this.participantB) {
            this.participantB.maxTokens = maxTokens || null;
        }
    }

    _generateId() {
        return `arena-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }

    async _saveToStorage() {
        try {
            const sessionData = this.exportJSON();
            // Debug: console.log('[Arena] Saving session:', this.id, 'messages:', sessionData.messages.length);
            await arenaStorage.saveSession(this.id, sessionData);
            await this._updateHistory(sessionData);
            this.onSave();
        } catch (err) {
            console.error('Failed to save arena session:', err);
        }
    }

    async _updateHistory(sessionData) {
        try {
            const history = await arenaStorage.loadHistory();
            const existingIndex = history.findIndex(h => h.id === this.id);

            const entry = {
                id: this.id,
                sessionId: this.sessionId,
                topic: sessionData.topic,
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
        });

        this.participantB = new Participant({
            name: participantBConfig.name || 'Model B',
            modelName: participantBConfig.modelName,
            gatewayUrl: this.gatewayUrl,
            systemPrompt: participantBConfig.systemPrompt,
            maxTokens: participantBConfig.maxTokens,
            sessionId: sessionIdB,
        });
    }

    setTopic(topic) {
        this.messages = [{
            role: 'system',
            speaker: 'moderator',
            content: `Topic: ${topic}`
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

        // Default prompt when roleplay is off
        if (!effectivePrompt) {
            effectivePrompt = `You are ${speaker.modelName}. Engage in a thoughtful conversation about the following topic: ${topic}`;
        }

        if (this.messages.length === 1) {
            effectivePrompt = effectivePrompt
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
            topic: this.messages[0]?.content.replace('Topic: ', '') || '',
            participants: [this.participantA?.modelName, this.participantB?.modelName],
            participantNames: [this.participantA?.name, this.participantB?.name],
            settings: {
                maxTurns: this.maxTurns,
                autoAdvance: this.autoAdvance,
                systemPromptA: this.participantA?.systemPrompt,
                systemPromptB: this.participantB?.systemPrompt,
                maxTokens: this.participantA?.maxTokens // Same for both participants
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
            autoAdvance: data.settings?.autoAdvance ?? true
        });

        arena.importJSON(data);

        // Restore participants if model names are available
        if (data.participants && data.participants.length >= 2) {
            const settings = data.settings || {};
            arena.setParticipants({
                name: data.participantNames?.[0] || data.participants[0].split('/').pop(),
                modelName: data.participants[0],
                systemPrompt: settings.systemPromptA,
                maxTokens: settings.maxTokens || null
            }, {
                name: data.participantNames?.[1] || data.participants[1].split('/').pop(),
                modelName: data.participants[1],
                systemPrompt: settings.systemPromptB,
                maxTokens: settings.maxTokens || null
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

    async summarize(model = null) {
        if (!this.messages || this.messages.length === 0) {
            return {
                compactedConversation: 'No messages to summarize.',
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

        const summaryPrompt = `You are providing 4 levels of summarization for a conversation between two AI models.

TOPIC: ${topic}

CONVERSATION:
${conversationText}

Please provide a structured summary with ALL of the following:

1. COMPACTED CONVERSATION: Rewrite the ENTIRE conversation preserving EVERY SINGLE TURN from both speakers. Each message should be compacted into more natural, concise language while retaining the speaker's tone, manner, and style. How something is said is just as important as what was said - preserve the personality and flow of the conversation. The result should read like a natural condensed transcript.

2. LONG SUMMARY: A comprehensive summary capturing all major facts, realizations, and implications discussed in the conversation.

3. SHORT SUMMARY: A brief description (2-3 sentences) of the conversation in relation to the topic.

4. TITLE: A short, descriptive title (5 words or less) for this conversation.

Format your response exactly like this:
===COMPACTED===
[compacted conversation text]
===LONG===
[long summary text]
===SHORT===
[short summary text]
===TITLE===
[title text]`;

        const client = new GatewayClient({ baseUrl: this.gatewayUrl });
        const modelToUse = model || this.participantA?.modelName || 'claude-3-5-sonnet-20241022';

        return new Promise((resolve, reject) => {
            const stream = client.chatStream({
                model: modelToUse,
                messages: [{ role: 'user', content: summaryPrompt }],
                stream: true,
                maxTokens: 2000
            });

            let fullText = '';

            stream.on('delta', (data) => {
                if (data?.choices?.[0]?.delta?.content !== undefined) {
                    fullText += data.choices[0].delta.content;
                }
            });

            stream.on('done', () => {
                resolve(this._parseStructuredSummary(fullText));
            });

            stream.on('error', (err) => {
                reject(err);
            });
        });
    }

    _parseStructuredSummary(text) {
        const result = {
            compactedConversation: '',
            longSummary: '',
            shortSummary: '',
            title: 'Untitled Conversation'
        };

        const sections = {
            '===COMPACTED===': 'compactedConversation',
            '===LONG===': 'longSummary',
            '===SHORT===': 'shortSummary',
            '===TITLE===': 'title'
        };

        let currentSection = null;
        const lines = text.split('\n');

        for (const line of lines) {
            const trimmed = line.trim();
            if (sections[trimmed]) {
                currentSection = sections[trimmed];
            } else if (currentSection) {
                if (result[currentSection]) {
                    result[currentSection] += '\n' + line;
                } else {
                    result[currentSection] = line;
                }
            }
        }

        result.compactedConversation = result.compactedConversation.trim();
        result.longSummary = result.longSummary.trim();
        result.shortSummary = result.shortSummary.trim();
        result.title = result.title.trim();

        return result;
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
        this.autoAdvanceCheckbox = document.getElementById('auto-advance');
        this.startButton = document.getElementById('start-btn');
        this.stopButton = document.getElementById('stop-btn');
        this.summarizeBtn = document.getElementById('summarize-btn');
        this.promptInput = document.getElementById('arena-prompt-input');
        this.sendPromptBtn = document.getElementById('arena-send-btn');
        this.nextTurnBtn = document.getElementById('next-turn-btn');
        this.scrollToBottomBtn = document.getElementById('scroll-to-bottom');
    }

    _bindEvents() {
        this.startButton?.addEventListener('click', () => this._startConversation());
        this.stopButton?.addEventListener('click', () => this._stopConversation());
        this.sendPromptBtn?.addEventListener('click', () => this._sendPromptMessage());
        this.nextTurnBtn?.addEventListener('click', () => this._nextTurn());
        document.getElementById('extend-turns-btn')?.addEventListener('click', () => this._extendConversation());

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

        const autoAdvanceToggle = document.getElementById('auto-advance-toggle');
        autoAdvanceToggle?.addEventListener('click', () => {
            if (this.arena) {
                const newValue = this.arena.toggleAutoAdvance();
                autoAdvanceToggle.classList.toggle('active', newValue);
                this._updateNextButtonVisibility();
            }
        });

        document.getElementById('new-arena-btn')?.addEventListener('click', () => this._showSetupView());
        document.getElementById('import-arena-btn')?.addEventListener('click', () => this._triggerImport());

        this._importInput = document.createElement('input');
        this._importInput.type = 'file';
        this._importInput.accept = '.json';
        this._importInput.style.display = 'none';
        this._importInput.addEventListener('change', (e) => this._handleFileImport(e));
        document.body.appendChild(this._importInput);
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
        const autoAdvance = this.autoAdvanceCheckbox?.checked ?? true;
        const maxTokens = this.maxTokensInput?.value?.trim() || '';

        console.log('[ArenaUI] Starting conversation:', {
            topic: topic ? 'yes' : 'no',
            modelA,
            modelB,
            maxTurns,
            maxTokens: maxTokens || '(empty)',
            autoAdvance
        });

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
            autoAdvance,
            onMessage: (msg) => this._renderMessage(msg),
            onStatusChange: (status) => this._updateStatus(status),
            onError: (err) => this._showError(err),
            onMaxTurnsReached: (maxTurns) => this._showExtendOption(maxTurns),
            onContextUpdate: (contextData) => this._updateContextDisplay(contextData),
            onSave: () => this._loadHistory()
        });

        const systemPromptTemplate = `You are in a conversation. Your identity: {modelName}.
You are speaking with {otherParticipantName} (model: {otherModelName}).
Topic: {topic}
Speak naturally as if in a thoughtful conversation. Respond concisely but thoroughly.`;

        // Extract short names for display (last part of model path)
        const modelAName = modelA.split('/').pop();
        const modelBName = modelB.split('/').pop();

        // Parse maxTokens once - apply to both participants
        const parsedMaxTokens = (maxTokens && !isNaN(parseInt(maxTokens))) ? parseInt(maxTokens) : null;
        
        console.log('[ArenaUI] Setting participants with maxTokens:', parsedMaxTokens);

        this.arena.setParticipants({
            name: modelAName,
            modelName: modelA,
            systemPrompt: this.roleplayCheckbox?.checked ? (this.systemPromptAInput?.value || systemPromptTemplate) : null,
            maxTokens: parsedMaxTokens
        }, {
            name: modelBName,
            modelName: modelB,
            systemPrompt: this.roleplayCheckbox?.checked ? (this.systemPromptBInput?.value || systemPromptTemplate) : null,
            maxTokens: parsedMaxTokens
        });

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
        this._updateNextButtonVisibility();

        // Hide extend button for new conversations (will show when max turns reached)
        const extendBtn = document.getElementById('extend-turns-btn');
        if (extendBtn) {
            extendBtn.style.display = 'none';
        }

        // Hide sidebar on mobile
        const app = document.querySelector('nui-app');
        if (app) app.toggleSideNav('right', false);

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

        // Trigger next response if auto-advance is on
        if (this.arena.autoAdvance) {
            this.arena.advanceAndRespond();
        }
    }

    _nextTurn() {
        if (this.arena && this.arena.isRunning) {
            this.arena.advanceAndRespond();
        }
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
        `;

        this.messagesContainer.appendChild(messageEl);
        
        // Only auto-scroll if user is near bottom (same logic as chat app)
        if (this._isNearBottom()) {
            this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
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

        const autoAdvanceToggle = document.getElementById('auto-advance-toggle');
        if (autoAdvanceToggle) {
            autoAdvanceToggle.classList.toggle('active', this.arena?.autoAdvance ?? true);
        }
        this._updateNextButtonVisibility();
    }

    _updateNextButtonVisibility() {
        if (this.nextTurnBtn) {
            this.nextTurnBtn.style.display = this.arena?.autoAdvance ? 'none' : 'inline-flex';
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

            // Show extend button so user can continue the conversation
            this._showExtendButton();

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
        const historyList = document.getElementById('arena-history-list');
        if (!historyList) return;

        try {
            const history = await arenaStorage.loadHistory();

            if (!history || history.length === 0) {
                historyList.innerHTML = '<p style="padding: 1rem; text-align: center; opacity: 0.6;">No saved arenas</p>';
                return;
            }

            historyList.innerHTML = '';

            for (const entry of history) {
                const item = document.createElement('div');
                item.className = 'arena-history-item';
                item.title = `${entry.participants?.[0] || '?'} vs ${entry.participants?.[1] || '?'}`;

                const date = entry.updatedAt ? new Date(entry.updatedAt).toLocaleDateString() : '';

                const titleSpan = document.createElement('span');
                titleSpan.className = 'arena-history-item-title';
                titleSpan.textContent = this._escapeHtml(entry.topic || 'Untitled');

                const metaSpan = document.createElement('span');
                metaSpan.className = 'arena-history-item-meta';
                metaSpan.textContent = `${entry.messageCount} msgs · ${date}`;

                const actionsDiv = document.createElement('div');
                actionsDiv.className = 'arena-history-item-actions';

                // Copy JSON to clipboard
                const copyJsonBtn = document.createElement('nui-button');
                copyJsonBtn.className = 'arena-history-item-action';
                copyJsonBtn.innerHTML = '<button type="button"><nui-icon name="content_copy"></nui-icon></button>';
                copyJsonBtn.title = 'Copy JSON to clipboard';
                copyJsonBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this._copyArenaJsonToClipboard(entry.id, copyJsonBtn);
                });

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

                actionsDiv.appendChild(copyJsonBtn);
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

            // Restore settings to UI
            this._restoreSettingsToUI(arena._importedSettings, {
                topic: arena.messages[0]?.content.replace('Topic: ', '') || '',
                participants: [arena.participantA?.modelName, arena.participantB?.modelName],
                participantNames: [arena.participantA?.name, arena.participantB?.name]
            });

            // Update context display
            this._updateContextDisplay(this.arena.getContextDisplayData());

            // Show extend button so user can continue the conversation
            this._showExtendButton();

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
        if (this.autoAdvanceCheckbox) this.autoAdvanceCheckbox.checked = config.defaultAutoAdvance !== false;
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

        // Hide extend button for new conversations
        const extendBtn = document.getElementById('extend-turns-btn');
        if (extendBtn) {
            extendBtn.style.display = 'none';
        }

        // Refresh history list
        this._loadHistory();
    }

    _showExtendOption(maxTurns) {
        // Show the extend button
        this._showExtendButton();
        // Show notification
        this._showNotification(`Conversation reached ${maxTurns} turns. Click Extend to continue.`, 'success');
    }

    _showExtendButton() {
        // Show the extend button element
        const extendBtn = document.getElementById('extend-turns-btn');
        if (extendBtn) {
            extendBtn.style.display = 'inline-flex';
        }
    }

    _extendConversation() {
        if (!this.arena) return;

        // Add 5 more turns
        this.arena.maxTurns += 5;

        // Hide extend button
        const extendBtn = document.getElementById('extend-turns-btn');
        if (extendBtn) {
            extendBtn.style.display = 'none';
        }

        // Update status display
        this._updateStatus({
            isRunning: this.arena.isRunning,
            activeSpeaker: null,
            turn: this.arena.currentTurn
        });

        // Resume if auto-advance is on
        if (this.arena.autoAdvance) {
            // Determine who should speak next based on turn count
            // Even turns (0, 2, 4...) = participantA, Odd turns (1, 3, 5...) = participantB
            const isParticipantATurn = this.arena.currentTurn % 2 === 0;
            this.arena.activeSpeaker = isParticipantATurn ? this.arena.participantA : this.arena.participantB;
            
            this.arena.isRunning = true;
            this.arena.isPaused = false;
            this.arena._triggerResponse();
        }
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

        // Restore max tokens (same for both participants)
        if (this.maxTokensInput && settings?.maxTokens) {
            this.maxTokensInput.value = settings.maxTokens;
        }

        // Restore auto-advance
        if (this.autoAdvanceCheckbox && settings?.autoAdvance !== undefined) {
            this.autoAdvanceCheckbox.checked = settings.autoAdvance;
            if (this.arena) {
                this.arena.autoAdvance = settings.autoAdvance;
            }
        }

        // Restore system prompts if they exist
        if (settings?.systemPromptA && this.systemPromptAInput) {
            this.systemPromptAInput.value = settings.systemPromptA;
        }
        if (settings?.systemPromptB && this.systemPromptBInput) {
            this.systemPromptBInput.value = settings.systemPromptB;
        }

        // Show roleplay section if custom system prompts exist
        if ((settings?.systemPromptA || settings?.systemPromptB) && this.roleplayCheckbox && this.roleplaySection) {
            this.roleplayCheckbox.checked = true;
            this.roleplaySection.style.display = 'block';
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

    _escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // ============================================
    // History Item Actions
    // ============================================

    async _copyArenaJsonToClipboard(id, btn) {
        try {
            const data = await arenaStorage.loadSession(id);
            if (!data) return;

            const formattedJson = JSON.stringify(data, null, 2);
            await navigator.clipboard.writeText(formattedJson);

            // Show success feedback
            if (btn) {
                const icon = btn.querySelector('nui-icon');
                if (icon) {
                    icon.setAttribute('name', 'check');
                    setTimeout(() => icon.setAttribute('name', 'content_copy'), 2000);
                }
            }
        } catch (err) {
            console.error('Failed to copy JSON to clipboard:', err);
            this._showError('Failed to copy to clipboard');
        }
    }

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

        // Use page mode dialog
        const { dialog, main } = await nui.components.dialog.page('Summarize Conversation', '', {
            contentScroll: true,
            buttons: [
                { label: 'Close', type: 'outline', value: 'close' },
                { label: 'Save', type: 'primary', value: 'save' }
            ]
        });

        // Build dialog content with overlay for loading state
        main.innerHTML = `
            <div id="summarize-content" style="position: relative;">
                <section style="margin-bottom: 1.5rem;">
                    <nui-form-row>
                        <nui-input-group>
                            <label>Summary Model</label>
                            <nui-select id="summarize-model-select" searchable data-label="Select model...">
                                <select>
                                    ${modelItems.map(m => `<option value="${m.value}"${m.disabled ? ' disabled' : ''}>${m.label}</option>`).join('')}
                                </select>
                            </nui-select>
                        </nui-input-group>
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
                            <button>Compacted</button>
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
        const modelSelect = main.querySelector('#summarize-model-select');
        const generateBtn = main.querySelector('#summarize-generate-btn');

        // Load existing summary from arena if available
        if (this.arena.summary) {
            compactedRt.setMarkdown(this.arena.summary.compactedConversation || '');
            longRt.setMarkdown(this.arena.summary.longSummary || '');
            shortRt.setMarkdown(this.arena.summary.shortSummary || '');
            titleRt.setMarkdown(this.arena.summary.title || '');
        }

        // Auto-select participant A's model
        if (this.arena.participantA?.modelName && modelSelect?.setValue) {
            modelSelect.setValue(this.arena.participantA.modelName);
        }

        // Handle generate button click
        generateBtn?.addEventListener('click', async () => {
            statusEl.textContent = 'Generating...';
            overlayEl.style.display = 'flex';

            try {
                const model = modelSelect?.getValue?.() || this.arena.participantA?.modelName;
                const result = await this.arena.summarize(model);

                statusEl.textContent = 'Done';
                compactedRt.setMarkdown(result.compactedConversation);
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

        // Handle dialog close - button values: 'close', 'save'
        dialog.addEventListener('nui-dialog-close', async (e) => {
            const returnValue = e.detail?.returnValue;

            if (returnValue === 'save') {
                // Save summaries to arena metadata
                this.arena.summary = {
                    compactedConversation: compactedRt.markdown || '',
                    longSummary: longRt.markdown || '',
                    shortSummary: shortRt.markdown || '',
                    title: titleRt.markdown || ''
                };
                this.arena._saveToStorage();
                this._showNotification('Summary saved to arena', 'success');
            }
            // 'close' just closes the dialog normally
        });
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