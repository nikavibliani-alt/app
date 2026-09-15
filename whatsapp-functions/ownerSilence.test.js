'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isShortAcknowledgement,
  isSilentAiReply,
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
  await t.test('real questions are not acks', () => {
    assert.equal(isShortAcknowledgement('Can I move to a city view apartment?'), false);
    assert.equal(isShortAcknowledgement('okay but what about tomorrow?'), false);
    assert.equal(isShortAcknowledgement('What time is checkout?'), false);
  });
  await t.test('empty / overly long text', () => {
    assert.equal(isShortAcknowledgement(''), false);
    assert.equal(isShortAcknowledgement('a'.repeat(60)), false);
  });
  await t.test('non-English script text is never an ack, even when ASCII-stripping leaves nothing', () => {
    assert.equal(isShortAcknowledgement('مساعدة'), false, 'Arabic "help" must not be silenced');
    assert.equal(isShortAcknowledgement('помогите'), false, 'Russian "help" must not be silenced');
    assert.equal(isShortAcknowledgement('დახმარება'), false, 'Georgian "help" must not be silenced');
    assert.equal(isShortAcknowledgement('עזרה'), false, 'Hebrew "help" must not be silenced');
  });
  await t.test('pure punctuation/emoji with nothing left is still an ack', () => {
    assert.equal(isShortAcknowledgement('???'), true);
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

test('shouldStaySilentFromHistory — the Away-mode incident replay', () => {
  // Newest-first: guest "okay", then owner "not possible", then the bot's earlier
  // escalation reply, then the original guest question.
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
