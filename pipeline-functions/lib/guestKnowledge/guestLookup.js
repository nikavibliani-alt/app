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

/**
 * The WhatsApp check-in form (and its reservation) for this phone's current or
 * upcoming stay, or null. Reads recent forms (single-field range on
 * arrivalDate, no composite index) and matches phones in code.
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
  const picked = pickCurrentForm(candidates, today);
  return picked ? { form: picked.form, reservation: picked.reservation, state: picked.state } : null;
}

module.exports = {
  canonicalPhone,
  phonesMatch,
  stayState,
  pickCurrentForm,
  findCurrentGuestForm,
};
