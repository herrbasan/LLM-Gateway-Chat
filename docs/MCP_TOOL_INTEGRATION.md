# MCP Tool Integration - Frontend-Driven Architecture

> **Last Updated:** 2026-03-22

## Overview

MCP tool execution is handled **entirely on the frontend (browser)**. The backend gateway is only involved in forwarding chat messages to the LLM provider - it has no role in tool detection or execution.

```
┌─────────────────┐         ┌─────────────────┐         ┌─────────────────┐
│   Chat UI       │         │  LLM Gateway    │         │   LLM Provider  │
│   (Frontend)    │────────▶│  (Backend)      │────────▶│   (KIMI, etc)  │
└─────────────────┘         └─────────────────┘         └─────────────────┘
        │                                                    │
        │  1. User message                                  │ Raw text stream
        │◀─────────────────────────────────────────────────┘
        │  2. LLM response with __TOOL_CALL__ text         │
        │                                                    │
        ▼                                                    │
┌─────────────────┐                                           │
│ MCP Servers     │◀── 3. Execute tool directly             │
│ (Browser-side)  │    (no backend involved)               │
└─────────────────┘                                           │
        │                                                    │
        │  4. Send result in new chat request               │
        ▼                                                    │
┌─────────────────┐                                           │
│ Backend just forwards - no tool awareness                  │
└─────────────────┘
```

## Architecture Decision

**Why Frontend-Driven?**

- MCP servers connect directly to the **browser** via SSE, not the backend
- Tool execution requires browser APIs (fetch, WebSocket to MCP servers)
- Backend has no visibility into MCP server state or available tools
- Simpler architecture - fewer moving parts, no coordination with backend

## Tool Invocation Flow

### Step 1: User Sends Message

Frontend sends chat request to backend with:
- Messages array (including system prompt with tool descriptions)
- `tools` array (OpenAI format)
- `stream: true`

```json
{
  "model": "kimi-chat",
  "messages": [
    { "role": "system", "content": "You have access to the following tools..." },
    { "role": "user", "content": "Search my memories" }
  ],
  "tools": [{ "type": "function", "function": { "name": "recall", ... } }],
  "stream": true
}
```

### Step 2: LLM Responds with Tool Call

LLM outputs `__TOOL_CALL__` syntax in response text:

```
I'll search for that...
__TOOL_CALL__({"name": "recall", "args": {"query": "memories", "limit": 10}})
```

### Step 3: Frontend Parses and Executes

Frontend detects `__TOOL_CALL__` pattern in streaming text:
1. Stops rendering the stream
2. Extracts tool name and arguments
3. Executes tool via `mcpClient.executeTool(toolName, args)`
4. Collects result

### Step 4: Result Sent as New Request

Frontend creates a new user message with the result and sends it:

```json
{
  "role": "user",
  "content": "<tool_result>\n  <tool_name>recall</tool_name>\n  <status>success</status>\n  <output>\n{\"results\": [...]}\n  </output>\n</tool_result>"
}
```

Backend simply forwards this as a normal chat message. No special tool handling needed.

## Implementation Details

### Frontend Components

| File | Role |
|------|------|
| `chat/js/mcp-client.js` | MCP server connections, tool registry, execution |
| `chat/js/chat.js` | `__TOOL_CALL__` text parsing, stream handling, execution orchestration |
| `chat/js/conversation.js` | Tool exchange storage, message formatting for API |

### Key Functions

#### `mcpClient.getFormattedToolsForLLM()`
Returns tools in OpenAI `tools` array format for the request body.

#### `mcpClient.generateToolPrompt()`
Returns system prompt text with tool descriptions and `__TOOL_CALL__` syntax instructions.

#### `mcpClient.executeTool(llmToolName, parameters)`
Looks up tool in registry, routes to correct MCP server, executes via JSON-RPC.

#### `streamResponse()` in chat.js
Handles SSE streaming, detects `__TOOL_CALL__` patterns, manages tool execution flow.

### System Prompt Format

```
You have access to the following tools:
{"name": "recall", "description": "Search memories...", "parameters": {...}}

To invoke a tool, you MUST output a single line with the exact following syntax, self-delimited, without any surrounding markdown formatting or text on that line:
__TOOL_CALL__({"name": "tool_name", "args": {"param1": "value"}})

After you output a tool call, the system will execute it and provide you with a new message containing the result formatted like this:
<tool_result>
  <tool_name>...</tool_name>
  <status>success|error</status>
  <output>...</output>
</tool_result>
Do not attempt to guess or hallucinate the tool's result.
```

### Tool Call Text Format

```
__TOOL_CALL__({"name": "recall", "args": {"query": "memories", "limit": 10}})
```

- Must be on its own line
- Valid JSON payload
- Self-delimiting (no end marker needed)

### Code Block Guard

Detection is disabled when inside markdown code fences (` ``` `). LLMs may output tool-like strings in examples - these must be ignored.

### Tool Execution States

UI shows:
- **Pending:** "Running [tool]..." with spinner
- **Success:** Green status, collapsible result box
- **Error:** Red status, "Retry" and "Dismiss & Continue" buttons

### Gateway Protocol Mapping (Shim)

Tool results are sent as user messages since the backend doesn't understand `role: 'tool'`:

```javascript
{
  "role": "user",
  "content": "<tool_result>\n  <tool_name>recall</tool_name>\n  <status>success</status>\n  <output>\n{result_json}\n  </output>\n</tool_result>"
}
```

This shim is handled by `conversation.getMessagesForApi()` in `chat/js/conversation.js`.

## Backend Requirements

**None for tool execution.**

The backend only needs to:
1. Forward chat messages to LLM provider
2. Stream responses back to frontend
3. Handle the `tools` array in the request (pass it through to LLM provider)

The backend does NOT need to:
- Detect tool call patterns
- Execute tools
- Track tool state between requests

## Differences from Native Tool Calling

OpenAI-style "native tool calling" (where the LLM outputs `tool_calls` JSON field) is NOT used. Instead:

- LLM learns from system prompt text
- LLM outputs `__TOOL_CALL__` as plain text
- Frontend parses the text directly

This works across all LLM providers regardless of their native tool calling support.

## File Inventory

### Core Files (Frontend Only)

- `chat/js/mcp-client.js` - MCP client implementation
- `chat/js/chat.js` - Chat UI and stream handling
- `chat/js/conversation.js` - Conversation state and message formatting
- `chat/js/client-sdk.js` - WebSocket communication with backend

### Documentation

- `docs/MCP_TOOL_INTEGRATION.md` - This document

### Obsolete / To Delete

The following documents described the backend-involved approach and are now obsolete:
- `docs/mcp_structured_events_proposal.md`
- `docs/mcp_integration_spec.md`
- `docs/mcp_integration_dev_plan.md`
- `docs/HANDOVER_MCP_FRONTEND.md`

## Testing Checklist

- [ ] MCP server connects successfully
- [ ] Tools appear in system prompt when exported
- [ ] LLM recognizes available tools
- [ ] LLM outputs `__TOOL_CALL__` syntax when using tools
- [ ] Frontend detects and intercepts tool call
- [ ] Tool executes via MCP server
- [ ] Result appears in chat
- [ ] LLM continues conversation after tool result
- [ ] Tool errors show proper UI states
- [ ] Multiple sequential tool calls work
