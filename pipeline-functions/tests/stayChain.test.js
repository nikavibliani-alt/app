'use strict';
// Back-to-back stays: the shared rule (shared/stay-chain.js, server copy lib/stay-chain.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const S = require('../lib/stay-chain');
const bot = require('../../whatsapp-functions/guestLookup');

const res = (id, room, checkin, checkout, extra) => ({ id, reservationNumber: id, roomCode: room, checkin, checkout, status: 'OK2', guest: 'Ann Lee', phone: '+995 555 12 34 56', ...extra });
const A = res('A', '7-2', '2026-11-14', '2026-11-21');
const B = res('B', '7-2', '2026-11-21', '2026-11-24');
const C = res('C', '7-2', '2026-11-24', '2026-11-27');
const ids = list => list.map(r => r.id);
const key = (a, b) => S.stayPairKey(a, b);

test('the shared file and the server copy hold the same rule', () => {
  const cut = file => { const s = fs.readFileSync(path.join(__dirname, '../..', file), 'utf8'); return s.slice(s.indexOf('// STAY-CHAIN-LOGIC-START'), s.indexOf('// STAY-CHAIN-LOGIC-END')).replace(/\s+/g, ' '); };
  assert.ok(cut('shared/stay-chain.js').length > 500);
  assert.equal(cut('shared/stay-chain.js'), cut('pipeline-functions/lib/stay-chain.js'));
});

test('names: case, extra spaces and the room tag do not matter', () => {
  assert.equal(S.stayName({ guest: 'Emma 01 Bonfiglio' }), 'emma bonfiglio');
  assert.equal(S.stayName({ guest: '  EMMA   Bonfiglio ' }), 'emma bonfiglio');
  assert.equal(S.stayName({ guest: 'Emma Bonfiglio 02' }), 'emma bonfiglio');
  assert.equal(S.stayName({ firstName: 'Emma', lastName: 'Bonfiglio' }), 'emma bonfiglio');
});

test('how a booking follows another one', () => {
  const t = (b, a = A) => S.stayPairType(a, b);
  assert.equal(t(B), 'strong', 'same unit, name, checkout day, phone');
  assert.equal(t(res('B', '7-2', '2026-11-21', '2026-11-24', { phone: '00995555123456' })), 'strong', 'same phone written differently');
  assert.equal(t(res('B', '7-2', '2026-11-21', '2026-11-24', { phone: '' })), 'weak', 'phone missing on one side');
  assert.equal(t(res('B', '7-2', '2026-11-21', '2026-11-24', { phone: '' }), res('A', '7-2', '2026-11-14', '2026-11-21', { phone: '' })), 'weak', 'no phone on either');
  assert.equal(t(res('B', '7-2', '2026-11-21', '2026-11-24', { phone: '+995 599 99 99 99' })), 'none', 'a different phone is never linked');
  assert.equal(t(res('B', '7-2', '2026-11-22', '2026-11-24')), 'none', 'a 1-day gap is a new stay');
  assert.equal(t(res('B', '7-2', '2026-11-20', '2026-11-24')), 'none', 'overlapping is not an extension');
  assert.equal(t(res('B', '7-2', '2026-11-21', '2026-11-24', { guest: 'Bob Lee' })), 'none');
  assert.equal(t(res('B', '7-2', '2026-11-21', '2026-11-24', { status: 'CANCELLED' })), 'none');
  assert.equal(t(res('B', '7-2', '2026-11-21', '2026-11-24', { status: 'CL' })), 'none');
  assert.equal(S.stayPairType(res('A', '7-2', '2026-11-14', '2026-11-21', { status: 'CANCELLED' }), B), 'none');
  assert.equal(t(res('B', '6-1', '2026-11-21', '2026-11-24')), 'move', 'another unit, same phone');
  assert.equal(t(res('B', '6-1', '2026-11-21', '2026-11-24', { phone: '' })), 'move', 'another unit, same name, no phone');
  assert.equal(t(res('B', '6-1', '2026-11-21', '2026-11-24', { phone: '+995 599 99 99 99' })), 'none');
  assert.equal(S.stayPairType(A, A), 'none');
});

test('the owner decision: confirm and reject; a different phone can never be confirmed into a link', () => {
  const weak = res('B', '7-2', '2026-11-21', '2026-11-24', { phone: '' });
  assert.equal(S.stayLinkStatus(A, B, {}), 'auto');
  assert.equal(S.stayLinkStatus(A, weak, {}), 'pending');
  assert.equal(S.stayLinkStatus(A, weak, { [key(A, weak)]: 'confirmed' }), 'confirmed');
  assert.equal(S.stayLinkStatus(A, weak, { [key(A, weak)]: 'rejected' }), 'rejected');
  assert.equal(S.stayLinkStatus(A, B, { [key(A, B)]: 'rejected' }), 'rejected', 'Unlink works on an automatic link too');
  assert.equal(S.stayLinkStatus(A, weak, { [key(A, weak)]: 'pending' }), 'pending', 'a stored pending is not a decision');
  const other = res('B', '7-2', '2026-11-21', '2026-11-24', { phone: '+995 599 99 99 99' });
  assert.equal(S.stayLinkStatus(A, other, { [key(A, other)]: 'confirmed' }), 'none');
});

