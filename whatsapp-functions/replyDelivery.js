'use strict';

// The bot worker's send phase, after Claude has replied: parse the reply's
// internal tags, run the final pre-send check, then send, store and alert —
// in that order, so a run that is replaced by a newer one (or overtaken by the
// owner) never sends and never alerts. All side effects are injected (`deps`)
// so every path is unit-testable.

const { applyToneGuard } = require('./toneGuard');

/**
 * Parses Claude's raw reply (time labels already stripped) into a plan:
 * { text, videoId, escalate, urgent ('LOCKOUT'|'ISSUE'|null), angry, silent }.
 * `text` is the exact guest-facing text: tags removed, tone guard applied.
 */
function parseAiReply(raw) {
  let text = String(raw ?? '');
  let videoId = null;
  const videoMatch = text.match(/^\[VIDEO:(\d+)\]\s*\n?/);
  if (videoMatch) {
    videoId = videoMatch[1];
    text = text.slice(videoMatch[0].length);
  }
  const angry = /\[URGENT:ANGRY\]/i.test(text);
  const silent = /\[SILENT\]/i.test(text);
  const urgentMatch = text.match(/\[URGENT:(LOCKOUT|ISSUE)\]/i);
  const escalate = /\[ESCALATE\]/i.test(text) || !!urgentMatch;
  text = text
    .replace(/\s*\[ESCALATE\]\s*/gi, ' ')
    .replace(/\s*\[URGENT:(?:LOCKOUT|ISSUE|ANGRY)\]\s*/gi, ' ')
    .replace(/\s*\[VIDEO_SENT:\d+\]\s*/gi, ' ')
    .replace(/\s*\[SILENT\]\s*/gi, ' ')
    .trim();
  return {
    text: applyToneGuard(text),
    videoId,
    escalate,
    urgent: urgentMatch ? urgentMatch[1].toUpperCase() : null,
    angry,
    silent,
  };
}

/** Meta Cloud API send response -> { ok, id } or { ok: false, code, reason }. */
function interpretMetaResponse(data) {
  const id = data?.messages?.[0]?.id;
  if (id) return { ok: true, id };
  const err = data?.error;
  if (err) {
    const detail = err.error_data?.details ? ` (${err.error_data.details})` : '';
    return { ok: false, code: err.code ?? 'unknown', reason: `Meta error ${err.code ?? '?'}: ${err.message || 'unknown'}${detail}`.slice(0, 300) };
  }
  return { ok: false, code: 'no_message_id', reason: 'Meta returned no message id' };
}

/** Owner notifications are limited to one per key per window; alert docs are always written. */
function shouldNotifyNow(lastNotifiedMs, nowMs, windowMs) {
  return !(Number.isFinite(lastNotifiedMs) && nowMs - lastNotifiedMs < windowMs);
}

/**
 * Sends a parsed reply. Returns { outcome }:
 *   'stopped_newer'   — the guest wrote again; the newer run answers (pending left as is)
 *   'stopped_owner'   — the owner handled it
 *   'angry_alerted'   — angry guest: nothing sent, owner alerted
 *   'escalated_only'  — tag-only escalation: nothing sent, owner alerted
 *   'empty_reply'     — nothing to send and no escalation: owner alerted, pending kept
 *   'send_failed'     — Meta rejected the text: nothing stored, owner alerted, pending kept
 *   'sent'
 *
 * who: { name, room, guestText, mode }
 * deps: preSendCheck() -> 'send'|'newer_message'|'owner_replied', humanize(),
 *   sendVideo(id) / sendText(body) -> { ok, id } | { ok: false, code, reason },
 *   storeAssistant(content), writeAlert(fields), notifyOwner(text),
 *   notifyOwnerThrottled(key, text), finishPending(), log
 */
