'use strict';
/**
 * Tells me when the Gmail script stops, or when no Booking.com email has been saved for 12 hours (see docs/INBOX_PLAN.md).
 *
 * The script calls inboxOutbox about every 5 minutes (the "pull" in controllers/inboxReply.js), and the
 * server notes the time in inbox_meta/script_heartbeat. inboxScriptWatch runs every minute:
 *   no call for 15 minutes -> one push to all phones: "Booking.com Gmail script has stopped"
 *   still stopped          -> the same, again every 3 hours
 *   calls are back         -> "Booking.com Gmail script is back"
 * Goes to the same phones as the guest alerts (push_subscriptions and inbox_push_devices, once per
 * phone). It is a health alert, so it is NOT stopped by the "Booking.com message alerts" switch.
 */

const { decideScriptAlert, scriptAlertPayload, decideEmailAlert, emailAlertPayload } = require('../lib/inboxScriptWatch');
const { sendToOwnerDevices } = require('./inboxPush');

const HEARTBEAT = ['inbox_meta', 'script_heartbeat'];
const STATE = ['inbox_meta', 'script_watch'];
const EMAIL_STATE = ['inbox_meta', 'email_watch'];
const ms = v => (v && typeof v.toMillis === 'function' ? v.toMillis() : v && typeof v.toDate === 'function' ? v.toDate().getTime() : v ? new Date(v).getTime() : NaN);

/** deps: { db, nowMs(), ts(ms), sendNotification }. Returns { action, ... }. */
async function checkScript(deps) {
  const { db, nowMs, ts } = deps;
  const [hb, st] = await Promise.all([db.collection(HEARTBEAT[0]).doc(HEARTBEAT[1]).get(), db.collection(STATE[0]).doc(STATE[1]).get()]);
  const lastPullMs = hb.exists ? ms(hb.data().lastPullAt) : NaN;
  const state = st.exists ? { down: !!st.data().down, alertedAtMs: ms(st.data().alertedAt) } : { down: false, alertedAtMs: 0 };
  const now = nowMs();
  const { action } = decideScriptAlert({ nowMs: now, lastPullMs, state });
  if (action === 'none') return { action };
  const result = await sendToOwnerDevices(scriptAlertPayload(action, lastPullMs, now), deps);
  await db.collection(STATE[0]).doc(STATE[1]).set({ down: action !== 'back', alertedAt: ts(now), lastPullAt: ts(lastPullMs) }, { merge: true });
  return { action, ...result };
}

/**
 * No new Booking.com email saved for 12 hours: one push to all phones (then every 6 hours, and a message
 * when emails are saved again). Catches a script that runs but cannot read Gmail. deps as checkScript.
 */
async function checkEmails(deps) {
  const { db, nowMs, ts } = deps;
  const newest = await db.collection('inbox_raw_emails').orderBy('receivedAt', 'desc').limit(1).get();
  const newestMs = newest.docs.length ? ms(newest.docs[0].data().receivedAt) : NaN;
  const st = await db.collection(EMAIL_STATE[0]).doc(EMAIL_STATE[1]).get();
  const state = st.exists ? { down: !!st.data().down, alertedAtMs: ms(st.data().alertedAt) } : { down: false, alertedAtMs: 0 };
  const now = nowMs();
  const { action } = decideEmailAlert({ nowMs: now, newestMs, state });
  if (action === 'none') return { action };
  const result = await sendToOwnerDevices(emailAlertPayload(action, newestMs), deps);
  await db.collection(EMAIL_STATE[0]).doc(EMAIL_STATE[1]).set({ down: action !== 'back', alertedAt: ts(now), newestAt: ts(newestMs) }, { merge: true });
  return { action, ...result };
}

function registerCloudFunctions() {
  const { onSchedule } = require('firebase-functions/v2/scheduler');
  const { defineSecret } = require('firebase-functions/params');
  const { getFirestore, Timestamp } = require('firebase-admin/firestore');
  const VAPID_PUBLIC_KEY = defineSecret('VAPID_PUBLIC_KEY');
  const VAPID_PRIVATE_KEY = defineSecret('VAPID_PRIVATE_KEY');
  const inboxScriptWatch = onSchedule(
    { schedule: 'every 1 minutes', region: 'europe-west1', secrets: [VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY], timeoutSeconds: 60, memory: '256MiB', maxInstances: 1 },
    async () => {
      const webpush = require('web-push');
      webpush.setVapidDetails('mailto:nikavibliani@gmail.com', VAPID_PUBLIC_KEY.value(), VAPID_PRIVATE_KEY.value());
      const deps = { db: getFirestore(), nowMs: () => Date.now(), ts: m => Timestamp.fromMillis(m), sendNotification: (sub, body) => webpush.sendNotification(sub, body) };
      for (const [name, check] of [['script', checkScript], ['emails', checkEmails]]) {
        try {
          const r = await check(deps);
          if (r.action !== 'none') console.log(JSON.stringify({ evt: 'inboxScriptWatch', check: name, ...r }));
        } catch (e) {
          console.error('inboxScriptWatch failed', name, e && e.code, e && e.message);
        }
      }
    }
  );
  return { inboxScriptWatch };
}

module.exports = { checkScript, checkEmails, registerCloudFunctions, HEARTBEAT, STATE };
