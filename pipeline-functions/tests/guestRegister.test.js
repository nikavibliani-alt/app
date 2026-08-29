'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { generateGuestToken, buildGuestLink, isLikelyGuestToken } = require('../lib/guest-token');
const { runGuestRegister } = require('../controllers/guestRegister');

test('generateGuestToken is 32 hex chars', () => {
  const t = generateGuestToken();
  assert.match(t, /^[a-f0-9]{32}$/);
});

test('buildGuestLink encodes token', () => {
  const url = buildGuestLink('https://app.example/checkin-guest-sandbox-2.html', 'abc123');
  assert.equal(url, 'https://app.example/checkin-guest-sandbox-2.html?g=abc123');
});

test('isLikelyGuestToken rejects room_date ids', () => {
  assert.equal(isLikelyGuestToken('6-1_2026-09-01'), false);
  assert.equal(isLikelyGuestToken('a'.repeat(32)), true);
});

function makeCtx(initial = {}) {
  const reservations = new Map(Object.entries(initial.reservations || {}));
  const guests = new Map();
  const logs = [];
  const unlockCalls = [];

  return {
    reservations,
    guests,
    logs,
    unlockCalls,
    getReservation: async (id) => {
      const r = reservations.get(id);
      return r ? { id, ...r } : null;
    },
    findReservationByNumber: async (num) => {
      for (const [id, r] of reservations) {
        if (r.reservationNumber === num && (r.status || '') !== 'CANCELLED') return { id, ...r };
      }
      return null;
    },
    findPrimaryGuestForReservation: async () => null,
    getGuest: async (id) => guests.get(id) || null,
    saveGuest: async (id, data, opts) => {
      const prev = guests.get(id) || {};
      guests.set(id, opts.mergeOnly ? { ...prev, ...data } : { ...prev, ...data });
    },
    runGuestUnlock: async (p) => {
      unlockCalls.push(p);
      return { ok: true };
    },
    logRun: async (e) => logs.push(e),
  };
}

test('register_primary creates guestToken doc with room from reservation', async () => {
  const ctx = makeCtx({
    reservations: {
      res1: {
        roomCode: '6-3',
        checkin: '2026-09-01',
        checkout: '2026-09-05',
        reservationNumber: 'R100',
        status: 'CONFIRMED',
      },
    },
  });

  const result = await runGuestRegister(ctx, {
    mode: 'register_primary',
    reservationId: 'res1',
    guestLinkBase: 'https://example.com/guest.html',
    profile: {
      name: 'Anna Test',
      passportUrl: 'https://storage/passport.jpg',
      arrivalDate: '2026-09-01',
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.aptId, '6-3');
  assert.ok(isLikelyGuestToken(result.data.guestToken));
  assert.match(result.data.guestLink, /\?g=/);
  const saved = ctx.guests.get(result.data.guestToken);
  assert.equal(saved.aptId, '6-3');
  assert.equal(saved.matchedReservationId, 'res1');
  assert.equal(saved.companionGuest, false);
  assert.equal(ctx.unlockCalls.length, 1);
});

test('register_primary reuses existing token for same reservation', async () => {
  const ctx = makeCtx({
    reservations: {
      res1: { roomCode: '6-1', checkin: '2026-09-01', checkout: '2026-09-03', status: 'CONFIRMED' },
    },
  });
  ctx.findPrimaryGuestForReservation = async () => ({
    id: 'a'.repeat(32),
    passportUrl: 'x',
  });

  const result = await runGuestRegister(ctx, {
    reservationId: 'res1',
    profile: { name: 'Bob', passportUrl: 'https://p.jpg', arrivalDate: '2026-09-01' },
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.guestToken, 'a'.repeat(32));
});

test('register_primary fails without passport', async () => {
  const ctx = makeCtx({
    reservations: { res1: { roomCode: '6-1', status: 'CONFIRMED' } },
  });
  const result = await runGuestRegister(ctx, {
    reservationId: 'res1',
    profile: { name: 'X' },
  });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'BAD_REQUEST');
});

test('register_companion uses room_date doc id', async () => {
  const ctx = makeCtx({
    reservations: {
      res1: {
        roomCode: '6-2',
        checkin: '2026-09-01',
        checkout: '2026-09-04',
        reservationNumber: 'R200',
        status: 'CONFIRMED',
      },
    },
  });

  const result = await runGuestRegister(ctx, {
    mode: 'register_companion',
    reservationId: 'res1',
    profile: { name: 'Companion', arrivalDate: '2026-09-01' },
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.guestToken, '6-2_2026-09-01');
  assert.equal(ctx.guests.get('6-2_2026-09-01').companionGuest, true);
});
