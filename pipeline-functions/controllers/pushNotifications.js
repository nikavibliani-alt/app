'use strict';
/**
 * pushNotifications — Web Push to admin PWA devices (checkin-admin.html only,
 * never guests). See shared/push-config.js (client public key) and
 * checkin-admin.html's subscribeToPush()/saveSubscription() for the
 * subscribe-side flow that populates `push_subscriptions`.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Triggers (all region europe-west1, matching the rest of this codebase):
 *   1. search_failures/{id}      created        → "Failed Search"
 *   2. checkin_guests/{id}       guestConfirmedCheckout false→true → "Guest Checked Out"
 *   3. service_requests/{id}     created        → "New Request"
 *   4. hk_status/{id}            done false→true (or created already-done) → "Room Ready"
 *   5. hk_damage_reports/{id}    created        → "⚠ Damage: <room>" (tap opens /checkin-admin?tab=damage)
 *
 * Trigger 4 deliberately does NOT use onDocumentCreated the way the other
 * "something happened" triggers do. In practice, hk_status/{roomCode_date}
 * docs are created up front with done:false (see checkin-admin.html's
 * hkSaveAdminModal / the per-day pending-cleaning record), and later marked
 * done via setDoc(...,{merge:true}) on that SAME doc (toggleHkDone) — which
 * Firestore fires as an UPDATE, not a CREATE. onDocumentCreated + "was this
 * created already done" would silently miss the done transition in the
 * common case. onDocumentWritten + before/after diff catches both the
 * ordinary create-then-later-toggle path and the rarer case where a doc is
 * created already done in one write — same robust pattern already used
 * correctly below for Trigger 2's checkout transition.
 *
 * Owns: reads `push_subscriptions` (read + prune only — the collection
 * itself is owned/written by the client subscribe flow). Never writes to
 * search_failures / checkin_guests / service_requests / hk_status.
 * Error behavior: a single failed/expired push (410/404) removes that one
 * subscription and does not affect delivery to any other device; any other
 * per-device error is swallowed (logged) via Promise.allSettled so one bad
 * subscription can never block the rest.
 */

const { onDocumentCreated, onDocumentUpdated, onDocumentWritten } = require('firebase-functions/v2/firestore');
const { defineSecret } = require('firebase-functions/params');
const { getFirestore } = require('firebase-admin/firestore');

const VAPID_PUBLIC_KEY = defineSecret('VAPID_PUBLIC_KEY');
const VAPID_PRIVATE_KEY = defineSecret('VAPID_PRIVATE_KEY');
const REGION = 'europe-west1';

/** Notify only for today or earlier (Tbilisi, UTC+4); future-dated Done docs are skipped. */
function isHkDoneDateNotFuture(date, nowMs = Date.now()) {
  const d = String(date || '');
  if (!d) return true; // no date to judge — keep the old behaviour
  return d <= new Date(nowMs + 4 * 3600 * 1000).toISOString().slice(0, 10);
}

// push_log: one small doc per notable push event (a deleted subscription, a failed send, a test).
async function logPush(db, kind, subDoc, extra) {
  try {
    const d = (subDoc.data && subDoc.data()) || {};
    await db.collection('push_log').add({
      kind,
      deviceId: subDoc.id,
      userAgent: String(d.userAgent || '').slice(0, 100),
      createdAt: new Date().toISOString(),
      ...extra,
    });
  } catch (err) {
    console.warn('[pushNotifications] could not write push_log', err.message || err);
  }
}

// Helper — send to all subscribed devices
async function sendPushToAll(payload) {
  const webpush = require('web-push');
  webpush.setVapidDetails(
    'mailto:nikavibliani@gmail.com',
    VAPID_PUBLIC_KEY.value(),
    VAPID_PRIVATE_KEY.value()
  );

  const db = getFirestore();
  const subs = await db.collection('push_subscriptions').get();

  await Promise.allSettled(
    subs.docs.map(async (subDoc) => {
      const { subscription } = subDoc.data() || {};
      if (!subscription) return;
      try {
        await webpush.sendNotification(subscription, JSON.stringify(payload));
      } catch (e) {
        // Subscription expired or invalid — remove it
        if (e.statusCode === 404 || e.statusCode === 410) {
          // Log WHICH device is dropped and WHY before deleting (push_log keeps the evidence).
          console.warn('[pushNotifications] subscription deleted', subDoc.id, e.statusCode, payload && payload.title);
          await logPush(db, 'subscription_deleted', subDoc, { statusCode: e.statusCode, title: payload && payload.title });
          await subDoc.ref.delete();
        } else {
          await logPush(db, 'send_failed', subDoc, { statusCode: e.statusCode || null, message: String(e.message || '').slice(0, 200), title: payload && payload.title });
          console.warn('[pushNotifications] send failed', subDoc.id, e.statusCode || e.message);
        }
      }
    })
  );
}

