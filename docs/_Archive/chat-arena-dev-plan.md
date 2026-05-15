# Chat Arena - Development Plan

## Overview

Chat Arena is a multi-party LLM conversation viewer where two LLMs discuss a topic set by a human moderator. The moderator kicks off the conversation and watches - no interference after starting.

---

## 1. Directory Structure

```
chat-arena/
├── index.html          # Arena UI
├── js/
│   ├── arena.js       # Main arena orchestrator
│   ├── arena.css     # Arena-specific styles
│   └── config.js     # Configuration (gateway URL, defaults)
```

**Reuses from existing codebase (read-only, no modifications):**
- `chat/js/client-sdk.js` - GatewayClient (import only)
- `chat/js/conversation.js` - Conversation class (import only)
- `chat/js/markdown.js` - renderMarkdown() and parseThinking() (import only)
- `chat/vendor/prism.*` - Syntax highlighting (import only)
- `nui_wc2/NUI/` - NUI component library (import only)

> **Important:** No shared files will be modified. All dependencies are imported/copied as needed.

---

## 2. Configuration

**`chat-arena/js/config.js`**
```javascript
window.ARENA_CONFIG = {
    gatewayUrl: 'http://localhost:3400',
    defaultMaxTurns: 10,
    defaultAutoAdvance: true,
    defaultModelA: '',
    defaultModelB: '',
};
```

---

## 3. Participant System

### Participant Class
Each participant wraps:
- One `GatewayClient` instance (independent WebSocket)
- Identity: model name (e.g., "claude-opus-4-6")
- Optional custom system prompt for "auto roleplay" scenarios
- Response accumulator for streaming

### System Prompt (Optional)
By default, no system prompt is set - participants are unaware they're in a multi-party conversation (natural behavior).

For roleplay scenarios, a custom system prompt can be set:
```
You are in a conversation. Your identity: {modelName}.
You are speaking with {otherParticipantName} (model: {otherModelName}).
Topic: {topic}
Speak naturally as if in a thoughtful conversation. Respond concisely but thoroughly.
```

---

## 4. Shared Conversation State

**Shared Conversation** tracks all messages:
```javascript
{
    messages: [
        { role: 'system', speaker: 'moderator', content: 'Topic: ...' },
        { role: 'assistant', speaker: 'Model-A', content: '...', isStreaming: false },
        { role: 'assistant', speaker: 'Model-B', content: '...', isStreaming: false },
        ...
    ],
    currentTurn: 0,
    maxTurns: 10,
    activeSpeaker: null,  // 'Model-A' | 'Model-B' | null
    isRunning: false,
}
```

---

## 5. Turn Management

**Turn Flow:**
1. Moderator sets topic → first message in shared history
2. Arena selects starting participant (random or Model A)
3. Active participant receives full conversation history via `chat.append`
4. On response complete → toggle active participant
5. Repeat until max turns reached or stopped

**Auto-Advance Logic:**
```
On Participant A response complete:
    → Render message to UI
    → If isRunning && currentTurn < maxTurns:
        → Increment turn
        → Set activeSpeaker = Participant B
        → Trigger Participant B response

On Participant B response complete:
    → Render message to UI
    → If isRunning && currentTurn < maxTurns:
        → Increment turn
        → Set activeSpeaker = Participant A
        → Trigger Participant A response
```

---

## 6. UI Layout

### Setup State (Initial)
```
┌─────────────────────────────────────────────────────────┐
│                      Chat Arena                          │
│                                                          │
│  ┌──────────────────────────────────────────────────┐   │
│  │  Topic:                                           │   │
│  │  [____________________________________________]  │   │
│  └──────────────────────────────────────────────────┘   │
│                                                          │
│  Participant A: [Select Model ▼]                        │
│  Participant B: [Select Model ▼]                         │
│                                                          │
│  ☐ Enable Roleplay Mode (set custom system prompts)    │
│  (If checked, expandable section for per-participant    │
│   system prompts with model awareness template)          │
│                                                          │
│  Max Turns: [10]    ☑ Auto-advance                     │
│                                                          │
│            [ Start Conversation ]                       │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

### Conversation State (After Start)
```
┌─────────────────────────────────────────────────────────┐
│  Chat Arena                           [Stop] [Export]   │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  ┌─────────────────────────────────────────────────┐    │
│  │ Moderator                                        │    │
│  │ Topic: What are the implications of quantum     │    │
│  │ computing on cryptography?                       │    │
│  └─────────────────────────────────────────────────┘    │
│                                                          │
│  ┌─────────────────────────────────────────────────┐    │
│  │ claude-opus-4-6                                 │    │
│  │ Let me outline the key concerns first...        │    │
│  └─────────────────────────────────────────────────┘    │
│                                                          │
│  ┌─────────────────────────────────────────────────┐    │
│  │ gpt-4o                                          │    │
│  │ I'd like to add the timeline perspective...     │    │
│  └─────────────────────────────────────────────────┘    │
│                                                          │
│  ┌─────────────────────────────────────────────────┐    │
│  │ claude-opus-4-6                                 │    │
│  │ That's an important nuance...                   │    │
│  └─────────────────────────────────────────────────┘    │
│                                                          │
│  ─────────────────────────────────────────────────────  │
│  Turn 3/10 · Speaking: gpt-4o · ○ Auto-advance         │
└─────────────────────────────────────────────────────────┘
```

---

## 7. NUI Components

| Component | Usage |
|-----------|-------|
| `nui-app` | App shell layout |
| `nui-card` | Message bubbles with speaker identity |
| `nui-select` | Model selection (searchable) |
| `nui-input` / `nui-textarea` | Topic input |
| `nui-button` | Start, Stop, Export |
| `nui-checkbox` | Auto-advance toggle |
| `nui-badge` | Speaker indicator, turn counter |
| `nui-banner` | Error/success notifications |

**Styling Principle:** Follow NUI patterns. Use NUI's built-in component styles. Only add arena-specific CSS for layout and speaker differentiation via CSS variables.

---

## 8. Message Rendering

**Reuse existing:**
- `renderMarkdown()` for rich text output
- `parseThinking()` for thought block handling
- Prism.js for code highlighting

**Message Structure (NUI-compliant):**
```html
<nui-card class="arena-message {speakerClass}">
    <div class="message-header">
        <nui-badge>{speakerName}</nui-badge>
        <span class="message-status"></span>
    </div>
    <div class="message-content">
        <!-- Rendered markdown here -->
    </div>
