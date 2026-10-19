'use strict';
// Made-up data only. A tiny in-memory Firestore stands in for the real one.
const test = require('node:test');
const assert = require('node:assert');
const { processEmail, pickReservation } = require('../controllers/inboxSort');

function fakeDb(seed = {}) {
  const store = new Map(Object.entries(seed));
  const docRef = path => ({
    path,
    id: path.split('/').pop(),
    collection: name => colRef(path + '/' + name),
  });
  const colRef = path => ({
    doc: id => docRef(path + '/' + id),
    where: (field, op, val) => ({ path, field, val }),
  });
  const snap = path => ({ exists: store.has(path), id: path.split('/').pop(), data: () => store.get(path) });
  const db = {
    store,
    collection: name => colRef(name),
    runTransaction: async fn => {
      const writes = [];
      const tx = {
        get: async x => {
          if (x.field) {
            const docs = [...store.entries()]
              .filter(([p, d]) => p.startsWith(x.path + '/') && p.split('/').length === x.path.split('/').length + 1 && d[x.field] === x.val)
              .map(([p]) => snap(p));
            return { docs };
          }
          return snap(x.path);
        },
        set: (r, d, o) => writes.push(() => store.set(r.path, o && o.merge ? { ...(store.get(r.path) || {}), ...d } : d)),
        update: (r, d) => writes.push(() => store.set(r.path, { ...store.get(r.path), ...d })),
      };
      const out = await fn(tx);
      writes.forEach(w => w());
      return out;
    },
  };
  return db;
}
const deps = db => ({ db, ts: iso => 'T:' + iso, now: () => 'NOW' });

const chat = (num, id, date, text) => ({
  from: `"G" <${num}-aa11.bb22.cc33.dd44@guest.booking.com>`,
  replyTo: `${num}-aa11.bb22.cc33.dd44@guest.booking.com`,
  subject: 'We received this message from G',
  date,
  bodyText: `Confirmation number: ${num}\n G said:\n ${text}\n Reply\n Guest name:\n Test Guest\n Check-in:\n Mon, Nov 9, 2026\n Check-out:\n Thu, Nov 19, 2026\n Property Name:\n Demo\n Booking Number:\n ${num}\n`,
  bodyHtml: `<p>G said:</p><table><td><p>${text}</p></td></table><a href="x?message_id=11111111-2222">r</a>`,
});

test('chat creates a conversation, a message and marks the email sorted', async () => {
  const db = fakeDb({
    'inbox_raw_emails/m1': chat('2000000001', 'm1', '2026-10-01T10:00:00Z', 'Hello there'),
    'reservations/r1': { bookingId: '2000000001', checkin: '2026-11-09', checkout: '2026-11-19', status: 'OK2', roomCode: '0-1', firstName: 'Test', lastName: 'Guest' },
  });
  const r = await processEmail('m1', deps(db));
  assert.strictEqual(r.kind, 'chat');
  const c = db.store.get('inbox_conversations/2000000001');
  assert.strictEqual(c.channel, 'booking');
  assert.strictEqual(c.account, 'maxela');
  assert.strictEqual(c.reservationId, 'r1');
  assert.strictEqual(c.reservationStatus, 'OK2');
  assert.strictEqual(c.roomCode, '0-1');
  assert.strictEqual(c.needsReply, true);
  assert.strictEqual(c.done, false);
  assert.strictEqual(c.messageCount, 1);
  assert.strictEqual(c.lastGuestMessageAt, 'T:2026-10-01T10:00:00.000Z');
  assert.strictEqual(c.replyTo, '2000000001-aa11.bb22.cc33.dd44@guest.booking.com');
  const m = db.store.get('inbox_conversations/2000000001/messages/m1');
  assert.strictEqual(m.direction, 'guest');
  assert.strictEqual(m.text, 'Hello there');
  assert.strictEqual(m.bookingMessageId, '11111111-2222');
  assert.strictEqual(db.store.get('inbox_raw_emails/m1').sortedAs, 'chat');
});

test('running twice changes nothing', async () => {
  const db = fakeDb({ 'inbox_raw_emails/m1': chat('2000000001', 'm1', '2026-10-01T10:00:00Z', 'Hello') });
  await processEmail('m1', deps(db));
  const again = await processEmail('m1', deps(db));
  assert.strictEqual(again.skipped, true);
  assert.strictEqual(db.store.get('inbox_conversations/2000000001').messageCount, 1);
});

test('unmatched reservation still makes a conversation, from the email details', async () => {
  const db = fakeDb({ 'inbox_raw_emails/m1': chat('2000000002', 'm1', '2026-10-01T10:00:00Z', 'Hi') });
  await processEmail('m1', deps(db));
  const c = db.store.get('inbox_conversations/2000000002');
  assert.strictEqual(c.reservationId, null);
  assert.strictEqual(c.guestName, 'Test Guest');
  assert.strictEqual(c.checkin, '2026-11-09');
});

test('a cancelled reservation still shows its conversation', async () => {
  const db = fakeDb({
    'inbox_raw_emails/m1': chat('2000000003', 'm1', '2026-10-01T10:00:00Z', 'Hi'),
    'reservations/r1': { bookingId: '2000000003', checkin: '2026-11-09', status: 'CANCELLED' },
  });
  await processEmail('m1', deps(db));
  const c = db.store.get('inbox_conversations/2000000003');
  assert.strictEqual(c.reservationStatus, 'CANCELLED');
  assert.strictEqual(c.needsReply, true);
});

