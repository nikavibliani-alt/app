'use strict';

// Post-checkout conversation summarizer — decision logic for
// summarizeGuestConversation (index.js). Pure module (no firebase imports) so
// it's unit-testable; Firestore access goes through a small `store` object
// (createFirestoreSummaryStore below, or a fake in summarizer.test.js).
//
// Why this exists: the trigger is onDocumentWritten on reservations/{docId},
// and the MiniHotel sync rewrites every reservation in [now-7d, now+60d]
// (fresh syncedAt) every ~10 minutes. Those rewrites are not checkout events.
// MiniHotel has no "checked out" status (only OK/OK2/CL/WL), so the real event
// is time-based: the first write seen after the checkout day ended. Each
// checkout is therefore claimed exactly once via a marker doc, and a repeat
// sync write exits on that marker without touching anything.
//
// Deletion rules:
// - never while the same phone has another active or future reservation
// - only messages timestamped before the end of this stay's checkout day
// - never role "owner" messages (the host's own replies), under any condition

const TBILISI_OFFSET_MS = 4 * 60 * 60 * 1000; // UTC+4 year-round, no DST
const MARKER_COLLECTION = 'whatsapp_checkout_summaries';
const DELETE_CHUNK = 400; // below Firestore's 500-writes-per-batch limit

const SUMMARY_SYSTEM_PROMPT = 'Summarize this guest WhatsApp conversation into 3-5 bullet points covering: issues they had, requests they made, how they communicated, anything notable. Be very brief.';

/** Strip spaces/dashes/parens/+ so Meta and form phones compare as digits-only. */
function normalizePhone(phone) {
  return String(phone || '').replace(/\D/g, '');
}

/** Exact strings a contact may be stored as: as typed, digits-only, +digits. */
function contactVariants(rawContact) {
  const raw = String(rawContact || '').trim();
  const digits = normalizePhone(raw);
  return [...new Set([raw, digits, digits ? `+${digits}` : ''].filter(Boolean))];
}

