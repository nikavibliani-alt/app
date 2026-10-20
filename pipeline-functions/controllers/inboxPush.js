'use strict';
/**
 * Alerts for the Booking.com inbox (see docs/INBOX_PLAN.md). Uses the same Web Push setup and VAPID
 * keys as pushNotifications.js.
 *
 * Who gets an alert: every device in `push_subscriptions` (the admin phones, like the other admin
 * alerts; the owner confirmed those are his and his team's) AND every device in `inbox_push_devices`
 * (phones registered from the inbox page through the owner-only callable below). A phone that is on
 * both lists gets ONE alert: devices are de-duplicated by their push address.
 *
 *   inboxPushOnMessage       guest message -> one push per burst (none until 3 minutes pass without a guest message)
 *   inboxPushOnConversation  cancellation request -> a push with the deadline
 *   inboxAlerts              callable, inbox users only: register / unregister / status of this phone
 *
 * No push for hidden emails, check-in time requests, my own replies, or old messages. Switch:
 * globals/config.bookingAlertsEnabled (default on).
 */

const { inboxUser } = require('../lib/inboxAccess');
const P = require('../lib/inboxPush');
const AI = require('../lib/inboxAi');

const CONVERSATIONS = 'inbox_conversations';
const DEVICES = 'inbox_push_devices';
const PRESENCE = 'inbox_presence';   // one document per conversation: { <person's name>: { at (ms), typing } }, written by the inbox page

class Fail extends Error { constructor(code, message) { super(message); this.code = code; } }
const ms = v => (v && typeof v.toMillis === 'function' ? v.toMillis() : v && typeof v.toDate === 'function' ? v.toDate().getTime() : v ? new Date(v).getTime() : NaN);

async function alertsEnabled(db) {
  const cfg = await db.collection('globals').doc('config').get();
  return !(cfg.exists && cfg.data().bookingAlertsEnabled === false);
}

const LISTS = ['push_subscriptions', DEVICES];

/**
 * Sends to every device in both lists, once per phone (de-duplicated by push address).
 * A device that answers 404/410 is removed from the list(s) it is on.
 * deps: { db, sendNotification(subscription, jsonString) }.
 */
async function sendToOwnerDevices(payload, deps) {
  const { db, sendNotification } = deps;
  const byEndpoint = new Map();
  for (const list of LISTS) {
    const snap = await db.collection(list).get();
    for (const d of snap.docs) {
      const { subscription } = d.data() || {};
      const endpoint = subscription && subscription.endpoint;
      if (!endpoint) continue;
      if (!byEndpoint.has(endpoint)) byEndpoint.set(endpoint, { subscription, docs: [] });
      byEndpoint.get(endpoint).docs.push(d);
    }
  }
  let sent = 0;
  let removed = 0;
  await Promise.allSettled([...byEndpoint.values()].map(async ({ subscription, docs }) => {
    try {
      await sendNotification(subscription, JSON.stringify(payload));
      sent++;
    } catch (e) {
      if (e && (e.statusCode === 404 || e.statusCode === 410)) { removed++; await Promise.all(docs.map(d => d.ref.delete())); }
      else console.warn('inboxPush: send failed', docs[0].id, e && (e.statusCode || e.message));
    }
  }));
  return { sent, removed, devices: byEndpoint.size };
}

