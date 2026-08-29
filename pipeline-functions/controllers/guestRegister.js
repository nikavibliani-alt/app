'use strict';
/**
 * GuestRegister — sole writer of new primary guest docs (guestToken IDs).
 *
 * Uses existing collections:
 *   checkin_guests/{guestToken} — create / merge profile (never room_* date IDs for primary)
 *   reservations — read-only (validates match; never writes roomCode)
 *
 * Room comes from reservation.roomCode — never invented here.
 * Room moves later go through RoomAssignment only.
 */

const { generateGuestToken, buildGuestLink, isLikelyGuestToken } = require('../lib/guest-token');
const { runGuestUnlock } = require('./guestUnlock');

function pickProfile(payload) {
  const p = payload.profile || payload;
  return {
    name: p.name || '',
    nameRoman: p.nameRoman || p.name || '',
    guests: p.guests ?? null,
    nationality: p.nationality || '',
    contact: p.contact || '',
    contactType: p.contactType || '',
    passportUrl: p.passportUrl || '',
    passportScanResult: p.passportScanResult || {},
    arrivalDate: p.arrivalDate || '',
    checkoutDate: p.checkoutDate || '',
    expectedCheckInWindow: p.expectedCheckInWindow || p.expectedCheckInTime || '',
    expectedCheckInTime: p.expectedCheckInTime || p.expectedCheckInWindow || '',
  };
}

function reservationDates(res) {
  return {
    checkin: res.checkin || res.checkIn || '',
    checkout: res.checkout || res.checkOut || '',
  };
}

function isActiveReservation(res) {
  return String(res.status || '').toUpperCase() !== 'CANCELLED';
}

async function runGuestRegister(ctx, params) {
  const mode = (params.mode || 'register_primary').toLowerCase();
  const actor = params.actor || 'guest';
  const input = { mode, reservationId: params.reservationId || null, actor };

  try {
    if (mode === 'register_companion' || params.companion === true) {
      return await registerCompanion(ctx, params, input);
    }
    if (mode === 'update_profile') {
      return await updateProfile(ctx, params, input);
    }
    return await registerPrimary(ctx, params, input);
  } catch (err) {
    await ctx.logRun({
      controller: 'GuestRegister',
      action: mode,
      status: 'error',
      message: err.message || String(err),
      input,
    });
    return { ok: false, errorCode: 'INTERNAL', message: err.message || 'GuestRegister failed' };
  }
}

