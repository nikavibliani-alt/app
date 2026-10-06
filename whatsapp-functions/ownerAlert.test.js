'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ownerAlertParams, ownerAlertTemplatePayload, ownerAlertText, sendOwnerAlert, ownerStatusIds, ownerAlertStatusLines, alertDocId } = require('./ownerAlert');

const quiet = () => {
  const lines = [];
  return { lines, log: { log: (m) => lines.push(['log', m]), error: (m) => lines.push(['error', m]) } };
};
/** Fake send that answers in order and records each payload. */
function sender(...answers) {
  const sent = [];
  const send = async (payload) => { sent.push(payload); return answers.shift(); };
  return { sent, send };
}

test('ownerAlertParams: cleaned for Meta (no newlines/tabs/runs of spaces, never empty) and trimmed to fit', () => {
  assert.deepEqual(ownerAlertParams('Anna Petrova / 6-2', 'URGENT, guest is locked out'), { guest: 'Anna Petrova / 6-2', issue: 'URGENT, guest is locked out' });
  assert.equal(ownerAlertParams('A', 'line one\nline two\t\ttab     spaces').issue, 'line one line two tab spaces');
  assert.deepEqual(ownerAlertParams('', '  '), { guest: 'unknown guest', issue: 'see the chat' });
  const long = ownerAlertParams('x'.repeat(200), 'y'.repeat(2000));
  assert.equal(long.guest.length, 60);
  assert.equal(long.issue.length, 500);
  assert.ok(long.issue.endsWith('…'));
});

test('template payload matches the approved owner_alert template', () => {
  const p = ownerAlertTemplatePayload('995555123456', { guest: 'Anna / 6-2', issue: 'Guest needs help: no hot water' }, 'en');
  assert.deepEqual(p, {
    messaging_product: 'whatsapp',
    to: '995555123456',
    type: 'template',
    template: {
      name: 'owner_alert',
      language: { code: 'en' },
      components: [{ type: 'body', parameters: [{ type: 'text', text: 'Anna / 6-2' }, { type: 'text', text: 'Guest needs help: no hot water' }] }],
    },
  });
});

test('free-form fallback has the same wording as the template', () => {
  assert.equal(ownerAlertText({ guest: 'Anna / 6-2', issue: 'URGENT, guest is locked out' }),
    'New alert from your Maxela bot. Guest: Anna / 6-2. Issue: URGENT, guest is locked out. Please check the WhatsApp chat.');
});

test('sendOwnerAlert', async (t) => {
  const base = { to: '995555123456', guest: 'Anna / 6-2', issue: 'URGENT, guest is locked out' };

  await t.test('template accepted: one send, no fallback', async () => {
    const q = quiet(); const s = sender({ ok: true, id: 'wamid.T1' });
    const r = await sendOwnerAlert({ ...base, send: s.send, log: q.log });
    assert.deepEqual(r, { ok: true, via: 'template', id: 'wamid.T1', language: 'en' });
    assert.equal(s.sent.length, 1);
    assert.equal(s.sent[0].type, 'template');
  });

  await t.test('template not found in "en" (132001): retried as "en_US"', async () => {
    const q = quiet(); const s = sender({ ok: false, code: 132001, reason: 'Meta error 132001: Template name does not exist in the translation' }, { ok: true, id: 'wamid.T2' });
    const r = await sendOwnerAlert({ ...base, send: s.send, log: q.log });
    assert.deepEqual(r, { ok: true, via: 'template', id: 'wamid.T2', language: 'en_US' });
    assert.deepEqual(s.sent.map((p) => p.template.language.code), ['en', 'en_US']);
    assert.ok(q.lines.some(([lvl, m]) => lvl === 'error' && /template "owner_alert" \(en\) failed: Meta error 132001/.test(m)), 'the "en" failure is logged');
  });

  await t.test('template fails for another reason: free-form fallback, logged', async () => {
    const q = quiet(); const s = sender({ ok: false, code: 132000, reason: 'Meta error 132000: parameter count mismatch' }, { ok: true, id: 'wamid.F1' });
    const r = await sendOwnerAlert({ ...base, send: s.send, log: q.log });
    assert.deepEqual(r, { ok: true, via: 'text', id: 'wamid.F1' });
    assert.equal(s.sent.length, 2, 'no language retry for other errors');
    assert.equal(s.sent[1].text.body, 'New alert from your Maxela bot. Guest: Anna / 6-2. Issue: URGENT, guest is locked out. Please check the WhatsApp chat.');
    assert.ok(q.lines.some(([lvl, m]) => lvl === 'error' && /template "owner_alert" \(en\) failed: Meta error 132000/.test(m)));
    assert.ok(q.lines.some(([lvl, m]) => lvl === 'error' && /template "owner_alert" failed, falling back to free-form text/.test(m)));
  });

  await t.test('template missing in every language: each failure logged, then fallback', async () => {
    const q = quiet();
    const nf = (lang) => ({ ok: false, code: 132001, reason: `Meta error 132001: template name (owner_alert) does not exist in ${lang}` });
    const s = sender(nf('en'), nf('en_US'), { ok: true, id: 'wamid.F2' });
    const r = await sendOwnerAlert({ ...base, send: s.send, log: q.log });
    assert.deepEqual(r, { ok: true, via: 'text', id: 'wamid.F2' });
    const errors = q.lines.filter(([lvl]) => lvl === 'error').map(([, m]) => m);
    assert.ok(errors.some((m) => /\(en\) failed: .*does not exist in en$/.test(m)));
    assert.ok(errors.some((m) => /\(en_US\) failed: .*does not exist in en_US$/.test(m)));
  });

  await t.test('both fail: logged, never throws', async () => {
    const q = quiet(); const s = sender({ ok: false, code: 'network', reason: 'could not reach Meta' }, { ok: false, code: 131047, reason: 'Re-engagement message' });
    const r = await sendOwnerAlert({ ...base, send: s.send, log: q.log });
    assert.equal(r.ok, false);
    assert.ok(q.lines.some(([lvl, m]) => lvl === 'error' && /fallback failed too/.test(m)));
  });

  await t.test('a throwing send is caught', async () => {
    const r = await sendOwnerAlert({ ...base, send: async () => { throw new Error('boom'); }, log: quiet().log });
    assert.equal(r.ok, false);
  });
});

