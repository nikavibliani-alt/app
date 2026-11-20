'use strict';
/**
 * cancelledBooking — when a booking becomes CANCELLED, its guest records are blocked at once
 * (accessDisabledByAdmin true, accessDisabledReason "booking cancelled") and any Tuya lock password made for it is revoked.
 *
 * Trigger : reservations/{id} written.
 * Acts on : a change TO cancelled (also a doc created already cancelled). A change back FROM cancelled (booking restored)
 *           lifts only the blocks this function set (reason "booking cancelled"); a block made by hand is never touched.
 * Guests  : checkin_guests whose matchedReservationId is the reservation id or its number. A guest who still has another
 *           live booking (same base number, or listed in relatedReservationIds) is NOT blocked: that stay is still valid.
 * Tuya    : calls the deployed callable deleteTuyaPassword (it revokes the password at Tuya and clears it on the reservation).
 *           Nothing to delete is not an error.
 * Logs    : one system_logs entry per run that does something ("CancelledBooking").
 */

const REASON = 'booking cancelled';
const TUYA_DELETE_URL = 'https://deletetuyapassword-fmdlrwouiq-ew.a.run.app';

const isCancelled = r => !!r && String(r.status || '').toUpperCase() === 'CANCELLED';
const baseNum = ref => String(ref || '').trim().replace(/_\d+$/, '');

/** Pure: what happened to the reservation? */
function transition(before, after) {
  if (!after) return 'none';
  if (isCancelled(after) && !isCancelled(before)) return 'cancelled';
  if (!isCancelled(after) && isCancelled(before)) return 'restored';
  return 'none';
}

/**
 * ctx: { listGuests(ids) -> [{id,...}], hasOtherLiveBooking(guest, base, thisId) -> bool,
 *        updateGuest(id, data), deleteTuyaPassword(reservationId) -> {ok, skipped, message}, logRun(entry), now() -> ISO string }
 */
async function runCancelledBooking(ctx, id, before, after) {
  const kind = transition(before, after);
  if (kind === 'none') return { action: 'none' };

  const number = String((after && after.reservationNumber) || id);
  const ids = Array.from(new Set([id, number, baseNum(number)]));
  const out = { reservation: id, guestsBlocked: 0, guestsKept: 0, guestsRestored: 0, tuya: 'none' };
  let status = 'ok';
  const notes = [];

  const guests = await ctx.listGuests(ids);

  if (kind === 'cancelled') {
    for (const g of guests) {
      if (g.accessDisabledByAdmin === true) continue;   // already blocked (by hand or earlier): leave as it is
      if (await ctx.hasOtherLiveBooking(g, baseNum(number), id)) { out.guestsKept++; continue; }
      await ctx.updateGuest(g.id, { accessDisabledByAdmin: true, accessDisabledReason: REASON, accessDisabledAt: ctx.now() });
      out.guestsBlocked++;
    }
    if (after.tuyaPasswordId || after.tuyaPassword) {
      try {
        const r = await ctx.deleteTuyaPassword(id);
        out.tuya = r && r.ok ? 'revoked' : (r && r.skipped ? 'nothing to revoke' : 'failed');
        if (out.tuya === 'failed') { status = 'warn'; notes.push('Tuya: ' + ((r && r.message) || 'failed')); }
      } catch (e) {
        out.tuya = 'failed'; status = 'warn'; notes.push('Tuya: ' + e.message);
      }
    }
  } else {   // restored
    for (const g of guests) {
      if (g.accessDisabledByAdmin === true && g.accessDisabledReason === REASON) {
        await ctx.updateGuest(g.id, { accessDisabledByAdmin: false, accessDisabledReason: '', accessDisabledAt: null });
        out.guestsRestored++;
      }
    }
  }

  const message = kind === 'cancelled'
    ? `Booking ${number} cancelled: ${out.guestsBlocked} guest record(s) blocked` + (out.guestsKept ? `, ${out.guestsKept} kept (other live booking)` : '') + `, Tuya password: ${out.tuya}.` + (notes.length ? ' ' + notes.join('; ') : '')
    : `Booking ${number} is live again: ${out.guestsRestored} automatic block(s) lifted.`;
  if (out.guestsBlocked || out.guestsRestored || out.guestsKept || out.tuya !== 'none' || kind === 'cancelled') {
    await ctx.logRun({ controller: 'CancelledBooking', action: kind, status, message, output: out });
  }
  return { action: kind, status, ...out };
}

function buildLiveCtx() {
  const { getFirestore } = require('firebase-admin/firestore');
  const { writeSystemLog } = require('../lib/logging');
  const db = getFirestore();
  return {
    now: () => new Date().toISOString(),
    listGuests: async ids => {
      const seen = new Map();
      for (const v of ids) {
        const s = await db.collection('checkin_guests').where('matchedReservationId', '==', v).get();
        s.docs.forEach(d => seen.set(d.id, { id: d.id, ...d.data() }));
      }
      return [...seen.values()];
    },
    hasOtherLiveBooking: async (guest, base, thisId) => {
      const live = r => r && String(r.status || '').toUpperCase() !== 'CANCELLED';
      const pre = await db.collection('reservations').where('reservationNumber', '>=', base).where('reservationNumber', '<=', base + '').get();
      if (pre.docs.some(d => d.id !== thisId && baseNum(d.data().reservationNumber || d.id) === base && live(d.data()))) return true;
      for (const rid of (Array.isArray(guest.relatedReservationIds) ? guest.relatedReservationIds : [])) {
        if (baseNum(rid) === base) continue;
        const s = await db.collection('reservations').doc(String(rid)).get();
        if (s.exists && live(s.data())) return true;
      }
      return false;
    },
    updateGuest: (id, data) => db.collection('checkin_guests').doc(id).update(data),
    deleteTuyaPassword: async reservationId => {
      const res = await fetch(TUYA_DELETE_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: { reservationId } }),
      });
      const j = await res.json().catch(() => ({}));
      if (j.result && j.result.ok) return { ok: true };
      const err = j.error || {};
      if (err.status === 'FAILED_PRECONDITION') return { skipped: true, message: err.message };
      return { ok: false, message: err.message || ('HTTP ' + res.status) };
    },
    logRun: entry => writeSystemLog(db, entry),
  };
}

function registerCloudFunction() {
  const { onDocumentWritten } = require('firebase-functions/v2/firestore');
  return onDocumentWritten({ document: 'reservations/{id}', region: 'europe-west1', timeoutSeconds: 60 }, async event => {
    const before = event.data.before && event.data.before.exists ? event.data.before.data() : null;
    const after = event.data.after && event.data.after.exists ? event.data.after.data() : null;
    if (transition(before, after) === 'none') return;
    try {
      await runCancelledBooking(buildLiveCtx(), event.params.id, before, after);
    } catch (e) {
      console.error('[cancelledBooking] failed', event.params.id, e.message);
      try { await require('../lib/logging').writeSystemLog(require('firebase-admin/firestore').getFirestore(), { controller: 'CancelledBooking', action: 'error', status: 'error', message: `Booking ${event.params.id}: ${e.message}` }); } catch (_) { /* nothing more to do */ }
      throw e;   // let the platform retry once
    }
  });
}

module.exports = { runCancelledBooking, transition, registerCloudFunction, REASON };
