'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { describeInbound } = require('./inboundContent');

test('text', () => {
  assert.deepEqual(describeInbound({ type: 'text', text: { body: 'Where is the parking?' } }), { content: 'Where is the parking?', media: null, action: 'reply' });
});

test('photo: media id kept (never the image), caption kept, bot runs', async (t) => {
  await t.test('with caption', () => {
    assert.deepEqual(describeInbound({ type: 'image', image: { id: '123456', mime_type: 'image/jpeg', caption: '  how I open\nthis ' } }), {
      content: '[image] how I open this',
      media: { type: 'image', id: '123456', mimeType: 'image/jpeg' },
      action: 'reply',
    });
  });
  await t.test('without caption', () => {
    const r = describeInbound({ type: 'image', image: { id: '789', mime_type: 'image/jpeg' } });
    assert.equal(r.content, '[image]');
    assert.equal(r.media.id, '789');
  });
  await t.test('no media id: still "[image]", nothing to download', () => {
    assert.deepEqual(describeInbound({ type: 'image', image: {} }), { content: '[image]', media: null, action: 'reply' });
  });
});

test('reaction: ignored (not stored, no bot run, no alert)', () => {
  assert.deepEqual(describeInbound({ type: 'reaction', reaction: { message_id: 'wamid.X', emoji: '👍' } }), { content: '[reaction: 👍]', media: null, action: 'ignore' });
  assert.equal(describeInbound({ type: 'reaction', reaction: { message_id: 'wamid.X' } }).action, 'ignore', 'reaction removed');
});

test('sticker: stored, no bot run of its own', () => {
  assert.deepEqual(describeInbound({ type: 'sticker', sticker: { id: 's1', mime_type: 'image/webp', animated: false } }), { content: '[sticker]', media: null, action: 'store_only' });
});

test('location: name/address and coordinates', async (t) => {
  await t.test('full', () => {
    assert.equal(
      describeInbound({ type: 'location', location: { latitude: 41.7151, longitude: 44.8271, name: 'Clean House Market', address: 'Zhiuli Shartava 35' } }).content,
      '[location: Clean House Market, Zhiuli Shartava 35, 41.7151, 44.8271]',
    );
  });
  await t.test('pin only', () => {
    assert.deepEqual(describeInbound({ type: 'location', location: { latitude: 41.7, longitude: 44.8 } }), { content: '[location: 41.7, 44.8]', media: null, action: 'reply' });
  });
  await t.test('zero coordinates are kept', () => {
    assert.equal(describeInbound({ type: 'location', location: { latitude: 0, longitude: 0 } }).content, '[location: 0, 0]');
  });
});

test('document: filename and caption', () => {
  assert.deepEqual(describeInbound({ type: 'document', document: { id: 'd1', filename: 'booking.pdf', mime_type: 'application/pdf' } }), { content: '[document: booking.pdf]', media: null, action: 'reply' });
  assert.equal(describeInbound({ type: 'document', document: { filename: 'passport.jpg', caption: 'for check-in' } }).content, '[document: passport.jpg] for check-in');
  assert.equal(describeInbound({ type: 'document', document: {} }).content, '[document: file]');
});

test('button replies use the button text', () => {
  assert.deepEqual(describeInbound({ type: 'button', button: { text: 'Yes, arriving today', payload: 'ARRIVING' } }), { content: 'Yes, arriving today', media: null, action: 'reply' });
  assert.equal(describeInbound({ type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'b1', title: 'Late checkout' } } }).content, 'Late checkout');
  assert.equal(describeInbound({ type: 'interactive', interactive: { type: 'list_reply', list_reply: { id: 'l1', title: 'Parking' } } }).content, 'Parking');
  assert.equal(describeInbound({ type: 'button', button: {} }).content, '[unsupported]', 'empty button text');
});

test('video, audio and unknown types', () => {
  assert.equal(describeInbound({ type: 'video', video: { id: 'v1', caption: 'the tap' } }).content, '[video] the tap');
  assert.equal(describeInbound({ type: 'video', video: { id: 'v1' } }).content, '[video]');
  assert.equal(describeInbound({ type: 'audio', audio: { id: 'a1', voice: true } }).content, '[audio]');
  assert.equal(describeInbound({ type: 'contacts', contacts: [] }).content, '[unsupported]');
  assert.equal(describeInbound({ type: 'unsupported' }).action, 'reply');
  assert.equal(describeInbound(undefined).content, '[unsupported]');
});
