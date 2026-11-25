'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  canonicalPhone,
  phonesMatch,
  stayState,
  pickCurrentForm,
  findCurrentGuestForm,
  stayChain,
} = require('./guestLookup');

const WA = '995555123456'; // WhatsApp sends digits with country code
const TODAY = '2026-09-25';
const NOW = Date.UTC(2026, 8, 25, 8, 0); // 12:00 Tbilisi on TODAY

test('phone formats a guest may type all match the WhatsApp number', async (t) => {
  const same = {
    'digits only': '995555123456',
    'with +': '+995555123456',
    'with 00': '00995555123456',
    'spaces': '+995 555 12 34 56',
    'dashes': '995-555-123-456',
    'parens and dots': '+995 (555) 12.34.56',
    'Georgian local 9 digits': '555123456',
    'Georgian local with spaces': '555 12 34 56',
    'invisible direction marks from copy-paste': '‪+995 555 123 456‬',
  };
  for (const [label, typed] of Object.entries(same)) {
    await t.test(label, () => assert.equal(phonesMatch(typed, WA), true, typed));
  }
});

test('different or junk numbers do not match', () => {
  assert.equal(phonesMatch('995555123457', WA), false, 'one digit different');
  assert.equal(phonesMatch('+49 1701234567', WA), false, 'other country');
  assert.equal(phonesMatch('123', '123'), false, 'too short to be a phone');
  assert.equal(phonesMatch('', WA), false);
  assert.equal(phonesMatch('@username', WA), false, 'telegram handle');
});

test('canonicalPhone only expands Georgian local mobiles', () => {
  assert.equal(canonicalPhone('555123456'), WA);
  assert.equal(canonicalPhone('0049 170 1234567'), '491701234567', 'leading 00 dropped');
  assert.equal(canonicalPhone('322123456'), '322123456', '9 digits not starting with 5 are left alone');
});

const form = (arrivalDate, extra = {}) => ({ contactType: 'wa', contact: WA, name: `Guest ${arrivalDate}`, arrivalDate, ...extra });
const res = (checkin, checkout, status = 'OK') => ({ checkin, checkout, status, roomCode: `room-${checkin}` });

test('stayState', () => {
  assert.equal(stayState(form('2026-09-20'), res('2026-09-20', '2026-09-27'), TODAY), 'current');
  assert.equal(stayState(form('2026-09-20'), res('2026-09-20', TODAY), TODAY), 'current', 'checkout day still counts');
  assert.equal(stayState(form('2026-10-02'), res('2026-10-02', '2026-10-05'), TODAY), 'upcoming');
  assert.equal(stayState(form('2026-07-13'), res('2026-07-13', '2026-07-16'), TODAY), 'past');
  assert.equal(stayState(form('2026-09-20'), res('2026-09-20', '2026-09-27', 'CL'), TODAY), 'cancelled');
  assert.equal(stayState(form('2026-09-20'), res('2026-09-20', '2026-09-27', 'CANCELLED'), TODAY), 'cancelled');
  assert.equal(stayState(form('2026-09-22'), null, TODAY), 'current', 'reservation not in Firestore, arrived recently');
  assert.equal(stayState(form('2026-08-01'), null, TODAY), 'past', 'reservation not in Firestore, arrived long ago');
});

test('pickCurrentForm prefers the current stay over old and cancelled ones', async (t) => {
  const old = { form: form('2026-07-13'), reservation: res('2026-07-13', '2026-07-16') };
  const cancelled = { form: form('2026-09-21'), reservation: res('2026-09-21', '2026-09-28', 'CL') };
  const current = { form: form('2026-09-20'), reservation: res('2026-09-20', '2026-09-27') };
  const upcoming = { form: form('2026-10-10'), reservation: res('2026-10-10', '2026-10-12') };
  const laterUpcoming = { form: form('2026-11-01'), reservation: res('2026-11-01', '2026-11-03') };

  await t.test('current beats old, cancelled and upcoming, whatever the order', () => {
    const picked = pickCurrentForm([old, cancelled, upcoming, current], TODAY);
    assert.equal(picked.form, current.form);
    assert.equal(picked.state, 'current');
  });
  await t.test('no current stay: nearest upcoming wins', () => {
    assert.equal(pickCurrentForm([laterUpcoming, old, upcoming], TODAY).form, upcoming.form);
  });
  await t.test('only past and cancelled forms: returning guest, no current form', () => {
    assert.equal(pickCurrentForm([old, cancelled], TODAY), null);
  });
  await t.test('two current stays (extension booked separately): the latest check-in wins', () => {
    const extension = { form: form(TODAY), reservation: res(TODAY, '2026-09-30') };
    assert.equal(pickCurrentForm([current, extension], TODAY).form, extension.form);
  });
  await t.test('a known reservation beats a form whose reservation is missing', () => {
    const unmatched = { form: form('2026-09-24'), reservation: null };
    assert.equal(pickCurrentForm([unmatched, current], TODAY).form, current.form);
  });
});

