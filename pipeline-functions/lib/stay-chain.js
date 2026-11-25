'use strict';
/**
 * Server copy of shared/stay-chain.js (back-to-back stays). The block below must stay identical to it
 * (tests/stayChain.test.js checks). Edit shared/stay-chain.js, then copy the block here.
 */

// STAY-CHAIN-LOGIC-START
const STAY_CHAIN_MAX = 30;

const stayId = r => String((r && (r.id || r.reservationNumber)) || '');
const stayRoom = r => String((r && (r.roomCode || r.room)) || '');
const stayDay = v => String(v || '').slice(0, 10);
const stayIn = r => stayDay(r && (r.checkin || r.checkIn));
const stayOut = r => stayDay(r && (r.checkout || r.checkOut));
const stayPairKey = (a, b) => stayId(a) + '__' + stayId(b);

function stayCancelled(r) {
  const s = String((r && r.status) || '').toUpperCase();
  return s === 'CL' || s === 'CANCELLED';
}

/** Guest name for comparing: lower case, single spaces, without MiniHotel's room tag ("Emma 02 Lee"). */
function stayName(r) {
  const raw = (r && (r.guest || r.guestName || [r.firstName, r.lastName].filter(Boolean).join(' '))) || '';
  return String(raw).toLowerCase().replace(/(^|\s)0\d+(?=\s|$)/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Digits only, as the bot compares them; '' when there is no usable number. */
function stayPhone(r) {
  let d = String((r && (r.phone || r.guestPhone || r.guest_phone)) || '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length === 9 && d.startsWith('5')) d = '995' + d;
  return d.length >= 9 ? d : '';
}

/** How booking b follows booking a: 'strong' | 'weak' (same unit), 'move' (another unit), 'none'. */
function stayPairType(a, b) {
  if (!a || !b || stayId(a) === stayId(b) || stayCancelled(a) || stayCancelled(b)) return 'none';
  if (!stayOut(a) || stayOut(a) !== stayIn(b)) return 'none';
  const name = stayName(a);
  if (!name || name !== stayName(b)) return 'none';
  if (!stayRoom(a) || !stayRoom(b)) return 'none';
  const pa = stayPhone(a), pb = stayPhone(b);
  if (pa && pb && pa !== pb) return 'none';
  if (stayRoom(a) !== stayRoom(b)) return 'move';
  return pa && pb ? 'strong' : 'weak';
}

/** The link between a and the next booking b in the same unit: 'auto' | 'confirmed' | 'pending' | 'rejected' | 'none'. */
function stayLinkStatus(a, b, decisions) {
  const type = stayPairType(a, b);
  if (type !== 'strong' && type !== 'weak') return 'none';
  const d = decisions && decisions[stayPairKey(a, b)];
  if (d === 'rejected') return 'rejected';
  if (d === 'confirmed') return 'confirmed';
  return type === 'strong' ? 'auto' : 'pending';
}

const stayIsLinked = status => status === 'auto' || status === 'confirmed';

// of several candidates: a linked one before a pending one, then the longest
function stayBest(list) {
  return list.sort((x, y) => (stayIsLinked(y.status) - stayIsLinked(x.status)) || stayOut(y.r).localeCompare(stayOut(x.r)))[0] || null;
}
function stayNextOf(from, pool, decisions, used) {
  return stayBest((pool || []).filter(r => !used.has(stayId(r)) && stayOut(r))
    .map(r => ({ r, status: stayLinkStatus(from, r, decisions) })).filter(x => x.status !== 'none' && x.status !== 'rejected'));
}
function stayPrevOf(to, pool, decisions, used) {
  return stayBest((pool || []).filter(r => !used.has(stayId(r)) && stayIn(r))
    .map(r => ({ r, status: stayLinkStatus(r, to, decisions) })).filter(x => stayIsLinked(x.status)));
}

/**
 * The whole stay a booking belongs to (pool: the bookings of its unit):
 * { chain (oldest first, linked bookings only), start, end, pending (next booking waiting for the owner, or null) }.
 */
function stayChainOf(reservation, pool, decisions) {
  const chain = [reservation];
  const used = new Set([stayId(reservation)]);
  let pending = null;
  for (let i = 0; i < STAY_CHAIN_MAX; i++) {
    const next = stayNextOf(chain[chain.length - 1], pool, decisions, used);
    if (!next) break;
    if (!stayIsLinked(next.status)) { pending = next.r; break; }
    used.add(stayId(next.r)); chain.push(next.r);
  }
  for (let i = 0; i < STAY_CHAIN_MAX; i++) {
    const prev = stayPrevOf(chain[0], pool, decisions, used);
    if (!prev) break;
    used.add(stayId(prev.r)); chain.unshift(prev.r);
  }
  return { chain, start: stayIn(chain[0]), end: stayOut(chain[chain.length - 1]), pending };
}

/** pool: bookings of every unit around the check-out day. The booking in another unit this guest moves to, or null. */
function stayMovingTo(reservation, pool, decisions) {
  const continues = (a, b) => { const s = stayLinkStatus(a, b, decisions); return s !== 'none' && s !== 'rejected'; };
  if ((pool || []).some(b => continues(reservation, b))) return null;   // they stay in this unit too
  return (pool || []).find(b => stayPairType(reservation, b) === 'move'
    && !(pool || []).some(p => stayId(p) !== stayId(reservation) && continues(p, b))) || null;
}

/** What follows this booking: { kind: 'strong' | 'weak' | 'move' | 'none', next, chain, start, end }. */
function stayClassify(reservation, pool, decisions) {
  const info = stayChainOf(reservation, pool, decisions);
  const direct = (pool || []).filter(b => { const t = stayPairType(reservation, b); return t === 'strong' || t === 'weak'; })
    .sort((x, y) => (stayPairType(reservation, x) === 'strong' ? 0 : 1) - (stayPairType(reservation, y) === 'strong' ? 0 : 1));
  if (direct.length) return { ...info, kind: stayPairType(reservation, direct[0]), next: direct[0] };
  const moving = stayMovingTo(reservation, pool, decisions);
  return { ...info, kind: moving ? 'move' : 'none', next: moving };
}

/** The booking without the fields stayViews adds. */
function stayPlain(r) {
  const out = { ...r };
  if (out.ownCheckin !== undefined) { out.checkin = out.ownCheckin; out.checkout = out.ownCheckout; }
  delete out.ownCheckin; delete out.ownCheckout; delete out.stayBookings; delete out.stayPending;
  return out;
}
const stayBrief = r => ({ id: stayId(r), checkin: stayIn(r), checkout: stayOut(r), tuyaPassword: r.tuyaPassword || '' });

/**
 * The guest's own bookings as they should be shown. A booking that is part of a longer stay gets the stay's first
 * check-in and last check-out (its own dates stay in ownCheckin / ownCheckout); bookings of one stay are shown once
 * (preferId wins). A booking with no link and nothing waiting is returned as it is.
 * pool: the bookings of the units concerned.
 */
function stayViews(own, pool, decisions, preferId) {
  const items = (own || []).map(r => {
    const stored = (pool || []).find(x => stayId(x) === stayId(r));
    const base = stored ? { ...stayPlain(r), ...stored } : stayPlain(r);
    if (!stored || stayCancelled(base)) return { key: stayId(base), view: base };
    const info = stayChainOf(stored, pool, decisions);
    const key = stayId(info.chain[0]);
    if (info.chain.length === 1 && !info.pending) return { key, view: base };
    return {
      key,
      view: {
        ...base, checkin: info.start, checkout: info.end, ownCheckin: stayIn(base), ownCheckout: stayOut(base),
        stayBookings: info.chain.map(stayBrief), stayPending: info.pending ? stayBrief(info.pending) : null,
      },
    };
  });
  const keep = new Map();
  for (const it of items) if (!keep.has(it.key) || (preferId && stayId(it.view) === preferId)) keep.set(it.key, it.view);
  return items.filter((it, i) => items.findIndex(x => x.key === it.key) === i).map(it => keep.get(it.key));
}

/** The last day this booking still matters to the guest (including an extension waiting for the owner). */
const stayUntil = view => stayOut(view && view.stayPending) || stayOut(view);

/** "12:00" -> 720; the default is 12:00. */
function stayMinutes(hhmm, fallback) {
  const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : (fallback === undefined ? 720 : fallback);
}

/** The booking of the stay that is running now (changeover day: the ending one until check-out time, then the next). */
function stayCurrentBooking(view, today, minutes, checkOutMinutes) {
  const list = (view && view.stayBookings) || [];
  if (!list.length) return view;
  return list.find(b => today < b.checkout || (today === b.checkout && minutes < checkOutMinutes)) || list[list.length - 1];
}

/** The unconfirmed extension, once the confirmed part of the stay is over; null before that and after the extension. */
function stayPendingDue(view, today, minutes, checkOutMinutes) {
  const p = view && view.stayPending;
  if (!p) return null;
  const end = stayOut(view);
  const over = today > end || (today === end && minutes >= checkOutMinutes);
  return over && today <= stayOut(p) ? p : null;
}
// STAY-CHAIN-LOGIC-END

module.exports = {
  stayPairKey, stayName, stayPhone, stayCancelled, stayPairType, stayLinkStatus, stayChainOf, stayMovingTo,
  stayClassify, stayViews, stayPlain, stayUntil, stayMinutes, stayCurrentBooking, stayPendingDue,
};
