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
    assert.equal(f.calls.find((c) => c[0] === 'notifyOwner')[1], 'Guest needs help (mode available): I am locked out, the code does not work', 'issue only; the caller adds the guest name / room');
    assert.ok(f.names().includes('finishPending'));
  });
  await t.test('urgent escalation with no text: paged once, nothing sent', async () => {
    const f = fakeDeps();
    const r = await deliverReply(parseAiReply('[ESCALATE] [URGENT:LOCKOUT]'), WHO, f.deps);
    assert.equal(r.outcome, 'escalated_only');
    assert.deepEqual(f.calls.filter((c) => c[0] === 'notifyOwner').map((c) => c[1]), ['URGENT, guest is locked out']);
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
    assert.match(text, /^Reply to the guest failed to send: Meta error 131047: Re-engagement message \(it was an escalation: I am locked out/);
  });
  await t.test('video rejected, text stands on its own: text sent, stored without the video marker, owner alerted', async () => {
    const f = fakeDeps({ sendVideo: { ok: false, code: 131053, reason: 'Meta error 131053: Media upload error' } });
    const r = await deliverReply(parseAiReply('[VIDEO:975338858914982]\nPaid parking under Carrefour.'), WHO, f.deps);
    assert.equal(r.outcome, 'sent');
    assert.deepEqual(f.calls.find((c) => c[0] === 'storeAssistant'), ['storeAssistant', 'Paid parking under Carrefour.']);
    const [, key, text] = f.calls.find((c) => c[0] === 'notifyOwnerThrottled');
    assert.equal(key, 'video_131053');
    assert.equal(text, 'The parking video could not be sent (Meta error 131053: Media upload error). The guest got the text-only version.');
    assert.equal(f.calls.find((c) => c[0] === 'writeAlert')[1].errorType, 'video_send_failed');
  });
  await t.test('video sent: the marker is stored so it is not resent later', async () => {
    const f = fakeDeps();
    await deliverReply(parseAiReply('[VIDEO:975338858914982]\nPaid parking under Carrefour.'), WHO, f.deps);
    assert.deepEqual(f.calls.find((c) => c[0] === 'storeAssistant'), ['storeAssistant', 'Paid parking under Carrefour.\n[VIDEO_SENT:975338858914982]']);
  });
  await t.test('video-only reply whose video fails: the text-only version is sent instead', async () => {
    const f = fakeDeps({ sendVideo: { ok: false, code: 'network', reason: 'could not reach Meta' } });
    const r = await deliverReply(parseAiReply('[VIDEO:975338858914982]'), WHO, f.deps);
    assert.equal(r.outcome, 'sent');
    assert.match(f.calls.find((c) => c[0] === 'sendText')[1], /^We do not have private parking/);
  });
  await t.test('unknown video id and a text that points at it: nothing sent, pending kept', async () => {
    const f = fakeDeps({ sendVideo: { ok: false, code: 'unknown_video', reason: 'no video with id 42' } });
    const r = await deliverReply(parseAiReply('[VIDEO:42]\nHere it is.'), WHO, f.deps);
    assert.equal(r.outcome, 'send_failed');
    assert.ok(!f.names().includes('sendText'));
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
    assert.equal(f.calls[2][1], 'URGENT, angry or complaining guest: I am locked out, the code does not work');
    assert.ok(!f.names().includes('sendText'));
  });
});

test('owner replied during generation: nothing sent, no alerts', async () => {
  const f = fakeDeps({ decision: 'owner_replied' });
  const r = await deliverReply(parseAiReply('Sure thing. [ESCALATE] [URGENT:ISSUE]'), WHO, f.deps);
  assert.equal(r.outcome, 'stopped_owner');
  assert.deepEqual(f.names(), ['humanize', 'preSendCheck', 'finishPending']);
});

