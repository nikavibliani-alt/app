const { onRequest } = require('firebase-functions/v2/https');
const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

if (!getApps().length) initializeApp();

const SYSTEM_PROMPT = `You are a guest assistant for Maxela Apartments in Tbilisi, Georgia. You handle guest questions via WhatsApp. Be friendly and natural, like a helpful local person. Never sound like a corporate bot.

TONE RULES:
- Short natural replies, 1-3 sentences maximum
- No exclamation marks
- No bullet points or lists in replies
- No dashes in replies
- No AI filler phrases like Certainly, Of course, Thank you for reaching out, I understand, I hope this helps
- Use emojis very sparingly, maximum 1 per message, only when it feels completely natural
- Match the guest language if they write in Russian or Arabic, otherwise reply in English
- If guest writes in Persian/Farsi, reply in English

GUEST CONTEXT (provided with each message):
- Guest name
- Room/apartment type
- Check-in and checkout dates
- Whether they filled the check-in form or not
- Previous stay notes if returning guest

SCENARIOS:

First contact or reservation confirmation:
Reply: Hi, please fill in this form to get your check-in instructions, everything will be available on that page: app.maxelaapartments.com/checkin-guest

Guest filled form but cannot see instructions:
Reply: It should be visible on that page, try refreshing it.

QR code not working (first mention in this conversation):
Reply: Are you opening the page directly or using a screenshot?
If guest says screenshot: The code refreshes daily so screenshots won't work. Open the page directly: app.maxelaapartments.com/checkin-guest
If guest says website: Got it, we will check and fix it as soon as possible.

QR code not working (already discussed earlier in conversation history):
Reply: I see you had this issue before, let me escalate this to our team right away.
Add [ESCALATE] on its own line after this reply.

Early check-in request:
Reply: Standard check-in is from 3pm. If the room gets ready earlier I will text you and the page will unlock automatically.

Parking question:
Send parking video first (media_id: 975338858914982) then text: The nearest paid parking is under Carrefour. We do not have private parking, daily rate is 15 GEL, cash only. Exact location is on the guest page.

Hot water issue:
First ask: Is there hot water in the kitchen tap or no hot water at all?
If no hot water at all: Our team will come to check it shortly, sorry about that.
If hot water only in kitchen: Send hot water video (media_id: 1819258012553462) then text: Please click the button and scroll in your direction to adjust it.

Bag storage before check-in:
Send bag storage video (media_id: 1804812277340997) then text: Most of our guests leave their belongings there. We do not have lockers and cannot be responsible for any loss, but in 7 years of hosting nothing has ever gone missing there.

Booking or price inquiry:
Reply: Unfortunately we cannot see exact pricing from our side. Reservations are only through Booking.com or Expedia. Which dates are you looking at and do you need a unit with kitchen or without?
If guest confirms dates and preference, send booking link: booking.com/Share-PaJ0WC

Room types information when asked:
Triple Room with Private Bathroom: no kitchen, 1 single bed, 1 double bed, 1 sofa bed, fits up to 4 guests.
Superior Apartment: 1 isolated bedroom with double bed, living room with double bed divided by curtains and 2 sofas, has kitchen.
3 Bedroom Apartment: Bedroom 1 has 2 double beds. Bedroom 2 has 1 double bed and 1 baby bed. Bedroom 3 has 1 double bed. Living room has 3 sofa beds. 1 separate toilet, 2 bathrooms with showers. Has kitchen.

Room type complaint (booked Triple Room but expected kitchen):
Reply: We have three separate unit types on Booking.com, each labeled differently. The Triple Room does not include a kitchen. The Superior Apartment and 3 Bedroom Apartment both have kitchens.

Minimum stay question or one night request:
Reply: Our minimum stay is 2 nights.

Airport transfer:
Reply: Yes, please click on Services on the guest page and it will forward you directly to the driver WhatsApp.

Arabic or Persian greeting like hello how are you:
Reply: Good thank you, how are you? How can I help?

Fully booked situation:
Reply: Sorry, we are fully booked for those dates.

Single bed request:
Reply: Unfortunately we do not have single beds, sorry about that.

Anything outside the above topics such as complaints, maintenance issues, booking modifications, or anything complex:
Reply: Let me check on that and get back to you shortly.
Add [ESCALATE] on its own line after this reply.

FOR SENDING VIDEOS:
When a scenario requires a video, start your response with [VIDEO:media_id] followed by the text message on a new line.
Example: [VIDEO:975338858914982]
The nearest paid parking is under Carrefour...
The Cloud Function will parse this, send the video as a separate WhatsApp message first, then send the text.

FOR ESCALATING TO THE TEAM:
When a scenario above tells you to add [ESCALATE], or the guest's issue is complex, a complaint, a maintenance problem, or a booking modification you cannot resolve yourself, put [ESCALATE] on its own line at the very end of your reply, after the guest-facing text.
Example:
I see you had this issue before, let me escalate this to our team right away.
[ESCALATE]
The Cloud Function will parse this, notify the team, and strip the tag before the message is sent to the guest.`;

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

