'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { urgentPushPayload, sendOwnerPush, PUSH_KINDS } = require('./ownerPush');

const quiet = () => {
  const lines = [];
  return { lines, log: { log: (m) => lines.push(['log', m]), error: (m) => lines.push(['error', m]) } };
};

test('urgentPushPayload: one title per alert type, property + room like the WhatsApp alert', () => {
  const base = { guestName: 'Anna Petrova', roomCode: '6-2', guestText: 'The lock is not opening, battery dead I think', phone: '995555123456' };
  assert.deepEqual(urgentPushPayload({ ...base, kind: 'lockout' }), {
    title: 'URGENT: Shartava 6-2 locked out',
    body: 'Anna Petrova: The lock is not opening, battery dead I think',
    url: '/checkin-admin',
    tag: 'wa-lockout-123456',
  });
  assert.equal(urgentPushPayload({ ...base, kind: 'issue' }).title, 'URGENT: Shartava 6-2 flooding or security issue');
  assert.equal(urgentPushPayload({ ...base, kind: 'angry', roomCode: 'tab-1' }).title, 'URGENT: Freedom Square tab-1 angry guest');
  const err = urgentPushPayload({ ...base, kind: 'bot_error', reason: 'Bot could not reply: Claude credit is empty' });
  assert.equal(err.title, 'Bot could not reply: Shartava 6-2');
  assert.equal(err.body, 'Bot could not reply: Claude credit is empty. Anna Petrova: The lock is not opening, battery dead I think');
  assert.deepEqual(PUSH_KINDS, ['lockout', 'issue', 'angry', 'bot_error']);
});

test('urgentPushPayload: unknown room, no name, long message, no text', () => {
  const p = urgentPushPayload({ kind: 'lockout', guestName: '', roomCode: '', guestText: 'x'.repeat(300) });
  assert.equal(p.title, 'URGENT: unknown property locked out');
  assert.ok(p.body.startsWith('Guest: xxx'));
  assert.ok(p.body.length <= 'Guest: '.length + 100, 'only the start of the message');
  assert.ok(p.body.endsWith('…'));
  assert.equal(urgentPushPayload({ kind: 'angry', guestName: 'Lisa', roomCode: 'xcv-1', guestText: '' }).body, 'Lisa');
  assert.equal(urgentPushPayload({ kind: 'angry', guestName: 'Lisa', roomCode: 'xcv-1', guestText: 'line one\nline two' }).body, 'Lisa: line one line two');
});

test('sendOwnerPush', async (t) => {
  const payload = { title: 'URGENT: Shartava 6-2 locked out', body: 'Anna: help', url: '/checkin-admin', tag: 'x' };

  await t.test('sends to every subscribed device', async () => {
    const q = quiet(); const sent = [];
    const r = await sendOwnerPush({
      payload,
      loadSubscriptions: async () => [{ id: 'f0ed7fa2-iphone', subscription: { endpoint: 'https://web.push.apple.com/abc' } }],
      send: async (sub, p) => { sent.push([sub.endpoint, p.title]); },
      log: q.log,
    });
    assert.deepEqual(r, { ok: true, sent: 1, failed: 0, devices: 1 });
    assert.deepEqual(sent, [['https://web.push.apple.com/abc', 'URGENT: Shartava 6-2 locked out']]);
    assert.ok(q.lines.some(([lvl, m]) => lvl === 'log' && /owner push sent to 1 of 1 device/.test(m)));
  });

  await t.test('no subscribed device: logged clearly, never throws', async () => {
    const q = quiet();
    const r = await sendOwnerPush({ payload, loadSubscriptions: async () => [], send: async () => {}, log: q.log });
    assert.equal(r.ok, false);
    assert.ok(q.lines.some(([lvl, m]) => lvl === 'error' && /owner push FAILED: no subscribed devices/.test(m)));
  });

  await t.test('expired subscription (410): logged, never throws', async () => {
    const q = quiet();
    const r = await sendOwnerPush({
      payload,
      loadSubscriptions: async () => [{ id: 'f0ed7fa2-iphone', subscription: {} }],
      send: async () => { const e = new Error('Gone'); e.statusCode = 410; throw e; },
      log: q.log,
    });
    assert.deepEqual(r, { ok: false, sent: 0, failed: 1, devices: 1 });
    assert.ok(q.lines.some(([lvl, m]) => lvl === 'error' && /owner push FAILED for device f0ed7fa2…: subscription expired \(410\)/.test(m)));
  });

  await t.test('one device fails, the other still gets it', async () => {
    const q = quiet();
    const r = await sendOwnerPush({
      payload,
      loadSubscriptions: async () => [{ id: 'a', subscription: { n: 1 } }, { id: 'b', subscription: { n: 2 } }],
      send: (sub) => { if (sub.n === 1) throw new Error('boom'); return Promise.resolve(); },
      log: q.log,
    });
    assert.deepEqual(r, { ok: true, sent: 1, failed: 1, devices: 2 });
  });

  await t.test('Firestore read fails: logged, never throws', async () => {
    const q = quiet();
    const r = await sendOwnerPush({ payload, loadSubscriptions: async () => { throw new Error('unavailable'); }, send: async () => {}, log: q.log });
    assert.equal(r.ok, false);
    assert.ok(q.lines.some(([lvl, m]) => lvl === 'error' && /could not read push_subscriptions/.test(m)));
  });
});
