'use strict';

// Post-checkout conversation summarizer — decision logic for
// summarizeGuestConversation (index.js). Pure module (no firebase imports) so
// it's unit-testable; Firestore access goes through a small `store` object
// (createFirestoreSummaryStore below, or a fake in summarizer.test.js).
//
// The trigger is onDocumentWritten on reservations/{docId}, and the MiniHotel
// sync rewrites every reservation in [now-7d, now+60d] (fresh syncedAt) every
// ~10 minutes. Those rewrites are not checkout events. MiniHotel has no
// "checked out" status (only OK/OK2/CL/WL), so the real event is time-based:
// the first write seen after the checkout day ended. Each checkout is claimed
// exactly once via whatsapp_checkout_summaries/{reservationNumber}, and a
// repeat sync write exits on that marker.
//
// This path NEVER deletes messages: the full raw conversation in
// whatsapp_conversations/{phone}/messages is kept forever. It only reads the
// stay's messages and writes a summary (on the marker, and as the latest
// summary in whatsapp_guests/{phone}).

const TBILISI_OFFSET_MS = 4 * 60 * 60 * 1000; // UTC+4 year-round, no DST
const MARKER_COLLECTION = 'whatsapp_checkout_summaries';

const SUMMARY_SYSTEM_PROMPT = 'Summarize this guest WhatsApp conversation into 3-5 bullet points covering: issues they had, requests they made, how they communicated, anything notable. Be very brief.';

/** Digits-only phone, matching how whatsapp_conversations/{phone} is keyed. */
function normalizePhone(phone) {
  return String(phone || '').replace(/\D/g, '');
}

function isCancelledStatus(status) {
  const s = String(status || '').toUpperCase();
  return s === 'CL' || s === 'CANCELLED';
}

/** Calendar date (YYYY-MM-DD) of a checkout value in Tbilisi, or '' if unparseable. */
function tbilisiDateString(value) {
  if (!value) return '';
  if (typeof value === 'string') {
    const m = value.match(/^(\d{4}-\d{2}-\d{2})/);
    if (m) return m[1];
  }
  let date = null;
  if (typeof value.toDate === 'function') date = value.toDate();
  else if (value instanceof Date) date = value;
  else date = new Date(value);
  if (!date || isNaN(date.getTime())) return '';
  return new Date(date.getTime() + TBILISI_OFFSET_MS).toISOString().slice(0, 10);
}

/** Epoch ms at which a stay's checkout day ends in Tbilisi (NaN if unknown). */
function checkoutCutoffMs(checkout) {
  const day = tbilisiDateString(checkout);
  if (!day) return NaN;
  const [y, m, d] = day.split('-').map(Number);
  return Date.UTC(y, m - 1, d + 1) - TBILISI_OFFSET_MS;
}

function conversationTextFor(messages) {
  return messages
    .map((m) => {
      // Strip the internal [VIDEO_SENT:id] follow-up marker — noise for the summarizer.
      const content = String(m.content || '').replace(/\s*\[VIDEO_SENT:\d+\]\s*/gi, ' ').trim();
      const who = m.role === 'assistant' ? 'Assistant' : m.role === 'owner' ? 'Host' : 'Guest';
      return `${who}: ${content}`;
    })
    .join('\n');
}

function summaryBulletsFrom(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.replace(/^[-•*]\s*/, '').trim())
    .filter((line) => line.length > 0);
}

/**
 * Handles one reservations/{docId} write. Returns { outcome, ... }.
 *
 * store:     see createFirestoreSummaryStore for the interface
 * summarize: async (conversationText) => summary text ('' on failure)
 */
