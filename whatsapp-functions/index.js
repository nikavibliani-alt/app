const { onRequest } = require('firebase-functions/v2/https');
const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const { defineString } = require('firebase-functions/params');
const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { CloudTasksClient } = require('@google-cloud/tasks');
const crypto = require('node:crypto');
const { aptIdToBrand, matchesFreedomKeywords } = require('./identity');

if (!getApps().length) initializeApp();

// ---- Cloud Tasks config (see README.md "Cloud Tasks setup" for the one-time GCP steps) ----
const TASKS_LOCATION = 'europe-west1';
const TASKS_QUEUE    = 'whatsapp-bot-debounce';
// Set at deploy time (firebase deploy will prompt for these params, or set via
// `firebase functions:secrets:set` / .env.whatsapp). Both are plain (non-secret)
// deploy-time params — see firebase-functions/params.
const WHATSAPP_BOT_WORKER_URL   = defineString('WHATSAPP_BOT_WORKER_URL', { default: '' });
const WHATSAPP_TASKS_INVOKER_SA = defineString('WHATSAPP_TASKS_INVOKER_SA', { default: '' });

const tasksClient = new CloudTasksClient();

const SYSTEM_PROMPT = `You are a guest assistant for Maxela Apartments in Tbilisi, Georgia. You handle guest questions via WhatsApp. Be friendly and natural, like a helpful local person. Never sound like a corporate bot.

LANGUAGE RULE:
Always reply in English regardless of what language the guest writes in. If they write in Arabic, Russian, Persian or any other language, respond in English only. If they seem to expect their language, you may add: We communicate in English.

TONE RULES:
- Short natural replies, 1-3 sentences maximum
- No exclamation marks ever
- No bullet points or lists in replies
- No dashes in replies
- No AI filler phrases like Certainly, Of course, Thank you for reaching out, I understand, I hope this helps
- Use emojis very sparingly, maximum 1 per message, only when it feels completely natural
- Never sound robotic or like a template

GUEST CONTEXT (injected with each message):
- Guest name
- Room/apartment type
- Check-in and checkout dates
- Whether they filled the check-in form or not
- Previous stay notes if returning guest

UNIT TYPES (know these well):
- Triple Room with Private Bathroom: no kitchen, no balcony, 1 single bed, 1 double bed, 1 sofa bed, fits up to 4 guests
- Superior Apartment: 1 isolated bedroom with double bed, living room with double bed divided by curtains and 2 sofas, has kitchen
- 3 Bedroom Apartment: Bedroom 1 has 2 double beds, Bedroom 2 has 1 double bed and 1 baby bed, Bedroom 3 has 1 double bed, living room has 3 sofa beds, 1 separate toilet, 2 bathrooms with showers, has kitchen

SCENARIOS:

First contact or reservation confirmation:
Reply: Hi, please fill in this form to get your check-in instructions, everything will be available on that page: app.maxelaapartments.com/checkin-guest

Guest filled form but cannot see instructions:
Reply: It should be visible on that page, try refreshing it.
If they say still not visible: Let me check this with the team and get back to you shortly. [ESCALATE]

QR code not working - guest using screenshot:
Reply: The code refreshes daily so screenshots won't work. Open the page directly: app.maxelaapartments.com/checkin-guest

QR code not working - guest using website:
Reply: Got it, I am alerting the team now to fix this for you. [ESCALATE]

QR code not working - already reported before (check conversation history):
Reply: I see you had this issue before, alerting the team right away. [ESCALATE]

Early check-in request:
Reply: Standard check-in is from 3pm. If the room gets ready earlier I will text you and the page will unlock automatically. If you arrive early you are welcome to leave your bags in the meantime, just let me know.

Parking question:
Send parking video (media_id: 975338858914982) then text: The nearest paid parking is under Carrefour. We do not have private parking, daily rate is 15 GEL, cash only. Exact location is on your check-in page.

Hot water issue:
If guest is in Triple Room (no kitchen): Reply: Is there any hot water at all or no hot water anywhere?
If guest is in apartment: Reply: Is there hot water in the kitchen tap or no hot water at all?
If no hot water anywhere: We will check this right away, sorry for the inconvenience. [ESCALATE]
If hot water only in kitchen but not bathroom: Send hot water video (media_id: 1819258012553462) then text: Please click the button and scroll in your direction to adjust it.

No water or no electricity:
Reply: We will check this right away, sorry for the inconvenience. [ESCALATE]

Bag storage before check-in:
Send bag storage video (media_id: 1804812277340997) then text: Most of our guests leave their belongings there. We recommend not leaving passports, laptops or valuables. We do not have lockers and cannot be responsible for any loss.

Booking or price inquiry:
Reply: Unfortunately we cannot see exact pricing from our side. Reservations are only through Booking.com or Expedia. Which dates are you looking at and do you need a unit with kitchen or without?
If guest confirms dates and preference: Here is our booking link: booking.com/Share-PaJ0WC — please make sure to select the right unit type when booking.

Room type complaint (booked Triple Room but expected kitchen):
Reply: I understand. Just to clarify, you booked the Triple Room with Private Bathroom which does not include a kitchen, as shown in the listing. We also have the Superior Apartment and 3 Bedroom Apartment which both have kitchens. If you have questions about your booking please contact Booking.com or Expedia directly.
If guest insists or is very upset: [ESCALATE]

Gym inquiry:
Reply: We do not have a gym on site.

Airport transfer:
Reply: Yes, you can find the airport transfer option on your check-in page under Services, it will connect you directly with our driver.

Guest at building, cannot get in or no one answering:
Reply: Sorry you are stuck, I am alerting the team right now to help you get in. Please tell me your apartment or building if you can. [ESCALATE]

Late checkout request:
Reply: Let me check availability based on the next guest arrival and I will get back to you shortly. [ESCALATE]

WiFi not working:
Reply: Sorry about that, I am alerting the team to check the connection now. [ESCALATE]

Smoking rules - Triple Room:
Reply: Smoking is strictly forbidden in the Triple Room and all shared areas.

Smoking rules - Apartment:
Reply: Smoking is only allowed on the balcony.

Noise complaint:
Reply: Thank you for letting us know, we will look into this immediately. [ESCALATE]

Extra guests beyond booked number:
Reply: Thanks for letting us know, I need to check this with the team and will get back to you shortly. [ESCALATE]

Dirty room complaint:
Reply: Sorry about that, I am alerting the team now so we can sort this out right away. [ESCALATE]

Voice message or audio received:
Reply: Please type your question and I will be happy to help.

Photo or video received:
Reply: Please type your question and I will be happy to help.

Returning guest (previous stay notes exist):
Reply: Good to hear from you again. How can I help?

Anything else outside the above topics:
Reply: Let me check on that and get back to you shortly. [ESCALATE]

FOR SENDING VIDEOS:
When a scenario requires a video, start your response with [VIDEO:media_id] on its own line followed by the text message.
Example:
[VIDEO:975338858914982]
The nearest paid parking is under Carrefour...

FOR ESCALATION:
When you include [ESCALATE] in your response, place it at the very end after the guest-facing text. It will be stripped before sending to the guest and used internally to alert the owner.
Example: Sorry about that, I am alerting the team now. [ESCALATE]`;

