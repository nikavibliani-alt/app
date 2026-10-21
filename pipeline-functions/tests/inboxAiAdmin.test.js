'use strict';
// Made-up data only.
const test = require('node:test');
const assert = require('node:assert');
const X = require('../controllers/inboxAiAdmin');

const NIKA = { token: { email: 'nikavibliani@gmail.com', email_verified: true } };
const BN = '6000000001';
const stamp = m => ({ toMillis: () => m });
const NOW = Date.UTC(2026, 10, 10, 8, 0, 0);

function fakeDb(seed = {}) {
  const store = new Map(Object.entries(seed));
  const snap = p => ({ id: p.split('/').pop(), exists: store.has(p), data: () => store.get(p) });
  const upd = (p, d) => { store.set(p, { ...store.get(p), ...d }); };
  const docRef = path => ({ path, get: async () => snap(path), set: async (d, o) => { store.set(path, o && o.merge ? { ...(store.get(path) || {}), ...d } : d); }, update: async d => upd(path, d) });
  const colRef = (path, f = []) => ({
    doc: id => docRef(path + '/' + id),
    where(field, op, val) { return { ...this, f: [...(this.f || []), [field, val]] }; },
    limit() { return this; },
    get: async function () { return { docs: [...store.entries()].filter(([p]) => p.startsWith(path + '/') && p.split('/').length === path.split('/').length + 1).filter(([, d]) => (this.f || []).every(([k, v]) => d[k] === v)).map(([p]) => snap(p)) }; },
  });
  return {
    store, collection: colRef,
    runTransaction: async fn => {
      const w = [];
      const tx = { get: async r => snap(r.path), update: (r, d) => w.push(() => upd(r.path, d)), set: (r, d) => w.push(() => store.set(r.path, d)) };
      const out = await fn(tx); w.forEach(x => x()); return out;
    },
  };
}
const deps = db => ({ db, nowMs: () => NOW, ts: stamp });
const conv = extra => ({ [`inbox_conversations/${BN}`]: { guestName: 'Test Guest', checkout: '2026-11-19', ...extra } });

test('only inbox users', async () => {
  await assert.rejects(X.aiAction(null, { bookingNumber: BN, action: 'stop' }, deps(fakeDb(conv()))), { code: 'permission-denied' });
  await assert.rejects(X.aiKnowledge({ token: { email: 'a@b.c', email_verified: true } }, { action: 'list' }, deps(fakeDb())), { code: 'permission-denied' });
});

test('stop cancels the wait; pause and resume', async () => {
  const db = fakeDb(conv({ aiPending: { lastMessageId: 'm1' }, aiDueAt: stamp(NOW + 30000) }));
  assert.deepStrictEqual(await X.aiAction(NIKA, { bookingNumber: BN, action: 'stop' }, deps(db)), { ok: true });
  assert.strictEqual(db.store.get(`inbox_conversations/${BN}`).aiPending, null);
  assert.ok((await X.aiAction(NIKA, { bookingNumber: BN, action: 'stop' }, deps(db))).nothingToStop);
  const r = await X.aiAction(NIKA, { bookingNumber: BN, action: 'pause', mode: 'checkout' }, deps(db));
  assert.strictEqual(r.until, Date.UTC(2026, 10, 19, 8, 0, 0));
  assert.strictEqual(db.store.get(`inbox_conversations/${BN}`).aiPausedBy, 'Nika');
  await assert.rejects(X.aiAction(NIKA, { bookingNumber: BN, action: 'pause', mode: 'bad' }, deps(db)), { code: 'failed-precondition' });
  await X.aiAction(NIKA, { bookingNumber: BN, action: 'resume' }, deps(db));
  assert.strictEqual(db.store.get(`inbox_conversations/${BN}`).aiPausedUntil, null);
});

test('review: Looks good marks it; Wrong with a correction makes a suggestion that is not used until approved', async () => {
  const db = fakeDb(conv({ aiLastReply: { messageId: 'ai-m1', text: 'Parking is free.', question: 'Is parking free?', review: null } }));
  await X.aiAction(NIKA, { bookingNumber: BN, action: 'review', verdict: 'ok' }, deps(db));
  assert.strictEqual(db.store.get(`inbox_conversations/${BN}`).aiLastReply.review, 'ok');
  const r = await X.aiAction(NIKA, { bookingNumber: BN, action: 'review', verdict: 'wrong', correction: 'Parking is paid, 15 GEL a day.' }, deps(db));
  const s = db.store.get(`inbox_ai_knowledge/${r.suggestionId}`);
  assert.deepStrictEqual([s.status, s.enabled, s.question, s.answer, s.wrongReply], ['pending', false, 'Is parking free?', 'Parking is paid, 15 GEL a day.', 'Parking is free.']);
  await assert.rejects(X.aiAction(NIKA, { bookingNumber: BN, action: 'review', verdict: 'maybe' }, deps(db)), { code: 'invalid-argument' });
});

