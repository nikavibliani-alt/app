'use strict';
/**
 * Keeping an eye on the Booking.com AI and teaching it (Step 5 of docs/INBOX_IMPROVEMENT_PLAN.md). Inbox users only.
 * Everything goes through these callables (admin SDK), so no Firestore rules are needed for it.
 *
 *   inboxAiAction     stop    cancel the AI's wait for this guest (the "AI will reply in 0:45" Stop / Write it myself)
 *                     pause   keep the AI out of this chat for 24 hours or until check-out
 *                     resume  let the AI answer this chat again
 *                     review  "Looks good" or "Wrong" on an AI reply (Wrong may carry what it should have said)
 *   inboxAiKnowledge  list / add / edit / approve / reject / toggle the corrections and extra answers, and
 *                     test: type a guest question, see the AI's answer (nothing is sent or saved)
 *
 * A correction is only a suggestion (status "pending"). The AI uses an entry only when it is approved and switched on
 * (see lib/inboxAi.js, used by controllers/inboxDraft.js). WhatsApp is not touched: this is the Booking.com AI only.
 */

const { inboxUser } = require('../lib/inboxAccess');
const { isBookingNumber } = require('../lib/inboxReply');
const AI = require('../lib/inboxAi');
const D = require('../lib/inboxDraft');
const T = require('../lib/inboxTopics');
const KB = require('../lib/guestKnowledge/knowledgeBase');
const claude = require('../lib/guestKnowledge/claudeClient');

const CONVERSATIONS = 'inbox_conversations';
const KNOWLEDGE = 'inbox_ai_knowledge';
const MAX_Q = 300;
const MAX_A = 700;

class Fail extends Error { constructor(code, message) { super(message); this.code = code; } }
const need = auth => { const u = inboxUser(auth); if (!u) throw new Fail('permission-denied', 'Only people with inbox access can do this.'); return u; };
const clean = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
const id20 = v => (/^[A-Za-z0-9_-]{6,40}$/.test(String(v || '')) ? String(v) : null);

// ---------------------------------------------------------------- stop / pause / resume / review

async function aiAction(auth, data, deps) {
  const user = need(auth);
  const d = data || {};
  if (!isBookingNumber(d.bookingNumber)) throw new Fail('invalid-argument', 'Bad booking number.');
  const { db, ts, nowMs } = deps;
  const ref = db.collection(CONVERSATIONS).doc(d.bookingNumber);

  return db.runTransaction(async tx => {
    const c = await tx.get(ref);
    if (!c.exists) throw new Fail('not-found', 'Conversation not found.');
    const v = c.data();
    if (d.action === 'stop') {
      if (!v.aiPending && !v.aiDueAt) return { ok: true, nothingToStop: true };
      tx.update(ref, { aiPending: null, aiDueAt: null });      // the same thing a reply from one of us does
      return { ok: true };
    }
    if (d.action === 'pause') {
      const until = AI.pauseUntilMs(d.mode, v, nowMs());
      if (!until) throw new Fail('failed-precondition', d.mode === 'checkout' ? 'This chat has no future check-out date.' : 'Bad pause choice.');
      tx.update(ref, { aiPausedUntil: until, aiPausedBy: user.name, aiPending: null, aiDueAt: null });
      return { ok: true, until };
    }
    if (d.action === 'resume') {
      tx.update(ref, { aiPausedUntil: null, aiPausedBy: null });
      return { ok: true };
    }
    if (d.action === 'review') {
      const last = v.aiLastReply;
      if (!last) throw new Fail('failed-precondition', 'There is no AI reply to review here.');
      if (d.verdict !== 'ok' && d.verdict !== 'wrong') throw new Fail('invalid-argument', 'Bad answer.');
      const correction = clean(d.correction, MAX_A);
      tx.update(ref, { aiLastReply: { ...last, review: d.verdict, reviewedBy: user.name, reviewedAt: ts(nowMs()) } });
      let suggestionId = null;
      if (d.verdict === 'wrong' && correction) {
        suggestionId = `fix-${d.bookingNumber}-${nowMs()}`;
        tx.set(db.collection(KNOWLEDGE).doc(suggestionId), {
          status: 'pending', enabled: false, source: 'wrong',
          question: clean(last.question, MAX_Q) || '(see the chat)', answer: correction, wrongReply: clean(last.text, MAX_A),
          createdAt: ts(nowMs()), updatedAt: ts(nowMs()), by: user.name, bookingNumber: d.bookingNumber,
        });
      }
      return { ok: true, suggestionId };
    }
    throw new Fail('invalid-argument', 'Bad action.');
  });
}

