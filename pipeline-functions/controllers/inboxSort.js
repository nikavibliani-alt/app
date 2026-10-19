'use strict';
/**
 * inboxSort: step 2 of the Booking.com guest inbox (see docs/INBOX_PLAN.md).
 *
 * Runs when a new document appears in inbox_raw_emails (and from the one-time/recovery script
 * scripts/inbox-sort-backfill.js). The rules live in lib/inboxSort.js; this file only reads and
 * writes Firestore.
 *
 *   inbox_raw_emails/{id}        gets sortedAs / sortedAt (+ sortedReason, conversationId). Set
 *                                in the same transaction as the other writes, so an email is
 *                                never processed twice and never half-processed.
 *   inbox_conversations/{booking number}            one per reservation
 *   inbox_conversations/{booking number}/messages/{id}   guest chat messages
 *   inbox_review/{id}            the "check this" pile
 *
 * No replies, no AI, no notifications here.
 */

const { sortEmail } = require('../lib/inboxSort');

const RAW = 'inbox_raw_emails';
const CONVERSATIONS = 'inbox_conversations';
const REVIEW = 'inbox_review';
const CHANNEL = 'booking';
const ACCOUNT = 'maxela';

const ms = v => (v ? new Date(v).getTime() : 0);

/** Pick the right reservation doc when a bookingId has more than one. */
function pickReservation(docs, checkin) {
  if (!docs.length) return null;
  const upd = d => ms(d.data().updatedAt && d.data().updatedAt.toDate ? d.data().updatedAt.toDate() : d.data().updatedAt);
  const score = d => {
    const r = d.data();
    return (checkin && r.checkin === checkin ? 4 : 0) + (r.status !== 'CANCELLED' ? 2 : 0);
  };
  return [...docs].sort((a, b) => score(b) - score(a) || upd(b) - upd(a))[0];
}

/** Reads must all happen before writes inside a transaction. */
async function findReservation(tx, db, bookingNumber, checkin) {
  const col = db.collection('reservations');
  let docs = (await tx.get(col.where('bookingId', '==', bookingNumber))).docs;
  if (!docs.length && /^\d+$/.test(bookingNumber)) {
    docs = (await tx.get(col.where('bookingId', '==', Number(bookingNumber)))).docs;
  }
  return pickReservation(docs, checkin);
}

function reservationFields(resDoc, sorted) {
  if (!resDoc) {
    return {
      reservationId: null,
      reservationStatus: null,
      guestName: sorted.guestName || null,
      propertyName: sorted.propertyName || null,
      roomCode: null,
      checkin: sorted.checkin || null,
      checkout: sorted.checkout || null,
    };
  }
  const r = resDoc.data();
  const name = [r.firstName, r.lastName].filter(Boolean).join(' ').trim();
  return {
    reservationId: resDoc.id,
    reservationStatus: r.status || null,
    guestName: sorted.guestName || name || (typeof r.guest === 'string' ? r.guest : null),
    propertyName: sorted.propertyName || null,
    roomCode: r.roomCode || null,
    checkin: r.checkin || sorted.checkin || null,
    checkout: r.checkout || sorted.checkout || null,
  };
}

/**
 * Sort one raw email and write the result. Safe to call twice for the same email.
 * deps: { db, ts(iso) -> Timestamp-like, now() -> Timestamp-like }
 * Returns { skipped: true } or { kind, reason?, conversationId? }.
 */
