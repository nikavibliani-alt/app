'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const proof = require('../lib/guest-proof');
const api = require('../controllers/guestApi');

const SECRET = 'test-secret';
const TOKEN_A = 'a'.repeat(32);
const TOKEN_B = 'b'.repeat(32);

function makeCtx(over = {}) {
  const data = {
    reservations: {
      '007004961_001': { reservationNumber: '007004961_001', roomCode: '6-1', checkin: '2026-10-12', checkout: '2026-10-15', status: 'OK',
        guest: 'Ahmed Ali', phone: '+995 555 111 222', email: 'ahmed@example.com', bookingId: 'HMABC12345', source: 'booking', tuyaPassword: '482913' },
      '007004961_002': { reservationNumber: '007004961_002', roomCode: '6-2', checkin: '2026-10-12', checkout: '2026-10-15', status: 'OK',
        guest: 'Ahmed Ali', phone: '+995 555 111 222', tuyaPassword: '777111' },
      '007005000_001': { reservationNumber: '007005000_001', roomCode: 'tab-1', checkin: '2026-10-12', checkout: '2026-10-14', status: 'OK',
        guest: 'Maria Garcia', phone: '+34 600 000 000', email: 'maria@example.com', bookingId: 'HMZZZ99999', tuyaPassword: '135790' },
      '007005100_001': { reservationNumber: '007005100_001', roomCode: 'orb-1', checkin: '2026-10-12', checkout: '2026-10-14', status: 'CANCELLED',
        guest: 'Cancelled Person', phone: '1' },
    },
    guests: {
      [TOKEN_A]: { isPrimaryGuest: true, passportUrl: 'https://x/p.jpg', matchedReservationId: '007004961_001', aptId: '6-1',
        arrivalDate: '2026-10-12', checkoutDate: '2026-10-15', relatedReservationIds: [], contact: '+995555111222', companionToken: 'join-token-aaaaaaaaaaaa' },
      [TOKEN_B]: { isPrimaryGuest: true, passportUrl: 'https://x/q.jpg', matchedReservationId: '007005000_001', aptId: 'tab-1',
        arrivalDate: '2026-10-12', checkoutDate: '2026-10-14' },
    },
    apartments: {
      '6-1': { propertyName: 'Maxela 6-1', address: '1 Test St', floorLabel: 'Floor 6', checkInTime: '15:00', doorCode: '4321#', wifiName: 'MaxelaWifi',
        wifiPass: 'secretwifi', doorPhotoUrl: 'https://x/door.jpg', videoUrl: 'https://x/v.mp4', tuyaDeviceId: 'DEV123',
        instructions: 'Enter code 4321# at the door', photoCaptions: ['Door code 4321#'], photos: ['https://x/1.jpg'], updatedAt: { toDate: () => new Date('2026-01-01') } },
      '6-2': { propertyName: 'Maxela 6-2', checkInTime: '15:00', doorCode: '9999#', wifiName: 'W2', wifiPass: 'p2' },
      'tab-1': { propertyName: 'Freedom 1', checkInTime: '14:00', doorCode: '5555#', wifiName: 'W3', wifiPass: 'p3' },
    },
    hk: {},
    elevator: { fs: { code: '2468', updatedAt: { toDate: () => new Date('2026-10-12T05:00:00Z') } }, rtdb: null },
    failures: [],
    counters: {},
    ...over,
  };
  const rows = o => Object.entries(o).map(([id, v]) => ({ id, ...v }));
  const ctx = {
    data,
    testClock: { today: '2026-10-12', hour: 16 },
    getReservation: async id => (data.reservations[id] ? { id, ...data.reservations[id] } : null),
    listReservationsByCheckin: async d => rows(data.reservations).filter(r => r.checkin === d),
    listReservationsByBookingIds: async ids => rows(data.reservations).filter(r => ids.includes(r.bookingId)),
    listReservationsByNumberPrefix: async b => rows(data.reservations).filter(r => r.reservationNumber >= b && r.reservationNumber <= b + ''),
    listGuestsByMatchedReservation: async id => rows(data.guests).filter(g => g.matchedReservationId === id),
    listGuestsByCompanionToken: async t => rows(data.guests).filter(g => g.companionToken === t),
    getGuest: async id => (data.guests[id] ? { id, ...data.guests[id] } : null),
    getApartment: async id => data.apartments[id] || null,
    getHkStatus: async (room, d) => data.hk[room + '_' + d] || null,
    readElevator: async () => data.elevator,
    addSearchFailure: async d => data.failures.push(d),
    rateLimit: async (key, max) => { data.counters[key] = (data.counters[key] || 0) + 1; return data.counters[key] > max; },
    signProof: p => proof.sign(SECRET, p),
    verifyProof: t => proof.verify(SECRET, t),
  };
  return Object.assign(ctx, over.ctx || {});
}
const IP = { ip: '1.2.3.4' };
const find = (ctx, p) => api.runGuestFind(ctx, { mode: 'find', ...p }, IP);

