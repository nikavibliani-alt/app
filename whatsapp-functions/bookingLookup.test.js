'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { NOT_MATCHED_NOTE, confirmationNumbersIn, nameWrittenBy, lookupBooking, bookingLookupLines, guestTextsFrom } = require('./bookingLookup');

test('confirmationNumbersIn: booking numbers yes; phones, dates, prices and links no', () => {
  assert.deepEqual(confirmationNumbersIn(['My booking number is 5123456789']), ['5123456789']);
  assert.deepEqual(confirmationNumbersIn(['5 123 456 789', 'res 007004653']), ['5123456789', '007004653']);
  assert.deepEqual(confirmationNumbersIn(['call me +995 555 123 456', '995555123456', 'arriving 17.10.2026', '2026-10-17', '50 GEL', 'https://x.com/1234567890']), []);
  assert.deepEqual(confirmationNumbersIn(['1111111', '2222222', '3333333', '4444444']).length, 3, 'at most 3 numbers');
});

test('nameWrittenBy: first and last name both written, any order or case', () => {
  const r = { firstName: 'Anna', lastName: 'Van der Berg' };
  assert.equal(nameWrittenBy(r, ['hi, it is anna BERG']), true);
  assert.equal(nameWrittenBy(r, ['Berg here']), false, 'last name only');
  assert.equal(nameWrittenBy({ firstName: 'José', lastName: 'García' }, ['jose garcia']), true, 'accents ignored');
  assert.equal(nameWrittenBy({ firstName: 'Anna', lastName: '' }, ['anna']), false);
  assert.equal(nameWrittenBy(r, ['annabelle bergman']), false, 'whole words only');
});

/** Fake Firestore for reservations: equality and checkin range queries. */
function fakeDb(reservations, { fail = false } = {}) {
  const queries = [];
  const query = (filters) => ({
    where: (f, op, v) => query([...filters, [f, op, v]]),
    limit: () => query(filters),
    get: async () => {
      queries.push(filters);
      if (fail) throw new Error('unavailable');
      const ok = (r) => filters.every(([f, op, v]) => (op === '==' ? String(r[f]) === v : op === '>=' ? r[f] >= v : r[f] <= v));
      const docs = reservations.filter(ok).map((r) => ({ data: () => r }));
      return { empty: docs.length === 0, docs };
    },
  });
  return { queries, collection: () => query([]) };
}

const NOW = Date.UTC(2026, 9, 17, 8, 0); // 12:00 in Tbilisi
const RES = [
  { reservationNumber: '007004653', bookingId: '5123456789', roomCode: '6-2', checkin: '2026-10-17', checkout: '2026-10-19', firstName: 'Anna', lastName: 'Berg', status: 'OK' },
  { reservationNumber: '007004700', bookingId: '5999999999', roomCode: 'tab-2', checkin: '2026-10-18', checkout: '2026-10-20', firstName: 'Luka', lastName: 'Beridze', status: 'CL' },
  { reservationNumber: '007004701', roomCode: '7-1', checkin: '2026-12-30', checkout: '2027-01-02', firstName: 'Mark', lastName: 'Stone', status: 'OK' },
];

test('lookupBooking: by confirmation number (Booking.com id or ours), then by name, else not found / no details', async () => {
  assert.deepEqual(await lookupBooking(fakeDb(RES), { guestTexts: ['the form cannot find 5123456789'], nowMs: NOW }),
    { status: 'found', via: 'confirmation number', roomCode: '6-2', checkin: '2026-10-17', checkout: '2026-10-19', reservationNumber: '007004653' });
  assert.equal((await lookupBooking(fakeDb(RES), { guestTexts: ['007004653'], nowMs: NOW })).roomCode, '6-2');
  assert.deepEqual(await lookupBooking(fakeDb(RES), { guestTexts: ['booking 5999999999'], nowMs: NOW }), { status: 'not_found', via: 'confirmation number' }, 'a cancelled booking does not count');
  assert.deepEqual(await lookupBooking(fakeDb(RES), { guestTexts: ['booked just now, number 5888888888'], nowMs: NOW }), { status: 'not_found', via: 'confirmation number' });
  const byName = await lookupBooking(fakeDb(RES), { guestTexts: ['Hi, Anna Berg here'], nowMs: NOW });
  assert.equal(byName.status, 'found');
  assert.equal(byName.via, 'name');
  assert.deepEqual(await lookupBooking(fakeDb(RES), { guestTexts: ['Mark Stone'], nowMs: NOW }), { status: 'no_details' }, 'arrival more than 60 days ahead');
  assert.deepEqual(await lookupBooking(fakeDb(RES), { guestTexts: ['the form does not find my booking'], nowMs: NOW }), { status: 'no_details' });
  assert.deepEqual(await lookupBooking(fakeDb(RES, { fail: true }), { guestTexts: ['5123456789'], nowMs: NOW, log: { warn() {} } }), { status: 'error' });
});

test('lookupBooking: the name search uses a checkin date window only (single-field range, no index needed)', async () => {
  const db = fakeDb(RES);
  await lookupBooking(db, { guestTexts: ['hello'], nowMs: NOW });
  assert.deepEqual(db.queries, [[['checkin', '>=', '2026-10-14'], ['checkin', '<=', '2026-12-16']]]);
});

test('bookingLookupLines: one plain line per result, none without a lookup', () => {
  assert.deepEqual(bookingLookupLines(null), []);
  assert.match(bookingLookupLines({ status: 'found', via: 'name', roomCode: '6-2', checkin: '2026-10-17', checkout: '2026-10-19' }, 'Shartava')[0], /found, 6-2 at Shartava, 2026-10-17 to 2026-10-19\. The booking is in our system\./);
  assert.match(bookingLookupLines({ status: 'not_found', via: 'confirmation number' })[0], /not in our system yet/);
  assert.match(bookingLookupLines({ status: 'no_details' })[0], /not possible yet/);
  assert.match(bookingLookupLines({ status: 'error' })[0], /unavailable/);
  for (const status of ['not_found', 'no_details', 'error']) assert.equal(bookingLookupLines({ status }).at(-1), NOT_MATCHED_NOTE, status);
  assert.equal(bookingLookupLines({ status: 'found', roomCode: '6-2' }).length, 1, 'no note once found');
});

test('guestTextsFrom: only the guest\'s own messages, plus the new batch', () => {
  const msgs = [{ role: 'user', content: 'Anna Berg' }, { role: 'assistant', content: 'Bob Smith 5123456789' }, { role: 'owner', content: 'x' }];
  assert.deepEqual(guestTextsFrom(msgs, 'new text'), ['Anna Berg', 'new text']);
});
