'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { computeInboxStats, statsRelevantChange } = require('../lib/inboxStats');
const { refreshInboxStats } = require('../controllers/inboxStats');

test('counts conversations that need a reply, like the inbox page', () => {
  const list = [
    { done: false, needsReply: true, messageCount: 2 },                                   // counts
    { done: true, needsReply: true, messageCount: 1 },                                    // done
    { done: false, needsReply: false, messageCount: 3 },                                  // I wrote last
    { done: false, needsReply: false, messageCount: 0 },                                  // no chat, hidden
    { done: false, needsReply: false, messageCount: 0, cancelRequest: { at: 1 } },        // cancel request counts
    { done: true, cancelRequest: { at: 1 } },                                             // done
    { done: false, needsReply: true, messageCount: 1, cancelRequest: { at: 1 } },         // counts, and a cancel request
  ];
  assert.deepStrictEqual(computeInboxStats(list), { needsReply: 3, cancelRequests: 2 });
  assert.deepStrictEqual(computeInboxStats([]), { needsReply: 0, cancelRequests: 0 });
  assert.deepStrictEqual(computeInboxStats(undefined), { needsReply: 0, cancelRequests: 0 });
});

test('only changes that affect the number trigger a recount', () => {
  const a = { done: false, needsReply: true, messageCount: 1, aiDraft: null };
  assert.ok(!statsRelevantChange(a, { ...a, aiDraft: { kind: 'reply' }, aiDraftTimes: [1] }));
  assert.ok(statsRelevantChange(a, { ...a, done: true }));
  assert.ok(statsRelevantChange(a, { ...a, needsReply: false }));
  assert.ok(statsRelevantChange(a, { ...a, cancelRequest: { at: 1 } }));
  assert.ok(statsRelevantChange(null, a));
  assert.ok(statsRelevantChange(a, null));
});

test('the stats document is written only when a number changed', async () => {
  const store = new Map([
    ['inbox_conversations/1', { done: false, needsReply: true, messageCount: 1 }],
    ['inbox_conversations/2', { done: true, needsReply: true, messageCount: 1 }],
  ]);
  let writes = 0;
  const db = {
    collection: name => ({
      where: (f, op, v) => ({ get: async () => ({ docs: [...store.entries()].filter(([p, d]) => p.startsWith(name + '/') && d[f] === v).map(([p, d]) => ({ id: p, data: () => d })) }) }),
      doc: id => ({ get: async () => ({ exists: store.has(name + '/' + id), data: () => store.get(name + '/' + id) }), set: async d => { writes++; store.set(name + '/' + id, { ...(store.get(name + '/' + id) || {}), ...d }); } }),
    }),
  };
  const deps = { db, now: () => 'NOW' };
  assert.deepStrictEqual(await refreshInboxStats(deps), { needsReply: 1, cancelRequests: 0, arrivalsWaiting: 0, changed: true });
  assert.strictEqual(store.get('globals/inboxStats').needsReply, 1);
  assert.strictEqual((await refreshInboxStats(deps)).changed, false);
  assert.strictEqual(writes, 1);
  store.set('inbox_conversations/3', { done: false, needsReply: true, messageCount: 2 });
  assert.deepStrictEqual(await refreshInboxStats(deps), { needsReply: 2, cancelRequests: 0, arrivalsWaiting: 0, changed: true });
});

test('a cancellation request on a booking that is already cancelled needs nothing; check-in changes count', () => {
  assert.deepStrictEqual(computeInboxStats([
    { done: false, messageCount: 0, cancelRequest: { at: 1 }, reservationStatus: 'CANCELLED' },        // booking cancelled: not counted
    { done: false, messageCount: 0, cancelRequest: { at: 1 }, reservationStatus: 'OK2' },              // counted
    { done: false, needsReply: true, messageCount: 1, reservationStatus: 'CANCELLED' },                // a real guest message still counts
  ]), { needsReply: 2, cancelRequests: 1 });
  const a = { done: false, needsReply: true, messageCount: 0 };
  assert.ok(statsRelevantChange(a, { ...a, checkinRequest: { time: '17:00' } }));
  assert.ok(statsRelevantChange(a, { ...a, reservationStatus: 'CANCELLED' }));
});

test('arrivals today waiting for a reply: a number only, today\'s check-ins that still need an answer', () => {
  const { arrivalsWaiting, tbilisiToday } = require('../lib/inboxStats');
  assert.strictEqual(tbilisiToday(Date.UTC(2026, 10, 9, 21, 0, 0)), '2026-11-10');   // 01:00 in Tbilisi already the next day
  const today = '2026-11-09';
  const list = [
    { checkin: today, needsReply: true, messageCount: 1 },
    { checkin: today, needsReply: true, messageCount: 2, done: true },
    { checkin: today, needsReply: true, messageCount: 1, reservationStatus: 'CANCELLED' },
    { checkin: '2026-11-10', needsReply: true, messageCount: 1 },
    { checkin: today, needsReply: false, messageCount: 1 },
    { checkin: today, needsReply: true, messageCount: 1 },
  ];
  assert.strictEqual(arrivalsWaiting(list, today), 2);
  assert.strictEqual(arrivalsWaiting([], today), 0);
});
