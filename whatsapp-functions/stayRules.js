'use strict';

// Facts about the guest's stay that the bot must not leave to the model:
// - which property the booking is at (Freedom Square, Orbeliani, VGL, XCV and
//   Abashidze guests get no bot reply at all: every scenario in the prompt is
//   Shartava-specific)
// - whether check-in (15:00 Tbilisi) has already opened for this guest.
// - whether today is the checkout day and checkout (12:00 Tbilisi) has passed:
//   after that the stay has ended, and "we checked out" is news, not a request.

const TBILISI_OFFSET_MS = 4 * 60 * 60 * 1000; // UTC+4 year-round, no DST
const CHECKIN_HOUR = 15;
const CHECKOUT_HOUR = 12;

// Properties whose guests get no bot reply: the bot sends nothing, Claude is
// not called, and the owner is alerted once per stay. Matched by the start of
// the booking's room code (tab-1..3, orb-1..3, vgl-st1/st2/ap3/ap4, xcv-1/2,
// abashidze).
const OTHER_PROPERTIES = [
  { prefix: 'tab-', name: 'Freedom Square' },
  { prefix: 'orb-', name: 'Orbeliani' },
  { prefix: 'vgl-', name: 'VGL' },
  { prefix: 'xcv-', name: 'XCV (Modern Avlabari)' },
  { prefix: 'abashidze', name: 'Abashidze' },
];

/** The property name for a non-Shartava room code (see OTHER_PROPERTIES), else null (Shartava and anything else). */
function otherPropertyForRoom(roomCode) {
  const code = String(roomCode || '').trim().toLowerCase();
  const match = OTHER_PROPERTIES.find((p) => code.startsWith(p.prefix));
  return match ? match.name : null;
}

/** Any property's name for a room code: 'Shartava' for 0-*, 6-*, 7-*, else as otherPropertyForRoom; null if not recognized. */
function propertyForRoom(roomCode) {
  const code = String(roomCode || '').trim().toLowerCase();
  if (/^[067]-/.test(code)) return 'Shartava';
  return otherPropertyForRoom(code);
}

function tbilisiNow(nowMs) {
  const d = new Date(nowMs + TBILISI_OFFSET_MS);
  return { date: d.toISOString().slice(0, 10), hour: d.getUTCHours() };
}

const dateOnly = (value) => {
  const m = String(value || '').match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : '';
};

/**
 * Check-in and checkout timing for the guest's booking, in Tbilisi time:
 * { today, arrivalDay: true|false|null, checkinTimePassed: bool,
 *   checkinOpen: 'yes'|'no'|'unknown',
 *   checkoutDay: true|false|null, checkoutTimePassed: bool, stayEnded: true|false|null }.
 * Check-in is open on the arrival day from 15:00, and on every later day of
 * the stay through checkout. The stay has ended from 12:00 on the checkout day.
 * Unknown dates -> null / 'unknown'.
 */
function stayTiming({ checkin, checkout } = {}, nowMs) {
  const { date: today, hour } = tbilisiNow(nowMs);
  const checkinTimePassed = hour >= CHECKIN_HOUR;
  const checkoutTimePassed = hour >= CHECKOUT_HOUR;
  const departure = dateOnly(checkout);
  const checkoutDay = departure ? today === departure : null;
  const stayEnded = departure ? today > departure || (today === departure && checkoutTimePassed) : null;
  const arrival = dateOnly(checkin);
  if (!arrival) return { today, arrivalDay: null, checkinTimePassed, checkinOpen: 'unknown', checkoutDay, checkoutTimePassed, stayEnded };
  const arrivalDay = today === arrival;
  let checkinOpen = 'no';
  if (arrivalDay) checkinOpen = checkinTimePassed ? 'yes' : 'no';
  else if (today > arrival && (!departure || today <= departure)) checkinOpen = 'yes';
  return { today, arrivalDay, checkinTimePassed, checkinOpen, checkoutDay, checkoutTimePassed, stayEnded };
}

/** Guest-context lines for the prompt (see the entrance and door-code scenarios). */
function stayTimingContextLines(timing) {
  const yn = (v) => (v === null ? 'unknown' : v ? 'yes' : 'no');
  return [
    `Today (Tbilisi): ${timing.today}`,
    `Today is the guest's arrival day: ${yn(timing.arrivalDay)}`,
    `15:00 check-in time has passed today: ${yn(timing.checkinTimePassed)}`,
    `Check-in is already open for this guest: ${timing.checkinOpen}`,
    `Today is the guest's checkout day: ${yn(timing.checkoutDay)}`,
    `12:00 checkout time has passed today: ${yn(timing.checkoutTimePassed)}`,
    `The guest's stay has ended (it is after 12:00 on the checkout day, or later): ${yn(timing.stayEnded)}`,
  ];
}

