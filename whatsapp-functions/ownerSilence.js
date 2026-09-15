'use strict';

// Owner-takeover / short-ack silence helpers for the WhatsApp bot worker.
// Pure module (no Firestore/Meta imports) so the Away-mode incident fixes are
// unit-testable without loading firebase-functions. Incorporates the narrow
// owner-silence behaviors from PR #48 (cursor/whatsapp-away-owner-silence-c97c):
// owner-echo pending clear in all modes, owner-since-batch-start check in all
// modes, short-acknowledgement silence, and [SILENT] tag support.

// Cyrillic, Arabic, Georgian, Hebrew — non-Latin script blocks. A message
// built from these isn't emoji/punctuation-only even after ASCII stripping
// leaves it empty, so it must never be treated as a silent ack.
const NON_ASCII_SCRIPT_RE = /[Ѐ-ӿ؀-ۿა-ჿ֐-׿]/u;

/**
 * Short guest acknowledgements like "okay" / "thanks" after the topic was
 * already closed. Kept strict so we never invent follow-up chatter.
 */
function isShortAcknowledgement(text) {
  const raw = String(text || '').trim().toLowerCase();
  if (!raw || raw.length > 48) return false;
  const cleaned = raw
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    .replace(/[^a-z0-9\s']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) {
    // Nothing ASCII left. Only an ack if that's because the original was
    // purely emoji/punctuation — not because it was non-English script text
    // (e.g. Arabic "مساعدة" / help, or a frustrated "???" written in another
    // script) that stripping simply can't see.
    return !NON_ASCII_SCRIPT_RE.test(raw);
  }
  return /^(ok|okay|k|kk|okey|alright|all right|got it|understood|thanks|thank you|thx|ty|cool|fine|sure|perfect|great|no problem|np|will do|noted)(\s+(ok|okay|thanks|thank you|thx|ty))?$/.test(cleaned);
}

/** True if the model's raw reply carries a [SILENT] tag anywhere. */
function isSilentAiReply(text) {
  return /\[SILENT\]/i.test(String(text || ''));
}

/**
 * After skipping trailing guest messages in this batch, should the bot stay
 * silent? messages: newest-first array of { role, content }.
 *
 * - Previous speaker is owner + short ack ("okay", "thanks") -> silent (the Away incident).
 * - Previous speaker is assistant + short ack -> silent (don't invent follow-up chatter).
 * - Previous speaker is owner + a real new question -> do NOT silence here; let Claude
 *   handle it (the owner may have only answered an earlier topic).
 */
function shouldStaySilentFromHistory(messagesNewestFirst, guestText) {
  const msgs = Array.isArray(messagesNewestFirst) ? messagesNewestFirst : [];
  let i = 0;
  while (i < msgs.length && (msgs[i].role === 'user' || msgs[i].role === 'guest')) i += 1;
  if (i >= msgs.length) return false;
  const prevRole = msgs[i].role;
  if ((prevRole === 'owner' || prevRole === 'assistant') && isShortAcknowledgement(guestText)) {
    return true;
  }
  return false;
}

/** The most recent message with role "owner" in a newest-first message array, or null. */
function findMostRecentOwnerMessage(messagesNewestFirst) {
  const msgs = Array.isArray(messagesNewestFirst) ? messagesNewestFirst : [];
  return msgs.find((m) => m.role === 'owner') || null;
}

module.exports = {
  isShortAcknowledgement,
  isSilentAiReply,
  shouldStaySilentFromHistory,
  findMostRecentOwnerMessage,
};
