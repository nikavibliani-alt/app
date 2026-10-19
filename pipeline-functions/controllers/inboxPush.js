'use strict';
/**
 * Alerts for the Booking.com inbox (see docs/INBOX_PLAN.md). Uses the same Web Push setup and VAPID
 * keys as pushNotifications.js, but NOT its device list: that list (`push_subscriptions`) holds every
 * phone that ever unlocked the admin page with the shared password, and a guest's message must reach
 * only the owner. Guest alerts go to `inbox_push_devices` (server-only), and a device gets into it
 * only through the owner-only callable below, which needs the owner's verified Google sign-in.
 *
 *   inboxPushOnMessage       guest message -> one push per burst (none until 3 minutes pass without a guest message)
 *   inboxPushOnConversation  cancellation request -> a push with the deadline
 *   inboxAlerts              callable, owner only: register / unregister / status of this phone
 *
 * No push for hidden emails, check-in time requests, my own replies, or old messages. Switch:
 * globals/config.bookingAlertsEnabled (default on).
 */

const { isOwnerAuth } = require('../lib/inboxReply');
const P = require('../lib/inboxPush');

const CONVERSATIONS = 'inbox_conversations';
const DEVICES = 'inbox_push_devices';

class Fail extends Error { constructor(code, message) { super(message); this.code = code; } }
const ms = v => (v && typeof v.toMillis === 'function' ? v.toMillis() : v && typeof v.toDate === 'function' ? v.toDate().getTime() : v ? new Date(v).getTime() : NaN);

async function alertsEnabled(db) {
  const cfg = await db.collection('globals').doc('config').get();
  return !(cfg.exists && cfg.data().bookingAlertsEnabled === false);
}

/**
 * Sends to the owner's registered devices only. A device that answers 404/410 is removed.
 * deps: { db, sendNotification(subscription, jsonString) }.
 */
async function sendToOwnerDevices(payload, deps) {
  const { db, sendNotification } = deps;
  const snap = await db.collection(DEVICES).get();
  let sent = 0;
  let removed = 0;
  await Promise.allSettled(snap.docs.map(async d => {
    const { subscription } = d.data() || {};
    if (!subscription) return;
    try {
      await sendNotification(subscription, JSON.stringify(payload));
      sent++;
    } catch (e) {
      if (e && (e.statusCode === 404 || e.statusCode === 410)) { removed++; await d.ref.delete(); }
      else console.warn('inboxPush: send failed', d.id, e && (e.statusCode || e.message));
    }
  }));
  return { sent, removed, devices: snap.docs.length };
}

/** deps: { db, nowMs(), ts(ms), sendNotification }. */
async function onGuestMessage(bookingNumber, messageId, msg, deps) {
  const { db, nowMs, ts } = deps;
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
  const result = await sendToOwnerDevices(P.messagePayload(decision.conv, bookingNumber, msg.text), deps);
  return { action: 'pushed', ...result };
}

/** A cancellation request that is new or changed. */
async function onConversationWritten(bookingNumber, before, after, deps) {
  const { db, nowMs } = deps;
  const a = after && after.cancelRequest;
  if (!a) return { action: 'no cancel request' };
  const atMs = ms(a.at);
  const prevAt = before && before.cancelRequest ? ms(before.cancelRequest.at) : NaN;
  if (Number.isFinite(prevAt) && prevAt === atMs) return { action: 'unchanged' };
  const now = nowMs();
  if (Number.isFinite(atMs) && now - atMs > P.STALE_CANCEL_MS) return { action: 'stale' };
  if (!(await alertsEnabled(db))) return { action: 'alerts off' };
  const result = await sendToOwnerDevices(P.cancelPayload(after, bookingNumber, ms(a.deadline), now), deps);
  return { action: 'pushed', ...result };
}

/** register / unregister / status. deps: { db, now(), sendNotification }. */
async function alerts(auth, data, deps) {
  if (!isOwnerAuth(auth)) throw new Fail('permission-denied', 'Only the owner can do this.');
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
    await ref.set({ subscription: clean.subscription, userAgent: String(d.userAgent || '').slice(0, 100), registeredAt: deps.now(), owner: true });
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
    return { db: getFirestore(), nowMs: () => Date.now(), now: () => Timestamp.now(), ts: m => Timestamp.fromMillis(m), sendNotification: (sub, body) => webpush.sendNotification(sub, body) };
  };

  const inboxPushOnMessage = onDocumentCreated(
    { document: `${CONVERSATIONS}/{bookingNumber}/messages/{messageId}`, region, secrets, timeoutSeconds: 30, maxInstances: 5, memory: '256MiB' },
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
      if (!after || !after.cancelRequest) return;
      try { await onConversationWritten(event.params.bookingNumber, before, after, deps()); }
      catch (e) { console.error('inboxPushOnConversation failed', e && e.code, e && e.message); }
    }
  );
  const inboxAlerts = onCall({ region, secrets, timeoutSeconds: 30, maxInstances: 3, memory: '256MiB' }, async request => {
    try { return await alerts(request.auth, request.data, deps()); }
    catch (e) {
      if (e instanceof Fail) throw new HttpsError(e.code, e.message);
      console.error('inboxAlerts failed', e && e.code, e && e.message);
      throw new HttpsError('internal', 'Something went wrong. Try again.');
    }
  });
  return { inboxPushOnMessage, inboxPushOnConversation, inboxAlerts };
}

module.exports = { onGuestMessage, onConversationWritten, sendToOwnerDevices, alerts, registerCloudFunctions, alertsEnabled };
