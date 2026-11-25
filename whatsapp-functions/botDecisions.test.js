'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildDecisionDoc, conversationId, decisionForDelivery, decisionRecorder,
  promptHash, stayMoment, sumTokens, tagsFromPlan, DECISIONS_COLLECTION,
} = require('./botDecisions');
const { parseAiReply, deliverReply } = require('./replyDelivery');
const { stayTiming } = require('./stayRules');

const PHONE = '995555001031';
const at = (iso) => Date.parse(iso); // Tbilisi = UTC+4

test('conversationId: same chat, same id; the phone is not in it', () => {
  const id = conversationId(PHONE);
  assert.match(id, /^c_[0-9a-f]{16}$/);
  assert.equal(conversationId(`+${PHONE}`), id);
  assert.notEqual(conversationId('995555001032'), id);
  assert.ok(!id.includes('1031'));
  assert.equal(conversationId(''), '');
});

test('promptHash changes with the prompt text', () => {
  assert.equal(promptHash('a').length, 12);
  assert.notEqual(promptHash('a'), promptHash('b'));
  assert.equal(promptHash(''), '');
});

test('stayMoment for each part of a stay (1 Nov to 6 Dec)', () => {
  const stay = { checkin: '2026-11-01', checkout: '2026-12-06' };
  const m = (iso) => stayMoment(stayTiming(stay, at(iso)), stay.checkin);
  assert.equal(m('2026-10-30T08:00:00Z'), 'before_arrival');
  assert.equal(m('2026-11-01T08:00:00Z'), 'arrival_day_before_checkin'); // 12:00 Tbilisi
  assert.equal(m('2026-11-01T12:00:00Z'), 'arrival_day_after_checkin'); // 16:00
  assert.equal(m('2026-11-24T08:00:00Z'), 'during_stay');
  assert.equal(m('2026-12-06T06:00:00Z'), 'checkout_day');
  assert.equal(m('2026-12-07T06:00:00Z'), 'after_stay');
  assert.equal(stayMoment(stayTiming({}, at('2026-11-24T08:00:00Z')), ''), 'unknown');
  assert.equal(stayMoment(null), 'unknown');
});

test('tagsFromPlan lists what the model wrote', () => {
  assert.deepEqual(tagsFromPlan(parseAiReply('Sure. [ESCALATE]')), ['ESCALATE']);
  assert.deepEqual(tagsFromPlan(parseAiReply('[VIDEO:2] Here is the video. [URGENT:ISSUE]')), ['URGENT:ISSUE', 'VIDEO:2']);
  assert.deepEqual(tagsFromPlan(parseAiReply('[SILENT]')), ['SILENT']);
  assert.deepEqual(tagsFromPlan(parseAiReply('[URGENT:ANGRY]')), ['URGENT:ANGRY']);
  assert.deepEqual(tagsFromPlan(parseAiReply('Hello!')), []);
});

test('decisionForDelivery: a plain reply', () => {
  const d = decisionForDelivery('sent', parseAiReply('The WiFi name is on the check-in page.'), { text: 'The WiFi name is on the check-in page.' });
  assert.equal(d.action, 'replied');
  assert.equal(d.replied, true);
  assert.equal(d.escalated, false);
  assert.equal(d.silentReason, null);
  assert.equal(d.sentText, 'The WiFi name is on the check-in page.');
});

test('decisionForDelivery: reply + escalation, urgent, angry, tag-only', () => {
  const esc = decisionForDelivery('sent', parseAiReply('Sure, we\'ll check and arrange it for you. [ESCALATE]'), { text: 'Sure, we\'ll check and arrange it for you.' });
  assert.equal(esc.action, 'escalated');
  assert.equal(esc.replied, true);
  assert.equal(esc.escalated, true);

  const urgent = decisionForDelivery('sent', parseAiReply('We are on it. [URGENT:LOCKOUT]'), { text: 'We are on it.' });
  assert.equal(urgent.action, 'urgent');
  assert.equal(urgent.urgentTag, 'LOCKOUT');

  const angry = decisionForDelivery('angry_alerted', parseAiReply('[URGENT:ANGRY]'), {});
  assert.equal(angry.action, 'urgent');
  assert.equal(angry.urgentTag, 'ANGRY');
  assert.equal(angry.replied, false);

  const only = decisionForDelivery('escalated_only', parseAiReply('[ESCALATE]'), {});
  assert.equal(only.action, 'escalated');
  assert.equal(only.replied, false);
});

