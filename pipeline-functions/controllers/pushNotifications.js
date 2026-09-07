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
          await subDoc.ref.delete();
        } else {
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
        url: '/checkin-admin',
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
        url: '/checkin-admin',
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

  return { pushOnFailedSearch, pushOnGuestCheckout, pushOnServiceRequest, pushOnHkDone };
}

module.exports = { sendPushToAll, registerCloudFunctions };