test('video tag is recognized anywhere in the reply and never sent as text', async (t) => {
  const ID = '1819258012553462';
  await t.test('at the end (the live test on 2 Oct)', () => {
    const p = parseAiReply(`Please click the button and scroll in your direction to adjust it.\n\n[VIDEO:${ID}]`);
    assert.equal(p.videoId, ID);
    assert.equal(p.text, 'Please click the button and scroll in your direction to adjust it.');
  });
  await t.test('at the start, on its own line', () => {
    const p = parseAiReply(`[VIDEO:${ID}]\nFor hot water, press the button on the right handle.`);
    assert.equal(p.videoId, ID);
    assert.equal(p.text, 'For hot water, press the button on the right handle.');
  });
  await t.test('in the middle, inline', () => {
    const p = parseAiReply(`Here is how it works [VIDEO:${ID}] the right handle controls the pressure.`);
    assert.equal(p.videoId, ID);
    assert.equal(p.text, 'Here is how it works the right handle controls the pressure.');
  });
  await t.test('two tags: the first is sent, both removed', () => {
    const p = parseAiReply(`[VIDEO:111]\nText. [VIDEO:222]`);
    assert.equal(p.videoId, '111');
    assert.equal(p.text, 'Text.');
  });
  await t.test('with escalation tags around it', () => {
    const p = parseAiReply(`Sorry, checking now. [VIDEO:${ID}] [ESCALATE]`);
    assert.equal(p.videoId, ID);
    assert.equal(p.escalate, true);
    assert.equal(p.text, 'Sorry, checking now.');
  });
  await t.test('no tag: no video', () => {
    assert.equal(parseAiReply('Just text.').videoId, null);
  });
  await t.test('delivery sends the video first, then the text without the tag, and stores the marker', async () => {
    const f = fakeDeps();
    const r = await deliverReply(parseAiReply(`Please adjust it.\n\n[VIDEO:${ID}]`), WHO, f.deps);
    assert.equal(r.outcome, 'sent');
    assert.deepEqual(f.calls.filter((c) => c[0] === 'sendVideo' || c[0] === 'sendText'), [['sendVideo', ID], ['sendText', 'Please adjust it.']]);
    assert.deepEqual(f.calls.find((c) => c[0] === 'storeAssistant'), ['storeAssistant', `Please adjust it.\n[VIDEO_SENT:${ID}]`]);
  });
});

test('push notification only for urgent alerts and bot errors, next to the WhatsApp alert', async (t) => {
  const pushOf = (f, name) => f.calls.filter((c) => c[0] === name).map((c) => c[c.length - 1]?.push).filter(Boolean);
  await t.test('locked out ([URGENT:LOCKOUT]): push "lockout"', async () => {
    const f = fakeDeps();
    await deliverReply(parseAiReply('I am contacting our team right now and will update you shortly. [ESCALATE] [URGENT:LOCKOUT]'), WHO, f.deps);
    assert.deepEqual(pushOf(f, 'notifyOwner'), ['lockout']);
    assert.equal(f.calls.filter((c) => c[0] === 'notifyOwner').length, 1, 'one WhatsApp alert, no second escalation alert');
  });
  await t.test('flooding / security ([URGENT:ISSUE]): push "issue"', async () => {
    const f = fakeDeps();
    await deliverReply(parseAiReply('We are looking into this right now and will update you shortly. [ESCALATE] [URGENT:ISSUE]'), WHO, f.deps);
    assert.deepEqual(pushOf(f, 'notifyOwner'), ['issue']);
  });
  await t.test('angry guest ([URGENT:ANGRY]): push "angry"', async () => {
    const f = fakeDeps();
    await deliverReply(parseAiReply('[URGENT:ANGRY]'), WHO, f.deps);
    assert.deepEqual(pushOf(f, 'notifyOwner'), ['angry']);
  });
  await t.test('normal escalation: WhatsApp only, no push', async () => {
    const f = fakeDeps();
    await deliverReply(parseAiReply('Let me check on that and get back to you shortly. [ESCALATE]'), WHO, f.deps);
    assert.equal(f.calls.filter((c) => c[0] === 'notifyOwner').length, 1);
    assert.deepEqual(pushOf(f, 'notifyOwner'), []);
  });
  await t.test('tag-only escalation: no push', async () => {
    const f = fakeDeps();
    await deliverReply(parseAiReply('[ESCALATE]'), WHO, f.deps);
    assert.deepEqual(pushOf(f, 'notifyOwner'), []);
  });
  await t.test('normal reply: no alert, no push', async () => {
    const f = fakeDeps();
    await deliverReply(parseAiReply('Check-in starts at 3pm.'), WHO, f.deps);
    assert.deepEqual([...pushOf(f, 'notifyOwner'), ...pushOf(f, 'notifyOwnerThrottled')], []);
  });
  await t.test('bot error, empty reply: push "bot_error"', async () => {
    const f = fakeDeps();
    await deliverReply(parseAiReply('[VIDEO_SENT:123]'), WHO, f.deps);
    const opts = f.calls.find((c) => c[0] === 'notifyOwnerThrottled')[3];
    assert.deepEqual(opts, { push: 'bot_error', reason: 'its reply was empty' });
  });
  await t.test('bot error, Meta refused the text: push "bot_error" with the reason', async () => {
    const f = fakeDeps({ sendText: { ok: false, code: 131047, reason: 'Meta error 131047: Re-engagement message' } });
    await deliverReply(parseAiReply('Here is the info.'), WHO, f.deps);
    const opts = f.calls.find((c) => c[0] === 'notifyOwnerThrottled')[3];
    assert.equal(opts.push, 'bot_error');
    assert.match(opts.reason, /reply failed to send: Meta error 131047/);
  });
  await t.test('bot error, Meta refused the video: push "bot_error"', async () => {
    const f = fakeDeps({ sendVideo: { ok: false, code: 131053, reason: 'Meta error 131053: Media upload error' } });
    await deliverReply(parseAiReply('[VIDEO:975338858914982]\nPaid parking under Carrefour.'), WHO, f.deps);
    assert.equal(f.calls.find((c) => c[0] === 'notifyOwnerThrottled')[3].push, 'bot_error');
  });
});

