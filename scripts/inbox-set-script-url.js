#!/usr/bin/env node
'use strict';
/**
 * Saves the Gmail script's web app URL where the inboxSendReply function can find it
 * (Firestore inbox_meta/outbox_config, server-only). The URL is not secret: calling it also needs
 * INBOX_INGEST_KEY. Needs admin access on this Mac.
 *
 *   node scripts/inbox-set-script-url.js https://script.google.com/macros/s/XXXX/exec
 *   node scripts/inbox-set-script-url.js --clear
 */
const path = require('path');
const { createRequire } = require('module');
const req = createRequire(path.join(__dirname, '..', 'pipeline-functions', 'package.json'));
const { initializeApp, getApps } = req('firebase-admin/app');
const { getFirestore, Timestamp } = req('firebase-admin/firestore');

const arg = process.argv[2];
const OK = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/;
if (!arg || (arg !== '--clear' && !OK.test(arg))) {
  console.error('Give the web app URL: https://script.google.com/macros/s/.../exec (it must end in /exec, not /dev).');
  process.exit(1);
}
(async () => {
  if (!getApps().length) initializeApp({ projectId: 'sleepy-5c962' });
  const ref = getFirestore().collection('inbox_meta').doc('outbox_config');
  if (arg === '--clear') { await ref.set({ webAppUrl: null, updatedAt: Timestamp.now() }, { merge: true }); console.log('Cleared: replies go out at the next minute run.'); return; }
  await ref.set({ webAppUrl: arg, updatedAt: Timestamp.now() }, { merge: true });
  console.log('Saved. New replies now trigger the script at once.');
})().then(() => process.exit(0), e => { console.error(e); process.exit(1); });