const SUMMARY_SYSTEM_PROMPT = 'Summarize this guest WhatsApp conversation into 3-5 bullet points covering: issues they had, requests they made, how they communicated, anything notable. Be very brief.';

/** Strip spaces/dashes/parens/+ so Meta and form phones compare as digits-only. */
function normalizePhone(phone) {
  return String(phone || '').replace(/[\s\-().]/g, '').replace(/^\+/, '').replace(/\D/g, '');
}

/** Contact values commonly stored in checkin_guests for the same WhatsApp number. */
function phoneQueryVariants(phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) return [];
  const variants = new Set([normalized, `+${normalized}`]);
  return [...variants];
}

/**
 * Look up a WA check-in guest by contact, trying both digits-only and +digits forms.
 * Returns the first matching document data, or null.
 */
async function findGuestByWhatsAppPhone(db, phone) {
  const variants = phoneQueryVariants(phone);
  for (const contact of variants) {
    const snap = await db.collection('checkin_guests')
      .where('contact', '==', contact)
      .where('contactType', '==', 'wa')
      .limit(1)
      .get();
    if (!snap.empty) return snap.docs[0].data();
  }
  return null;
}

/** matchedReservationId may be "007004653_001" — base reservation number is before first _. */
function baseReservationNumber(matchedReservationId) {
  const raw = String(matchedReservationId || '').trim();
  if (!raw) return '';
  return raw.split('_')[0];
}

function guestFirstName(fullName) {
  const name = String(fullName || '').trim();
  if (!name) return 'Guest';
  return name.split(/\s+/)[0];
}

async function alreadySentRoomReady(db, reservationNumber) {
  if (!reservationNumber) return false;
  const docs = await db.collection('whatsapp_messages')
    .where('reservationNumber', '==', String(reservationNumber))
    .where('job', '==', 'room_ready')
    .where('status', '==', 'sent')
    .limit(1)
    .get();
  return !docs.empty;
}

async function writeRoomReadyRecord(db, { reservationNumber, guestName, phone, status, metaMessageId = '' }) {
  await db.collection('whatsapp_messages').add({
    reservationNumber: String(reservationNumber || ''),
    guestName: guestName || '',
    phone: phone || '',
    job: 'room_ready',
    status,
    metaMessageId,
    createdAt: FieldValue.serverTimestamp(),
  });
}

async function callClaude({ system, messages, maxTokens = 500 }) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: maxTokens,
      system,
      messages,
    }),
  });

  const data = await res.json();
  return data?.content?.[0]?.text || '';
}

async function sendWhatsAppMessage(payload) {
  const res = await fetch(
    `https://graph.facebook.com/v19.0/${process.env.META_PHONE_NUMBER_ID}/messages`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.META_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    }
  );
  return res.json();
}

function toJsDate(value) {
  if (!value) return null;
  if (typeof value.toDate === 'function') return value.toDate();
  if (value instanceof Date) return value;
  const parsed = new Date(value);
  return isNaN(parsed.getTime()) ? null : parsed;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---- Bot config / mode resolution ------------------------------------------

const CONFIG_DEFAULTS = {
  aiBotEnabled: true,
  botMode: 'available',
  botResponseDelay: 20,
  ownerPhone: '',
  nightStart: 22,
  nightEnd: 9,
};

async function getGlobalsConfig(db) {
  try {
    const snap = await db.collection('globals').doc('config').get();
    return snap.exists ? { ...CONFIG_DEFAULTS, ...snap.data() } : { ...CONFIG_DEFAULTS };
  } catch (err) {
    console.error('getGlobalsConfig failed:', err);
    return { ...CONFIG_DEFAULTS };
  }
}

/** Current hour (0-23) in Tbilisi local time. Georgia is UTC+4 year-round, no DST. */
function tbilisiHour(date = new Date()) {
  const formatted = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Tbilisi',
    hour: 'numeric',
    hourCycle: 'h23',
  }).format(date);
  return Number(formatted) % 24;
}

