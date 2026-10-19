'use strict';
/**
 * Sorting rules for the Booking.com guest inbox (step 2, see docs/INBOX_PLAN.md).
 *
 * Pure functions only: no Firebase, no network, no clock. Give it a saved raw email
 * ({from, replyTo, subject, date, bodyText, bodyHtml}) and it says what the email is.
 *
 * sortEmail(email) returns one of:
 *   { kind: 'chat',            bookingNumber, text, messageId, sentAt, guestName, propertyName, checkin, checkout, replyTo, script }
 *   { kind: 'checkin_request', bookingNumber, requestedTime, sentAt, ...booking info }
 *   { kind: 'auto_confirmed',  bookingNumber, requestedTime, sentAt, ...booking info }
 *   { kind: 'cancel_request',  bookingNumber, sentAt, deadline, ...booking info }
 *   { kind: 'hidden',          reason }
 *   { kind: 'review',          reason }       the "check this" pile
 * Anything that cannot be read ends up as 'review', never dropped.
 */

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const DEFAULT_CANCEL_HOURS = 12;

function senderAddress(from) {
  const s = String(from || '');
  const m = s.match(/<([^>]+)>/);
  return (m ? m[1] : s).trim().toLowerCase();
}

function senderDomain(from) {
  const a = senderAddress(from);
  const i = a.lastIndexOf('@');
  return i < 0 ? '' : a.slice(i + 1);
}

function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeChar(parseInt(d, 10)));
}

function safeChar(n) {
  try { return String.fromCodePoint(n); } catch (e) { return ''; }
}

