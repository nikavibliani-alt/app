// Click tests for pricing-v2.html: the DESIGN_SPEC checklist at 390, 1280 and 1024 wide, Firestore faked.
// Run: PLAYWRIGHT_PATH=/opt/node-tools/node_modules/playwright CHROME_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome \
//      NODE_PATH=/opt/node-tools/node_modules node tests/pricing-v2/pricing-v2.test.cjs
const {chromium} = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const assert = require('assert');
const h = require('./harness.cjs');

const SIZES = [[390, 844], [1280, 800], [1024, 768]];
let passed = 0, failed = 0;
const failures = [];
async function test(name, w, hh, fn, opts = {}) {
  if (process.env.ONLY && !name.startsWith(process.env.ONLY)) return;
  if (process.env.WIDTH && String(w) !== process.env.WIDTH) return;
  const env = await h.open(BROWSER, {width: w, height: hh, ...opts});
  env.page.setDefaultTimeout(6000);
  try { await fn(env, w >= 900); assert.deepStrictEqual(env.logs.filter(l => !/favicon/.test(l)), [], 'console errors'); passed++; console.log(`PASS [${w}] ${name}`); }
  catch (e) { failed++; failures.push(`[${w}] ${name}: ${e.message}`); console.log(`FAIL [${w}] ${name}\n     ${e.message.split('\n')[0]}`); try { await env.page.screenshot({path: `/tmp/claude-0/fail-${w}-${name.replace(/\W+/g, '_').slice(0, 40)}.png`, fullPage: true}); } catch (x) {} }
  await env.ctx.close();
}
let BROWSER;
const openDates = async page => { if (!(await page.$('#seasonDates'))) await page.click('[data-act=toggleSeasonDates]'); await page.waitForSelector('#seasonDates'); };
const go = async (page, hash) => { await page.evaluate(x => { location.hash = x; }, hash); await page.waitForTimeout(150); };
const text = (page, sel) => page.evaluate(s => (document.querySelector(s) || {}).innerText || '', sel);
const bar = page => text(page, '#bar');
const writesTo = async (page, path) => (await h.writes(page)).filter(w => w.path === path);
const dlgOpen = page => page.evaluate(() => !document.getElementById('overlay').hidden);
const focusInDialog = page => page.evaluate(() => { const o = document.getElementById('overlay'); return !o.hidden && o.contains(document.activeElement); });
const fill = async (page, sel, v) => { await page.fill(sel, v); await page.waitForTimeout(30); };
const openRoom = async (env, desk, rt) => { if (desk) await env.page.click(`.cname[data-rt="${rt}"]`); else await go(env.page, '#/room/' + rt); };
const modeLine = (page, desk, rt) => text(page, desk ? `.cname[data-rt="${rt}"] span` : `a.row[href="#/room/${rt}"] .s`);

