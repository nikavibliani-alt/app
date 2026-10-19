'use strict';
// Made-up data only. A small in-memory Firestore and a fake "web push" stand in for the real ones.
const test = require('node:test');
const assert = require('node:assert');
const P = require('../lib/inboxPush');
const C = require('../controllers/inboxPush');

const OWNER = { token: { email: 'nikavibliani@gmail.com', email_verified: true } };
const BN = '5000000001';
const T0 = Date.UTC(2026, 9, 19, 10, 0, 0);
const stamp = m => ({ toMillis: () => m, toDate: () => new Date(m) });
const mval = v => (v && typeof v.toMillis === 'function' ? v.toMillis() : v);

function fakeDb(seed = {}) {
  const store = new Map(Object.entries(seed));
  const snap = p => ({ id: p.split('/').pop(), exists: store.has(p), data: () => store.get(p), ref: { delete: async () => { store.delete(p); } } });
  const docRef = path => ({ path, id: path.split('/').pop(), get: async () => snap(path), set: async d => { store.set(path, d); }, delete: async () => { store.delete(path); } });
  const colRef = path => ({
    doc: id => docRef(path + '/' + id),
    get: async () => ({ docs: [...store.entries()].filter(([p]) => p.startsWith(path + '/') && p.split('/').length === path.split('/').length + 1).map(([p]) => snap(p)) }),
  });
  return {
    store,
    collection: colRef,
    runTransaction: async fn => {
      const writes = [];
      const tx = { get: async r => snap(r.path), update: (r, d) => writes.push(() => store.set(r.path, { ...store.get(r.path), ...d })) };
      const out = await fn(tx);
      writes.forEach(w => w());
      return out;
    },
  };
}

let clock = T0;
function mk(seed = {}, extra = {}) {
  const sent = [];
  const base = {
    [`inbox_conversations/${BN}`]: { guestName: 'Test Guest', propertyName: 'Maxela Apartments', done: false },
    'inbox_push_devices/owner-phone-1': { subscription: { endpoint: 'https://web.push.apple.com/AAA', keys: { p256dh: 'p', auth: 'a' } } },
    // a staff phone from the old admin list: must never get a guest message
    'push_subscriptions/staff-phone': { subscription: { endpoint: 'https://web.push.apple.com/STAFF', keys: { p256dh: 'p', auth: 'a' } } },
  };
  const d = {
    db: fakeDb({ ...base, ...seed }),
    nowMs: () => clock, now: () => stamp(clock), ts: stamp,
    sendNotification: async (sub, body) => { sent.push({ endpoint: sub.endpoint, payload: JSON.parse(body) }); },
    ...extra,
  };
  return { d, sent };
}
const guest = (text, at = clock) => ({ direction: 'guest', text, sentAt: stamp(at), createdAt: stamp(at) });

test('one push per burst: the first message pushes, words that follow do not', async () => {
  clock = T0;
  const { d, sent } = mk();
  assert.strictEqual((await C.onGuestMessage(BN, 'm1', guest('Hello'), d)).action, 'pushed');
  for (let i = 2; i <= 6; i++) { clock += 30000; assert.strictEqual((await C.onGuestMessage(BN, 'm' + i, guest('word ' + i), d)).action, 'same burst'); }
  assert.strictEqual(sent.length, 2, 'six messages, one push to each of the two phones');
});

test('a new push only after 3 minutes without a guest message', async () => {
  clock = T0;
  const { d, sent } = mk();
  await C.onGuestMessage(BN, 'm1', guest('one'), d);
  clock += 2 * 60000 + 50000; await C.onGuestMessage(BN, 'm2', guest('two'), d);       // 2m50 later: same burst, restarts the quiet time
  clock += 2 * 60000 + 50000; await C.onGuestMessage(BN, 'm3', guest('three'), d);     // 2m50 after the last message: still same burst
  assert.strictEqual(sent.length, 2, 'one push, two phones');
  clock += 3 * 60000; const r = await C.onGuestMessage(BN, 'm4', guest('four'), d);    // 3 minutes of quiet: new burst
  assert.strictEqual(r.action, 'pushed');
  assert.strictEqual(sent.length, 4, 'a second push to the two phones');
});

