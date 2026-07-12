const {onRequest} = require('firebase-functions/v2/https');
const {initializeApp} = require('firebase-admin/app');
const {getFirestore} = require('firebase-admin/firestore');

initializeApp();
const db = getFirestore();

function normalizePhone(raw) {
  let p = String(raw || '').replace(/[\s\-\(\)]/g, '');
  if (p.startsWith('00')) p = '+' + p.slice(2);
  if (!p.startsWith('+')) p = '+' + p;
  return p;
}

exports.syncWassengerContact = onRequest(
  {region: 'europe-west1', cors: true},
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).json({success: false, error: 'Method not allowed'});
      return;
    }
    try {
      const {phone, labels} = req.body;
      if (!phone) {
        res.status(400).json({success: false, error: 'phone is required'});
        return;
      }
      const aptId = (labels || [])[1] || '';

      const configSnap = await db.doc('globals/config').get();
      const wassengerKey = configSnap.data()?.wassengerKey;
      if (!wassengerKey) {
        res.json({success: false, error: 'Wassenger key not configured'});
        return;
      }

      // Step 1: find the chat by phone number
      const chatRes = await fetch(
        `https://api.wassenger.com/v1/chats?phone=${encodeURIComponent(phone)}`,
        {headers: {'Token': wassengerKey}}
      );
      if (!chatRes.ok) {
        const text = await chatRes.text();
        res.json({success: false, error: `chats lookup failed: ${text}`});
        return;
      }
      const chats = await chatRes.json();
      const chat = Array.isArray(chats) ? chats[0] : null;
      if (!chat) {
        res.json({success: true, skipped: 'no chat found'});
        return;
      }

      // Step 2: label the chat with the aptId
      const patchRes = await fetch(
        `https://api.wassenger.com/v1/chats/${encodeURIComponent(chat.id)}`,
        {
          method: 'PATCH',
          headers: {'Token': wassengerKey, 'Content-Type': 'application/json'},
          body: JSON.stringify({labels: aptId ? [aptId] : []}),
        }
      );
      if (!patchRes.ok) {
        const text = await patchRes.text();
        res.json({success: false, error: `chat label failed: ${text}`});
        return;
      }

      res.json({success: true, chatId: chat.id, aptId});
    } catch (e) {
      res.status(500).json({success: false, error: e.message});
    }
  }
);

exports.wassengerWebhook = onRequest(
  {region: 'europe-west1', cors: true},
  async (req, res) => {
    // Always return 200 — Wassenger retries on any non-200
    if (req.method !== 'POST') { res.sendStatus(200); return; }

    try {
      const body = req.body;
      // Log full payload on first runs so we can confirm field paths
      console.log('wassengerWebhook payload:', JSON.stringify(body));

      // Extract chatId — Wassenger v1 webhooks use event.data.id for the chat/message id
      // and the chat object is at event.data.chat
      const data = body?.event?.data || body?.data || body;
      const chatId = data?.chat?.id || data?.id;

      // Extract sender phone — try multiple known field paths
      const rawPhone =
        data?.chat?.contact?.phone ||   // message webhook
        data?.contact?.phone ||          // contact webhook
        data?.fromNumber ||              // alternative field
        data?.phone;

      if (!chatId || !rawPhone) {
        console.log('wassengerWebhook: missing chatId or phone, skipping', {chatId, rawPhone});
        res.sendStatus(200);
        return;
      }

      const phone = normalizePhone(rawPhone);
      console.log('wassengerWebhook: chatId=', chatId, 'phone=', phone);

      // Query checkin_guests for a matching WhatsApp contact
      const snap = await db.collection('checkin_guests')
        .where('contact', '==', phone)
        .where('contactType', '==', 'wa')
        .limit(1)
        .get();

      if (snap.empty) {
        console.log('wassengerWebhook: no guest found for', phone);
        res.sendStatus(200);
        return;
      }

      const aptId = snap.docs[0].data().aptId;
      if (!aptId) {
        console.log('wassengerWebhook: guest found but no aptId');
        res.sendStatus(200);
        return;
      }

      // Read Wassenger API key
      const configSnap = await db.doc('globals/config').get();
      const wassengerKey = configSnap.data()?.wassengerKey;
      if (!wassengerKey) {
        console.log('wassengerWebhook: wassengerKey not configured');
        res.sendStatus(200);
        return;
      }

      // Label the chat with the apartment ID
      const labelRes = await fetch(
        `https://api.wassenger.com/v1/chats/${encodeURIComponent(chatId)}/labels`,
        {
          method: 'PATCH',
          headers: {'Token': wassengerKey, 'Content-Type': 'application/json'},
          body: JSON.stringify({labels: [aptId]}),
        }
      );
      console.log('wassengerWebhook: label response', labelRes.status, await labelRes.text());

    } catch (e) {
      console.error('wassengerWebhook error:', e);
    }

    res.sendStatus(200);
  }
);