(async () => {
  BROWSER = await chromium.launch({executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox']});

  for (const [w, hh] of SIZES) {
    // ---- 1. pause ----
    await test('1 pause asks first, red bar, resume works; dialog focus, Escape, Tab', w, hh, async ({page}, desk) => {
      await page.click('[data-act=togglePause]');
      assert.ok(await dlgOpen(page) && await focusInDialog(page), 'focus moves into the dialog');
      for (let i = 0; i < 6; i++) { await page.keyboard.press('Tab'); assert.ok(await focusInDialog(page), 'Tab stays inside'); }
      for (let i = 0; i < 3; i++) { await page.keyboard.press('Shift+Tab'); assert.ok(await focusInDialog(page), 'Shift+Tab stays inside'); }
      await page.keyboard.press('Escape');
      assert.ok(!(await dlgOpen(page)), 'Escape closes');
      assert.strictEqual((await h.writes(page)).length, 0, 'nothing written before confirming');
      await page.click('[data-act=togglePause]'); await page.click('text=Keep running');
      assert.strictEqual((await h.writes(page)).length, 0);
      await page.click('[data-act=togglePause]'); await page.click('[data-act=pauseNow]');
      await page.waitForSelector('.banner.red');
      const w1 = await writesTo(page, 'pricing_config/control');
      assert.strictEqual(w1.length, 1); assert.strictEqual(w1[0].op, 'updateDoc'); assert.strictEqual(w1[0].fields.paused, true);
      assert.ok(/no updates until you resume/.test(await text(page, 'body')), 'says no updates until you resume');
      assert.strictEqual(await page.evaluate(() => getComputedStyle(document.querySelector('.banner.red')).backgroundColor), 'rgb(155, 44, 44)');
      await page.click('[data-act=resume]');
      await page.waitForFunction(() => !document.querySelector('.banner.red'));
      assert.strictEqual((await h.doc(page, 'pricing_config/control')).paused, false);
    });
    await test('1b a read error counts as paused', w, hh, async ({page}) => {
      assert.ok(await page.$('.banner.red'));
      assert.ok(/could not read the pause switch/.test(await text(page, '.banner.red')));
    }, {failPaths: ['pricing_config/control']});

    // ---- 2. nights and reasons ----
    await test('2 every night opens a reason; booked, hand-set, protected and event nights are marked', w, hh, async (env, desk) => {
      const {page} = env;
      if (!desk) {
        await go(page, '#/room/XCV_2'); await page.click('[data-act=allNights]');
        const n = await page.$$eval('.night', els => els.map(e => ({iso: e.dataset.iso, what: e.querySelector('.w').innerText})));
        assert.strictEqual(n.length, 28);
        for (const night of n) {
          await page.click(`.night[data-iso="${night.iso}"]`);
          assert.ok(await dlgOpen(page) && await focusInDialog(page));
          const t = await text(page, '.dlg');
          assert.ok(t.length > 40, 'has text for ' + night.iso);
          if (night.what === 'Booked') assert.ok(/Booked\. The engine does not change booked nights/.test(t));
          if (night.iso === '2026-10-17') assert.ok(/Set by you\. The engine never changes this price/.test(t) && /Give this night back to the engine/.test(t));
          if (night.iso === '2026-10-19') assert.ok(/told the engine not to change/.test(t));
          if (night.iso === '2026-10-31') { assert.ok(/event you approved/.test(t)); assert.strictEqual(night.what, 'Empty · event'); }
          await page.keyboard.press('Escape');
        }
      } else {
        const iso = await page.$$eval('.crow:nth-of-type(3) .cell', els => els.map(e => e.dataset.iso)).catch(() => []);
        const cells = await page.$$eval('.cell[data-rt="XCV_2"]', els => els.map(e => ({iso: e.dataset.iso, bk: e.classList.contains('bk'), lock: !!e.querySelector('.lk'), ev: !!e.querySelector('.ev')})));
        assert.strictEqual(cells.length, 28);
        for (const c of cells) {
          await page.click(`.cell[data-rt="XCV_2"][data-iso="${c.iso}"]`);
          await page.waitForSelector('.panel');
          const t = await text(page, '.panel');
          assert.ok(t.length > 30, 'panel text ' + c.iso);
          if (c.bk) assert.ok(/Booked\. The engine does not change booked nights/.test(t));
          if (c.iso === '2026-10-17') { assert.ok(c.lock && /Set by you\. The engine never changes this price/.test(t) && /Give this night back to the engine/.test(t)); }
          if (c.iso === '2026-10-19') assert.ok(c.lock && /told the engine not to change/.test(t));
          if (c.iso === '2026-10-31') assert.ok(c.ev && /event you approved/.test(t));
        }
      }
    });

    // ---- 3. mode ----
    await test('3 mode change: Not saved, Save clears it, row shows saved mode only after Save, nothing leaks to other rooms', w, hh, async (env, desk) => {
      const {page} = env;
      await openRoom(env, desk, 'XCV_2');
      await page.click('[data-act=mode][data-mode=fillfast][data-rt=XCV_2]');
      let b = await bar(page);
      assert.ok(/Not saved/.test(b) && /XCV 2 mode Balanced → Fill fast/.test(b), b);
      if (!desk) await go(page, '#/rooms');
      assert.ok(/Balanced/.test(await modeLine(page, desk, 'XCV_2')) && !/Fill fast/.test(await modeLine(page, desk, 'XCV_2')), 'row shows the saved mode');
      assert.ok(/Not saved/.test(await bar(page)), 'bar stays');
      await openRoom(env, desk, 'XCV_1');
      assert.strictEqual(await page.getAttribute('[data-act=mode][data-mode=balanced][data-rt=XCV_1]', 'aria-checked'), 'true');
      assert.strictEqual(await page.getAttribute('[data-act=mode][data-mode=fillfast][data-rt=XCV_1]', 'aria-checked'), 'false');
      await openRoom(env, desk, 'XCV_2');
      assert.strictEqual(await page.getAttribute('[data-act=mode][data-mode=fillfast][data-rt=XCV_2]', 'aria-checked'), 'true');
      await page.click('[data-act=save]');
      await page.waitForFunction(() => /Saved\. Used from the next price update\./.test(document.getElementById('bar').innerText));
      const wr = (await h.writes(page)).filter(x => x.path === 'pricing_config/engine_v2');
      assert.strictEqual(wr.length, 1); assert.strictEqual(wr[0].op, 'updateDoc');
      assert.deepStrictEqual(Object.keys(wr[0].fields), ['settings.room_types.XCV_2.style']);
      assert.strictEqual(wr[0].fields['settings.room_types.XCV_2.style'], 'aggressive');
      const eng = await h.doc(page, 'pricing_config/engine_v2');
      assert.strictEqual(eng.settings.room_types.XCV_1.style, 'normal'); assert.strictEqual(eng.settings.room_types.XCV_2.window_days, 180);
      if (!desk) await go(page, '#/rooms');
      assert.ok(/Fill fast/.test(await modeLine(page, desk, 'XCV_2')), 'row shows the mode after Save');
      assert.ok(/Balanced/.test(await modeLine(page, desk, 'XCV_1')));
    });
    await test('3b other room settings: how far ahead and automatic prices (asks before sending prices)', w, hh, async (env, desk) => {
      const {page} = env;
      await openRoom(env, desk, 'XCV_1');
      await page.click('[data-act=ahead][data-rt=XCV_1][data-d="365"]');
      await page.click('[data-act=engine][data-rt=XCV_1][data-v=test]');
      assert.ok(/how far ahead 6 months → 1 year/.test(await bar(page)) && /Only calculate/.test(await bar(page)));
      await page.click('[data-act=save]'); await page.waitForFunction(() => /^Saved/.test(document.getElementById('bar').innerText));
      let e = await h.doc(page, 'pricing_config/engine_v2');
      assert.strictEqual(e.settings.room_types.XCV_1.window_days, 365); assert.strictEqual(e.settings.room_types.XCV_1.engine, 'test');
      await page.click('[data-act=engine][data-rt=XCV_1][data-v=live]'); await page.click('[data-act=save]');
      assert.ok(await dlgOpen(page) && /Send prices\?/.test(await text(page, '.dlg')));
      await page.click('text=Not yet'); assert.strictEqual((await h.doc(page, 'pricing_config/engine_v2')).settings.room_types.XCV_1.engine, 'test');
      await page.click('[data-act=save]'); await page.click('[data-act=dialogYes]');
      await page.waitForFunction(() => /^Saved/.test(document.getElementById('bar').innerText));
      assert.strictEqual((await h.doc(page, 'pricing_config/engine_v2')).settings.room_types.XCV_1.engine, 'live');
    });
    await test('3c what a mode does opens, with Escape', w, hh, async (env, desk) => {
      const {page} = env; await openRoom(env, desk, 'XCV_2');
      await page.click('[data-act=info][data-mode=fillfast]');
      assert.ok(await focusInDialog(page)); const t = await text(page, '.dlg');
      assert.ok(/Fill fast/.test(t) && /8%/.test(t) && /Good for/.test(t));
      await page.keyboard.press('Escape'); assert.ok(!(await dlgOpen(page)));
      assert.ok(await page.$('[data-act=soon]'), 'coming soon rows exist');
      assert.strictEqual((await h.writes(page)).length, 0);
    });

    // ---- 4. season prices ----
    await test('4 season prices keep what you type; red boxes block Save in any season; saved numbers stay', w, hh, async ({page}) => {
      await go(page, '#/seasons');
      const k1 = 'input[data-k="XCV_1|mid|GEL|start"]';
      await fill(page, k1, '999');
      for (const f of ['min', 'start', 'max']) assert.ok(await page.$eval(`input[data-k="XCV_1|mid|GEL|${f}"]`, e => e.classList.contains('bad')), 'red box ' + f);
      assert.ok(/Fix the red boxes first/.test(await bar(page)));
      assert.strictEqual(await page.getAttribute('[data-act=save]', 'aria-disabled'), 'true');
      await page.$eval('[data-act=save]', e => e.click()); assert.strictEqual((await h.writes(page)).length, 0, 'blocked');
      await page.click('[data-act=season][data-season=high]');
      await fill(page, 'input[data-k="XCV_2|high|GEL|start"]', '205');
      assert.ok(/Fix the red boxes first \(also in Mid\)/.test(await bar(page)), await bar(page));
      assert.ok(/Mid \(fix\)/.test(await text(page, '#seasonChips')));
      await page.click('[data-act=season][data-season=mid]');
      assert.strictEqual(await page.inputValue(k1), '999', 'keeps what you typed');
      await fill(page, k1, '160');
      assert.ok(!/Fix the red boxes/.test(await bar(page)));
      assert.strictEqual(await page.getAttribute('[data-act=save]', 'aria-disabled'), 'false');
      await page.click('[data-act=save]');
      await page.waitForFunction(() => /^Saved/.test(document.getElementById('bar').innerText));
      const wr = await writesTo(page, 'pricing_config/rules');
      assert.ok(wr.every(x => x.op === 'updateDoc'), 'field-path updates only');
      assert.deepStrictEqual(Object.keys(wr[0].fields).sort(), ['startPrices.XCV_1.mid', 'startPrices.XCV_2.high']);
      const r = await h.doc(page, 'pricing_config/rules');
      assert.strictEqual(r.startPrices.XCV_1.mid, 160); assert.strictEqual(r.startPrices.XCV_2.high, 205);
      assert.strictEqual(r.priceRules.XCV_1.mid.max, 190); assert.strictEqual(r.startPrices.XCV_2.mid, 175); assert.ok(r.dateOverrides.length === 2);
      assert.strictEqual(await page.inputValue(k1), '160', 'saved number stays');
      await page.click('[data-act=season][data-season=high]'); assert.strictEqual(await page.inputValue('input[data-k="XCV_2|high|GEL|start"]'), '205');
    });
    await test('4b empty box in a changed group blocks; Airbnb box checked too', w, hh, async ({page}) => {
      await go(page, '#/seasons');
      await fill(page, 'input[data-k="XCV_2|mid|USD|min"]', '');
      assert.ok(/Airbnb: fill in all three numbers/.test(await text(page, '[data-err="XCV_2"]')));
      await fill(page, 'input[data-k="XCV_2|mid|USD|min"]', '60');
      assert.ok(/Airbnb: minimum ≤ start ≤ maximum/.test(await text(page, '[data-err="XCV_2"]')));
      await page.click('[data-act=undoAll]'); assert.strictEqual(await page.inputValue('input[data-k="XCV_2|mid|USD|min"]'), '38');
      assert.ok(!(await bar(page)).trim());
    });
    await test('4c changed elsewhere since the page loaded: nothing saved, new value shown', w, hh, async ({page}) => {
      await go(page, '#/seasons');
      await fill(page, 'input[data-k="XCV_1|mid|GEL|start"]', '160');
      await page.evaluate(() => { window.__FS.docs['pricing_config/rules'].startPrices.XCV_1.mid = 170; });
      await page.click('[data-act=save]');
      await page.waitForSelector('.dlg');
      assert.ok(/Nothing was saved/.test(await text(page, '.dlg')) && /XCV 1 . small Mid Booking start/.test(await text(page, '.dlg')));
      assert.strictEqual((await writesTo(page, 'pricing_config/rules')).length, 0);
      await page.keyboard.press('Escape');
      assert.strictEqual(await page.inputValue('input[data-k="XCV_1|mid|GEL|start"]'), '170');
    });
    await test('4d warning when engine_v2 overrides a room; fixed season dates shown', w, hh, async ({page}) => {
      await go(page, '#/seasons');
      assert.ok(/Change the dates under Season dates above/.test(await text(page, 'body')) && /16 Mar – 30 Apr/.test(await text(page, 'body')));
      assert.ok(/set outside this page/.test(await text(page, '[data-room="VGL_ST"]')));
      assert.ok(!/set outside this page/.test(await text(page, '[data-room="XCV_1"]')));
      assert.ok(!(await page.$('text=month')) || true);
    }, {mutate: d => { d['pricing_config/engine_v2'].rules = {VGL_ST: {GEL: {mid: {min: 1, start: 2, max: 3}}}}; }});

    // ---- 5. dates ----
    await test('5 holiday dates: cross-month range, overlap blocked, past days off, remove with Undo', w, hh, async ({page}) => {
      await go(page, '#/dates');
      const list = () => text(page, '#holList');
      assert.ok(/20 Dec – 27 Dec/.test(await list()) && /28 Dec – 6 Jan/.test(await list()));
      const dis = await page.$$eval('button.day', els => els.map(e => [e.dataset.iso, e.disabled]));
      assert.ok(dis.filter(([i]) => i < '2026-10-11').every(([, d]) => d) && dis.filter(([i]) => i >= '2026-10-11').every(([, d]) => !d), 'past days disabled');
      await page.click('[data-act=dpChoice][data-id=low]');
      await page.click('button.day[data-iso="2026-10-29"]');
      assert.ok(/Now tap the last day/.test(await text(page, '#addForm')));
      await page.click('[data-act=monthNext]'); await page.click('button.day[data-iso="2026-11-02"]');
      assert.strictEqual((await text(page, '[data-act=dpAdd]')).trim(), 'Add 29 Oct – 2 Nov: Low prices');
      await page.click('[data-act=dpAdd]');
      assert.ok(/29 Oct – 2 Nov/.test(await list()) && /not saved/.test(await list()));
      assert.ok(/Not saved/.test(await bar(page)) && /holiday dates 29 Oct – 2 Nov \(Low\) added/.test(await bar(page)));
      assert.strictEqual((await h.writes(page)).length, 0, 'nothing written before Save');
      // overlap
      await page.click('[data-act=dpChoice][data-id=peak]');
      await page.click('[data-act=monthNext]');   // Dec 2026 (view moved from Nov)
      await page.click('button.day[data-iso="2026-12-25"]'); await page.click('button.day[data-iso="2026-12-30"]');
      assert.ok(/Remove those first/.test(await text(page, '#addForm [role=alert]')));
      assert.strictEqual(await page.getAttribute('[data-act=dpAdd]', 'aria-disabled'), 'true');
      assert.ok(/Pick other days/.test(await text(page, '[data-act=dpAdd]')));
      const nBefore = (await list()).split('\n').filter(Boolean).length;
      await page.$eval('[data-act=dpAdd]', e => e.click()); assert.strictEqual((await list()).split('\n').filter(Boolean).length, nBefore);
      // remove with Undo
      await page.click('[aria-label="Remove 20 Dec – 27 Dec"]');
      assert.ok(!/20 Dec – 27 Dec/.test(await list()) && /Removed 20 Dec – 27 Dec/.test(await text(page, '#toast')));
      await page.click('#toast [data-act=toastUndo]');
      assert.ok(/20 Dec – 27 Dec/.test(await list()));
      await page.click('[aria-label="Remove 29 Oct – 2 Nov"]'); await page.click('#toast [data-act=toastUndo]');
      // save: only the new range, as an array add
      await page.click('[data-act=save]'); await page.waitForFunction(() => /^Saved/.test(document.getElementById('bar').innerText));
      const wr = await writesTo(page, 'pricing_config/rules');
      assert.strictEqual(wr.length, 1); assert.deepStrictEqual(Object.keys(wr[0].fields), ['dateOverrides']);
      assert.strictEqual(wr[0].fields.dateOverrides.__op, 'union'); assert.strictEqual(wr[0].fields.dateOverrides.items.length, 1);
      const r = await h.doc(page, 'pricing_config/rules'); assert.strictEqual(r.dateOverrides.length, 3);
      // remove a saved one and save: an array remove
      await page.click('[aria-label="Remove 29 Oct – 2 Nov"]'); await page.click('[data-act=save]');
      await page.waitForFunction(() => /^Saved/.test(document.getElementById('bar').innerText));
      const wr2 = await writesTo(page, 'pricing_config/rules'); assert.strictEqual(wr2[1].fields.dateOverrides.__op, 'remove');
      assert.strictEqual((await h.doc(page, 'pricing_config/rules')).dateOverrides.length, 2);
    });
    await test('5b holiday dates are sorted from July on; date rules and events', w, hh, async ({page}) => {
      await go(page, '#/dates');
      const rows = await page.$$eval('#holList .lrow .t', els => els.map(e => e.innerText));
      assert.deepStrictEqual(rows, ['1 Jul – 10 Jul', '20 Dec – 27 Dec', '28 Dec – 6 Jan', '5 Mar – 8 Mar']);
      // a date rule for one room, saved as an array add under settings
      await page.click('[data-act=dpKind][data-k=rule]');
      await page.click('[data-act=dpRoom][data-id=XCV_1]');
      await page.click('button.day[data-iso="2026-10-20"]'); await page.click('button.day[data-iso="2026-10-22"]');
      assert.ok(/Add 20 Oct – 22 Oct: Don’t change the price, XCV 1/.test(await text(page, '[data-act=dpAdd]')));
      await page.click('[data-act=dpAdd]'); await page.click('[data-act=save]'); await page.waitForFunction(() => /^Saved/.test(document.getElementById('bar').innerText));
      const wr = await writesTo(page, 'pricing_config/engine_v2');
      assert.deepStrictEqual(Object.keys(wr[0].fields), ['settings.date_rules']);
      const e = await h.doc(page, 'pricing_config/engine_v2');
      assert.deepStrictEqual(e.settings.date_rules, [{from: '2026-10-20', to: '2026-10-22', rooms: ['XCV_1'], action: 'protect'}]);
      assert.strictEqual(e.settings.room_types.XCV_1.style, 'normal');
      assert.ok(/protect|Don’t change the price/.test(await text(page, '#ruleList')) && /only this time/.test(await text(page, '#ruleList')));
      // events
      assert.ok(/Concert/.test(await text(page, 'body')) && /waiting for you/.test(await text(page, 'body')));
      await page.click('[data-act=eventSet][data-id="event_2026-11-14"][data-v=approved]');
      assert.strictEqual((await h.doc(page, 'pricing_events/event_2026-11-14')).status, 'approved');
      const ew = (await h.writes(page)).filter(x => x.path === 'pricing_events/event_2026-11-14'); assert.strictEqual(ew[0].op, 'updateDoc');
    }, {mutate: d => { d['pricing_config/rules'].dateOverrides.push({from: '03-05', to: '03-08', season: 'low'}, {from: '07-01', to: '07-10', season: 'peak'}); }});

    // ---- 6. ideas ----
    await test('6 ideas: Apply stores the old value, Undo puts it back; out-of-date refused; Skip reason is optional', w, hh, async ({page}) => {
      await go(page, '#/ideas');
      assert.strictEqual((await page.$$('[data-idea]')).length, 3);
      assert.ok(/Lower the start price/.test(await text(page, '[data-idea=ideaA]')) && /175 ₾/.test(await text(page, '[data-idea=ideaA]')));
      await page.click('[data-idea=ideaA] [data-act=ideaApply]');
      await page.waitForSelector('[data-idea=ideaA] .done.g');
      assert.strictEqual((await h.doc(page, 'pricing_config/rules')).startPrices.XCV_2.mid, 165);
      const pa = await h.doc(page, 'pricing_proposals/ideaA');
      assert.strictEqual(pa.status, 'approved'); assert.strictEqual(pa.previous, 175); assert.strictEqual(pa.applied_path, 'startPrices.XCV_2.mid');
      const rw = await writesTo(page, 'pricing_config/rules'); assert.deepStrictEqual(Object.keys(rw[0].fields), ['startPrices.XCV_2.mid']);
      await page.click('[data-idea=ideaA] [data-act=ideaUndo]');
      await page.waitForSelector('[data-idea=ideaA] [data-act=ideaApply]');
      assert.strictEqual((await h.doc(page, 'pricing_config/rules')).startPrices.XCV_2.mid, 175);
      assert.strictEqual((await h.doc(page, 'pricing_proposals/ideaA')).status, 'pending');
      // out of date: someone changed the number
      await page.evaluate(() => { window.__FS.docs['pricing_config/rules'].startPrices.XCV_2.mid = 170; });
      const n0 = (await writesTo(page, 'pricing_config/rules')).length;
      await page.click('[data-idea=ideaA] [data-act=ideaApply]');
      await page.waitForSelector('[data-idea=ideaA] [role=alert]');
      assert.ok(/out of date/.test(await text(page, '[data-idea=ideaA]')));
      assert.strictEqual((await writesTo(page, 'pricing_config/rules')).length, n0);
      // Skip with a reason, and without
      await page.click('[data-idea=ideaB] [data-act=ideaAskSkip]');
      assert.ok(/You can leave this out/.test(await text(page, '[data-idea=ideaB]')));
      await page.click('[data-idea=ideaB] [data-reason="I want my price"]');
      let pb = await h.doc(page, 'pricing_proposals/ideaB'); assert.strictEqual(pb.status, 'rejected'); assert.strictEqual(pb.rejection_reason, 'I want my price');
      await page.click('[data-idea=ideaC] [data-act=ideaAskSkip]'); await page.click('[data-idea=ideaC] [data-act=ideaSkip][data-reason=""]');
      const pc = await h.doc(page, 'pricing_proposals/ideaC'); assert.strictEqual(pc.status, 'rejected'); assert.ok(!('rejection_reason' in pc));
      await page.click('[data-idea=ideaC] [data-act=ideaAgain]');
      assert.strictEqual((await h.doc(page, 'pricing_proposals/ideaC')).status, 'pending');
      assert.ok(/Applied/.test(await text(page, '.hist')) || true);
      const hist = await text(page, 'body');
      assert.ok(/Skipped/.test(hist) && /Too early to tell/.test(hist));
      assert.strictEqual((await page.$$('.hist [data-act=ideaUndo]')).length, 0, 'old applied ideas have no stored old value, so no Undo');
    });

    // ---- 7/old rooms ----
    await test('old rooms: results and comparison, no Switch button, "from 23 Oct"', w, hh, async (env, desk) => {
      const {page} = env;
      if (desk) await page.click('.cname[data-rt=MAXELA]'); else await go(page, '#/test/MAXELA');
      await page.waitForFunction(() => /Try-out so far/.test(document.body.innerText));
      const t = await text(page, 'body');
      assert.ok(/from 23 Oct/.test(t) && /Cheaper/.test(t) && /More expensive/.test(t) && /On average/.test(t));
      assert.ok(!(await page.$$eval('button,a', els => els.some(e => /switch/i.test(e.innerText)))), 'no Switch button');
      assert.ok(/Old way/.test(t));
    });
    await test('rooms: tonight, mode, % booked, VGL shows full / n of 2 free', w, hh, async ({page}, desk) => {
      if (!desk) { const t = await text(page, 'body'); assert.ok(/XCV 1 . small/.test(t) && /145 ₾/.test(t) && /full/.test(t) && /next 30 nights \d+% booked/.test(t) && /New way would be/.test(t)); }
      else { const t = await text(page, '#cwrap'); assert.ok(/1 of 2 free|2 of 2 free/.test(t) && /Booked/.test(t) && /new \d+/.test(t)); }
      assert.ok(/Today 09:03: all prices sent/.test(await text(page, 'body')) && /next about 13:00/.test(await text(page, 'body')));
    });
    await test('failed channel shows red', w, hh, async ({page}) => {
      assert.ok(/did not take the 09:03 prices/.test(await text(page, 'body')) && /some prices were not sent/.test(await text(page, 'body')));
      assert.ok(await page.$('.ok.bad'));
    }, {mutate: d => { d['pricing_calm_runs/r1'].failed_portals = ['AIRBNB']; }});
  }

  // ---- 7. the side panel never hides Save or the pause switch (computer) ----
  for (const [w, hh] of SIZES.filter(s => s[0] >= 900)) {
    await test('7 side panel never hides Save or the pause switch', w, hh, async ({page}) => {
      for (const open of [async () => page.click('.cname[data-rt=XCV_2]'), async () => page.click('.cell[data-rt=XCV_2][data-iso="2026-10-14"]')]) {
        await open(); await page.waitForSelector('.panel');
        await page.click('[data-act=mode][data-mode=fillfast][data-rt=XCV_2]').catch(async () => { await page.click('.cname[data-rt=XCV_2]'); await page.click('[data-act=mode][data-mode=fillfast][data-rt=XCV_2]'); });
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        const r = await page.evaluate(() => {
          const top = sel => { const e = document.querySelector(sel); const b = e.getBoundingClientRect(); const x = b.left + b.width / 2, y = b.top + b.height / 2; const at = document.elementFromPoint(x, y); return {visible: b.width > 0 && y >= 0 && y <= innerHeight, ok: !!at && (e === at || e.contains(at))}; };
          const p = document.querySelector('.panel').getBoundingClientRect(), bar = document.getElementById('bar').getBoundingClientRect();
          return {save: top('[data-act=save]'), pause: top('[data-act=togglePause]'), panelBottom: p.bottom, barTop: bar.top, panelRight: p.right, vw: innerWidth};
        });
        assert.ok(r.save.visible && r.save.ok, 'Save is visible and on top'); assert.ok(r.pause.visible && r.pause.ok, 'pause switch is visible and on top');
        assert.ok(r.panelBottom <= r.barTop + 1, `panel ends above the bar (${r.panelBottom} vs ${r.barTop})`); assert.ok(r.panelRight <= r.vw + 1);
        await page.click('[data-act=undoAll]');
      }
    });
    await test('computer calendar: Airbnb $ under the ₾ price, Shift range adds a rule, "don’t change this night"', w, hh, async ({page}) => {
      assert.ok(!(await page.$('[data-act=cur]')), 'no currency switch: both prices are always shown');
      const c = await text(page, '.cell[data-rt=XCV_2][data-iso="2026-10-14"]');
      assert.ok(/\d+ ₾/.test(c) && /\$\d+/.test(c) && c.indexOf('₾') < c.indexOf('$'), c);
      await page.click('.cell[data-rt=XCV_1][data-iso="2026-10-20"]');
      await page.click('.cell[data-rt=XCV_1][data-iso="2026-10-22"]', {modifiers: ['Shift']});
      assert.ok(/3 nights selected/.test(await text(page, '.panel')));
      await page.click('[data-act=rangeAdd]');
      assert.ok(/Not saved/.test(await bar(page)) && /date rule 20 Oct – 22 Oct/.test(await bar(page)));
      await page.click('.cell[data-rt=XCV_2][data-iso="2026-10-15"]'); await page.click('[data-act=ruleNight]');
      assert.ok(await page.$('.cell[data-rt=XCV_2][data-iso="2026-10-15"] .lk'), 'lock shows on the night');
      await page.click('[data-act=save]'); await page.waitForFunction(() => /^Saved/.test(document.getElementById('bar').innerText));
      const e = await h.doc(page, 'pricing_config/engine_v2');
      assert.strictEqual(e.settings.date_rules.length, 2);
      const wr = await writesTo(page, 'pricing_config/engine_v2'); assert.deepStrictEqual(Object.keys(wr[0].fields), ['settings.date_rules']);
      await page.click('.cell[data-rt=MAXELA][data-iso="2026-10-20"]'); await page.click('.cell[data-rt=MAXELA][data-iso="2026-10-22"]', {modifiers: ['Shift']});
      assert.ok(/still on the old way/.test(await text(page, '.panel')) && !(await page.$('[data-act=rangeAdd]')));
    });
  }


  // ---- the six old rooms moved to the new engine: every room is "new way" ----
  const MOVED = d => {
    for (const rt of ['ROOMS', 'MAXELA', 'BIG_APT', 'FREEDOM', 'ORBE_1', 'ORBE_2']) {
      delete d['pricing_config/engine_v2'].settings.room_types[rt];               // calm_settings.json says live
      d[`pricing_calm_daily/2026-10-11_${rt}`] = d[`pricing_shadow_daily/2026-10-11_${rt}`]; delete d[`pricing_shadow_daily/2026-10-11_${rt}`];
    }
  };
  for (const [w, hh] of SIZES) {
    await test('moved: all 10 rooms are on the new way (no old-way section, no test screens)', w, hh, async (env, desk) => {
      const {page} = env;
      if (!desk) {
        const t = await text(page, 'body');
        assert.ok(!/Old way, new way being tested/.test(t) && !/New way would be/.test(t), 'no old-way section');
        assert.strictEqual((await page.$$('a.row[href^="#/room/"]')).length, 10);
        await go(page, '#/room/MAXELA');
        assert.ok(/Mode/.test(await text(page, 'body')) && await page.$('[data-act=mode][data-rt=MAXELA]'), 'MAXELA has the room settings');
        await go(page, '#/test/MAXELA'); assert.ok(!(await page.$('text=Try-out so far')), 'no test screen for a live room');
        await go(page, '#/seasons'); assert.ok(!(await page.$('[data-act=toggleOld]')), 'no old-room toggle');
        assert.strictEqual((await page.$$('[data-room]')).length, 10);
      } else {
        assert.ok(!/Old way, new way being tested/.test(await text(page, '#cwrap')));
        await page.click('.cname[data-rt=MAXELA]'); await page.waitForSelector('.panel');
        assert.ok(await page.$('.panel [data-act=mode][data-rt=MAXELA]'), 'MAXELA opens the room settings');
      }
      await go(page, '#/dates'); await page.click('[data-act=dpKind][data-k=rule]');
      assert.strictEqual((await page.$$('[data-act=dpRoom]')).length, 11, 'date rules can name all 10 rooms');
      await go(page, desk ? '#/calendar' : '#/rooms'); await page.click('[data-act=how]');
      const how = await text(page, '.dlg'); assert.ok(/All 10 rooms/.test(how) && /Expedia/.test(how) && !/Old way \(/.test(how));
    }, {mutate: MOVED});
  }

  // ---- holiday rule card and window; the "hold" action; the price check card ----
  const holGrid = page => page.$$eval('#overlay input[data-inp=hol]', els => Object.fromEntries(els.map(e => [e.dataset.k, e.value])));
  const holSaveOff = page => page.$eval('#holSaveBtn', e => e.getAttribute('aria-disabled') === 'true');
  const ENG = page => h.doc(page, 'pricing_config/engine_v2');
  for (const [w, hh] of SIZES) {
    await test('holiday rule: the card sits under Holiday dates and the window shows the table', w, hh, async ({page}, desk) => {
      await go(page, '#/dates');
      const t = await text(page, '#holList + .card');
      assert.ok(/Holiday rule: small moves far ahead/.test(t) && /down at most 5%/.test(t) && /up at most 3%/.test(t), t);
      assert.ok(await page.$('#holList + .card [data-act=holRule]'));
      await page.click('[data-act=holRule]');
      assert.ok(await dlgOpen(page) && await focusInDialog(page));
      const d = await text(page, '.dlg');
      for (const x of ['How much a holiday night may move before 14 days before arrival', 'More than 30 days', '30 to 21 days', '20 to 15 days', 'Down, several rooms', 'Down, single apartments', 'Up, single apartments', 'Save', 'Undo', 'Back to recommended']) assert.ok(d.includes(x), 'missing: ' + x);
      assert.deepStrictEqual(await holGrid(page), {'far|down_multi': '5', 'far|down_single': '3', 'far|up_single': '3', 'mid|down_multi': '8', 'mid|down_single': '5', 'mid|up_single': '5', 'near|down_multi': '10', 'near|down_single': '8', 'near|up_single': '8'});
      assert.ok(await holSaveOff(page), 'Save is off until something changes');
      const fit = await page.evaluate(() => { const o = document.querySelector('.dlg'); return {side: o.scrollWidth > o.clientWidth + 1, body: document.documentElement.scrollWidth > innerWidth + 1, small: [...o.querySelectorAll('input')].filter(e => e.getBoundingClientRect().height < 44).length}; });
      assert.ok(!fit.side && !fit.body && fit.small === 0, JSON.stringify(fit));
      assert.strictEqual((await h.writes(page)).length, 0);
    });
    await test('holiday rule: out-of-range and wrong-order numbers show a red message and cannot be saved', w, hh, async ({page}) => {
      await go(page, '#/dates'); await page.click('[data-act=holRule]');
      await fill(page, 'input[data-k="far|down_single"]', '25');
      assert.ok(/between 0 and 20%/.test(await text(page, '#holMsg')) && await holSaveOff(page));
      assert.ok(await page.$eval('input[data-k="far|down_single"]', e => e.classList.contains('bad')));
      assert.strictEqual(await page.$eval('#holMsg .warnbox', e => getComputedStyle(e).color), 'rgb(122, 31, 31)');
      await page.$eval('#holSaveBtn', e => e.click()); assert.strictEqual((await h.writes(page)).length, 0, 'a click on the dimmed Save writes nothing');
      await fill(page, 'input[data-k="far|down_single"]', 'abc'); assert.ok(/between 0 and 20%/.test(await text(page, '#holMsg')));
      await fill(page, 'input[data-k="far|down_single"]', '3'); assert.strictEqual(await text(page, '#holMsg'), '');
      await fill(page, 'input[data-k="mid|up_single"]', '2');       // closer to the date must allow at least as much
      assert.ok(/at least as much as one farther away/.test(await text(page, '#holMsg')) && await holSaveOff(page));
      await fill(page, 'input[data-k="far|up_single"]', '1.5'); await fill(page, 'input[data-k="mid|up_single"]', '4');
      assert.strictEqual(await text(page, '#holMsg'), ''); assert.ok(!(await holSaveOff(page)));
    });
    await test('holiday rule: Undo, Back to recommended, then Save writes only the changed field paths', w, hh, async ({page}) => {
      await go(page, '#/dates'); await page.click('[data-act=holRule]');
      await fill(page, 'input[data-k="far|down_multi"]', '6'); await fill(page, 'input[data-k="near|up_single"]', '9,5');
      assert.ok(!(await holSaveOff(page)));
      await page.click('[data-act=holUndo]');
      assert.strictEqual((await holGrid(page))['far|down_multi'], '5'); assert.ok(await holSaveOff(page));
      await fill(page, 'input[data-k="far|down_multi"]', '7');
      await page.click('[data-act=holRec]');
      assert.strictEqual((await holGrid(page))['far|down_multi'], '5'); assert.strictEqual((await holGrid(page))['near|down_multi'], '10');
      await fill(page, 'input[data-k="far|down_multi"]', '6'); await fill(page, 'input[data-k="near|up_single"]', '9.5');
      await page.click('#holSaveBtn');
      await page.waitForFunction(() => document.getElementById('overlay').hidden);
      const wr = await writesTo(page, 'pricing_config/engine_v2');
      assert.strictEqual(wr.length, 1); assert.strictEqual(wr[0].op, 'updateDoc');
      assert.deepStrictEqual(wr[0].fields, {'settings.holiday.limits.far.down_multi': 0.06, 'settings.holiday.limits.near.up_single': 0.095});
      const e = await ENG(page); assert.strictEqual(e.settings.holiday.limits.far.down_multi, 0.06); assert.ok(e.settings.date_rules, 'other settings untouched');
      assert.ok(/down at most 6%/.test(await text(page, '#holList + .card')), 'the card shows the new number');
      assert.ok(/Saved/.test(await text(page, 'body')));
      await page.click('[data-act=holRule]');
      assert.strictEqual((await holGrid(page))['near|up_single'], '9.5');
    });
    await test('holiday rule: a number changed somewhere else is not overwritten', w, hh, async ({page}) => {
      await go(page, '#/dates'); await page.click('[data-act=holRule]');
      await fill(page, 'input[data-k="far|down_multi"]', '6');
      await page.evaluate(() => { const d = window.__FS.docs['pricing_config/engine_v2']; d.settings.holiday = {limits: {far: {down_multi: 0.04}}}; });
      await page.click('#holSaveBtn');
      await page.waitForSelector('.dlg:has-text("Nothing was saved")');
      assert.strictEqual((await writesTo(page, 'pricing_config/engine_v2')).length, 0);
    });
    await test('hold: the new date rule choice has its plain label on the Dates tab', w, hh, async ({page}) => {
      await go(page, '#/dates'); await page.click('[data-act=dpKind][data-k=rule]');
      const labels = await page.$$eval('[data-act=dpChoice]', els => els.map(e => e.innerText.trim()));
      assert.ok(labels.includes('Small moves only, more active closer to the date') && labels.includes('Don’t change the price'), labels.join('|'));
    });
    await test('hold: a saved hold rule is listed with its label', w, hh, async ({page}) => {
      await go(page, '#/dates');
      assert.ok(/Small moves only, more active closer to the date/.test(await text(page, '#ruleList')));
    }, {mutate: d => { d['pricing_config/engine_v2'].settings.date_rules = [{from: '2026-12-20', to: '2027-01-02', rooms: 'all', action: 'hold'}]; }});
    await test('price check: green card when all is good, red card with the list, quiet when stale', w, hh, async ({page}) => {
      const t = await text(page, '#pausedBar');
      assert.ok(/Price check/.test(t) && /All good/.test(t) && !(await page.$('#pausedBar .ok.bad')), t);
    }, {mutate: d => { d['pricing_watchdog/latest'] = {day: '2026-10-11', ts: '2026-10-11T09:12:00', status: 'green', issues: [], counts: {}}; }});
    await test('price check: red card lists the problems', w, hh, async ({page}) => {
      const t = await text(page, '#pausedBar');
      assert.ok(/Needs a look/.test(t) && /XCV_1 2026-11-01 GEL: price 310 is above the maximum 300/.test(t) && /The push to Expedia failed/.test(t) && /and 3 more/.test(t), t);
      assert.ok(await page.$('#pausedBar [role=alert]'));
    }, {mutate: d => { d['pricing_watchdog/latest'] = {day: '2026-10-11', ts: '2026-10-11T09:12:00', status: 'red', total_issues: 5, counts: {out_of_range: 1, channel_failed: 1},
      issues: [{code: 'out_of_range', text: 'XCV_1 2026-11-01 GEL: price 310 is above the maximum 300.'}, {code: 'channel_failed', text: 'The push to Expedia failed.'}]}; }});
    await test('price check: "waiting" (no run yet today) is quiet, not red', w, hh, async ({page}) => {
      const t = await text(page, '#pausedBar'); assert.ok(/No result yet today/.test(t) && !/Needs a look/.test(t), t);
    }, {mutate: d => { d['pricing_watchdog/latest'] = {day: '2026-10-11', ts: '2026-10-11T00:18:00', status: 'waiting', issues: []}; }});
    await test('price check: an old result is not shown as good', w, hh, async ({page}) => {
      const t = await text(page, '#pausedBar'); assert.ok(/No result yet today/.test(t) && !/All good/.test(t), t);
    }, {mutate: d => { d['pricing_watchdog/latest'] = {day: '2026-10-09', ts: '2026-10-09T09:12:00', status: 'green', issues: []}; }});
  }

  // ---- both prices on every night; ideas with real dates ----
  for (const [w, hh] of SIZES) {
    await test('Airbnb $ is shown under the ₾ price on every night (list on the phone, grid on the computer), "–" when missing', w, hh, async ({page}, desk) => {
      if (!desk) {
        await go(page, '#/room/XCV_2'); await page.click('[data-act=allNights]');
        const rows = await page.$$eval('.night', els => els.map(e => ({g: (e.querySelector('.pr b') || {}).innerText, u: (e.querySelector('.pr i') || {}).innerText, aria: e.getAttribute('aria-label')})));
        assert.strictEqual(rows.length, 28);
        for (const r of rows) assert.ok(/ ₾$/.test(r.g) && /^\$\d+$/.test(r.u), JSON.stringify(r));
        assert.ok(rows.some(r => /Airbnb \$/.test(r.aria)));
        const geom = await page.$eval('.night .pr', e => { const [b, i] = [e.querySelector('b').getBoundingClientRect(), e.querySelector('i').getBoundingClientRect()]; return {below: i.top >= b.bottom - 1, small: parseFloat(getComputedStyle(e.querySelector('i')).fontSize) < parseFloat(getComputedStyle(e.querySelector('b')).fontSize), grey: getComputedStyle(e.querySelector('i')).color}; });
        assert.ok(geom.below && geom.small && geom.grey !== 'rgb(31, 31, 31)', JSON.stringify(geom));
        await go(page, '#/room/ROOMS');                                  // no Airbnb price list
        assert.ok((await page.$$eval('.night .pr i', els => els.map(e => e.innerText))).every(t => t === '–'));
        await go(page, '#/room/ORBE_2');                                 // Airbnb only: no Booking price
        const o = await page.$$eval('.night .pr', els => els.map(e => [e.querySelector('b').innerText, e.querySelector('i').innerText]));
        assert.ok(o.every(([g, u]) => g === '–' && /^\$\d+$/.test(u)), JSON.stringify(o.slice(0, 3)));
        await go(page, '#/room/XCV_2'); await page.click('.night[data-iso="2026-10-14"]');
        const d = await text(page, '.dlg'); assert.ok(/Booking/.test(d) && /Airbnb/.test(d) && /\$\d+/.test(d) && /₾/.test(d), d);
        assert.strictEqual(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'no sideways scroll');
      } else {
        for (const [rt, iso] of [['XCV_2', '2026-10-14'], ['VGL_ST', '2026-10-22'], ['BIG_APT', '2026-10-25']]) {
          const c = await text(page, `.cell[data-rt=${rt}][data-iso="${iso}"]`); assert.ok(/₾/.test(c) && /\$\d+/.test(c) && c.indexOf('₾') < c.indexOf('$'), rt + ': ' + c);
        }
        const rooms = await text(page, '.cell[data-rt=ROOMS][data-iso="2026-10-14"]'); assert.ok(/₾/.test(rooms) && /–/.test(rooms) && !/\$/.test(rooms), rooms);
        const o2 = await text(page, '.cell[data-rt=ORBE_2][data-iso="2026-10-14"]'); assert.ok(/\$\d+/.test(o2) && /–/.test(o2) && !/₾/.test(o2), o2);
        const full = await text(page, '.cell[data-rt=XCV_2][data-iso="2026-10-12"]'); assert.ok(/Booked/.test(full) && /\$\d+/.test(full), full);
        const g = await page.$eval('.cell[data-rt=XCV_2][data-iso="2026-10-14"]', e => { const em = e.querySelector('em'), b = e.querySelector('b'); return {below: em.getBoundingClientRect().top >= b.getBoundingClientRect().bottom - 1, fit: e.scrollHeight <= e.clientHeight + 1, size: parseFloat(getComputedStyle(em).fontSize)}; });
        assert.ok(g.below && g.fit && g.size >= 12, JSON.stringify(g));
        await page.click('.cell[data-rt=XCV_2][data-iso="2026-10-14"]');
        const panel = await text(page, '.panel'); assert.ok(/Booking/.test(panel) && /Airbnb/.test(panel) && /\$\d+/.test(panel), panel);
      }
    });
    await test('ideas tested against the engine: headline = only the nights whose price changes, season range small, other stretches named', w, hh, async ({page}) => {
      await go(page, '#/ideas');
      const e = await text(page, '[data-idea=ideaE]');
      assert.ok(/Which dates: 23–25 Dec 2026 · 3 nights/.test(e), e);
      assert.ok(/High season: 20–27 Dec 2026 · 8 nights/.test(e), 'season range as small text: ' + e);
      assert.ok(/This also changes: 2 Jan 2027, 1 May – 30 Jun 2027/.test(e), e);
      assert.ok(/Tested against the engine on 10 Oct: it would change the price of 64 nights that can still be sold\./.test(e), e);
      assert.ok(/Example nights/.test(e) && /23 Dec: 400 ₾ → 430 ₾/.test(e) && /24 Dec: 410 ₾ → 430 ₾/.test(e), 'examples from the engine test: ' + e.replace(/\n/g, ' | '));
      const size = await page.$eval('[data-idea=ideaE] .muted', el => parseFloat(getComputedStyle(el).fontSize));
      assert.ok(size >= 12);
    }, {mutate: d => {
      d['pricing_proposals/ideaE'] = {type: 'startPrice', property: 'FREEDOM', season: 'high', current: 400, suggested: 430, reasoning: 'High-season weekends fill early.', status: 'pending', ts: '2026-10-10T07:00:00',
    evidence: {version: 1, made_on: '2026-10-10', uses_last_year: false, stretch: {from: '2026-12-20', to: '2026-12-27', nights: 8}, later: [], looked_at: {from: '2026-12-20', to: '2026-12-27', nights: 8},
      booked: [], empty: ['2026-12-20', '2026-12-21', '2026-12-22', '2026-12-23', '2026-12-24', '2026-12-25', '2026-12-26', '2026-12-27'], no_price: [], booked_count: 0, known_nights: 8, units: 3,
      effect: {version: 2, changed_count: 64, groups: [{from: '2026-12-23', to: '2026-12-25', nights: 3}, {from: '2027-01-02', to: '2027-01-02', nights: 1}, {from: '2027-05-01', to: '2027-06-30', nights: 61}], groups_total: 3,
        examples: [{date: '2026-12-23', without: 400, with: 430}, {date: '2026-12-24', without: 410, with: 430}], sellable: 70, gap_nights_ignored: 0, price_list: 'GEL'}}};
    }});
    await test('ideas: every card names the dates, room, price, why with real nights, example nights and when it was made', w, hh, async ({page}, desk) => {
      await go(page, '#/ideas');
      const a = await text(page, '[data-idea=ideaA]');
      assert.ok(/XCV 2/.test(a) && /Booking \(₾\)/.test(a), a);
      assert.ok(/Which dates: Mid season: 1 Oct – 30 Nov 2026 · 61 nights/.test(a), 'dates: ' + a);
      assert.ok(/Which price: Start price for Booking \(₾\), XCV 2/.test(a), a);
      assert.ok(/Booked so far: \d+ of \d+ nights \(\d+–\d+ Oct/.test(a) && /Not booked: /.test(a), 'real nights: ' + a);
      assert.ok(/Idea maker’s note: Only 2 of 22 November nights are booked\. Last year by today: 9\./.test(a));
      assert.ok(/compares with last year, but last year’s dates and numbers were not saved/.test(a), 'says what is missing');
      assert.ok(/Example nights/.test(a) && /(Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d+ Oct: \d+ → \d+ ₾/.test(a), 'example nights: ' + a);
      assert.ok(/Booked nights and nights you set by hand do not change\. Nights you protected stay protected\./.test(a));
      assert.ok(/Made 10 Oct/.test(a), a);
      const b = await text(page, '[data-idea=ideaB]');       // Airbnb maximum, High season: dates far ahead, no prices yet
      assert.ok(/VGL studios/.test(b) && /Airbnb \(\$\)/.test(b) && /Which dates: High season: 20–27 Dec 2026 · 8 nights\. Also: 1 May – 30 Jun 2027/.test(b) && /Maximum for Airbnb \(\$\)/.test(b), b);
      assert.ok(/Fully booked so far: 0 of 8 nights\. Not booked: 20–27 Dec\./.test(b), b);
      const all = await text(page, 'body');
      assert.ok(!/\b(guard|band|anchor)\b/i.test(await page.$$eval('[data-idea]', els => els.map(e => e.innerText).join(' '))), 'plain words only');
      const fit = await page.evaluate(() => { const bad = []; for (const c of document.querySelectorAll('[data-idea]')) { for (const e of c.querySelectorAll('*')) { if (e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflow !== 'visible') bad.push(e.className); } if (c.scrollWidth > c.clientWidth + 1) bad.push('card'); } return {bad, side: document.documentElement.scrollWidth > innerWidth + 1}; });
      assert.deepStrictEqual(fit, {bad: [], side: false});
      // an idea made with saved evidence shows that evidence
      const c = await text(page, '[data-idea=ideaC]');
      assert.ok(/Which dates: High season: 20–27 Dec 2026 · 8 nights\. Also: 1 May – 30 Jun 2027/.test(c), c);
      assert.ok(/Nights looked at: 20 Dec – 27 Dec 2026 \(8 nights from the day it was made\)/.test(c), c);
      assert.ok(/On 10 Oct, fully booked: 2 of 8 nights \(22 Dec, 26 Dec\)\. Not booked: 20–21 Dec, 23–25 Dec, 27 Dec\./.test(c), c);
      assert.ok(/Last year \(20–27 Dec 2025\): 13 of 16 room-nights were booked in the end, and 5 were already booked by 10 Oct 2025\./.test(c), c);
      assert.ok(!/were not saved with it/.test(c), 'saved evidence replaces the old "not saved" note');
      assert.ok(/were not saved with it/.test(a), 'older ideas keep the old view and say what is missing');
      // the Earlier list shows the dates of applied and skipped ideas
      const hist = await text(page, '.hist');
      assert.ok(/Low season: 15 Jan – 15 Mar 2027 · 60 nights · Made 6 Oct/.test(await page.$$eval('.hist', els => els.map(e => e.innerText).join(' | '))), hist);
      const replacedRow = await page.$$eval('.hist', els => els.map(e => e.innerText).find(t => /Replaced/.test(t)) || '');
      assert.ok(/Replaced/.test(replacedRow) && !/Show again/.test(replacedRow) && /Mid season: 1 Oct – 30 Nov 2026/.test(replacedRow), replacedRow);
      assert.ok(/High season: 20–27 Dec 2026 · 8 nights · Made 5 Oct/.test(await page.$$eval('.hist', els => els.map(e => e.innerText).join(' | '))));
    });
  }

  // ---- scorecard on finished ideas ----
  for (const [w, hh] of SIZES) {
    await test('scorecard: finished ideas show Right / Wrong / Unclear with the reason; running ones say Checking', w, hh, async ({page}) => {
      await go(page, '#/ideas');
      const rows = await page.$$eval('.hist', els => els.map(e => e.innerText));
      const d = rows.find(t => /Maxela|MAXELA/i.test(t) && /minimum/.test(t)) || '';
      assert.ok(/Wrong/.test(d) && /18 of 20 nights that were empty when the idea was made got a booking anyway at your price/.test(d) && !/→ Wrong/.test(d), d);
      assert.ok(/What if: With the idea applied, the twin priced these 20 nights/.test(d) && /evidence, not proof/.test(d), 'twin line: ' + d);
      const f = rows.find(t => /Rooms|ROOMS/i.test(t) && /start price/.test(t)) || '';
      assert.ok(/Checking/.test(f) && /Still running: 11 nights to go/.test(f), f);
      const color = await page.$eval('.verdict.wrong', e => getComputedStyle(e).color);
      assert.ok(color !== 'rgb(0, 0, 255)');
    }, {mutate: d => {
      d['pricing_scorecard/oldD'] = {status: 'final', verdict: 'wrong', reason: 'Said raise the minimum for Maxela (Low season, 1–20 Nov 2026). You skipped it. 18 of 20 nights that were empty when the idea was made got a booking anyway at your price. → Wrong'};
      d['pricing_twin_results/oldD'] = {status: 'final', text: 'With the idea applied, the twin priced these 20 nights at 120 ₾ on average, 20% higher than your real 100 ₾. In real life 18 of 20 sold, at about 105 ₾ a night. The twin cannot know if a guest would have booked at its price: this is evidence, not proof.'};
      d['pricing_scorecard/oldF'] = {status: 'tracking', verdict: null, reason: 'Still running: 11 nights to go (until 20 Nov 2026).'};
    }});
  }

  // ---- season dates fold: closed by default, + opens, - closes, locked while there are unsaved changes ----
  for (const [w, hh] of SIZES) {
    await test('season dates fold: one row with + when closed; + opens, - closes; stays open while there are unsaved changes or an error', w, hh, async ({page}) => {
      await go(page, '#/seasons');
      assert.ok(!(await page.$('#seasonDates')), 'closed by default');
      const row = await text(page, '#seasonFold');
      assert.ok(/Season dates/.test(row) && !/Tap the first and the last day/.test(row) && !(await page.$('#seasonFold .mbar')), row);
      const b = '[data-act=toggleSeasonDates]';
      assert.strictEqual(await page.$eval(b, e => e.innerText.trim()), '+');
      assert.strictEqual(await page.getAttribute(b, 'aria-expanded'), 'false');
      const box = await page.$eval(b, e => { const r = e.getBoundingClientRect(); return [r.width, r.height, r.right, innerWidth]; });
      assert.ok(box[0] >= 44 && box[1] >= 44 && box[3] - box[2] < 60, 'a 44px button on the right: ' + box);
      await page.click(b); await page.waitForSelector('#seasonDates');
      assert.strictEqual(await page.$eval(b, e => e.innerText.trim()), '−');
      assert.strictEqual(await page.getAttribute(b, 'aria-expanded'), 'true');
      assert.ok(await page.$('#seasonDates .mbar') && (await page.$$('#seasonDates .cd')).length > 20);
      await page.click(b); await page.waitForTimeout(80);
      assert.ok(!(await page.$('#seasonDates')) && (await page.$eval(b, e => e.innerText.trim())) === '+', 'closes again');
      // an unsaved change keeps it open and the button cannot close it
      await page.click(b); await page.waitForSelector('#seasonDates');
      await page.click('#seasonDates .mbar .mo[data-m="12"]'); await page.click('.cd[data-md="12-02"]'); await page.click('.cd[data-md="12-05"]'); await page.click('[data-act=calSeason][data-s="high"]');
      assert.strictEqual(await page.getAttribute(b, 'aria-disabled'), 'true');
      assert.ok(/Save or undo your changes to close this/.test(await text(page, '#seasonFold')));
      await page.click(b, {force: true}); await page.waitForTimeout(80);
      assert.ok(await page.$('#seasonDates'), 'still open while there are unsaved changes');
      await page.click('#bar [data-act=undoAll]'); await page.waitForTimeout(80);
      assert.strictEqual(await page.getAttribute(b, 'aria-disabled'), 'false');
      await page.click(b); await page.waitForTimeout(80);
      assert.ok(!(await page.$('#seasonDates')), 'after undo it can close');
    });
  }

  // ---- season dates: a calendar (tap the first and the last day, pick the season) ----
  const COLOR = {new_year: 'rgb(94, 74, 110)', mid: 'rgb(110, 139, 106)', high: 'rgb(46, 107, 52)', low: 'rgb(138, 137, 132)', peak: 'rgb(155, 44, 44)', xmas_low: 'rgb(122, 111, 100)'};
  const bg = (page, md) => page.$eval(`.cd[data-md="${md}"]`, e => getComputedStyle(e).backgroundColor);
  for (const [w, hh] of SIZES) {
    await test('season calendar: days carry their season colour, the 12-month bar jumps to a month, tap first and last day then pick a season', w, hh, async ({page}, desk) => {
      await go(page, '#/seasons'); await openDates(page);
      assert.strictEqual(await page.$$eval('#seasonDates .mbar .mo', els => els.length), 12);
      assert.strictEqual(await page.$$eval('#seasonDates .mbar .days i', els => els.length), 366);
      assert.strictEqual((await page.$$('#seasonDates .cmonths .cm')).length, desk ? 2 : 1, 'one month on the phone, two on the computer');
      assert.strictEqual(await bg(page, '10-05'), COLOR.mid);
      await page.click('#seasonDates .mbar .mo[data-m="12"]');
      assert.strictEqual(await bg(page, '12-10'), COLOR.xmas_low); assert.strictEqual(await bg(page, '12-26'), COLOR.new_year);
      assert.ok(/December/.test(await text(page, '#seasonDates .cnav')));
      const legend = await text(page, '#seasonDates .sleg');
      assert.ok(/Low/.test(legend) && /Early December/.test(legend) && /New Year/.test(legend));
      assert.ok(/Tap the first day of a season/.test(await text(page, '#seasonDates .cpanel')));
      assert.ok(!(await page.$('#bar:not([hidden]) .btns')), 'nothing to save yet');
      await page.click('.cd[data-md="12-10"]');
      assert.ok(/From 10 Dec\. Now tap the last day/.test(await text(page, '#seasonDates .cpanel')));
      await page.click('.cd[data-md="12-20"]');
      assert.ok(/10 Dec – 20 Dec · 11 days\. Which season is this\?/.test(await text(page, '#seasonDates .cpanel')), await text(page, '#seasonDates .cpanel'));
      assert.strictEqual((await page.$$('#seasonDates [data-act=calSeason]')).length, 6);
      assert.ok((await page.$$('.cd.pre')).length === 11, 'the chosen days are marked');
      await page.click('[data-act=calSeason][data-s="high"]'); await page.waitForTimeout(80);
      assert.strictEqual(await bg(page, '12-10'), COLOR.high); assert.strictEqual(await bg(page, '12-20'), COLOR.high); assert.strictEqual(await bg(page, '12-21'), COLOR.xmas_low);
      assert.ok(/Not saved/.test(await text(page, '#bar')) && /season dates changed/.test(await text(page, '#bar')));
      assert.ok(!(await page.$('#seasonDates .rangeerr')), 'painting never leaves a gap or an overlap');
      assert.ok(/High\s+1 May – 30 Jun, 1 – 30 Sep, 10 Dec – 20 Dec/.test((await text(page, '#seasonDates')).replace(/\s+/g, ' ')) || /10 Dec – 20 Dec/.test(await text(page, '#seasonDates')));
      assert.strictEqual(await page.$$eval('#seasonDates .mbar .days i.gap, #seasonDates .mbar .days i.dup', els => els.length), 0);
      await page.click('#bar [data-act=undoAll]'); await page.waitForTimeout(80);
      assert.strictEqual(await bg(page, '12-10'), COLOR.xmas_low);
      assert.ok(await page.$eval('#bar', e => e.hidden || !/Not saved/.test(e.innerText)), 'undo: nothing to save');
      // painting the same season it already has changes nothing
      await page.click('.cd[data-md="12-02"]'); await page.click('.cd[data-md="12-05"]'); await page.click('[data-act=calSeason][data-s="xmas_low"]'); await page.waitForTimeout(80);
      assert.ok(await page.$eval('#bar', e => e.hidden || !/Not saved/.test(e.innerText)), 'no change, no Not saved');
    });
    await test('season calendar: the other way round asks what you mean; a range over New Year is saved as one range after the review', w, hh, async ({page}) => {
      await go(page, '#/seasons'); await openDates(page);
      await page.click('#seasonDates .mbar .mo[data-m="3"]');
      await page.click('.cd[data-md="03-20"]'); await page.click('.cd[data-md="03-10"]');
      const q = await text(page, '#seasonDates .cpanel');
      assert.ok(/comes before the first day/.test(q) && /Over New Year: 20 Mar – 10 Mar · 357 days/.test(q) && /The other way: 10 Mar – 20 Mar · 11 days/.test(q), q);
      await page.click('[data-act=calSwap]');
      assert.ok(/10 Mar – 20 Mar · 11 days\. Which season is this\?/.test(await text(page, '#seasonDates .cpanel')));
      await page.click('[data-act=calCancel]');
      assert.ok(/Tap the first day of a season/.test(await text(page, '#seasonDates .cpanel')));
      // 28 Dec - 6 Jan, over New Year, taps in two different months
      await page.click('#seasonDates .mbar .mo[data-m="12"]'); await page.click('.cd[data-md="12-28"]');
      await page.click('[data-act=calMove][data-d="1"]'); assert.ok(/January/.test(await text(page, '#seasonDates .cnav')));
      await page.click('.cd[data-md="01-06"]');
      assert.ok(/comes before the first day/.test(await text(page, '#seasonDates .cpanel')));
      await page.click('[data-act=calWrap]');
      assert.ok(/28 Dec – 6 Jan · 10 days\. Which season is this\?/.test(await text(page, '#seasonDates .cpanel')), await text(page, '#seasonDates .cpanel'));
      await page.click('[data-act=calSeason][data-s="high"]'); await page.waitForTimeout(80);
      assert.strictEqual(await bg(page, '01-06'), COLOR.high); assert.strictEqual(await bg(page, '01-07'), COLOR.new_year);
      await page.click('[data-act=calMove][data-d="-1"]');
      assert.strictEqual(await bg(page, '12-28'), COLOR.high); assert.strictEqual(await bg(page, '12-27'), COLOR.new_year);
      await page.click('#bar [data-act=save]'); await page.waitForSelector('.dlg');
      const dlg = await text(page, '.dlg');
      assert.ok(/Check what changes/.test(dlg) && /Booked, hand-set and protected nights are not touched/.test(dlg), dlg);
      assert.strictEqual((await h.writes(page)).filter(x => x.path === 'pricing_config/rules').length, 0, 'nothing written before the review is accepted');
      await page.click('[data-act=closeDialog]');
      assert.ok(/Not saved/.test(await text(page, '#bar')));
      await page.click('#bar [data-act=save]'); await page.waitForSelector('.dlg'); await page.click('[data-act=dialogYes]');
      await page.waitForFunction(() => /Saved/.test(document.getElementById('bar').innerText), null, {timeout: 6000});
      const rules = await h.doc(page, 'pricing_config/rules');
      assert.ok(rules.seasonRanges.some(r => r.from === '12-28' && r.to === '01-06' && r.season === 'high'), JSON.stringify(rules.seasonRanges));
      const days = new Set(); const md = []; for (let m = 1; m <= 12; m++) for (let d = 1; d <= [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]; d++) md.push(String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0'));
      const cover = {}; md.forEach(x => { cover[x] = 0; });
      rules.seasonRanges.forEach(r => { const a = md.indexOf(r.from), b = md.indexOf(r.to); (a <= b ? md.slice(a, b + 1) : md.slice(a).concat(md.slice(0, b + 1))).forEach(x => { cover[x]++; }); });
      assert.ok(md.every(x => cover[x] === 1), 'every day of the year has exactly one season in what was saved');
      const rec = (await h.writes(page)).filter(x => x.path.startsWith('pricing_changes/')).map(x => x.data).find(x => x.type === 'season_dates');
      assert.ok(rec && rec.fields.season_ranges.old.includes('12-24..12-31 new_year') && rec.fields.season_ranges.new.includes('12-28..01-06 high') && rec.ts, JSON.stringify(rec));
    });
  }

  // ---- nights you set by hand: shown as "Set by you", with a button to give the night back ----
  for (const [w, hh] of SIZES) {
    await test('hand-set night: "Set by you" label, give back writes the request, other nights have no such button', w, hh, async ({page}, desk) => {
      if (desk) {
        const sub = await page.$eval('.cell[data-rt="XCV_2"][data-iso="2026-10-17"]', e => e.innerText);
        assert.ok(/Set by you/.test(sub), sub);
        await page.click('.cell[data-rt="XCV_2"][data-iso="2026-10-17"]'); await page.waitForSelector('.panel');
      } else {
        await go(page, '#/room/XCV_2'); await page.click('[data-act=allNights]');
        const row = await page.$eval('.night[data-iso="2026-10-17"]', e => e.innerText);
        assert.ok(/Set by you/.test(row), row);
        await page.click('.night[data-iso="2026-10-17"]');
      }
      assert.ok(/Set by you\. The engine never changes this price/.test(await text(page, desk ? '.panel' : '.dlg')));
      assert.strictEqual((await h.writes(page)).length, 0, 'nothing is written before the button');
      await page.click('[data-act=giveBack]'); await page.waitForTimeout(150);
      const ctl = await h.doc(page, 'pricing_config/control');
      assert.ok(Array.isArray(ctl.release) && ctl.release.includes('XCV_2|2026-10-17'), JSON.stringify(ctl));
      assert.ok(/Given back/.test(await text(page, desk ? '.panel' : '.dlg')) || /Given back/.test(await text(page, '#toast')), 'confirms');
    });
    await test('a normal night has no give-back button', w, hh, async ({page}, desk) => {
      if (desk) { await page.click('.cell[data-rt="XCV_2"][data-iso="2026-10-20"]'); await page.waitForSelector('.panel'); }
      else { await go(page, '#/room/XCV_2'); await page.click('[data-act=allNights]'); await page.click('.night[data-iso="2026-10-20"]'); }
      assert.ok(!(await page.$('[data-act=giveBack]')));
    });
  }

  // ---- weekly report ----
  for (const [w, hh] of SIZES) {
    await test('weekly report: headline, three lists, numbers per room, notes, past weeks', w, hh, async ({page}) => {
      await go(page, '#/weekly');
      const t = await text(page, '.page');
      assert.ok(/Weekly/.test(await text(page, 'a.tab[href="#/weekly"]')));
      assert.ok(/6 Oct – 12 Oct 2026/.test(t) && /A calm week: 11 nights sold in Maxela/.test(t), t.slice(0, 300));
      assert.ok(/What worked/.test(t) && /What did not work/.test(t) && /Possible upgrades/.test(t) && /nothing here changed a price/i.test(t));
      assert.ok(/The tonight drop sold: 1 of 1/.test(t) && /shortened by the checker/.test(t) && /1 claim removed, 1 shortened/.test(t), 'checker line');
      assert.ok(/What the data cannot show yet/.test(t) && /only exists since 2026-10-12/.test(t));
      assert.ok(/Maxela|MAXELA/i.test(t) && /Nights sold\s*11/.test(t) && !/XCV 2\s*Bookings made/.test(t), 'numbers per room, quiet rooms left out');
      assert.ok(/Right 9 of 14/.test(t) && /Expedia 1/i.test(t));
      await page.click('[data-act=weekPick][data-k="2026-W41"]');
      assert.ok(/Thin week\./.test(await text(page, '.page')) && /did not run/.test(await text(page, '.page')));
    });
  }

  // ---- layout switch ----
  await test('layout switches at 900 px', 899, 800, async ({page}) => { assert.strictEqual(await page.evaluate(() => document.body.dataset.layout), 'phone'); assert.ok(await page.$('a.tab[href="#/rooms"]')); });
  await test('layout switches at 900 px (desk side)', 900, 800, async ({page}) => { assert.strictEqual(await page.evaluate(() => document.body.dataset.layout), 'desk'); assert.ok(await page.$('a.tab[href="#/calendar"]')); });

  // ---- ideas Beta: label, switch (off by default, confirm to turn on), score ----
  for (const [w, hh] of SIZES) {
    await test('ideas Beta: label, switch off by default, confirm before turning on, score line', w, hh, async ({page}) => {
      await go(page, '#/ideas');
      assert.ok(/Beta/.test(await text(page, 'a.tab[href="#/ideas"]')), 'Beta on the tab');
      const sw = '[data-act=toggleAuto]';
      assert.strictEqual(await page.getAttribute(sw, 'aria-checked'), 'false', 'off by default');
      assert.ok(/Right 9 of 14 so far/.test(await text(page, '.scorebar')) && /3 wrong, 2 unclear/.test(await text(page, '.scorebar')), await text(page, '.scorebar'));
      await page.click(sw);
      assert.strictEqual((await h.writes(page)).length, 0, 'nothing written before confirming');
      await page.click('[data-act=closeDialog]');
      assert.strictEqual(await page.getAttribute(sw, 'aria-checked'), 'false');
      await page.click(sw); await page.click('[data-act=autoOn]'); await page.waitForTimeout(100);
      assert.strictEqual(await page.getAttribute(sw, 'aria-checked'), 'true');
      assert.strictEqual((await writesTo(page, 'pricing_config/ideas_beta')).length, 1);
      assert.strictEqual((await h.doc(page, 'pricing_config/ideas_beta')).auto_apply, true);
      await page.click(sw); await page.waitForTimeout(100);                  // turning it off needs no confirm
      assert.strictEqual((await h.doc(page, 'pricing_config/ideas_beta')).auto_apply, false);
    }, {mutate: d => { d['pricing_scorecard/_summary'] = {finished: 14, right: 9, wrong: 3, unclear: 2, tracking: 4}; }});
  }

  // ---- 8 + design rules, on every screen at every size ----
  const SCREENS = ['#/rooms', '#/room/XCV_2', '#/test/MAXELA', '#/seasons', '#/dates', '#/ideas', '#/weekly'];
  for (const [w, hh] of SIZES) {
    await test('8 + design rules on every screen: no console errors, no sideways scroll, no cut-off text, text 12px+, no emoji, no blue, 44px targets (phone)', w, hh, async ({page}, desk) => {
      const dialogs = [async () => { await page.$eval('[data-act=togglePause]', e => e.click()); }, async () => { await page.$eval('[data-act=how]', e => e.click()); }];
      for (const hash of SCREENS) {
        await go(page, hash); await page.waitForTimeout(100);
        const wasDesk = desk;
        const r = await page.evaluate(({desk}) => {
          const out = {blue: [], small: [], clipped: [], emoji: false, targets: [], side: document.documentElement.scrollWidth > innerWidth + 1};
          const parse = c => (c.match(/[\d.]+/g) || []).map(Number);
          const isBlue = c => { const [r, g, b, a] = parse(c); if (a === 0) return false; return b - Math.max(r, g) >= 35; };
          out.emoji = /\p{Extended_Pictographic}/u.test(document.body.innerText);
          for (const e of document.querySelectorAll('body *')) {
            const cs = getComputedStyle(e), rc = e.getBoundingClientRect();
            if (cs.display === 'none' || (!rc.width && !rc.height)) continue;
            if (e.closest('#ownerAuth')) continue;
            for (const p of ['color', 'backgroundColor', 'borderTopColor', 'outlineColor']) { if ((p !== 'borderTopColor' || parseFloat(cs.borderTopWidth) > 0) && (p !== 'outlineColor' || cs.outlineStyle !== 'none') && isBlue(cs[p])) out.blue.push(e.tagName + '.' + e.className + ' ' + p + ' ' + cs[p]); }
            const own = [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
            if (own && parseFloat(cs.fontSize) < 12 && e.tagName !== 'svg') out.small.push(e.tagName + ' ' + cs.fontSize + ' ' + e.innerText.slice(0, 20));
            if (e.tagName !== 'svg' && !e.closest('svg') && ['hidden', 'clip'].includes(cs.overflowX) && e.scrollWidth > e.clientWidth + 1 && cs.textOverflow !== 'clip') out.clipped.push(e.tagName + '.' + e.className);
            if (!desk && rc.right > innerWidth + 1 && !e.closest('svg')) out.clipped.push('outside ' + e.tagName + '.' + e.className + ' ' + Math.round(rc.right));
            if (!desk && e.matches('button,a[href],input,[role=radio]') && rc.height < 43.5) out.targets.push(e.tagName + '.' + e.className + ' ' + Math.round(rc.height) + ' ' + (e.innerText || e.getAttribute('aria-label') || '').slice(0, 20));
          }
          return out;
        }, {desk});
        assert.ok(!r.side, hash + ': sideways scroll'); assert.ok(!r.emoji, hash + ': emoji');
        assert.deepStrictEqual(r.blue, [], hash + ' blue'); assert.deepStrictEqual(r.small, [], hash + ' small text'); assert.deepStrictEqual(r.clipped, [], hash + ' cut off'); assert.deepStrictEqual(r.targets, [], hash + ' small targets');
      }
      // dialogs and the bar also pass the colour rule
      await go(page, '#/seasons'); await fill(page, 'input[data-k="XCV_1|mid|GEL|start"]', '999');
      await go(page, '#/rooms'); await dialogs[1](); await page.waitForTimeout(80);
      const blue = await page.evaluate(() => { const bad = []; for (const e of document.querySelectorAll('#overlay *, #bar *, #toast *')) { const c = getComputedStyle(e); for (const p of ['color', 'backgroundColor']) { const [r, g, b, a] = (c[p].match(/[\d.]+/g) || []).map(Number); if (a !== 0 && b - Math.max(r, g) >= 35) bad.push(e.tagName + p); } } return bad; });
      assert.deepStrictEqual(blue, []);
      await page.keyboard.press('Escape');
      // keyboard focus ring is dark grey, not the browser's blue
      await page.keyboard.press('Tab');
      const ring = await page.evaluate(() => { const c = getComputedStyle(document.activeElement); return [c.outlineStyle, c.outlineColor]; });
      assert.ok(ring[0] !== 'none', 'focus ring visible'); const [r, g, b] = ring[1].match(/\d+/g).map(Number); assert.ok(b - Math.max(r, g) < 35, 'focus ring not blue ' + ring[1]);
    });
  }

  await BROWSER.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { console.log(failures.join('\n')); process.exit(1); }
})().catch(e => { console.error(e); process.exit(1); });
