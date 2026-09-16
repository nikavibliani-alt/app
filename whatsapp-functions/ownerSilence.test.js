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
} = require('./ownerSilence');

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
