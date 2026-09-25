'use strict';

// Current-stay scoping for the bot worker's conversation history.
//
// Messages are never deleted (see summarizer.js), so a returning guest's
// conversation still holds their previous stays. The worker must only reason
// about the current stay: messages after the phone's most recent completed
// checkout. That boundary comes from the whatsapp_checkout_summaries marker
// docs the summarizer writes once per checkout. Each stores `phone` (the
// exact whatsapp_conversations/{phone} key) and `cutoffMs` (end of the
// checkout day, Tbilisi). No completed checkout -> no boundary -> history is
// unchanged.

const MARKER_COLLECTION = 'whatsapp_checkout_summaries';

function toMillis(value) {
  if (!value) return NaN;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value.toDate === 'function') return value.toDate().getTime();
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : NaN;
}

/** Latest completed checkout cutoff (ms) among a phone's marker docs, or NaN if none. */
function latestCompletedCheckoutMs(markers, nowMs) {
  let latest = NaN;
  for (const marker of markers || []) {
    const cutoff = Number(marker && marker.cutoffMs);
    if (!Number.isFinite(cutoff) || cutoff > nowMs) continue;
    if (!Number.isFinite(latest) || cutoff > latest) latest = cutoff;
  }
  return latest;
}

/** Keeps only messages after the stay boundary; no boundary (NaN) keeps everything. */
function currentStayMessages(messages, stayStartMs) {
  const list = Array.isArray(messages) ? messages : [];
  if (!Number.isFinite(stayStartMs)) return list;
  return list.filter((m) => toMillis(m.timestamp) > stayStartMs);
}

/** Newest-first stored messages -> Claude's chronological history. Owner
 *  echoes become an assistant turn prefixed "Host: " so the model knows a
 *  human already responded. */
function toClaudeHistory(recentNewestFirst) {
  return [...recentNewestFirst]
    .reverse()
    .map((m) => {
      if (m.role === 'owner') return { role: 'assistant', content: `Host: ${m.content}` };
      if (m.role === 'assistant') return { role: 'assistant', content: m.content };
      return { role: 'user', content: m.content };
    });
}

/**
 * The last `limit` messages of the phone's CURRENT stay, newest first. The
 * boundary is applied in the query, so the limit counts current-stay messages
 * only, and again in JS as a guard. If the marker lookup fails, falls back to
 * the unscoped history (the pre-scoping behavior) instead of failing the reply.
 */
async function loadCurrentStayHistory(db, phone, nowMs, limit = 15) {
  let stayStartMs = NaN;
  try {
    const markers = await db.collection(MARKER_COLLECTION).where('phone', '==', phone).get();
    stayStartMs = latestCompletedCheckoutMs(markers.docs.map((d) => d.data()), nowMs);
  } catch (err) {
    console.warn('loadCurrentStayHistory: checkout marker lookup failed, using unscoped history for', phone, err.message || err);
  }

  let query = db.collection('whatsapp_conversations').doc(phone).collection('messages');
  if (Number.isFinite(stayStartMs)) query = query.where('timestamp', '>', new Date(stayStartMs));
  const snap = await query.orderBy('timestamp', 'desc').limit(limit).get();
  const recentNewestFirst = currentStayMessages(snap.docs.map((d) => d.data()), stayStartMs);
  return { recentNewestFirst, stayStartMs };
}

module.exports = {
  latestCompletedCheckoutMs,
  currentStayMessages,
  toClaudeHistory,
  loadCurrentStayHistory,
};
