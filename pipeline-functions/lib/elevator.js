'use strict';
/**
 * Elevator drift-detection logic, shared by elevatorCodeSync.js (and re-uses the
 * same normalize/pick rules elevatorCodeGuard.js and the Samsung app contract in
 * docs/ELEVATOR_APP.md already use — one implementation, not three).
 */
const ElevatorSync = require('./elevator-sync.js');
const { toMillis, ageHours } = require('./timestamps');

// elevatorCodeSync's own reconcile-staleness threshold. Deliberately NOT the same
// number as scripts/elevator-monitor.js (26h, RTDB-only, email alert) — that script
// is untouched and keeps being the actual "tell Nika" channel. 8h matches the brief.
const STALE_HOURS = 8;
const STALE_MS = STALE_HOURS * 60 * 60 * 1000;

/**
 * Compare Firestore's and RTDB's elevator-code state and decide what (if anything)
 * needs to happen. Pure — no I/O.
 *
 * @param {object|null} fsData   globals/elevator_code document data
 * @param {object|null} rtdbData /elevator_code RTDB value
 * @param {number} nowMs
 * @returns {{
 *   outcome: 'ok'|'sync'|'stale',
 *   winner: 'fs'|'rtdb'|null,
 *   syncDirection: 'fs_to_rtdb'|'rtdb_to_fs'|null,
 *   firestoreCode: string, rtdbCode: string,
 *   firestoreAgeHours: number|null, rtdbAgeHours: number|null,
 *   synced: boolean,
 * }}
 */
function evaluate(fsData, rtdbData, nowMs) {
  const fsCode = ElevatorSync.normalizeCode(ElevatorSync.pickCode(fsData));
  const rtdbCode = ElevatorSync.normalizeCode(ElevatorSync.pickCode(rtdbData));

  const fsUpdatedAtMs = toMillis(fsData && fsData.updatedAt);
  const rtdbUpdatedAtMs = toMillis(rtdbData && rtdbData.updatedAt);

  const firestoreAgeHoursRaw = ageHours(fsUpdatedAtMs, nowMs);
  const rtdbAgeHoursRaw = ageHours(rtdbUpdatedAtMs, nowMs);

  const fsFresh = firestoreAgeHoursRaw != null && firestoreAgeHoursRaw < STALE_HOURS;
  const rtdbFresh = rtdbAgeHoursRaw != null && rtdbAgeHoursRaw < STALE_HOURS;

  const bothEmpty = !fsCode && !rtdbCode;
  const codesMatch = !!fsCode && !!rtdbCode && fsCode === rtdbCode;

  let outcome;
  let winner = null;
  let syncDirection = null;

  if (bothEmpty || (!fsFresh && !rtdbFresh)) {
    // Nothing fresh enough to trust as the source to copy FROM — don't sync
    // garbage onto the other side. Just log it (the 26h email monitor is the
    // actual alert channel for this case, unchanged).
    outcome = 'stale';
  } else if (fsFresh && rtdbFresh && codesMatch) {
    outcome = 'ok';
  } else {
    outcome = 'sync';
    if (fsFresh && !rtdbFresh) {
      winner = 'fs';
    } else if (rtdbFresh && !fsFresh) {
      winner = 'rtdb';
    } else {
      // Both fresh, but codes differ (only remaining reason to be in this branch).
      // A manual admin save is a deliberate human fix — never let a same-age auto
      // write outrank it. If both/neither side is manual, the newer updatedAt wins.
      const fsManual = fsData && fsData.source === 'manual';
      const rtdbManual = rtdbData && rtdbData.source === 'manual';
      if (fsManual && !rtdbManual) winner = 'fs';
      else if (rtdbManual && !fsManual) winner = 'rtdb';
      else winner = (fsUpdatedAtMs || 0) >= (rtdbUpdatedAtMs || 0) ? 'fs' : 'rtdb';
    }
    syncDirection = winner === 'fs' ? 'fs_to_rtdb' : 'rtdb_to_fs';
  }

  return {
    outcome,
    winner,
    syncDirection,
    firestoreCode: fsCode,
    rtdbCode: rtdbCode,
    firestoreAgeHours: firestoreAgeHoursRaw == null ? null : Number(firestoreAgeHoursRaw.toFixed(2)),
    rtdbAgeHours: rtdbAgeHoursRaw == null ? null : Number(rtdbAgeHoursRaw.toFixed(2)),
    synced: outcome === 'ok',
  };
}

/** Full payload to copy onto the lagging side — same field shape shared/elevator-sync.js writers use. */
function payloadFrom(data) {
  return {
    display_code: data.display_code || data.code || '',
    qr_code: data.qr_code || '',
    code: data.code || data.display_code || '',
    lastCode: data.lastCode || data.display_code || data.code || '',
    source: data.source || 'auto',
    updatedAt: data.updatedAt,
    expires_at: data.expires_at,
  };
}

module.exports = { evaluate, payloadFrom, STALE_HOURS, STALE_MS };
