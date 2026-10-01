'use strict';
/**
 * HK bedding / extra sheets rules — canonical copy for admin sandbox + HK apps.
 *
 * Priority order:
 *   1. Individual room override — checkin_apartments/{roomCode}.normalCapacity
 *   2. Category default — checkin_admin/config.categoryCapacity[group].default
 *      (group resolved from roomCode via hkPropertyGroupForRoom)
 *   3. Hardcoded fallback thresholds (guest count that triggers alert), used only
 *      when neither of the above is configured:
 *        0-*           — 4th guest  (sofa bed sheets)
 *        6-1,6-2,6-4,7-1,7-2,7-4 — after 4th (= 5+ guests)
 *        6-3           — after 8th (= 9+ guests)
 *        orb-*, tab-*, vgl-st-*  — 3rd guest
 *        vgl-ap*       — after 4th (= 5+ guests)
 */

export const HK_GUEST_ICON =
  '<svg class="hk-icon hk-icon--guest" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="3"/><path d="M22 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>';

export const HK_SHEET_ICON =
  '<svg class="hk-icon hk-icon--sheet" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7v11a2 2 0 002 2h14a2 2 0 002-2V7"/><path d="M3 7h18V5a2 2 0 00-2-2H5a2 2 0 00-2 2v2z"/><path d="M7 11h10"/></svg>';

/**
 * Maps a room code to its property/listing-category group id.
 * @returns {'ROOMS'|'MAXELA'|'BIG_APT'|'FREEDOM'|'ORBELIANI'|'VGL'|null}
 */
export function hkPropertyGroupForRoom(roomCode) {
  const c = String(roomCode || '').toLowerCase();
  if (c === '6-3') return 'BIG_APT';
  if (/^0-/.test(c)) return 'ROOMS';
  if (/^(6|7)-/.test(c)) return 'MAXELA';
  if (/^tab-/.test(c)) return 'FREEDOM';
  if (/^orb-/.test(c)) return 'ORBELIANI';
  if (/^vgl-/.test(c)) return 'VGL';
  return null;
}

/** @returns {{text:string, kind:'sofa'|'sheets'}|null} */
export function hkBeddingAlert(roomCode, guests, normalCapacity, categoryCapacity) {
  const n = Number(guests) || 0;
  if (n < 1) return null;

  const roomCap = Number(normalCapacity) || 0;
  if (roomCap > 0) {
    return n > roomCap ? { kind: 'sheets', text: 'Extra sheets needed' } : null;
  }

  const group = hkPropertyGroupForRoom(roomCode);
  const catCap = group && categoryCapacity && categoryCapacity[group]
    ? Number(categoryCapacity[group].default) || 0
    : 0;
  if (catCap > 0) {
    return n > catCap ? { kind: 'sheets', text: 'Extra sheets needed' } : null;
  }

  const c = String(roomCode || '').toLowerCase();

  if (/^0-/.test(c)) {
    return n >= 4 ? { kind: 'sofa', text: 'Extra sofa bed sheets needed' } : null;
  }
  if (['6-1', '6-2', '6-4', '7-1', '7-2', '7-4'].includes(c)) {
    return n >= 5 ? { kind: 'sheets', text: 'Extra sheets needed' } : null;
  }
  if (c === '6-3') {
    return n >= 9 ? { kind: 'sheets', text: 'Extra sheets needed' } : null;
  }
  if (/^(orb|tab|vgl-st)-/.test(c)) {
    return n >= 3 ? { kind: 'sheets', text: 'Extra sheets needed' } : null;
  }
  if (/^vgl-ap/.test(c)) {
    return n >= 5 ? { kind: 'sheets', text: 'Extra sheets needed' } : null;
  }
  return null;
}

export function hkGuestCountLabel(count, verb) {
  if (count > 0) return `${count} ${verb}`;
  return '';
}
