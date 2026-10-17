'use strict';

// When no check-in form matches the guest's phone: is their booking already in
// our system? Looks it up (read-only) in `reservations` by a confirmation
// number the guest wrote (Booking.com id or our reservation number), else by
// their full name (first and last name both written by the guest, arrival from
// 3 days ago to 60 days ahead). Reservations have no phone number, so this is
// the only way to find a guest whose form did not match.
//
// Used for two rules: "the form can't find my booking" (not in the system yet
// -> new bookings take up to 10 minutes to appear) and "never assume Shartava
// when the booking isn't matched" (a found booking gives the room and dates).

const TBILISI_OFFSET_MS = 4 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const NAME_WINDOW_BEFORE_DAYS = 3;
const NAME_WINDOW_AFTER_DAYS = 60;
const MAX_NUMBERS = 3;

const isCancelled = (s) => ['CL', 'CANCELLED'].includes(String(s || '').toUpperCase());
const dateOnly = (v) => String(v || '').slice(0, 10);
const tbilisiDate = (nowMs, plusDays = 0) => new Date(nowMs + TBILISI_OFFSET_MS + plusDays * DAY_MS).toISOString().slice(0, 10);

/**
 * Confirmation numbers in the guest's messages: 6 to 12 digits, spaces, dots
 * or dashes allowed between groups. Phone numbers (+..., or 995...) and dates
 * are skipped.
 */
function confirmationNumbersIn(texts) {
  const out = [];
  for (const text of texts || []) {
    const t = String(text || '').replace(/https?:\/\/\S+/g, ' ');
    for (const m of t.matchAll(/(\+?)(\d[\d .-]{4,18}\d)/g)) {
      if (m[1] === '+') continue;
      if (/^\d{1,4}[.-]\d{1,2}[.-]\d{1,4}$/.test(m[2].trim())) continue; // a date
      const digits = m[2].replace(/\D/g, '');
      if (digits.length < 6 || digits.length > 12) continue;
      if (digits.length === 12 && digits.startsWith('995')) continue; // a Georgian phone number
      if (!out.includes(digits)) out.push(digits);
    }
  }
  return out.slice(0, MAX_NUMBERS);
}

/** Lowercase words of a name or text, in any script (Latin, Georgian, Cyrillic, ...). */
const words = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').split(/[^\p{L}]+/u).filter((w) => w.length >= 2);

/** True if the guest wrote both the reservation's first and last name (as whole words). */
function nameWrittenBy(reservation, texts) {
  const first = words(reservation?.firstName);
  const last = words(reservation?.lastName);
  if (!first.length || !last.length) return false;
  const written = new Set(words((texts || []).join(' ')));
  return written.has(first[0]) && written.has(last[last.length - 1]);
}

function foundFrom(reservation, via) {
  return {
    status: 'found',
    via,
    roomCode: String(reservation.roomCode || '').trim().toLowerCase(),
    checkin: dateOnly(reservation.checkin),
    checkout: dateOnly(reservation.checkout),
    reservationNumber: String(reservation.reservationNumber || ''),
  };
}

/**
 * { status: 'found', via, roomCode, checkin, checkout, reservationNumber }
 * | { status: 'not_found', via: 'confirmation number' }  (a number was written, no booking has it)
 * | { status: 'no_details' }  (no number written and no name match)
 * | { status: 'error' }  (the lookup failed; treat as unknown)
 */
async function lookupBooking(db, { guestTexts, nowMs = Date.now(), log = console }) {
  try {
    const numbers = confirmationNumbersIn(guestTexts);
    for (const n of numbers) {
      for (const field of ['bookingId', 'reservationNumber']) {
        const snap = await db.collection('reservations').where(field, '==', n).limit(3).get();
        const hit = snap.docs.map((d) => d.data()).find((r) => !isCancelled(r.status));
        if (hit) return foundFrom(hit, 'confirmation number');
      }
    }
    const snap = await db.collection('reservations')
      .where('checkin', '>=', tbilisiDate(nowMs, -NAME_WINDOW_BEFORE_DAYS))
      .where('checkin', '<=', tbilisiDate(nowMs, NAME_WINDOW_AFTER_DAYS))
      .get();
    const byName = snap.docs.map((d) => d.data())
      .filter((r) => !isCancelled(r.status) && nameWrittenBy(r, guestTexts))
      .sort((a, b) => dateOnly(a.checkin).localeCompare(dateOnly(b.checkin)));
    if (byName.length) return foundFrom(byName[0], 'name');
    return numbers.length ? { status: 'not_found', via: 'confirmation number' } : { status: 'no_details' };
  } catch (err) {
    log.warn(`bookingLookup: lookup failed (${err?.message || err})`);
    return { status: 'error' };
  }
}

// Said in the guest context whenever the booking is not matched: the prompt rule
// ("Guest's booking not matched") is followed far more reliably with it.
const NOT_MATCHED_NOTE = 'This guest\'s booking is not matched, so their location is unknown: do not give the Shartava address, maps links, entrance, parking, bag storage, hot water or WiFi; for those, ask for the name on the booking (see "Guest\'s booking not matched"). Everything else (check-in form or page, check-in and checkout times, early check-in, late checkout, booking questions, escalations) is answered as usual.';

/** The guest-context lines for a lookup result (none without a lookup). */
function bookingLookupLines(lookup, propertyName) {
  if (!lookup) return [];
  if (lookup.status !== 'found') return [...lookupResultLines(lookup), NOT_MATCHED_NOTE];
  return lookupResultLines(lookup, propertyName);
}

function lookupResultLines(lookup, propertyName) {
  if (lookup.status === 'found') {
    return [`Booking lookup (no check-in form matched this phone, so the booking was searched in our system by the ${lookup.via} the guest wrote): found, ${lookup.roomCode || 'room unknown'}${propertyName ? ` at ${propertyName}` : ''}, ${lookup.checkin} to ${lookup.checkout}. The booking is in our system.`];
  }
  if (lookup.status === 'not_found') {
    return ['Booking lookup (no check-in form matched this phone): no booking in our system has the confirmation number the guest wrote. The booking is not in our system yet.'];
  }
  if (lookup.status === 'no_details') {
    return ['Booking lookup (no check-in form matched this phone): not possible yet, the guest has not written a confirmation number or their full name that matches a booking.'];
  }
  return ['Booking lookup: unavailable right now (treat the booking as not checked).'];
}

/** The guest's own message texts from the stored history (role user). */
function guestTextsFrom(messagesNewestFirst, extra = '') {
  const texts = (messagesNewestFirst || []).filter((m) => m && m.role === 'user').map((m) => String(m.content || ''));
  if (extra) texts.push(String(extra));
  return texts;
}

module.exports = {
  NOT_MATCHED_NOTE,
  confirmationNumbersIn,
  nameWrittenBy,
  lookupBooking,
  bookingLookupLines,
  guestTextsFrom,
};