test('the push says guest name, listing and the first line, and opens that conversation', async () => {
  clock = T0;
  const { d, sent } = mk();
  await C.onGuestMessage(BN, 'm1', guest('Hello, is there parking?\nSecond line that is not shown'), d);
  assert.deepStrictEqual(sent[0].payload, { title: 'Test Guest', body: 'Maxela Apartments · Hello, is there parking?', tag: `inbox-${BN}`, url: `/inbox#c/${BN}` });
  assert.strictEqual(P.firstLine('x'.repeat(200)).length, 90);
  assert.ok(P.firstLine('x'.repeat(200)).endsWith('...'));
  assert.strictEqual(P.firstLine('\n\n  hi there  \nsecond'), 'hi there');
});

test('every device in both lists gets it, and a phone on both lists gets it once', async () => {
  clock = T0;
  const both = { subscription: { endpoint: 'https://web.push.apple.com/BOTH', keys: { p256dh: 'p', auth: 'a' } } };
  const { d, sent } = mk({ 'push_subscriptions/phone-both': both, 'inbox_push_devices/phone-both-inbox': both });
  const r = await C.onGuestMessage(BN, 'm1', guest('Hello'), d);
  assert.deepStrictEqual(sent.map(s => s.endpoint).sort(), ['https://web.push.apple.com/AAA', 'https://web.push.apple.com/BOTH', 'https://web.push.apple.com/STAFF']);
  assert.strictEqual(r.sent, 3);
  assert.strictEqual(r.devices, 3, 'four documents, three phones');
});

test('with no device at all nothing is sent and nothing breaks', async () => {
  clock = T0;
  const { d, sent } = mk();
  d.db.store.delete('inbox_push_devices/owner-phone-1');
  d.db.store.delete('push_subscriptions/staff-phone');
  const r = await C.onGuestMessage(BN, 'm1', guest('Hello'), d);
  assert.strictEqual(sent.length, 0);
  assert.strictEqual(r.devices, 0);
});

test('no push for my own replies, old messages, a missing conversation, or when the switch is off', async () => {
  clock = T0;
  let { d, sent } = mk();
  assert.strictEqual((await C.onGuestMessage(BN, 'h1', { direction: 'host', text: 'my reply', sentAt: stamp(clock) }, d)).action, 'ignored');
  assert.strictEqual((await C.onGuestMessage(BN, 'm1', guest('old', clock - 2 * 3600000), d)).action, 'stale');
  assert.strictEqual((await C.onGuestMessage('999999999', 'm1', guest('x'), d)).action, 'no conversation');
  assert.strictEqual(sent.length, 0);
  ({ d, sent } = mk({ 'globals/config': { bookingAlertsEnabled: false } }));
  assert.strictEqual((await C.onGuestMessage(BN, 'm1', guest('Hello'), d)).action, 'alerts off');
  assert.strictEqual(sent.length, 0);
});

test('a cancellation request pushes once with the deadline; nothing else on that conversation does', async () => {
  clock = T0;
  const { d, sent } = mk();
  const deadline = T0 + 12 * 3600000;                         // 22:00 UTC = 02:00 next day Tbilisi
  const before = { guestName: 'Test Guest', propertyName: 'Maxela Apartments' };
  const after = { ...before, cancelRequest: { at: stamp(T0 - 60000), deadline: stamp(deadline) } };
  assert.strictEqual((await C.onConversationWritten(BN, before, after, d)).action, 'pushed');
  assert.strictEqual(sent[0].payload.title, 'Cancellation request');
  assert.match(sent[0].payload.body, /^Test Guest \(Maxela Apartments\): asks to cancel for free, answer in Booking\.com by 10\/20 02:00$/);
  assert.strictEqual(sent[0].payload.url, `/inbox#c/${BN}`);
  assert.strictEqual((await C.onConversationWritten(BN, after, { ...after, done: true }, d)).action, 'unchanged');
  assert.strictEqual((await C.onConversationWritten(BN, before, before, d)).action, 'no cancel request');
  const old = { ...before, cancelRequest: { at: stamp(T0 - 7 * 3600000), deadline: stamp(deadline) } };
  assert.strictEqual((await C.onConversationWritten(BN, before, old, d)).action, 'stale');
  assert.strictEqual(sent.length, 2, 'one alert, two phones');
});

test('a phone that no longer exists is removed from the list it is on, others are kept', async () => {
  clock = T0;
  const { d } = mk({}, { sendNotification: async sub => { if (sub.endpoint.endsWith('/STAFF')) { const e = new Error('gone'); e.statusCode = 410; throw e; } } });
  const r = await C.onGuestMessage(BN, 'm1', guest('Hello'), d);
  assert.strictEqual(r.removed, 1);
  assert.ok(!d.db.store.has('push_subscriptions/staff-phone'));
  assert.ok(d.db.store.has('inbox_push_devices/owner-phone-1'));
});

