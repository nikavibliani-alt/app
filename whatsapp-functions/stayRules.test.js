'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { otherPropertyForRoom, stayTiming, stayTimingContextLines } = require('./stayRules');

// Tbilisi is UTC+4: 11:00 Tbilisi = 07:00 UTC, 22:00 Tbilisi = 18:00 UTC.
const at = (date, tbilisiHour, minute = 0) => Date.UTC(...date.split('-').map((n, i) => (i === 1 ? Number(n) - 1 : Number(n))), tbilisiHour - 4, minute);
const STAY = { checkin: '2026-09-25', checkout: '2026-09-29' };

test('otherPropertyForRoom: decided by the booking room code', () => {
  assert.equal(otherPropertyForRoom('tab-2'), 'Freedom Square');
  assert.equal(otherPropertyForRoom('TAB-1'), 'Freedom Square');
  assert.equal(otherPropertyForRoom('orb-3'), 'Orbeliani');
  for (const shartava of ['0-1', '6-2', '6-3', '7-4']) assert.equal(otherPropertyForRoom(shartava), null, shartava);
  assert.equal(otherPropertyForRoom(''), null);
  assert.equal(otherPropertyForRoom(undefined), null);
  assert.equal(otherPropertyForRoom('stable-1'), null, 'only a tab-/orb- prefix counts');
});

test('stayTiming: check-in opens at 15:00 Tbilisi on the arrival day', async (t) => {
  await t.test('arrival day, 11:00 -> not open yet', () => {
    assert.deepEqual(stayTiming(STAY, at('2026-09-25', 11)), { today: '2026-09-25', arrivalDay: true, checkinTimePassed: false, checkinOpen: 'no' });
  });
  await t.test('arrival day, 14:59 -> not open yet', () => {
    assert.equal(stayTiming(STAY, at('2026-09-25', 14, 59)).checkinOpen, 'no');
  });
  await t.test('arrival day, 15:00 -> open', () => {
    assert.equal(stayTiming(STAY, at('2026-09-25', 15)).checkinOpen, 'yes');
  });
  await t.test('arrival day, 22:00 (today\'s real case) -> open', () => {
    assert.deepEqual(stayTiming(STAY, at('2026-09-25', 22)), { today: '2026-09-25', arrivalDay: true, checkinTimePassed: true, checkinOpen: 'yes' });
  });
  await t.test('arrival day just after midnight UTC but still the evening in Tbilisi', () => {
    // 2026-09-25 23:30 Tbilisi = 19:30 UTC; Tbilisi date is still the 25th
    assert.equal(stayTiming(STAY, Date.UTC(2026, 8, 25, 19, 30)).today, '2026-09-25');
  });
  await t.test('later day of the stay, even in the morning -> open', () => {
    assert.deepEqual(stayTiming(STAY, at('2026-09-26', 9)), { today: '2026-09-26', arrivalDay: false, checkinTimePassed: false, checkinOpen: 'yes' });
  });
  await t.test('checkout day -> still open', () => {
    assert.equal(stayTiming(STAY, at('2026-09-29', 10)).checkinOpen, 'yes');
  });
  await t.test('before arrival -> not open', () => {
    assert.equal(stayTiming(STAY, at('2026-09-24', 18)).checkinOpen, 'no');
  });
  await t.test('after checkout -> not open', () => {
    assert.equal(stayTiming(STAY, at('2026-09-30', 12)).checkinOpen, 'no');
  });
  await t.test('unknown dates -> unknown', () => {
    assert.deepEqual(stayTiming({}, at('2026-09-25', 22)), { today: '2026-09-25', arrivalDay: null, checkinTimePassed: true, checkinOpen: 'unknown' });
  });
});

test('stayTimingContextLines', () => {
  assert.deepEqual(stayTimingContextLines(stayTiming(STAY, at('2026-09-25', 22))), [
    'Today (Tbilisi): 2026-09-25',
    "Today is the guest's arrival day: yes",
    '15:00 check-in time has passed today: yes',
    'Check-in is already open for this guest: yes',
  ]);
  assert.equal(stayTimingContextLines(stayTiming({}, at('2026-09-25', 9)))[1], "Today is the guest's arrival day: unknown");
});