test('decisionForDelivery: runs that sent nothing say why', () => {
  const plan = parseAiReply('Sure. [ESCALATE]');
  const newer = decisionForDelivery('stopped_newer', plan, {});
  assert.deepEqual([newer.action, newer.silentReason, newer.superseded, newer.escalated], ['silent', 'newer_guest_message', true, false]);
  const owner = decisionForDelivery('stopped_owner', plan, {});
  assert.deepEqual([owner.action, owner.silentReason, owner.escalated], ['silent', 'owner_replied_while_generating', false]);
  const leak = decisionForDelivery('leak_blocked', parseAiReply('Wait, the guest is asking about cleaning.'), {});
  assert.deepEqual([leak.action, leak.silentReason, leak.replied], ['error', 'reply_blocked_reasoning_leak', false]);
  assert.equal(decisionForDelivery('empty_reply', parseAiReply(''), {}).silentReason, 'empty_reply');
  assert.equal(decisionForDelivery('send_failed', parseAiReply('Hi'), {}).silentReason, 'send_failed');
  assert.equal(decisionForDelivery('something_new', parseAiReply('Hi'), {}).action, 'error');
});

test('decisionForDelivery: media sent is recorded', () => {
  const d = decisionForDelivery('sent', parseAiReply('[VIDEO:1] Here is how to open the door.'), { text: 'Here is how to open the door.', mediaId: '1' });
  assert.equal(d.mediaSent, '1');
  assert.equal(d.action, 'replied');
});

test('sumTokens adds up every Claude call (first + leak retry)', () => {
  const t = sumTokens([
    { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 9000, cache_creation_input_tokens: 0 },
    { input_tokens: 110, output_tokens: 25, cache_read_input_tokens: 0, cache_creation_input_tokens: 9000 },
    null,
  ]);
  assert.deepEqual(t, { input: 210, output: 45, cacheRead: 9000, cacheWrite: 9000, calls: 2 });
});

test('buildDecisionDoc: every field, no phone number anywhere', () => {
  const doc = buildDecisionDoc({
    phone: PHONE,
    guestMessages: ['Could someone come today to clean the bathroom, please?'],
    room: '7-2', property: 'Shartava', unitType: 'superior', stayMoment: 'during_stay',
    mode: 'available', model: 'claude-sonnet-4-6', promptHash: 'abc123def456',
    usages: [{ input_tokens: 5, output_tokens: 7 }],
    tags: ['ESCALATE'], modelReply: 'Sure, we\'ll check and arrange it for you. [ESCALATE]',
    build: { commit: '4ac1110', dirty: false },
  }, decisionForDelivery('sent', parseAiReply('Sure, we\'ll check and arrange it for you. [ESCALATE]'), { text: 'Sure, we\'ll check and arrange it for you.' }), at('2026-11-25T08:00:00Z'));
  assert.equal(doc.atMs, at('2026-11-25T08:00:00Z'));
  assert.equal(doc.conversation, conversationId(PHONE));
  assert.equal(doc.action, 'escalated');
  assert.equal(doc.sentText, 'Sure, we\'ll check and arrange it for you.');
  assert.equal(doc.commit, '4ac1110');
  assert.deepEqual(doc.tokens, { input: 5, output: 7, cacheRead: 0, cacheWrite: 0, calls: 1 });
  assert.equal(doc.ownerFollowup, null);
  assert.equal(doc.followupCheckedAtMs, null);
  assert.ok(!JSON.stringify(doc).includes(PHONE), 'the phone number must never be stored');
  assert.ok(!JSON.stringify(doc).includes('555001031'));
});

test('buildDecisionDoc clips very long text', () => {
  const doc = buildDecisionDoc({ phone: PHONE, guestMessages: ['x'.repeat(9000)] }, { action: 'silent', silentReason: 'closed_topic' });
  assert.equal(doc.guestMessages[0].length, 4000);
  assert.equal(doc.silentReason, 'closed_topic');
});

