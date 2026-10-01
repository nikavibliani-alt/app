'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  checkoutCutoffMs,
  runPostCheckoutSummary,
  createFirestoreSummaryStore,
} = require('./summarizer');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const PHONE = '995555123456';

// Checkout 2026-09-24 ends at 2026-09-25 00:00 Tbilisi = 2026-09-24 20:00 UTC.
const CUTOFF = Date.UTC(2026, 8, 24, 20, 0);
const AFTER_CHECKOUT = CUTOFF + 3 * HOUR;

function pastReservation(overrides = {}) {
  return {
    reservationNumber: '7001',
    roomCode: '6-2',
    checkin: '2026-09-20',
    checkout: '2026-09-24',
    status: 'OK',
    syncedAt: 'sync-pass-1',
    ...overrides,
  };
}

function msg(id, role, timestampMs, content = `${role} ${id}`) {
  return { id, role, content, timestampMs };
}

/** In-memory store with the same interface as createFirestoreSummaryStore. No delete for messages exists. */
function fakeStore({ messages = [], latest = null, form = { contact: `+${PHONE}`, contactType: 'wa' } } = {}) {
  const state = { messages: [...messages], markers: new Map(), latest, latestWrites: 0, listCalls: 0 };
  state.store = {
    async getMarker(rn) { return state.markers.get(rn) || null; },
    async claimMarker(rn, data) {
      if (state.markers.has(rn)) return false;
      state.markers.set(rn, { ...data, status: 'processing' });
      return true;
    },
    async finishMarker(rn, data) { state.markers.set(rn, { ...state.markers.get(rn), ...data, status: 'done' }); },
    async releaseMarker(rn) { state.markers.delete(rn); },
    async findWaFormForReservation() { return form; },
    async getLatestSummary() { return state.latest; },
    async listMessages(phone, { fromMs, toMs }) {
      state.listCalls += 1;
      return state.messages.filter((m) => m.timestampMs < toMs && (!Number.isFinite(fromMs) || m.timestampMs >= fromMs));
    },
    async writeLatestSummary(phone, data) { state.latest = data; state.latestWrites += 1; },
  };
  return state;
}

function countingSummarize(text = '- stayed in 6-2\n- asked about parking') {
  const fn = async (conversationText) => { fn.calls += 1; fn.texts.push(conversationText); return text; };
  fn.calls = 0;
  fn.texts = [];
  return fn;
}

test('checkoutCutoffMs — end of the checkout day in Tbilisi', () => {
  assert.equal(checkoutCutoffMs('2026-09-24'), CUTOFF);
  assert.equal(checkoutCutoffMs(new Date(Date.UTC(2026, 8, 24, 10))), CUTOFF, 'Date/Timestamp checkout uses its Tbilisi day');
  assert.ok(Number.isNaN(checkoutCutoffMs('')));
});

test('summarizes once and saves the summary on the marker and as the latest summary', async () => {
  const s = fakeStore({ messages: [msg('u1', 'user', CUTOFF - 30 * HOUR), msg('o1', 'owner', CUTOFF - 29 * HOUR)] });
  const r = await runPostCheckoutSummary({
    reservation: pastReservation(), nowMs: AFTER_CHECKOUT, store: s.store, summarize: countingSummarize(),
  });
  assert.equal(r.outcome, 'summarized');
  const marker = s.markers.get('7001');
  assert.equal(marker.status, 'done');
  assert.deepEqual(marker.summary, ['stayed in 6-2', 'asked about parking']);
  assert.equal(marker.stay.reservationNumber, '7001');
  assert.deepEqual(s.latest.summary, marker.summary);
  assert.equal(s.latest.lastStay.checkout, '2026-09-24');
});

test('never deletes any message — guest, bot, or owner, before or after checkout', async () => {
  const messages = [
    msg('u1', 'user', CUTOFF - 30 * HOUR, 'Can I move rooms?'),
    msg('o1', 'owner', CUTOFF - 29 * HOUR, 'Unfortunately not possible today.'),
    msg('a1', 'assistant', CUTOFF - 28 * HOUR),
    msg('u2', 'user', AFTER_CHECKOUT + HOUR, 'I forgot my charger'),
  ];
  const s = fakeStore({ messages });
  await runPostCheckoutSummary({
    reservation: pastReservation(), nowMs: AFTER_CHECKOUT + 2 * HOUR, store: s.store, summarize: countingSummarize(),
  });
  assert.deepEqual(s.messages, messages, 'conversation is byte-for-byte unchanged');
});

