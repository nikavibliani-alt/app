'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../../shared/apt-arrival.js');

test('room -> group: known rooms, prefixes, site, default', async () => {
  const { roomGroup } = await load();
  assert.equal(roomGroup('0-3'), 'ROOMS');
  assert.equal(roomGroup('6-1'), 'MAXELA');
  assert.equal(roomGroup('6-3'), 'BIG_APT');
  assert.equal(roomGroup('tab-2'), 'FREEDOM');
  assert.equal(roomGroup('orb-3'), 'ORBELIANI');
  assert.equal(roomGroup('xcv-2'), 'XCV');
  assert.equal(roomGroup('vgl-5'), 'VGL');
  assert.equal(roomGroup('new-1', 'vgl'), 'VGL');
  assert.equal(roomGroup('whatever'), 'ROOMS');
  assert.equal(roomGroup(''), 'ROOMS');
});

test('nothing saved: same as today (smart lock, only the unit photo steps)', async () => {
  const { resolveArrival } = await load();
  const unit = { photos: ['a.jpg', 'b.jpg'], photoCaptions: ['Door', 'Lift #elevatorcode'], doorCode: '1234' };
  for (const cfg of [undefined, null, {}, { access: {}, steps: [] }]) {
    const r = resolveArrival(cfg, unit);
    assert.equal(r.access.method, 'smartlock');
    assert.equal(r.access.source, 'default');
    assert.deepEqual(r.steps.map((s) => [s.photo, s.text, s.shared]), [['a.jpg', 'Door', false], ['b.jpg', 'Lift #elevatorcode', false]]);
  }
  assert.deepEqual(resolveArrival(null, {}).steps, []);
});

test('type steps come first; per-unit photo uses the unit photo; unit steps follow', async () => {
  const { resolveArrival } = await load();
  const cfg = {
    access: { method: 'code' },
    steps: [
      { id: 'a', title: 'Gate', text: 'Use {door code}', photo: 'gate.jpg', perUnitPhoto: false },
      { id: 'b', title: 'Your door', text: 'Room {room}', photo: 'ignored.jpg', perUnitPhoto: true },
    ],
  };
  const unit = { photos: ['own.jpg'], photoCaptions: ['Extra'], stepPhotos: { b: 'door-03.jpg' } };
  const r = resolveArrival(cfg, unit);
  assert.deepEqual(r.steps.map((s) => s.photo), ['gate.jpg', 'door-03.jpg', 'own.jpg']);
  assert.deepEqual(r.steps.map((s) => s.shared), [true, true, false]);
  assert.equal(r.steps[1].missingPhoto, false);
  const r2 = resolveArrival(cfg, { photos: [], photoCaptions: [] });
  assert.equal(r2.steps[1].photo, '');
  assert.equal(r2.steps[1].missingPhoto, true);
  assert.equal(r.access.method, 'code');
});

test('a unit can override the access method', async () => {
  const { resolveArrival, resolveAccessMethod } = await load();
  const cfg = { access: { method: 'lockbox', lockboxWhere: 'By the gate' } };
  assert.deepEqual(resolveAccessMethod(cfg, {}), { method: 'lockbox', source: 'type' });
  assert.deepEqual(resolveAccessMethod(cfg, { accessMethod: 'handover' }), { method: 'handover', source: 'unit' });
  assert.deepEqual(resolveAccessMethod(cfg, { accessMethod: '' }), { method: 'lockbox', source: 'type' });
  assert.deepEqual(resolveAccessMethod(cfg, { accessMethod: 'bogus' }), { method: 'lockbox', source: 'type' });
  assert.equal(resolveArrival(cfg, {}).access.lockboxWhere, 'By the gate');
});

test('placeholders: codes only when unlocked, {room} always', async () => {
  const { fillPlaceholders } = await load();
  const ctx = { room: '0-3', doorCode: '4821#', lockboxCode: '9910', elevatorCode: '7766', lockedText: 'Shown when your room is ready' };
  const text = 'Room {room}: door {door code}, box {lock box code}, lift {elevator code}';
  const locked = fillPlaceholders(text, ctx, false);
  assert.ok(locked.includes('Room 0-3'));
  assert.ok(!/4821|9910|7766/.test(locked));
  assert.equal((locked.match(/Shown when your room is ready/g) || []).length, 3);
  const open = fillPlaceholders(text, ctx, true);
  assert.equal(open, 'Room 0-3: door 4821#, box 9910, lift 7766');
  assert.equal(fillPlaceholders('{ Door Code }', ctx, true), '4821#');
  assert.equal(fillPlaceholders('{door code}', { room: '1' }, true), 'contact host');
  assert.equal(fillPlaceholders('Lift #elevatorcode', ctx, true), 'Lift 7766');
});

test('problems in plain words', async () => {
  const { unitProblems } = await load();
  assert.deepEqual(unitProblems(null, '0-4', { tuyaDeviceId: 'x' }), []);
  assert.deepEqual(unitProblems(null, '0-4', {}), ['0-4 has no lock']);
  assert.deepEqual(unitProblems(null, '0-4', {}, { noLock: true }), []);
  assert.deepEqual(unitProblems(null, '0-4', { doorCode: '1234' }), []);
  assert.deepEqual(unitProblems({ access: { method: 'code' } }, '6-2', {}), ['6-2 has no lock']);
  assert.deepEqual(unitProblems({ access: { method: 'code' } }, '6-2', { doorCode: '1' }), []);
  assert.deepEqual(unitProblems({ access: { method: 'lockbox' } }, '6-2', {}), ['6-2 has no lock']);
  assert.deepEqual(unitProblems({ access: { method: 'handover' } }, '6-2', {}), []);
  const cfg = { access: { method: 'handover' }, steps: [{ id: 'p', perUnitPhoto: true }] };
  assert.deepEqual(unitProblems(cfg, '0-4', {}), ['0-4 needs a photo']);
  assert.deepEqual(unitProblems(cfg, '0-4', { stepPhotos: { p: 'u.jpg' } }), []);
});

test('normalizeTypeCfg drops junk and never keeps a code-like field', async () => {
  const { normalizeTypeCfg } = await load();
  assert.equal(normalizeTypeCfg(null), null);
  assert.equal(normalizeTypeCfg({}), null);
  assert.equal(normalizeTypeCfg({ access: { method: '', entranceCard: false }, steps: [] }), null);
  const t = normalizeTypeCfg({ access: { method: 'nonsense', doorCode: '1234', handoverPhone: '+995 555 12-34' }, steps: [null, { title: 5, text: 'x' }] });
  assert.equal(t.access.method, '');
  assert.equal(t.access.handoverPhone, '9955551234');
  assert.equal(t.access.doorCode, undefined);
  assert.equal(t.steps.length, 1);
  assert.equal(t.steps[0].title, '');
});