/** deps: { db, nowMs(), ts(ms), sendNotification }. */
async function onGuestMessage(bookingNumber, messageId, msg, deps) {
  const { db, nowMs, ts } = deps;
  if (msg && msg.direction === 'host' && String(msg.sentBy || '').toLowerCase() === 'ai') return onAiAnswered(bookingNumber, msg, deps);
  if (!msg || msg.direction !== 'guest') return { action: 'ignored' };
  const now = nowMs();
  const sent = ms(msg.sentAt);
  if (Number.isFinite(sent) && now - sent > P.STALE_MESSAGE_MS) return { action: 'stale' };
  if (!(await alertsEnabled(db))) return { action: 'alerts off' };

  const convRef = db.collection(CONVERSATIONS).doc(bookingNumber);
  const decision = await db.runTransaction(async tx => {
    const c = await tx.get(convRef);
    if (!c.exists) return null;
    const v = c.data();
    const push = P.burstDecision(ms(v.pushLastGuestAt), now);
    tx.update(convRef, { pushLastGuestAt: ts(now) });   // every guest message restarts the 3 quiet minutes
    return { push, conv: v };
  });
  if (!decision) return { action: 'no conversation' };
  if (!decision.push) return { action: 'same burst' };
  // Two people, fewer duplicate alerts: wait a little; if one of us already replied or opened the chat meanwhile, no alert.
  if (typeof deps.sleep === 'function') {
    const startedAt = now;
    await deps.sleep(P.QUIET_BEFORE_ALERT_MS);
    const [after, presence] = await Promise.all([convRef.get(), db.collection(PRESENCE).doc(bookingNumber).get()]);
    const v = after.exists ? after.data() : null;
    if (v && (v.needsReply === false || v.done === true)) return { action: 'already handled' };
    if (presence.exists && Object.values(presence.data() || {}).some(p => p && Number(p.at) >= startedAt)) return { action: 'already opened' };
  }
  const result = await sendToOwnerDevices(P.messagePayload(decision.conv, bookingNumber, msg.text), deps);
  return { action: 'pushed', ...result };
}

/** The assistant sent a reply by itself: one alert per automatic send. */
async function onAiAnswered(bookingNumber, msg, deps) {
  const { db } = deps;
  if (msg && msg.holding) return { action: 'holding reply' };   // the "needs you" alert for that conversation is the one to send
  if (!(await alertsEnabled(db))) return { action: 'alerts off' };
  const convRef = db.collection(CONVERSATIONS).doc(bookingNumber);
  const c = await convRef.get();
  const conv = c.exists ? c.data() : {};
  // Safety net: after every automatic send, look for things the AI must never say. Always alerts, whatever the alert setting.
  const flags = AI.scanAiReply(msg.text);
  if (flags.length) {
    try { await convRef.update({ 'aiLastReply.flags': flags }); } catch (e) { console.warn('inboxPush: flag not saved', e && e.message); }
    const result = await sendToOwnerDevices(P.aiCheckPayload(conv, bookingNumber, flags), deps);
    return { action: 'pushed', kind: 'ai check', flags, ...result };
  }
  // "AI answer alerts": every answer (default) or only when it needs you (plus the evening summary).
  const cfg = await db.collection('globals').doc('config').get();
  if (cfg.exists && cfg.data().aiAlertMode === 'needs') return { action: 'ai alert skipped (needs-you mode)' };
  const result = await sendToOwnerDevices(P.aiAnsweredPayload(conv, bookingNumber, msg.text), deps);
  return { action: 'pushed', kind: 'ai answered', ...result };
}

const NEEDS_YOU_FRESH_MS = 10 * 60 * 1000;

/**
 * Things that happen on a conversation document and deserve an alert: a new or changed cancellation request,
 * and a new "Needs you" note from the assistant. Returns { action: 'none' } or { action: 'pushed', kinds }.
 */
