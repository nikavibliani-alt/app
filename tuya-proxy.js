const http = require('http');   // NOTE: http not https — proxy listens locally over HTTP
const https = require('https'); // https is still used for outbound calls to Tuya
const crypto = require('crypto');

const CONFIG = {
    accessId: 'wxd3afwrhewvh5p5tukc',
    accessSecret: '80edc016e2d84df886f500f38f5cc6b7',
    endpoint: 'openapi.tuyaeu.com',
    port: 3000
};

// Helper: Calculate HMAC SHA256
const calcSign = (str, secret) => {
    return crypto.createHmac('sha256', secret).update(str).digest('hex').toUpperCase();
};

// Helper: SHA-256 of body string
const calcBodyHash = (body) => {
    const content = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : '';
    return crypto.createHash('sha256').update(content).digest('hex');
};

// ── AES-128-ECB helpers (PKCS7 padding via Node default) ─────────────────────
const AES_KEY = Buffer.from(CONFIG.accessSecret.slice(0, 16), 'utf8');

function aesEcbDecrypt(keyBuf, dataBuf) {
    const d = crypto.createDecipheriv('aes-128-ecb', keyBuf, null);
    d.setAutoPadding(true);
    return Buffer.concat([d.update(dataBuf), d.final()]);
}
function aesEcbEncrypt(keyBuf, dataBuf) {
    const c = crypto.createCipheriv('aes-128-ecb', keyBuf, null);
    c.setAutoPadding(true);
    return Buffer.concat([c.update(dataBuf), c.final()]);
}

// ── Internal Tuya HTTPS call (used by /api/ticket-flow) ──────────────────────
function tuyaCall(method, path, token, bodyStr) {
    bodyStr = bodyStr || '';
    return new Promise((resolve) => {
        const timestamp = Date.now().toString();
        const nonce     = '';
        const bodyHash  = calcBodyHash(bodyStr);
        const sts       = [method, bodyHash, '', path].join('\n');
        const signStr   = CONFIG.accessId + (token || '') + timestamp + nonce + sts;
        const sign      = calcSign(signStr, CONFIG.accessSecret);
        const bodyBuf   = Buffer.from(bodyStr, 'utf8');
        const headers   = {
            'client_id':      CONFIG.accessId,
            'sign':           sign,
            't':              timestamp,
            'sign_method':    'HMAC-SHA256',
            'Content-Type':   'application/json',
            'Content-Length': bodyBuf.length,
        };
        if (token) headers['access_token'] = token;

        console.log(`  [tuyaCall] ${method} ${path}  body=${bodyStr||'(empty)'}`);
        const req = https.request({ hostname: CONFIG.endpoint, port: 443, method, path, headers, timeout: 10000 }, res => {
            let raw = '';
            res.on('data', c => { raw += c; });
            res.on('end', () => {
                console.log(`  [tuyaCall] ${res.statusCode}  ${raw}`);
                let data;
                try { data = JSON.parse(raw); } catch { data = { _raw: raw }; }
                resolve({ status: res.statusCode, data, raw });
            });
        });
        req.on('error', err => resolve({ status: 0, data: { error: err.message }, raw: '' }));
        req.on('timeout', () => { req.destroy(); resolve({ status: 504, data: { error: 'timeout' }, raw: '' }); });
        req.write(bodyBuf);
        req.end();
    });
}

// ── Keep the process alive no matter what ────────────────────────────────────
process.on('uncaughtException', (err) => {
    console.error('[uncaughtException]', err.message, err.stack);
});
process.on('unhandledRejection', (reason) => {
    console.error('[unhandledRejection]', reason);
});

// ── Safe response helper — never write to an already-finished socket ──────────
function safeSend(res, status, body) {
    try {
        if (!res.headersSent) {
            res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        }
        if (!res.writableEnded) res.end(typeof body === 'string' ? body : JSON.stringify(body));
    } catch (e) {
        console.error('[safeSend]', e.message);
    }
}