async function registerPrimary(ctx, params, input) {
  const actor = params.actor || input.actor || 'guest';
  const reservationId = params.reservationId;
  if (!reservationId) {
    await ctx.logRun({
      controller: 'GuestRegister',
      action: 'register_primary',
      status: 'error',
      message: 'reservationId is required',
      input,
    });
    return { ok: false, errorCode: 'BAD_REQUEST', message: 'reservationId is required' };
  }

  const reservation = await ctx.getReservation(reservationId);
  if (!reservation) {
    await ctx.logRun({
      controller: 'GuestRegister',
      action: 'register_primary',
      status: 'error',
      message: 'Reservation not found',
      input,
    });
    return { ok: false, errorCode: 'NOT_FOUND', message: 'Reservation not found' };
  }
  if (!isActiveReservation(reservation)) {
    await ctx.logRun({
      controller: 'GuestRegister',
      action: 'register_primary',
      status: 'error',
      message: 'Reservation is cancelled',
      input,
    });
    return { ok: false, errorCode: 'INACTIVE', message: 'Reservation is cancelled' };
  }

  const profile = pickProfile(params);
  const roomCode = reservation.roomCode || reservation.room || '';
  if (!roomCode) {
    await ctx.logRun({
      controller: 'GuestRegister',
      action: 'register_primary',
      status: 'error',
      message: 'Reservation has no room — cannot register',
      input,
    });
    return { ok: false, errorCode: 'NO_ROOM', message: 'Reservation has no room assigned yet' };
  }

  const dates = reservationDates(reservation);
  const arrivalDate = profile.arrivalDate || dates.checkin;
  const checkoutDate = profile.checkoutDate || dates.checkout;

  let guestToken = params.guestToken || null;
  if (guestToken && !isLikelyGuestToken(guestToken)) {
    return { ok: false, errorCode: 'BAD_REQUEST', message: 'Invalid guestToken format' };
  }

  if (!guestToken) {
    const existing = await ctx.findPrimaryGuestForReservation(reservationId, reservation.reservationNumber);
    if (existing) guestToken = existing.id;
  }
  if (!guestToken) guestToken = generateGuestToken();

  const guestLinkBase = params.guestLinkBase || '';
  const guestLink = buildGuestLink(guestLinkBase, guestToken) || null;

  if (!profile.passportUrl) {
    await ctx.logRun({
      controller: 'GuestRegister',
      action: 'register_primary',
      status: 'error',
      message: 'passportUrl is required for primary registration',
      input,
    });
    return { ok: false, errorCode: 'BAD_REQUEST', message: 'passportUrl is required' };
  }

  const doc = {
    aptId: roomCode,
    ...profile,
    arrivalDate,
    checkoutDate,
    matchedReservationId: reservationId,
    manualUnlock: false,
    companionGuest: false,
    isPrimaryGuest: true,
    guestLink,
    linkedReservationNumber: null,
    registeredBy: actor,
  };

  const existed = await ctx.getGuest(guestToken);
  await ctx.saveGuest(guestToken, doc, { isCreate: !existed });

  if (ctx.runGuestUnlock) {
    await ctx.runGuestUnlock({ guestId: guestToken, actor: 'GuestRegister' });
  }

  await ctx.logRun({
    controller: 'GuestRegister',
    action: 'register_primary',
    status: 'ok',
    message: existed ? `Updated guest ${guestToken}` : `Created guest ${guestToken}`,
    input: { ...input, guestToken, roomCode },
    output: { guestToken, guestLink, aptId: roomCode, matchedReservationId: reservationId },
  });

  return {
    ok: true,
    errorCode: existed ? 'UPDATED' : 'CREATED',
    message: existed ? 'Registration updated' : 'Registration complete',
    data: { guestToken, guestLink, aptId: roomCode, matchedReservationId: reservationId },
  };
}

async function registerCompanion(ctx, params, input) {
  const reservationId = params.reservationId;
  let reservation = reservationId ? await ctx.getReservation(reservationId) : null;

  if (!reservation && params.reservationNumber) {
    reservation = await ctx.findReservationByNumber(params.reservationNumber);
  }
  if (!reservation) {
    await ctx.logRun({
      controller: 'GuestRegister',
      action: 'register_companion',
      status: 'error',
      message: 'Reservation not found',
      input,
    });
    return { ok: false, errorCode: 'NOT_FOUND', message: 'Reservation not found' };
  }

  const profile = pickProfile(params);
  const roomCode = reservation.roomCode || reservation.room || '';
  const dates = reservationDates(reservation);
  const arrivalDate = profile.arrivalDate || dates.checkin || '';
  const docId = `${roomCode}_${arrivalDate || Date.now()}`;

  const doc = {
    aptId: roomCode,
    ...profile,
    arrivalDate,
    checkoutDate: profile.checkoutDate || dates.checkout,
    matchedReservationId: reservation.id,
    manualUnlock: false,
    companionGuest: true,
    isPrimaryGuest: false,
    guestLink: null,
    linkedReservationNumber: String(params.reservationNumber || reservation.reservationNumber || '').trim() || null,
    primaryGuestId: params.primaryGuestId || null,
    registeredBy: params.actor || 'guest',
    passportUrl: profile.passportUrl || '',
  };

  const existed = await ctx.getGuest(docId);
  await ctx.saveGuest(docId, doc, { isCreate: !existed });

  await ctx.logRun({
    controller: 'GuestRegister',
    action: 'register_companion',
    status: 'ok',
    message: `Companion registered ${docId}`,
    input,
    output: { guestToken: docId, aptId: roomCode },
  });

  return {
    ok: true,
    errorCode: existed ? 'UPDATED' : 'CREATED',
    message: 'Companion registered',
    data: { guestToken: docId, aptId: roomCode, matchedReservationId: reservation.id },
  };
}

