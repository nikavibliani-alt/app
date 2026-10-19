'use strict';
/** The Booking.com AI mode (Admin, More): off, drafts (the host taps Send) or auto (sends by itself when sure). Pure. */

const MODES = ['off', 'drafts', 'auto'];
const AI_SENDER = { email: 'ai', name: 'AI' };           // sentBy / sentByName on replies the assistant sent
const HUMAN_REPLY_QUIET_MS = 30 * 60 * 1000;             // no automatic sending this long after one of us replied

/** cfg = globals/config data. New field bookingAiMode; older installs only had bookingAiDraftsEnabled. */
function resolveAiMode(cfg) {
  const m = cfg && cfg.bookingAiMode;
  if (MODES.includes(m)) return m;
  if (cfg && cfg.bookingAiDraftsEnabled === false) return 'off';
  return 'drafts';
}

const ms = v => (v && typeof v.toMillis === 'function' ? v.toMillis() : v && typeof v.toDate === 'function' ? v.toDate().getTime() : v ? new Date(v).getTime() : NaN);

/**
 * Why a normal draft must NOT be sent automatically, or null when it may be: a cancelled reservation, or
 * a person (not the assistant) replied in this conversation in the last 30 minutes.
 * messages: conversation messages with direction, sentAt, sentBy.
 */
function autoSendBlockReason({ conv, messages, nowMs }) {
  if (String((conv && conv.reservationStatus) || '').toUpperCase() === 'CANCELLED') return 'the reservation is cancelled';
  for (const m of messages || []) {
    if (m.direction !== 'host' || String(m.sentBy || '').toLowerCase() === AI_SENDER.email) continue;
    const t = ms(m.sentAt);
    if (Number.isFinite(t) && nowMs - t <= HUMAN_REPLY_QUIET_MS) return 'one of us replied in the last 30 minutes';
  }
  return null;
}

module.exports = { MODES, AI_SENDER, HUMAN_REPLY_QUIET_MS, resolveAiMode, autoSendBlockReason };
