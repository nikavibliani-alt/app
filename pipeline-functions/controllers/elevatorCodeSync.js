'use strict';
/**
 * ElevatorCodeSync
 * ─────────────────────────────────────────────────────────────────────────
 * Trigger  : onSchedule, every 1 hour. Plus `elevatorCodeSyncManual` (HTTPS,
 *            secret-gated) for on-demand testing without waiting for the schedule.
 * Input    : Firestore `globals/elevator_code`, RTDB `/elevator_code`.
 * Output   : If the two stores agree and are both fresh → nothing written, just a
 *            log. If they've drifted (different codes, or one side stale) → the
 *            fresher/authoritative side's full payload is copied onto the lagging
 *            side. If NEITHER side is fresh (or both empty) → nothing is written,
 *            logged as a warning. Always exactly one `system_logs` entry per run.
 * Owns     : `globals/elevator_code` + RTDB `/elevator_code` — but ONLY to
 *            reconcile drift between the two; it never invents a new code from
 *            nothing. `system_logs`.
 * Never touches : guests, reservations, rooms, hk_status, service_requests,
 *            HTML, email, WhatsApp, or any `tuya-functions/` export.
 * Error behavior : Every failure (read or write) is caught, logged as status:
 *            'error', and does not throw past this controller.
 *
 * NO notifications of any kind come from this controller — no WhatsApp, no email,
 * no `system_alerts`. `scripts/elevator-monitor.js` already emails Nika when the
 * elevator code is stale >26h on RTDB; that script and its GitHub Actions workflow
 * are untouched and remain the actual "tell a human" channel. This controller is
 * read/sync/log only.
 *
 * Complements — does NOT replace — `elevatorCodeGuard.js` in this same codebase
 * (a Firestore `onDocumentWritten` trigger that rejects a stale same-code AUTO
 * retry at write time, in Firestore only). This controller is a separate,
 * later-stage, hourly check for the OTHER failure mode: Firestore and RTDB fell
 * out of sync with EACH OTHER (e.g. a dual-write from the admin UI or the Samsung
 * app half-succeeded — one side updated, one didn't).
 *
 * Manual test: see pipeline-functions/README.md → "Testing ElevatorCodeSync".
 */

const { evaluate, payloadFrom } = require('../lib/elevator');

/**
 * Pure logic — no `firebase-admin`/`firebase-functions` imports at module scope,
 * so this function (and its tests) never need real Firebase or the emulator.
 * `ctx` is a small injected interface; `buildLiveCtx()` below is the only place
 * that talks to real Firestore/RTDB.
 *
 * @param {object} ctx
 * @param {() => number} ctx.now
 * @param {() => Promise<object|null>} ctx.readFirestoreElevator
 * @param {() => Promise<object|null>} ctx.readRtdbElevator
 * @param {(data:object) => Promise<void>} ctx.writeFirestoreElevator
 * @param {(data:object) => Promise<void>} ctx.writeRtdbElevator
 * @param {(entry:object) => Promise<void>} ctx.logRun
 * @returns {Promise<{status:'ok'|'warn'|'error', message?:string}>}
 */
async function runElevatorCodeSync(ctx) {
  const nowMs = ctx.now();

  let fsData = null;
  let rtdbData = null;
  try {
    [fsData, rtdbData] = await Promise.all([ctx.readFirestoreElevator(), ctx.readRtdbElevator()]);
  } catch (err) {
    const message = `read failed: ${err.message}`;
    await ctx.logRun({ controller: 'ElevatorCodeSync', action: 'check', status: 'error', message });
    return { status: 'error', message };
  }

  const result = evaluate(fsData, rtdbData, nowMs);
  const output = {
    firestoreCode: result.firestoreCode,
    rtdbCode: result.rtdbCode,
    firestoreAgeHours: result.firestoreAgeHours,
    rtdbAgeHours: result.rtdbAgeHours,
    synced: result.synced,
    syncDirection: result.syncDirection,
  };

  // ── Case 1: both fresh and agree ──────────────────────────────────────
  if (result.outcome === 'ok') {
    await ctx.logRun({
      controller: 'ElevatorCodeSync',
      action: 'check',
      status: 'ok',
      message: 'Firestore and RTDB agree and are both fresh.',
      output,
    });
    return { status: 'ok', ...output };
  }

  // ── Case 2: drift — one side is fresher/authoritative, sync the other ──
  if (result.outcome === 'sync') {
    const winnerData = result.winner === 'fs' ? fsData : rtdbData;
    const payload = payloadFrom(winnerData);

    let writeErr = null;
    try {
      if (result.winner === 'fs') await ctx.writeRtdbElevator(payload);
      else await ctx.writeFirestoreElevator(payload);
    } catch (err) {
      writeErr = err;
    }

    if (writeErr) {
      const message = `Detected drift (winner=${result.winner}) but reconcile write failed: ${writeErr.message}`;
      await ctx.logRun({ controller: 'ElevatorCodeSync', action: 'reconcile', status: 'error', message, output });
      return { status: 'error', message, ...output };
    }

    const message = `Drift detected — synced ${result.syncDirection} (winner=${result.winner}).`;
    await ctx.logRun({ controller: 'ElevatorCodeSync', action: 'reconcile', status: 'warn', message, output });
    return { status: 'warn', message, ...output };
  }

  // ── Case 3: neither side is fresh — nothing trustworthy to sync from ───
  // (scripts/elevator-monitor.js is the actual email-alert channel for this —
  // this controller only logs it.)
  const message =
    !result.firestoreCode && !result.rtdbCode
      ? 'Elevator code missing from both Firestore and RTDB.'
      : `Elevator code stale in both stores (Firestore ${result.firestoreAgeHours ?? '∞'}h, RTDB ${result.rtdbAgeHours ?? '∞'}h old) — nothing fresh to sync from.`;

  await ctx.logRun({ controller: 'ElevatorCodeSync', action: 'check', status: 'warn', message, output });
  return { status: 'warn', message, ...output };
}

