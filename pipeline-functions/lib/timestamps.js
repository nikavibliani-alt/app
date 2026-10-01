'use strict';
/**
 * Timestamps show up in different shapes across this system:
 *  - Firestore Timestamp object      (has .toMillis())
 *  - Firestore Timestamp-like object ({seconds, nanoseconds})
 *  - RTDB / shared/elevator-sync.js writes: a STRING of milliseconds, e.g. "1735000000000"
 *  - A plain number of milliseconds
 *
 * Every controller that compares "how old is this" needs one normalizer instead of
 * reimplementing this per controller.
 */

function toMillis(value) {
  if (value == null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value.seconds === 'number') {
    return value.seconds * 1000 + Math.floor((value.nanoseconds || 0) / 1e6);
  }
  return null;
}

function ageHours(millis, nowMs) {
  if (millis == null) return null;
  return (nowMs - millis) / 3600000;
}

module.exports = { toMillis, ageHours };
