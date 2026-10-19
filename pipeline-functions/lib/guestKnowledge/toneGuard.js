'use strict';

// Last-line tone guard for every bot reply, applied right before it is sent
// to the guest. The prompt already bans these, but the model slips (e.g. it
// copies an em dash from an older reply in the history):
// - "!" (any run, e.g. "!!") -> "."   ("!?" / "?!" keep just the "?")
// - em dash "—" -> ", "
// Text inside URLs is never changed. Language-independent (English, Georgian,
// Russian, ... all use the same characters).

// http(s):// or www. links, and bare links like app.maxelaapartments.com/checkin-guest
const URL_RE = /(?:https?:\/\/|www\.)[^\s<>"']+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\/[^\s<>"']*/gi;
// Sentence punctuation right after a link belongs to the sentence, not the link.
const TRAILING_PUNCT_RE = /[.,!?;:)\]]+$/;

// Applied to the text between links only.
function fixProse(text) {
  return text
    .replace(/!+\?+|\?+!+[!?]*/g, '?') // "!?", "?!", "?!!" -> "?"
    .replace(/!+/g, '.') // "!", "!!" -> "."
    .replace(/\.{2,}/g, (dots) => (dots.length === 3 ? dots : '.')) // "!." -> ".", keep a real "..."
    .replace(/[ \t]*—[ \t]*/g, ', ') // em dash -> ", "
    .replace(/,[ \t]*([,.?:;])/g, '$1') // ", ." / ", ," left behind by a dash
    .replace(/, \n/g, ',\n'); // no trailing space before a line break
}

/** Applies the tone guard to a guest-facing reply, leaving URLs untouched. */
function applyToneGuard(reply) {
  const text = String(reply ?? '');
  let out = '';
  let last = 0;
  for (const match of text.matchAll(URL_RE)) {
    const url = match[0].replace(TRAILING_PUNCT_RE, '');
    if (!url) continue;
    out += fixProse(text.slice(last, match.index)) + url;
    last = match.index + url.length;
  }
  out += fixProse(text.slice(last));
  // A dash at the very start or end of the reply leaves a stray comma.
  return out.replace(/^[\s,]+/, '').replace(/[\s,]+$/, '');
}

module.exports = { applyToneGuard };