test('the whole stay: chains repeat, in both directions, and stop at a rejected or unconfirmed link', () => {
  const pool = [C, A, B];
  assert.deepEqual(ids(S.stayChainOf(A, pool).chain), ['A', 'B', 'C']);
  assert.deepEqual(ids(S.stayChainOf(C, pool).chain), ['A', 'B', 'C']);
  const info = S.stayChainOf(B, pool);
  assert.equal(info.start, '2026-11-14');
  assert.equal(info.end, '2026-11-27');
  assert.equal(info.pending, null);
  assert.deepEqual(ids(S.stayChainOf(A, pool, { [key(B, C)]: 'rejected' }).chain), ['A', 'B']);
  assert.deepEqual(ids(S.stayChainOf(C, pool, { [key(B, C)]: 'rejected' }).chain), ['C']);
  const weakC = { ...C, phone: '' };
  const p = S.stayChainOf(A, [A, B, weakC]);
  assert.deepEqual(ids(p.chain), ['A', 'B']);
  assert.equal(p.end, '2026-11-24');
  assert.equal(p.pending.id, 'C', 'the unconfirmed next booking is reported as pending');
  assert.deepEqual(ids(S.stayChainOf(A, [A, B, weakC], { [key(B, weakC)]: 'confirmed' }).chain), ['A', 'B', 'C']);
  assert.deepEqual(ids(S.stayChainOf(weakC, [A, B, weakC]).chain), ['C'], 'the pending booking alone is its own stay');
});

test('cancelling either booking removes the link', () => {
  assert.deepEqual(ids(S.stayChainOf(A, [A, { ...B, status: 'CANCELLED' }, C]).chain), ['A']);
  assert.deepEqual(ids(S.stayChainOf(C, [A, { ...B, status: 'CANCELLED' }, C]).chain), ['C']);
});

test('moving guest: only when the guest does not also continue in the unit', () => {
  const other = res('M', '6-1', '2026-11-21', '2026-11-24');
  assert.equal(S.stayMovingTo(A, [A, other]).id, 'M');
  assert.equal(S.stayMovingTo(A, [A, B, other]), null, 'they stay in 7-2 as well: not a move');
  assert.equal(S.stayMovingTo(A, [A, B, other], { [key(A, B)]: 'rejected' }).id, 'M');
  // a group in two rooms that extends only one of them: the other room is not "moving"
  const room2 = res('G', '6-1', '2026-11-14', '2026-11-21');
  assert.equal(S.stayMovingTo(A, [A, room2, other]), null, '6-1 already continues the guest who was in 6-1');
  assert.equal(S.stayMovingTo(A, [A, res('M', '6-1', '2026-11-21', '2026-11-24', { phone: '+995 599 99 99 99' })]), null);
});

test('classify: strong / weak / moving / none, with the chain', () => {
  assert.equal(S.stayClassify(A, [A, B, C]).kind, 'strong');
  assert.deepEqual(ids(S.stayClassify(A, [A, B, C]).chain), ['A', 'B', 'C']);
  assert.equal(S.stayClassify(A, [A, { ...B, phone: '' }]).kind, 'weak');
  assert.equal(S.stayClassify(A, [A, res('M', '6-1', '2026-11-21', '2026-11-24')]).kind, 'move');
  assert.equal(S.stayClassify(A, [A, res('N', '7-2', '2026-11-22', '2026-11-24')]).kind, 'none');
});

test('guest view: a single booking is untouched; a linked one gets the stay dates; one stay is shown once', () => {
  const lone = S.stayViews([A], [A], {});
  assert.deepEqual(lone, [A]);
  const [v, ...rest] = S.stayViews([A], [A, B, C], {});
  assert.equal(rest.length, 0);
  assert.deepEqual([v.id, v.checkin, v.checkout, v.ownCheckin, v.ownCheckout], ['A', '2026-11-14', '2026-11-27', '2026-11-14', '2026-11-21']);
  assert.deepEqual(v.stayBookings.map(b => b.id), ['A', 'B', 'C']);
  assert.equal(v.stayPending, null);
  assert.deepEqual(S.stayViews([A, B], [A, B, C], {}, 'B').map(r => r.id), ['B'], 'the guest own booking is the one shown');
  assert.deepEqual(S.stayViews([v], [A, B, C], {}), [v], 'applying it again changes nothing');
  assert.deepEqual(S.stayViews([v], [A, { ...B, status: 'CANCELLED' }, C], {}), [A], 'cancelled: back to the booking own dates');
  assert.deepEqual(S.stayViews([v], [], {}), [v], 'its unit not loaded yet: the stay dates are kept, not reset');
  const pending = S.stayViews([A], [A, { ...B, phone: '' }], {})[0];
  assert.equal(pending.checkout, '2026-11-21', 'unconfirmed: the stay is not longer yet');
  assert.equal(pending.stayPending.id, 'B');
  assert.equal(S.stayUntil(pending), '2026-11-24');
  assert.equal(S.stayUntil(A), '2026-11-21');
});

