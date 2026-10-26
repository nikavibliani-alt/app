'use strict';

// A guest-context line about the script of the guest's newest message(s).
// Without it, a fixed Georgian reply in the prompt can pull the model into
// Georgian for an English message (seen 26 Oct with "We're in, thanks!").
// Only for text with Latin letters and no Georgian letters: Cyrillic, Arabic
// etc. get no line (the LANGUAGE RULE already says English), and Georgian
// written in Latin letters is left to the model ("unless clearly Georgian").

const GEORGIAN_RE = /[Ⴀ-ჿᲐ-Ჿⴀ-⴯]/;
const LATIN_RE = /[a-z]/i;

/** [] or one line for the guest context. `text` = the guest's newest batch. */
function languageHintLines(text) {
  // Placeholders like "[image]" or "[location: ...]" and links are not the guest's words.
  const words = String(text || '').replace(/\[[^\]]*\]/g, ' ').replace(/https?:\/\/\S+/g, ' ');
  if (GEORGIAN_RE.test(words) || !LATIN_RE.test(words)) return [];
  return ['Script of the guest\'s newest message: Latin letters, no Georgian letters. This is only about language: whether to reply or stay silent is decided by the rules as usual. If you reply, use English unless it is clearly Georgian written in Latin letters (for example "gamarjoba").'];
}

module.exports = { languageHintLines };
