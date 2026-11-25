'use strict';

// Finds the WhatsApp check-in form for a guest's CURRENT or upcoming stay.
//
// The guest types their phone into the check-in page as free text (spaces,
// dashes, missing +, a leading 00, a Georgian local number without 995), so
// an exact Firestore match against the WhatsApp number misses real forms.
// Phones are compared here by digits only, after canonicalizing those
// formats. When several forms match (returning guests), the one whose
// reservation is current or upcoming wins; cancelled reservations never count,
// and only-past matches mean a returning guest with no current form.
//
// Only contactType 'wa' forms are used (unchanged behavior).

const FORM_WINDOW_DAYS = 60; // forms with an arrival date older than this can't be a current stay
const RECENT_UNMATCHED_DAYS = 14; // form whose reservation isn't in Firestore: still "current" this long after arrival
const DAY_MS = 24 * 60 * 60 * 1000;
const TBILISI_OFFSET_MS = 4 * 60 * 60 * 1000; // UTC+4 year-round, no DST

/** Digits only; drops a leading 00; a Georgian local mobile (9 digits, starts with 5) gets 995. */
function canonicalPhone(raw) {
  let digits = String(raw ?? '').replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.length === 9 && digits.startsWith('5')) digits = `995${digits}`;
  return digits;
}

/** Same phone number? Needs at least 9 digits so junk like "123" never matches. */
function phonesMatch(a, b) {
  const x = canonicalPhone(a);
  return x.length >= 9 && x === canonicalPhone(b);
}

/** YYYY-MM-DD in Tbilisi, `offsetDays` from now. */
function tbilisiDate(nowMs, offsetDays = 0) {
  return new Date(nowMs + TBILISI_OFFSET_MS + offsetDays * DAY_MS).toISOString().slice(0, 10);
}

function isCancelled(status) {
  const s = String(status || '').toUpperCase();
  return s === 'CL' || s === 'CANCELLED';
}

/** 'current' | 'upcoming' | 'past' | 'cancelled' for one form + its reservation (null if not found). */
function stayState(form, reservation, today) {
  if (reservation) {
    if (isCancelled(reservation.status)) return 'cancelled';
    const checkin = reservation.checkin || form.arrivalDate || '';
    const checkout = reservation.checkout || '';
    if (checkout && checkout < today) return 'past';
    if (checkin && checkin > today) return 'upcoming';
    return 'current';
  }
  // Reservation not in Firestore: judge by the form's own arrival date.
  const arrival = form.arrivalDate || '';
  if (arrival > today) return 'upcoming';
  const [y, m, d] = today.split('-').map(Number);
  const recent = new Date(Date.UTC(y, m - 1, d) - RECENT_UNMATCHED_DAYS * DAY_MS).toISOString().slice(0, 10);
  return arrival && arrival >= recent ? 'current' : 'past';
}

/**
 * Picks the form for the current stay, else the nearest upcoming one; null if
 * only past/cancelled forms match. candidates: [{ form, reservation }].
 */
function pickCurrentForm(candidates, today) {
  const scored = (candidates || []).map((c) => ({ ...c, state: stayState(c.form, c.reservation, today) }));
  const checkinOf = (c) => (c.reservation && c.reservation.checkin) || c.form.arrivalDate || '';
  const current = scored.filter((c) => c.state === 'current')
    // prefer a known reservation, then the most recent check-in (e.g. an extension booked as a new reservation)
    .sort((a, b) => (!!b.reservation - !!a.reservation) || checkinOf(b).localeCompare(checkinOf(a)));
  if (current.length) return current[0];
  const upcoming = scored.filter((c) => c.state === 'upcoming').sort((a, b) => checkinOf(a).localeCompare(checkinOf(b)));
  return upcoming[0] || null;
}

/** matchedReservationId may be "007004653_001" — base reservation number is before first _. */
function baseReservationNumber(matchedReservationId) {
  const raw = String(matchedReservationId || '').trim();
  return raw ? raw.split('_')[0] : '';
}

// Rule A (owner, 25 Nov): a stay only ends with a checkout and a new check-in
// that is not on the same day. A next booking starting on the checkout day is
// the same stay (no cleaning in between); a 1-day gap is a new stay.
const CHAIN_GAP_DAYS = 0;
const CHAIN_MAX = 30;