</nui-card>
```

**Speaker Differentiation:**
Use CSS custom properties (NUI variables) for speaker colors. Do not override NUI component styles.
```css
.arena-message[data-speaker="moderator"] { --speaker-accent: var(--color-shade4); }
.arena-message[data-speaker="model-a"] { --speaker-accent: var(--nui-accent); }
.arena-message[data-speaker="model-b"] { --speaker-accent: var(--nui-accent-secondary); }
```

---

## 9. Implementation Phases

### Phase 1: Foundation
- [ ] Create `chat-arena/` directory structure
- [ ] Create `chat-arena/index.html` with NUI app shell (page mode, standalone)
- [ ] Create `chat-arena/js/config.js`
- [ ] Create `chat-arena/js/arena.css`
- [ ] Import GatewayClient and markdown utilities (no modifications to source)
- [ ] Verify NUI components load correctly
- [ ] Follow NUI patterns: declarative HTML-first, CSS custom properties for theming, `data-action` for interactions

### Phase 2: Participant Infrastructure
- [ ] Implement `Participant` class
  - [ ] GatewayClient wrapper
  - [ ] Optional custom system prompt (for roleplay mode)
  - [ ] Streaming response handling
- [ ] Implement `Arena` class
  - [ ] Shared conversation state
  - [ ] Turn management logic
  - [ ] Auto-advance mechanism

### Phase 3: UI
- [ ] Setup view (topic, model selection, max turns)
- [ ] Conversation view (messages, controls)
- [ ] Model selection (fetch available models from gateway)
- [ ] Message rendering with speaker identity
- [ ] Status indicators (current speaker, turn count)

### Phase 4: Controls & Polish
- [ ] Start button → begins conversation
- [ ] Stop button → halts auto-advance
- [ ] Auto-advance toggle
- [ ] Export as JSON (replayable)
- [ ] Export as Markdown (clean transcript)
- [ ] Import from JSON
- [ ] Error handling (basic banner notification, not priority)

---

## 10. API / Gateway Integration

**Message Format for chat.append:**
```javascript
{
    model: participantModelName,
    messages: [
        // Full conversation history formatted for gateway
        { role: 'system', content: '...' },
        { role: 'user', content: 'Topic: ...' },
        { role: 'assistant', content: 'Participant A response...' },
        { role: 'assistant', content: 'Participant B response...' },
        ...
    ],
    stream: true,
    temperature: 0.7,
}
```

---

## 11. File Dependencies

> All dependencies are imported/copied from source - no modifications to shared files.

```
chat-arena/index.html
├── NUI Theme & Modules (read-only import)
│   ├── nui_wc2/NUI/css/nui-theme.css
│   └── nui_wc2/NUI/css/modules/...
├── Vendor (read-only import)
│   ├── chat/vendor/prism.css/js
│   ├── chat/vendor/markdown-it.js
│   └── chat/vendor/purify.js
├── chat-arena/
│   ├── js/
│   │   ├── arena.js       # Main arena orchestrator
│   │   ├── arena.css     # Arena-specific styles
│   │   └── config.js     # Configuration
│   └── index.html
└── Scripts (read-only import from chat/)
    ├── chat/js/client-sdk.js (GatewayClient)
    ├── chat/js/conversation.js (Conversation)
    └── chat/js/markdown.js (renderMarkdown, parseThinking)
```

---

## 12. Export / Import

### JSON Export/Import
Same format as normal chat for replay capability:
```json
{
    "version": 1,
    "exportedAt": "2026-03-24T...",
    "topic": "What are the implications of quantum computing...",
    "participants": ["claude-opus-4-6", "gpt-4o"],
    "messages": [
        { "role": "user", "speaker": "moderator", "content": "Topic: ..." },
        { "role": "assistant", "speaker": "claude-opus-4-6", "content": "..." },
        { "role": "assistant", "speaker": "gpt-4o", "content": "..." }
    ]
}
```

### Markdown Transcript
Clean formatted transcript, no behind-the-scenes metadata:
```markdown
# Topic: What are the implications of quantum computing on cryptography?

**claude-opus-4-6:**
Let me outline the key concerns first...

**gpt-4o:**
I'd like to add the timeline perspective...

**claude-opus-4-6:**
That's an important nuance...
```

## 13. Error Handling

Not a priority. Basic handling:
- Gateway connection errors → banner notification, stop auto-advance
- Stream interruption → show partial response, allow retry
- No elaborate recovery mechanisms needed

## 14. Context Management

Handled entirely by the gateway. Arena sends full history via `chat.append`; gateway manages truncation as needed.

