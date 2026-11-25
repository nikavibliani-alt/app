'use strict';
/**
 * stayLinks — back-to-back stays (rule: lib/stay-chain.js, same as the WhatsApp bot's Rule A).
 *
 * Trigger : reservations/{id} written. Does nothing unless the unit, dates, status, name or phone changed (the hourly
 *           sync rewrites every reservation).
 * Writes  : stay_links/{previousId__nextId} { kind: 'extension' | 'move', status, prevId, nextId, fromUnit, unit,
 *           prevCheckin, prevCheckout, nextCheckin, nextCheckout, notifiedAt }. Status: 'auto' (phones match),
 *           'pending' (a phone is missing: the owner confirms in admin), 'confirmed' / 'rejected' (the owner's answer,
 *           written by admin and never overwritten here), 'moved' (same guest, another unit: a notice only).
 *           No names or phones are stored: the guest page reads this collection.
 * Push    : to the admin phones (same sender as failed searches), once per pair: pending and moving guest, only while
 *           the changeover day is today or later.
 * Cancel  : a cancelled or deleted booking removes its links.
 */

const S = require('../lib/stay-chain');

const WATCHED = ['roomCode', 'room', 'checkin', 'checkIn', 'checkout', 'checkOut', 'status', 'guest', 'firstName', 'lastName', 'phone'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const changed = (before, after) => !before || !after || WATCHED.some(k => String(before[k] ?? '') !== String(after[k] ?? ''));
const room = r => String(r.roomCode || r.room || '');
const inDay = r => String(r.checkin || r.checkIn || '').slice(0, 10);
const outDay = r => String(r.checkout || r.checkOut || '').slice(0, 10);
const shortDay = d => { const p = String(d).split('-').map(Number); return p.length === 3 ? p[2] + ' ' + MONTHS[p[1] - 1] : String(d); };
const guestName = r => String(r.guest || [r.firstName, r.lastName].filter(Boolean).join(' ') || 'Guest').replace(/(^|\s)0\d+(?=\s|$)/g, ' ').replace(/\s+/g, ' ').trim();

function pushFor(kind, a, b, key) {
  const base = { tag: 'stay-' + key, url: '/checkin-admin?tab=stay' };
  if (kind === 'move') {
    return { ...base, title: 'Moving guest: ' + guestName(b), body: `Same guest moves ${room(a)} -> ${room(b)} on ${shortDay(inDay(b))} - change it if needed` };
  }
  return { ...base, title: 'Possible extension', body: `Possible extension: ${guestName(b)}, ${room(b)}, ${shortDay(inDay(b))} - ${shortDay(outDay(b))} - confirm in admin` };
}

/**
 * ctx: { today(), now(), listByCheckin(day), listByCheckout(day), listLinks(reservationId) -> [{key, ...}],
 *        upsertLink(key, existing => ({data, push})) (atomic), deleteLink(key), sendPush(payload), logRun(entry) }
 */
async function runStayLinks(ctx, id, before, after) {
  if (!changed(before, after)) return { action: 'unchanged' };

  if (!after || S.stayCancelled(after)) {
    const links = await ctx.listLinks(id);
    for (const l of links) await ctx.deleteLink(l.key);
    if (links.length) await ctx.logRun({ controller: 'StayLinks', action: 'removed', status: 'ok', message: `Booking ${id} cancelled or removed: ${links.length} stay link(s) removed.` });
    return { action: 'removed', removed: links.length };
  }

  const me = { id, ...after };
  const ci = inDay(me), co = outDay(me);
  if (!ci || !co) return { action: 'none' };
  const [endingOnMyIn, startingOnMyIn, startingOnMyOut, endingOnMyOut] = await Promise.all([
    ctx.listByCheckout(ci), ctx.listByCheckin(ci), ctx.listByCheckin(co), ctx.listByCheckout(co),
  ]);

  const wanted = new Map();
  const consider = (a, b, around) => {
    if (a.id === b.id) return;
    const type = S.stayPairType(a, b);
    if (type === 'strong' || type === 'weak') wanted.set(S.stayPairKey(a, b), { a, b, kind: 'extension', type });
    else if (type === 'move') {
      const to = S.stayMovingTo(a, around, {});
      if (to && to.id === b.id) wanted.set(S.stayPairKey(a, b), { a, b, kind: 'move', type });
    }
  };
  for (const p of endingOnMyIn) consider(p, me, [...endingOnMyIn, ...startingOnMyIn]);
  for (const n of startingOnMyOut) consider(me, n, [...startingOnMyOut, ...endingOnMyOut]);

  // links of this booking that no longer match (moved unit, new dates, other name); the owner's "not the same guest" is kept
  for (const l of await ctx.listLinks(id)) if (!wanted.has(l.key) && l.status !== 'rejected') await ctx.deleteLink(l.key);

  const out = { action: 'checked', links: wanted.size, pushed: 0 };
  for (const [key, w] of wanted) {
    const { a, b, kind, type } = w;
    if (kind === 'extension') {   // they continue in the unit: an earlier "moving guest" notice about them was wrong
      for (const l of await ctx.listLinks(a.id)) if (l.kind === 'move' && l.prevId === a.id) await ctx.deleteLink(l.key);
      for (const l of await ctx.listLinks(b.id)) if (l.kind === 'move' && l.nextId === b.id) await ctx.deleteLink(l.key);
    }
    const res = await ctx.upsertLink(key, existing => {
      const same = existing && existing.kind === kind;
      const answered = same && kind === 'extension' && (existing.status === 'confirmed' || existing.status === 'rejected');
      const status = kind === 'move' ? 'moved' : (answered ? existing.status : (type === 'strong' ? 'auto' : 'pending'));
      const data = {
        kind, status, prevId: a.id, nextId: b.id, fromUnit: room(a), unit: room(b),
        prevCheckin: inDay(a), prevCheckout: outDay(a), nextCheckin: inDay(b), nextCheckout: outDay(b),
      };
      const notify = (status === 'pending' || status === 'moved') && !(same && existing.notifiedAt) && inDay(b) >= ctx.today();
      if (notify) data.notifiedAt = ctx.now();
      else if (!same) data.notifiedAt = null;
      if (!notify && same && Object.keys(data).every(k => existing[k] === data[k])) return { data: null, push: null };
      data.updatedAt = ctx.now();
      if (!existing) data.createdAt = ctx.now();
      return { data, push: notify ? pushFor(kind, a, b, key) : null };
    });
    if (!res.push) continue;
    try {
      await ctx.sendPush(res.push);
      out.pushed++;
      await ctx.logRun({ controller: 'StayLinks', action: 'notified', status: 'ok', message: res.push.body });
    } catch (e) {
      await ctx.upsertLink(key, () => ({ data: { notifiedAt: null }, push: null }));   // try again on the next write
      await ctx.logRun({ controller: 'StayLinks', action: 'notify-failed', status: 'warn', message: `${res.push.body} (${e.message})` });
    }
  }
  return out;
}

function buildLiveCtx() {
  const { getFirestore } = require('firebase-admin/firestore');
  const { writeSystemLog } = require('../lib/logging');
  const db = getFirestore();
  const rows = snap => snap.docs.map(d => ({ id: d.id, ...d.data() }));
  const links = db.collection('stay_links');
  return {
    today: () => new Date(Date.now() + 4 * 3600 * 1000).toISOString().slice(0, 10),
    now: () => new Date().toISOString(),
    listByCheckin: async d => rows(await db.collection('reservations').where('checkin', '==', d).get()),
    listByCheckout: async d => rows(await db.collection('reservations').where('checkout', '==', d).get()),
    listLinks: async id => {
      const [p, n] = await Promise.all([links.where('prevId', '==', id).get(), links.where('nextId', '==', id).get()]);
      return [...p.docs, ...n.docs].map(d => ({ key: d.id, ...d.data() }));
    },
    upsertLink: (key, make) => db.runTransaction(async tx => {
      const ref = links.doc(key);
      const snap = await tx.get(ref);
      const out = make(snap.exists ? snap.data() : null);
      if (out.data) tx.set(ref, out.data, { merge: true });
      return out;
    }),
    deleteLink: key => links.doc(key).delete(),
    sendPush: payload => require('./pushNotifications').sendPushToAll(payload),
    logRun: entry => writeSystemLog(db, entry),
  };
}

function registerCloudFunction() {
  const { onDocumentWritten } = require('firebase-functions/v2/firestore');
  const { defineSecret } = require('firebase-functions/params');
  const secrets = [defineSecret('VAPID_PUBLIC_KEY'), defineSecret('VAPID_PRIVATE_KEY')];
  return onDocumentWritten({ document: 'reservations/{id}', region: 'europe-west1', secrets, timeoutSeconds: 60 }, async event => {
    const before = event.data.before && event.data.before.exists ? event.data.before.data() : null;
    const after = event.data.after && event.data.after.exists ? event.data.after.data() : null;
    if (!changed(before, after)) return;
    try {
      await runStayLinks(buildLiveCtx(), event.params.id, before, after);
    } catch (e) {
      console.error('[stayLinks] failed', event.params.id, e.message);
      try { await require('../lib/logging').writeSystemLog(require('firebase-admin/firestore').getFirestore(), { controller: 'StayLinks', action: 'error', status: 'error', message: `Booking ${event.params.id}: ${e.message}` }); } catch (_) { /* nothing more to do */ }
      throw e;
    }
  });
}

module.exports = { runStayLinks, registerCloudFunction, changed };
