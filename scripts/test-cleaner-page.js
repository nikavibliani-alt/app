#!/usr/bin/env node
'use strict';
/**
 * Offline tests for cleaner.html (no network, no dependencies): runs the page's real module script
 * against an in-memory Firestore mock.
 *
 *   node scripts/test-cleaner-page.js
 *
 * Covers: Done parity with the admin toggleHkDone, and "Done only on the day" (future cards locked,
 * date rollover unlocks, guard inside toggleHkDone).
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const page = fs.readFileSync(path.join(ROOT, 'cleaner.html'), 'utf8');
const adminSrc = fs.readFileSync(path.join(ROOT, 'checkin-admin.html'), 'utf8');
let script = page.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
script = script.replace(/^import\s*\{([^}]*)\}\s*from\s*"([^"]+)";?$/gm, (m, list, from) =>
  `const {${list.split(',').map((x) => x.trim()).filter(Boolean).join(',')}}=M[${JSON.stringify(from.split('/').pop())}];`);

const realNow = Date.now;
let clock = null; // fixed fake time (ms) or null
Date.now = () => (clock === null ? realNow() : clock);
const tbToday = () => new Date(Date.now() + 4 * 3600 * 1000).toISOString().slice(0, 10);
const addD = (base, n) => { const d = new Date(base + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const atTbilisi = (date, hh, mm, ss = 0) => Date.parse(`${date}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}+04:00`);

function loadShared(file, exportsList) {
  const s = fs.readFileSync(path.join(ROOT, 'shared', file), 'utf8').replace(/^export\s+(async\s+)?(const|function)/gm, '$1$2');
  return new Function(s + ';return {' + exportsList + '};')();
}

function mkMock(init) {
  const store = JSON.parse(JSON.stringify(init));
  const log = { writes: [], reads: [] };
  const listeners = [];
  const inCol = (c) => Object.entries(store).filter(([k]) => k.startsWith(c + '/') && !k.slice(c.length + 1).includes('/'))
    .map(([k, v]) => ({ id: k.slice(c.length + 1), data: () => v }));
  const run = (q) => {
    let rows = inCol(q.path || q.c);
    for (const w of q.w || []) {
      rows = rows.filter((r) => {
        const x = r.data()[w.f];
        if (x == null) return false;
        return w.op === '==' ? x === w.v : w.op === '>=' ? x >= w.v : w.op === '<=' ? x <= w.v : true;
      });
    }
    return rows;
  };
  const fire = () => listeners.forEach((l) => l.cb({ docs: run(l.q) }));
  const apply = (ref, data, merge) => { const cur = store[ref.path] || {}; store[ref.path] = merge ? { ...cur, ...data } : { ...data }; };
  const clean = (d) => JSON.parse(JSON.stringify(d));
  const M = {
    'firebase-app.js': { initializeApp: () => ({}) },
    'firebase-storage.js': { getStorage: () => ({}), ref: (_, p) => ({ path: p }), uploadBytesResumable() {}, getDownloadURL() {}, getMetadata() {} },
    'firebase-firestore.js': {
      getFirestore: () => ({}),
      collection: (_, c) => ({ path: c }),
      doc: (_, c, id) => ({ path: c + '/' + id }),
      query: (c, ...w) => ({ c: c.path, w }),
      where: (f, op, v) => ({ f, op, v }),
      serverTimestamp: () => 'TS',
      arrayUnion: (...a) => ({ __u: a }),
      increment: (n) => ({ __i: n }),
      getDoc: async (ref) => { log.reads.push(['getDoc', ref.path]); const v = store[ref.path]; return { exists: () => v !== undefined, data: () => v }; },
      getDocs: async (q) => { log.reads.push(['getDocs', q.path || q.c]); return { docs: run(q) }; },
      setDoc: async (ref, data, opt) => { log.writes.push(['set', ref.path, clean(data)]); apply(ref, data, opt && opt.merge); fire(); },
      updateDoc: async (ref, data) => { log.writes.push(['upd', ref.path, clean(data)]); apply(ref, data, true); fire(); },
      onSnapshot: (q, cb) => { const l = { q, cb }; listeners.push(l); cb({ docs: run(q) }); return () => { const i = listeners.indexOf(l); if (i >= 0) listeners.splice(i, 1); }; },
    },
    'guest-unlock.js': { normalizeStayDate: (v) => (typeof v === 'string' ? ((v.match(/^(\d{4}-\d{2}-\d{2})/) || [])[1] || '') : '') },
    'hk-bedding.js': loadShared('hk-bedding.js', 'hkBeddingAlert,HK_GUEST_ICON,HK_SHEET_ICON'),
    'room-registry.js': loadShared('room-registry.js', 'roomsSorted'),
    'hk-damage.js': loadShared('hk-damage.js', 'DAMAGE_CATEGORIES,makeReportId,tbilisiIsoNow,readPhotoMeta,fileExt,uploadOriginal,pickDepartingReservation'),
  };
  return { M, store, log, listeners };
}

const TOK = 'a'.repeat(32);

function baseInit(today) {
  return {
    'checkin_admin/config': { hkSettings: { teams: [{ id: 'tA', label: 'Team A', roomCodes: ['6-1', '6-2', '7-1'] }] }, categoryCapacity: {} },
    'checkin_rooms/6-1': { site: 'shartava', displayName: 'Apt 6-1', showInHk: true, active: true, sortOrder: 1 },
    'checkin_rooms/6-2': { site: 'shartava', displayName: 'Apt 6-2', showInHk: true, active: true, sortOrder: 2 },
    'checkin_rooms/7-1': { site: 'shartava', displayName: 'Apt 7-1', showInHk: true, active: true, sortOrder: 3 },
    ['hk_staff_links/' + TOK]: { name: 'Nino', teamId: 'tA', teamIds: ['tA'], active: true, lastSeenAt: null, revokedAt: null },
  };
}

async function boot({ init, lang = 'en' }) {
  const mk = mkMock(init);
  const els = {};
  const el = (id) => els[id] || (els[id] = { id, hidden: false, innerHTML: '', textContent: '', classList: { add() {}, remove() {} }, addEventListener() {}, querySelector: () => null, dataset: {} });
  const ls = { hk_lang: lang, hk_staff_token: TOK };
  const localStorage = { getItem: (k) => (k in ls ? ls[k] : null), setItem: (k, v) => { ls[k] = String(v); }, removeItem: (k) => { delete ls[k]; } };
  const dl = {}; const timers = []; const docState = { visibilityState: 'visible' };
  const document = {
    getElementById: el, addEventListener: (t, f) => { (dl[t] = dl[t] || []).push(f); }, querySelector: () => null,
    documentElement: { lang: '' }, get visibilityState() { return docState.visibilityState; },
  };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const f = new AsyncFunction('M', 'document', 'localStorage', 'location', 'requestAnimationFrame', 'setTimeout', 'URLSearchParams', 'window', 'URL', 'confirm',
    script + `;return {toggleHkDone,refresh,
      setDay:(i)=>{hkActiveDay=i;renderNow();},
      get day(){return hkActiveDay;},
      get html(){return $("list").innerHTML;},
      get tabs(){return $("tabs").innerHTML;},
      hkTaskRooms:(d)=>hkTaskRooms(d), findFormForReservation, hkGetNextCheckin, hkGuestFormForRoom,
      get state(){return {link,hkStatusData,_resCache,guestData};}};`);
  const api = await f(mk.M, document, localStorage, { search: '?s=' + TOK }, (cb) => cb(),
    (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, URLSearchParams, { addEventListener() {} },
    { createObjectURL: () => 'blob:x', revokeObjectURL() {} }, () => true);
  await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
  return { ...mk, els, api, dl, timers, docState };
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const hasBtn = (html, room, date) => new RegExp(`data-act="done" data-room="${room}" data-date="${date}"`).test(html);

/* ─────────── Done parity with the admin toggleHkDone ─────────── */
function adminToggleSource() {
  const a = adminSrc.indexOf('window.toggleHkDone=async');
  return adminSrc.slice(a, adminSrc.indexOf('/* ── Elevator', a));
}

