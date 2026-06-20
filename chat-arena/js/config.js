window.ARENA_CONFIG = {
    gatewayUrl: 'http://192.168.0.100:3400',
    defaultMaxTurns: 10,
    defaultAutoAdvance: true,
    defaultModelA: 0,  // 0-indexed, so 5 = 6th option
    defaultModelB: 1,  // 0-indexed, so 6 = 7th option
    defaultTopic: 'This is a Chat app that connects two LLM\'s for autonomous conversation. This is not a task, feel free to be yourself and allow yourself to be curious.',

    // Identity visibility: prepends [ModelName]: prefix to messages so each
    // participant can distinguish their own output from the other model's.
    // Set to false to study dissociation phenomena where models can't tell
    // who said what.
    showIdentities: true,

    // Temperature (0.0 - 2.0). Controls response randomness.
    defaultTemperature: 0.7,

    // Default model used for AI summary generation in the arena edit dialog.
    // Set to null to fall back to the first available chat model.
    defaultSummaryModel: null,

    // TTS Configuration
    ttsEndpoint: 'http://localhost:2233',
    ttsVoiceA: '',
    ttsVoiceB: '',
    ttsSpeed: 1.0,
};