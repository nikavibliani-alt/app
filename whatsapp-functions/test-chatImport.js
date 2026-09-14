const assert = require('node:assert/strict');
const {
  parseWhatsAppExport,
  isGeorgianHeavy,
  filterOutGeorgianMessages,
  inferHostSender,
  buildKnowledgeContext,
} = require('./chatImport');

const sample = `12/09/2024, 14:30 - Maxela Apartments: Messages and calls are end-to-end encrypted. No one outside of this chat, not even WhatsApp, can read or listen to them.
12/09/2024, 14:31 - Guest Friend: Hi, where can I park?
12/09/2024, 14:32 - Maxela Apartments: The nearest paid parking is under Carrefour. Daily rate is 15 GEL, cash only.
12/09/2024, 14:40 - Guest Friend: გთხოვთ დამირეკოთ
12/09/2024, 14:41 - Maxela Apartments: მალე დაგირეკავთ
[13/09/2024, 09:05:12] Guest Friend: Is there a gym?
[13/09/2024, 09:06:01] Maxela Apartments: We do not have a gym on site.
`;

const messages = parseWhatsAppExport(sample);
assert.equal(messages.length, 6, `expected 6 messages, got ${messages.length}`);
assert.ok(isGeorgianHeavy('გთხოვთ დამირეკოთ'));
assert.ok(!isGeorgianHeavy('Where is parking?'));

const filtered = filterOutGeorgianMessages(messages);
assert.equal(filtered.length, 4, `expected 4 non-Georgian messages, got ${filtered.length}`);

const host = inferHostSender(filtered, ['Maxela']);
assert.equal(host, 'Maxela Apartments');

const ctx = buildKnowledgeContext([
  { topic: 'parking', guestQuestion: 'Where to park?', hostAnswer: 'Carrefour, 15 GEL.' },
]);
assert.ok(ctx.includes('LEARNED FROM PAST HOST CHATS'));
assert.ok(ctx.includes('Carrefour'));

console.log('chatImport smoke tests passed');
