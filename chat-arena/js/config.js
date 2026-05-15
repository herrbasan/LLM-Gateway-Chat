window.ARENA_CONFIG = {
    gatewayUrl: 'http://192.168.0.100:3400',
    defaultMaxTurns: 10,
    defaultAutoAdvance: true,
    defaultModelA: 0,  // 0-indexed, so 5 = 6th option
    defaultModelB: 1,  // 0-indexed, so 6 = 7th option
    defaultTopic: 'This is a Chat app that connects two LLM\'s for autonomous conversation. This is not a task, feel free to be yourself and allow yourself to be curious.',

    // TTS Configuration
    ttsEndpoint: 'http://localhost:2244',
    ttsVoiceA: '',
    ttsVoiceB: '',
    ttsSpeed: 1.0,
};