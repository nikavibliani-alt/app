'use strict';

// The media the bot can send with a reply: a video (parking, hot water) or
// photos (bag storage). The prompt keeps the old Meta media ids as the names in
// its tags ([VIDEO:<id>], [VIDEO_SENT:<id>]); each tag maps to one or more
// files sent by permanent public link (Cloudinary maxela/info/), never by Meta
// media id: Meta deletes uploaded media after about 30 days (all three ids were
// gone on 2026-10-16, so every video failed).
//
// Videos go through Cloudinary's on-the-fly conversion to what WhatsApp
// accepts (MP4, H.264/AAC, max 720 px wide, well under WhatsApp's 16 MB).
//
// If the media can't be sent, the guest gets `fallback` (a text-only version
// in the reply's language) instead of a text that points at a photo or video.

const MEDIA = {
  '1804812277340997': {
    label: 'bag storage photos',
    items: [
      { type: 'image', source: 'https://res.cloudinary.com/dlkjizhya/image/upload/v1792196074/maxela/info/bag-storage-1-building.jpg' },
      { type: 'image', source: 'https://res.cloudinary.com/dlkjizhya/image/upload/v1792196075/maxela/info/bag-storage-2-glass-door.jpg' },
    ],
    fallback: {
      en: 'You can leave your bags before check-in. At Zhiuli Shartava 35/37, take the entrance to the left of the Clean House shop, then the glass door on the left, next to the black metal door. The smart lock code is 13 24 13#. Please leave your bags under the camera, and keep passports, laptops and other valuables with you.',
      ka: 'ბარგის დატოვება check-in-მდე შეგიძლიათ. ჟიული შარტავას 35/37-ში შედით Clean House-ის მაღაზიის მარცხნივ მდებარე შესასვლელით, შემდეგ კი მარცხენა შუშის კარით, შავი რკინის კარის გვერდით. კარის კოდია 13 24 13#. გთხოვთ, ბარგი დატოვოთ კამერის ქვეშ, ხოლო პასპორტები, ლეპტოპები და სხვა ძვირფასი ნივთები თან იქონიოთ.',
    },
  },
  '1819258012553462': {
    label: 'hot water video',
    // No permanent file yet (the old Meta upload expired): the mixer text is sent on its own.
    items: [],
    fallback: {
      en: 'For hot water, press the button on the right handle and turn it down, towards you. The left handle controls the water pressure: press its button and pull it up, towards the wall, all the way for full pressure. Without pressing the buttons, the handles stay locked.',
      ka: 'ცხელი წყლისთვის დააჭირეთ მარჯვენა სახელურის ღილაკს და დაატრიალეთ ქვემოთ, თქვენკენ. მარცხენა სახელური წყლის წნევას არეგულირებს: დააჭირეთ ღილაკს და აწიეთ ზემოთ, კედლისკენ, ბოლომდე. ღილაკების დაჭერის გარეშე სახელურები დაბლოკილია.',
    },
  },
  '975338858914982': {
    label: 'parking video',
    items: [
      { type: 'video', source: 'https://res.cloudinary.com/dlkjizhya/video/upload/v1792196077/maxela/info/parking.mp4' },
    ],
    fallback: {
      en: 'We do not have private parking, but there is paid parking in the neighboring building, underneath Carrefour. Daily rate is 15 GEL, cash only. Location: https://maps.app.goo.gl/LArVmJASytmQdReJA',
      ka: 'სამწუხაროდ ჩვენი პარკინგი არ გვაქვს, მაგრამ მეზობელ შენობაში, Carrefour-ის ქვეშ არის ფასიანი პარკინგი, დღეში 15 ლარი, მხოლოდ ნაღდი ფულით. https://maps.app.goo.gl/LArVmJASytmQdReJA',
    },
  },
};

const WHATSAPP_VIDEO_TRANSFORM = 'f_mp4,vc_h264,ac_aac,q_auto,w_720,c_limit';

/**
 * A Cloudinary video link as WhatsApp needs it (MP4, H.264/AAC, max 720 px);
 * any other link is returned as is; '' for no link.
 */
