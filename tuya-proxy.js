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

// ── jtmspro 3-step flow ───────────────────────────────────────────────────────
async function jtmsproFlow({ token, deviceId, code, name, durationSec }) {
  const nowSec  = Math.floor(Date.now() / 1000);
  const result  = { ok: false, steps: {} };

  // Step 1: try four body variants for password-ticket
  const ticketPath = `/v1.0/devices/${deviceId}/door-lock/password-ticket`;
  const variants   = [
    '{}',
    JSON.stringify({ ticket_type: 0 }),
    JSON.stringify({ ticket_type: 1 }),
    '',
  ];

  const attempts = [];
  let ticket = null;

  for (const body of variants) {
    console.log(`\n── STEP 1 variant: ${body || '(empty string)'}`);
    const r = await tuyaCall('POST', ticketPath, token, body);
    attempts.push({ body_sent: body, http_status: r.status, tuya_response: r.data });
    if (r.ok) {
      ticket = r.data.result;
      console.log('   ✅ ticket obtained:', JSON.stringify(ticket));
      break;
    }
    console.log(`   ✗ code=${r.data?.code} msg=${r.data?.msg}`);
  }

  result.steps.step1 = { attempts, ticket };

  if (!ticket?.ticket_id || !ticket?.ticket_key) {
    result.error = 'Step 1 failed — no ticket from any variant';
    return result;
  }

  // Step 2: crypto
  let encPwd;
  try {
    const isHex = /^[0-9a-fA-F]+$/.test(ticket.ticket_key) && ticket.ticket_key.length % 2 === 0;
    const tkBuf = Buffer.from(ticket.ticket_key, isHex ? 'hex' : 'base64');
    const dk    = aesDecrypt(AES_KEY, tkBuf);
    const epBuf = aesEncrypt(dk, Buffer.from(code, 'utf8'));
    encPwd      = epBuf.toString('hex');

    result.steps.step2 = {
      aes_key_hex:        AES_KEY.toString('hex'),
      ticket_key:         ticket.ticket_key,
      ticket_key_enc:     isHex ? 'hex' : 'base64',
      decrypted_key_hex:  dk.toString('hex'),
      plaintext:          code,
      encrypted_hex:      encPwd,
    };
    console.log('\n── STEP 2 crypto OK, encrypted_password:', encPwd);
  } catch (e) {
    result.steps.step2 = { error: e.message };
    result.error = 'Step 2 crypto failed: ' + e.message;
    console.error('── STEP 2 ERROR:', e.message);
    return result;
  }

  // Step 3: create temp password
  const createPath = `/v1.0/devices/${deviceId}/door-lock/temp-passwords`;
  const body3 = JSON.stringify({
    name,
    password:       encPwd,
    effective_time: nowSec,
    invalid_time:   nowSec + durationSec,
    ticket_id:      ticket.ticket_id,
  });

  console.log('\n── STEP 3');
  const r3 = await tuyaCall('POST', createPath, token, body3);
  result.steps.step3 = { body_sent: JSON.parse(body3), http_status: r3.status, tuya_response: r3.data };

  if (r3.ok) {
    result.ok          = true;
    result.password_id = r3.data.result;
    result.plaintext   = code;
    result.valid_from  = new Date(nowSec * 1000).toISOString();
    result.valid_until = new Date((nowSec + durationSec) * 1000).toISOString();
    console.log('── ✅ DONE, password_id:', result.password_id);
  } else {
    result.error = `Step 3 failed: code=${r3.data?.code} msg=${r3.data?.msg}`;
    console.log('── ✗ Step 3 failed:', result.error);
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
