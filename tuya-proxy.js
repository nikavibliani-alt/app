/**
 * tuya-proxy.js
 * Local routes (handled here, NOT forwarded to Tuya):
 *   GET  /ping
 *   POST /encrypt
 *   POST /create-temp-password   ← full 4-step flow
 * Everything else → signed + forwarded to openapi.tuyaeu.com
 */

const http   = require('http');
const https  = require('https');
const crypto = require('crypto');

const ACCESS_ID     = 'wxd3afwrhewvh5p5tukc';
const ACCESS_SECRET = '80edc016e2d84df886f500f38f5cc6b7';
const DEVICE_ID     = 'bf70cd74974715b99cxmee';
const TUYA_HOST     = 'openapi.tuyaeu.com';
const PORT          = 3000;

// ── Keep process alive ────────────────────────────────────────────────────────
process.on('uncaughtException',  e => console.error('[uncaught]', e.message));
process.on('unhandledRejection', e => console.error('[unhandled]', e));

// ── Helpers ───────────────────────────────────────────────────────────────────
function sha256(s) { return crypto.createHash('sha256').update(s,'utf8').digest('hex'); }
function hmac(s,k) { return crypto.createHmac('sha256',k).update(s,'utf8').digest('hex').toUpperCase(); }

// Tuya signing requires query params sorted alphabetically by key.
// Returns the pathname + sorted query string used in the signature.
function signPath(rawPath) {
    const qIdx = rawPath.indexOf('?');
    if (qIdx === -1) return rawPath;
    const pathname = rawPath.slice(0, qIdx);
    const qs       = rawPath.slice(qIdx + 1);
    const sorted   = qs.split('&')
        .filter(Boolean)
        .sort()                          // sort alphabetically by "key=value" string
        .join('&');
    return pathname + '?' + sorted;
}

function buildHeaders(method, path, token, body) {
    const t        = Date.now().toString();
    const nonce    = '';
    const signable = signPath(path);     // use sorted query string for signing
    const sts      = [method, sha256(body), '', signable].join('\n');
    const str      = ACCESS_ID + (token||'') + t + nonce + sts;
    console.log(`  [sign] path="${signable}" t=${t}`);
    const h = {
        'client_id':      ACCESS_ID,
        'sign':           hmac(str, ACCESS_SECRET),
        't':              t,
        'sign_method':    'HMAC-SHA256',
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body,'utf8').toString(),
    };
    if (token) h['access_token'] = token;
    return h;
}

// Fire a signed request to Tuya; always resolves, never throws
function tuyaCall(method, path, token, body) {
    body = body || '';
    return new Promise(resolve => {
        const headers = buildHeaders(method, path, token, body);
        const opts    = { hostname: TUYA_HOST, port: 443, method, path, headers, timeout: 12000 };
        const req     = https.request(opts, res => {
            let raw = '';
            res.on('data', c => { raw += c; });
            res.on('end', () => {
                console.log(`  TUYA ${method} ${path} → ${res.statusCode}  ${raw}`);
                let data;
                try   { data = JSON.parse(raw); }
                catch { data = { _raw: raw };   }
                resolve({ status: res.statusCode, data });
            });
        });
        req.on('timeout', () => { req.destroy(); resolve({ status: 504, data: { error: 'timeout' } }); });
        req.on('error',   e => { resolve({ status: 0, data: { error: e.message } }); });
        req.write(body);
        req.end();
    });
}

// AES-128-ECB helpers
function aesDecrypt(key, buf) {
    const d = crypto.createDecipheriv('aes-128-ecb', key, null);
    d.setAutoPadding(false);
    return Buffer.concat([d.update(buf), d.final()]);
}
function aesEncrypt(key, buf) {
    const c = crypto.createCipheriv('aes-128-ecb', key, null);
    c.setAutoPadding(true);
    return Buffer.concat([c.update(buf), c.final()]);
}

// Send JSON response with CORS headers
function respond(res, status, obj) {
    const json = JSON.stringify(obj, null, 2);
    console.log(`  RESPOND ${status}  ${json.slice(0, 200)}`);
    res.writeHead(status, {
        'Content-Type':                'application/json',
        'Access-Control-Allow-Origin': '*',
        'Content-Length':              Buffer.byteLength(json, 'utf8').toString(),
    });
    res.end(json);
}

