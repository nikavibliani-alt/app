'use strict';
/**
 * Replying to guests from the inbox (step 4, see docs/INBOX_PLAN.md).
 *
 *   inboxSendReply     callable, inbox users only (lib/inboxAccess.js). Saves the reply as a host message (status "waiting")
 *                      and as an item in inbox_outbox. Marks the conversation answered.
 *   inboxOutbox        HTTPS, key protected (same INBOX_INGEST_KEY as the ingest function). The
 *                      Gmail script asks it for waiting replies ("pull") and tells it how each
 *                      one went ("report"). A pulled item is marked "sending" first.
 *   inboxCheckinLink   callable, inbox users only. The Extranet page of a check-in time request.
 *
 * After saving a reply, inboxSendReply pokes the Gmail script's web app so the reply goes out at
 * once. That is best effort: if it fails or is slow, the script's every-minute run sends it.
 * Both paths only send what pull() hands out, and pull() marks an item "sending" in a transaction,
 * so a reply is never handed to both.
 *
 * Never sends twice: only "waiting" items can be pulled, and pulling marks them "sending" in the
 * same transaction. An item stuck in "sending" for more than 10 minutes becomes "unknown" and is
 * never sent again by itself. Sending is done by the Gmail script, not here.
 *
 * Statuses: waiting -> sending -> sent | failed | unknown.
 */

const crypto = require('crypto');
const {
  cleanReplyText, isBookingNumber, isClientId, isGuestAddress,
  checkinRequestLink, STALE_SENDING_MS,
} = require('../lib/inboxReply');
const { inboxUser } = require('../lib/inboxAccess');

const CONVERSATIONS = 'inbox_conversations';
const OUTBOX = 'inbox_outbox';
const RAW = 'inbox_raw_emails';
const MAX_PULL = 5;
const MAX_REASON = 300;
const POKE_TIMEOUT_MS = 6000;

class Fail extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const fail = (code, message) => new Fail(code, message);

const millis = v => (v && typeof v.toMillis === 'function' ? v.toMillis() : v && typeof v.toDate === 'function' ? v.toDate().getTime() : v ? new Date(v).getTime() : 0);

// ---------------------------------------------------------------- owner: send a reply

/** deps: { db, now(), trigger?() }. Returns { ok, outboxId, duplicate }. */
async function sendReply(auth, data, deps) {
  const user = inboxUser(auth);
  if (!user) throw fail('permission-denied', 'Only people with inbox access can send replies.');
  const d = data || {};
  if (!isBookingNumber(d.bookingNumber)) throw fail('invalid-argument', 'Bad booking number.');
  if (!isClientId(d.clientId)) throw fail('invalid-argument', 'Bad request id.');
  const clean = cleanReplyText(d.text);
  if (!clean.ok) throw fail('invalid-argument', clean.error);

  const { db, now } = deps;
  const convRef = db.collection(CONVERSATIONS).doc(d.bookingNumber);
  const outRef = db.collection(OUTBOX).doc(d.clientId);
  const msgRef = convRef.collection('messages').doc(d.clientId);

  const saved = await db.runTransaction(async tx => {
    const [conv, existing, recent] = await Promise.all([
      tx.get(convRef),
      tx.get(outRef),
      tx.get(convRef.collection('messages').orderBy('sentAt', 'desc').limit(10)),
    ]);
    if (existing.exists) return { ok: true, outboxId: d.clientId, duplicate: true };
    if (!conv.exists) throw fail('not-found', 'Conversation not found.');
    const c = conv.data();
    if (!isGuestAddress(c.replyTo)) throw fail('failed-precondition', 'This conversation has no guest address to reply to.');
    const latestGuest = recent.docs.find(m => m.data().direction === 'guest');
    if (!latestGuest) throw fail('failed-precondition', 'There is no guest message to reply to.');

    const t = now();
    tx.create(outRef, {
      bookingNumber: d.bookingNumber,
      text: clean.text,
      status: 'waiting',
      createdAt: t,
      expectedTo: c.replyTo.toLowerCase(),
      gmailMessageId: latestGuest.id,
      sentBy: user.email,
      sentByName: user.name,
    });
    tx.create(msgRef, {
      direction: 'host',
      text: clean.text,
      sentAt: t,
      status: 'waiting',
      outboxId: d.clientId,
      sentBy: user.email,
      sentByName: user.name,
      createdAt: t,
    });
    tx.update(convRef, {
      needsReply: false,
      done: true,
      doneAt: t,
      lastMessageAt: t,
      lastMessagePreview: ('You: ' + clean.text.replace(/\s+/g, ' ')).slice(0, 160),
      updatedAt: t,
    });
    return { ok: true, outboxId: d.clientId, duplicate: false };
  });
  if (!saved.duplicate && typeof deps.trigger === 'function') {
    try { await deps.trigger(); } catch (e) { console.warn('inboxSendReply: instant send not triggered', e && e.message); }
  }
  return saved;
}