function isNightHour(hour, nightStart, nightEnd) {
  if (nightStart === nightEnd) return false; // no window configured — treat as always available
  if (nightStart > nightEnd) return hour >= nightStart || hour < nightEnd; // wraps past midnight, e.g. 22 -> 9
  return hour >= nightStart && hour < nightEnd;
}

/**
 * Resolve the effective bot mode ("available" | "away" | "night") from config.botMode.
 * Does NOT consider aiBotEnabled — callers must check that separately (hard kill switch).
 */
function resolveEffectiveMode(config) {
  if (config.botMode === 'away') return 'away';
  if (config.botMode === 'night') return 'night';
  if (config.botMode === 'auto') {
    const hour = tbilisiHour();
    return isNightHour(hour, Number(config.nightStart), Number(config.nightEnd)) ? 'night' : 'available';
  }
  return 'available';
}

function buildModeContext(effectiveMode, ownerPhone) {
  if (effectiveMode === 'away') {
    return 'AWAY MODE: The owner is currently unreachable (traveling/no internet). Be helpful with everything you can. For escalations that require human action, tell the guest: I have noted this and someone from our team will follow up as soon as possible. Do not promise immediate response times.';
  }
  if (effectiveMode === 'night') {
    let text = 'NIGHT MODE: It is currently nighttime in Tbilisi. For escalations that require urgent human action, tell the guest: If this is urgent please call the night contact number provided below, otherwise we will get back to you first thing in the morning.';
    const normalizedOwner = normalizePhone(ownerPhone);
    if (normalizedOwner) {
      text += `\nNight contact number: +${normalizedOwner}`;
    }
    return text;
  }
  return 'AVAILABLE MODE: A human host may reply manually. If the conversation history already contains a Host: message that answered the guest, keep your reply empty of new commitments and prefer silence unless still necessary. Guest should never be told they are talking to a bot.';
}

