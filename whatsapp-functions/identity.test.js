'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { aptIdToBrand, matchesFreedomKeywords } = require('./identity');

test('aptIdToBrand', async (t) => {
  await t.test('Shartava prefixes', () => {
    assert.equal(aptIdToBrand('0-12'), 'shartava');
    assert.equal(aptIdToBrand('6-3'), 'shartava');
    assert.equal(aptIdToBrand('7-1'), 'shartava');
  });
  await t.test('Freedom Square prefix', () => {
    assert.equal(aptIdToBrand('tab-2'), 'freedom');
  });
  await t.test('Orbeliani prefix', () => {
    assert.equal(aptIdToBrand('orb-1'), 'orbeliani');
  });
  await t.test('unknown / missing prefix', () => {
    assert.equal(aptIdToBrand('xyz-1'), null);
    assert.equal(aptIdToBrand(''), null);
    assert.equal(aptIdToBrand(null), null);
    assert.equal(aptIdToBrand(undefined), null);
  });
});

test('matchesFreedomKeywords — positive matches', async (t) => {
  await t.test('Freedom Square', () => {
    assert.equal(matchesFreedomKeywords('is this near Freedom Square?'), true);
  });
  await t.test('Tabidze', () => {
    assert.equal(matchesFreedomKeywords('my apartment is on Tabidze street'), true);
  });
  await t.test('Galaktion Tabidze (full)', () => {
    assert.equal(matchesFreedomKeywords('address says Galaktion Tabidze 3/5'), true);
  });
  await t.test('Hi Nina greeting', () => {
    assert.equal(matchesFreedomKeywords('Hi Nina, is my room ready?'), true);
  });
  await t.test('Hello Nina greeting', () => {
    assert.equal(matchesFreedomKeywords('Hello Nina how are you'), true);
  });
  await t.test('Dear Nina greeting', () => {
    assert.equal(matchesFreedomKeywords('Dear Nina, we have arrived'), true);
  });
  await t.test('Message opens with "Nina,"', () => {
    assert.equal(matchesFreedomKeywords('Nina, can you help me check in'), true);
  });
  await t.test('Message opens with "Nina."', () => {
    assert.equal(matchesFreedomKeywords('Nina. I am outside the building'), true);
  });
  await t.test('matches within a joined multi-line batch', () => {
    assert.equal(matchesFreedomKeywords('hey there\nNina, are you around?'), true);
  });
});

test('matchesFreedomKeywords — must NOT match', async (t) => {
  await t.test('bare Galaktion', () => {
    assert.equal(matchesFreedomKeywords('my name is Galaktion'), false);
  });
  await t.test('city centre', () => {
    assert.equal(matchesFreedomKeywords('is it close to the city centre'), false);
  });
  await t.test('city center', () => {
    assert.equal(matchesFreedomKeywords('is it close to the city center'), false);
  });
  await t.test('bare mid-sentence Nina', () => {
    assert.equal(matchesFreedomKeywords('I spoke with Nina yesterday about the booking'), false);
  });
  await t.test('studios', () => {
    assert.equal(matchesFreedomKeywords('do you have studios available'), false);
  });
  await t.test('Nina as part of another word', () => {
    assert.equal(matchesFreedomKeywords('Ninagram is a great app'), false);
  });
  await t.test('empty / missing text', () => {
    assert.equal(matchesFreedomKeywords(''), false);
    assert.equal(matchesFreedomKeywords(null), false);
    assert.equal(matchesFreedomKeywords(undefined), false);
  });
});
