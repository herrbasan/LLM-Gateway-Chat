# Features Backlog

## Message Management
- [x] **Delete Messages**: Add UI to trigger the existing deleteExchange function to remove individual user or assistant messages from the active conversation context.
- [x] **Edit Messages**: Allow editing of past user messages (destructive edit where downstream messages are dropped). [See Dev Plan: Edit](dev_plan_edit.md)
- [x] **Rich-Text Editor for Edit Dialog**: Replace the standard textarea in the message edit dialog with the `nui-rich-text` element (without toolbar) for better markdown parsing and editing experience.

## Performance & Telemetry
- [ ] **Tokens Per Second (TPS)**: Display real-time and final generation speeds (Tokens/sec).
- [ ] **Time to First Token (TTFT)**: Track and display the delay before the first chunk is received.
- [ ] **Total Generation Time**: Show the overall time taken for the API to complete the response.

## Workspace & Context Management
- [x] **Context Usage Display**: Show current context token usage with progress indicator in the chat header.
- [x] **Import/Export Chat Session**: 
  - Debug export (clipboard): JSON without images for debugging
  - Full export (file): JSON with embedded images for backup/restore
  - Import (file): Restore from full export file
- [x] **Chat Organization Utilities**: Ability to Pin conversations to the top of the history list and Clone/duplicate existing sessions.
- [x] **Chat Statistics**: View creation times and message turn counts inside the Chat Options dialog.
- [x] **Compact Sidebar**: Consolidate chat actions into a dialog to reduce UI clutter.
- [ ] **Chat Summarization Generator**: Automatically or manually trigger an LLM to read the current chat and generate a non-destructive, highly condensed markdown summary to save space and context.
- [ ] **System Prompt Presets**: Save, name, and quickly select frequently used system prompts directly from the sidebar.
- [ ] **Real-time Input Token Estimator**: Show an estimated token count for the user's input draft before they hit send.

## Input & Rich Media
- [x] **Rich-Text Editor Input**: Replace the standard message input textarea with the NUI library's `<nui-rich-text>` component (configured without its toolbar). This will allow users to paste markdown into the prompt input in a readable but still fully editable format.
- [x] **Markdown Support in User Message**: Render user inputs using markdown when displayed in the chat history.
- [x] **Multiline Input**: Improve text area behavior for proper multiline support. (Resolved by Rich-Text Editor transition).
- [x] **Image Paste Support**: Allow users to paste images directly from their clipboard into the chat interface as attachments.
- [x] **File Upload Support**: Allow users to upload and attach images via file picker.

## System & Visualization
- [x] **Realtime Process Status Blocks**: Display realtime server status updates (e.g., compaction progress, upload status) via progress indicators in assistant message area.
- [ ] **Tool Execution Status**: Display realtime MCP tool executions and MediaService tasks similar to VS Code Copilot's tool-use UI.

## Network & Connection
- [x] **Streaming Crash Self-Healing**: Properly intercept backend or API aborts (e.g., HTTP 400) mid-stream and auto-inject the raw system error into the completion array so the LLM is aware of the failure context.
- [ ] **SSE Operation Mode**: Support Server-Sent Events (SSE) as an optional operation mode for chat messaging and streaming (pending backend support).
## Technical Debt / Code Cleanup
- [ ] **User Management Refactor**: The current user management approach (passing ackendClient.user via cookies, setting explicit folders in Node) is functioning and provides isolation, but is very clunky. Need to design and implement a more robust identity and session management system in the future.
