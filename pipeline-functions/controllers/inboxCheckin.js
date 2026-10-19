'use strict';
/**
 * Check-in time requests, handled by rule (see docs/INBOX_PLAN.md and lib/inboxCheckin.js).
 *
 *   inboxCheckinTrigger  Firestore trigger on a conversation: a new check-in time request (not auto-confirmed by
 *                        Booking.com) starts a 2 minute wait (Booking.com's own automatic answer may follow)
 *   runDueCheckin        called every minute by inboxAiRun: for each request whose wait is over
 *                          Off        nothing
 *                          Drafts     the message is shown as a draft (Send / Edit / Discard)
 *                          Automatic  the message is sent through the normal reply path, sentBy "AI"
 *                        (Automatic falls back to a draft for a cancelled reservation or within 30 minutes
 *                        after one of us replied.) The Extranet one-tap link for the answer is saved on the
 *                        conversation (checkinAction) and used in the alert. A time that cannot be read gives
 *                        no message, only a "Needs you" note.
 *
 * Only the English text is fixed. If the guest's earlier messages are in another language the same words are
 * also sent translated (a translation that changes a time or adds anything is dropped; English only is sent).
 */

const { resolveAiMode, AI_SENDER, autoSendBlockReason } = require('../lib/inboxAiMode');
const { decideCheckin, translationRequest, acceptTranslation } = require('../lib/inboxCheckin');
const { checkinRequestLink, cleanReplyText } = require('../lib/inboxReply');
const { checkDraft } = require('../lib/inboxDraft');
const { queueReplyWrites } = require('./inboxReply');

const CONVERSATIONS = 'inbox_conversations';
const RAW = 'inbox_raw_emails';
const DUE_DELAY_MS = 2 * 60 * 1000;
const STALE_REQUEST_MS = 60 * 60 * 1000;
const DUPLICATE_QUIET_MS = 6 * 60 * 60 * 1000;
const MAX_DUE_PER_RUN = 5;
const DAILY_CAP = 60;
const TBILISI_OFFSET_MS = 4 * 60 * 60 * 1000;

const ms = v => (v && typeof v.toMillis === 'function' ? v.toMillis() : v && typeof v.toDate === 'function' ? v.toDate().getTime() : v ? new Date(v).getTime() : NaN);
const dayKey = nowMs => new Date(nowMs + TBILISI_OFFSET_MS).toISOString().slice(0, 10);
const log = o => console.log(JSON.stringify({ evt: 'inboxCheckin', ...o }));

// ---------------------------------------------------------------- the trigger

/** deps: { db, nowMs(), ts(ms) }. */
async function onConversationWritten(bookingNumber, before, after, deps) {
  const { db, nowMs, ts } = deps;
  const req = after && after.checkinRequest;
  if (!req) return { action: 'none' };
  if (req.autoConfirmed) return { action: 'auto-confirmed' };                  // Booking.com already answered it
  const at = ms(req.at);
  const prevAt = before && before.checkinRequest ? ms(before.checkinRequest.at) : NaN;
  if (Number.isFinite(prevAt) && prevAt === at) return { action: 'unchanged' };
  if (after.checkinDueAt) return { action: 'already waiting' };
  const now = nowMs();
  if (Number.isFinite(at) && now - at > STALE_REQUEST_MS) return { action: 'stale' };
  const h = after.checkinHandled;
  if (h && h.time === decideCheckin(req.time).time && now - ms(h.processedAt) < DUPLICATE_QUIET_MS) return { action: 'duplicate' };
  await db.collection(CONVERSATIONS).doc(bookingNumber).update({ checkinDueAt: ts(now + DUE_DELAY_MS) });
  return { action: 'waiting' };
}

// ---------------------------------------------------------------- handling one due request

async function newestRequestEmail(db, bookingNumber) {
  const snap = await db.collection(RAW).where('conversationId', '==', bookingNumber).where('sortedAs', '==', 'checkin_request').get();
  const rows = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => new Date(b.date) - new Date(a.date));
  return rows[0] || null;
}

