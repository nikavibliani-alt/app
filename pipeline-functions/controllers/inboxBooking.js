'use strict';
/**
 * Connecting the inbox chat to the rest of the admin (Step 6 of docs/INBOX_IMPROVEMENT_PLAN.md). Inbox users only.
 * Everything is READ ONLY except creating one request. The server (admin SDK) reads, so no Firestore rules are involved.
 *
 *   inboxBookingPanel   the facts about this booking: dates, room, guests, status, check-in form filled or not,
 *                       door access (the flags the guest unlock logic already stored), today's cleaning of the room,
 *                       earlier stays with the same name, and requests already made from this chat.
 *   inboxRequestCreate  "+ Request" on a guest message: one item in service_requests (the Requests list), made the way the
 *                       guest page makes one. The same message never makes two.
 *
 * Where each fact lives:
 *   reservation       reservations/{conversation.reservationId}  (checkin, checkout, roomCode, status, adults, children, guestCount)
 *   check-in form     checkin_guests where matchedReservationId starts with the reservation number (submittedAt = filled)
 *   door access       the same form: unlockState / unlockReason / manualUnlock, written by the guest unlock function (read only here)
 *   cleaning          hk_status/{roomCode}_{date}  (done)
 *   earlier stays     reservations with the same guest name
 *   requests          service_requests with source "booking_inbox" and this booking number
 */

const { inboxUser } = require('../lib/inboxAccess');
const { isBookingNumber } = require('../lib/inboxReply');

const CONVERSATIONS = 'inbox_conversations';
const TBILISI_OFFSET_MS = 4 * 60 * 60 * 1000;

class Fail extends Error { constructor(code, message) { super(message); this.code = code; } }
const ms = v => (v && typeof v.toMillis === 'function' ? v.toMillis() : v && typeof v.toDate === 'function' ? v.toDate().getTime() : v ? new Date(v).getTime() : 0);
const tbilisiDay = nowMs => new Date(nowMs + TBILISI_OFFSET_MS).toISOString().slice(0, 10);
const nightsBetween = (a, b) => (a && b ? Math.max(0, Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5)) : null);

const ACCESS_WORDS = {
  mid_stay: 'The guest is staying: door access is on.',
  manual_unlock: 'Door access was switched on by hand.',
  check_in_hour: 'Door access is on (check-in time has come).',
  hk_early: 'Door access is on early (the room is ready).',
  before_arrival: 'Door access is not on yet: the guest arrives later.',
  hk_ready_wait_11: 'Door access is not on yet: waiting for the room to be ready.',
  no_arrival: 'Door access is not on yet.',
  cancelled: 'Door access is off: the booking is cancelled.',
  stay_ended: 'Door access is off: the stay has ended.',
  blocked: 'Door access is blocked.',
  admin_disabled_until: 'Door access was switched off for a while.',
  admin_disabled_indefinite: 'Door access was switched off.',
};

async function safe(label, notes, fn, fallback) {
  try { return await fn(); } catch (e) { notes.push(`${label}: not available (${(e && e.message) || 'error'})`); return fallback; }
}

/** The reservation behind a conversation, or null. */
async function loadReservation(db, conv, bookingNumber) {
  if (conv.reservationId) {
    const s = await db.collection('reservations').doc(String(conv.reservationId)).get();
    if (s.exists) return { id: s.id, ...s.data() };
  }
  const q = await db.collection('reservations').where('bookingId', '==', bookingNumber).limit(5).get();
  const docs = q.docs.map(d => ({ id: d.id, ...d.data() }));
  return docs.find(d => String(d.status || '').toUpperCase() !== 'CANCELLED') || docs[0] || null;
}

async function loadForm(db, res) {
  const rn = String(res.reservationNumber || '').trim();
  if (!rn) return null;
  const snap = await db.collection('checkin_guests').where('matchedReservationId', '>=', rn).where('matchedReservationId', '<', rn + '').get();
  const forms = snap.docs.map(d => d.data()).filter(f => String(f.matchedReservationId).split('_')[0] === rn);
  return forms.sort((a, b) => ms(b.submittedAt) - ms(a.submittedAt))[0] || null;
}

