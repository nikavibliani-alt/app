// Admin: back-to-back stays on the Stay page (chips, Link / Not the same guest, moving guest) and in Guest Details
// (whole stay, Unlink). Phone width.
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const assert = require('assert');
const h = require('./e2e.cjs');
const SHOT = process.env.SHOT_DIR || '';
let passed = 0; const ok = n => { passed++; console.log('PASS ' + n); };

const res = (id, room, from, to, extra) => ({ ['reservations/' + id]: { reservationNumber: id, roomCode: room, checkin: '2026-10-' + from, checkout: '2026-10-' + to, status: 'OK2', guest: 'Ann Lee', phone: '+995 555 111 222', source: 'booking', ...extra } });
const form = (token, matched, room, from, to, name) => ({ ['checkin_guests/' + token.repeat(32)]: { name, nameRoman: name, aptId: room, matchedReservationId: matched, arrivalDate: '2026-10-' + from, checkoutDate: '2026-10-' + to, contact: '+995555111222', contactType: 'wa', passportSkipped: true, isPrimaryGuest: true } });
const DOCS = Object.assign({},
  res('A1', '6-1', '10', '13'), res('A2', '6-1', '13', '16'), form('a', 'A1', '6-1', '10', '13', 'Ann Lee'),            // strong extension
  res('W1', '7-1', '10', '13', { guest: 'Bo Park' }), res('W2', '7-1', '13', '15', { guest: 'Bo Park', phone: '' }), form('b', 'W1', '7-1', '10', '13', 'Bo Park'),   // phone missing
  res('M1', 'tab-1', '11', '13', { guest: 'Cy Moss' }), res('M2', 'orb-1', '13', '15', { guest: 'Cy Moss' }),          // moves to another unit
  res('G1', '6-2', '10', '12', { guest: 'Di Gap' }), res('G2', '6-2', '13', '15', { guest: 'Di Gap' }));              // 1-day gap

