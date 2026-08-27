'use strict';
/**
 * RoomAssignment — ★ PHASE 2 SCAFFOLD ONLY. Not implemented. Not wired to any
 * Cloud Function trigger. Exported from this file only so the interface is agreed
 * now and `pipeline-functions/index.js` has a stable import target once Phase 2
 * starts — importing/deploying this codebase today does NOT deploy this controller.
 *
 * Full rules: PIPELINE_DESIGN_CURSOR.md §2 (Controller 2) and §3 (RULE 1–7),
 * MASTER_ARCHITECTURE_CURSOR.md §8 + §10 "LOCKED DECISIONS" #1/#7.
 *
 * Locked-in shape (do not redesign without updating those docs first):
 *   Trigger : AdminAction only (`move` | `swap` | `repair`) — never called directly
 *             from admin HTML once wired.
 *   Input   : { assignmentId, toRoomCode, mode, actor }
 *   Output  : reservations.roomCode (+ manualRoom:true on admin move),
 *             checkin_guests.aptId, one room_moves/{id} audit doc — all in one
 *             Firestore transaction.
 *   Owns    : reservations.roomCode, checkin_guests.aptId, room_moves (sole writer).
 *   Never touches : MiniHotel API, WhatsApp, elevator, hk_status, apartment content.
 *   Conflict policy (LOCKED) : Block + Swap only. No silent overwrite. No "displace
 *             to unassigned" in v1 — that's exactly the class of bug that produces a
 *             lost guest, so it's intentionally not an option.
 *   Error behavior : transaction abort → no partial change; log + alert; return a
 *             structured error to the caller (never a bare throw to admin UI).
 */

/**
 * @param {object} ctx  same shape of injected interface as other controllers
 *                      (db, logRun, writeAlert — to be finalized in Phase 2)
 * @param {{assignmentId:string, toRoomCode:string, mode:'move'|'swap'|'repair', actor:string}} params
 */
async function runRoomAssignment(ctx, params) {
  throw new Error(
    'RoomAssignment is not implemented yet — Phase 2 scaffold only. ' +
      'See pipeline-functions/README.md and PIPELINE_DESIGN_CURSOR.md §2–§3.'
  );
}

module.exports = { runRoomAssignment };