function cleanLines(s) {
  return String(s)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(l => l.replace(/[ \t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * The guest's words from the HTML part. The message sits in the first text block after
 * "<name> said:". Real line breaks are <br> tags; the newlines in the HTML source are only
 * layout and are ignored.
 */
function messageFromHtml(html) {
  const h = String(html || '');
  const i = h.search(/\bsaid:/i);
  if (i < 0) return null;
  const rest = h.slice(i + 5);
  const re = /<(p|span|div|td)\b[^>]*>([^<]*(?:<br\s*\/?>[^<]*)*)<\/\1>/gi;
  let m;
  while ((m = re.exec(rest))) {
    const raw = m[2]
      .replace(/\s*\n\s*/g, ' ')
      .replace(/<br\s*\/?>/gi, '\n');
    const text = cleanLines(decodeEntities(raw));
    if (text) return text;
    if (m.index > 6000) break;
  }
  return null;
}

/**
 * Fallback: the guest's words from the plain-text part, between "<name> said:" and the
 * "Reply" line (or the first answer button). The text part is hard-wrapped at about 72
 * characters, so the lines are joined with spaces.
 */
function messageFromText(text) {
  const t = String(text || '').replace(/\r\n?/g, '\n');
  const m = t.match(/\bsaid:[ \t]*\n([\s\S]*?)\n[ \t]*(?:Reply|Accept for free)[ \t]*\n/);
  if (!m) return null;
  const out = m[1].split('\n').map(l => l.trim()).filter(Boolean).join(' ');
  return out || null;
}

function guestMessageText(email) {
  return messageFromHtml(email.bodyHtml) || messageFromText(email.bodyText);
}

function parseDate(s) {
  // "Mon, Nov 9, 2026" or "Monday, November 9, 2026" -> "2026-11-09"
  const m = String(s || '').match(/([A-Za-z]{3})[A-Za-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/);
  if (!m) return null;
  const mon = MONTHS[m[1].toLowerCase()];
  if (!mon) return null;
  return `${m[3]}-${String(mon).padStart(2, '0')}-${String(parseInt(m[2], 10)).padStart(2, '0')}`;
}

/** Value after "Label:" on the same line or the next non-empty line. */
function labelValue(text, label) {
  const re = new RegExp(label + ':[ \\t]*\\n?[ \\t]*([^\\n]+)', 'i');
  const m = String(text || '').match(re);
  return m ? m[1].trim() : null;
}

function bookingNumber(email) {
  const t = String(email.bodyText || '');
  const m = t.match(/(?:Booking Number|Confirmation number):\s*(\d{6,})/i);
  if (m) return m[1];
  const r = senderAddress(email.replyTo || '').match(/^(\d{6,})-/);
  if (r) return r[1];
  const f = senderAddress(email.from || '').match(/^(\d{6,})-/);
  return f ? f[1] : null;
}

function replyToAddress(email) {
  const a = senderAddress(email.replyTo || email.from || '');
  return a.includes('@') ? a : null;
}

function messageId(email) {
  const flat = String(email.bodyHtml || '').replace(/&amp;/gi, '&') + '\n' +
    String(email.bodyText || '').replace(/\n\s*/g, '');
  const m = flat.match(/[?&]message_id=([0-9a-f-]{8,})/i);
  return m ? m[1] : null;
}

/** Booking.com property id from the Extranet link in the email (needed to open the chat). */
function hotelId(email) {
  const flat = String(email.bodyHtml || '').replace(/&amp;/gi, '&') + '\n' +
    String(email.bodyText || '').replace(/\n\s*/g, '');
  const m = flat.match(/[?&]hotel_id=(\d{3,})/i);
  return m ? m[1] : null;
}

function emailDate(email) {
  const d = new Date(email.date);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function scriptOf(text) {
  const t = String(text || '');
  if (/[Ⴀ-ჿ]/.test(t)) return 'georgian';
  if (/[Ѐ-ӿ]/.test(t)) return 'cyrillic';
  if (/[֐-׿]/.test(t)) return 'hebrew';
  if (/[؀-ۿ]/.test(t)) return 'arabic';
  if (/[Ͱ-Ͽ]/.test(t)) return 'greek';
  if (/[一-鿿぀-ヿ가-힯]/.test(t)) return 'cjk';
  return 'latin';
}

function bookingInfo(email) {
  const t = String(email.bodyText || '');
  return {
    bookingNumber: bookingNumber(email),
    hotelId: hotelId(email),
    guestName: labelValue(t, 'Guest name'),
    propertyName: labelValue(t, 'Property Name'),
    checkin: parseDate(labelValue(t, 'Check-in')),
    checkout: parseDate(labelValue(t, 'Check-out')),
    replyTo: replyToAddress(email),
    sentAt: emailDate(email),
  };
}

function requestedTime(email) {
  const flat = String(email.bodyText || '').replace(/\s+/g, ' ');
  const m = flat.match(/request check-in at (\d{1,2}[:.]\d{2})\s*[-–]\s*(\d{1,2}[:.]\d{2})/i);
  return m ? `${m[1].replace('.', ':')} - ${m[2].replace('.', ':')}` : null;
}

const review = reason => ({ kind: 'review', reason });
const hidden = reason => ({ kind: 'hidden', reason });

function sortGuestDomain(email) {
  const subject = String(email.subject || '');
  if (!/we received this message from/i.test(subject)) return review('guest address, unknown subject');
  const info = bookingInfo(email);
  if (!info.bookingNumber) return review('guest message without a booking number');

  if (requestedTime(email) && /Accept for free/i.test(email.bodyText || '')) {
    return { kind: 'checkin_request', ...info, requestedTime: requestedTime(email) };
  }
  const text = guestMessageText(email);
  if (!text) return review('guest message text could not be read');
  return {
    kind: 'chat',
    ...info,
    text,
    messageId: messageId(email),
    script: scriptOf(text),
  };
}

function sortEmail(email) {
  const r = sortEmailInner(email);
  if (r.bookingNumber && !r.sentAt) return review('email date missing or unreadable');
  return r;
}

function sortEmailInner(email) {
  const e = email || {};
  const domain = senderDomain(e.from);
  const subject = String(e.subject || '');

  if (domain === 'guest.booking.com') return sortGuestDomain(e);

  if (domain === 'property.booking.com' && /would like to cancel/i.test(subject)) {
    const info = bookingInfo(e);
    if (!info.bookingNumber) return review('cancellation request without a booking number');
    if (!info.sentAt) return review('cancellation request without a date');
    const h = String(e.bodyText || '').replace(/\s+/g, ' ').match(/within the next (\d{1,3}) hours?/i);
    const hours = h ? parseInt(h[1], 10) : DEFAULT_CANCEL_HOURS;
    const deadline = new Date(new Date(info.sentAt).getTime() + hours * 3600 * 1000).toISOString();
    return { kind: 'cancel_request', ...info, deadline };
  }

  if (domain === 'booking.com') {
    if (/request has been confirmed/i.test(subject)) {
      const info = bookingInfo(e);
      if (!info.bookingNumber) return review('auto-confirmed request without a booking number');
      return { kind: 'auto_confirmed', ...info, requestedTime: requestedTime(e) };
    }
    if (/guest messages? (?:(?:is|are) )?waiting/i.test(subject)) return hidden('digest');
    if (/uncharged virtual cards|invoice|payment in progress/i.test(subject)) return hidden('finance or payment');
    if (/new question about your property/i.test(subject)) return review('question before booking, no booking number');
    return review('unknown email from booking.com');
  }

  if (domain === 'properties.booking.com') return hidden('marketing or policy');
  if (domain === 'support.booking.com') return hidden('security or system notice');

  return review('unknown sender');
}

module.exports = {
  sortEmail,
  guestMessageText,
  messageFromHtml,
  messageFromText,
  parseDate,
  senderAddress,
  senderDomain,
  scriptOf,
};