async function runPostCheckoutSummary({ reservation, nowMs, store, summarize }) {
  if (!reservation) return { outcome: 'no_reservation' };
  const reservationNumber = String(reservation.reservationNumber || '');
  if (!reservationNumber) return { outcome: 'no_reservation_number' };
  if (isCancelledStatus(reservation.status)) return { outcome: 'cancelled' };

  const cutoffMs = checkoutCutoffMs(reservation.checkout);
  if (!Number.isFinite(cutoffMs) || nowMs < cutoffMs) return { outcome: 'not_checked_out' };

  // The routine MiniHotel rewrite case: this checkout was already handled.
  if (await store.getMarker(reservationNumber)) return { outcome: 'already_processed' };

  const form = await store.findWaFormForReservation(reservationNumber);
  if (!form) return { outcome: 'no_wa_form' };
  const phone = normalizePhone(form.contact);
  if (!phone) return { outcome: 'no_phone' };

  // Atomic claim — two near-simultaneous writes can't both proceed.
  if (!(await store.claimMarker(reservationNumber, { phone, cutoffMs }))) {
    return { outcome: 'already_processed' };
  }

  let markerFinished = false;
  try {
    // The stay's messages: after the previous summarized stay's checkout day
    // (so a returning guest's older stays aren't re-summarized) and before
    // this one's ended.
    const previousStay = (await store.getLatestSummary(phone))?.lastStay;
    const previousCutoffMs = checkoutCutoffMs(previousStay?.checkout);
    const fromMs = previousCutoffMs < cutoffMs ? previousCutoffMs : null;
    const messages = await store.listMessages(phone, { fromMs, toMs: cutoffMs });

    if (messages.length === 0) {
      await store.finishMarker(reservationNumber, { outcome: 'no_messages', messageCount: 0 });
      return { outcome: 'no_messages', phone };
    }

    let summaryText = '';
    try {
      summaryText = await summarize(conversationTextFor(messages));
    } catch (err) {
      summaryText = '';
    }
    const summary = summaryBulletsFrom(summaryText);
    if (summary.length === 0) {
      // Release the claim so a later write retries.
      await store.releaseMarker(reservationNumber);
      return { outcome: 'summary_failed', phone };
    }

    const stay = {
      room: reservation.roomCode || '',
      checkin: reservation.checkin || '',
      checkout: reservation.checkout || '',
      reservationNumber,
    };
    // Every stay's summary is kept on its marker doc.
    await store.finishMarker(reservationNumber, {
      outcome: 'summarized', messageCount: messages.length, summary, stay,
    });
    markerFinished = true;
    // whatsapp_guests holds the latest stay only — don't let a late-processed
    // older checkout overwrite a newer stay's summary.
    if (!(previousCutoffMs > cutoffMs)) {
      await store.writeLatestSummary(phone, { summary, lastStay: stay });
    }
    return { outcome: 'summarized', phone, messageCount: messages.length };
  } catch (err) {
    // Release the claim for a retry unless the summary is already saved on
    // the marker (then this checkout counts as done).
    if (!markerFinished) await store.releaseMarker(reservationNumber).catch(() => {});
    throw err;
  }
}

function toMillis(value) {
  if (!value) return NaN;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value.toDate === 'function') return value.toDate().getTime();
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : NaN;
}

/** Firestore-backed store for runPostCheckoutSummary. Reads messages; never deletes them. */
function createFirestoreSummaryStore(db, FieldValue) {
  const markerRef = (rn) => db.collection(MARKER_COLLECTION).doc(rn);

  return {
    async getMarker(rn) {
      const snap = await markerRef(rn).get();
      return snap.exists ? snap.data() : null;
    },

    async claimMarker(rn, { phone, cutoffMs }) {
      try {
        await markerRef(rn).create({
          reservationNumber: rn,
          phone,
          cutoffMs,
          status: 'processing',
          claimedAt: FieldValue.serverTimestamp(),
        });
        return true;
      } catch (err) {
        if (err.code === 6 || /already exists/i.test(err.message || '')) return false;
        throw err;
      }
    },

    async finishMarker(rn, data) {
      await markerRef(rn).set({ ...data, status: 'done', finishedAt: FieldValue.serverTimestamp() }, { merge: true });
    },

    // Deletes only the claim marker itself (so a failed summary can retry).
    async releaseMarker(rn) {
      await markerRef(rn).delete();
    },

    // Exact match only. Multi-room forms ("123_001") were never matched here
    // before either (the old range fallback was an empty range) — unchanged.
    async findWaFormForReservation(rn) {
      const snap = await db.collection('checkin_guests')
        .where('matchedReservationId', '==', rn)
        .where('contactType', '==', 'wa')
        .limit(1)
        .get();
      return snap.empty ? null : snap.docs[0].data();
    },

    async getLatestSummary(phone) {
      const snap = await db.collection('whatsapp_guests').doc(phone).get();
      return snap.exists ? snap.data() : null;
    },

    async listMessages(phone, { fromMs, toMs }) {
      let q = db.collection('whatsapp_conversations').doc(phone).collection('messages')
        .where('timestamp', '<', new Date(toMs));
      if (Number.isFinite(fromMs)) q = q.where('timestamp', '>=', new Date(fromMs));
      const snap = await q.orderBy('timestamp', 'asc').get();
      return snap.docs.map((d) => {
        const m = d.data();
        return { id: d.id, role: m.role, content: m.content, timestampMs: toMillis(m.timestamp) };
      });
    },

    async writeLatestSummary(phone, { summary, lastStay }) {
      await db.collection('whatsapp_guests').doc(phone).set(
        { summary, lastStay, updatedAt: FieldValue.serverTimestamp() },
        { merge: true }
      );
    },
  };
}

module.exports = {
  SUMMARY_SYSTEM_PROMPT,
  MARKER_COLLECTION,
  checkoutCutoffMs,
  tbilisiDateString,
  runPostCheckoutSummary,
  createFirestoreSummaryStore,
};