async function writeAlert(db, { reason, phone, guestName = '', room = '', message = '', mode = '' }) {
  try {
    await db.collection('whatsapp_alerts').add({
      reason,
      phone: phone || '',
      guestName,
      room,
      message,
      mode,
      resolved: false,
      createdAt: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.error('writeAlert failed:', err);
  }
}

/** Best-effort free-form WhatsApp notification to the owner. Never throws. */
async function notifyOwner(ownerPhone, text) {
  const to = normalizePhone(ownerPhone);
  if (!to) return;
  try {
    const data = await sendWhatsAppMessage({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text },
    });
    if (!data?.messages) {
      console.error('notifyOwner: Meta error —', JSON.stringify(data));
    }
  } catch (err) {
    console.error('notifyOwner: fetch failed:', err);
  }
}

// ---- Guest location identification (Shartava vs Freedom Square vs Orbeliani) --

/** Merges a patch onto whatsapp_conversations/{phone}. Best-effort; logs and swallows errors. */
async function mergeConversation(db, phone, patch) {
  try {
    await db.collection('whatsapp_conversations').doc(phone).set(
      { ...patch, updatedAt: FieldValue.serverTimestamp() },
      { merge: true }
    );
  } catch (err) {
    console.error(`mergeConversation failed for ${phone}:`, err);
  }
}

const OWNER_ALERT_DEBOUNCE_MS = 30 * 60 * 1000; // 30 minutes

/** Best-effort owner notify, debounced per-conversation via lastAlertSentAt (skips within 30 min). */
async function alertOwnerDebounced(db, config, convo, phone, text) {
  const lastAlertAt = toJsDate(convo?.lastAlertSentAt);
  if (lastAlertAt && Date.now() - lastAlertAt.getTime() < OWNER_ALERT_DEBOUNCE_MS) {
    console.log(`whatsappBotWorker: owner alert debounced for ${phone}`);
    return;
  }
  if (config.ownerPhone) {
    await notifyOwner(config.ownerPhone, text);
  }
  await mergeConversation(db, phone, { lastAlertSentAt: FieldValue.serverTimestamp() });
}

const FORM_LINK_TEXT = 'Hi, please fill in our check-in form, your access instructions will be available on that page: app.maxelaapartments.com/checkin-guest';

/**
 * Resolves whether this batch belongs to the Shartava AI bot, following the exact
 * Step 0-3 identification order. May merge whatsapp_conversations/{phone} and, in
 * Step 3, send the check-in form link or a debounced owner alert as a side effect —
 * those are the only WhatsApp sends this function makes; it never calls Claude.
 *
 * Returns either:
 *   { proceed: false, reason }   — stop; no Claude call, no guest reply beyond any
 *                                  form-link/alert already sent above.
 *   { proceed: true, aptId, guestName, reservationNumber, hasFilledForm }
 */
async function identifyGuestLocation(db, phone, convo, combinedGuestText, config) {
  const aptId = convo?.aptId || '';

  // STEP 0 — decide from the cached conversation doc alone when possible (0 extra reads)
  if (aptId) {
    const brand = aptIdToBrand(aptId);
    if (brand === 'freedom') return { proceed: false, reason: 'aptId_tab' };
    if (brand === 'orbeliani') return { proceed: false, reason: 'aptId_orb' };
    if (brand === 'shartava') {
      return {
        proceed: true,
        aptId,
        guestName: convo.guestName || 'Guest',
        reservationNumber: convo.reservationNumber || '',
        hasFilledForm: !!convo.formFilledAt,
      };
    }
    // Unrecognized prefix cached on the conversation doc — fall through to STEP 1,
    // which re-resolves it via checkin_guests and lands on the same "unknown
    // aptId prefix" alert-and-stay-silent branch.
  } else if (convo?.locationBrand === 'freedom' && !convo.formFilledAt) {
    // Keyword-only Freedom classification, no form filled yet.
    return { proceed: false, reason: 'brand_freedom_keyword' };
  }

  // STEP 1 — checkin_guests phone lookup (authoritative; aptId always wins over
  // a keyword-derived brand). Reuses the existing phone-variant lookup.
  const form = await findGuestByWhatsAppPhone(db, phone);
  if (form) {
    const formAptId = form.aptId || '';
    const brand = aptIdToBrand(formAptId);
    const reservationNumber = baseReservationNumber(form.matchedReservationId);
    const guestName = form.name || 'Guest';

    if (brand === 'freedom' || brand === 'orbeliani' || brand === 'shartava') {
      await mergeConversation(db, phone, {
        locationBrand: brand,
        aptId: formAptId,
        guestName,
        reservationNumber,
        formFilledAt: FieldValue.serverTimestamp(),
      });
      if (brand === 'freedom') return { proceed: false, reason: 'aptId_tab' };
      if (brand === 'orbeliani') return { proceed: false, reason: 'aptId_orb' };
      return { proceed: true, aptId: formAptId, guestName, reservationNumber, hasFilledForm: true };
    }

    // Unknown aptId prefix — do not guess a brand, alert the owner (debounced), stay silent.
    await alertOwnerDebounced(
      db, config, convo, phone,
      `Unknown apartment prefix "${formAptId}" for ${guestName} (${phone}) — needs manual routing.`
    );
    return { proceed: false, reason: 'unknown_aptId_prefix' };
  }

  // STEP 2 — Freedom Square keywords (only reached with no authoritative aptId)
  if (matchesFreedomKeywords(combinedGuestText)) {
    await mergeConversation(db, phone, { locationBrand: 'freedom' });
    return { proceed: false, reason: 'brand_freedom_keyword' };
  }

  // STEP 3 — unknown guest, no Freedom keywords
  const formLinkAlreadyConfirmed = !!convo?.formLinkSentAt && convo?.formLinkStatus === 'sent';
  if (!formLinkAlreadyConfirmed) {
    const sendResult = await sendWhatsAppMessage({
      messaging_product: 'whatsapp',
      to: phone,
      type: 'text',
      text: { body: FORM_LINK_TEXT },
    });
    if (sendResult?.messages) {
      await mergeConversation(db, phone, { formLinkSentAt: FieldValue.serverTimestamp(), formLinkStatus: 'sent' });
      console.log(`whatsappBotWorker: form link sent to ${phone}`);
    } else {
      await mergeConversation(db, phone, { formLinkStatus: 'failed' });
      console.error(`whatsappBotWorker: form link send failed for ${phone} —`, JSON.stringify(sendResult));
    }
    return { proceed: false, reason: 'unknown_first_contact' };
  }

  // Form link already sent and confirmed — a repeat message from an unidentified
  // guest. Alert the owner (debounced) instead of guessing or calling Claude.
  await alertOwnerDebounced(
    db, config, convo, phone,
    `Unidentified guest ${phone} messaged again (form link already sent): "${combinedGuestText}"`
  );
  return { proceed: false, reason: 'unknown_repeat' };
}

// ---- Inbound content classification ----------------------------------------

/** Returns the text to store for an inbound message, or a bracketed placeholder for non-text types. */
function classifyIncomingContent(msg) {
  if (msg.text?.body) return msg.text.body;
  const type = msg.type;
  if (type === 'audio' || type === 'voice') return '[audio]';
  if (type === 'image' || type === 'sticker') return '[image]';
  if (type === 'video') return '[video]';
  return '[unsupported]';
}

// ---- Message batching (whatsapp_pending) ------------------------------------

/** Adds `text` to the guest's pending batch, rotating batchToken so any in-flight worker for the old token no-ops. */
async function upsertPendingMessage(db, phone, text) {
  const batchToken = crypto.randomUUID();
  const pendingRef = db.collection('whatsapp_pending').doc(phone);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(pendingRef);
    if (snap.exists) {
      tx.update(pendingRef, {
        messages: FieldValue.arrayUnion(text),
        lastMessageAt: FieldValue.serverTimestamp(),
        batchToken,
        phone,
      });
    } else {
      tx.set(pendingRef, {
        messages: [text],
        batchStartedAt: FieldValue.serverTimestamp(),
        lastMessageAt: FieldValue.serverTimestamp(),
        batchToken,
        phone,
      });
    }
  });
  return batchToken;
}

