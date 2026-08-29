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

const ROOM_ACTIONS = new Set(['move', 'move_guest', 'swap', 'swap_guests', 'release_to_minihotel']);

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

  if (!ROOM_ACTIONS.has(actionType)) {
    await ctx.logRun({
      controller: 'AdminAction',
      action: actionType,
      status: 'error',
      message: `Unknown admin action: ${actionType}`,
      input,
    });
    return { ok: false, errorCode: 'UNKNOWN_ACTION', message: `Unknown action: ${actionType}` };
  }

  await ctx.logRun({
    controller: 'AdminAction',
    action: actionType,
    status: 'ok',
    message: `Admin intent received: ${actionType}`,
    input,
  });

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
    roomParams = { mode: 'swap', assignmentId, otherAssignmentId, actor };
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
    roomParams = { mode: 'release_to_minihotel', assignmentId, actor };
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
  return {
    runRoomAssignment: (params) => runRoomAssignment(roomCtx, params),
    logRun: roomCtx.logRun,
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
