'use strict';
const test = require('node:test');
const assert = require('node:assert');
const R = require('../controllers/inboxReview');

const NIKA = { token: { email: 'nikavibliani@gmail.com', email_verified: true } };
const NUTSA = { token: { email: 'nutsamargiani@gmail.com', email_verified: true } };
const db = (docs = { 'inbox_review/abc123xyz': { resolved: false, reason: 'r' } }) => {
  const store = new Map(Object.entries(docs));
  return {
    store,
    collection: n => ({ doc: id => ({ path: n + '/' + id }) }),
    runTransaction: async fn => { const w = []; const out = await fn({ get: async r => ({ exists: store.has(r.path), data: () => store.get(r.path) }), update: (r, d) => w.push(() => store.set(r.path, { ...store.get(r.path), ...d })) }); w.forEach(f => f()); return out; },
  };
};

test('Handled: both inbox users, nobody else; sets resolved and who', async () => {
  const d = db();
  const deps = { db: d, now: () => 'NOW' };
  await assert.rejects(R.markHandled(null, { id: 'abc123xyz' }, deps), { code: 'permission-denied' });
  await assert.rejects(R.markHandled({ token: { email: 'x@example.com', email_verified: true } }, { id: 'abc123xyz' }, deps), { code: 'permission-denied' });
  await assert.rejects(R.markHandled(NIKA, { id: 'a/b' }, deps), { code: 'invalid-argument' });
  await assert.rejects(R.markHandled(NIKA, { id: 'missing-one' }, deps), { code: 'not-found' });
  assert.deepStrictEqual(await R.markHandled(NUTSA, { id: 'abc123xyz' }, deps), { ok: true });
  const v = d.store.get('inbox_review/abc123xyz');
  assert.strictEqual(v.resolved, true);
  assert.strictEqual(v.resolvedBy, 'nutsamargiani@gmail.com');
});