/** deps: { db, nowMs() }. */
async function bookingPanel(auth, data, deps) {
  if (!inboxUser(auth)) throw new Fail('permission-denied', 'Only people with inbox access can do this.');
  const bn = data && data.bookingNumber;
  if (!isBookingNumber(bn)) throw new Fail('invalid-argument', 'Bad booking number.');
  const { db, nowMs } = deps;
  const c = await db.collection(CONVERSATIONS).doc(bn).get();
  if (!c.exists) throw new Fail('not-found', 'Conversation not found.');
  const conv = c.data();
  const notes = [];
  const out = { ok: true, bookingNumber: bn, notes };

  const res = await safe('reservation', notes, () => loadReservation(db, conv, bn), null);
  out.found = !!res;
  out.reservationNumber = res && res.reservationNumber ? String(res.reservationNumber).replace(/_\d+$/, '') : null;   // for the admin's "Open booking" link
  const checkin = (res && res.checkin) || conv.checkin || null;
  const checkout = (res && res.checkout) || conv.checkout || null;
  const room = (res && (res.roomCode || res.room)) || conv.roomCode || null;
  out.reservation = {
    checkin, checkout, nights: nightsBetween(checkin, checkout), room,
    status: (res && res.status) || conv.reservationStatus || null,
    guests: res ? (Number(res.guestCount) || (Number(res.adults) || 0) + (Number(res.children) || 0) || null) : null,
    guestName: conv.guestName || null,
  };
  if (res) {
    const form = await safe('check-in form', notes, () => loadForm(db, res), null);
    out.form = { filled: !!form, submittedAt: form ? ms(form.submittedAt) || null : null };
    out.access = form && form.unlockState
      ? { on: form.unlockState === 'unlocked', text: ACCESS_WORDS[form.unlockReason] || (form.unlockState === 'unlocked' ? 'Door access is on.' : 'Door access is not on.') }
      : { on: null, text: form ? 'Door access: no information yet.' : 'Door access: the guest has not filled in the check-in form.' };
  } else { out.form = null; out.access = null; }

  const today = tbilisiDay(nowMs());
  out.cleaning = null;
  if (room) {
    const hk = await safe('cleaning', notes, async () => { const s = await db.collection('hk_status').doc(`${room}_${today}`).get(); return s.exists ? s.data() : null; }, undefined);
    if (hk !== undefined) out.cleaning = { date: today, text: !hk ? 'No cleaning task for this room today.' : hk.removed ? 'No cleaning task for this room today.' : hk.done ? 'Cleaned today.' : 'Cleaning is not done yet today.' };
  }

  const name = res && typeof res.guest === 'string' ? res.guest : null;
  out.previous = [];
  if (name) {
    const prev = await safe('earlier stays', notes, async () => {
      const q = await db.collection('reservations').where('guest', '==', name).limit(10).get();
      return q.docs.map(d => ({ id: d.id, ...d.data() })).filter(r => r.id !== res.id && String(r.status || '').toUpperCase() !== 'CANCELLED' && r.checkin && r.checkin < (checkin || '9999'));
    }, []);
    out.previous = prev.sort((a, b) => String(b.checkin).localeCompare(String(a.checkin))).slice(0, 5).map(r => ({ checkin: r.checkin, checkout: r.checkout || null, room: r.roomCode || r.room || null }));
  }

  out.requests = await safe('requests', notes, async () => {
    const q = await db.collection('service_requests').where('bookingNumber', '==', bn).limit(30).get();
    return q.docs.map(d => ({ messageId: d.data().messageId || null, status: d.data().status || 'PENDING', id: d.id })).filter(r => r.messageId);
  }, []);
  return out;
}

/** "+ Request" on a guest message. deps: { db, nowMs(), ts(ms) }. */
async function createRequest(auth, data, deps) {
  const user = inboxUser(auth);
  if (!user) throw new Fail('permission-denied', 'Only people with inbox access can do this.');
  const d = data || {};
  if (!isBookingNumber(d.bookingNumber)) throw new Fail('invalid-argument', 'Bad booking number.');
  if (!/^[A-Za-z0-9_.-]{1,80}$/.test(String(d.messageId || ''))) throw new Fail('invalid-argument', 'Bad message.');
  const { db, nowMs, ts } = deps;
  const convRef = db.collection(CONVERSATIONS).doc(d.bookingNumber);
  const [conv, msg] = await Promise.all([convRef.get(), convRef.collection('messages').doc(d.messageId).get()]);
  if (!conv.exists || !msg.exists) throw new Fail('not-found', 'Message not found.');
  const m = msg.data();
  if (m.direction !== 'guest') throw new Fail('failed-precondition', 'Only a guest message can become a request.');
  const c = conv.data();
  const id = `inbox-${d.bookingNumber}-${d.messageId}`.slice(0, 140).replace(/\//g, '_');
  const ref = db.collection('service_requests').doc(id);
  const existing = await ref.get();
  if (existing.exists) return { ok: true, duplicate: true, status: existing.data().status || 'PENDING' };
  const note = String(m.text || '').replace(/\s+/g, ' ').trim().slice(0, 600);
  const room = c.roomCode || '';
  await ref.set({
    aptId: room, roomCode: room, guestName: c.guestName || '',
    guestId: '', guestContact: '', guestContactType: '', checkinRequestId: null,
    service: 'Message from the Booking.com chat', serviceId: 'booking_message',
    status: 'PENDING', details: { note }, whatsappNumber: '',
    source: 'booking_inbox', bookingNumber: d.bookingNumber, messageId: d.messageId, createdBy: user.name,
    timestamp: ts(nowMs()),
  });
  return { ok: true, duplicate: false, status: 'PENDING' };
}

function registerCloudFunctions() {
  const { onCall, HttpsError } = require('firebase-functions/v2/https');
  const { getFirestore, Timestamp } = require('firebase-admin/firestore');
  const region = 'europe-west1';
  const deps = () => ({ db: getFirestore(), nowMs: () => Date.now(), ts: m => Timestamp.fromMillis(m) });
  const wrap = fn => async request => {
    try { return await fn(request.auth, request.data, deps()); }
    catch (e) {
      if (e instanceof Fail) throw new HttpsError(e.code, e.message);
      console.error('inboxBooking callable failed', e && e.code, e && e.message);
      throw new HttpsError('internal', 'Something went wrong. Try again.');
    }
  };
  return {
    inboxBookingPanel: onCall({ region, timeoutSeconds: 30, maxInstances: 3, memory: '256MiB' }, wrap(bookingPanel)),
    inboxRequestCreate: onCall({ region, timeoutSeconds: 30, maxInstances: 3, memory: '256MiB' }, wrap(createRequest)),
  };
}

module.exports = { bookingPanel, createRequest, registerCloudFunctions, Fail };
