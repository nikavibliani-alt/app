'use strict';
/**
 * inboxEmailIngest: step 1 of the Booking.com guest inbox (see docs/INBOX_PLAN.md).
 *
 * The Gmail Apps Script POSTs one email per request. We check the secret key and save the email
 * to inbox_raw_emails/{gmailMessageId}. Nothing else happens here: no sorting, no replies,
 * no AI, no notifications.
 *
 * The Gmail message id is the document id, and we use create(), so the same email is never
 * saved twice and the first receivedAt is kept.
 */

const crypto = require('crypto');

const COLLECTION = 'inbox_raw_emails';
const SOURCE = 'gmail-script';
const ID_RE = /^[A-Za-z0-9_-]{6,128}$/;
const MAX_SHORT = 1000;          // addresses, subject, header values
const MAX_TEXT = 200 * 1024;     // plain-text body, characters
const MAX_HTML = 200 * 1024;     // HTML body, characters
const MAX_HEADERS = 40;

// Headers worth keeping for sorting and for replying in the same thread later.
const HEADER_ALLOW = new Set([
  'message-id', 'in-reply-to', 'references', 'return-path', 'sender', 'cc', 'bcc',
  'delivered-to', 'auto-submitted', 'precedence', 'list-id', 'reply-to',
  'mime-version', 'content-type', 'x-mailer',
]);

const str = (v, max = MAX_SHORT) => (typeof v === 'string' ? v.slice(0, max) : '');

function cleanHeaders(h) {
  const out = {};
  if (!h || typeof h !== 'object' || Array.isArray(h)) return out;
  let n = 0;
  for (const k of Object.keys(h)) {
    const key = k.toLowerCase();
    if (!HEADER_ALLOW.has(key) && !key.startsWith('x-booking')) continue;
    if (n >= MAX_HEADERS) break;
    out[key] = str(h[k]);
    n++;
  }
  return out;
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function bearerKey(req) {
  const auth = String((req.get && req.get('authorization')) || '');
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : '';
}

/**
 * deps: { getKey(): string, db: Firestore-like, now(): Timestamp-like }
 * Returns nothing; writes the response.
 */
async function handle(req, res, deps) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method' });

  const expected = deps.getKey();
  const given = bearerKey(req);
  if (!expected || !given || !safeEqual(given, expected)) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  const b = req.body && typeof req.body === 'object' ? req.body : {};
  const id = str(b.gmailMessageId, 200);
  if (!ID_RE.test(id)) return res.status(400).json({ ok: false, error: 'bad gmailMessageId' });

  const doc = {
    gmailMessageId: id,
    gmailThreadId: str(b.gmailThreadId, 200),
    date: str(b.date, 100),
    from: str(b.from),
    to: str(b.to),
    replyTo: str(b.replyTo),
    subject: str(b.subject),
    bodyText: str(b.bodyText, MAX_TEXT),
    bodyHtml: str(b.bodyHtml, MAX_HTML),
    headers: cleanHeaders(b.headers),
    receivedAt: deps.now(),
    source: SOURCE,
  };

  try {
    await deps.db.collection(COLLECTION).doc(id).create(doc);
  } catch (e) {
    // gRPC ALREADY_EXISTS (6): the email is already saved. That is fine.
    if (e && (e.code === 6 || e.code === 'already-exists')) {
      return res.status(200).json({ ok: true, duplicate: true });
    }
    console.error('inboxEmailIngest save failed', e && e.code, e && e.message);
    return res.status(500).json({ ok: false, error: 'save failed' });
  }
  return res.status(200).json({ ok: true, duplicate: false });
}

function registerCloudFunction() {
  const { onRequest } = require('firebase-functions/v2/https');
  const { defineSecret } = require('firebase-functions/params');
  const { getFirestore, Timestamp } = require('firebase-admin/firestore');
  const INBOX_INGEST_KEY = defineSecret('INBOX_INGEST_KEY');

  return onRequest(
    { region: 'europe-west1', secrets: [INBOX_INGEST_KEY], timeoutSeconds: 30, maxInstances: 5, memory: '256MiB' },
    (req, res) =>
      handle(req, res, {
        getKey: () => INBOX_INGEST_KEY.value(),
        db: getFirestore(),
        now: () => Timestamp.now(),
      })
  );
}

module.exports = { handle, registerCloudFunction, cleanHeaders, COLLECTION };