test('ownerAlertStatusLines: owner-number reports only; "owner alert" only for recorded alert ids; failures as errors', () => {
  const statuses = [
    { id: 'wamid.HBgMOTk1NTU1MTIzNDU2FQIAERgSAAAA', status: 'sent', recipient_id: '995555123456' },
    { id: 'wamid.HBgMOTk1NTU1MTIzNDU2FQIAERgSAAAA', status: 'delivered', recipient_id: '995555123456' },
    { id: 'wamid.GUEST', status: 'delivered', recipient_id: '491701234567' },
    { id: 'wamid.HBgMOTk1NTU1MTIzNDU2FQIAERgSBBBB', status: 'failed', recipient_id: '995555123456',
      errors: [{ code: 131047, title: 'Re-engagement message', error_data: { details: 'More than 24 hours have passed' } }] },
    { id: 'wamid.HBgMOTk1NTU1MTIzNDU2FQIAERgSCCCC', status: 'read', recipient_id: '995555123456' },
  ];
  const alertIds = new Set(['wamid.HBgMOTk1NTU1MTIzNDU2FQIAERgSAAAA', 'wamid.HBgMOTk1NTU1MTIzNDU2FQIAERgSBBBB']);
  assert.deepEqual(ownerAlertStatusLines(statuses, '+995 555 12 34 56', alertIds), [
    { level: 'log', text: 'owner alert …FQIAERgSAAAA sent' },
    { level: 'log', text: 'owner alert …FQIAERgSAAAA delivered' },
    { level: 'error', text: 'owner alert …FQIAERgSBBBB FAILED: Meta error 131047 Re-engagement message (More than 24 hours have passed)' },
    { level: 'log', text: "message to the owner's number …FQIAERgSCCCC read" },
  ]);
  assert.equal(ownerAlertStatusLines(statuses, '995555123456')[0].text, "message to the owner's number …FQIAERgSAAAA sent", 'no recorded ids: never called an owner alert');
  assert.deepEqual(ownerAlertStatusLines(statuses, ''), [], 'no owner phone configured');
  assert.deepEqual(ownerAlertStatusLines(undefined, '995555123456'), []);
});

test('ownerStatusIds: unique ids of reports to the owner only', () => {
  const statuses = [
    { id: 'a', status: 'sent', recipient_id: '995555123456' },
    { id: 'a', status: 'delivered', recipient_id: '995555123456' },
    { id: 'g', status: 'sent', recipient_id: '491701234567' },
    { id: 'b', status: 'read', recipient_id: '995555123456' },
  ];
  assert.deepEqual(ownerStatusIds(statuses, '+995 555 12 34 56'), ['a', 'b']);
  assert.deepEqual(ownerStatusIds(statuses, ''), []);
});

test('alertDocId: Meta ids with "/" become valid Firestore doc ids', () => {
  assert.equal(alertDocId('wamid.HBgL/MzI0OTM5=='), 'wamid.HBgL_MzI0OTM5==');
  assert.equal(alertDocId('wamid.ABC'), 'wamid.ABC');
});
