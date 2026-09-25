'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isShortAcknowledgement,
  isSilentAiReply,
  isEscalationMessage,
  isWaitingFollowUpAfterEscalation,
  shouldStaySilentFromHistory,
  findMostRecentOwnerMessage,
  isNonTextPlaceholderOnly,
  ownerMuteCutoffMs,
  ownerMuteDecision,
  preSendDecision,
  isConversationStale,
} = require('./ownerSilence');

test('preSendDecision — final check before sending a generated reply', async (t) => {
  const base = { pendingExists: true, pendingToken: 'T1', batchToken: 'T1', muteAction: 'proceed' };
  await t.test('nothing changed -> send', () => {
    assert.equal(preSendDecision(base), 'send');
  });
  await t.test('guest wrote again while the reply was generated (token rotated) -> do not send, newer run answers', () => {
    assert.equal(preSendDecision({ ...base, pendingToken: 'T2' }), 'newer_message');
  });
  await t.test('owner echo cleared the pending batch -> owner handled it', () => {
    assert.equal(preSendDecision({ ...base, pendingExists: false, pendingToken: undefined }), 'owner_replied');
  });
  await t.test('owner replied since the batch started -> owner handled it', () => {
    assert.equal(preSendDecision({ ...base, muteAction: 'drop' }), 'owner_replied');
  });
  await t.test('newer guest message wins over a mute drop (the newer run re-checks the owner anyway)', () => {
    assert.equal(preSendDecision({ ...base, pendingToken: 'T2', muteAction: 'drop' }), 'newer_message');
  });
});

test('isShortAcknowledgement', async (t) => {
  await t.test('common short acks', () => {
    assert.equal(isShortAcknowledgement('okay'), true);
    assert.equal(isShortAcknowledgement('Ok'), true);
    assert.equal(isShortAcknowledgement('thanks!'), true);
    assert.equal(isShortAcknowledgement('thank you'), true);
    assert.equal(isShortAcknowledgement('got it'), true);
    assert.equal(isShortAcknowledgement('👍'), true);
  });
  await t.test('expanded category 1/2/5/6 words', () => {
    assert.equal(isShortAcknowledgement('makes sense'), true);
    assert.equal(isShortAcknowledgement('sounds good'), true);
    assert.equal(isShortAcknowledgement('no worries'), true);
    assert.equal(isShortAcknowledgement('many thanks'), true);
    assert.equal(isShortAcknowledgement('thanks so much'), true);
    assert.equal(isShortAcknowledgement('merci'), true);
    assert.equal(isShortAcknowledgement('exactly'), true);
    assert.equal(isShortAcknowledgement("that's right"), true);
    assert.equal(isShortAcknowledgement('duly noted'), true);
    assert.equal(isShortAcknowledgement('message received'), true);
    assert.equal(isShortAcknowledgement('ok thanks'), true, 'two known phrases joined by whitespace');
  });
  await t.test('non-English acknowledgments', () => {
    assert.equal(isShortAcknowledgement('хорошо'), true, 'Russian "okay"');
    assert.equal(isShortAcknowledgement('спасибо'), true, 'Russian "thanks"');
    assert.equal(isShortAcknowledgement('تمام'), true, 'Arabic "okay"');
    assert.equal(isShortAcknowledgement('شكراً'), true, 'Arabic "thanks"');
    assert.equal(isShortAcknowledgement('باشه'), true, 'Persian "okay"');
    assert.equal(isShortAcknowledgement('ممنون'), true, 'Persian "thanks"');
    assert.equal(isShortAcknowledgement('კარგი'), true, 'Georgian "good/okay"');
    assert.equal(isShortAcknowledgement('გმადლობ'), true, 'Georgian "thank you"');
  });
  await t.test('real questions are not acks', () => {
    assert.equal(isShortAcknowledgement('Can I move to a city view apartment?'), false);
    assert.equal(isShortAcknowledgement('okay but what about tomorrow?'), false);
    assert.equal(isShortAcknowledgement('What time is checkout?'), false);
  });
  await t.test('any question mark disqualifies, even a short one', () => {
    assert.equal(isShortAcknowledgement('ok?'), false);
    assert.equal(isShortAcknowledgement('???'), false, 'punctuation-only but a question — see Category 4 instead');
  });
  await t.test('empty / overly long text', () => {
    assert.equal(isShortAcknowledgement(''), false);
    assert.equal(isShortAcknowledgement('a'.repeat(70)), false);
  });
  await t.test('non-English script text is never an ack unless it matches a known short phrase', () => {
    assert.equal(isShortAcknowledgement('مساعدة'), false, 'Arabic "help" must not be silenced');
    assert.equal(isShortAcknowledgement('помогите'), false, 'Russian "help" must not be silenced');
    assert.equal(isShortAcknowledgement('დახმარება'), false, 'Georgian "help" must not be silenced');
    assert.equal(isShortAcknowledgement('עזרה'), false, 'Hebrew "help" must not be silenced');
  });
  await t.test('non-English script over 15 chars is never an ack, even if it starts with one', () => {
    assert.equal(isShortAcknowledgement('спасибо но у меня есть вопрос про парковку'), false);
  });
  await t.test('pure punctuation/emoji with nothing left and no question mark is still an ack', () => {
    assert.equal(isShortAcknowledgement('...'), true);
    assert.equal(isShortAcknowledgement('👍👍'), true);
  });
});

