// No Gemini any more: the guest still sees "Document received", nothing is sent to any scan function or Google AI,
// and the admin's Approve / Reject (and the red banner for the guest after Reject) still work.
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const assert = require('assert');
const h = require('./e2e.cjs');
let passed = 0; const ok = n => { passed++; console.log('PASS ' + n); };
const FAST = `(() => { const si = window.setInterval; window.setInterval = (f, ms, ...a) => si(f, ms === 60000 ? 1000 : ms, ...a); })();`;
const dbDocs = env => env.page.evaluate(() => JSON.parse(JSON.stringify(window.__DB.docs)));

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
  let guestId;
  for (const apiOn of [true, false]) {
    const env = await h.open(browser, { apiOn, startIso: '2026-10-12T06:00:00Z' });
    await env.page.addInitScript(FAST);
    await h.register(env, { apiOn });
    const docs = await dbDocs(env);
    const g = Object.entries(docs).filter(([k]) => k.startsWith('checkin_guests/'));
    assert.equal(g.length >= 1, true, 'guest record saved');
    assert.ok(g.every(([, v]) => !v.passportScanResult || Object.keys(v.passportScanResult).length === 0), 'no scan result is ever stored');
    assert.equal(Object.keys(docs).filter(k => k.startsWith('passport_alerts/')).length, 0, 'no passport alerts');
    assert.equal(env.calls.filter(c => c.name === 'guestScan').length, 0, 'no scan function call');
    assert.deepEqual(env.blocked.filter(u => /generativelanguage|googleapis\.com\/v1beta/.test(u)), [], 'no call to Google AI');
    assert.ok(g.every(([, v]) => v.passportUrl), 'passport uploaded to storage and linked');
    if (apiOn) { const reg = env.calls.find(c => c.name === 'guestRegister'); assert.ok(reg && reg.out.ok, 'registered through the function'); guestId = g.find(([, v]) => v.isPrimaryGuest)[0].split('/')[1]; }
    assert.deepEqual(env.logs.filter(l => l.startsWith('PAGEERROR')), []);
    ok((apiOn ? 'new path' : 'old path') + ': upload and registration work, no scan, no Google AI call, no stored scan result');
    if (apiOn) {
      // the admin presses Reject: the guest gets the red banner; uploading a new photo clears it
      await env.page.evaluate(g => window.__DBAPI.set('checkin_guests/' + g, { passportScanResult: { overrideByAdmin: false, valid: false } }, true), guestId);
      await env.page.waitForSelector('#passport-warning-banner', { timeout: 20000 });
      const bannerText = await env.page.evaluate(() => document.getElementById('passport-warning-banner').innerText);
      assert.ok(/wasn't verified/.test(bannerText));
      ok('after Reject the guest sees the red banner');
      await env.page.setInputFiles('#reupload-passport', { name: 'p2.jpg', mimeType: 'image/jpeg', buffer: h.TINY_JPG });
      await env.page.waitForFunction(() => !document.getElementById('passport-warning-banner'), null, { timeout: 15000 });
      const after = (await dbDocs(env))['checkin_guests/' + guestId];
      assert.deepEqual(after.passportScanResult, {}, 'Reject cleared by the new upload');
      assert.equal(env.calls.filter(c => c.name === 'guestScan').length, 0);
      assert.deepEqual(env.blocked.filter(u => /generativelanguage/.test(u)), []);
      const txt = await env.page.evaluate(() => document.body.innerText);
      assert.ok(!/Verifying your document/.test(txt));
      ok('uploading a new photo clears the banner, still no scan');
    }
    await env.ctx.close();
  }
  // admin page: Approve / Reject still write the flags the guest page reads
  {
    const GID = 'b'.repeat(32);
    const env = await h.open(browser, { apiOn: true, startIso: '2026-10-12T06:00:00Z', viewport: { width: 1200, height: 900 } });
    await env.page.addInitScript(g => {
      localStorage.setItem('maxela_admin_authed', 'yes_' + Date.now());
      window.__DB.docs['checkin_guests/' + g] = { name: 'Ahmed Ali', aptId: '6-1', passportUrl: 'https://storage.test/p.jpg', passportScanResult: {}, isPrimaryGuest: true, arrivalDate: '2026-10-12', checkoutDate: '2026-10-15', matchedReservationId: '007004961_001' };
    }, GID);
    env.page.on('dialog', d => d.accept());
    await env.page.goto('http://test.local/checkin-admin.html');
    await env.page.waitForFunction(() => typeof window.openDetail === 'function' && typeof window.rejectPassport === 'function', null, { timeout: 20000 });
    await env.page.waitForTimeout(1500);
    await env.page.evaluate(g => window.openDetail(g), GID);
    await env.page.waitForTimeout(1000);
    const btn = await env.page.evaluate(() => ({ approve: !!document.querySelector('[onclick*="approvePassport"]'), reject: !!document.querySelector('[onclick*="rejectPassport"]') }));
    assert.ok(btn.approve && btn.reject, 'Approve and Reject buttons are shown in the guest detail');
    await env.page.evaluate(g => window.rejectPassport(g), GID);
    let sr = (await dbDocs(env))['checkin_guests/' + GID].passportScanResult;
    assert.equal(sr.overrideByAdmin, false); assert.equal(sr.valid, false);
    await env.page.evaluate(g => window.approvePassport(g), GID);
    sr = (await dbDocs(env))['checkin_guests/' + GID].passportScanResult;
    assert.equal(sr.overrideByAdmin, true); assert.equal(sr.valid, true);
    assert.deepEqual(env.logs.filter(l => l.startsWith('PAGEERROR')), []);
    ok('admin: Approve and Reject buttons are there and both save correctly');
    await env.ctx.close();
  }
  console.log('\nALL ' + passed + ' NO-GEMINI CHECKS PASSED');
  await browser.close();
})().catch(e => { console.error('FAIL', e); process.exit(1); });
