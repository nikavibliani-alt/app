'use strict';
/**
 * Booking.com AI drafts (see docs/INBOX_PLAN.md, Part 2). DRAFTS ONLY: nothing here sends anything
 * to a guest. A draft is stored on the conversation (aiDraft) and the host decides in the inbox.
 *
 *   inboxAiOnMessage  Firestore trigger on a new message in a conversation.
 *                     guest message  -> (re)starts the wait: aiPending + aiDueAt (60 s after the last
 *                                       message, never later than 4 min after the first), clears an old draft
 *                     host message   -> my reply cancels any pending draft and removes the shown one
 *   inboxAiRun        runs every minute: for each conversation that is due, makes ONE draft for the
 *                     whole burst, after a last check that nothing newer arrived
 *   inboxDraftDiscard callable, inbox users only: the Discard button
 *
 * Guards: switch globals/config.bookingAiDraftsEnabled (default on), at most 6 drafts per
 * conversation per hour, a daily total cap, one log line per AI call (no guest text).
 */

const { isBookingNumber } = require('../lib/inboxReply');
const { isInboxUser } = require('../lib/inboxAccess');
const { resolveAiMode, AI_SENDER, autoSendBlockReason } = require('../lib/inboxAiMode');
const { queueReplyWrites } = require('./inboxReply');
const { cleanReplyText } = require('../lib/inboxReply');
const T = require('../lib/inboxTopics');
const { translationRequest, acceptTranslation } = require('../lib/inboxCheckin');
const D = require('../lib/inboxDraft');
const KB = require('../lib/guestKnowledge/knowledgeBase');
const { canonicalPhone } = require('../lib/guestKnowledge/guestLookup');
const claude = require('../lib/guestKnowledge/claudeClient');

const CONVERSATIONS = 'inbox_conversations';
const USAGE = 'inbox_ai_usage';
const MAX_PER_CONV_PER_HOUR = 6;
const DAILY_CAP = 60;
const STALE_MESSAGE_MS = 60 * 60 * 1000;       // a guest message older than this never starts a draft
const MAX_DUE_PER_RUN = 5;
const MAX_TOKENS = 400;
const TBILISI_OFFSET_MS = 4 * 60 * 60 * 1000;

class Fail extends Error { constructor(code, message) { super(message); this.code = code; } }

const ms = v => (v && typeof v.toMillis === 'function' ? v.toMillis() : v && typeof v.toDate === 'function' ? v.toDate().getTime() : v ? new Date(v).getTime() : NaN);
const dayKey = nowMs => new Date(nowMs + TBILISI_OFFSET_MS).toISOString().slice(0, 10);
const log = o => console.log(JSON.stringify({ evt: 'inboxAi', ...o }));

// ---------------------------------------------------------------- the message trigger

/**
 * deps: { db, nowMs(), ts(ms) -> Timestamp-like }.
 * `msg` is the new message document's data.
 */
async function onMessageCreated(bookingNumber, messageId, msg, deps) {
  const { db, nowMs, ts } = deps;
  const convRef = db.collection(CONVERSATIONS).doc(bookingNumber);
  const direction = msg && msg.direction;

  if (direction === 'host') {
    // My reply cancels a pending draft and removes the one on screen.
    await db.runTransaction(async tx => {
      const c = await tx.get(convRef);
      if (!c.exists) return;
      const v = c.data();
      if (!v.aiPending && !v.aiDraft && !v.aiDueAt) return;
      tx.update(convRef, { aiPending: null, aiDueAt: null, aiDraft: null });
    });
    return { action: 'cancelled' };
  }
  if (direction !== 'guest') return { action: 'ignored' };

  const now = nowMs();
  const sent = ms(msg.sentAt);
  if (Number.isFinite(sent) && now - sent > STALE_MESSAGE_MS) return { action: 'stale' };

  return db.runTransaction(async tx => {
    const c = await tx.get(convRef);
    if (!c.exists) return { action: 'no conversation' };
    const prev = c.data().aiPending;
    const first = prev && Number.isFinite(ms(prev.firstAt)) ? ms(prev.firstAt) : now;
    const ids = [...((prev && prev.ids) || []), messageId].slice(-20);
    tx.update(convRef, {
      aiPending: { firstAt: ts(first), lastAt: ts(now), lastMessageId: messageId, ids },
      aiDueAt: ts(D.dueAtMs(first, now)),
      aiDraft: null,   // the guest wrote again: an older draft no longer fits
    });
    return { action: 'waiting', dueInMs: D.dueAtMs(first, now) - now };
  });
}

