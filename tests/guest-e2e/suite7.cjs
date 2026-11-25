// Bookings with 3+ rooms: every room is visible in the switcher at 390px, each with its own instructions,
// door code and unlock; companion and per-room records see the whole group too. Direct Firestore and GUEST_API.
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const assert = require('assert');
const h = require('./e2e.cjs');
const SHOT = process.env.SHOT_DIR || '';
let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('PASS ' + name); }
  catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + e.message.split('\n')[0]); }
}

const NOW = '2026-10-13T08:00:00Z';   // mid-stay for arrival 10-12
const CODES = { '0-2': '1002#', '0-3': '1003#', '0-4': '1004#', '0-5': '1005#', '0-1': '1001#', '6-1': '6001#', 'tab-1': '7001#', 'vgl-ap3': '8003#' };
const res = (id, room, extra) => ({ ['reservations/' + id]: { reservationNumber: id.replace(/_\d+$/, ''), roomCode: room, checkin: '2026-10-12', checkout: '2026-10-15', status: 'OK', guest: 'Emma Stone', ...extra } });
const apt = room => ({ ['checkin_apartments/' + room]: { propertyName: 'Unit ' + room, checkInTime: '15:00', checkOutTime: '12:00', doorCode: CODES[room], wifiName: 'W', wifiPass: 'p', photos: ['https://img.test/' + room + '.jpg'], photoCaptions: ['Steps for ' + room] } });
const guest = (token, matched, room, extra) => ({ ['checkin_guests/' + token]: { name: 'Emma Stone', aptId: room, matchedReservationId: matched, arrivalDate: '2026-10-12', checkoutDate: '2026-10-15', passportSkipped: true, guestConfirmedCheckin: true, ...extra } });
const token = c => c.repeat(32);

/** same = one reservation number with _001.. ; otherwise separate numbers linked by relatedReservationIds. */
function booking(rooms, same) {
  const ids = rooms.map((_, i) => (same ? '007100000_00' + (i + 1) : '00720000' + (i + 1)));
  const docs = {};
  rooms.forEach((room, i) => Object.assign(docs, res(ids[i], room), apt(room)));
  Object.assign(docs, guest(token('a'), ids[0], rooms[0], { isPrimaryGuest: true, ...(same ? {} : { relatedReservationIds: ids.slice(1) }) }));
  // the records the app saves besides the main one: an extra room of the owner, a companion, and a companion's extra room
  const base = ids[0].replace(/_\d+$/, '');
  Object.assign(docs, guest(token('b'), ids[2], rooms[2], { isPrimaryGuest: true, primaryGuestId: token('a') }));
  Object.assign(docs, guest(token('c'), ids[0], rooms[0], { companionGuest: true, primaryGuestId: token('a'), linkedReservationNumber: base }));
  Object.assign(docs, guest(token('d'), ids[1], rooms[1], { companionGuest: true, primaryGuestId: token('c'), linkedReservationNumber: base }));
  return docs;
}

async function openStay(browser, { docs, who, apiOn, width }) {
  const env = await h.open(browser, { apiOn, startIso: NOW, viewport: { width: width || 390, height: 844 } });
  await env.page.addInitScript(d => { Object.assign(window.__DB.docs, d); }, docs);
  await env.page.goto('http://test.local/checkin-guest.html?api=' + (apiOn ? 1 : 0) + '&g=' + who);
  await env.page.waitForFunction(() => document.getElementById('page-home')?.classList.contains('active'), null, { timeout: 20000 });
  await env.page.waitForTimeout(1500);
  return env;
}

/** Rooms whose tile is fully inside the switcher box and the screen (what a guest can actually see and tap). */
const tiles = page => page.evaluate(() => {
  const grid = document.querySelector('#multi-room-label');
  if (!grid) return [];
  const g = grid.getBoundingClientRect();
  return [...grid.querySelectorAll('.apt-tile')].map(t => {
    const r = t.getBoundingClientRect();
    const name = t.querySelector('.apt-tile__name');
    return { room: t.dataset.room, visible: r.width > 40 && r.left >= g.left - 1 && r.right <= g.right + 1 && r.right <= innerWidth && r.top >= g.top - 1 && r.bottom <= g.bottom + 1,
      nameCut: name.scrollWidth > name.clientWidth + 1 };
  });
});

