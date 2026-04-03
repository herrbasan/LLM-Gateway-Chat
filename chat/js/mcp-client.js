/**
 * MCP (Model Context Protocol) Client
 * Handles connections to local or remote MCP servers via SSE (Server-Sent Events)
 * and tool execution coordination for the chat application.
 */

import { storage } from './storage.js';

class MCPClient {
    constructor() {
        this.servers = []; // List of active MCP server connections
        this.availableTools = []; // Cached flattened list of active tools mapped for the LLM
        this.toolRegistry = new Map(); // internal global lookup map: llmName -> { serverId, originalName, definition }
        this.enabledTools = new Map(); // Map<serverId, Map<toolName, boolean>>
        this.onLog = null; // Callback for UI logger
        this.pendingRequests = new Map(); // requestId -> { resolve, reject, server } for SSE responses
        this._configLoaded = false;
    }

    /**
     * Load MCP config from IndexedDB. Call once after app init.
     */
    async ready() {
        if (this._configLoaded) return;
        this._configLoaded = true;

        try {
            const storedServers = await storage.mcpGet('servers');
            if (storedServers) {
                this.servers = JSON.parse(storedServers);
                this.servers.forEach(s => s.status = 'disconnected');
            }

            const storedEnabledTools = await storage.mcpGet('enabledTools');
            if (storedEnabledTools) {
                const parsedTools = JSON.parse(storedEnabledTools);
                this.enabledTools = new Map(
                    Object.entries(parsedTools).map(([serverId, toolsObj]) => [
                        serverId,
                        new Map(Object.entries(toolsObj))
                    ])
                );
            }
        } catch (e) {
            console.error('Failed to load MCP server config', e);
        }
    }

    async saveConfig() {
        const serversToStore = this.servers.map(s => ({
            id: s.id,
            url: s.url,
            name: s.name,
            status: 'disconnected'
        }));
        await storage.mcpSet('servers', JSON.stringify(serversToStore));

        const serializedTools = {};
        for (const [serverId, toolsMap] of this.enabledTools.entries()) {
            serializedTools[serverId] = Object.fromEntries(toolsMap);
        }
        await storage.mcpSet('enabledTools', JSON.stringify(serializedTools));
    }

    logTraffic(direction, payload) {
        if (this.onLog) {
            const time = new Date().toISOString().split('T')[1].split('.')[0];
            const prefix = direction === 'IN' ? '<<' : '>>';
            const text = `[${time}] ${prefix} ${JSON.stringify(payload, null, 2)}\n`;
            this.onLog(text);
        }
    }

    addServer(url, name) {
        const id = Date.now().toString();
        this.servers.push({ id, url, name, status: 'disconnected' });
        this.enabledTools.set(id, new Map());
        this.saveConfig();
        // TODO: Automatically connect and fetch tools
    }

    removeServer(id) {
        // PHASE-0: Cleanup tracking states
        this.disconnectServer(id);
        this.servers = this.servers.filter(s => s.id !== id);
        this.enabledTools.delete(id);
        this.saveConfig();
        this.rebuildToolRegistry();
    }

    disconnectServer(id) {
        const server = this.servers.find(s => s.id === id);
        if (server) {
            if (server.eventSource) {
                server.eventSource.close();
                server.eventSource = null;
            }
            server.status = 'disconnected';
            server.tools = [];
            this.rebuildToolRegistry();
        }
    }

    // Set a tool's enabled state locally
    setToolEnabled(serverId, toolName, enabled) {
        if (!this.enabledTools.has(serverId)) {
            this.enabledTools.set(serverId, new Map());
        }
        this.enabledTools.get(serverId).set(toolName, enabled);
        this.saveConfig();
        this.rebuildToolRegistry();
    }

    // PHASE-0: Intercept and rebuild the registry cache
    rebuildToolRegistry() {
        this.toolRegistry = new Map();
        this.availableTools = [];

        // First pass: Count occurrences across connected servers to find collisions
        const nameCounts = new Map();
        for (const server of this.servers) {
            if (server.status === 'connected' && server.tools) {
                for (const tool of server.tools) {
                    nameCounts.set(tool.name, (nameCounts.get(tool.name) || 0) + 1);
                }
            }
        }

        // Second pass: Build registry and resolve collision prefixes
        for (const server of this.servers) {
            if (server.status === 'connected' && server.tools) {
                for (const tool of server.tools) {
                    let llmName = tool.name;
                    if (nameCounts.get(tool.name) > 1) {
                        const safeServerName = server.name.replace(/[^a-zA-Z0-9_-]/g, '_');
                        llmName = `${safeServerName}__${tool.name}`;
                    }

                    const record = {
                        serverId: server.id,
                        originalName: tool.name,
                        llmName: llmName,
                        definition: tool
                    };

                    this.toolRegistry.set(llmName, record);

                    // Push to the active list that the LLM context uses if user enabled it
                    const isEnabled = this.enabledTools.get(server.id)?.get(tool.name) ?? false;
                    if (isEnabled) {
                        this.availableTools.push(record);
                    }
                }
            }
        }

    }

