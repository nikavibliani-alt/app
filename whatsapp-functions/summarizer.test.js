'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  checkoutCutoffMs,
  isActiveOrFutureReservation,
  messagesInStayWindow,
  deletableMessageIds,
  runPostCheckoutSummary,
} = require('./summarizer');

const HOUR = 60 * 60 * 1000;
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

/** In-memory store with the same interface as createFirestoreSummaryStore. */
function fakeStore({ messages = [], linkedReservations = [], form = { contact: `+${PHONE}`, contactType: 'wa' } } = {}) {
  const markers = new Map();
  const state = {
    messages: [...messages],
    markers,
    summaries: [],
    deletedIds: [],
    listCalls: 0,
  };
  state.store = {
    async getMarker(rn) { return markers.get(rn) || null; },
    async claimMarker(rn, data) {
      if (markers.has(rn)) return false;
      markers.set(rn, { ...data, status: 'processing' });
      return true;
    },
    async finishMarker(rn, data) { markers.set(rn, { ...(markers.get(rn) || {}), ...data, status: 'done' }); },
    async releaseMarker(rn) { markers.delete(rn); },
    async findWaFormForReservation() { return form; },
    async findReservationsForPhone() { return linkedReservations; },
    async listMessages() { state.listCalls += 1; return [...state.messages]; },
    async deleteMessages(phone, ids) {
      state.deletedIds.push(...ids);
      state.messages = state.messages.filter((m) => !ids.includes(m.id));
    },
    async writeSummary(phone, data) { state.summaries.push({ phone, ...data }); },
  };
  return state;
}

function countingSummarize(text = '- stayed in 6-2\n- asked about parking') {
  const fn = async () => { fn.calls += 1; return text; };
  fn.calls = 0;
  return fn;
}

test('checkoutCutoffMs — end of the checkout day in Tbilisi', () => {
  assert.equal(checkoutCutoffMs('2026-09-24'), CUTOFF);
  assert.equal(checkoutCutoffMs(new Date(Date.UTC(2026, 8, 24, 10))), CUTOFF, 'Date/Timestamp checkout uses its Tbilisi day');
  assert.ok(Number.isNaN(checkoutCutoffMs('')));
});

test('isActiveOrFutureReservation', () => {
  const now = AFTER_CHECKOUT;
  assert.equal(isActiveOrFutureReservation({ checkout: '2026-09-28', status: 'OK' }, now), true, 'current stay');
  assert.equal(isActiveOrFutureReservation({ checkout: '2026-10-15', status: 'OK2' }, now), true, 'future stay');
  assert.equal(isActiveOrFutureReservation({ checkout: '2026-09-24', status: 'OK' }, now), false, 'already over');
  assert.equal(isActiveOrFutureReservation({ checkout: '2026-10-15', status: 'CL' }, now), false, 'cancelled');
});

