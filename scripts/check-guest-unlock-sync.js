#!/usr/bin/env node
/** Fail if browser + server guest-unlock logic drift apart. */
import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHARED = join(ROOT, 'shared/guest-unlock.js');
const SERVER = join(ROOT, 'pipeline-functions/lib/guest-unlock.js');

function extractLogic(src) {
  const start = src.indexOf('function computeGuestUnlock');
  const end = src.indexOf('function isGuestUnlocked');
  if (start < 0 || end < 0) throw new Error('Could not find computeGuestUnlock block');
  return src.slice(start, end).replace(/\s+/g, ' ').trim();
}

const sharedLogic = extractLogic(readFileSync(SHARED, 'utf8'));
const serverLogic = extractLogic(readFileSync(SERVER, 'utf8'));

if (sharedLogic !== serverLogic) {
  console.error('guest-unlock.js logic mismatch between shared/ and pipeline-functions/lib/');
  console.error('Edit shared/guest-unlock.js then run: node scripts/sync-guest-unlock.js');
  process.exit(1);
}

const hash = createHash('sha256').update(sharedLogic).digest('hex').slice(0, 12);
console.log('guest-unlock logic in sync (' + hash + ')');
