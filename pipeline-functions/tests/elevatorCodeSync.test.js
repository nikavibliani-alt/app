'use strict';
/**
 * Unit tests for runElevatorCodeSync — no Firebase, no emulator, no network.
 * Run with: node --test pipeline-functions/tests/*.test.js
 *
 * Every ctx method is a recording fake so each test can assert exactly what the
 * controller tried to read/write/log, without touching Firestore or RTDB at all.
 * There is no sendWhatsApp/writeAlert in this controller's ctx — Phase 1 is
 * read/sync/log only, by design (see controllers/elevatorCodeSync.js header).
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runElevatorCodeSync } = require('../controllers/elevatorCodeSync');

const HOUR = 3600 * 1000;
const NOW = Date.parse('2026-08-28T12:00:00Z');

function makeCtx({ fsData = null, rtdbData = null, failRead = false, failWrite = null } = {}) {
  const calls = { logRun: [], writeFirestoreElevator: [], writeRtdbElevator: [] };
  return {
    calls,
    now: () => NOW,
    readFirestoreElevator: async () => {
      if (failRead) throw new Error('boom-read');
      return fsData;
    },
    readRtdbElevator: async () => rtdbData,
    writeFirestoreElevator: async (data) => {
      calls.writeFirestoreElevator.push(data);
      if (failWrite === 'fs') throw new Error('boom-write-fs');
    },
    writeRtdbElevator: async (data) => {
      calls.writeRtdbElevator.push(data);
      if (failWrite === 'rtdb') throw new Error('boom-write-rtdb');
    },
    logRun: async (entry) => { calls.logRun.push(entry); },
  };
}

test('both fresh and matching → ok, no writes', async () => {
  const fresh = { display_code: '123#', updatedAt: String(NOW - HOUR), source: 'auto' };
  const ctx = makeCtx({ fsData: fresh, rtdbData: { ...fresh } });
  const result = await runElevatorCodeSync(ctx);

  assert.equal(result.status, 'ok');
  assert.equal(ctx.calls.logRun.length, 1);
  assert.equal(ctx.calls.logRun[0].status, 'ok');
  assert.equal(ctx.calls.writeFirestoreElevator.length, 0);
  assert.equal(ctx.calls.writeRtdbElevator.length, 0);
});

test('FS fresh, RTDB stale → syncs FS payload onto RTDB, warn', async () => {
  const fsFresh = { display_code: '456#', updatedAt: String(NOW - HOUR), source: 'manual', lastCode: '456#' };
  const rtdbStale = { display_code: '999#', updatedAt: String(NOW - 20 * HOUR), source: 'auto' };
  const ctx = makeCtx({ fsData: fsFresh, rtdbData: rtdbStale });
  const result = await runElevatorCodeSync(ctx);

  assert.equal(result.status, 'warn');
  assert.equal(ctx.calls.writeRtdbElevator.length, 1);
  assert.equal(ctx.calls.writeRtdbElevator[0].display_code, '456#');
  assert.equal(ctx.calls.writeFirestoreElevator.length, 0);
  assert.equal(ctx.calls.logRun[0].status, 'warn');
});

test('both fresh but codes differ, RTDB is manual → RTDB wins even though same age', async () => {
  const fsAuto = { display_code: '111#', updatedAt: String(NOW - HOUR), source: 'auto' };
  const rtdbManual = { display_code: '222#', updatedAt: String(NOW - HOUR), source: 'manual' };
  const ctx = makeCtx({ fsData: fsAuto, rtdbData: rtdbManual });
  const result = await runElevatorCodeSync(ctx);

  assert.equal(result.status, 'warn');
  assert.equal(ctx.calls.writeFirestoreElevator.length, 1);
  assert.equal(ctx.calls.writeFirestoreElevator[0].display_code, '222#');
  assert.equal(ctx.calls.writeRtdbElevator.length, 0);
});

test('both fresh, codes differ, neither manual → newer updatedAt wins', async () => {
  const fsOlder = { display_code: '111#', updatedAt: String(NOW - 2 * HOUR), source: 'auto' };
  const rtdbNewer = { display_code: '222#', updatedAt: String(NOW - 1 * HOUR), source: 'auto' };
  const ctx = makeCtx({ fsData: fsOlder, rtdbData: rtdbNewer });
  const result = await runElevatorCodeSync(ctx);

  assert.equal(result.status, 'warn');
  assert.equal(ctx.calls.writeFirestoreElevator.length, 1);
  assert.equal(ctx.calls.writeFirestoreElevator[0].display_code, '222#');
});

test('both stale ≥8h → warn, logged, nothing written (email monitor is the alert channel, not this controller)', async () => {
  const staleA = { display_code: '111#', updatedAt: String(NOW - 20 * HOUR), source: 'auto' };
  const staleB = { display_code: '222#', updatedAt: String(NOW - 30 * HOUR), source: 'auto' };
  const ctx = makeCtx({ fsData: staleA, rtdbData: staleB });
  const result = await runElevatorCodeSync(ctx);

  assert.equal(result.status, 'warn');
  assert.equal(ctx.calls.logRun.length, 1);
  assert.equal(ctx.calls.writeFirestoreElevator.length, 0);
  assert.equal(ctx.calls.writeRtdbElevator.length, 0);
});

test('both empty/missing → warn with "missing from both" message', async () => {
  const ctx = makeCtx({ fsData: null, rtdbData: null });
  const result = await runElevatorCodeSync(ctx);

  assert.equal(result.status, 'warn');
  assert.match(result.message, /missing from both/);
});

test('read failure → error logged, no throw escapes', async () => {
  const ctx = makeCtx({ failRead: true });
  const result = await runElevatorCodeSync(ctx); // must not throw

  assert.equal(result.status, 'error');
  assert.equal(ctx.calls.logRun.length, 1);
  assert.equal(ctx.calls.logRun[0].status, 'error');
});

test('sync write failure → error logged, not warn', async () => {
  const fsFresh = { display_code: '456#', updatedAt: String(NOW - HOUR), source: 'manual' };
  const rtdbStale = { display_code: '999#', updatedAt: String(NOW - 20 * HOUR), source: 'auto' };
  const ctx = makeCtx({ fsData: fsFresh, rtdbData: rtdbStale, failWrite: 'rtdb' });
  const result = await runElevatorCodeSync(ctx);

  assert.equal(result.status, 'error');
  assert.equal(ctx.calls.logRun[0].status, 'error');
});

test('same code but one side stale → still syncs (refreshes the stale side rather than leaving it stale forever)', async () => {
  const fsFresh = { display_code: '789#', updatedAt: String(NOW - HOUR), source: 'auto' };
  const rtdbStaleSameCode = { display_code: '789#', updatedAt: String(NOW - 20 * HOUR), source: 'auto' };
  const ctx = makeCtx({ fsData: fsFresh, rtdbData: rtdbStaleSameCode });
  const result = await runElevatorCodeSync(ctx);

  assert.equal(result.status, 'warn');
  assert.equal(ctx.calls.writeRtdbElevator.length, 1);
});
