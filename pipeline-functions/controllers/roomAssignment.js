'use strict';
/**
 * RoomAssignment — sole writer of authoritative room moves.
 *
 * Uses existing Firestore collections (no v2_*):
 *   reservations.roomCode (+ manualRoom, allRooms, roomVersion)
 *   checkin_guests.aptId (mirror for docs linked via matchedReservationId)
 *   room_moves/{id} (audit trail)
 *
 * Trigger: AdminAction only (`move` | `swap` | `release_to_minihotel`).
 * Conflict policy (LOCKED): block + swap only — no silent overwrite, no displace.
 */

const { datesOverlap } = require('../lib/dates');

class RoomAbort extends Error {
  constructor(code, message, data = null) {
    super(message);
    this.code = code;
    this.message = message;
    this.data = data;
  }
}

function stayDates(res) {
  return {
    checkin: res.checkin || res.checkIn || '',
    checkout: res.checkout || res.checkOut || '',
  };
}

function isActiveReservation(res) {
  const status = String(res.status || '').toUpperCase();
  return status !== 'CANCELLED';
}

function reservationSummary(id, data) {
  const dates = stayDates(data);
  return {
    reservationId: id,
    reservationNumber: data.reservationNumber || data.reservation_number || null,
    roomCode: data.roomCode || data.room || null,
    checkin: dates.checkin,
    checkout: dates.checkout,
    guest: data.guest || data.guestName || null,
  };
}

function findConflicts(reservations, roomCode, checkin, checkout, excludeId) {
  const conflicts = [];
  for (const [id, data] of reservations) {
    if (excludeId && id === excludeId) continue;
    if ((data.roomCode || data.room) !== roomCode) continue;
    if (!isActiveReservation(data)) continue;
    const dates = stayDates(data);
    if (datesOverlap(checkin, checkout, dates.checkin, dates.checkout)) {
      conflicts.push(reservationSummary(id, data));
    }
  }
  return conflicts;
}

function bumpRoomVersion(res, actor, nowIso) {
  const before = Number(res.roomVersion || 0);
  return {
    roomVersion: before + 1,
    updatedAt: nowIso,
    updatedBy: actor,
    _beforeRoomVersion: before,
  };
}

/**
 * @param {object} ctx
 * @param {() => string} ctx.nowIso
 * @param {(reservationId:string) => Promise<{id:string,data:object|null}>} ctx.getReservation
 * @param {(roomCode:string) => Promise<Map<string,object>>} ctx.listReservationsInRoom
 * @param {(reservationId:string) => Promise<string[]>} ctx.listGuestIdsForReservation
 * @param {(fn:(tx:object)=>Promise<object>) => Promise<object>} ctx.runTransaction
 * @param {(entry:object) => Promise<void>} ctx.logRun
 * @param {(audit:object) => Promise<void>} ctx.writeRoomMove
 * @param {{mode:'move'|'swap'|'release_to_minihotel', assignmentId:string,
 *          toRoomCode?:string, otherAssignmentId?:string, actor:string,
 *          expectedVersion?:number|null}} params
 * @returns {Promise<{ok:boolean, errorCode?:string, message:string, data?:object}>}
 */
async function runRoomAssignment(ctx, params) {
  const mode = params.mode;
  const assignmentId = params.assignmentId;
  const actor = params.actor || 'unknown';
  const correlationId = params.correlationId || null;
  const input = {
    mode,
    assignmentId,
    toRoomCode: params.toRoomCode || null,
    otherAssignmentId: params.otherAssignmentId || null,
    actor,
    expectedVersion: params.expectedVersion ?? null,
    correlationId,
  };

  try {
    if (mode === 'release_to_minihotel') {
      return await releaseToMinihotel(ctx, assignmentId, actor, input, correlationId);
    }
    if (mode === 'swap') {
      return await swapRooms(ctx, assignmentId, params.otherAssignmentId, actor, input, correlationId);
    }
    if (mode === 'move') {
      return await moveRoom(ctx, assignmentId, params.toRoomCode, actor, params.expectedVersion, input, correlationId);
    }
    const message = `Unknown mode: ${mode}`;
    await ctx.logRun({
      controller: 'RoomAssignment',
      action: mode || 'unknown',
      status: 'error',
      message,
      input,
    });
    return { ok: false, errorCode: 'BAD_REQUEST', message };
  } catch (err) {
    const message = err.message || String(err);
    await ctx.logRun({
      controller: 'RoomAssignment',
      action: mode || 'unknown',
      status: 'error',
      message,
      input,
    });
    return { ok: false, errorCode: 'INTERNAL', message };
  }
}