test('(a) MiniHotel sync rewrites with no real checkout change never re-trigger summarization or deletion', async (t) => {
  await t.test('rewrite before the checkout day has ended: nothing happens', async () => {
    const s = fakeStore({ messages: [msg('u1', 'user', CUTOFF - 5 * HOUR)] });
    const summarize = countingSummarize();
    const r = await runPostCheckoutSummary({
      reservation: pastReservation(), nowMs: CUTOFF - 1, store: s.store, summarize,
    });
    assert.equal(r.outcome, 'not_checked_out');
    assert.equal(summarize.calls, 0);
    assert.deepEqual(s.deletedIds, []);
    assert.equal(s.markers.size, 0);
  });

  await t.test('first write after checkout summarizes once; every later sync pass is a no-op', async () => {
    const s = fakeStore({
      messages: [msg('u1', 'user', CUTOFF - 30 * HOUR), msg('a1', 'assistant', CUTOFF - 29 * HOUR)],
    });
    const summarize = countingSummarize();

    const first = await runPostCheckoutSummary({
      reservation: pastReservation(), nowMs: AFTER_CHECKOUT, store: s.store, summarize,
    });
    assert.equal(first.outcome, 'summarized');
    assert.equal(summarize.calls, 1);
    assert.deepEqual(s.deletedIds.sort(), ['a1', 'u1']);

    // Guest writes again after checkout ("I forgot my charger"), then the sync
    // keeps rewriting the same reservation every ~10 minutes for days.
    s.messages.push(msg('u2', 'user', AFTER_CHECKOUT + HOUR, 'I forgot my charger'));
    for (let pass = 2; pass <= 6; pass += 1) {
      const r = await runPostCheckoutSummary({
        reservation: pastReservation({ syncedAt: `sync-pass-${pass}` }),
        nowMs: AFTER_CHECKOUT + pass * 10 * 60 * 1000,
        store: s.store,
        summarize,
      });
      assert.equal(r.outcome, 'already_processed');
    }
    assert.equal(summarize.calls, 1, 'Claude was not called again');
    assert.equal(s.summaries.length, 1, 'summary was not overwritten');
    assert.deepEqual(s.deletedIds.sort(), ['a1', 'u1'], 'nothing further deleted');
    assert.ok(s.messages.some((m) => m.id === 'u2'), 'post-checkout message kept');
    assert.equal(s.listCalls, 1, 'later passes never even read the conversation');
  });

  await t.test('two near-simultaneous writes: only one claim wins', async () => {
    const s = fakeStore({ messages: [msg('u1', 'user', CUTOFF - 30 * HOUR)] });
    const summarize = countingSummarize();
    const args = { reservation: pastReservation(), nowMs: AFTER_CHECKOUT, store: s.store, summarize };
    const results = await Promise.all([runPostCheckoutSummary(args), runPostCheckoutSummary(args)]);
    assert.deepEqual(results.map((r) => r.outcome).sort(), ['already_processed', 'summarized']);
    assert.equal(summarize.calls, 1);
  });

  await t.test('failed summary deletes nothing and releases the claim so a later write retries', async () => {
    const s = fakeStore({ messages: [msg('u1', 'user', CUTOFF - 30 * HOUR)] });
    const failing = countingSummarize('');
    const r = await runPostCheckoutSummary({
      reservation: pastReservation(), nowMs: AFTER_CHECKOUT, store: s.store, summarize: failing,
    });
    assert.equal(r.outcome, 'summary_failed');
    assert.deepEqual(s.deletedIds, []);
    assert.equal(s.markers.size, 0);

    const retry = await runPostCheckoutSummary({
      reservation: pastReservation(), nowMs: AFTER_CHECKOUT + HOUR, store: s.store, summarize: countingSummarize(),
    });
    assert.equal(retry.outcome, 'summarized');
  });
});

test('(b) a phone with an active or future reservation keeps its conversation', async (t) => {
  const conversation = () => [
    msg('old1', 'user', CUTOFF - 48 * HOUR, 'old stay question'),
    msg('old2', 'assistant', CUTOFF - 47 * HOUR),
    msg('new1', 'user', CUTOFF + HOUR, 'new stay question'),
    msg('new2', 'assistant', CUTOFF + 2 * HOUR),
  ];

  await t.test('back-to-back / returning stay linked to the phone: nothing summarized or deleted', async () => {
    const s = fakeStore({
      messages: conversation(),
      linkedReservations: [
        pastReservation(),
        { reservationNumber: '7002', checkin: '2026-09-24', checkout: '2026-09-29', status: 'OK' },
      ],
    });
    const summarize = countingSummarize();
    for (let pass = 1; pass <= 3; pass += 1) {
      const r = await runPostCheckoutSummary({
        reservation: pastReservation({ syncedAt: `sync-pass-${pass}` }),
        nowMs: AFTER_CHECKOUT + pass * 10 * 60 * 1000,
        store: s.store,
        summarize,
      });
      assert.equal(r.outcome, 'deferred_active_stay');
      assert.equal(r.otherReservationNumber, '7002');
    }
    assert.equal(summarize.calls, 0);
    assert.deepEqual(s.deletedIds, []);
    assert.equal(s.messages.length, 4, 'full conversation retained');
    assert.equal(s.summaries.length, 0, 'previous-stay notes untouched');
  });

  await t.test('a cancelled other reservation does not block the summary', async () => {
    const s = fakeStore({
      messages: conversation(),
      linkedReservations: [{ reservationNumber: '7003', checkout: '2026-10-10', status: 'CL' }],
    });
    const r = await runPostCheckoutSummary({
      reservation: pastReservation(), nowMs: AFTER_CHECKOUT, store: s.store, summarize: countingSummarize(),
    });
    assert.equal(r.outcome, 'summarized');
  });

  await t.test('even if the next stay is not linked, its messages (after this checkout) are never deleted', async () => {
    const s = fakeStore({ messages: conversation(), linkedReservations: [] });
    const r = await runPostCheckoutSummary({
      reservation: pastReservation(), nowMs: AFTER_CHECKOUT + 5 * HOUR, store: s.store, summarize: countingSummarize(),
    });
    assert.equal(r.outcome, 'summarized');
    assert.deepEqual(s.deletedIds.sort(), ['old1', 'old2']);
    assert.deepEqual(s.messages.map((m) => m.id).sort(), ['new1', 'new2']);
  });

  await t.test('messages with no usable timestamp are never deleted', () => {
    const window = messagesInStayWindow([msg('x', 'user', NaN), msg('y', 'user', CUTOFF - 1)], CUTOFF);
    assert.deepEqual(window.map((m) => m.id), ['y']);
  });
});

