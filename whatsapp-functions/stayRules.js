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

module.exports = {
  otherPropertyForRoom,
  propertyForRoom,
  stayTiming,
  stayTimingContextLines,
};
