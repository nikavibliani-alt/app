'use strict';
/**
 * "Other Booking.com emails" (inbox_review): the "Handled" button. Browsers cannot write inbox_* (server-only
 * rules), so marking one handled goes through this callable (inbox users only, lib/inboxAccess.js).
 */

const { inboxUser } = require('../lib/inboxAccess');

class Fail extends Error { constructor(code, message) { super(message); this.code = code; } }
const ID_RE = /^[A-Za-z0-9_-]{6,128}$/;

/** deps: { db, now() }. */
async function markHandled(auth, data, deps) {
  const user = inboxUser(auth);
  if (!user) throw new Fail('permission-denied', 'Only people with inbox access can do this.');
  const id = data && data.id;
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new Fail('invalid-argument', 'Bad id.');
  const ref = deps.db.collection('inbox_review').doc(id);
  await deps.db.runTransaction(async tx => {
    const s = await tx.get(ref);
    if (!s.exists) throw new Fail('not-found', 'Item not found.');
    tx.update(ref, { resolved: true, resolvedAt: deps.now(), resolvedBy: user.email });
  });
  return { ok: true };
}

function registerCloudFunctions() {
  const { onCall, HttpsError } = require('firebase-functions/v2/https');
  const { getFirestore, Timestamp } = require('firebase-admin/firestore');
  const inboxReviewHandled = onCall({ region: 'europe-west1', timeoutSeconds: 30, maxInstances: 3, memory: '256MiB' }, async request => {
    try {
      return await markHandled(request.auth, request.data, { db: getFirestore(), now: () => Timestamp.now() });
    } catch (e) {
      if (e instanceof Fail) throw new HttpsError(e.code, e.message);
      console.error('inboxReviewHandled failed', e && e.code, e && e.message);
      throw new HttpsError('internal', 'Something went wrong. Try again.');
    }
  });
  return { inboxReviewHandled };
}

module.exports = { markHandled, registerCloudFunctions };
