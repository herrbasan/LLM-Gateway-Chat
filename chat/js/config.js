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
    
    // Connection operation mode: 'websocket' (default, fast full-duplex) or 'sse' (better for aggressive mobile proxy/backgrounding)
    operationMode: 'websocket',
    
    // TTS Service Configuration
    ttsEndpoint: 'http://localhost:2244',
    ttsVoice: '',
    ttsSpeed: 1.0,

    // Optional: Add to system prompt to discourage LLM from generating timestamps
    // timestampInstruction: 'Do not include timestamps in your responses.',

    // Chat Backend (port 3500) — archive search, session management
    backendUrl: 'http://localhost:3500',
    backendApiKey: 'migrated-775c80b8-7731-4930-b3b7-49b061eefe4c',

    // Enable archive tools in chat (chat_archive_search etc.)
    enableArchiveTools: true,
};
