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
const DEVICE_ID     = 'bf4a5ba093e5e561d5mt2r';
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

    // Always generate a fresh random 7-digit code
    const password = Math.floor(1000000 + Math.random() * 9000000).toString();
    if (password.length !== 7) throw new Error(`BUG: password is ${password.length} digits, expected 7`);
    console.log('\n' + '★'.repeat(50));
    console.log(`★  DOOR CODE TO TRY ON LOCK: ${password}  ★`);
    console.log('★'.repeat(50) + '\n');
    const name     = params.name     || 'GuestCode';
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

    // Step 1 — fresh ticket (retry until expire_time >= 300s)
    const ticketPath = `/v1.0/devices/${deviceId}/door-lock/password-ticket`;
    const MIN_EXPIRE = 300; // seconds — reject stale/cached tickets below this
    let r1, ticketAttempts = 0;
    result.steps.step1 = { endpoint: ticketPath, attempts: [] };
    while (ticketAttempts < 3) {
        ticketAttempts++;
        console.log(`[step1] attempt ${ticketAttempts}: POST ${ticketPath}`);
        r1 = await tuyaCall('POST', ticketPath, token, '{}');
        console.log(`[step1] result: expire_time=${r1.data.result?.expire_time}  ticket_id=${r1.data.result?.ticket_id}`);
        result.steps.step1.attempts.push({ attempt: ticketAttempts, tuya_response: r1.data });
        if (!r1.data.success || !r1.data.result?.ticket_id) {
            result.error = `Ticket failed: code=${r1.data.code} msg=${r1.data.msg}`;
            return respond(res, 422, result);
        }
        if (r1.data.result.expire_time >= MIN_EXPIRE) {
            console.log(`[step1] ✅ Fresh ticket (expire_time=${r1.data.result.expire_time}s >= ${MIN_EXPIRE}s)`);
            break;
        }
        console.log(`[step1] ⚠️ Stale ticket (expire_time=${r1.data.result.expire_time}s < ${MIN_EXPIRE}s) — retrying in 2s`);
        await new Promise(r => setTimeout(r, 2000));
    }
    result.steps.step1.ticket_id  = r1.data.result.ticket_id;
    result.steps.step1.expire_time = r1.data.result.expire_time;
    const { ticket_id, ticket_key } = r1.data.result;

    // Step 2 — AES encrypt
    console.log('[/create-temp-password] Step 2: AES encrypt  ticket_key=' + ticket_key);
    let encryptedHex;
    try {
        const intermediateKey = ACCESS_SECRET.substring(0, 16);
        const decryptedTicket = aesDecrypt(intermediateKey, Buffer.from(ticket_key, 'hex'));
        const finalKey        = decryptedTicket.slice(0, 16);
        const encBuf      = aesEncrypt(finalKey, Buffer.from(password, 'utf8'));
        encryptedHex      = encBuf.toString('hex').toUpperCase();
        console.log(`[step2] plain_password="${password}" length=${password.length} chars`);
        console.log(`[step2] encrypted_hex="${encryptedHex}" length=${encBuf.length} bytes / ${encryptedHex.length} hex chars`);
        console.log(`[step2] PKCS7: cipher.final() included ✅ (setAutoPadding(true)) — expected ${Math.ceil((password.length+1)/16)*16} bytes`);
        result.steps.step2 = { ticket_key, decrypted_ticket_hex: decryptedTicket.toString('hex'), final_key_hex: finalKey.toString('hex'), plain_password: password, plain_length: password.length, encrypted_hex: encryptedHex, encrypted_bytes: encBuf.length };
    } catch(e) {
        console.error('[/create-temp-password] Step 2 ERROR:', e.message);
        result.error = 'AES failed: ' + e.message;
        result.steps.step2 = { error: e.message };
        return respond(res, 500, result);
    }

    // Step 3 — remote_no_dp_key DP via POST /commands
    // /door-lock/temp-password always returns 1109 for jtmspro — this lock has no
    // temp_password in its instruction set, only remote_no_dp_key (Raw DP).
    const nowSec       = Math.floor(Date.now() / 1000);
    const effectiveSec = nowSec + 60;
    const invalidSec   = effectiveSec + 3600;
    const ticketAgeSec = nowSec - Math.floor(r1.data.t / 1000);
    console.log(`[timing] Ticket age: ${ticketAgeSec}s  expire_time=${r1.data.result.expire_time}s  ${ticketAgeSec > r1.data.result.expire_time ? '⚠️ EXPIRED' : '✅ OK'}`);

    const dpPayload = {
        ticket_id,
        password:       encryptedHex,
        effective_time: effectiveSec,
        invalid_time:   invalidSec,
    };
    const dpBase64   = Buffer.from(JSON.stringify(dpPayload)).toString('base64');
    const createPath = `/v1.0/devices/${deviceId}/commands`;
    const body3Obj   = { commands: [{ code: 'remote_no_dp_key', value: dpBase64 }] };
    const body3      = JSON.stringify(body3Obj);

    console.log('\n─── STEP 3 ───────────────────────────────────────────────');
    console.log('URL:', `POST https://${TUYA_HOST}${createPath}`);
    console.log('dp_payload (before base64):', JSON.stringify(dpPayload));
    console.log('body3:', body3);
    console.log('──────────────────────────────────────────────────────────');

    // Capture unlock_temporary BEFORE sending the command
    const statusPath   = `/v1.0/devices/${deviceId}/status`;
    const rStatusBefore = await tuyaCall('GET', statusPath, token, '');
    const unlockBefore  = rStatusBefore.data?.result?.find?.(dp => dp.code === 'unlock_temporary');
    console.log('[step3-pre] unlock_temporary BEFORE:', JSON.stringify(unlockBefore));

    result.steps.step3 = { endpoint: createPath, dp_payload: dpPayload, body_sent: body3Obj,
                            unlock_temporary_before: unlockBefore };
    const r3 = await tuyaCall('POST', createPath, token, body3);   // r3 always in scope
    result.steps.step3.tuya_response = r3.data;
    console.log('─── STEP 3 RESPONSE:', JSON.stringify(r3.data));

    result.plain_pwd = password;   // always set so browser shows the code

    if (!r3.data.success) {
        result.error = `Step 3 failed: code=${r3.data.code} msg=${r3.data.msg}`;
        return respond(res, 422, result);
    }

    result.ok          = true;
    result.password_id = r3.data.result;
    console.log(`\n★  SUCCESS — code=${password}  result=${result.password_id}  ★`);

    // Wait 5s then check unlock_temporary AFTER
    console.log('[step3-post] waiting 5s to check unlock_temporary...');
    await new Promise(r => setTimeout(r, 5000));
    const rStatusAfter  = await tuyaCall('GET', statusPath, token, '');
    const unlockAfter   = rStatusAfter.data?.result?.find?.(dp => dp.code === 'unlock_temporary');
    result.steps.step3.unlock_temporary_after  = unlockAfter;
    result.steps.step3.status_after_raw        = rStatusAfter.data;
    const changed = (unlockAfter?.value ?? -1) !== (unlockBefore?.value ?? -1);
    result.steps.step3.unlock_temporary_changed = changed;
    console.log('[step3-post] unlock_temporary AFTER:', JSON.stringify(unlockAfter), changed ? '⬆️ CHANGED' : '— unchanged');

    // Step 4 — poll delivery status, try 2 endpoints per poll
    const listEndpoints = [
        `/v1.0/devices/${deviceId}/door-lock/temp-passwords`,
    ];
    result.steps.step4_delivery = { endpoints_tried: listEndpoints, polls: [] };

    const pollDelivery = async (waitMs, pollIndex) => {
        console.log(`[step4] poll ${pollIndex}: waiting ${waitMs/1000}s`);
        await new Promise(r => setTimeout(r, waitMs));

        const epResults = [];
        let status = 'LIST_FAILED', allPasswords = [];

        for (const ep of listEndpoints) {
            console.log(`[step4] poll ${pollIndex} GET ${ep}`);
            const r4 = await tuyaCall('GET', ep, token, '');
            console.log(`[step4] poll ${pollIndex} [${ep}]:`, JSON.stringify(r4.data));
            epResults.push({ endpoint: ep, tuya_response: r4.data });

            if (r4.data.success) {
                // Return raw objects — no field mapping — so we see actual keys from Tuya
                const arr = Array.isArray(r4.data.result) ? r4.data.result
                          : Array.isArray(r4.data.result?.list) ? r4.data.result.list
                          : [];
                allPasswords = arr;   // raw, unmodified
                console.log(`[step4] poll ${pollIndex} [${ep}] count=${arr.length}  raw:`, JSON.stringify(arr));
                const searchedFor = { name, password_id: result.password_id };
                const match = arr.find(p =>
                    p.name === name || p.lock_name === name ||
                    String(p.id) === String(result.password_id) ||
                    String(p.password_id) === String(result.password_id)
                );
                status = match?.delivery_status ?? match?.phase ?? (arr.length > 0 ? 'NO_MATCH' : 'EMPTY_LIST');
                epResults[epResults.length - 1].searched_for = searchedFor;
                epResults[epResults.length - 1].match_found  = match ?? null;
                epResults[epResults.length - 1].total_count  = arr.length;
                console.log(`[step4] poll ${pollIndex} searched_for=${JSON.stringify(searchedFor)}  match=${JSON.stringify(match)}  status=${status}`);
                // Stop at this endpoint whether array is empty or not — it's the correct source
                if (arr.length === 0) status = 'EMPTY_LIST';
                break;
            }
        }

        const pollData = { poll: pollIndex, wait_sec: waitMs/1000, delivery_status: status, all_passwords: allPasswords, endpoint_results: epResults };
        result.steps.step4_delivery.polls.push(pollData);
        return status;
    };

    const s4s1 = await pollDelivery(5000, 1);
    result.delivery_status = s4s1;
    result.all_passwords   = result.steps.step4_delivery.polls[0]?.all_passwords ?? [];

    if (s4s1 === 'ONGOING') {
        const s4s2 = await pollDelivery(10000, 2);
        result.delivery_status = s4s2;
        result.all_passwords   = result.steps.step4_delivery.polls[1]?.all_passwords ?? result.all_passwords;
    }

    // Step 5 — auto-diagnostics
    console.log('\n[step5] Running diagnostics');
    const diagChecks = [
        { label: 'device category',           method: 'GET', path: `/v1.0/devices/${deviceId}` },
        { label: 'list temp-passwords (v1.0)', method: 'GET', path: `/v1.0/devices/${deviceId}/door-lock/temp-passwords` },
        // NOTE: removed the "test" remote_no_dp_key command — it was firing 10s after
        // Step 3 and overwriting the real password payload on the lock.
    ];
    result.steps.step5_diag = { checks: [] };
    for (const chk of diagChecks) {
        const r = await tuyaCall(chk.method, chk.path, token, chk.body || '');
        console.log(`[step5] ${chk.label}:`, JSON.stringify(r.data));
        result.steps.step5_diag.checks.push({ label: chk.label, endpoint: chk.path, tuya_response: r.data });
    }

    console.log(`\n★  FINAL — code=${password}  delivery=${result.delivery_status}  ★`);
    respond(res, 200, result);
}