/** deps: { db, nowMs(), ts(ms), apiKey, callClaude?, poke? }. Returns { outcome, sent? }. */
async function processCheckin(bookingNumber, deps) {
  const { db, nowMs, ts } = deps;
  const convRef = db.collection(CONVERSATIONS).doc(bookingNumber);

  const conv = await db.runTransaction(async tx => {
    const c = await tx.get(convRef);
    if (!c.exists) return null;
    const v = c.data();
    if (!v.checkinDueAt || ms(v.checkinDueAt) > nowMs() || !v.checkinRequest) return null;
    tx.update(convRef, { checkinDueAt: null });
    return v;
  });
  if (!conv) return { outcome: 'not due' };

  const req = conv.checkinRequest;
  const atMs = ms(req.at);
  const handled = (outcome, extra = {}) => ({ checkinHandled: { atMs, outcome, time: (decideCheckin(req.time).time) || null, processedAt: ts(nowMs()), ...extra } });
  const finishOnly = async (outcome, upd = {}) => {
    await convRef.update({ ...handled(outcome), ...upd });
    log({ conv: bookingNumber, outcome });
    return { outcome };
  };
  const needsYou = reason => finishOnly(`needs you: ${reason}`, { aiDraft: { kind: 'needs_you', reason, text: reason, source: 'rule', createdAt: ts(nowMs()) } });

  const cfg = await db.collection('globals').doc('config').get();
  const mode = resolveAiMode(cfg.exists ? cfg.data() : null);
  if (mode === 'off') return finishOnly('off');
  if (req.autoConfirmed) return finishOnly('auto-confirmed by Booking.com');

  const d = decideCheckin(req.time);
  if (!d.ok) return needsYou('the check-in time request could not be read, so no message was sent');

  const email = await newestRequestEmail(db, bookingNumber);
  const url = email ? checkinRequestLink(email, d.option) : null;
  if (!email || !url) return needsYou('the check-in request email could not be found, so no message was sent');

  // History: for the language of the guest, and for the "one of us replied recently" rule.
  const histSnap = await convRef.collection('messages').orderBy('sentAt', 'desc').limit(20).get();
  const history = histSnap.docs.map(m => ({ id: m.id, ...m.data() })).reverse();
  const guestTexts = history.filter(m => m.direction === 'guest').map(m => String(m.text || ''));

  let text = d.text;
  let translated = false;
  if (guestTexts.length) {
    const usageRef = db.collection('inbox_ai_usage').doc(dayKey(nowMs()));
    const allowed = await db.runTransaction(async tx => {
      const u = await tx.get(usageRef);
      const n = u.exists ? Number(u.data().count || 0) : 0;
      if (n >= DAILY_CAP) return false;
      tx.set(usageRef, { count: n + 1, updatedAt: ts(nowMs()) }, { merge: true });
      return true;
    });
    if (allowed && deps.callClaude) {
      try {
        const r = translationRequest(d.text, guestTexts);
        const out = await deps.callClaude({ apiKey: deps.apiKey, system: r.system, messages: [{ role: 'user', content: r.user }], maxTokens: 400, log: { warn: () => {}, error: () => {} } });
        const tr = out && out.ok ? acceptTranslation(d.text, out.text) : null;
        if (tr) { text = `${d.text}\n\n${tr}`; translated = true; }
      } catch (e) { console.warn('inboxCheckin: translation failed, English only', e && e.message); }
    }
  }
  const checked = checkDraft(text);
  if (!checked.ok) return needsYou(`the check-in message did not pass the Booking.com rules (${checked.problem})`);
  text = checked.text;

  const action = { label: d.label, url, option: d.option, verb: d.verb, time: d.time, range: d.range };
  const common = { checkinAction: action, needsReply: true, done: false, doneAt: null, updatedAt: ts(nowMs()) };   // the answer in Booking.com is still open

  const asDraft = async (autoBlocked) => {
    const draft = { kind: 'reply', text, source: 'checkin', actionLabel: d.label, actionUrl: url, createdAt: ts(nowMs()), checkinAtMs: atMs, ...(autoBlocked ? { autoBlocked } : {}) };
    return finishOnly('draft', { ...common, aiDraft: draft, ...handled('draft', { option: d.option, verb: d.verb, url, translated }) });
  };
  if (mode === 'drafts') return asDraft(null);

  // Automatic.
  const block = autoSendBlockReason({ conv, messages: history, nowMs: nowMs() });
  if (block) return asDraft(block);
  const clientId = `ci-${atMs}`;
  const clean = cleanReplyText(text);
  if (!clean.ok) return asDraft(null);
  const result = await db.runTransaction(async tx => {
    const [c, existing] = await Promise.all([tx.get(convRef), tx.get(db.collection('inbox_outbox').doc(clientId))]);
    if (!c.exists || existing.exists) return 'skipped';
    queueReplyWrites(tx, db, {
      bookingNumber, clientId, text: clean.text, conv: c.data(), gmailMessageId: email.id,
      sentBy: AI_SENDER.email, sentByName: AI_SENDER.name, now: () => ts(nowMs()), label: 'AI',
    });
    tx.update(convRef, { ...common, aiDraft: null, ...handled('sent', { option: d.option, verb: d.verb, url, translated }) });
    return 'sent';
  });
  log({ conv: bookingNumber, outcome: result, range: d.range, translated });
  if (result === 'sent' && typeof deps.poke === 'function') {
    try { await deps.poke(); } catch (e) { console.warn('inboxCheckin: instant send not triggered', e && e.message); }
  }
  return { outcome: result, sent: result === 'sent' };
}

/** Every request whose wait is over (a few per call). */
async function runDueCheckin(deps) {
  const snap = await deps.db.collection(CONVERSATIONS).where('checkinDueAt', '<=', deps.ts(deps.nowMs())).limit(MAX_DUE_PER_RUN).get();
  const results = [];
  for (const d of snap.docs) {
    try { results.push(await processCheckin(d.id, deps)); } catch (e) { console.error('inboxCheckin failed', d.id, e && e.code, e && e.message); }
  }
  return results;
}

function registerCloudFunctions() {
  const { onDocumentWritten } = require('firebase-functions/v2/firestore');
  const { getFirestore, Timestamp } = require('firebase-admin/firestore');
  const inboxCheckinTrigger = onDocumentWritten(
    { document: `${CONVERSATIONS}/{bookingNumber}`, region: 'europe-west1', timeoutSeconds: 30, maxInstances: 3, memory: '256MiB' },
    async event => {
      const before = event.data && event.data.before && event.data.before.exists ? event.data.before.data() : null;
      const after = event.data && event.data.after && event.data.after.exists ? event.data.after.data() : null;
      if (!after || !after.checkinRequest) return;
      try {
        await onConversationWritten(event.params.bookingNumber, before, after, { db: getFirestore(), nowMs: () => Date.now(), ts: m => Timestamp.fromMillis(m) });
      } catch (e) { console.error('inboxCheckinTrigger failed', e && e.code, e && e.message); }
    }
  );
  return { inboxCheckinTrigger };
}

module.exports = { onConversationWritten, processCheckin, runDueCheckin, registerCloudFunctions, DUE_DELAY_MS };