async function checkAllRooms(env, rooms, { clickEach = true } = {}) {
  const { page } = env;
  await page.evaluate(() => window.scrollTo(0, 0));
  const seen = await tiles(page);
  assert.deepStrictEqual(seen.map(t => t.room).sort(), [...rooms].sort(), 'rooms in the switcher: ' + seen.map(t => t.room));
  assert.deepStrictEqual(seen.filter(t => !t.visible).map(t => t.room), [], 'tiles hidden off the switcher');
  assert.deepStrictEqual(seen.filter(t => t.nameCut).map(t => t.room), [], 'room names cut off');
  if (!clickEach) return;
  for (const room of rooms) {
    await page.evaluate(() => window.scrollTo(0, 0));   // up and down only: a tile off to the side stays unreachable
    const box = await page.locator(`.apt-tile[data-room="${room}"]`).boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);   // a real tap on the spot, no auto-scrolling
    await page.waitForFunction(([code, room]) => document.getElementById('hero-door-code')?.textContent.trim() === code
      && (document.getElementById('hero-walkthrough-list')?.textContent || '').includes('Steps for ' + room), [CODES[room], room], { timeout: 8000 })
      .catch(async () => { throw new Error(room + ' shows code "' + await page.evaluate(() => document.getElementById('hero-door-code')?.textContent) + '", steps "' + await page.evaluate(() => document.getElementById('hero-walkthrough-list')?.textContent.trim().slice(0, 60)) + '"'); });
  }
}

(async () => {
  const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
  const cases = [
    ['3 rooms, one building', ['0-2', '0-3', '0-5'], true],
    ['4 rooms, one building', ['0-2', '0-3', '0-4', '0-5'], true],
    ['3 rooms, different buildings', ['0-2', '6-1', 'tab-1'], false],
    ['4 rooms, different buildings', ['0-2', '6-1', 'tab-1', 'vgl-ap3'], false],
    ['5 rooms, one building', ['0-1', '0-2', '0-3', '0-4', '0-5'], true],
  ];
  for (const apiOn of [false, true]) {
    const way = apiOn ? 'GUEST_API' : 'direct';
    for (const [label, rooms, same] of cases) {
      await test(`${way}: ${label} - all visible, each with its own code and steps`, async () => {
        const env = await openStay(browser, { docs: booking(rooms, same), who: token('a'), apiOn });
        await checkAllRooms(env, rooms);
        if (SHOT && !apiOn) await env.page.screenshot({ path: `${SHOT}/rooms-${rooms.length}${same ? '' : '-mixed'}.png` });
        await env.ctx.close();
      });
    }
    for (const [who, label] of [['b', 'per-room record'], ['c', 'companion'], ['d', "companion's extra-room record"]]) {
      for (const same of [true, false]) {
        const rooms = same ? ['0-2', '0-3', '0-5'] : ['0-2', '6-1', 'tab-1'];
        await test(`${way}: ${label} sees the whole group (${same ? 'one booking number' : 'separate numbers'})`, async () => {
          const env = await openStay(browser, { docs: booking(rooms, same), who: token(who), apiOn });
          await checkAllRooms(env, rooms);
          await env.ctx.close();
        });
      }
    }
    await test(`${way}: a record pointing at another booking's owner gets none of those rooms`, async () => {
      const docs = { ...booking(['0-2', '0-3', '0-5'], false), ...res('007300000', '0-1', { guest: 'Other Person' }), ...apt('0-1'),
        ...guest(token('e'), '007300000', '0-1', { companionGuest: true, primaryGuestId: token('a'), linkedReservationNumber: '007300000' }) };
      const env = await openStay(browser, { docs, who: token('e'), apiOn });
      assert.deepStrictEqual(await tiles(env.page), [], 'a one-room guest has no switcher');
      const saved = await env.page.evaluate(t => window.__DB.docs['checkin_guests/' + t].relatedReservationIds || [], token('e'));
      assert.deepStrictEqual(saved, []);
      await env.ctx.close();
    });
  }
  await test('direct: 4 rooms still all visible on a 360px phone', async () => {
    const env = await openStay(browser, { docs: booking(['0-2', '0-3', '0-4', '0-5'], true), who: token('a'), apiOn: false, width: 360 });
    await checkAllRooms(env, ['0-2', '0-3', '0-4', '0-5'], { clickEach: false });
    await env.ctx.close();
  });
  await browser.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
