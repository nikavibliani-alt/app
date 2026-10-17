'use strict';

// Bot modes and timing settings (globals/config), as pure functions.
// Modes: available (owner-first: waits so the owner can answer), away (fast,
// "the team will follow up"), night (fast, urgent -> night contact number),
// auto (night inside nightStart..nightEnd, Tbilisi time, else available).

const CONFIG_DEFAULTS = {
  aiBotEnabled: true,
  botMode: 'available',
  botResponseDelay: 20,
  ownerPhone: '',
  nightStart: 22,
  nightEnd: 9,
  ownerSilenceWindowMinutes: 30,
  // Flat mute after any manual owner message: the bot stays silent for this long (0 = off).
  ownerMuteMinutes: 5,
  // If the conversation's last message (either side) is older than this, a new
  // guest message waits staleGraceSeconds (floor 10) before the bot replies, so
  // the owner can answer first (Available mode only).
  staleConversationMinutes: 60,
  staleGraceSeconds: 60,
};

const MODES = ['available', 'away', 'night', 'auto'];

/**
 * A numeric setting: the stored value if it is a real number within
 * [min, max] (0 counts), else the default. Fixes `Number(x) || default`,
 * which turned a deliberate 0 into the default.
 */
function numberSetting(value, fallback, { min = -Infinity, max = Infinity } = {}) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Current hour (0-23) in Tbilisi. Georgia is UTC+4 year-round, no DST. */
function tbilisiHour(nowMs = Date.now()) {
  return new Date(nowMs + 4 * 3600 * 1000).getUTCHours();
}

function isNightHour(hour, nightStart, nightEnd) {
  if (nightStart === nightEnd) return false; // no window configured: never night
  if (nightStart > nightEnd) return hour >= nightStart || hour < nightEnd; // wraps past midnight, e.g. 22 -> 9
  return hour >= nightStart && hour < nightEnd;
}

/** Night window from config; invalid hours fall back to the defaults (22 -> 9) instead of "never night". */
function nightWindow(config) {
  const hour = (v, d) => { const n = numberSetting(v, d); return Number.isInteger(n) && n >= 0 && n <= 23 ? n : d; };
  return { start: hour(config.nightStart, CONFIG_DEFAULTS.nightStart), end: hour(config.nightEnd, CONFIG_DEFAULTS.nightEnd) };
}

/**
 * The effective mode ("available" | "away" | "night") right now.
 * Does NOT consider aiBotEnabled (the kill switch is checked separately).
 */
function resolveEffectiveMode(config, nowMs = Date.now()) {
  if (config.botMode === 'away') return 'away';
  if (config.botMode === 'night') return 'night';
  if (config.botMode === 'auto') {
    const { start, end } = nightWindow(config);
    return isNightHour(tbilisiHour(nowMs), start, end) ? 'night' : 'available';
  }
  return 'available';
}

/** All timing settings, validated. */
function timingSettings(config) {
  return {
    replyDelaySeconds: numberSetting(config.botResponseDelay, CONFIG_DEFAULTS.botResponseDelay, { min: 0, max: 600 }),
    ownerMuteMinutes: numberSetting(config.ownerMuteMinutes, CONFIG_DEFAULTS.ownerMuteMinutes, { min: 0, max: 240 }),
    ownerSilenceWindowMinutes: numberSetting(config.ownerSilenceWindowMinutes, CONFIG_DEFAULTS.ownerSilenceWindowMinutes, { min: 0, max: 720 }),
    staleConversationMinutes: numberSetting(config.staleConversationMinutes, CONFIG_DEFAULTS.staleConversationMinutes, { min: 1, max: 10080 }),
    staleGraceSeconds: numberSetting(config.staleGraceSeconds, CONFIG_DEFAULTS.staleGraceSeconds, { min: 10, max: 600 }),
  };
}

/**
 * How long the webhook waits before the bot runs: the reply delay in
 * Available mode (at least the quiet-chat grace after a long silence),
 * at most 3 s in Away/Night so bursts still batch.
 */
function replyDelaySeconds(config, effectiveMode, { staleConversation = false } = {}) {
  const t = timingSettings(config);
  const base = effectiveMode === 'available' ? t.replyDelaySeconds : Math.min(t.replyDelaySeconds, 3);
  const grace = effectiveMode === 'available' && staleConversation ? t.staleGraceSeconds : 0;
  return Math.max(base, grace);
}

function normalizePhone(phone) {
  return String(phone || '').replace(/\D/g, '');
}

/** The mode block added to the system prompt. */
function buildModeContext(effectiveMode, ownerPhone) {
  const hostRule = 'If a Host: message appears after the guest\'s latest message, the host already answered it — reply with only [SILENT]. A Host: message that came before the guest\'s latest message does not answer it — reply normally.';
  if (effectiveMode === 'away') {
    return `AWAY MODE: The owner may be unreachable (traveling/no internet). Be helpful with everything you can. When a scenario escalates, its own "let me check / get back to you shortly" sentence is replaced by this one, so the reply has exactly one follow-up sentence: I have noted this and someone from our team will follow up as soon as possible. Example: "Let me check on that and get back to you shortly. [ESCALATE]" becomes "I have noted this and someone from our team will follow up as soon as possible. [ESCALATE]". Never write both sentences. Do not promise immediate response times. ${hostRule}`;
  }
  if (effectiveMode === 'night') {
    const owner = normalizePhone(ownerPhone);
    const urgent = owner
      ? `Only for an urgent problem that cannot wait until morning (the guest is locked out or the smart lock fails, flooding, a security issue, no water or no electricity in the whole apartment), add after your reply: If this is urgent please call the night contact number: +${owner}`
      : 'There is no night contact number: for urgent problems escalate as the scenarios say.';
    return `NIGHT MODE: The owner is off for the night. ${urgent}\nFor anything else that needs the team, say we will get back to you first thing in the morning instead of "shortly", and never give the night contact number for it.\n${hostRule}`;
  }
  return `AVAILABLE MODE: A human host may reply manually. ${hostRule} Guest should never be told they are talking to a bot.`;
}

module.exports = {
  CONFIG_DEFAULTS,
  MODES,
  numberSetting,
  tbilisiHour,
  isNightHour,
  nightWindow,
  resolveEffectiveMode,
  timingSettings,
  replyDelaySeconds,
  buildModeContext,
};
