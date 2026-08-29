'use strict';
/**
 * AdminAction — orchestration entry for admin-initiated mutations.
 *
 * Routes room actions to RoomAssignment (never writes room fields directly).
 * Logs every admin intent to system_logs before delegating.
 *
 * Auth v1: same password as admin HTML apps, supplied per call and checked
 * against Firebase secret ADMIN_ACTION_PASSWORD.
 */

const { runRoomAssignment, buildLiveCtx: buildRoomCtx } = require('./roomAssignment');
const { runGuestUnlock, buildLiveCtx: buildGuestUnlockCtx } = require('./guestUnlock');
const crypto = require('crypto');

function newCorrelationId() {
  return `adm_${crypto.randomBytes(8).toString('hex')}`;
}

const ROOM_ACTIONS = new Set(['move', 'move_guest', 'swap', 'swap_guests', 'release_to_minihotel']);
const UNLOCK_ACTIONS = new Set(['force_unlock', 'force_lock', 'recompute_unlock']);
const KNOWN_ACTIONS = new Set([...ROOM_ACTIONS, ...UNLOCK_ACTIONS]);

function normalizeActionType(actionType) {
  return String(actionType || '')
    .trim()
    .toLowerCase()
    .replace(/-/g, '_');
}

function pick(payload, ...keys) {
  for (const key of keys) {
    if (payload[key] != null && payload[key] !== '') return payload[key];
  }
  return null;
}

/**
 * @param {object} ctx
 * @param {(params:object) => Promise<object>} ctx.runRoomAssignment
 * @param {(params:object) => Promise<object>} ctx.runGuestUnlock
 * @param {(entry:object) => Promise<void>} ctx.logRun
 * @param {{actionType:string, payload:object, actor:string}} params
 */
