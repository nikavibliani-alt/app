'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { otherPropertyForRoom, propertyForRoom, stayTiming, stayTimingContextLines } = require('./stayRules');

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
  assert.equal(otherPropertyForRoom('stable-1'), null, 'only a listed prefix counts');
});

test('otherPropertyForRoom: VGL, XCV (Modern Avlabari) and Abashidze never get Shartava answers', () => {
  for (const vgl of ['vgl-st1', 'vgl-st2', 'vgl-ap3', 'vgl-ap4', 'VGL-AP3']) assert.equal(otherPropertyForRoom(vgl), 'VGL', vgl);
  for (const xcv of ['xcv-1', 'xcv-2', ' XCV-2 ']) assert.equal(otherPropertyForRoom(xcv), 'XCV (Modern Avlabari)', xcv);
  assert.equal(otherPropertyForRoom('abashidze'), 'Abashidze');
  // Every non-Shartava room code seen in reservations since June 2026 is covered.
  for (const code of ['tab-1', 'tab-2', 'tab-3', 'orb-1', 'orb-2', 'orb-3', 'vgl-st1', 'vgl-st2', 'vgl-ap3', 'vgl-ap4', 'xcv-1', 'xcv-2', 'abashidze']) {
    assert.notEqual(otherPropertyForRoom(code), null, code);
  }
});

test('propertyForRoom: Shartava for 0-/6-/7-, the other properties by prefix, else null', () => {
  for (const c of ['0-1', '0-5', '6-2', '6-3', '7-4']) assert.equal(propertyForRoom(c), 'Shartava', c);
  assert.equal(propertyForRoom('tab-1'), 'Freedom Square');
  assert.equal(propertyForRoom('orb-2'), 'Orbeliani');
  assert.equal(propertyForRoom('vgl-st1'), 'VGL');
  assert.equal(propertyForRoom('xcv-1'), 'XCV (Modern Avlabari)');
  assert.equal(propertyForRoom(''), null);
  assert.equal(propertyForRoom('60-1'), null, 'only the exact 0-/6-/7- prefixes');
});

test('stayTiming: check-in opens at 15:00 Tbilisi on the arrival day', async (t) => {
  await t.test('arrival day, 11:00 -> not open yet', () => {
    assert.deepEqual(stayTiming(STAY, at('2026-09-25', 11)), { today: '2026-09-25', arrivalDay: true, checkinTimePassed: false, checkinOpen: 'no', checkoutDay: false, checkoutTimePassed: false, stayEnded: false });
  });
  await t.test('arrival day, 14:59 -> not open yet', () => {
    assert.equal(stayTiming(STAY, at('2026-09-25', 14, 59)).checkinOpen, 'no');
  });
  await t.test('arrival day, 15:00 -> open', () => {
    assert.equal(stayTiming(STAY, at('2026-09-25', 15)).checkinOpen, 'yes');
  });
  await t.test('arrival day, 22:00 (today\'s real case) -> open', () => {
    assert.deepEqual(stayTiming(STAY, at('2026-09-25', 22)), { today: '2026-09-25', arrivalDay: true, checkinTimePassed: true, checkinOpen: 'yes', checkoutDay: false, checkoutTimePassed: true, stayEnded: false });
  });
  await t.test('arrival day just after midnight UTC but still the evening in Tbilisi', () => {
    // 2026-09-25 23:30 Tbilisi = 19:30 UTC; Tbilisi date is still the 25th
    assert.equal(stayTiming(STAY, Date.UTC(2026, 8, 25, 19, 30)).today, '2026-09-25');
  });
  await t.test('later day of the stay, even in the morning -> open', () => {
    assert.deepEqual(stayTiming(STAY, at('2026-09-26', 9)), { today: '2026-09-26', arrivalDay: false, checkinTimePassed: false, checkinOpen: 'yes', checkoutDay: false, checkoutTimePassed: false, stayEnded: false });
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
    assert.deepEqual(stayTiming({}, at('2026-09-25', 22)), { today: '2026-09-25', arrivalDay: null, checkinTimePassed: true, checkinOpen: 'unknown', checkoutDay: null, checkoutTimePassed: true, stayEnded: null });
  });
});

test('stayTimingContextLines', () => {
  assert.deepEqual(stayTimingContextLines(stayTiming(STAY, at('2026-09-25', 22))), [
    'Today (Tbilisi): 2026-09-25',
    "Today is the guest's arrival day: yes",
    '15:00 check-in time has passed today: yes',
    'Check-in is already open for this guest: yes',
    "Today is the guest's checkout day: no",
    '12:00 checkout time has passed today: yes',
    "The guest's stay has ended (it is after 12:00 on the checkout day, or later): no",
  ]);
  assert.equal(stayTimingContextLines(stayTiming({}, at('2026-09-25', 9)))[1], "Today is the guest's arrival day: unknown");
});

test('stayTiming: checkout day, 12:00 checkout, stay ended (27 Oct real case: 18:12 on the checkout day)', () => {
  const stay = { checkin: '2026-10-25', checkout: '2026-10-27' };
  const t = stayTiming(stay, at('2026-10-27', 18, 12));
  assert.equal(t.checkoutDay, true);
  assert.equal(t.checkoutTimePassed, true);
  assert.equal(t.stayEnded, true);
  assert.deepEqual(stayTimingContextLines(t).slice(-3), [
    "Today is the guest's checkout day: yes",
    '12:00 checkout time has passed today: yes',
    "The guest's stay has ended (it is after 12:00 on the checkout day, or later): yes",
  ]);
  const morning = stayTiming(stay, at('2026-10-27', 9));
  assert.deepEqual([morning.checkoutDay, morning.checkoutTimePassed, morning.stayEnded], [true, false, false], 'checkout morning: stay not ended');
  assert.equal(stayTiming(stay, at('2026-10-27', 11, 59)).stayEnded, false);
  assert.equal(stayTiming(stay, at('2026-10-27', 12)).stayEnded, true);
  const dayBefore = stayTiming(stay, at('2026-10-26', 20));
  assert.deepEqual([dayBefore.checkoutDay, dayBefore.stayEnded], [false, false], 'evening before checkout');
  assert.deepEqual([stayTiming(stay, at('2026-10-28', 8)).checkoutDay, stayTiming(stay, at('2026-10-28', 8)).stayEnded], [false, true], 'the day after');
  assert.equal(stayTiming({ checkin: '2026-10-25' }, at('2026-10-27', 18)).stayEnded, null, 'no checkout date -> unknown');
});
