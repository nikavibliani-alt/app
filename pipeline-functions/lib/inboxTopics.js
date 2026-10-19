'use strict';
/**
 * Topics of a guest's burst of messages (Booking.com AI) and what to do about each. Pure.
 *
 * Two sources, combined: the AI names the topics in ANY language (the first line of its answer,
 * "TOPICS: early_checkin, payment_how"), and an English keyword list is an extra safety net. The union
 * decides, safest first:
 *   hard topics   refund, discount, complaint, late_checkout, payment_other   -> "Needs you", nothing sent
 *   hold topics   cancellation, date_change                                   -> a holding reply, and "Needs you"
 *   soft topics   early_checkin, payment_how, other                           -> a normal answer (checked)
 */

const TOPICS = ['early_checkin', 'payment_how', 'payment_other', 'cancellation', 'date_change', 'refund', 'discount', 'complaint', 'late_checkout', 'other'];
const HARD = new Set(['refund', 'discount', 'complaint', 'late_checkout', 'payment_other']);
const HOLD = new Set(['cancellation', 'date_change']);

const PHRASE = {
  refund: 'a refund', discount: 'a discount or price', complaint: 'a complaint or a problem', late_checkout: 'late check-out',
  payment_other: 'a payment question beyond how to pay', cancellation: 'a cancellation', date_change: 'a date change',
};

/** What we send while the host decides. It promises nothing. */
const HOLDING_EN = "Thank you, we'll forward this to our team and get back to you soon.";

// English keywords: the safety net. (Any language is covered by the AI's topics.)
const KEYWORDS = [
  ['refund', /\b(refunds?|money back|reimburse\w*|compensat\w*)\b/i],
  ['discount', /\b(discounts?|cheaper|lower (?:the )?price|reduce[d]? (?:the )?price|special (?:price|offer)|negotiat\w*|price)\b/i],
  ['complaint', /\b(complain\w*|unacceptable|disgusting|terrible|awful|horrible|worst|scam|fraud|cheated|dirty|filthy|broken|not working|doesn'?t work|no (?:hot )?water|no electricity|noisy|noise|smells?|bugs?|cockroach\w*|mold|leak\w*|flood\w*)\b/i],
  ['late_checkout', /\blate\s*check[- ]?out\b|\bcheck[- ]?out\b.{0,25}\b(later|late|after 1[2-9])\b/i],
  ['payment_other', /\b(deposit|invoice|receipt|credit card|card|cash|charged?|charges|fees?|taxes|tax|vat|extra cost|additional cost|bill|prepay\w*|prepaid)\b|\d\s?(?:gel|usd|eur|lari)\b|[$€₾]\s?\d/i],
  ['cancellation', /\bcancel\w*\b/i],
  ['date_change', /\b(change|move|shift|modify|extend|extension|shorten|postpone|reschedul\w*)\b.{0,40}\b(dates?|booking|reservation|stay|nights?)\b|\b(extra|one more|another) nights?\b|\bstay longer\b/i],
  ['early_checkin', /\bearly\s*check[- ]?in\b|\bcheck[- ]?in\b.{0,25}\b(earlier|early|before 1[0-4])\b|\b(?:arrive|arriving|arrival)\b.{0,15}\b(?:early|earlier)\b|\bcheck[- ]?in\b.{0,20}\b(?:at|around|from)\s*(?:0?[0-9]|1[0-4])(?::\d\d)?\s*am\b/i],
];

/** Topics found by the English keywords in the guest's messages. */
function keywordTopics(texts) {
  const joined = (texts || []).join(' \n ');
  const out = new Set();
  for (const [label, re] of KEYWORDS) if (re.test(joined)) out.add(label);
  return out;
}

/**
 * Reads the "TOPICS: a, b" line the AI puts first. Returns { topics: Set|null, rest }.
 * topics is null when the line is missing or has no known label (the caller then does not trust the answer).
 */
function parseTopicsLine(raw) {
  const text = String(raw || '').replace(/^\s+/, '');
  const m = text.match(/^TOPICS\s*:\s*([^\n]*)\n?/i);
  if (!m) return { topics: null, rest: text.trim() };
  const labels = m[1].toLowerCase().split(/[,\s;|]+/).map(s => s.replace(/[^a-z_]/g, '')).filter(Boolean).filter(l => TOPICS.includes(l));
  return { topics: labels.length ? new Set(labels) : null, rest: text.slice(m[0].length).trim() };
}

const join = labels => labels.join(' and ');

/**
 * What to do for a set of topics: { action: 'needs_you', reason } | { action: 'hold', label } | { action: 'reply' }.
 * Hard topics beat everything, then payment details, then holding replies.
 */
function decideByTopics(topics) {
  const t = topics instanceof Set ? topics : new Set(topics || []);
  const hard = [...t].filter(x => HARD.has(x));
  if (hard.length) return { action: 'needs_you', reason: `the guest asks about ${join(hard.map(x => PHRASE[x]))}` };
  const hold = [...t].filter(x => HOLD.has(x));
  if (hold.length) return { action: 'hold', label: hold.length === 2 ? 'cancellation and date change' : hold[0] === 'cancellation' ? 'cancellation' : 'date change' };
  return { action: 'reply' };
}

// ---------------------------------------------------------------- checks on a normal answer

const OTHER_TIME = /\b(?:(?!15[:.]00\b)\d{1,2}[:.]\d{2})\b|\b\d{1,2}\s?(?:am|pm)\b/i;

/**
 * Extra checks for the two topics that get an automatic answer. Returns { ok:true } or { ok:false, problem }.
 *  early_checkin: the answer must say 15:00 and must not name any other time (no promise of an earlier time).
 *  payment_how: no amounts, currencies or money details.
 */
function validateTopicReply(text, topics) {
  const t = topics instanceof Set ? topics : new Set(topics || []);
  const s = String(text || '');
  if (t.has('early_checkin')) {
    if (!/15[:.]00/.test(s)) return { ok: false, problem: 'an early check-in answer without the 15:00 check-in time' };
    if (OTHER_TIME.test(s)) return { ok: false, problem: 'an early check-in answer that names another time' };
  }
  if (t.has('payment_how')) {
    const noTime = s.replace(/15[:.]00/g, '');
    if (/\d/.test(noTime) || /[$€₾]/.test(noTime) || /\b(gel|usd|eur|lari|deposit|cash|card|fee|fees|charge|charged|charges|tax|vat|extra)\b/i.test(noTime)) {
      return { ok: false, problem: 'a payment answer with amounts or money details' };
    }
  }
  return { ok: true };
}

module.exports = { TOPICS, HARD, HOLD, PHRASE, HOLDING_EN, keywordTopics, parseTopicsLine, decideByTopics, validateTopicReply };
