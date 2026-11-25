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

// Self-corrections and talk about "the guest" in the third person (seen on
// 24 Nov: "Good to hear from you again. How can I help? / Wait, the guest is
// asking about cleaning, let me address that directly. / Good morning, let me
// check..."). The guest-facing facts say "the guest page" and "the guest must
// be out", so only reasoning verbs count after "the guest".
const SELF_CORRECTION_RE = /(?:^|[.!?:]\s+|\n)\s*(?:(?:wait|hold on|oops|scratch that|on second thought)\s*[,.!:;—–-]|hmm+\b)/i;
const ACTUALLY_RE = /(?:[.!?:]\s+|\n)\s*actually,?\s|^\s*actually,?\s+(?:let me|I (?:should|need|will|'ll|must)|the guest|wait|no\b|scratch)/i;
const THIRD_PERSON_RE = /\b(?:the|this) guest(?:'s)? (?:is|was|has|had|wants?|wanted|asks?|asked|asking|says?|said|writes?|wrote|mentions?|mentioned|seems?|needs?|just|now|probably|already|message|question|request(?:s|ed)?|newest|latest|first|did|does|didn't|doesn't)\b|\bthis guest\b/i;
const META_RE = /\blet me (?:address|respond to|reply to|focus on|re-?read|reconsider|rethink|correct (?:that|this|myself))\b|\bI (?:should|need to|will now|must) (?:reply|respond|answer|address|use|apply|follow)\b|\b(?:address|answer)(?:ing)? (?:that|this|it) directly\b|\bmy (?:previous|first|earlier) (?:reply|answer|draft|response)\b/i;
// Two answers in one message: a greeting question, then more text after it.
const HOW_CAN_I_HELP_RE = /how can i help(?: you)?(?: today)?\?|რით შემიძლია დაგეხმაროთ\?/i;
const OPENING_RE = /^(?:hi|hello|hey|good (?:morning|afternoon|evening)|good to hear from you|გამარჯობა|დილა მშვიდობისა)\b/i;

/**
 * Why a reply must not be sent as it is, or null when it is fine: the model's
 * reasoning about its instructions, a self-correction ("Wait,", "Actually,"),
 * talk about "the guest" in the third person, or two answers in one message
 * (a greeting question followed by another reply, or two paragraphs that each
 * open with a greeting). The worker then calls Claude once more; a reply that
 * still leaks is never sent (deliverReply).
 */
function findReasoningLeak(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  if (REASONING_RE.test(t)) return 'talks about its instructions';
  if (SELF_CORRECTION_RE.test(t)) return 'self-correction';
  if (ACTUALLY_RE.test(t)) return 'self-correction';
  if (THIRD_PERSON_RE.test(t)) return 'talks about the guest in the third person';
  if (META_RE.test(t)) return 'talks about its own reply';
  const help = dropGreetingPrefix(t).match(HOW_CAN_I_HELP_RE);
  if (help && dropGreetingPrefix(t).slice(help.index + help[0].length).trim().length >= 15) return 'two answers in one message';
  const openings = t.split(/\n\s*\n/).filter((p) => OPENING_RE.test(p.trim()));
  if (openings.length >= 2) return 'two answers in one message';
  return null;
}

// Added to the second Claude call after a leak (uncached part of the system prompt).
const LEAK_RETRY_NOTE = 'Your previous draft for this message was not sent: it contained your own notes or two answers. Write only the one message to send to the guest, as the final reply: no notes about the guest or your instructions, no "Wait" or "Actually", no second answer.';

/**
 * The reply plan after the leak check, with one retry: if the first reply
 * leaks, `retry()` is called once (-> raw reply text, or null when that call
 * failed) and its plan is used; if that one leaks too (or the retry failed),
 * the plan gets `leak` and deliverReply sends nothing. Silent and angry
 * replies send nothing to the guest anyway, so they are not checked.
 * Returns { plan, retried, firstLeak }.
 */
async function planWithLeakRetry(firstRaw, toPlan, retry) {
  const leakOf = (p) => (p.silent || p.angry ? null : findReasoningLeak(p.text));
  const first = toPlan(firstRaw);
  const firstLeak = leakOf(first);
  if (!firstLeak) return { plan: first, retried: false, firstLeak: null };
  const raw = await retry();
  if (raw === null || raw === undefined) return { plan: { ...first, leak: firstLeak }, retried: true, firstLeak };
  const second = toPlan(raw);
  const secondLeak = leakOf(second);
  return { plan: secondLeak ? { ...second, leak: secondLeak } : second, retried: true, firstLeak };
}

// "Hi, how can I help you?" is only for a bare greeting. When the model opens
// with it and then answers a real question (seen 18 Oct: a guest who asked
// about two bedrooms), the greeting reads as ignoring the question: dropped.
const GREETING_PREFIX_RE = /^\s*(?:(?:hi|hello)(?: there)?,?|good to hear from you again[.!,]?) how can i help(?: you)?(?: today)?\?\s+|^\s*გამარჯობა,? რით შემიძლია დაგეხმაროთ\?\s+/i;

/** The reply without a leading generic greeting, when an answer follows it. */
function dropGreetingPrefix(text) {
  const t = String(text || '');
  const m = t.match(GREETING_PREFIX_RE);
  if (!m) return t;
  const rest = t.slice(m[0].length).trim();
  return rest.length >= 15 ? rest : t;
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

// A normal escalation's push, next to its WhatsApp alert (ownerPush.js).
const ESCALATION_PUSH = { push: 'escalation', reason: 'Guest needs help' };

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
 *   'leak_blocked'    — the reply leaked the model's reasoning or held two answers: nothing sent, owner alerted
 *   'empty_reply'     — nothing to send and no escalation: owner alerted, pending kept
 *   'send_failed'     — Meta rejected the text: nothing stored, owner alerted, pending kept
 *   'sent'
 *
 * who: { name, room, guestText, mode, ownerNote? } (ownerNote: stay + next arrival, added to escalation alerts)
 * deps: preSendCheck() -> 'send'|'newer_message'|'owner_replied', humanize(),
 *   sendVideo(id) / sendText(body) -> { ok, id } | { ok: false, code, reason },
 *   storeAssistant(content), writeAlert(fields), notifyOwner(issue, opts),
 *   notifyOwnerThrottled(key, issue, opts), finishPending(), log
 *   opts: { push: 'lockout'|'issue'|'angry'|'bot_error'|'escalation', reason } also
 *   sends a push notification
 * (the caller adds the guest name / room to owner alerts; `issue` is the reason
 * plus the guest's message)
 */
async function deliverReply(plan, who, deps) {
  const hasContent = !!plan.text || !!plan.videoId;
  // A reply that leaks the model's reasoning or holds two answers (the worker
  // already called Claude a second time, see planWithLeakRetry) is never sent.
  const leak = plan.angry ? null : (plan.leak || findReasoningLeak(plan.text));

  if (hasContent && !plan.angry && !leak) await deps.humanize();

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

  // Leaked reply: nothing to the guest, the owner gets the guest's message (WhatsApp + push).
  if (leak) {
    deps.log.error(`deliverReply: reply blocked (${leak}), nothing sent to the guest; owner alerted`);
    await deps.writeAlert({ reason: 'bot_error', errorType: 'reasoning_leak', errorMessage: `reply blocked (${leak}); nothing sent`, urgency: !!plan.urgent });
    await deps.notifyOwner(`Bot reply blocked, nothing sent to the guest (${leak}). Guest wrote: ${who.guestText}`, { push: 'bot_error', reason: 'Bot reply blocked, nothing sent' });
    await deps.finishPending();
    return { outcome: 'leak_blocked' };
  }

  // Tag-only reply (e.g. just "[ESCALATE]"): never send an empty WhatsApp message.
  if (!hasContent) {
    if (plan.escalate) {
      deps.log.warn('deliverReply: reply had only tags, nothing sent to the guest; escalating to the owner');
      await deps.writeAlert({ reason: 'escalation', urgency: !!plan.urgent });
      if (!plan.urgent) await deps.notifyOwner(`Guest needs help (mode ${who.mode}): ${who.guestText}${who.ownerNote ? ` [${who.ownerNote}]` : ''}`, ESCALATION_PUSH);
      await deps.finishPending();
      return { outcome: 'escalated_only' };
    }
    deps.log.error('deliverReply: reply was empty after removing tags, nothing sent');
    await deps.writeAlert({ reason: 'bot_error', errorType: 'empty_reply', errorMessage: 'reply was empty after removing internal tags' });
    await deps.notifyOwnerThrottled('bot_empty_reply', 'Bot could not reply: its reply was empty', { push: 'bot_error', reason: 'its reply was empty' });
    return { outcome: 'empty_reply' }; // pending kept: the next guest message retries it
  }

  let videoSent = false;
  let text = dropGreetingPrefix(plan.text);
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
    if (!plan.urgent) await deps.notifyOwner(`Guest needs help (mode ${who.mode}): ${who.guestText}${who.ownerNote ? ` [${who.ownerNote}]` : ''}`, ESCALATION_PUSH);
  }
  await deps.finishPending();
  return { outcome: 'sent' };
}

module.exports = {
  dropGreetingPrefix,
  findReasoningLeak,
  planWithLeakRetry,
  LEAK_RETRY_NOTE,
  findForbiddenCode,
  SAFE_CODE_REPLY,
  parseAiReply,
  interpretMetaResponse,
  shouldNotifyNow,
  deliverReply,
};
