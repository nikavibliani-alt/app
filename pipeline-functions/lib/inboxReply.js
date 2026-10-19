'use strict';
/**
 * Pure helpers for replying to guests from the inbox (step 4, see docs/INBOX_PLAN.md).
 * No Firebase, no network, no clock.
 */

const MAX_REPLY_CHARS = 2000;
const STALE_SENDING_MS = 10 * 60 * 1000;   // "sending" with no report for this long becomes "unknown"
const GUEST_DOMAIN = '@guest.booking.com';

/** Plain text only: no markup, no control characters, no long runs of blank lines. */
function cleanReplyText(input) {
  if (typeof input !== 'string') return { ok: false, error: 'Write a message first.' };
  const text = input
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .split('\n').map(l => l.replace(/[ \t]+$/g, '')).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!text) return { ok: false, error: 'Write a message first.' };
  if (text.length > MAX_REPLY_CHARS) return { ok: false, error: `The message is too long (${text.length} of ${MAX_REPLY_CHARS} characters).` };
  return { ok: true, text };
}

const isBookingNumber = v => typeof v === 'string' && /^\d{6,20}$/.test(v);
const isClientId = v => typeof v === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(v);
const isGuestAddress = v => typeof v === 'string' && v.toLowerCase().endsWith(GUEST_DOMAIN) && /^[^\s<>@]+@guest\.booking\.com$/i.test(v);

/**
 * The Extranet page of a guest's check-in time request, from the saved raw email. Without `option` it is
 * the request page itself with no answer chosen; with option 'confirm' (Accept), 'reject' (Decline) or
 * 'availability' (Subject to availability) it is the link of that answer button in the Booking.com email.
 */
function checkinRequestLink(email, option) {
  const html = String((email && email.bodyHtml) || '').replace(/&amp;/gi, '&');
  const m = html.match(/href="(https:\/\/admin\.booking\.com\/hotel\/hoteladmin\/extranet_ng\/manage\/messaging\/self_service\.html\?[^"]+)"/i);
  if (!m) return null;
  let u;
  try { u = new URL(m[1]); } catch (e) { return null; }
  const hotel = u.searchParams.get('hotel_id');
  const req = u.searchParams.get('ss_request_id');
  if (!/^\d{3,}$/.test(hotel || '') || !/^\d{3,}$/.test(req || '')) return null;
  const opt = ['confirm', 'reject', 'availability'].includes(option) ? `&option=${option}` : '';   // no option = just the request page
  return `https://admin.booking.com/hotel/hoteladmin/extranet_ng/manage/messaging/self_service.html?form_key=partner_approval&hotel_id=${hotel}&ss_request_id=${req}${opt}`;
}

module.exports = {
  MAX_REPLY_CHARS, STALE_SENDING_MS, GUEST_DOMAIN,
  cleanReplyText, isBookingNumber, isClientId, isGuestAddress, checkinRequestLink,
};
