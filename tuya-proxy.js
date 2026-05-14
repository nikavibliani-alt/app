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

// Helper: Calculate MD5 of Body
const calcBodyHash = (body) => {
    const content = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : '';
    return crypto.createHash('sha256').update(content).digest('hex');
};

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

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
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
    });
});

server.listen(CONFIG.port, () => {
    console.log(`Tuya Proxy running at http://localhost:${CONFIG.port}`);
    console.warn("CRITICAL: Rotate your Access Secret after testing. It is currently exposed.");
});
