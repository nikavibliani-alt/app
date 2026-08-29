'use strict';
/**
 * Unit tests for runRoomAssignment — in-memory fake, no Firebase.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runRoomAssignment, findConflicts } = require('../controllers/roomAssignment');

function makeStore(initial = {}) {
  const reservations = new Map(Object.entries(initial.reservations || {}));
  const guests = new Map(Object.entries(initial.guests || {}));
  const roomMoves = [];
  const logs = [];

  function reservationMapForRoom(roomCode) {
    const map = new Map();
    for (const [id, data] of reservations) {
      if ((data.roomCode || data.room) === roomCode) map.set(id, { ...data });
    }
    return map;
  }

  function guestIdsForReservation(reservationId) {
    const ids = [];
    for (const [id, data] of guests) {
      if (data.matchedReservationId === reservationId) ids.push(id);
    }
    return ids;
  }

  async function runTransaction(fn) {
    const pendingResUpdates = new Map();
    const pendingGuestUpdates = new Map();

    const tx = {
      async getReservation(reservationId) {
        const pending = pendingResUpdates.get(reservationId);
        const base = reservations.get(reservationId);
        const data = pending ? { ...base, ...pending } : base ? { ...base } : null;
        return { id: reservationId, data: data || null };
      },
      async listReservationsInRoom(roomCode) {
        const map = new Map();
        for (const [id, base] of reservations) {
          const data = pendingResUpdates.has(id) ? { ...base, ...pendingResUpdates.get(id) } : { ...base };
          if ((data.roomCode || data.room) === roomCode) map.set(id, data);
        }
        return map;
      },
      async listGuestIdsForReservation(reservationId) {
        return guestIdsForReservation(reservationId);
      },
      updateReservation(reservationId, patch) {
        const prev = pendingResUpdates.get(reservationId) || {};
        pendingResUpdates.set(reservationId, { ...prev, ...patch });
      },
      updateGuest(guestId, patch) {
        const prev = pendingGuestUpdates.get(guestId) || {};
        pendingGuestUpdates.set(guestId, { ...prev, ...patch });
      },
    };

    const result = await fn(tx);

    for (const [id, patch] of pendingResUpdates) {
      reservations.set(id, { ...(reservations.get(id) || {}), ...patch });
    }
    for (const [id, patch] of pendingGuestUpdates) {
      guests.set(id, { ...(guests.get(id) || {}), ...patch });
    }

    return result;
  }

  const ctx = {
    store: { reservations, guests, roomMoves, logs },
    nowIso: () => '2026-08-29T12:00:00.000Z',
    getReservation: async (id) => ({
      id,
      data: reservations.has(id) ? { ...reservations.get(id) } : null,
    }),
    listReservationsInRoom: async (roomCode) => reservationMapForRoom(roomCode),
    listGuestIdsForReservation: async (id) => guestIdsForReservation(id),
    runTransaction,
    writeRoomMove: async (audit) => {
      roomMoves.push(audit);
    },
    logRun: async (entry) => {
      logs.push(entry);
    },
  };

  return ctx;
}

function res(roomCode, checkin, checkout, extra = {}) {
  return { roomCode, checkin, checkout, status: 'CONFIRMED', reservationNumber: extra.reservationNumber || 'R1', ...extra };
}

test('move into empty room updates reservation + guest mirror + audit', async () => {
  const ctx = makeStore({
    reservations: { res1: res('6-1', '2026-09-01', '2026-09-05') },
    guests: { g1: { aptId: '6-1', matchedReservationId: 'res1' } },
  });

  const result = await runRoomAssignment(ctx, {
    mode: 'move',
    assignmentId: 'res1',
    toRoomCode: '6-3',
    actor: 'nika',
  });

  assert.equal(result.ok, true);
  assert.equal(result.errorCode, 'MOVED');
  assert.equal(ctx.store.reservations.get('res1').roomCode, '6-3');
  assert.equal(ctx.store.reservations.get('res1').manualRoom, true);
  assert.equal(ctx.store.guests.get('g1').aptId, '6-3');
  assert.equal(ctx.store.roomMoves.length, 1);
  assert.equal(ctx.store.roomMoves[0].toRoom, '6-3');
});

test('conflict blocks silent overwrite', async () => {
  const ctx = makeStore({
    reservations: {
      res1: res('6-1', '2026-09-01', '2026-09-05'),
      res2: res('6-2', '2026-09-02', '2026-09-04', { reservationNumber: 'R2' }),
    },
  });

  const result = await runRoomAssignment(ctx, {
    mode: 'move',
    assignmentId: 'res1',
    toRoomCode: '6-2',
    actor: 'test',
  });

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'CONFLICT');
  assert.equal(ctx.store.reservations.get('res1').roomCode, '6-1');
});

test('same-day turnover is not a conflict', async () => {
  const ctx = makeStore({
    reservations: {
      res1: res('6-1', '2026-09-01', '2026-09-03'),
      res2: res('6-2', '2026-09-03', '2026-09-06', { reservationNumber: 'R2' }),
    },
  });

  const result = await runRoomAssignment(ctx, {
    mode: 'move',
    assignmentId: 'res1',
    toRoomCode: '6-2',
    actor: 'test',
  });

  assert.equal(result.ok, true);
  assert.equal(result.errorCode, 'MOVED');
});

test('swap exchanges rooms and mirrors both guests', async () => {
  const ctx = makeStore({
    reservations: {
      res1: res('6-1', '2026-09-01', '2026-09-05', { reservationNumber: 'R1' }),
      res2: res('6-2', '2026-09-01', '2026-09-05', { reservationNumber: 'R2' }),
    },
    guests: {
      g1: { aptId: '6-1', matchedReservationId: 'res1' },
      g2: { aptId: '6-2', matchedReservationId: 'res2' },
    },
  });

  const result = await runRoomAssignment(ctx, {
    mode: 'swap',
    assignmentId: 'res1',
    otherAssignmentId: 'res2',
    actor: 'nika',
  });

  assert.equal(result.ok, true);
  assert.equal(result.errorCode, 'SWAPPED');
  assert.equal(ctx.store.reservations.get('res1').roomCode, '6-2');
  assert.equal(ctx.store.reservations.get('res2').roomCode, '6-1');
  assert.equal(ctx.store.guests.get('g1').aptId, '6-2');
  assert.equal(ctx.store.guests.get('g2').aptId, '6-1');
  assert.equal(ctx.store.roomMoves.length, 2);
});

test('release_to_minihotel clears manualRoom', async () => {
  const ctx = makeStore({
    reservations: { res1: res('6-1', '2026-09-01', '2026-09-05', { manualRoom: true, roomVersion: 2 }) },
  });

  const result = await runRoomAssignment(ctx, {
    mode: 'release_to_minihotel',
    assignmentId: 'res1',
    actor: 'nika',
  });

  assert.equal(result.ok, true);
  assert.equal(result.errorCode, 'RELEASED');
  assert.equal(ctx.store.reservations.get('res1').manualRoom, false);
  assert.equal(ctx.store.reservations.get('res1').roomVersion, 3);
});

test('noop when already in target room', async () => {
  const ctx = makeStore({
    reservations: { res1: res('6-1', '2026-09-01', '2026-09-05') },
  });

  const result = await runRoomAssignment(ctx, {
    mode: 'move',
    assignmentId: 'res1',
    toRoomCode: '6-1',
    actor: 'test',
  });

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'NOOP');
});

test('findConflicts ignores cancelled reservations', () => {
  const rows = new Map([
    ['a', res('6-2', '2026-09-01', '2026-09-05')],
    ['b', res('6-2', '2026-09-01', '2026-09-05', { status: 'CANCELLED' })],
  ]);
  const conflicts = findConflicts(rows, '6-2', '2026-09-02', '2026-09-04', null);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].reservationId, 'a');
});
