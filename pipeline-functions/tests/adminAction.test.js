'use strict';
/**
 * Unit tests for runAdminAction — routes to fake RoomAssignment.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runAdminAction, normalizeActionType } = require('../controllers/adminAction');

function makeCtx(roomResult) {
  const logs = [];
  const calls = [];
  return {
    logs,
    calls,
    logRun: async (entry) => {
      logs.push(entry);
    },
    runRoomAssignment: async (params) => {
      calls.push(params);
      return roomResult;
    },
  };
}

test('normalizeActionType lowercases and normalizes dashes', () => {
  assert.equal(normalizeActionType('Move-Guest'), 'move_guest');
  assert.equal(normalizeActionType(' release_to_minihotel '), 'release_to_minihotel');
});

test('routes move_guest to RoomAssignment.move', async () => {
  const ctx = makeCtx({ ok: true, errorCode: 'MOVED', message: 'ok', data: { reservationId: 'res1' } });
  const result = await runAdminAction(ctx, {
    actionType: 'move_guest',
    payload: { assignmentId: 'res1', toRoom: '6-3' },
    actor: 'nika',
  });

  assert.equal(result.ok, true);
  assert.equal(ctx.calls.length, 1);
  assert.equal(ctx.calls[0].mode, 'move');
  assert.equal(ctx.calls[0].assignmentId, 'res1');
  assert.equal(ctx.calls[0].toRoomCode, '6-3');
  assert.equal(ctx.calls[0].actor, 'nika');
  assert.ok(ctx.logs.some((l) => l.controller === 'AdminAction' && l.message.includes('Admin intent')));
});

test('routes swap to RoomAssignment.swap', async () => {
  const ctx = makeCtx({ ok: true, errorCode: 'SWAPPED', message: 'ok' });
  await runAdminAction(ctx, {
    actionType: 'swap',
    payload: { reservationId: 'a', otherReservationId: 'b' },
    actor: 'admin',
  });

  assert.equal(ctx.calls[0].mode, 'swap');
  assert.equal(ctx.calls[0].otherAssignmentId, 'b');
});

test('unknown action returns UNKNOWN_ACTION', async () => {
  const ctx = makeCtx({ ok: true, message: 'unused' });
  const result = await runAdminAction(ctx, {
    actionType: 'save_apartment',
    payload: {},
    actor: 'admin',
  });

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'UNKNOWN_ACTION');
  assert.equal(ctx.calls.length, 0);
});

test('missing move fields returns BAD_REQUEST', async () => {
  const ctx = makeCtx({ ok: true, message: 'unused' });
  const result = await runAdminAction(ctx, {
    actionType: 'move',
    payload: { assignmentId: 'res1' },
    actor: 'admin',
  });

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'BAD_REQUEST');
});

test('routes force_unlock to GuestUnlock', async () => {
  const ctx = makeCtx({ ok: true, errorCode: 'UNLOCKED', message: 'Unlocked' });
  ctx.runGuestUnlock = async (params) => {
    ctx.unlockCalls = ctx.unlockCalls || [];
    ctx.unlockCalls.push(params);
    return { ok: true, errorCode: 'UNLOCKED', message: 'Unlocked' };
  };
  const result = await runAdminAction(ctx, {
    actionType: 'force_unlock',
    payload: { guestId: 'g1' },
    actor: 'nika',
  });
  assert.equal(result.ok, true);
  assert.equal(ctx.unlockCalls[0].guestId, 'g1');
  assert.equal(ctx.unlockCalls[0].forceManual, true);
  assert.ok(ctx.unlockCalls[0].correlationId);
  assert.ok(ctx.logs.every((l) => l.correlationId === ctx.logs[0].correlationId));
});

test('routes move_guest with correlationId propagated', async () => {
  const ctx = makeCtx({ ok: true, errorCode: 'MOVED', message: 'ok' });
  await runAdminAction(ctx, {
    actionType: 'move_guest',
    payload: { assignmentId: 'res1', toRoom: '6-3' },
    actor: 'nika',
    correlationId: 'adm_corr_1',
  });
  assert.equal(ctx.calls[0].correlationId, 'adm_corr_1');
});

test('recomputes unlock for affected guests after swap', async () => {
  const ctx = makeCtx({
    ok: true,
    errorCode: 'SWAPPED',
    message: 'ok',
    data: { affectedGuestIds: ['g1', 'g2'] },
  });
  ctx.runGuestUnlock = async (params) => {
    ctx.unlockCalls = ctx.unlockCalls || [];
    ctx.unlockCalls.push(params);
    return { ok: true, errorCode: 'RECOMPUTED', message: 'Unlocked' };
  };
  const result = await runAdminAction(ctx, {
    actionType: 'swap_guests',
    payload: { reservationId: 'a', otherReservationId: 'b' },
    actor: 'admin',
  });
  assert.equal(result.ok, true);
  assert.equal(ctx.unlockCalls.length, 2);
  assert.deepEqual(ctx.unlockCalls.map((c) => c.guestId), ['g1', 'g2']);
  assert.ok(ctx.unlockCalls.every((c) => c.forceManual === null));
});

test('surfaces unlock warnings when recompute fails after swap', async () => {
  const ctx = makeCtx({
    ok: true,
    errorCode: 'SWAPPED',
    message: 'Swapped',
    data: { affectedGuestIds: ['g1', 'g2'] },
  });
  ctx.runGuestUnlock = async (params) => {
    ctx.unlockCalls = ctx.unlockCalls || [];
    ctx.unlockCalls.push(params);
    if (params.guestId === 'g2') return { ok: false, message: 'Guest not found' };
    return { ok: true, errorCode: 'RECOMPUTED', message: 'Unlocked' };
  };
  const result = await runAdminAction(ctx, {
    actionType: 'swap_guests',
    payload: { reservationId: 'a', otherReservationId: 'b' },
    actor: 'admin',
  });
  assert.equal(result.ok, true);
  assert.equal(result.data.unlockWarnings.length, 1);
  assert.equal(result.data.unlockWarnings[0].guestId, 'g2');
  const finalLog = ctx.logs[ctx.logs.length - 1];
  assert.equal(finalLog.status, 'warn');
});