/** Guest name on a reservation, lowercased, single spaces ('' if none). */
function reservationGuestName(r) {
  const name = r?.guest || [r?.firstName, r?.lastName].filter(Boolean).join(' ');
  return String(name || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function dayDiff(fromDay, toDay) {
  const a = Date.parse(`${String(fromDay || '').slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${String(toDay || '').slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.round((b - a) / DAY_MS) : NaN;
}

/**
 * The stay a reservation belongs to: it and the same guest's back-to-back
 * bookings in the same room (the next one starts on the previous checkout
 * day, same guest name, not cancelled), oldest first. An
 * extension booked as a new reservation is the same stay, not a new visit.
 * roomReservations: every reservation of that room.
 */
function stayChain(reservation, roomReservations) {
  if (!reservation) return [];
  const name = reservationGuestName(reservation);
  const pool = (roomReservations || []).filter((r) => r && !isCancelled(r.status) && r.checkin && r.checkout
    && name && reservationGuestName(r) === name && r.reservationNumber !== reservation.reservationNumber);
  const chain = [reservation];
  const used = new Set([reservation.reservationNumber]);
  const step = (edge, pick) => {
    for (let i = 0; i < CHAIN_MAX; i++) {
      const from = chain[edge === 'next' ? chain.length - 1 : 0];
      const next = pool
        .filter((r) => !used.has(r.reservationNumber))
        .filter((r) => {
          const gap = edge === 'next' ? dayDiff(from.checkout, r.checkin) : dayDiff(r.checkout, from.checkin);
          return gap >= 0 && gap <= CHAIN_GAP_DAYS;
        })
        .sort(pick)[0];
      if (!next) return;
      used.add(next.reservationNumber);
      if (edge === 'next') chain.push(next); else chain.unshift(next);
    }
  };
  step('next', (a, b) => a.checkin.localeCompare(b.checkin));
  step('previous', (a, b) => b.checkout.localeCompare(a.checkout));
  return chain;
}

/** True when this booking is the last of its stay (no back-to-back booking follows it). */
function endsStay(reservation, roomReservationsList) {
  const chain = stayChain(reservation, roomReservationsList);
  return !chain.length || chain[chain.length - 1].reservationNumber === reservation.reservationNumber;
}

/** Every reservation of one room (equality filter only, no composite index). */
async function roomReservations(db, roomCode) {
  if (!roomCode) return [];
  const snap = await db.collection('reservations').where('roomCode', '==', roomCode).get();
  return snap.docs.map((d) => d.data());
}

/**
 * The WhatsApp check-in form (and its reservation) for this phone's current or
 * upcoming stay, or null. Reads recent forms (single-field range on
 * arrivalDate, no composite index) and matches phones in code.
 *
 * A guest who extended with new bookings often fills no new form, and those
 * bookings may carry no phone: when no form is current, a form whose booking
 * continues back to back (same room, same guest name, see stayChain) into
 * today or later still gives the current booking.
 *
 * Also returns stayStart / stayEnd (first check-in and last checkout of the
 * whole stay), bookings (how many back-to-back bookings it has) and
 * previousCheckouts (the checkouts of this phone's other bookings), for the
 * returning-guest line (stayRules.js).
 */
async function findCurrentGuestForm(db, phone, nowMs) {
  const today = tbilisiDate(nowMs);
  const snap = await db.collection('checkin_guests')
    .where('arrivalDate', '>=', tbilisiDate(nowMs, -FORM_WINDOW_DAYS))
    .get();
  const forms = snap.docs.map((d) => d.data())
    .filter((f) => f.contactType === 'wa' && phonesMatch(f.contact, phone));
  if (forms.length === 0) return null;

  const candidates = [];
  for (const form of forms) {
    const rn = baseReservationNumber(form.matchedReservationId);
    let reservation = null;
    if (rn) {
      const resSnap = await db.collection('reservations').where('reservationNumber', '==', rn).limit(1).get();
      if (!resSnap.empty) reservation = resSnap.docs[0].data();
    }
    candidates.push({ form, reservation });
  }

  let picked = pickCurrentForm(candidates, today);
  let chain = [];
  const roomCache = new Map();
  const chainOf = async (reservation) => {
    const room = reservation?.roomCode || '';
    if (!room) return reservation ? [reservation] : [];
    if (!roomCache.has(room)) roomCache.set(room, await roomReservations(db, room));
    return stayChain(reservation, roomCache.get(room));
  };

  if (!picked) {
    // No current form: does a past booking continue back to back into today or later?
    const past = candidates
      .filter((c) => c.reservation && stayState(c.form, c.reservation, today) === 'past')
      .sort((a, b) => String(b.reservation.checkout).localeCompare(String(a.reservation.checkout)))
      .slice(0, 3);
    for (const c of past) {
      const linked = await chainOf(c.reservation);
      // On a changeover day two bookings are current: the one starting today is the live one.
      const live = linked.filter((r) => stayState(c.form, r, today) === 'current').pop()
        || linked.find((r) => stayState(c.form, r, today) === 'upcoming');
      if (live) {
        picked = { form: c.form, reservation: live, state: stayState(c.form, live, today), continued: true };
        chain = linked;
        break;
      }
    }
  }
  if (!picked) return null;

  if (!chain.length && picked.reservation) chain = await chainOf(picked.reservation);
  const inChain = new Set(chain.map((r) => r.reservationNumber));
  const stayStart = chain[0]?.checkin || picked.reservation?.checkin || picked.form.arrivalDate || '';
  const stayEnd = chain[chain.length - 1]?.checkout || picked.reservation?.checkout || '';
  const previousCheckouts = candidates
    .filter((c) => c.reservation && !isCancelled(c.reservation.status) && !inChain.has(c.reservation.reservationNumber))
    .map((c) => c.reservation.checkout)
    .filter(Boolean);

  return {
    form: picked.form,
    reservation: picked.reservation,
    state: picked.state,
    continued: !!picked.continued,
    stayStart,
    stayEnd,
    bookings: chain.length,
    previousCheckouts,
  };
}

module.exports = {
  canonicalPhone,
  phonesMatch,
  stayState,
  stayChain,
  endsStay,
  roomReservations,
  pickCurrentForm,
  findCurrentGuestForm,
};
