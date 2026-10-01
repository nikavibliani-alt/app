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

const TBILISI_OFFSET_MS = 4 * 60 * 60 * 1000; // UTC+4 year-round, no DST
const DAY_MS = 24 * 60 * 60 * 1000;

/** Calendar day number of an instant in Tbilisi. */
function tbilisiDayNumber(ms) {
  return Math.floor((ms + TBILISI_OFFSET_MS) / DAY_MS);
}

/**
 * How long ago a message was sent, as the label Claude sees: "just now",
 * "5 min ago", "3 hours ago" (under 24 hours), else whole Tbilisi calendar
 * days, "1 day ago" / "2 days ago". Empty string if the time is unknown.
 */
function relativeTimeLabel(sentMs, nowMs) {
  if (!Number.isFinite(sentMs) || !Number.isFinite(nowMs)) return '';
  const minutes = Math.max(0, Math.floor((nowMs - sentMs) / 60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.max(1, tbilisiDayNumber(nowMs) - tbilisiDayNumber(sentMs));
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

// Matches any label relativeTimeLabel produces, in brackets, plus trailing spaces.
const TIME_LABEL_RE = /\[(?:just now|\d+ min ago|\d+ hours? ago|\d+ days? ago)\]\s*/gi;

/** Removes time labels Claude may have copied from the history into its reply. */
function stripTimeLabels(text) {
  return String(text ?? '').replace(TIME_LABEL_RE, '').trim();
}

/** Newest-first stored messages -> Claude's chronological history. Owner
 *  echoes become an assistant turn prefixed "Host: " so the model knows a
 *  human already responded. With `nowMs`, every line starts with a relative
 *  time label (e.g. "[2 days ago] Host: …") so the model can tell old
 *  messages from new ones; without it, lines are unlabelled. */
function toClaudeHistory(recentNewestFirst, nowMs) {
  return [...recentNewestFirst]
    .reverse()
    .map((m) => {
      const label = nowMs === undefined ? '' : relativeTimeLabel(toMillis(m.timestamp), nowMs);
      const prefix = label ? `[${label}] ` : '';
      if (m.role === 'owner') return { role: 'assistant', content: `${prefix}Host: ${m.content}` };
      if (m.role === 'assistant') return { role: 'assistant', content: `${prefix}${m.content}` };
      return { role: 'user', content: `${prefix}${m.content}` };
    });
}

/**
 * Claude's messages for this run, guaranteed to end with the guest's
 * unanswered message(s) — the API rejects a conversation that ends with an
 * assistant turn (a bot reply or a "Host:" line).
 *
 * A guest message counts as answered if a Host message came after it, or if
 * a bot reply covered it: stored bot replies record `repliesToMs`, the time
 * of the newest guest message that was in that reply's history (older replies
 * without it are treated as covering everything before them). This matters
 * in the race where the guest writes again while a reply is being generated:
 * the new message is stored before the reply, yet the reply never saw it.
 *
 * Answered messages keep their order; the unanswered guest messages go last
 * as the final user turn(s), with their time labels. Returns
 * `{ messages, unansweredCount, newestUnansweredMs }`, or `{ silent: true }`
 * when there is no unanswered guest message (nothing to reply to).
 */
function prepareClaudeHistory(recentNewestFirst, nowMs) {
  const chronological = [...recentNewestFirst].reverse();
  let answeredUntilMs = -Infinity;
  for (const m of chronological) {
    if (m.role === 'owner') answeredUntilMs = Math.max(answeredUntilMs, toMillis(m.timestamp));
    if (m.role === 'assistant') {
      const covered = Number.isFinite(m.repliesToMs) ? m.repliesToMs : toMillis(m.timestamp);
      answeredUntilMs = Math.max(answeredUntilMs, covered);
    }
  }
  const isUnanswered = (m) => (m.role === 'user' || m.role === 'guest') && !(toMillis(m.timestamp) <= answeredUntilMs);
  const unanswered = chronological.filter(isUnanswered);
  if (unanswered.length === 0) return { silent: true };
  const answered = chronological.filter((m) => !isUnanswered(m));
  const ordered = [...answered, ...unanswered];
  return {
    messages: toClaudeHistory([...ordered].reverse(), nowMs),
    unansweredCount: unanswered.length,
    newestUnansweredMs: Math.max(...unanswered.map((m) => toMillis(m.timestamp)).filter(Number.isFinite)),
  };
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
  relativeTimeLabel,
  stripTimeLabels,
  toClaudeHistory,
  prepareClaudeHistory,
  loadCurrentStayHistory,
};
