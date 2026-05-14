/**
 * tuya-proxy.js — generic Tuya signing proxy
 *
 * Every incoming request is signed and forwarded to openapi.tuyaeu.com.
 * The raw Tuya response is returned verbatim — no parsing, no routing logic.
 *
 * Only special route: GET /ping (health check)
 * Everything else: sign → forward → pipe response back as-is
 */

const http   = require('http');
const https  = require('https');
const crypto = require('crypto');

const ACCESS_ID     = 'wxd3afwrhewvh5p5tukc';
const ACCESS_SECRET = '80edc016e2d84df886f500f38f5cc6b7';
const TUYA_HOST     = 'openapi.tuyaeu.com';
const PORT          = 3000;

function sha256hex(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}
function hmacUpper(s, k) {
  return crypto.createHmac('sha256', k).update(s, 'utf8').digest('hex').toUpperCase();
}

function buildHeaders(method, path, token, body) {
  const t     = Date.now().toString();
  const nonce = crypto.randomUUID().replace(/-/g, '');
  const sts   = [method.toUpperCase(), sha256hex(body), '', path].join('\n');
  const str   = ACCESS_ID + (token || '') + t + nonce + sts;
  const h     = {
    'client_id':      ACCESS_ID,
    'sign':           hmacUpper(str, ACCESS_SECRET),
    't':              t,
    'nonce':          nonce,
    'sign_method':    'HMAC-SHA256',
    'Content-Type':   'application/json',
    'Content-Length': Buffer.byteLength(body, 'utf8').toString(),
  };
  // Only add access_token header when a real token is supplied
  if (token) h['access_token'] = token;
  return h;
}

http.createServer((req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Tuya-Token');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Health check
  if (req.url === '/ping') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ ok: true, host: TUYA_HOST }));
    return;
  }

  // Collect request body (empty string for GET)
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    const token   = req.headers['x-tuya-token'] || null;
    const headers = buildHeaders(req.method, req.url, token, body);

    console.log(`\n→ ${req.method} https://${TUYA_HOST}${req.url}`);
    if (body) console.log(`  body: ${body}`);

    const fwd = https.request(
      { hostname: TUYA_HOST, port: 443, path: req.url, method: req.method, headers },
      tuyaRes => {
        let raw = '';
        tuyaRes.on('data', c => { raw += c; });
        tuyaRes.on('end', () => {
          console.log(`← ${tuyaRes.statusCode}  (${raw.length} bytes)`);
          console.log('TUYA RESPONSE:', raw);

          // Forward Tuya's response verbatim — no modification
          res.writeHead(tuyaRes.statusCode, {
            'Content-Type':                'application/json',
            'Access-Control-Allow-Origin': '*',
          });
          res.end(raw);
        });
      }
    );

    fwd.on('error', err => {
      console.error('NETWORK ERROR:', err.message);
      res.writeHead(502, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: err.message }));
    });

    fwd.write(body);
    fwd.end();
  });

}).listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log(`  Tuya proxy → http://localhost:${PORT}`);
  console.log(`  Forwarding all requests to ${TUYA_HOST}`);
  console.log('  Raw Tuya responses returned verbatim — no route handling.');
  console.log('');
});
