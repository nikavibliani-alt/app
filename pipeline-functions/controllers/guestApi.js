'use strict';
/**
 * GuestApi: what the guest page used to read straight from Firestore, now answered by the server.
 *
 *   guestFind   find the booking (name + arrival date, or booking number), its sibling rooms,
 *               an existing guest record, companion join links. Never returns phone, email or door codes.
 *   guestStay   the guest's own apartment, own reservations and elevator code.
 *               Door code, Wi-Fi, door photo, smart-lock password and elevator code are only included
 *               when this guest's own booking is checked in (same rule as shared/guest-unlock.js).
 *
 * All data access goes through `ctx`, so the logic is tested with a fake database.
 */

const M = require('../lib/guest-match');
const { computeGuestUnlock, parseCheckInHour, tbilisiToday, normalizeStayDate } = require('../lib/guest-unlock');
const { isLikelyGuestToken } = require('../lib/guest-token');

const PUBLIC_RES_FIELDS = ['reservationNumber', 'roomCode', 'checkin', 'checkIn', 'checkout', 'checkOut', 'status', 'guest', 'guestName', 'source'];
const APT_ALWAYS_REMOVE = ['tuyaDeviceId', 'updatedAt'];
const APT_LOCKED_REMOVE = ['doorCode', 'lockboxCode', 'wifiName', 'wifiPass', 'doorPhotoUrl', 'videoUrl'];

// ---------------------------------------------------------------- helpers

const str = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const isCancelled = r => String(r.status || '').toUpperCase() === 'CANCELLED';
const resBase = r => M.reservationBaseNum(r.reservationNumber || r.id);
const byRoom = (a, b) => String(a.roomCode || '').localeCompare(String(b.roomCode || ''));

/** Firestore Timestamps become {seconds, nanoseconds}; nothing else is changed. */
function plain(v) {
  if (v == null || typeof v !== 'object') return v;
  if (typeof v.toDate === 'function') {
    const d = v.toDate();
    return { seconds: Math.floor(d.getTime() / 1000), nanoseconds: 0 };
  }
  if (Array.isArray(v)) return v.map(plain);
  const out = {};
  for (const k of Object.keys(v)) out[k] = plain(v[k]);
  return out;
}

function pubRes(r) {
  const out = { id: r.id };
  for (const k of PUBLIC_RES_FIELDS) if (r[k] !== undefined) out[k] = r[k];
  return out;
}