/**
 * Builds a real `ctx` backed by Firestore/RTDB. Only required lazily inside this
 * function (and the Cloud Function wrappers below) so that importing this file
 * for unit tests never needs `firebase-admin` installed or initialized.
 */
function buildLiveCtx() {
  const { getFirestore, FieldValue } = require('firebase-admin/firestore');
  const { getDatabaseWithUrl } = require('firebase-admin/database');
  const { writeSystemLog } = require('../lib/logging');

  const RTDB_URL = 'https://sleepy-5c962-default-rtdb.europe-west1.firebasedatabase.app';
  const db = getFirestore();
  const rtdb = getDatabaseWithUrl(RTDB_URL);

  return {
    now: () => Date.now(),

    readFirestoreElevator: async () => {
      const snap = await db.doc('globals/elevator_code').get();
      return snap.exists ? snap.data() : null;
    },
    readRtdbElevator: async () => {
      const snap = await rtdb.ref('elevator_code').get();
      return snap.exists() ? snap.val() : null;
    },

    // These preserve the WINNER's own `updatedAt` (don't overwrite it with "now" —
    // that would erase the real staleness signal). `reconciledAt`/`reconciledBy`
    // are separate new bookkeeping fields for "when did this controller last touch
    // this doc", not a replacement for `updatedAt`.
    writeFirestoreElevator: async (data) => {
      await db.doc('globals/elevator_code').set(
        { ...data, reconciledBy: 'ElevatorCodeSync', reconciledAt: FieldValue.serverTimestamp() },
        { merge: true }
      );
    },
    writeRtdbElevator: async (data) => {
      await rtdb.ref('elevator_code').update({
        ...data,
        reconciledBy: 'ElevatorCodeSync',
        reconciledAt: String(Date.now()),
      });
    },

    logRun: (entry) => writeSystemLog(db, entry),
  };
}

function registerCloudFunctions() {
  const { onSchedule } = require('firebase-functions/v2/scheduler');
  const { onRequest } = require('firebase-functions/v2/https');

  const elevatorCodeSync = onSchedule({ schedule: 'every 1 hours', region: 'europe-west1' }, async () => {
    const ctx = buildLiveCtx();
    await runElevatorCodeSync(ctx);
  });

  /**
   * Manual on-demand trigger for testing — same logic, callable over HTTPS instead
   * of waiting for the hourly schedule. Gated by a shared secret
   * (`ELEVATOR_SYNC_MANUAL_SECRET`) checked against a standard `Authorization`
   * header, so it isn't a public "run this for me" endpoint.
   *
   *   curl -X POST "https://…/elevatorCodeSyncManual" \
   *        -H "Authorization: Bearer $ELEVATOR_SYNC_MANUAL_SECRET"
   */
  const elevatorCodeSyncManual = onRequest(
    { region: 'europe-west1', secrets: ['ELEVATOR_SYNC_MANUAL_SECRET'] },
    async (req, res) => {
      const expected = `Bearer ${process.env.ELEVATOR_SYNC_MANUAL_SECRET}`;
      if (!process.env.ELEVATOR_SYNC_MANUAL_SECRET || req.get('Authorization') !== expected) {
        res.status(403).json({ error: 'forbidden' });
        return;
      }
      const ctx = buildLiveCtx();
      try {
        const result = await runElevatorCodeSync(ctx);
        res.status(200).json(result);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    }
  );

  return { elevatorCodeSync, elevatorCodeSyncManual };
}

module.exports = { runElevatorCodeSync, buildLiveCtx, registerCloudFunctions };
