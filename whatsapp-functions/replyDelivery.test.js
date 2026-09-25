'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseAiReply, interpretMetaResponse, shouldNotifyNow, deliverReply } = require('./replyDelivery');

const WHO = { name: 'Anna Petrova', room: '6-2', guestText: 'I am locked out, the code does not work', mode: 'available' };

/** Fake deps that record every call in order. */
function fakeDeps({ decision = 'send', sendText = { ok: true, id: 'wamid.T' }, sendVideo = { ok: true, id: 'wamid.V' } } = {}) {
  const calls = [];
  const rec = (name) => async (...args) => { calls.push([name, ...args]); };
  return {
    calls,
    names: () => calls.map((c) => c[0]),
    deps: {
      log: { warn: () => {}, error: () => {}, log: () => {} },
      humanize: rec('humanize'),
      preSendCheck: async () => { calls.push(['preSendCheck']); return decision; },
      sendVideo: async (id) => { calls.push(['sendVideo', id]); return sendVideo; },
      sendText: async (body) => { calls.push(['sendText', body]); return sendText; },
      storeAssistant: rec('storeAssistant'),
      writeAlert: rec('writeAlert'),
      notifyOwner: rec('notifyOwner'),
      notifyOwnerThrottled: rec('notifyOwnerThrottled'),
      finishPending: rec('finishPending'),
    },
  };
}

test('parseAiReply', async (t) => {
  await t.test('tag-only escalation leaves no text', () => {
    assert.deepEqual(parseAiReply('[ESCALATE]'), { text: '', videoId: null, escalate: true, urgent: null, angry: false, silent: false });
    assert.equal(parseAiReply('  [ESCALATE] [URGENT:LOCKOUT] ').text, '');
  });
  await t.test('video, text and urgent tags', () => {
    const p = parseAiReply('[VIDEO:975338858914982]\nWe do not have private parking! [ESCALATE] [URGENT:ISSUE]');
    assert.equal(p.videoId, '975338858914982');
    assert.equal(p.text, 'We do not have private parking.', 'tags removed, tone guard applied');
    assert.equal(p.escalate, true);
    assert.equal(p.urgent, 'ISSUE');
  });
  await t.test('angry and silent', () => {
    assert.equal(parseAiReply('[URGENT:ANGRY]').angry, true);
    assert.equal(parseAiReply('[URGENT:ANGRY]').text, '');
    assert.equal(parseAiReply('[SILENT]').silent, true);
  });
});

test('interpretMetaResponse', () => {
  assert.deepEqual(interpretMetaResponse({ messages: [{ id: 'wamid.X' }] }), { ok: true, id: 'wamid.X' });
  const r = interpretMetaResponse({ error: { code: 131047, message: 'Re-engagement message', error_data: { details: 'More than 24 hours have passed' } } });
  assert.equal(r.ok, false);
  assert.equal(r.code, 131047);
  assert.match(r.reason, /Meta error 131047: Re-engagement message \(More than 24 hours have passed\)/);
  assert.equal(interpretMetaResponse({}).ok, false);
  assert.equal(interpretMetaResponse(null).code, 'no_message_id');
});

test('shouldNotifyNow: one owner notification per error type per 30 minutes', () => {
  const W = 30 * 60 * 1000;
  assert.equal(shouldNotifyNow(NaN, 1e9, W), true, 'never notified before');
  assert.equal(shouldNotifyNow(1e9 - 10 * 60 * 1000, 1e9, W), false, '10 min ago: skip');
  assert.equal(shouldNotifyNow(1e9 - 31 * 60 * 1000, 1e9, W), true, '31 min ago: notify again');
});

test('normal reply: humanize, pre-send check, send, store, finish; no alerts', async () => {
  const f = fakeDeps();
  const r = await deliverReply(parseAiReply('Sure, the wifi is maxela62'), WHO, f.deps);
  assert.equal(r.outcome, 'sent');
  assert.deepEqual(f.names(), ['humanize', 'preSendCheck', 'sendText', 'storeAssistant', 'finishPending']);
  assert.deepEqual(f.calls.find((c) => c[0] === 'storeAssistant'), ['storeAssistant', 'Sure, the wifi is maxela62']);
});

test('empty reply after removing tags', async (t) => {
  await t.test('escalation: nothing sent to the guest, owner alerted', async () => {
    const f = fakeDeps();
    const r = await deliverReply(parseAiReply('[ESCALATE]'), WHO, f.deps);
    assert.equal(r.outcome, 'escalated_only');
    assert.ok(!f.names().includes('sendText'), 'no empty WhatsApp message');
    assert.ok(!f.names().includes('storeAssistant'));
    assert.deepEqual(f.calls.find((c) => c[0] === 'writeAlert')[1], { reason: 'escalation', urgency: false });
    assert.match(f.calls.find((c) => c[0] === 'notifyOwner')[1], /^Guest needs help — Anna Petrova \/ 6-2/);
    assert.ok(f.names().includes('finishPending'));
  });
  await t.test('urgent escalation with no text: paged once, nothing sent', async () => {
    const f = fakeDeps();
    const r = await deliverReply(parseAiReply('[ESCALATE] [URGENT:LOCKOUT]'), WHO, f.deps);
    assert.equal(r.outcome, 'escalated_only');
    assert.deepEqual(f.calls.filter((c) => c[0] === 'notifyOwner').map((c) => c[1]), ['URGENT: Anna Petrova / 6-2 — guest is locked out']);
    assert.ok(!f.names().includes('sendText'));
  });
  await t.test('no escalation either: bot_error alert, pending kept', async () => {
    const f = fakeDeps();
    const r = await deliverReply(parseAiReply('[VIDEO_SENT:123]'), WHO, f.deps);
    assert.equal(r.outcome, 'empty_reply');
    assert.equal(f.calls.find((c) => c[0] === 'writeAlert')[1].reason, 'bot_error');
    assert.ok(f.names().includes('notifyOwnerThrottled'));
    assert.ok(!f.names().includes('sendText'));
    assert.ok(!f.names().includes('finishPending'), 'pending batch kept');
  });
});