async function releaseToMinihotel(ctx, reservationId, actor, input, correlationId) {
  const nowIso = ctx.nowIso();
  const current = await ctx.getReservation(reservationId);
  if (!current.data) {
    await logRoomError(ctx, 'release_to_minihotel', input, 'NOT_FOUND', 'Reservation not found', null, correlationId);
    return { ok: false, errorCode: 'NOT_FOUND', message: 'Reservation not found' };
  }
  if (!isActiveReservation(current.data)) {
    await logRoomError(ctx, 'release_to_minihotel', input, 'INACTIVE', 'Reservation is cancelled', null, correlationId);
    return { ok: false, errorCode: 'INACTIVE', message: 'Reservation is cancelled' };
  }

  const fromRoom = current.data.roomCode || current.data.room || '';
  const versionMeta = bumpRoomVersion(current.data, actor, nowIso);

  await ctx.runTransaction(async (tx) => {
    const snap = await tx.getReservation(reservationId);
    if (!snap.data) throw new RoomAbort('NOT_FOUND', 'Reservation not found');
    const guestIds = await tx.listGuestIdsForReservation(reservationId);
    tx.updateReservation(reservationId, {
      manualRoom: false,
      roomVersion: versionMeta.roomVersion,
      updatedAt: versionMeta.updatedAt,
      updatedBy: versionMeta.updatedBy,
    });
    tx.writeRoomMove({
      reservationId,
      reservationNumber: snap.data.reservationNumber || null,
      guestIds,
      fromRoom,
      toRoom: fromRoom,
      mode: 'release_to_minihotel',
      actor,
      at: nowIso,
      beforeRoomVersion: versionMeta._beforeRoomVersion,
      afterRoomVersion: versionMeta.roomVersion,
      otherReservationId: null,
    });
    tx.logRun({
      controller: 'RoomAssignment',
      action: 'release_to_minihotel',
      status: 'ok',
      message: `Cleared manualRoom on ${reservationId}`,
      input,
      output: { reservationId, manualRoom: false, roomVersion: versionMeta.roomVersion },
      correlationId,
    });
  });

  return {
    ok: true,
    errorCode: 'RELEASED',
    message: 'Now follows MiniHotel room updates',
    data: { reservationId, manualRoom: false, roomVersion: versionMeta.roomVersion },
  };
}

