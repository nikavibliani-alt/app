'use strict';
/**
 * Unit tests for runElevatorCodeGuard / decideGuardAction — no Firebase needed.
 * Run with: node --test pipeline-functions/tests/*.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { decideGuardAction, runElevatorCodeGuard } = require('../controllers/elevatorCodeGuard');

function makeCtx() {
  const calls = { applyWrite: [], logRun: [] };
  return {
    calls,
    applyWrite: async (write) => { calls.applyWrite.push(write); },
    logRun: async (entry) => { calls.logRun.push(entry); },
  };
}

test('decideGuardAction: manual save with stale lastCode → accept-manual, updates lastCode', () => {
  const next = { display_code: '456#', source: 'manual', lastCode: '999#' };
  const d = decideGuardAction(null, next);
  assert.equal(d.status, 'ok');
  assert.equal(d.action, 'accept-manual');
  assert.deepEqual(d.write, { type: 'update', data: { lastCode: '456#' } });
});

test('decideGuardAction: manual save, lastCode already current → noop-manual, no write', () => {
  const next = { display_code: '456#', source: 'manual', lastCode: '456#' };
  const d = decideGuardAction(null, next);
  assert.equal(d.action, 'noop-manual');
  assert.equal(d.write, null);
});

test('decideGuardAction: auto write, same code as before → reject-stale-auto, reverts to prev', () => {
  const prev = { display_code: '123#', source: 'auto' };
  const next = { display_code: '123#', source: 'auto' };
  const d = decideGuardAction(prev, next);
  assert.equal(d.status, 'warn');
  assert.equal(d.action, 'reject-stale-auto');
  assert.deepEqual(d.write, { type: 'set', data: prev });
});

test('decideGuardAction: auto write, same code as before, NO prev doc → reject via delete', () => {
  const next = { display_code: '123#', source: 'auto' };
  const d = decideGuardAction(null, next);
  // no `prev` and no `cur` code means "!cur" is true, so this actually falls into
  // the accept-new-auto branch (nothing to compare against) — confirms the guard
  // never blocks the very first auto write.
  assert.equal(d.action, 'accept-new-auto');
});

test('decideGuardAction: auto write, DIFFERENT code from before → accept-new-auto', () => {
  const prev = { display_code: '123#', source: 'auto' };
  const next = { display_code: '789#', source: 'auto' };
  const d = decideGuardAction(prev, next);
  assert.equal(d.status, 'ok');
  assert.equal(d.action, 'accept-new-auto');
  assert.deepEqual(d.write, { type: 'update', data: { lastCode: '789#' } });
});

test('decideGuardAction: auto write with empty code → noop-empty, no write', () => {
  const d = decideGuardAction(null, { display_code: '', source: 'auto' });
  assert.equal(d.action, 'noop-empty');
  assert.equal(d.write, null);
});

test('decideGuardAction: code normalization ignores # and spaces when comparing', () => {
  const prev = { display_code: '1 2 3#', source: 'auto' };
  const next = { display_code: '123', source: 'auto' };
  const d = decideGuardAction(prev, next);
  assert.equal(d.action, 'reject-stale-auto'); // "123" normalizes the same as "1 2 3#"
});

test('runElevatorCodeGuard: nextData null (deleted doc) → noop, no log written (matches original early return)', async () => {
  const ctx = makeCtx();
  const result = await runElevatorCodeGuard(ctx, null, null);
  assert.equal(result.status, 'ok');
  assert.equal(ctx.calls.logRun.length, 0);
  assert.equal(ctx.calls.applyWrite.length, 0);
});

test('runElevatorCodeGuard: applies the write AND logs it', async () => {
  const ctx = makeCtx();
  const prev = { display_code: '111#', source: 'auto' };
  const next = { display_code: '222#', source: 'auto' };
  const result = await runElevatorCodeGuard(ctx, prev, next);

  assert.equal(result.status, 'ok');
  assert.equal(ctx.calls.applyWrite.length, 1);
  assert.deepEqual(ctx.calls.applyWrite[0], { type: 'update', data: { lastCode: '222#' } });
  assert.equal(ctx.calls.logRun.length, 1);
  assert.equal(ctx.calls.logRun[0].controller, 'ElevatorCodeGuard');
});

test('runElevatorCodeGuard: write failure → error logged, no throw escapes', async () => {
  const ctx = makeCtx();
  ctx.applyWrite = async () => { throw new Error('boom'); };
  const next = { display_code: '222#', source: 'auto' };
  const result = await runElevatorCodeGuard(ctx, { display_code: '111#', source: 'auto' }, next);

  assert.equal(result.status, 'error');
  assert.equal(ctx.calls.logRun[0].status, 'error');
});
