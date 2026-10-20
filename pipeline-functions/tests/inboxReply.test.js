'use strict';
// Made-up data only. A tiny in-memory Firestore stands in for the real one.
const test = require('node:test');
const assert = require('node:assert');
const C = require('../controllers/inboxReply');
const L = require('../lib/inboxReply');

const OWNER = { token: { email: 'nikavibliani@gmail.com', email_verified: true } };
const NUM = '3000000001';
const GUEST_ADDR = `${NUM}-aa11.bb22.cc33.dd44@guest.booking.com`;
const CID = 'client-id-0001';

function fakeDb(seed = {}) {
  const store = new Map(Object.entries(seed));
  const mkSnap = p => ({ id: p.split('/').pop(), exists: store.has(p), data: () => store.get(p), ref: docRef(p) });
  const docRef = path => ({ path, id: path.split('/').pop(), collection: n => colRef(path + '/' + n) });
  const colRef = (path, f = []) => ({
    path, filters: f, ord: null, lim: null,
    doc: id => docRef(path + '/' + id),
    where(field, op, val) { return { ...this, filters: [...this.filters, [field, val]] }; },
    orderBy(field, dir) { return { ...this, ord: [field, dir] }; },
    limit(n) { return { ...this, lim: n }; },
    get() { return Promise.resolve(run(this)); },
  });
  const run = q => {
    const depth = q.path.split('/').length + 1;
    let rows = [...store.entries()].filter(([p]) => p.startsWith(q.path + '/') && p.split('/').length === depth);
    rows = rows.filter(([, d]) => q.filters.every(([f, v]) => d[f] === v));
    if (q.ord) rows.sort(([, a], [, b]) => (C_ms(a[q.ord[0]]) - C_ms(b[q.ord[0]])) * (q.ord[1] === 'desc' ? -1 : 1));
    if (q.lim) rows = rows.slice(0, q.lim);
    return { docs: rows.map(([p]) => mkSnap(p)) };
  };
  const C_ms = v => (v && v.toMillis ? v.toMillis() : 0);
  return {
    store,
    collection: n => colRef(n),
    runTransaction: async fn => {
      const writes = [];
      const tx = {
        get: async x => (x.filters ? run(x) : mkSnap(x.path)),
        create: (r, d) => { if (store.has(r.path) || writes.some(w => w.path === r.path && w.kind === 'create')) throw new Error('exists'); writes.push({ kind: 'create', path: r.path, d }); },
        update: (r, d) => writes.push({ kind: 'update', path: r.path, d }),
      };
      const out = await fn(tx);
      for (const w of writes) {
        if (w.kind === 'update' && !store.has(w.path)) throw new Error('update of a missing doc ' + w.path);
        store.set(w.path, w.kind === 'create' ? w.d : { ...store.get(w.path), ...w.d });
      }
      return out;
    },
    get: async x => run(x),
  };
}
let clock = 1_000_000;
const mkNow = () => () => { const v = clock; return { toMillis: () => v }; };
const T = ms => ({ toMillis: () => ms });
const seed = (over = {}) => ({
  [`inbox_conversations/${NUM}`]: { replyTo: GUEST_ADDR, done: false, needsReply: true, messageCount: 1, ...over },
  [`inbox_conversations/${NUM}/messages/gmail-old`]: { direction: 'guest', text: 'hi', sentAt: T(100) },
  [`inbox_conversations/${NUM}/messages/gmail-new`]: { direction: 'guest', text: 'hi again', sentAt: T(200) },
});
const deps = db => ({ db, now: mkNow() });

test('helpers: text cleaning, ids, addresses', () => {
  assert.strictEqual(L.cleanReplyText('  Hello\r\n\r\n\r\n\r\nthere \u0007 ').text, 'Hello\n\nthere');
  assert.ok(!L.cleanReplyText('   ').ok);
  assert.ok(!L.cleanReplyText('x'.repeat(2001)).ok);
  assert.ok(!L.cleanReplyText(5).ok);
  assert.ok(L.isGuestAddress('123456-aa11.bb22.cc33.dd44@guest.booking.com'));
  assert.ok(!L.isGuestAddress('someone@example.com'));
  assert.ok(!L.isGuestAddress('x@guest.booking.com.evil.com'));
});