function whatsappVideoLink(source) {
  const url = String(source || '').trim();
  const m = url.match(/^(https:\/\/res\.cloudinary\.com\/[^/]+\/video\/upload\/)(.+)$/);
  if (!m) return url;
  const parts = m[2].split('/');
  // Drop any transformation segments ("q_auto", "w_720,c_limit") and the version ("v1783171995").
  while (parts.length > 1 && (/^v\d+$/.test(parts[0]) || /^[a-z]{1,3}_[^/]*$/.test(parts[0]))) parts.shift();
  const publicId = parts.join('/').replace(/\.[a-z0-9]+$/i, '');
  return `${m[1]}${WHATSAPP_VIDEO_TRANSFORM}/${publicId}.mp4`;
}

/**
 * { id, label, items: [{ type: 'image'|'video', link }], fallback } for a tag's
 * id (items empty if no permanent file is set); null for an unknown id.
 */
function mediaFor(id) {
  const m = MEDIA[String(id)];
  if (!m) return null;
  return {
    id: String(id),
    label: m.label,
    items: m.items.map((i) => ({ type: i.type, link: i.type === 'video' ? whatsappVideoLink(i.source) : String(i.source || '').trim() })),
    fallback: m.fallback,
  };
}

// Text that only makes sense if the video or photos arrived.
const MEDIA_REFERENCE_RE = /\bvideos?\b|\bphotos?\b|\bpictures?\b|\bimages?\b|\bhere it is\b|\bhere's\b|\bhere is\b|\bsending it\b|\blet me send\b|ვიდეო|ფოტო|სურათ|გიგზავნით|видео|фото/i;
const GEORGIAN_RE = /[Ⴀ-ჿ]/;

/**
 * The text to send when the media did NOT go out: the model's text if it
 * stands on its own, else the media's text-only fallback in the reply's
 * language (Georgian if the reply is in Georgian, else English). An unknown
 * id with a text that points at media: '' (nothing usable to send).
 */
function textWithoutMedia(text, id) {
  const t = String(text || '').trim();
  if (t && !MEDIA_REFERENCE_RE.test(t)) return t;
  const m = MEDIA[String(id)];
  if (!m) return '';
  return GEORGIAN_RE.test(t) ? m.fallback.ka : m.fallback.en;
}

const MAX_SENDS_PER_MEDIA = 2; // the first send + one resend when the guest didn't get it
const CHECK_WITH_TEAM = {
  en: 'Let me check this with the team and get back to you shortly.',
  ka: 'გადავამოწმებ გუნდთან და მალე მოგწერთ.',
};

/**
 * Hard limit on resending (the prompt alone did not hold it): if this media
 * already went out MAX_SENDS_PER_MEDIA times in the conversation
 * ([VIDEO_SENT:id] markers in `historyContents`), the reply does not send it
 * again; it says the team will check, and escalates. Returns the plan unchanged otherwise.
 */
function capMediaResend(plan, historyContents) {
  if (!plan || !plan.videoId) return plan;
  const marker = `[VIDEO_SENT:${plan.videoId}]`;
  const sent = (historyContents || []).filter((c) => String(c || '').includes(marker)).length;
  if (sent < MAX_SENDS_PER_MEDIA) return plan;
  return { ...plan, videoId: null, text: GEORGIAN_RE.test(plan.text) ? CHECK_WITH_TEAM.ka : CHECK_WITH_TEAM.en, escalate: true, videoCapped: true };
}

/**
 * Checks a media link right before sending (for a converted video this also
 * makes Cloudinary prepare it; it answers 423 while that is still running, so
 * that is waited out). { ok } or { ok: false, reason }.
 */
async function checkMediaLink(link, type, { fetchImpl = fetch, timeoutMs = 20000, retries = 3, waitMs = 4000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  if (!link) return { ok: false, reason: 'no permanent link is set' };
  const want = type === 'image' ? /^image\/(jpeg|png)/i : /^video\/mp4/i;
  for (let attempt = 0; ; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(link, { method: 'HEAD', signal: controller.signal });
      if (res.status === 423 && attempt < retries) { await sleep(waitMs); continue; }
      const ctype = String(res.headers?.get?.('content-type') || '');
      if (!res.ok) return { ok: false, reason: `${type} link answered HTTP ${res.status}` };
      if (!want.test(ctype)) return { ok: false, reason: `${type} link has the wrong format (${ctype || 'no content type'})` };
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: err?.name === 'AbortError' ? `${type} link did not answer within ${timeoutMs} ms` : `${type} link error: ${err?.message || err}` };
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = {
  MEDIA,
  MAX_SENDS_PER_MEDIA,
  mediaFor,
  whatsappVideoLink,
  textWithoutMedia,
  capMediaResend,
  checkMediaLink,
  MEDIA_REFERENCE_RE,
};
