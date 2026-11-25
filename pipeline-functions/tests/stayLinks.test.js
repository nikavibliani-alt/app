'use strict';
// The reservations trigger that keeps stay_links and tells the owner (fake database, fake push).
const test = require('node:test');
const assert = require('node:assert/strict');
const { runStayLinks } = require('../controllers/stayLinks');

const res = (room, checkin, checkout, extra) => ({ roomCode: room, checkin, checkout, status: 'OK2', guest: 'Ann Lee', phone: '+995 555 12 34 56', syncedAt: 't0', ...extra });
const A = res('7-2', '2026-11-20', '2026-11-27');
const B = res('7-2', '2026-11-27', '2026-12-01');
const C = res('7-2', '2026-12-01', '2026-12-05');
const NOPHONE = { phone: '' };

function world(reservations, today = '2026-11-26') {
  const db = { reservations: { ...reservations }, links: {}, pushes: [], logs: [], reads: 0 };
  const list = fn => Object.entries(db.reservations).map(([id, r]) => ({ id, ...r })).filter(fn);
  const ctx = {
    today: () => today, now: () => '2026-11-26T10:00:00.000Z',
    listByCheckin: async d => { db.reads++; return list(r => r.checkin === d); },
    listByCheckout: async d => { db.reads++; return list(r => r.checkout === d); },
    listLinks: async id => Object.entries(db.links).filter(([, l]) => l.prevId === id || l.nextId === id).map(([key, l]) => ({ key, ...l })),
    upsertLink: async (key, make) => { const out = make(db.links[key] || null); if (out.data) db.links[key] = { ...(db.links[key] || {}), ...out.data }; return out; },
    deleteLink: async key => { delete db.links[key]; },
    sendPush: async p => { db.pushes.push(p); },
    logRun: async e => { db.logs.push(e); },
  };
  /** write a reservation and run the trigger, as Firestore would */
  db.write = async (id, data) => {
    const before = db.reservations[id] ? { ...db.reservations[id] } : null;
    const after = data ? { ...(db.reservations[id] || {}), ...data } : null;
    if (after) db.reservations[id] = after; else delete db.reservations[id];
    return runStayLinks(ctx, id, before, after);
  };
  return db;
}

test('a sync that changes nothing that matters reads nothing', async () => {
  const w = world({ A, B });
  const out = await w.write('B', { syncedAt: 't1', debit: 5 });
  assert.equal(out.action, 'unchanged');
  assert.equal(w.reads, 0);
});

test('same unit, name, phone, checkout day: linked automatically, no push', async () => {
  const w = world({ A });
  await w.write('B', B);
  assert.deepEqual(Object.keys(w.links), ['A__B']);
  assert.equal(w.links.A__B.status, 'auto');
  assert.equal(w.links.A__B.kind, 'extension');
  assert.deepEqual([w.links.A__B.prevId, w.links.A__B.nextId, w.links.A__B.unit, w.links.A__B.prevCheckin, w.links.A__B.prevCheckout, w.links.A__B.nextCheckin, w.links.A__B.nextCheckout],
    ['A', 'B', '7-2', '2026-11-20', '2026-11-27', '2026-11-27', '2026-12-01']);
  assert.ok(!JSON.stringify(w.links).includes('Ann') && !JSON.stringify(w.links).includes('555'), 'no name or phone is stored (the collection is readable by the guest page)');
  assert.equal(w.pushes.length, 0);
});

test('missing phone: pending, one push to the owner, never a second one', async () => {
  const w = world({ A });
  await w.write('B', { ...B, ...NOPHONE });
  assert.equal(w.links.A__B.status, 'pending');
  assert.equal(w.pushes.length, 1);
  assert.equal(w.pushes[0].body, 'Possible extension: Ann Lee, 7-2, 27 Nov - 1 Dec - confirm in admin');
  assert.equal(w.pushes[0].url, '/checkin-admin?tab=stay');
  await w.write('B', { checkout: '2026-12-02' });
  await w.write('A', { guest: 'Ann  Lee' });
  assert.equal(w.pushes.length, 1);
  assert.equal(w.links.A__B.nextCheckout, '2026-12-02', 'dates follow the booking');
});