test('check-in request link is the request page with no answer chosen', () => {
  const html = '<a href="https://admin.booking.com/hotel/hoteladmin/extranet_ng/manage/messaging/self_service.html?form_key=partner_approval&amp;hotel_id=555123&amp;ss_request_id=00123456789&amp;option=confirm">Accept</a>';
  const url = L.checkinRequestLink({ bodyHtml: html });
  assert.strictEqual(url, 'https://admin.booking.com/hotel/hoteladmin/extranet_ng/manage/messaging/self_service.html?form_key=partner_approval&hotel_id=555123&ss_request_id=00123456789');
  assert.ok(!url.includes('option'));
  assert.strictEqual(L.checkinRequestLink({ bodyHtml: '<a href="https://evil.example/self_service.html?hotel_id=1&ss_request_id=2">x</a>' }), null);
  assert.strictEqual(L.checkinRequestLink({}), null);
});

test('send: only the owner, and bad input is refused', async () => {
  const db = fakeDb(seed());
  await assert.rejects(C.sendReply(null, { bookingNumber: NUM, clientId: CID, text: 'x' }, deps(db)), { code: 'permission-denied' });
  await assert.rejects(C.sendReply({ token: { email: 'a@b.c', email_verified: true } }, { bookingNumber: NUM, clientId: CID, text: 'x' }, deps(db)), { code: 'permission-denied' });
  await assert.rejects(C.sendReply(OWNER, { bookingNumber: 'abc', clientId: CID, text: 'x' }, deps(db)), { code: 'invalid-argument' });
  await assert.rejects(C.sendReply(OWNER, { bookingNumber: NUM, clientId: 'x', text: 'x' }, deps(db)), { code: 'invalid-argument' });
  await assert.rejects(C.sendReply(OWNER, { bookingNumber: NUM, clientId: CID, text: '  ' }, deps(db)), { code: 'invalid-argument' });
  assert.strictEqual([...db.store.keys()].some(k => k.startsWith('inbox_outbox')), false);
});

test('send: saves a waiting host message and an outbox item, and marks the conversation answered', async () => {
  const db = fakeDb(seed());
  const r = await C.sendReply(OWNER, { bookingNumber: NUM, clientId: CID, text: 'Hello <b>there</b>\r\nWelcome' }, deps(db));
  assert.deepStrictEqual(r, { ok: true, outboxId: CID, duplicate: false });
  const o = db.store.get(`inbox_outbox/${CID}`);
  assert.strictEqual(o.status, 'waiting');
  assert.strictEqual(o.text, 'Hello <b>there</b>\nWelcome');
  assert.strictEqual(o.expectedTo, GUEST_ADDR);
  assert.strictEqual(o.gmailMessageId, 'gmail-new', 'replies to the newest guest message');
  const m = db.store.get(`inbox_conversations/${NUM}/messages/${CID}`);
  assert.strictEqual(m.direction, 'host');
  assert.strictEqual(m.status, 'waiting');
  const c = db.store.get(`inbox_conversations/${NUM}`);
  assert.strictEqual(c.needsReply, false);
  assert.strictEqual(c.done, true);
  assert.ok(c.lastMessagePreview.startsWith('You: Hello'));
});

test('send: the same request id twice makes one outbox item', async () => {
  const db = fakeDb(seed());
  await C.sendReply(OWNER, { bookingNumber: NUM, clientId: CID, text: 'one' }, deps(db));
  const again = await C.sendReply(OWNER, { bookingNumber: NUM, clientId: CID, text: 'one' }, deps(db));
  assert.strictEqual(again.duplicate, true);
  assert.strictEqual([...db.store.keys()].filter(k => k.startsWith('inbox_outbox/')).length, 1);
});