async function moveRoom(ctx, reservationId, toRoomCode, actor, expectedVersion, input, correlationId) {
  if (!toRoomCode) {
    await logRoomError(ctx, 'move', input, 'BAD_REQUEST', 'toRoomCode is required');
    return { ok: false, errorCode: 'BAD_REQUEST', message: 'toRoomCode is required' };
  }

  const current = await ctx.getReservation(reservationId);
  if (!current.data) {
    await logRoomError(ctx, 'move', input, 'NOT_FOUND', 'Reservation not found');
    return { ok: false, errorCode: 'NOT_FOUND', message: 'Reservation not found' };
  }
  if (!isActiveReservation(current.data)) {
    await logRoomError(ctx, 'move', input, 'INACTIVE', 'Reservation is cancelled');
    return { ok: false, errorCode: 'INACTIVE', message: 'Reservation is cancelled' };
  }

  const fromRoom = current.data.roomCode || current.data.room || '';
  if (fromRoom === toRoomCode) {
    await logRoomWarn(ctx, 'move', input, 'NOOP', 'Already in that room');
    return { ok: false, errorCode: 'NOOP', message: 'Already in that room' };
  }

  const dates = stayDates(current.data);
  const roomRows = await ctx.listReservationsInRoom(toRoomCode);
  const conflicts = findConflicts(roomRows, toRoomCode, dates.checkin, dates.checkout, reservationId);
  if (conflicts.length) {
    await logRoomWarn(ctx, 'move', input, 'CONFLICT', 'Target room already has an overlapping stay — cancel or use swap', {
      conflict: conflicts[0],
      conflicts,
    });
    return {
      ok: false,
      errorCode: 'CONFLICT',
      message: 'Target room already has an overlapping stay — cancel or use swap',
      data: { conflict: conflicts[0], conflicts },
    };
  }

  if (expectedVersion != null && Number(current.data.roomVersion || 0) !== Number(expectedVersion)) {
    await logRoomError(ctx, 'move', input, 'VERSION_CONFLICT', 'Reservation changed since you loaded it — refresh and retry');
    return {
      ok: false,
      errorCode: 'VERSION_CONFLICT',
      message: 'Reservation changed since you loaded it — refresh and retry',
    };
  }

  const nowIso = ctx.nowIso();
  const versionMeta = bumpRoomVersion(current.data, actor, nowIso);
  const guestIds = await ctx.listGuestIdsForReservation(reservationId);

  try {
    await ctx.runTransaction(async (tx) => {
      const snap = await tx.getReservation(reservationId);
      if (!snap.data) throw new RoomAbort('NOT_FOUND', 'Reservation not found');
      if (expectedVersion != null && Number(snap.data.roomVersion || 0) !== Number(expectedVersion)) {
        throw new RoomAbort('VERSION_CONFLICT', 'Reservation changed since you loaded it — refresh and retry');
      }
      const liveDates = stayDates(snap.data);
      const liveFrom = snap.data.roomCode || snap.data.room || '';
      if (liveFrom === toRoomCode) throw new RoomAbort('NOOP', 'Already in that room');

      const [liveRows, guestIds] = await Promise.all([
        tx.listReservationsInRoom(toRoomCode),
        tx.listGuestIdsForReservation(reservationId),
      ]);
      const liveConflicts = findConflicts(liveRows, toRoomCode, liveDates.checkin, liveDates.checkout, reservationId);
      if (liveConflicts.length) {
        throw new RoomAbort(
          'CONFLICT',
          'Target room already has an overlapping stay — cancel or use swap',
          { conflict: liveConflicts[0], conflicts: liveConflicts }
        );
      }

      tx.updateReservation(reservationId, {
        roomCode: toRoomCode,
        allRooms: toRoomCode,
        manualRoom: true,
        roomVersion: versionMeta.roomVersion,
        updatedAt: versionMeta.updatedAt,
        updatedBy: versionMeta.updatedBy,
      });

      for (const guestId of guestIds) {
        tx.updateGuest(guestId, { aptId: toRoomCode, updatedAt: versionMeta.updatedAt });
      }

      tx.writeRoomMove({
        reservationId,
        reservationNumber: snap.data.reservationNumber || null,
        guestIds,
        fromRoom: liveFrom,
        toRoom: toRoomCode,
        mode: 'move',
        actor,
        at: nowIso,
        beforeRoomVersion: versionMeta._beforeRoomVersion,
        afterRoomVersion: versionMeta.roomVersion,
        otherReservationId: null,
      });
      tx.logRun({
        controller: 'RoomAssignment',
        action: 'move',
        status: 'ok',
        message: `move ${reservationId}: ${liveFrom} → ${toRoomCode}`,
        input,
        output: { reservationId, fromRoom: liveFrom, toRoom: toRoomCode, roomVersion: versionMeta.roomVersion },
        correlationId,
      });
    });
  } catch (err) {
    if (err instanceof RoomAbort) {
      const isWarn = err.code === 'CONFLICT' || err.code === 'NOOP';
      await ctx.logRun({
        controller: 'RoomAssignment',
        action: 'move',
        status: isWarn ? 'warn' : 'error',
        message: err.message,
        input,
        output: err.data || { errorCode: err.code },
        correlationId,
      });
      return { ok: false, errorCode: err.code, message: err.message, data: err.data || undefined };
    }
    throw err;
  }

  return {
    ok: true,
    errorCode: 'MOVED',
    message: 'Room move succeeded',
    data: { reservationId, fromRoom, toRoom: toRoomCode, roomVersion: versionMeta.roomVersion, affectedGuestIds: guestIds },
  };
}