// ------------------------------------------------------------------ find

test('find: name + arrival date finds the booking and its sibling room, without phone, email or lock password', async () => {
  const ctx = makeCtx();
  const r = await find(ctx, { name: 'Ahmed Ali', arrival: '2026-10-12' });
  assert.equal(r.found, true);
  assert.equal(r.score, 3);
  assert.deepEqual(r.group.map(x => x.id).sort(), ['007004961_001', '007004961_002']);
  assert.equal(r.existing.id, TOKEN_A);
  const json = JSON.stringify(r);
  for (const secret of ['555 111', 'ahmed@example.com', '482913', '777111', 'HMABC12345', 'Maria']) assert.ok(!json.includes(secret), 'leaked: ' + secret);
});

test('find: a wrong name, a wrong date, or someone else is refused and logged', async () => {
  const ctx = makeCtx();
  assert.equal((await find(ctx, { name: 'Zed Nobody', arrival: '2026-10-12' })).found, false);
  assert.equal((await find(ctx, { name: 'Ahmed Ali', arrival: '2026-10-13' })).found, false);
  assert.equal((await find(ctx, { name: 'Cancelled Person', arrival: '2026-10-12' })).found, false);
  assert.equal(ctx.data.failures.length, 3);
  assert.equal(ctx.data.failures[0].input_name, 'Zed Nobody');
});

test('find: the channel booking number works with any date; reservation numbers do not', async () => {
  const ctx = makeCtx();
  const ok = await find(ctx, { name: 'hmabc 12345', arrival: '2026-01-01' });
  assert.equal(ok.found, true);
  assert.equal(ok.score, 10);
  const no = await find(ctx, { name: '007004961', arrival: '2026-01-01' });
  assert.equal(no.found, false);
});

test('find: asks for name and a real date, and is rate limited per address', async () => {
  const ctx = makeCtx();
  assert.equal((await find(ctx, { name: '', arrival: '2026-10-12' })).errorCode, 'BAD_REQUEST');
  assert.equal((await find(ctx, { name: 'Ahmed Ali', arrival: 'tomorrow' })).errorCode, 'BAD_REQUEST');
  let last;
  for (let i = 0; i < 22; i++) last = await find(ctx, { name: 'Zed Nobody', arrival: '2026-10-12' });
  assert.equal(last.errorCode, 'RATE_LIMITED');
});

test('existing: only with the proof from a successful find, and only for that booking', async () => {
  const ctx = makeCtx();
  const f = await find(ctx, { name: 'Ahmed Ali', arrival: '2026-10-12' });
  const ok = await api.runGuestFind(ctx, { mode: 'existing', reservationId: '007004961_001', reservationNumber: '007004961_001', proof: f.proof }, IP);
  assert.equal(ok.existing.id, TOKEN_A);
  const other = await api.runGuestFind(ctx, { mode: 'existing', reservationId: '007005000_001', reservationNumber: '007005000_001', proof: f.proof }, IP);
  assert.equal(other.errorCode, 'FORBIDDEN');
  const none = await api.runGuestFind(ctx, { mode: 'existing', reservationId: '007004961_001', reservationNumber: '007004961_001' }, IP);
  assert.equal(none.errorCode, 'FORBIDDEN');
  const forged = await api.runGuestFind(ctx, { mode: 'existing', reservationId: '007005000_001', reservationNumber: '007005000_001', proof: proof.sign('wrong', { bases: ['007005000'] }) }, IP);
  assert.equal(forged.errorCode, 'FORBIDDEN');
});

test('siblings: a guest sees only their own booking', async () => {
  const ctx = makeCtx();
  const mine = await api.runGuestFind(ctx, { mode: 'siblings', guestToken: TOKEN_A, reservationRef: '007004961_001' }, IP);
  assert.equal(mine.reservations.length, 2);
  const theirs = await api.runGuestFind(ctx, { mode: 'siblings', guestToken: TOKEN_A, reservationRef: '007005000_001' }, IP);
  assert.equal(theirs.errorCode, 'FORBIDDEN');
  const nobody = await api.runGuestFind(ctx, { mode: 'siblings', guestToken: 'c'.repeat(32), reservationRef: '007004961_001' }, IP);
  assert.equal(nobody.errorCode, 'FORBIDDEN');
  const junk = await api.runGuestFind(ctx, { mode: 'siblings', guestToken: '6-1_2026-10-12', reservationRef: '007004961_001' }, IP);
  assert.equal(junk.errorCode, 'FORBIDDEN');
});

