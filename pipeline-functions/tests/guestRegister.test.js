'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { generateGuestToken, buildGuestLink, isLikelyGuestToken } = require('../lib/guest-token');
const { runGuestRegister } = require('../controllers/guestRegister');
const proofLib = require('../lib/guest-proof');
const M = require('../lib/guest-match');

const SECRET = 'test-secret';
/** a find-step proof covering every booking in the ctx (what a real search of that booking would hand out) */
const proofFor = ctx => proofLib.sign(SECRET, { bases: [...ctx.reservations].map(([id, r]) => M.reservationBaseNum(String(r.reservationNumber || id))) });

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
    verifyProof: (t) => proofLib.verify(SECRET, t),
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
    proof: proofFor(ctx),
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
    proof: proofFor(ctx),
    reservationId: 'res1',
    profile: { name: 'Bob', passportUrl: 'https://p.jpg', arrivalDate: '2026-09-01' },
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.guestToken, 'a'.repeat(32));
});

test('register_primary without passport is accepted for an Airbnb booking', async () => {
  const ctx = makeCtx({
    reservations: { resA: { roomCode: '6-2', checkin: '2026-09-01', checkout: '2026-09-04', reservationNumber: 'R300', status: 'OK2', source: 'airbnb' } },
  });
  const result = await runGuestRegister(ctx, {
    proof: proofFor(ctx),
    mode: 'register_primary', reservationId: 'resA',
    profile: { name: 'A Guest', passportSkipped: true, skipReason: 'airbnb', arrivalDate: '2026-09-01' },
  });
  assert.equal(result.ok, true);
  const saved = ctx.guests.get(result.data.guestToken);
  assert.equal(saved.passportSkipped, true);
  assert.equal(saved.skipReason, 'airbnb');
  assert.equal(saved.passportUrl, '');
  assert.equal(saved.isPrimaryGuest, true);
});

test('register_primary without passport is still rejected for Booking.com', async () => {
  const ctx = makeCtx({
    reservations: { resB: { roomCode: '6-2', checkin: '2026-09-01', checkout: '2026-09-04', reservationNumber: 'R301', status: 'OK2', source: 'booking' } },
  });
  const result = await runGuestRegister(ctx, { proof: proofFor(ctx), mode: 'register_primary', reservationId: 'resB', profile: { name: 'B Guest' } });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'BAD_REQUEST');
});

test('register_primary fails without passport', async () => {
  const ctx = makeCtx({
    reservations: { res1: { roomCode: '6-1', status: 'CONFIRMED' } },
  });
  const result = await runGuestRegister(ctx, {
    proof: proofFor(ctx),
    reservationId: 'res1',
    profile: { name: 'X' },
  });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'BAD_REQUEST');
});

test('register_companion uses a random token doc id (not room_date)', async () => {
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
    proof: proofFor(ctx),
    mode: 'register_companion',
    reservationId: 'res1',
    profile: { name: 'Companion', arrivalDate: '2026-09-01' },
  });

  assert.equal(result.ok, true);
  assert.match(result.data.guestToken, /^[a-f0-9]{32}$/);
  assert.notEqual(result.data.guestToken, '6-2_2026-09-01');
  assert.equal(ctx.guests.get(result.data.guestToken).companionGuest, true);
  assert.equal(ctx.guests.get(result.data.guestToken).aptId, '6-2');
});

const REG = { mode: 'register_primary', reservationId: 'res1', profile: { name: 'X', passportUrl: 'https://storage/p.jpg' } };
const mk = () => makeCtx({ reservations: {
  res1: { roomCode: '6-1', reservationNumber: '007004961_001', status: 'CONFIRMED' },
  res2: { roomCode: '6-2', reservationNumber: '009999999_001', status: 'CONFIRMED' },
} });

test('register_primary refuses a request with no proof', async () => {
  const ctx = mk();
  const r = await runGuestRegister(ctx, REG);
  assert.equal(r.ok, false);
  assert.equal(r.errorCode, 'FORBIDDEN');
  assert.equal(ctx.guests.size, 0);
});

test('register_primary refuses a forged or expired proof', async () => {
  const ctx = mk();
  const forged = proofLib.sign('other-secret', { bases: ['007004961'] });
  assert.equal((await runGuestRegister(ctx, { ...REG, proof: forged })).errorCode, 'FORBIDDEN');
  const old = proofLib.sign(SECRET, { bases: ['007004961'] }, Date.now() - 3 * 3600 * 1000);
  assert.equal((await runGuestRegister(ctx, { ...REG, proof: old })).errorCode, 'FORBIDDEN');
  assert.equal(ctx.guests.size, 0);
});

test('register_primary refuses a proof for a different booking', async () => {
  const ctx = mk();
  const other = proofLib.sign(SECRET, { bases: ['009999999'] });
  const r = await runGuestRegister(ctx, { ...REG, proof: other });
  assert.equal(r.errorCode, 'FORBIDDEN');
  assert.equal(ctx.guests.size, 0);
});

test('register_primary accepts a proof that covers the booking', async () => {
  const ctx = mk();
  const r = await runGuestRegister(ctx, { ...REG, proof: proofLib.sign(SECRET, { bases: ['007004961'] }) });
  assert.equal(r.ok, true);
});

test('register_primary fails closed when the server has no proof checker', async () => {
  const ctx = mk();
  delete ctx.verifyProof;
  const r = await runGuestRegister(ctx, { ...REG, proof: proofLib.sign(SECRET, { bases: ['007004961'] }) });
  assert.equal(r.errorCode, 'FORBIDDEN');
});

test('register_companion needs a proof for that booking', async () => {
  const ctx = mk();
  const p = { mode: 'register_companion', reservationId: 'res1', profile: { name: 'C' } };
  assert.equal((await runGuestRegister(ctx, p)).errorCode, 'FORBIDDEN');
  assert.equal((await runGuestRegister(ctx, { ...p, proof: proofLib.sign(SECRET, { bases: ['009999999'] }) })).errorCode, 'FORBIDDEN');
  assert.equal(ctx.guests.size, 0);
  assert.equal((await runGuestRegister(ctx, { ...p, proof: proofLib.sign(SECRET, { bases: ['007004961'] }) })).ok, true);
});

test('a guest cannot set the passport approval flags (admin only)', async () => {
  const ctx = mk();
  const pf = proofLib.sign(SECRET, { bases: ['007004961'] });
  const created = await runGuestRegister(ctx, { ...REG, proof: pf, profile: { ...REG.profile, passportScanResult: { overrideByAdmin: true, valid: true } } });
  assert.deepEqual(ctx.guests.get(created.data.guestToken).passportScanResult, {});
  await runGuestRegister(ctx, { mode: 'update_profile', guestToken: created.data.guestToken, profile: {}, passportScanResult: { overrideByAdmin: true } });
  assert.deepEqual(ctx.guests.get(created.data.guestToken).passportScanResult, {});
});

test('update_profile still works with only the secret guest token', async () => {
  const ctx = mk();
  const created = await runGuestRegister(ctx, { ...REG, proof: proofLib.sign(SECRET, { bases: ['007004961'] }) });
  const r = await runGuestRegister(ctx, { mode: 'update_profile', guestToken: created.data.guestToken, profile: { name: 'New Name' } });
  assert.equal(r.ok, true);
});
