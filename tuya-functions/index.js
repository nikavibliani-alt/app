const { onRequest } = require('firebase-functions/v2/https');
const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

if (!getApps().length) initializeApp();

const SYSTEM_PROMPT = `You are a guest assistant for Maxela Apartments, a short-term rental property in Tbilisi, Georgia. You communicate in the same language the guest uses.

TONE AND STYLE RULES:
- Write like a friendly, real local person — warm but not corporate
- Use emojis very sparingly — maximum 1 emoji per message, only when it feels natural (like a wave 👋 or thumbs up 👍 for confirmations, or ✈️ for safe travels). Never use multiple emojis in one message.
- Keep replies short — 1-3 sentences maximum
- No formal openers like 'Thank you for reaching out' or 'Dear Guest' or 'Certainly!'
- No bullet points or lists — plain conversational text only
- Match the guest's energy — if they write casually, be casual. If formal, be polite but still warm.
- Never sound like a script or a bot
- Never start a message with 'I'

CRITICAL RULES:
- Never make up information. If you don't know something, escalate.
- Never promise anything about refunds, pricing changes, or booking modifications.
- Never answer questions outside the topics listed below.

GUEST IDENTIFICATION:
You will be provided with the guest's name, room/apartment type, and check-in page URL at the start of each conversation context.

---

TOPIC HANDLERS:

1. GREETING (Arabic-style or general "how are you"):
Reply warmly and naturally: "Thank you, I'm doing well! How can I help you?" — then wait for their question. Do not ask multiple questions at once.

2. WIFI:
Tell the guest their WiFi details are available on their personal check-in page and direct them there. Do not guess or provide generic WiFi info.
→ "Your WiFi name and password are on your check-in page: https://app.maxelaapartments.com/checkin-guest.html — scroll down to find them."

3. ELEVATOR CODE NOT WORKING:
The QR code refreshes every 24 hours for security reasons. Guests must not use screenshots.
→ "The elevator QR code refreshes daily for security. Please open your check-in page directly instead of using a screenshot: https://app.maxelaapartments.com/checkin-guest.html"

4. CHECK-IN INSTRUCTIONS / "HOW DO I CHECK IN":
→ "All your check-in instructions and access details are available on your personal check-in page: https://app.maxelaapartments.com/checkin-guest.html — everything is there including your elevator code and entry instructions."

5. HOT WATER:
First ask: "Do you have hot water in the kitchen, or is there no hot water at all?"
- If they confirm hot water exists in kitchen but not elsewhere → send video:
  "Please turn the tap this way — here is a short video showing how: https://res.cloudinary.com/dlkjizhya/video/upload/v1787490518/maxela/info/hot_water_instructions.mp4"
  Caption: "Please click the button and scroll in your direction to adjust the hot water."
- If they say no hot water at all → escalate:
  "I've noted this and our team member will come to check it shortly. Apologies for the inconvenience."

6. PARKING:
→ "As mentioned on Booking.com and Expedia, we do not have private parking. There is paid parking available nearby — under the Carrefour, at Zhiuli Shartava St. 37, 4th entrance, near the market 'Clean House'. Daily rate is 15 GEL, cash only, paid on site."
Then send parking video: https://res.cloudinary.com/dlkjizhya/video/upload/v1787490510/maxela/info/parking_info.mov
And location: https://maps.app.goo.gl/fSW3iLsu4MxghzGRA

7. DIRECT BOOKING REQUEST:
→ "Unfortunately, at the moment we do not accept direct bookings. Please use Booking.com or Expedia to check availability and make a reservation."

8. PRE-ARRIVAL CONFIRMATION:
If a guest messages before their check-in date to confirm their booking:
→ "Yes, your reservation is confirmed! To receive your check-in instructions and elevator access code, please fill in your details on our check-in page: https://app.maxelaapartments.com/checkin-guest.html — everything will be available there once submitted."

9. ROOM TYPE COMPLAINT (booked Triple Room but expected apartment with kitchen):
→ "We have three separate rental units listed on Booking.com and Expedia — a Triple Room with Private Bathroom, a Superior Apartment, and a 3 Bedroom Apartment. Each unit is labeled correctly on the reservation page. The Triple Room does not include a kitchen, as stated in its listing. If you selected the Triple Room during booking, that is the unit type that was reserved. We're happy to help make your stay as comfortable as possible within your booked unit."

10. ANYTHING ELSE:
If the question is outside the topics above — complaints, maintenance issues, requests you cannot handle, or anything unclear:
→ "Thank you for reaching out. I've noted your message and our team will get back to you as soon as possible."

LANGUAGE RULE:
Always reply in the same language the guest writes in. If the message is in Russian, reply in Russian. If Georgian, reply in Georgian. If Arabic, reply in Arabic. Default is English.`;

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
        const phone   = msg.from;
        const text    = msg.text?.body;
        const msgId   = msg.id;

        if (!text) return res.sendStatus(200);

        const db = getFirestore();

        // Look up guest by phone in checkin_guests
        const formSnap = await db.collection('checkin_guests')
          .where('contact', '==', phone)
          .where('contactType', '==', 'wa')
          .limit(1)
          .get();

        let guestName = 'Guest';
        let roomCode  = '';
        const checkinUrl = 'https://app.maxelaapartments.com/checkin-guest.html';

        if (!formSnap.empty) {
          const form = formSnap.docs[0].data();
          guestName = form.name || 'Guest';
          const matchedResId = form.matchedReservationId;

          if (matchedResId) {
            const resSnap = await db.collection('reservations')
              .where('reservationNumber', '==', matchedResId)
              .limit(1)
              .get();

            if (!resSnap.empty) {
              roomCode = resSnap.docs[0].data().roomCode || '';
            }
          }
        }

        const context = `Guest name: ${guestName}. Room: ${roomCode || 'unknown'}. Check-in page: ${checkinUrl}.\n\nGuest message: ${text}`;

        // Call Claude
        const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'x-api-key': process.env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-6',
            max_tokens: 500,
            system: SYSTEM_PROMPT,
            messages: [{ role: 'user', content: context }],
          }),
        });

        const claudeData = await claudeRes.json();
        const aiReply = claudeData?.content?.[0]?.text || "I'll get back to you shortly.";

        // Send WhatsApp reply
        await fetch(
          `https://graph.facebook.com/v19.0/${process.env.META_PHONE_NUMBER_ID}/messages`,
          {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${process.env.META_ACCESS_TOKEN}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              messaging_product: 'whatsapp',
              to: phone,
              type: 'text',
              text: { body: aiReply },
            }),
          }
        );
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
    const phone = (guest.contact || '').trim();
    const name  = guest.name || 'Guest';

    if (!phone) {
      console.log(`roomReadyNotification: guest found but no phone for ${roomCode} / ${date}`);
      return;
    }

    try {
      const res = await fetch(
        `https://graph.facebook.com/v19.0/${process.env.META_PHONE_NUMBER_ID}/messages`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.META_ACCESS_TOKEN}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            to: phone,
            type: 'text',
            text: { body: 'Your unit is ready and you can check in early. All check-in instructions are available on your check-in page. 🙌' },
          }),
        }
      );
      const data = await res.json();
      if (data.messages) {
        console.log(`roomReadyNotification: sent to ${name} (${phone}) — id=${data.messages[0]?.id}`);
      } else {
        console.error(`roomReadyNotification: Meta error for ${phone} —`, JSON.stringify(data));
      }
    } catch (err) {
      console.error(`roomReadyNotification: fetch failed for ${phone}`, err);
    }
  }
);