test('companion: the join link finds the group; a short or unknown token finds nothing', async () => {
  const ctx = makeCtx();
  const r = await api.runGuestFind(ctx, { mode: 'companion', joinToken: 'join-token-aaaaaaaaaaaa' }, IP);
  assert.equal(r.found, true);
  assert.equal(r.primary.id, TOKEN_A);
  assert.equal(r.reservations.length, 2);
  assert.ok(!JSON.stringify(r).includes('555 111'));
  assert.equal((await api.runGuestFind(ctx, { mode: 'companion', joinToken: 'short' }, IP)).found, false);
  assert.equal((await api.runGuestFind(ctx, { mode: 'companion', joinToken: 'x'.repeat(30) }, IP)).found, false);
});

// ------------------------------------------------------------------ stay

const stay = (ctx, p) => api.runGuestStay(ctx, p, IP);
const at = (ctx, today, hour) => { ctx.testClock = { today, hour }; return ctx; };

test('stay: before arrival nothing secret is sent (door code, Wi-Fi, door photo, lock password, elevator, device id)', async () => {
  const ctx = at(makeCtx(), '2026-10-11', 18);
  const r = await stay(ctx, { guestToken: TOKEN_A });
  assert.equal(r.unlocked, false);
  assert.equal(r.reason, 'before_arrival');
  const json = JSON.stringify(r);
  for (const secret of ['4321', 'MaxelaWifi', 'secretwifi', 'door.jpg', 'v.mp4', '482913', '777111', '2468', 'DEV123']) assert.ok(!json.includes(secret), 'leaked: ' + secret);
  assert.equal(r.apt.address, '1 Test St');           // the public part still works
  assert.equal(r.apt.checkInTime, '15:00');
  assert.equal(r.elevator, null);
});

test('stay: arrival day, before check-in time, stays locked; at check-in time it opens', async () => {
  const early = await stay(at(makeCtx(), '2026-10-12', 10), { guestToken: TOKEN_A });
  assert.equal(early.unlocked, false);
  assert.ok(!JSON.stringify(early).includes('4321'));
  const open = await stay(at(makeCtx(), '2026-10-12', 15), { guestToken: TOKEN_A });
  assert.equal(open.unlocked, true);
  assert.equal(open.apt.doorCode, '4321#');
  assert.equal(open.apt.wifiPass, 'secretwifi');
  assert.equal(open.reservation.tuyaPassword, '482913');
  assert.equal(open.elevator.code, '2468');
  assert.equal(open.elevator.updatedAt.seconds, Math.floor(new Date('2026-10-12T05:00:00Z').getTime() / 1000));
  assert.equal(open.apt.tuyaDeviceId, undefined);     // never leaves the server
});

test('stay: early unlock only when housekeeping is done (from 11:00), or when the owner unlocked by hand', async () => {
  const hkCtx = at(makeCtx(), '2026-10-12', 12);
  hkCtx.data.hk['6-1_2026-10-12'] = { done: true };
  assert.equal((await stay(hkCtx, { guestToken: TOKEN_A })).unlocked, true);
  const hk10 = at(makeCtx(), '2026-10-12', 10);
  hk10.data.hk['6-1_2026-10-12'] = { done: true };
  assert.equal((await stay(hk10, { guestToken: TOKEN_A })).unlocked, false);
  const manual = at(makeCtx(), '2026-10-12', 9);
  manual.data.guests[TOKEN_A].manualUnlock = true;
  assert.equal((await stay(manual, { guestToken: TOKEN_A })).unlocked, true);
});

test('stay: mid-stay open, after the stay locked again, cancelled or blocked never open', async () => {
  assert.equal((await stay(at(makeCtx(), '2026-10-13', 3), { guestToken: TOKEN_A })).unlocked, true);
  const over = await stay(at(makeCtx(), '2026-10-15', 21), { guestToken: TOKEN_A });
  assert.equal(over.unlocked, false);
  assert.ok(!JSON.stringify(over).includes('4321'));
  const cancelled = at(makeCtx(), '2026-10-13', 12);
  for (const k of Object.keys(cancelled.data.reservations)) if (k.startsWith('007004961')) cancelled.data.reservations[k].status = 'CANCELLED';
  const c = await stay(cancelled, { guestToken: TOKEN_A });
  assert.equal(c.unlocked, false);
  assert.equal(c.ownCancelled, true);
  const blocked = at(makeCtx(), '2026-10-13', 12);
  blocked.data.guests[TOKEN_A].blocked = true;
  assert.equal((await stay(blocked, { guestToken: TOKEN_A })).unlocked, false);
  const disabled = at(makeCtx(), '2026-10-13', 12);
  disabled.data.guests[TOKEN_A].accessDisabledByAdmin = true;
  assert.equal((await stay(disabled, { guestToken: TOKEN_A })).unlocked, false);
});

