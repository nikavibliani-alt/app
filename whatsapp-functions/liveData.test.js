'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { checkinPageState, liveContextLines, nextArrivalIn, ownerStayNote, loadLiveStay, checkinOpenWithLiveData } = require('./liveData');
const { deliverReply, parseAiReply } = require('./replyDelivery');

// Tbilisi is UTC+4: 10:00 Tbilisi = 06:00 UTC.
const at = (ymd, tbilisiHour) => Date.parse(`${ymd}T00:00:00Z`) + (tbilisiHour - 4) * 3600e3;
const FORM = { aptId: '6-2', arrivalDate: '2026-10-17', name: 'Anna' };
const RES = { reservationNumber: '007000001', roomCode: '6-2', checkin: '2026-10-17', checkout: '2026-10-20', status: 'OK' };

test('guestUnlock.js is the same unlock logic as shared/guest-unlock.js (no drift)', () => {
  const fnOf = (src) => src.slice(src.indexOf('function computeGuestUnlock'), src.indexOf('\n}\n', src.indexOf('function computeGuestUnlock')) + 2);
  const ours = fnOf(fs.readFileSync(path.join(__dirname, 'guestUnlock.js'), 'utf8'));
  const shared = fnOf(fs.readFileSync(path.join(__dirname, '..', 'shared', 'guest-unlock.js'), 'utf8'));
  assert.ok(ours.length > 500);
  assert.equal(ours, shared);
});

test('checkinPageState: same answers as the guest page', async (t) => {
  const st = (o) => checkinPageState({ form: FORM, reservation: RES, checkInTime: '15:00', ...o });
  await t.test('arrival day 10:00, not cleaned: locked', () => assert.deepEqual(st({ nowMs: at('2026-10-17', 10) }), { unlocked: false, reason: 'awaiting_hk_or_hour', label: 'Waiting' }));
  await t.test('arrival day 10:00, cleaned: locked until 11', () => assert.equal(st({ nowMs: at('2026-10-17', 10), hkDoneToday: true }).reason, 'hk_ready_wait_11'));
  await t.test('arrival day 12:00, cleaned: unlocked early', () => assert.deepEqual(st({ nowMs: at('2026-10-17', 12), hkDoneToday: true }), { unlocked: true, reason: 'hk_early', label: 'Unlocked early' }));
  await t.test('arrival day 12:00, cleaned yesterday: unlocked early', () => assert.equal(st({ nowMs: at('2026-10-17', 12), hkDoneYesterday: true }).unlocked, true));
  await t.test('arrival day 15:00: unlocked', () => assert.equal(st({ nowMs: at('2026-10-17', 15) }).reason, 'check_in_hour'));
  await t.test('mid-stay: unlocked', () => assert.equal(st({ nowMs: at('2026-10-18', 9) }).reason, 'mid_stay'));
  await t.test('admin locked: locked', () => assert.equal(checkinPageState({ form: { ...FORM, accessDisabledByAdmin: true }, reservation: RES, nowMs: at('2026-10-18', 9) }).reason, 'admin_disabled_indefinite'));
  await t.test('cancelled booking: locked', () => assert.equal(st({ reservation: { ...RES, status: 'CL' }, nowMs: at('2026-10-18', 9) }).reason, 'cancelled'));
  await t.test('no form: null', () => assert.equal(checkinPageState({ form: null, nowMs: 0 }), null));
});

test('checkinOpenWithLiveData: upgrades to yes when the page is unlocked early, never downgrades', () => {
  assert.equal(checkinOpenWithLiveData('no', { unlocked: true }), 'yes');
  assert.equal(checkinOpenWithLiveData('no', { unlocked: false }), 'no');
  assert.equal(checkinOpenWithLiveData('yes', { unlocked: false }), 'yes');
  assert.equal(checkinOpenWithLiveData('unknown', null), 'unknown');
});

test('liveContextLines', () => {
  assert.deepEqual(liveContextLines({ page: { unlocked: true, reason: 'hk_early' }, airportTransfer: { smallCarPrice: 70, largeCarPrice: 100, maxGuestsPerCar: 7 } }), [
    'Check-in page unlocked right now (door code and instructions visible to the guest): yes (unlocked early because the unit is already cleaned)',
    'Airport transfer prices (only if the guest asks the price): small car 70 GEL, large car 100 GEL, up to 7 guests per car; booked on the check-in page under Services.',
  ]);
  assert.deepEqual(liveContextLines({ page: null, airportTransfer: null }), []);
});

