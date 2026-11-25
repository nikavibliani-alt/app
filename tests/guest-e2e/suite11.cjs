// The whole loop on one set of data: trigger (fake push) -> guest page -> the owner's tap in admin -> guest page -> cancel.
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const assert = require('assert');
const h = require('./e2e.cjs');
const { runStayLinks } = require('../../pipeline-functions/controllers/stayLinks.js');
let passed = 0; const ok = n => { passed++; console.log('PASS ' + n); };
const FAST = `(() => { const si = window.setInterval; window.setInterval = (f, ms, ...a) => si(f, ms === 60000 || ms === 30000 ? 700 : ms, ...a); })();`;
const tok = 'a'.repeat(32);
const A = { reservationNumber: 'A1', roomCode: '6-1', checkin: '2026-10-10', checkout: '2026-10-13', status: 'OK2', guest: 'Ann Lee', phone: '+995 555 111 222' };
const B = { ...A, reservationNumber: 'B1', checkin: '2026-10-13', checkout: '2026-10-16', phone: '' };   // booked later, no phone

const db = { 'reservations/A1': A,
  'checkin_apartments/6-1': { propertyName: 'Unit 6-1', checkInTime: '15:00', checkOutTime: '12:00', doorCode: '7777#', wifiName: 'N', wifiPass: 'pw-61' },
  ['checkin_guests/' + tok]: { name: 'Ann Lee', nameRoman: 'Ann Lee', aptId: '6-1', matchedReservationId: 'A1', arrivalDate: '2026-10-10', checkoutDate: '2026-10-13', contact: '+995555111222', contactType: 'wa', passportSkipped: true, isPrimaryGuest: true, guestConfirmedCheckin: true } };
const pushes = [];
const rows = () => Object.entries(db).filter(([k]) => k.startsWith('reservations/')).map(([k, v]) => ({ id: k.split('/')[1], ...v }));
const ctx = {
  today: () => '2026-10-12', now: () => '2026-10-12T10:00:00.000Z',
  listByCheckin: async d => rows().filter(r => r.checkin === d), listByCheckout: async d => rows().filter(r => r.checkout === d),
  listLinks: async id => Object.entries(db).filter(([k, v]) => k.startsWith('stay_links/') && (v.prevId === id || v.nextId === id)).map(([k, v]) => ({ key: k.split('/')[1], ...v })),
  upsertLink: async (key, make) => { const out = make(db['stay_links/' + key] || null); if (out.data) db['stay_links/' + key] = { ...(db['stay_links/' + key] || {}), ...out.data }; return out; },
  deleteLink: async key => { delete db['stay_links/' + key]; }, sendPush: async p => pushes.push(p), logRun: async () => {},
};
async function writeReservation(id, data) {
  const before = db['reservations/' + id] || null;
  db['reservations/' + id] = { ...(before || {}), ...data };
  await runStayLinks(ctx, id, before, db['reservations/' + id]);
}

async function openWith(browser, when, url, admin) {
  const env = await h.open(browser, { apiOn: false, startIso: when, viewport: { width: 390, height: 844 } });
  await env.page.addInitScript(FAST);
  await env.page.addInitScript(([d, admin]) => {
    if (admin) localStorage.setItem('maxela_admin_authed', 'yes_' + Date.now());
    for (const k of Object.keys(window.__DB.docs)) if (k.startsWith('reservations/') || k.startsWith('checkin_apartments/')) delete window.__DB.docs[k];
    Object.assign(window.__DB.docs, d);
  }, [db, !!admin]);
  await env.page.goto('http://test.local/' + url);
  return env;
}
/** copy what the page wrote back into the shared data */
async function pull(env, prefix) {
  const docs = await env.page.evaluate(p => Object.fromEntries(Object.entries(window.__DB.docs).filter(([k]) => k.startsWith(p))), prefix);
  Object.assign(db, docs);
}
const guestPage = async (browser, when) => {
  const env = await openWith(browser, when, 'checkin-guest.html?api=0&g=' + tok);
  await env.page.waitForFunction(() => document.getElementById('page-home')?.classList.contains('active'), null, { timeout: 20000 });
  await env.page.waitForTimeout(1800);
  env.phase = () => env.page.evaluate(() => ['waiting', 'arriving', 'staying', 'leaving', 'ended', 'pending'].find(p => document.getElementById('page-home').classList.contains('phase-' + p)));
  return env;
};