test('the booking that is current at a moment, and when a pending extension takes over the screen', () => {
  const v = S.stayViews([A], [{ ...A, tuyaPassword: '111' }, { ...B, tuyaPassword: '222' }], {})[0];
  const at = (day, min) => S.stayCurrentBooking(v, day, min, 12 * 60).id;
  assert.equal(at('2026-11-18', 600), 'A');
  assert.equal(at('2026-11-21', 11 * 60 + 59), 'A', 'changeover day before check-out time');
  assert.equal(at('2026-11-21', 12 * 60), 'B', 'after check-out time the next booking is current');
  assert.equal(at('2026-11-30', 0), 'B');
  assert.equal(S.stayCurrentBooking(v, '2026-11-21', 800, 12 * 60).tuyaPassword, '222');
  const p = S.stayViews([A], [A, { ...B, phone: '' }], {})[0];
  const due = (day, min) => !!S.stayPendingDue(p, day, min, 12 * 60);
  assert.equal(due('2026-11-20', 900), false);
  assert.equal(due('2026-11-21', 11 * 60 + 59), false, 'normal until the first booking check-out time');
  assert.equal(due('2026-11-21', 12 * 60), true);
  assert.equal(due('2026-11-23', 60), true);
  assert.equal(due('2026-11-24', 900), true);
  assert.equal(due('2026-11-25', 0), false, 'after the extension itself would be over');
  assert.equal(S.stayMinutes('11:30'), 690);
  assert.equal(S.stayMinutes(''), 720);
});

// The bot's Rule A cases (whatsapp-functions/guestLookup.test.js), copied: with every unconfirmed link confirmed,
// this rule must give the same chain as the bot's stayChain.
const B2B = [
  { reservationNumber: 'R0', roomCode: '7-2', checkin: '2026-11-08', checkout: '2026-11-12', status: 'OK2', guest: 'Someone Else' },
  { reservationNumber: 'R1', roomCode: '7-2', checkin: '2026-11-12', checkout: '2026-11-14', status: 'OK2', guest: 'Akbar Nikbakht' },
  { reservationNumber: 'R2', roomCode: '7-2', checkin: '2026-11-14', checkout: '2026-11-21', status: 'OK2', guest: 'Akbar Nikbakht' },
  { reservationNumber: 'R3', roomCode: '7-2', checkin: '2026-11-21', checkout: '2026-11-24', status: 'OK2', guest: 'Akbar  Nikbakht' },
  { reservationNumber: 'R4', roomCode: '7-2', checkin: '2026-11-24', checkout: '2026-11-27', status: 'OK2', firstName: 'Akbar', lastName: 'Nikbakht' },
  { reservationNumber: 'R5', roomCode: '7-2', checkin: '2026-11-27', checkout: '2026-12-06', status: 'OK2', guest: 'AKBAR NIKBAKHT' },
  { reservationNumber: 'R6', roomCode: '7-2', checkin: '2026-12-30', checkout: '2027-01-05', status: 'OK2', guest: 'Akbar Nikbakht' },
  { reservationNumber: 'R7', roomCode: '7-2', checkin: '2026-12-06', checkout: '2026-12-09', status: 'CL', guest: 'Akbar Nikbakht' },
];
const GAP = [
  { reservationNumber: 'A', roomCode: '6-2', checkin: '2026-11-01', checkout: '2026-11-05', guest: 'Ann Lee' },
  { reservationNumber: 'B', roomCode: '6-2', checkin: '2026-11-05', checkout: '2026-11-08', guest: 'Ann Lee' },
  { reservationNumber: 'C', roomCode: '6-2', checkin: '2026-11-09', checkout: '2026-11-12', guest: 'Ann Lee' },
];
const NONAME = [{ reservationNumber: 'A', roomCode: '6-2', checkin: '2026-11-01', checkout: '2026-11-05' }, { reservationNumber: 'B', roomCode: '6-2', checkin: '2026-11-05', checkout: '2026-11-08' }];

test('same chains as the bot Rule A, on the bot test cases', () => {
  for (const rows of [B2B, GAP, NONAME]) {
    const allConfirmed = {};
    rows.forEach(a => rows.forEach(b => { allConfirmed[S.stayPairKey(a, b)] = 'confirmed'; }));
    for (const r of rows.filter(x => x.status !== 'CL')) {
      assert.deepEqual(S.stayChainOf(r, rows, allConfirmed).chain.map(x => x.reservationNumber), bot.stayChain(r, rows).map(x => x.reservationNumber), 'chain of ' + r.reservationNumber);
    }
  }
});
