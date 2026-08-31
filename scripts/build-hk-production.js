#!/usr/bin/env node
'use strict';
/**
 * Promote checkin-admin-sandbox.html → hk-app.html (full HK board).
 * HK.html is a tiny loader (no cache-buster loops) that opens hk-app.html.
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = path.join(root, 'checkin-admin-sandbox.html');
let html = fs.readFileSync(src, 'utf8');

html = html.replace(
  '<title>Maxela Admin — Sandbox (HK)</title>',
  '<title>Sleepy HK</title>'
);

html = html.replace(
  /<script>window\.__STANDALONE_HK__=[\s\S]*?<\/script>\n/,
  '<script>window.__STANDALONE_HK__=true;document.documentElement.classList.add(\'standalone-hk\');document.addEventListener(\'dblclick\',function(e){e.preventDefault();},{passive:false,capture:true});try{var role=localStorage.getItem(\'hk_role\')||localStorage.getItem(\'hk_shartava_role\');if(role){document.documentElement.classList.add(\'hk-authed\');if(role===\'admin\')document.documentElement.classList.add(\'hk-admin-role\');}}catch(e){}</script>\n'
);

// Remove cache-buster redirect entirely — caused URI Too Long loops on cleaner phones.
html = html.replace(
  /<script>\n\(function\(\)\{\n  var BUILD=[\s\S]*?\}\)\(\);\n<\/script>\n/,
  ''
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

const appOut = path.join(root, 'hk-app.html');
fs.writeFileSync(appOut, html);
console.log('Wrote', appOut, '(' + html.length + ' bytes)');

const loader = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate">
<meta http-equiv="Pragma" content="no-cache">
<meta http-equiv="Expires" content="0">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>Sleepy HK</title>
<script>
(function(){
  var app='hk-app.html';
  if(location.search){location.replace(app);return;}
  location.replace(app);
})();
</script>
</head>
<body style="font-family:system-ui,sans-serif;background:#FAFAF9;color:#6B6B68;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
  Loading HK…
</body>
</html>
`;

const loaderOut = path.join(root, 'HK.html');
fs.writeFileSync(loaderOut, loader);
console.log('Wrote', loaderOut, '(' + loader.length + ' bytes)');