async function handleDeleteTestPasswords(req, res, body) {
    console.log('\n[delete-test-passwords] START');
    // Step 0: fresh token
    const rTok = await tuyaCall('GET', '/v1.0/token?grant_type=1', null, '');
    if (!rTok.data.success) return respond(res, 422, { error: 'token failed', detail: rTok.data });
    const token    = rTok.data.result.access_token;
    const params   = JSON.parse(body || '{}');
    const deviceId = params.deviceId || DEVICE_ID;

    // Step 1: list all temp passwords
    const listPath = `/v1.0/devices/${deviceId}/door-lock/temp-passwords`;
    const rList    = await tuyaCall('GET', listPath, token, '');
    if (!rList.data.success) return respond(res, 422, { error: 'list failed', detail: rList.data });

    const all = Array.isArray(rList.data.result) ? rList.data.result
              : Array.isArray(rList.data.result?.list) ? rList.data.result.list : [];

    console.log(`[delete] ${all.length} total passwords`);

    // Filter: name contains SleepyTest, GuestCode, Test, or TestAlpha (case-insensitive)
    const PATTERN = /sleepytest|guestcode|testalpha|\btest\b/i;
    const toDelete = all.filter(p => PATTERN.test(p.name || p.lock_name || ''));
    console.log(`[delete] ${toDelete.length} match filter`);

    const deleted = [], failed = [], skipped = [];
    for (const p of toDelete) {
        const delPath = `/v1.0/devices/${deviceId}/door-lock/temp-passwords/${p.id}`;
        const r = await tuyaCall('DELETE', delPath, token, '');
        console.log(`[delete] id=${p.id} name="${p.name ?? p.lock_name}"  result:`, JSON.stringify(r.data));
        if (r.data.success) deleted.push({ id: p.id, name: p.name ?? p.lock_name });
        else failed.push({ id: p.id, name: p.name ?? p.lock_name, error: r.data.msg });
    }
    all.filter(p => !PATTERN.test(p.name || p.lock_name || '')).forEach(p =>
        skipped.push({ id: p.id, name: p.name ?? p.lock_name })
    );

    respond(res, 200, { ok: true, total: all.length, deleted, failed, skipped });
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
        if (req.url === '/delete-test-passwords'&& req.method === 'POST') return handleDeleteTestPasswords(req, res, body);

        // ── Everything else → signed forward to Tuya ─────────────────────────
        handleForward(req, res, body);
    });

}).listen(PORT, '127.0.0.1', () => {
    console.log(`\nTuya proxy → http://localhost:${PORT}`);
    console.log(`Local routes: /ping  /encrypt  /create-temp-password`);
    console.log(`All other paths forwarded to ${TUYA_HOST}\n`);
});
