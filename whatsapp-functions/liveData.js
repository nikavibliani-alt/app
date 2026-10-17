'use strict';

// Live system data the bot may use to answer more accurately (read-only):
// - the guest's check-in page state (same rules as the guest page: check-in
//   hour, cleaned today/yesterday, manual unlock, admin lock, stay ended)
// - the next arrival in the same unit (for the owner's alert on a late
//   checkout or other escalation; never shown to the guest or the model)
// - service prices from the admin settings (airport transfer)
//
// Decisions (early check-in, late checkout, discounts, room changes) stay with
// the owner: this data only makes answers and alerts more accurate.
// Never reads door codes: the unit lookup selects only checkInTime.

const { computeGuestUnlock, parseCheckInHour } = require('./guestUnlock');

const TBILISI_OFFSET_MS = 4 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const NEXT_ARRIVAL_WINDOW_DAYS = 30;

function tbilisiParts(nowMs) {
  const d = new Date(nowMs + TBILISI_OFFSET_MS);
  return { today: d.toISOString().slice(0, 10), hour: d.getUTCHours() };
}
const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const isCancelled = (s) => ['CL', 'CANCELLED'].includes(String(s || '').toUpperCase());
const dateOnly = (v) => String(v || '').slice(0, 10);

/**
 * The check-in page state for this guest, as the guest page computes it:
 * { unlocked, reason, label }, or null without a form.
 */
function checkinPageState({ form, reservation, checkInTime, hkDoneToday, hkDoneYesterday, nowMs }) {
  if (!form) return null;
  const { today, hour } = tbilisiParts(nowMs);
  const r = computeGuestUnlock({
    guest: form,
    arrivalDate: dateOnly(reservation?.checkin) || dateOnly(form.arrivalDate),
    checkoutDate: dateOnly(reservation?.checkout),
    cancelled: isCancelled(reservation?.status),
    checkInHour: parseCheckInHour(checkInTime),
    hkDone: hkDoneToday === true || hkDoneYesterday === true,
    today,
    hour,
    nowMs,
  });
  return { unlocked: r.unlocked, reason: r.reason, label: r.label };
}

const PAGE_REASON_TEXT = {
  hk_early: 'unlocked early because the unit is already cleaned',
  check_in_hour: 'unlocked, check-in time has passed',
  manual_unlock: 'unlocked by the host',
  mid_stay: 'unlocked (the guest is mid-stay)',
  hk_ready_wait_11: 'locked: the unit is cleaned, the page unlocks at 11:00',
  awaiting_hk_or_hour: 'locked: it unlocks at check-in time, or earlier once the unit is cleaned',
  before_arrival: 'locked: the arrival day has not come yet',
  stay_ended: 'locked: the stay has ended',
  cancelled: 'locked: the booking is cancelled',
  admin_disabled_until: 'locked by the host for now',
  admin_disabled_indefinite: 'locked by the host',
  blocked: 'locked by the host',
  no_arrival: 'locked: no arrival date known',
};

/** Guest-context lines for the live data (empty when nothing is known). */
function liveContextLines({ page, airportTransfer }) {
  const lines = [];
  if (page) {
    lines.push(`Check-in page unlocked right now (door code and instructions visible to the guest): ${page.unlocked ? 'yes' : 'no'} (${PAGE_REASON_TEXT[page.reason] || page.label})`);
  }
  if (airportTransfer && (airportTransfer.smallCarPrice || airportTransfer.largeCarPrice)) {
    const parts = [];
    if (airportTransfer.smallCarPrice) parts.push(`small car ${airportTransfer.smallCarPrice} GEL`);
    if (airportTransfer.largeCarPrice) parts.push(`large car ${airportTransfer.largeCarPrice} GEL`);
    lines.push(`Airport transfer prices (only if the guest asks the price): ${parts.join(', ')}${airportTransfer.maxGuestsPerCar ? `, up to ${airportTransfer.maxGuestsPerCar} guests per car` : ''}; booked on the check-in page under Services.`);
  }
  return lines;
}

/**
 * The earliest non-cancelled arrival in `roomCode` on or after `fromDate`
 * (within 30 days), other than `excludeReservation`. { date, sameDay } or null.
 */
