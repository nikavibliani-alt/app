'use strict';
/**
 * Step 5 of docs/INBOX_IMPROVEMENT_PLAN.md: keeping an eye on the Booking.com AI and teaching it. Pure helpers, no Firestore.
 * Nothing here changes how the AI decides what to say; it only (a) pauses it for one guest when a person asks,
 * (b) scans what it sent for things it must never say, (c) formats the host-approved extra answers.
 */

const TBILISI_OFFSET_MS = 4 * 60 * 60 * 1000;
const OUR_HOST = 'app.maxelaapartments.com';
const MAX_ENTRIES = 25;
const MAX_EXTRA_CHARS = 4000;
const SIGN_LINE = 'This reply was written by our AI assistant.';

const ms = v => (v && typeof v.toMillis === 'function' ? v.toMillis() : v && typeof v.toDate === 'function' ? v.toDate().getTime() : v ? new Date(v).getTime() : NaN);

// ---------------------------------------------------------------- pause AI for one guest

/** Until when the AI stays out of this chat: '24h' or 'checkout' (12:00 Tbilisi on the check-out day). null if it cannot be worked out. */
function pauseUntilMs(mode, conv, nowMs) {
  if (mode === '24h') return nowMs + 24 * 60 * 60 * 1000;
  if (mode === 'checkout') {
    const m = String((conv && conv.checkout) || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return null;
    const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0) - TBILISI_OFFSET_MS;
    return t > nowMs ? t : null;
  }
  return null;
}
const isPaused = (conv, nowMs) => Number(conv && conv.aiPausedUntil) > nowMs;

// ---------------------------------------------------------------- the safety scan

const MONEY_RE = /(?:[€$₾£]\s?\d|\d[\d.,]*\s?(?:€|\$|₾|£|gel|usd|eur|euros?|dollars?|lari|lar)\b)/i;
const PROMISE_RE = /\b(?:refund(?:ed|s|ing)?|reimburs\w*|discount\w*|compensat\w*|money back|free of charge|waive[ds]?|we will pay|we'll pay|complimentary)\b/i;
const CODE_RE = /\b(?:door|lock|elevator|lift|gate|wi-?fi|wifi|network|password|passcode|pin|code)\b[^.\n]{0,40}?\b[A-Za-z0-9#*-]*\d[A-Za-z0-9#*-]{2,}\b/i;
const PHONE_RE = /(?:\+\s?\d[\d\s().-]{6,}\d|\b\d[\d\s().-]{7,}\d\b)/;
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"')]+/gi;

/** What the AI must never say. Returns a list of short plain-words problems (empty = nothing found). */
function scanAiReply(text) {
  const t = String(text || '');
  const flags = [];
  if (MONEY_RE.test(t)) flags.push('a money amount');
  if (PROMISE_RE.test(t)) flags.push('a refund, discount or compensation promise');
  if (CODE_RE.test(t)) flags.push('what looks like a door, elevator or Wi-Fi code');
  if (PHONE_RE.test(t)) flags.push('a phone number');
  for (const m of t.matchAll(URL_RE)) {
    let host = '';
    try { host = new URL(/^https?:/i.test(m[0]) ? m[0] : 'https://' + m[0]).hostname.toLowerCase(); } catch (e) { host = ''; }
    if (host !== OUR_HOST) { flags.push('a link that is not ours'); break; }
  }
  return flags;
}

// ---------------------------------------------------------------- approved extra answers

/** entries: documents of inbox_ai_knowledge. Only approved and switched-on ones count. */
function activeEntries(entries) {
  return (entries || []).filter(e => e && e.status === 'approved' && e.enabled !== false && String(e.question || '').trim() && String(e.answer || '').trim());
}

/** The extra section added after the normal knowledge (Booking.com chats only). Empty string when there are no approved entries. */
function extraKnowledgeText(entries) {
  const list = activeEntries(entries).slice(0, MAX_ENTRIES);
  if (!list.length) return '';
  const lines = ['EXTRA ANSWERS APPROVED BY THE HOST (Booking.com chats only). When a guest asks about one of these, answer with it. It wins over the general text above.'];
  let used = lines[0].length;
  for (const e of list) {
    const q = String(e.question).replace(/\s+/g, ' ').trim().slice(0, 300);
    const a = String(e.answer).replace(/\s+/g, ' ').trim().slice(0, 700);
    const block = `Question: ${q}\nAnswer: ${a}`;
    if (used + block.length > MAX_EXTRA_CHARS) break;
    lines.push(block); used += block.length;
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------- the optional sign-off

/** Adds the short line to the first AI reply in a conversation, only when the setting is on. */
function withSignLine(text, { on, firstAiReply }) {
  if (!on || !firstAiReply) return text;
  return `${text}\n\n${SIGN_LINE}`;
}

const tbilisiDayStartMs = nowMs => { const d = new Date(nowMs + TBILISI_OFFSET_MS); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - TBILISI_OFFSET_MS; };

module.exports = { pauseUntilMs, isPaused, scanAiReply, activeEntries, extraKnowledgeText, withSignLine, SIGN_LINE, tbilisiDayStartMs, ms, MAX_ENTRIES };