test('nextArrivalIn + ownerStayNote: next booking in the same unit, for the owner only', () => {
  const others = [
    { ...RES, reservationNumber: '9', checkin: '2026-10-25' },
    { ...RES, reservationNumber: '8', checkin: '2026-10-20' },
    { ...RES, reservationNumber: '7', checkin: '2026-10-20', status: 'CL' },
    { ...RES, reservationNumber: '6', roomCode: '6-4', checkin: '2026-10-20' },
    RES,
  ];
  const next = nextArrivalIn(others, { roomCode: '6-2', fromDate: '2026-10-20', excludeReservation: RES.reservationNumber });
  assert.deepEqual(next, { date: '2026-10-20', sameDay: true });
  assert.equal(ownerStayNote({ roomCode: '6-2', reservation: RES, next }), 'Stay 2026-10-17 to 2026-10-20; next arrival in 6-2: 2026-10-20 (same day as this checkout)');
  assert.equal(ownerStayNote({ roomCode: '6-2', reservation: RES, next: null }), 'Stay 2026-10-17 to 2026-10-20; next arrival in 6-2: none in the next 30 days');
  assert.equal(nextArrivalIn([{ ...RES, reservationNumber: '9', checkin: '2026-12-01' }], { roomCode: '6-2', fromDate: '2026-10-20' }), null, 'beyond 30 days');
});

/** Read-only Firestore fake that records what was read; supports the queries liveData uses. */
function fakeDb(docs) {
  const reads = [];
  const query = (col, filters = [], selected = null) => ({
    where: (f, op, v) => query(col, [...filters, [f, op, v]], selected),
    select: (...fields) => query(col, filters, fields),
    get: async () => {
      reads.push({ col, filters: filters.map(([f, op, v]) => [f, op, typeof v === 'object' ? v.id : v]), selected });
      let rows = Object.entries(docs[col] || {}).map(([id, d]) => ({ id, d }));
      for (const [f, , v] of filters) rows = rows.filter((r) => (f === '__name__' ? r.id === v.id : r.d[f] === v));
      return { empty: !rows.length, docs: rows.map((r) => ({ id: r.id, data: () => r.d, get: (k) => r.d[k] })) };
    },
  });
  return {
    reads,
    collection: (col) => ({
      ...query(col),
      doc: (id) => ({ id, get: async () => { reads.push({ col, doc: id }); const d = (docs[col] || {})[id]; return { exists: !!d, get: (k) => d?.[k], data: () => d }; } }),
    }),
  };
}

test('loadLiveStay: reads only what it needs, never door codes', async () => {
  const db = fakeDb({
    checkin_apartments: { '6-2': { checkInTime: '15:00', doorCode: '4821' } },
    hk_status: { '6-2_2026-10-17': { done: true } },
    checkin_admin: { config: { services: [{ id: 'airport_transfer', smallCarPrice: 70, largeCarPrice: 100, maxGuestsPerCar: 7 }] } },
    reservations: { a: RES, b: { ...RES, reservationNumber: '8', checkin: '2026-10-21' } },
  });
  const live = await loadLiveStay(db, { roomCode: '6-2', form: FORM, reservation: RES, nowMs: at('2026-10-17', 12), log: { warn: () => {} } });
  assert.deepEqual(live.page, { unlocked: true, reason: 'hk_early', label: 'Unlocked early' });
  assert.deepEqual(live.airportTransfer, { smallCarPrice: 70, largeCarPrice: 100, maxGuestsPerCar: 7 });
  assert.equal(live.ownerNote, 'Stay 2026-10-17 to 2026-10-20; next arrival in 6-2: 2026-10-21');
  const aptRead = db.reads.find((r) => r.col === 'checkin_apartments');
  assert.deepEqual(aptRead.selected, ['checkInTime'], 'only checkInTime is read from checkin_apartments');
  assert.ok(!JSON.stringify(live).includes('4821'));
});

test('loadLiveStay: every read is optional; failures leave the part out', async () => {
  const broken = { collection: () => { throw new Error('unavailable'); } };
  const live = await loadLiveStay(broken, { roomCode: '6-2', form: FORM, reservation: RES, nowMs: at('2026-10-17', 12), log: { warn: () => {} } });
  assert.deepEqual(live, { page: null, airportTransfer: null, ownerNote: '' });
});

test('deliverReply: escalation alerts carry the stay and next-arrival note', async () => {
  const calls = [];
  const rec = (n) => async (...a) => { calls.push([n, ...a]); return { ok: true, id: 'x' }; };
  const deps = { log: { error: () => {}, warn: () => {}, log: () => {} }, humanize: async () => {}, preSendCheck: async () => 'send', sendVideo: rec('sendVideo'), sendText: rec('sendText'), storeAssistant: rec('storeAssistant'), writeAlert: rec('writeAlert'), notifyOwner: rec('notifyOwner'), notifyOwnerThrottled: rec('notifyOwnerThrottled'), finishPending: rec('finishPending') };
  await deliverReply(parseAiReply('Let me check availability based on the next guest arrival and I will get back to you shortly. [ESCALATE]'),
    { name: 'A', guestText: 'Can we check out at 3pm?', mode: 'available', ownerNote: 'Stay 2026-10-17 to 2026-10-20; next arrival in 6-2: 2026-10-20 (same day as this checkout)' }, deps);
  assert.equal(calls.find((c) => c[0] === 'notifyOwner')[1], 'Guest needs help (mode available): Can we check out at 3pm? [Stay 2026-10-17 to 2026-10-20; next arrival in 6-2: 2026-10-20 (same day as this checkout)]');
});