async function updateProfile(ctx, params, input) {
  const guestToken = params.guestToken;
  if (!guestToken) {
    return { ok: false, errorCode: 'BAD_REQUEST', message: 'guestToken is required' };
  }
  const existing = await ctx.getGuest(guestToken);
  if (!existing) {
    return { ok: false, errorCode: 'NOT_FOUND', message: 'Guest not found' };
  }

  const profile = pickProfile(params);
  const patch = {};
  for (const [k, v] of Object.entries(profile)) {
    if (v !== '' && v != null) patch[k] = v;
  }
  if (params.passportScanResult) patch.passportScanResult = params.passportScanResult;

  await ctx.saveGuest(guestToken, patch, { isCreate: false, mergeOnly: true });

  await ctx.logRun({
    controller: 'GuestRegister',
    action: 'update_profile',
    status: 'ok',
    message: `Profile patch ${guestToken}`,
    input: { ...input, guestToken },
  });

  return { ok: true, errorCode: 'UPDATED', message: 'Profile updated', data: { guestToken } };
}

function buildLiveCtx() {
  const { getFirestore, FieldValue } = require('firebase-admin/firestore');
  const { writeSystemLog } = require('../lib/logging');
  const guestUnlockCtx = require('./guestUnlock').buildLiveCtx();

  const db = getFirestore();

  return {
    getReservation: async (id) => {
      const snap = await db.collection('reservations').doc(id).get();
      return snap.exists ? { id, ...snap.data() } : null;
    },
    findReservationByNumber: async (num) => {
      const snap = await db
        .collection('reservations')
        .where('reservationNumber', '==', String(num))
        .limit(5)
        .get();
      for (const doc of snap.docs) {
        const data = doc.data();
        if (isActiveReservation(data)) return { id: doc.id, ...data };
      }
      return null;
    },
    findPrimaryGuestForReservation: async (resId, resNum) => {
      const ids = [resId, resNum].filter(Boolean);
      for (const id of ids) {
        const snap = await db
          .collection('checkin_guests')
          .where('matchedReservationId', '==', id)
          .limit(10)
          .get();
        for (const doc of snap.docs) {
          const data = doc.data();
          if (data.companionGuest) continue;
          if (data.passportUrl && isLikelyGuestToken(doc.id)) return { id: doc.id, ...data };
        }
      }
      return null;
    },
    getGuest: async (guestToken) => {
      const snap = await db.collection('checkin_guests').doc(guestToken).get();
      return snap.exists ? snap.data() : null;
    },
    saveGuest: async (guestToken, data, opts = {}) => {
      const ref = db.collection('checkin_guests').doc(guestToken);
      if (opts.mergeOnly) {
        await ref.set({ ...data, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
        return;
      }
      if (opts.isCreate) {
        await ref.set({ ...data, submittedAt: FieldValue.serverTimestamp() });
      } else {
        await ref.set({ ...data, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      }
    },
    runGuestUnlock: (p) => runGuestUnlock({ ...guestUnlockCtx, logRun: (e) => writeSystemLog(db, e) }, p),
    logRun: (entry) => writeSystemLog(db, entry),
  };
}

function registerCloudFunction() {
  const { onCall, HttpsError } = require('firebase-functions/v2/https');

  return onCall({ region: 'europe-west1' }, async (request) => {
    const data = request.data || {};
    const ctx = buildLiveCtx();
    try {
      return await runGuestRegister(ctx, data);
    } catch (err) {
      await ctx.logRun({
        controller: 'GuestRegister',
        action: data.mode || 'register_primary',
        status: 'error',
        message: err.message || String(err),
        input: data,
      });
      throw new HttpsError('internal', err.message || 'GuestRegister failed');
    }
  });
}

module.exports = { runGuestRegister, buildLiveCtx, registerCloudFunction, pickProfile };
