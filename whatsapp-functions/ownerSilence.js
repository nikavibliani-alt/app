'use strict';

// Owner-takeover / short-ack silence helpers for the WhatsApp bot worker.
// Pure module (no Firestore/Meta imports) so the Away-mode incident fixes are
// unit-testable without loading firebase-functions. Incorporates the narrow
// owner-silence behaviors from PR #48 (cursor/whatsapp-away-owner-silence-c97c):
// owner-echo pending clear in all modes, owner-since-batch-start check in all
// modes, short-acknowledgement silence, and [SILENT] tag support. Later
// expanded with multilingual acknowledgment detection and escalation-aware
// "waiting for an update" follow-up detection (Category 4).

// Cyrillic, Arabic, Georgian, Hebrew — non-Latin script blocks. A message
// built from these isn't emoji/punctuation-only even after ASCII stripping
// leaves it empty, so it must never be treated as a silent ack.
const NON_ASCII_SCRIPT_RE = /[Ѐ-ӿ؀-ۿა-ჿ֐-׿]/u;

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Builds `^(?:p1|p2|...)(?:\s+(?:p1|p2|...))*$` — the whole cleaned string must be
 * made up of nothing but known phrases, longest-first so a longer phrase always
 * wins over a shorter prefix of it. */
function buildWholeStringPhraseRegex(phrases, flags) {
  const sorted = [...phrases].sort((a, b) => b.length - a.length).map(escapeRegExp);
  const alt = sorted.join('|');
  return new RegExp(`^(?:${alt})(?:\\s+(?:${alt}))*$`, flags);
}

// ---- CATEGORY 1 (simple acknowledgments) + 2 (thank-you) + 5 (positive
// reactions) + 6 (confirmation of receipt) — Latin-script, matched against the
// ASCII-cleaned text (emoji/punctuation stripped, lowercased).
const ACK_WORDS_LATIN = [
  // Category 1 — simple acknowledgments (English)
  'ok', 'okay', 'k', 'kk', 'okey', 'alright', 'all right', 'sure', 'fine', 'got it',
  'understood', 'noted', 'i see', 'i understand', 'makes sense', 'sounds good',
  'sounds great', 'perfect', 'wonderful', 'excellent', 'great', 'good', 'nice',
  'cool', 'awesome', 'brilliant', 'no problem', 'no worries', 'np', 'will do',
  // Category 2 — thank you variations
  'thanks', 'thank you', 'thx', 'ty', 'thankyou', 'thank u', 'many thanks',
  'thanks a lot', 'thanks so much', 'merci', 'gracias', 'cheers',
  // Category 5 — positive reactions
  'amazing', 'fantastic', 'lovely', 'exactly', 'precisely', 'thats right',
  "that's right", 'correct', 'yes exactly', 'yes perfect',
  // Category 6 — confirmation of receipt
  'received', 'seen', 'read', 'message received', 'duly noted', 'acknowledged',
];
const ACK_LATIN_RE = buildWholeStringPhraseRegex(ACK_WORDS_LATIN);

// Non-Latin scripts (Russian, Arabic, Persian, Georgian) — matched against the
// raw, lightly-normalized text. ASCII-stripping would erase these entirely, so
// they can't go through the same cleaning pipeline as the Latin list above.
const ACK_WORDS_NON_LATIN = [
  // Russian
  'хорошо', 'понял', 'поняла', 'понятно', 'ок', 'окей', 'спасибо', 'ладно',
  'договорились', 'ясно', 'отлично', 'супер', 'пойдёт', 'благодарю',
  // Arabic
  'حسناً', 'حسنا', 'تمام', 'شكراً', 'شكرا', 'مفهوم', 'موافق', 'حسن', 'ماشي',
  'طيب', 'اوك', 'تمام تمام',
  // Persian
  'باشه', 'خوب', 'ممنون', 'فهمیدم', 'باشه ممنون', 'چشم', 'حتماً', 'حتما',
  // Georgian
  'კარგი', 'გასაგებია', 'გმადლობ', 'ცხადია', 'კი',
];
const ACK_NON_LATIN_RE = buildWholeStringPhraseRegex(ACK_WORDS_NON_LATIN, 'u');

