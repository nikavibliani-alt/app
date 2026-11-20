// Codes typed as plain text in arrival steps are never in the page before the guest is unlocked, and show as written after.
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const assert = require('assert');
const h = require('./e2e.cjs');
let passed = 0; const ok = n => { passed++; console.log('PASS ' + n); };
const FAST = `(() => { const si = window.setInterval; window.setInterval = (f, ms, ...a) => si(f, ms === 60000 ? 1000 : ms, ...a); })();`;
const T_BEFORE = '2026-10-12T06:00:00Z';   // 10:00 Tbilisi on the arrival day: not ready yet
const T_AFTER = '2026-10-12T12:30:00Z';    // 16:30 Tbilisi: unlocked
const PHOTOS = ['https://img.test/1.jpg', 'https://img.test/2.jpg', 'https://img.test/3.jpg'];
const CAPS = ['Entrance is on the right.', '3435#', 'Elevator Code: 2468 (only for check-in)'];
const listHtml = page => page.evaluate(() => document.getElementById('hero-walkthrough-list').innerHTML);

async function scenario(browser, name, extraDocs) {
  const env = await h.open(browser, { apiOn: false, startIso: T_BEFORE });
  await env.page.addInitScript(FAST);
  await env.page.addInitScript(([docs, photos, caps]) => {
    Object.assign(window.__DB.docs, docs);
    window.__DB.docs['checkin_apartments/6-1'] = { ...window.__DB.docs['checkin_apartments/6-1'], photos, photoCaptions: caps };
  }, [extraDocs, PHOTOS, CAPS]);
  await h.register(env, { apiOn: false });
  const before = await listHtml(env.page);
  assert.ok(!/3435/.test(before) && !/2468/.test(before), name + ': no code in the page before unlock');
  assert.ok(/Shown when your room is ready/.test(before), name + ': shows the "ready" text instead');
  assert.ok(/Entrance is on the right/.test(before), name + ': normal words stay');
  ok(name + ': before unlock the codes are masked ("Shown when your room is ready")');
  await env.setClock(T_AFTER);
  await env.page.waitForFunction(() => /3435/.test(document.getElementById('hero-walkthrough-list').innerHTML), null, { timeout: 20000 });
  const after = await listHtml(env.page);
  assert.ok(/3435/.test(after) && /2468/.test(after), name + ': after unlock the codes show as written');
  ok(name + ': after unlock the codes show as written');
  assert.deepEqual(env.logs.filter(l => l.startsWith('PAGEERROR')), []);
  await env.ctx.close();
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
  await scenario(browser, 'own photo steps', {});
  await scenario(browser, 'type steps', { 'checkin_admin/config': { aptTypes: { MAXELA: { access: { method: '' }, steps: [{ id: 's1', title: 'Gate', text: 'Gate code is 7788# then walk in', photo: '', perUnitPhoto: false }] } } } });
  console.log('\nALL ' + passed + ' CODE-MASKING CHECKS PASSED');
  await browser.close();
})().catch(e => { console.error('FAIL', e); process.exit(1); });