test('send: refuses when there is no guest address or no guest message', async () => {
  const noAddr = fakeDb(seed({ replyTo: 'noreply@booking.com' }));
  await assert.rejects(C.sendReply(OWNER, { bookingNumber: NUM, clientId: CID, text: 'x' }, deps(noAddr)), { code: 'failed-precondition' });
  const noMsg = fakeDb({ [`inbox_conversations/${NUM}`]: { replyTo: GUEST_ADDR } });
  await assert.rejects(C.sendReply(OWNER, { bookingNumber: NUM, clientId: CID, text: 'x' }, deps(noMsg)), { code: 'failed-precondition' });
  await assert.rejects(C.sendReply(OWNER, { bookingNumber: '999999999', clientId: CID, text: 'x' }, deps(fakeDb())), { code: 'not-found' });
});

async function withWaiting() {
  const db = fakeDb(seed());
  await C.sendReply(OWNER, { bookingNumber: NUM, clientId: CID, text: 'hello' }, deps(db));
  return db;
}

test('pull: gives a waiting reply once and marks it sending', async () => {
  const db = await withWaiting();
  const a = await C.pull(deps(db));
  assert.strictEqual(a.items.length, 1);
  assert.deepStrictEqual(Object.keys(a.items[0]).sort(), ['expectedTo', 'gmailMessageId', 'id', 'text']);
  assert.strictEqual(db.store.get(`inbox_outbox/${CID}`).status, 'sending');
  assert.strictEqual(db.store.get(`inbox_conversations/${NUM}/messages/${CID}`).status, 'sending');
  const b = await C.pull(deps(db));
  assert.strictEqual(b.items.length, 0, 'a second pull must not give it again');
});

test('pull: a reply stuck in sending for over 10 minutes becomes unknown and is never handed out again', async () => {
  const db = await withWaiting();
  await C.pull(deps(db));
  clock += 9 * 60 * 1000;
  assert.strictEqual((await C.pull(deps(db))).markedUnknown, 0);
  assert.strictEqual(db.store.get(`inbox_outbox/${CID}`).status, 'sending');
  clock += 2 * 60 * 1000;
  const r = await C.pull(deps(db));
  assert.strictEqual(r.markedUnknown, 1);
  assert.strictEqual(r.items.length, 0);
  assert.strictEqual(db.store.get(`inbox_outbox/${CID}`).status, 'unknown');
  assert.strictEqual(db.store.get(`inbox_conversations/${NUM}/messages/${CID}`).status, 'unknown');
  const c = db.store.get(`inbox_conversations/${NUM}`);
  assert.strictEqual(c.done, false);
  assert.strictEqual(c.needsReply, true);
  assert.strictEqual((await C.pull(deps(db))).items.length, 0);
});

test('report: sent and failed', async () => {
  const db = await withWaiting();
  await C.pull(deps(db));
  await C.report({ id: CID, result: 'sent' }, deps(db));
  assert.strictEqual(db.store.get(`inbox_outbox/${CID}`).status, 'sent');
  assert.strictEqual(db.store.get(`inbox_conversations/${NUM}/messages/${CID}`).status, 'sent');
  assert.strictEqual(db.store.get(`inbox_conversations/${NUM}`).done, true, 'a sent reply keeps the conversation done');

  const db2 = await withWaiting();
  await C.pull(deps(db2));
  await C.report({ id: CID, result: 'failed', reason: 'x'.repeat(500) }, deps(db2));
  assert.strictEqual(db2.store.get(`inbox_outbox/${CID}`).status, 'failed');
  assert.strictEqual(db2.store.get(`inbox_outbox/${CID}`).failReason.length, 300);
  const c = db2.store.get(`inbox_conversations/${NUM}`);
  assert.strictEqual(c.done, false);
  assert.strictEqual(c.needsReply, true);
});

test('report: a late "sent" after unknown is accepted; a report for a waiting item is ignored', async () => {
  const db = await withWaiting();
  assert.deepStrictEqual(await C.report({ id: CID, result: 'sent' }, deps(db)), { ok: true, ignored: 'waiting' });
  assert.strictEqual(db.store.get(`inbox_outbox/${CID}`).status, 'waiting');
  await C.pull(deps(db));
  clock += 11 * 60 * 1000;
  await C.pull(deps(db));
  await C.report({ id: CID, result: 'sent' }, deps(db));
  assert.strictEqual(db.store.get(`inbox_outbox/${CID}`).status, 'sent');
  await assert.rejects(C.report({ id: 'missing-id-1', result: 'sent' }, deps(db)), { code: 'not-found' });
  await assert.rejects(C.report({ id: CID, result: 'maybe' }, deps(db)), { code: 'invalid-argument' });
});

