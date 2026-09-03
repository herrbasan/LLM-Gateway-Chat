/**
 * /api/stt/* same-origin relay → nVoice.
 *
 * Why: nVoice binds localhost on the server host — remote clients can't reach
 * it, and the nPort cutover makes 443 the only public surface (an HTTPS page
 * can't open ws:// to a plain-HTTP host). Same rationale as the /api/tts/*
 * proxy: the view only ever talks to this origin. Path-passthrough with a
 * whitelist: strip /api/stt, forward the remainder verbatim.
 *
 * REST: GET /api/stt/v1/realtime/sessions, POST /api/stt/v1/audio/cleanup.
 * WS:   /api/stt/v1/realtime/ws, /api/stt/v1/wakeword/ws.
 *
 * The WS relay never parses a frame. WS masking is directional (client masks,
 * server doesn't) and both legs have the same directionality, so after two
 * independent handshakes the raw sockets are spliced and bytes flow untouched:
 * nVoice unmasks browser frames exactly as on a direct connection. Rules:
 *  - no Sec-WebSocket-Extensions on either handshake (permessage-deflate on
 *    one leg only would corrupt the byte pipe)
 *  - no subprotocols (the SDK uses none)
 *  - setNoDelay on both sockets (32ms audio frames; Nagle adds jitter)
 *  - no idle timeout (assistant mode is legitimately open-but-silent for hours)
 *  - close/error on either side destroys the other — no half-open pipes
 */
const net = require('net');
const crypto = require('crypto');
const { Readable } = require('stream');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const HANDSHAKE_TIMEOUT_MS = 10000;
const MAX_HANDSHAKE_BYTES = 16384;

const WS_PATHS = new Set(['/v1/realtime/ws', '/v1/wakeword/ws']);
const REST_PATHS = new Set(['GET /v1/realtime/sessions', 'POST /v1/audio/cleanup']);