for (const [label, room, scenario] of [
  ['same-day turnover', '6-1', 'same'],
  ['next guest in 2 days', '6-2', 'two'],
  ['no next booking', '7-1', 'none'],
]) {
  test(`Done parity: ${label}`, async () => {
    const T = tbToday();
    const init = baseInit(T);
    init['reservations/o61'] = { roomCode: '6-1', checkin: addD(T, -3), checkout: T, status: 'CONFIRMED', guest: 'Out 61', guests: 2 };
    init['reservations/i61'] = { roomCode: '6-1', checkin: T, checkout: addD(T, 3), status: 'CONFIRMED', guest: 'In 61', guests: 3, reservationNumber: 'N61' };
    init['checkin_guests/f61'] = { aptId: '6-1', arrivalDate: T, checkoutDate: addD(T, 3), matchedReservationId: 'i61', guests: 3, name: 'In 61' };
    init['reservations/o62'] = { roomCode: '6-2', checkin: addD(T, -2), checkout: T, status: 'CONFIRMED', guest: 'Out 62', guests: 1 };
    init['reservations/i62'] = { roomCode: '6-2', checkin: addD(T, 2), checkout: addD(T, 4), status: 'CONFIRMED', guest: 'In 62', guests: 2 };
    init['reservations/o71'] = { roomCode: '7-1', checkin: addD(T, -2), checkout: T, status: 'CONFIRMED', guest: 'Out 71', guests: 1 };

    // admin run (same data)
    const ad = await boot({ init });
    ad.log.writes.length = 0;
    const S = ad.api.state;
    const F = ad.M['firebase-firestore.js'];
    const aenv = {
      hkStatusData: { ...S.hkStatusData },
      hkGetNextCheckin: ad.api.hkGetNextCheckin,
      findFormForReservation: ad.api.findFormForReservation,
      hkGuestFormForRoom: ad.api.hkGuestFormForRoom,
      setDoc: F.setDoc, updateDoc: F.updateDoc, getDocs: F.getDocs, doc: F.doc, collection: F.collection, query: F.query, where: F.where,
      db: {}, serverTimestamp: () => 'TS', toast() {}, renderHk() {}, rebuildFormMaps() {}, currentTab: 'x', renderStay() {}, window: {},
    };
    const adminToggle = new Function(...Object.keys(aenv), adminToggleSource() + ';return window.toggleHkDone;')(...Object.values(aenv));
    await adminToggle(room, T);
    const adminWrites = ad.log.writes.slice();

    const cl = await boot({ init });
    cl.log.writes.length = 0;
    await cl.api.toggleHkDone(room, T);
    const clWrites = cl.log.writes.slice();

    assert.strictEqual(clWrites.length, adminWrites.length, 'same number of writes');
    clWrites.forEach((w, i) => {
      const aw = adminWrites[i];
      assert.strictEqual(w[1], aw[1], 'same doc, same order');
      const extra = Object.keys(w[2]).filter((k) => !(k in aw[2]));
      if (i === 0) assert.deepStrictEqual(extra.sort(), ['doneAt', 'doneBy', 'doneByLinkId'], 'only additive fields on the checkout-day doc');
      else assert.deepStrictEqual(extra, [], 'no extra fields on ' + w[1]);
      for (const k of Object.keys(aw[2])) assert.deepStrictEqual(w[2][k], aw[2][k], 'field ' + k);
    });
    if (scenario === 'same') assert(clWrites.some((w) => w[1] === 'checkin_guests/f61' && w[2].manualUnlock === true), 'arriving guest unlocked');
    if (scenario === 'two') assert(clWrites.some((w) => w[1] === `hk_status/6-2_${addD(T, 2)}`), 'arrival-day doc written');
    // undo
    cl.log.writes.length = 0;
    await cl.api.toggleHkDone(room, T);
    assert.strictEqual(cl.log.writes[0][2].done, false);
    assert(!cl.log.writes.some((w) => w[1].startsWith('checkin_guests/')), 'undo never touches guests');
  });
}