// ---------------------------------------------------------------- the AI knowledge page

const pub = (id, x) => ({
  id, status: x.status, enabled: x.enabled !== false, source: x.source || 'manual', question: x.question || '', answer: x.answer || '',
  wrongReply: x.wrongReply || '', by: x.by || '', createdAt: AI.ms(x.createdAt) || 0, updatedAt: AI.ms(x.updatedAt) || 0,
});

/** Runs the same question and prompt as a real chat, but saves and sends nothing. */
async function testQuestion(data, deps) {
  const question = clean(data && data.question, 500);
  if (!question) throw new Fail('invalid-argument', 'Type a guest question first.');
  const nowMs = deps.nowMs();
  const room = clean(data && data.room, 12);
  const conv = { guestName: 'Test guest', propertyName: 'Maxela Apartments', roomCode: room || '', checkin: '', checkout: '' };
  const k = D.knowledgeForConversation(conv, KB.SEED);
  if (!k.ok) return { ok: true, kind: 'needs_you', reason: k.reason, topics: [] };
  let extra = '';
  try {
    const ks = await deps.db.collection(KNOWLEDGE).where('status', '==', 'approved').limit(AI.MAX_ENTRIES + 10).get();
    extra = AI.extraKnowledgeText(ks.docs.map(x => x.data()));
  } catch (e) { /* none */ }
  const kb = KB.SEED;
  const system = claude.buildCachedSystem(D.fixedSystemText(kb), D.dynamicSystemText({ conv, formFilled: null, nowMs, kb }) + (extra ? '\n\n' + extra : ''));
  const msg = { id: 'test-1', direction: 'guest', text: question, sentAt: { toMillis: () => nowMs } };
  const userTurn = D.buildUserTurn({ bookingMessages: [msg], burstIds: ['test-1'], whatsapp: [], nowMs });
  const out = await (deps.callClaude || claude.callClaudeWithRetry)({ apiKey: deps.apiKey, system, messages: [{ role: 'user', content: userTurn }], maxTokens: 400, model: deps.model || claude.MODEL, log: { warn: () => {}, error: () => {} } });
  if (!out || !out.ok) throw new Fail('unavailable', 'The assistant could not answer just now. Try again.');
  const tp = T.parseTopicsLine(out.text);
  const parsed = D.parseModelOutput(tp.rest);
  const topics = tp.topics ? [...tp.topics] : [];
  if (parsed.type === 'needs_you') return { ok: true, kind: 'needs_you', reason: parsed.reason, topics };
  if (parsed.type === 'silent') return { ok: true, kind: 'silent', reason: 'It would not answer this one.', topics };
  if (parsed.type === 'already_answered') return { ok: true, kind: 'needs_you', reason: 'It would say this was already answered on WhatsApp.', topics };
  if (parsed.type !== 'reply') return { ok: true, kind: 'needs_you', reason: 'No usable answer.', topics };
  const byTopic = T.decideByTopics(new Set([...topics]));
  if (byTopic.action === 'needs_you') return { ok: true, kind: 'needs_you', reason: byTopic.reason, topics };
  if (byTopic.action === 'hold') return { ok: true, kind: 'needs_you', reason: `${byTopic.label} request: it would send a holding reply and alert you`, topics };
  const checked = D.checkDraft(parsed.text, { kb });
  if (!checked.ok) return { ok: true, kind: 'needs_you', reason: `its answer had ${checked.problem}, so it would not be sent`, topics };
  return { ok: true, kind: 'reply', reply: checked.text, topics, scan: AI.scanAiReply(checked.text) };
}