// Minimal fake Firestore for findCurrentGuestForm's two queries.
function fakeDb({ forms, reservations }) {
  const reads = [];
  return {
    reads,
    collection(name) {
      return {
        where(field, op, value) {
          const filters = [{ field, op, value }];
          const q = {
            where(f, o, v) { filters.push({ field: f, op: o, value: v }); return q; },
            limit() { return q; },
            async get() {
              reads.push({ name, filters: [...filters] });
              const rows = (name === 'checkin_guests' ? forms : reservations).filter((row) => filters.every((fl) => {
                if (fl.op === '>=') return (row[fl.field] || '') >= fl.value;
                if (fl.op === '==') return row[fl.field] === fl.value;
                throw new Error(`unsupported op ${fl.op}`);
              }));
              return { empty: rows.length === 0, docs: rows.map((row) => ({ data: () => row })) };
            },
          };
          return q;
        },
      };
    },
  };
}

test('findCurrentGuestForm (Firestore path)', async (t) => {
  const reservations = [
    { reservationNumber: '7001', checkin: '2026-09-20', checkout: '2026-09-27', status: 'OK', roomCode: '6-2' },
    { reservationNumber: '6001', checkin: '2026-09-01', checkout: '2026-09-04', status: 'OK', roomCode: '0-3' },
    { reservationNumber: '6500', checkin: '2026-09-22', checkout: '2026-09-29', status: 'CL', roomCode: '7-1' },
  ];

  await t.test('returning guest typed a local number: current stay picked, old and cancelled ignored', async () => {
    const db = fakeDb({
      reservations,
      forms: [
        { contactType: 'wa', contact: '+995 555 12 34 56', arrivalDate: '2026-09-01', matchedReservationId: '6001', name: 'Old stay' },
        { contactType: 'wa', contact: '555123456', arrivalDate: '2026-09-22', matchedReservationId: '6500', name: 'Cancelled' },
        { contactType: 'wa', contact: '555 123 456', arrivalDate: '2026-09-20', matchedReservationId: '7001_001', name: 'Current' },
        { contactType: 'wa', contact: '+995 555 99 99 99', arrivalDate: '2026-09-20', matchedReservationId: '7001', name: 'Someone else' },
      ],
    });
    const match = await findCurrentGuestForm(db, WA, NOW);
    assert.equal(match.form.name, 'Current');
    assert.equal(match.reservation.roomCode, '6-2');
    assert.equal(match.state, 'current');
    const formQuery = db.reads.find((r) => r.name === 'checkin_guests');
    assert.deepEqual(formQuery.filters, [{ field: 'arrivalDate', op: '>=', value: '2026-07-27' }], 'single-field range, 60-day window');
  });

  await t.test('only a past stay: no current form', async () => {
    const db = fakeDb({
      reservations,
      forms: [{ contactType: 'wa', contact: '+995555123456', arrivalDate: '2026-09-01', matchedReservationId: '6001' }],
    });
    assert.equal(await findCurrentGuestForm(db, WA, NOW), null);
  });

  await t.test('a matching Telegram (tg) form is not used — contactType wa only, unchanged', async () => {
    const db = fakeDb({
      reservations,
      forms: [{ contactType: 'tg', contact: '+995555123456', arrivalDate: '2026-09-20', matchedReservationId: '7001' }],
    });
    assert.equal(await findCurrentGuestForm(db, WA, NOW), null);
  });

  await t.test('no forms at all', async () => {
    assert.equal(await findCurrentGuestForm(fakeDb({ reservations, forms: [] }), WA, NOW), null);
  });
});

