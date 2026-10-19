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

module.exports = { STALE_MS, REPEAT_MS, decideScriptAlert, scriptAlertPayload };