    /**
     * Connects to a specific MCP server using SSE transport.
     * Uses fetch() instead of EventSource so we can set Accept: text/event-stream.
     * @param {Object} server The server config object
     */
    async connectToServer(server) {
        // The server exposes /sse for SSE endpoint discovery and /message for POST requests
        // Derive the SSE URL from the server URL (replace /mcp or /message with /sse if needed)
        let sseUrl = server.url;
        if (sseUrl.includes('/message')) {
            sseUrl = sseUrl.replace('/message', '/sse');
        } else if (sseUrl.endsWith('/mcp')) {
            sseUrl = sseUrl.replace('/mcp', '/sse');
        }

        console.log(`[${server.name}] Connecting SSE at ${sseUrl}`);

        return new Promise((resolve, reject) => {
            fetch(sseUrl, {
                headers: { 'Accept': 'text/event-stream' }
            }).then(async (response) => {
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                if (!response.body) throw new Error('No response body');

                server.status = 'connected';
                server.eventSource = { close: () => {} }; // compat shim

                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let buffer = '';

                const read = () => {
                    reader.read().then(({ done, value }) => {
                        if (done) return;
                        buffer += decoder.decode(value, { stream: true });

                        // SSE messages are separated by blank lines (\n\n or \r\n\r\n)
                        // Normalise CRLF -> LF first
                        buffer = buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

                        while (buffer.includes('\n\n')) {
                            const msgEnd = buffer.indexOf('\n\n');
                            const rawMsg = buffer.slice(0, msgEnd);
                            buffer = buffer.slice(msgEnd + 2);

                            // Parse: "event: <type>\ndata: <payload>"
                            let eventType = '';
                            let eventData = '';
                            for (const line of rawMsg.split('\n')) {
                                if (line.startsWith('event:')) {
                                    eventType = line.slice(6).trim();
                                } else if (line.startsWith('data:')) {
                                    eventData = line.slice(5).trim();
                                }
                            }

                            // Skip comment lines (start with :)
                            if (rawMsg.startsWith(':')) continue;
                            // Skip events with no data
                            if (!eventData) continue;

                            if (eventType === 'endpoint') {
                                // POST endpoint is relative or absolute
                                let postEndpoint = eventData;
                                if (postEndpoint.startsWith('/')) {
                                    const base = new URL(sseUrl);
                                    postEndpoint = `${base.protocol}//${base.host}${postEndpoint}`;
                                }
                                server.postEndpoint = postEndpoint;
                                console.log(`[${server.name}] POST endpoint: ${postEndpoint}. Fetching tools...`);
                                this.refreshServerTools(server).then(resolve).catch(reject);
                            } else if (eventType === 'message') {
                                // JSON-RPC response on the SSE stream
                                try {
                                    const data = JSON.parse(eventData);
                                    if (data.method === 'notifications/progress') {
                                        this.handleProgress(server, data.params);
                                    }
                                    if (data.id) {
                                        // Check if this is a pending tools/list response
                                        if (server._pendingToolListRequest && String(data.id) === String(server._pendingToolListRequest.requestId)) {
                                            server._pendingToolListRequest.onResponse(data);
                                        } else {
                                            this.handleResponse(server, data);
                                        }
                                    }
                                } catch (err) {
                                    // Ignore malformed JSON
                                }
                            }
                        }

                        read();
                    }).catch(err => {
                        console.error(`[${server.name}] SSE read error:`, err);
                        server.status = 'error';
                        this.rebuildToolRegistry();
                        reject(err);
                    });
                };

                read();
            }).catch(err => {
                console.error(`[${server.name}] SSE connection failed:`, err);
                server.status = 'error';
                this.rebuildToolRegistry();
                reject(err);
            });
        });
    }

