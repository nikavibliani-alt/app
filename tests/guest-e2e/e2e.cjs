const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const fs = require('fs');
const assert = require('assert');
const stubs = require('./stubs.cjs');
const api = require('../../pipeline-functions/controllers/guestApi.js');
const regc = require('../../pipeline-functions/controllers/guestRegister.js');
const proof = require('../../pipeline-functions/lib/guest-proof.js');
const SECRET = 'e2e-secret';
const ROOT = require('path').join(__dirname, '../..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };

const SEED = () => ({
  'reservations/007004961_001': { reservationNumber: '007004961_001', roomCode: '6-1', checkin: '2026-10-12', checkout: '2026-10-15', status: 'OK', guest: 'Ahmed Ali', phone: '+995 555 111 222', email: 'ahmed@example.com', bookingId: 'HMABC12345', source: 'booking', tuyaPassword: '482913' },
  'reservations/007005000_001': { reservationNumber: '007005000_001', roomCode: 'tab-1', checkin: '2026-10-12', checkout: '2026-10-14', status: 'OK', guest: 'Maria Garcia', phone: '+34 600 000 000', email: 'maria@example.com', bookingId: 'HMZZZ99999', source: 'booking', tuyaPassword: '135790' },
  'checkin_apartments/6-1': { propertyName: 'Maxela 6-1', address: '1 Test St', floorLabel: 'Floor 6', checkInTime: '15:00', checkOutTime: '12:00', doorCode: '4321#', wifiName: 'MaxelaWifi', wifiPass: 'secretwifi', instructions: 'Use the code at the door', photos: [], photoCaptions: [], tuyaDeviceId: 'DEV123' },
  'checkin_apartments/tab-1': { propertyName: 'Freedom 1', address: '2 Test St', checkInTime: '14:00', doorCode: '5555#', wifiName: 'W3', wifiPass: 'p3' },
  'globals/elevator_code': { code: '2468', updatedAt: { seconds: 1760245200, nanoseconds: 0 } },
  'checkin_admin/config': {},
});
const SECRET_STRINGS = ['4321', 'MaxelaWifi', 'secretwifi', '482913', 'DEV123', '2468', '5555', '135790', 'Maria', 'ahmed@example.com', '555 111'];
// a tiny valid JPEG
const TINY_JPG = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');

function tbilisi(iso) { const tb = new Date(new Date(iso).getTime() + 4 * 3600e3); return { today: tb.toISOString().slice(0, 10), hour: tb.getUTCHours() }; }

async function open(browser, { apiOn, startIso, viewport }) {
  const ctx = await browser.newContext({ viewport: viewport || { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  const logs = [], calls = [], blocked = [];
  const state = { counters: {}, failures: [], clock: tbilisi(startIso) };
  page.on('console', m => logs.push(m.type() + ': ' + m.text()));
  page.on('pageerror', e => logs.push('PAGEERROR: ' + e.message));
  await page.route(/^https?:\/\/(?!test\.local)/, r => {
    const u = r.request().url();
    if (u.includes('gstatic.com/firebasejs')) {
      const body = u.includes('firebase-firestore') ? stubs.FS : u.includes('firebase-storage') ? stubs.STORAGE : u.includes('firebase-functions') ? stubs.FUNCTIONS : u.includes('firebase-app') ? stubs.APP : null;
      if (body) return r.fulfill({ contentType: 'text/javascript', body });
    }
    blocked.push(u); return r.abort();
  });
  await page.route('http://test.local/**', r => {
    const p = new URL(r.request().url()).pathname;
    const f = ROOT + p;
    if (fs.existsSync(f) && fs.statSync(f).isFile()) return r.fulfill({ body: fs.readFileSync(f), contentType: MIME[require('path').extname(f)] || 'application/octet-stream' });
    return r.fulfill({ status: 404, body: '' });
  });
  await page.addInitScript(stubs.CLOCK);
  await page.addInitScript(([seed, iso]) => { window.__DB = { docs: seed, listeners: [], calls: [], uploads: [] }; window.__setClock(iso); }, [SEED(), startIso]);

  const ctxFor = docs => {
    const col = c => Object.keys(docs).filter(k => k.startsWith(c + '/') && !k.slice(c.length + 1).includes('/')).map(k => ({ id: k.slice(c.length + 1), ...docs[k] }));
    return {
      testClock: state.clock,
      getReservation: async id => (docs['reservations/' + id] ? { id, ...docs['reservations/' + id] } : null),
      listReservationsByCheckin: async d => col('reservations').filter(r => r.checkin === d),
      listReservationsByBookingIds: async ids => col('reservations').filter(r => ids.includes(r.bookingId)),
      listReservationsByNumberPrefix: async b => col('reservations').filter(r => r.reservationNumber >= b && r.reservationNumber <= b + '\uf8ff'),
      listGuestsByMatchedReservation: async id => col('checkin_guests').filter(g => g.matchedReservationId === id),
      listGuestsByCompanionToken: async t => col('checkin_guests').filter(g => g.companionToken === t),
      getGuest: async id => (docs['checkin_guests/' + id] ? { id, ...docs['checkin_guests/' + id] } : null),
      getApartment: async id => docs['checkin_apartments/' + id] || null,
      getHkStatus: async (room, d) => docs['hk_status/' + room + '_' + d] || null,
      readElevator: async () => ({ fs: docs['globals/elevator_code'] || null, rtdb: null }),
      addSearchFailure: async d => state.failures.push(d),
      rateLimit: async (key, max) => { state.counters[key] = (state.counters[key] || 0) + 1; return state.counters[key] > max; },
      signProof: p => proof.sign(SECRET, p), verifyProof: t => proof.verify(SECRET, t),
      hasGeminiKey: () => true,
      callGemini: async () => '{"valid": true, "confidence": "high", "reason": "ok", "isPassport": true}',
    };
  };
  const regCtx = docs => {
    const base = ctxFor(docs);
    const col = c => Object.keys(docs).filter(k => k.startsWith(c + '/') && !k.slice(c.length + 1).includes('/')).map(k => ({ id: k.slice(c.length + 1), ...docs[k] }));
    return {
      getReservation: base.getReservation,
      findReservationByNumber: async n => col('reservations').find(r => r.reservationNumber === String(n) && r.status !== 'CANCELLED') || null,
      findPrimaryGuestForReservation: async (id, num) => { for (const x of [id, num].filter(Boolean)) { const g = col('checkin_guests').find(g => g.matchedReservationId === x && !g.companionGuest && (g.isPrimaryGuest || g.passportUrl)); if (g) return g; } return null; },
      getGuest: async t => docs['checkin_guests/' + t] || null,
      saveGuest: async (t, data, opts = {}) => { await page.evaluate(([p, d, m]) => window.__DBAPI.set(p, d, m), ['checkin_guests/' + t, { ...data, [opts.isCreate ? 'submittedAt' : 'updatedAt']: { seconds: Math.floor(Date.now() / 1000), nanoseconds: 0 } }, !opts.isCreate]); },
      runGuestUnlock: async () => ({ ok: true }), logRun: async () => {},
    };
  };
  await page.exposeFunction('__callFn', async (name, data) => {
    const docs = await page.evaluate(() => JSON.parse(JSON.stringify(window.__DB.docs)));
    const meta = { ip: '9.9.9.9' };
    let out;
    try {
      if (name === 'guestFind') out = await api.runGuestFind(ctxFor(docs), data, meta);
      else if (name === 'guestStay') out = await api.runGuestStay(ctxFor(docs), data, meta);
      else if (name === 'guestScan') out = await api.runGuestScan(ctxFor(docs), data, meta);
      else if (name === 'guestRegister') out = await regc.runGuestRegister(regCtx(docs), data);
      else out = { __error: { code: 'not-found', message: 'unknown function ' + name } };
    } catch (e) { out = { __error: { code: 'internal', message: e.message } }; }
    calls.push({ name, data, out });
    return out;
  });
  const setClock = async iso => { state.clock = tbilisi(iso); Object.assign(state.clock, tbilisi(iso)); await page.evaluate(i => window.__setClock(i), iso); };
  return { ctx, page, logs, calls, blocked, state, setClock };
}

const visible = (page, id) => page.evaluate(i => { const e = document.getElementById(i); return !!e && e.classList.contains('active'); }, id);
async function fillSearch(page, { name, arrival, contact = '+995555111222' }) {
  await page.evaluate(([n, a, c]) => {
    const set = (id, v) => { const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); };
    set('r-name', n); set('r-arrival', a); set('r-contact', c); set('r-checkin-time', '15:00');
  }, [name, arrival, contact]);
}
const norm = t => t.replace(/\d\d:\d\d:\d\d/g, 'hh:mm:ss').replace(/\s+/g, ' ').trim();
const SIGNED = 'Ahmed Ali';

async function register(env, { apiOn }) {
  const { page } = env;
  await page.goto('http://test.local/checkin-guest.html?api=' + (apiOn ? 1 : 0));
  await page.waitForSelector('#search-btn', { state: 'visible', timeout: 15000 });
  await fillSearch(page, { name: 'Ahmed Ali', arrival: '2026-10-12' });
  await page.click('#search-btn');
  await page.waitForFunction(() => document.getElementById('page-rules')?.classList.contains('active'), null, { timeout: 15000 });
  for (const k of ['noise', 'smoke', 'care', 'card']) { if (await page.$('#rule-' + k)) await page.evaluate(k => { if (!document.getElementById('rule-' + k).classList.contains('checked')) window.toggleRule(k); }, k); }
  await page.fill('#rules-sign-input', SIGNED);
  await page.evaluate(() => window.onRulesSignInput && window.onRulesSignInput());
  await page.waitForFunction(() => !document.getElementById('rules-continue-btn').disabled, null, { timeout: 5000 });
  await page.click('#rules-continue-btn');
  await page.waitForFunction(() => document.getElementById('page-passport')?.classList.contains('active') || document.getElementById('passport-input'), null, { timeout: 10000 });
  await page.setInputFiles('#passport-input', { name: 'passport.jpg', mimeType: 'image/jpeg', buffer: TINY_JPG });
  await page.waitForFunction(() => /Document received|Verifying/.test(document.getElementById('passport-scan-status')?.textContent || '') || !document.getElementById('passport-continue-btn').disabled, null, { timeout: 10000 });
  await page.waitForFunction(() => !document.getElementById('passport-continue-btn').disabled, null, { timeout: 10000 });
  await page.click('#passport-continue-btn');
  await page.waitForFunction(() => document.getElementById('page-home')?.classList.contains('active'), null, { timeout: 20000 });
  await page.waitForTimeout(1500);
}
module.exports = { open, register, visible, fillSearch, norm, SECRET_STRINGS, SEED, TINY_JPG, tbilisi };