function registerCloudFunctions() {
  const opts = { region: REGION, secrets: [VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY] };

  const pushOnFailedSearch = onDocumentCreated(
    { document: 'search_failures/{id}', ...opts },
    async (event) => {
      const data = event.data.data();
      await sendPushToAll({
        title: 'Failed Search',
        body: `Guest could not find booking: "${data.input_name}"`,
        tag: 'failed-search',
        url: '/checkin-admin?tab=failures',
      });
    }
  );

  const pushOnGuestCheckout = onDocumentUpdated(
    { document: 'checkin_guests/{id}', ...opts },
    async (event) => {
      const before = event.data.before.data();
      const after = event.data.after.data();
      if (!before.guestConfirmedCheckout && after.guestConfirmedCheckout) {
        const name = after.nameRoman || after.name || 'Guest';
        const room = after.aptId || '';
        await sendPushToAll({
          title: 'Guest Checked Out',
          body: `${name} — Room ${room} checked out`,
          tag: 'checkout-' + event.params.id,
          url: '/checkin-admin',
        });
      }
    }
  );

  const pushOnServiceRequest = onDocumentCreated(
    { document: 'service_requests/{id}', ...opts },
    async (event) => {
      const data = event.data.data();
      const type = data.serviceId || data.type || 'Request';
      const room = data.aptId || '';
      await sendPushToAll({
        title: 'New Request',
        body: `${type} — Room ${room}`,
        tag: 'request-' + event.params.id,
        url: '/checkin-admin?tab=requests',
      });
    }
  );

  const pushOnHkDone = onDocumentWritten(
    { document: 'hk_status/{id}', ...opts },
    async (event) => {
      const before = event.data.before?.exists ? event.data.before.data() : null;
      const after = event.data.after?.exists ? event.data.after.data() : null;
      if (!after) return; // deleted — nothing to notify
      const wasDone = !!before?.done;
      const isDone = after.done === true;
      // Emergency fix 2026-10-04: a Done on a future day (toggleHkDone also marks the next-arrival day) is not "ready now".
      if (!isHkDoneDateNotFuture(after.date || event.params.id.split('_')[1])) {
        console.log('pushOnHkDone skipped: future date', event.params.id);
        return;
      }
      if (!wasDone && isDone) {
        const roomCode = after.roomCode || event.params.id.split('_')[0];
        await sendPushToAll({
          title: 'Room Ready',
          body: `${roomCode} is clean and ready`,
          tag: 'hk-ready-' + roomCode,
          url: '/checkin-admin',
        });
      }
    }
  );

  const DAMAGE_LABELS = {
    cigarette: 'Cigarette smell', broken: 'Broken', stain: 'Stain', missing: 'Missing item',
    notworking: 'Not working', dirty: 'Dirty / smell', other: 'Other',
  };
  const pushOnDamageReport = onDocumentCreated(
    { document: 'hk_damage_reports/{id}', ...opts },
    async (event) => {
      const data = event.data.data();
      const cats = (data.categories || []).map((c) => DAMAGE_LABELS[c] || c).join(', ') || 'no tags';
      const n = Number(data.photoCount) || (data.photos || []).length || 0;
      await sendPushToAll({
        title: `${data.urgent ? 'URGENT · ' : ''}⚠ Damage: ${data.roomCode || ''}`,
        body: `${data.reportedBy?.name || 'Housekeeping'} · ${n} photo${n === 1 ? '' : 's'} · ${cats}`,
        tag: 'damage-' + event.params.id,
        url: '/checkin-admin?tab=damage',
      });
    }
  );

  // "Send test notification" in the admin More tab: the page writes push_test_requests/{id} {deviceId};
  // this sends one test push to that device only and writes the Apple/Google status back on the doc.
  const pushTestRequest = onDocumentCreated(
    { document: 'push_test_requests/{id}', ...opts },
    async (event) => {
      const ref = event.data.ref;
      const deviceId = String((event.data.data() || {}).deviceId || '');
      const done = (r) => ref.set({ ...r, doneAt: new Date().toISOString() }, { merge: true });
      if (!deviceId) { await done({ ok: false, message: 'no deviceId' }); return; }
      const db = getFirestore();
      const snap = await db.collection('push_subscriptions').doc(deviceId).get();
      if (!snap.exists) { await done({ ok: false, message: 'This phone has no saved subscription' }); return; }
      const webpush = require('web-push');
      webpush.setVapidDetails('mailto:nikavibliani@gmail.com', VAPID_PUBLIC_KEY.value(), VAPID_PRIVATE_KEY.value());
      try {
        const r = await webpush.sendNotification(snap.data().subscription, JSON.stringify({
          title: 'Test notification', body: 'This phone can receive Maxela notifications.', tag: 'test-' + deviceId.slice(0, 8), url: '/checkin-admin',
        }));
        await done({ ok: true, statusCode: r.statusCode });
      } catch (e) {
        // A test never deletes the subscription: the status is shown to the user instead.
        await logPush(db, 'test_failed', snap, { statusCode: e.statusCode || null, message: String(e.message || '').slice(0, 200) });
        await done({ ok: false, statusCode: e.statusCode || null, message: String(e.message || '').slice(0, 200) });
      }
    }
  );

  return { pushOnFailedSearch, pushOnGuestCheckout, pushOnServiceRequest, pushOnHkDone, pushOnDamageReport, pushTestRequest };
}

module.exports = { sendPushToAll, registerCloudFunctions, isHkDoneDateNotFuture };
