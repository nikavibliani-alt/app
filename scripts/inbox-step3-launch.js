#!/usr/bin/env node
'use strict';
/**
 * One-time launch step for the inbox screen (step 3). Safe to run twice.
 *
 *  1. Fills in two fields on conversations made before step 3: lastMessagePreview (from the
 *     newest chat message) and hotelId (from the saved raw email, for the Open in Booking.com
 *     button). Only fills what is missing.
 *  2. Marks every conversation that existed at launch as done, so the "Needs reply" list starts
 *     empty. The launch time is saved once in inbox_meta/step3_launch; a second run only touches
 *     conversations whose last guest message is older than that time, so a real new message is
 *     never marked done by a re-run.
 *
 *   node scripts/inbox-step3-launch.js          # write
 *   node scripts/inbox-step3-launch.js --dry    # print counts only
 *
 * Needs admin access on this Mac (gcloud auth application-default login). Counts only, no text.
 */
const path = require('path');
const { createRequire } = require('module');
const req = createRequire(path.join(__dirname, '..', 'pipeline-functions', 'package.json'));
const { initializeApp, getApps } = req('firebase-admin/app');
const { getFirestore, Timestamp } = req('firebase-admin/firestore');
const { sortEmail } = require('../pipeline-functions/lib/inboxSort');

const DRY = process.argv.includes('--dry');
const ms = v => (v && v.toDate ? v.toDate().getTime() : v ? new Date(v).getTime() : 0);

async function main() {
  if (!getApps().length) initializeApp({ projectId: 'sleepy-5c962' });
  const db = getFirestore();

  const metaRef = db.collection('inbox_meta').doc('step3_launch');
  const meta = await metaRef.get();
  const launchAt = meta.exists ? meta.data().launchAt : Timestamp.now();
  console.log(meta.exists ? 'launch time already saved: re-run, only older conversations are touched' : 'first run: saving the launch time now');

  const raw = await db.collection('inbox_raw_emails').get();
  const hotelByBooking = {};
  for (const d of raw.docs) {
    const e = d.data();
    if (!e.conversationId || hotelByBooking[e.conversationId]) continue;
    const r = sortEmail(e);
    if (r.hotelId) hotelByBooking[e.conversationId] = r.hotelId;
  }

  const convs = await db.collection('inbox_conversations').get();
  const n = { conversations: convs.size, previewFilled: 0, hotelIdFilled: 0, markedDone: 0, alreadyDone: 0, newerThanLaunchLeftAlone: 0, noHotelId: 0 };
  for (const c of convs.docs) {
    const v = c.data();
    const upd = {};

    if (!v.lastMessagePreview && (v.messageCount || 0) > 0) {
      const last = await c.ref.collection('messages').orderBy('sentAt', 'desc').limit(1).get();
      if (!last.empty) {
        upd.lastMessagePreview = String(last.docs[0].data().text || '').replace(/\s+/g, ' ').trim().slice(0, 160);
        n.previewFilled++;
      }
    }
    if (!v.hotelId) {
      if (hotelByBooking[c.id]) { upd.hotelId = hotelByBooking[c.id]; n.hotelIdFilled++; } else n.noHotelId++;
    }

    const newest = Math.max(ms(v.lastGuestMessageAt), ms(v.cancelRequest && v.cancelRequest.at));
    if (v.done === true) n.alreadyDone++;
    else if (newest <= ms(launchAt)) { upd.done = true; upd.doneAt = Timestamp.now(); n.markedDone++; }
    else n.newerThanLaunchLeftAlone++;

    if (!DRY && Object.keys(upd).length) await c.ref.update(upd);
  }
  if (!DRY && !meta.exists) await metaRef.set({ launchAt, note: 'inbox screen launch: older conversations were marked done' });
  console.log(DRY ? '(dry run, nothing written)' : 'written', n);
}

main().then(() => process.exit(0), e => { console.error(e); process.exit(1); });
