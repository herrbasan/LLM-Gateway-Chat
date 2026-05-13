// CJS wrapper for nLogger ESM submodule (lib/nlogger/src/logger.js)
let _logger = null;
let _ready = false;

async function init(options = {}) {
    const mod = await import('./nlogger/src/logger.js');
    _logger = mod.createLogger(options);
    _ready = true;
    return _logger;
}

function get() {
    if (!_ready) throw new Error('Logger not initialized. Call await init() first.');
    return _logger;
}

module.exports = { init, get };
