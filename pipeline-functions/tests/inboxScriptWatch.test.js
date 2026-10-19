'use strict';
const test = require('node:test');
const assert = require('node:assert');
const W = require('../lib/inboxScriptWatch');
const S = require('../controllers/inboxScriptWatch');
const R = require('../controllers/inboxReply');

const T0 = Date.UTC(2026, 9, 19, 10, 0, 0);
const MIN = 60000;
const stamp = m => ({ toMillis: () => m });

test('decision: stopped after 15 minutes, a reminder every 3 hours, and back', () => {
  const up = { down: false, alertedAtMs: 0 };
  assert.strictEqual(W.decideScriptAlert({ nowMs: T0, lastPullMs: NaN, state: up }).action, 'none', 'never called: nothing to judge');
  assert.strictEqual(W.decideScriptAlert({ nowMs: T0 + 14 * MIN, lastPullMs: T0, state: up }).action, 'none', '14 minutes is fine');
  assert.strictEqual(W.decideScriptAlert({ nowMs: T0 + 16 * MIN, lastPullMs: T0, state: up }).action, 'down');
  const down = { down: true, alertedAtMs: T0 + 16 * MIN };
  assert.strictEqual(W.decideScriptAlert({ nowMs: T0 + 100 * MIN, lastPullMs: T0, state: down }).action, 'none', 'no repeat before 3 hours');
  assert.strictEqual(W.decideScriptAlert({ nowMs: T0 + 16 * MIN + 3 * 60 * MIN, lastPullMs: T0, state: down }).action, 'still_down');
  assert.strictEqual(W.decideScriptAlert({ nowMs: T0 + 200 * MIN, lastPullMs: T0 + 199 * MIN, state: down }).action, 'back');
  assert.strictEqual(W.decideScriptAlert({ nowMs: T0 + 5 * MIN, lastPullMs: T0, state: up }).action, 'none');
});

test('the alert texts', () => {
  const down = W.scriptAlertPayload('down', T0, T0 + 20 * MIN);      // 10:00 UTC = 14:00 Tbilisi
  assert.strictEqual(down.title, 'Booking.com Gmail script has stopped');
  assert.match(down.body, /since 14:00/);
  assert.strictEqual(W.scriptAlertPayload('still_down', T0, T0).title, 'Booking.com Gmail script is still stopped');
  assert.strictEqual(W.scriptAlertPayload('back', T0, T0).title, 'Booking.com Gmail script is back');
});

function fakeDb(seed = {}) {
  const store = new Map(Object.entries(seed));
  const snap = p => ({ id: p.split('/').pop(), exists: store.has(p), data: () => store.get(p), ref: { delete: async () => { store.delete(p); } } });
  return {
    store,
    collection: name => ({
      doc: id => ({ get: async () => snap(name + '/' + id), set: async (d, o) => { store.set(name + '/' + id, o && o.merge ? { ...(store.get(name + '/' + id) || {}), ...d } : d); } }),
      get: async () => ({ docs: [...store.entries()].filter(([p]) => p.startsWith(name + '/')).map(([p]) => snap(p)) }),
    }),
  };
}
const phone = { subscription: { endpoint: 'https://web.push.apple.com/AAA', keys: { p256dh: 'p', auth: 'a' } } };
function mk(seed, now) {
  const sent = [];
  return { d: { db: fakeDb({ 'push_subscriptions/p1': phone, ...seed }), nowMs: () => now, ts: stamp, sendNotification: async (sub, body) => { sent.push(JSON.parse(body)); } }, sent };
}

test('watch: no alert while the script calls, one alert when it stops, reminders, and a back message', async () => {
  let clock = T0 + 5 * MIN;
  const { d, sent } = mk({ 'inbox_meta/script_heartbeat': { lastPullAt: stamp(T0) } }, clock);
  assert.strictEqual((await S.checkScript(d)).action, 'none');
  d.nowMs = () => clock = T0 + 16 * MIN;
  assert.strictEqual((await S.checkScript(d)).action, 'down');
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].title, 'Booking.com Gmail script has stopped');
  d.nowMs = () => clock = T0 + 30 * MIN;
  assert.strictEqual((await S.checkScript(d)).action, 'none', 'no second alert right away');
  d.nowMs = () => clock = T0 + 16 * MIN + 3 * 60 * MIN;
  assert.strictEqual((await S.checkScript(d)).action, 'still_down');
  d.db.store.set('inbox_meta/script_heartbeat', { lastPullAt: stamp(clock - MIN) });
  assert.strictEqual((await S.checkScript(d)).action, 'back');
  assert.strictEqual(sent.map(s => s.title).join('|'), 'Booking.com Gmail script has stopped|Booking.com Gmail script is still stopped|Booking.com Gmail script is back');
  assert.strictEqual((await S.checkScript(d)).action, 'none');
  assert.strictEqual(sent.length, 3);
});

test('watch: the alert goes to every phone once, even a phone on both lists', async () => {
  const { d, sent } = mk({ 'inbox_meta/script_heartbeat': { lastPullAt: stamp(T0) }, 'inbox_push_devices/same-phone': phone, 'inbox_push_devices/other': { subscription: { endpoint: 'https://web.push.apple.com/BBB', keys: { p256dh: 'p', auth: 'a' } } } }, T0 + 20 * MIN);
  const r = await S.checkScript(d);
  assert.strictEqual(r.devices, 2);
  assert.strictEqual(sent.length, 2);
});

