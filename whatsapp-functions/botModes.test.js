'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { numberSetting, tbilisiHour, isNightHour, nightWindow, resolveEffectiveMode, timingSettings, replyDelaySeconds, buildModeContext, CONFIG_DEFAULTS } = require('./botModes');

// Tbilisi is UTC+4: 14:00 Tbilisi = 10:00 UTC, 02:00 Tbilisi = 22:00 UTC the day before.
const atTbilisi = (hour) => Date.UTC(2026, 9, 17, hour - 4, 30);

test('numberSetting: 0 is a real value (the old `|| default` turned it into the default)', () => {
  assert.equal(numberSetting(0, 5, { min: 0 }), 0);
  assert.equal(numberSetting('0', 5, { min: 0 }), 0);
  assert.equal(numberSetting(undefined, 5), 5);
  assert.equal(numberSetting('', 5), 5);
  assert.equal(numberSetting('abc', 5), 5);
  assert.equal(numberSetting(true, 5), 5);
  assert.equal(numberSetting(5, 60, { min: 10 }), 10, 'clamped to the minimum');
  assert.equal(numberSetting(9999, 20, { max: 600 }), 600);
});

test('timingSettings: owner mute 0 = off, delay 0 = immediate, grace has a 10 s floor', () => {
  const t = timingSettings({ ownerMuteMinutes: 0, botResponseDelay: 0, staleGraceSeconds: 0 });
  assert.equal(t.ownerMuteMinutes, 0);
  assert.equal(t.replyDelaySeconds, 0);
  assert.equal(t.staleGraceSeconds, 10);
  assert.deepEqual(timingSettings({}), { replyDelaySeconds: 20, ownerMuteMinutes: 5, ownerSilenceWindowMinutes: 30, staleConversationMinutes: 60, staleGraceSeconds: 60 });
});

test('tbilisiHour', () => {
  assert.equal(tbilisiHour(atTbilisi(14)), 14);
  assert.equal(tbilisiHour(atTbilisi(2)), 2);
});

test('isNightHour / nightWindow', () => {
  assert.equal(isNightHour(23, 22, 9), true);
  assert.equal(isNightHour(8, 22, 9), true);
  assert.equal(isNightHour(9, 22, 9), false);
  assert.equal(isNightHour(14, 22, 9), false);
  assert.equal(isNightHour(2, 1, 11), true);
  assert.equal(isNightHour(11, 1, 11), false);
  assert.equal(isNightHour(5, 7, 7), false, 'equal hours: never night');
  assert.deepEqual(nightWindow({ nightStart: '23', nightEnd: '7' }), { start: 23, end: 7 }, 'strings accepted');
  assert.deepEqual(nightWindow({ nightStart: 'x', nightEnd: 30 }), { start: 22, end: 9 }, 'invalid -> defaults, not "never night"');
});

test('resolveEffectiveMode: every mode, Automatic by day and by night', () => {
  const night = { nightStart: 22, nightEnd: 9 };
  assert.equal(resolveEffectiveMode({ botMode: 'available', ...night }, atTbilisi(2)), 'available', 'Available ignores the clock');
  assert.equal(resolveEffectiveMode({ botMode: 'away' }, atTbilisi(14)), 'away');
  assert.equal(resolveEffectiveMode({ botMode: 'night' }, atTbilisi(14)), 'night', 'Night is night even by day');
  assert.equal(resolveEffectiveMode({ botMode: 'auto', ...night }, atTbilisi(14)), 'available');
  assert.equal(resolveEffectiveMode({ botMode: 'auto', ...night }, atTbilisi(2)), 'night');
  assert.equal(resolveEffectiveMode({ botMode: 'auto', ...night }, atTbilisi(22)), 'night');
  assert.equal(resolveEffectiveMode({ botMode: 'auto', ...night }, atTbilisi(9)), 'available');
  assert.equal(resolveEffectiveMode({ botMode: 'auto', nightStart: 'bad', nightEnd: null }, atTbilisi(2)), 'night', 'bad hours -> default window');
  assert.equal(resolveEffectiveMode({ botMode: 'weird' }, atTbilisi(2)), 'available');
  assert.equal(resolveEffectiveMode({}, atTbilisi(2)), 'available');
});

test('replyDelaySeconds: owner-first wait in Available, at most 3 s in Away/Night', () => {
  const cfg = { botResponseDelay: 60, staleGraceSeconds: 90 };
  assert.equal(replyDelaySeconds(cfg, 'available'), 60);
  assert.equal(replyDelaySeconds(cfg, 'available', { staleConversation: true }), 90, 'quiet chat: the grace when longer');
  assert.equal(replyDelaySeconds({ botResponseDelay: 120, staleGraceSeconds: 60 }, 'available', { staleConversation: true }), 120);
  assert.equal(replyDelaySeconds(cfg, 'away'), 3);
  assert.equal(replyDelaySeconds(cfg, 'night', { staleConversation: true }), 3, 'no grace in Night');
  assert.equal(replyDelaySeconds({ botResponseDelay: 0 }, 'available'), 0);
  assert.equal(replyDelaySeconds({}, 'available'), CONFIG_DEFAULTS.botResponseDelay);
});

test('buildModeContext', () => {
  assert.match(buildModeContext('available'), /^AVAILABLE MODE: .*never be told they are talking to a bot\.$/);
  const away = buildModeContext('away');
  assert.match(away, /^AWAY MODE: .*replaced by this one, so the reply has exactly one follow-up sentence: I have noted this and someone from our team will follow up as soon as possible\. Example: .*Never write both sentences\./);
  const n = buildModeContext('night', '+995 555 12-34-56');
  assert.match(n, /^NIGHT MODE: The owner is off for the night\. Only for an urgent problem/);
  assert.match(n, /call the night contact number: \+995555123456\n/);
  assert.match(n, /never give the night contact number for it/, 'not for towels at 2am');
  assert.doesNotMatch(buildModeContext('night', ''), /\+\d/);
});
