'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runHotelCollectAlert, shouldAlert, buildTexts } = require('../controllers/hotelCollectAlert');

const NOW = Date.parse('2026-10-02T08:00:00Z'); // 12:00 Tbilisi, 2026-10-02

function makeDb({ ownerPhone = '995555000111', existing = new Set() } = {}) {
  const alerts = new Map();
  return {
    alerts,
    collection(name) {
      return {
        doc(id) {
          return {
            async create(data) {
              if (name === 'hc_alerts') {
                if (existing.has(id) || alerts.has(id)) { const e = new Error('ALREADY_EXISTS'); e.code = 6; throw e; }
                alerts.set(id, data);
              }
            },
            async set(data) { if (name === 'hc_alerts') alerts.set(id, { ...(alerts.get(id) || {}), ...data }); },
            async get() { return { exists: name === 'globals', data: () => ({ ownerPhone }) }; },
          };
        },
      };
    },
  };
}
const doc = (o = {}) => ({ reservationNumber: '007004955', guest: 'Yanping Wang', roomCode: 'tab-2', checkin: '2026-10-04', checkout: '2026-10-07', hotelCollect: true, ...o });

function deps(db, over = {}) {
  const calls = { push: [], wa: [] };
  return {
    calls,
    d: {
      db, now: NOW,
      sendPush: async (p) => { calls.push.push(p); },
      sendWhatsApp: async (to, t) => { calls.wa.push([to, t]); return { ok: true }; },
      ...over,
    },
  };
}

test('new Hotel Collect booking fires push + WhatsApp once', async () => {
  const db = makeDb(); const { calls, d } = deps(db);
  const r = await runHotelCollectAlert({ id: '007004955', before: null, after: doc() }, d);
  assert.equal(r.fired, true);
  assert.equal(calls.push.length, 1);
  assert.equal(calls.push[0].url, '/checkin-admin?hc=007004955');
  assert.equal(calls.push[0].tag, 'hc-007004955');
  assert.match(calls.push[0].body, /Yanping Wang · tab-2 · 2026-10-04–2026-10-07 · #007004955 — check if real/);
  assert.equal(calls.wa.length, 1);
  assert.match(calls.wa[0][1], /checkin-admin\?hc=007004955/);
  assert.equal(db.alerts.get('007004955').whatsapp, 'sent');
});

test('true -> true update does not fire', async () => {
  const { calls, d } = deps(makeDb());
  const r = await runHotelCollectAlert({ id: 'x', before: doc(), after: doc({ syncedAt: 'later' }) }, d);
  assert.equal(r.fired, false);
  assert.equal(calls.push.length, 0);
});

test('missing/false -> true fires (field added to existing doc)', async () => {
  const { d } = deps(makeDb());
  const r = await runHotelCollectAlert({ id: 'x', before: doc({ hotelCollect: undefined }), after: doc() }, d);
  assert.equal(r.fired, true);
});

test('past booking does not fire', async () => {
  const { calls, d } = deps(makeDb());
  const r = await runHotelCollectAlert({ id: 'x', before: null, after: doc({ checkin: '2026-09-20', checkout: '2026-09-25' }) }, d);
  assert.equal(r.fired, false);
  assert.equal(calls.push.length, 0);
});

test('checkout today still fires', () => {
  assert.equal(shouldAlert(null, doc({ checkout: '2026-10-02' }), '2026-10-02'), true);
});

test('already reviewed does not fire', async () => {
  const { calls, d } = deps(makeDb());
  const r = await runHotelCollectAlert({ id: 'x', before: null, after: doc({ hcReview: { status: 'verified' } }) }, d);
  assert.equal(r.fired, false);
  assert.equal(calls.push.length, 0);
});

test('not Hotel Collect does not fire', async () => {
  const { d } = deps(makeDb());
  assert.equal((await runHotelCollectAlert({ id: 'x', before: null, after: doc({ hotelCollect: false }) }, d)).fired, false);
  assert.equal((await runHotelCollectAlert({ id: 'x', before: null, after: doc({ hotelCollect: undefined }) }, d)).fired, false);
});

test('second doc of the same multi-room booking does not fire again', async () => {
  const db = makeDb(); const { calls, d } = deps(db);
  await runHotelCollectAlert({ id: '007004955', before: null, after: doc() }, d);
  const r2 = await runHotelCollectAlert({ id: '007004955_002', before: null, after: doc({ reservationNumber: '007004955_002', roomCode: 'tab-3' }) }, d);
  assert.equal(r2.fired, false);
  assert.equal(r2.reason, 'already_alerted');
  assert.equal(calls.push.length, 1);
});

test('WhatsApp error does not block push or throw', async () => {
  const db = makeDb(); const { calls, d } = deps(db, { sendWhatsApp: async () => ({ ok: false, error: { code: 131047 } }) });
  const r = await runHotelCollectAlert({ id: 'x', before: null, after: doc() }, d);
  assert.equal(r.fired, true);
  assert.equal(r.pushSent, true);
  assert.equal(r.whatsapp, 'failed');
  assert.equal(calls.push.length, 1);
});

test('WhatsApp throwing does not block push or throw', async () => {
  const { calls, d } = deps(makeDb(), { sendWhatsApp: async () => { throw new Error('network'); } });
  const r = await runHotelCollectAlert({ id: 'x', before: null, after: doc() }, d);
  assert.equal(r.fired, true);
  assert.equal(calls.push.length, 1);
});

test('empty ownerPhone skips WhatsApp but still pushes', async () => {
  const { calls, d } = deps(makeDb({ ownerPhone: '' }));
  const r = await runHotelCollectAlert({ id: 'x', before: null, after: doc() }, d);
  assert.equal(r.whatsapp, 'skipped_no_owner_phone');
  assert.equal(calls.push.length, 1);
  assert.equal(calls.wa.length, 0);
});

test('push failure does not throw and WhatsApp still goes out', async () => {
  const { calls, d } = deps(makeDb(), { sendPush: async () => { throw new Error('push down'); } });
  const r = await runHotelCollectAlert({ id: 'x', before: null, after: doc() }, d);
  assert.equal(r.fired, true);
  assert.equal(r.pushSent, false);
  assert.equal(calls.wa.length, 1);
});

test('texts contain no emoji', () => {
  const t = buildTexts(doc(), '007004955');
  assert.doesNotMatch(t.whatsapp + t.body, /[\u{1F000}-\u{1FAFF}☀-➿]/u);
});
