'use strict';
/**
 * Maxela health monitor — daily checks for silent failures.
 *
 * Usage (local):
 *   FIREBASE_SERVICE_ACCOUNT=base64... RESEND_API_KEY=re_... node health-monitor.js
 *
 * GitHub Actions: .github/workflows/health-monitor.yml
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { Resend } = require('resend');

const FROM = 'onboarding@resend.dev';
const TO = process.env.HEALTH_ALERT_EMAIL || 'nikavibliani@gmail.com';
const COOLDOWN_MS = 12 * 60 * 60 * 1000; // max one alert email per 12h

/** Keep in sync with shared/room-registry.js DEFAULT_ROOMS_SEED */
const EXPECTED_ROOM_CODES = [
  '0-1', '0-2', '0-3', '0-4', '0-5',
  '6-1', '6-2', '6-3', '6-4', '7-1', '7-2', '7-4',
  'orb-1', 'orb-2', 'orb-3', 'tab-1', 'tab-2', 'tab-3',
  'vgl-st1', 'vgl-st2', 'vgl-ap3', 'vgl-ap4',
  'abashidze',
];

const REQUIRED_HK_PIN_KEYS = ['shartava', 'centre', 'vgl', 'admin'];
const RESERVATION_STALE_MS = 36 * 60 * 60 * 1000; // warn if no sync in 36h

function initFirestore() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT not set');
  const sa = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  const admin = require('firebase-admin');
  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(sa) });
  }
  return admin.firestore();
}

