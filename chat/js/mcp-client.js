/**
 * MCP (Model Context Protocol) Client
 * Handles connections to local or remote MCP servers via SSE (Server-Sent Events)
 * and tool execution coordination for the chat application.
 */

// PHASE-1: Abstracted StorageAdapter interface
class StorageAdapter {
    constructor(prefix = 'mcp-') {
        this.prefix = prefix;
    }

    get(key) {
        try {
            return localStorage.getItem(this.prefix + key);
        } catch (e) {
            console.error(`StorageAdapter get error for ${key}:`, e);
            return null;
        }
    }

    set(key, value) {
        try {
            localStorage.setItem(this.prefix + key, value);
        } catch (e) {
            console.error(`StorageAdapter set error for ${key}:`, e);
        }
    }
}

class MCPClient {
    constructor() {
        this.storage = new StorageAdapter();
        this.servers = []; // List of active MCP server connections
        this.availableTools = []; // Cached flattened list of active tools mapped for the LLM
        this.toolRegistry = new Map(); // internal global lookup map: llmName -> { serverId, originalName, definition }
        this.enabledTools = new Map(); // Map<serverId, Map<toolName, boolean>>
        this.onLog = null; // Callback for UI logger
        this.loadConfig();
    }

    logTraffic(direction, payload) {
        if (this.onLog) {
            const time = new Date().toISOString().split('T')[1].split('.')[0];
            const prefix = direction === 'IN' ? '<<' : '>>';
            const text = `[${time}] ${prefix} ${JSON.stringify(payload, null, 2)}\n`;
            this.onLog(text);
        }
    }

