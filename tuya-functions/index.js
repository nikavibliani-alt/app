/**
 * tuya-functions/index.js
 * Firebase Cloud Functions v2 — Tuya offline lock password generation
 *
 * Exports:
 *   generateOfflinePasswordOnReservation  Firestore trigger (reservations/{id} create)
 *   regenerateTuyaPassword                HTTPS callable — force regenerate for any reservation
 *   deleteTuyaPassword                    HTTPS callable — revoke a password from the lock
 *
 * TODO: migrate credentials to Firebase Secrets before production:
 *   firebase functions:secrets:set TUYA_ACCESS_ID
 *   firebase functions:secrets:set TUYA_ACCESS_SECRET
 *   Then access via process.env.TUYA_ACCESS_ID inside the function.
 */

const { onDocumentCreated }  = require('firebase-functions/v2/firestore');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { logger }             = require('firebase-functions');
const admin                  = require('firebase-admin');
const crypto                 = require('crypto');
const https                  = require('https');

admin.initializeApp();
const db = admin.firestore();

// ── Credentials (hardcoded for now) ──────────────────────────────────────────
// TODO: migrate to Firebase Secrets before production
const TUYA_ACCESS_ID     = 'wxd3afwrhewvh5p5tukc';
const TUYA_ACCESS_SECRET = '80edc016e2d84df886f500f38f5cc6b7';
const TUYA_HOST          = 'openapi.tuyaeu.com';

// Tbilisi is UTC+4 year-round (Georgia Standard Time, no DST)
const TBILISI_OFFSET_HOURS = 4;

// ── Tuya signing (copied verbatim from tuya-proxy.js) ────────────────────────
function sha256hex(s) {
    return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}
function hmacUpper(s, k) {
    return crypto.createHmac('sha256', k).update(s, 'utf8').digest('hex').toUpperCase();
}
function signPath(rawPath) {
    const qi = rawPath.indexOf('?');
    if (qi === -1) return rawPath;
    const pathname = rawPath.slice(0, qi);
    const sorted   = rawPath.slice(qi + 1).split('&').filter(Boolean).sort().join('&');
    return pathname + '?' + sorted;
}
function buildTuyaHeaders(method, path, token, body) {
    body = body || '';
    const t       = Date.now().toString();
    const nonce   = '';
    const sig     = signPath(path);
    const sts     = [method.toUpperCase(), sha256hex(body), '', sig].join('\n');
    const signStr = TUYA_ACCESS_ID + (token || '') + t + nonce + sts;
    const h = {
        'client_id':      TUYA_ACCESS_ID,
        'sign':           hmacUpper(signStr, TUYA_ACCESS_SECRET),
        't':              t,
        'sign_method':    'HMAC-SHA256',
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body, 'utf8').toString(),
    };
    if (token) h['access_token'] = token;
    return h;
}

// ── Low-level Tuya HTTPS call — always resolves ───────────────────────────────
function tuyaCall(method, path, token, body) {
    body = body || '';
    const headers = buildTuyaHeaders(method, path, token, body);
    return new Promise((resolve) => {
        const req = https.request(
            { hostname: TUYA_HOST, port: 443, method, path, headers, timeout: 15000 },
            (res) => {
                let raw = '';
                res.on('data', (c) => { raw += c; });
                res.on('end', () => {
                    logger.info(`TUYA ${method} ${path} → ${res.statusCode}`, { raw: raw.slice(0, 500) });
                    try { resolve({ status: res.statusCode, data: JSON.parse(raw) }); }
                    catch { resolve({ status: res.statusCode, data: { _raw: raw } }); }
                });
            }
        );
        req.on('timeout', () => { req.destroy(); resolve({ status: 504, data: { error: 'timeout' } }); });
        req.on('error',   (e) => resolve({ status: 0,   data: { error: e.message } }));
        req.write(body);
        req.end();
    });
}

// ── Get Tuya access token ─────────────────────────────────────────────────────
async function getTuyaToken() {
    const r = await tuyaCall('GET', '/v1.0/token?grant_type=1', null, '');
    if (!r.data.success) throw new Error(`Tuya token failed: ${r.data.msg} (code ${r.data.code})`);
    return r.data.result.access_token;
}