const server = http.createServer((req, res) => {
    // CORS headers for browser access
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, access_token');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    // Catch any sync throw inside the handler before body collection starts
    res.on('error', (e) => console.error('[res error]', e.message));
    req.on('error', (e) => { console.error('[req error]', e.message); safeSend(res, 400, { error: e.message }); });

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
    try {

        // ── /encrypt — AES-128-ECB only, no Tuya calls ───────────────────────
        if (req.url === '/encrypt' && req.method === 'POST') {
            const { ticket_key, password } = JSON.parse(body || '{}');
            if (!ticket_key || !password) return safeSend(res, 400, { error: 'ticket_key and password required' });
            try {
                const intermediateKey = '80edc016e2d84df886f500f38f5cc6b7'.substring(0, 16);
                const decipher = crypto.createDecipheriv('aes-128-ecb', intermediateKey, null);
                decipher.setAutoPadding(false);
                let decryptedTicket = Buffer.concat([
                    decipher.update(Buffer.from(ticket_key, 'hex')),
                    decipher.final()
                ]);
                const finalKey = decryptedTicket.slice(0, 16);
                const cipher = crypto.createCipheriv('aes-128-ecb', finalKey, null);
                let encryptedPassword = Buffer.concat([
                    cipher.update(password, 'utf8'),
                    cipher.final()
                ]);
                const encrypted_hex = encryptedPassword.toString('hex').toUpperCase();

                console.log(`[/encrypt] intermediateKey: ${intermediateKey}`);
                console.log(`[/encrypt] decryptedTicket: ${decryptedTicket.toString('hex')}`);
                console.log(`[/encrypt] finalKey:        ${finalKey.toString('hex')}`);
                console.log(`[/encrypt] encrypted_hex:   ${encrypted_hex}`);

                return safeSend(res, 200, {
                    ok: true,
                    intermediate_key:    intermediateKey,
                    decrypted_ticket_hex: decryptedTicket.toString('hex'),
                    final_key_hex:       finalKey.toString('hex'),
                    plain_password:      password,
                    encrypted_hex,
                });
            } catch (e) {
                console.error('[/encrypt] error:', e.message);
                return safeSend(res, 500, { ok: false, error: e.message });
            }
        }

        // ── Internal route: full ticket+encrypt+create flow ───────────────────
        if (req.url === '/api/ticket-flow' && req.method === 'POST') {
            const params     = JSON.parse(body || '{}');
            const token      = params.token;
            const plainPwd   = params.password   || '123456';
            const name       = params.name        || 'SleepyTest';
            const duration   = params.durationSec || 3600;
            const deviceId   = params.deviceId    || 'bf70cd74974715b99cxmee';
            const nowSec     = Math.floor(Date.now() / 1000);
            const result     = { ok: false, steps: {} };

            // Step 1 — get ticket
            const ticketPath = `/v1.0/devices/${deviceId}/door-lock/password-ticket`;
            console.log('\n[ticket-flow] Step 1 — POST', ticketPath);
            const r1 = await tuyaCall('POST', ticketPath, token, '{}');
            result.steps.step1 = { endpoint: ticketPath, body_sent: '{}', http_status: r1.status, tuya_response: r1.data };

            if (!r1.data.success) {
                result.error = `Step 1 failed: code=${r1.data.code} msg=${r1.data.msg}`;
                return safeSend(res, 422, result);
            }

            const ticketId  = r1.data.result?.ticket_id;
            const ticketKey = r1.data.result?.ticket_key;
            if (!ticketId || !ticketKey) {
                result.error = 'Step 1: ticket_id or ticket_key missing from response';
                return safeSend(res, 422, result);
            }

            // Step 2 — AES crypto (Node.js)
            console.log('[ticket-flow] Step 2 — AES decrypt ticket_key, encrypt password');
            let encryptedPwd;
            try {
                const isHex    = /^[0-9a-fA-F]+$/.test(ticketKey) && ticketKey.length % 2 === 0;
                const tkBuf    = Buffer.from(ticketKey, isHex ? 'hex' : 'base64');
                const dk       = aesEcbDecrypt(AES_KEY, tkBuf);
                const encBuf   = aesEcbEncrypt(dk, Buffer.from(plainPwd, 'utf8'));
                encryptedPwd   = encBuf.toString('hex');
                result.steps.step2 = {
                    aes_key_hex:       AES_KEY.toString('hex'),
                    ticket_key_raw:    ticketKey,
                    ticket_key_enc:    isHex ? 'hex' : 'base64',
                    decrypted_key_hex: dk.toString('hex'),
                    plain_password:    plainPwd,
                    encrypted_hex:     encryptedPwd,
                };
                console.log('[ticket-flow] encrypted_password:', encryptedPwd);
            } catch (e) {
                result.error = 'Step 2 crypto failed: ' + e.message;
                result.steps.step2 = { error: e.message };
                return safeSend(res, 500, result);
            }

            // Step 3 — create temp password
            const createPath = `/v1.0/devices/${deviceId}/door-lock/temp-password`;
            const body3 = JSON.stringify({
                name,
                password:       encryptedPwd,
                password_type:  'ticket',
                ticket_id:      ticketId,
                effective_time: nowSec,
                invalid_time:   nowSec + duration,
            });
            console.log('[ticket-flow] Step 3 — POST', createPath, body3);
            const r3 = await tuyaCall('POST', createPath, token, body3);
            result.steps.step3 = { endpoint: createPath, body_sent: JSON.parse(body3), http_status: r3.status, tuya_response: r3.data };

            if (r3.data.success) {
                result.ok          = true;
                result.password_id = r3.data.result;
                result.plain_pwd   = plainPwd;
                result.valid_from  = new Date(nowSec * 1000).toISOString();
                result.valid_until = new Date((nowSec + duration) * 1000).toISOString();
            } else {
                result.error = `Step 3 failed: code=${r3.data.code} msg=${r3.data.msg}`;
            }
            return safeSend(res, result.ok ? 200 : 422, result);
        }

        const timestamp = Date.now().toString();
        const nonce = ''; // Optional for most requests
        const httpMethod = req.method;
        const urlPath = req.url; // Includes query params
        const bodyHash = calcBodyHash(body);

        // Tuya V2 Signature String:
        // AccessId + Token(if any) + t + nonce + StringToSign
        // StringToSign = HTTPMethod + "\n" + Content-SHA256 + "\n" + Headers + "\n" + Url

        // Note: For simplicity, this proxy assumes a fresh token is handled by your frontend
        // or passed via header. If you need token management, you'd fetch it here.
        const accessToken = req.headers['access_token'] || '';

        const stringToSign = [
            httpMethod,
            bodyHash,
            '', // Headers (usually empty unless specific ones are signed)
            urlPath
        ].join('\n');

        const signStr = CONFIG.accessId + accessToken + timestamp + nonce + stringToSign;
        const sign = calcSign(signStr, CONFIG.accessSecret);

        const bodyBuf = Buffer.from(body, 'utf8');

        const options = {
            hostname: CONFIG.endpoint,
            port: 443,
            method: httpMethod,
            path: urlPath,
            timeout: 10000, // 10 s — prevents silent hang → "Failed to fetch"
            headers: {
                'client_id':      CONFIG.accessId,
                'sign':           sign,
                't':              timestamp,
                'sign_method':    'HMAC-SHA256',
                'access_token':   accessToken,
                'Content-Type':   'application/json',
                'Content-Length': bodyBuf.length  // required — without this Tuya hangs on POST
            }
        };

        const CORS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

        const tuyaReq = https.request(options, (tuyaRes) => {
            let responseData = '';
            tuyaRes.on('data', (d) => { responseData += d; });
            tuyaRes.on('end', () => {
                console.log(`[${tuyaRes.statusCode}] ${httpMethod} ${urlPath}`);
                console.log('TUYA RESPONSE:', responseData);
                res.writeHead(tuyaRes.statusCode, CORS);
                res.end(responseData);
            });
        });

        tuyaReq.on('timeout', () => {
            tuyaReq.destroy();
            res.writeHead(504, CORS);
            res.end(JSON.stringify({ error: 'Tuya request timed out after 10s' }));
        });

        tuyaReq.on('error', (e) => {
            console.error('Tuya request error:', e.message);
            if (!res.headersSent) {
                res.writeHead(502, CORS);
                res.end(JSON.stringify({ error: e.message }));
            }
        });

        tuyaReq.write(bodyBuf); // always write — empty buffer is a no-op, avoids chunked encoding
        tuyaReq.end();

    } catch (err) {
        console.error('[handler error]', err.message, err.stack);
        safeSend(res, 500, { error: err.message });
    }
    }); // end req.on('end')
});

server.on('error', (err) => console.error('[server error]', err.message));

server.listen(CONFIG.port, () => {
    console.log(`Tuya Proxy running at http://localhost:${CONFIG.port}`);
    console.warn("CRITICAL: Rotate your Access Secret after testing. It is currently exposed.");
});
