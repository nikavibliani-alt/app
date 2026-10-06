'use strict';

// Owner alerts via the approved Utility template "owner_alert", which Meta
// delivers at any time. A free-form text is only delivered if the owner wrote
// to the business number in the last 24 hours, so alerts were silently lost.
// Body: "New alert from your Maxela bot. Guest: {{1}}. Issue: {{2}}. Please
// check the WhatsApp chat." If the template send fails, the same content goes
// out as free-form text (and the failure is logged).
//
// Pure apart from the injected `send`, so every path is unit-testable.

const TEMPLATE = 'owner_alert';
// "English" in WhatsApp Manager is "en"; fall back to "en_US" if Meta says the
// template does not exist in that language (error 132001).
const LANGUAGES = ['en', 'en_US'];
const MAX_GUEST = 60;
const MAX_ISSUE = 500;
// whatsapp_owner_alerts/{messageId}: one small doc per owner alert sent, so the
// webhook can tell Meta's delivery reports for real alerts from other messages
// to the owner's number (e.g. the bot replying to the owner as a guest).
const ALERTS_COLLECTION = 'whatsapp_owner_alerts';

/** Template parameters may not contain newlines, tabs or 4+ spaces in a row, nor be empty. */
function cleanParam(value, max, fallback) {
  const text = String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  if (!text) return fallback;
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** { guest, issue } ready for the template: cleaned and trimmed to fit. */
function ownerAlertParams(guest, issue) {
  return { guest: cleanParam(guest, MAX_GUEST, 'unknown guest'), issue: cleanParam(issue, MAX_ISSUE, 'see the chat') };
}

function ownerAlertTemplatePayload(to, params, language) {
  return {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name: TEMPLATE,
      language: { code: language },
      components: [{ type: 'body', parameters: [{ type: 'text', text: params.guest }, { type: 'text', text: params.issue }] }],
    },
  };
}

/** The same wording as the template, for the free-form fallback. */
function ownerAlertText(params) {
  return `New alert from your Maxela bot. Guest: ${params.guest}. Issue: ${params.issue}. Please check the WhatsApp chat.`;
}

/**
 * Sends one owner alert: the template first (trying each language on
 * "template not found"), else the free-form text. `send(payload)` resolves to
 * { ok, id } or { ok: false, code, reason }. Never throws.
 * Returns { ok, via: 'template' | 'text' | null, id, language, reason }.
 */
async function sendOwnerAlert({ to, guest, issue, send, log = console }) {
  const params = ownerAlertParams(guest, issue);
  let lastReason = '';
  for (const language of LANGUAGES) {
    const r = await send(ownerAlertTemplatePayload(to, params, language)).catch((e) => ({ ok: false, reason: String(e?.message || e) }));
    if (r.ok) {
      log.log(`owner alert sent via template "${TEMPLATE}" (${language}), message id ${r.id}`);
      return { ok: true, via: 'template', id: r.id, language };
    }
    lastReason = r.reason;
    log.error(`owner alert: template "${TEMPLATE}" (${language}) failed: ${r.reason}`);
    if (r.code !== 132001) break; // only "template not found in this language" is worth another language
  }
  log.error(`owner alert: template "${TEMPLATE}" failed, falling back to free-form text`);
  const t = await send({ messaging_product: 'whatsapp', to, type: 'text', text: { body: ownerAlertText(params) } })
    .catch((e) => ({ ok: false, reason: String(e?.message || e) }));
  if (t.ok) {
    log.log(`owner alert sent as free-form text (fallback), message id ${t.id}`);
    return { ok: true, via: 'text', id: t.id };
  }
  log.error(`owner alert: free-form fallback failed too (${t.reason}); the whatsapp_alerts doc is the only record`);
  return { ok: false, via: null, reason: `${lastReason} / ${t.reason}` };
}

/** Firestore doc id for a Meta message id (base64 ids may contain "/"). */
const alertDocId = (messageId) => String(messageId).replace(/\//g, '_');

const digits = (v) => String(v || '').replace(/\D/g, '');

/** Ids of the delivery reports (webhook value.statuses) for messages to the owner's number. */
function ownerStatusIds(statuses, ownerPhone) {
  const owner = digits(ownerPhone);
  if (!owner) return [];
  return [...new Set((statuses || []).filter((s) => s?.id && digits(s.recipient_id) === owner).map((s) => String(s.id)))];
}

/**
 * Meta delivery reports for messages to the owner's number, as log lines:
 * [{ level: 'log' | 'error', text }]. Only ids in `alertIds` (recorded in
 * whatsapp_owner_alerts when sent) are labelled "owner alert"; anything else
 * to that number is "message to the owner's number". Other recipients ignored.
 */
function ownerAlertStatusLines(statuses, ownerPhone, alertIds = new Set()) {
  const owner = digits(ownerPhone);
  if (!owner) return [];
  return (statuses || [])
    .filter((s) => digits(s?.recipient_id) === owner)
    .map((s) => {
      const label = alertIds.has(String(s.id)) ? 'owner alert' : "message to the owner's number";
      const id = String(s.id || '').slice(-12);
      if (s.status === 'failed') {
        const e = (s.errors || [])[0] || {};
        const detail = e.error_data?.details ? ` (${e.error_data.details})` : '';
        return { level: 'error', text: `${label} …${id} FAILED: Meta error ${e.code ?? '?'} ${e.title || e.message || ''}${detail}`.trim() };
      }
      return { level: 'log', text: `${label} …${id} ${s.status}` };
    });
}

module.exports = { ownerAlertParams, ownerAlertTemplatePayload, ownerAlertText, sendOwnerAlert, ownerStatusIds, ownerAlertStatusLines, alertDocId, TEMPLATE, ALERTS_COLLECTION };
