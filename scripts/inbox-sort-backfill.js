#!/usr/bin/env node
'use strict';
/**
 * Sorts every inbox_raw_emails document that has no "sortedAs" yet (oldest email first).
 * Safe to run twice: sorted emails are skipped. Also the recovery tool if the Cloud Function
 * ever missed an email.
 *
 *   node scripts/inbox-sort-backfill.js          # sort and write
 *   node scripts/inbox-sort-backfill.js --dry    # only print counts, write nothing
 *
 * Needs admin access on this Mac (gcloud auth application-default login). Prints counts only,
 * never email contents.
 */
const path = require('path');
const { createRequire } = require('module');
const req = createRequire(path.join(__dirname, '..', 'pipeline-functions', 'package.json'));
const { initializeApp, getApps } = req('firebase-admin/app');
const { getFirestore, Timestamp } = req('firebase-admin/firestore');
const { processEmail } = require('../pipeline-functions/controllers/inboxSort');
const { sortEmail } = require('../pipeline-functions/lib/inboxSort');

const DRY = process.argv.includes('--dry');

async function main() {
  if (!getApps().length) initializeApp({ projectId: 'sleepy-5c962' });
  const db = getFirestore();
  const deps = { db, ts: iso => Timestamp.fromDate(new Date(iso)), now: () => Timestamp.now() };

  const snap = await db.collection('inbox_raw_emails').get();
  const todo = snap.docs
    .filter(d => !d.data().sortedAs)
    .sort((a, b) => new Date(a.data().date) - new Date(b.data().date));
  console.log(`raw emails: ${snap.size}, not sorted yet: ${todo.length}${DRY ? ' (dry run)' : ''}`);

  const counts = {};
  const reasons = {};
  let failed = 0;
  for (const d of todo) {
    try {
      const r = DRY ? sortEmail(d.data()) : await processEmail(d.id, deps);
      const k = r.skipped ? 'skipped' : r.kind;
      counts[k] = (counts[k] || 0) + 1;
      if (r.reason) reasons[r.reason] = (reasons[r.reason] || 0) + 1;
    } catch (e) {
      failed++;
      console.error('failed', d.id, e && e.code, e && e.message);
    }
  }
  console.log('sorted as:', counts);
  if (Object.keys(reasons).length) console.log('check-this reasons / hidden reasons:', reasons);
  if (failed) console.log('failed:', failed);
  if (!DRY) {
    const conv = await db.collection('inbox_conversations').get();
    let msgs = 0;
    for (const c of conv.docs) msgs += (await c.ref.collection('messages').get()).size;
    const rev = await db.collection('inbox_review').get();
    const withReq = conv.docs.filter(c => c.data().checkinRequest).length;
    const withCancel = conv.docs.filter(c => c.data().cancelRequest).length;
    const unmatched = conv.docs.filter(c => !c.data().reservationId).length;
    const cancelledRes = conv.docs.filter(c => c.data().reservationStatus === 'CANCELLED').length;
    console.log({
      conversations: conv.size, chatMessages: msgs, withCheckinRequest: withReq,
      withCancelAlert: withCancel, checkThisPile: rev.size, conversationsWithoutReservation: unmatched,
      conversationsOfCancelledReservations: cancelledRes,
    });
  }
}

main().then(() => process.exit(0), e => { console.error(e); process.exit(1); });