test('the owner answer is kept when the bookings are written again', async () => {
  const w = world({ A });
  await w.write('B', { ...B, ...NOPHONE });
  w.links.A__B.status = 'confirmed';
  await w.write('B', { checkout: '2026-12-02' });
  assert.equal(w.links.A__B.status, 'confirmed');
  w.links.A__B.status = 'rejected';
  await w.write('B', { checkout: '2026-12-03' });
  assert.equal(w.links.A__B.status, 'rejected');
  assert.equal(w.pushes.length, 1);
});

test('a different phone, or a 1-day gap: nothing', async () => {
  const w = world({ A });
  await w.write('B', { ...B, phone: '+995 599 99 99 99' });
  await w.write('G', res('7-2', '2026-11-28', '2026-12-01'));
  assert.deepEqual(w.links, {});
  assert.equal(w.pushes.length, 0);
});

test('same guest, another unit: never linked, one "moving guest" push', async () => {
  const w = world({ A });
  await w.write('M', res('6-1', '2026-11-27', '2026-12-01'));
  assert.equal(w.links.A__M.kind, 'move');
  assert.equal(w.links.A__M.status, 'moved');
  assert.deepEqual([w.links.A__M.fromUnit, w.links.A__M.unit], ['7-2', '6-1']);
  assert.equal(w.pushes.length, 1);
  assert.equal(w.pushes[0].body, 'Same guest moves 7-2 -> 6-1 on 27 Nov - change it if needed');
  await w.write('M', { checkout: '2026-12-02' });
  assert.equal(w.pushes.length, 1);
});

test('a move notice goes away when a same-unit booking appears', async () => {
  const w = world({ A });
  await w.write('M', res('6-1', '2026-11-27', '2026-12-01'));
  await w.write('B', B);
  assert.deepEqual(Object.keys(w.links), ['A__B']);
});

test('a booking moved to another unit: the extension link is replaced by a move notice', async () => {
  const w = world({ A });
  await w.write('B', B);
  await w.write('B', { roomCode: '6-1' });
  assert.deepEqual(Object.keys(w.links), ['A__B']);
  assert.equal(w.links.A__B.kind, 'move');
  assert.equal(w.pushes.length, 1);
});

test('cancelling either booking removes the link, also a rejected one', async () => {
  for (const victim of ['A', 'B']) {
    const w = world({ A });
    await w.write('B', B);
    await w.write(victim, { status: 'CANCELLED' });
    assert.deepEqual(w.links, {}, 'cancel ' + victim);
  }
  const w = world({ A });
  await w.write('B', B);
  w.links.A__B.status = 'rejected';
  await w.write('B', { status: 'CL' });
  assert.deepEqual(w.links, {});
  const gone = world({ A });
  await gone.write('B', B);
  await gone.write('B', null);
  assert.deepEqual(gone.links, {}, 'a deleted booking too');
});

test('chain A -> B -> C: both links', async () => {
  const w = world({ A });
  await w.write('C', C);
  await w.write('B', B);
  assert.deepEqual(Object.keys(w.links).sort(), ['A__B', 'B__C']);
});

test('an old changeover never sends a push', async () => {
  const w = world({ A }, '2026-12-10');
  await w.write('B', { ...B, ...NOPHONE });
  assert.equal(w.links.A__B.status, 'pending');
  assert.equal(w.pushes.length, 0);
});

test('a failed push is not marked as sent, so the next write tries again', async () => {
  const w = world({ A });
  let fail = true;
  const { runStayLinks: run } = require('../controllers/stayLinks');
  const base = world({ A, B: { ...B, ...NOPHONE } });
  const ctx = {
    today: () => '2026-11-26', now: () => 'now',
    listByCheckin: async d => Object.entries(base.reservations).map(([id, r]) => ({ id, ...r })).filter(r => r.checkin === d),
    listByCheckout: async d => Object.entries(base.reservations).map(([id, r]) => ({ id, ...r })).filter(r => r.checkout === d),
    listLinks: async () => [],
    upsertLink: async (key, make) => { const out = make(w.links[key] || null); if (out.data) w.links[key] = { ...(w.links[key] || {}), ...out.data }; return out; },
    deleteLink: async () => {}, logRun: async () => {},
    sendPush: async p => { if (fail) throw new Error('push down'); w.pushes.push(p); },
  };
  await run(ctx, 'B', null, base.reservations.B);
  assert.equal(w.links.A__B.notifiedAt, null);
  fail = false;
  await run(ctx, 'B', null, base.reservations.B);
  assert.equal(w.pushes.length, 1);
});
