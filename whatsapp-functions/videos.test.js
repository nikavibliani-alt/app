'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MEDIA, mediaFor, whatsappVideoLink, textWithoutMedia, capMediaResend, checkMediaLink } = require('./videos');

const BAG = '1804812277340997';
const HOT = '1819258012553462';
const PARK = '975338858914982';

test('media catalog: bag storage = 2 photos, parking = 1 video, all by permanent Cloudinary link', () => {
  assert.deepEqual(Object.keys(MEDIA).sort(), [BAG, HOT, PARK].sort());
  const bag = mediaFor(BAG);
  assert.deepEqual(bag.items.map((i) => i.type), ['image', 'image']);
  assert.match(bag.items[0].link, /maxela\/info\/bag-storage-1-building\.jpg$/, 'building first');
  assert.match(bag.items[1].link, /maxela\/info\/bag-storage-2-glass-door\.jpg$/, 'glass door second');
  const park = mediaFor(PARK);
  assert.deepEqual(park.items, [{ type: 'video', link: 'https://res.cloudinary.com/dlkjizhya/video/upload/f_mp4,vc_h264,ac_aac,q_auto,w_720,c_limit/maxela/info/parking.mp4' }]);
  assert.deepEqual(mediaFor(HOT).items, [], 'hot water: no permanent file yet');
  for (const m of Object.values(MEDIA)) {
    for (const i of m.items) assert.match(i.source, /^https:\/\/res\.cloudinary\.com\/dlkjizhya\//, 'never a Meta media id');
  }
  assert.equal(mediaFor('123'), null, 'unknown id');
});

test('text-only versions: never mention a photo or video; bag storage has the code and the landmarks', () => {
  for (const [id, m] of Object.entries(MEDIA)) {
    assert.ok(m.fallback.en && m.fallback.ka, id);
    assert.doesNotMatch(m.fallback.en, /video|photo|picture/i, id);
    assert.doesNotMatch(m.fallback.ka, /ვიდეო|ფოტო/, id);
  }
  const bag = MEDIA[BAG].fallback;
  assert.match(bag.en, /13 24 13#/);
  assert.match(bag.en, /Clean House/);
  assert.match(bag.en, /glass door/);
  assert.match(bag.en, /camera/);
  assert.match(bag.en, /valuables/);
  assert.match(bag.ka, /13 24 13#/);
});

test('whatsappVideoLink: any Cloudinary video link becomes a WhatsApp-ready MP4 link', () => {
  const out = 'https://res.cloudinary.com/dlkjizhya/video/upload/f_mp4,vc_h264,ac_aac,q_auto,w_720,c_limit/maxela/info/abc123.mp4';
  assert.equal(whatsappVideoLink('https://res.cloudinary.com/dlkjizhya/video/upload/v1783171995/maxela/info/abc123.mov'), out);
  assert.equal(whatsappVideoLink('https://res.cloudinary.com/dlkjizhya/video/upload/maxela/info/abc123.mp4'), out);
  assert.equal(whatsappVideoLink('https://res.cloudinary.com/dlkjizhya/video/upload/q_auto,w_480/v17/maxela/info/abc123.mov'), out, 'old transformations replaced');
  assert.equal(whatsappVideoLink(' https://example.com/v.mp4 '), 'https://example.com/v.mp4', 'non-Cloudinary links unchanged');
  assert.equal(whatsappVideoLink(''), '');
});

test('textWithoutMedia: never a text that points at media the guest did not get', async (t) => {
  await t.test('bag storage reply with photos that failed -> text-only version', () => {
    for (const sent of [
      'You can leave your bags before check-in. Go to the entrance in the first photo, then the glass door in the second photo. The smart lock code is 13 24 13#.',
      'Good morning. You can leave your bags in the hallway storage area shown in the video, through the door it shows.',
      'Here it is, sorry about that.',
      'Sending it again.',
      '',
    ]) {
      assert.equal(textWithoutMedia(sent, BAG), MEDIA[BAG].fallback.en, sent);
    }
  });
  await t.test('Georgian reply -> Georgian text-only version', () => {
    assert.equal(textWithoutMedia('მიდით პირველ ფოტოზე ნაჩვენებ შესასვლელთან.', BAG), MEDIA[BAG].fallback.ka);
    assert.equal(textWithoutMedia('თავიდან გიგზავნით.', BAG), MEDIA[BAG].fallback.ka);
  });
  await t.test('a text that stands on its own is kept', () => {
    const mixer = 'For hot water, press the button on the right handle and turn it down, towards you.';
    assert.equal(textWithoutMedia(mixer, HOT), mixer);
    const park = 'We do not have private parking, but there is paid parking under Carrefour.'; // "there is" is not "here is"
    assert.equal(textWithoutMedia(park, PARK), park);
  });
  await t.test('unknown id: nothing usable if the text points at media', () => {
    assert.equal(textWithoutMedia('Here it is.', '999'), '');
    assert.equal(textWithoutMedia('Check-in is at 3pm.', '999'), 'Check-in is at 3pm.');
  });
});

test('capMediaResend: photos or a video go out at most twice per conversation', () => {
  const plan = { text: 'Sending it again.', videoId: BAG, escalate: false };
  assert.equal(capMediaResend(plan, []), plan, 'first send');
  assert.equal(capMediaResend(plan, [`You can leave your bags...\n[VIDEO_SENT:${BAG}]`]), plan, 'one resend allowed');
  const capped = capMediaResend(plan, [`Sending it again.\n[VIDEO_SENT:${BAG}]`, 'ok', `You can leave...\n[VIDEO_SENT:${BAG}]`]);
  assert.deepEqual(capped, { text: 'Let me check this with the team and get back to you shortly.', videoId: null, escalate: true, videoCapped: true });
  assert.equal(capMediaResend({ ...plan, videoId: PARK }, [`x\n[VIDEO_SENT:${BAG}]`, `y\n[VIDEO_SENT:${BAG}]`]).videoId, PARK, 'counted per media');
  assert.equal(capMediaResend({ text: 'თავიდან გიგზავნით.', videoId: BAG }, [`[VIDEO_SENT:${BAG}]`, `[VIDEO_SENT:${BAG}]`]).text, 'გადავამოწმებ გუნდთან და მალე მოგწერთ.');
});

test('checkMediaLink', async (t) => {
  const res = (status, type) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => type } });
  await t.test('video MP4 / image JPEG: ok', async () => {
    assert.deepEqual(await checkMediaLink('https://x/v.mp4', 'video', { fetchImpl: async (u, o) => { assert.equal(o.method, 'HEAD'); return res(200, 'video/mp4;codecs=avc1'); } }), { ok: true });
    assert.deepEqual(await checkMediaLink('https://x/a.jpg', 'image', { fetchImpl: async () => res(200, 'image/jpeg') }), { ok: true });
  });
  await t.test('Cloudinary still preparing the video (423): waits and tries again', async () => {
    const answers = [423, 423, 200];
    const r = await checkMediaLink('https://x/v.mp4', 'video', { fetchImpl: async () => res(answers.shift(), 'video/mp4'), sleep: async () => {} });
    assert.deepEqual(r, { ok: true });
  });
  await t.test('no link / 404 / wrong format / timeout / still 423 after retries', async () => {
    assert.match((await checkMediaLink('', 'video')).reason, /no permanent link/);
    assert.match((await checkMediaLink('https://x', 'image', { fetchImpl: async () => res(404, 'text/html') })).reason, /HTTP 404/);
    assert.match((await checkMediaLink('https://x', 'video', { fetchImpl: async () => res(200, 'video/quicktime') })).reason, /wrong format/);
    assert.match((await checkMediaLink('https://x', 'image', { fetchImpl: async () => res(200, 'video/mp4') })).reason, /wrong format/);
    const slow = (u, o) => new Promise((resolve, reject) => o.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); }));
    assert.match((await checkMediaLink('https://x', 'video', { fetchImpl: slow, timeoutMs: 10 })).reason, /did not answer/);
    assert.match((await checkMediaLink('https://x', 'video', { fetchImpl: async () => res(423, ''), sleep: async () => {}, retries: 2 })).reason, /HTTP 423/);
  });
});
