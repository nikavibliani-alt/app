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
    if (r.code !== 132001) break; // only "template not found in this language" is worth another language
  }
  log.error(`owner alert: template "${TEMPLATE}" failed (${lastReason}), falling back to free-form text`);
  const t = await send({ messaging_product: 'whatsapp', to, type: 'text', text: { body: ownerAlertText(params) } })
    .catch((e) => ({ ok: false, reason: String(e?.message || e) }));
  if (t.ok) {
    log.log(`owner alert sent as free-form text (fallback), message id ${t.id}`);
    return { ok: true, via: 'text', id: t.id };
  }
  log.error(`owner alert: free-form fallback failed too (${t.reason}); the whatsapp_alerts doc is the only record`);
  return { ok: false, via: null, reason: `${lastReason} / ${t.reason}` };
}

/**
 * Meta delivery reports (webhook value.statuses) for messages to the owner,
 * as log lines: [{ level: 'log' | 'error', text }]. Other recipients ignored.
 */
function ownerAlertStatusLines(statuses, ownerPhone) {
  const owner = String(ownerPhone || '').replace(/\D/g, '');
  if (!owner) return [];
  return (statuses || [])
    .filter((s) => String(s?.recipient_id || '').replace(/\D/g, '') === owner)
    .map((s) => {
      const id = String(s.id || '').slice(-12);
      if (s.status === 'failed') {
        const e = (s.errors || [])[0] || {};
        const detail = e.error_data?.details ? ` (${e.error_data.details})` : '';
        return { level: 'error', text: `owner alert …${id} FAILED: Meta error ${e.code ?? '?'} ${e.title || e.message || ''}${detail}`.trim() };
      }
      return { level: 'log', text: `owner alert …${id} ${s.status}` };
    });
}

module.exports = { ownerAlertParams, ownerAlertTemplatePayload, ownerAlertText, sendOwnerAlert, ownerAlertStatusLines, TEMPLATE };