// ---------------------------------------------------------------- the WhatsApp side

/** Same guest's WhatsApp chat: reservation -> check-in form -> phone -> whatsapp_conversations. Read only. */
async function findWhatsapp(db, conv) {
  const empty = { formFilled: null, messages: [] };
  try {
    if (!conv.reservationId) return empty;
    const res = await db.collection('reservations').doc(conv.reservationId).get();
    if (!res.exists) return empty;
    const rn = String(res.data().reservationNumber || '').trim();
    if (!rn) return empty;
    const snap = await db.collection('checkin_guests')
      .where('matchedReservationId', '>=', rn).where('matchedReservationId', '<', rn + '').get();
    const forms = snap.docs.map(d => d.data()).filter(f => String(f.matchedReservationId).split('_')[0] === rn);
    if (!forms.length) return { formFilled: false, messages: [] };
    const wa = forms.filter(f => f.contactType === 'wa').sort((a, b) => ms(b.submittedAt) - ms(a.submittedAt))[0];
    if (!wa) return { formFilled: true, messages: [] };
    const phone = canonicalPhone(wa.contact);
    if (phone.length < 9) return { formFilled: true, messages: [] };
    const m = await db.collection('whatsapp_conversations').doc(phone).collection('messages').orderBy('timestamp', 'desc').limit(D.MAX_HISTORY).get();
    const messages = m.docs.map(d => d.data()).reverse()
      .map(x => ({ role: x.role, content: String(x.content || ''), timestamp: x.timestamp }));
    return { formFilled: true, messages };
  } catch (e) {
    console.warn('inboxAi: WhatsApp context unavailable', e && e.message);
    return empty;
  }
}

// ---------------------------------------------------------------- making a draft

async function loadHistory(db, bookingNumber) {
  const snap = await db.collection(CONVERSATIONS).doc(bookingNumber).collection('messages').orderBy('sentAt', 'desc').limit(D.MAX_HISTORY + 5).get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() })).reverse();
}

/**
 * Makes (or skips) the draft for one due conversation.
 * deps: { db, nowMs(), ts(ms), apiKey, callClaude?, model? }
 * Returns { outcome }.
 */
