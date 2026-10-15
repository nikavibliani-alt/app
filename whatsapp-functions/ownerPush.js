'use strict';

// Push notifications to the owner's phone for URGENT alerts only, as a second
// channel next to the WhatsApp owner_alert template (which Meta sometimes
// declines to deliver, error 131049). Same Web Push system as the Hotel
// Collect alert: the admin app's devices in push_subscriptions, the VAPID keys
// and the payload shape sw.js shows ({ title, body, url, tag }).
//
// Kinds: 'lockout' ([URGENT:LOCKOUT]), 'issue' ([URGENT:ISSUE]), 'angry'
// ([URGENT:ANGRY]), 'bot_error' (Claude or Meta failure, empty reply).
// Normal escalations get no push.
//
// Pure apart from the injected loaders/senders. Never throws: a push failure
// is logged and never stops the bot or the WhatsApp alert.

const { placeLabel, cleanParam } = require('./ownerAlert');

const PUSH_KINDS = ['lockout', 'issue', 'angry', 'bot_error'];
const MAX_SNIPPET = 100;
const ADMIN_URL = '/checkin-admin';

/**
 * { title, body, url, tag } for one urgent alert, e.g.
 * title "URGENT: Shartava 6-2 locked out", body "Anna Petrova: The lock is not opening…".
 */
function urgentPushPayload({ kind, guestName, roomCode, guestText, reason, phone }) {
  const place = placeLabel(roomCode);
  const name = cleanParam(guestName, 40, 'Guest');
  const said = cleanParam(guestText, MAX_SNIPPET, '');
  const titles = {
    lockout: `URGENT: ${place} locked out`,
    issue: `URGENT: ${place} flooding or security issue`,
    angry: `URGENT: ${place} angry guest`,
    bot_error: `Bot could not reply: ${place}`,
  };
  const guestLine = said ? `${name}: ${said}` : name;
  const body = kind === 'bot_error' && reason
    ? `${cleanParam(reason, 80, 'unknown error')}. ${guestLine}`
    : guestLine;
  return {
    title: titles[kind] || `URGENT: ${place}`,
    body,
    url: ADMIN_URL,
    tag: `wa-${kind}-${String(phone || '').replace(/\D/g, '').slice(-6) || 'guest'}`,
  };
}

/**
 * Sends `payload` to every subscribed admin device.
 * loadSubscriptions() -> [{ id, subscription }]; send(subscription, payload) -> resolves or throws
 * (web-push errors carry statusCode). Returns { ok, sent, failed, devices }. Never throws.
 */
async function sendOwnerPush({ payload, loadSubscriptions, send, log = console }) {
  let subs;
  try {
    subs = (await loadSubscriptions()).filter((s) => s && s.subscription);
  } catch (err) {
    log.error(`owner push FAILED: could not read push_subscriptions (${err?.message || err}) — "${payload.title}"`);
    return { ok: false, sent: 0, failed: 0, devices: 0 };
  }
  if (!subs.length) {
    log.error(`owner push FAILED: no subscribed devices (turn on notifications in the admin app) — "${payload.title}"`);
    return { ok: false, sent: 0, failed: 0, devices: 0 };
  }
  const results = await Promise.allSettled(subs.map((s) => Promise.resolve().then(() => send(s.subscription, payload))));
  let sent = 0;
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') { sent += 1; return; }
    const code = r.reason?.statusCode;
    const why = code === 404 || code === 410
      ? `subscription expired (${code}), turn notifications on again in the admin app`
      : `${code || ''} ${r.reason?.message || r.reason}`.trim();
    log.error(`owner push FAILED for device ${String(subs[i].id || '?').slice(0, 8)}…: ${why} — "${payload.title}"`);
  });
  if (sent) log.log(`owner push sent to ${sent} of ${subs.length} device(s): "${payload.title}"`);
  return { ok: sent > 0, sent, failed: subs.length - sent, devices: subs.length };
}

module.exports = { PUSH_KINDS, urgentPushPayload, sendOwnerPush };
