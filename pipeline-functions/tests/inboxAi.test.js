'use strict';
const test = require('node:test');
const assert = require('node:assert');
const A = require('../lib/inboxAi');

test('pause: 24 hours, or until 12:00 Tbilisi on the check-out day', () => {
  const now = Date.UTC(2026, 10, 10, 8, 0, 0);
  assert.strictEqual(A.pauseUntilMs('24h', {}, now), now + 86400000);
  assert.strictEqual(A.pauseUntilMs('checkout', { checkout: '2026-11-19' }, now), Date.UTC(2026, 10, 19, 8, 0, 0));
  assert.strictEqual(A.pauseUntilMs('checkout', { checkout: '2026-11-01' }, now), null, 'already past');
  assert.strictEqual(A.pauseUntilMs('checkout', {}, now), null);
  assert.strictEqual(A.pauseUntilMs('forever', {}, now), null);
  assert.ok(A.isPaused({ aiPausedUntil: now + 1 }, now));
  assert.ok(!A.isPaused({ aiPausedUntil: now - 1 }, now));
  assert.ok(!A.isPaused({}, now));
});

test('scan: finds money, promises, codes, phone numbers and foreign links; ordinary answers pass', () => {
  const ok = [
    'Check-in starts at 15:00. Please fill in the check-in form here: https://app.maxelaapartments.com/checkin-guest',
    'Parking is behind the building, on a first come first served basis. See you on 9 November.',
    'The apartment has 2 beds and a kitchen on the 6th floor.',
  ];
  for (const t of ok) assert.deepStrictEqual(A.scanAiReply(t), [], t);
  assert.ok(A.scanAiReply('Parking costs 15 GEL a day.').includes('a money amount'));
  assert.ok(A.scanAiReply('It is $20 extra').includes('a money amount'));
  assert.ok(A.scanAiReply('We will refund you for the night.').some(f => /refund/.test(f)));
  assert.ok(A.scanAiReply('We can give you a discount.').some(f => /discount/.test(f)));
  assert.ok(A.scanAiReply('The door code is 4821.').some(f => /code/.test(f)));
  assert.ok(A.scanAiReply('The Wi-Fi password is maxela2026').some(f => /code/.test(f)));
  assert.ok(A.scanAiReply('Call us on +995 555 12 34 56').includes('a phone number'));
  assert.ok(A.scanAiReply('See https://example.com/x').includes('a link that is not ours'));
  assert.ok(A.scanAiReply('see www.evil.com').includes('a link that is not ours'));
});

test('extra knowledge: only approved and switched-on entries, in a bounded block', () => {
  assert.strictEqual(A.extraKnowledgeText([]), '');
  assert.strictEqual(A.extraKnowledgeText([{ status: 'pending', question: 'q', answer: 'a' }]), '');
  assert.strictEqual(A.extraKnowledgeText([{ status: 'approved', enabled: false, question: 'q', answer: 'a' }]), '');
  const t = A.extraKnowledgeText([{ status: 'approved', enabled: true, question: 'Is there a pool?', answer: 'No pool, but a gym nearby.' }, { status: 'rejected', question: 'x', answer: 'y' }]);
  assert.match(t, /Question: Is there a pool\?\nAnswer: No pool, but a gym nearby\./);
  assert.ok(!/x\nAnswer: y/.test(t));
  const many = Array.from({ length: 200 }, (_, i) => ({ status: 'approved', question: 'Q' + i, answer: 'A'.repeat(600) }));
  assert.ok(A.extraKnowledgeText(many).length <= 5000);
});

test('sign line: only when on, only on the first AI reply', () => {
  assert.strictEqual(A.withSignLine('Hi', { on: false, firstAiReply: true }), 'Hi');
  assert.strictEqual(A.withSignLine('Hi', { on: true, firstAiReply: false }), 'Hi');
  assert.match(A.withSignLine('Hi', { on: true, firstAiReply: true }), /Hi\n\nThis reply was written by our AI assistant\./);
});
