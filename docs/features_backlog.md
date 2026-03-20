# Features Backlog

## Message Management
- [x] **Delete Messages**: Add UI to trigger the existing deleteExchange function to remove individual user or assistant messages from the active conversation context.
- [x] **Edit Messages**: Allow editing of past user messages (destructive edit where downstream messages are dropped). [See Dev Plan: Edit](dev_plan_edit.md)
- [ ] **Rich-Text Editor for Edit Dialog**: Replace the standard textarea in the message edit dialog with the `nui-rich-text` element (without toolbar) for better markdown parsing and editing experience.

## Performance & Telemetry
- [ ] **Tokens Per Second (TPS)**: Display real-time and final generation speeds (Tokens/sec).
- [ ] **Time to First Token (TTFT)**: Track and display the delay before the first chunk is received.
- [ ] **Total Generation Time**: Show the overall time taken for the API to complete the response.

## Workspace & Context Management
- [ ] **Import Chat Session**: We already have JSON export; adding a way to *import* a JSON file to resume a session later.
- [ ] **System Prompt Presets**: Save, name, and quickly select frequently used system prompts directly from the sidebar.
- [ ] **Real-time Input Token Estimator**: Show an estimated token count for the user's input draft before they hit send.

## Input & Rich Media
- [ ] **Rich-Text Editor Input**: Replace the standard message input textarea with the NUI library's `<nui-rich-text>` component (configured without its toolbar). This will allow users to paste markdown into the prompt input in a readable but still fully editable format.
- [ ] **Markdown Support in User Message**: Render user inputs using markdown when displayed in the chat history.
- [ ] **Multiline Input**: Improve text area behavior for proper multiline support. (May be resolved by Rich-Text Editor transition).
- [ ] **Image Paste Support**: Allow users to paste images directly from their clipboard into the chat interface as attachments.
- [ ] **File Upload Support**: Allow users to upload and attach files (pending backend support for file contents extraction).

## System & Visualization
- [ ] **Realtime Process Status Blocks**: Introduce a special, inline block in the conversation to display realtime server status updates (e.g., MediaService tasks, MCP tool executions, compaction processes). Similar to tool-use UI in VS Code Copilot.

## Network & Connection
- [ ] **SSE Operation Mode**: Support Server-Sent Events (SSE) as an optional operation mode for chat messaging and streaming (pending backend support).
