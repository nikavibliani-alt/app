#!/usr/bin/env node
'use strict';
/**
 * Promote checkin-guest-sandbox-2.html → checkin-guest.html (production).
 * Strips sandbox dev toolbar CSS/JS/HTML and mock-guest shortcuts.
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = path.join(root, 'checkin-guest-sandbox-2.html');
let html = fs.readFileSync(src, 'utf8');

// Remove sandbox dev toolbar CSS block
html = html.replace(
  /\n\/\* ══+\n   SANDBOX — dev toolbar[\s\S]*?#sb-toolbar button\.sb-toggle-on\{[^}]+\}\n/,
  '\n'
);

// Toolbar clearance no longer needed
html = html.replace('body{padding-bottom:72px;}', 'body{padding-bottom:0;}');

// Production guest link base
html = html.replace(
  'import{GUEST_APP_VERSION}from"./shared/guest-app-version.js";',
  'import{GUEST_APP_VERSION,GUEST_APP_URL}from"./shared/guest-app-version.js";'
);
html = html.replace(
  /function buildGuestLink\(token\)\{\n  const base=window\.location\.origin\+window\.location\.pathname;\n  return base\+'\?g='\+encodeURIComponent\(token\);\n\}/,
  "function buildGuestLink(token){\n  return GUEST_APP_URL+'?g='+encodeURIComponent(token);\n}"
);
html = html.replace(
  'guestLinkBase:window.location.origin+window.location.pathname,',
  'guestLinkBase:GUEST_APP_URL,'
);

// Mock guest shortcuts (toolbar-only)
html = html.replace(
  /\n  \/\/ Sandbox mock: keep mock aptData \/ hero; do not hit Firestore\n  if\(_sbMockActive\)\{\n    if\(guestData\)guestData=\{\.\.\.guestData,aptId\};\n    renderGreetingApt\(\);\n    _renderHeroContent\(\);\n    return;\n  \}\n/,
  '\n'
);
html = html.replace(
  /  if\(_sbMockActive\)\{applyHomePhase\(\);toast\('Welcome! Enjoy your stay\.'\);return;\} \/\/ sandbox mock guest — skip Firestore write\n/,
  ''
);
html = html.replace(
  /  if\(_sbMockActive\)\{toast\('Safe travels! Hope to see you again\.'\);applyHomePhase\(\);return;\} \/\/ sandbox mock guest — skip Firestore write\n/,
  ''
);

// Remove entire sandbox dev toolbar JS block
html = html.replace(
  /\n\/\/ ══+\n\/\/ SANDBOX DEV TOOLBAR[\s\S]*?window\._sbToggleCollapse=function\(\)\{[\s\S]*?\};\n\ninit\(\);/,
  '\n\ninit();'
);

// Remove sandbox dev toolbar HTML
html = html.replace(
  /\n<!-- ══+\n     SANDBOX DEV TOOLBAR[\s\S]*?<\/div>\n<\/body>/,
  '\n</body>'
);

// Production title hint in HTML comment at top of style block
html = html.replace(
  'SANDBOX 2 — Cursor design proposal (does not replace sandbox 1)',
  'Guest check-in — production (promoted from sandbox-2)'
);

const out = path.join(root, 'checkin-guest.html');
fs.writeFileSync(out, html);
console.log('Wrote', out, '(' + html.length + ' bytes)');
