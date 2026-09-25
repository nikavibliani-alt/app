'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  latestCompletedCheckoutMs,
  currentStayMessages,
  toClaudeHistory,
  loadCurrentStayHistory,
} = require('./stayContext');
const {
  shouldStaySilentFromHistory,
  findMostRecentOwnerMessage,
} = require('./ownerSilence');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const PHONE = '995555123456';

// Previous stay checked out 2026-09-10 -> cutoff 2026-09-10 20:00 UTC.
const PREV_CUTOFF = Date.UTC(2026, 8, 10, 20, 0);
const NOW = PREV_CUTOFF + 30 * DAY;

function m(role, content, atMs) {
  return { role, content, timestamp: new Date(atMs) };
}

// Newest first, as the worker reads it. The new stay starts with one guest
// message; everything older belongs to the previous stay.
function returningGuestHistory(newGuestText) {
  return [
    m('user', newGuestText, NOW - 30 * 1000),
    // --- previous stay ---
    m('assistant', 'Let me check on that and get back to you shortly.', PREV_CUTOFF - 2 * DAY),
    m('user', 'Can I get a late checkout?', PREV_CUTOFF - 2 * DAY - HOUR),
    m('owner', 'Yes, checkout at 2pm is fine.', PREV_CUTOFF - 3 * DAY),
    m('assistant', 'We do not have private parking, but there is paid parking under Carrefour.\n[VIDEO_SENT:975338858914982]', PREV_CUTOFF - 4 * DAY),
    m('user', 'Where can I park?', PREV_CUTOFF - 4 * DAY - HOUR),
  ];
}

test('latestCompletedCheckoutMs picks the newest checkout that has already ended', () => {
  const markers = [
    { phone: PHONE, cutoffMs: PREV_CUTOFF - 60 * DAY },
    { phone: PHONE, cutoffMs: PREV_CUTOFF },
    { phone: PHONE, cutoffMs: NOW + DAY }, // not ended yet
    { phone: PHONE }, // malformed
  ];
  assert.equal(latestCompletedCheckoutMs(markers, NOW), PREV_CUTOFF);
  assert.ok(Number.isNaN(latestCompletedCheckoutMs([], NOW)));
});

test('currentStayMessages', async (t) => {
  await t.test('drops messages at or before the boundary', () => {
    const scoped = currentStayMessages(returningGuestHistory('hi'), PREV_CUTOFF);
    assert.deepEqual(scoped.map((x) => x.content), ['hi']);
  });
  await t.test('no previous checkout: history unchanged', () => {
    const all = returningGuestHistory('hi');
    assert.equal(currentStayMessages(all, NaN), all);
  });
});

test('returning guest: previous stay must not affect the new stay', async (t) => {
  await t.test('old Host reply: a new-stay "okay" is not silenced as an ack to it, and no Host: line reaches Claude', () => {
    const all = [m('user', 'okay', NOW - 1000), m('owner', 'Yes, checkout at 2pm is fine.', PREV_CUTOFF - DAY)];
    assert.equal(shouldStaySilentFromHistory(all, 'okay'), true, 'the bug this guards against');
    const scoped = currentStayMessages(all, PREV_CUTOFF);
    assert.equal(shouldStaySilentFromHistory(scoped, 'okay'), false);
    assert.equal(findMostRecentOwnerMessage(scoped), null, 'owner continuation silence has nothing to key off');
    assert.ok(!toClaudeHistory(scoped).some((h) => h.content.startsWith('Host:')));
  });

  await t.test('old escalation: a new-stay "hello?" is not silenced as a waiting nudge', () => {
    const all = returningGuestHistory('hello?');
    assert.equal(shouldStaySilentFromHistory(all, 'hello?'), true, 'the bug this guards against');
    const scoped = currentStayMessages(all, PREV_CUTOFF);
    assert.equal(shouldStaySilentFromHistory(scoped, 'hello?'), false);
    assert.ok(!toClaudeHistory(scoped).some((h) => /get back to you/.test(h.content)));
  });

  await t.test('old video marker: the new stay\'s Claude history has no [VIDEO_SENT]', () => {
    const all = returningGuestHistory('Where can I park?');
    assert.ok(toClaudeHistory(all).some((h) => h.content.includes('[VIDEO_SENT:975338858914982]')), 'the bug this guards against');
    const history = toClaudeHistory(currentStayMessages(all, PREV_CUTOFF));
    assert.deepEqual(history, [{ role: 'user', content: 'Where can I park?' }]);
  });

  await t.test('messages within the current stay still work as before', () => {
    const history = [
      m('user', 'thanks', NOW - 1000),
      m('owner', 'The code is on your check-in page.', NOW - 2 * 60 * 1000),
      m('user', 'Where is the door code?', NOW - 3 * 60 * 1000),
      ...returningGuestHistory('x').slice(1),
    ];
    const scoped = currentStayMessages(history, PREV_CUTOFF);
    assert.equal(scoped.length, 3);
    assert.equal(shouldStaySilentFromHistory(scoped, 'thanks'), true, 'current-stay Host answer still closes the topic');
    assert.equal(findMostRecentOwnerMessage(scoped).content, 'The code is on your check-in page.');
  });
});