// ── Time helpers ──────────────────────────────────────────────────────────────
/**
 * Convert a date string "YYYY-MM-DD" + hour (local Tbilisi time) to Unix seconds.
 * Tbilisi = UTC+4, no DST.
 */
function tbilisiDateToUnix(dateStr, hourLocal) {
    // dateStr = "2026-05-20", hourLocal = 14 → 2026-05-20T10:00:00Z
    const [y, m, d] = dateStr.split('-').map(Number);
    const utcHour   = hourLocal - TBILISI_OFFSET_HOURS;
    const dt        = new Date(Date.UTC(y, m - 1, d, utcHour, 0, 0));
    return Math.floor(dt.getTime() / 1000);
}

// ── Core: generate offline password for a reservation ────────────────────────
async function generateForReservation(reservationId) {
    const resRef  = db.collection('reservations').doc(reservationId);
    const resSnap = await resRef.get();
    if (!resSnap.exists) throw new Error(`Reservation ${reservationId} not found`);

    const res = resSnap.data();
    const roomCode = (res.roomCode || '')
        .toLowerCase()
        .trim()
        .replace(/\s+/g, '-')           // "orb 1"  → "orb-1"
        .replace(/^orb(\d)$/, 'orb-$1') // "orb1"   → "orb-1"
        .replace(/^tab(\d)$/, 'tab-$1');// "tab1"   → "tab-1"

    if (!roomCode) {
        logger.info(`[${reservationId}] no roomCode — skipping`);
        return { skipped: true, reason: 'no roomCode' };
    }

    // Look up Tuya device ID from checkin_apartments/{roomCode}
    const aptSnap = await db.collection('checkin_apartments').doc(roomCode).get();
    const tuyaDeviceId = aptSnap.exists ? (aptSnap.data().tuyaDeviceId || '') : '';

    if (!aptSnap.exists) {
        logger.warn(`[${reservationId}] checkin_apartments/${roomCode} does not exist — raw roomCode was "${res.roomCode}"`);
        return { skipped: true, reason: `no checkin_apartments doc for "${roomCode}" (raw: "${res.roomCode}")` };
    }

    if (!tuyaDeviceId) {
        logger.info(`[${reservationId}] room ${roomCode} has no tuyaDeviceId — skipping (raw roomCode: "${res.roomCode}")`);
        return { skipped: true, reason: 'no tuyaDeviceId for room ' + roomCode };
    }

    // Check-in at 14:00, checkout at 12:00 Tbilisi time
    const checkIn  = res.checkin  || res.checkIn  || '';
    const checkOut = res.checkout || res.checkOut || '';
    if (!checkIn || !checkOut) {
        await resRef.update({ tuyaError: 'Missing checkin or checkout date', tuyaGeneratedAt: admin.firestore.FieldValue.serverTimestamp() });
        throw new Error(`[${reservationId}] missing dates`);
    }

    const effectiveSec = tbilisiDateToUnix(checkIn,  14);   // check-in at 14:00
    const invalidSec   = tbilisiDateToUnix(checkOut, 12);   // checkout at 12:00

    const guestName = res.guest || res.guestName || 'Guest';
    const pwdName   = `${guestName} - ${roomCode}`.slice(0, 30);   // Tuya name limit

    logger.info(`[${reservationId}] generating password`, {
        roomCode, tuyaDeviceId, pwdName,
        effectiveSec, invalidSec,
        checkIn, checkOut,
    });

    try {
        const token = await getTuyaToken();
        const body  = JSON.stringify({
            name:           pwdName,
            type:           'multiple',
            effective_time: effectiveSec,
            invalid_time:   invalidSec,
        });
        const r = await tuyaCall(
            'POST',
            `/v1.1/devices/${tuyaDeviceId}/door-lock/offline-temp-password`,
            token,
            body
        );

        if (!r.data.success) {
            const errMsg = `Tuya error ${r.data.code}: ${r.data.msg}`;
            await resRef.update({
                tuyaError:        errMsg,
                tuyaGeneratedAt:  admin.firestore.FieldValue.serverTimestamp(),
            });
            throw new Error(errMsg);
        }

        const pwd   = r.data.result?.offline_temp_password || r.data.result?.password || '';
        const pwdId = r.data.result?.offline_temp_password_id || r.data.result?.id || '';

        await resRef.update({
            tuyaPassword:       pwd,
            tuyaPasswordId:     pwdId,
            tuyaEffectiveTime:  effectiveSec,
            tuyaInvalidTime:    invalidSec,
            tuyaGeneratedAt:    admin.firestore.FieldValue.serverTimestamp(),
            tuyaError:          admin.firestore.FieldValue.delete(),   // clear any previous error
        });

        logger.info(`[${reservationId}] ✅ password generated`, { pwdId, tuyaDeviceId });
        return { ok: true, pwdId, tuyaDeviceId, effectiveSec, invalidSec };

    } catch (err) {
        // If not already written above, write the error
        try {
            await resRef.update({
                tuyaError:       err.message,
                tuyaGeneratedAt: admin.firestore.FieldValue.serverTimestamp(),
            });
        } catch (_) {}
        throw err;
    }
}

