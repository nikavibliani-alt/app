#!/usr/bin/env node
/**
 * Copies the guest page's booking-matching functions (checkin-guest.html) into
 * pipeline-functions/lib/guest-match.js, so the server matches names exactly like the page does.
 *
 *   node scripts/sync-guest-match.js          # regenerate the server copy
 *   node scripts/sync-guest-match.js --check  # fail if the server copy is out of date
 */
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = join(ROOT, 'checkin-guest.html');
const OUT = join(ROOT, 'pipeline-functions/lib/guest-match.js');

const FUNCTIONS = [
  'reservationBaseNum', 'levenshtein', 'normalizePhone', '_nameWords', '_translit', 'isArabic', '_csk',
  '_normRef', '_looksLikeBookingRef', 'scoreReservations', '_allWords', '_isShortNameBooking',
  '_shortNameMatches', 'nameMatch', 'partialNameMatch', '_stripRoomNum', '_relatedBookings',
  '_elevatorUpdatedMs', '_buildElevatorMerged',
];

function matchBrace(src, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i; }
  }
  throw new Error('unbalanced braces');
}

function extractFunction(src, name) {
  const m = new RegExp('^(async )?function ' + name + '\\(', 'm').exec(src);
  if (!m) throw new Error('function not found in the page: ' + name);
  const open = src.indexOf('{', m.index);
  return src.slice(m.index, matchBrace(src, open) + 1);
}

function extractConstObject(src, name) {
  const m = new RegExp('^const ' + name + '=\\{', 'm').exec(src);
  if (!m) throw new Error('const not found in the page: ' + name);
  const open = src.indexOf('{', m.index);
  return src.slice(m.index, matchBrace(src, open) + 2);   // includes the closing ";"
}

export function build() {
  const html = readFileSync(PAGE, 'utf8');
  const parts = [extractConstObject(html, '_AR')];
  for (const f of FUNCTIONS) parts.push(extractFunction(html, f));
  return `'use strict';
/**
 * GENERATED from checkin-guest.html by scripts/sync-guest-match.js. Do not edit by hand.
 * The page's booking-matching code, copied as-is so the server and the page agree.
 */

${parts.join('\n')}

module.exports = {
  ${FUNCTIONS.join(',\n  ')},
};
`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = build();
  if (process.argv.includes('--check')) {
    let cur = '';
    try { cur = readFileSync(OUT, 'utf8'); } catch (e) { /* missing */ }
    if (cur !== out) {
      console.error('pipeline-functions/lib/guest-match.js is out of date. Run: node scripts/sync-guest-match.js');
      process.exit(1);
    }
    console.log('guest-match in sync');
  } else {
    writeFileSync(OUT, out);
    console.log('wrote', OUT);
  }
}
