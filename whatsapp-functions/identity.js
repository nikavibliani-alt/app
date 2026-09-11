'use strict';

// Pure helpers for guest location identification (Shartava vs Freedom Square vs
// Orbeliani, sharing one WhatsApp number). No Firestore/Meta/Claude calls in
// here on purpose — keeps this file trivially unit-testable.

/**
 * Maps a checkin_guests `aptId` prefix to a property brand.
 * `0-` / `6-` / `7-` -> Shartava (the AI bot's property). `tab-` -> Freedom
 * Square. `orb-` -> Orbeliani. Anything else is unknown (null) — callers must
 * not guess and should alert the owner instead.
 */
function aptIdToBrand(aptId) {
  const id = String(aptId || '');
  if (!id) return null;
  if (id.startsWith('tab-')) return 'freedom';
  if (id.startsWith('orb-')) return 'orbeliani';
  if (id.startsWith('0-') || id.startsWith('6-') || id.startsWith('7-')) return 'shartava';
  return null;
}

// Case-insensitive Freedom Square identification keywords. Deliberately narrow —
// see whatsapp-functions/README.md "Identification flow" for the false-positive
// list this was tuned against (bare "Galaktion", "city centre/center", bare
// mid-sentence "Nina", "studios").
const FREEDOM_KEYWORD_PATTERNS = [
  /freedom\s+square/i,
  /\btabidze\b/i,
  /galaktion\s+tabidze/i,
  // "Hi/Hello/Dear Nina" as a greeting, not a mid-sentence mention.
  /(?:^|[\s,.:;!?])(?:hi|hello|dear)\s+nina(?:[\s,.:;!?]|$)/i,
  // A message that opens by directly addressing "Nina," / "Nina." — checked per
  // line (messages in a batch are joined with "\n") so this never matches a
  // mid-sentence "...spoke with Nina yesterday...".
  /^nina[\s,.:;!?]/im,
];

/** True if `text` (a single message, or several joined with "\n") matches a Freedom Square keyword. */
function matchesFreedomKeywords(text) {
  const t = String(text || '');
  if (!t) return false;
  return FREEDOM_KEYWORD_PATTERNS.some((re) => re.test(t));
}

module.exports = { aptIdToBrand, matchesFreedomKeywords, FREEDOM_KEYWORD_PATTERNS };
