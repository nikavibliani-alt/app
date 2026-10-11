const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const assert = require('assert');
const h = require('./e2e.cjs');
let passed = 0;
const ok = (name) => { passed++; console.log('PASS ' + name); };
const leaky = (calls) => { const j = JSON.stringify(calls.map(c => c.out)); return h.SECRET_STRINGS.filter(s => j.includes(s)); };
const noPageErrors = (env) => assert.deepEqual(env.logs.filter(l => l.startsWith('PAGEERROR')), [], 'page errors');
const FAST = `(() => { const si = window.setInterval; window.setInterval = (f, ms, ...a) => si(f, ms === 60000 ? 1000 : ms, ...a); })();`;
const home = (page) => page.evaluate(() => ({ door: document.getElementById('hero-door-code')?.textContent, wifi: document.getElementById('hero-wifi-pass')?.textContent, elev: document.getElementById('hero-elevator')?.innerText || '', text: document.getElementById('page-home').innerText }));

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
  const T10 = '2026-10-12T06:00:00Z', T1505 = '2026-10-12T11:05:00Z';

  // ---------- A. full guest flow with the guest functions, codes only after check-in ----------
  let texts = {};
  for (const apiOn of [true, false]) {
    const env = await h.open(browser, { apiOn, startIso: T10 });
    await env.page.addInitScript(FAST);
    await h.register(env, { apiOn });
    const before = await home(env.page);
    if (!apiOn) console.log('   (old page) code already inside the hidden part of the page before check-in: door=' + before.door + ' wifi=' + before.wifi);
    if (apiOn) {
      assert.equal(before.door.includes('—'), true, 'door code hidden before check-in');
      assert.equal(before.wifi.trim(), '—');
      assert.deepEqual(leaky(env.calls), [], 'secrets in a function answer before check-in');
      const html = await env.page.evaluate(() => document.documentElement.innerHTML + JSON.stringify(Object.assign({}, localStorage)));
      for (const s of h.SECRET_STRINGS) assert.ok(!html.includes(s), 'secret in the page or storage before check-in: ' + s);
      assert.deepEqual(env.blocked.filter(u => /generativelanguage|firebasedatabase/.test(u)), [], 'no direct Gemini / RTDB calls');
      ok('v2: registration works, nothing secret reaches the browser before check-in');
    }
    await env.page.screenshot({ path: (process.env.SHOT_DIR || require('os').tmpdir()) + `/A_${apiOn ? 'v2' : 'v1'}_before.png` });
    texts[apiOn ? 'v2before' : 'v1before'] = h.norm(before.text);
    await env.setClock(T1505);
    await env.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await env.page.waitForFunction(() => /482913/.test(document.getElementById('hero-door-code')?.textContent || ''), null, { timeout: 15000 });
    const after = await home(env.page);
    assert.match(after.wifi, /secretwifi/);
    assert.match(after.elev, /2468/);
    texts[apiOn ? 'v2after' : 'v1after'] = h.norm(after.text);
    await env.page.screenshot({ path: (process.env.SHOT_DIR || require('os').tmpdir()) + `/A_${apiOn ? 'v2' : 'v1'}_after.png` });
    noPageErrors(env);
    ok((apiOn ? 'v2' : 'v1') + ': after check-in time the door code, Wi-Fi and elevator code appear');
    await env.ctx.close();
  }
  assert.equal(texts.v2before, texts.v1before, 'same screen before check-in');
  assert.equal(texts.v2after, texts.v1after, 'same screen after check-in');
  ok('v1 and v2 show exactly the same text on the home screen (before and after check-in)');

  // ---------- B. wrong booking, someone else, rate limit ----------
  {
    const env = await h.open(browser, { apiOn: true, startIso: T10 });
    await env.page.goto('http://test.local/checkin-guest.html?api=1');
    await env.page.waitForSelector('#search-btn', { state: 'visible' });
    await h.fillSearch(env.page, { name: 'Zed Nobody', arrival: '2026-10-12' });
    await env.page.click('#search-btn');
    await env.page.waitForSelector('#reg-verify-error', { state: 'visible', timeout: 10000 });
    assert.equal(await h.visible(env.page, 'page-rules'), false);
    assert.equal(env.state.failures.length, 1);
    await h.fillSearch(env.page, { name: 'Ahmed Ali', arrival: '2026-10-20' });
    await env.page.click('#search-btn');
    await env.page.waitForTimeout(800);
    assert.equal(await h.visible(env.page, 'page-rules'), false);
    const finds = env.calls.filter(c => c.name === 'guestFind');
    assert.ok(finds.every(c => c.out.found === false));
    assert.deepEqual(leaky(env.calls), []);
    ok('wrong name or wrong date: refused, logged, nothing about any booking is sent');
    // a hostile page asking for other people's data
    const ask = (name, data) => env.page.evaluate(([n, d]) => window.__callFn(n, d), [name, data]);
    await ask('guestFind', { mode: 'find', name: 'Ahmed Ali', arrival: '2026-10-12' });   // creates nothing; just a valid search
    const tokenB = 'b'.repeat(32);
    await env.page.evaluate(([t]) => window.__DBAPI.set('checkin_guests/' + t, { isPrimaryGuest: true, passportUrl: 'u', matchedReservationId: '007005000_001', aptId: 'tab-1', arrivalDate: '2026-10-12', checkoutDate: '2026-10-14' }), [tokenB]);
    const tokenA = 'a'.repeat(32);
    await env.page.evaluate(([t]) => window.__DBAPI.set('checkin_guests/' + t, { isPrimaryGuest: true, passportUrl: 'u', matchedReservationId: '007004961_001', aptId: '6-1', arrivalDate: '2026-10-12', checkoutDate: '2026-10-15' }), [tokenA]);
    const sib = await ask('guestFind', { mode: 'siblings', guestToken: tokenA, reservationRef: '007005000_001' });
    assert.equal(sib.errorCode, 'FORBIDDEN');
    const stay = await ask('guestStay', { guestToken: tokenA, aptId: 'tab-1' });
    assert.equal(stay.aptId, '6-1');
    assert.ok(!JSON.stringify(stay).includes('5555') && !JSON.stringify(stay).includes('135790'));
    assert.equal((await ask('guestStay', { guestToken: 'f'.repeat(32) })).errorCode, 'NOT_FOUND');
    const anon = await ask('guestStay', { aptId: '6-1' });
    assert.ok(!JSON.stringify(anon).includes('4321') && !JSON.stringify(anon).includes('secretwifi'));
    const existingNoProof = await ask('guestFind', { mode: 'existing', reservationId: '007005000_001', reservationNumber: '007005000_001' });
    assert.equal(existingNoProof.errorCode, 'FORBIDDEN');
    ok('someone else\'s booking, a fake guest token, a missing proof and an anonymous apartment request are all refused or stripped');
    let last;
    for (let i = 0; i < 22; i++) last = await ask('guestFind', { mode: 'find', name: 'Zed Nobody', arrival: '2026-10-12' });
    assert.equal(last.errorCode, 'RATE_LIMITED');
    await h.fillSearch(env.page, { name: 'Zed Nobody', arrival: '2026-10-12' });
    await env.page.click('#search-btn');
    await env.page.waitForFunction(() => /Too many/.test(document.getElementById('toast')?.textContent || ''), null, { timeout: 8000 });
    ok('repeated searches are rate limited and the guest sees a clear message');
    noPageErrors(env);
    await env.ctx.close();
  }

  // ---------- C. passport size ----------
  {
    const env = await h.open(browser, { apiOn: true, startIso: T10 });
    await env.page.goto('http://test.local/checkin-guest.html?api=1');
    await env.page.waitForSelector('#search-btn', { state: 'visible' });
    // a 12 MB file the browser cannot read as a picture: cannot be shrunk, so a friendly message
    await env.page.setInputFiles('#passport-input', { name: 'huge.jpg', mimeType: 'image/jpeg', buffer: Buffer.alloc(12 * 1024 * 1024, 7) });
    await env.page.waitForFunction(() => /too large/.test(document.getElementById('toast')?.textContent || ''), null, { timeout: 15000 });
    assert.equal(await env.page.evaluate(() => document.getElementById('passport-continue-btn').disabled), true);
    ok('a 12 MB file that cannot be shrunk is refused with a clear message');
    // a real, big photo: shrunk to under 10 MB and accepted
    const big = await env.page.evaluate(async () => {
      const c = document.createElement('canvas'); c.width = 4500; c.height = 4500;
      const x = c.getContext('2d'); const d = x.createImageData(4500, 4500);
      for (let i = 0; i < d.data.length; i += 4) { d.data[i] = Math.random() * 255; d.data[i + 1] = Math.random() * 255; d.data[i + 2] = Math.random() * 255; d.data[i + 3] = 255; }
      x.putImageData(d, 0, 0);
      const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 1));
      const f = new File([blob], 'big.jpg', { type: 'image/jpeg' });
      const dt = new DataTransfer(); dt.items.add(f);
      const inp = document.getElementById('passport-input'); inp.files = dt.files; inp.dispatchEvent(new Event('change', { bubbles: true }));
      return f.size;
    });
    console.log('   big photo size', (big / 1048576).toFixed(1), 'MB');
    assert.ok(big > 10 * 1048576, 'test photo must be over 10 MB');
    await env.page.waitForFunction(() => !document.getElementById('passport-continue-btn').disabled, null, { timeout: 30000 });
    ok('a real photo over 10 MB is shrunk and accepted');
    noPageErrors(env);
    await env.ctx.close();
  }

  // ---------- D. coming back later, and the room being moved ----------
  {
    const env = await h.open(browser, { apiOn: true, startIso: T1505 });
    await env.page.addInitScript(FAST);
    await h.register(env, { apiOn: true });
    await env.page.waitForFunction(() => /482913/.test(document.getElementById('hero-door-code')?.textContent || ''), null, { timeout: 15000 });
    const first = await home(env.page);
    // the owner moves the booking to another room
    await env.page.evaluate(() => {
      window.__DBAPI.set('checkin_apartments/6-2', { propertyName: 'Maxela 6-2', address: '1 Test St', checkInTime: '15:00', doorCode: '9999#', wifiName: 'W2', wifiPass: 'wifi2pass' }, false);
      window.__DBAPI.set('reservations/007004961_001', { roomCode: '6-2', tuyaPassword: '777111' }, true);
    });
    await env.page.waitForFunction(() => /wifi2pass/.test(document.getElementById('hero-wifi-pass')?.textContent || '') || /6-2/.test(document.body.innerText), null, { timeout: 20000 });
    const moved = await env.page.evaluate(() => ({ text: document.body.innerText, guest: Object.entries(window.__DB.docs).filter(([k]) => k.startsWith('checkin_guests/')).map(([k, v]) => v.aptId) }));
    assert.ok(/Maxela 6-2/.test(moved.text), 'new room shown');
    assert.ok(moved.guest.includes('6-2'), 'guest record follows the move');
    ok('a room move is noticed within a minute and the new room is shown');
    // reload: the guest comes back with the saved link
    const token = await env.page.evaluate(() => Object.keys(window.__DB.docs).find(k => k.startsWith('checkin_guests/') && window.__DB.docs[k].isPrimaryGuest).split('/')[1]);
    const snapshot = await env.page.evaluate(() => JSON.stringify(window.__DB.docs));
    await env.page.evaluate(s => { window.__keep = s; }, snapshot);
    await env.page.addInitScript(s => { window.__DB.docs = JSON.parse(s); }, snapshot);
    await env.page.goto('http://test.local/checkin-guest.html?api=1&g=' + token);
    await env.page.waitForFunction(() => document.getElementById('page-home')?.classList.contains('active'), null, { timeout: 20000 });
    await env.page.waitForTimeout(1500);
    const again = await home(env.page);
    assert.match(again.text, /Maxela 6-2/);
    assert.match(again.door, /777111|9999/);
    ok('coming back with the guest link later still works (new room, door code)');
    noPageErrors(env);
    await env.ctx.close();
  }
  console.log('\nALL ' + passed + ' CHECKS PASSED');
  await browser.close();
})().catch(e => { console.error('FAIL', e && (e.stack || e.message)); process.exit(1); });