function maskDigits(s) {
  return String(s || '').replace(/\d[\d \-]{1,}\d#?/g, '••••');
}

function filterApt(apt, unlocked) {
  if (!apt) return null;
  const out = { ...plain(apt) };
  for (const k of APT_ALWAYS_REMOVE) delete out[k];
  if (!unlocked) {
    for (const k of APT_LOCKED_REMOVE) delete out[k];
    if (out.instructions) out.instructions = maskDigits(out.instructions);
    if (Array.isArray(out.photoCaptions)) out.photoCaptions = out.photoCaptions.map(maskDigits);
    // the unit's lock box code is gone above; arrival steps of a type are config (placeholders only, no codes)
  }
  return out;
}

const bad = (errorCode, message) => ({ ok: false, errorCode, message });

async function limited(ctx, key, max, windowSec) {
  try {
    return !!(await ctx.rateLimit(key, max, windowSec));   // true = over the limit
  } catch (e) {
    return false;   // a broken limiter must not lock guests out
  }
}

// -------------------------------------------------------- shared lookups

/** Same as the page's loadSiblingReservations: the booking's rooms (same base number), not cancelled. */
async function loadSiblings(ctx, resIdOrNum) {
  if (!resIdOrNum) return [];
  const base = M.reservationBaseNum(resIdOrNum);
  if (!base) return [];
  const [own, sibs] = await Promise.all([
    ctx.getReservation(resIdOrNum).catch(() => null),
    ctx.listReservationsByNumberPrefix(base).catch(() => []),
  ]);
  let finalBase = base;
  let docs = sibs || [];
  if (own) finalBase = M.reservationBaseNum(own.reservationNumber || own.id) || base;
  if (finalBase !== base) docs = (await ctx.listReservationsByNumberPrefix(finalBase).catch(() => [])) || [];
  return docs.filter(r => !isCancelled(r)).filter(r => resBase(r) === finalBase).sort(byRoom);
}

/** Same as the page's findExistingPrimaryGuest. */
async function findExistingPrimaryGuest(ctx, resId, resNum) {
  for (const id of [resId, resNum].filter(Boolean)) {
    const guests = await ctx.listGuestsByMatchedReservation(id, 10).catch(() => []);
    for (const g of guests) {
      if (g.companionGuest) continue;
      if ((g.isPrimaryGuest === true || g.passportUrl) && isLikelyGuestToken(g.id)) return g;
    }
  }
  return null;
}

// --------------------------------------------------------------- guestFind

async function runGuestFind(ctx, params, meta = {}) {
  const mode = str(params.mode, 20) || 'find';
  if (mode === 'existing') return runExisting(ctx, params, meta);
  if (mode === 'siblings') return runSiblings(ctx, params, meta);
  if (mode === 'companion') return runCompanion(ctx, params, meta);
  if (mode === 'related') return runRelated(ctx, params, meta);
  if (mode !== 'find') return bad('BAD_REQUEST', 'unknown mode');

  const name = str(params.name, 200);
  const arrival = /^\d{4}-\d{2}-\d{2}$/.test(str(params.arrival, 10)) ? str(params.arrival, 10) : '';
  if (!name || !arrival) return bad('BAD_REQUEST', 'name and arrival date are required');
  if (await limited(ctx, 'find:' + (meta.ip || '?'), 20, 600)) return bad('RATE_LIMITED', 'Too many searches. Please wait a few minutes.');

  const pool = [];
  for (const r of await ctx.listReservationsByCheckin(arrival)) pool.push(r);
  if (M._looksLikeBookingRef(name)) {
    const typed = name.trim();
    const variants = [...new Set([typed, typed.toUpperCase(), M._normRef(name)])];
    try {
      for (const r of await ctx.listReservationsByBookingIds(variants)) if (!pool.some(x => x.id === r.id)) pool.push(r);
    } catch (e) { /* the date search still works */ }
  }

  const scored = M.scoreReservations(name, arrival, pool);
  const best = scored.best;
  const bestScore = scored.bestScore;

  if (bestScore < 3 || !best) {
    try {
      await ctx.addSearchFailure({
        input_name: name, input_date: arrival, input_booking_ref: '',
        input_apt: str(params.aptHint, 20), input_contact: str(params.contact, 80),
        input_contact_type: str(params.contactType, 10) || 'wa', search_mode: 'name',
        best_match_name: best ? (best.guest || best.guestName || '') : '',
        best_match_score: bestScore, best_match_room: best ? (best.roomCode || '') : '',
        resolved: false,
      });
    } catch (e) { /* logging only */ }
    return { ok: true, found: false };
  }

  let group = [best];
  const baseRn = M.reservationBaseNum(String(best.reservationNumber || best.id || '').trim());
  if (baseRn) {
    try {
      const sibs = (await ctx.listReservationsByNumberPrefix(baseRn)).filter(r => !isCancelled(r)).filter(r => resBase(r) === baseRn);
      if (sibs.length) group = sibs;
    } catch (e) { /* single match */ }
  }

  const relatedIds = [];
  try {
    for (const rb of M._relatedBookings(best, pool)) {
      if (group.some(g => resBase(g) === resBase(rb))) continue;
      const more = await loadSiblings(ctx, rb.id);
      (more.length ? more : [rb]).forEach(a => { if (!group.some(g => g.id === a.id)) group.push(a); });
      relatedIds.push(rb.id);
    }
    group.sort(byRoom);
  } catch (e) { /* keep what we have */ }

  const existing = await findExistingPrimaryGuest(ctx, best.id, best.reservationNumber);
  const proof = ctx.signProof({ bases: [...new Set(group.map(resBase).filter(Boolean))] });
  return {
    ok: true, found: true, score: bestScore,
    best: pubRes(best), group: group.map(pubRes), relatedIds,
    existing: existing ? plain(existing) : null, proof,
  };
}

async function runExisting(ctx, params, meta) {
  if (await limited(ctx, 'existing:' + (meta.ip || '?'), 60, 600)) return bad('RATE_LIMITED', 'Too many requests.');
  const payload = ctx.verifyProof(str(params.proof, 2000));
  const base = M.reservationBaseNum(str(params.reservationNumber, 60) || str(params.reservationId, 60));
  if (!payload || !base || !(payload.bases || []).includes(base)) return bad('FORBIDDEN', 'Booking not verified');
  const existing = await findExistingPrimaryGuest(ctx, str(params.reservationId, 60), str(params.reservationNumber, 60));
  return { ok: true, existing: existing ? plain(existing) : null };
}

/** A guest may only ask about their own bookings (matched booking plus the related ones saved on their record). */
async function ownBases(ctx, guestToken) {
  if (!isLikelyGuestToken(guestToken)) return null;
  const guest = await ctx.getGuest(guestToken);
  if (!guest) return null;
  const refs = [guest.matchedReservationId, guest.linkedReservationNumber, ...(guest.relatedReservationIds || [])].filter(Boolean);
  return { guest, bases: new Set(refs.map(M.reservationBaseNum).filter(Boolean)) };
}

/** Phone digits of the guest's own contact, used only when the booking has no phone (never to loosen the search rule). */
function contactDigits(contact) {
  const d = String(contact || '').replace(/\D/g, '');
  return d.length >= 7 ? d.slice(-7) : '';
}

/**
 * Bookings made AFTER registration by the same person: the SAME rule as at search time (M._relatedBookings:
 * same name with the room tag stripped, same check-in date, same phone when both have one, not cancelled),
 * only stricter: when the booking has no phone, the guest's own contact number (if it is a number) must match too.
 * Returns the new bookings' siblings plus the ids to keep on the guest record.
 */
async function findLaterRelated(ctx, guest, knownBases) {
  const ref = guest.matchedReservationId;
  if (!ref) return { reservations: [], relatedIds: [] };
  const mine = (await loadSiblings(ctx, ref)).filter(r => !isCancelled(r));
  const best = mine[0];
  const ci = best && (best.checkin || best.checkIn);
  if (!best || !ci) return { reservations: [], relatedIds: [] };
  const pool = (await ctx.listReservationsByCheckin(ci)).filter(r => !isCancelled(r));
  const ph = M.normalizePhone(best.phone || '') || contactDigits(guest.contact);
  const found = M._relatedBookings(best, pool).filter(r => {
    if (knownBases.has(resBase(r))) return false;
    const rp = M.normalizePhone(r.phone || '');
    return !ph || !rp || rp === ph;
  });
  const reservations = [];
  const relatedIds = [];
  const seen = new Set();
  for (const rb of found) {
    if (seen.has(resBase(rb))) continue;
    seen.add(resBase(rb));
    const more = await loadSiblings(ctx, rb.id);
    (more.length ? more : [rb]).forEach(a => { if (!reservations.some(g => g.id === a.id)) reservations.push(a); });
    relatedIds.push(rb.id);
  }
  return { reservations: reservations.sort(byRoom), relatedIds };
}

async function runRelated(ctx, params, meta) {
  if (await limited(ctx, 'related:' + (meta.ip || '?'), 60, 600)) return bad('RATE_LIMITED', 'Too many requests.');
  const own = await ownBases(ctx, str(params.guestToken, 80));
  if (!own) return bad('FORBIDDEN', 'Not your booking');
  if (own.guest.companionGuest) return { ok: true, reservations: [], relatedIds: [] };
  const r = await findLaterRelated(ctx, own.guest, own.bases);
  return { ok: true, reservations: r.reservations.map(pubRes), relatedIds: r.relatedIds };
}

async function runSiblings(ctx, params, meta) {
  if (await limited(ctx, 'siblings:' + (meta.ip || '?'), 120, 600)) return bad('RATE_LIMITED', 'Too many requests.');
  const own = await ownBases(ctx, str(params.guestToken, 80));
  const ref = str(params.reservationRef, 80);
  if (!own || !ref || !own.bases.has(M.reservationBaseNum(ref))) return bad('FORBIDDEN', 'Not your booking');
  const reservations = await loadSiblings(ctx, ref);
  let refCancelled = false;
  if (!reservations.length) {
    const doc = await ctx.getReservation(ref).catch(() => null);
    refCancelled = !!doc && isCancelled(doc);
  }
  return { ok: true, reservations: reservations.map(pubRes), refCancelled };
}

async function runCompanion(ctx, params, meta) {
  const token = str(params.joinToken, 100);
  if (token.length < 16) return { ok: true, found: false };
  if (await limited(ctx, 'join:' + (meta.ip || '?'), 30, 600)) return bad('RATE_LIMITED', 'Too many requests.');
  const guests = await ctx.listGuestsByCompanionToken(token);
  const primary = guests.find(g => !g.companionGuest);
  if (!primary) return { ok: true, found: false };
  const base = M.reservationBaseNum(primary.matchedReservationId);
  if (!base) return { ok: true, found: false };
  const res = (await ctx.listReservationsByNumberPrefix(base)).filter(r => !isCancelled(r)).filter(r => resBase(r) === base);
  if (!res.length) return { ok: true, found: false };
  for (const rid of primary.relatedReservationIds || []) {
    for (const m of await loadSiblings(ctx, rid)) if (!res.some(x => x.id === m.id)) res.push(m);
  }
  const proof = ctx.signProof({ bases: [...new Set([base, ...res.map(resBase)].filter(Boolean))] });
  return {
    ok: true, found: true, base, proof,
    primary: { id: primary.id, matchedReservationId: primary.matchedReservationId || null, relatedReservationIds: primary.relatedReservationIds || [] },
    reservations: res.map(pubRes),
  };
}

// --------------------------------------------------------------- guestStay

function pickBest(pool) {
  const withPw = pool.filter(r => r.tuyaPassword);
  return (withPw.length ? withPw : pool).sort((a, b) => ((a.checkin || a.checkIn || '') < (b.checkin || b.checkIn || '') ? -1 : 1))[0] || null;
}

async function runGuestStay(ctx, params, meta = {}) {
  const wantedApt = str(params.aptId, 30);
  const token = str(params.guestToken, 80);
  const ip = meta.ip || '?';
  if (await limited(ctx, 'stay-ip:' + ip, 300, 600)) return bad('RATE_LIMITED', 'Too many requests.');

  if (!token) {   // no guest yet: only the public part of the apartment
    const apt = wantedApt ? await ctx.getApartment(wantedApt) : null;
    return { ok: true, unlocked: false, state: 'locked', reason: 'no_guest', aptId: wantedApt, apt: filterApt(apt, false),
      reservation: null, reservations: [], ownCancelled: false, elevator: null };
  }

  const own = await ownBases(ctx, token);
  if (!own) return bad('NOT_FOUND', 'Guest not found');
  if (await limited(ctx, 'stay:' + token, 120, 600)) return bad('RATE_LIMITED', 'Too many requests.');
  const guest = own.guest;

  const clock = ctx.testClock || {};   // only tests set this; a request can never change the clock
  const today = clock.today || tbilisiToday();
  const all = [];
  for (const base of own.bases) {
    for (const r of await ctx.listReservationsByNumberPrefix(base).catch(() => [])) {
      if (resBase(r) === base && !all.some(x => x.id === r.id)) all.push(r);
    }
  }
  const active = all.filter(r => !isCancelled(r)).sort(byRoom);
  const ownCancelled = all.length > 0 && all.every(isCancelled);
  const rooms = [...new Set(active.map(r => r.roomCode).filter(Boolean))];
  let aptId = wantedApt && (rooms.includes(wantedApt) || (!rooms.length && wantedApt === guest.aptId)) ? wantedApt : '';
  if (!aptId) aptId = (rooms.includes(guest.aptId) ? guest.aptId : '') || rooms[0] || guest.aptId || '';

  const valid = active.filter(r => r.roomCode === aptId).filter(r => (r.checkout || r.checkOut || '') >= today);
  const current = valid.filter(r => (r.checkin || r.checkIn || '') <= today);
  const upcoming = valid.filter(r => !(r.checkin || r.checkIn) || (r.checkin || r.checkIn) > today);
  let picked = valid.find(r => r.id === guest.matchedReservationId) || null;
  if (!picked) picked = pickBest(current) || pickBest(upcoming);
  if (picked && !picked.tuyaPassword) {   // a sibling booking of the same room may carry the lock password
    const withPw = pickBest(valid.filter(r => r.tuyaPassword));
    if (withPw && (withPw.checkin || withPw.checkIn) === (picked.checkin || picked.checkIn)) picked = withPw;
  }

  const apt = aptId ? await ctx.getApartment(aptId) : null;
  const yesterday = new Date(new Date(today + 'T00:00:00Z').getTime() - 86400000).toISOString().slice(0, 10);
  const [hkToday, hkYesterday] = aptId
    ? await Promise.all([ctx.getHkStatus(aptId, today), ctx.getHkStatus(aptId, yesterday)])
    : [null, null];
  const unlock = computeGuestUnlock({
    guest,
    arrivalDate: normalizeStayDate((picked && (picked.checkin || picked.checkIn)) || guest.arrivalDate || ''),
    checkInHour: parseCheckInHour(apt && apt.checkInTime),
    hkDone: (hkToday && hkToday.done === true) || (hkYesterday && hkYesterday.done === true),
    cancelled: ownCancelled,
    checkoutDate: (picked && (picked.checkout || picked.checkOut)) || guest.checkoutDate || '',
    today,
    hour: clock.hour,
  });

  const reservation = picked ? pubRes(picked) : null;
  if (reservation && unlock.unlocked && picked.tuyaPassword) reservation.tuyaPassword = String(picked.tuyaPassword);

  let elevator = null;
  if (unlock.unlocked) {
    try {
      const { fs, rtdb } = await ctx.readElevator();
      const merged = M._buildElevatorMerged(rtdb || null, fs ? plain(fs) : null);
      if (merged) elevator = plain(merged);
    } catch (e) { /* the page keeps showing the last code */ }
  }

  return {
    ok: true, unlocked: unlock.unlocked, state: unlock.state, reason: unlock.reason, aptId,
    apt: filterApt(apt, unlock.unlocked), reservation,
    reservations: active.map(pubRes), ownCancelled, elevator,
  };
}

// ------------------------------------------------------------- live wiring

function buildLiveCtx(secrets = {}) {
  const { getFirestore, FieldValue } = require('firebase-admin/firestore');
  const crypto = require('crypto');
  const proof = require('../lib/guest-proof');
  const db = getFirestore();
  const rows = snap => snap.docs.map(d => ({ id: d.id, ...d.data() }));
  const salt = () => secrets.proofSecret || 'unset';

  return {
    getReservation: async id => { const s = await db.collection('reservations').doc(String(id)).get(); return s.exists ? { id: s.id, ...s.data() } : null; },
    listReservationsByCheckin: async date => rows(await db.collection('reservations').where('checkin', '==', date).get()),
    listReservationsByBookingIds: async ids => rows(await db.collection('reservations').where('bookingId', 'in', ids.slice(0, 30)).get()),
    listReservationsByNumberPrefix: async base =>
      rows(await db.collection('reservations').where('reservationNumber', '>=', base).where('reservationNumber', '<=', base + '').get()),
    listGuestsByMatchedReservation: async (id, n) => rows(await db.collection('checkin_guests').where('matchedReservationId', '==', id).limit(n).get()),
    listGuestsByCompanionToken: async t => rows(await db.collection('checkin_guests').where('companionToken', '==', t).limit(1).get()),
    getGuest: async id => { const s = await db.collection('checkin_guests').doc(id).get(); return s.exists ? { id: s.id, ...s.data() } : null; },
    getApartment: async id => { const s = await db.collection('checkin_apartments').doc(id).get(); return s.exists ? s.data() : null; },
    getHkStatus: async (room, date) => { const s = await db.collection('hk_status').doc(room + '_' + date).get(); return s.exists ? s.data() : null; },
    readElevator: async () => {
      const fsSnap = await db.collection('globals').doc('elevator_code').get();
      let rtdb = null;
      try {
        const { getDatabaseWithUrl } = require('firebase-admin/database');
        const snap = await getDatabaseWithUrl('https://sleepy-5c962-default-rtdb.europe-west1.firebasedatabase.app').ref('elevator_code').get();
        rtdb = snap.exists() ? snap.val() : null;
      } catch (e) { /* firestore copy only */ }
      return { fs: fsSnap.exists ? fsSnap.data() : null, rtdb };
    },
    addSearchFailure: async doc => { await db.collection('search_failures').add({ ...doc, timestamp: FieldValue.serverTimestamp() }); },
    rateLimit: async (key, max, windowSec) => {
      const win = Math.floor(Date.now() / 1000 / windowSec);
      const id = crypto.createHash('sha256').update(salt() + '|' + key).digest('hex').slice(0, 40) + '_' + win;
      const ref = db.collection('guest_rate_limits').doc(id);
      return db.runTransaction(async tx => {
        const s = await tx.get(ref);
        const n = (s.exists ? s.data().n : 0) + 1;
        tx.set(ref, { n, expiresAt: new Date((win + 2) * windowSec * 1000) });
        return n > max;   // true = over the limit
      });
    },
    signProof: payload => proof.sign(secrets.proofSecret, payload),
    verifyProof: token => proof.verify(secrets.proofSecret, token),
  };
}

function clientIp(request) {
  const h = (request.rawRequest && request.rawRequest.headers) || {};
  const f = String(h['x-forwarded-for'] || '').split(',')[0].trim();
  return f || (request.rawRequest && request.rawRequest.ip) || '?';
}

function registerCloudFunctions() {
  const { onCall, HttpsError } = require('firebase-functions/v2/https');
  const { defineSecret } = require('firebase-functions/params');
  const PROOF_SECRET = defineSecret('GUEST_PROOF_SECRET');
  const base = { region: 'europe-west1', timeoutSeconds: 30, maxInstances: 10 };

  const wrap = (run, secretsFn) => async request => {
    try {
      const ctx = buildLiveCtx(secretsFn());
      return await run(ctx, request.data || {}, { ip: clientIp(request) });
    } catch (err) {
      console.error('[guestApi]', err && err.message);
      throw new HttpsError('internal', 'Request failed');
    }
  };

  return {
    guestFind: onCall({ ...base, secrets: [PROOF_SECRET] }, wrap(runGuestFind, () => ({ proofSecret: PROOF_SECRET.value() }))),
    guestStay: onCall({ ...base }, wrap(runGuestStay, () => ({}))),
  };
}

module.exports = {
  runGuestFind, runGuestStay, registerCloudFunctions, buildLiveCtx,
  filterApt, pubRes, plain, maskDigits, findLaterRelated,
};