test('(c) owner messages are never removed by the post-checkout path', async (t) => {
  await t.test('deletableMessageIds excludes every owner message', () => {
    const window = [msg('u', 'user', 1), msg('o1', 'owner', 2), msg('a', 'assistant', 3), msg('o2', 'owner', 4)];
    assert.deepEqual(deletableMessageIds(window), ['u', 'a']);
  });

  await t.test('full summarize run deletes guest/bot messages but keeps the owner\'s', async () => {
    const s = fakeStore({
      messages: [
        msg('u1', 'user', CUTOFF - 30 * HOUR, 'Can I move rooms?'),
        msg('o1', 'owner', CUTOFF - 29 * HOUR, 'Unfortunately not possible today.'),
        msg('u2', 'user', CUTOFF - 28 * HOUR, 'okay'),
        msg('o2', 'owner', CUTOFF - 20 * HOUR, 'Safe travels'),
      ],
    });
    const seen = [];
    const summarize = async (text) => { seen.push(text); return '- asked to move rooms'; };
    const r = await runPostCheckoutSummary({
      reservation: pastReservation(), nowMs: AFTER_CHECKOUT, store: s.store, summarize,
    });
    assert.equal(r.outcome, 'summarized');
    assert.equal(r.keptOwnerCount, 2);
    assert.deepEqual(s.deletedIds.sort(), ['u1', 'u2']);
    assert.deepEqual(s.messages.map((m) => m.id).sort(), ['o1', 'o2']);
    assert.match(seen[0], /Host: Unfortunately not possible today\./, 'owner messages still inform the summary');
  });

  await t.test('owner-only conversation: nothing deleted', async () => {
    const s = fakeStore({ messages: [msg('o1', 'owner', CUTOFF - 10 * HOUR)] });
    const r = await runPostCheckoutSummary({
      reservation: pastReservation(), nowMs: AFTER_CHECKOUT, store: s.store, summarize: countingSummarize(),
    });
    assert.equal(r.deletedCount, 0);
    assert.deepEqual(s.deletedIds, []);
    assert.equal(s.messages.length, 1);
  });

  await t.test('a failure after the summary is written keeps the claim and loses no owner message', async () => {
    const s = fakeStore({
      messages: [msg('u1', 'user', CUTOFF - 30 * HOUR), msg('o1', 'owner', CUTOFF - 29 * HOUR)],
    });
    s.store.deleteMessages = async () => { throw new Error('batch commit failed'); };
    await assert.rejects(runPostCheckoutSummary({
      reservation: pastReservation(), nowMs: AFTER_CHECKOUT, store: s.store, summarize: countingSummarize(),
    }), /batch commit failed/);
    assert.equal(s.markers.get('7001').outcome, 'delete_failed', 'not released — no re-summarize of leftovers');
    assert.equal(s.messages.length, 2);
  });
});
