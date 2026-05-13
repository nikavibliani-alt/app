/**
 * tuya-proxy.js — local CORS proxy for Tuya OpenAPI (Central Europe)
 *
 * Usage: node tuya-proxy.js
 * Runs on http://localhost:3000
 *
 * Routes:
 *   GET  /ping                        health check
 *   *    /v1.x/...                    transparent proxy → openapi.tuyaeu.com (signing added)
 *   POST /api/create-temp-code        full 3-step jtmspro ticket+encrypt+create flow
 *
 * No npm packages required — only Node.js built-ins.
 */

const http   = require('http');
const https  = require('https');
const crypto = require('crypto');

const ACCESS_ID     = 'wxd3afwrhewvh5p5tukc';
const ACCESS_SECRET = '80edc016e2d84df886f500f38f5cc6b7';
const TUYA_HOST     = 'openapi.tuyaeu.com';
const PORT          = 3000;

// ── Signing helpers ───────────────────────────────────────────────────────────
function sha256hex(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}
function hmacUpper(str, secret) {
  return crypto.createHmac('sha256', secret).update(str, 'utf8').digest('hex').toUpperCase();
}
function buildTuyaHeaders(method, path, token, body = '') {
  const t     = Date.now().toString();
  const nonce = crypto.randomUUID().replace(/-/g, '');
  const sts   = [method.toUpperCase(), sha256hex(body), '', path].join('\n');
  const sign  = hmacUpper(ACCESS_ID + (token || '') + t + nonce + sts, ACCESS_SECRET);
  const h = { client_id: ACCESS_ID, sign, t, nonce, sign_method: 'HMAC-SHA256', 'Content-Type': 'application/json' };
  if (token) h.access_token = token;
  if (body)  h['Content-Length'] = Buffer.byteLength(body, 'utf8').toString();
  return h;
}

// ── AES-128-ECB (PKCS7) — used for jtmspro password encryption ───────────────
// Key: first 16 UTF-8 bytes of ACCESS_SECRET
const AES_KEY = Buffer.from(ACCESS_SECRET.substring(0, 16), 'utf8');

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

