'use strict';
/**
 * AdminAction — PHASE 2 SCAFFOLD ONLY. Not implemented. Not wired to any Cloud
 * Function trigger. Exists so the interface is agreed now; importing/deploying
 * this codebase today does NOT deploy this controller.
 *
 * Full rules: PIPELINE_DESIGN_CURSOR.md §2 (Controller 8).
 *
 * Locked-in shape:
 *   Trigger : every admin-initiated write (move, unlock, elevator manual set,
 *             apartment save, resolve search failure, service-request status).
 *   Input   : { actionType, payload, actor } — actor is the admin session id.
 *   Output  : routes to the controller that actually owns the affected data
 *             (e.g. `move`/`swap` → RoomAssignment). Returns
 *             { ok, errorCode, message }.
 *   Owns    : orchestration only + a system_logs entry for the admin intent.
 *             Never bypasses RoomAssignment for room moves.
 *   Never touches : Firestore room fields directly — always through RoomAssignment.
 *   Auth (v1, LOCKED) : same password gate as today's admin apps. Stronger auth is
 *             a later phase, not a blocker for pipeline correctness.
 */

/**
 * @param {object} ctx
 * @param {{actionType:string, payload:object, actor:string}} params
 */
async function runAdminAction(ctx, params) {
  throw new Error(
    'AdminAction is not implemented yet — Phase 2 scaffold only. ' +
      'See pipeline-functions/README.md and PIPELINE_DESIGN_CURSOR.md §2 (Controller 8).'
  );
}

module.exports = { runAdminAction };
