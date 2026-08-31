'use strict';
/**
 * Shared guest unlock rules — canonical copy for browser sandboxes.
 * Server mirror: pipeline-functions/lib/guest-unlock.js (keep in sync).
 *
 * Tbilisi timezone (UTC+4). Half-open stay: arrival day uses time/HK rules;
 * after arrival day → unlocked; before → locked.
 */

const TBILISI_TZ = 'Asia/Tbilisi';
const DEFAULT_CHECK_IN_HOUR = 15;
const HK_EARLY_HOUR = 11;
const TBILISI_OFFSET_MS = 4 * 3600 * 1000;

/** Tbilisi clock via fixed UTC+4 offset (no DST). Same approach as live admin HTML. */
function tbilisiNow() {
  return new Date(Date.now() + TBILISI_OFFSET_MS);
}

function tbilisiToday() {
  return tbilisiNow().toISOString().slice(0, 10);
}

function tbilisiHour() {
  return tbilisiNow().getUTCHours();
}

/** Normalize Firestore Timestamp / ISO / YYYY-MM-DD to calendar date string. */
function normalizeStayDate(v) {
  if (v == null || v === '') return '';
  if (typeof v === 'string') {
    const m = v.match(/^(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : '';
  }
  if (typeof v.toDate === 'function') {
    return v.toDate().toISOString().slice(0, 10);
  }
  if (v.seconds != null) {
    return new Date(v.seconds * 1000).toISOString().slice(0, 10);
  }
  return '';
}

/**
 * @param {object} opts
 * @param {object} [opts.guest] checkin_guests doc fields (manualUnlock, blocked, arrivalDate)
 * @param {string} [opts.arrivalDate] YYYY-MM-DD override
 * @param {number} [opts.checkInHour] apartment check-in hour (default 15)
 * @param {boolean} [opts.hkDone] hk_status.done for room+today
 * @param {string} [opts.today] YYYY-MM-DD override (tests)
 * @param {number} [opts.hour] hour override (tests)
 * @returns {{state:'locked'|'unlocked'|'blocked', unlocked:boolean, label:string, cls:string, reason:string}}
 */
function computeGuestUnlock(opts = {}) {
  const guest = opts.guest || {};
  if (guest.blocked === true) {
    return { state: 'blocked', unlocked: false, label: 'Blocked', cls: 'waiting', reason: 'blocked' };
  }

  // Admin force-unlock overrides arrival date / HK / time gates
  if (guest.manualUnlock === true) {
    return { state: 'unlocked', unlocked: true, label: 'Unlocked', cls: 'unlocked', reason: 'manual_unlock' };
  }

  const today = opts.today || tbilisiToday();
  const hour = opts.hour != null ? opts.hour : tbilisiHour();
  const checkInHour = opts.checkInHour != null ? opts.checkInHour : DEFAULT_CHECK_IN_HOUR;
  const hkDone = opts.hkDone === true;
  const arrival = normalizeStayDate(opts.arrivalDate || guest.arrivalDate || '');

  if (arrival) {
    if (today > arrival) {
      return { state: 'unlocked', unlocked: true, label: 'Checked in', cls: 'unlocked', reason: 'mid_stay' };
    }
    if (today < arrival) {
      return { state: 'locked', unlocked: false, label: 'Arrives ' + arrival, cls: 'waiting', reason: 'before_arrival' };
    }
  }

  // Arrival day, or no arrivalDate — time / HK rules (matches live admin HTML)
  if (hour >= checkInHour) {
    return { state: 'unlocked', unlocked: true, label: 'Unlocked', cls: 'unlocked', reason: 'check_in_hour' };
  }
  if (hkDone && hour >= HK_EARLY_HOUR) {
    return { state: 'unlocked', unlocked: true, label: 'Unlocked early', cls: 'unlocked', reason: 'hk_early' };
  }
  if (hkDone) {
    return { state: 'locked', unlocked: false, label: 'Ready 11am', cls: 'waiting', reason: 'hk_ready_wait_11' };
  }
  if (!arrival) {
    return { state: 'locked', unlocked: false, label: 'Waiting', cls: 'waiting', reason: 'no_arrival' };
  }
  return { state: 'locked', unlocked: false, label: 'Waiting', cls: 'waiting', reason: 'awaiting_hk_or_hour' };
}

/** Boolean gate for guest pages (same decision as computeGuestUnlock.unlocked). */
function isGuestUnlocked(opts = {}) {
  return computeGuestUnlock(opts).unlocked;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    TBILISI_TZ,
    DEFAULT_CHECK_IN_HOUR,
    HK_EARLY_HOUR,
    tbilisiNow,
    tbilisiToday,
    tbilisiHour,
    normalizeStayDate,
    computeGuestUnlock,
    isGuestUnlocked,
  };
}

export {
  TBILISI_TZ,
  DEFAULT_CHECK_IN_HOUR,
  HK_EARLY_HOUR,
  tbilisiNow,
  tbilisiToday,
  tbilisiHour,
  normalizeStayDate,
  computeGuestUnlock,
  isGuestUnlocked,
};
