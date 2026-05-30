# Features Backlog

> Last updated: 2026-05-30 — post-refactor audit
> 
> **Legend:** [x] = Done, [ ] = Not started, [~] = Partially done

## Message Management
- [x] **Delete Messages**: Add UI to trigger the existing deleteExchange function to remove individual user or assistant messages from the active conversation context.
- [x] **Edit Messages**: Allow editing of past user messages (destructive edit where downstream messages are dropped). [See Dev Plan: Edit](dev_plan_edit.md)
- [x] **Rich-Text Editor for Edit Dialog**: Replace the standard textarea in the message edit dialog with the `nui-rich-text` element (without toolbar) for better markdown parsing and editing experience.

## Performance & Telemetry
- [x] **Tokens Per Second (TPS) + Time to First Token (TTFT)**: Displayed in context bar after stream completes (`chat.js` L2651-2654). Both TPS and TTFT are tracked via `streamStats` on the exchange.
- [ ] **Total Generation Time**: Show the overall time taken for the API to complete the response. (TTFT + total duration are tracked internally but not displayed distinctly.)

## Workspace & Context Management
- [x] **Context Usage Display**: Show current context token usage with progress indicator in the chat header.
- [x] **Import/Export Chat Session**: Debug export (clipboard, no images) + full export (file, with images) + import (file restore).
- [x] **Chat Organization Utilities**: Pin conversations to top of history list + Clone/duplicate existing sessions.
- [x] **Chat Statistics**: View creation times and message turn counts inside the Chat Options dialog.
- [x] **Compact Sidebar**: Consolidate chat actions into a dialog to reduce UI clutter.
- [x] **System Prompt Presets**: Save, name, and quickly select frequently used system prompts from the sidebar (`chat.js` `setupPresets`, `loadPresets`, `savePresets`). Stored in localStorage via `storage.getPref`.
- [ ] **Chat Summarization Generator**: Automatically or manually trigger an LLM to read the current chat and generate a non-destructive, highly condensed markdown summary. (Arena has `summarize()` — direct chat does not.)
- [ ] **Real-time Input Token Estimator**: Show an estimated token count for the user's input draft before they hit send.

## Input & Rich Media
- [x] **Rich-Text Editor Input**: Replace the standard message input textarea with the NUI library's `<nui-rich-text>` component (without toolbar).
- [x] **Markdown Support in User Message**: Render user inputs using markdown when displayed in the chat history.
- [x] **Multiline Input**: Resolved by Rich-Text Editor transition.
- [x] **Image Paste Support**: Allow users to paste images directly from their clipboard into the chat interface as attachments.
- [x] **File Upload Support**: Allow users to upload and attach images via file picker.

## System & Visualization
- [x] **Realtime Process Status Blocks**: Display realtime server status updates (e.g., compaction progress, upload status) via progress indicators in assistant message area.
- [ ] **Tool Execution Status UI**: Display realtime MCP tool executions with status badges, progress, and result expansion — similar to VS Code Copilot's tool-use UI. Current tool UI is basic (collapsible box with Pending/Success/Error badges).

## Network & Connection
- [x] **Streaming Crash Self-Healing**: Properly intercept backend or API aborts (e.g., HTTP 400) mid-stream and auto-inject the raw system error into the completion array.
- [x] **SSE Operation Mode**: SSE is the **default** mode (`'sse'` in server-generated config.js). Full SSE streaming path implemented in `client-sdk.js` (`_streamChatIterableSSE`). WebSocket is also available.

## Rich Media & Binary Support
- [ ] **Automatic Thumbnail Generation for Unsupported Image Formats**: Use the nMedia service to generate thumbnails for image formats not natively supported by browsers (e.g., HEIC, TIFF, RAW). Thumbnails render inline while the original file is available for download.
- [ ] **Expand Binary Support (PDF, Audio, Video, Arbitrary Files)**: Allow attaching and previewing non-image binary files — PDFs, audio clips, video, documents, etc. Requires Gateway-side features for file handling, MIME type routing, and media processing. Blocked on Gateway backend changes.

## Search
- [ ] **Scoped Search (Chat vs. Arena)**: Both normal (text) and vector (semantic) search should list sessions separately — chat results in one group, arena results in another. Currently `/api/search` returns mixed results with `filter_mode: 'direct|arena|all'` but the UI doesn't differentiate. The landing/search results view should clearly partition conversations by type.
- [ ] **Full-Text Search Parity**: The hybrid search (`search_type: 'hybrid'`) falls back to text-only when nVDB returns no results. Ensure text search (FTS) has complete coverage — currently some exact-word queries miss due to FTS index gaps (see `bugs.md`).

## Per-User Feature Flags
- [ ] **Granular User Rights**: Extend the existing `rights` object beyond `{ login, read, write, admin }` to control feature access per user:
  - `arenaAccess` — whether the user can access the Chat Arena
  - `mcpAccess` — whether the user can connect external MCP servers (separate from built-in archive tools)
  - `autoEmbed` — whether the user's messages are automatically embedded (on by default, disable for privacy-sensitive use)
  - `visionAccess` — whether the user can use MCP Vision tools
  - `exportAccess` — whether the user can export/import conversations
- [ ] **Rights Enforcement in Backend**: All new rights flags must be enforced server-side (not just UI-hidden). The `requireAuth()` middleware should accept an optional rights mask. Admin UI should expose these toggles alongside existing `login/read/write/admin` checkboxes.
- [ ] **Rights Enforcement in Frontend**: UI should hide/disable features based on the user's rights object returned by `GET /api/auth/session`. Arena button, MCP config panel, export buttons, and vision toggle should all respect the flags.

## Navigation & Mode Switching
- [ ] **Open Arena in New Tab**: Add a "Chat Arena" button to Chat's header that opens `/chat-arena/` in a new browser tab (`target="_blank"`). Arena already has a "Back to Chat" link. Both modes remain fully independent — each runs in its own window, sharing the same backend/auth via cookies but with no cross-window coupling. This is intentional: Chat and Arena are different kinds of experience and should not share a tab.

## Technical Debt / Code Cleanup
- [ ] **User Management Refactor**: Current cookie-based auth with nDB user isolation works but is rigid. The `config.json` users array + env var SUPERADMIN bootstrap pattern functions correctly for Phase 2 signoff, but deserves a more elegant design in future iterations.
