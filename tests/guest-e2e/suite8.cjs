// Back-to-back stays on the guest page: a new booking in the same unit from the check-out day continues the stay.
// Direct Firestore and GUEST_API. Tbilisi times below; check-out time of the unit is 12:00.
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const assert = require('assert');
const h = require('./e2e.cjs');
const SHOT = process.env.SHOT_DIR || '';
const ONLY = process.env.ONLY || '';
let passed = 0, failed = 0;
async function test(name, fn) {
  if (ONLY && !name.includes(ONLY)) return;
  try { await fn(); passed++; console.log('PASS ' + name); }
  catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + e.message.split('\n').slice(0, 3).join(' | ')); }
}
const FAST = `(() => { const si = window.setInterval; window.setInterval = (f, ms, ...a) => si(f, ms === 60000 || ms === 30000 ? 700 : ms, ...a); })();`;

const at = (day, hhmm) => `2026-10-${day}T${hhmm}:00+04:00`;
const PHONE = '+995 555 111 222';
const res = (id, room, from, to, extra) => ({ ['reservations/' + id]: { reservationNumber: id, roomCode: room, checkin: '2026-10-' + from, checkout: '2026-10-' + to, status: 'OK2', guest: 'Ann Lee', phone: PHONE, ...extra } });
const A = x => res('007100001', '6-1', '10', '13', x);
const B = x => res('007100002', '6-1', '13', '16', x);
const C = x => res('007100003', '6-1', '16', '18', x);
const APT = {
  'checkin_apartments/6-1': { propertyName: 'Unit 6-1', checkInTime: '15:00', checkOutTime: '12:00', doorCode: '7777#', wifiName: 'NetSixOne', wifiPass: 'wifi-secret-61', photos: ['https://img.test/a.jpg'], photoCaptions: ['Door code {door code}'] },
  'checkin_apartments/7-1': { propertyName: 'Unit 7-1', checkInTime: '15:00', checkOutTime: '12:00', doorCode: '8888#', wifiName: 'NetSevenOne', wifiPass: 'wifi-secret-71' },
};
const SECRETS = ['7777', 'wifi-secret-61', '2468', '111111', '222222'];
const tok = c => c.repeat(32);
const guest = (c, matched, room, from, to, extra) => ({ ['checkin_guests/' + tok(c)]: { name: 'Ann Lee', nameRoman: 'Ann Lee', aptId: room, matchedReservationId: matched, arrivalDate: '2026-10-' + from, checkoutDate: '2026-10-' + to, contact: PHONE, contactType: 'wa', passportSkipped: true, isPrimaryGuest: true, guestConfirmedCheckin: true, ...extra } });
const GA = x => guest('a', '007100001', '6-1', '10', '13', x);
const seed = (...parts) => Object.assign({}, APT, ...parts);

async function openAt(browser, { docs, when, apiOn, who = 'a', url }) {
  const env = await h.open(browser, { apiOn, startIso: when, viewport: { width: 390, height: 844 } });
  await env.page.addInitScript(FAST);
  await env.page.addInitScript(d => {
    for (const k of Object.keys(window.__DB.docs)) if (k.startsWith('reservations/') || k.startsWith('checkin_apartments/')) delete window.__DB.docs[k];
    Object.assign(window.__DB.docs, d);
  }, docs);
  await env.page.goto('http://test.local/checkin-guest.html?api=' + (apiOn ? 1 : 0) + (url !== undefined ? url : '&g=' + tok(who)));
  await env.page.waitForFunction(() => document.getElementById('page-home')?.classList.contains('active'), null, { timeout: 20000 });
  await env.page.waitForTimeout(1800);
  return env;
}
const state = page => page.evaluate(() => {
  const home = document.getElementById('page-home');
  const shown = id => { const e = document.getElementById(id); return !!e && getComputedStyle(e).display !== 'none' && e.offsetHeight > 0; };
  return {
    phase: ['waiting', 'arriving', 'staying', 'leaving', 'ended', 'pending'].find(p => home.classList.contains('phase-' + p)) || '',
    door: shown('hero-door-code') ? document.getElementById('hero-door-code').textContent.trim() : '',
    pendingShown: shown('hero-pending'), thanksShown: shown('hero-thankyou'), text: home.innerText, html: home.innerHTML,
    coLabel: document.getElementById('hero-checkout-label')?.textContent || '',
  };
});
const record = (env, c = 'a') => env.page.evaluate(t => window.__DB.docs['checkin_guests/' + t], tok(c));
const go = async (env, when) => { await env.setClock(when); await env.page.waitForTimeout(1900); };
const dbSet = (env, path, data) => env.page.evaluate(([p, d]) => window.__DBAPI.set(p, d, true), [path, data]);
const link = (a, b) => 'stay_links/' + a + '__' + b;
function assertAccess(s, code, label) {
  assert.ok(['arriving', 'staying', 'leaving'].includes(s.phase), label + ': phase ' + s.phase);
  assert.strictEqual(s.door, code, label + ': door code');
  assert.ok(!s.pendingShown && !s.thanksShown, label + ': no pending / thank-you screen');
}
function assertNoCodes(s, label) {
  for (const x of SECRETS) assert.ok(!s.html.includes(x), label + ': "' + x + '" is in the page');
}