const card = (page, room) => page.evaluate(room => [...document.querySelectorAll('#stay-list .card--stay')].filter(c => c.querySelector('.card__room').textContent === room).map(c => c.innerText.replace(/\s+/g, ' ')), room);
const doc = (page, path) => page.evaluate(p => window.__DB.docs[p] || null, path);

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
  const env = await h.open(browser, { apiOn: false, startIso: '2026-10-13T06:00:00Z', viewport: { width: 390, height: 844 } });
  await env.page.addInitScript(() => { localStorage.setItem('maxela_admin_authed', 'yes_' + Date.now()); });
  await env.page.addInitScript(d => {
    for (const k of Object.keys(window.__DB.docs)) if (k.startsWith('reservations/')) delete window.__DB.docs[k];
    Object.assign(window.__DB.docs, d);
  }, DOCS);
  await env.page.goto('http://test.local/checkin-admin.html?tab=stay');
  await env.page.waitForFunction(() => document.querySelectorAll('#stay-list .card--stay').length >= 6, null, { timeout: 25000 });
  await env.page.waitForTimeout(1200);

  let c = await card(env.page, '6-1');
  assert.ok(c.some(t => /Extension of 10 Oct – 13 Oct/.test(t)), 'chip on the continuing booking: ' + c.join(' | '));
  const next = c.find(t => /Extension of/.test(t));
  assert.ok(!/Not registered/.test(next), 'the continuing booking is not shown as unregistered: ' + next);
  ok('a booking that continues a stay shows "Extension of 10 Oct – 13 Oct" and the guest of the stay');

  c = await card(env.page, '7-1');
  assert.ok(c.some(t => /Confirm extension\?.*Link.*Not the same guest/.test(t)), c.join(' | '));
  const banner = await env.page.evaluate(() => document.getElementById('stay-ext')?.innerText.replace(/\s+/g, ' ') || '');
  assert.match(banner, /Extensions to confirm \(1\).*Bo Park.*7-1/);
  ok('a missing phone shows "Confirm extension?" with Link / Not the same guest, also in a list at the top');

  assert.ok((await card(env.page, 'orb-1')).some(t => /Same guest in tab-1 - check/.test(t)));
  assert.ok((await card(env.page, 'tab-1')).some(t => /Same guest in orb-1 - check/.test(t)));
  ok('a moving guest shows "Same guest in <other unit> - check" on both cards');

  assert.ok((await card(env.page, '6-2')).every(t => !/Extension|Confirm extension|Same guest/.test(t)));
  ok('a 1-day gap shows nothing');

  const colors = await env.page.evaluate(() => [...document.querySelectorAll('.stay-btns button')].map(b => getComputedStyle(b).color));
  assert.ok(colors.length >= 2);
  assert.ok(colors.every(x => x === 'rgb(255, 255, 255)' || x === 'rgb(44, 44, 42)'), 'button text colours: ' + colors);
  const wide = await env.page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  assert.strictEqual(wide, false, 'nothing sticks out at 390px');
  if (SHOT) { await env.page.evaluate(() => document.getElementById('stay-ext').scrollIntoView()); await env.page.screenshot({ path: SHOT + '/admin-stay.png' }); }
  ok('buttons set their own text colour; the page fits 390px');

  env.page.on('dialog', d => d.accept());
  await env.page.locator('#stay-ext button', { hasText: 'Link' }).first().click();
  await env.page.waitForTimeout(900);
  const confirmed = await doc(env.page, 'stay_links/W1__W2');
  assert.deepStrictEqual([confirmed.status, confirmed.kind, confirmed.prevId, confirmed.nextId, confirmed.unit, confirmed.nextCheckin], ['confirmed', 'extension', 'W1', 'W2', '7-1', '2026-10-13']);
  assert.ok((await card(env.page, '7-1')).some(t => /Extension of 10 Oct – 13 Oct/.test(t)));
  assert.strictEqual(await env.page.evaluate(() => document.getElementById('stay-ext').innerText.trim()), '');
  ok('Link saves the confirmation; the card becomes "Extension of …" and leaves the list');

  await env.page.evaluate(t => window.openDetail(t), 'a'.repeat(32));
  await env.page.waitForTimeout(700);
  let detail = await env.page.evaluate(() => document.getElementById('detail-body').innerText.replace(/\s+/g, ' '));
  assert.match(detail, /Whole stay: 10 Oct – 16 Oct/);
  assert.match(detail, /10 Oct – 13 Oct.*Linked automatically.*Unlink.*13 Oct – 16 Oct/);
  if (SHOT) { await env.page.evaluate(() => document.getElementById('stay-detail').scrollIntoView()); await env.page.screenshot({ path: SHOT + '/admin-stay-detail.png' }); }
  ok('Guest Details shows the whole stay chain');

  await env.page.locator('#stay-detail button', { hasText: 'Unlink' }).click();
  await env.page.waitForTimeout(900);
  assert.strictEqual((await doc(env.page, 'stay_links/A1__A2')).status, 'rejected');
  detail = await env.page.evaluate(() => document.getElementById('detail-body').innerText.replace(/\s+/g, ' '));
  assert.match(detail, /Not linked/);
  await env.page.evaluate(() => window.closeDetail());
  assert.ok((await card(env.page, '6-1')).every(t => !/Extension of/.test(t)));
  ok('Unlink saves "not the same guest" and removes the chip');

  await env.page.evaluate(t => window.openDetail(t), 'a'.repeat(32));
  await env.page.waitForTimeout(500);
  await env.page.locator('#stay-detail button', { hasText: 'Link again' }).click();
  await env.page.waitForTimeout(900);
  assert.strictEqual((await doc(env.page, 'stay_links/A1__A2')).status, 'confirmed');
  await env.page.evaluate(() => window.closeDetail());
  ok('an unlinked stay can be linked again');

  await env.page.evaluate(() => window.__DBAPI.set('reservations/A2', { status: 'CANCELLED' }, true));
  await env.page.waitForTimeout(1200);
  assert.ok((await card(env.page, '6-1')).every(t => !/Extension of/.test(t)));
  ok('a cancelled extension disappears');

  // an unconfirmed link whose second booking already ended, but the stay goes on after it: it must still be listed
  await env.page.evaluate(d => Object.entries(d).forEach(([k, v]) => window.__DBAPI.set(k, v)), Object.assign({},
    res('P1', '7-4', '05', '07', { guest: 'Eve Long' }), res('P2', '7-4', '07', '10', { guest: 'Eve Long', phone: '' }), res('P3', '7-4', '10', '20', { guest: 'Eve Long', phone: '' }),
    res('Q1', '7-2', '05', '07', { guest: 'Old Pair' }), res('Q2', '7-2', '07', '10', { guest: 'Old Pair', phone: '' })));
  await env.page.waitForTimeout(1500);
  const list = await env.page.evaluate(() => [...document.querySelectorAll('#stay-ext .stay-banner__row')].map(r => r.innerText.replace(/\s+/g, ' ')));
  assert.ok(list.some(t => /Eve Long.*7-4.*5 Oct – 7 Oct, then 7 Oct – 10 Oct/.test(t)), 'the older link of a running stay: ' + list.join(' | '));
  assert.ok(list.some(t => /Eve Long.*7 Oct – 10 Oct, then 10 Oct – 20 Oct/.test(t)));
  assert.ok(!list.some(t => /Old Pair/.test(t)), 'a stay that is over is not asked about');
  ok('every unconfirmed link of a stay that is still running is listed, also the older ones');

  const errors = env.logs.filter(l => l.startsWith('PAGEERROR'));
  assert.deepStrictEqual(errors, []);
  console.log(`\nALL ${passed} ADMIN BACK-TO-BACK STAY CHECKS PASSED`);
  await browser.close();
})().catch(e => { console.error('FAIL', e.message.split('\n').slice(0, 4).join(' | ')); process.exit(1); });
