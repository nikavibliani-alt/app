/**
 * tuya-proxy.js — Tuya OpenAPI proxy with full response pass-through
 * Every Tuya response is logged and returned verbatim.
 */

const http   = require('http');
const https  = require('https');
const crypto = require('crypto');

const ACCESS_ID     = 'wxd3afwrhewvh5p5tukc';
const ACCESS_SECRET = '80edc016e2d84df886f500f38f5cc6b7';
const TUYA_HOST     = 'openapi.tuyaeu.com';
const PORT          = 3000;

// ── Signing ───────────────────────────────────────────────────────────────────
function sha256hex(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}
function hmacUpper(s, k) {
  return crypto.createHmac('sha256', k).update(s, 'utf8').digest('hex').toUpperCase();
}
function sign(method, path, token, body) {
  const t     = Date.now().toString();
  const nonce = crypto.randomUUID().replace(/-/g, '');
  const sts   = [method.toUpperCase(), sha256hex(body), '', path].join('\n');
  const str   = ACCESS_ID + (token || '') + t + nonce + sts;
  return {
    headers: {
      'client_id':     ACCESS_ID,
      'access_token':  token || '',
      'sign':          hmacUpper(str, ACCESS_SECRET),
      't':             t,
      'nonce':         nonce,
      'sign_method':   'HMAC-SHA256',
      'Content-Type':  'application/json',
      'Content-Length': Buffer.byteLength(body, 'utf8').toString(),
    },
    t, nonce,
  };
}

// ── AES-128-ECB ───────────────────────────────────────────────────────────────
const AES_KEY = Buffer.from(ACCESS_SECRET.slice(0, 16), 'utf8');

function aesDecrypt(key, data) {
  const d = crypto.createDecipheriv('aes-128-ecb', key, null);
  d.setAutoPadding(true);
  return Buffer.concat([d.update(data), d.final()]);
}
function aesEncrypt(key, data) {
  const c = crypto.createCipheriv('aes-128-ecb', key, null);
  c.setAutoPadding(true);
  return Buffer.concat([c.update(data), c.final()]);
}

// ── Raw HTTPS call to Tuya ────────────────────────────────────────────────────
// Always resolves. Never swallows. Returns { ok, status, data, raw }.
function tuyaCall(method, path, token, body) {
  body = body || '';
  const { headers } = sign(method, path, token, body);

  console.log(`\n── TUYA ${method} ${path}`);
  console.log(`   body: ${body || '(empty)'}`);

  return new Promise(resolve => {
    const req = https.request(
      { hostname: TUYA_HOST, port: 443, path, method, headers },
      res => {
        let raw = '';
        res.on('data', c => { raw += c; });
        res.on('end', () => {
          let data;
          try   { data = JSON.parse(raw); }
          catch { data = { _parse_error: 'not JSON', _raw: raw }; }

          console.log(`   HTTP ${res.statusCode}`);
          console.log('TUYA RESPONSE:', JSON.stringify(data));

          resolve({ ok: data.success === true, status: res.statusCode, data, raw });
        });
      }
    );

    req.on('error', err => {
      console.error('   NETWORK ERROR:', err.message);
      resolve({ ok: false, status: 0, data: { error: err.message }, raw: '' });
    });

    req.write(body);
    req.end();
  });
}

