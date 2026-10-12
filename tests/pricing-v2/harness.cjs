const fs = require('fs'), path = require('path');
const stubs = require('./stubs.cjs');
const {seedDocs, NOW_ISO} = require('./seed.cjs');
const ROOT = path.resolve(__dirname, '../..');
const MIME = {'.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css'};

async function open(browser, {width, height, hash = '', mutate, failPaths = []}) {
  const desk = width >= 900;
  const ctx = await browser.newContext({viewport: {width, height}, hasTouch: !desk, isMobile: !desk});
  const page = await ctx.newPage();
  const logs = [], blocked = [];
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') logs.push(m.type() + ': ' + m.text()); });
  page.on('pageerror', e => logs.push('PAGEERROR: ' + e.message));
  await page.route(/^https?:\/\/(?!test\.local)/, r => {
    const u = r.request().url();
    if (u.includes('gstatic.com/firebasejs')) {
      const body = u.includes('firebase-app') ? stubs.APP : u.includes('firebase-auth') ? stubs.AUTH : u.includes('firebase-firestore') ? stubs.FS : null;
      if (body) return r.fulfill({contentType: 'text/javascript', body});
    }
    blocked.push(u); return r.abort();
  });
  await page.route('http://test.local/**', r => {
    const p = new URL(r.request().url()).pathname, f = ROOT + p;
    if (fs.existsSync(f) && fs.statSync(f).isFile()) return r.fulfill({body: fs.readFileSync(f), contentType: MIME[path.extname(f)] || 'application/octet-stream'});
    return r.fulfill({status: 404, body: ''});
  });
  const docs = seedDocs();
  if (mutate) mutate(docs);
  await page.addInitScript(([d, iso, fail]) => {
    window.__PRICING_NOW = iso;
    const rev = o => { for (const k of Object.keys(o)) { const v = o[k]; if (v && typeof v === 'object' && v.__date) o[k] = new Date(v.__date); else if (v && typeof v === 'object') rev(v); } };
    rev(d);
    window.__FS = {docs: d, writes: [], fail, reads: []};
  }, [JSON.parse(JSON.stringify(docs, (k, v) => (v instanceof Date ? {__date: v.toISOString()} : v))), NOW_ISO, failPaths]);
  await page.goto('http://test.local/pricing-v2.html' + hash);
  await page.waitForFunction(() => window.__pricingReady === true, null, {timeout: 20000});
  return {ctx, page, logs, blocked};
}
const writes = page => page.evaluate(() => window.__FS.writes);
const doc = (page, p) => page.evaluate(p => window.__FS.docs[p], p);
module.exports = {open, writes, doc};