async function runAdminAction(ctx, params) {
  const actionType = normalizeActionType(params.actionType);
  const payload = params.payload || {};
  const actor = params.actor || 'admin';

  const input = { actionType, payload, actor };

  if (!actionType) {
    await ctx.logRun({
      controller: 'AdminAction',
      action: 'unknown',
      status: 'error',
      message: 'actionType is required',
      input,
    });
    return { ok: false, errorCode: 'BAD_REQUEST', message: 'actionType is required' };
  }

  if (!KNOWN_ACTIONS.has(actionType)) {
    await ctx.logRun({
      controller: 'AdminAction',
      action: actionType,
      status: 'error',
      message: `Unknown admin action: ${actionType}`,
      input,
    });
    return { ok: false, errorCode: 'UNKNOWN_ACTION', message: `Unknown action: ${actionType}` };
  }

  const correlationId = params.correlationId || newCorrelationId();
  input.correlationId = correlationId;

  await ctx.logRun({
    controller: 'AdminAction',
    action: actionType,
    status: 'ok',
    message: `Admin intent received: ${actionType}`,
    input,
    correlationId,
  });

  if (UNLOCK_ACTIONS.has(actionType)) {
    const guestId = pick(payload, 'guestId');
    if (!guestId) {
      await ctx.logRun({
        controller: 'AdminAction',
        action: actionType,
        status: 'error',
        message: 'guestId is required',
        input,
      });
      return { ok: false, errorCode: 'BAD_REQUEST', message: 'guestId is required' };
    }
    const forceManual =
      actionType === 'force_unlock' ? true : actionType === 'force_lock' ? false : null;
    const result = await ctx.runGuestUnlock({ guestId, actor, forceManual, correlationId });
    await ctx.logRun({
      controller: 'AdminAction',
      action: actionType,
      status: result.ok ? 'ok' : 'error',
      message: result.message,
      input,
      output: { ok: result.ok, errorCode: result.errorCode, data: result.data || null },
      correlationId,
    });
    return {
      ok: result.ok,
      errorCode: result.errorCode || (result.ok ? 'OK' : 'FAILED'),
      message: result.message,
      data: result.data || null,
    };
  }

  let roomParams;
  if (actionType === 'move' || actionType === 'move_guest') {
    const assignmentId = pick(payload, 'assignmentId', 'reservationId');
    const toRoomCode = pick(payload, 'toRoomCode', 'toRoom');
    if (!assignmentId || !toRoomCode) {
      await ctx.logRun({
        controller: 'AdminAction',
        action: actionType,
        status: 'error',
        message: 'move requires assignmentId/reservationId and toRoomCode/toRoom',
        input,
      });
      return {
        ok: false,
        errorCode: 'BAD_REQUEST',
        message: 'move requires assignmentId/reservationId and toRoomCode/toRoom',
      };
    }
    roomParams = {
      mode: 'move',
      assignmentId,
      toRoomCode,
      actor,
      expectedVersion: payload.expectedVersion ?? payload.expectedRoomVersion ?? null,
      correlationId,
    };
  } else if (actionType === 'swap' || actionType === 'swap_guests') {
    const assignmentId = pick(payload, 'assignmentId', 'reservationId');
    const otherAssignmentId = pick(payload, 'otherAssignmentId', 'otherReservationId');
    if (!assignmentId || !otherAssignmentId) {
      await ctx.logRun({
        controller: 'AdminAction',
        action: actionType,
        status: 'error',
        message: 'swap requires assignmentId and otherAssignmentId',
        input,
      });
      return {
        ok: false,
        errorCode: 'BAD_REQUEST',
        message: 'swap requires assignmentId and otherAssignmentId',
      };
    }
    roomParams = { mode: 'swap', assignmentId, otherAssignmentId, actor, correlationId };
  } else {
    const assignmentId = pick(payload, 'assignmentId', 'reservationId');
    if (!assignmentId) {
      await ctx.logRun({
        controller: 'AdminAction',
        action: actionType,
        status: 'error',
        message: 'release_to_minihotel requires assignmentId/reservationId',
        input,
      });
      return {
        ok: false,
        errorCode: 'BAD_REQUEST',
        message: 'release_to_minihotel requires assignmentId/reservationId',
      };
    }
    roomParams = { mode: 'release_to_minihotel', assignmentId, actor, correlationId };
  }

  const result = await ctx.runRoomAssignment(roomParams);

  await ctx.logRun({
    controller: 'AdminAction',
    action: actionType,
    status: result.ok ? 'ok' : result.errorCode === 'CONFLICT' || result.errorCode === 'NOOP' ? 'warn' : 'error',
    message: result.message,
    input,
    output: {
      ok: result.ok,
      errorCode: result.errorCode || null,
      data: result.data || null,
    },
    correlationId,
  });

  return {
    ok: result.ok,
    errorCode: result.errorCode || (result.ok ? 'OK' : 'FAILED'),
    message: result.message,
    data: result.data || null,
  };
}

function buildLiveCtx() {
  const roomCtx = buildRoomCtx();
  const guestCtx = buildGuestUnlockCtx();
  const logRun = roomCtx.logRun;
  return {
    runRoomAssignment: (params) => runRoomAssignment(roomCtx, params),
    runGuestUnlock: (params) => runGuestUnlock({ ...guestCtx, logRun }, params),
    logRun,
  };
}

function registerCloudFunction() {
  const { onCall, HttpsError } = require('firebase-functions/v2/https');

  return onCall({ region: 'europe-west1', secrets: ['ADMIN_ACTION_PASSWORD'] }, async (request) => {
    const { password, actionType, payload, actor } = request.data || {};
    const expected = process.env.ADMIN_ACTION_PASSWORD;
    if (!expected || password !== expected) {
      throw new HttpsError('permission-denied', 'Incorrect admin password');
    }

    const ctx = buildLiveCtx();
    try {
      return await runAdminAction(ctx, { actionType, payload: payload || {}, actor: actor || 'admin' });
    } catch (err) {
      await ctx.logRun({
        controller: 'AdminAction',
        action: normalizeActionType(actionType) || 'unknown',
        status: 'error',
        message: err.message || String(err),
        input: { actionType, payload, actor },
      });
      throw new HttpsError('internal', err.message || 'AdminAction failed');
    }
  });
}

module.exports = { runAdminAction, buildLiveCtx, registerCloudFunction, normalizeActionType };
