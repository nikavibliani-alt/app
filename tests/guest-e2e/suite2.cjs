const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const assert = require('assert');
const h = require('./e2e.cjs');
let passed = 0; const ok = n => { passed++; console.log('PASS ' + n); };
const FAST = `(() => { const si = window.setInterval; window.setInterval = (f, ms, ...a) => si(f, ms === 60000 ? 1000 : ms, ...a); })();`;
const SECOND = [['reservations/007004961_002', { reservationNumber: '007004961_002', roomCode: '6-2', checkin: '2026-10-12', checkout: '2026-10-15', status: 'OK', guest: 'Ahmed Ali', phone: '+995 555 111 222', source: 'booking', tuyaPassword: '777111' }],
  ['checkin_apartments/6-2', { propertyName: 'Maxela 6-2', address: '1 Test St', checkInTime: '15:00', doorCode: '9999#', wifiName: 'W2', wifiPass: 'wifi2pass', tuyaDeviceId: 'DEV2' }]];
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
  // F. a booking with two rooms: the guest can switch rooms; each room's codes only after check-in
  {
    const env = await h.open(browser, { apiOn: true, startIso: '2026-10-12T06:00:00Z' });
    await env.page.addInitScript(FAST);
    await env.page.addInitScript(rows => { for (const [k, v] of rows) window.__DB.docs[k] = v; }, SECOND);
    await h.register(env, { apiOn: true });
    const guestFind = env.calls.find(c => c.name === 'guestFind' && c.out.found);
    assert.equal(guestFind.out.group.length, 2);
    await env.page.evaluate(() => window.switchApt('6-2'));
    await env.page.waitForTimeout(1500);
    const bodyText = await env.page.evaluate(() => document.getElementById('page-home').innerText);
    assert.ok(/Maxela 6-2/.test(bodyText), 'second room shown');
    const all = JSON.stringify(env.calls.map(c => c.out));
    for (const s of ['9999', 'wifi2pass', '777111', 'DEV2', '482913']) assert.ok(!all.includes(s), 'leak before check-in: ' + s);
    ok('two-room booking: switching rooms works and the second room\'s codes also stay hidden before check-in');
    await env.setClock('2026-10-12T11:05:00Z');
    await env.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await env.page.waitForFunction(() => /777111/.test(document.getElementById('hero-door-code')?.textContent || ''), null, { timeout: 15000 });
    ok('two-room booking: after check-in time the second room\'s own door code appears');
    assert.deepEqual(env.logs.filter(l => l.startsWith('PAGEERROR')), []);
    await env.ctx.close();
  }
  // E. companion join link
  {
    const env = await h.open(browser, { apiOn: true, startIso: '2026-10-12T06:00:00Z' });
    await env.page.addInitScript(() => { window.__DB.docs['checkin_guests/' + 'a'.repeat(32)] = { isPrimaryGuest: true, passportUrl: 'u', matchedReservationId: '007004961_001', aptId: '6-1', arrivalDate: '2026-10-12', checkoutDate: '2026-10-15', companionToken: 'join-token-aaaaaaaaaaaa' }; });
    await env.page.goto('http://test.local/checkin-guest.html?api=1&join=join-token-aaaaaaaaaaaa');
    await env.page.waitForFunction(() => /join|Join/i.test(document.getElementById('t-search-btn')?.textContent || ''), null, { timeout: 15000 });
    const hidden = await env.page.evaluate(() => getComputedStyle(document.getElementById('r-arrival').closest('.auth-row')).display);
    assert.equal(hidden, 'none');
    const j = env.calls.find(c => c.name === 'guestFind');
    assert.equal(j.out.found, true);
    assert.ok(!JSON.stringify(j.out).includes('555 111') && !JSON.stringify(j.out).includes('482913'));
    ok('a family member\'s join link works (no date asked, nothing private sent)');
    const bad = await h.open(browser, { apiOn: true, startIso: '2026-10-12T06:00:00Z' });
    await bad.page.goto('http://test.local/checkin-guest.html?api=1&join=' + 'x'.repeat(30));
    await bad.page.waitForSelector('#search-btn', { state: 'visible' });
    await bad.page.waitForTimeout(800);
    assert.equal(await bad.page.evaluate(() => document.getElementById('t-search-btn').textContent.trim()), 'Find my booking');
    ok('an unknown join link falls back to the normal search page');
    await env.ctx.close(); await bad.ctx.close();
  }
  console.log('\nALL ' + passed + ' MORE CHECKS PASSED');
  await browser.close();
})().catch(e => { console.error('FAIL', e && (e.stack || e.message)); process.exit(1); });
