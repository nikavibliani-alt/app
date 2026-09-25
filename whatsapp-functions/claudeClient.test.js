'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { callClaudeWithRetry, describeClaudeError, classifyError } = require('./claudeClient');

const KEY = 'sk-ant-test-SECRET-KEY';
const ok = (text) => ({ ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text }], stop_reason: 'end_turn' }) });
const fail = (status, message) => ({ ok: false, status, json: async () => ({ type: 'error', error: { type: 'x', message } }) });

/** Fake fetch returning the scripted responses in order; records calls. */
function scripted(...responses) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(init);
    const next = responses.shift();
    if (typeof next === 'function') return next(init);
    return next;
  };
  return { fetchImpl, calls };
}
function recorder() {
  const lines = [];
  return { lines, log: { warn: (m) => lines.push(m), error: (m) => lines.push(m), log: (m) => lines.push(m) } };
}
const base = (extra) => ({ apiKey: KEY, system: 'sys', messages: [{ role: 'user', content: 'hi' }], sleep: async () => {}, ...extra });

test('success on the first attempt', async () => {
  const f = scripted(ok('Hello'));
  const r = await callClaudeWithRetry(base({ fetchImpl: f.fetchImpl }));
  assert.deepEqual({ ok: r.ok, text: r.text, attempts: r.attempts }, { ok: true, text: 'Hello', attempts: 1 });
  assert.equal(f.calls[0].headers['x-api-key'], KEY);
  assert.ok(f.calls[0].signal, 'request carries an abort signal for the timeout');
});

test('credit balance too low: no retry, classified, plain description', async () => {
  const f = scripted(fail(400, 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.'));
  const rec = recorder();
  const r = await callClaudeWithRetry(base({ fetchImpl: f.fetchImpl, log: rec.log }));
  assert.equal(r.ok, false);
  assert.equal(r.errorType, 'credit');
  assert.equal(r.status, 400);
  assert.equal(r.attempts, 1);
  assert.equal(f.calls.length, 1, 'not retried');
  assert.equal(describeClaudeError(r), 'Claude credit is empty');
  assert.match(rec.lines.join('\n'), /credit \(HTTP 400\)/);
});

test('529 overloaded, then success on the retry', async () => {
  const f = scripted(fail(529, 'Overloaded'), ok('Here you go'));
  const waits = [];
  const r = await callClaudeWithRetry(base({ fetchImpl: f.fetchImpl, sleep: async (ms) => waits.push(ms), retryDelayMs: 1500, log: recorder().log }));
  assert.deepEqual({ ok: r.ok, text: r.text, attempts: r.attempts }, { ok: true, text: 'Here you go', attempts: 2 });
  assert.deepEqual(waits, [1500], 'waited once before retrying');
});

test('529 twice: fails after exactly two attempts', async () => {
  const f = scripted(fail(529, 'Overloaded'), fail(529, 'Overloaded'));
  const r = await callClaudeWithRetry(base({ fetchImpl: f.fetchImpl, log: recorder().log }));
  assert.equal(r.errorType, 'overloaded');
  assert.equal(r.attempts, 2);
  assert.equal(f.calls.length, 2);
  assert.equal(describeClaudeError(r), 'Claude API error 529 (overloaded)');
});

test('timeout: the request is aborted, retried once, then reported as a timeout', async () => {
  const hang = (init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  const f = scripted(hang, hang);
  const started = Date.now();
  const r = await callClaudeWithRetry(base({ fetchImpl: f.fetchImpl, timeoutMs: 30, log: recorder().log }));
  assert.equal(r.ok, false);
  assert.equal(r.errorType, 'timeout');
  assert.equal(r.attempts, 2);
  assert.ok(Date.now() - started < 2000, 'both attempts were cut off by the timeout');
  assert.equal(describeClaudeError(r), 'Claude did not answer in time');
});

test('timeout on the first attempt, success on the retry', async () => {
  const hang = (init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  const f = scripted(hang, ok('Sorry for the wait'));
  const r = await callClaudeWithRetry(base({ fetchImpl: f.fetchImpl, timeoutMs: 30, log: recorder().log }));
  assert.deepEqual({ ok: r.ok, text: r.text, attempts: r.attempts }, { ok: true, text: 'Sorry for the wait', attempts: 2 });
});

test('429 and 500 are retried; 400 and 401 are not', async () => {
  for (const status of [429, 500]) {
    const f = scripted(fail(status, 'temporary'), ok('fine'));
    const r = await callClaudeWithRetry(base({ fetchImpl: f.fetchImpl, log: recorder().log }));
    assert.equal(r.ok, true, `${status} retried`);
  }
  for (const [status, type] of [[400, 'bad_request'], [401, 'auth']]) {
    const f = scripted(fail(status, 'nope'), ok('never reached'));
    const r = await callClaudeWithRetry(base({ fetchImpl: f.fetchImpl, log: recorder().log }));
    assert.equal(r.errorType, type);
    assert.equal(f.calls.length, 1, `${status} not retried`);
  }
});

test('network error is retried', async () => {
  const f = scripted(() => { throw new TypeError('fetch failed'); }, ok('back online'));
  const r = await callClaudeWithRetry(base({ fetchImpl: f.fetchImpl, log: recorder().log }));
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 2);
});

test('a 200 with no text counts as a failure, not an empty reply to send', async () => {
  const f = scripted({ ok: true, status: 200, json: async () => ({ content: [], stop_reason: 'end_turn' }) });
  const r = await callClaudeWithRetry(base({ fetchImpl: f.fetchImpl, log: recorder().log }));
  assert.equal(r.ok, false);
  assert.equal(r.errorType, 'empty_response');
  assert.equal(f.calls.length, 1);
});

test('the API key never appears in logs or in the result', async () => {
  const f = scripted(fail(529, 'Overloaded'), fail(401, 'invalid x-api-key'));
  const rec = recorder();
  const r = await callClaudeWithRetry(base({ fetchImpl: f.fetchImpl, log: rec.log }));
  assert.ok(!rec.lines.join('\n').includes(KEY));
  assert.ok(!JSON.stringify(r).includes(KEY));
});

test('classifyError', () => {
  assert.equal(classifyError(400, 'Your credit balance is too low'), 'credit');
  assert.equal(classifyError(400, 'messages: roles must alternate'), 'bad_request');
  assert.equal(classifyError(403, ''), 'auth');
  assert.equal(classifyError(503, ''), 'server');
});
