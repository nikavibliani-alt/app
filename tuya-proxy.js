/**
 * tuya-proxy.js — local CORS proxy for Tuya OpenAPI (Central Europe)
 *
 * Usage: node tuya-proxy.js
 * Runs on http://localhost:3000
 *
 * Handles all Tuya HMAC-SHA256 signing server-side.
 * tuya-test.html calls this proxy with an optional X-Tuya-Token header.
 * No npm packages required — only Node.js built-ins.
 */

const http   = require('http');
const https  = require('https');
const crypto = require('crypto');
const { URL } = require('url');

// ── Credentials ───────────────────────────────────────────────────────────────
const ACCESS_ID     = 'wxd3afwrhewvh5p5tukc';
const ACCESS_SECRET = '80edc016e2d84df886f500f38f5cc6b7';
const TUYA_HOST     = 'openapi.tuyaeu.com';
const PORT          = 3000;

// ── Signing ───────────────────────────────────────────────────────────────────
function sha256hex(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

function hmacSHA256upper(str, secret) {
  return crypto.createHmac('sha256', secret).update(str, 'utf8').digest('hex').toUpperCase();
}

/**
 * Build Tuya authentication headers.
 * Tuya v2.0 full signing:
 *   signStr = client_id + access_token + t + nonce
 *             + "\n" + METHOD + "\n" + sha256(body) + "\n" + "" + "\n" + path_with_query
 */
function buildTuyaHeaders(method, pathWithQuery, token, body = '') {
  const t     = Date.now().toString();
  const nonce = crypto.randomUUID().replace(/-/g, '');

  const stringToSign = [
    method.toUpperCase(),
    sha256hex(body),
    '',               // empty custom-header section
    pathWithQuery,
  ].join('\n');

  const signStr = ACCESS_ID + (token || '') + t + nonce + stringToSign;
  const sign    = hmacSHA256upper(signStr, ACCESS_SECRET);

  const headers = {
    'client_id':   ACCESS_ID,
    'sign':        sign,
    't':           t,
    'nonce':       nonce,
    'sign_method': 'HMAC-SHA256',
    'Content-Type':'application/json',
  };
  if (token) headers['access_token'] = token;
  return headers;
}

// ── HTTP server ───────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  // Allow all CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Tuya-Token');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Health-check endpoint
  if (req.url === '/ping') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, proxy: 'tuya', host: TUYA_HOST }));
    return;
  }

  // Only proxy paths starting with /v
  if (!req.url.startsWith('/v')) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found — proxy only handles /v1.0/... paths' }));
    return;
  }

  const token = req.headers['x-tuya-token'] || null;

  // Collect body (for POST/PUT)
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    const authHeaders = buildTuyaHeaders(req.method, req.url, token, body);

    const options = {
      hostname: TUYA_HOST,
      port:     443,
      path:     req.url,
      method:   req.method,
      headers:  authHeaders,
    };

    console.log(`→ ${req.method} https://${TUYA_HOST}${req.url}${token ? ' [with token]' : ' [no token]'}`);

    const proxyReq = https.request(options, proxyRes => {
      let data = '';
      proxyRes.on('data', chunk => { data += chunk; });
      proxyRes.on('end', () => {
        console.log(`← ${proxyRes.statusCode} (${data.length} bytes)`);
        res.writeHead(proxyRes.statusCode, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(data);
      });
    });

    proxyReq.on('error', err => {
      console.error('Proxy request error:', err.message);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Proxy error', detail: err.message }));
    });

    if (body) proxyReq.write(body);
    proxyReq.end();
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('  ┌─────────────────────────────────────────┐');
  console.log(`  │  Tuya proxy  →  http://localhost:${PORT}   │`);
  console.log(`  │  Region: Central Europe (${TUYA_HOST})  │`);
  console.log(`  │  Access ID: ${ACCESS_ID}  │`);
  console.log('  └─────────────────────────────────────────┘');
  console.log('');
  console.log('  Open tuya-test.html in your browser, or:');
  console.log('  curl http://localhost:3000/ping');
  console.log('');
});