// ── Low-level Tuya HTTPS request ──────────────────────────────────────────────
function tuyaFetch(method, path, token, body = '') {
  return new Promise((resolve, reject) => {
    const headers = buildTuyaHeaders(method, path, token, body);
    const opts = { hostname: TUYA_HOST, port: 443, path, method, headers };
    console.log(`  → ${method} https://${TUYA_HOST}${path}`);
    const req = https.request(opts, res => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        console.log(`  ← ${res.statusCode}  ${raw.slice(0, 120)}`);
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(new Error(`Non-JSON response (${res.statusCode}): ${raw.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ── Full jtmspro 3-step flow ──────────────────────────────────────────────────
async function createTempCode({ token, deviceId, code, name, durationSec }) {
  const nowSec = Math.floor(Date.now() / 1000);
  const steps  = {};

  // ── Step 1: Get password ticket ───────────────────────────────────────────
  console.log('\n[step 1] POST door-lock/password-ticket');
  const ticketPath = `/v1.0/devices/${deviceId}/door-lock/password-ticket`;
  const step1 = await tuyaFetch('POST', ticketPath, token, '');
  steps.step1_ticket = step1;

  if (!step1.success) {
    return { ok: false, error: `Step 1 failed: ${step1.msg} (code ${step1.code})`, steps };
  }

  const ticketId  = step1.result?.ticket_id;
  const ticketKey = step1.result?.ticket_key; // hex-encoded AES-encrypted key

  if (!ticketId || !ticketKey) {
    return { ok: false, error: 'Step 1: missing ticket_id or ticket_key in response', steps };
  }

  // ── Step 2: Decrypt ticket_key → encrypt password ─────────────────────────
  console.log('\n[step 2] AES-128-ECB decrypt ticket_key, then encrypt password');
  let encryptedPasswordHex, decryptedKeyHex;
  try {
    // ticket_key may be hex or base64 — try hex first
    let ticketKeyBuf;
    if (/^[0-9a-fA-F]+$/.test(ticketKey) && ticketKey.length % 2 === 0) {
      ticketKeyBuf = Buffer.from(ticketKey, 'hex');
    } else {
      ticketKeyBuf = Buffer.from(ticketKey, 'base64');
    }

    const decryptedKey = aesEcbDecrypt(AES_KEY, ticketKeyBuf);
    decryptedKeyHex = decryptedKey.toString('hex');
    console.log(`  ticket_key (${ticketKey.length} chars) → decrypted key: ${decryptedKeyHex}`);

    const passwordBuf      = Buffer.from(code, 'utf8');
    const encryptedPwdBuf  = aesEcbEncrypt(decryptedKey, passwordBuf);
    encryptedPasswordHex   = encryptedPwdBuf.toString('hex');
    console.log(`  password "${code}" → encrypted: ${encryptedPasswordHex}`);

    steps.step2_crypto = {
      aes_key_used:           AES_KEY.toString('utf8'),
      ticket_key_raw:         ticketKey,
      ticket_key_encoding:    /^[0-9a-fA-F]+$/.test(ticketKey) ? 'hex' : 'base64',
      decrypted_key_hex:      decryptedKeyHex,
      plaintext_password:     code,
      encrypted_password_hex: encryptedPasswordHex,
    };
  } catch (e) {
    steps.step2_crypto = { error: e.message };
    return { ok: false, error: `Step 2 crypto failed: ${e.message}`, steps };
  }

  // ── Step 3: POST temp-passwords ───────────────────────────────────────────
  console.log('\n[step 3] POST door-lock/temp-passwords');
  const createPath = `/v1.0/devices/${deviceId}/door-lock/temp-passwords`;
  const body3 = JSON.stringify({
    name,
    password:       encryptedPasswordHex,
    effective_time: nowSec,
    invalid_time:   nowSec + durationSec,
    ticket_id:      ticketId,
  });
  const step3 = await tuyaFetch('POST', createPath, token, body3);
  steps.step3_create = step3;

  if (!step3.success) {
    return { ok: false, error: `Step 3 failed: ${step3.msg} (code ${step3.code})`, steps };
  }

  return {
    ok:         true,
    password_id: step3.result,
    plaintext:  code,
    valid_from: new Date(nowSec * 1000).toISOString(),
    valid_until: new Date((nowSec + durationSec) * 1000).toISOString(),
    steps,
  };
}

// ── HTTP server ───────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Tuya-Token');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const send = (status, obj) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(obj, null, 2));
  };

  // ── /ping ─────────────────────────────────────────────────────────────────
  if (req.url === '/ping') {
    send(200, { ok: true, proxy: 'tuya', host: TUYA_HOST }); return;
  }

  // Collect body first for all routes
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', async () => {

    // ── /api/create-temp-code — full jtmspro ticket+encrypt+create ──────────
    if (req.url === '/api/create-temp-code' && req.method === 'POST') {
      const token = req.headers['x-tuya-token'];
      if (!token) { send(401, { error: 'X-Tuya-Token header required' }); return; }

      let params;
      try { params = JSON.parse(body); }
      catch (e) { send(400, { error: 'Invalid JSON body' }); return; }

      const { code = '12345678', name = 'SleepyTest', durationSec = 3600, deviceId = 'bf70cd74974715b99cxmee' } = params;

      console.log(`\n═══ create-temp-code: device=${deviceId} code=${code} name="${name}" duration=${durationSec}s ═══`);
      try {
        const result = await createTempCode({ token, deviceId, code, name, durationSec });
        send(result.ok ? 200 : 422, result);
      } catch (e) {
        console.error('create-temp-code error:', e);
        send(500, { error: e.message });
      }
      return;
    }

    // ── Transparent proxy → Tuya (/v1.x/...) ─────────────────────────────────
    if (!req.url.startsWith('/v')) {
      send(404, { error: 'Unknown route. Use /ping, /api/create-temp-code, or /v1.x/...' }); return;
    }

    const token = req.headers['x-tuya-token'] || null;
    const authHeaders = buildTuyaHeaders(req.method, req.url, token, body);
    const opts = { hostname: TUYA_HOST, port: 443, path: req.url, method: req.method, headers: authHeaders };

    console.log(`→ ${req.method} https://${TUYA_HOST}${req.url}${token ? ' [+token]' : ''}`);

    const proxyReq = https.request(opts, proxyRes => {
      let data = '';
      proxyRes.on('data', c => { data += c; });
      proxyRes.on('end', () => {
        console.log(`← ${proxyRes.statusCode} (${data.length}b)`);
        res.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(data);
      });
    });
    proxyReq.on('error', err => { send(502, { error: 'Proxy error', detail: err.message }); });
    if (body) proxyReq.write(body);
    proxyReq.end();
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('  ┌─────────────────────────────────────────────┐');
  console.log(`  │  Tuya proxy  →  http://localhost:${PORT}     │`);
  console.log(`  │  Region: Central Europe (${TUYA_HOST})  │`);
  console.log(`  │  AES key: first 16 bytes of ACCESS_SECRET  │`);
  console.log('  └─────────────────────────────────────────────┘');
  console.log('');
  console.log('  Routes:');
  console.log('    GET  /ping                    health check');
  console.log('    POST /api/create-temp-code    full jtmspro 3-step flow');
  console.log('    *    /v1.0/...                transparent Tuya proxy');
  console.log('');
});