// ---- Kill switch / escalation helpers -------------------------------------

async function getGlobalsConfig(db) {
  try {
    const snap = await db.collection('globals').doc('config').get();
    return snap.exists ? snap.data() || {} : {};
  } catch (err) {
    console.error('getGlobalsConfig failed:', err);
    return {};
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Human-like reply delay: 2-5 seconds. */
async function humanDelay() {
  await sleep(2000 + Math.random() * 3000);
}

/** Mark the inbound message as read via the documented Meta Cloud API payload. Best-effort. */
async function markMessageAsRead(msgId) {
  if (!msgId) return;
  try {
    const data = await sendWhatsAppMessage({
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: msgId,
    });
    if (data?.error) {
      console.error('markMessageAsRead: Meta error —', JSON.stringify(data));
    }
  } catch (err) {
    console.error('markMessageAsRead failed:', err);
  }
}

/** Returns the current hour (0-23) in Tbilisi local time. */
function tbilisiHour() {
  const formatted = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Tbilisi',
    hour: 'numeric',
    hourCycle: 'h23',
  }).format(new Date());
  return Number(formatted) % 24;
}

/** Night window for owner notifications: 20:00-08:59 Tbilisi time. */
function isTbilisiNight() {
  const h = tbilisiHour();
  return h >= 20 || h < 9;
}

// Exact guest-facing handoff phrases from SYSTEM_PROMPT that also count as an escalation signal.
const ESCALATION_PHRASES = [
  'let me check on that and get back to you shortly',
  'let me escalate this to our team right away',
];

/** Strips a trailing [ESCALATE] tag and reports whether the reply should be escalated. */
function extractEscalation(replyText) {
  const hasTag = /\[ESCALATE\]/i.test(replyText);
  const text = replyText.replace(/\s*\[ESCALATE\]\s*/gi, ' ').replace(/\s+$/,'').trim();
  const lower = text.toLowerCase();
  const matchesPhrase = ESCALATION_PHRASES.some((p) => lower.includes(p));
  return { text, shouldEscalate: hasTag || matchesPhrase };
}