(async () => {
  const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
  for (const apiOn of [false, true]) {
    const way = apiOn ? 'GUEST_API' : 'direct';

    await test(`${way}: extension (same unit, name, phone, same day): the stay continues, codes stay, no cleaning wait`, async () => {
      const env = await openAt(browser, { docs: seed(A(), B(), GA()), when: at(13, '00:30'), apiOn });
      let s = await state(env.page);
      assertAccess(s, '7777#', 'changeover day, just after midnight');
      assert.strictEqual(s.phase, 'staying');
      assert.match(s.coLabel, /2026-10-16/, 'the date shown is the end of the whole stay');
      await go(env, at(13, '10:00')); assertAccess(await state(env.page), '7777#', 'changeover 10:00');
      await go(env, at(13, '13:00')); assertAccess(await state(env.page), '7777#', 'after check-out time');
      await go(env, at(13, '21:00')); assertAccess(await state(env.page), '7777#', 'changeover evening');
      await go(env, at(16, '10:00'));
      s = await state(env.page);
      assert.strictEqual(s.phase, 'leaving', 'check-out day of the last booking');
      await go(env, at(16, '20:30'));
      assert.strictEqual((await state(env.page)).phase, 'ended');
      const r = await record(env);
      assert.strictEqual(r.checkoutDate, '2026-10-16', 'the record check-out date is updated');
      assert.strictEqual(r.arrivalDate, '2026-10-10', 'the arrival date stays');
      assert.strictEqual(r.matchedReservationId, '007100001');
      await env.ctx.close();
    });

    for (const [label, other] of [['a 1-day gap', res('007100002', '6-1', '14', '16')], ['a different phone', B({ phone: '+995 599 000 000' })], ['another unit', res('007100002', '7-1', '13', '16')], ['a cancelled next booking', B({ status: 'CANCELLED' })]]) {
      await test(`${way}: ${label} is a new stay: normal check-out and end`, async () => {
        const env = await openAt(browser, { docs: seed(A(), other, GA()), when: at(13, '10:00'), apiOn });
        assert.strictEqual((await state(env.page)).phase, 'leaving');
        await go(env, at(13, '13:00'));
        let s = await state(env.page);
        assert.strictEqual(s.phase, 'leaving'); assert.ok(!s.pendingShown);
        await go(env, at(13, '20:30'));
        s = await state(env.page);
        assert.strictEqual(s.phase, 'ended');
        assert.strictEqual((await record(env)).checkoutDate, '2026-10-13');
        await env.ctx.close();
      });
    }

    await test(`${way}: missing phone: normal until check-out time, then "being confirmed" with WhatsApp and no codes; continues after confirm`, async () => {
      const env = await openAt(browser, { docs: seed(A({ tuyaPassword: '111111' }), B({ phone: '', tuyaPassword: '222222' }), GA()), when: at(13, '11:00'), apiOn });
      let s = await state(env.page);
      assert.strictEqual(s.phase, 'leaving'); assert.strictEqual(s.door, '111111');
      await go(env, at(13, '12:05'));
      s = await state(env.page);
      assert.strictEqual(s.phase, 'pending');
      assert.ok(s.pendingShown, 'the calm screen shows');
      assert.match(s.text, /Your extension is being confirmed by the host/);
      assert.match(s.text, /WhatsApp/);
      assertNoCodes(s, 'pending');
      assert.strictEqual(await env.page.evaluate(() => /^https:\/\/wa\.me\/\d+/.test(document.getElementById('hero-pending-whatsapp').href)), true);
      if (SHOT && !apiOn) await env.page.screenshot({ path: SHOT + '/stay-pending.png' });
      await go(env, at(13, '21:00'));
      assert.strictEqual((await state(env.page)).phase, 'pending', 'not "stay ended" in the evening');
      await go(env, at(14, '09:00'));
      s = await state(env.page);
      assert.strictEqual(s.phase, 'pending'); assertNoCodes(s, 'next day');
      await dbSet(env, link('007100001', '007100002'), { kind: 'extension', status: 'confirmed', prevId: '007100001', nextId: '007100002', unit: '6-1' });
      await env.page.waitForFunction(() => document.getElementById('page-home').classList.contains('phase-staying'), null, { timeout: 8000 });
      await env.page.waitForTimeout(800);
      s = await state(env.page);
      assertAccess(s, '222222', 'after confirm');
      assert.strictEqual((await record(env)).checkoutDate, '2026-10-16');
      await env.ctx.close();
    });

    await test(`${way}: a pending extension opened later, and after a reload, still shows the confirming screen`, async () => {
      const env = await openAt(browser, { docs: seed(A(), B({ phone: '' }), GA()), when: at(15, '10:00'), apiOn });
      const s = await state(env.page);
      assert.strictEqual(s.phase, 'pending'); assertNoCodes(s, 'opened two days later');
      await env.ctx.close();
    });

    await test(`${way}: "Not the same guest": exactly as today (check-out, then ended)`, async () => {
      const docs = seed(A(), B({ phone: '' }), GA(), { [link('007100001', '007100002')]: { kind: 'extension', status: 'rejected', prevId: '007100001', nextId: '007100002', unit: '6-1' } });
      const env = await openAt(browser, { docs, when: at(13, '13:00'), apiOn });
      let s = await state(env.page);
      assert.strictEqual(s.phase, 'leaving'); assert.strictEqual(s.door, '7777#'); assert.ok(!s.pendingShown);
      await go(env, at(13, '20:30'));
      assert.strictEqual((await state(env.page)).phase, 'ended');
      await env.ctx.close();
    });

    await test(`${way}: chain A -> B -> C`, async () => {
      const env = await openAt(browser, { docs: seed(A(), B(), C(), GA()), when: at(16, '13:00'), apiOn });
      assertAccess(await state(env.page), '7777#', 'second changeover');
      assert.strictEqual((await record(env)).checkoutDate, '2026-10-18');
      await go(env, at(18, '10:00'));
      assert.strictEqual((await state(env.page)).phase, 'leaving');
      await env.ctx.close();
    });

    await test(`${way}: each booking's own lock code shows while that booking is current`, async () => {
      const env = await openAt(browser, { docs: seed(A({ tuyaPassword: '111111' }), B({ tuyaPassword: '222222' }), GA()), when: at(13, '11:00'), apiOn });
      assert.strictEqual((await state(env.page)).door, '111111');
      await go(env, at(13, '12:30'));
      assert.strictEqual((await state(env.page)).door, '222222');
      await env.ctx.close();
    });

    await test(`${way}: cancelling the extension removes it while the page is open`, async () => {
      const env = await openAt(browser, { docs: seed(A(), B(), GA()), when: at(13, '10:00'), apiOn });
      assert.strictEqual((await state(env.page)).phase, 'staying');
      await dbSet(env, 'reservations/007100002', { status: 'CANCELLED' });
      await env.page.waitForFunction(() => document.getElementById('page-home').classList.contains('phase-leaving'), null, { timeout: 8000 });
      await env.page.waitForTimeout(800);
      assert.strictEqual((await record(env)).checkoutDate, '2026-10-13', 'the record goes back to the first check-out');
      await env.ctx.close();
    });

    await test(`${way}: same name, same unit, another phone: neither guest gets into the other's stay`, async () => {
      const docs = seed(A(), B({ phone: '+995 599 000 000' }), GA(), guest('b', '007100002', '6-1', '13', '16', { contact: '+995 599 000 000', guestConfirmedCheckin: false }));
      const second = await openAt(browser, { docs, when: at(13, '10:00'), apiOn, who: 'b' });
      let s = await state(second.page);
      assert.strictEqual(s.phase, 'waiting', 'the second guest waits for check-in like any new guest');
      assert.strictEqual(s.door, '');
      await second.ctx.close();
      const first = await openAt(browser, { docs, when: at(13, '20:30'), apiOn });
      s = await state(first.page);
      assert.strictEqual(s.phase, 'ended', 'the first guest ends at their own check-out');
      assert.strictEqual((await record(first)).checkoutDate, '2026-10-13');
      await first.ctx.close();
    });
  }

  await test('direct: coming back two days after the first check-out keeps the session (no second registration)', async () => {
    const env = await h.open(browser, { apiOn: false, startIso: at(15, '10:00') });
    await env.page.addInitScript(FAST);
    await env.page.addInitScript(([d, t]) => {
      for (const k of Object.keys(window.__DB.docs)) if (k.startsWith('reservations/')) delete window.__DB.docs[k];
      Object.assign(window.__DB.docs, d);
      localStorage.setItem('maxela_guest_id', t); localStorage.setItem('maxela_apt_id', '6-1');
    }, [seed(A(), B(), GA()), tok('a')]);
    await env.page.goto('http://test.local/checkin-guest.html?api=0');
    await env.page.waitForFunction(() => document.getElementById('page-home')?.classList.contains('active'), null, { timeout: 20000 });
    await env.page.waitForTimeout(1800);
    assertAccess(await state(env.page), '7777#', 'restored session');
    assert.strictEqual(await env.page.evaluate(() => localStorage.getItem('maxela_guest_id')), tok('a'));
    if (SHOT) await env.page.screenshot({ path: SHOT + '/stay-continued.png' });
    await env.ctx.close();
  });

  await test('direct: coming back after a stay with no extension still asks to register again (as today)', async () => {
    const env = await h.open(browser, { apiOn: false, startIso: at(15, '10:00') });
    await env.page.addInitScript(([d, t]) => {
      for (const k of Object.keys(window.__DB.docs)) if (k.startsWith('reservations/')) delete window.__DB.docs[k];
      Object.assign(window.__DB.docs, d);
      localStorage.setItem('maxela_guest_id', t); localStorage.setItem('maxela_apt_id', '6-1');
    }, [seed(A(), GA()), tok('a')]);
    await env.page.goto('http://test.local/checkin-guest.html?api=0');
    await env.page.waitForFunction(() => document.getElementById('app').style.display === 'block', null, { timeout: 20000 });
    await env.page.waitForTimeout(1500);
    assert.strictEqual(await env.page.evaluate(() => localStorage.getItem('maxela_guest_id')), null);
    await env.ctx.close();
  });

  await test('direct: a normal single booking: the record is not rewritten and nothing new shows', async () => {
    const env = await openAt(browser, { docs: seed(A(), GA()), when: at(11, '10:00'), apiOn: false });
    const s = await state(env.page);
    assertAccess(s, '7777#', 'mid stay');
    const writes = await env.page.evaluate(() => window.__DB.calls.filter(c => c.path.startsWith('checkin_guests/') || c.path.startsWith('stay_links/')).length);
    assert.strictEqual(writes, 0);
    assert.strictEqual(await env.page.evaluate(() => document.querySelectorAll('.apt-tile').length), 0);
    await env.ctx.close();
  });

  await browser.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
