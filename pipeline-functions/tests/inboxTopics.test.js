'use strict';
const test = require('node:test');
const assert = require('node:assert');
const T = require('../lib/inboxTopics');

test('keywords: the English safety net', () => {
  const k = t => [...T.keywordTopics([t])].sort();
  assert.deepStrictEqual(k('Can I have an early check-in please?'), ['early_checkin']);
  assert.deepStrictEqual(k('I would like to cancel'), ['cancellation']);
  assert.deepStrictEqual(k('Can we extend our stay by one night?'), ['date_change']);
  assert.deepStrictEqual(k('I want my money back'), ['refund']);
  assert.deepStrictEqual(k('Is there a late checkout?'), ['late_checkout']);
  assert.ok(k('Do you take a credit card?').includes('payment_other'));
  assert.ok(k('How much is the deposit').includes('payment_other'));
  assert.ok(k('It costs 50 GEL?').includes('payment_other'));
  assert.deepStrictEqual(k('How do I pay for the reservation?'), [], 'plain "how do I pay" is left to the model');
  assert.deepStrictEqual(k('Is there parking?'), []);
});

test('the TOPICS line', () => {
  const p = T.parseTopicsLine('TOPICS: early_checkin, payment_how\nCheck-in starts at 15:00.');
  assert.deepStrictEqual([...p.topics], ['early_checkin', 'payment_how']);
  assert.strictEqual(p.rest, 'Check-in starts at 15:00.');
  assert.deepStrictEqual([...T.parseTopicsLine('topics: OTHER').topics], ['other']);
  assert.strictEqual(T.parseTopicsLine('Check-in starts at 15:00.').topics, null, 'no line: not trusted');
  assert.strictEqual(T.parseTopicsLine('TOPICS: banana').topics, null, 'unknown labels only: not trusted');
  assert.deepStrictEqual([...T.parseTopicsLine('TOPICS: banana, refund').topics], ['refund']);
  assert.strictEqual(T.parseTopicsLine('').topics, null);
});

test('decisions: hard topics first, then holding replies, then normal answers', () => {
  const d = (...t) => T.decideByTopics(new Set(t));
  assert.strictEqual(d('refund').action, 'needs_you');
  assert.strictEqual(d('discount').action, 'needs_you');
  assert.strictEqual(d('complaint').action, 'needs_you');
  assert.strictEqual(d('late_checkout').action, 'needs_you');
  assert.strictEqual(d('payment_other').action, 'needs_you');
  assert.strictEqual(d('payment_other', 'payment_how').action, 'needs_you', 'beyond how to pay: the host');
  assert.strictEqual(d('early_checkin', 'late_checkout').action, 'needs_you');
  assert.strictEqual(d('cancellation', 'refund').action, 'needs_you', 'a refund wins over a holding reply');
  assert.deepStrictEqual(d('cancellation'), { action: 'hold', label: 'cancellation' });
  assert.deepStrictEqual(d('date_change'), { action: 'hold', label: 'date change' });
  assert.deepStrictEqual(d('cancellation', 'date_change'), { action: 'hold', label: 'cancellation and date change' });
  assert.deepStrictEqual(d('early_checkin', 'cancellation'), { action: 'hold', label: 'cancellation' });
  assert.deepStrictEqual(d('early_checkin'), { action: 'reply' });
  assert.deepStrictEqual(d('payment_how'), { action: 'reply' });
  assert.deepStrictEqual(d('other'), { action: 'reply' });
});

test('answer checks: early check-in must say 15:00 and name no other time; payment must have no money details', () => {
  const ok = (text, ...t) => T.validateTopicReply(text, new Set(t)).ok;
  assert.ok(ok("Check-in starts at 15:00. If your apartment is ready earlier, we'll message you after you fill in the check-in form.", 'early_checkin'));
  assert.ok(ok('Заезд с 15:00. Если будет готово раньше, мы напишем.', 'early_checkin'));
  assert.ok(!ok('Yes, you can come at 11:00.', 'early_checkin'));
  assert.ok(!ok('Check-in starts at 15:00, but you can arrive at 10:30.', 'early_checkin'));
  assert.ok(!ok('Check-in is at 3pm.', 'early_checkin'), 'must say 15:00');
  assert.ok(!ok('Check-in starts at 15:00 and you may come at 11 am.', 'early_checkin'));
  assert.ok(ok('Payment for your reservation is handled by Booking.com.', 'payment_how'));
  assert.ok(ok('El pago de la reserva se gestiona a través de Booking.com.', 'payment_how'));
  assert.ok(!ok('Payment is handled by Booking.com, 50 GEL in total.', 'payment_how'));
  assert.ok(!ok('You can pay by card at the property.', 'payment_how'));
  assert.ok(!ok('Payment is handled by Booking.com. There is no deposit.', 'payment_how'));
  assert.ok(ok('Anything at all, 11:00 and 50 GEL', 'other'), 'other topics have no extra check here');
});
