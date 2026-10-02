'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { downloadMetaMedia, photosToAttach, attachPhotos, MAX_IMAGES, UNSEEN_PHOTO } = require('./metaMedia');

const TOKEN = 'META-TEST-TOKEN';
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

/** Fake fetch: media lookup JSON at graph.facebook.com/{id}, then the file at its URL. */
function fakeMeta({ lookup = { url: 'https://lookaside.example/abc', mime_type: 'image/jpeg', file_size: JPEG.length }, lookupStatus = 200, file = JPEG, fileStatus = 200, hang = false } = {}) {
  const calls = [];
  const fetchImpl = (url, init) => {
    calls.push({ url, auth: init.headers.Authorization });
    if (hang) return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    if (url.startsWith('https://graph.facebook.com/')) return Promise.resolve({ ok: lookupStatus === 200, status: lookupStatus, json: async () => lookup });
    return Promise.resolve({ ok: fileStatus === 200, status: fileStatus, arrayBuffer: async () => file.buffer.slice(file.byteOffset, file.byteOffset + file.length) });
  };
  return { fetchImpl, calls };
}

test('downloadMetaMedia: media id -> URL -> bytes, both with the access token', async () => {
  const f = fakeMeta();
  const r = await downloadMetaMedia({ mediaId: '123', accessToken: TOKEN, fetchImpl: f.fetchImpl });
  assert.deepEqual(r, { ok: true, mimeType: 'image/jpeg', base64: JPEG.toString('base64'), bytes: JPEG.length });
  assert.equal(f.calls[0].url, 'https://graph.facebook.com/v19.0/123');
  assert.equal(f.calls[1].url, 'https://lookaside.example/abc');
  assert.ok(f.calls.every((c) => c.auth === `Bearer ${TOKEN}`));
});

test('downloadMetaMedia failures fall back cleanly (never throws)', async (t) => {
  await t.test('media expired / unknown id', async () => {
    const r = await downloadMetaMedia({ mediaId: 'x', accessToken: TOKEN, fetchImpl: fakeMeta({ lookupStatus: 400, lookup: { error: { message: 'Invalid media id' } } }).fetchImpl });
    assert.deepEqual(r, { ok: false, reason: 'media lookup failed (HTTP 400: Invalid media id)' });
  });
  await t.test('file download fails', async () => {
    const r = await downloadMetaMedia({ mediaId: 'x', accessToken: TOKEN, fetchImpl: fakeMeta({ fileStatus: 404 }).fetchImpl });
    assert.equal(r.ok, false);
    assert.match(r.reason, /HTTP 404/);
  });
  await t.test('unsupported type (e.g. HEIC)', async () => {
    const r = await downloadMetaMedia({ mediaId: 'x', accessToken: TOKEN, fetchImpl: fakeMeta({ lookup: { url: 'u', mime_type: 'image/heic' } }).fetchImpl });
    assert.deepEqual(r, { ok: false, reason: 'unsupported image type image/heic' });
  });
  await t.test('too large for Claude', async () => {
    const r = await downloadMetaMedia({ mediaId: 'x', accessToken: TOKEN, fetchImpl: fakeMeta({ lookup: { url: 'u', mime_type: 'image/jpeg', file_size: 6 * 1024 * 1024 } }).fetchImpl });
    assert.equal(r.ok, false);
    assert.match(r.reason, /too large/);
  });
  await t.test('timeout', async () => {
    const r = await downloadMetaMedia({ mediaId: 'x', accessToken: TOKEN, fetchImpl: fakeMeta({ hang: true }).fetchImpl, timeoutMs: 20 });
    assert.deepEqual(r, { ok: false, reason: 'media download timed out after 20 ms' });
  });
  await t.test('network error', async () => {
    const r = await downloadMetaMedia({ mediaId: 'x', accessToken: TOKEN, fetchImpl: () => Promise.reject(new TypeError('fetch failed')) });
    assert.deepEqual(r, { ok: false, reason: 'media download error: fetch failed' });
  });
  await t.test('the access token never appears in a failure reason', async () => {
    const r = await downloadMetaMedia({ mediaId: 'x', accessToken: TOKEN, fetchImpl: fakeMeta({ lookupStatus: 401, lookup: { error: { message: 'bad token' } } }).fetchImpl });
    assert.ok(!r.reason.includes(TOKEN));
  });
});

test('photosToAttach: only photos in the unanswered batch, newest few', () => {
  const unanswered = [
    { content: 'hello' },
    { content: '[image]', media: { type: 'image', id: 'p1' } },
    { content: '[sticker]' },
    { content: '[image] how I open this', media: { type: 'image', id: 'p2' } },
  ];
  assert.deepEqual(photosToAttach(unanswered), [{ index: 1, mediaId: 'p1' }, { index: 3, mediaId: 'p2' }]);
  const many = Array.from({ length: 7 }, (_, i) => ({ content: '[image]', media: { type: 'image', id: `p${i}` } }));
  assert.deepEqual(photosToAttach(many).map((p) => p.mediaId), ['p3', 'p4', 'p5', 'p6'], `newest ${MAX_IMAGES} only`);
  assert.deepEqual(photosToAttach(undefined), []);
});

test('attachPhotos: downloaded photos become image blocks; every photo Claude cannot see is labelled as such', () => {
  const messages = [
    { role: 'user', content: '[2 days ago] [image]' }, // older photo in history: stays text
    { role: 'assistant', content: '[2 days ago] Sorry, we are unable to view the photo right now.' },
    { role: 'user', content: '[1 min ago] [image] how I open this' }, // unanswered index 0
    { role: 'user', content: '[just now] [image]' }, // unanswered index 1, download failed
  ];
  const downloads = new Map([[0, { ok: true, mimeType: 'image/jpeg', base64: 'AAAA' }], [1, { ok: false, reason: 'expired' }]]);
  const out = attachPhotos(messages, 2, downloads);
  assert.equal(UNSEEN_PHOTO, '[photo you cannot see]');
  assert.equal(out[0].content, '[2 days ago] [photo you cannot see]', 'older photo in history');
  assert.equal(out[1].content, messages[1].content, 'bot turns untouched');
  assert.deepEqual(out[2].content, [
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } },
    { type: 'text', text: '[1 min ago] [image] how I open this' },
  ]);
  assert.equal(out[3].content, '[just now] [photo you cannot see]', 'failed download: Claude is told it cannot see it');
  assert.equal(out[2].content[1].text, '[1 min ago] [image] how I open this', 'an attached photo keeps "[image]" next to the real image');
  assert.equal(messages[0].content, '[2 days ago] [image]', 'input not mutated');
});
