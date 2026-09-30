#!/usr/bin/env node
'use strict';
/**
 * Safety check for cleaner.html: the cleaner page must never contain admin-only code
 * or write to anything except the collections below.
 * Step 3 (damage reports) must extend ALLOWED_WRITE_COLLECTIONS.
 */
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'cleaner.html');
const FORBIDDEN = [
  'hkOpenEditRoom', 'hkOpenMoveRoom', 'hkMoveRoom', 'hkRemoveRoom', 'hkSaveAdminModal',
  'hk-admin-modal', 'deleteDoc', 'deleteField', 'hk_pins', '_ADMIN_PWD', 'adminAction', 'Add room',
];
const ALLOWED_WRITE_COLLECTIONS = ['hk_status', 'checkin_guests', 'hk_staff_links'];

const src = fs.readFileSync(FILE, 'utf8');
const errors = [];

for (const word of FORBIDDEN) {
  if (src.includes(word)) errors.push(`forbidden text found: ${word}`);
}

const writeRe = /\b(setDoc|updateDoc|addDoc)\s*\(\s*(doc|collection)\s*\(\s*db\s*,\s*(['"`])([^'"`]+)\3/g;
const parsed = new Set();
let m;
while ((m = writeRe.exec(src))) {
  parsed.add(m.index);
  if (!ALLOWED_WRITE_COLLECTIONS.includes(m[4])) errors.push(`${m[1]} writes to disallowed collection: ${m[4]}`);
}
// every write call must be one we could read the target of (the import line is not a call)
const anyRe = /\b(setDoc|updateDoc|addDoc)\s*\(/g;
while ((m = anyRe.exec(src))) {
  if (!parsed.has(m.index)) errors.push(`${m[1]}( call with unreadable target at offset ${m.index}`);
}

if (errors.length) {
  console.error('FAIL cleaner.html safety check:\n - ' + errors.join('\n - '));
  process.exit(1);
}
console.log(`OK cleaner.html: no forbidden code; ${parsed.size} write calls, all to [${ALLOWED_WRITE_COLLECTIONS.join(', ')}]`);