/** Nights from check-in to checkout (date parts only), or NaN when unknown or nonsense. */
function stayNights({ checkin, checkout } = {}) {
  const from = Date.parse(`${dateOnly(checkin)}T00:00:00Z`);
  const to = Date.parse(`${dateOnly(checkout)}T00:00:00Z`);
  const nights = Math.round((to - from) / 86400000);
  return Number.isFinite(nights) && nights >= 1 ? nights : NaN;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const shortDate = (value) => {
  const d = dateOnly(value);
  return d ? `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]}` : '';
};

/** For the owner's alerts: "stay 1 Nov to 6 Dec, 35 nights" (whole stay), or '' when the dates are unknown. */
function stayLabel(stay = {}) {
  const nights = stayNights(stay);
  if (!Number.isFinite(nights)) return '';
  return `stay ${shortDate(stay.checkin)} to ${shortDate(stay.checkout)}, ${nights} night${nights === 1 ? '' : 's'}`;
}

/**
 * 27 Nov (guest asked "is 4 am okay?"): the check-in day and the day after it,
 * written out here so the model never works out a date for an arrival-time
 * question ("4 am on 29 Nov is fine, 4 am on 28 Nov is too early"), and
 * which case applies: before the arrival day, the arrival day before 15:00,
 * or check-in already open. timing: stayTiming() (checkinOpen may include live data).
 * Unknown check-in date: a line that says so, so the model gives the reply
 * without dates and does not think aloud about the missing dates.
 */
function checkinDayLines(checkin, timing = {}) {
  const d = dateOnly(checkin);
  if (!d) return ['Check-in day: not known. For an arrival-time question give the reply without dates, and never mention the dates or that they are not known (computed in code)'];
  const next = new Date(Date.parse(`${d}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  if (timing.checkinOpen === 'yes') {
    return [`Check-in day: ${shortDate(d)}, check-in is already open, so the guest can arrive any time now (computed in code)`];
  }
  if (timing.arrivalDay === true) {
    return [`Check-in day: today, ${shortDate(d)}, check-in from 15:00 today, not open yet (computed in code)`];
  }
  return [`Check-in day: ${shortDate(d)} (check-in from 15:00 that day); the day after check-in: ${shortDate(next)} (computed in code)`];
}

/**
 * Rule B (owner, 25 Nov): the length of the WHOLE stay (back-to-back bookings
 * counted together, see guestLookup.js stayChain) and whether it is longer
 * than `overNights` nights, decided here so the model never counts dates. A
 * longer stay gets "we'll check and arrange it" + an alert for cleaning and
 * towel requests, a shorter one the paid cleaning reply (see the prompt).
 * No lines when either date is unknown or the dates make no sense.
 */
function stayLengthLines(stay = {}, overNights = 5) {
  const nights = stayNights(stay);
  if (!Number.isFinite(nights)) return [];
  return [
    `Length of this stay: ${nights} night${nights === 1 ? '' : 's'} (the whole stay, back-to-back bookings counted together; computed in code)`,
    `Stay is longer than ${overNights} nights: ${nights > overNights ? 'yes' : 'no'}`,
  ];
}

/**
 * Is this a returning guest on a new visit? Only when an earlier stay of this
 * guest ended more than 1 day before this stay's check-in. Back-to-back or
 * extended bookings (gap of 0 or 1 day) are the same stay, not a return.
 * stayStart: check-in of the whole current stay; previousCheckouts: checkouts
 * of the guest's other stays. true / false, or null when stayStart is unknown.
 */
function isReturningGuest({ stayStart, previousCheckouts = [] } = {}) {
  const start = dateOnly(stayStart);
  if (!start) return null;
  const startMs = Date.parse(`${start}T00:00:00Z`);
  // The latest earlier stay that ended on or before this check-in (an overlap is not a return).
  const prev = previousCheckouts.map(dateOnly).filter((d) => d && d <= start).sort().pop();
  if (!prev) return false;
  return (startMs - Date.parse(`${prev}T00:00:00Z`)) / 86400000 > 1;
}

/** Guest-context line for the returning-guest greeting (see that scenario in the prompt). */
function returningGuestLines(returning) {
  const v = returning === null || returning === undefined ? 'unknown' : returning ? 'yes' : 'no';
  return [`Returning guest on a new visit (an earlier stay ended more than 1 day before this stay's check-in; back-to-back bookings are one stay; computed in code): ${v}`];
}

/** "Check-in" / "Checkout" for the whole stay, plus the current booking when the stay has back-to-back bookings. */
function backToBackLines({ bookings, checkin, checkout } = {}) {
  if (!(bookings > 1)) return [];
  return [`This stay has ${bookings} back-to-back bookings in the same unit (one stay, not a new arrival in between): the current booking is ${dateOnly(checkin) || 'unknown'} to ${dateOnly(checkout) || 'unknown'}`];
}

module.exports = {
  backToBackLines,
  checkinDayLines,
  isReturningGuest,
  otherPropertyForRoom,
  propertyForRoom,
  returningGuestLines,
  stayLabel,
  stayLengthLines,
  stayNights,
  stayTiming,
  stayTimingContextLines,
};