function fakeDb({ fail = false } = {}) {
  const writes = [];
  return {
    writes,
    collection(name) {
      return { add: async (doc) => { if (fail) throw new Error('quota'); writes.push({ name, doc }); } };
    },
  };
}

test('decisionRecorder writes ONE document per run, to bot_decisions', async () => {
  const db = fakeDb();
  const rec = decisionRecorder({ db, phone: PHONE, guestMessages: ['Hello'], mode: 'night', now: () => 42, serverTimestamp: () => 'SERVER_TIME' });
  rec.set({ room: '7-2' });
  rec.addUsage({ input_tokens: 1, output_tokens: 2 });
  await rec.record({ action: 'silent', outcome: 'closed_topic', silentReason: 'closed_topic' });
  await rec.record({ action: 'replied' }); // ignored
  assert.equal(db.writes.length, 1);
  assert.equal(db.writes[0].name, DECISIONS_COLLECTION);
  assert.equal(db.writes[0].doc.at, 'SERVER_TIME');
  assert.equal(db.writes[0].doc.atMs, 42);
  assert.equal(db.writes[0].doc.mode, 'night');
  assert.equal(db.writes[0].doc.action, 'silent');
  assert.equal(rec.recorded, true);
});

test('decisionRecorder: a failed write never throws (the bot is not affected)', async () => {
  const warnings = [];
  const rec = decisionRecorder({ db: fakeDb({ fail: true }), phone: PHONE, log: { warn: (m) => warnings.push(m) } });
  await rec.record({ action: 'replied' });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /could not save the decision/);
});

// End to end with the real deliverReply: the recorded text is exactly what was sent.
async function runDelivery(raw, { preSend = 'send', textOk = true } = {}) {
  const plan = parseAiReply(raw);
  const sent = { text: null, mediaId: null };
  const { outcome } = await deliverReply(plan, { name: 'Guest', room: '7-2', guestText: 'Hi', mode: 'available' }, {
    log: { log() {}, warn() {}, error() {} },
    humanize: async () => {},
    preSendCheck: async () => preSend,
    sendVideo: async (id) => { sent.mediaId = id; return { ok: true }; },
    sendText: async (body) => { if (!textOk) return { ok: false, code: 1, reason: 'x' }; sent.text = body; return { ok: true, id: 'm' }; },
    storeAssistant: async () => {},
    writeAlert: async () => {},
    notifyOwner: async () => {},
    notifyOwnerThrottled: async () => {},
    finishPending: async () => {},
  });
  return decisionForDelivery(outcome, plan, sent);
}

test('with deliverReply: sent text has the tags removed', async () => {
  const d = await runDelivery('Sure, we\'ll check and arrange it for you. [ESCALATE]');
  assert.equal(d.action, 'escalated');
  assert.equal(d.sentText, 'Sure, we\'ll check and arrange it for you.');
});

test('with deliverReply: a blocked door code is never recorded, the safe reply that was sent is', async () => {
  const d = await runDelivery('The door code is 4821#.');
  assert.equal(d.replied, true);
  assert.ok(d.sentText && !d.sentText.includes('4821'));
});

test('with deliverReply: owner replied first -> silent, nothing sent', async () => {
  const d = await runDelivery('Sure. [ESCALATE]', { preSend: 'owner_replied' });
  assert.deepEqual([d.action, d.replied, d.sentText], ['silent', false, null]);
});

test('with deliverReply: Meta refused the text -> error, nothing recorded as sent', async () => {
  const d = await runDelivery('Hello there.', { textOk: false });
  assert.deepEqual([d.action, d.replied, d.silentReason], ['error', false, 'send_failed']);
});

test('with deliverReply: the 24 Nov leaking reply -> blocked, recorded as error', async () => {
  const d = await runDelivery('Good to hear from you again. How can I help?\n\nWait, the guest is asking about cleaning. Let me check with the team.');
  assert.equal(d.outcome, 'leak_blocked');
  assert.equal(d.replied, false);
});
