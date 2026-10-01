'use strict';
/**
 * hotelCollectAlert — tells the owner right away when a new Expedia "Hotel Collect"
 * booking appears (these are very often fake). Only informs; never cancels, blocks,
 * unlocks or changes a booking.
 *
 * Trigger: reservations/{id} written.
 * Fires once per booking (hc_alerts/{reservationNumber}, created with create()), when:
 *   after.hotelCollect === true, before.hotelCollect !== true, no hcReview,
 *   and checkout is today or later (Tbilisi date).
 * Sends: web push to all admin devices (url /checkin-admin?hc=<number>) and a WhatsApp
 * text to globals/config.ownerPhone via the Meta secrets the WhatsApp functions use.
 * A failed WhatsApp (e.g. outside the 24-hour window) is logged and never blocks the push.
 */

const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const { defineSecret } = require('firebase-functions/params');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

const REGION = 'europe-west1';
const ADMIN_URL = 'https://app.maxelaapartments.com/checkin-admin';

function tbilisiToday(now = Date.now()) {
  return new Date(now + 4 * 3600 * 1000).toISOString().slice(0, 10);
}
function normalizeDate(v) {
  const m = String(v || '').match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : '';
}
function baseNumber(after, id) {
  return String(after.reservationNumber || id || '').replace(/_\d+$/, '');
}
function normalizePhone(phone) {
  return String(phone || '').replace(/\D/g, '');
}

/** Pure decision: should this write raise an alert? */
function shouldAlert(before, after, today) {
  if (!after || after.hotelCollect !== true) return false;
  if (before && before.hotelCollect === true) return false;
  if (after.hcReview) return false;
  const checkout = normalizeDate(after.checkout || after.checkOut);
  return !!checkout && checkout >= today;
}

function buildTexts(after, base) {
  const guest = String(after.guest || [after.firstName, after.lastName].filter(Boolean).join(' ') || 'Guest').trim();
  const rooms = String(after.allRooms || after.roomCode || after.room || '').trim();
  const dates = `${normalizeDate(after.checkin || after.checkIn)}–${normalizeDate(after.checkout || after.checkOut)}`;
  const body = `${guest} · ${rooms} · ${dates} · #${base} — check if real`;
  const link = `${ADMIN_URL}?hc=${encodeURIComponent(base)}`;
  return { body, link, whatsapp: `Hotel Collect booking: ${body}\n${link}` };
}

/**
 * Core logic with injected dependencies (testable). Never throws.
 * deps: { db, sendPush(payload), sendWhatsApp(to, text) -> {ok, error?}, now }
 */
async function runHotelCollectAlert({ id, before, after }, deps) {
  try {
    const today = tbilisiToday(deps.now);
    if (!shouldAlert(before, after, today)) return { fired: false, reason: 'not_eligible' };
    const base = baseNumber(after, id);
    const ref = deps.db.collection('hc_alerts').doc(base);
    try {
      await ref.create({ reservationNumber: base, createdAt: FieldValue.serverTimestamp(), pushSent: false, whatsapp: 'pending' });
    } catch (e) {
      if (e && (e.code === 6 || /already exists/i.test(e.message || ''))) return { fired: false, reason: 'already_alerted' };
      throw e;
    }
    const t = buildTexts(after, base);
    let pushSent = false;
    try {
      await deps.sendPush({ title: 'Hotel Collect booking', body: t.body, url: `/checkin-admin?hc=${encodeURIComponent(base)}`, tag: `hc-${base}` });
      pushSent = true;
    } catch (e) {
      console.error('[hotelCollectAlert] push failed', e && e.message);
    }
    let whatsapp = 'skipped_no_owner_phone';
    try {
      const cfg = await deps.db.collection('globals').doc('config').get();
      const to = normalizePhone(cfg.exists ? cfg.data().ownerPhone : '');
      if (to) {
        const r = await deps.sendWhatsApp(to, t.whatsapp);
        whatsapp = r && r.ok ? 'sent' : 'failed';
        if (!(r && r.ok)) console.error('[hotelCollectAlert] WhatsApp not sent (maybe outside the 24-hour window):', JSON.stringify(r && r.error));
      } else {
        console.warn('[hotelCollectAlert] ownerPhone is empty — WhatsApp skipped');
      }
    } catch (e) {
      whatsapp = 'failed';
      console.error('[hotelCollectAlert] WhatsApp error', e && e.message);
    }
    try { await ref.set({ pushSent, whatsapp }, { merge: true }); } catch (e) { /* status note only */ }
    return { fired: true, base, pushSent, whatsapp };
  } catch (e) {
    console.error('[hotelCollectAlert] failed', e && e.message);
    return { fired: false, reason: 'error' };
  }
}

async function sendWhatsAppText(to, text) {
  const res = await fetch(`https://graph.facebook.com/v19.0/${process.env.META_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.META_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text } }),
  });
  const data = await res.json();
  return data && data.messages ? { ok: true } : { ok: false, error: data && data.error ? data.error : data };
}

function registerCloudFunction() {
  const VAPID_PUBLIC_KEY = defineSecret('VAPID_PUBLIC_KEY');
  const VAPID_PRIVATE_KEY = defineSecret('VAPID_PRIVATE_KEY');
  return onDocumentWritten(
    { document: 'reservations/{id}', region: REGION, secrets: [VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, 'META_ACCESS_TOKEN', 'META_PHONE_NUMBER_ID'] },
    async (event) => {
      const before = event.data.before && event.data.before.exists ? event.data.before.data() : null;
      const after = event.data.after && event.data.after.exists ? event.data.after.data() : null;
      if (!after) return;
      const { sendPushToAll } = require('./pushNotifications');
      await runHotelCollectAlert({ id: event.params.id, before, after }, {
        db: getFirestore(),
        sendPush: sendPushToAll,
        sendWhatsApp: sendWhatsAppText,
      });
    }
  );
}

module.exports = { registerCloudFunction, runHotelCollectAlert, shouldAlert, buildTexts, tbilisiToday };
