'use strict';
/**
 * Booking.com inbox alerts: the pure parts (payloads, the one-push-per-burst rule, subscription checks).
 * No Firebase, no network, no clock.
 */

const QUIET_MS = 3 * 60 * 1000;            // a new push only after 3 minutes without a guest message
const STALE_MESSAGE_MS = 60 * 60 * 1000;   // an older message (backfill, late email) never alerts
const STALE_CANCEL_MS = 6 * 60 * 60 * 1000;
const MAX_BODY = 90;
const TBILISI_OFFSET_MS = 4 * 60 * 60 * 1000;
const MAX_SUB_JSON = 4000;

/** Push iff there was no guest message in the previous 3 minutes (or none before). */
function burstDecision(prevAtMs, nowMs) {
  return !Number.isFinite(prevAtMs) || nowMs - prevAtMs >= QUIET_MS;
}

/** First line of a message, short. */
function firstLine(text, max = MAX_BODY) {
  const line = String(text || '').split(/\r?\n/).map(l => l.trim()).find(Boolean) || '';
  const flat = line.replace(/\s+/g, ' ');
  return flat.length > max ? flat.slice(0, max - 3).trimEnd() + '...' : flat;
}

const tbilisiClock = ms => {
  const d = new Date(ms + TBILISI_OFFSET_MS);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
};
const tbilisiDate = ms => new Date(ms + TBILISI_OFFSET_MS).toISOString().slice(0, 10);

/** Guest name, listing, first line of the message. Tapping opens that conversation. */
function messagePayload(conv, bookingNumber, text) {
  const c = conv || {};
  const name = String(c.guestName || 'Guest').slice(0, 60);
  const listing = String(c.propertyName || '').slice(0, 60);
  const line = firstLine(text);
  return {
    title: name,
    body: [listing, line].filter(Boolean).join(' · '),
    tag: `inbox-${bookingNumber}`,
    url: `/inbox#c/${bookingNumber}`,
  };
}

/** The assistant sent a reply by itself. */
function aiAnsweredPayload(conv, bookingNumber, text) {
  const c = conv || {};
  return {
    title: `AI answered ${String(c.guestName || 'Guest').slice(0, 60)}`,
    body: firstLine(text),
    tag: `inbox-ai-${bookingNumber}`,
    url: `/inbox#c/${bookingNumber}`,
  };
}

/** The assistant could not answer and hands the conversation to me. */
function needsYouPayload(conv, bookingNumber, reason) {
  const c = conv || {};
  return {
    title: `${String(c.guestName || 'Guest').slice(0, 60)} needs you`,
    body: firstLine(reason),
    tag: `inbox-needs-${bookingNumber}`,
    url: `/inbox#c/${bookingNumber}`,
  };
}

/** A cancellation request, with the deadline. */
function cancelPayload(conv, bookingNumber, deadlineMs, nowMs) {
  const c = conv || {};
  const name = String(c.guestName || 'Guest').slice(0, 60);
  const listing = String(c.propertyName || '').slice(0, 60);
  let when = '';
  if (Number.isFinite(deadlineMs)) {
    when = tbilisiDate(deadlineMs) === tbilisiDate(nowMs) ? tbilisiClock(deadlineMs) : `${tbilisiDate(deadlineMs).slice(5).replace('-', '/')} ${tbilisiClock(deadlineMs)}`;
  }
  return {
    title: 'Cancellation request',
    body: `${name}${listing ? ` (${listing})` : ''}: asks to cancel for free${when ? `, answer in Booking.com by ${when}` : ''}`,
    tag: `inbox-cancel-${bookingNumber}`,
    url: `/inbox#c/${bookingNumber}`,
  };
}

// Web Push services only. The server posts to this address, so it must be one of them.
const PUSH_HOST_RE = /(^|\.)(push\.apple\.com|fcm\.googleapis\.com|push\.services\.mozilla\.com|notify\.windows\.com)$/i;

/** Checks a browser push subscription. Returns { ok, subscription } (trimmed to what web-push needs) or { ok:false, error }. */
function cleanSubscription(sub) {
  try {
    if (!sub || typeof sub !== 'object') return { ok: false, error: 'No subscription.' };
    if (JSON.stringify(sub).length > MAX_SUB_JSON) return { ok: false, error: 'Subscription too large.' };
    const u = new URL(String(sub.endpoint || ''));
    if (u.protocol !== 'https:' || !PUSH_HOST_RE.test(u.hostname)) return { ok: false, error: 'Not a Web Push address.' };
    const k = sub.keys || {};
    if (typeof k.p256dh !== 'string' || typeof k.auth !== 'string' || !k.p256dh || !k.auth) return { ok: false, error: 'Subscription keys are missing.' };
    return { ok: true, subscription: { endpoint: u.toString(), keys: { p256dh: k.p256dh, auth: k.auth } } };
  } catch (e) {
    return { ok: false, error: 'Bad subscription.' };
  }
}

const isDeviceId = v => typeof v === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(v);

module.exports = {
  QUIET_MS, STALE_MESSAGE_MS, STALE_CANCEL_MS,
  burstDecision, firstLine, messagePayload, aiAnsweredPayload, needsYouPayload, cancelPayload, cleanSubscription, isDeviceId, tbilisiClock,
};
