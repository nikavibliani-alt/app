#!/usr/bin/env node
'use strict';
/**
 * Promote checkin-admin-sandbox.html → HK.html (standalone housekeeping app).
 * Same HK board as admin tab, with PIN login for cleaners.
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = path.join(root, 'checkin-admin-sandbox.html');
let html = fs.readFileSync(src, 'utf8');

const HK_BUILD = '20260831hk2';

html = html.replace(
  '<title>Maxela Admin — Sandbox (HK)</title>',
  '<title>Sleepy HK</title>'
);

html = html.replace(
  /<script>window\.__STANDALONE_HK__=[\s\S]*?<\/script>\n/,
  '<script>window.__STANDALONE_HK__=true;document.documentElement.classList.add(\'standalone-hk\');try{var role=localStorage.getItem(\'hk_role\')||localStorage.getItem(\'hk_shartava_role\');if(role){document.documentElement.classList.add(\'hk-authed\');if(role===\'admin\')document.documentElement.classList.add(\'hk-admin-role\');}}catch(e){}</script>\n'
);

html = html.replace(
  /var BUILD=window\.__STANDALONE_HK__\?'20260831hk':'20260831e';/,
  `var BUILD='${HK_BUILD}';`
);
html = html.replace(
  /if\(!\/\[\?&\]build=20260831(?:f|hk2)/,
  `if(!/[?&]build=${HK_BUILD}`
);

html = html.replace(
  '<div id="loading"><div class="spinner"></div><div style="font-size:13px;color:var(--muted)">Loading admin…</div></div>',
  '<div id="loading"><div class="spinner"></div><div style="font-size:13px;color:var(--muted)">Loading HK…</div></div>'
);

html = html.replace(
  /if\(_usingPipelineEmulator\)\{mountEmulatorBanner\(\);console\.info\('\[sandbox\] pipeline functions → emulator 127\.0\.0\.1:5001'\);\}\nelse if\(!document\.getElementById\('admin-sandbox-banner'\)\)\{\n  const el=document\.createElement\('div'\);\n  el\.id='admin-sandbox-banner';\n  el\.innerHTML='Admin sandbox · <a href="sandbox-index\.html" style="color:#fff;text-decoration:underline">Testing hub<\/a> · not live';\n  el\.style\.cssText='position:fixed;top:0;left:0;right:0;z-index:99998;padding:5px 12px;background:#7a5a0a;color:#fff;font:600 11px\/1\.4 system-ui,sans-serif;text-align:center;';\n  document\.body\.prepend\(el\);\n\}/,
  "if(_usingPipelineEmulator){mountEmulatorBanner();console.info('[HK] pipeline functions → emulator 127.0.0.1:5001');}"
);

html = html.replace(/actor:'admin-sandbox'/g, "actor:'hk'");

html = html.replace(
  '/* ADMIN SANDBOX — see GUEST_CHECKIN_REDESIGN.md §22.9',
  '/* HK standalone — promoted from checkin-admin-sandbox.html — see GUEST_CHECKIN_REDESIGN.md §22'
);

const legacyPath = path.join(root, 'HK-legacy.html');
const currentHk = path.join(root, 'HK.html');
if (fs.existsSync(currentHk) && !fs.existsSync(legacyPath)) {
  const prev = fs.readFileSync(currentHk, 'utf8');
  if (prev.length > 500) {
    fs.writeFileSync(legacyPath, prev);
    console.log('Archived previous HK.html → HK-legacy.html');
  }
}

const out = path.join(root, 'HK.html');
fs.writeFileSync(out, html);
console.log('Wrote', out, '(' + html.length + ' bytes)');