async function writeAlert(db, { reason, phone, guestName = '', room = '', message = '' }) {
  try {
    await db.collection('whatsapp_alerts').add({
      reason,
      phone: phone || '',
      guestName,
      room,
      message,
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

    // POST — incoming message
    if (req.method === 'POST') {
      try {
        const body = req.body;

        const value    = body?.entry?.[0]?.changes?.[0]?.value;
        const messages = value?.messages;

        // Status updates have no messages array — acknowledge and exit
        if (!messages || messages.length === 0) {
          return res.sendStatus(200);
        }

        const msg     = messages[0];
        const phone   = normalizePhone(msg.from);
        const text    = msg.text?.body;
        const msgId   = msg.id;

        if (!text || !phone) return res.sendStatus(200);

        const db = getFirestore();
        const convoRef    = db.collection('whatsapp_conversations').doc(phone);
        const messagesRef = convoRef.collection('messages');

        // CHANGE 1 — kill switch: check globals/config before touching Claude
        const globalsConfig = await getGlobalsConfig(db);
        const aiBotEnabled  = globalsConfig.aiBotEnabled !== false; // missing/undefined -> true
        const ownerPhone    = globalsConfig.ownerPhone || '';

        if (!aiBotEnabled) {
          // Still record the inbound message so nothing is lost while paused
          await messagesRef.add({
            role: 'user',
            content: text,
            timestamp: FieldValue.serverTimestamp(),
          });

          await writeAlert(db, { reason: 'bot_paused', phone, message: text });

          if (ownerPhone) {
            await notifyOwner(ownerPhone, `AI assistant is paused. New WhatsApp message from ${phone}: "${text}"`);
          }

          return res.sendStatus(200);
        }

        // PART 1 — save incoming guest message
        await messagesRef.add({
          role: 'user',
          content: text,
          timestamp: FieldValue.serverTimestamp(),
        });

        // PART 1 — fetch last 15 messages (newest first), then reverse to chronological order
        const historySnap = await messagesRef
          .orderBy('timestamp', 'desc')
          .limit(15)
          .get();

        const history = historySnap.docs
          .map((d) => d.data())
          .reverse()
          .map((m) => ({ role: m.role, content: m.content }));

        // Look up guest by phone in checkin_guests (digits and +digits variants)
        const form = await findGuestByWhatsAppPhone(db, phone);

        let guestName     = 'Guest';
        let roomCode       = '';
        let checkinDate    = '';
        let checkoutDate   = '';
        let hasFilledForm  = false;

        if (form) {
          hasFilledForm = true;
          guestName = form.name || 'Guest';
          const matchedResId = form.matchedReservationId;
          const resNumber = baseReservationNumber(matchedResId);

          if (resNumber) {
            const resSnap = await db.collection('reservations')
              .where('reservationNumber', '==', resNumber)
              .limit(1)
              .get();

            if (!resSnap.empty) {
              const reservation = resSnap.docs[0].data();
              roomCode     = reservation.roomCode || '';
              checkinDate  = reservation.checkin || '';
              checkoutDate = reservation.checkout || '';
            }
          }
        }

        // PART 2 — long-term guest memory
        let memoryContext = '';
        const guestDoc = await db.collection('whatsapp_guests').doc(phone).get();
        if (guestDoc.exists) {
          const summary = guestDoc.data().summary;
          if (Array.isArray(summary) && summary.length > 0) {
            memoryContext = `\nPrevious stay notes for this guest: ${summary.map((s) => `- ${s}`).join(' ')}`;
          }
        }

        const guestContext = [
          `Guest name: ${guestName}`,
          `Room/apartment type: ${roomCode || 'unknown'}`,
          `Check-in: ${checkinDate || 'unknown'}`,
          `Checkout: ${checkoutDate || 'unknown'}`,
          `Filled check-in form: ${hasFilledForm ? 'yes' : 'no'}`,
        ].join('\n') + memoryContext;

        const systemWithContext = `${SYSTEM_PROMPT}\n\n${guestContext}`;

        // PART 1/3 — call Claude with full conversation history
        let aiReply = await callClaude({ system: systemWithContext, messages: history });
        if (!aiReply) aiReply = 'Let me check on that and get back to you shortly.';

        // Parse an optional [VIDEO:media_id] prefix
        let videoMediaId = null;
        const videoMatch = aiReply.match(/^\[VIDEO:(\d+)\]\s*\n?/);
        if (videoMatch) {
          videoMediaId = videoMatch[1];
          aiReply = aiReply.slice(videoMatch[0].length).trim();
        }

        // CHANGE 3 — escalation: parse/strip [ESCALATE] and check handoff phrases
        const escalation = extractEscalation(aiReply);
        aiReply = escalation.text;

        if (escalation.shouldEscalate) {
          await writeAlert(db, {
            reason: 'escalation',
            phone,
            guestName,
            room: roomCode,
            message: aiReply,
          });

          if (ownerPhone && isTbilisiNight()) {
            await notifyOwner(
              ownerPhone,
              `Escalation from ${guestName} (${phone})${roomCode ? ` — room ${roomCode}` : ''}: ${aiReply}`
            );
          }
        }

        // CHANGE 2 — best-effort read receipt, then a human-like pause before replying
        await markMessageAsRead(msgId);
        await humanDelay();

        // Send video first, if present
        if (videoMediaId) {
          await sendWhatsAppMessage({
            messaging_product: 'whatsapp',
            to: phone,
            type: 'video',
            video: { id: videoMediaId },
          });
        }

        // Send text reply
        await sendWhatsAppMessage({
          messaging_product: 'whatsapp',
          to: phone,
          type: 'text',
          text: { body: aiReply },
        });

        // PART 1 — save assistant reply
        await messagesRef.add({
          role: 'assistant',
          content: aiReply,
          timestamp: FieldValue.serverTimestamp(),
        });
      } catch (err) {
        console.error('whatsappWebhook error:', err);
      }

      // Always return 200 to Meta
      return res.sendStatus(200);
    }

    return res.sendStatus(405);
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
        .where('matchedReservationId', '<', `${reservationNumber}_\uf8ff`)
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
        return `${m.role === 'assistant' ? 'Assistant' : 'Guest'}: ${m.content}`;
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