async function processConversation(bookingNumber, deps) {
  const { db, nowMs, ts } = deps;
  const started = Date.now();
  const convRef = db.collection(CONVERSATIONS).doc(bookingNumber);

  // 1. Claim it. A second runner (or a late restart) finds aiDueAt empty and leaves.
  const claimed = await db.runTransaction(async tx => {
    const c = await tx.get(convRef);
    if (!c.exists) return null;
    const v = c.data();
    if (!v.aiPending || !v.aiDueAt || ms(v.aiDueAt) > nowMs()) return null;
    tx.update(convRef, { aiDueAt: null, aiRunning: { at: ts(nowMs()), lastMessageId: v.aiPending.lastMessageId } });
    return { conv: v, pending: v.aiPending };
  });
  if (!claimed) return { outcome: 'not due' };
  const { conv, pending } = claimed;

  const finish = async (outcome, draft, extra = {}, send = null, extraUpdate = null) => {
    const r = await db.runTransaction(async tx => {
      const c = await tx.get(convRef);
      if (!c.exists) return 'gone';
      const v = c.data();
      const same = v.aiPending && v.aiPending.lastMessageId === pending.lastMessageId;
      if (!same) { tx.update(convRef, { aiRunning: null }); return 'newer message'; }   // a newer message restarted the wait
      // Last check: the newest message must still be the guest's, and I must not have replied.
      const latest = (await tx.get(convRef.collection('messages').orderBy('createdAt', 'desc').limit(3))).docs.map(d => ({ id: d.id, ...d.data() }));
      const newest = latest[0];
      if (!newest || newest.direction !== 'guest' || newest.id !== pending.lastMessageId) {
        tx.update(convRef, { aiPending: null, aiRunning: null, aiDueAt: null });
        return 'replied or newer';
      }
      if (send) {
        // Automatic send: same last check as above, and the reply is queued in THIS transaction, so nothing
        // newer can slip in between the check and the send. Same path as a person tapping Send.
        const clientId = `ai-${pending.lastMessageId}`;
        const existing = await tx.get(db.collection('inbox_outbox').doc(clientId));
        if (existing.exists) { tx.update(convRef, { aiPending: null, aiRunning: null, aiDueAt: null }); return 'already sent'; }
        const clean = cleanReplyText(send.text);
        if (!clean.ok) { tx.update(convRef, { aiPending: null, aiRunning: null, aiDueAt: null, aiDraft: { ...draft, createdAt: ts(nowMs()), forMessageId: pending.lastMessageId } }); return 'saved'; }
        tx.update(convRef, { aiPending: null, aiRunning: null, aiDueAt: null, aiDraft: null });
        queueReplyWrites(tx, db, {
          bookingNumber, clientId, text: clean.text, conv: v, gmailMessageId: pending.lastMessageId,
          sentBy: AI_SENDER.email, sentByName: AI_SENDER.name, now: () => ts(nowMs()), label: 'AI',
          messageExtra: send.holding ? { holding: true } : undefined,
        });
        if (send.needsYou) {
          // A holding reply was sent, but the host still has to decide: back to "Needs reply" with a note (the alert comes from it).
          tx.update(convRef, { needsReply: true, done: false, doneAt: null, waitingSince: v.waitingSince || v.lastGuestMessageAt || null, aiDraft: { kind: 'needs_you', reason: send.needsYou, text: send.needsYou, source: 'rule', createdAt: ts(nowMs()), forMessageId: pending.lastMessageId } });
        }
        return 'auto_sent';
      }
      const upd = { aiPending: null, aiRunning: null, aiDueAt: null, ...(extraUpdate || {}) };
      if (draft) upd.aiDraft = { ...draft, createdAt: ts(nowMs()), forMessageId: pending.lastMessageId };
      tx.update(convRef, upd);
      return draft ? 'saved' : 'cleared';
    });
    const done = r === 'saved' || r === 'cleared' || r === 'auto_sent';
    log({ conv: bookingNumber, outcome: done ? (r === 'auto_sent' ? 'auto_sent' : outcome) : `discarded (${r})`, ...extra, ms: Date.now() - started });
    return { outcome: done ? (r === 'auto_sent' ? 'auto_sent' : outcome) : `discarded (${r})`, sent: r === 'auto_sent' };
  };
  const note = (kind, reason, extra) => finish(kind === 'needs_you' ? `needs_you: ${reason}` : kind, { kind, reason, text: reason, source: 'rule' }, extra);

  // 2. Switch.
  const cfg = await db.collection('globals').doc('config').get();
  const mode = resolveAiMode(cfg.exists ? cfg.data() : null);
  if (mode === 'off') return finish('switch off', null);

  // 3. The burst.
  const history = await loadHistory(db, bookingNumber);
  const burst = history.filter(m => m.direction === 'guest' && (pending.ids || []).includes(m.id));
  const texts = burst.map(m => String(m.text || ''));
  if (!texts.length) return finish('empty burst', null);

  // The holding reply for a cancellation or a change of dates: it promises nothing, and the host is alerted.
  const holdingReply = async (label, extra = {}) => {
    const reason = `${label} request`;
    const twoHours = nowMs() - 2 * 60 * 60 * 1000;
    if (history.some(m => m.direction === 'host' && m.holding && ms(m.sentAt) >= twoHours)) {
      return note('needs_you', `${reason} (asked again, a holding reply was already sent)`, extra);   // not twice in a row
    }
    let text = T.HOLDING_EN;
    const guestTexts = history.filter(m => m.direction === 'guest').map(m => String(m.text || ''));
    if (guestTexts.length) {
      try {
        const r = translationRequest(T.HOLDING_EN, guestTexts);
        const outT = await (deps.callClaude || claude.callClaudeWithRetry)({ apiKey: deps.apiKey, system: r.system, messages: [{ role: 'user', content: r.user }], maxTokens: 400, model: deps.model || claude.MODEL, log: { warn: () => {}, error: () => {} } });
        const tr = outT && outT.ok ? acceptTranslation(T.HOLDING_EN, outT.text) : null;   // the same words, nothing more, or English only
        if (tr) text = `${T.HOLDING_EN}\n\n${tr}`;
      } catch (e) { console.warn('inboxAi: holding translation failed, English only', e && e.message); }
    }
    const checked = D.checkDraft(text);
    if (!checked.ok) return note('needs_you', reason, extra);
    const draft = { kind: 'reply', text: checked.text, source: 'rule', needsYouReason: reason };
    if (mode === 'auto') {
      const block = autoSendBlockReason({ conv, messages: history, nowMs: nowMs() });
      if (block) return finish('hold draft', { ...draft, autoBlocked: block }, { ...extra, hold: label });
      return finish('hold sent', draft, { ...extra, hold: label, mode }, { text: checked.text, holding: true, needsYou: reason });
    }
    return finish('hold draft', draft, { ...extra, hold: label });
  };

  // 4. Skip rules and the topics that are the host's call. The English keywords are a safety net; the model names
  //    the topics in any language (see below).
  if (D.burstIsOnlyClosers(texts)) {
    // "ok", "thanks": nothing to answer, so the conversation moves to Done by itself (a new guest message reopens it).
    // Not when a cancellation or check-in request is still open or the last reply did not go out.
    const open = conv.cancelRequest || conv.checkinAction || conv.lastSendStatus === 'failed' || conv.lastSendStatus === 'unknown';
    return finish('closer', null, {}, null, open ? null : { done: true, needsReply: false, doneAt: ts(nowMs()), closedAsThanksAt: ts(nowMs()), waitingSince: null });
  }
  const k = D.knowledgeForConversation(conv, KB.SEED);
  if (!k.ok) return note('needs_you', k.reason);
  const kw = T.keywordTopics(texts);
  const kwDecision = T.decideByTopics(kw);
  if (kwDecision.action === 'needs_you') return note('needs_you', kwDecision.reason);

  // 5. Cost guard.
  const hourAgo = nowMs() - 60 * 60 * 1000;
  const recent = (conv.aiDraftTimes || []).map(ms).filter(t => t > hourAgo);
  if (recent.length >= MAX_PER_CONV_PER_HOUR) return note('needs_you', 'too many drafts for this chat in the last hour');
  const usageRef = db.collection(USAGE).doc(dayKey(nowMs()));
  const allowed = await db.runTransaction(async tx => {
    const u = await tx.get(usageRef);
    const n = u.exists ? Number(u.data().count || 0) : 0;
    if (n >= DAILY_CAP) return false;
    tx.set(usageRef, { count: n + 1, updatedAt: ts(nowMs()) }, { merge: true });
    tx.update(convRef, { aiDraftTimes: [...recent.map(t => ts(t)), ts(nowMs())] });
    return true;
  });
  if (!allowed) return note('needs_you', 'the daily AI draft limit is reached');
  if (kwDecision.action === 'hold') return holdingReply(kwDecision.label);   // a cancellation or date change found by keywords: no model call for the topic

  // 6. Ask the model (same prompt as the WhatsApp bot plus the Booking.com rules).
  const wa = await findWhatsapp(db, conv);
  const kb = KB.SEED;
  const system = claude.buildCachedSystem(D.fixedSystemText(kb), D.dynamicSystemText({ conv, formFilled: wa.formFilled, nowMs: nowMs(), kb }));
  const userTurn = D.buildUserTurn({ bookingMessages: history, burstIds: pending.ids, whatsapp: wa.messages, nowMs: nowMs() });
  const call = deps.callClaude || claude.callClaudeWithRetry;
  const model = deps.model || claude.MODEL;
  const out = await call({ apiKey: deps.apiKey, system, messages: [{ role: 'user', content: userTurn }], maxTokens: MAX_TOKENS, model, log: { warn: () => {}, error: () => {} } });
  const usage = out && out.usage ? { in: out.usage.input_tokens, cacheRead: out.usage.cache_read_input_tokens || 0, out: out.usage.output_tokens } : undefined;
  if (!out || !out.ok) return note('needs_you', 'the assistant could not write a draft just now', { model, error: out && out.errorType, usage });

  // 7. Read the answer.
  const tp = T.parseTopicsLine(out.text);                 // "TOPICS: ..." first line, then the answer
  const parsed = D.parseModelOutput(tp.rest);
  const info = { model, usage };
  if (parsed.type === 'silent') return finish('silent', null, info);
  if (parsed.type === 'needs_you') return finish(`needs_you: ${parsed.reason}`, { kind: 'needs_you', reason: parsed.reason, text: parsed.reason, source: 'ai', model }, info);
  if (parsed.type === 'already_answered') {
    if (!D.whatsappAnswerAt(parsed.time, wa.messages)) return finish('needs_you: not sure if answered on WhatsApp', { kind: 'needs_you', reason: 'not sure if this was already answered on WhatsApp', text: 'not sure if this was already answered on WhatsApp', source: 'ai', model }, info);
    const text = `Already answered on WhatsApp at ${parsed.time}: ${parsed.summary}`;
    return finish('already_answered', { kind: 'already_answered', text, source: 'ai', model }, info);
  }
  if (parsed.type !== 'reply') return finish('needs_you: empty answer', { kind: 'needs_you', reason: 'the assistant gave no usable draft', text: 'the assistant gave no usable draft', source: 'ai', model }, info);
  // The topics decide what is allowed: the model's (any language) together with the keywords.
  if (!tp.topics) return finish('needs_you: topic unclear', { kind: 'needs_you', reason: 'the assistant could not tell what the guest is asking about, so nothing was sent', text: 'the assistant could not tell what the guest is asking about, so nothing was sent', source: 'ai', model }, info);
  const topics = new Set([...tp.topics, ...kw]);
  const byTopic = T.decideByTopics(topics);
  if (byTopic.action === 'needs_you') return finish(`needs_you: ${byTopic.reason}`, { kind: 'needs_you', reason: byTopic.reason, text: byTopic.reason, source: 'ai', model }, info);
  if (byTopic.action === 'hold') return holdingReply(byTopic.label, info);
  const tcheck = T.validateTopicReply(parsed.text, topics);
  if (!tcheck.ok) {
    const reason = `the answer was not safe to send (${tcheck.problem}). Write this one yourself`;
    return finish(`needs_you: topic check (${tcheck.problem})`, { kind: 'needs_you', reason, text: reason, source: 'ai', model }, info);
  }
  const checked = D.checkDraft(parsed.text, { kb });
  if (!checked.ok) {
    const reason = `the draft contained ${checked.problem}, which Booking.com chats must not have. Write this one yourself`;
    return finish(`needs_you: draft rejected (${checked.problem})`, { kind: 'needs_you', reason, text: reason, source: 'ai', model }, info);
  }
  // A normal draft that passed every check. Drafts mode: shown for me to send. Automatic mode: sent by itself,
  // unless the reservation is cancelled or one of us replied in the last 30 minutes (then it stays a draft).
  const block = mode === 'auto' ? autoSendBlockReason({ conv, messages: history, nowMs: nowMs() }) : 'drafts mode';
  const draft = { kind: 'reply', text: checked.text, source: 'ai', model, ...(mode === 'auto' && block ? { autoBlocked: block } : {}) };
  if (mode === 'auto' && !block) return finish('reply', draft, { ...info, removedLinks: checked.removedLinks, mode }, { text: checked.text });
  return finish('reply', draft, { ...info, removedLinks: checked.removedLinks, mode });
}

