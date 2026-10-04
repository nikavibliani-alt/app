'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isRoomReadyDateToday, tbilisiToday } = require('./roomReadyDate');

const NOW = Date.parse('2026-10-04T07:51:32Z'); // 11:51 Tbilisi

test('today in Tbilisi time passes', () => {
  assert.equal(tbilisiToday(NOW), '2026-10-04');
  assert.equal(isRoomReadyDateToday('2026-10-04', NOW), true);
});
test('future date is skipped (the 10 Oct guest case)', () => {
  assert.equal(isRoomReadyDateToday('2026-10-10', NOW), false);
});
test('past date is skipped', () => {
  assert.equal(isRoomReadyDateToday('2026-10-03', NOW), false);
});
test('uses Tbilisi day, not UTC (23:30 UTC is already tomorrow)', () => {
  const lateUtc = Date.parse('2026-10-04T21:30:00Z');
  assert.equal(isRoomReadyDateToday('2026-10-05', lateUtc), true);
  assert.equal(isRoomReadyDateToday('2026-10-04', lateUtc), false);
});
test('missing date is skipped', () => {
  assert.equal(isRoomReadyDateToday('', NOW), false);
  assert.equal(isRoomReadyDateToday(undefined, NOW), false);
});