test('Meta send failure', async (t) => {
  await t.test('text rejected: not stored, owner alerted, pending kept', async () => {
    const f = fakeDeps({ sendText: { ok: false, code: 131047, reason: 'Meta error 131047: Re-engagement message' } });
    const r = await deliverReply(parseAiReply('Here is the info. [ESCALATE]'), WHO, f.deps);
    assert.equal(r.outcome, 'send_failed');
    assert.ok(!f.names().includes('storeAssistant'), 'failed reply is not stored as a sent bot message');
    assert.ok(!f.names().includes('finishPending'), 'pending batch kept');
    const alert = f.calls.find((c) => c[0] === 'writeAlert')[1];
    assert.equal(alert.reason, 'bot_error');
    assert.equal(alert.errorType, 'meta_send_failed');
    const [, key, text] = f.calls.find((c) => c[0] === 'notifyOwnerThrottled');
    assert.equal(key, 'meta_131047');
    assert.match(text, /^Reply to Anna Petrova \/ 6-2 failed to send: Meta error 131047: Re-engagement message \(it was an escalation/);
  });
  await t.test('video rejected, text sent: stored without the video marker, owner alerted', async () => {
    const f = fakeDeps({ sendVideo: { ok: false, code: 131053, reason: 'Meta error 131053: Media upload error' } });
    const r = await deliverReply(parseAiReply('[VIDEO:975338858914982]\nPaid parking under Carrefour.'), WHO, f.deps);
    assert.equal(r.outcome, 'sent');
    assert.deepEqual(f.calls.find((c) => c[0] === 'storeAssistant'), ['storeAssistant', 'Paid parking under Carrefour.']);
    assert.match(f.calls.find((c) => c[0] === 'notifyOwnerThrottled')[2], /failed to send \(video\)/);
  });
  await t.test('video sent: the marker is stored so it is not resent later', async () => {
    const f = fakeDeps();
    await deliverReply(parseAiReply('[VIDEO:975338858914982]\nPaid parking under Carrefour.'), WHO, f.deps);
    assert.deepEqual(f.calls.find((c) => c[0] === 'storeAssistant'), ['storeAssistant', 'Paid parking under Carrefour.\n[VIDEO_SENT:975338858914982]']);
  });
  await t.test('video-only reply whose video fails: counted as a failed send', async () => {
    const f = fakeDeps({ sendVideo: { ok: false, code: 'network', reason: 'could not reach Meta' } });
    const r = await deliverReply(parseAiReply('[VIDEO:975338858914982]'), WHO, f.deps);
    assert.equal(r.outcome, 'send_failed');
    assert.ok(!f.names().includes('storeAssistant'));
  });
});

test('no duplicate urgent alert when a run is replaced by a newer one', async () => {
  const urgentPlan = parseAiReply('I am contacting our team right now and will update you shortly. [ESCALATE] [URGENT:LOCKOUT]');
  const runA = fakeDeps({ decision: 'newer_message' }); // guest wrote again while A was generating
  const runB = fakeDeps({ decision: 'send' });
  assert.equal((await deliverReply(urgentPlan, WHO, runA.deps)).outcome, 'stopped_newer');
  assert.equal((await deliverReply(urgentPlan, WHO, runB.deps)).outcome, 'sent');
  const pages = [...runA.calls, ...runB.calls].filter((c) => c[0] === 'notifyOwner');
  assert.equal(pages.length, 1, 'owner paged exactly once');
  assert.deepEqual(runA.names(), ['humanize', 'preSendCheck'], 'run A: no send, no alert, pending untouched');
  // urgent page goes out after the pre-send check and before the guest-facing send
  assert.deepEqual(runB.names(), ['humanize', 'preSendCheck', 'notifyOwner', 'sendText', 'storeAssistant', 'writeAlert', 'finishPending']);
});

test('angry guest: alerts the owner only after the pre-send check, sends nothing', async (t) => {
  await t.test('replaced by a newer run: no alert', async () => {
    const f = fakeDeps({ decision: 'newer_message' });
    assert.equal((await deliverReply(parseAiReply('[URGENT:ANGRY]'), WHO, f.deps)).outcome, 'stopped_newer');
    assert.deepEqual(f.names(), ['preSendCheck']);
  });
  await t.test('check passes: one urgent alert, nothing sent to the guest', async () => {
    const f = fakeDeps();
    assert.equal((await deliverReply(parseAiReply('[URGENT:ANGRY]'), WHO, f.deps)).outcome, 'angry_alerted');
    assert.deepEqual(f.names(), ['preSendCheck', 'writeAlert', 'notifyOwner', 'finishPending']);
    assert.deepEqual(f.calls[1][1], { reason: 'angry_guest', urgency: true });
    assert.ok(!f.names().includes('sendText'));
  });
});

test('owner replied during generation: nothing sent, no alerts', async () => {
  const f = fakeDeps({ decision: 'owner_replied' });
  const r = await deliverReply(parseAiReply('Sure thing. [ESCALATE] [URGENT:ISSUE]'), WHO, f.deps);
  assert.equal(r.outcome, 'stopped_owner');
  assert.deepEqual(f.names(), ['humanize', 'preSendCheck', 'finishPending']);
});
