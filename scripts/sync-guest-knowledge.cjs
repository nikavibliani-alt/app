#!/usr/bin/env node
/**
 * The Booking.com inbox drafter uses the WhatsApp bot's knowledge, rules and helpers ("same brain").
 * Each codebase deploys on its own, so the drafter works from verbatim copies of these files in
 * pipeline-functions/lib/guestKnowledge/. The WhatsApp files stay the source; nothing in
 * whatsapp-functions is changed or wired to the copies.
 *
 *   node scripts/sync-guest-knowledge.cjs          # copy the files
 *   node scripts/sync-guest-knowledge.cjs --check  # fail if a copy is out of date (also run by the tests)
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FROM = path.join(ROOT, 'whatsapp-functions');
const TO = path.join(ROOT, 'pipeline-functions', 'lib', 'guestKnowledge');
const FILES = [
  ['knowledge/seed.js', 'seed.js'],
  ['knowledge/promptTemplate.js', 'promptTemplate.js'],
  ['knowledge/knowledgeBase.js', 'knowledgeBase.js'],
  ['claudeClient.js', 'claudeClient.js'],
  ['toneGuard.js', 'toneGuard.js'],
  ['ownerSilence.js', 'ownerSilence.js'],
  ['stayRules.js', 'stayRules.js'],
  ['stayContext.js', 'stayContext.js'],
  ['guestLookup.js', 'guestLookup.js'],
];

function outOfDate() {
  return FILES.filter(([src, dst]) => {
    const a = fs.readFileSync(path.join(FROM, src), 'utf8');
    const p = path.join(TO, dst);
    return !fs.existsSync(p) || fs.readFileSync(p, 'utf8') !== a;
  }).map(([, dst]) => dst);
}

if (require.main === module) {
  if (process.argv.includes('--check')) {
    const bad = outOfDate();
    if (bad.length) { console.error('Out of date, run: node scripts/sync-guest-knowledge.cjs\n  ' + bad.join('\n  ')); process.exit(1); }
    console.log('guestKnowledge copies are up to date.');
  } else {
    fs.mkdirSync(TO, { recursive: true });
    for (const [src, dst] of FILES) fs.copyFileSync(path.join(FROM, src), path.join(TO, dst));
    console.log(`Copied ${FILES.length} files to pipeline-functions/lib/guestKnowledge/`);
  }
}
module.exports = { outOfDate, FILES };
