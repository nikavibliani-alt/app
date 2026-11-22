// Building / elevator code card on the home screen (staying and checkout day) and check-out steps.
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const assert = require('assert');
const h = require('./e2e.cjs');
let passed = 0; const ok = n => { passed++; console.log('PASS ' + n); };
const FAST = `(() => { const si = window.setInterval; window.setInterval = (f, ms, ...a) => si(f, ms === 60000 ? 1000 : ms, ...a); })();`;
const SHOT = process.env.SHOT_DIR || '';
const T = {
  before: '2026-10-12T06:00:00Z',   // arrival day 10:00 Tbilisi: not ready yet
  staying: '2026-10-13T08:00:00Z',  // mid-stay
  coBefore: '2026-10-15T06:00:00Z', // checkout day 10:00 Tbilisi (check-out 12:00)
  coAfter: '2026-10-15T09:00:00Z',  // checkout day 13:00 Tbilisi, after check-out time, before 20:00
  ended: '2026-10-15T17:00:00Z',    // 21:00 Tbilisi: stay over
};
const XCV_APT = { propertyName: 'Modern Avlabari 2', address: '1 Test St', checkInTime: '15:00', checkOutTime: '12:00', doorCode: '1111#', wifiName: 'W', wifiPass: 'p' };

async function open(browser, { room, apt, docs, startIso, viewport }) {
  const env = await h.open(browser, { apiOn: false, startIso: startIso || T.before, viewport });
  await env.page.addInitScript(FAST);
  await env.page.addInitScript(([room, apt, docs]) => {
    Object.assign(window.__DB.docs, docs || {});
    if (room) {
      window.__DB.docs['reservations/007004961_001'].roomCode = room;
      window.__DB.docs['checkin_apartments/' + room] = { ...(window.__DB.docs['checkin_apartments/' + room] || {}), ...apt };
    }
  }, [room, apt, docs]);
  return env;
}
const vis = (page, id) => page.evaluate(i => { const e = document.getElementById(i); return !!e && getComputedStyle(e).display !== 'none' && e.offsetHeight > 0; }, id);
const text = (page, id) => page.evaluate(i => (document.getElementById(i)?.innerText || '').replace(/\s+/g, ' ').trim(), id);
const phase = page => page.evaluate(() => ['waiting', 'arriving', 'staying', 'leaving', 'ended'].find(p => document.getElementById('page-home').classList.contains('phase-' + p)) || '');
async function toStaying(env) {
  await env.setClock(T.staying);
  const gid = await env.page.evaluate(() => Object.keys(window.__DB.docs).find(k => k.startsWith('checkin_guests/')).split('/')[1]);
  await env.page.evaluate(g => window.__DBAPI.set('checkin_guests/' + g, { guestConfirmedCheckin: true }, true), gid);
  await env.page.waitForFunction(() => document.getElementById('page-home').classList.contains('phase-staying'), null, { timeout: 20000 });
}
async function shot(env, name) { if (SHOT) { await env.page.evaluate(() => window.scrollTo(0, 0)); await env.page.screenshot({ path: SHOT + '/' + name + '.png', fullPage: true }); } }

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });

  // XCV unit with its own entrance code: hidden before unlock, shown staying and on checkout day (before and after check-out time)
  {
    const env = await open(browser, { room: 'xcv-2', apt: { ...XCV_APT, entranceCode: '9911#' } });
    await h.register(env, { apiOn: false });
    assert.equal(await phase(env.page), 'waiting');
    assert.equal(await vis(env.page, 'hero-building-card'), false);
    assert.ok(!(await env.page.evaluate(() => document.body.innerHTML)).includes('9911'), 'code not in the page before unlock');
    ok('XCV: before unlock the building code card is hidden and the code is not in the page');
    await toStaying(env);
    assert.equal(await vis(env.page, 'hero-building-card'), true);
    assert.match(await text(env.page, 'hero-building-card'), /Building \/ elevator code/);
    assert.equal(await text(env.page, 'hero-building-code'), '9911#');
    await shot(env, 'xcv-staying');
    ok('XCV staying: the building code card shows the code with the default title');
    await env.setClock(T.coBefore);
    await env.page.waitForFunction(() => document.getElementById('page-home').classList.contains('phase-leaving'), null, { timeout: 20000 });
    assert.equal(await vis(env.page, 'hero-building-card'), true);
    assert.equal(await text(env.page, 'hero-building-code'), '9911#');
    await shot(env, 'xcv-checkout-day-morning');
    ok('XCV checkout day, before check-out time: the code card is there');
    await env.setClock(T.coAfter);
    await env.page.waitForTimeout(2500);
    assert.equal(await phase(env.page), 'leaving');
    assert.equal(await vis(env.page, 'hero-building-card'), true);
    ok('XCV checkout day, after check-out time: the code card is still there');
    await env.page.evaluate(() => navigator.clipboard && 0);
    await env.setClock(T.ended);
    await env.page.waitForFunction(() => document.getElementById('page-home').classList.contains('phase-ended'), null, { timeout: 20000 });
    assert.equal(await vis(env.page, 'hero-building-card'), false);
    ok('XCV after the stay ended: the card is gone');
    assert.deepEqual(env.logs.filter(l => l.startsWith('PAGEERROR')), []);
    await env.ctx.close();
  }

  // type code (checkin_type_codes) and a custom title set on the type
  {
    const env = await open(browser, { room: 'xcv-2', apt: XCV_APT, docs: {
      'checkin_type_codes/XCV': { entranceCode: '6622#' },
      'checkin_admin/config': { aptTypes: { XCV: { access: { method: '', buildingLabel: 'Main door code' }, steps: [] } } },
    } });
    await h.register(env, { apiOn: false });
    await toStaying(env);
    await env.page.waitForFunction(() => /6622/.test(document.getElementById('hero-building-code')?.innerText || ''), null, { timeout: 20000 });
    assert.match(await text(env.page, 'hero-building-card'), /Main door code/);
    ok("XCV: the type's code and the title set on the type are used");
    await env.ctx.close();
  }

  // Shartava unit: no entrance code, so no new card; the QR elevator card is as before
  {
    const env = await open(browser, {});
    await h.register(env, { apiOn: false });
    await toStaying(env);
    assert.equal(await vis(env.page, 'hero-building-card'), false);
    assert.equal(await vis(env.page, 'hero-elevator'), true);
    await shot(env, 'shartava-staying');
    await env.setClock(T.coBefore);
    await env.page.waitForFunction(() => document.getElementById('page-home').classList.contains('phase-leaving'), null, { timeout: 20000 });
    assert.equal(await vis(env.page, 'hero-building-card'), false);
    assert.equal(await vis(env.page, 'hero-elevator'), true);
    ok('Shartava unit: no building code card, the elevator card is unchanged (staying and checkout day)');
    await env.ctx.close();
  }

  // Preview: fake code only where the apartment has an entrance code
  for (const [apt, expect] of [['xcv-2', true], ['6-1', false]]) {
    const env = await open(browser, { room: null, apt: null, docs: { 'checkin_apartments/xcv-2': { ...XCV_APT, entranceCode: '9911#' } } });
    await env.page.goto('http://test.local/checkin-guest.html?preview=true&apt=' + apt);
    await env.page.waitForFunction(() => document.getElementById('page-home')?.classList.contains('active'), null, { timeout: 20000 });
    await env.page.waitForTimeout(2000);
    assert.equal(await vis(env.page, 'hero-building-card'), expect);
    if (expect) { assert.equal(await text(env.page, 'hero-building-code'), '0000'); assert.ok(!(await env.page.evaluate(() => document.body.innerHTML)).includes('9911')); }
    ok('Preview ' + apt + ': ' + (expect ? 'card with the fake code 0000, real code not in the page' : 'no card'));
    await env.ctx.close();
  }

  // Check-out steps
  const CO_DOCS = {
    'checkin_admin/config': { aptTypes: { XCV: { access: { method: 'lockbox', lockboxWhere: 'Grey box by the door' }, steps: [], checkoutSteps: [
      { id: 'c1', title: 'Close the windows', text: 'Entrance code for the way out: {entrance code}', photo: '', perUnitPhoto: false },
      { id: 'c2', title: 'Photo step', text: '', photo: 'https://img.test/co.jpg', perUnitPhoto: false },
    ] } } },
  };
  const CO_APT = { ...XCV_APT, entranceCode: '9911#', lockboxCode: '5544', checkoutPhotos: [''], checkoutPhotoCaptions: ['Take the trash out'] };
  {
    const env = await open(browser, { room: 'xcv-2', apt: CO_APT, docs: CO_DOCS });
    await h.register(env, { apiOn: false });
    assert.equal(await vis(env.page, 'hero-checkout-steps'), false);
    assert.ok(!(await env.page.evaluate(() => document.body.innerHTML)).includes('9911'), 'no code in the page before unlock');
    ok('check-out steps: hidden before unlock, no code in the page');
    await toStaying(env);
    assert.equal(await vis(env.page, 'hero-checkout-steps'), true);
    assert.equal(await vis(env.page, 'hero-checkout-list'), false, 'collapsed during the stay');
    assert.equal(await text(env.page, 'btn-show-checkout'), 'Show how to check out');
    await shot(env, 'xcv-staying-checkout-closed');
    await env.page.click('#btn-show-checkout');
    assert.equal(await vis(env.page, 'hero-checkout-list'), true);
    const opened = await text(env.page, 'hero-checkout-list');
    assert.match(opened, /Close the windows/); assert.match(opened, /9911#/); assert.match(opened, /Take the trash out/);
    assert.equal(await text(env.page, 'btn-show-checkout'), 'Hide how to check out');
    await shot(env, 'xcv-staying-checkout-open');
    ok('check-out steps during the stay: an item "How to check out" that opens; steps in order, fill-in words filled');
    await env.setClock(T.coBefore);
    await env.page.waitForFunction(() => document.getElementById('page-home').classList.contains('phase-leaving'), null, { timeout: 20000 });
    assert.equal(await vis(env.page, 'hero-checkout-list'), true);
    assert.equal(await vis(env.page, 'btn-show-checkout'), false);
    assert.equal(await text(env.page, 't-checkout-steps-title'), 'How to check out');
    const order = await env.page.evaluate(() => { const y = id => document.getElementById(id).getBoundingClientRect().top; return { ret: y('hero-return-card'), co: y('hero-checkout-steps'), build: y('hero-building-card') }; });
    assert.ok(order.ret < order.co, 'the key return note shows first');
    assert.match(await text(env.page, 'hero-return-card'), /lock box/i);
    await shot(env, 'xcv-checkout-day-steps');
    ok('check-out steps on checkout day: shown in full under the key return note, building code card also there');
    await env.setClock(T.coAfter);
    await env.page.waitForTimeout(2500);
    assert.equal(await vis(env.page, 'hero-checkout-list'), true);
    ok('check-out steps on checkout day after check-out time: still shown');
    for (const [l, lbl, tog] of [['ka', 'შენობის / ლიფტის კოდი', null], ['ru', 'Код здания / лифта', null], ['ar', 'رمز المبنى / المصعد', null]]) {
      await env.page.evaluate(x => window.setLang(x), l);
      await env.page.waitForTimeout(500);
      assert.match(await text(env.page, 'hero-building-card'), new RegExp(lbl.replace(/[/]/g, '\\/')));
      assert.notEqual(await text(env.page, 't-checkout-steps-title'), 'How to check out');
    }
    ok('new labels are translated (ka, ru, ar)');
    assert.deepEqual(env.logs.filter(l => l.startsWith('PAGEERROR')), []);
    await env.ctx.close();
  }
  // XCV with an entrance code but no check-out steps, and a Shartava unit: no check-out block at all
  for (const [name, o] of [['XCV without check-out steps', { room: 'xcv-2', apt: { ...XCV_APT, entranceCode: '9911#' } }], ['Shartava unit', {}]]) {
    const env = await open(browser, o);
    await h.register(env, { apiOn: false });
    await toStaying(env);
    assert.equal(await vis(env.page, 'hero-checkout-steps'), false);
    assert.equal(await env.page.evaluate(() => document.getElementById('hero-checkout-steps').dataset.has), '');
    await env.setClock(T.coBefore);
    await env.page.waitForFunction(() => document.getElementById('page-home').classList.contains('phase-leaving'), null, { timeout: 20000 });
    assert.equal(await vis(env.page, 'hero-checkout-steps'), false);
    ok(name + ': no check-out block (as today)');
    await env.ctx.close();
  }

  console.log('\nALL ' + passed + ' BUILDING CODE CARD AND CHECK-OUT CHECKS PASSED');
  await browser.close();
})().catch(e => { console.error('FAIL', e); process.exit(1); });