/** Deletes whatsapp_pending/{phone} only if its batchToken still matches — avoids racing a newer burst. */
async function deletePendingIfTokenMatches(db, phone, batchToken) {
  const pendingRef = db.collection('whatsapp_pending').doc(phone);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(pendingRef);
    if (snap.exists && snap.data().batchToken === batchToken) {
      tx.delete(pendingRef);
    }
  });
}

/** Enqueues a Cloud Task that calls whatsappBotWorker after `delaySeconds`. Logs and no-ops on failure. */
async function enqueueBotWorker({ phone, batchToken, delaySeconds }) {
  const workerUrl = WHATSAPP_BOT_WORKER_URL.value();
  if (!workerUrl) {
    console.error('enqueueBotWorker: WHATSAPP_BOT_WORKER_URL is not configured — see README "Cloud Tasks setup"');
    return;
  }
  const project  = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || 'sleepy-5c962';
  const queuePath = tasksClient.queuePath(project, TASKS_LOCATION, TASKS_QUEUE);
  const invokerSa = WHATSAPP_TASKS_INVOKER_SA.value();

  const task = {
    httpRequest: {
      httpMethod: 'POST',
      url: workerUrl,
      headers: { 'Content-Type': 'application/json' },
      body: Buffer.from(JSON.stringify({ phone, batchToken })).toString('base64'),
      ...(invokerSa ? { oidcToken: { serviceAccountEmail: invokerSa } } : {}),
    },
    scheduleTime: { seconds: Math.floor(Date.now() / 1000) + Math.max(0, Math.round(delaySeconds)) },
  };

  try {
    await tasksClient.createTask({ parent: queuePath, task });
  } catch (err) {
    console.error('enqueueBotWorker: createTask failed:', err);
  }
}

// -----------------------------------------------------------------------------

exports.whatsappWebhook = onRequest(
  { region: 'europe-west1', cors: true, secrets: ['WEBHOOK_VERIFY_TOKEN', 'META_ACCESS_TOKEN', 'META_PHONE_NUMBER_ID', 'ANTHROPIC_API_KEY'] },
  async (req, res) => {
    // GET — Meta webhook verification
    if (req.method === 'GET') {
      const mode  = req.query['hub.mode'];
      const token = req.query['hub.verify_token'];
      const challenge = req.query['hub.challenge'];

      if (mode === 'subscribe' && token === process.env.WEBHOOK_VERIFY_TOKEN) {
        return res.status(200).send(challenge);
      }
      return res.status(403).send('Forbidden');
    }

    // POST — incoming message / echo. Architecture rule: no long waits here — accept
    // work, hand off delayed replies to the Cloud Tasks worker, return 200 fast.
    if (req.method === 'POST') {
      try {
        const body  = req.body;
        const value = body?.entry?.[0]?.changes?.[0]?.value;
        const db    = getFirestore();

        // CHANGE 3 — coexistence owner echoes (owner/app replied from the WhatsApp Business app).
        // Field name per Meta's Business Coexistence webhook; some accounts may expose it as
        // `message_echoes` instead — check both defensively.
        const echoes = value?.smb_message_echoes || value?.message_echoes;
        if (Array.isArray(echoes) && echoes.length > 0) {
          for (const echo of echoes) {
            // An echo is a message the business (owner) sent TO the guest, so the guest's
            // number is `to`, not `from` (which is the business number).
            const guestPhone = normalizePhone(echo.to || echo.recipient_id || echo.from);
            if (!guestPhone) continue;
            const echoText = echo.text?.body || classifyIncomingContent(echo);
            await db.collection('whatsapp_conversations').doc(guestPhone)
              .collection('messages').add({
                role: 'owner',
                content: echoText,
                timestamp: FieldValue.serverTimestamp(),
                metaMessageId: echo.id || null,
              });
          }
          // Owner echoes never enqueue a bot reply.
          return res.sendStatus(200);
        }

        const messages = value?.messages;

        // Status updates / other non-message payloads — acknowledge and exit
        if (!messages || messages.length === 0) {
          return res.sendStatus(200);
        }

        const msg   = messages[0];
        const phone = normalizePhone(msg.from);
        if (!phone) return res.sendStatus(200);

        const text = classifyIncomingContent(msg);

        const convoRef    = db.collection('whatsapp_conversations').doc(phone);
        const messagesRef = convoRef.collection('messages');

        // Always persist the inbound message first, regardless of bot state
        await messagesRef.add({
          role: 'user',
          content: text,
          timestamp: FieldValue.serverTimestamp(),
          metaMessageId: msg.id || null,
        });

        // Early SILENT exit for guests already known to be Freedom Square / Orbeliani —
        // saves a config read, a whatsapp_pending write, and a Cloud Task enqueue for a
        // conversation the Shartava bot must never answer. The worker re-derives this
        // independently (STEP 0) for any case not safely known here — this is a cost
        // optimization only, never the sole source of truth.
        const earlyConvoSnap = await convoRef.get();
        const earlyConvo = earlyConvoSnap.exists ? earlyConvoSnap.data() : null;
        const earlyAptId = earlyConvo?.aptId || '';
        if (earlyAptId.startsWith('tab-') || earlyAptId.startsWith('orb-')) {
          console.log(`whatsappWebhook: early SILENT (known aptId ${earlyAptId}) for ${phone}`);
          return res.sendStatus(200);
        }
        if (earlyConvo?.locationBrand === 'freedom' && !earlyConvo.formFilledAt && !earlyAptId) {
          console.log(`whatsappWebhook: early SILENT (brand_freedom_keyword, no form) for ${phone}`);
          return res.sendStatus(200);
        }

        const config = await getGlobalsConfig(db);

        // CHANGE 1 — hard kill switch
        if (config.aiBotEnabled === false) {
          await writeAlert(db, { reason: 'bot_paused', phone, message: text });
          if (config.ownerPhone) {
            await notifyOwner(config.ownerPhone, `AI assistant is paused. New WhatsApp message from ${phone}: "${text}"`);
          }
          return res.sendStatus(200);
        }

        // CHANGE 2 — batch into whatsapp_pending and hand off to the Cloud Tasks worker
        const batchToken = await upsertPendingMessage(db, phone, text);

        const effectiveMode = resolveEffectiveMode(config);
        const configuredDelay = Number(config.botResponseDelay) || CONFIG_DEFAULTS.botResponseDelay;
        // Away/night still debounce rapid bursts, but don't make the guest wait the full
        // human-first delay — cap at 3s.
        const delaySeconds = effectiveMode === 'available' ? configuredDelay : Math.min(configuredDelay, 3);

        await enqueueBotWorker({ phone, batchToken, delaySeconds });

        return res.sendStatus(200);
      } catch (err) {
        console.error('whatsappWebhook error:', err);
        return res.sendStatus(200);
      }
    }

    return res.sendStatus(405);
  }
);

