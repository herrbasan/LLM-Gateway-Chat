# Development Plan: Frontend-Driven MCP Tool Integration (IDE Style)

This plan outlines the phased workflow for integrating Model Context Protocol (MCP) tools.
**For detailed technical requirements, architecture, and UI behaviors for each step, you MUST refer to the [MCP Integration Technical Specification](mcp_integration_spec.md).**

> **CRITICAL - NUI Library Usage:** All UI additions *must* adhere strictly to the ui_wc2 Web Components guidelines.

## Coding Ethics & Philosophy
Before beginning implementation, adhere to the project's core architectural and coding philosophy:
- **Performance & Reliability First:** These are the absolute highest priorities for all technical decisions.
- **AI-First Maintainability:** Code is designed to be maintained by LLMs, not humans. Ignore human 'clean code' dogmas. Write optimal, intuitive, and deterministically clear code for an LLM parsing the AST. Prefer explicit, flat logic and dense colocation. Strictly limit comments to structural markers.
- **Vanilla Tech Stack:** Pure Vanilla JS, HTML, and CSS. Locally Vendored Dependencies Only. No package managers at runtime (no npm, no build steps, no heavy frameworks).
- **Backend Limitations:** Do not build complex frontend workarounds for backend LLM Gateway limitations. Suggest backend modifications instead.
- **NUI Web Components:** Always use `nui_wc2` components (e.g., `<nui-input>`, `<nui-button>`). Do not use custom HTML elements or custom CSS for basic styling. Leverage NUI theme variables (e.g., `--nui-bg`, `--nui-accent`) for consistent styling.

## Phase 0: Prerequisites & Critical Fixes

> **Verify file paths before starting:** Confirm `chat/js/mcp-client.js`, `chat/js/chat.js`, `chat/js/conversation.js`, and `chat/index.html` exist. Update phase references if paths differ.

1. **Fix Tool State Tracking (chat/js/mcp-client.js)**
   - Cache availableTools on the tools/list response to prevent silent failures.
   - Add reconnection handling and tool name collision prefixing per spec.
   - *Spec Reference:* [1.1 Tool State Tracking](mcp_integration_spec.md#11-tool-state-tracking)

## Phase 1: Storage Abstraction and State Management

2. **Create Storage Adapter (chat/js/mcp-client.js)**
   - Implement storage abstractions without breaking legacy synchronous callers.
   - *Spec Reference:* [1.2 StorageAdapter Interface](mcp_integration_spec.md#12-storageadapter-interface)

3. **Extend Core Logic (chat/js/mcp-client.js)**
   - Map enabledTools using Map<serverId, Map<toolName, boolean>>.
   - Update generateToolPrompt() for the new strict JSON syntax.
   - *Spec Reference:* [2. LLM Tool Invocation Syntax](mcp_integration_spec.md#2-llm-tool-invocation-syntax)

## Phase 2: MCP Settings UI

> **Note:** Phase 2 UI scaffolding can begin once Phase 1's type definitions exist. Full Phase 1 completion is not required.

4. **Build MCP Settings Tab (chat/index.html & chat/js/chat.js)**
   - Implement server addition, connection cards, toggles, and logs using nui_wc2 components.
   - *Spec Reference:* [4.1 MCP Configuration Settings](mcp_integration_spec.md#41-mcp-configuration-settings)

## Phase 3: Tool Execution Loop & IDE-Style UI

5. **Introduce "Tool" Message Type (chat/js/conversation.js & chat/js/chat.js)**
   - Support role: 'tool' with distinct UI rendering states.
   - *Spec Reference:* [4.2 IDE-Style Tool Execution Messages](mcp_integration_spec.md#42-ide-style-tool-execution-messages)

6. **LLM Payload Mapping & Prompt Injection (chat/js/chat.js)**
   - Inject the updated prompt instructions and implement the payload shim for the backend.
   - *Spec Reference:* [5. Gateway Protocol Mapping (Shim)](mcp_integration_spec.md#5-gateway-protocol-mapping-shim)

7. **Robust Execution Interception (chat/js/chat.js)**
   - Read SSE chunks via a line-buffered streaming JSON parser looking for __TOOL_CALL__.
   - Implement code block guard (ignore __TOOL_CALL__ inside markdown fences).
   - *Spec Reference:* [3. SSE Interception & Parsing Loop](mcp_integration_spec.md#3-sse-interception--parsing-loop)

8. **Execution Error Handling (chat/js/chat.js)**
   - Wrap tool execution, render visual error states, and resume automatically.
   - *Spec Reference:* [4.2 IDE-Style Tool Execution Messages](mcp_integration_spec.md#42-ide-style-tool-execution-messages)

## Phase 4: Testing & Validation

9. **Integration Testing**
   - Test tool listing, enabling/disabling, and execution across multiple servers.
   - Test reconnection scenarios (server disconnects and reconnects).
   - Test code block false-positive guard.
   - Test tool name collision handling.

## Process & Maintenance Practices

- **Traceability:** Add `// PHASE-X:` marker comments in the code to ensure the plan reflects the code state natively.
- **Security:** Consider adding a "Requires Confirmation" safeguard setting for destructive tools, forcing the user to explicitly "Approve" local tool actions.