function createRelay({ cfg, getAuthUser, requireAuth, L }) {
    function sttBase() {
        return (process.env.STT_ENDPOINT || cfg.sttEndpoint || 'http://localhost:2244').replace(/\/+$/, '');
    }

    // --- REST: buffered in, streamed out (same shape as proxyTts) ---
    async function proxyRest(req, res) {
        const authResult = requireAuth(req, res);
        if (!authResult) return;

        const url = new URL(req.url, 'http://localhost');
        const upstreamPath = url.pathname.slice('/api/stt'.length);
        if (!REST_PATHS.has(`${req.method} ${upstreamPath}`)) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Not found' }));
            return;
        }

        const init = { method: req.method, headers: {} };
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            init.body = Buffer.concat(chunks);
            if (req.headers['content-type']) init.headers['Content-Type'] = req.headers['content-type'];
        }

        let upstream;
        try {
            upstream = await fetch(sttBase() + upstreamPath + url.search, init);
        } catch (e) {
            L().warn('STT proxy: nVoice unreachable', { error: e.message }, 'STT');
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `nVoice unreachable: ${e.message}` }));
            return;
        }

        res.writeHead(upstream.status, {
            'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream'
        });
        if (upstream.body) {
            const stream = Readable.fromWeb(upstream.body);
            stream.on('error', (e) => { L().error('STT proxy stream failed', e, {}, 'STT'); stream.destroy(); res.destroy(); });
            stream.pipe(res);
        } else {
            res.end();
        }
    }

    // --- WS: auth on the upgrade request, two handshakes, raw TCP splice ---
    function handleUpgrade(req, socket, head) {
        const fail = (status, text) => {
            try { socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`); } catch { /* socket already gone */ }
            socket.destroy();
        };

        let url;
        try {
            url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        } catch {
            fail(400, 'Bad Request');
            return;
        }
        if (!url.pathname.startsWith('/api/stt/')) { fail(404, 'Not Found'); return; }
        const upstreamPath = url.pathname.slice('/api/stt'.length);
        if (!WS_PATHS.has(upstreamPath)) { fail(404, 'Not Found'); return; }

        const user = getAuthUser(req);
        if (!user || user.rights?.login === false) { fail(401, 'Unauthorized'); return; }

        const browserKey = req.headers['sec-websocket-key'];
        if (!browserKey) { fail(400, 'Bad Request'); return; }

        const target = new URL(sttBase() + upstreamPath + url.search);
        const key = crypto.randomBytes(16).toString('base64');
        const expectedAccept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');

        const upstream = net.connect({ host: target.hostname, port: target.port || 80 });
        let answered = false;
        const timer = setTimeout(() => {
            L().warn('STT relay: nVoice handshake timeout', { path: upstreamPath }, 'STT');
            if (!answered) fail(504, 'Gateway Timeout');
            upstream.destroy();
        }, HANDSHAKE_TIMEOUT_MS);

        upstream.on('connect', () => {
            upstream.write(
                `GET ${target.pathname}${target.search} HTTP/1.1\r\n` +
                `Host: ${target.host}\r\n` +
                'Upgrade: websocket\r\n' +
                'Connection: Upgrade\r\n' +
                `Sec-WebSocket-Key: ${key}\r\n` +
                'Sec-WebSocket-Version: 13\r\n\r\n'
            );
        });

        let buf = Buffer.alloc(0);
        const onData = (chunk) => {
            buf = Buffer.concat([buf, chunk]);
            const idx = buf.indexOf('\r\n\r\n');
            if (idx === -1) {
                if (buf.length > MAX_HANDSHAKE_BYTES) { fail(502, 'Bad Gateway'); upstream.destroy(); }
                return;
            }
            upstream.removeListener('data', onData);
            clearTimeout(timer);
            answered = true;

            const headerBlock = buf.slice(0, idx).toString('latin1');
            const over = buf.slice(idx + 4);
            const lines = headerBlock.split('\r\n');
            const m = lines[0].match(/^HTTP\/\d\.\d (\d{3})/);
            const status = m ? parseInt(m[1], 10) : 502;
            if (status !== 101) {
                L().warn('STT relay: nVoice rejected upgrade', { path: upstreamPath, status }, 'STT');
                fail(status, 'Bad Gateway');
                upstream.destroy();
                return;
            }
            const respHeaders = {};
            for (const line of lines.slice(1)) {
                const ci = line.indexOf(':');
                if (ci > 0) respHeaders[line.slice(0, ci).trim().toLowerCase()] = line.slice(ci + 1).trim();
            }
            if (respHeaders['sec-websocket-accept'] !== expectedAccept) {
                L().error('STT relay: bad Sec-WebSocket-Accept from nVoice', null, { path: upstreamPath }, 'STT');
                fail(502, 'Bad Gateway');
                upstream.destroy();
                return;
            }

            const accept = crypto.createHash('sha1').update(browserKey + WS_GUID).digest('base64');
            socket.write(
                'HTTP/1.1 101 Switching Protocols\r\n' +
                'Upgrade: websocket\r\n' +
                'Connection: Upgrade\r\n' +
                `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
            );
            socket.setNoDelay(true);
            upstream.setNoDelay(true);
            // head: bytes the browser pipelined past its upgrade request.
            // over: bytes nVoice pipelined past its 101. Both must reach the
            // other side before piping or the first frames vanish.
            if (head && head.length) upstream.write(head);
            if (over.length) socket.write(over);
            socket.pipe(upstream);
            upstream.pipe(socket);
            L().info('STT relay: WS spliced', { path: upstreamPath }, 'STT');
        };
        upstream.on('data', onData);

        const kill = () => {
            clearTimeout(timer);
            if (!socket.destroyed) socket.destroy();
            if (!upstream.destroyed) upstream.destroy();
        };
        upstream.on('error', (e) => {
            L().error('STT relay: upstream socket error', e, { path: upstreamPath }, 'STT');
            if (!answered) fail(502, 'Bad Gateway');
            kill();
        });
        socket.on('error', () => kill());
        upstream.on('close', kill);
        socket.on('close', kill);
    }

    return { proxyRest, handleUpgrade, sttBase };
}

module.exports = { createRelay };