/** Runs every conversation that is due (a few per call). deps as processConversation. */
async function runDue(deps) {
  const snap = await deps.db.collection(CONVERSATIONS).where('aiDueAt', '<=', deps.ts(deps.nowMs())).limit(MAX_DUE_PER_RUN).get();
  const results = [];
  for (const d of snap.docs) {
    try {
      const r = await processConversation(d.id, deps);
      results.push(r);
      if (r && r.sent && typeof deps.poke === 'function') {
        try { await deps.poke(); } catch (e) { console.warn('inboxAi: instant send not triggered', e && e.message); }   // the script's next run sends it anyway
      }
    } catch (e) { console.error('inboxAi failed', d.id, e && e.code, e && e.message); }
  }
  return results;
}

// ---------------------------------------------------------------- owner: discard

async function discardDraft(auth, data, deps) {
  if (!isInboxUser(auth)) throw new Fail('permission-denied', 'Only people with inbox access can do this.');
  const bn = data && data.bookingNumber;
  if (!isBookingNumber(bn)) throw new Fail('invalid-argument', 'Bad booking number.');
  const ref = deps.db.collection(CONVERSATIONS).doc(bn);
  await deps.db.runTransaction(async tx => {
    const c = await tx.get(ref);
    if (!c.exists) throw new Fail('not-found', 'Conversation not found.');
    tx.update(ref, { aiDraft: null });
  });
  return { ok: true };
}