/* ─────────── Done only on the day ─────────── */
function dayLockInit(T) {
  const init = baseInit(T);
  init['reservations/y1'] = { roomCode: '6-1', checkin: addD(T, -4), checkout: addD(T, -1), status: 'CONFIRMED', guest: 'Y', guests: 1 };      // left yesterday, not cleaned (overdue today)
  init['reservations/t1'] = { roomCode: '6-2', checkin: addD(T, -3), checkout: T, status: 'CONFIRMED', guest: 'T', guests: 1 };               // leaves today
  init['reservations/n1'] = { roomCode: '7-1', checkin: addD(T, -2), checkout: addD(T, 1), status: 'CONFIRMED', guest: 'N', guests: 1 };     // leaves tomorrow
  init['reservations/l1'] = { roomCode: '6-1', checkin: addD(T, 3), checkout: addD(T, 5), status: 'CONFIRMED', guest: 'L', guests: 1 };      // another room leaves in 5 days (room 6-1 later)
  init['reservations/l2'] = { roomCode: '6-2', checkin: addD(T, -1), checkout: addD(T, 3), status: 'CONFIRMED', guest: 'L2', guests: 1 };    // leaves in 3 days
  return init;
}

test('Done only on the day: today active, yesterday/overdue active, future locked', async () => {
  const T = tbToday();
  clock = atTbilisi(T, 10, 0);
  const b = await boot({ init: dayLockInit(T), lang: 'en' });
  // today tab: 6-2 leaves today, 6-1 is the overdue carry-over: both pressable
  b.api.setDay(0);
  assert(hasBtn(b.api.html, '6-2', T), "today's checkout card is active");
  assert(hasBtn(b.api.html, '6-1', T), 'overdue carry-over card is active');
  assert(!/donebtn locked/.test(b.api.html));
  // yesterday tab: still pressable for late marking
  b.api.setDay(-1);
  assert(hasBtn(b.api.html, '6-1', addD(T, -1)), "yesterday's card is active");
  // tomorrow tab: locked, labelled "Tomorrow", with the hint
  b.api.setDay(1);
  assert(!/data-act="done"/.test(b.api.html), 'no active Done button on a future day');
  assert(/class="donebtn locked" disabled/.test(b.api.html), 'locked + disabled');
  assert(/>Tomorrow<\/button><div class="donehint">Done only on the day<\/div>/.test(b.api.html), 'text "Tomorrow" + hint');
  // later day: dd.mm
  b.api.setDay(3);
  const dd = addD(T, 3).slice(8, 10) + '.' + addD(T, 3).slice(5, 7);
  assert(new RegExp(`class="donebtn locked" disabled[^>]*>${dd.replace('.', '\\.')}</button>`).test(b.api.html), 'later days show dd.mm');
  // Georgian default text
  const g = await boot({ init: dayLockInit(T), lang: 'ka' });
  g.api.setDay(1);
  assert(/ხვალ<\/button><div class="donehint">მზადაა მხოლოდ იმ დღეს<\/div>/.test(g.api.html), 'Georgian text');
});

