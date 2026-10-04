'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isHkDoneDateNotFuture } = require('../controllers/pushNotifications');
const NOW = Date.parse('2026-10-04T07:51:32Z');
test('today and past notify', () => {
  assert.equal(isHkDoneDateNotFuture('2026-10-04', NOW), true);
  assert.equal(isHkDoneDateNotFuture('2026-10-03', NOW), true);
});
test('future day is skipped', () => {
  assert.equal(isHkDoneDateNotFuture('2026-10-10', NOW), false);
});
test('Tbilisi day boundary', () => {
  const lateUtc = Date.parse('2026-10-04T21:30:00Z'); // already 5 Oct in Tbilisi
  assert.equal(isHkDoneDateNotFuture('2026-10-05', lateUtc), true);
  assert.equal(isHkDoneDateNotFuture('2026-10-06', lateUtc), false);
});
test('missing date keeps old behaviour', () => {
  assert.equal(isHkDoneDateNotFuture('', NOW), true);
});
