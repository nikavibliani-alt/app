'use strict';
/**
 * GuestUnlock — computes and stores derived unlock state on checkin_guests.
 *
 * Uses existing collections only:
 *   checkin_guests — unlockState, unlockReason, unlockComputedAt (+ manualUnlock via force_*)
 *   checkin_apartments — checkInTime
 *   hk_status — early unlock when done
 *
 * Never writes roomCode, reservations, elevator, or hk_status.
 */

const { computeGuestUnlock, parseCheckInHour, tbilisiToday } = require('../lib/guest-unlock');

/**
 * @param {object} ctx
 * @param {(guestId:string) => Promise<object|null>} ctx.getGuest
 * @param {(aptId:string) => Promise<object|null>} ctx.getApartment
 * @param {(roomCode:string, dateStr:string) => Promise<object|null>} ctx.getHkStatus
 * @param {(guestId:string, patch:object) => Promise<void>} ctx.updateGuest
 * @param {(entry:object) => Promise<void>} ctx.logRun
 * @param {{guestId:string, actor?:string, forceManual?:boolean|null}} params forceManual true=unlock false=lock null=recompute only
 */
async function runGuestUnlock(ctx, params) {
  const guestId = params.guestId;
  const actor = params.actor || 'system';
  const input = { guestId, actor, forceManual: params.forceManual ?? null };

  if (!guestId) {
    await ctx.logRun({
      controller: 'GuestUnlock',
      action: 'recompute',
      status: 'error',
      message: 'guestId is required',
      input,
    });
    return { ok: false, errorCode: 'BAD_REQUEST', message: 'guestId is required' };
  }

  try {
    const guest = await ctx.getGuest(guestId);
    if (!guest) {
      await ctx.logRun({
        controller: 'GuestUnlock',
        action: 'recompute',
        status: 'error',
        message: 'Guest not found',
        input,
      });
      return { ok: false, errorCode: 'NOT_FOUND', message: 'Guest not found' };
    }

    const workingGuest = { ...guest };
    if (params.forceManual === true) workingGuest.manualUnlock = true;
    if (params.forceManual === false) workingGuest.manualUnlock = false;

    const aptId = workingGuest.aptId || '';
    const today = tbilisiToday();

    const [apt, hk] = await Promise.all([
      aptId ? ctx.getApartment(aptId) : Promise.resolve(null),
      aptId ? ctx.getHkStatus(aptId, today) : Promise.resolve(null),
    ]);

    const checkInHour = parseCheckInHour(apt?.checkInTime);
    const computed = computeGuestUnlock({
      guest: workingGuest,
      checkInHour,
      hkDone: hk?.done === true,
    });

    const nowIso = new Date().toISOString();
    const patch = {
      unlockState: computed.state,
      unlockReason: computed.reason,
      unlockComputedAt: nowIso,
    };
    if (params.forceManual === true) {
      patch.manualUnlock = true;
      patch.unlockedAt = nowIso;
      patch.unlockedBy = actor;
    }
    if (params.forceManual === false) {
      patch.manualUnlock = false;
    }

    await ctx.updateGuest(guestId, patch);

    const action =
      params.forceManual === true ? 'force_unlock' : params.forceManual === false ? 'force_lock' : 'recompute';

    await ctx.logRun({
      controller: 'GuestUnlock',
      action,
      status: 'ok',
      message: `${action} ${guestId} → ${computed.state} (${computed.reason})`,
      input,
      output: { guestId, ...computed, aptId, hkDone: hk?.done === true },
    });

    return {
      ok: true,
      errorCode: action === 'force_unlock' ? 'UNLOCKED' : action === 'force_lock' ? 'LOCKED' : 'RECOMPUTED',
      message: computed.label,
      data: { guestId, ...computed },
    };
  } catch (err) {
    await ctx.logRun({
      controller: 'GuestUnlock',
      action: 'recompute',
      status: 'error',
      message: err.message || String(err),
      input,
    });
    return { ok: false, errorCode: 'INTERNAL', message: err.message || 'GuestUnlock failed' };
  }
}

function buildLiveCtx() {
  const { getFirestore, FieldValue } = require('firebase-admin/firestore');
  const { writeSystemLog } = require('../lib/logging');
  const db = getFirestore();

  return {
    getGuest: async (guestId) => {
      const snap = await db.collection('checkin_guests').doc(guestId).get();
      return snap.exists ? snap.data() : null;
    },
    getApartment: async (aptId) => {
      const snap = await db.collection('checkin_apartments').doc(aptId).get();
      return snap.exists ? snap.data() : null;
    },
    getHkStatus: async (roomCode, dateStr) => {
      const snap = await db.collection('hk_status').doc(roomCode + '_' + dateStr).get();
      return snap.exists ? snap.data() : null;
    },
    updateGuest: async (guestId, patch) => {
      await db.collection('checkin_guests').doc(guestId).set(
        { ...patch, updatedAt: FieldValue.serverTimestamp() },
        { merge: true }
      );
    },
    logRun: (entry) => writeSystemLog(db, entry),
  };
}

module.exports = { runGuestUnlock, buildLiveCtx };
