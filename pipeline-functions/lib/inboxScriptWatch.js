'use strict';
/** Is the Gmail script still alive? Pure decision and texts for inboxScriptWatch. */

const { tbilisiClock } = require('./inboxPush');

const STALE_MS = 15 * 60 * 1000;        // no call from the script for this long = stopped
const REPEAT_MS = 3 * 60 * 60 * 1000;   // while it stays stopped, remind every 3 hours

/**
 * state: { down: boolean, alertedAtMs: number }. Returns { action: 'none'|'down'|'still_down'|'back' }.
 * No heartbeat yet (the script never called) means nothing to judge.
 */
function decideScriptAlert({ nowMs, lastPullMs, state }) {
  if (!Number.isFinite(lastPullMs)) return { action: 'none' };
  const stale = nowMs - lastPullMs > STALE_MS;
  const down = !!(state && state.down);
  if (stale && !down) return { action: 'down' };
  if (stale && down && nowMs - Number((state && state.alertedAtMs) || 0) >= REPEAT_MS) return { action: 'still_down' };
  if (!stale && down) return { action: 'back' };
  return { action: 'none' };
}

/** The push text. */
function scriptAlertPayload(action, lastPullMs, nowMs) {
  const since = tbilisiClock(lastPullMs);
  if (action === 'back') {
    return { title: 'Booking.com Gmail script is back', body: 'The script is running again. New guest emails and replies are moving.', tag: 'inbox-script', url: '/inbox' };
  }
  return {
    title: action === 'still_down' ? 'Booking.com Gmail script is still stopped' : 'Booking.com Gmail script has stopped',
    body: `No check from the script since ${since}. New guest messages and replies are not moving. Open script.google.com, Executions.`,
    tag: 'inbox-script',
    url: '/inbox',
  };
}

// ---------------------------------------------------------------- no new Booking.com email saved

const EMAIL_STALE_MS = 12 * 60 * 60 * 1000;     // no email saved for this long = something is wrong
const EMAIL_REPEAT_MS = 6 * 60 * 60 * 1000;     // while it stays quiet, remind every 6 hours

/** Same shape as decideScriptAlert, for "the newest saved email is older than 12 hours". */
function decideEmailAlert({ nowMs, newestMs, state }) {
  if (!Number.isFinite(newestMs)) return { action: 'none' };
  const stale = nowMs - newestMs > EMAIL_STALE_MS;
  const down = !!(state && state.down);
  if (stale && !down) return { action: 'down' };
  if (stale && down && nowMs - Number((state && state.alertedAtMs) || 0) >= EMAIL_REPEAT_MS) return { action: 'still_down' };
  if (!stale && down) return { action: 'back' };
  return { action: 'none' };
}

const tbilisiDay = ms => new Date(ms + 4 * 3600 * 1000).toISOString().slice(5, 10).replace('-', '/');

function emailAlertPayload(action, newestMs) {
  if (action === 'back') {
    return { title: 'Booking.com emails are being saved again', body: 'A new Booking.com email was saved. The email flow works again.', tag: 'inbox-email-watch', url: '/inbox' };
  }
  return {
    title: action === 'still_down' ? 'Still no Booking.com email saved' : 'No Booking.com email saved for 12 hours',
    body: `The last one was saved ${tbilisiDay(newestMs)} ${tbilisiClock(newestMs)}. The Gmail script may be failing. Open script.google.com, Executions.`,
    tag: 'inbox-email-watch',
    url: '/inbox',
  };
}

module.exports = { STALE_MS, REPEAT_MS, decideScriptAlert, scriptAlertPayload, EMAIL_STALE_MS, EMAIL_REPEAT_MS, decideEmailAlert, emailAlertPayload };
