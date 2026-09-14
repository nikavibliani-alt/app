const assert = require('node:assert/strict');
const {
  isShortAcknowledgement,
  isSilentAiReply,
  shouldStaySilentFromHistory,
} = require('./ownerSilence');

// --- short acknowledgements ---
assert.equal(isShortAcknowledgement('okay'), true);
assert.equal(isShortAcknowledgement('Ok'), true);
assert.equal(isShortAcknowledgement('thanks!'), true);
assert.equal(isShortAcknowledgement('👍'), true);
assert.equal(isShortAcknowledgement('Can I move to a city view apartment?'), false);
assert.equal(isShortAcknowledgement('okay but what about tomorrow?'), false);

// --- [SILENT] marker ---
assert.equal(isSilentAiReply('[SILENT]'), true);
assert.equal(isSilentAiReply(''), true);
assert.equal(isSilentAiReply('Enjoy the views from Narikala'), false);

// --- Away incident replay ---
// newest-first: guest "okay", then owner "not possible", then earlier turns...
const incidentHistory = [
  { role: 'user', content: 'okay' },
  { role: 'owner', content: 'Unfortunately a move is not possible today.' },
  { role: 'assistant', content: 'Let me check on that and get back to you shortly.' },
  { role: 'user', content: 'Can I move to an apartment with a city view?' },
];
assert.equal(
  shouldStaySilentFromHistory(incidentHistory, 'okay'),
  true,
  'bot must stay silent after owner resolved + guest okay'
);

// Owner answered earlier, guest asks a NEW real question → do not hard-silent
const newQuestionAfterOwner = [
  { role: 'user', content: 'What time is checkout?' },
  { role: 'owner', content: 'Unfortunately a move is not possible today.' },
];
assert.equal(
  shouldStaySilentFromHistory(newQuestionAfterOwner, 'What time is checkout?'),
  false,
  'new questions after owner must still reach Claude'
);

// Short thanks after bot answer → silent
const thanksAfterBot = [
  { role: 'user', content: 'thanks' },
  { role: 'assistant', content: 'The nearest paid parking is under Carrefour.' },
];
assert.equal(shouldStaySilentFromHistory(thanksAfterBot, 'thanks'), true);

console.log('ownerSilence tests passed');
