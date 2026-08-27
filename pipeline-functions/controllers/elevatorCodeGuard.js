'use strict';
/**
 * elevatorCodeGuard — MOVED from tuya-functions/index.js (removed there in this
 * same change). Same logic as before, byte-for-byte behavior preserved, plus:
 *   (a) now logs every decision to system_logs (it silently console.log'd before)
 *   (b) reuses shared/elevator-sync.js's normalizeCode/pickCode instead of the
 *       private `_normElevatorCode`/`_pickElevatorCode` copies that used to live
 *       in tuya-functions/index.js — same behavior, one fewer duplicate
 *       implementation of the same two functions.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Trigger  : Firestore onDocumentWritten on `globals/elevator_code`.
 * Input    : before/after document data for that doc.
 * Output   : Reverts/corrects the just-written doc when it's a stale AUTO retry
 *            (same code as before); otherwise keeps `lastCode` in sync with
 *            whatever was accepted. `system_logs` entry every time it actually
 *            evaluates a write (not for a bare delete-with-no-after, matching the
 *            original early-return).
 * Owns     : `globals/elevator_code` (trigger-side corrections only — reverting or
 *            patching the doc that just triggered it), `system_logs`.
 * Never touches : RTDB, guests, reservations, tuya-functions, or any other collection.
 * Error behavior : Any read/write failure inside the trigger is caught and logged
 *            as status:'error' — never left to crash the trigger silently (Firestore
 *            triggers that throw get retried by the platform in a loop; catching
 *            here avoids that and still leaves a trace).
 *
 * docs/ELEVATOR_APP.md's contract, restated:
 *   - source !== 'auto' (i.e. manual admin save): always accepted; lastCode synced
 *     to the saved code if it isn't already.
 *   - source === 'auto' (Samsung app): accepted only if the incoming code differs
 *     from the previous one; a same-code auto retry is reverted (deleted if there
 *     was no previous doc to revert to).
 */

const ElevatorSync = require('../lib/elevator-sync.js');

/**
 * Pure decision function — no Firestore imports, directly unit-testable.
 *
 * @param {object|null} prevData  document data before this write (null if none existed)
 * @param {object} nextData       document data after this write
 * @returns {{
 *   status:'ok'|'warn',
 *   action:'accept-manual'|'noop-manual'|'accept-new-auto'|'reject-stale-auto'|'noop-empty',
 *   write: {type:'update',data:object} | {type:'set',data:object} | {type:'delete'} | null,
 *   message: string,
 * }}
 */
function decideGuardAction(prevData, nextData) {
  const source = nextData.source || 'auto';

  if (source !== 'auto') {
    const code = ElevatorSync.pickCode(nextData);
    if (code && nextData.lastCode !== code) {
      return {
        status: 'ok',
        action: 'accept-manual',
        write: { type: 'update', data: { lastCode: code } },
        message: `Manual save accepted — lastCode synced to "${code}".`,
      };
    }
    return { status: 'ok', action: 'noop-manual', write: null, message: 'Manual save, lastCode already current.' };
  }

  const inc = ElevatorSync.normalizeCode(ElevatorSync.pickCode(nextData));
  const cur = ElevatorSync.normalizeCode(ElevatorSync.pickCode(prevData));

  if (!inc) {
    return { status: 'ok', action: 'noop-empty', write: null, message: 'Empty incoming auto code, ignored.' };
  }

  if (cur && inc === cur) {
    return {
      status: 'warn',
      action: 'reject-stale-auto',
      write: prevData ? { type: 'set', data: prevData } : { type: 'delete' },
      message: `Rejected stale auto retry: "${inc}" is the same code as before.`,
    };
  }

  return {
    status: 'ok',
    action: 'accept-new-auto',
    write: { type: 'update', data: { lastCode: ElevatorSync.pickCode(nextData) } },
    message: `Accepted new auto code: "${inc}".`,
  };
}

/**
 * Applies the decision from decideGuardAction. Injected `ctx` keeps this testable
 * without a real Firestore doc reference.
 *
 * @param {object} ctx
 * @param {(write:object) => Promise<void>} ctx.applyWrite
 * @param {(entry:object) => Promise<void>} ctx.logRun
 * @param {object|null} prevData
 * @param {object|null} nextData  null means the document was deleted / has no "after"
 */
async function runElevatorCodeGuard(ctx, prevData, nextData) {
  if (!nextData) {
    // Matches the original tuya-functions behavior: a delete-with-no-after is a
    // true no-op, not logged (nothing to guard).
    return { status: 'ok', action: 'noop-no-after' };
  }

  let decision;
  try {
    decision = decideGuardAction(prevData, nextData);
  } catch (err) {
    const message = `decide failed: ${err.message}`;
    await ctx.logRun({ controller: 'ElevatorCodeGuard', action: 'evaluate', status: 'error', message });
    return { status: 'error', message };
  }

  if (decision.write) {
    try {
      await ctx.applyWrite(decision.write);
    } catch (err) {
      const message = `${decision.message} — but write failed: ${err.message}`;
      await ctx.logRun({ controller: 'ElevatorCodeGuard', action: decision.action, status: 'error', message });
      return { status: 'error', message };
    }
  }

  await ctx.logRun({
    controller: 'ElevatorCodeGuard',
    action: decision.action,
    status: decision.status,
    message: decision.message,
  });

  return { status: decision.status, action: decision.action, message: decision.message };
}

/** Builds a real ctx from the Firestore trigger's `after.ref`. Lazily requires firebase-admin. */
function buildLiveCtx(afterRef) {
  const { getFirestore } = require('firebase-admin/firestore');
  const { writeSystemLog } = require('../lib/logging');
  const db = getFirestore();

  return {
    applyWrite: async (write) => {
      if (write.type === 'update') await afterRef.update(write.data);
      else if (write.type === 'set') await afterRef.set(write.data, { merge: false });
      else if (write.type === 'delete') await afterRef.delete();
    },
    logRun: (entry) => writeSystemLog(db, entry),
  };
}

function registerCloudFunction() {
  const { onDocumentWritten } = require('firebase-functions/v2/firestore');

  return onDocumentWritten({ document: 'globals/elevator_code', region: 'europe-west1' }, async (event) => {
    const after = event.data.after;
    const before = event.data.before;
    if (!after?.exists) return; // matches original early return, no log

    const nextData = after.data();
    const prevData = before?.exists ? before.data() : null;
    const ctx = buildLiveCtx(after.ref);

    await runElevatorCodeGuard(ctx, prevData, nextData);
  });
}

module.exports = { decideGuardAction, runElevatorCodeGuard, buildLiveCtx, registerCloudFunction };