test('Done only on the day: an already-Done future card shows Done but cannot be undone', async () => {
  const T = tbToday();
  clock = atTbilisi(T, 10, 0);
  const init = dayLockInit(T);
  init[`hk_status/7-1_${addD(T, 1)}`] = { roomCode: '7-1', date: addD(T, 1), done: true, doneBy: 'Someone' };
  const b = await boot({ init, lang: 'en' });
  b.api.setDay(1);
  assert(/Done<\/span>|pill-ok/.test(b.api.html), 'shows Done');
  assert(/class="donebtn locked" disabled[^>]*>Done<\/button>/.test(b.api.html), 'button reads Done and is disabled');
  assert(!/Undo/.test(b.api.html) && !/data-act="done"/.test(b.api.html), 'no Undo');
});

test('Done only on the day: toggleHkDone ignores future dates (old cached page / double tap)', async () => {
  const T = tbToday();
  clock = atTbilisi(T, 10, 0);
  const b = await boot({ init: dayLockInit(T), lang: 'en' });
  b.log.writes.length = 0;
  await b.api.toggleHkDone('7-1', addD(T, 1));
  await b.api.toggleHkDone('7-1', addD(T, 30));
  assert.strictEqual(b.log.writes.length, 0, 'nothing written for a future date');
  await b.api.toggleHkDone('6-2', T);
  assert(b.log.writes.some((w) => w[1] === `hk_status/6-2_${T}` && w[2].done === true), "today's Done works");
  b.log.writes.length = 0;
  await b.api.toggleHkDone('6-1', addD(T, -1));
  assert(b.log.writes.some((w) => w[1] === `hk_status/6-1_${addD(T, -1)}` && w[2].done === true), "yesterday's Done still works");
});

