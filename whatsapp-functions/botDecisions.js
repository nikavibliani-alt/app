'use strict';

// One Firestore document per bot run in `bot_decisions`: what the guest wrote,
// what the bot did (replied / silent / escalated / urgent / error), why it was
// silent, the exact text that reached the guest, mode, model, prompt version
// and tokens. Kept forever (no TTL), as a learning and test set.
//
// Recording never changes what the bot does: every write is wrapped, a failed
// write is only logged, and it runs after the bot has already acted.
// The real phone number is never stored here, only a one-way hash of it
// (`conversation`), the same for every run of that chat.

const crypto = require('node:crypto');

const DECISIONS_COLLECTION = 'bot_decisions';
const SCHEMA_VERSION = 1;
const TEXT_MAX = 4000;

/** Same chat -> same id; the phone can't be read back from it. "c_" + 16 hex characters. */
function conversationId(phone) {
  const digits = String(phone ?? '').replace(/\D/g, '');
  if (!digits) return '';
  return `c_${crypto.createHash('sha256').update(`maxela-bot-decisions:${digits}`).digest('hex').slice(0, 16)}`;
}

/** Short fingerprint of the exact system prompt sent (changes with the template AND the knowledge base). */
function promptHash(promptText) {
  if (!promptText) return '';
  return crypto.createHash('sha256').update(String(promptText)).digest('hex').slice(0, 12);
}

/** The deployed commit, written at deploy time by scripts/build-info.js (absent in tests and local runs). */
function buildInfo() {
  try {
    // eslint-disable-next-line global-require
    const info = require('./build-info.json');
    return { commit: String(info.commit || ''), dirty: !!info.dirty };
  } catch {
    return { commit: '', dirty: false };
  }
}

/**
 * Where the guest is in their stay, from stayRules.stayTiming():
 * 'before_arrival' | 'arrival_day_before_checkin' | 'arrival_day_after_checkin'
 * | 'during_stay' | 'checkout_day' | 'after_stay' | 'unknown'.
 */
function stayMoment(timing, stayStart) {
  if (!timing) return 'unknown';
  const arrival = String(stayStart || '').slice(0, 10);
  if (timing.arrivalDay === true) return timing.checkinTimePassed ? 'arrival_day_after_checkin' : 'arrival_day_before_checkin';
  if (timing.checkoutDay === true) return 'checkout_day';
  if (timing.stayEnded === true) return 'after_stay';
  if (arrival && timing.today < arrival) return 'before_arrival';
  if (arrival && timing.arrivalDay === false && timing.stayEnded === false) return 'during_stay';
  return 'unknown';
}

/** Tags the model wrote, from a parseAiReply() plan: e.g. ['ESCALATE', 'URGENT:ISSUE', 'VIDEO:2']. */
function tagsFromPlan(plan) {
  if (!plan) return [];
  const tags = [];
  if (plan.silent) tags.push('SILENT');
  if (plan.angry) tags.push('URGENT:ANGRY');
  if (plan.urgent) tags.push(`URGENT:${plan.urgent}`);
  else if (plan.escalate) tags.push('ESCALATE');
  if (plan.videoId) tags.push(`VIDEO:${plan.videoId}`);
  return tags;
}

// deliverReply() outcome -> what the bot did. `replied` (did anything reach the
// guest) is decided by what was actually sent, not here.
const DELIVERY_OUTCOMES = {
  stopped_newer: { action: 'silent', silentReason: 'newer_guest_message', superseded: true },
  stopped_owner: { action: 'silent', silentReason: 'owner_replied_while_generating' },
  angry_alerted: { action: 'urgent' },
  escalated_only: { action: 'escalated' },
  leak_blocked: { action: 'error', silentReason: 'reply_blocked_reasoning_leak' },
  empty_reply: { action: 'error', silentReason: 'empty_reply' },
  send_failed: { action: 'error', silentReason: 'send_failed' },
  sent: { action: 'replied' },
};

/**
 * The decision fields for a deliverReply() outcome.
 * sent: { text, mediaId } that actually reached the guest.
 */
