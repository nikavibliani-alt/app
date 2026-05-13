/**
 * tuya-proxy.js — local CORS proxy for Tuya OpenAPI (Central Europe)
 * Routes:
 *   GET  /ping                     health check
 *   POST /api/create-temp-code     full jtmspro 3-step ticket+encrypt+create flow
 *   *    /v1.x/...                 transparent proxy → openapi.tuyaeu.com
 */

const http   = require('http');
const https  = require('https');
const crypto = require('crypto');

const ACCESS_ID     = 'wxd3afwrhewvh5p5tukc';
const ACCESS_SECRET = '80edc016e2d84df886f500f38f5cc6b7';
const TUYA_HOST     = 'openapi.tuyaeu.com';
const PORT          = 3000;

// ── Signing ───────────────────────────────────────────────────────────────────
function sha256hex(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}
function hmacUpper(str, secret) {
  return crypto.createHmac('sha256', secret).update(str, 'utf8').digest('hex').toUpperCase();
}

function buildTuyaHeaders(method, path, token, body) {
  // body must be a string — always pass '' or JSON string, never null/undefined
  const bodyStr = body || '';
  const t     = Date.now().toString();
  const nonce = crypto.randomUUID().replace(/-/g, '');
  const sts   = [method.toUpperCase(), sha256hex(bodyStr), '', path].join('\n');
  const sign  = hmacUpper(ACCESS_ID + (token || '') + t + nonce + sts, ACCESS_SECRET);
  return {
    'client_id':      ACCESS_ID,
    'sign':           sign,
    't':              t,
    'nonce':          nonce,
    'sign_method':    'HMAC-SHA256',
    'Content-Type':   'application/json',
    // Always send Content-Length — Tuya rejects POST with no Content-Length
    'Content-Length': Buffer.byteLength(bodyStr, 'utf8').toString(),
    ...(token ? { 'access_token': token } : {}),
  };
}

// ── AES-128-ECB (PKCS7) ───────────────────────────────────────────────────────
// Key = first 16 UTF-8 bytes of ACCESS_SECRET
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

// ── Core HTTPS request to Tuya ────────────────────────────────────────────────
// Returns { parsed, raw, status } — NEVER throws on HTTP-level errors.
// Only rejects on network failure.
function tuyaFetch(method, path, token, body) {
  const bodyStr = body || '';
  const headers = buildTuyaHeaders(method, path, token, bodyStr);

  return new Promise((resolve, reject) => {
    const opts = { hostname: TUYA_HOST, port: 443, path, method, headers };

    console.log(`\n  ┌─ ${method} https://${TUYA_HOST}${path}`);
    console.log(`  │  body (${bodyStr.length}b): ${bodyStr || '(empty)'}`);
    console.log(`  │  sign: ${headers.sign}`);
    console.log(`  │  t: ${headers.t}  nonce: ${headers.nonce}`);

    const req = https.request(opts, res => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        console.log(`  └─ HTTP ${res.statusCode}  raw (${raw.length}b):`);
        console.log(`     ${raw}`);            // full response, no truncation

        let parsed;
        try   { parsed = JSON.parse(raw); }
        catch (e) { parsed = { _parseError: e.message, _raw: raw }; }

        resolve({ parsed, raw, status: res.statusCode });
      });
    });

    req.on('error', err => {
      console.error(`  └─ NETWORK ERROR: ${err.message}`);
      reject(err);
    });

    // Always write body for POST (even empty string keeps Content-Length correct)
    req.write(bodyStr);
    req.end();
  });
}