async function onConversationWritten(bookingNumber, before, after, deps) {
  const { db, nowMs } = deps;
  if (!after) return { action: 'none' };
  const now = nowMs();
  const payloads = [];
  const kinds = [];

  const a = after.cancelRequest;
  if (a) {
    const atMs = ms(a.at);
    const prevAt = before && before.cancelRequest ? ms(before.cancelRequest.at) : NaN;
    const changed = !(Number.isFinite(prevAt) && prevAt === atMs);
    if (changed && !(Number.isFinite(atMs) && now - atMs > P.STALE_CANCEL_MS)) { payloads.push(P.cancelPayload(after, bookingNumber, ms(a.deadline), now)); kinds.push('cancel'); }
  }
  const dr = after.aiDraft;
  const needsMe = d => d && (d.kind === 'needs_you' || d.needsYouReason);          // a note, or a draft the host must still decide on
  if (needsMe(dr)) {
    const at = ms(dr.createdAt);
    const prevAt = before && needsMe(before.aiDraft) ? ms(before.aiDraft.createdAt) : NaN;
    if (!(Number.isFinite(prevAt) && prevAt === at) && !(Number.isFinite(at) && now - at > NEEDS_YOU_FRESH_MS)) {
      payloads.push(P.needsYouPayload(after, bookingNumber, dr.needsYouReason || dr.reason || dr.text)); kinds.push('needs you');
    }
  }
  const ch = after.checkinHandled;
  if (ch && (ch.outcome === 'sent' || ch.outcome === 'draft')) {
    const prevAt = before && before.checkinHandled ? Number(before.checkinHandled.atMs) : NaN;
    const processed = ms(ch.processedAt);
    if (!(Number.isFinite(prevAt) && prevAt === Number(ch.atMs) && before.checkinHandled.outcome === ch.outcome) && !(Number.isFinite(processed) && now - processed > NEEDS_YOU_FRESH_MS)) {
      payloads.push(P.checkinPayload(after, bookingNumber, ch)); kinds.push('check-in');
    }
  }
  if (!payloads.length) return { action: 'none' };
  if (!(await alertsEnabled(db))) return { action: 'alerts off' };
  let result = { sent: 0, removed: 0, devices: 0 };
  for (const p of payloads) result = await sendToOwnerDevices(p, deps);
  return { action: 'pushed', kinds, ...result };
}

/**
 * 21:00 Tbilisi, only when the alert setting is "only when it needs you": one alert with the day's numbers.
 * deps: { db, nowMs(), sendNotification }. Numbers only, no guest text.
 */
async function eveningSummary(deps) {
  const { db, nowMs } = deps;
  const cfg = await db.collection('globals').doc('config').get();
  if (!(cfg.exists && cfg.data().aiAlertMode === 'needs')) return { action: 'every-answer mode' };
  if (!(await alertsEnabled(db))) return { action: 'alerts off' };
  const start = AI.tbilisiDayStartMs(nowMs());
  const snap = await db.collection(CONVERSATIONS).get();
  let answered = 0; let needs = 0;
  for (const d of snap.docs) {
    const v = d.data();
    if (v.aiLastReply && AI.ms(v.aiLastReply.at) >= start) answered++;
    const dr = v.aiDraft;
    if (v.needsReply === true && dr && (dr.kind === 'needs_you' || dr.needsYouReason)) needs++;
  }
  if (!answered && !needs) return { action: 'nothing to report' };
  const result = await sendToOwnerDevices(P.aiSummaryPayload(answered, needs), deps);
  return { action: 'pushed', answered, needs, ...result };
}

/** register / unregister / status. deps: { db, now(), sendNotification }. */
async function alerts(auth, data, deps) {
  const user = inboxUser(auth);
  if (!user) throw new Fail('permission-denied', 'Only people with inbox access can do this.');
  const d = data || {};
  if (!P.isDeviceId(d.deviceId)) throw new Fail('invalid-argument', 'Bad device id.');
  const ref = deps.db.collection(DEVICES).doc(d.deviceId);
  if (d.action === 'status') {
    const s = await ref.get();
    return { registered: s.exists };
  }
  if (d.action === 'unregister') {
    const s = await ref.get();
    if (s.exists) await ref.delete();
    return { registered: false };
  }
  if (d.action === 'register') {
    const clean = P.cleanSubscription(d.subscription);
    if (!clean.ok) throw new Fail('invalid-argument', clean.error);
    await ref.set({ subscription: clean.subscription, userAgent: String(d.userAgent || '').slice(0, 100), registeredAt: deps.now(), email: user.email, name: user.name });
    // A short test, so the owner sees at once that this phone works. It holds no guest text.
    try {
      await deps.sendNotification(clean.subscription, JSON.stringify({ title: 'Booking.com alerts are on', body: 'This phone gets an alert when a guest writes.', tag: 'inbox-test', url: '/inbox' }));
    } catch (e) {
      throw new Fail('failed-precondition', 'The phone was saved but the test alert failed (' + ((e && (e.statusCode || e.message)) || 'unknown') + '). Allow notifications for the Maxela app and try again.');
    }
    return { registered: true };
  }
  throw new Fail('invalid-argument', 'Bad action.');
}

