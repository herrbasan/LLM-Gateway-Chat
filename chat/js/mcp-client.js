/**
 * MCP (Model Context Protocol) Client
 * Handles connections to local or remote MCP servers via SSE (Server-Sent Events)
 * and tool execution coordination for the chat application.
 */

class MCPClient {
    constructor() {
        this.servers = []; // List of active MCP server connections
        this.availableTools = [];
        this.loadConfig();
    }

    loadConfig() {
        try {
            const stored = localStorage.getItem('mcp-servers');
            if (stored) {
                this.servers = JSON.parse(stored);
            }
        } catch (e) {
            console.error('Failed to load MCP server config', e);
        }
    }

    saveConfig() {
        localStorage.setItem('mcp-servers', JSON.stringify(this.servers));
    }

    addServer(url, name) {
        this.servers.push({ id: Date.now().toString(), url, name, status: 'disconnected' });
        this.saveConfig();
        // TODO: Automatically connect and fetch tools
    }

    removeServer(id) {
        this.servers = this.servers.filter(s => s.id !== id);
        this.saveConfig();
        // TODO: rebuild availableTools list
    }

    /**
     * Connects to a specific MCP server using standard SSE (Server-Sent Events) pattern
     * Based on official @modelcontextprotocol/sdk/client/sse.js flow
     * @param {Object} server The server config object
     */
    async connectToServer(server) {
        console.log(`Connecting to MCP server via SSE: ${server.name} at ${server.url}`);
        
        return new Promise((resolve, reject) => {
            // 1. Establish the SSE connection
            // The standard MCP SSEServerTransport expects a GET request without special headers
            const eventSource = new EventSource(server.url);
            let postEndpoint = server.url; // Fallback if server doesn't provide one

            eventSource.onopen = () => {
                console.log(`[${server.name}] SSE Connection opened`);
                server.status = 'connected';
                server.eventSource = eventSource;
            };

            // 2. Listen for the specific "endpoint" event that MCP servers send to tell us where to POST
            eventSource.addEventListener('endpoint', (e) => {
                postEndpoint = e.data;
                server.postEndpoint = postEndpoint;
                console.log(`[${server.name}] Received POST endpoint: ${postEndpoint}`);
                
                // Now that we have the endpoint, we can fetch tools
                this.refreshServerTools(server).then(resolve).catch(reject);
            });

            // 3. Listen for general messages (JSON-RPC responses and progress updates)
            eventSource.onmessage = (e) => {
                try {
                    const data = JSON.parse(e.data);
                    console.log(`[${server.name}] Received message:`, data);
                    
                    // Handle progress notifications for long-running tools
                    if (data.method === 'notifications/progress') {
                        this.handleProgress(server, data.params);
                    }
                    
                    // Handle JSON-RPC responses
                    if (data.id) {
                        this.handleResponse(server, data);
                    }
                } catch (err) {
                    console.error(`[${server.name}] Error parsing message:`, err);
                }
            };

            eventSource.onerror = (err) => {
                console.error(`[${server.name}] SSE connection error:`, err);
                server.status = 'error';
                eventSource.close();
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
        
        const response = await fetch(server.postEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: Date.now().toString(),
                method: 'tools/list',
                params: {}
            })
        });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        // We'll receive the actual response asynchronously via SSE (or the fetch response depending on server implementation)
        // Standard MCP actually sends responses back in the HTTP response body for tool calls, 
        // while using SSE for progress and notifications.
        const data = await response.json();
        if (data.result && data.result.tools) {
            server.tools = data.result.tools;
            console.log(`[${server.name}] Tools loaded:`, server.tools);
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
     * @param {String} toolName The name of the tool
     * @param {Object} parameters The arguments to pass to the tool
     */
    async executeTool(server, toolName, parameters) {
        if (!server.postEndpoint) throw new Error("Server not connected properly");

        const requestId = Date.now().toString();
        const progressToken = `prog-${requestId}`; // Ask the server to send progress updates

        console.log(`Executing tool: ${toolName}`, parameters);

        // Standard MCP execution over the negotiated POST endpoint
        const response = await fetch(server.postEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: requestId,
                method: 'tools/call',
                params: {
                    name: toolName,
                    arguments: parameters,
                    _meta: { progressToken } // enables long-running task events!
                }
            })
        });

        if (!response.ok) throw new Error(`Tool execution failed: ${response.status}`);
        return await response.json();
    }

    /**
     * Converts MCP tool definitions into the format required by LLM APIs
     * (e.g. OpenAI's tools array format)
     */
    getFormattedToolsForLLM() {
        return this.availableTools.map(tool => ({
            type: "function",
            function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.inputSchema // JSON schema
            }
        }));
    }
}

export const mcpClient = new MCPClient();

// Expose to window for easy testing in the browser console
window.mcpClient = mcpClient;