test('toClaudeHistory keeps the existing role mapping', () => {
  const newestFirst = [m('user', 'b', 3), m('owner', 'a', 2), m('assistant', 'z', 1)];
  assert.deepEqual(toClaudeHistory(newestFirst), [
    { role: 'assistant', content: 'z' },
    { role: 'assistant', content: 'Host: a' },
    { role: 'user', content: 'b' },
  ]);
});

// Minimal fake Firestore for loadCurrentStayHistory's two queries.
function fakeDb({ markers = [], messages = [], markerQueryFails = false } = {}) {
  const messageQuery = (filters = [], order = null, max = Infinity) => ({
    where: (field, op, value) => messageQuery([...filters, { field, op, value }], order, max),
    orderBy: (field, dir) => messageQuery(filters, { field, dir }, max),
    limit: (n) => messageQuery(filters, order, n),
    async get() {
      let docs = messages.filter((doc) => filters.every(({ field, op, value }) => {
        if (op === '>') return doc[field] > value;
        throw new Error(`unsupported op ${op}`);
      }));
      if (order) docs = [...docs].sort((a, b) => (order.dir === 'desc' ? b[order.field] - a[order.field] : a[order.field] - b[order.field]));
      return { docs: docs.slice(0, max).map((doc) => ({ data: () => doc })) };
    },
  });
  return {
    collection(name) {
      if (name === 'whatsapp_checkout_summaries') {
        return {
          where: (field, op, value) => ({
            async get() {
              if (markerQueryFails) throw new Error('unavailable');
              return { docs: markers.filter((x) => x[field] === value).map((x) => ({ data: () => x })) };
            },
          }),
        };
      }
      assert.equal(name, 'whatsapp_conversations');
      return { doc: (phone) => ({ collection: () => { assert.equal(phone, PHONE); return messageQuery(); } }) };
    },
  };
}

test('loadCurrentStayHistory (Firestore path)', async (t) => {
  const markers = [
    { phone: PHONE, cutoffMs: PREV_CUTOFF },
    { phone: '4917000000', cutoffMs: NOW - HOUR }, // another guest's checkout
  ];

  await t.test('returns only the current stay, newest first', async () => {
    const db = fakeDb({ markers, messages: returningGuestHistory('Where can I park?') });
    const { recentNewestFirst, stayStartMs } = await loadCurrentStayHistory(db, PHONE, NOW);
    assert.equal(stayStartMs, PREV_CUTOFF);
    assert.deepEqual(recentNewestFirst.map((x) => x.content), ['Where can I park?']);
  });

  await t.test('the 15-message limit counts current-stay messages only', async () => {
    const current = Array.from({ length: 20 }, (_, i) => m('user', `new ${i}`, NOW - i * 60 * 1000));
    const db = fakeDb({ markers, messages: [...current, ...returningGuestHistory('x').slice(1)] });
    const { recentNewestFirst } = await loadCurrentStayHistory(db, PHONE, NOW);
    assert.equal(recentNewestFirst.length, 15);
    assert.ok(recentNewestFirst.every((x) => x.content.startsWith('new ')));
  });

  await t.test('no previous checkout for this phone: unchanged, last 15 of everything', async () => {
    const db = fakeDb({ markers: markers.slice(1), messages: returningGuestHistory('hi') });
    const { recentNewestFirst, stayStartMs } = await loadCurrentStayHistory(db, PHONE, NOW);
    assert.ok(Number.isNaN(stayStartMs));
    assert.equal(recentNewestFirst.length, 6);
  });

  await t.test('marker lookup failure falls back to the unscoped history instead of failing the reply', async () => {
    const db = fakeDb({ markers, messages: returningGuestHistory('hi'), markerQueryFails: true });
    const { recentNewestFirst } = await loadCurrentStayHistory(db, PHONE, NOW);
    assert.equal(recentNewestFirst.length, 6);
  });
});
