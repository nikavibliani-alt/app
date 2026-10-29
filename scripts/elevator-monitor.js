'use strict';
/* Elevator code monitor. Runs from cron-job.org (workflow_dispatch), every 10-30 minutes.
 * Reads RTDB /elevator_code, decides with elevator-monitor-logic.js, and on a new problem sends the existing email
 * plus a push (an elevator_alerts doc, sent to the admin phones by the pushOnElevatorAlert function).
 * Env: RESEND_API_KEY, FIREBASE_SERVICE_ACCOUNT (for the push doc).
 * Testing: ELEVATOR_FIXTURE='{"data":{...},"monitor":{...}}' uses fake data, and DRY_RUN=1 sends and writes nothing. */
const { decide, alertTexts, tbilisiTime } = require('./elevator-monitor-logic');

const FIREBASE_BASE = 'https://sleepy-5c962-default-rtdb.europe-west1.firebasedatabase.app';
const ELEVATOR_URL = `${FIREBASE_BASE}/elevator_code.json`;
const MONITOR_URL = `${FIREBASE_BASE}/elevator_monitor.json`;

const FROM = 'onboarding@resend.dev';
const TO = 'nikavibliani@gmail.com';
const DRY = process.env.DRY_RUN === '1';

async function get(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  return res.json();
}

async function patchMonitor(values) {
  if (DRY) { console.log('[dry run] would save', JSON.stringify(values)); return; }
  const res = await fetch(MONITOR_URL, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(values),
  });
  if (!res.ok) throw new Error(`PATCH ${MONITOR_URL} -> ${res.status} ${res.statusText}`);
}

async function sendEmail(subject, html) {
  if (DRY) { console.log('[dry run] would email:', subject); return; }
  const { Resend } = require('resend');
  const resend = new Resend(process.env.RESEND_API_KEY);
  const { data, error } = await resend.emails.send({ from: FROM, to: TO, subject, html });
  if (error) throw new Error(`Resend error: ${JSON.stringify(error)}`);
  console.log(`Email sent: ${subject} (id: ${data && data.id})`);
}

// One doc per problem; the pushOnElevatorAlert function turns it into a push on every admin phone.
async function queuePush(title, body) {
  if (DRY) { console.log('[dry run] would queue push:', title, '|', body); return; }
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) { console.log('No FIREBASE_SERVICE_ACCOUNT, push skipped'); return; }
  const admin = require('firebase-admin');
  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
  }
  await admin.firestore().collection('elevator_alerts').add({ title, body, createdAt: new Date().toISOString() });
  console.log('Push queued');
}

async function main() {
  const now = Date.now();
  let data, monitor;
  if (process.env.ELEVATOR_FIXTURE) {
    const f = JSON.parse(process.env.ELEVATOR_FIXTURE);
    data = f.data; monitor = f.monitor;
  } else {
    data = await get(ELEVATOR_URL);
    monitor = (await get(MONITOR_URL).catch(() => null)) || {};
  }
  const d = decide(data, monitor, now);
  console.log(`Now: ${tbilisiTime(now)} | ${d.reason} | action: ${d.action}`);

  if (d.action === 'alert') {
    const t = alertTexts(d, now);
    // Save the flag first: if the email or push then fails, the next run does not repeat the other one.
    await patchMonitor({ alert_open: true, alert_since: now, last_alert_sent: now, was_stale: true });
    try { await queuePush(t.title, t.body); } catch (e) { console.error('Push failed:', e.message); }
    await sendEmail(t.subject, `
      <h2 style="color:#b91c1c">${t.title}</h2>
      <p>${d.reason}</p>
      <p>Guests arriving now may get an old elevator code.<br>
      Open the Samsung phone and check that the ElevatorSync app is running and the building app is open.
      You can also type the code by hand in the admin Elevator tab; that clears this alert.</p>
      <p style="color:#6b7280">Checked at ${t.now}. You get one message per problem.</p>`);
  } else if (d.action === 'recover') {
    await patchMonitor({ alert_open: false, was_stale: false, recovered_at: now });
    await sendEmail('Elevator code is current again', `
      <h2 style="color:#15803d">Elevator code is current again</h2>
      <p>${d.reason}</p><p>No further action needed.</p>`);
  } else {
    console.log('Nothing to do');
  }
}

main().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
