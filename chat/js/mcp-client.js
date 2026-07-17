/**
 * MCP (Model Context Protocol) Client
 * Handles connections to local or remote MCP servers via SSE (Server-Sent Events)
 * and tool execution coordination for the chat application.
 */

class MCPClient {
    constructor() {
        this.servers = []; // List of active MCP server connections
        this.availableTools = []; // Cached flattened list of active tools mapped for the LLM
        this.toolRegistry = new Map(); // internal global lookup map: llmName -> { serverId, originalName, definition }
        this.enabledTools = new Map(); // Map<serverId, Map<toolName, boolean>>
        this.pendingRequests = new Map(); // requestId -> { resolve, reject, server } for SSE responses
        this._configLoaded = false;
        this._reqCounter = 0; // monotonic suffix for unique request IDs
        // Resource state per server
        this._resources = new Map(); // serverId -> { resources: [], templates: [], initializedAt: number }
    }

    /**
     * Unique request ID. Date.now() alone collides when two calls fire in the
     * same millisecond — the second pendingRequests.set() overwrites the first,
     * and the orphaned stream dies with "MCP stream ended without response".
     * Counter + random suffix makes collisions impossible.
     */
    _nextRequestId() {
        this._reqCounter = (this._reqCounter + 1) % 0xffff;
        return `${Date.now().toString(36)}-${this._reqCounter.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    }

    /**
     * Load MCP config from localStorage. Call once after app init.
     */
    async ready() {
        if (this._configLoaded) return;
        this._configLoaded = true;

        const storedServers = localStorage.getItem('mcp-servers');
        if (storedServers) {
            this.servers = JSON.parse(storedServers);
            this.servers.forEach(s => s.status = 'disconnected');
        }

        const storedEnabledTools = localStorage.getItem('mcp-enabledTools');
        if (storedEnabledTools) {
            const parsedTools = JSON.parse(storedEnabledTools);
            this.enabledTools = new Map(
                Object.entries(parsedTools).map(([serverId, toolsObj]) => [
                    serverId,
                    new Map(Object.entries(toolsObj))
                ])
            );
        }
    }

    saveConfig() {
        const serversToStore = this.servers.map(s => ({
            id: s.id,
            url: s.url,
            name: s.name,
            status: 'disconnected'
        }));
        localStorage.setItem('mcp-servers', JSON.stringify(serversToStore));

        const serializedTools = {};
        for (const [serverId, toolsMap] of this.enabledTools.entries()) {
            serializedTools[serverId] = Object.fromEntries(toolsMap);
        }
        localStorage.setItem('mcp-enabledTools', JSON.stringify(serializedTools));
    }

    logTraffic(direction, payload) {
        const time = new Date().toISOString().split('T')[1].split('.')[0];
        const prefix = direction === 'IN' ? '<<' : '>>';
        console.log(`[MCP] [${time}] ${prefix} ${JSON.stringify(payload)}`);
    }

    addServer(url, name) {
        const id = this._nextRequestId();
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
            if (server._reconnectTimer) {
                clearTimeout(server._reconnectTimer);
                delete server._reconnectTimer;
            }
            delete server._reconnectAttempt;
            delete server._pendingToolListRequest;
            if (server.eventSource) {
                server.eventSource.close();
                server.eventSource = null;
            }
            server.status = 'disconnected';
            server.tools = [];
            this._resources.delete(id);
            this.rebuildToolRegistry();
        }
    }

    // Get resources for a connected server
    getServerResources(serverId) {
        return this._resources.get(serverId);
    }

    // Get all resources across connected servers
    getAllResources() {
        const result = [];
        for (const [serverId, entry] of this._resources.entries()) {
            const server = this.servers.find(s => s.id === serverId);
            const serverName = server?.name || serverId;
            for (const resource of entry.resources || []) {
                result.push({ ...resource, _serverId: serverId, _serverName: serverName });
            }
        }
        return result;
    }

    // Get all resource templates across connected servers
    getAllResourceTemplates() {
        const result = [];
        for (const [serverId, entry] of this._resources.entries()) {
            const server = this.servers.find(s => s.id === serverId);
            const serverName = server?.name || serverId;
            for (const template of entry.templates || []) {
                result.push({ ...template, _serverId: serverId, _serverName: serverName });
            }
        }
        return result;
    }

    /**
     * Discover resources and templates on a server after tools/list succeeds.
     * Mutates server._resources and the global cache.
     */
    async discoverResources(server) {
        if (!server?.capabilities?.resources) {
            this._resources.set(server.id, { resources: [], templates: [], initializedAt: Date.now() });
            return;
        }

        let resources = [];
        let templates = [];

        try {
            resources = await this.listResources(server);
        } catch (err) {
            console.warn(`[${server.name}] resources/list failed:`, err.message);
        }

        try {
            templates = await this.listResourceTemplates(server);
        } catch (err) {
            console.warn(`[${server.name}] resources/templates/list failed:`, err.message);
        }

        this._resources.set(server.id, { resources, templates, initializedAt: Date.now() });
    }

    /**
     * Call resources/list with pagination.
     */
    async listResources(server, cursor = null) {
        const all = [];
        let nextCursor = cursor;
        do {
            const result = await this._sendRequest(server, 'resources/list', nextCursor ? { cursor: nextCursor } : {});
            if (result?.resources && Array.isArray(result.resources)) {
                all.push(...result.resources);
            }
            nextCursor = result?.nextCursor || null;
        } while (nextCursor);
        return all;
    }

    /**
     * Call resources/templates/list.
     */
    async listResourceTemplates(server) {
        const result = await this._sendRequest(server, 'resources/templates/list', {});
        return result?.resourceTemplates || [];
    }

    /**
     * Read a resource by URI. Returns MCP result shape { contents: [...] }.
     */
    async readResource(serverId, uri) {
        const server = this.servers.find(s => s.id === serverId);
        if (!server) throw new Error(`readResource: server ${serverId} not found`);
        if (server.status !== 'connected') throw new Error(`readResource: server ${server.name} is not connected`);
        return this._sendRequest(server, 'resources/read', { uri });
    }

    /**
     * Subscribe/unsubscribe to a resource URI (server currently no-ops).
     */
    async subscribeResource(serverId, uri) {
        const server = this.servers.find(s => s.id === serverId);
        if (!server) throw new Error(`subscribeResource: server ${serverId} not found`);
        if (server.status !== 'connected') throw new Error(`subscribeResource: server ${server.name} is not connected`);
        return this._sendRequest(server, 'resources/subscribe', { uri });
    }

    async unsubscribeResource(serverId, uri) {
        const server = this.servers.find(s => s.id === serverId);
        if (!server) throw new Error(`unsubscribeResource: server ${serverId} not found`);
        if (server.status !== 'connected') throw new Error(`unsubscribeResource: server ${server.name} is not connected`);
        return this._sendRequest(server, 'resources/unsubscribe', { uri });
    }

    /**
     * Internal: send a JSON-RPC request and wait for the response.
     * Uses the same pendingRequests map used by tools/call.
     */
    async _sendRequest(server, method, params = {}) {
        if (!server.postEndpoint) throw new Error(`No POST endpoint for server ${server.name}`);

        const requestId = Date.now().toString() + Math.random().toString(36).slice(2, 8);
        const payload = { jsonrpc: '2.0', id: requestId, method, params };

        return new Promise((resolve, reject) => {
            let settled = false;
            const timeoutId = setTimeout(() => {
                if (settled) return;
                settled = true;
                this.pendingRequests.delete(requestId);
                reject(new Error(`MCP ${method} timeout`));
            }, 30000);

            const cleanup = (err, result) => {
                if (settled) return;
                settled = true;
                clearTimeout(timeoutId);
                this.pendingRequests.delete(requestId);
                if (err) reject(err); else resolve(result);
            };

            this.pendingRequests.set(requestId, {
                resolve: (result) => cleanup(null, result),
                reject: (err) => cleanup(err),
                cancelTimeout: () => clearTimeout(timeoutId),
                server
            });

            this._sendPost(server, payload, requestId, resolve, reject).catch(err => cleanup(err));
        });
    }

    /**
     * Internal: POST a JSON-RPC payload. For streamable HTTP the response body
     * may carry the result; for legacy SSE the response arrives on the main SSE
     * stream and is handled by handleResponse through pendingRequests.
     */
    async _sendPost(server, payload, requestId, resolve, reject) {
        console.log(`[MCP] POST ${payload.method} → ${server.name}`);
        const response = await fetch(server.postEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const text = await response.text();
            throw new Error(`HTTP ${response.status}: ${text}`);
        }

        // Streamable HTTP: read SSE body for our response
        this._readSSEBodyForId(response, requestId, resolve, reject);
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
        // Cancel any pending reconnect (in case this is a manual reconnect)
        if (server._reconnectTimer) {
            clearTimeout(server._reconnectTimer);
            delete server._reconnectTimer;
        }
        // Cancel stale tools/list timeout from a previous connection
        delete server._pendingToolListRequest;

        // The server exposes /sse for SSE endpoint discovery and /message for POST requests
        // Derive the SSE URL from the server URL (replace /mcp or /message with /sse if needed)
        let sseUrl = server.url;
        if (sseUrl.includes('/message')) {
            sseUrl = sseUrl.replace('/message', '/sse');
        } else if (sseUrl.endsWith('/mcp/compact')) {
            sseUrl = sseUrl.replace('/mcp/compact', '/sse/compact');
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
                delete server._reconnectAttempt; // reset backoff on successful connection
                server.eventSource = { close: () => {} }; // compat shim

                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let buffer = '';

                const read = () => {
                    return reader.read().then(({ done, value }) => {
                        if (done) return; // stream ended cleanly, chain resolves
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

                        return read(); // chain the next read
                    });
                };

                // Start reading; when the stream ends (clean or error), schedule reconnect
                read().then(() => {
                    console.log(`[${server.name}] SSE stream ended cleanly, reconnecting...`);
                    this._scheduleReconnect(server);
                }).catch(err => {
                    console.error(`[${server.name}] SSE read error:`, err);
                    this._scheduleReconnect(server);
                });
            }).catch(err => {
                console.error(`[${server.name}] SSE connection failed:`, err);
                this._scheduleReconnect(server);
                reject(err);
            });
        });
    }

    /**
     * Schedule an auto-reconnect attempt with exponential backoff.
     * @param {Object} server The server that disconnected
     */
    _scheduleReconnect(server) {
        // Don't schedule if already reconnecting or disconnected manually
        if (server._reconnectTimer) return;
        if (server.status === 'disconnected') return;

        const attempt = (server._reconnectAttempt || 0) + 1;
        server._reconnectAttempt = attempt;
        server.status = 'reconnecting';
        this.rebuildToolRegistry();
        // Notify UI to show reconnecting status
        if (typeof window !== 'undefined' && window.refreshMCPServersUI) {
            window.refreshMCPServersUI();
        }

        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 30000); // 1s, 2s, 4s, 8s, ..., max 30s
        console.log(`[${server.name}] Reconnect attempt ${attempt} in ${delay}ms`);

        server._reconnectTimer = setTimeout(() => {
            delete server._reconnectTimer;
            this.connectToServer(server).catch(() => {
                // connectToServer calls _scheduleReconnect on failure, so nothing to do here
            });
        }, delay);
    }

    /**
     * Internal: Fetches tools using the discovered POST endpoint.
     * Handles BOTH transport modes:
     *   - Legacy SSE: response arrives on the main SSE stream (_pendingToolListRequest)
     *   - Streamable HTTP: response arrives on the POST response body as SSE
     * Whichever path delivers first wins.
     */
    async refreshServerTools(server) {
        if (!server.postEndpoint) throw new Error("No POST endpoint discovered for server");

        const requestId = this._nextRequestId();
        const payload = {
            jsonrpc: '2.0',
            id: requestId,
            method: 'tools/list',
            params: {}
        };

        return new Promise((resolve, reject) => {
            let settled = false;

            const onSuccess = (result) => {
                // result is data.result (full JSON-RPC result object) from either path
                const tools = result?.tools;
                if (!tools || !Array.isArray(tools)) {
                    onError(new Error('Unexpected response format: missing tools array'));
                    return;
                }
                if (settled) return;
                settled = true;
                clearTimeout(timeoutId);
                delete server._pendingToolListRequest;
                server.tools = tools;
                server.capabilities = server.capabilities || result?._meta?.capabilities || null;
                this.rebuildToolRegistry();
                // Discover resources if the server advertises the capability
                this.discoverResources(server).catch(err => {
                    console.warn(`[${server.name}] Resource discovery failed:`, err.message);
                });
                if (typeof window !== 'undefined' && window.refreshMCPServersUI) {
                    window.refreshMCPServersUI();
                }
                resolve();
            };

            const onError = (err) => {
                if (settled) return;
                settled = true;
                clearTimeout(timeoutId);
                delete server._pendingToolListRequest;
                reject(err);
            };

            const timeoutId = setTimeout(() => {
                onError(new Error('Timeout waiting for tools/list response'));
            }, 10000);

            // Path 1: Legacy SSE — response comes on the main SSE stream.
            // The connectToServer SSE handler routes messages to _pendingToolListRequest.onResponse.
            server._pendingToolListRequest = {
                requestId: requestId,
                onResponse: (data) => {
                    if (data.error) {
                        onError(new Error(`MCP error: ${data.error.message}`));
                    } else if (data.result) {
                        onSuccess(data.result);
                    } else {
                        onError(new Error('Unexpected response format'));
                    }
                }
            };

            // Send the POST request
            fetch(server.postEndpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'text/event-stream'
                },
                body: JSON.stringify(payload)
            }).then(async (response) => {
                if (!response.ok) {
                    const text = await response.text();
                    return onError(new Error(`HTTP ${response.status}: ${text}`));
                }

                // Path 2: Streamable HTTP — response comes on the POST response body as SSE.
                // Read the body in parallel with Path 1; whichever delivers first wins.
                this._readSSEBodyForId(response, requestId, onSuccess, onError);
            }).catch(err => {
                onError(err);
            });
        });
    }

    /**
     * Read an SSE response body, looking for a JSON-RPC response matching requestId.
     * Used for both tools/list (refreshServerTools) and tools/call (executeToolStreamableHttp).
     * @param {Response} response - Fetch Response with SSE body
     * @param {String} requestId - JSON-RPC request ID to match
     * @param {Function} onSuccess - Called with result object when matching response found
     * @param {Function} onError - Called with Error on stream/parse failure
     */
    _readSSEBodyForId(response, requestId, onSuccess, onError) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        const read = () => {
            return reader.read().then(({ done, value }) => {
                if (done) return;
                buffer += decoder.decode(value, { stream: true });
                buffer = buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

                while (buffer.includes('\n\n')) {
                    const msgEnd = buffer.indexOf('\n\n');
                    const rawMsg = buffer.slice(0, msgEnd);
                    buffer = buffer.slice(msgEnd + 2);

                    if (rawMsg.startsWith(':')) continue;

                    let eventData = '';
                    for (const line of rawMsg.split('\n')) {
                        if (line.startsWith('data:')) {
                            eventData = line.slice(5).trim();
                        }
                    }

                    if (!eventData) continue;

                    try {
                        const data = JSON.parse(eventData);
                        if (data.id && String(data.id) === requestId) {
                            if (data.error) {
                                onError(new Error(`MCP error: ${data.error.message || JSON.stringify(data.error)}`));
                            } else {
                                onSuccess(data.result);
                            }
                            return; // Found our response, stop reading
                        }
                        // Not our response — could be a notification or a different request.
                        // Ignore and continue reading.
                    } catch (e) {
                        // Ignore malformed JSON in SSE stream
                    }
                }

                return read();
            });
        };

        read().catch(err => {
            onError(err);
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
        console.log(`[MCP handleResponse] requestId=${requestId} found=${!!pending} error=${!!data.error} resultType=${typeof data.result}`);
        if (pending) {
            this.pendingRequests.delete(requestId);
            if (pending.cancelTimeout) {
                pending.cancelTimeout();
            }
            if (data.error) {
                console.error('[MCP handleResponse] Rejecting with:', data.error.message || data.error);
                pending.reject(new Error(`MCP error: ${data.error.message || JSON.stringify(data.error)}`));
            } else {
                console.log('[MCP handleResponse] Resolving with result');
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
        console.log(`[MCP SSE] POST fetch → ${server.postEndpoint} | method=${payload.method} name=${payload.params?.name}`);

        const response = await fetch(server.postEndpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'text/event-stream'
            },
            body: JSON.stringify(payload)
        });

        console.log(`[MCP SSE] Response: status=${response.status} ok=${response.ok} type=${response.headers.get('content-type')}`);

        if (!response.ok) {
            const text = await response.text();
            console.error(`[MCP SSE] HTTP error body:`, text.slice(0, 500));
            throw new Error(`HTTP ${response.status}: ${text}`);
        }

        // Response is SSE (text/event-stream) - parse manually from fetch stream
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let eventCount = 0;

        console.log('[MCP SSE] Starting SSE reader loop...');

        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                console.log(`[MCP SSE] Stream ended after ${eventCount} events`);
                // Stream closed without a matching response for our requestId.
                // This is a zombie — the pending promise has no resolution path.
                // Force-fail it.
                const pending = this.pendingRequests.get(requestId);
                if (pending) {
                    console.error(`[MCP SSE] Stream ended with NO matching response for requestId=${requestId}`);
                    this.pendingRequests.delete(requestId);
                    if (pending.cancelTimeout) pending.cancelTimeout();
                    pending.reject(new Error('MCP stream ended without response'));
                }
                break;
            }

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

                let data;
                try {
                    data = JSON.parse(fields.data);
                } catch (e) {
                    console.warn('[MCP SSE] Skipping unparseable event data:', fields.data.slice(0, 100));
                    continue;
                }

                eventCount++;
                const hasId = !!data.id;
                const hasMethod = !!data.method;
                console.log(`[MCP SSE] Event #${eventCount}: id=${data.id || 'NONE'} method=${data.method || 'NONE'} hasError=${!!data.error} hasResult=${!!data.result}`);

                if (data.method && !data.id) {
                    if (data.method === 'notifications/progress') {
                        this.handleProgress(server, data.params);
                    }
                    continue;
                }
                if (data.id) {
                    const isMatch = String(data.id) === requestId;
                    console.log(`[MCP SSE] handleResponse id=${data.id} requestId=${requestId} match=${isMatch}`);
                    this.handleResponse(server, data);
                }
            }
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
        // Internal resource reader tool
        if (llmToolName === 'read_resource') {
            return this.executeReadResource(parameters, chatId);
        }

