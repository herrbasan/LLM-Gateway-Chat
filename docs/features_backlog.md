# Features Backlog

## Message Management
- [x] **Delete Messages**: Add UI to trigger the existing deleteExchange function to remove individual user or assistant messages from the active conversation context.
- [x] **Edit Messages**: Allow editing of past user messages (destructive edit where downstream messages are dropped). [See Dev Plan: Edit](dev_plan_edit.md)

## Performance & Telemetry
- [ ] **Tokens Per Second (TPS)**: Display real-time and final generation speeds (Tokens/sec).
- [ ] **Time to First Token (TTFT)**: Track and display the delay before the first chunk is received.
- [ ] **Total Generation Time**: Show the overall time taken for the API to complete the response.

## Workspace & Context Management
- [ ] **Import Chat Session**: We already have JSON export; adding a way to *import* a JSON file to resume a session later.
- [ ] **System Prompt Presets**: Save, name, and quickly select frequently used system prompts directly from the sidebar.
- [ ] **Real-time Input Token Estimator**: Show an estimated token count for the user's input draft before they hit send.