// ---- Deferred worker: builds the reply for one debounced batch --------------

exports.whatsappBotWorker = onRequest(
  {
    region: 'europe-west1',
    timeoutSeconds: 120,
    invoker: 'private', // only IAM principals granted Cloud Run Invoker (the Cloud Tasks SA) may call this
    secrets: ['META_ACCESS_TOKEN', 'META_PHONE_NUMBER_ID', 'ANTHROPIC_API_KEY'],
  },
  async (req, res) => {
    try {
      const { phone, batchToken } = req.body || {};
      if (!phone || !batchToken) {
        console.error('whatsappBotWorker: missing phone or batchToken in payload');
        return res.sendStatus(200); // malformed task — don't retry
      }

      const db = getFirestore();
      const config = await getGlobalsConfig(db);

      // Kill switch may have flipped after the task was enqueued
      if (config.aiBotEnabled === false) return res.sendStatus(200);

      const pendingRef = db.collection('whatsapp_pending').doc(phone);
      const pendingSnap = await pendingRef.get();
      if (!pendingSnap.exists) return res.sendStatus(200);

      const pending = pendingSnap.data();
      // A newer message arrived and rescheduled work under a fresh token — this run is stale
      if (pending.batchToken !== batchToken) return res.sendStatus(200);

      const effectiveMode = resolveEffectiveMode(config);
      const convoRef         = db.collection('whatsapp_conversations').doc(phone);
      const convoMessagesRef = convoRef.collection('messages');
      const combinedGuestText = (pending.messages || []).join('\n');

      // Location identification: Freedom Square / Orbeliani must stay SILENT even
      // though they share this WhatsApp number with Shartava. Re-checked here (not
      // just in the webhook) since bot state can change between enqueue and run.
      const convoSnap = await convoRef.get();
      const convo = convoSnap.exists ? convoSnap.data() : null;

      const identity = await identifyGuestLocation(db, phone, convo, combinedGuestText, config);
      if (!identity.proceed) {
        console.log(`whatsappBotWorker: SILENT (${identity.reason}) for ${phone}`);
        await deletePendingIfTokenMatches(db, phone, batchToken);
        return res.sendStatus(200);
      }

      if (effectiveMode === 'available') {
        const batchStart = pending.batchStartedAt || pending.lastMessageAt;
        const ownerSnap = await convoMessagesRef
          .where('role', '==', 'owner')
          .where('timestamp', '>=', batchStart)
          .limit(1)
          .get();
        if (!ownerSnap.empty) {
          // Owner already answered in the WhatsApp Business app — stay silent.
          await deletePendingIfTokenMatches(db, phone, batchToken);
          return res.sendStatus(200);
        }
      }

      const guestName    = identity.guestName || 'Guest';
      const roomCode     = identity.aptId || '';
      const hasFilledForm = !!identity.hasFilledForm;
      let checkinDate  = '';
      let checkoutDate = '';

      const resNumber = baseReservationNumber(identity.reservationNumber);
      if (resNumber) {
        const resSnap = await db.collection('reservations')
          .where('reservationNumber', '==', resNumber)
          .limit(1)
          .get();
        if (!resSnap.empty) {
          const reservation = resSnap.docs[0].data();
          checkinDate  = reservation.checkin || '';
          checkoutDate = reservation.checkout || '';
        }
      }

      let memoryContext = '';
      const guestDoc = await db.collection('whatsapp_guests').doc(phone).get();
      if (guestDoc.exists) {
        const summary = guestDoc.data().summary;
        if (Array.isArray(summary) && summary.length > 0) {
          memoryContext = `\nPrevious stay notes for this guest: ${summary.map((s) => `- ${s}`).join(' ')}`;
        }
      }

      // Last 15 messages as conversation history. Owner echoes map to an assistant turn
      // prefixed "Host: " so the model knows a human already responded.
      const historySnap = await convoMessagesRef.orderBy('timestamp', 'desc').limit(15).get();
      const history = historySnap.docs
        .map((d) => d.data())
        .reverse()
        .map((m) => {
          if (m.role === 'owner') return { role: 'assistant', content: `Host: ${m.content}` };
          if (m.role === 'assistant') return { role: 'assistant', content: m.content };
          return { role: 'user', content: m.content };
        });

      const guestContext = [
        `Guest name: ${guestName}`,
        `Room/apartment type: ${roomCode || 'unknown'}`,
        `Check-in: ${checkinDate || 'unknown'}`,
        `Checkout: ${checkoutDate || 'unknown'}`,
        `Filled check-in form: ${hasFilledForm ? 'yes' : 'no'}`,
      ].join('\n') + memoryContext;

      const modeContext = buildModeContext(effectiveMode, config.ownerPhone);
      const systemWithContext = `${SYSTEM_PROMPT}\n\n${guestContext}\n\n${modeContext}`;

      let aiReply = await callClaude({ system: systemWithContext, messages: history });

      let escalated = false;
      let escalationReason = 'escalation';

      if (!aiReply) {
        aiReply = 'Let me check on that and get back to you shortly.';
        escalated = true;
        escalationReason = 'unhandled_message';
      }

      // Parse an optional [VIDEO:media_id] prefix
      let videoMediaId = null;
      const videoMatch = aiReply.match(/^\[VIDEO:(\d+)\]\s*\n?/);
      if (videoMatch) {
        videoMediaId = videoMatch[1];
        aiReply = aiReply.slice(videoMatch[0].length).trim();
      }

      // Strip a trailing [ESCALATE] tag — internal only, never sent to WhatsApp
      const hasEscalateTag = /\[ESCALATE\]/i.test(aiReply);
      aiReply = aiReply.replace(/\s*\[ESCALATE\]\s*/gi, ' ').replace(/\s+$/, '').trim();
      if (hasEscalateTag) {
        escalated = true;
        escalationReason = 'escalation';
      }

      // Small humanizer — short, after Claude, before send. Not the batching delay.
      await sleep(1000 + Math.random() * 1000);

      if (videoMediaId) {
        await sendWhatsAppMessage({
          messaging_product: 'whatsapp',
          to: phone,
          type: 'video',
          video: { id: videoMediaId },
        });
      }

      await sendWhatsAppMessage({
        messaging_product: 'whatsapp',
        to: phone,
        type: 'text',
        text: { body: aiReply },
      });

      await convoMessagesRef.add({
        role: 'assistant',
        content: aiReply,
        timestamp: FieldValue.serverTimestamp(),
      });

      if (escalated) {
        await writeAlert(db, {
          reason: escalationReason,
          phone,
          guestName,
          room: roomCode,
          message: combinedGuestText,
          mode: effectiveMode,
        });

        if (config.ownerPhone) {
          await notifyOwner(
            config.ownerPhone,
            `Guest needs help — ${guestName} / ${roomCode || 'unknown room'} / mode=${effectiveMode}: ${combinedGuestText}`
          );
        }
      }

      await deletePendingIfTokenMatches(db, phone, batchToken);

      return res.sendStatus(200);
    } catch (err) {
      console.error('whatsappBotWorker error:', err);
      return res.sendStatus(200); // clean completion so Cloud Tasks does not retry indefinitely
    }
  }
);