// ---------------------------------------------------------------- owner: check-in request page

async function checkinLink(auth, data, deps) {
  if (!inboxUser(auth)) throw fail('permission-denied', 'Only people with inbox access can do this.');
  const bn = data && data.bookingNumber;
  if (!isBookingNumber(bn)) throw fail('invalid-argument', 'Bad booking number.');
  const snap = await deps.db.collection(RAW).where('conversationId', '==', bn).where('sortedAs', '==', 'checkin_request').get();
  const newest = snap.docs
    .map(x => x.data())
    .sort((a, b) => new Date(b.date) - new Date(a.date));
  for (const e of newest) {
    const url = checkinRequestLink(e);
    if (url) return { url };
  }
  return { url: null };
}

// ---------------------------------------------------------------- script: pull and report

function setHostStatus(tx, bookingNumber, id, db, fields) {
  tx.update(db.collection(CONVERSATIONS).doc(bookingNumber).collection('messages').doc(id), fields);
}

/** A reply that did not go through puts the conversation back on "Needs reply". */
function reopen(tx, bookingNumber, db, t) {
  tx.update(db.collection(CONVERSATIONS).doc(bookingNumber), { done: false, doneAt: null, needsReply: true, updatedAt: t });
}

async function markUnknown(id, deps) {
  const { db, now } = deps;
  const ref = db.collection(OUTBOX).doc(id);
  return db.runTransaction(async tx => {
    const s = await tx.get(ref);
    if (!s.exists) return false;
    const o = s.data();
    if (o.status !== 'sending') return false;
    if (millis(o.claimedAt) + STALE_SENDING_MS > millis(now())) return false;
    const t = now();
    tx.update(ref, { status: 'unknown', failReason: 'No report from the Gmail script. Check in Booking.com.', reportedAt: t });
    setHostStatus(tx, o.bookingNumber, id, db, { status: 'unknown', failReason: 'No report from the Gmail script. Check in Booking.com.' });
    reopen(tx, o.bookingNumber, db, t);
    return true;
  });
}

async function claim(id, deps) {
  const { db, now } = deps;
  const ref = db.collection(OUTBOX).doc(id);
  return db.runTransaction(async tx => {
    const s = await tx.get(ref);
    if (!s.exists || s.data().status !== 'waiting') return null;
    const o = s.data();
    const t = now();
    tx.update(ref, { status: 'sending', claimedAt: t });
    setHostStatus(tx, o.bookingNumber, id, db, { status: 'sending' });
    return { id, gmailMessageId: o.gmailMessageId, expectedTo: o.expectedTo, text: o.text };
  });
}

/** The script is alive: remember when it last called (read by inboxScriptWatch). A call from the web app does not count. */
async function noteHeartbeat(deps, source) {
  if (source === 'webapp') return;
  try {
    await deps.db.collection('inbox_meta').doc('script_heartbeat').set({ lastPullAt: deps.now(), source: String(source || 'trigger').slice(0, 20) }, { merge: true });
  } catch (e) {
    console.warn('inboxOutbox: heartbeat not saved', e && e.message);
  }
}

async function pull(deps, source) {
  const { db } = deps;
  await noteHeartbeat(deps, source);
  const stuck = await db.collection(OUTBOX).where('status', '==', 'sending').limit(20).get();
  let unknown = 0;
  for (const s of stuck.docs) if (await markUnknown(s.id, deps)) unknown++;

  const waiting = await db.collection(OUTBOX).where('status', '==', 'waiting').limit(20).get();
  const ids = waiting.docs
    .sort((a, b) => millis(a.data().createdAt) - millis(b.data().createdAt))
    .slice(0, MAX_PULL).map(x => x.id);
  const items = [];
  for (const id of ids) {
    const it = await claim(id, deps);
    if (it) items.push(it);
  }
  return { ok: true, items, markedUnknown: unknown };
}

