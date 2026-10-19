'use strict';
// All emails here are made up. They copy the shape of real Booking.com emails, not their content.
const test = require('node:test');
const assert = require('node:assert');
const { sortEmail, messageFromText, parseDate, scriptOf } = require('../lib/inboxSort');

const DETAILS = (num) => `
   Reservation Details

   Guest name:
   Test Guest

   Check-in:
   Mon, Nov 9, 2026

   Check-out:
   Thu, Nov 19, 2026

   Property Name:
   Demo Apartment

   Booking Number:
   ${num}

   Total guests:
   2
`;

function chatEmail(over = {}) {
  const num = over.num || '1000000001';
  return {
    from: `"Test Guest through Booking.com" <${num}-ab12.cd34.ef56.gh78@guest.booking.com>`,
    replyTo: `${num}-ab12.cd34.ef56.gh78@guest.booking.com`,
    subject: 'We received this message from Test Guest',
    date: '2026-10-01T10:00:00.000Z',
    bodyText: `   ##- Please type your reply above this line -##

                       Confirmation number: ${num}

                     You have a new message from a guest

                           Test Guest said:

   Hello, this is the first line of a message that was
   wrapped by the mail system at about seventy characters.

   Reply

                                     -->
   https://admin.booking.com/hotel/hoteladmin/extranet_ng/manage/messaging
   /inbox.html?product_type=POST_BOOKING&product_id=${num}&lang=xu&hotel_i
   d=555123&res_id=${num}&message_id=aaaa1111-b4c1-11f1-8791-f9cc85dd2571&utm_c
   ampaign=x
${DETAILS(num)}`,
    bodyHtml: over.html !== undefined ? over.html : `<html><body><table><tr><td><p>Test Guest said:</p></td></tr></table>
      <table><tr><td><img src="cid:x" /></td><td>
      <p style="font-size: 16px;">Hello, this is the first line<br />
      <br />
      Second paragraph &amp; more.<br />
      Third line.
      </p></td></tr></table>
      <a href="https://admin.booking.com/x?a=1&amp;message_id=aaaa1111-b4c1-11f1-8791-f9cc85dd2571&amp;b=2">Reply</a>
      </body></html>`,
    ...over.fields,
  };
}

test('guest chat message: text, ids and booking info', () => {
  const r = sortEmail(chatEmail());
  assert.strictEqual(r.kind, 'chat');
  assert.strictEqual(r.bookingNumber, '1000000001');
  assert.strictEqual(r.text, 'Hello, this is the first line\n\nSecond paragraph & more.\nThird line.');
  assert.strictEqual(r.messageId, 'aaaa1111-b4c1-11f1-8791-f9cc85dd2571');
  assert.strictEqual(r.sentAt, '2026-10-01T10:00:00.000Z');
  assert.strictEqual(r.guestName, 'Test Guest');
  assert.strictEqual(r.propertyName, 'Demo Apartment');
  assert.strictEqual(r.checkin, '2026-11-09');
  assert.strictEqual(r.checkout, '2026-11-19');
  assert.strictEqual(r.replyTo, '1000000001-ab12.cd34.ef56.gh78@guest.booking.com');
  assert.strictEqual(r.script, 'latin');
  assert.strictEqual(r.hotelId, "555123");
});

test('guest chat message: falls back to plain text and unwraps lines', () => {
  const r = sortEmail(chatEmail({ html: '' }));
  assert.strictEqual(r.kind, 'chat');
  assert.strictEqual(
    r.text,
    'Hello, this is the first line of a message that was wrapped by the mail system at about seventy characters.'
  );
  assert.strictEqual(r.messageId, 'aaaa1111-b4c1-11f1-8791-f9cc85dd2571');
});

test('guest chat: reply-to with a display name still gives a clean address', () => {
  const r = sortEmail(chatEmail({ fields: { replyTo: '"Test Guest through Booking.com" <1000000001-ab12.cd34.ef56.gh78@guest.booking.com>' } }));
  assert.strictEqual(r.replyTo, '1000000001-ab12.cd34.ef56.gh78@guest.booking.com');
});

test('guest chat: non-latin text is detected', () => {
  const html = '<p>x said:</p><table><td><p>გამარჯობა</p></td></table>';
  const r = sortEmail(chatEmail({ html }));
  assert.strictEqual(r.kind, 'chat');
  assert.strictEqual(r.script, 'georgian');
});

test('guest message without readable text goes to check-this pile', () => {
  const r = sortEmail(chatEmail({ html: '<p>nothing</p>', fields: { bodyText: 'Booking Number: 1000000001\nno marker' } }));
  assert.strictEqual(r.kind, 'review');
  assert.match(r.reason, /could not be read/);
});

test('guest message without a booking number goes to check-this pile', () => {
  const r = sortEmail(chatEmail({ fields: { bodyText: 'Test Guest said:\nhi\nReply\n', replyTo: 'x@guest.booking.com', from: 'x@guest.booking.com' } }));
  assert.strictEqual(r.kind, 'review');
});