test('isSilentAiReply', async (t) => {
  await t.test('detects the tag anywhere in the reply', () => {
    assert.equal(isSilentAiReply('[SILENT]'), true);
    assert.equal(isSilentAiReply('Sure thing. [SILENT]'), true);
    assert.equal(isSilentAiReply('[silent]'), true);
  });
  await t.test('does not false-positive on normal replies', () => {
    assert.equal(isSilentAiReply(''), false);
    assert.equal(isSilentAiReply('Enjoy the views from Narikala'), false);
  });
});

test('isEscalationMessage', async (t) => {
  await t.test('recognizes escalation phrasing', () => {
    assert.equal(isEscalationMessage('Let me check on that and get back to you shortly.'), true);
    assert.equal(isEscalationMessage('I am alerting the team now.'), true);
    assert.equal(isEscalationMessage('We will check this right away, sorry for the inconvenience.'), true);
  });
  await t.test('does not flag a normal informative answer', () => {
    assert.equal(isEscalationMessage('The nearest paid parking is under Carrefour.'), false);
    assert.equal(isEscalationMessage('Unfortunately a move is not possible today.'), false);
  });
});

test('isWaitingFollowUpAfterEscalation — Category 4', async (t) => {
  await t.test('nudge after an escalation stays silent', () => {
    assert.equal(isWaitingFollowUpAfterEscalation('any update?', 'Let me check on that and get back to you shortly.'), true);
    assert.equal(isWaitingFollowUpAfterEscalation('still waiting', 'I am alerting the team now.'), true);
    assert.equal(isWaitingFollowUpAfterEscalation('???', 'Let me check on that and get back to you shortly.'), true);
    assert.equal(isWaitingFollowUpAfterEscalation('hello?', 'We will check this right away, sorry for the inconvenience.'), true);
    assert.equal(isWaitingFollowUpAfterEscalation("it's been 2 hours", 'Let me check on that and get back to you shortly.'), true);
  });
  await t.test('same nudge with no escalation context is NOT silenced', () => {
    assert.equal(isWaitingFollowUpAfterEscalation('any update?', 'The nearest paid parking is under Carrefour.'), false);
    assert.equal(isWaitingFollowUpAfterEscalation('hello?', 'Good to hear from you again. How can I help?'), false);
  });
  await t.test('not a waiting-nudge pattern at all', () => {
    assert.equal(isWaitingFollowUpAfterEscalation('Can I also get the wifi password?', 'Let me check on that and get back to you shortly.'), false);
  });
});