/** matchedReservationId may be "007004653_001" — base reservation number is before first _. */
function baseReservationNumber(matchedReservationId) {
  const raw = String(matchedReservationId || '').trim();
  return raw ? raw.split('_')[0] : '';
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

/** Epoch ms at which this stay's checkout day ends in Tbilisi (NaN if unknown). */
function checkoutCutoffMs(checkout) {
  const day = tbilisiDateString(checkout);
  if (!day) return NaN;
  const [y, m, d] = day.split('-').map(Number);
  return Date.UTC(y, m - 1, d + 1) - TBILISI_OFFSET_MS;
}

/** A non-cancelled reservation whose checkout day hasn't ended yet (current or upcoming stay). */
function isActiveOrFutureReservation(reservation, nowMs) {
  if (!reservation || isCancelledStatus(reservation.status)) return false;
  const cutoff = checkoutCutoffMs(reservation.checkout);
  return Number.isFinite(cutoff) && cutoff > nowMs;
}

/** Messages that belong to the finished stay: timestamped before its checkout cutoff. */
function messagesInStayWindow(messages, cutoffMs) {
  return (messages || []).filter((m) => Number.isFinite(m.timestampMs) && m.timestampMs < cutoffMs);
}

/** Ids safe to delete from a stay window — never owner messages. */
function deletableMessageIds(windowMessages) {
  return windowMessages.filter((m) => m.role !== 'owner').map((m) => m.id);
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
 * Handles one reservations/{docId} write. Returns { outcome, ... } describing
 * what happened; only outcome 'summarized' deletes anything.
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

  // Another current/upcoming stay on this phone: leave the conversation alone.
  // Not marked, so a later write re-checks (e.g. if that stay gets cancelled);
  // otherwise the later stay's own checkout summarizes these messages too.
  const linked = await store.findReservationsForPhone({ phone, rawContact: form.contact });
  const otherStay = linked.find((r) => String(r.reservationNumber || '') !== reservationNumber
    && isActiveOrFutureReservation(r, nowMs));
  if (otherStay) {
    return { outcome: 'deferred_active_stay', phone, otherReservationNumber: String(otherStay.reservationNumber) };
  }

  // Atomic claim — two near-simultaneous writes can't both proceed.
  if (!(await store.claimMarker(reservationNumber, { phone, cutoffMs }))) {
    return { outcome: 'already_processed' };
  }

  let summaryWritten = false;
  try {
    const windowMessages = messagesInStayWindow(await store.listMessages(phone), cutoffMs);
    if (windowMessages.length === 0) {
      await store.finishMarker(reservationNumber, { outcome: 'no_messages', deletedCount: 0 });
      return { outcome: 'no_messages', phone };
    }

    let summaryText = '';
    try {
      summaryText = await summarize(conversationTextFor(windowMessages));
    } catch (err) {
      summaryText = '';
    }
    const summary = summaryBulletsFrom(summaryText);
    if (summary.length === 0) {
      // Keep everything and release the claim so a later write retries.
      await store.releaseMarker(reservationNumber);
      return { outcome: 'summary_failed', phone };
    }

    await store.writeSummary(phone, {
      summary,
      lastStay: {
        room: reservation.roomCode || '',
        checkin: reservation.checkin || '',
        checkout: reservation.checkout || '',
        reservationNumber,
      },
    });
    summaryWritten = true;

    const ids = deletableMessageIds(windowMessages);
    await store.deleteMessages(phone, ids);
    const keptOwnerCount = windowMessages.length - ids.length;
    await store.finishMarker(reservationNumber, { outcome: 'summarized', deletedCount: ids.length, keptOwnerCount });
    return { outcome: 'summarized', phone, deletedCount: ids.length, keptOwnerCount };
  } catch (err) {
    if (summaryWritten) {
      // Summary saved but deletion failed part-way: keep the claim, so a retry
      // can't re-summarize the leftover subset and overwrite the good summary.
      // Leftover messages are kept, never lost.
      await store.finishMarker(reservationNumber, { outcome: 'delete_failed', error: String(err.message || err) })
        .catch(() => {});
    } else {
      // Nothing was deleted; release so a later write can retry cleanly.
      await store.releaseMarker(reservationNumber).catch(() => {});
    }
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

/** Firestore-backed store for runPostCheckoutSummary. */
function createFirestoreSummaryStore(db, FieldValue) {
  const markerRef = (rn) => db.collection(MARKER_COLLECTION).doc(rn);
  const messagesRef = (phone) => db.collection('whatsapp_conversations').doc(phone).collection('messages');

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

    async releaseMarker(rn) {
      await markerRef(rn).delete();
    },

    // Exact match only. Multi-room forms ("123_001") were never matched here
    // before either (the old range fallback was an empty range), so they stay
    // unsummarized — unchanged behavior.
    async findWaFormForReservation(rn) {
      const snap = await db.collection('checkin_guests')
        .where('matchedReservationId', '==', rn)
        .where('contactType', '==', 'wa')
        .limit(1)
        .get();
      return snap.empty ? null : snap.docs[0].data();
    },

    // Every reservation linked to this phone: via its WA check-in forms, and
    // via reservations.phone (catches upcoming stays with no form filled yet).
    async findReservationsForPhone({ rawContact }) {
      const variants = contactVariants(rawContact);
      const reservationNumbers = new Set();
      for (const contact of variants) {
        const forms = await db.collection('checkin_guests')
          .where('contact', '==', contact)
          .where('contactType', '==', 'wa')
          .limit(50)
          .get();
        forms.docs.forEach((d) => {
          const base = baseReservationNumber(d.data().matchedReservationId);
          if (base) reservationNumbers.add(base);
        });
      }
      const results = [];
      for (const rn of reservationNumbers) {
        const snap = await db.collection('reservations').where('reservationNumber', '==', rn).limit(5).get();
        snap.docs.forEach((d) => results.push(d.data()));
      }
      for (const phone of variants) {
        const snap = await db.collection('reservations').where('phone', '==', phone).limit(20).get();
        snap.docs.forEach((d) => results.push(d.data()));
      }
      return results;
    },

    async listMessages(phone) {
      const snap = await messagesRef(phone).orderBy('timestamp', 'asc').get();
      return snap.docs.map((d) => {
        const m = d.data();
        return { id: d.id, role: m.role, content: m.content, timestampMs: toMillis(m.timestamp) };
      });
    },

    async deleteMessages(phone, ids) {
      for (let i = 0; i < ids.length; i += DELETE_CHUNK) {
        const batch = db.batch();
        ids.slice(i, i + DELETE_CHUNK).forEach((id) => batch.delete(messagesRef(phone).doc(id)));
        await batch.commit();
      }
    },

    async writeSummary(phone, { summary, lastStay }) {
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
  contactVariants,
  checkoutCutoffMs,
  tbilisiDateString,
  isActiveOrFutureReservation,
  messagesInStayWindow,
  deletableMessageIds,
  runPostCheckoutSummary,
  createFirestoreSummaryStore,
};