test('check-in time request is not a chat message', () => {
  const r = sortEmail({
    from: '"Test Guest through Booking.com" <1000000002-ab12.cd34.ef56.gh78@guest.booking.com>',
    replyTo: '"Test Guest through Booking.com" <1000000002-ab12.cd34.ef56.gh78@guest.booking.com>',
    subject: 'We received this message from Test Guest',
    date: '2026-10-02T08:00:00.000Z',
    bodyText: `Booking Number: 1000000002
   You have a new message from a guest
   Test Guest said:
   I want to request check-in at 06:00 - 07:00. Is this okay?
   Accept for free
     ______
   Not accepted
${DETAILS('1000000002')}`,
    bodyHtml: '<p>Test Guest said:</p><p>I want to request check-in at 06:00 - 07:00. Is this okay?</p>',
  });
  assert.strictEqual(r.kind, 'checkin_request');
  assert.strictEqual(r.bookingNumber, '1000000002');
  assert.strictEqual(r.requestedTime, '06:00 - 07:00');
  assert.strictEqual(r.sentAt, '2026-10-02T08:00:00.000Z');
});

test('request confirmed by Booking.com is booking info', () => {
  const r = sortEmail({
    from: '"Booking.com" <noreply@booking.com>',
    replyTo: 'noreply@booking.com',
    subject: 'Test Guest’s request has been confirmed',
    date: '2026-10-03T08:00:00.000Z',
    bodyText: `Confirmation number: 1000000003
   This guest received an automatic reply
   Test Guest said:
   I want to request check-in at 23:00 - 24:00. Is this okay?
   Confirmed free of charge
${DETAILS('1000000003')}`,
    bodyHtml: '',
  });
  assert.strictEqual(r.kind, 'auto_confirmed');
  assert.strictEqual(r.bookingNumber, '1000000003');
  assert.strictEqual(r.requestedTime, '23:00 - 24:00');
});

test('cancellation request gets a deadline from the email', () => {
  const base = {
    from: '"Test Guest through Booking.com" <1000000004-ab12.cd34.ef56.gh78@property.booking.com>',
    replyTo: '1000000004-ab12.cd34.ef56.gh78@property.booking.com',
    subject: 'Your guest would like to cancel for free',
    date: '2026-10-04T08:00:00.000Z',
    bodyText: 'Booking Number: 1000000004\n   You have a guest who would like to cancel for free\n   Please respond within the next 12 hours\n',
    bodyHtml: '',
  };
  const r = sortEmail(base);
  assert.strictEqual(r.kind, 'cancel_request');
  assert.strictEqual(r.bookingNumber, '1000000004');
  assert.strictEqual(r.deadline, '2026-10-04T20:00:00.000Z');
  const r2 = sortEmail({ ...base, bodyText: base.bodyText.replace('12 hours', '24 hours') });
  assert.strictEqual(r2.deadline, '2026-10-05T08:00:00.000Z');
  const r3 = sortEmail({ ...base, bodyText: 'Booking Number: 1000000004\nno deadline here' });
  assert.strictEqual(r3.deadline, '2026-10-04T20:00:00.000Z');
});

test('system emails are hidden', () => {
  const mk = (from, subject) => sortEmail({ from, subject, date: '2026-10-05T00:00:00Z', bodyText: '', bodyHtml: '' });
  assert.deepStrictEqual(mk('Booking.com <noreply@booking.com>', '7 guest messages waiting for you'), { kind: 'hidden', reason: 'digest' });
  assert.deepStrictEqual(mk('Booking.com <noreply@booking.com>', '1 guest message is waiting for you'), { kind: 'hidden', reason: 'digest' });
  assert.strictEqual(mk('noreply@booking.com', 'You have GEL 12.30 on uncharged virtual cards').kind, 'hidden');
  assert.strictEqual(mk('noreply@booking.com', 'Booking.com Invoice 123').kind, 'hidden');
  assert.strictEqual(mk('noreply@booking.com', 'Payment in progress: Check status on the Extranet').kind, 'hidden');
  assert.strictEqual(mk('no-reply@properties.booking.com', 'Set up a Deal').kind, 'hidden');
  assert.strictEqual(mk('x@support.booking.com', 'Important update').kind, 'hidden');
});

test('pre-booking question and unknown mail go to the check-this pile', () => {
  const mk = (from, subject) => sortEmail({ from, subject, date: '2026-10-05T00:00:00Z', bodyText: '', bodyHtml: '' });
  const q = mk('noreply@booking.com', 'You just received a new question about your property');
  assert.strictEqual(q.kind, 'review');
  assert.match(q.reason, /before booking/);
  assert.strictEqual(mk('noreply@booking.com', 'Something new we never saw').kind, 'review');
  assert.strictEqual(mk('someone@example.com', 'hello').kind, 'review');
  assert.strictEqual(mk('x@guest.booking.com', 'Different subject').kind, 'review');
});

test('garbage input does not throw', () => {
  assert.strictEqual(sortEmail(undefined).kind, 'review');
  assert.strictEqual(sortEmail({}).kind, 'review');
  assert.strictEqual(sortEmail({ from: 5, subject: null, bodyText: 7 }).kind, 'review');
});

test('helpers', () => {
  assert.strictEqual(parseDate('Monday, November 9, 2026'), '2026-11-09');
  assert.strictEqual(parseDate('Sun, Oct 25, 2026'), '2026-10-25');
  assert.strictEqual(parseDate('nonsense'), null);
  assert.strictEqual(messageFromText('x said:\nline one\n  line two\n\nReply\n'), 'line one line two');
  assert.strictEqual(scriptOf('привет'), 'cyrillic');
});