    loadConfig() {
        // PHASE-1: Storage abstraction
        try {
            const storedServers = this.storage.get('servers');
            if (storedServers) {
                this.servers = JSON.parse(storedServers);
                // Reset status to disconnected on load
                this.servers.forEach(s => s.status = 'disconnected');
            }

            const storedEnabledTools = this.storage.get('enabledTools');
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

    saveConfig() {
        // PHASE-1: Storage abstraction
        const serversToStore = this.servers.map(s => ({
            id: s.id,
            url: s.url,
            name: s.name,
            status: 'disconnected'
        }));
        this.storage.set('servers', JSON.stringify(serversToStore));

        // Serialize nested Map explicitly
        const serializedTools = {};
        for (const [serverId, toolsMap] of this.enabledTools.entries()) {
            serializedTools[serverId] = Object.fromEntries(toolsMap);
        }
        this.storage.set('enabledTools', JSON.stringify(serializedTools));
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
        console.log("MCP Tool Registry Built:", this.availableTools);
    }

    /**
     * Connects to a specific MCP server using standard SSE (Server-Sent Events) pattern
     * Based on official @modelcontextprotocol/sdk/client/sse.js flow
     * @param {Object} server The server config object
     */
    async connectToServer(server) {
        console.log(`Connecting to MCP server via SSE: ${server.name} at ${server.url}`);
        this.logTraffic('OUT', { action: 'Connecting..', url: server.url, transport: 'SSE/EventSource' });
        
        return new Promise((resolve, reject) => {
            // 1. Establish the SSE connection
            // The standard MCP SSEServerTransport expects a GET request without special headers
            const eventSource = new EventSource(server.url);
            let postEndpoint = server.url; // Fallback if server doesn't provide one

            // Connection timeout heuristic if server doesn't emit 'endpoint'
            const connectTimeout = setTimeout(() => {
                this.logTraffic('IN', { note: 'No endpoint event received after 3s. Falling back to using base URL for POST routing...' });
                console.warn(`[${server.name}] No 'endpoint' event received after 3s. Falling back to base URL: ${server.url}`);
                
                // Fallback: try using the url directly if the server isn't standard SSE compliant
                server.postEndpoint = server.url;
                
                this.refreshServerTools(server).then(() => {
                    server.status = 'connected';
                    server.eventSource = eventSource;
                    resolve();
                }).catch(err => {
                    server.status = 'error';
                    eventSource.close();
                    this.logTraffic('IN', { error: 'Fallback POST failed. Ensure this is an MCP server.', details: err.message });
                    reject(new Error(`SSE endpoint event missing -> Fallback POST to ${server.url} failed: ${err.message}`));
                });
            }, 3000);

            eventSource.onopen = () => {
                this.logTraffic('IN', { status: 'SSE Connection opened', note: 'Waiting for endpoint event...' });
                console.log(`[${server.name}] SSE Connection opened. Waiting for 'endpoint' event...`);
                server.status = 'connected';
                server.eventSource = eventSource;
            };

            // 2. Listen for the specific "endpoint" event that MCP servers send to tell us where to POST
            eventSource.addEventListener('endpoint', (e) => {
                clearTimeout(connectTimeout);
                postEndpoint = e.data;
                
                // The MCP Spec may return relative paths like `/message?sessionId=123` or absolute URLs
                if (postEndpoint.startsWith('/')) {
                    const baseUrl = new URL(server.url);
                    postEndpoint = `${baseUrl.protocol}//${baseUrl.host}${postEndpoint}`;
                }

                server.postEndpoint = postEndpoint;
                this.logTraffic('IN', { event: 'endpoint', postEndpoint: postEndpoint });
                console.log(`[${server.name}] Received POST endpoint: ${postEndpoint}. Fetching tools...`);
                
                // Now that we have the endpoint, we can fetch tools
                this.refreshServerTools(server).then(() => {
                    server.status = 'connected';
                    resolve();
                }).catch(reject);
            });

            // 3. Listen for general messages (JSON-RPC responses and progress updates)
            eventSource.onmessage = (e) => {
                try {
                    const data = JSON.parse(e.data);
                    this.logTraffic('IN', data);
                    console.log(`[${server.name}] Received message:`, data);
                    
                    // Fallback to extract endpoint if server sent it as a generic message payload
                    if (data.endpoint && !server.postEndpoint) {
                        clearTimeout(connectTimeout);
                        let ep = data.endpoint;
                        if (ep.startsWith('/')) {
                            const baseUrl = new URL(server.url);
                            ep = `${baseUrl.protocol}//${baseUrl.host}${ep}`;
                        }
                        server.postEndpoint = ep;
                        console.log(`[${server.name}] Recovered POST endpoint from generic message: ${ep}`);
                        this.refreshServerTools(server).then(() => {
                            server.status = 'connected';
                            resolve();
                        }).catch(reject);
                        return; // exit early
                    }

                    // Handle progress notifications for long-running tools
                    if (data.method === 'notifications/progress') {
                        this.handleProgress(server, data.params);
                    }
                    
                    // Handle JSON-RPC responses
                    if (data.id) {
                        this.handleResponse(server, data);
                    }
                } catch (err) {
                    this.logTraffic('IN', { rawEventData: e.data, parsingError: err.message });
                    console.warn(`[${server.name}] Error parsing message or raw data received:`, e.data);
                }
            };

            eventSource.onerror = (err) => {
                clearTimeout(connectTimeout);
                console.error(`[${server.name}] SSE connection error:`, err);
                
                // Keep the state in memory, but report it
                server.status = 'error'; 
                this.rebuildToolRegistry();
                eventSource.close();
                
                // If it's a UI callback, log it
                this.logTraffic('IN', { error: 'SSE Connection Failed or Closed', details: (err && err.message) ? err.message : 'Unknown network failure' });
                
                reject(err);
            };
            
            // Map resolvers for tracking responses
            server.pendingRequests = new Map();
        });
    }

    /**
     * Internal: Fetches tools using the discovered POST endpoint
     */
    async refreshServerTools(server) {
        if (!server.postEndpoint) throw new Error("No POST endpoint discovered for server");
        
        const payload = {
            jsonrpc: '2.0',
            id: Date.now().toString(),
            method: 'tools/list',
            params: {}
        };
        this.logTraffic('OUT', payload);

        const response = await fetch(server.postEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        // We'll receive the actual response asynchronously via SSE (or the fetch response depending on server implementation)
        // Standard MCP actually sends responses back in the HTTP response body for tool calls, 
        // while using SSE for progress and notifications.
        const data = await response.json();
        this.logTraffic('IN', data);
        if (data.result && data.result.tools) {
            server.tools = data.result.tools;
            console.log(`[${server.name}] Tools loaded:`, server.tools);
            
            // PHASE-0: Rebuild the tool registry cache now that we have updated tools
            this.rebuildToolRegistry();
        }
    }

    /**
     * Handle progress indicators for long-running tools (e.g. browser_research)
     */
    handleProgress(server, params) {
        const { progressToken, progress, total, message } = params;
        console.log(`[Progress ${progressToken}] ${message || ''} (${progress}/${total || '?'})`);
        
        // TODO: Dispatch custom event or callback to the Chat UI to show a "Thinking/Searching" badge!
    }

    /**
     * Execute a specific tool on the appropriate server
     * @param {String} llmToolName The LLM-friendly name of the tool (post-collision prefixing)
     * @param {Object} parameters The arguments to pass to the tool
     */
    async executeTool(llmToolName, parameters) {
        const record = this.toolRegistry.get(llmToolName);
        if (!record) {
            throw new Error(`Unknown tool: ${llmToolName}`);
        }

        const server = this.servers.find(s => s.id === record.serverId);
        if (!server || server.status !== 'connected' || !server.postEndpoint) {
            throw new Error(`Server for tool ${llmToolName} is disconnected or unavailable`);
        }

        const requestId = Date.now().toString();
        const progressToken = `prog-${requestId}`; // Ask the server to send progress updates

        console.log(`Executing tool: ${record.originalName} on server ${server.name}`, parameters);

        const payload = {
            jsonrpc: '2.0',
            id: requestId,
            method: 'tools/call',
            params: {
                name: record.originalName,
                arguments: parameters,
                _meta: { progressToken } // enables long-running task events!
            }
        };
        this.logTraffic('OUT', payload);

        // Standard MCP execution over the negotiated POST endpoint
        const response = await fetch(server.postEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!response.ok) throw new Error(`Tool execution failed: ${response.status}`);
        const data = await response.json();
        this.logTraffic('IN', data);
        return data;
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
     */
    generateToolPrompt() {
        if (this.availableTools.length === 0) return "";

        const toolDescriptions = this.getFormattedToolsForLLM().map(t => JSON.stringify(t.function)).join('\n');
        
        return `
You have access to the following tools:
${toolDescriptions}

To invoke a tool, you MUST output a single line with the exact following syntax, self-delimited, without any surrounding markdown formatting or text on that line:
__TOOL_CALL__({"name": "tool_name", "args": {"param1": "value"}})

After you output a tool call, the system will execute it and provide you with a new message containing the result. Do not attempt to guess or hallucinate the tool's result.
`;
    }
}

export const mcpClient = new MCPClient();

// Expose to window for easy testing in the browser console
window.mcpClient = mcpClient;