test('stay: a guest can never get another guest\'s apartment or lock password', async () => {
  const ctx = at(makeCtx(), '2026-10-13', 12);
  const r = await stay(ctx, { guestToken: TOKEN_A, aptId: 'tab-1' });     // B's room
  assert.equal(r.aptId, '6-1');
  const json = JSON.stringify(r);
  assert.ok(!json.includes('5555') && !json.includes('135790') && !json.includes('Maria'));
  assert.equal((await stay(ctx, { guestToken: 'd'.repeat(32) })).errorCode, 'NOT_FOUND');
  assert.equal((await stay(ctx, { guestToken: 'not-a-token' })).errorCode, 'NOT_FOUND');
});

test('stay: a multi-room booking can switch to its other room', async () => {
  const ctx = at(makeCtx(), '2026-10-13', 12);
  const r = await stay(ctx, { guestToken: TOKEN_A, aptId: '6-2' });
  assert.equal(r.aptId, '6-2');
  assert.equal(r.apt.doorCode, '9999#');
  assert.equal(r.reservation.tuyaPassword, '777111');
});

test('stay: without a guest only the public part of an apartment is sent', async () => {
  const r = await stay(at(makeCtx(), '2026-10-13', 12), { aptId: '6-1' });
  assert.equal(r.unlocked, false);
  assert.equal(r.apt.address, '1 Test St');
  const json = JSON.stringify(r);
  for (const secret of ['4321', 'MaxelaWifi', 'secretwifi', 'door.jpg', 'DEV123']) assert.ok(!json.includes(secret));
});

test('stay: the clock cannot be set from the request', async () => {
  const ctx = at(makeCtx(), '2026-10-11', 3);
  const r = await stay(ctx, { guestToken: TOKEN_A, __hour: 23, today: '2026-10-13', hour: 23 });
  assert.equal(r.unlocked, false);
});

// ------------------------------------------------------------------ no Gemini

test('the guest functions no longer include any passport scan or Gemini call', () => {
  assert.equal(api.runGuestScan, undefined);
  assert.equal(typeof api.registerCloudFunctions, 'function');
  const src = require('fs').readFileSync(require.resolve('../controllers/guestApi.js'), 'utf8');
  assert.equal(/gemini|guestScan/i.test(src), false);
});

// ----------------------------------------------------------- helpers

test('proof: tampered, expired or wrong-secret proofs are rejected', () => {
  const t = proof.sign(SECRET, { bases: ['1'] }, 1000, 5000);
  assert.deepEqual(proof.verify(SECRET, t, 2000).bases, ['1']);
  assert.equal(proof.verify(SECRET, t, 7000), null);
  assert.equal(proof.verify('other', t, 2000), null);
  assert.equal(proof.verify(SECRET, t.slice(0, -2) + 'xx', 2000), null);
  assert.equal(proof.verify(SECRET, 'garbage', 2000), null);
});

test('apartment filter: locked hides secrets and masks numbers in the text, always hides the device id', () => {
  const apt = { doorCode: '1', wifiName: 'w', wifiPass: 'p', doorPhotoUrl: 'u', videoUrl: 'v', tuyaDeviceId: 'd', instructions: 'code 4321# ok', photoCaptions: ['x 1234'], address: 'a' };
  const locked = api.filterApt(apt, false);
  assert.deepEqual(Object.keys(locked).sort(), ['address', 'instructions', 'photoCaptions']);
  assert.ok(!locked.instructions.includes('4321'));
  const open = api.filterApt(apt, true);
  assert.equal(open.doorCode, '1');
  assert.equal(open.tuyaDeviceId, undefined);
  assert.equal(open.instructions, 'code 4321# ok');
});

test('guest-match.js is an exact copy of the guest page code', async () => {
  const { build } = await import('../../scripts/sync-guest-match.js');
  const current = fs.readFileSync(path.join(__dirname, '../lib/guest-match.js'), 'utf8');
  assert.equal(current, build(), 'run: node scripts/sync-guest-match.js');
});