// ---------------------------------------------------------------- registering a phone
const goodSub = { endpoint: 'https://web.push.apple.com/XYZ123', keys: { p256dh: 'pk', auth: 'ak' } };

test('only the owner can register or remove a phone', async () => {
  const { d } = mk();
  const data = { action: 'register', deviceId: 'device-abcdef01', subscription: goodSub };
  await assert.rejects(C.alerts(null, data, d), { code: 'permission-denied' });
  await assert.rejects(C.alerts({ token: { email: 'staff@example.com', email_verified: true } }, data, d), { code: 'permission-denied' });
  await assert.rejects(C.alerts({ token: { email: 'nikavibliani@gmail.com', email_verified: false } }, data, d), { code: 'permission-denied' });
  assert.ok(!d.db.store.has('inbox_push_devices/device-abcdef01'));
});

test('register saves a clean subscription, sends a test alert, and status / unregister work', async () => {
  const { d, sent } = mk();
  const data = { action: 'register', deviceId: 'device-abcdef01', subscription: { ...goodSub, extra: 'x', expirationTime: null }, userAgent: 'iPhone' };
  assert.deepStrictEqual(await C.alerts(OWNER, data, d), { registered: true });
  const saved = d.db.store.get('inbox_push_devices/device-abcdef01');
  assert.deepStrictEqual(saved.subscription, goodSub);
  assert.strictEqual(saved.email, 'nikavibliani@gmail.com');
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].payload.title, 'Booking.com alerts are on');
  assert.deepStrictEqual(await C.alerts(OWNER, { action: 'status', deviceId: 'device-abcdef01' }, d), { registered: true });
  assert.deepStrictEqual(await C.alerts(OWNER, { action: 'unregister', deviceId: 'device-abcdef01' }, d), { registered: false });
  assert.deepStrictEqual(await C.alerts(OWNER, { action: 'status', deviceId: 'device-abcdef01' }, d), { registered: false });
});

test('bad subscriptions and ids are refused', async () => {
  const { d } = mk();
  const run = (over) => C.alerts(OWNER, { action: 'register', deviceId: 'device-abcdef01', subscription: goodSub, ...over }, d);
  await assert.rejects(run({ deviceId: 'x' }), { code: 'invalid-argument' });
  await assert.rejects(run({ subscription: { ...goodSub, endpoint: 'https://evil.example.com/x' } }), { code: 'invalid-argument' });
  await assert.rejects(run({ subscription: { ...goodSub, endpoint: 'http://web.push.apple.com/x' } }), { code: 'invalid-argument' });
  await assert.rejects(run({ subscription: { endpoint: goodSub.endpoint, keys: {} } }), { code: 'invalid-argument' });
  await assert.rejects(run({ subscription: null }), { code: 'invalid-argument' });
  await assert.rejects(C.alerts(OWNER, { action: 'nope', deviceId: 'device-abcdef01' }, d), { code: 'invalid-argument' });
  assert.ok(P.cleanSubscription({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: 'p', auth: 'a' } }).ok);
  assert.ok(P.cleanSubscription({ endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/abc', keys: { p256dh: 'p', auth: 'a' } }).ok);
});

test('a failed test alert is reported to the owner', async () => {
  const { d } = mk({}, { sendNotification: async () => { const e = new Error('nope'); e.statusCode = 403; throw e; } });
  await assert.rejects(C.alerts(OWNER, { action: 'register', deviceId: 'device-abcdef01', subscription: goodSub }, d), { code: 'failed-precondition' });
});

test('both inbox users can register a phone; the record says whose it is', async () => {
  const { d } = mk();
  const WIFE = { token: { email: 'nutsamargiani@gmail.com', email_verified: true } };
  await C.alerts(WIFE, { action: 'register', deviceId: 'device-wife-001', subscription: goodSub }, d);
  const saved = d.db.store.get('inbox_push_devices/device-wife-001');
  assert.strictEqual(saved.email, 'nutsamargiani@gmail.com');
  assert.strictEqual(saved.name, 'Nutsa');
  assert.deepStrictEqual(await C.alerts(WIFE, { action: 'status', deviceId: 'device-wife-001' }, d), { registered: true });
});