// ── jtmspro full flow ─────────────────────────────────────────────────────────
async function createTempCode({ token, deviceId, code, name, durationSec }) {
  const nowSec = Math.floor(Date.now() / 1000);
  const steps  = {};

  // ── Step 1: POST password-ticket ─────────────────────────────────────────
  // Try two body variants — some jtmspro firmware needs ticket_type, some don't
  const ticketPath = `/v1.0/devices/${deviceId}/door-lock/password-ticket`;
  const ticketBodies = [
    { label: 'empty body {}',             body: '{}' },
    { label: 'ticket_type=0',             body: JSON.stringify({ ticket_type: 0 }) },
    { label: 'ticket_type=1',             body: JSON.stringify({ ticket_type: 1 }) },
    { label: 'truly empty (no JSON)',     body: '' },
  ];

  let ticketId = null, ticketKey = null;
  const ticketAttempts = [];

  for (const variant of ticketBodies) {
    console.log(`\n[step 1] POST password-ticket — ${variant.label}`);
    const r = await tuyaFetch('POST', ticketPath, token, variant.body);
    const attempt = {
      variant: variant.label,
      body_sent: variant.body,
      http_status: r.status,
      response: r.parsed,
      raw: r.raw,
    };
    ticketAttempts.push(attempt);

    if (r.parsed?.success) {
      ticketId  = r.parsed.result?.ticket_id;
      ticketKey = r.parsed.result?.ticket_key;
      attempt.winner = true;
      console.log(`  ✅ Ticket obtained: ticket_id=${ticketId}`);
      break;
    } else {
      console.log(`  ✗ code=${r.parsed?.code} msg=${r.parsed?.msg}`);
    }
  }

  steps.step1_ticket = {
    attempts:  ticketAttempts,
    ticket_id: ticketId,
    ticket_key: ticketKey,
    success:   !!ticketId,
  };

  if (!ticketId || !ticketKey) {
    return {
      ok:    false,
      error: 'Step 1: no ticket obtained — see attempts for details',
      steps,
    };
  }

  // ── Step 2: Decrypt ticket_key → encrypt password ─────────────────────────
  console.log('\n[step 2] AES-128-ECB crypto');
  let encryptedPasswordHex;
  try {
    // Detect ticket_key encoding: hex or base64
    const isHex = /^[0-9a-fA-F]+$/.test(ticketKey) && ticketKey.length % 2 === 0;
    const ticketKeyBuf = Buffer.from(ticketKey, isHex ? 'hex' : 'base64');

    console.log(`  ticket_key (${ticketKey.length} chars, ${isHex ? 'hex' : 'base64'}): ${ticketKey}`);
    console.log(`  AES key (utf8 of secret[:16]): ${AES_KEY.toString('hex')}`);

    const decryptedKey = aesEcbDecrypt(AES_KEY, ticketKeyBuf);
    console.log(`  decrypted_key: ${decryptedKey.toString('hex')}`);

    const encPwdBuf   = aesEcbEncrypt(decryptedKey, Buffer.from(code, 'utf8'));
    encryptedPasswordHex = encPwdBuf.toString('hex');
    console.log(`  encrypted_password: ${encryptedPasswordHex}`);

    steps.step2_crypto = {
      aes_key_hex:            AES_KEY.toString('hex'),
      aes_key_utf8:           AES_KEY.toString('utf8'),
      ticket_key_raw:         ticketKey,
      ticket_key_encoding:    isHex ? 'hex' : 'base64',
      ticket_key_bytes:       ticketKeyBuf.toString('hex'),
      decrypted_key_hex:      decryptedKey.toString('hex'),
      plaintext_password:     code,
      encrypted_password_hex: encryptedPasswordHex,
    };
  } catch (e) {
    console.error('  CRYPTO ERROR:', e);
    steps.step2_crypto = { error: e.message, stack: e.stack };
    return { ok: false, error: `Step 2 crypto failed: ${e.message}`, steps };
  }

  // ── Step 3: POST temp-passwords ───────────────────────────────────────────
  console.log('\n[step 3] POST temp-passwords');
  const createPath = `/v1.0/devices/${deviceId}/door-lock/temp-passwords`;
  const body3 = JSON.stringify({
    name,
    password:       encryptedPasswordHex,
    effective_time: nowSec,
    invalid_time:   nowSec + durationSec,
    ticket_id:      ticketId,
  });
  console.log(`  body: ${body3}`);

  const r3 = await tuyaFetch('POST', createPath, token, body3);
  steps.step3_create = {
    http_status: r3.status,
    response:    r3.parsed,
    raw:         r3.raw,
    body_sent:   body3,
  };

  if (!r3.parsed?.success) {
    return {
      ok:    false,
      error: `Step 3 failed: ${r3.parsed?.msg} (code ${r3.parsed?.code})`,
      steps,
    };
  }

  return {
    ok:          true,
    password_id: r3.parsed.result,
    plaintext:   code,
    valid_from:  new Date(nowSec * 1000).toISOString(),
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
    const json = JSON.stringify(obj, null, 2);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(json);
  };

  if (req.url === '/ping') {
    send(200, { ok: true, proxy: 'tuya', host: TUYA_HOST, aes_key: AES_KEY.toString('hex') });
    return;
  }

  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', async () => {

    // ── /api/create-temp-code ──────────────────────────────────────────────
    if (req.url === '/api/create-temp-code' && req.method === 'POST') {
      const token = req.headers['x-tuya-token'];
      if (!token) { send(401, { error: 'X-Tuya-Token header required' }); return; }
      let params;
      try { params = JSON.parse(body || '{}'); }
      catch { send(400, { error: 'Invalid JSON body' }); return; }

      const {
        code       = '12345678',
        name       = 'SleepyTest',
        durationSec = 3600,
        deviceId   = 'bf70cd74974715b99cxmee',
      } = params;

      console.log(`\n${'═'.repeat(60)}`);
      console.log(`create-temp-code: device=${deviceId} code=${code} name="${name}" dur=${durationSec}s`);
      console.log('═'.repeat(60));

      try {
        const result = await createTempCode({ token, deviceId, code, name, durationSec });
        send(result.ok ? 200 : 422, result);
      } catch (e) {
        console.error('Unhandled error in createTempCode:', e);
        send(500, { error: e.message, stack: e.stack });
      }
      return;
    }

    // ── Transparent proxy → Tuya (/v1.x/...) ─────────────────────────────
    if (!req.url.startsWith('/v')) {
      send(404, { error: 'Unknown route. Use /ping, /api/create-temp-code, or /v1.x/...' });
      return;
    }

    const token = req.headers['x-tuya-token'] || null;
    const headers = buildTuyaHeaders(req.method, req.url, token, body);

    console.log(`\n→ ${req.method} https://${TUYA_HOST}${req.url}${token ? ' [+token]' : ''}`);

    const proxyReq = https.request(
      { hostname: TUYA_HOST, port: 443, path: req.url, method: req.method, headers },
      proxyRes => {
        let data = '';
        proxyRes.on('data', c => { data += c; });
        proxyRes.on('end', () => {
          console.log(`← ${proxyRes.statusCode}  ${data}`);
          res.writeHead(proxyRes.statusCode, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          });
          res.end(data);
        });
      }
    );
    proxyReq.on('error', err => send(502, { error: 'Proxy error', detail: err.message }));
    proxyReq.write(body || '');
    proxyReq.end();
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('  ┌───────────────────────────────────────────────────┐');
  console.log(`  │  Tuya proxy  →  http://localhost:${PORT}            │`);
  console.log(`  │  Region: Central Europe (${TUYA_HOST})       │`);
  console.log(`  │  AES key: ${AES_KEY.toString('hex')}  │`);
  console.log('  └───────────────────────────────────────────────────┘');
  console.log('');
  console.log('  Routes:');
  console.log('    GET  /ping                   health check + AES key');
  console.log('    POST /api/create-temp-code   full jtmspro 3-step flow');
  console.log('    *    /v1.0/...               transparent Tuya proxy');
  console.log('');
  console.log('  All Tuya responses logged in full below.\n');
});