function decisionForDelivery(outcome, plan, sent = {}) {
  const base = DELIVERY_OUTCOMES[outcome] || { action: 'error', silentReason: outcome || 'unknown' };
  const replied = !!(sent.text || sent.mediaId);
  const urgentTag = plan?.angry ? 'ANGRY' : plan?.urgent || null;
  // Owner alerted for an escalation: only when the run got as far as acting on the tags.
  const acted = ['angry_alerted', 'escalated_only', 'sent'].includes(outcome);
  const escalated = acted && !!(plan?.escalate || plan?.angry);
  let { action } = base;
  if (acted) action = urgentTag ? 'urgent' : escalated ? 'escalated' : replied ? 'replied' : base.action;
  return {
    action,
    outcome,
    silentReason: replied ? null : base.silentReason || null,
    superseded: !!base.superseded,
    replied,
    escalated,
    urgentTag: acted || outcome === 'leak_blocked' ? urgentTag : null,
    mediaSent: sent.mediaId || null,
    sentText: sent.text || null,
  };
}

const clip = (s) => (s === null || s === undefined ? null : String(s).slice(0, TEXT_MAX));

/** Adds up the usage of every Claude call in the run. */
function sumTokens(usages) {
  const list = (usages || []).filter(Boolean);
  const add = (key) => list.reduce((n, u) => n + (Number(u[key]) || 0), 0);
  return {
    input: add('input_tokens'),
    output: add('output_tokens'),
    cacheRead: add('cache_read_input_tokens'),
    cacheWrite: add('cache_creation_input_tokens'),
    calls: list.length,
  };
}

/**
 * The document for one run. `ctx` holds what the worker knew (phone, guest
 * messages, room, mode, Claude calls...), `decision` what it did.
 */
function buildDecisionDoc(ctx = {}, decision = {}, nowMs = Date.now()) {
  const tokens = sumTokens(ctx.usages);
  const build = ctx.build || buildInfo();
  return {
    schema: SCHEMA_VERSION,
    atMs: nowMs,
    conversation: conversationId(ctx.phone),
    property: ctx.property || null,
    room: ctx.room || null,
    unitType: ctx.unitType || null,
    stayMoment: ctx.stayMoment || 'unknown',
    guestMessages: (ctx.guestMessages || []).map((m) => clip(m)),
    action: decision.action || 'silent',
    outcome: decision.outcome || null,
    silentReason: decision.silentReason || null,
    superseded: !!decision.superseded,
    replied: !!decision.replied,
    escalated: !!decision.escalated,
    urgentTag: decision.urgentTag || null,
    mediaSent: decision.mediaSent || null,
    sentText: clip(decision.sentText),
    tags: ctx.tags || [],
    modelReply: clip(ctx.modelReply),
    leakRetried: !!ctx.leakRetried,
    leak: ctx.leak || null,
    errorType: decision.errorType || null,
    mode: ctx.mode || null,
    model: ctx.model || null,
    promptHash: ctx.promptHash || null,
    commit: build.commit || null,
    commitDirty: !!build.dirty,
    revision: process.env.K_REVISION || null,
    tokens,
    // Filled later by the daily follow-up job (step 2).
    ownerFollowup: null,
    followupCheckedAtMs: null,
  };
}

/**
 * Collects facts during one worker run and writes ONE document at its end.
 * record(decision) writes once; later calls are ignored. Never throws.
 */
function decisionRecorder({ db, phone, guestMessages = [], mode = null, log = console, now = () => Date.now(), serverTimestamp = null }) {
  const ctx = { phone, guestMessages, mode, usages: [] };
  let done = false;
  return {
    ctx,
    set(fields) { Object.assign(ctx, fields); },
    addUsage(usage) { if (usage) ctx.usages.push(usage); },
    async record(decision) {
      if (done) return;
      done = true;
      try {
        const doc = buildDecisionDoc(ctx, decision, now());
        if (serverTimestamp) doc.at = serverTimestamp();
        await db.collection(DECISIONS_COLLECTION).add(doc);
      } catch (err) {
        log.warn?.(`botDecisions: could not save the decision (${err?.message || err}); the bot is not affected`);
      }
    },
    get recorded() { return done; },
  };
}

module.exports = {
  DECISIONS_COLLECTION,
  buildDecisionDoc,
  buildInfo,
  conversationId,
  decisionForDelivery,
  decisionRecorder,
  promptHash,
  stayMoment,
  sumTokens,
  tagsFromPlan,
};