test('16 Oct bag storage chat: a failed video never leaves a text that points at it', async (t) => {
  const BAG = '1804812277340997';
  const failed = { ok: false, code: 100, reason: 'Meta error 100: Param video.id is not a valid whatsapp business account media attachment ID' };
  for (const reply of [
    `[VIDEO:${BAG}]\nGood morning. Yes, you can leave your bags in our hallway storage area before check-in. You can leave your bags in the hallway storage area shown in the video, through the door it shows, under camera surveillance.`,
    `[VIDEO:${BAG}]\nSorry about that, let me send it over. You can leave your bags in the hallway storage area shown in the video, under camera surveillance.`,
    `[VIDEO:${BAG}]\nHere it is, sorry about that.`,
  ]) {
    await t.test(reply.split('\n')[1].slice(0, 40), async () => {
      const f = fakeDeps({ sendVideo: failed });
      const r = await deliverReply(parseAiReply(reply), WHO, f.deps);
      assert.equal(r.outcome, 'sent');
      const sent = f.calls.find((c) => c[0] === 'sendText')[1];
      assert.doesNotMatch(sent, /video|photo|here it is|let me send/i);
      assert.match(sent, /glass door/);
      assert.match(sent, /13 24 13#/);
      assert.equal(f.calls.find((c) => c[0] === 'storeAssistant')[1], sent, 'stored = what the guest got, no [VIDEO_SENT]');
    });
  }
  await t.test('video sent: the text and the marker go out as before', async () => {
    const f = fakeDeps();
    await deliverReply(parseAiReply(`[VIDEO:${BAG}]\nHere it is, sorry about that.`), WHO, f.deps);
    assert.deepEqual(f.calls.filter((c) => c[0] === 'sendVideo' || c[0] === 'sendText'), [['sendVideo', BAG], ['sendText', 'Here it is, sorry about that.']]);
    assert.equal(f.calls.find((c) => c[0] === 'storeAssistant')[1], `Here it is, sorry about that.\n[VIDEO_SENT:${BAG}]`);
  });
});

test('bag storage photos', async (t) => {
  const BAG = '1804812277340997';
  const reply = `[VIDEO:${BAG}]\nYou can leave your bags before check-in. Go to the entrance in the first photo, then the glass door in the second photo. The smart lock code is 13 24 13#. Please leave your bags under the camera, and keep passports, laptops and other valuables with you.`;
  await t.test('photos sent: photos first, then the text, marker stored', async () => {
    const f = fakeDeps();
    const r = await deliverReply(parseAiReply(reply), WHO, f.deps);
    assert.equal(r.outcome, 'sent');
    assert.deepEqual(f.names().slice(2, 4), ['sendVideo', 'sendText'], 'media before text');
    assert.match(f.calls.find((c) => c[0] === 'storeAssistant')[1], /first photo[\s\S]*\[VIDEO_SENT:1804812277340997\]$/);
  });
  await t.test('a photo fails: text-only version (no "photo"), owner alerted', async () => {
    const f = fakeDeps({ sendVideo: { ok: false, code: 'media_link', reason: 'image link answered HTTP 404' } });
    const r = await deliverReply(parseAiReply(reply), WHO, f.deps);
    assert.equal(r.outcome, 'sent');
    const sent = f.calls.find((c) => c[0] === 'sendText')[1];
    assert.doesNotMatch(sent, /photo/i);
    assert.match(sent, /Clean House/);
    assert.match(sent, /13 24 13#/);
    assert.equal(f.calls.find((c) => c[0] === 'notifyOwnerThrottled')[2], 'The bag storage photos could not be sent (image link answered HTTP 404). The guest got the text-only version.');
  });
  await t.test('hot water video not set up yet: mixer text only, no alert', async () => {
    const f = fakeDeps({ sendVideo: { ok: false, code: 'not_configured', reason: 'no permanent file is set for the hot water video' } });
    const r = await deliverReply(parseAiReply('[VIDEO:1819258012553462]\nFor hot water, press the button on the right handle.'), WHO, f.deps);
    assert.equal(r.outcome, 'sent');
    assert.equal(f.calls.find((c) => c[0] === 'sendText')[1], 'For hot water, press the button on the right handle.');
    assert.ok(!f.names().includes('writeAlert') && !f.names().includes('notifyOwnerThrottled'), 'no alert for a known gap');
  });
});
