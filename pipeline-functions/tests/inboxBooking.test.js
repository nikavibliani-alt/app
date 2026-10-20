'use strict';
// Made-up data only.
const test = require('node:test');
const assert = require('node:assert');
const B = require('../controllers/inboxBooking');

const NIKA = { token: { email: 'nikavibliani@gmail.com', email_verified: true } };
const BN = '7000000001';
const NOW = Date.UTC(2026, 10, 9, 8, 0, 0);          // 12:00 on 9 Nov in Tbilisi
const stamp = m => ({ toMillis: () => m });

function fakeDb(seed) {
  const store = new Map(Object.entries(seed));
  const snap = p => ({ id: p.split('/').pop(), exists: store.has(p), data: () => store.get(p) });
  const col = name => ({
    doc: id => ({ path: name + '/' + id, get: async () => snap(name + '/' + id), set: async d => { store.set(name + '/' + id, d); }, collection: sub => col(name + '/' + id + '/' + sub) }),
    where(f, op, v) { return { ...this, f: [...(this.f || []), [f, op, v]] }; },
    limit() { return this; },
    get: async function () {
      const rows = [...store.entries()].filter(([p]) => p.startsWith(name + '/') && p.split('/').length === name.split('/').length + 1)
        .filter(([, d]) => (this.f || []).every(([f, op, v]) => op === '==' ? d[f] === v : op === '>=' ? String(d[f]) >= v : String(d[f]) < v));
      return { docs: rows.map(([p]) => snap(p)) };
    },
  });
  return { store, collection: col };
}
const seed = () => ({
  [`inbox_conversations/${BN}`]: { guestName: 'Test Guest', reservationId: 'res1', roomCode: '6-2', checkin: '2026-11-09', checkout: '2026-11-19', reservationStatus: 'OK2' },
  [`inbox_conversations/${BN}/messages/g1`]: { direction: 'guest', text: 'Can we get extra towels,\nplease?', sentAt: stamp(1) },
  [`inbox_conversations/${BN}/messages/h1`]: { direction: 'host', text: 'Sure', sentAt: stamp(2) },
  'reservations/res1': { guest: 'Test Guest', reservationNumber: '555', roomCode: '6-2', checkin: '2026-11-09', checkout: '2026-11-19', status: 'OK2', adults: 2, children: 1 },
  'reservations/res0': { guest: 'Test Guest', reservationNumber: '444', roomCode: '0-4', checkin: '2025-05-01', checkout: '2025-05-04', status: 'OK2' },
  'checkin_guests/f1': { matchedReservationId: '555_1', submittedAt: stamp(5), unlockState: 'unlocked', unlockReason: 'check_in_hour' },
  'hk_status/6-2_2026-11-09': { done: true },
});
const deps = db => ({ db, nowMs: () => NOW, ts: stamp });

test('booking panel: the facts, read only', async () => {
  const db = fakeDb(seed());
  const before = JSON.stringify([...db.store.entries()]);
  const r = await B.bookingPanel(NIKA, { bookingNumber: BN }, deps(db));
  assert.deepStrictEqual(r.reservation, { checkin: '2026-11-09', checkout: '2026-11-19', nights: 10, room: '6-2', status: 'OK2', guests: 3, guestName: 'Test Guest' });
  assert.strictEqual(r.reservationNumber, '555');
  assert.deepStrictEqual(r.form, { filled: true, submittedAt: 5 });
  assert.deepStrictEqual(r.access, { on: true, text: 'Door access is on (check-in time has come).' });
  assert.strictEqual(r.cleaning.text, 'Cleaned today.');
  assert.deepStrictEqual(r.previous, [{ checkin: '2025-05-01', checkout: '2025-05-04', room: '0-4' }]);
  assert.strictEqual(JSON.stringify([...db.store.entries()]), before, 'nothing was written');
});

test('booking panel: no form, no reservation, and who may ask', async () => {
  const s = seed(); delete s['checkin_guests/f1']; delete s['hk_status/6-2_2026-11-09'];
  let r = await B.bookingPanel(NIKA, { bookingNumber: BN }, deps(fakeDb(s)));
  assert.deepStrictEqual(r.form, { filled: false, submittedAt: null });
  assert.match(r.access.text, /not filled in/);
  assert.match(r.cleaning.text, /No cleaning task/);
  const s2 = seed(); delete s2['reservations/res1'];
  r = await B.bookingPanel(NIKA, { bookingNumber: BN }, deps(fakeDb(s2)));
  assert.strictEqual(r.found, false);
  assert.strictEqual(r.reservation.checkin, '2026-11-09', 'falls back to what the chat knows');
  await assert.rejects(B.bookingPanel(null, { bookingNumber: BN }, deps(fakeDb(seed()))), { code: 'permission-denied' });
  await assert.rejects(B.bookingPanel(NIKA, { bookingNumber: 'x' }, deps(fakeDb(seed()))), { code: 'invalid-argument' });
});

test('+ Request: one request in service_requests the way the guest page makes one, never twice, only for guest messages', async () => {
  const db = fakeDb(seed());
  const r = await B.createRequest(NIKA, { bookingNumber: BN, messageId: 'g1' }, deps(db));
  assert.deepStrictEqual(r, { ok: true, duplicate: false, status: 'PENDING' });
  const doc = db.store.get(`service_requests/inbox-${BN}-g1`);
  assert.deepStrictEqual([doc.aptId, doc.roomCode, doc.guestName, doc.status, doc.details.note, doc.serviceId, doc.source], ['6-2', '6-2', 'Test Guest', 'PENDING', 'Can we get extra towels, please?', 'booking_message', 'booking_inbox']);
  assert.strictEqual((await B.createRequest(NIKA, { bookingNumber: BN, messageId: 'g1' }, deps(db))).duplicate, true);
  assert.strictEqual([...db.store.keys()].filter(k => k.startsWith('service_requests/')).length, 1);
  await assert.rejects(B.createRequest(NIKA, { bookingNumber: BN, messageId: 'h1' }, deps(db)), { code: 'failed-precondition' });
  await assert.rejects(B.createRequest(null, { bookingNumber: BN, messageId: 'g1' }, deps(db)), { code: 'permission-denied' });
  // the panel then shows it with its status
  const p = await B.bookingPanel(NIKA, { bookingNumber: BN }, deps(db));
  assert.deepStrictEqual(p.requests.map(x => [x.messageId, x.status]), [['g1', 'PENDING']]);
});