// ── Route handlers ────────────────────────────────────────────────────────────

function handlePing(req, res) {
    respond(res, 200, { ok: true, host: TUYA_HOST });
}

function handleEncrypt(req, res, body) {
    console.log('[/encrypt] body:', body);
    let params;
    try { params = JSON.parse(body || '{}'); } catch(e) { return respond(res, 400, { error: 'invalid JSON' }); }

    const { ticket_key, password } = params;
    if (!ticket_key || !password) return respond(res, 400, { error: 'ticket_key and password required' });

    try {
        const intermediateKey = ACCESS_SECRET.substring(0, 16);
        const decryptedTicket = aesDecrypt(intermediateKey, Buffer.from(ticket_key, 'hex'));
        const finalKey        = decryptedTicket.slice(0, 16);
        const encrypted_hex   = aesEncrypt(finalKey, Buffer.from(String(password), 'utf8')).toString('hex').toUpperCase();
        console.log('[/encrypt] intermediateKey:', intermediateKey);
        console.log('[/encrypt] decryptedTicket:', decryptedTicket.toString('hex'));
        console.log('[/encrypt] finalKey:', finalKey.toString('hex'));
        console.log('[/encrypt] encrypted_hex:', encrypted_hex);
        respond(res, 200, { ok: true, intermediate_key: intermediateKey, decrypted_ticket_hex: decryptedTicket.toString('hex'), final_key_hex: finalKey.toString('hex'), plain_password: password, encrypted_hex });
    } catch(e) {
        console.error('[/encrypt] ERROR:', e.message);
        respond(res, 500, { ok: false, error: e.message });
    }
}

async function handleCreateTempPassword(req, res, body) {
    console.log('\n' + '='.repeat(60));
    console.log('[/create-temp-password] HANDLER ENTERED');
    console.log('[/create-temp-password] body:', body);

    let params;
    try { params = JSON.parse(body || '{}'); } catch(e) { return respond(res, 400, { error: 'invalid JSON' }); }

    // Generate a fresh random 7-digit code each run; caller can override via params.password
    const password = String(params.password || Math.floor(1000000 + Math.random() * 9000000));
    const name     = params.name     || 'SleepyTest';
    const deviceId = params.deviceId || DEVICE_ID;
    const result   = { ok: false, steps: {} };

    // Step 0 — token
    console.log('[/create-temp-password] Step 0: GET token');
    const rTok = await tuyaCall('GET', '/v1.0/token?grant_type=1', null, '');
    console.log('[/create-temp-password] Step 0 result:', JSON.stringify(rTok.data));
    result.steps.token = rTok.data;
    if (!rTok.data.success || !rTok.data.result?.access_token) {
        result.error = `Token failed: code=${rTok.data.code} msg=${rTok.data.msg}`;
        return respond(res, 422, result);
    }
    const token = rTok.data.result.access_token;

    // Step 1 — ticket
    const ticketPath = `/v1.0/devices/${deviceId}/door-lock/password-ticket`;
    console.log('[/create-temp-password] Step 1: POST', ticketPath);
    const r1 = await tuyaCall('POST', ticketPath, token, '{}');
    console.log('[/create-temp-password] Step 1 result:', JSON.stringify(r1.data));
    result.steps.step1 = { endpoint: ticketPath, body_sent: '{}', tuya_response: r1.data };
    if (!r1.data.success || !r1.data.result?.ticket_id) {
        result.error = `Ticket failed: code=${r1.data.code} msg=${r1.data.msg}`;
        return respond(res, 422, result);
    }
    const { ticket_id, ticket_key } = r1.data.result;

    // Step 2 — AES encrypt
    console.log('[/create-temp-password] Step 2: AES encrypt  ticket_key=' + ticket_key);
    let encryptedHex;
    try {
        const intermediateKey = ACCESS_SECRET.substring(0, 16);
        const decryptedTicket = aesDecrypt(intermediateKey, Buffer.from(ticket_key, 'hex'));
        const finalKey        = decryptedTicket.slice(0, 16);
        encryptedHex          = aesEncrypt(finalKey, Buffer.from(password, 'utf8')).toString('hex').toUpperCase();
        console.log('[/create-temp-password] Step 2 encrypted_hex:', encryptedHex);
        result.steps.step2 = { ticket_key, decrypted_ticket_hex: decryptedTicket.toString('hex'), final_key_hex: finalKey.toString('hex'), plain_password: password, encrypted_hex: encryptedHex };
    } catch(e) {
        console.error('[/create-temp-password] Step 2 ERROR:', e.message);
        result.error = 'AES failed: ' + e.message;
        result.steps.step2 = { error: e.message };
        return respond(res, 500, result);
    }

    // Step 3 — try all 3 endpoints, collect all responses
    const nowSec     = Math.floor(Date.now() / 1000);
    const endpoints  = [
        `/v1.0/devices/${deviceId}/door-lock/temp-password`,
    ];
    const bodyObj = {
        name,
        password:       encryptedHex,
        password_type:  1,
        ticket_id,
        effective_time: nowSec,
        invalid_time:   nowSec + 3600,
    };
    const body3 = JSON.stringify(bodyObj);
    result.steps.step3 = { body_sent: bodyObj, endpoints: [] };

    for (const createPath of endpoints) {
        console.log('[/create-temp-password] Step 3: POST', createPath);
        const r = await tuyaCall('POST', createPath, token, body3);
        console.log('[/create-temp-password] Result:', JSON.stringify(r.data));
        const attempt = { endpoint: createPath, tuya_response: r.data };
        result.steps.step3.endpoints.push(attempt);
        if (r.data.success) {
            result.ok          = true;
            result.password_id = r.data.result;
            result.plain_pwd   = password;
            result.winning_endpoint = createPath;
            console.log('[/create-temp-password] ✅ SUCCESS at', createPath, ' password_id=' + result.password_id);
            break;
        }
        console.log(`[/create-temp-password] ✗ code=${r.data.code} msg=${r.data.msg} — trying next`);
    }
    if (!result.ok) result.error = 'All 3 endpoints failed — see steps.step3.endpoints for details';
    respond(res, result.ok ? 200 : 422, result);
}

