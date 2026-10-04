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
module.exports = { tbilisiToday, isRoomReadyDateToday };