function call(req, d) {
  return new Promise(resolve => {
    const headers = req.headers || {};
    const res = { status(c) { this.code = c; return this; }, json(b) { resolve({ code: this.code, body: b }); } };
    C.handleOutbox({ method: 'POST', get: n => headers[n.toLowerCase()], ...req }, res, { getKey: () => 'secret', ...d });
  });
}

test('outbox endpoint: key, method and actions', async () => {
  const db = await withWaiting();
  const d = deps(db);
  assert.strictEqual((await call({ headers: {}, body: { action: 'pull' } }, d)).code, 401);
  assert.strictEqual((await call({ headers: { authorization: 'Bearer nope' }, body: { action: 'pull' } }, d)).code, 401);
  assert.strictEqual((await call({ method: 'GET', headers: { authorization: 'Bearer secret' } }, d)).code, 405);
  assert.strictEqual((await call({ headers: { authorization: 'Bearer secret' }, body: { action: 'nope' } }, d)).code, 400);
  const ok = await call({ headers: { authorization: 'Bearer secret' }, body: { action: 'pull' } }, d);
  assert.strictEqual(ok.code, 200);
  assert.strictEqual(ok.body.items.length, 1);
  const rep = await call({ headers: { authorization: 'Bearer secret' }, body: { action: 'report', id: CID, result: 'sent' } }, d);
  assert.strictEqual(rep.code, 200);
});

test('check-in link: finds the newest request email of the conversation', async () => {
  const mk = (hid, rid, date) => ({ conversationId: NUM, sortedAs: 'checkin_request', date, bodyHtml: `<a href="https://admin.booking.com/hotel/hoteladmin/extranet_ng/manage/messaging/self_service.html?form_key=partner_approval&amp;hotel_id=${hid}&amp;ss_request_id=${rid}&amp;option=confirm">x</a>` });
  const db = fakeDb({
    'inbox_raw_emails/a': mk('555123', '00000000001', '2026-10-01T00:00:00Z'),
    'inbox_raw_emails/b': mk('555123', '00000000002', '2026-10-02T00:00:00Z'),
    'inbox_raw_emails/c': { conversationId: NUM, sortedAs: 'chat', date: '2026-10-03T00:00:00Z', bodyHtml: '' },
  });
  const r = await C.checkinLink(OWNER, { bookingNumber: NUM }, deps(db));
  assert.ok(r.url.endsWith('ss_request_id=00000000002'));
  assert.deepStrictEqual(await C.checkinLink(OWNER, { bookingNumber: '999999999' }, deps(db)), { url: null });
  await assert.rejects(C.checkinLink(null, { bookingNumber: NUM }, deps(db)), { code: 'permission-denied' });
});

test('reply warnings', async () => {
  const { replyWarnings } = await import('../../shared/inbox-reply-warnings.js');
  assert.deepStrictEqual(replyWarnings('Welcome, see you at 14:00. The elevator is on the left.'), []);
  assert.deepStrictEqual(replyWarnings('Details at https://app.maxelaapartments.com/checkin-guest and app.maxelaapartments.com'), []);
  assert.ok(replyWarnings('Look at https://example.com/x').some(w => /link/.test(w)));
  assert.ok(replyWarnings('see www.evil.ge now').some(w => /link/.test(w)));
  assert.ok(replyWarnings('mail me at a.b@example.com').some(w => /email/.test(w)));
  assert.ok(replyWarnings('call +995 555 12 34 56').some(w => /phone/.test(w)));
  assert.ok(!replyWarnings('Check-in is 14:00 to 15:00').some(w => /phone/.test(w)));
  assert.ok(replyWarnings('The door code is 4821').some(w => /door code/.test(w)));
  assert.ok(replyWarnings('wifi password: Sun12345').some(w => /door code or WiFi/.test(w)));
  assert.ok(!replyWarnings('Please send your passport photo').some(w => /door code/.test(w)));
});