// ── Export 1: Firestore trigger on reservation create ────────────────────────
exports.generateOfflinePasswordOnReservation = onDocumentCreated(
    { document: 'reservations/{reservationId}', region: 'europe-west1' },
    async (event) => {
        const reservationId = event.params.reservationId;
        logger.info(`[trigger] new reservation ${reservationId}`);
        try {
            const result = await generateForReservation(reservationId);
            if (result.skipped) logger.info(`[trigger] skipped: ${result.reason}`);
        } catch (err) {
            logger.error(`[trigger] failed for ${reservationId}:`, err.message);
            // Don't rethrow — a trigger failure shouldn't block reservation creation
        }
    }
);

// ── Export 2: Callable — manually regenerate password ────────────────────────
exports.regenerateTuyaPassword = onCall(
    { region: 'europe-west1' },
    async (request) => {
        const { reservationId } = request.data;
        if (!reservationId) throw new HttpsError('invalid-argument', 'reservationId required');
        logger.info(`[callable] regenerateTuyaPassword for ${reservationId}`);
        try {
            return await generateForReservation(reservationId);
        } catch (err) {
            throw new HttpsError('internal', err.message);
        }
    }
);

// ── Export 3: Callable — delete/revoke a password from the lock ──────────────
exports.deleteTuyaPassword = onCall(
    { region: 'europe-west1' },
    async (request) => {
        const { reservationId } = request.data;
        if (!reservationId) throw new HttpsError('invalid-argument', 'reservationId required');

        const resRef  = db.collection('reservations').doc(reservationId);
        const resSnap = await resRef.get();
        if (!resSnap.exists) throw new HttpsError('not-found', `Reservation ${reservationId} not found`);

        const res          = resSnap.data();
        const tuyaPasswordId = res.tuyaPasswordId;
        const roomCode     = (res.roomCode || '').toLowerCase().trim();

        if (!tuyaPasswordId) throw new HttpsError('failed-precondition', 'No tuyaPasswordId on this reservation');

        const aptSnap      = await db.collection('checkin_apartments').doc(roomCode).get();
        const tuyaDeviceId = aptSnap.exists ? (aptSnap.data().tuyaDeviceId || '') : '';
        if (!tuyaDeviceId) throw new HttpsError('failed-precondition', `No tuyaDeviceId for room ${roomCode}`);

        logger.info(`[callable] deleteTuyaPassword`, { reservationId, tuyaDeviceId, tuyaPasswordId });

        const token = await getTuyaToken();
        const r = await tuyaCall(
            'DELETE',
            `/v1.0/devices/${tuyaDeviceId}/door-lock/temp-password/${tuyaPasswordId}`,
            token,
            ''
        );

        if (!r.data.success) {
            throw new HttpsError('internal', `Tuya delete failed: code=${r.data.code} msg=${r.data.msg}`);
        }

        await resRef.update({
            tuyaPassword:    admin.firestore.FieldValue.delete(),
            tuyaPasswordId:  admin.firestore.FieldValue.delete(),
            tuyaDeletedAt:   admin.firestore.FieldValue.serverTimestamp(),
        });

        logger.info(`[callable] ✅ password revoked`, { tuyaPasswordId });
        return { ok: true, tuyaPasswordId };
    }
);