exports.roomReadyNotification = onDocumentWritten(
  {
    document: 'hk_status/{docId}',
    region: 'europe-west1',
    secrets: ['META_ACCESS_TOKEN', 'META_PHONE_NUMBER_ID'],
  },
  async (event) => {
    const before = event.data.before;
    const after  = event.data.after;

    // Only fire when done flips TO true
    if (!after.exists) return;
    if (after.data().done !== true) return;
    if (before.exists && before.data().done === true) return;

    const { roomCode, date } = after.data();
    if (!roomCode || !date) return;

    const db = getFirestore();

    const snap = await db.collection('checkin_guests')
      .where('aptId', '==', roomCode)
      .where('arrivalDate', '==', date)
      .where('contactType', '==', 'wa')
      .limit(1)
      .get();

    if (snap.empty) {
      console.log(`roomReadyNotification: no WA guest for ${roomCode} / ${date}`);
      return;
    }

    const guest = snap.docs[0].data();
    const phone = normalizePhone(guest.contact);
    const name  = guest.name || 'Guest';
    const firstName = guestFirstName(name);
    const reservationNumber = baseReservationNumber(guest.matchedReservationId);

    if (!phone) {
      console.log(`roomReadyNotification: guest found but no phone for ${roomCode} / ${date}`);
      return;
    }

    if (reservationNumber && await alreadySentRoomReady(db, reservationNumber)) {
      console.log(`roomReadyNotification: already sent for reservation ${reservationNumber}`);
      return;
    }

    try {
      const data = await sendWhatsAppMessage({
        messaging_product: 'whatsapp',
        to: phone,
        type: 'template',
        template: {
          name: 'room_ready',
          language: { code: 'en' },
          components: [{
            type: 'body',
            parameters: [{ type: 'text', text: firstName }],
          }],
        },
      });

      if (data.messages) {
        const metaMessageId = data.messages[0]?.id || '';
        await writeRoomReadyRecord(db, {
          reservationNumber,
          guestName: name,
          phone,
          status: 'sent',
          metaMessageId,
        });
        console.log(`roomReadyNotification: sent to ${name} (${phone}) — id=${metaMessageId}`);
      } else {
        await writeRoomReadyRecord(db, {
          reservationNumber,
          guestName: name,
          phone,
          status: 'failed',
        });
        console.error(`roomReadyNotification: Meta error for ${phone} —`, JSON.stringify(data));
      }
    } catch (err) {
      await writeRoomReadyRecord(db, {
        reservationNumber,
        guestName: name,
        phone,
        status: 'failed',
      }).catch(() => {});
      console.error(`roomReadyNotification: fetch failed for ${phone}`, err);
    }
  }
);