test('send: pokes the script after saving, once, and never fails the send if the poke fails', async () => {
  const db = fakeDb(seed());
  let pokes = 0;
  const r = await C.sendReply(OWNER, { bookingNumber: NUM, clientId: CID, text: 'hi' }, { ...deps(db), trigger: async () => { pokes++; } });
  assert.strictEqual(r.duplicate, false);
  assert.strictEqual(pokes, 1);
  assert.strictEqual(db.store.get(`inbox_outbox/${CID}`).status, 'waiting', 'the poke does not change the item; pull() does');
  const again = await C.sendReply(OWNER, { bookingNumber: NUM, clientId: CID, text: 'hi' }, { ...deps(db), trigger: async () => { pokes++; } });
  assert.strictEqual(again.duplicate, true);
  assert.strictEqual(pokes, 1, 'a repeated request does not poke again');

  const db2 = fakeDb(seed());
  const r2 = await C.sendReply(OWNER, { bookingNumber: NUM, clientId: 'client-id-0002', text: 'hi' }, { ...deps(db2), trigger: async () => { throw new Error('boom'); } });
  assert.strictEqual(r2.ok, true);
  assert.strictEqual(db2.store.get('inbox_outbox/client-id-0002').status, 'waiting');
});

test('poke: only the Apps Script web app address, key in the body, gives up on a slow answer', async () => {
  const url = 'https://script.google.com/macros/s/AKfycbxAbC_123-xyz/exec';
  let seen;
  await C.pokeWebApp(url, 'secret', async (u, o) => { seen = { u, o }; return {}; });
  assert.strictEqual(seen.u, url);
  assert.strictEqual(seen.o.method, 'POST');
  assert.deepStrictEqual(JSON.parse(seen.o.body), { key: 'secret', action: 'sendNow' });
  await assert.rejects(C.pokeWebApp('https://evil.example.com/exec', 'secret', async () => ({})), /bad web app url/);
  await assert.rejects(C.pokeWebApp('http://script.google.com/macros/s/abc/exec', 'secret', async () => ({})), /bad web app url/);
  const slow = (u, o) => new Promise((_, rej) => o.signal.addEventListener('abort', () => rej(new Error('aborted'))));
  await assert.rejects(C.pokeWebApp(url, 'secret', slow, 20), /aborted/);
});

const WIFE = { token: { email: 'nutsamargiani@gmail.com', email_verified: true } };
const STRANGER = { token: { email: 'someone@example.com', email_verified: true } };

test('both inbox users can send, and the reply says who sent it', async () => {
  for (const [auth, email, name] of [[OWNER, 'nikavibliani@gmail.com', 'Nika'], [WIFE, 'nutsamargiani@gmail.com', 'Nutsa']]) {
    const db = fakeDb(seed());
    await C.sendReply(auth, { bookingNumber: NUM, clientId: 'client-' + name, text: 'Hello' }, deps(db));
    const o = db.store.get('inbox_outbox/client-' + name);
    const m = db.store.get(`inbox_conversations/${NUM}/messages/client-${name}`);
    assert.strictEqual(o.sentBy, email);
    assert.strictEqual(o.sentByName, name);
    assert.strictEqual(m.sentBy, email);
    assert.strictEqual(m.sentByName, name);
  }
  const db = fakeDb(seed());
  await assert.rejects(C.sendReply(STRANGER, { bookingNumber: NUM, clientId: CID, text: 'Hello' }, deps(db)), { code: 'permission-denied' });
  await assert.rejects(C.sendReply({ token: { email: 'nutsamargiani@gmail.com', email_verified: false } }, { bookingNumber: NUM, clientId: CID, text: 'Hello' }, deps(db)), { code: 'permission-denied' });
});

