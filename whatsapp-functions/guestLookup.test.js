'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  canonicalPhone,
  phonesMatch,
  stayState,
  pickCurrentForm,
  findCurrentGuestForm,
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
