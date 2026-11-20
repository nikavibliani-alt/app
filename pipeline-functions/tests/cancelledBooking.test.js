'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runCancelledBooking, transition, REASON } = require('../controllers/cancelledBooking');

function mk(guests, { other = {}, tuya = { ok: true } } = {}) {
  const calls = { updates: [], logs: [], tuya: [] };
  return {
    calls,
    ctx: {
      now: () => '2026-11-20T10:00:00Z',
      listGuests: async () => guests,
      hasOtherLiveBooking: async g => !!other[g.id],
      updateGuest: async (id, d) => calls.updates.push([id, d]),
      deleteTuyaPassword: async id => { calls.tuya.push(id); if (tuya instanceof Error) throw tuya; return tuya; },
      logRun: async e => calls.logs.push(e),
    },
  };
}
const live = { status: 'OK', reservationNumber: '007005736', roomCode: 'xcv-2' };
const cancelled = { ...live, status: 'CANCELLED' };

test('transitions', () => {
  assert.equal(transition(live, cancelled), 'cancelled');
  assert.equal(transition(null, cancelled), 'cancelled');
  assert.equal(transition(cancelled, live), 'restored');
  assert.equal(transition(live, { ...live, guest: 'x' }), 'none');
  assert.equal(transition(cancelled, { ...cancelled, syncedAt: 1 }), 'none');
  assert.equal(transition(live, null), 'none');
});
test('a cancelled booking blocks every guest record with the reason, and logs it', async () => {
  const { ctx, calls } = mk([{ id: 'g1' }, { id: 'g2' }]);
  const r = await runCancelledBooking(ctx, '007005736', live, cancelled);
  assert.equal(r.guestsBlocked, 2);
  assert.deepEqual(calls.updates.map(u => u[0]), ['g1', 'g2']);
  assert.equal(calls.updates[0][1].accessDisabledByAdmin, true);
  assert.equal(calls.updates[0][1].accessDisabledReason, REASON);
  assert.equal(calls.logs.length, 1);
  assert.equal(calls.logs[0].controller, 'CancelledBooking');
  assert.equal(calls.tuya.length, 0, 'no password on the booking: Tuya is not called');
});
test('a record that is already blocked is left alone', async () => {
  const { ctx, calls } = mk([{ id: 'g1', accessDisabledByAdmin: true, accessDisabledReason: 'by hand' }]);
  await runCancelledBooking(ctx, '007005736', live, cancelled);
  assert.equal(calls.updates.length, 0);
});
test('a guest who still has another live booking is not blocked', async () => {
  const { ctx, calls } = mk([{ id: 'g1' }, { id: 'g2' }], { other: { g1: true } });
  const r = await runCancelledBooking(ctx, '007005736_001', live, cancelled);
  assert.equal(r.guestsKept, 1);
  assert.deepEqual(calls.updates.map(u => u[0]), ['g2']);
});
test('the Tuya password is revoked when the booking has one', async () => {
  const { ctx, calls } = mk([{ id: 'g1' }]);
  const r = await runCancelledBooking(ctx, '007005736', live, { ...cancelled, tuyaPasswordId: 'p1', tuyaPassword: '123456' });
  assert.deepEqual(calls.tuya, ['007005736']);
  assert.equal(r.tuya, 'revoked');
  assert.equal(r.status, 'ok');
});
test('a Tuya failure is a warning, the guests are still blocked', async () => {
  const { ctx, calls } = mk([{ id: 'g1' }], { tuya: new Error('Tuya down') });
  const r = await runCancelledBooking(ctx, '007005736', live, { ...cancelled, tuyaPasswordId: 'p1' });
  assert.equal(r.status, 'warn');
  assert.equal(r.guestsBlocked, 1);
  assert.match(calls.logs[0].message, /Tuya down/);
});
test('a restored booking lifts only the blocks made by this function', async () => {
  const { ctx, calls } = mk([
    { id: 'auto', accessDisabledByAdmin: true, accessDisabledReason: REASON },
    { id: 'hand', accessDisabledByAdmin: true, accessDisabledReason: 'by hand' },
    { id: 'open' },
  ]);
  const r = await runCancelledBooking(ctx, '007005736', cancelled, live);
  assert.equal(r.guestsRestored, 1);
  assert.deepEqual(calls.updates.map(u => u[0]), ['auto']);
});
test('no change in status does nothing', async () => {
  const { ctx, calls } = mk([{ id: 'g1' }]);
  const r = await runCancelledBooking(ctx, '007005736', live, { ...live, guest: 'New name' });
  assert.equal(r.action, 'none');
  assert.equal(calls.updates.length + calls.logs.length, 0);
});
