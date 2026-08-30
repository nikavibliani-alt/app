'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computeGuestUnlock, isGuestUnlocked } = require('../lib/guest-unlock');
const { runGuestUnlock } = require('../controllers/guestUnlock');

test('before arrival → locked', () => {
  const r = computeGuestUnlock({
    guest: { arrivalDate: '2026-09-05' },
    today: '2026-09-01',
    hour: 16,
  });
  assert.equal(r.unlocked, false);
  assert.equal(r.reason, 'before_arrival');
});

test('mid-stay → unlocked', () => {
  assert.equal(
    isGuestUnlocked({ guest: { arrivalDate: '2026-09-01' }, today: '2026-09-03', hour: 10 }),
    true
  );
});

test('arrival day after check-in hour → unlocked', () => {
  const r = computeGuestUnlock({
    guest: { arrivalDate: '2026-09-01' },
    checkInHour: 15,
    today: '2026-09-01',
    hour: 15,
  });
  assert.equal(r.unlocked, true);
  assert.equal(r.reason, 'check_in_hour');
});

test('arrival day HK done before 11 → ready 11am', () => {
  const r = computeGuestUnlock({
    guest: { arrivalDate: '2026-09-01' },
    checkInHour: 15,
    hkDone: true,
    today: '2026-09-01',
    hour: 10,
  });
  assert.equal(r.unlocked, false);
  assert.equal(r.reason, 'hk_ready_wait_11');
});

test('arrival day HK done at 11 → early unlock', () => {
  const r = computeGuestUnlock({
    guest: { arrivalDate: '2026-09-01' },
    checkInHour: 15,
    hkDone: true,
    today: '2026-09-01',
    hour: 11,
  });
  assert.equal(r.unlocked, true);
  assert.equal(r.reason, 'hk_early');
});

test('manualUnlock on arrival day → unlocked', () => {
  const r = computeGuestUnlock({
    guest: { arrivalDate: '2026-09-01', manualUnlock: true },
    today: '2026-09-01',
    hour: 8,
  });
  assert.equal(r.unlocked, true);
});

test('manualUnlock without arrivalDate still unlocks', () => {
  const r = computeGuestUnlock({ guest: { manualUnlock: true }, today: '2026-09-01', hour: 8 });
  assert.equal(r.unlocked, true);
  assert.equal(r.reason, 'manual_unlock');
});

test('no arrivalDate after check-in hour → unlocked', () => {
  const r = computeGuestUnlock({ guest: {}, checkInHour: 15, today: '2026-09-01', hour: 16 });
  assert.equal(r.unlocked, true);
  assert.equal(r.reason, 'check_in_hour');
});

test('no arrivalDate before check-in hour → waiting', () => {
  const r = computeGuestUnlock({ guest: {}, checkInHour: 15, today: '2026-09-01', hour: 10 });
  assert.equal(r.unlocked, false);
  assert.equal(r.reason, 'no_arrival');
});

test('runGuestUnlock force_unlock writes derived fields', async () => {
  const { tbilisiToday } = require('../lib/guest-unlock');
  const today = tbilisiToday();
  const store = {
    guest: { aptId: '6-1', arrivalDate: today },
    apt: { checkInTime: '15:00' },
    hk: null,
    patches: [],
    logs: [],
  };
  const ctx = {
    getGuest: async () => store.guest,
    getApartment: async () => store.apt,
    getHkStatus: async () => store.hk,
    updateGuest: async (_id, patch) => {
      store.patches.push(patch);
      store.guest = { ...store.guest, ...patch };
    },
    logRun: async (e) => {
      store.logs.push(e);
    },
  };

  const result = await runGuestUnlock(ctx, { guestId: 'g1', actor: 'nika', forceManual: true });
  assert.equal(result.ok, true);
  assert.equal(store.patches[0].manualUnlock, true);
  assert.equal(store.patches[0].unlockState, 'unlocked');
});
