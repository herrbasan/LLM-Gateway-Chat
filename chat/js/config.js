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
    
    // Optional: Add to system prompt to discourage LLM from generating timestamps
    // timestampInstruction: 'Do not include timestamps in your responses.',
};
