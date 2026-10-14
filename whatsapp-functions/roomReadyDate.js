'use strict';
/**
 * The "room ready" WhatsApp may only go out for a cleaning marked done FOR TODAY (Tbilisi, UTC+4).
 * toggleHkDone also marks the room's next-arrival day done, so a Done on a future day (or a
 * carried-over day) must never message the guest who arrives on that other day.
 */
function tbilisiToday(nowMs = Date.now()) {
  return new Date(nowMs + 4 * 3600 * 1000).toISOString().slice(0, 10);
}
function isRoomReadyDateToday(date, nowMs = Date.now()) {
  return String(date || '') === tbilisiToday(nowMs);
}

/**
 * No "room ready" message for Orbeliani (orb-*), VGL (vgl-*) and XCV (xcv-*) rooms.
 * Shartava and Freedom Square (tab-*) keep getting it. whatsapp_checkin_ready.py
 * (the daily fallback) applies the same list.
 */
const NO_ROOM_READY_PREFIXES = ['orb-', 'vgl-', 'xcv-'];
function isRoomReadyExcluded(roomCode) {
  const code = String(roomCode || '').trim().toLowerCase();
  return NO_ROOM_READY_PREFIXES.some((p) => code.startsWith(p));
}

module.exports = { tbilisiToday, isRoomReadyDateToday, isRoomReadyExcluded, NO_ROOM_READY_PREFIXES };
