// Cleaner page and admin HK: "Same guest continues" on the changeover day (label only; the tasks are the same).
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const assert = require('assert');
const h = require('./e2e.cjs');
const SHOT = process.env.SHOT_DIR || '';
let passed = 0; const ok = n => { passed++; console.log('PASS ' + n); };

const TOKEN = 'f'.repeat(32);
const ROOMS = ['6-1', '7-1', '6-2', '7-2', '7-4'];
const res = (id, room, from, to, extra) => ({ ['reservations/' + id]: { reservationNumber: id, roomCode: room, checkin: '2026-10-' + from, checkout: '2026-10-' + to, status: 'OK2', guest: 'Ann Lee', phone: '+995 555 111 222', ...extra } });
const DOCS = Object.assign({
  ['hk_staff_links/' + TOKEN]: { active: true, name: 'Tester', teamIds: ['t'] },
  'checkin_admin/config': { hkSettings: { teams: [{ id: 't', label: 'Team', roomCodes: ROOMS }] } },
  'stay_links/R1__R2': { kind: 'extension', status: 'rejected', prevId: 'R1', nextId: 'R2', unit: '7-4', nextCheckin: '2026-10-13' },
}, ...ROOMS.map(r => ({ ['checkin_rooms/' + r]: { roomCode: r, site: 'shartava', displayName: r, showInHk: true, active: true, sortOrder: 1 } })),
  res('A1', '6-1', '10', '13'), res('A2', '6-1', '13', '16'),                                  // strong: continues
  res('W1', '7-1', '10', '13'), res('W2', '7-1', '13', '16', { phone: '' }),                   // phone missing: waits for the owner
  res('D1', '6-2', '10', '13'), res('D2', '6-2', '13', '16', { phone: '+995 599 000 000' }),   // another phone
  res('G1', '7-2', '10', '13'), res('G2', '7-2', '14', '16'),                                  // 1-day gap
  res('R1', '7-4', '10', '13'), res('R2', '7-4', '13', '16'));                                 // owner said no

const cards = page => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.card .room, .hk-card .hk-card__room')].map(r => [r.textContent, r.closest('.card, .hk-card').innerText.replace(/\s+/g, ' ')])));
const SAME = /Same guest continues/;

async function openPage(browser, url, admin) {
  const env = await h.open(browser, { apiOn: false, startIso: '2026-10-13T06:00:00Z', viewport: { width: 390, height: 844 } });
  await env.page.addInitScript(admin => { if (admin) localStorage.setItem('maxela_admin_authed', 'yes_' + Date.now()); localStorage.setItem('hk_lang', 'en'); }, admin);
  await env.page.addInitScript(d => {
    for (const k of Object.keys(window.__DB.docs)) if (k.startsWith('reservations/')) delete window.__DB.docs[k];
    Object.assign(window.__DB.docs, d);
  }, DOCS);
  await env.page.goto('http://test.local/' + url);
  await env.page.waitForFunction(() => document.querySelectorAll('.card .room, .hk-card .hk-card__room').length >= 5, null, { timeout: 25000 });
  await env.page.waitForTimeout(1200);
  return env;
}

async function check(env, who) {
  let c = await cards(env.page);
  assert.deepStrictEqual(Object.keys(c).sort(), [...ROOMS].sort(), who + ': every check-out room is still a task');
  assert.match(c['6-1'], SAME, who + ' 6-1');
  for (const room of ['7-1', '6-2', '7-2', '7-4']) assert.ok(!SAME.test(c[room]), who + ' ' + room + ' must have no label: ' + c[room]);
  ok(who + ': "Same guest continues" only on the linked changeover; the task list is unchanged');
  await env.page.evaluate(() => window.__DBAPI.set('stay_links/W1__W2', { kind: 'extension', status: 'confirmed', prevId: 'W1', nextId: 'W2', unit: '7-1', nextCheckin: '2026-10-13' }));
  await env.page.waitForTimeout(1500);
  c = await cards(env.page);
  assert.match(c['7-1'], SAME, who + ' 7-1 after confirm');
  ok(who + ': a link you confirm shows the label too');
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
  let env = await openPage(browser, 'cleaner.html?s=' + TOKEN, false);
  await check(env, 'cleaner');
  if (SHOT) await env.page.screenshot({ path: SHOT + '/cleaner-same.png' });
  await env.page.click('#lang-btn');
  await env.page.waitForTimeout(500);
  assert.match((await cards(env.page))['6-1'], /იგივე სტუმარი რჩება/);
  ok('cleaner: the label is in Georgian too');
  assert.deepStrictEqual(env.logs.filter(l => l.startsWith('PAGEERROR')), []);
  await env.ctx.close();

  env = await openPage(browser, 'checkin-admin.html?tab=hk', true);
  await check(env, 'admin HK');
  assert.deepStrictEqual(env.logs.filter(l => l.startsWith('PAGEERROR')), []);
  console.log(`\nALL ${passed} CLEANER LABEL CHECKS PASSED`);
  await browser.close();
})().catch(e => { console.error('FAIL', e.message.split('\n').slice(0, 4).join(' | ')); process.exit(1); });
