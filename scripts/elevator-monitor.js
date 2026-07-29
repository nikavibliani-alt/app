'use strict';
const { Resend } = require('resend');

const FIREBASE_BASE = 'https://sleepy-5c962-default-rtdb.europe-west1.firebasedatabase.app';
const ELEVATOR_URL  = `${FIREBASE_BASE}/elevator_code.json`;
const MONITOR_URL   = `${FIREBASE_BASE}/elevator_monitor.json`;
const LAST_ALERT_URL = `${FIREBASE_BASE}/elevator_monitor/last_alert_sent.json`;
const WAS_STALE_URL  = `${FIREBASE_BASE}/elevator_monitor/was_stale.json`;

const STALE_MS   = 2 * 60 * 60 * 1000;  // 2 hours
const COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6 hours between alerts
const TZ_OFFSET  = 4 * 60 * 60 * 1000;  // UTC+4 Tbilisi

const FROM = 'alerts@maxelaapartments.com';
const TO   = 'nikavibliani@gmail.com';

async function get(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} → ${res.status} ${res.statusText}`);
  return res.json();
}

async function put(url, value) {
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  });
  if (!res.ok) throw new Error(`PUT ${url} → ${res.status} ${res.statusText}`);
}

function tbilisiTime(ms) {
  const d = new Date(ms + TZ_OFFSET);
  return d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC+4';
}

async function sendEmail(resend, subject, html) {
  const { data, error } = await resend.emails.send({ from: FROM, to: TO, subject, html });
  if (error) throw new Error(`Resend error: ${JSON.stringify(error)}`);
  console.log(`Email sent: ${subject} (id: ${data?.id})`);
}

async function main() {
  const resend = new Resend(process.env.RESEND_API_KEY);
  const now = Date.now();

  // ── Read elevator code ─────────────────────────────────────────────────
  const elevatorData = await get(ELEVATOR_URL);

  if (!elevatorData || elevatorData.updatedAt == null) {
    console.log('No elevator_code data or missing updatedAt — skipping');
    return;
  }

  const updatedAt  = Number(elevatorData.updatedAt);
  const stalenessMs = now - updatedAt;
  const isStale    = stalenessMs > STALE_MS;
  const hoursSince = (stalenessMs / 3_600_000).toFixed(1);

  console.log(`Last updated : ${tbilisiTime(updatedAt)}`);
  console.log(`Now          : ${tbilisiTime(now)}`);
  console.log(`Hours since  : ${hoursSince}h`);
  console.log(`Status       : ${isStale ? 'STALE ⚠️' : 'OK ✅'}`);

  // ── Read monitoring state ──────────────────────────────────────────────
  const monitor     = (await get(MONITOR_URL).catch(() => null)) || {};
  const lastAlert   = Number(monitor.last_alert_sent || 0);
  const wasStale    = Boolean(monitor.was_stale);

  // ── Stale path ────────────────────────────────────────────────────────
  if (isStale) {
    const timeSinceAlert = now - lastAlert;

    if (timeSinceAlert < COOLDOWN_MS) {
      const nextInH = ((COOLDOWN_MS - timeSinceAlert) / 3_600_000).toFixed(1);
      console.log(`Alert cooldown active — next alert in ${nextInH}h`);
    } else {
      const html = `
        <h2 style="color:#b91c1c">⚠️ Elevator Code Not Updated</h2>
        <p>The elevator code has not been refreshed in <strong>${hoursSince} hours</strong>.</p>
        <table cellpadding="6" style="border-collapse:collapse;font-size:14px;">
          <tr><td style="color:#6b7280">Last updated</td><td><strong>${tbilisiTime(updatedAt)}</strong></td></tr>
          <tr><td style="color:#6b7280">Current time</td><td><strong>${tbilisiTime(now)}</strong></td></tr>
          <tr><td style="color:#6b7280">Hours since update</td><td><strong>${hoursSince}h</strong></td></tr>
        </table>
        <p style="margin-top:16px">Guests arriving now may receive a stale elevator code.<br>
        Check the Tuya integration and restart the sync if needed.</p>
      `;
      await sendEmail(resend, '⚠️ Elevator Code Not Updated — Action Required', html);
      await put(LAST_ALERT_URL, now);
    }

    if (!wasStale) {
      await put(WAS_STALE_URL, true);
    }
    return;
  }

  // ── Healthy path ──────────────────────────────────────────────────────
  if (wasStale) {
    const html = `
      <h2 style="color:#15803d">✅ Elevator Code Back Online</h2>
      <p>The elevator code is updating normally again.</p>
      <table cellpadding="6" style="border-collapse:collapse;font-size:14px;">
        <tr><td style="color:#6b7280">Last updated</td><td><strong>${tbilisiTime(updatedAt)}</strong></td></tr>
        <tr><td style="color:#6b7280">Current time</td><td><strong>${tbilisiTime(now)}</strong></td></tr>
      </table>
      <p style="margin-top:16px">No further action needed.</p>
    `;
    await sendEmail(resend, '✅ Elevator Code Back Online — SleepyPMS', html);
    await put(WAS_STALE_URL, false);
    return;
  }

  console.log('Elevator code is current — nothing to do');
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