/** @returns {{name:string, ok:boolean, detail:string}[]} */
function runLocalChecks() {
  const results = [];
  try {
    execSync('node scripts/check-guest-unlock-sync.js', {
      cwd: path.join(__dirname, '..'),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    results.push({ name: 'Guest unlock sync', ok: true, detail: 'shared/ ↔ pipeline lib in sync' });
  } catch (e) {
    const out = (e.stdout?.toString() || e.stderr?.toString() || e.message).slice(0, 400);
    results.push({ name: 'Guest unlock sync', ok: false, detail: out });
  }

  try {
    execSync('npm test', {
      cwd: path.join(__dirname, '../pipeline-functions'),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    results.push({ name: 'Pipeline unit tests', ok: true, detail: 'All tests passed' });
  } catch (e) {
    results.push({ name: 'Pipeline unit tests', ok: false, detail: 'npm test failed in pipeline-functions' });
  }

  return results;
}

async function checkReservationSync(db) {
  // Sample recent docs — avoids requiring a syncedAt composite index
  const snap = await db.collection('reservations').limit(200).get();
  if (snap.empty) {
    return { name: 'MiniHotel reservation sync', ok: false, detail: 'No reservations in Firestore' };
  }
  let latest = null;
  snap.forEach((d) => {
    const ts = d.data().syncedAt?.toDate?.();
    if (ts && (!latest || ts > latest)) latest = ts;
  });
  if (!latest) {
    return { name: 'MiniHotel reservation sync', ok: false, detail: 'No syncedAt on sampled reservations' };
  }
  const ageMs = Date.now() - latest.getTime();
  const ageH = (ageMs / 3_600_000).toFixed(1);
  if (ageMs > RESERVATION_STALE_MS) {
    return {
      name: 'MiniHotel reservation sync',
      ok: false,
      detail: `Last syncedAt ~${ageH}h ago — check cron-job.org (workflow_dispatch every ~10 min), not "enable GitHub schedule". See docs/OPERATIONS.md`,
    };
  }
  return { name: 'MiniHotel reservation sync', ok: true, detail: `Last sync ~${ageH}h ago` };
}

async function checkRoomRegistry(db) {
  const missing = [];
  const inactive = [];
  for (const code of EXPECTED_ROOM_CODES) {
    const doc = await db.collection('checkin_rooms').doc(code).get();
    if (!doc.exists) missing.push(code);
    else if (doc.data()?.active === false) inactive.push(code);
  }
  if (missing.length) {
    return {
      name: 'Room registry (checkin_rooms)',
      ok: false,
      detail: `Missing ${missing.length} room(s): ${missing.join(', ')} — open admin sandbox to sync`,
    };
  }
  if (inactive.length) {
    return {
      name: 'Room registry (checkin_rooms)',
      ok: false,
      detail: `Inactive: ${inactive.join(', ')}`,
    };
  }
  return { name: 'Room registry (checkin_rooms)', ok: true, detail: `${EXPECTED_ROOM_CODES.length} rooms present` };
}

async function checkHkPins(db) {
  const empty = [];
  for (const role of REQUIRED_HK_PIN_KEYS) {
    const doc = await db.collection('hk_pins').doc(role).get();
    const pin = doc.exists ? String(doc.data()?.pin || '') : '';
    if (pin.length < 4) empty.push(role);
  }
  if (empty.length) {
    return {
      name: 'HK staff PINs',
      ok: false,
      detail: `Missing PIN doc or empty: ${empty.join(', ')} — set in admin HK settings`,
    };
  }
  return { name: 'HK staff PINs', ok: true, detail: 'shartava, centre, vgl, admin configured' };
}

async function checkGuestPageReachable() {
  const url = 'https://app.maxelaapartments.com/checkin-guest.html';
  try {
    const res = await fetch(url, { method: 'HEAD', redirect: 'follow' });
    if (!res.ok) {
      return { name: 'Guest check-in URL', ok: false, detail: `${url} → HTTP ${res.status}` };
    }
    return { name: 'Guest check-in URL', ok: true, detail: `${url} reachable` };
  } catch (e) {
    return { name: 'Guest check-in URL', ok: false, detail: e.message };
  }
}

async function loadAlertState(db) {
  try {
    const doc = await db.collection('config').doc('health_monitor').get();
    return doc.exists ? doc.data() : {};
  } catch {
    return {};
  }
}

async function saveAlertState(db, patch) {
  await db.collection('config').doc('health_monitor').set(
    { ...patch, updatedAt: new Date() },
    { merge: true },
  );
}

function buildReport(results) {
  const failed = results.filter((r) => !r.ok);
  const lines = results.map((r) => `${r.ok ? '✅' : '❌'} ${r.name}: ${r.detail}`);
  return { failed, lines, html: lines.map((l) => `<li>${l}</li>`).join('') };
}

async function sendAlert(resend, subject, html) {
  const { error } = await resend.emails.send({ from: FROM, to: TO, subject, html });
  if (error) throw new Error(JSON.stringify(error));
}

async function main() {
  console.log('Maxela health monitor —', new Date().toISOString());

  const results = runLocalChecks();

  const db = initFirestore();
  results.push(await checkReservationSync(db));
  results.push(await checkRoomRegistry(db));
  results.push(await checkHkPins(db));
  results.push(await checkGuestPageReachable());

  const { failed, lines, html } = buildReport(results);
  lines.forEach((l) => console.log(l));

  await saveAlertState(db, {
    lastRunAt: new Date(),
    lastResults: results,
    lastFailedCount: failed.length,
  });

  if (!failed.length) {
    console.log('All checks passed');
    return;
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('Checks failed but RESEND_API_KEY not set — no email sent');
    process.exit(1);
  }

  const state = await loadAlertState(db);
  const lastAlert = state.lastAlertSent?.toDate?.()?.getTime?.() || Number(state.lastAlertSentMs || 0);
  if (Date.now() - lastAlert < COOLDOWN_MS) {
    console.log('Alert cooldown — email skipped');
    process.exit(1);
  }

  const resend = new Resend(apiKey);
  await sendAlert(
    resend,
    `⚠️ Maxela health check — ${failed.length} issue(s)`,
    `<h2>Health monitor found problems</h2><ul>${html}</ul><p>Fix in admin or GitHub Actions, then re-run workflow.</p>`,
  );
  await saveAlertState(db, { lastAlertSent: new Date(), lastAlertSentMs: Date.now() });
  process.exit(1);
}

main().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
