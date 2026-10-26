'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { languageHintLines } = require('./languageHint');

test('languageHintLines: a line only for Latin-letter messages without Georgian letters', () => {
  assert.equal(languageHintLines("We're in, thanks!").length, 1);
  assert.match(languageHintLines('ukve davsakhldit, madloba')[0], /unless it is clearly Georgian written in Latin letters/);
  for (const t of ['უკვე დავსახლდით მადლობა', 'გამარჯობა\nWiFi?', 'Мы заселились, спасибо', 'مرحبا', '[image]', '[location: 41.72, 44.77]', '👍', '', 'https://maps.app.goo.gl/x']) {
    assert.deepEqual(languageHintLines(t), [], JSON.stringify(t));
  }
  assert.equal(languageHintLines('[image] is this my door?').length, 1, 'the caption counts, the placeholder does not');
});
