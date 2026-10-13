'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { handle } = require('../controllers/inboxEmailIngest');

function fakeDb() {
  const store = new Map();
  return {
    store,
    collection: name => ({
      doc: id => ({
        create: async data => {
          const k = name + '/' + id;
          if (store.has(k)) { const e = new Error('exists'); e.code = 6; throw e; }
          store.set(k, data);
        },
      }),
    }),
  };
}
function run(req, db = fakeDb()) {
  return new Promise(resolve => {
    const res = { status(c) { this.code = c; return this; }, json(b) { resolve({ code: this.code, body: b, db }); } };
    const headers = req.headers || {};
    handle({ method: 'POST', get: n => headers[n.toLowerCase()], ...req }, res, { getKey: () => 'secret', db, now: () => 'NOW' });
  });
}
const auth = { authorization: 'Bearer secret' };
const good = { gmailMessageId: 'abc123def456', subject: 's', bodyText: 't', headers: { 'Message-ID': 'x', Cookie: 'no' } };

test('rejects wrong or missing key', async () => {
  assert.strictEqual((await run({ headers: {}, body: good })).code, 401);
  assert.strictEqual((await run({ headers: { authorization: 'Bearer nope' }, body: good })).code, 401);
});
test('rejects non-POST', async () => {
  assert.strictEqual((await run({ method: 'GET', headers: auth, body: good })).code, 405);
});
test('rejects bad message id', async () => {
  assert.strictEqual((await run({ headers: auth, body: { ...good, gmailMessageId: 'a/b' } })).code, 400);
});
test('saves once, keeps allowed headers only, second time is a duplicate', async () => {
  const db = fakeDb();
  const a = await run({ headers: auth, body: good }, db);
  assert.deepStrictEqual(a.body, { ok: true, duplicate: false });
  const saved = db.store.get('inbox_raw_emails/abc123def456');
  assert.strictEqual(saved.source, 'gmail-script');
  assert.strictEqual(saved.receivedAt, 'NOW');
  assert.deepStrictEqual(Object.keys(saved.headers), ['message-id']);
  const b = await run({ headers: auth, body: good }, db);
  assert.deepStrictEqual(b.body, { ok: true, duplicate: true });
  assert.strictEqual(db.store.size, 1);
});
test('cuts oversize HTML', async () => {
  const db = fakeDb();
  await run({ headers: auth, body: { ...good, bodyHtml: 'x'.repeat(500000) } }, db);
  assert.strictEqual(db.store.get('inbox_raw_emails/abc123def456').bodyHtml.length, 200 * 1024);
});
