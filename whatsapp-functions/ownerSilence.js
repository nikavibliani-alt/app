/**
 * Owner-takeover / short-ack silence helpers for the WhatsApp bot worker.
 * Kept in a tiny module so we can unit-test the Away-mode incident fixes
 * without loading firebase-functions.
 */

/**
 * CHANGE 6 — short guest acknowledgements like "okay" / "thanks" after the topic
 * was already closed. Keep this strict so we never invent follow-up chatter.
 */
function isShortAcknowledgement(text) {
  const raw = String(text || '').trim().toLowerCase();
  if (!raw || raw.length > 48) return false;
  const cleaned = raw
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    .replace(/[^a-z0-9\s']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return true; // emoji-only / punctuation-only ack
  return /^(ok|okay|k|kk|okey|alright|all right|got it|understood|thanks|thank you|thx|ty|cool|fine|sure|perfect|great|no problem|np|will do|noted)(\s+(ok|okay|thanks|thank you|thx|ty))?$/.test(cleaned);
}

function isSilentAiReply(text) {
  const t = String(text || '').trim();
  if (!t) return true;
  return /^\[SILENT\]$/i.test(t);
}

/**
 * CHANGE 5/6 — after skipping trailing guest messages in this batch, should the
 * bot stay silent?
 * messages: newest-first array of { role, content }.
 *
 * - Previous speaker is owner + short ack ("okay", "thanks") → silent (the Away incident).
 * - Previous speaker is assistant + short ack → silent (don't invent follow-up chatter).
 * - Previous speaker is owner + a real new question → do NOT silent here; let Claude
 *   handle it (owner may have answered an earlier topic only).
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

module.exports = {
  isShortAcknowledgement,
  isSilentAiReply,
  shouldStaySilentFromHistory,
};