async function deliverReply(plan, who, deps) {
  const label = `${who.name} / ${who.room || 'unknown room'}`;
  const hasContent = !!plan.text || !!plan.videoId;

  if (hasContent && !plan.angry) await deps.humanize();

  // Final check BEFORE any send or owner alert.
  const decision = await deps.preSendCheck();
  if (decision === 'newer_message') return { outcome: 'stopped_newer' };
  if (decision === 'owner_replied') {
    await deps.finishPending();
    return { outcome: 'stopped_owner' };
  }

  // Angry guest: nothing to the guest, urgent alert to the owner.
  if (plan.angry) {
    await deps.writeAlert({ reason: 'angry_guest', urgency: true });
    await deps.notifyOwner(`URGENT: ${label} — angry/complaint guest: ${who.guestText.slice(0, 300)}`);
    await deps.finishPending();
    return { outcome: 'angry_alerted' };
  }

  // Urgent issues page the owner ahead of the guest-facing send.
  if (plan.urgent) {
    await deps.notifyOwner(plan.urgent === 'LOCKOUT'
      ? `URGENT: ${label} — guest is locked out`
      : `URGENT: ${label} — ${who.guestText.slice(0, 300)}`);
  }

  // Tag-only reply (e.g. just "[ESCALATE]"): never send an empty WhatsApp message.
  if (!hasContent) {
    if (plan.escalate) {
      deps.log.warn('deliverReply: reply had only tags, nothing sent to the guest; escalating to the owner');
      await deps.writeAlert({ reason: 'escalation', urgency: !!plan.urgent });
      if (!plan.urgent) await deps.notifyOwner(`Guest needs help — ${label} / mode=${who.mode}: ${who.guestText}`);
      await deps.finishPending();
      return { outcome: 'escalated_only' };
    }
    deps.log.error('deliverReply: reply was empty after removing tags, nothing sent');
    await deps.writeAlert({ reason: 'bot_error', errorType: 'empty_reply', errorMessage: 'reply was empty after removing internal tags' });
    await deps.notifyOwnerThrottled('bot_empty_reply', `Bot could not reply to ${label}: its reply was empty`);
    return { outcome: 'empty_reply' }; // pending kept: the next guest message retries it
  }

  let videoSent = false;
  if (plan.videoId) {
    const v = await deps.sendVideo(plan.videoId);
    videoSent = v.ok;
    if (!v.ok) {
      deps.log.error(`deliverReply: video ${plan.videoId} failed to send — ${v.reason}`);
      await deps.writeAlert({ reason: 'bot_error', errorType: 'meta_send_failed', errorMessage: `video: ${v.reason}` });
      await deps.notifyOwnerThrottled(`meta_${v.code}`, `Reply to ${label} failed to send (video): ${v.reason}`);
      if (!plan.text) return { outcome: 'send_failed' }; // nothing reached the guest; pending kept
    }
  }

  if (plan.text) {
    const t = await deps.sendText(plan.text);
    if (!t.ok) {
      deps.log.error(`deliverReply: text failed to send — ${t.reason}`);
      await deps.writeAlert({ reason: 'bot_error', errorType: 'meta_send_failed', errorMessage: t.reason, urgency: !!plan.urgent });
      await deps.notifyOwnerThrottled(`meta_${t.code}`, `Reply to ${label} failed to send: ${t.reason}${plan.escalate ? ` (it was an escalation: ${who.guestText.slice(0, 200)})` : ''}`);
      return { outcome: 'send_failed' }; // not stored as sent; pending kept
    }
  }

  // Store exactly what reached the guest; the video marker only if the video went out.
  const stored = [plan.text, videoSent ? `[VIDEO_SENT:${plan.videoId}]` : ''].filter(Boolean).join('\n');
  if (stored) await deps.storeAssistant(stored);

  if (plan.escalate) {
    await deps.writeAlert({ reason: 'escalation', urgency: !!plan.urgent });
    // Urgent cases were already paged above.
    if (!plan.urgent) await deps.notifyOwner(`Guest needs help — ${label} / mode=${who.mode}: ${who.guestText}`);
  }
  await deps.finishPending();
  return { outcome: 'sent' };
}

module.exports = {
  parseAiReply,
  interpretMetaResponse,
  shouldNotifyNow,
  deliverReply,
};