function nextArrivalIn(reservations, { roomCode, fromDate, excludeReservation }) {
  const until = addDays(fromDate, NEXT_ARRIVAL_WINDOW_DAYS);
  const next = (reservations || [])
    .filter((r) => r && r.roomCode === roomCode && !isCancelled(r.status) && String(r.reservationNumber || '') !== String(excludeReservation || ''))
    .map((r) => dateOnly(r.checkin))
    .filter((d) => d && d >= fromDate && d <= until)
    .sort()[0];
  return next ? { date: next, sameDay: next === fromDate } : null;
}

/** One line for the owner's alert: the stay and the next arrival in the unit. */
function ownerStayNote({ roomCode, reservation, next }) {
  if (!roomCode || !reservation?.checkout) return '';
  const nextText = next ? `${next.date}${next.sameDay ? ' (same day as this checkout)' : ''}` : `none in the next ${NEXT_ARRIVAL_WINDOW_DAYS} days`;
  return `Stay ${dateOnly(reservation.checkin)} to ${dateOnly(reservation.checkout)}; next arrival in ${roomCode}: ${nextText}`;
}

/**
 * Reads the live data for one guest (read-only). Every part is optional: a
 * failed read just leaves that part out. Returns { page, airportTransfer, ownerNote }.
 */
async function loadLiveStay(db, { roomCode, form, reservation, nowMs = Date.now(), log = console }) {
  const out = { page: null, airportTransfer: null, ownerNote: '' };
  const { today } = tbilisiParts(nowMs);
  const yesterday = addDays(today, -1);
  const aptId = String(form?.aptId || roomCode || '').trim();

  const tasks = [];
  if (form && aptId) {
    tasks.push((async () => {
      const [apt, hkToday, hkYesterday] = await Promise.all([
        // checkInTime only: door codes are never loaded.
        db.collection('checkin_apartments').where('__name__', '==', db.collection('checkin_apartments').doc(aptId)).select('checkInTime').get(),
        db.collection('hk_status').doc(`${aptId}_${today}`).get(),
        db.collection('hk_status').doc(`${aptId}_${yesterday}`).get(),
      ]);
      out.page = checkinPageState({
        form,
        reservation,
        checkInTime: apt.empty ? undefined : apt.docs[0].get('checkInTime'),
        hkDoneToday: hkToday.exists && hkToday.get('done') === true,
        hkDoneYesterday: hkYesterday.exists && hkYesterday.get('done') === true,
        nowMs,
      });
    })().catch((err) => log.warn(`liveData: check-in page state unavailable (${err?.message || err})`)));
  }
  tasks.push((async () => {
    const cfg = await db.collection('checkin_admin').where('__name__', '==', db.collection('checkin_admin').doc('config')).select('services').get();
    const services = cfg.empty ? [] : (cfg.docs[0].get('services') || []);
    const t = services.find((s) => s && s.id === 'airport_transfer');
    if (t) out.airportTransfer = { smallCarPrice: Number(t.smallCarPrice) || 0, largeCarPrice: Number(t.largeCarPrice) || 0, maxGuestsPerCar: Number(t.maxGuestsPerCar) || 0 };
  })().catch((err) => log.warn(`liveData: service prices unavailable (${err?.message || err})`)));
  if (roomCode && reservation?.checkout) {
    tasks.push((async () => {
      const snap = await db.collection('reservations').where('roomCode', '==', roomCode).get();
      const next = nextArrivalIn(snap.docs.map((d) => d.data()), { roomCode, fromDate: dateOnly(reservation.checkout), excludeReservation: reservation.reservationNumber });
      out.ownerNote = ownerStayNote({ roomCode, reservation, next });
    })().catch((err) => log.warn(`liveData: next arrival unavailable (${err?.message || err})`)));
  }
  await Promise.all(tasks);
  return out;
}

/**
 * The check-in "already open" answer, upgraded by live data: the time-based
 * value from stayRules, or 'yes' when the guest's page is already unlocked
 * (e.g. cleaned early). Never downgrades a time-based 'yes'.
 */
function checkinOpenWithLiveData(timeBased, page) {
  if (page?.unlocked === true) return 'yes';
  return timeBased;
}

module.exports = {
  checkinPageState,
  liveContextLines,
  nextArrivalIn,
  ownerStayNote,
  loadLiveStay,
  checkinOpenWithLiveData,
  PAGE_REASON_TEXT,
};