(async () => {
  const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});

  await writeReservation('B1', B);
  assert.strictEqual(db['stay_links/A1__B1'].status, 'pending');
  assert.deepStrictEqual(pushes.map(p => p.body), ['Possible extension: Ann Lee, 6-1, 13 Oct - 16 Oct - confirm in admin']);
  await writeReservation('B1', { syncedAt: 'again' });
  await writeReservation('A1', { guest: 'Ann  Lee' });
  assert.strictEqual(pushes.length, 1);
  ok('a new booking with no phone: stored as pending, one push to the owner, not repeated by the next syncs');

  let g = await guestPage(browser, '2026-10-13T09:00:00+04:00');
  assert.strictEqual(await g.phase(), 'leaving');
  await g.ctx.close();
  g = await guestPage(browser, '2026-10-13T12:30:00+04:00');
  assert.strictEqual(await g.phase(), 'pending');
  await g.ctx.close();
  ok('guest page: normal until check-out time, then "being confirmed"');

  const admin = await openWith(browser, '2026-10-13T13:00:00+04:00', 'checkin-admin.html?tab=stay', true);
  await admin.page.waitForSelector('#stay-ext .stay-banner__row', { timeout: 25000 });
  await admin.page.locator('#stay-ext button', { hasText: 'Link' }).first().click();
  await admin.page.waitForTimeout(900);
  await pull(admin, 'stay_links/');
  assert.strictEqual(db['stay_links/A1__B1'].status, 'confirmed');
  await admin.ctx.close();
  await writeReservation('B1', { checkout: '2026-10-17' });
  assert.deepStrictEqual([db['stay_links/A1__B1'].status, db['stay_links/A1__B1'].nextCheckout], ['confirmed', '2026-10-17']);
  ok('admin: one tap confirms; the trigger keeps that answer when the booking changes');

  g = await guestPage(browser, '2026-10-13T14:00:00+04:00');
  assert.strictEqual(await g.phase(), 'staying');
  assert.strictEqual(await g.page.evaluate(() => document.getElementById('hero-door-code').textContent.trim()), '7777#');
  await pull(g, 'checkin_guests/');
  assert.strictEqual(db['checkin_guests/' + tok].checkoutDate, '2026-10-17');
  await g.ctx.close();
  ok('guest page: the stay continues with codes; the record now ends 17 Oct');

  await writeReservation('B1', { status: 'CANCELLED' });
  assert.strictEqual(db['stay_links/A1__B1'], undefined);
  g = await guestPage(browser, '2026-10-13T14:30:00+04:00');
  assert.strictEqual(await g.phase(), 'leaving');
  await pull(g, 'checkin_guests/');
  assert.strictEqual(db['checkin_guests/' + tok].checkoutDate, '2026-10-13');
  await g.ctx.close();
  ok('cancelled: the link is removed and the stay ends on 13 Oct again');

  await writeReservation('M1', { reservationNumber: 'M1', roomCode: '7-1', checkin: '2026-10-13', checkout: '2026-10-15', status: 'OK2', guest: 'Ann Lee', phone: '+995 555 111 222' });
  assert.strictEqual(pushes[pushes.length - 1].body, 'Same guest moves 6-1 -> 7-1 on 13 Oct - change it if needed');
  assert.strictEqual(db['stay_links/A1__M1'].kind, 'move');
  g = await guestPage(browser, '2026-10-13T21:00:00+04:00');
  assert.strictEqual(await g.phase(), 'ended');
  await g.ctx.close();
  ok('another unit: a "moving guest" push, never linked');

  console.log(`\nALL ${passed} WHOLE-LOOP CHECKS PASSED`);
  await browser.close();
})().catch(e => { console.error('FAIL', e.message.split('\n').slice(0, 4).join(' | ')); process.exit(1); });
