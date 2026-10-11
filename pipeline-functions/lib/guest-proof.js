'use strict';
/**
 * Short-lived signed proof that a visitor really found a booking (name + arrival date, or booking number).
 * It lets the later "is there already a guest record for this booking" step run on the server without
 * letting anyone who merely knows a reservation id take over another guest's page.
 */
const crypto = require('crypto');

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function sign(secret, payload, nowMs = Date.now(), ttlMs = 2 * 3600 * 1000) {
  if (!secret) throw new Error('proof secret missing');
  const body = b64url(JSON.stringify({ ...payload, exp: nowMs + ttlMs }));
  const sig = b64url(crypto.createHmac('sha256', secret).update(body).digest());
  return body + '.' + sig;
}

function verify(secret, token, nowMs = Date.now()) {
  if (!secret || typeof token !== 'string') return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const want = b64url(crypto.createHmac('sha256', secret).update(body).digest());
  const a = Buffer.from(sig), b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    if (!(payload.exp > nowMs)) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

module.exports = { sign, verify };