async function aiKnowledge(auth, data, deps) {
  const user = need(auth);
  const d = data || {};
  const { db, ts, nowMs } = deps;
  const col = db.collection(KNOWLEDGE);
  if (d.action === 'list') {
    const snap = await col.limit(300).get();
    return { ok: true, items: snap.docs.map(x => pub(x.id, x.data())).sort((a, b) => b.updatedAt - a.updatedAt) };
  }
  if (d.action === 'test') return testQuestion(d, deps);
  if (d.action === 'add') {
    const question = clean(d.question, MAX_Q), answer = clean(d.answer, MAX_A);
    if (!question || !answer) throw new Fail('invalid-argument', 'Write the question and the answer.');
    const id = `s-${nowMs()}-${Math.floor(Math.random() * 1e6)}`;
    await col.doc(id).set({ status: 'pending', enabled: false, source: d.source === 'unanswered' ? 'unanswered' : 'manual', question, answer, createdAt: ts(nowMs()), updatedAt: ts(nowMs()), by: user.name });
    return { ok: true, id };
  }
  const id = id20(d.id);
  if (!id) throw new Fail('invalid-argument', 'Bad id.');
  const ref = col.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Fail('not-found', 'Not found.');
  const cur = snap.data();
  if (d.action === 'edit' || d.action === 'approve') {
    const question = d.question === undefined ? cur.question : clean(d.question, MAX_Q);
    const answer = d.answer === undefined ? cur.answer : clean(d.answer, MAX_A);
    if (!question || !answer) throw new Fail('invalid-argument', 'Write the question and the answer.');
    const upd = { question, answer, updatedAt: ts(nowMs()) };
    if (d.action === 'approve') { upd.status = 'approved'; upd.enabled = true; upd.approvedBy = user.name; upd.approvedAt = ts(nowMs()); }
    await ref.update(upd);
    return { ok: true };
  }
  if (d.action === 'reject') { await ref.update({ status: 'rejected', enabled: false, updatedAt: ts(nowMs()) }); return { ok: true }; }
  if (d.action === 'toggle') {
    if (cur.status !== 'approved') throw new Fail('failed-precondition', 'Only approved answers can be switched on or off.');
    await ref.update({ enabled: !!d.enabled, updatedAt: ts(nowMs()) });
    return { ok: true };
  }
  throw new Fail('invalid-argument', 'Bad action.');
}

// ---------------------------------------------------------------- the one settings page

/** The Booking.com inbox settings saved in globals/config, checked one by one. Returns the fields to write. */
function settingsPatch(data) {
  const d = data || {};
  if (d.bookingAiMode !== undefined) {
    if (!['off', 'drafts', 'auto'].includes(d.bookingAiMode)) throw new Fail('invalid-argument', 'Bad AI mode.');
    return { bookingAiMode: d.bookingAiMode, bookingAiDraftsEnabled: d.bookingAiMode !== 'off' };   // the old field stays in step for older code
  }
  if (d.aiAlertMode !== undefined) {
    if (!['every', 'needs'].includes(d.aiAlertMode)) throw new Fail('invalid-argument', 'Bad alert choice.');
    return { aiAlertMode: d.aiAlertMode };
  }
  if (d.aiSignReplies !== undefined) return { aiSignReplies: d.aiSignReplies === true };
  if (d.bookingAlertsEnabled !== undefined) return { bookingAlertsEnabled: d.bookingAlertsEnabled === true };
  throw new Fail('invalid-argument', 'Nothing to save.');
}
async function saveSettings(auth, data, deps) {
  need(auth);
  const patch = settingsPatch(data);
  await deps.db.collection('globals').doc('config').set({ ...patch, updatedAt: deps.ts(deps.nowMs()) }, { merge: true });
  return { ok: true, saved: patch };
}

// ---------------------------------------------------------------- Cloud Functions

function registerCloudFunctions() {
  const { onCall, HttpsError } = require('firebase-functions/v2/https');
  const { defineSecret } = require('firebase-functions/params');
  const { getFirestore, Timestamp } = require('firebase-admin/firestore');
  const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');
  const region = 'europe-west1';
  const deps = () => ({ db: getFirestore(), nowMs: () => Date.now(), ts: m => Timestamp.fromMillis(m) });
  const wrap = fn => async request => {
    try { return await fn(request.auth, request.data); }
    catch (e) {
      if (e instanceof Fail) throw new HttpsError(e.code, e.message);
      console.error('inboxAi callable failed', e && e.code, e && e.message);
      throw new HttpsError('internal', 'Something went wrong. Try again.');
    }
  };
  const inboxAiAction = onCall({ region, timeoutSeconds: 30, maxInstances: 3, memory: '256MiB' }, wrap((a, d) => aiAction(a, d, deps())));
  const inboxAiKnowledge = onCall({ region, secrets: [ANTHROPIC_API_KEY], timeoutSeconds: 60, maxInstances: 3, memory: '256MiB' },
    wrap((a, d) => aiKnowledge(a, d, { ...deps(), apiKey: ANTHROPIC_API_KEY.value() })));
  const inboxSettingsSave = onCall({ region, timeoutSeconds: 30, maxInstances: 3, memory: '256MiB' }, wrap((a, d) => saveSettings(a, d, deps())));
  return { inboxAiAction, inboxAiKnowledge, inboxSettingsSave };
}

module.exports = { saveSettings, settingsPatch, aiAction, aiKnowledge, testQuestion, registerCloudFunctions, Fail };
