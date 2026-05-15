// ============================================
// LLM Gateway Chat - Configuration
// ============================================
// Edit this file to configure your gateway connection

window.CHAT_CONFIG = {
    // LLM Gateway URL - change this to match your gateway server
    gatewayUrl: 'http://192.168.0.100:3400',
    
    // Optional: Default model to select (leave empty to auto-select first available)
    defaultModel: '',
    
    // Optional: Default temperature (0-2)
    defaultTemperature: 0.7,
    
    // Optional: Default max tokens
    defaultMaxTokens: null,
    
    // Connection operation mode: 'sse' (default, HTTP streaming) or 'websocket' (fast full-duplex)
    operationMode: 'sse',
    
    // TTS Service Configuration
    ttsEndpoint: 'http://localhost:2244',
    ttsVoice: '',
    ttsSpeed: 1.0,

    // Optional: Add to system prompt to discourage LLM from generating timestamps
    // timestampInstruction: 'Do not include timestamps in your responses.',

    // Chat Backend (port 3500) — archive search, session management
    backendUrl: 'http://localhost:3500',
    backendApiKey: 'migrated-754e711f-15fe-4d9d-82a0-7efa446418dd',

    // Enable backend persistence (false = legacy localStorage-only mode)
    enableBackend: true,

    // Enable archive tools in chat (chat_archive_search etc.)
    enableArchiveTools: true,
};