test('the Firestore store never deletes anything under whatsapp_conversations', async () => {
  // Minimal fake Firestore that records every write/delete path.
  const ops = [];
  const docs = new Map([
    ['checkin_guests/f1', { matchedReservationId: '7001', contactType: 'wa', contact: `+${PHONE}` }],
    [`whatsapp_conversations/${PHONE}/messages/m1`, { role: 'user', content: 'hi', timestamp: new Date(CUTOFF - 5 * HOUR) }],
    [`whatsapp_conversations/${PHONE}/messages/m2`, { role: 'owner', content: 'hello', timestamp: new Date(CUTOFF - 4 * HOUR) }],
  ]);
  const snapOf = (path) => ({ id: path.split('/').pop(), exists: docs.has(path), data: () => docs.get(path) });
  const query = (prefix, filters = []) => ({
    where: (field, op, value) => query(prefix, [...filters, { field, op, value }]),
    orderBy: () => query(prefix, filters),
    limit: () => query(prefix, filters),
    async get() {
      const matches = [...docs.keys()]
        .filter((p) => p.startsWith(`${prefix}/`) && !p.slice(prefix.length + 1).includes('/'))
        .filter((p) => filters.every(({ field, op, value }) => {
          const v = docs.get(p)[field];
          if (op === '==') return v === value;
          if (op === '<') return v < value;
          if (op === '>=') return v >= value;
          throw new Error(`unsupported op ${op}`);
        }));
      return { empty: matches.length === 0, docs: matches.map(snapOf) };
    },
  });
  const collection = (prefix) => ({
    ...query(prefix),
    doc: (id) => {
      const path = `${prefix}/${id}`;
      return {
        collection: (name) => collection(`${path}/${name}`),
        get: async () => snapOf(path),
        create: async (data) => {
          if (docs.has(path)) throw Object.assign(new Error('already exists'), { code: 6 });
          ops.push(['create', path]); docs.set(path, data);
        },
        set: async (data) => { ops.push(['set', path]); docs.set(path, { ...docs.get(path), ...data }); },
        delete: async () => { ops.push(['delete', path]); docs.delete(path); },
      };
    },
  });
  const db = { collection };
  const FieldValue = { serverTimestamp: () => 'SERVER_TS' };

  const r = await runPostCheckoutSummary({
    reservation: pastReservation(),
    nowMs: AFTER_CHECKOUT,
    store: createFirestoreSummaryStore(db, FieldValue),
    summarize: countingSummarize(),
  });
  assert.equal(r.outcome, 'summarized');
  assert.equal(r.messageCount, 2);
  assert.deepEqual(ops.filter(([op]) => op === 'delete'), [], 'no delete of any kind on success');
  assert.ok(!ops.some(([, path]) => path.startsWith('whatsapp_conversations/')), 'no write to the conversation at all');
  assert.ok(docs.has(`whatsapp_conversations/${PHONE}/messages/m1`));
  assert.ok(docs.has(`whatsapp_conversations/${PHONE}/messages/m2`));
  assert.deepEqual(docs.get('whatsapp_checkout_summaries/7001').summary, ['stayed in 6-2', 'asked about parking']);
  assert.deepEqual(docs.get(`whatsapp_guests/${PHONE}`).summary, ['stayed in 6-2', 'asked about parking']);
});