async function swapRooms(ctx, reservationId, otherReservationId, actor, input, correlationId) {
  if (!otherReservationId) {
    await logRoomError(ctx, 'swap', input, 'BAD_REQUEST', 'otherAssignmentId is required');
    return { ok: false, errorCode: 'BAD_REQUEST', message: 'otherAssignmentId is required' };
  }
  if (otherReservationId === reservationId) {
    await logRoomError(ctx, 'swap', input, 'BAD_REQUEST', 'Cannot swap a reservation with itself');
    return { ok: false, errorCode: 'BAD_REQUEST', message: 'Cannot swap a reservation with itself' };
  }

  const [a, b] = await Promise.all([
    ctx.getReservation(reservationId),
    ctx.getReservation(otherReservationId),
  ]);
  if (!a.data) {
    await logRoomError(ctx, 'swap', input, 'NOT_FOUND', 'Reservation not found');
    return { ok: false, errorCode: 'NOT_FOUND', message: 'Reservation not found' };
  }
  if (!b.data) {
    await logRoomError(ctx, 'swap', input, 'NOT_FOUND', 'Other reservation not found');
    return { ok: false, errorCode: 'NOT_FOUND', message: 'Other reservation not found' };
  }
  if (!isActiveReservation(a.data) || !isActiveReservation(b.data)) {
    await logRoomError(ctx, 'swap', input, 'INACTIVE', 'One or both reservations are cancelled');
    return { ok: false, errorCode: 'INACTIVE', message: 'One or both reservations are cancelled' };
  }

  const roomA = a.data.roomCode || a.data.room || '';
  const roomB = b.data.roomCode || b.data.room || '';
  if (roomA === roomB) {
    await logRoomWarn(ctx, 'swap', input, 'NOOP', 'Both reservations are already in the same room');
    return { ok: false, errorCode: 'NOOP', message: 'Both reservations are already in the same room' };
  }

  const nowIso = ctx.nowIso();
  const versionA = bumpRoomVersion(a.data, actor, nowIso);
  const versionB = bumpRoomVersion(b.data, actor, nowIso);
  const [guestIdsA, guestIdsB] = await Promise.all([
    ctx.listGuestIdsForReservation(reservationId),
    ctx.listGuestIdsForReservation(otherReservationId),
  ]);

  try {
    await ctx.runTransaction(async (tx) => {
      const [snapA, snapB, guestIdsA, guestIdsB] = await Promise.all([
        tx.getReservation(reservationId),
        tx.getReservation(otherReservationId),
        tx.listGuestIdsForReservation(reservationId),
        tx.listGuestIdsForReservation(otherReservationId),
      ]);
      if (!snapA.data) throw new RoomAbort('NOT_FOUND', 'Reservation not found');
      if (!snapB.data) throw new RoomAbort('NOT_FOUND', 'Other reservation not found');

      const liveA = snapA.data.roomCode || snapA.data.room || '';
      const liveB = snapB.data.roomCode || snapB.data.room || '';
      if (liveA === liveB) throw new RoomAbort('NOOP', 'Both reservations are already in the same room');

      tx.updateReservation(reservationId, {
        roomCode: liveB,
        allRooms: liveB,
        manualRoom: true,
        roomVersion: versionA.roomVersion,
        updatedAt: versionA.updatedAt,
        updatedBy: versionA.updatedBy,
      });
      tx.updateReservation(otherReservationId, {
        roomCode: liveA,
        allRooms: liveA,
        manualRoom: true,
        roomVersion: versionB.roomVersion,
        updatedAt: versionB.updatedAt,
        updatedBy: versionB.updatedBy,
      });

      for (const guestId of guestIdsA) {
        tx.updateGuest(guestId, { aptId: liveB, updatedAt: versionA.updatedAt });
      }
      for (const guestId of guestIdsB) {
        tx.updateGuest(guestId, { aptId: liveA, updatedAt: versionB.updatedAt });
      }

      tx.writeRoomMove({
        reservationId,
        reservationNumber: snapA.data.reservationNumber || null,
        guestIds: guestIdsA,
        fromRoom: liveA,
        toRoom: liveB,
        mode: 'swap',
        actor,
        at: nowIso,
        beforeRoomVersion: versionA._beforeRoomVersion,
        afterRoomVersion: versionA.roomVersion,
        otherReservationId,
      });
      tx.writeRoomMove({
        reservationId: otherReservationId,
        reservationNumber: snapB.data.reservationNumber || null,
        guestIds: guestIdsB,
        fromRoom: liveB,
        toRoom: liveA,
        mode: 'swap',
        actor,
        at: nowIso,
        beforeRoomVersion: versionB._beforeRoomVersion,
        afterRoomVersion: versionB.roomVersion,
        otherReservationId: reservationId,
      });
      tx.logRun({
        controller: 'RoomAssignment',
        action: 'swap',
        status: 'ok',
        message: `swap ${reservationId} ↔ ${otherReservationId}: ${liveA} ↔ ${liveB}`,
        input,
        output: {
          reservationId,
          otherReservationId,
          fromRoom: liveA,
          toRoom: liveB,
          roomVersionA: versionA.roomVersion,
          roomVersionB: versionB.roomVersion,
        },
        correlationId,
      });
    });
  } catch (err) {
    if (err instanceof RoomAbort) {
      const isWarn = err.code === 'NOOP';
      await ctx.logRun({
        controller: 'RoomAssignment',
        action: 'swap',
        status: isWarn ? 'warn' : 'error',
        message: err.message,
        input,
        output: err.data || { errorCode: err.code },
        correlationId,
      });
      return { ok: false, errorCode: err.code, message: err.message, data: err.data || undefined };
    }
    throw err;
  }

  return {
    ok: true,
    errorCode: 'SWAPPED',
    message: 'Room swap succeeded',
    data: {
      reservationId,
      otherReservationId,
      fromRoom: roomA,
      toRoom: roomB,
      roomVersionA: versionA.roomVersion,
      roomVersionB: versionB.roomVersion,
      affectedGuestIds: [...guestIdsA, ...guestIdsB],
    },
  };
}