function normalizeNonLatin(raw) {
  return raw
    .toLowerCase() // no-op for Arabic/Persian/Georgian; meaningful for Cyrillic
    .replace(/[!.,;:()\-–—"'«»]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Short guest acknowledgements — Categories 1, 2, 3 (emoji/punctuation-only),
 * 5, and 6. Kept strict so we never mistake a real message for a closed topic:
 * - never true if it contains a "?" (looks like a real question — see
 *   isWaitingFollowUpAfterEscalation for the one escalation-context exception,
 *   which is intentionally a separate function, not folded in here)
 * - never true if longer than 60 characters
 * - never true for non-ASCII-script text longer than 15 characters (could be
 *   a real sentence in that script) — and even under 15 chars, only true if
 *   it actually matches a known short ack phrase in that script, not just
 *   "short and non-Latin"
 */
function isShortAcknowledgement(text) {
  const raw = String(text || '').trim();
  if (!raw) return false;
  if (raw.length > 60) return false;
  if (raw.includes('?')) return false;

  if (NON_ASCII_SCRIPT_RE.test(raw)) {
    if (raw.length > 15) return false;
    const normalized = normalizeNonLatin(raw);
    return !!normalized && ACK_NON_LATIN_RE.test(normalized);
  }

  const cleaned = raw
    .toLowerCase()
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '') // Category 3 — emoji
    .replace(/[^a-z0-9\s']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return true; // emoji-only / punctuation-only (Category 3)
  return ACK_LATIN_RE.test(cleaned);
}

/** True if the model's raw reply carries a [SILENT] tag anywhere. */
function isSilentAiReply(text) {
  return /\[SILENT\]/i.test(String(text || ''));
}

// CATEGORY 4 — a guest nudging for an update ("any update?", "hello?") is only
// silence-worthy when the previous bot/owner message actually reads as an
// escalation ("let me check", "alerting the team", ...). Deliberately separate
// from isShortAcknowledgement: several of these patterns contain "?", which
// isShortAcknowledgement treats as a hard "this is a real question" signal —
// that's correct there (no escalation context to check against), but wrong
// here once we know what the bot already promised.
const WAITING_FOLLOWUP_PATTERNS = [
  /^still waiting\b/i,
  /^any update\b/i,
  /^hello[?!.]*$/i,
  /^hi[?!.]*$/i,
  /^\?{1,3}$/,
  /^anyone there[?!.]*$/i,
  /^are you there[?!.]*$/i,
  /^how long\b/i,
  /^when will\b/i,
  /^it'?s been .*(minute|hour|min|hr)/i,
];

// Deliberately generous — matched against SYSTEM_PROMPT's actual escalation
// reply texts (lockout, flooding, cleaning, utilities, noise, extra guests,
// the generic fallback, ...), not just one or two examples.
const ESCALATION_PHRASE_RE = /\b(let me check|will get back to you|get back to you|alerting the team|i am alerting|contacting our team|looking into this|look into this|checking on this|we will check|we will look into|will look into|someone (from our team )?will follow up|noted this|will update you|keep you updated|will arrange this|someone is on the way|our team will|i need to check this|sorted)\b/i;

/** True if `text` (a past bot/owner message) reads as having escalated something. */
function isEscalationMessage(text) {
  return ESCALATION_PHRASE_RE.test(String(text || ''));
}

/**
 * CATEGORY 4 — should a guest's "waiting for an update" nudge stay silent?
 * Only when the specific previous message being checked against actually
 * escalated something; the same nudge with no escalation context should
 * still reach Claude (it might be a genuine new question, e.g. first "hello").
 */
function isWaitingFollowUpAfterEscalation(guestText, previousMessageContent) {
  const raw = String(guestText || '').trim();
  if (!raw || raw.length > 60) return false;
  if (!isEscalationMessage(previousMessageContent)) return false;
  return WAITING_FOLLOWUP_PATTERNS.some((re) => re.test(raw));
}

/**
 * After skipping trailing guest messages in this batch, should the bot stay
 * silent? messages: newest-first array of { role, content }.
 *
 * - Previous speaker is owner/assistant + short ack ("okay", "thanks") -> silent.
 * - Previous speaker is owner/assistant + a waiting nudge ("any update?") AND
 *   that specific previous message escalated something -> silent (Category 4).
 * - Previous speaker is owner/assistant + a real new question -> do NOT
 *   silence here; let Claude handle it.
 * - No previous non-guest message at all (including: this is the first
 *   message in the conversation) -> never silent.
 */
function shouldStaySilentFromHistory(messagesNewestFirst, guestText) {
  const msgs = Array.isArray(messagesNewestFirst) ? messagesNewestFirst : [];
  let i = 0;
  while (i < msgs.length && (msgs[i].role === 'user' || msgs[i].role === 'guest')) i += 1;
  if (i >= msgs.length) return false;
  const prevMsg = msgs[i];
  if (prevMsg.role !== 'owner' && prevMsg.role !== 'assistant') return false;
  if (isShortAcknowledgement(guestText)) return true;
  if (isWaitingFollowUpAfterEscalation(guestText, prevMsg.content)) return true;
  return false;
}

/** The most recent message with role "owner" in a newest-first message array, or null. */
function findMostRecentOwnerMessage(messagesNewestFirst) {
  const msgs = Array.isArray(messagesNewestFirst) ? messagesNewestFirst : [];
  return msgs.find((m) => m.role === 'owner') || null;
}

// Placeholder strings classifyIncomingContent() stores for non-text messages —
// these can never match a text-based ack/nudge pattern, so a guest sending a
// photo/video/voice note right after an active owner reply would otherwise
// always fall through to "let the bot answer." Treat a batch made up entirely
// of these placeholders (no real wording at all) as ack-equivalent for the
// owner-continuation-silence window. A batch mixing a placeholder with real
// text is NOT covered here — that combination still carries a real question.
const NON_TEXT_PLACEHOLDER_RE = /^\[(?:image|video|audio|unsupported)\]$/;

/** True if every line of `text` is one of classifyIncomingContent()'s non-text
 * placeholder strings — i.e. the guest sent no real wording at all, just
 * media/unsupported content. */
function isNonTextPlaceholderOnly(text) {
  const raw = String(text || '').trim();
  if (!raw) return false;
  return raw.split('\n').every((line) => NON_TEXT_PLACEHOLDER_RE.test(line.trim()));
}

/**
 * Earliest timestamp (ms) such that ANY owner message at or after it means the
 * bot must stay silent: the flat owner-mute window (now - muteMinutes) or the
 * start of the current guest batch, whichever is earlier. The batch-start half
 * catches an owner reply that landed while this batch was still being processed.
 */
function ownerMuteCutoffMs(nowMs, batchStartMs, muteMinutes) {
  const muteCutoff = nowMs - muteMinutes * 60 * 1000;
  return Number.isFinite(batchStartMs) ? Math.min(batchStartMs, muteCutoff) : muteCutoff;
}

/**
 * What the worker should do given the newest owner message (latestOwnerMs, NaN if
 * none in range) relative to this guest batch:
 * - 'drop': the owner replied at or after the batch started, so they addressed it.
 * - 'defer': the owner replied before the batch started and the mute window is
 *   still open, so the guest wrote DURING the mute. Keep the batch and answer at
 *   deferUntilMs (mute end) if the owner hasn't replied again by then.
 * - 'proceed': no owner reply, or its mute already expired.
 */
function ownerMuteDecision({ nowMs, batchStartMs, latestOwnerMs, muteMinutes }) {
  if (!Number.isFinite(latestOwnerMs)) return { action: 'proceed' };
  if (Number.isFinite(batchStartMs) && latestOwnerMs >= batchStartMs) return { action: 'drop' };
  const muteEndsMs = latestOwnerMs + muteMinutes * 60 * 1000;
  if (muteEndsMs > nowMs) return { action: 'defer', deferUntilMs: muteEndsMs };
  return { action: 'proceed' };
}

/**
 * Final check right before a generated reply is sent:
 * - 'owner_replied': the pending batch is gone (an owner echo clears it) or
 *   the owner replied since the batch started, so the owner handled it.
 * - 'newer_message': the pending batchToken changed while the reply was being
 *   generated, i.e. the guest wrote again. This reply is outdated; the newer
 *   run (already queued) answers everything in one reply.
 * - 'send': nothing changed.
 */
function preSendDecision({ pendingExists, pendingToken, batchToken, muteAction }) {
  if (!pendingExists) return 'owner_replied';
  if (pendingToken !== batchToken) return 'newer_message';
  if (muteAction === 'drop') return 'owner_replied';
  return 'send';
}

/** True if the last message in the conversation (either side) is older than `staleMinutes`. */
function isConversationStale(lastMessageMs, nowMs, staleMinutes) {
  return Number.isFinite(lastMessageMs) && nowMs - lastMessageMs > staleMinutes * 60 * 1000;
}

module.exports = {
  ownerMuteCutoffMs,
  ownerMuteDecision,
  preSendDecision,
  isConversationStale,
  isShortAcknowledgement,
  isSilentAiReply,
  isEscalationMessage,
  isWaitingFollowUpAfterEscalation,
  shouldStaySilentFromHistory,
  findMostRecentOwnerMessage,
  isNonTextPlaceholderOnly,
};