test('shouldStaySilentFromHistory — the Away-mode incident replay', () => {
  const incidentHistory = [
    { role: 'user', content: 'okay' },
    { role: 'owner', content: 'Unfortunately a move is not possible today.' },
    { role: 'assistant', content: 'Let me check on that and get back to you shortly.' },
    { role: 'user', content: 'Can I move to an apartment with a city view?' },
  ];
  assert.equal(
    shouldStaySilentFromHistory(incidentHistory, 'okay'),
    true,
    'bot must stay silent after owner resolved + guest said okay'
  );
});

test('shouldStaySilentFromHistory — a real new question after the owner must still reach Claude', () => {
  const newQuestionAfterOwner = [
    { role: 'user', content: 'What time is checkout?' },
    { role: 'owner', content: 'Unfortunately a move is not possible today.' },
  ];
  assert.equal(
    shouldStaySilentFromHistory(newQuestionAfterOwner, 'What time is checkout?'),
    false,
    'new questions after the owner must still reach Claude'
  );
});

test('shouldStaySilentFromHistory — short thanks after a bot answer stays silent', () => {
  const thanksAfterBot = [
    { role: 'user', content: 'thanks' },
    { role: 'assistant', content: 'The nearest paid parking is under Carrefour.' },
  ];
  assert.equal(shouldStaySilentFromHistory(thanksAfterBot, 'thanks'), true);
});

test('shouldStaySilentFromHistory — Category 4 nudge after an escalation stays silent', () => {
  const nudgeAfterEscalation = [
    { role: 'user', content: 'any update?' },
    { role: 'assistant', content: 'I am contacting our team right now and will update you shortly.' },
  ];
  assert.equal(shouldStaySilentFromHistory(nudgeAfterEscalation, 'any update?'), true);
});

test('shouldStaySilentFromHistory — same nudge after a non-escalation answer reaches Claude', () => {
  const nudgeAfterAnswer = [
    { role: 'user', content: 'any update?' },
    { role: 'assistant', content: 'The nearest paid parking is under Carrefour.' },
  ];
  assert.equal(shouldStaySilentFromHistory(nudgeAfterAnswer, 'any update?'), false);
});

test('shouldStaySilentFromHistory — no prior messages at all', () => {
  assert.equal(shouldStaySilentFromHistory([], 'okay'), false);
});

test('findMostRecentOwnerMessage', async (t) => {
  await t.test('finds the owner message even with turns in between', () => {
    const history = [
      { role: 'user', content: 'and one more thing' },
      { role: 'assistant', content: 'Sure, anything else?' },
      { role: 'owner', content: 'Not possible today.' },
      { role: 'user', content: 'Can I move rooms?' },
    ];
    assert.deepEqual(findMostRecentOwnerMessage(history), { role: 'owner', content: 'Not possible today.' });
  });
  await t.test('returns null when there is no owner message', () => {
    assert.equal(findMostRecentOwnerMessage([{ role: 'user', content: 'hi' }]), null);
    assert.equal(findMostRecentOwnerMessage([]), null);
  });
});

test('isNonTextPlaceholderOnly — the Roman Lartsev incident replay (Sep 22)', async (t) => {
  await t.test('each classifyIncomingContent placeholder type qualifies on its own', () => {
    assert.equal(isNonTextPlaceholderOnly('[image]'), true);
    assert.equal(isNonTextPlaceholderOnly('[video]'), true);
    assert.equal(isNonTextPlaceholderOnly('[audio]'), true);
    assert.equal(isNonTextPlaceholderOnly('[unsupported]'), true, 'the exact placeholder from the incident');
  });
  await t.test('a batch of multiple placeholders (multi-image send) still qualifies', () => {
    assert.equal(isNonTextPlaceholderOnly('[image]\n[image]\n[video]'), true);
  });
  await t.test('a placeholder mixed with real guest text does NOT qualify — real question still reaches Claude', () => {
    assert.equal(isNonTextPlaceholderOnly('[image]\nWhere is the entrance?'), false);
    assert.equal(isNonTextPlaceholderOnly('Here is a photo of the issue\n[image]'), false);
  });
  await t.test('real text alone does not qualify', () => {
    assert.equal(isNonTextPlaceholderOnly('I have booked an apartment with you for today'), false);
    assert.equal(isNonTextPlaceholderOnly('okay'), false, 'handled separately by isShortAcknowledgement');
  });
  await t.test('empty / whitespace-only text does not qualify', () => {
    assert.equal(isNonTextPlaceholderOnly(''), false);
    assert.equal(isNonTextPlaceholderOnly('   '), false);
  });
});

