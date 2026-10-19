'use strict';
/**
 * Keeps globals/inboxStats = { needsReply, cancelRequests, updatedAt } up to date for the admin main
 * screen. The admin page has no Google sign-in and cannot read inbox_* (server-only), so it reads this
 * one small document instead. It holds two numbers and no guest text.
 *
 *   inboxStatsOnWrite  Firestore trigger: a conversation changed
 *   refreshInboxStats  also called every minute by inboxAiRun, so a missed or out-of-order trigger heals
 */

const { computeInboxStats, statsRelevantChange } = require('../lib/inboxStats');

const STATS_PATH = ['globals', 'inboxStats'];

/** deps: { db, now() }. Writes only when a number changed. */
async function refreshInboxStats(deps) {
  const { db, now } = deps;
  const snap = await db.collection('inbox_conversations').where('done', '==', false).get();
  const stats = computeInboxStats(snap.docs.map(d => d.data()));
  const ref = db.collection(STATS_PATH[0]).doc(STATS_PATH[1]);
  const cur = await ref.get();
  const old = cur.exists ? cur.data() : null;
  if (old && old.needsReply === stats.needsReply && old.cancelRequests === stats.cancelRequests) return { ...stats, changed: false };
  await ref.set({ ...stats, updatedAt: now() }, { merge: true });
  return { ...stats, changed: true };
}

function registerCloudFunctions() {
  const { onDocumentWritten } = require('firebase-functions/v2/firestore');
  const { getFirestore, Timestamp } = require('firebase-admin/firestore');
  const inboxStatsOnWrite = onDocumentWritten(
    { document: 'inbox_conversations/{bookingNumber}', region: 'europe-west1', timeoutSeconds: 30, maxInstances: 3, memory: '256MiB' },
    async event => {
      const before = event.data && event.data.before && event.data.before.exists ? event.data.before.data() : null;
      const after = event.data && event.data.after && event.data.after.exists ? event.data.after.data() : null;
      if (!statsRelevantChange(before, after)) return;
      try {
        await refreshInboxStats({ db: getFirestore(), now: () => Timestamp.now() });
      } catch (e) {
        console.error('inboxStatsOnWrite failed', e && e.code, e && e.message);
      }
    }
  );
  return { inboxStatsOnWrite };
}

module.exports = { refreshInboxStats, registerCloudFunctions };