test('a second trigger for the same reservation does nothing', async (t) => {
  await t.test('later MiniHotel sync rewrites exit on the marker', async () => {
    const s = fakeStore({ messages: [msg('u1', 'user', CUTOFF - 30 * HOUR)] });
    const summarize = countingSummarize();
    await runPostCheckoutSummary({ reservation: pastReservation(), nowMs: AFTER_CHECKOUT, store: s.store, summarize });
    const markerAfterFirst = { ...s.markers.get('7001') };

    for (let pass = 2; pass <= 6; pass += 1) {
      const r = await runPostCheckoutSummary({
        reservation: pastReservation({ syncedAt: `sync-pass-${pass}` }),
        nowMs: AFTER_CHECKOUT + pass * 10 * 60 * 1000,
        store: s.store,
        summarize,
      });
      assert.equal(r.outcome, 'already_processed');
    }
    assert.equal(summarize.calls, 1, 'Claude called once only');
    assert.equal(s.listCalls, 1, 'later passes never read the conversation');
    assert.equal(s.latestWrites, 1, 'latest summary written once');
    assert.deepEqual(s.markers.get('7001'), markerAfterFirst, 'marker unchanged');
  });

  await t.test('two near-simultaneous triggers: only one claim wins', async () => {
    const s = fakeStore({ messages: [msg('u1', 'user', CUTOFF - 30 * HOUR)] });
    const summarize = countingSummarize();
    const args = { reservation: pastReservation(), nowMs: AFTER_CHECKOUT, store: s.store, summarize };
    const results = await Promise.all([runPostCheckoutSummary(args), runPostCheckoutSummary(args)]);
    assert.deepEqual(results.map((r) => r.outcome).sort(), ['already_processed', 'summarized']);
    assert.equal(summarize.calls, 1);
  });

  await t.test('a sync rewrite before the checkout day has ended does nothing', async () => {
    const s = fakeStore({ messages: [msg('u1', 'user', CUTOFF - 5 * HOUR)] });
    const summarize = countingSummarize();
    const r = await runPostCheckoutSummary({
      reservation: pastReservation(), nowMs: CUTOFF - 1, store: s.store, summarize,
    });
    assert.equal(r.outcome, 'not_checked_out');
    assert.equal(summarize.calls, 0);
    assert.equal(s.markers.size, 0);
  });
});

test('a failed summary releases the claim so a later write retries', async () => {
  const s = fakeStore({ messages: [msg('u1', 'user', CUTOFF - 30 * HOUR)] });
  const r = await runPostCheckoutSummary({
    reservation: pastReservation(), nowMs: AFTER_CHECKOUT, store: s.store, summarize: countingSummarize(''),
  });
  assert.equal(r.outcome, 'summary_failed');
  assert.equal(s.markers.size, 0);
  assert.equal(s.latest, null);

  const retry = await runPostCheckoutSummary({
    reservation: pastReservation(), nowMs: AFTER_CHECKOUT + HOUR, store: s.store, summarize: countingSummarize(),
  });
  assert.equal(retry.outcome, 'summarized');
});

test('returning guest: each stay is summarized from its own messages only', async () => {
  const previousStay = { checkout: '2026-09-10', reservationNumber: '6001' };
  const previousCutoff = checkoutCutoffMs(previousStay.checkout);
  const s = fakeStore({
    latest: { summary: ['old stay notes'], lastStay: previousStay },
    messages: [
      msg('old', 'user', previousCutoff - DAY, 'old stay question'),
      msg('new', 'user', CUTOFF - DAY, 'new stay question'),
    ],
  });
  const summarize = countingSummarize();
  await runPostCheckoutSummary({ reservation: pastReservation(), nowMs: AFTER_CHECKOUT, store: s.store, summarize });
  assert.match(summarize.texts[0], /new stay question/);
  assert.doesNotMatch(summarize.texts[0], /old stay question/);
  assert.equal(s.messages.length, 2, 'old stay messages still kept');
});

test('a late-processed older checkout does not overwrite a newer stay\'s latest summary', async () => {
  const newer = { summary: ['newer stay'], lastStay: { checkout: '2026-10-05', reservationNumber: '7002' } };
  const s = fakeStore({ latest: newer, messages: [msg('u1', 'user', CUTOFF - DAY)] });
  const r = await runPostCheckoutSummary({
    reservation: pastReservation(), nowMs: Date.UTC(2026, 9, 6), store: s.store, summarize: countingSummarize(),
  });
  assert.equal(r.outcome, 'summarized');
  assert.ok(s.markers.get('7001').summary, 'older stay summary still kept on its marker');
  assert.equal(s.latest, newer, 'latest summary untouched');
});

test('no messages in the stay: marked done, nothing written to the guest', async () => {
  const s = fakeStore({ messages: [] });
  const r = await runPostCheckoutSummary({
    reservation: pastReservation(), nowMs: AFTER_CHECKOUT, store: s.store, summarize: countingSummarize(),
  });
  assert.equal(r.outcome, 'no_messages');
  assert.equal(s.markers.get('7001').status, 'done');
  assert.equal(s.latestWrites, 0);
});