// The 24 Nov case (guest ...1031, 7-2): the last check-in form is for the
// 14-21 Nov booking; the extensions (21-24, 24-27, 27 Nov - 6 Dec) were booked
// as new reservations, with no form and no phone. Another guest had 7-2 before.
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

test('stayChain: back-to-back bookings of the same guest in the same room are one stay', async (t) => {
  await t.test('the 24 Nov guest: 12 Nov to 6 Dec, the other guest before and the December return are not part of it', () => {
    assert.deepEqual(stayChain(B2B[3], B2B).map((r) => r.reservationNumber), ['R1', 'R2', 'R3', 'R4', 'R5']);
  });
  await t.test('a 1-day gap still counts, a 2-day gap does not', () => {
    const rows = [
      { reservationNumber: 'A', roomCode: '6-2', checkin: '2026-11-01', checkout: '2026-11-05', guest: 'Ann Lee' },
      { reservationNumber: 'B', roomCode: '6-2', checkin: '2026-11-06', checkout: '2026-11-08', guest: 'Ann Lee' },
      { reservationNumber: 'C', roomCode: '6-2', checkin: '2026-11-10', checkout: '2026-11-12', guest: 'Ann Lee' },
    ];
    assert.deepEqual(stayChain(rows[0], rows).map((r) => r.reservationNumber), ['A', 'B']);
    assert.deepEqual(stayChain(rows[2], rows).map((r) => r.reservationNumber), ['C']);
  });
  await t.test('no guest name: only the booking itself', () => {
    const rows = [{ reservationNumber: 'A', checkin: '2026-11-01', checkout: '2026-11-05' }, { reservationNumber: 'B', checkin: '2026-11-05', checkout: '2026-11-08' }];
    assert.deepEqual(stayChain(rows[0], rows).map((r) => r.reservationNumber), ['A']);
  });
});

test('findCurrentGuestForm: a form for an earlier booking of a back-to-back stay still finds the current booking', async (t) => {
  const forms = [
    { contactType: 'wa', contact: '+995555123456', arrivalDate: '2026-11-12', matchedReservationId: 'R1', name: 'Akbar Nikbakht', aptId: '7-2' },
    { contactType: 'wa', contact: '+995555123456', arrivalDate: '2026-11-14', matchedReservationId: 'R2', name: 'Akbar Nikbakht', aptId: '7-2' },
    { contactType: 'wa', contact: '+995555123456', arrivalDate: '2026-11-01', matchedReservationId: 'P1', name: 'Akbar Nikbakht', aptId: '0-3' },
  ];
  const reservations = [...B2B, { reservationNumber: 'P1', roomCode: '0-3', checkin: '2026-11-01', checkout: '2026-11-04', status: 'OK2', guest: 'Akbar Nikbakht' }];
  await t.test('24 Nov, 10:39 (the changeover day): the booking starting today, whole stay 12 Nov - 6 Dec', async () => {
    const m = await findCurrentGuestForm(fakeDb({ forms, reservations }), WA, Date.UTC(2026, 10, 24, 6, 39));
    assert.equal(m.reservation.reservationNumber, 'R4');
    assert.equal(m.reservation.roomCode, '7-2');
    assert.equal(m.continued, true);
    assert.equal(m.stayStart, '2026-11-12');
    assert.equal(m.stayEnd, '2026-12-06');
    assert.equal(m.bookings, 5);
    assert.deepEqual(m.previousCheckouts, ['2026-11-04'], 'only the earlier stay in 0-3 counts as a previous stay');
  });
  await t.test('a current form: the whole stay is still reported', async () => {
    const m = await findCurrentGuestForm(fakeDb({ forms, reservations }), WA, Date.UTC(2026, 10, 16, 8, 0));
    assert.equal(m.reservation.reservationNumber, 'R2');
    assert.equal(m.continued, false);
    assert.equal(m.stayStart, '2026-11-12');
    assert.equal(m.stayEnd, '2026-12-06');
  });
  await t.test('after the stay ended (7 Dec): no current form', async () => {
    assert.equal(await findCurrentGuestForm(fakeDb({ forms, reservations }), WA, Date.UTC(2026, 11, 7, 8, 0)), null);
  });
});