    /**
     * Internal: Fetches tools using the discovered POST endpoint
     * For legacy SSE transport, the response comes on the main SSE stream, not the POST response
     */
    async refreshServerTools(server) {
        if (!server.postEndpoint) throw new Error("No POST endpoint discovered for server");

        const requestId = Date.now().toString();
        const payload = {
            jsonrpc: '2.0',
            id: requestId,
            method: 'tools/list',
            params: {}
        };

        // For legacy SSE transport, register a one-time handler for the response on the main SSE stream
        return new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                delete server._pendingToolListRequest;
                reject(new Error('Timeout waiting for tools/list response'));
            }, 10000);

            // Store the pending request handler on the server object
            // The connectToServer SSE handler will check for this
            server._pendingToolListRequest = {
                requestId: requestId,
                onResponse: (data) => {
                    clearTimeout(timeoutId);
                    delete server._pendingToolListRequest;
                    if (data.error) {
                        reject(new Error(`MCP error: ${data.error.message}`));
                    } else if (data.result?.tools) {
                        server.tools = data.result.tools;
                        this.rebuildToolRegistry();
                        // Notify UI to refresh server display with new tool counts
                        if (typeof window !== 'undefined' && window.refreshMCPServersUI) {
                            window.refreshMCPServersUI();
                        }
                        resolve();
                    } else {
                        reject(new Error('Unexpected response format'));
                    }
                }
            };

            // Send the POST request (response will come via main SSE stream)
            fetch(server.postEndpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'text/event-stream'
                },
                body: JSON.stringify(payload)
            }).then(response => {
                if (!response.ok) {
                    clearTimeout(timeoutId);
                    delete server._pendingToolListRequest;
                    return response.text().then(text => {
                        reject(new Error(`HTTP ${response.status}: ${text}`));
                    });
                }

            }).catch(err => {
                clearTimeout(timeoutId);
                delete server._pendingToolListRequest;
                reject(err);
            });
        });
    }

    /**
     * Handle progress indicators for long-running tools (e.g. browser_research)
     */
    handleProgress(server, params) {
        const { progressToken, progress, total, message } = params;
        console.log(`[Progress ${progressToken}] ${message || ''} (${progress}/${total || '?'})`);

        let requestId = null;
        const ptStr = String(progressToken);
        if (ptStr.startsWith('prog-')) {
            requestId = ptStr.substring(5);
        } else {
            requestId = ptStr; // fallback if they just echo without prefix
        }

        if (requestId) {
            const pending = this.pendingRequests.get(requestId);
            if (pending) {
                // Reset timeout on progress
                if (pending.resetTimeout) {
                    pending.resetTimeout();
                }
                
                // Fire optional callback
                if (pending.onProgress) {
                    pending.onProgress(params);
                }
            }
        }
    }

    /**
     * Handle JSON-RPC responses (from SSE or streamableHTTP)
     */
    handleResponse(server, data) {
        const requestId = String(data.id);
        const pending = this.pendingRequests.get(requestId);
        if (pending) {
            this.pendingRequests.delete(requestId);
            if (pending.cancelTimeout) {
                // Clear the timeout to prevent it firing later
                pending.cancelTimeout();
            }
            if (data.error) {
                pending.reject(new Error(`MCP error: ${data.error.message || JSON.stringify(data.error)}`));
            } else {
                pending.resolve(data.result);
            }
        }
    }

    /**
     * Execute a tool using streamableHTTP transport
     * POST request with streaming HTTP response containing JSON-RPC messages
     */
    async executeToolStreamableHttp(server, payload) {
        const requestId = payload.id;
        console.log(`[${server.name}] Execute via streamableHTTP: ${server.postEndpoint}`);

        let response;
        try {
            response = await fetch(server.postEndpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'text/event-stream'
                },
                body: JSON.stringify(payload)
            });
        } catch (err) {
            console.error(`[${server.name}] Fetch failed:`, err.message);
            throw new Error(`Fetch failed: ${err.message}. CORS issue?`);
        }

        if (!response.ok) {
            const text = await response.text();
            throw new Error(`HTTP ${response.status}: ${text}`);
        }

        // Response is SSE (text/event-stream) - parse manually from fetch stream
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const chunk = decoder.decode(value, { stream: true });
                buffer += chunk;

                // Normalise line endings
                buffer = buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

                while (buffer.includes('\n\n')) {
                    const msgEnd = buffer.indexOf('\n\n');
                    const msg = buffer.slice(0, msgEnd);
                    buffer = buffer.slice(msgEnd + 2);

                    if (msg.startsWith(':')) continue; // skip comment lines

                    const fields = {};
                    for (const line of msg.split('\n')) {
                        const colonIdx = line.indexOf(':');
                        if (colonIdx === -1) continue;
                        fields[line.slice(0, colonIdx).trim()] = line.slice(colonIdx + 1).trim();
                    }

                    if (!fields.data) continue;

                    try {
                        const data = JSON.parse(fields.data);
                        if (data.method && !data.id) {
                            if (data.method === 'notifications/progress') {
                                this.handleProgress(server, data.params);
                            }
                            continue;
                        }
                        if (data.id) {
                            this.handleResponse(server, data);
                        }
                    } catch (e) {
                        // Ignore malformed JSON in SSE stream
                    }
                }
            }
        } catch (e) {
            console.error(`[${server.name}] SSE read error:`, e);
        }
    }

    /**
     * Execute a specific tool on the appropriate server
     * @param {String} llmToolName The LLM-friendly name of the tool (post-collision prefixing)
     * @param {Object} parameters The arguments to pass to the tool
     * @param {Function} onProgress Optional callback for progress updates
     * @param {String} chatId Optional - the chat this tool execution belongs to (for multi-chat tracking)
     */
    async executeTool(llmToolName, parameters, onProgress = null, chatId = null) {
        const record = this.toolRegistry.get(llmToolName);
        if (!record) {
            throw new Error(`Unknown tool: ${llmToolName}`);
        }

        const server = this.servers.find(s => s.id === record.serverId);
        if (!server || server.status !== 'connected') {
            throw new Error(`Server for tool ${llmToolName} is disconnected or unavailable`);
        }

        const requestId = Date.now().toString();
        const progressToken = `prog-${requestId}`;

        console.log(`Executing tool: ${record.originalName} on server ${server.name}`, parameters);

        const payload = {
            jsonrpc: '2.0',
            id: requestId,
            method: 'tools/call',
            params: {
                name: record.originalName,
                arguments: parameters,
                _meta: { progressToken }
            }
        };

        // Register pending request for progress/cancel callbacks
        const pendingPromise = new Promise((resolve, reject) => {
            const timeoutDuration = 120000; // 2 minutes setup

            const startTimeout = () => {
                return setTimeout(() => {
                    this.pendingRequests.delete(requestId);
                    reject(new Error('Tool execution timeout (2 minutes)'));
                }, timeoutDuration);
            };

            let timeoutId = startTimeout();

            const resetTimeout = () => {
                if (timeoutId) clearTimeout(timeoutId);
                timeoutId = startTimeout();
            };
            
            const cancelTimeout = () => {
                if (timeoutId) clearTimeout(timeoutId);
            }

            this.pendingRequests.set(requestId, { resolve, reject, resetTimeout, cancelTimeout, onProgress, server, chatId });
        });

        // Use streamableHTTP (streaming response)
        this.executeToolStreamableHttp(server, payload).catch(err => {
            // Error will be handled by handleResponse rejecting the promise
            console.error(`[${server.name}] StreamableHTTP error:`, err);
        });

        // Return the pending promise directly, timeout is handled natively inside it
        return pendingPromise;
    }

    /**
     * Converts MCP tool definitions into the format required by LLM APIs
     * (e.g. OpenAI's tools array format)
     */
    getFormattedToolsForLLM() {
        return this.availableTools.map(tool => ({
            type: "function",
            function: {
                name: tool.llmName,
                description: tool.definition.description,
                parameters: tool.definition.inputSchema // JSON schema
            }
        }));
    }

    /**
     * PHASE-1: Tool Invocation Syntax Injection
     * Generates a strict system prompt instructing the LLM how to invoke tools via SSE chunking.
     * @param {string[]} excludedToolPrefixes - Array of tool name prefixes to exclude (e.g., ['vision_'])
     */
    generateToolPrompt(excludedToolPrefixes = []) {
        if (this.availableTools.length === 0) return "";

        const allTools = this.getFormattedToolsForLLM();
        
        // Filter out excluded tools
        const filteredTools = excludedToolPrefixes.length > 0
            ? allTools.filter(tool => {
                const toolName = tool.function?.name?.toLowerCase() || '';
                return !excludedToolPrefixes.some(prefix => toolName.startsWith(prefix.toLowerCase()));
            })
            : allTools;

        if (filteredTools.length === 0) return "";

        const toolNames = filteredTools.map(t => t.function?.name).join(', ');
        console.log('[MCP] generateToolPrompt: excluded=', excludedToolPrefixes, '| included tools:', toolNames);

        const toolDescriptions = filteredTools.map(t => JSON.stringify(t.function)).join('\n');
        
        return `
You have access to the following tools:
${toolDescriptions}

To invoke a tool, you MUST output a single line with the exact following syntax, self-delimited, without any surrounding markdown formatting or text on that line:
__TOOL_CALL__({"name": "tool_name", "args": {"param1": "value"}})

After you output a tool call, the system will execute it and provide you with a new message containing the result formatted like this:
<tool_result>
  <tool_name>...</tool_name>
  <status>success|error</status>
  <output>...</output>
</tool_result>
Do not attempt to guess or hallucinate the tool's result.
`;
    }
}

export const mcpClient = new MCPClient();

// Expose to window for easy testing in the browser console
window.mcpClient = mcpClient;