test('Done only on the day: date rollover unlocks tomorrow (timer and visibilitychange)', async () => {
  const T = tbToday();
  const tomorrow = addD(T, 1);
  clock = atTbilisi(T, 23, 59, 50);              // 10 seconds before Tbilisi midnight
  const b = await boot({ init: dayLockInit(T), lang: 'en' });
  b.api.setDay(1);
  assert(/class="donebtn locked" disabled[^>]*>Tomorrow</.test(b.api.html), 'locked before midnight');
  // a timer for the next midnight was scheduled (~10 s + 2 s margin)
  const mid = b.timers.find((t) => t.ms >= 9000 && t.ms <= 14000);
  assert(mid, 'midnight timer scheduled, got ' + JSON.stringify(b.timers.map((t) => t.ms)));
  // midnight passes -> timer fires -> the old "tomorrow" card (7-1, leaves that day) is now TODAY and pressable
  clock = atTbilisi(tomorrow, 0, 0, 3);
  await mid.fn();
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(b.api.day, 0, 'back to the Today tab');
  assert(hasBtn(b.api.html, '7-1', tomorrow), 'now today: Done is active at 00:00 without a reload');
  assert(!/donebtn locked/.test(b.api.html), 'nothing locked on today');
  // visibilitychange path: reopen the page after midnight
  const T2 = tbToday();
  clock = atTbilisi(addD(T, 2), 0, 1, 0);
  assert.notStrictEqual(tbToday(), T2);
  b.docState.visibilityState = 'visible';
  for (const h of b.dl.visibilitychange || []) await h();
  await new Promise((r) => setImmediate(r));
  assert(hasBtn(b.api.html, '6-2', tbToday()) || /data-act="done"/.test(b.api.html) || /empty/.test(b.api.html), 'board re-rendered for the new day');
  b.api.setDay(1);
  assert(/class="donebtn locked" disabled/.test(b.api.html) || /empty/.test(b.api.html), 'the new tomorrow is locked again');
  // cards that are in the past relative to the new day stay pressable (yesterday tab)
  b.api.setDay(-1);
  assert(!/donebtn locked/.test(b.api.html), 'yesterday tab never locked');
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log('PASS  ' + t.name); } catch (e) { failed++; console.log('FAIL  ' + t.name + '\n      ' + (e && e.message)); }
    clock = null;
  }
  Date.now = realNow;
  console.log(failed ? `\n${failed} FAILED` : `\nall ${tests.length} cleaner-page tests passed`);
  process.exit(failed ? 1 : 0);
})();
