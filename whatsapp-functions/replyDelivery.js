'use strict';

// The bot worker's send phase, after Claude has replied: parse the reply's
// internal tags, run the final pre-send check, then send, store and alert —
// in that order, so a run that is replaced by a newer one (or overtaken by the
// owner) never sends and never alerts. All side effects are injected (`deps`)
// so every path is unit-testable.

const { applyToneGuard } = require('./toneGuard');
const { mediaFor, textWithoutMedia } = require('./videos');
const { SEED: KB } = require('./knowledge/knowledgeBase');

const CHECKIN_PAGE_URL = KB.properties.shartava.checkinPageUrl;

/**
 * Parses Claude's raw reply (time labels already stripped) into a plan:
 * { text, videoId, escalate, urgent ('LOCKOUT'|'ISSUE'|null), angry, silent }.
 * `text` is the exact guest-facing text: tags removed, tone guard applied.
 */
function parseAiReply(raw) {
  let text = String(raw ?? '');
  // [VIDEO:id] anywhere in the reply (the prompt asks for it first, but the
  // model sometimes puts it at the end): the first one is the video to send,
  // and every video tag is removed from the guest-facing text.
  const videoMatch = text.match(/\[VIDEO:(\d+)\]/i);
  const videoId = videoMatch ? videoMatch[1] : null;
  text = text
    .replace(/[ \t]*\[VIDEO:\d+\][ \t]*/gi, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n');
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

// The only code a guest may get from the bot (bag storage glass door).
const ALLOWED_CODES = ['13 24 13#'];
const SAFE_CODE_REPLY = `Your door code and step-by-step instructions are on your check-in page, just scroll down through the steps: ${CHECKIN_PAGE_URL}`;
const CODE_WORD_RE = /\b(?:code|pin|passcode)\b|კოდ|код/i;
const DIGITS_RE = /(?:\d[ \-]?){4,10}[#*]?/g;

/**
 * True if `text` looks like it gives a door / smart lock code: 4-10 digits
 * ending in # or *, or near a code word, other than the allowed bag storage
 * code. Prices, times, dates and links don't match (no code word, no #).
 */
function findForbiddenCode(text) {
  let t = String(text || '');
  for (const ok of ALLOWED_CODES) t = t.split(ok).join(' ');
  t = t.replace(/https?:\/\/\S+/g, ' ');
  for (const m of t.matchAll(DIGITS_RE)) {
    const digits = m[0].replace(/\D/g, '');
    if (digits.length < 4) continue;
    if (/[#*]$/.test(m[0])) return true;
    const around = t.slice(Math.max(0, m.index - 40), m.index + m[0].length + 10);
    if (CODE_WORD_RE.test(around) && !/\+\d|\b(?:GEL|ლარ|eur|usd)\b|\d:\d/i.test(around)) return true;
  }
  return false;
}

// Sentences in which the model talks about its own instructions instead of
// to the guest (seen on 2026-10-17: "Guest's newest message is in English, so
// reply in English. The direct booking scenario: ..."). Never sent.
const REASONING_RE = /\b(?:the guest(?:'s)? (?:newest|latest) message|guest(?:'s)? newest message|so (?:I )?(?:should )?reply in (?:english|georgian)|reply in (?:english|georgian)\b.*\b(?:because|since|so)\b|(?:this|the|that) scenario\b|scenario:|guest context|the rules\b|system prompt|\[silent\]|filled check-in form: (?:yes|no)|check-in is already open for this guest|current_tbilisi_hour|internal tag)/i;

/**
 * Removes sentences that leak the model's reasoning about its instructions.
 * Returns { text, removed } (text may become '').
 */
function stripReasoning(text) {
  const t = String(text || '');
  if (!REASONING_RE.test(t)) return { text: t, removed: 0 };
  const parts = t.split(/(?<=[.!?]["”»']?)\s+|\n+/);
  const kept = parts.filter((p) => !REASONING_RE.test(p));
  // A sentence the model quoted from a scenario ("...": the reply) stays only once.
  const dedup = kept.filter((p, i) => kept.findIndex((q) => q.trim() === p.trim()) === i);
  return { text: dedup.join(' ').replace(/\s+/g, ' ').trim(), removed: parts.length - kept.length };
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
 * who: { name, room, guestText, mode, ownerNote? } (ownerNote: stay + next arrival, added to escalation alerts)
 * deps: preSendCheck() -> 'send'|'newer_message'|'owner_replied', humanize(),
 *   sendVideo(id) / sendText(body) -> { ok, id } | { ok: false, code, reason },
 *   storeAssistant(content), writeAlert(fields), notifyOwner(issue, opts),
 *   notifyOwnerThrottled(key, issue, opts), finishPending(), log
 *   opts: { push: 'lockout'|'issue'|'angry'|'bot_error', reason } also sends a
 *   push notification (urgent alerts and bot errors only; escalations get none)
 * (the caller adds the guest name / room to owner alerts; `issue` is the reason
 * plus the guest's message)
 */
async function deliverReply(plan, who, deps) {
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
    await deps.notifyOwner(`URGENT, angry or complaining guest: ${who.guestText}`, { push: 'angry' });
    await deps.finishPending();
    return { outcome: 'angry_alerted' };
  }

  // Urgent issues page the owner ahead of the guest-facing send.
  if (plan.urgent) {
    await deps.notifyOwner(plan.urgent === 'LOCKOUT'
      ? 'URGENT, guest is locked out'
      : `URGENT: ${who.guestText}`, { push: plan.urgent === 'LOCKOUT' ? 'lockout' : 'issue' });
  }

  // Tag-only reply (e.g. just "[ESCALATE]"): never send an empty WhatsApp message.
  if (!hasContent) {
    if (plan.escalate) {
      deps.log.warn('deliverReply: reply had only tags, nothing sent to the guest; escalating to the owner');
      await deps.writeAlert({ reason: 'escalation', urgency: !!plan.urgent });
      if (!plan.urgent) await deps.notifyOwner(`Guest needs help (mode ${who.mode}): ${who.guestText}${who.ownerNote ? ` [${who.ownerNote}]` : ''}`);
      await deps.finishPending();
      return { outcome: 'escalated_only' };
    }
    deps.log.error('deliverReply: reply was empty after removing tags, nothing sent');
    await deps.writeAlert({ reason: 'bot_error', errorType: 'empty_reply', errorMessage: 'reply was empty after removing internal tags' });
    await deps.notifyOwnerThrottled('bot_empty_reply', 'Bot could not reply: its reply was empty', { push: 'bot_error', reason: 'its reply was empty' });
    return { outcome: 'empty_reply' }; // pending kept: the next guest message retries it
  }

  let videoSent = false;
  let text = plan.text;
  // Safety net: never send the model's reasoning about its instructions.
  const cleaned = stripReasoning(text);
  if (cleaned.removed) {
    deps.log.error(`deliverReply: removed ${cleaned.removed} reasoning sentence(s) from the reply`);
    text = cleaned.text;
    if (!text && !plan.videoId) {
      await deps.writeAlert({ reason: 'bot_error', errorType: 'reasoning_leak', errorMessage: 'reply was only the model\'s reasoning; nothing sent' });
      await deps.notifyOwnerThrottled('bot_reasoning_leak', 'Bot could not reply: its reply was only internal reasoning', { push: 'bot_error', reason: 'its reply was only internal reasoning' });
      return { outcome: 'empty_reply' };
    }
  }
  // Safety net: never send a door / smart lock code (the bag storage code is the only one allowed).
  if (findForbiddenCode(text)) {
    deps.log.error('deliverReply: reply contained a door/lock code, not sent; sending the check-in page pointer instead');
    await deps.writeAlert({ reason: 'bot_error', errorType: 'code_blocked', errorMessage: 'reply contained a door/lock code; replaced' });
    await deps.notifyOwnerThrottled('code_blocked', 'The bot tried to send a door or lock code; it was blocked and the guest was pointed to the check-in page.');
    text = SAFE_CODE_REPLY;
  }
  if (plan.videoId) {
    const v = await deps.sendVideo(plan.videoId);
    videoSent = v.ok;
    if (!v.ok) {
      // Never send a text that points at a photo or video the guest didn't get
      // ("shown in the video", "here it is"): send the text-only version instead (videos.js).
      const label = mediaFor(plan.videoId)?.label || 'requested media';
      text = textWithoutMedia(plan.text, plan.videoId);
      const how = text !== plan.text ? (text ? '; sending the text-only version instead' : '; nothing usable to send') : '';
      if (v.code === 'not_configured') {
        // Known gap (no permanent file set yet, e.g. the hot water video): text only, no alert.
        deps.log.log(`deliverReply: no ${label} to send (no permanent file set)${how}`);
      } else {
        deps.log.error(`deliverReply: ${label} (${plan.videoId}) failed to send — ${v.reason}${how}`);
        await deps.writeAlert({ reason: 'bot_error', errorType: 'video_send_failed', errorMessage: `${label}: ${v.reason}` });
        await deps.notifyOwnerThrottled(`video_${v.code}`, `The ${label} could not be sent (${v.reason}). ${text ? 'The guest got the text-only version.' : 'Nothing was sent to the guest.'}`, { push: 'bot_error', reason: `${label} could not be sent` });
      }
      if (!text) return { outcome: 'send_failed' }; // nothing reached the guest; pending kept
    }
  }

  if (text) {
    const t = await deps.sendText(text);
    if (!t.ok) {
      deps.log.error(`deliverReply: text failed to send — ${t.reason}`);
      await deps.writeAlert({ reason: 'bot_error', errorType: 'meta_send_failed', errorMessage: t.reason, urgency: !!plan.urgent });
      await deps.notifyOwnerThrottled(`meta_${t.code}`, `Reply to the guest failed to send: ${t.reason}${plan.escalate ? ` (it was an escalation: ${who.guestText})` : ''}`, { push: 'bot_error', reason: `reply failed to send: ${t.reason}` });
      return { outcome: 'send_failed' }; // not stored as sent; pending kept
    }
  }

  // Store exactly what reached the guest; the video marker only if the video went out.
  const stored = [text, videoSent ? `[VIDEO_SENT:${plan.videoId}]` : ''].filter(Boolean).join('\n');
  if (stored) await deps.storeAssistant(stored);

  if (plan.escalate) {
    await deps.writeAlert({ reason: 'escalation', urgency: !!plan.urgent });
    // Urgent cases were already paged above.
    if (!plan.urgent) await deps.notifyOwner(`Guest needs help (mode ${who.mode}): ${who.guestText}${who.ownerNote ? ` [${who.ownerNote}]` : ''}`);
  }
  await deps.finishPending();
  return { outcome: 'sent' };
}

module.exports = {
  stripReasoning,
  findForbiddenCode,
  SAFE_CODE_REPLY,
  parseAiReply,
  interpretMetaResponse,
  shouldNotifyNow,
  deliverReply,
};