test('ownerMuteCutoffMs — flat 5-minute mute plus batch-start coverage', async (t) => {
  const now = 10 * 60 * 1000;
  await t.test('no batch start: cutoff is exactly now minus the mute window', () => {
    assert.equal(ownerMuteCutoffMs(now, undefined, 5), now - 5 * 60 * 1000);
  });
  await t.test('recent batch start: the 5-minute window is the earlier (wider) bound', () => {
    assert.equal(ownerMuteCutoffMs(now, now - 1000, 5), now - 5 * 60 * 1000);
  });
  await t.test('old batch start: an owner reply since the batch began still counts', () => {
    assert.equal(ownerMuteCutoffMs(now, now - 8 * 60 * 1000, 5), now - 8 * 60 * 1000);
  });
});

test('isConversationStale — 1 hour threshold', async (t) => {
  const now = 5 * 60 * 60 * 1000;
  await t.test('just over an hour is stale', () => {
    assert.equal(isConversationStale(now - 61 * 60 * 1000, now, 60), true);
  });
  await t.test('under an hour is not stale', () => {
    assert.equal(isConversationStale(now - 59 * 60 * 1000, now, 60), false);
  });
  await t.test('no previous message (first contact) is not stale', () => {
    assert.equal(isConversationStale(undefined, now, 60), false);
    assert.equal(isConversationStale(NaN, now, 60), false);
  });
});

test('ownerMuteDecision — guest message during the mute is answered late, not dropped', async (t) => {
  const MIN = 60 * 1000;
  const ownerAt = 100 * MIN;
  const guestAt = ownerAt + 2 * MIN; // guest writes 2 min into the 5-min mute
  const base = { batchStartMs: guestAt, latestOwnerMs: ownerAt, muteMinutes: 5 };

  await t.test('during the mute the batch is deferred to the mute end, not dropped', () => {
    const d = ownerMuteDecision({ ...base, nowMs: guestAt + 20 * 1000 });
    assert.deepEqual(d, { action: 'defer', deferUntilMs: ownerAt + 5 * MIN });
  });
  await t.test('mute expires with no further owner reply -> bot answers the queued message', () => {
    const d = ownerMuteDecision({ ...base, nowMs: ownerAt + 5 * MIN + 2000 });
    assert.deepEqual(d, { action: 'proceed' });
  });
  await t.test('owner replies again before expiry -> newest owner message is after the batch start -> drop', () => {
    const d = ownerMuteDecision({ ...base, latestOwnerMs: guestAt + MIN, nowMs: ownerAt + 5 * MIN + 2000 });
    assert.deepEqual(d, { action: 'drop' });
  });
  await t.test('no owner message at all -> proceed', () => {
    assert.deepEqual(ownerMuteDecision({ ...base, latestOwnerMs: NaN, nowMs: guestAt }), { action: 'proceed' });
  });
  await t.test('owner replied long before the batch and its mute already expired -> proceed', () => {
    const d = ownerMuteDecision({ nowMs: 200 * MIN, batchStartMs: 199 * MIN, latestOwnerMs: 100 * MIN, muteMinutes: 5 });
    assert.deepEqual(d, { action: 'proceed' });
  });
});
