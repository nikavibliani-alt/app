'use strict';

// Guest photos for Claude: download from Meta (media id -> URL -> bytes with
// the access token) and attach them to the guest's unanswered message(s).
// Nothing is stored: the bytes are passed through to Claude and dropped.
// Any failure falls back to the plain "[image]" text and is logged.

const GRAPH = 'https://graph.facebook.com/v19.0';
const SUPPORTED = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const MAX_BYTES = 5 * 1024 * 1024; // Claude's per-image limit
const MAX_IMAGES = 4; // newest photos per reply; older ones stay "[image]"
const TIMEOUT_MS = 10000;

async function fetchWithTimeout(fetchImpl, url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** { ok: true, mimeType, base64, bytes } or { ok: false, reason }. Never throws. */
async function downloadMetaMedia({ mediaId, accessToken, fetchImpl = fetch, timeoutMs = TIMEOUT_MS }) {
  try {
    const auth = { headers: { Authorization: `Bearer ${accessToken}` } };
    const metaRes = await fetchWithTimeout(fetchImpl, `${GRAPH}/${encodeURIComponent(mediaId)}`, auth, timeoutMs);
    const meta = await metaRes.json().catch(() => null);
    if (!metaRes.ok || !meta?.url) {
      return { ok: false, reason: `media lookup failed (HTTP ${metaRes.status}${meta?.error?.message ? `: ${meta.error.message}` : ''})` };
    }
    const mimeType = String(meta.mime_type || '').split(';')[0].trim().toLowerCase();
    if (!SUPPORTED.has(mimeType)) return { ok: false, reason: `unsupported image type ${mimeType || 'unknown'}` };
    if (Number(meta.file_size) > MAX_BYTES) return { ok: false, reason: `image too large (${meta.file_size} bytes)` };

    const fileRes = await fetchWithTimeout(fetchImpl, meta.url, auth, timeoutMs);
    if (!fileRes.ok) return { ok: false, reason: `media download failed (HTTP ${fileRes.status})` };
    const buf = Buffer.from(await fileRes.arrayBuffer());
    if (buf.length === 0) return { ok: false, reason: 'media download was empty' };
    if (buf.length > MAX_BYTES) return { ok: false, reason: `image too large (${buf.length} bytes)` };
    return { ok: true, mimeType, base64: buf.toString('base64'), bytes: buf.length };
  } catch (err) {
    return { ok: false, reason: err?.name === 'AbortError' ? `media download timed out after ${timeoutMs} ms` : `media download error: ${err?.message || err}` };
  }
}

/** Photos in the guest's unanswered batch, newest MAX_IMAGES, as [{ index, mediaId }] (index into `unanswered`). */
function photosToAttach(unanswered) {
  const withPhotos = (unanswered || [])
    .map((m, index) => ({ index, mediaId: m?.media?.type === 'image' ? m.media.id : null }))
    .filter((p) => p.mediaId);
  return withPhotos.slice(-MAX_IMAGES);
}

// What Claude sees for photos that are NOT attached. "[image]" alone made the
// model write "looking at the photo", or treat an old photo as still waiting
// for an answer ("we're unable to view the photo" to a guest's "I'm worried").
// - An unanswered photo that could not be attached (download failed):
const UNSEEN_PHOTO = '[photo you cannot see]';
// - A photo from before a bot or Host reply, i.e. already answered:
const ANSWERED_PHOTO = '[photo, already answered]';

/**
 * Turns the trailing unanswered user turns that carry a downloaded photo into
 * [image, text] content blocks (the text keeps "[image]" next to the real
 * image). `messages` ends with the unanswered turns in order (see
 * prepareClaudeHistory); `downloads` maps unanswered index -> result.
 * Every other "[image]" in the guest's turns is relabelled: before the
 * unanswered turns -> "[photo, already answered]"; in an unanswered turn whose
 * photo was not attached -> "[photo you cannot see]".
 */
function attachPhotos(messages, unansweredCount, downloads) {
  const first = messages.length - unansweredCount;
  const out = messages.map((turn, i) => (turn.role === 'user' && typeof turn.content === 'string'
    ? { ...turn, content: turn.content.replace(/\[image\]/g, i < first ? ANSWERED_PHOTO : UNSEEN_PHOTO) }
    : turn));
  for (const [index, d] of downloads) {
    if (!d?.ok) continue;
    const i = first + index;
    const original = messages[i];
    if (!original || original.role !== 'user' || typeof original.content !== 'string') continue;
    out[i] = {
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: d.mimeType, data: d.base64 } },
        { type: 'text', text: original.content },
      ],
    };
  }
  return out;
}

module.exports = { downloadMetaMedia, photosToAttach, attachPhotos, MAX_IMAGES, UNSEEN_PHOTO, ANSWERED_PHOTO };