async function report(body, deps) {
  const { db, now } = deps;
  const id = body && body.id;
  const result = body && body.result;
  if (!isClientId(id)) throw fail('invalid-argument', 'bad id');
  if (result !== 'sent' && result !== 'failed') throw fail('invalid-argument', 'bad result');
  const reason = String((body && body.reason) || '').slice(0, MAX_REASON);
  const ref = db.collection(OUTBOX).doc(id);
  return db.runTransaction(async tx => {
    const s = await tx.get(ref);
    if (!s.exists) throw fail('not-found', 'unknown outbox item');
    const o = s.data();
    if (o.status === result) return { ok: true, unchanged: true };
    // Only an item that was being sent (or went unknown) can get a result. A repeat report or a
    // report for a waiting item is ignored, so nothing is ever sent or re-marked by accident.
    if (o.status !== 'sending' && o.status !== 'unknown') return { ok: true, ignored: o.status };
    const t = now();
    if (result === 'sent') {
      tx.update(ref, { status: 'sent', reportedAt: t, failReason: null });
      setHostStatus(tx, o.bookingNumber, id, db, { status: 'sent', failReason: null });
    } else {
      tx.update(ref, { status: 'failed', reportedAt: t, failReason: reason || 'Sending failed.' });
      setHostStatus(tx, o.bookingNumber, id, db, { status: 'failed', failReason: reason || 'Sending failed.' });
      reopen(tx, o.bookingNumber, db, t);
    }
    return { ok: true };
  });
}

/** POSTs {key, action:'sendNow'} to the Gmail script web app. Gives up after a few seconds; the script keeps running. */
async function pokeWebApp(url, key, fetchImpl = fetch, timeoutMs = POKE_TIMEOUT_MS) {
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(url)) throw new Error('bad web app url');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ key, action: 'sendNow' }),
      redirect: 'follow',
      signal: ctl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
function bearerKey(req) {
  const m = String((req.get && req.get('authorization')) || '').match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : '';
}

/** deps: { getKey(), db, now() } */
async function handleOutbox(req, res, deps) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method' });
  const expected = deps.getKey();
  const given = bearerKey(req);
  if (!expected || !given || !safeEqual(given, expected)) return res.status(401).json({ ok: false, error: 'unauthorized' });
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  try {
    if (b.action === 'pull') return res.status(200).json(await pull(deps, b.source));
    if (b.action === 'report') return res.status(200).json(await report(b, deps));
    return res.status(400).json({ ok: false, error: 'bad action' });
  } catch (e) {
    if (e instanceof Fail) return res.status(e.code === 'not-found' ? 404 : 400).json({ ok: false, error: e.message });
    console.error('inboxOutbox failed', e && e.code, e && e.message);
    return res.status(500).json({ ok: false, error: 'failed' });
  }
}

// ---------------------------------------------------------------- Cloud Functions

function registerCloudFunctions() {
  const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
  const { defineSecret } = require('firebase-functions/params');
  const { getFirestore, Timestamp } = require('firebase-admin/firestore');
  const INBOX_INGEST_KEY = defineSecret('INBOX_INGEST_KEY');
  const INBOX_SCRIPT_URL = defineSecret('INBOX_SCRIPT_URL');
  const region = 'europe-west1';
  const deps = () => ({ db: getFirestore(), now: () => Timestamp.now() });
  const wrap = fn => async request => {
    try {
      return await fn(request.auth, request.data, deps());
    } catch (e) {
      if (e instanceof Fail) throw new HttpsError(e.code, e.message);
      console.error('inbox callable failed', e && e.code, e && e.message);
      throw new HttpsError('internal', 'Something went wrong. Try again.');
    }
  };

  // Pokes the Gmail script web app. Its URL is the Firebase secret INBOX_SCRIPT_URL (not in the repo).
  const triggerScript = () => pokeWebApp(INBOX_SCRIPT_URL.value().trim(), INBOX_INGEST_KEY.value());
  const inboxSendReply = onCall(
    { region, secrets: [INBOX_INGEST_KEY, INBOX_SCRIPT_URL], timeoutSeconds: 30, maxInstances: 5, memory: '256MiB' },
    wrap((auth, data, d) => sendReply(auth, data, { ...d, trigger: triggerScript }))
  );
  const inboxCheckinLink = onCall({ region, timeoutSeconds: 30, maxInstances: 5, memory: '256MiB' }, wrap(checkinLink));
  const inboxOutbox = onRequest(
    { region, secrets: [INBOX_INGEST_KEY], timeoutSeconds: 60, maxInstances: 2, memory: '256MiB' },
    (req, res) => handleOutbox(req, res, { getKey: () => INBOX_INGEST_KEY.value(), ...deps() })
  );
  return { inboxSendReply, inboxCheckinLink, inboxOutbox };
}

module.exports = {
  sendReply, pokeWebApp, noteHeartbeat, checkinLink, pull, report, handleOutbox, markUnknown, registerCloudFunctions, Fail,
  CONVERSATIONS, OUTBOX,
};