test('knowledge page: add -> approve -> switch off; reject', async () => {
  const db = fakeDb();
  const { id } = await X.aiKnowledge(NIKA, { action: 'add', question: 'Is there a pool?', answer: 'No pool.', source: 'unanswered' }, deps(db));
  let list = (await X.aiKnowledge(NIKA, { action: 'list' }, deps(db))).items;
  assert.deepStrictEqual([list[0].status, list[0].enabled, list[0].source], ['pending', false, 'unanswered']);
  await assert.rejects(X.aiKnowledge(NIKA, { action: 'toggle', id, enabled: true }, deps(db)), { code: 'failed-precondition' });
  await X.aiKnowledge(NIKA, { action: 'approve', id, answer: 'No pool, but there is a gym nearby.' }, deps(db));
  list = (await X.aiKnowledge(NIKA, { action: 'list' }, deps(db))).items;
  assert.deepStrictEqual([list[0].status, list[0].enabled, list[0].answer], ['approved', true, 'No pool, but there is a gym nearby.']);
  await X.aiKnowledge(NIKA, { action: 'toggle', id, enabled: false }, deps(db));
  assert.strictEqual(db.store.get(`inbox_ai_knowledge/${id}`).enabled, false);
  await X.aiKnowledge(NIKA, { action: 'reject', id }, deps(db));
  assert.strictEqual(db.store.get(`inbox_ai_knowledge/${id}`).status, 'rejected');
  await assert.rejects(X.aiKnowledge(NIKA, { action: 'add', question: '', answer: 'x' }, deps(db)), { code: 'invalid-argument' });
});

test('test box: uses the approved extra answers, sends nothing, saves nothing', async () => {
  const db = fakeDb({ 'inbox_ai_knowledge/k1': { status: 'approved', enabled: true, question: 'Is there a pool?', answer: 'No pool, but a gym nearby.' } });
  let seenSystem = '';
  const callClaude = async ({ system }) => { seenSystem = JSON.stringify(system); return { ok: true, text: 'TOPICS: amenities\nThere is no pool, but there is a gym nearby.' }; };
  const before = [...db.store.keys()].join();
  const r = await X.aiKnowledge(NIKA, { action: 'test', question: 'Do you have a pool?', room: '6-2' }, { ...deps(db), callClaude });
  assert.strictEqual(r.ok, true);
  assert.match(seenSystem, /EXTRA ANSWERS APPROVED BY THE HOST/);
  assert.match(seenSystem, /No pool, but a gym nearby/);
  assert.ok(['reply', 'needs_you'].includes(r.kind));
  assert.strictEqual([...db.store.keys()].join(), before);
});

test('settings page: only the known settings, only inbox users', async () => {
  const db = fakeDb({ 'globals/config': { botMode: 'available' } });
  await assert.rejects(X.saveSettings(null, { aiSignReplies: true }, deps(db)), { code: 'permission-denied' });
  await X.saveSettings(NIKA, { bookingAiMode: 'auto' }, deps(db));
  assert.deepStrictEqual([db.store.get('globals/config').bookingAiMode, db.store.get('globals/config').bookingAiDraftsEnabled, db.store.get('globals/config').botMode], ['auto', true, 'available']);
  await X.saveSettings(NIKA, { bookingAiMode: 'off' }, deps(db));
  assert.strictEqual(db.store.get('globals/config').bookingAiDraftsEnabled, false);
  await X.saveSettings(NIKA, { aiAlertMode: 'needs' }, deps(db));
  await X.saveSettings(NIKA, { aiSignReplies: true }, deps(db));
  await X.saveSettings(NIKA, { bookingAlertsEnabled: false }, deps(db));
  const c = db.store.get('globals/config');
  assert.deepStrictEqual([c.aiAlertMode, c.aiSignReplies, c.bookingAlertsEnabled], ['needs', true, false]);
  await assert.rejects(X.saveSettings(NIKA, { bookingAiMode: 'wild' }, deps(db)), { code: 'invalid-argument' });
  await assert.rejects(X.saveSettings(NIKA, { aiBotEnabled: false }, deps(db)), { code: 'invalid-argument' });   // WhatsApp settings are not changed from here
});
