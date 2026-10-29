'use strict';
/* Elevator monitor decisions, kept free of network code so they can be tested with fake data.
 * Signal used: the Samsung app writes /elevator_code only when the code changes (watched 30 minutes, no write
 * and no heartbeat field), so the problem is "the code has passed its expires_at and no new code came".
 * A hand save in the admin sets a new expires_at (+24h), so it clears the problem by itself. */

const GRACE_MS = 30 * 60 * 1000;          // the app may write the next code a little after expires_at
const NO_EXPIRY_STALE_MS = 26 * 3600 * 1000; // only when expires_at is missing or unreadable
const TZ_OFFSET = 4 * 3600 * 1000;       // Tbilisi

function toMs(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 1e11 ? n : null;
}

function tbilisiTime(ms) {
  return new Date(ms + TZ_OFFSET).toISOString().slice(0, 16).replace('T', ' ') + ' (Tbilisi)';
}

/* data = /elevator_code, monitor = /elevator_monitor. Returns what to do this run. */
function decide(data, monitor, now) {
  const m = monitor || {};
  const open = m.alert_open === true || m.was_stale === true;   // was_stale: the old monitor's flag
  const updatedAt = toMs(data && data.updatedAt);
  const expiresAt = toMs(data && data.expires_at);
  if (updatedAt == null && expiresAt == null) {
    return { problem: false, action: 'none', reason: 'no elevator_code data, skipped' };
  }
  let problem = false;
  let reason = '';
  if (expiresAt != null) {
    problem = now > expiresAt + GRACE_MS;
    reason = problem
      ? 'The code expired at ' + tbilisiTime(expiresAt) + ' and no new code has come.'
      : 'The code is valid until ' + tbilisiTime(expiresAt) + '.';
  } else {
    problem = now - updatedAt > NO_EXPIRY_STALE_MS;
    reason = problem
      ? 'The code was last updated at ' + tbilisiTime(updatedAt) + ' and has no expiry time.'
      : 'The code was updated at ' + tbilisiTime(updatedAt) + '.';
  }
  let action = 'none';
  if (problem && !open) action = 'alert';          // once per problem: no repeats while it stays open
  else if (!problem && open) action = 'recover';   // new code or hand save: reset
  return { problem, action, reason, updatedAt, expiresAt };
}

const ALERT_TITLE = 'Elevator code expired - phone app stopped?';
function alertTexts(d, now) {
  return {
    title: ALERT_TITLE,
    body: 'Check the Samsung phone (ElevatorSync). ' + d.reason,
    subject: ALERT_TITLE,
    now: tbilisiTime(now),
  };
}

module.exports = { decide, alertTexts, tbilisiTime, toMs, GRACE_MS, NO_EXPIRY_STALE_MS, ALERT_TITLE };