function registerCloudFunctions() {
  const { onDocumentCreated, onDocumentWritten } = require('firebase-functions/v2/firestore');
  const { onCall, HttpsError } = require('firebase-functions/v2/https');
  const { defineSecret } = require('firebase-functions/params');
  const { getFirestore, Timestamp } = require('firebase-admin/firestore');
  const VAPID_PUBLIC_KEY = defineSecret('VAPID_PUBLIC_KEY');
  const VAPID_PRIVATE_KEY = defineSecret('VAPID_PRIVATE_KEY');
  const region = 'europe-west1';
  const secrets = [VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY];
  const deps = () => {
    const webpush = require('web-push');
    webpush.setVapidDetails('mailto:nikavibliani@gmail.com', VAPID_PUBLIC_KEY.value(), VAPID_PRIVATE_KEY.value());
    return { db: getFirestore(), nowMs: () => Date.now(), now: () => Timestamp.now(), ts: m => Timestamp.fromMillis(m), sendNotification: (sub, body) => webpush.sendNotification(sub, body), sleep: ms => new Promise(r => setTimeout(r, ms)) };
  };

  const inboxPushOnMessage = onDocumentCreated(
    { document: `${CONVERSATIONS}/{bookingNumber}/messages/{messageId}`, region, secrets, timeoutSeconds: 60, maxInstances: 5, memory: '256MiB' },
    async event => {
      try { await onGuestMessage(event.params.bookingNumber, event.params.messageId, event.data && event.data.data(), deps()); }
      catch (e) { console.error('inboxPushOnMessage failed', e && e.code, e && e.message); }
    }
  );
  const inboxPushOnConversation = onDocumentWritten(
    { document: `${CONVERSATIONS}/{bookingNumber}`, region, secrets, timeoutSeconds: 30, maxInstances: 3, memory: '256MiB' },
    async event => {
      const before = event.data && event.data.before && event.data.before.exists ? event.data.before.data() : null;
      const after = event.data && event.data.after && event.data.after.exists ? event.data.after.data() : null;
      if (!after) return;
      try { await onConversationWritten(event.params.bookingNumber, before, after, deps()); }
      catch (e) { console.error('inboxPushOnConversation failed', e && e.code, e && e.message); }
    }
  );
  const { onSchedule } = require('firebase-functions/v2/scheduler');
  const inboxAiEveningSummary = onSchedule(
    { schedule: '0 21 * * *', timeZone: 'Asia/Tbilisi', region, secrets, timeoutSeconds: 60, memory: '256MiB', maxInstances: 1 },
    async () => { try { await eveningSummary(deps()); } catch (e) { console.error('inboxAiEveningSummary failed', e && e.message); } }
  );
  const inboxAlerts = onCall({ region, secrets, timeoutSeconds: 30, maxInstances: 3, memory: '256MiB' }, async request => {
    try { return await alerts(request.auth, request.data, deps()); }
    catch (e) {
      if (e instanceof Fail) throw new HttpsError(e.code, e.message);
      console.error('inboxAlerts failed', e && e.code, e && e.message);
      throw new HttpsError('internal', 'Something went wrong. Try again.');
    }
  });
  return { inboxPushOnMessage, inboxPushOnConversation, inboxAlerts, inboxAiEveningSummary };
}

module.exports = { eveningSummary, onGuestMessage, onAiAnswered, onConversationWritten, sendToOwnerDevices, alerts, registerCloudFunctions, alertsEnabled };
