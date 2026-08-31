#!/usr/bin/env node
'use strict';
/**
 * Promote checkin-admin-sandbox.html → checkin-admin.html (production).
 * Strips sandbox banner/labels; keeps pipeline backend wiring.
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = path.join(root, 'checkin-admin-sandbox.html');
let html = fs.readFileSync(src, 'utf8');

const PROD_BUILD = '20260831g';

html = html.replace(
  '<title>Maxela Admin — Sandbox (HK)</title>',
  '<title>Maxela — Check-in Admin</title>'
);
html = html.replace(
  '<div class="lock-sub">Sandbox · mobile ops</div>',
  '<div class="lock-sub">Property operations</div>'
);
html = html.replace(
  'Build 30a · Sandbox',
  `Build ${PROD_BUILD.slice(-4)} · Live`
);
html = html.replace(
  /var BUILD=window\.__STANDALONE_HK__\?'[^']+':'[^']+';/,
  `var BUILD='${PROD_BUILD}';`
);
html = html.replace(
  'const SANDBOX_BUILD=\'20260831g\';',
  `const ADMIN_BUILD='${PROD_BUILD}';`
);

html = html.replace(
  'function migrateSandboxBuild(){',
  'function migrateAdminBuild(){'
);
html = html.replace(
  "localStorage.getItem('maxela_sandbox_build')!==SANDBOX_BUILD",
  "localStorage.getItem('maxela_admin_prod_build')!==ADMIN_BUILD"
);
html = html.replace(
  "localStorage.setItem('maxela_sandbox_build',SANDBOX_BUILD)",
  "localStorage.setItem('maxela_admin_prod_build',ADMIN_BUILD)"
);
html = html.replace(
  '(function migrateAdminBuild(){',
  '(function migrateAdminBuild(){'
);
html = html.replace('migrateSandboxBuild()', 'migrateAdminBuild()');

html = html.replace(
  /if\(_usingPipelineEmulator\)\{mountEmulatorBanner\(\);console\.info\('\[sandbox\] pipeline functions → emulator 127\.0\.0\.1:5001'\);\}\nelse if\(!document\.getElementById\('admin-sandbox-banner'\)\)\{\n  const el=document\.createElement\('div'\);\n  el\.id='admin-sandbox-banner';\n  el\.innerHTML='Admin sandbox · <a href="sandbox-index\.html" style="color:#fff;text-decoration:underline">Testing hub<\/a> · not live';\n  el\.style\.cssText='position:fixed;top:0;left:0;right:0;z-index:99998;padding:5px 12px;background:#7a5a0a;color:#fff;font:600 11px\/1\.4 system-ui,sans-serif;text-align:center;';\n  document\.body\.prepend\(el\);\n\}/,
  "if(_usingPipelineEmulator){mountEmulatorBanner();console.info('[admin] pipeline functions → emulator 127.0.0.1:5001');}"
);

html = html.replace(/actor:'admin-sandbox'/g, "actor:'admin'");

html = html.replace(
  "return 'Add ?emulator=1 and start emulator, or deploy pipeline-adminAction (see SANDBOX_BACKEND_HANDOFF.md)';",
  "return 'Pipeline backend unavailable — try again or check Firebase Functions (adminAction).';"
);

html = html.replace(
  '/* ADMIN SANDBOX — see GUEST_CHECKIN_REDESIGN.md §22.9',
  '/* ADMIN — production (promoted from checkin-admin-sandbox.html) — see GUEST_CHECKIN_REDESIGN.md §22'
);

const legacyPath = path.join(root, 'checkin-admin-legacy.html');
const currentAdmin = path.join(root, 'checkin-admin.html');
if (fs.existsSync(currentAdmin) && !fs.existsSync(legacyPath)) {
  fs.writeFileSync(legacyPath, currentAdmin);
  console.log('Archived previous checkin-admin.html → checkin-admin-legacy.html');
}

const out = path.join(root, 'checkin-admin.html');
fs.writeFileSync(out, html);
console.log('Wrote', out, '(' + html.length + ' bytes)');
