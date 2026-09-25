'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { applyToneGuard } = require('./toneGuard');

test('exclamation marks become periods', async (t) => {
  await t.test('English', () => {
    assert.equal(applyToneGuard('Hi Roman, great to hear from you! How can I help?'), 'Hi Roman, great to hear from you. How can I help?');
    assert.equal(applyToneGuard('Welcome!!'), 'Welcome.');
    assert.equal(applyToneGuard('Thanks!!! 😊'), 'Thanks. 😊');
    assert.equal(applyToneGuard('Really!?'), 'Really?', '"!?" keeps just the question mark');
    assert.equal(applyToneGuard('Really?!'), 'Really?');
    assert.equal(applyToneGuard('Great!.'), 'Great.', 'no double period');
    assert.equal(applyToneGuard('Let me think... ok'), 'Let me think... ok', 'a real ellipsis is kept');
  });
  await t.test('Georgian', () => {
    assert.equal(applyToneGuard('გამარჯობა! რით შემიძლია დაგეხმაროთ?'), 'გამარჯობა. რით შემიძლია დაგეხმაროთ?');
    assert.equal(applyToneGuard('დიდი მადლობა!!'), 'დიდი მადლობა.');
  });
  await t.test('Russian', () => {
    assert.equal(applyToneGuard('Здравствуйте! Чем могу помочь?'), 'Здравствуйте. Чем могу помочь?');
    assert.equal(applyToneGuard('Спасибо!!'), 'Спасибо.');
  });
});

test('em dashes become ", "', async (t) => {
  await t.test('English', () => {
    assert.equal(applyToneGuard('Good, thanks — and you? How can I help?'), 'Good, thanks, and you? How can I help?');
    assert.equal(applyToneGuard('Hello, good thanks—and you?'), 'Hello, good thanks, and you?');
    assert.equal(applyToneGuard('Sure — Booking.com or Expedia — we don\'t take direct bookings.'), 'Sure, Booking.com or Expedia, we don\'t take direct bookings.');
    assert.equal(applyToneGuard('Checkout is at 12:00 —.'), 'Checkout is at 12:00.', 'no ", ." left behind');
    assert.equal(applyToneGuard('— Hello'), 'Hello', 'no leading comma');
    assert.equal(applyToneGuard('See you soon —'), 'See you soon', 'no trailing comma');
    assert.equal(applyToneGuard('First line —\nSecond line'), 'First line,\nSecond line');
  });
  await t.test('Georgian', () => {
    assert.equal(applyToneGuard('კარგად — თქვენ? რით შემიძლია დაგეხმაროთ?'), 'კარგად, თქვენ? რით შემიძლია დაგეხმაროთ?');
  });
  await t.test('Russian', () => {
    assert.equal(applyToneGuard('Хорошо — а вы?'), 'Хорошо, а вы?');
  });
  await t.test('en dash and hyphen are left alone', () => {
    assert.equal(applyToneGuard('Room 6-2, 15:00–16:00'), 'Room 6-2, 15:00–16:00');
  });
});

test('links are never changed', async (t) => {
  await t.test('bare link from the prompt, with "!" after it', () => {
    assert.equal(
      applyToneGuard('Please fill in this form: app.maxelaapartments.com/checkin-guest!'),
      'Please fill in this form: app.maxelaapartments.com/checkin-guest.',
    );
  });
  await t.test('https link, dash and "!" around it', () => {
    assert.equal(
      applyToneGuard('Location — https://maps.app.goo.gl/LArVmJASytmQdReJA! Cash only!'),
      'Location, https://maps.app.goo.gl/LArVmJASytmQdReJA. Cash only.',
    );
  });
  await t.test('"!" and "—" inside a link survive', () => {
    const url = 'https://example.com/a!b—c?x=1!';
    assert.equal(applyToneGuard(`Here: ${url} thanks!`), `Here: ${url.slice(0, -1)}. thanks.`, 'trailing "!" is sentence punctuation');
    assert.equal(applyToneGuard('Open www.example.com/path!!x now!'), 'Open www.example.com/path!!x now.');
  });
  await t.test('booking link followed by a dash keeps its space', () => {
    assert.equal(
      applyToneGuard('Book here booking.com/Share-PaJ0WC — select the right unit type!'),
      'Book here booking.com/Share-PaJ0WC, select the right unit type.',
    );
  });
});

test('replies without "!" or "—" are unchanged', () => {
  const reply = 'We do not have private parking, but there is paid parking under Carrefour. Daily rate is 15 GEL, cash only.';
  assert.equal(applyToneGuard(reply), reply);
  assert.equal(applyToneGuard('შევამოწმებ და გაგაგებინებთ მალე.'), 'შევამოწმებ და გაგაგებინებთ მალე.');
  assert.equal(applyToneGuard(''), '');
});