// ── jtmspro flow ──────────────────────────────────────────────────────────────
// Step 1: GET password-ticket (check if required)
// Step 2: POST /v1.0/smart-lock/devices/{id}/temporary-password (plaintext, no encryption)
async function jtmsproFlow({ token, deviceId, code, name, durationSec }) {
  const nowSec = Math.floor(Date.now() / 1000);
  const result = { ok: false, steps: {} };

  // ── Step 1: GET password-ticket — check if required ──────────────────────
  const ticketPath = `/v1.0/smart-lock/devices/${deviceId}/password-ticket`;
  console.log('\n── STEP 1: GET password-ticket (informational)');
  const r1 = await tuyaCall('GET', ticketPath, token, '');
  result.steps.step1 = {
    endpoint:      ticketPath,
    http_status:   r1.status,
    tuya_response: r1.data,
    note:          r1.ok
      ? 'Ticket available — may be required for some firmware'
      : `code=${r1.data?.code}: ${r1.data?.msg}`,
  };
  // Extract ticket_id if present (used in step 2 body if returned)
  const ticketId = r1.data?.result?.ticket_id ?? null;
  if (ticketId) console.log(`   ticket_id: ${ticketId}`);

  // ── Step 2: POST temporary-password (plaintext password, no AES) ─────────
  const createPath = `/v1.0/smart-lock/devices/${deviceId}/temporary-password`;
  const body2 = JSON.stringify({
    name,
    password:       code,         // plaintext — no encryption for this endpoint
    password_type:  0,            // 0 = one-time, 1 = time-limited recurring
    effective_time: nowSec,
    invalid_time:   nowSec + durationSec,
    ...(ticketId ? { ticket_id: ticketId } : {}),
  });

  console.log('\n── STEP 2: POST temporary-password');
  console.log('   body:', body2);
  const r2 = await tuyaCall('POST', createPath, token, body2);
  result.steps.step2 = {
    endpoint:      createPath,
    body_sent:     JSON.parse(body2),
    http_status:   r2.status,
    tuya_response: r2.data,
  };

  if (r2.ok) {
    result.ok          = true;
    result.password_id = r2.data.result;
    result.plaintext   = code;
    result.valid_from  = new Date(nowSec * 1000).toISOString();
    result.valid_until = new Date((nowSec + durationSec) * 1000).toISOString();
    console.log('── ✅ DONE  password_id:', result.password_id);
  } else {
    result.error = `Step 2 failed: code=${r2.data?.code} msg=${r2.data?.msg}`;
    console.log('── ✗', result.error);
  }

  return result;
}

// ── HTTP server ───────────────────────────────────────────────────────────────
http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Tuya-Token');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const send = (status, obj) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(obj, null, 2));
  };

  if (req.url === '/ping') {
    send(200, { ok: true, host: TUYA_HOST, aes_key_hex: AES_KEY.toString('hex') });
    return;
  }

  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', async () => {

    // Internal flow endpoint
    if (req.url === '/api/create-temp-code' && req.method === 'POST') {
      const token = req.headers['x-tuya-token'];
      if (!token) { send(401, { error: 'Missing X-Tuya-Token header' }); return; }
      let p = {};
      try { p = JSON.parse(body || '{}'); } catch { /* ignore */ }
      const { code = '12345678', name = 'SleepyTest', durationSec = 3600, deviceId = 'bf70cd74974715b99cxmee' } = p;

      console.log(`\n${'═'.repeat(55)}`);
      console.log(`jtmspro flow  device=${deviceId}  code=${code}  dur=${durationSec}s`);
      console.log('═'.repeat(55));

      try {
        const r = await jtmsproFlow({ token, deviceId, code, name, durationSec });
        send(r.ok ? 200 : 422, r);
      } catch (e) {
        console.error('UNHANDLED:', e);
        send(500, { error: e.message });
      }
      return;
    }

    // Transparent proxy for /v1.x/... calls
    if (!req.url.startsWith('/v')) {
      send(404, { error: 'Unknown route' }); return;
    }

    const token = req.headers['x-tuya-token'] || null;
    const r = await tuyaCall(req.method, req.url, token, body);
    send(r.status || 200, r.data);
  });

}).listen(PORT, '127.0.0.1', () => {
  console.log(`\nTuya proxy → http://localhost:${PORT}`);
  console.log(`AES key (hex): ${AES_KEY.toString('hex')}`);
  console.log('All Tuya responses logged in full. Waiting for requests…\n');
});
