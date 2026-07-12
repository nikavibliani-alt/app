const {onRequest} = require('firebase-functions/v2/https');
const {initializeApp} = require('firebase-admin/app');
const {getFirestore} = require('firebase-admin/firestore');

initializeApp();
const db = getFirestore();

exports.syncWassengerContact = onRequest(
  {region: 'europe-west1', cors: true},
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).json({success: false, error: 'Method not allowed'});
      return;
    }
    try {
      const {phone, name, labels, metadata} = req.body;
      if (!phone) {
        res.status(400).json({success: false, error: 'phone is required'});
        return;
      }
      const configSnap = await db.doc('globals/config').get();
      const wassengerKey = configSnap.data()?.wassengerKey;
      if (!wassengerKey) {
        res.json({success: false, error: 'Wassenger key not configured'});
        return;
      }
      const upstream = await fetch('https://api.wassenger.com/v1/contacts', {
        method: 'POST',
        headers: {'Token': wassengerKey, 'Content-Type': 'application/json'},
        body: JSON.stringify({phone, name, labels, metadata}),
      });
      if (!upstream.ok) {
        const text = await upstream.text();
        res.json({success: false, error: text});
        return;
      }
      res.json({success: true});
    } catch (e) {
      res.status(500).json({success: false, error: e.message});
    }
  }
);
