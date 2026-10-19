/**
 * Warnings shown before a reply is sent from the guest inbox. A warning never blocks sending;
 * it asks "send anyway?". Pure function, used by inbox.html and tested in pipeline-functions/tests.
 */
const ALLOWED_HOST = "app.maxelaapartments.com";

export function replyWarnings(text) {
  const t = String(text || "");
  const out = [];

  // Links to anything other than our own app.
  const urls = t.match(/(?:https?:\/\/|www\.)[^\s<>"']+/gi) || [];
  const bare = t.match(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|ge|io|app|me|co|info|biz|ru|eu|uk|de|fr)\b(?:\/[^\s]*)?/gi) || [];
  const bad = [...urls, ...bare].filter(u => {
    const host = u.replace(/^https?:\/\//i, "").replace(/^www\./i, "").split(/[\/?#]/)[0].toLowerCase();
    return host !== ALLOWED_HOST && !host.endsWith("." + ALLOWED_HOST);
  });
  if (bad.length) out.push("It contains a link that is not " + ALLOWED_HOST + ".");

  // Email address.
  if (/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/.test(t)) out.push("It contains an email address.");

  // Phone number: 7 or more digits, allowing spaces, dashes, dots and brackets between them.
  const phone = t.match(/\+?\(?\d[\d\s().-]{5,}\d/g) || [];
  if (phone.some(p => p.replace(/\D/g, "").length >= 7)) out.push("It contains a phone number.");

  // Door code, elevator code or WiFi password: a code word next to a number or a mixed letters and digits token.
  const word = /\b(?:code|passcode|password|passwort|pass|pin|wifi|wi-fi|lockbox|keybox)\b/i.test(t);
  const secretish = /\b\d{3,8}\b/.test(t) || /\b(?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{5,}\b/.test(t);
  if (word && secretish) out.push("It looks like it may contain a door code or WiFi password.");

  return out;
}
