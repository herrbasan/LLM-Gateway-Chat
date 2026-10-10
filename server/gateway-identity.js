// Who we are on every gateway call. The gateway attaches this identity to its
// failure and warning lines (LLM-Gateway src/utils/client-identity.js); without
// it, two clients on one machine are indistinguishable in its logs — the
// 2026-10 context-window bursts could not be attributed to a sender precisely
// because no request carried a name.
const { version } = require('../package.json');

function gatewayIdentityHeaders(sessionId) {
    const headers = {
        'X-Client-Name': 'llm-gateway-chat',
        'X-Client-Version': version
    };
    if (sessionId) headers['X-Session-Id'] = sessionId;
    return headers;
}

module.exports = { gatewayIdentityHeaders };
