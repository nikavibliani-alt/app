'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { decide, GRACE_MS } = require('../../scripts/elevator-monitor-logic');

const NOW = Date.parse('2026-10-29T12:00:00Z');
const H = 3600 * 1000;
const code = (expiresAt, updatedAt = NOW - 10 * H) => ({ code: '1', updatedAt: String(updatedAt), expires_at: String(expiresAt) });

test('code still valid: nothing happens', () => {
  assert.equal(decide(code(NOW + 2 * H), {}, NOW).action, 'none');
});
test('just past expiry but inside the grace time: no alert yet', () => {
  assert.equal(decide(code(NOW - GRACE_MS + 60000), {}, NOW).action, 'none');
});
test('expired past the grace time: alert once', () => {
  const d = decide(code(NOW - GRACE_MS - 60000), {}, NOW);
  assert.equal(d.problem, true);
  assert.equal(d.action, 'alert');
});
test('problem already alerted: no repeat on later runs', () => {
  const d = decide(code(NOW - 5 * H), { alert_open: true, alert_since: NOW - H }, NOW);
  assert.equal(d.problem, true);
  assert.equal(d.action, 'none');
});
test('old monitor flag was_stale counts as an open alert (no double mail after the upgrade)', () => {
  assert.equal(decide(code(NOW - 5 * H), { was_stale: true }, NOW).action, 'none');
});
test('new code or hand save resets the alert', () => {
  assert.equal(decide(code(NOW + 20 * H, NOW - 1000), { alert_open: true }, NOW).action, 'recover');
});
test('after a reset a new problem alerts again', () => {
  assert.equal(decide(code(NOW - 2 * H), { alert_open: false }, NOW).action, 'alert');
});
test('no expires_at: falls back to 26 hours since updatedAt', () => {
  const d1 = decide({ updatedAt: String(NOW - 25 * H) }, {}, NOW);
  const d2 = decide({ updatedAt: String(NOW - 27 * H) }, {}, NOW);
  assert.equal(d1.action, 'none');
  assert.equal(d2.action, 'alert');
});
test('empty data is skipped, never an alert', () => {
  assert.equal(decide(null, {}, NOW).action, 'none');
  assert.equal(decide({}, {}, NOW).action, 'none');
});