test('the check-in link callable is open to both inbox users and nobody else', async () => {
  const db = fakeDb({});
  assert.deepStrictEqual(await C.checkinLink(WIFE, { bookingNumber: NUM }, deps(db)), { url: null });
  await assert.rejects(C.checkinLink(STRANGER, { bookingNumber: NUM }, deps(db)), { code: 'permission-denied' });
});

test('the allowed-people list: one list on the server, the sign-in screen matches it', async () => {
  const A = require('../lib/inboxAccess');
  assert.deepStrictEqual(A.INBOX_EMAILS, ['nikavibliani@gmail.com', 'nutsamargiani@gmail.com']);
  assert.strictEqual(A.inboxUser({ token: { email: 'NutsaMargiani@Gmail.com', email_verified: true } }).name, 'Nutsa');
  assert.strictEqual(A.inboxUser(null), null);
  assert.strictEqual(A.inboxUser({ token: { email: 'nikavibliani@gmail.com' } }), null, 'unverified email');
  const client = await import('../../shared/inbox-auth.js');
  assert.deepStrictEqual(client.INBOX_USERS, A.INBOX_USERS, 'shared/inbox-auth.js must list the same people');
  assert.strictEqual(client.inboxUserFor('nutsamargiani@gmail.com').name, 'Nutsa');
  assert.strictEqual(client.inboxUserFor('x@example.com'), null);
});

// ---------------------------------------------------------------- Step 1: the last send status on the conversation
test('a queued reply marks the conversation: sending, who replied, wait ended; the report updates it; a failure reopens with the old wait', async () => {
  const waited = T(100);
  const db = fakeDb(seed({ needsReply: true, done: false, waitingSince: waited }));
  await C.sendReply(OWNER, { bookingNumber: NUM, clientId: CID, text: 'Hello' }, deps(db));
  const k = `inbox_conversations/${NUM}`;
  let c = db.store.get(k);
  assert.strictEqual(c.lastSendStatus, 'sending');
  assert.strictEqual(c.lastSendOutboxId, CID);
  assert.strictEqual(c.lastReplyBy, 'Nika');
  assert.strictEqual(c.waitingSince, null, 'a sent reply ends the wait');
  assert.strictEqual(db.store.get(`inbox_outbox/${CID}`).prevWaitingSince, waited);
  await C.pull(deps(db));
  await C.report({ id: CID, result: 'sent' }, deps(db));
  assert.strictEqual(db.store.get(k).lastSendStatus, 'sent');

  const db2 = fakeDb(seed({ needsReply: true, done: false, waitingSince: waited }));
  await C.sendReply(OWNER, { bookingNumber: NUM, clientId: CID, text: 'Hello' }, deps(db2));
  await C.pull(deps(db2));
  await C.report({ id: CID, result: 'failed', reason: 'Gmail refused' }, deps(db2));
  c = db2.store.get(k);
  assert.strictEqual(c.lastSendStatus, 'failed');
  assert.strictEqual(c.lastSendFailReason, 'Gmail refused');
  assert.strictEqual(c.done, false);
  assert.strictEqual(c.needsReply, true);
  assert.strictEqual(c.waitingSince, waited, 'the guest has been waiting since before, not since the failed try');

  const db3 = fakeDb(seed({}));
  await C.sendReply(OWNER, { bookingNumber: NUM, clientId: CID, text: 'Hello' }, deps(db3));
  await C.pull(deps(db3));
  clock += 11 * 60 * 1000;
  await C.pull(deps(db3));                       // stuck in sending for over 10 minutes
  assert.strictEqual(db3.store.get(k).lastSendStatus, 'unknown');
  // an old reply reporting late does not overwrite a newer reply's status
  const db4 = fakeDb(seed({ lastSendOutboxId: 'newer-reply-id' }));
  db4.store.set(`inbox_outbox/${CID}`, { bookingNumber: NUM, status: 'sending', claimedAt: T(1), text: 'x' });
  db4.store.set(`inbox_conversations/${NUM}/messages/${CID}`, { direction: 'host', status: 'sending' });
  await C.report({ id: CID, result: 'sent' }, deps(db4));
  assert.ok(!db4.store.get(k).lastSendStatus, 'the newer reply keeps its own status');
});