// ---------------------------------------------------------------- Cloud Functions

function registerCloudFunctions() {
  const { onDocumentCreated } = require('firebase-functions/v2/firestore');
  const { onSchedule } = require('firebase-functions/v2/scheduler');
  const { onCall, HttpsError } = require('firebase-functions/v2/https');
  const { defineSecret } = require('firebase-functions/params');
  const { getFirestore, Timestamp } = require('firebase-admin/firestore');
  const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');
  const INBOX_INGEST_KEY = defineSecret('INBOX_INGEST_KEY');
  const INBOX_SCRIPT_URL = defineSecret('INBOX_SCRIPT_URL');
  const region = 'europe-west1';
  const baseDeps = () => ({ db: getFirestore(), nowMs: () => Date.now(), ts: m => Timestamp.fromMillis(m) });

  const inboxAiOnMessage = onDocumentCreated(
    { document: `${CONVERSATIONS}/{bookingNumber}/messages/{messageId}`, region, timeoutSeconds: 30, maxInstances: 5, memory: '256MiB' },
    async event => {
      const snap = event.data;
      if (!snap) return;
      try {
        await onMessageCreated(event.params.bookingNumber, event.params.messageId, snap.data(), baseDeps());
      } catch (e) {
        console.error('inboxAiOnMessage failed', e && e.code, e && e.message);
      }
    }
  );

  const inboxAiRun = onSchedule(
    { schedule: 'every 1 minutes', region, secrets: [ANTHROPIC_API_KEY, INBOX_INGEST_KEY, INBOX_SCRIPT_URL], timeoutSeconds: 300, memory: '512MiB', maxInstances: 1 },
    async () => {
      // poke: after an automatic send, ask the Gmail script web app to send it now (best effort; its next run sends it anyway)
      const { pokeWebApp } = require('./inboxReply');
      const runDeps = { ...baseDeps(), apiKey: ANTHROPIC_API_KEY.value(), poke: () => pokeWebApp(INBOX_SCRIPT_URL.value().trim(), INBOX_INGEST_KEY.value()) };
      await runDue(runDeps);
      try { await require('./inboxCheckin').runDueCheckin({ ...runDeps, callClaude: claude.callClaudeWithRetry }); }   // check-in time requests
      catch (e) { console.warn('inboxAiRun: check-in step failed', e && e.message); }
      try { await require('./inboxStats').refreshInboxStats({ db: getFirestore(), now: () => Timestamp.now() }); }   // heals the admin count
      catch (e) { console.warn('inboxAiRun: stats refresh failed', e && e.message); }
    }
  );

  const inboxDraftDiscard = onCall({ region, timeoutSeconds: 30, maxInstances: 5, memory: '256MiB' }, async request => {
    try {
      return await discardDraft(request.auth, request.data, baseDeps());
    } catch (e) {
      if (e instanceof Fail) throw new HttpsError(e.code, e.message);
      console.error('inboxDraftDiscard failed', e && e.code, e && e.message);
      throw new HttpsError('internal', 'Something went wrong. Try again.');
    }
  });

  return { inboxAiOnMessage, inboxAiRun, inboxDraftDiscard };
}

module.exports = {
  onMessageCreated, processConversation, runDue, discardDraft, findWhatsapp, registerCloudFunctions,
  MAX_PER_CONV_PER_HOUR, DAILY_CAP,
};