test('watch: nothing happens before the script has ever called', async () => {
  const { d, sent } = mk({}, T0);
  assert.strictEqual((await S.checkScript(d)).action, 'none');
  assert.strictEqual(sent.length, 0);
});

test('heartbeat: a script call counts, a web app call does not', async () => {
  const db = fakeDb();
  let t = 111;
  const deps = { db, now: () => stamp(t) };
  await R.noteHeartbeat(deps, 'webapp');
  assert.ok(!db.store.has('inbox_meta/script_heartbeat'), 'the web app proves nothing about the trigger');
  await R.noteHeartbeat(deps, 'trigger');
  assert.strictEqual(db.store.get('inbox_meta/script_heartbeat').lastPullAt.toMillis(), 111);
  t = 222;
  await R.noteHeartbeat(deps, undefined);   // an older script version sends no source: counts as the trigger
  assert.strictEqual(db.store.get('inbox_meta/script_heartbeat').lastPullAt.toMillis(), 222);
  await R.noteHeartbeat({ db: { collection: () => { throw new Error('db down'); } }, now: () => 1 }, 'trigger');   // never breaks the pull
});

// ---------------------------------------------------------------- no new email for 12 hours
const H = 60 * MIN;

test('email decision: 12 hours, reminders every 6 hours, and back', () => {
  const up = { down: false, alertedAtMs: 0 };
  assert.strictEqual(W.decideEmailAlert({ nowMs: T0, newestMs: NaN, state: up }).action, 'none');
  assert.strictEqual(W.decideEmailAlert({ nowMs: T0 + 11 * H, newestMs: T0, state: up }).action, 'none');
  assert.strictEqual(W.decideEmailAlert({ nowMs: T0 + 12 * H + MIN, newestMs: T0, state: up }).action, 'down');
  const down = { down: true, alertedAtMs: T0 + 12 * H };
  assert.strictEqual(W.decideEmailAlert({ nowMs: T0 + 17 * H, newestMs: T0, state: down }).action, 'none');
  assert.strictEqual(W.decideEmailAlert({ nowMs: T0 + 18 * H, newestMs: T0, state: down }).action, 'still_down');
  assert.strictEqual(W.decideEmailAlert({ nowMs: T0 + 19 * H, newestMs: T0 + 18 * H, state: down }).action, 'back');
});

test('email alert texts', () => {
  const p = W.emailAlertPayload('down', T0);                 // 10:00 UTC on 19 Oct = 14:00 Tbilisi
  assert.strictEqual(p.title, 'No Booking.com email saved for 12 hours');
  assert.match(p.body, /10\/19 14:00/);
  assert.strictEqual(W.emailAlertPayload('still_down', T0).title, 'Still no Booking.com email saved');
  assert.strictEqual(W.emailAlertPayload('back', T0).title, 'Booking.com emails are being saved again');
});

function fakeDbWithEmails(seed) {
  const base = fakeDb(seed);
  const col = base.collection;
  base.collection = name => {
    const c = col(name);
    if (name !== 'inbox_raw_emails') return c;
    return { ...c, orderBy: () => ({ limit: () => ({ get: async () => {
      const rows = [...base.store.entries()].filter(([p]) => p.startsWith('inbox_raw_emails/')).map(([, d]) => d).sort((a, b) => b.receivedAt.toMillis() - a.receivedAt.toMillis());
      return { docs: rows.slice(0, 1).map(d => ({ data: () => d })) };
    } }) }) };
  };
  return base;
}

test('email watch: quiet for 12 hours alerts all phones once, then again every 6 hours, and says when emails are back', async () => {
  const sent = [];
  let clock = T0 + 2 * H;
  const d = { db: fakeDbWithEmails({ 'push_subscriptions/p1': phone, 'inbox_raw_emails/e1': { receivedAt: stamp(T0) } }), nowMs: () => clock, ts: stamp, sendNotification: async (sub, body) => { sent.push(JSON.parse(body)); } };
  assert.strictEqual((await S.checkEmails(d)).action, 'none');
  clock = T0 + 12 * H + 2 * MIN;
  const r = await S.checkEmails(d);
  assert.strictEqual(r.action, 'down');
  assert.strictEqual(sent.length, 1);
  clock = T0 + 14 * H;
  assert.strictEqual((await S.checkEmails(d)).action, 'none', 'not again right away');
  clock = T0 + 18 * H + 3 * MIN;
  assert.strictEqual((await S.checkEmails(d)).action, 'still_down');
  d.db.store.set('inbox_raw_emails/e2', { receivedAt: stamp(clock - MIN) });
  assert.strictEqual((await S.checkEmails(d)).action, 'back');
  assert.strictEqual((await S.checkEmails(d)).action, 'none');
  assert.deepStrictEqual(sent.map(s => s.title), ['No Booking.com email saved for 12 hours', 'Still no Booking.com email saved', 'Booking.com emails are being saved again']);
});

test('email watch: no emails at all yet means nothing to judge', async () => {
  const sent = [];
  const d = { db: fakeDbWithEmails({ 'push_subscriptions/p1': phone }), nowMs: () => T0, ts: stamp, sendNotification: async (sub, body) => { sent.push(body); } };
  assert.strictEqual((await S.checkEmails(d)).action, 'none');
  assert.strictEqual(sent.length, 0);
});