async function logRoomError(ctx, action, input, code, message, output = null, correlationId = null) {
  await ctx.logRun({
    controller: 'RoomAssignment',
    action,
    status: code === 'CONFLICT' || code === 'NOOP' ? 'warn' : 'error',
    message,
    input,
    output: output || { errorCode: code },
    correlationId: correlationId || input.correlationId || null,
  });
}

async function logRoomWarn(ctx, action, input, code, message, output = null, correlationId = null) {
  await ctx.logRun({
    controller: 'RoomAssignment',
    action,
    status: 'warn',
    message,
    input,
    output: output || { errorCode: code },
    correlationId: correlationId || input.correlationId || null,
  });
}

function buildLiveCtx() {
  const { getFirestore, FieldValue } = require('firebase-admin/firestore');
  const { writeSystemLog, buildSystemLogDoc } = require('../lib/logging');

  const db = getFirestore();

  async function getReservation(reservationId) {
    const snap = await db.collection('reservations').doc(reservationId).get();
    return { id: reservationId, data: snap.exists ? snap.data() : null };
  }

  async function listReservationsInRoom(roomCode) {
    const snap = await db.collection('reservations').where('roomCode', '==', roomCode).get();
    const map = new Map();
    snap.forEach((doc) => map.set(doc.id, doc.data()));
    return map;
  }

  async function listGuestIdsForReservation(reservationId) {
    const snap = await db
      .collection('checkin_guests')
      .where('matchedReservationId', '==', reservationId)
      .get();
    return snap.docs.map((d) => d.id);
  }

  async function runTransaction(fn) {
    return db.runTransaction(async (txn) => {
      const tx = {
        async getReservation(reservationId) {
          const ref = db.collection('reservations').doc(reservationId);
          const snap = await txn.get(ref);
          return { id: reservationId, data: snap.exists ? snap.data() : null };
        },
        async listReservationsInRoom(roomCode) {
          const snap = await txn.get(db.collection('reservations').where('roomCode', '==', roomCode));
          const map = new Map();
          snap.forEach((doc) => map.set(doc.id, doc.data()));
          return map;
        },
        async listGuestIdsForReservation(reservationId) {
          const snap = await txn.get(
            db.collection('checkin_guests').where('matchedReservationId', '==', reservationId)
          );
          return snap.docs.map((d) => d.id);
        },
        updateReservation(reservationId, patch) {
          const ref = db.collection('reservations').doc(reservationId);
          txn.update(ref, patch);
        },
        updateGuest(guestId, patch) {
          const ref = db.collection('checkin_guests').doc(guestId);
          txn.set(ref, patch, { merge: true });
        },
        writeRoomMove(audit) {
          const ref = db.collection('room_moves').doc();
          txn.set(ref, { ...audit, timestamp: FieldValue.serverTimestamp() });
        },
        logRun(entry) {
          const ref = db.collection('system_logs').doc();
          txn.set(ref, buildSystemLogDoc(entry));
        },
      };

      try {
        return await fn(tx);
      } catch (err) {
        if (err instanceof RoomAbort) throw err;
        throw err;
      }
    });
  }

  return {
    nowIso: () => new Date().toISOString(),
    getReservation,
    listReservationsInRoom,
    listGuestIdsForReservation,
    runTransaction,
    logRun: (entry) => writeSystemLog(db, entry),
  };
}

module.exports = {
  runRoomAssignment,
  buildLiveCtx,
  RoomAbort,
  datesOverlap,
  findConflicts,
  stayDates,
  isActiveReservation,
};
