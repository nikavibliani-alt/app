'use strict';

// Facts about the guest's stay that the bot must not leave to the model:
// - which property the booking is at (Freedom Square, Orbeliani, VGL, XCV and
//   Abashidze guests get no bot reply at all: every scenario in the prompt is
//   Shartava-specific)
// - whether check-in (15:00 Tbilisi) has already opened for this guest.

const TBILISI_OFFSET_MS = 4 * 60 * 60 * 1000; // UTC+4 year-round, no DST
const CHECKIN_HOUR = 15;

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

function tbilisiNow(nowMs) {
  const d = new Date(nowMs + TBILISI_OFFSET_MS);
  return { date: d.toISOString().slice(0, 10), hour: d.getUTCHours() };
}

const dateOnly = (value) => {
  const m = String(value || '').match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : '';
};

/**
 * Check-in timing for the guest's booking, in Tbilisi time:
 * { today, arrivalDay: true|false|null, checkinTimePassed: bool,
 *   checkinOpen: 'yes'|'no'|'unknown' }.
 * Check-in is open on the arrival day from 15:00, and on every later day of
 * the stay through checkout. Unknown dates -> arrivalDay null, checkinOpen 'unknown'.
 */
function stayTiming({ checkin, checkout } = {}, nowMs) {
  const { date: today, hour } = tbilisiNow(nowMs);
  const checkinTimePassed = hour >= CHECKIN_HOUR;
  const arrival = dateOnly(checkin);
  if (!arrival) return { today, arrivalDay: null, checkinTimePassed, checkinOpen: 'unknown' };
  const departure = dateOnly(checkout);
  const arrivalDay = today === arrival;
  let checkinOpen = 'no';
  if (arrivalDay) checkinOpen = checkinTimePassed ? 'yes' : 'no';
  else if (today > arrival && (!departure || today <= departure)) checkinOpen = 'yes';
  return { today, arrivalDay, checkinTimePassed, checkinOpen };
}

/** Guest-context lines for the prompt (see the entrance and door-code scenarios). */
function stayTimingContextLines(timing) {
  const yn = (v) => (v === null ? 'unknown' : v ? 'yes' : 'no');
  return [
    `Today (Tbilisi): ${timing.today}`,
    `Today is the guest's arrival day: ${yn(timing.arrivalDay)}`,
    `15:00 check-in time has passed today: ${yn(timing.checkinTimePassed)}`,
    `Check-in is already open for this guest: ${timing.checkinOpen}`,
  ];
}

module.exports = {
  otherPropertyForRoom,
  stayTiming,
  stayTimingContextLines,
};