async function processEmail(emailId, deps) {
  const { db, ts, now } = deps;
  const rawRef = db.collection(RAW).doc(emailId);

  return db.runTransaction(async tx => {
    const rawSnap = await tx.get(rawRef);
    if (!rawSnap.exists) return { skipped: true, why: 'missing' };
    const raw = rawSnap.data();
    if (raw.sortedAs) return { skipped: true, why: 'already sorted' };

    let sorted;
    try {
      sorted = sortEmail(raw);
    } catch (e) {
      sorted = { kind: 'review', reason: 'sorting failed: ' + String((e && e.message) || e).slice(0, 120) };
    }

    const mark = (extra = {}) => ({ sortedAs: sorted.kind, sortedAt: now(), ...extra });

    if (sorted.kind === 'hidden') {
      tx.update(rawRef, mark({ sortedReason: sorted.reason }));
      return { kind: 'hidden', reason: sorted.reason };
    }
    if (sorted.kind === 'review') {
      tx.set(db.collection(REVIEW).doc(emailId), {
        gmailMessageId: emailId,
        reason: sorted.reason,
        from: raw.from || '',
        subject: raw.subject || '',
        date: raw.date || '',
        createdAt: now(),
        resolved: false,
      });
      tx.update(rawRef, mark({ sortedReason: sorted.reason }));
      return { kind: 'review', reason: sorted.reason };
    }

    // chat, checkin_request, auto_confirmed, cancel_request: all belong to a conversation.
    const convRef = db.collection(CONVERSATIONS).doc(sorted.bookingNumber);
    const convSnap = await tx.get(convRef);
    const prev = convSnap.exists ? convSnap.data() : null;
    const resDoc = await findReservation(tx, db, sorted.bookingNumber, sorted.checkin);

    const conv = {
      channel: CHANNEL,
      account: ACCOUNT,
      bookingNumber: sorted.bookingNumber,
      ...reservationFields(resDoc, sorted),
      updatedAt: now(),
    };
    // The no-reply address of Booking.com's own notices is not a way to answer the guest.
    if (sorted.kind !== 'auto_confirmed' && sorted.replyTo) conv.replyTo = sorted.replyTo;
    if (!prev) {
      Object.assign(conv, {
        createdAt: now(), done: false, needsReply: false, messageCount: 0,
        lastGuestMessageAt: null, lastMessageAt: null, replyTo: conv.replyTo || null,
      });
    }

    if (sorted.kind === 'chat') {
      const newer = !prev || !prev.lastGuestMessageAt || ms(sorted.sentAt) >= ms(prev.lastGuestMessageAt.toDate ? prev.lastGuestMessageAt.toDate() : prev.lastGuestMessageAt);
      conv.messageCount = ((prev && prev.messageCount) || 0) + 1;
      if (newer) {
        conv.lastGuestMessageAt = ts(sorted.sentAt);
        conv.lastMessageAt = ts(sorted.sentAt);
        conv.needsReply = true;
        conv.done = false;
      }
      tx.set(convRef.collection('messages').doc(emailId), {
        direction: 'guest',
        text: sorted.text,
        sentAt: ts(sorted.sentAt),
        bookingMessageId: sorted.messageId || null,
        gmailMessageId: emailId,
        script: sorted.script,
        createdAt: now(),
      });
    } else if (sorted.kind === 'checkin_request' || sorted.kind === 'auto_confirmed') {
      const old = (prev && prev.checkinRequest) || {};
      conv.checkinRequest = {
        time: sorted.requestedTime || old.time || null,
        autoConfirmed: sorted.kind === 'auto_confirmed' ? true : !!old.autoConfirmed,
        at: ts(sorted.sentAt),
      };
    } else if (sorted.kind === 'cancel_request') {
      conv.cancelRequest = { at: ts(sorted.sentAt), deadline: ts(sorted.deadline) };
    }

    tx.set(convRef, conv, { merge: true });
    tx.update(rawRef, mark({ conversationId: sorted.bookingNumber }));
    return { kind: sorted.kind, conversationId: sorted.bookingNumber, matched: !!resDoc };
  });
}

function registerCloudFunction() {
  const { onDocumentCreated } = require('firebase-functions/v2/firestore');
  const { getFirestore, Timestamp } = require('firebase-admin/firestore');

  return onDocumentCreated(
    { document: `${RAW}/{emailId}`, region: 'europe-west1', timeoutSeconds: 60, maxInstances: 5, memory: '256MiB' },
    async event => {
      const emailId = event.params.emailId;
      try {
        const r = await processEmail(emailId, {
          db: getFirestore(),
          ts: iso => Timestamp.fromDate(new Date(iso)),
          now: () => Timestamp.now(),
        });
        console.log('inboxSort', emailId, r.kind || r.why, r.reason || '');
      } catch (e) {
        // Left unsorted on purpose: scripts/inbox-sort-backfill.js picks it up on the next run.
        console.error('inboxSort failed', emailId, e && e.code, e && e.message);
      }
    }
  );
}

module.exports = { processEmail, registerCloudFunction, pickReservation, RAW, CONVERSATIONS, REVIEW };