async function handleForward(req, res, body) {
    const token   = req.headers['access_token'] || '';
    const headers = buildHeaders(req.method, req.url, token, body);
    console.log(`→ FORWARD ${req.method} ${req.url}`);

    const fwd = https.request(
        { hostname: TUYA_HOST, port: 443, path: req.url, method: req.method, headers, timeout: 12000 },
        tuyaRes => {
            let raw = '';
            tuyaRes.on('data', c => { raw += c; });
            tuyaRes.on('end', () => {
                console.log(`← ${tuyaRes.statusCode}  ${raw}`);
                res.writeHead(tuyaRes.statusCode, {
                    'Content-Type':                'application/json',
                    'Access-Control-Allow-Origin': '*',
                });
                res.end(raw);
            });
        }
    );
    fwd.on('timeout', () => { fwd.destroy(); respond(res, 504, { error: 'timeout' }); });
    fwd.on('error',   e  => { respond(res, 502, { error: e.message }); });
    fwd.write(body || '');
    fwd.end();
}

// ── Server ────────────────────────────────────────────────────────────────────
http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, access_token');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    let body = '';
    req.on('data', c => { body += c; });
    req.on('error', e => { console.error('[req error]', e.message); respond(res, 400, { error: e.message }); });

    req.on('end', () => {
        console.log(`\n>> ${req.method} ${req.url}`);

        // ── Local routes — handled here, NOT forwarded ────────────────────────
        if (req.url === '/ping')                                          return handlePing(req, res);
        if (req.url === '/encrypt'              && req.method === 'POST') return handleEncrypt(req, res, body);
        if (req.url === '/create-temp-password' && req.method === 'POST') return handleCreateTempPassword(req, res, body);

        // ── Everything else → signed forward to Tuya ─────────────────────────
        handleForward(req, res, body);
    });

}).listen(PORT, '127.0.0.1', () => {
    console.log(`\nTuya proxy → http://localhost:${PORT}`);
    console.log(`Local routes: /ping  /encrypt  /create-temp-password`);
    console.log(`All other paths forwarded to ${TUYA_HOST}\n`);
});