// PART 3 — auto-summarize a guest's WhatsApp conversation after checkout
exports.summarizeGuestConversation = onDocumentWritten(
  {
    document: 'reservations/{docId}',
    region: 'europe-west1',
    secrets: ['ANTHROPIC_API_KEY'],
  },
  async (event) => {
    const after = event.data?.after;
    if (!after || !after.exists) return;

    const reservation = after.data();

    if (reservation.status === 'CANCELLED') return;

    const checkoutDate = toJsDate(reservation.checkout);
    if (!checkoutDate) return;

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (checkoutDate >= today) return;

    const reservationNumber = reservation.reservationNumber;
    if (!reservationNumber) return;

    const db = getFirestore();

    // Find the matching WhatsApp check-in form for this reservation.
    // matchedReservationId may be the bare number or a multi-room id like "007004653_001".
    let form = null;
    const exactSnap = await db.collection('checkin_guests')
      .where('matchedReservationId', '==', reservationNumber)
      .where('contactType', '==', 'wa')
      .limit(1)
      .get();

    if (!exactSnap.empty) {
      form = exactSnap.docs[0].data();
    } else {
      // Range query alone (no contactType) avoids needing a new composite index.
      const multiSnap = await db.collection('checkin_guests')
        .where('matchedReservationId', '>=', `${reservationNumber}_`)
        .where('matchedReservationId', '<', `${reservationNumber}_`)
        .limit(20)
        .get();
      const match = multiSnap.docs.find((d) => (d.data().contactType || '').toLowerCase() === 'wa');
      if (match) form = match.data();
    }

    if (!form) return;

    const phone = normalizePhone(form.contact);
    if (!phone) return;

    const messagesRef = db.collection('whatsapp_conversations').doc(phone).collection('messages');
    const messagesSnap = await messagesRef.orderBy('timestamp', 'asc').get();

    if (messagesSnap.empty) return;

    const conversationText = messagesSnap.docs
      .map((d) => {
        const m = d.data();
        return `${m.role === 'assistant' ? 'Assistant' : m.role === 'owner' ? 'Host' : 'Guest'}: ${m.content}`;
      })
      .join('\n');

    let summaryText = '';
    try {
      summaryText = await callClaude({
        system: SUMMARY_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: conversationText }],
      });
    } catch (err) {
      console.error(`summarizeGuestConversation: Claude call failed for ${phone}`, err);
      return;
    }

    const summaryBullets = summaryText
      .split('\n')
      .map((line) => line.replace(/^[-•*]\s*/, '').trim())
      .filter((line) => line.length > 0);

    if (summaryBullets.length === 0) return;

    await db.collection('whatsapp_guests').doc(phone).set(
      {
        summary: summaryBullets,
        lastStay: {
          room: reservation.roomCode || '',
          checkin: reservation.checkin || '',
          checkout: reservation.checkout || '',
          reservationNumber,
        },
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    // Delete all messages from this conversation now that it's summarized
    const batch = db.batch();
    messagesSnap.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();

    console.log(`summarizeGuestConversation: summarized ${phone} for reservation ${reservationNumber}`);
  }
);

// Consistency layer: keeps whatsapp_conversations/{phone} in sync with checkin_guests
// (room re-assignments, new form submissions) so brand identification never goes stale.
// A Shartava aptId here always overwrites any prior keyword-derived "freedom" brand.
exports.syncCheckinGuestToConversation = onDocumentWritten(
  {
    document: 'checkin_guests/{docId}',
    region: 'europe-west1',
  },
  async (event) => {
    const after = event.data?.after;
    if (!after || !after.exists) return; // deleted — no-op

    const data = after.data();
    if ((data.contactType || '').toLowerCase() !== 'wa') return;

    const phone = normalizePhone(data.contact);
    if (!phone) return;

    const aptId = data.aptId || '';
    const brand = aptIdToBrand(aptId);
    if (!brand) return; // unrecognized prefix — leave conversation state as-is; the
                         // worker's STEP 1 owner-alert path handles this case

    const guestName = data.name || 'Guest';
    const reservationNumber = baseReservationNumber(data.matchedReservationId);

    const db = getFirestore();
    await db.collection('whatsapp_conversations').doc(phone).set(
      {
        locationBrand: brand,
        aptId,
        guestName,
        reservationNumber,
        formFilledAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    console.log(`syncCheckinGuestToConversation: ${phone} -> ${brand} (${aptId})`);
  }
);