        console.log('[MCP executeTool] Called for:', llmToolName);

        const record = this.toolRegistry.get(llmToolName);
        if (!record) {
            console.error('[MCP executeTool] Tool not in registry:', llmToolName, 'registry keys:', [...this.toolRegistry.keys()]);
            throw new Error(`Unknown tool: ${llmToolName}`);
        }

        const server = this.servers.find(s => s.id === record.serverId);
        console.log('[MCP executeTool] Server lookup:', server?.name, 'status:', server?.status, 'postEndpoint:', server?.postEndpoint);
        if (!server || server.status !== 'connected') {
            console.error('[MCP executeTool] Server disconnected:', server?.name, server?.status);
            throw new Error(`Server for tool ${llmToolName} is disconnected or unavailable`);
        }

        const requestId = this._nextRequestId();
        const progressToken = `prog-${requestId}`;

        console.log(`[MCP executeTool] Dispatching ${record.originalName} → ${server.name}, requestId=${requestId}`);

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
        console.log('[MCP executeTool] Payload:', JSON.stringify(payload).slice(0, 200));

        // Register pending request for progress/cancel callbacks
        const pendingPromise = new Promise((resolve, reject) => {
            const timeoutDuration = 120000; // 2 minutes setup

            const startTimeout = () => {
                return setTimeout(() => {
                    console.warn('[MCP executeTool] Timeout firing for requestId:', requestId);
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
            console.log('[MCP executeTool] pendingRequests count:', this.pendingRequests.size);
        });

        // Use streamableHTTP (streaming response).
        // Reject the pending promise immediately if the fetch or stream fails.
        this.executeToolStreamableHttp(server, payload).catch(err => {
            console.error('[MCP executeTool] streamableHTTP failed:', err.message);
            const pending = this.pendingRequests.get(payload.id);
            if (pending) {
                this.pendingRequests.delete(payload.id);
                if (pending.cancelTimeout) pending.cancelTimeout();
                pending.reject(err);
            }
        });

        return pendingPromise;
    }

    /**
     * Execute the internal `read_resource` tool by looking up the URI across
     * all connected servers. If the response is a URL pointing to a LAN
     * resource that exceeds inline size, browser_fetch should be used.
     */
    async executeReadResource(parameters, _chatId = null) {
        if (!parameters || typeof parameters !== 'object') throw new Error('read_resource: parameters object required');
        if (typeof parameters.uri !== 'string' || parameters.uri.length === 0) throw new Error('read_resource: uri required');

        const uri = parameters.uri;
        // Find the first server that either has this resource or a matching template
        let targetServer = null;
        for (const server of this.servers) {
            if (server.status !== 'connected') continue;
            const entry = this._resources.get(server.id);
            if (!entry) continue;
            const hasExact = (entry.resources || []).some(r => r.uri === uri);
            if (hasExact) {
                targetServer = server;
                break;
            }
            const hasTemplate = (entry.templates || []).some(t => this._matchUriTemplate(uri, t.uriTemplate));
            if (hasTemplate) {
                targetServer = server;
                break;
            }
        }

        if (!targetServer) {
            // Fallback: try all connected servers if none advertises it
            targetServer = this.servers.find(s => s.status === 'connected');
        }
        if (!targetServer) throw new Error('read_resource: no connected MCP server available');

        const result = await this.readResource(targetServer.id, uri);

        // If server returned an HTTP URL for a large resource, suggest browser_fetch
        // by returning the URL in the response text.
        if (result?.contents && Array.isArray(result.contents)) {
            for (const item of result.contents) {
                if (item.text && typeof item.text === 'string' && (item.text.startsWith('http://') || item.text.startsWith('https://'))) {
                    item.text = item.text + '\n\n[Note: This is a large resource. If the content is too large to use inline, call browser_fetch with the URL above.]\n';
                }
            }
        }

        return result;
    }

    /**
     * Simple URI template matching for RFC 6570 level 1 templates used by MCP.
     * Splits the template on `{...}` segments and replaces them with a non-greedy
     * capture, escaping literal regex metacharacters in the rest.
     */
    _matchUriTemplate(uri, template) {
        if (typeof uri !== 'string' || typeof template !== 'string') return false;
        const parts = template.split(/(\{[^{}]+\})/);
        let regex = '';
        for (const part of parts) {
            if (part.startsWith('{') && part.endsWith('}')) {
                regex += '(.+?)';
            } else {
                regex += part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            }
        }
        const re = new RegExp(`^${regex}$`);
        return re.test(uri);
    }

    /**
     * Converts MCP tool definitions into the format required by LLM APIs
     * (e.g. OpenAI's tools array format)
     */
    getFormattedToolsForLLM() {
        const tools = this.availableTools.map(tool => ({
            type: "function",
            function: {
                name: tool.llmName,
                description: tool.definition.description,
                parameters: tool.definition.inputSchema // JSON schema
            }
        }));

        // Add internal read_resource tool if any server exposes resources/templates
        if (this.getAllResources().length > 0 || this.getAllResourceTemplates().length > 0) {
            tools.push({
                type: "function",
                function: {
                    name: "read_resource",
                    description: "Read the contents of an MCP resource by URI. Use this to fetch files and resources advertised by connected MCP servers. For large resources, the response may contain a URL — use browser_fetch on that URL if the inline content is too large.",
                    parameters: {
                        type: "object",
                        properties: {
                            uri: { type: "string", description: "Resource URI to read (e.g. storage://Agents.md)" }
                        },
                        required: ["uri"]
                    }
                }
            });
        }

        return tools;
    }
}

export const mcpClient = new MCPClient();

// Expose to window for easy testing in the browser console
window.mcpClient = mcpClient;