test('second message in the same reservation adds to the same conversation', async () => {
  const db = fakeDb({
    'inbox_raw_emails/m1': chat('2000000004', 'm1', '2026-10-01T10:00:00Z', 'one'),
    'inbox_raw_emails/m2': chat('2000000004', 'm2', '2026-10-01T10:01:00Z', 'two'),
  });
  await processEmail('m2', deps(db)); // arrives out of order on purpose
  await processEmail('m1', deps(db));
  const c = db.store.get('inbox_conversations/2000000004');
  assert.strictEqual(c.messageCount, 2);
  assert.strictEqual(c.lastGuestMessageAt, 'T:2026-10-01T10:01:00.000Z');
});

test('pickReservation prefers matching dates, then not cancelled, then newest', () => {
  const d = (id, data) => ({ id, data: () => data });
  const a = d('a', { checkin: '2026-11-09', status: 'CANCELLED' });
  const b = d('b', { checkin: '2026-12-01', status: 'OK2' });
  const c = d('c', { checkin: '2026-11-09', status: 'OK2', updatedAt: '2026-01-01' });
  assert.strictEqual(pickReservation([a, b, c], '2026-11-09').id, 'c');
  assert.strictEqual(pickReservation([a, b], '2026-11-09').id, 'a');
  assert.strictEqual(pickReservation([a, b], null).id, 'b');
  assert.strictEqual(pickReservation([], null), null);
});

test('check-in request and auto-confirmed notice become booking info', async () => {
  const req = {
    from: '"G" <2000000005-aa11.bb22.cc33.dd44@guest.booking.com>',
    replyTo: '2000000005-aa11.bb22.cc33.dd44@guest.booking.com',
    subject: 'We received this message from G',
    date: '2026-10-02T08:00:00Z',
    bodyText: 'Booking Number: 2000000005\n G said:\n I want to request check-in at 06:00 - 07:00. Is this okay?\n Accept for free\n',
    bodyHtml: '',
  };
  const auto = {
    from: 'Booking.com <noreply@booking.com>', replyTo: 'noreply@booking.com',
    subject: 'G’s request has been confirmed', date: '2026-10-02T08:01:00Z',
    bodyText: 'Confirmation number: 2000000005\n I want to request check-in at 06:00 - 07:00. Is this okay?\n', bodyHtml: '',
  };
  const db = fakeDb({ 'inbox_raw_emails/a': req, 'inbox_raw_emails/b': auto });
  await processEmail('a', deps(db));
  let c = db.store.get('inbox_conversations/2000000005');
  assert.deepStrictEqual(c.checkinRequest, { time: '06:00 - 07:00', autoConfirmed: false, at: 'T:2026-10-02T08:00:00.000Z' });
  assert.strictEqual(c.messageCount, 0);
  assert.strictEqual(c.needsReply, false);
  await processEmail('b', deps(db));
  c = db.store.get('inbox_conversations/2000000005');
  assert.strictEqual(c.checkinRequest.autoConfirmed, true);
  assert.strictEqual(c.checkinRequest.time, '06:00 - 07:00');
  assert.ok(c.replyTo.includes('@guest.booking.com'), 'no-reply address must not replace the guest address');
});

test('cancel request is an alert with a deadline, not a message', async () => {
  const db = fakeDb({
    'inbox_raw_emails/c': {
      from: '"G" <2000000006-aa11.bb22.cc33.dd44@property.booking.com>',
      replyTo: '2000000006-aa11.bb22.cc33.dd44@property.booking.com',
      subject: 'Your guest would like to cancel for free', date: '2026-10-04T08:00:00Z',
      bodyText: 'Booking Number: 2000000006\n Please respond within the next 12 hours\n', bodyHtml: '',
    },
  });
  await processEmail('c', deps(db));
  const c = db.store.get('inbox_conversations/2000000006');
  assert.deepStrictEqual(c.cancelRequest, { at: 'T:2026-10-04T08:00:00.000Z', deadline: 'T:2026-10-04T20:00:00.000Z' });
  assert.strictEqual(c.messageCount, 0);
  assert.strictEqual([...db.store.keys()].filter(k => k.includes('/messages/')).length, 0);
});

test('hidden emails are only marked; review emails go to the check-this pile', async () => {
  const db = fakeDb({
    'inbox_raw_emails/h': { from: 'noreply@booking.com', subject: '3 guest messages waiting for you', date: '2026-10-05T00:00:00Z', bodyText: '', bodyHtml: '' },
    'inbox_raw_emails/q': { from: 'noreply@booking.com', subject: 'You just received a new question about your property', date: '2026-10-05T00:00:00Z', bodyText: '', bodyHtml: '' },
    'inbox_raw_emails/u': { from: 'weird@example.com', subject: 'hi', date: 'not a date', bodyText: '', bodyHtml: '' },
  });
  assert.strictEqual((await processEmail('h', deps(db))).kind, 'hidden');
  assert.strictEqual(db.store.get('inbox_raw_emails/h').sortedAs, 'hidden');
  assert.strictEqual(db.store.has('inbox_review/h'), false);
  assert.strictEqual((await processEmail('q', deps(db))).kind, 'review');
  assert.strictEqual(db.store.get('inbox_review/q').resolved, false);
  assert.strictEqual((await processEmail('u', deps(db))).kind, 'review');
  assert.strictEqual(db.store.get('inbox_raw_emails/u').sortedAs, 'review');
  assert.strictEqual([...db.store.keys()].filter(k => k.startsWith('inbox_conversations')).length, 0);
});

test('missing email is skipped', async () => {
  assert.strictEqual((await processEmail('nope', deps(fakeDb()))).skipped, true);
});
