'use strict';
/**
 * The number shown on the admin main screen: how many Booking.com conversations need a reply.
 * Same rule as the inbox page: not done, and the guest wrote last (or there is a cancel request),
 * and the conversation has chat messages or a cancel request. Pure.
 */

const needsReply = c => !c.done && (!!c.needsReply || !!c.cancelRequest);
const visible = c => (c.messageCount || 0) > 0 || !!c.cancelRequest;

/** conversations: array of conversation data. Returns { needsReply, cancelRequests }. */
function computeInboxStats(conversations) {
  let n = 0;
  let cancels = 0;
  for (const c of conversations || []) {
    if (!c || !visible(c) || !needsReply(c)) continue;
    n++;
    if (c.cancelRequest) cancels++;
  }
  return { needsReply: n, cancelRequests: cancels };
}

/** Did anything that changes the number change? (Avoids recounting on draft or counter updates.) */
function statsRelevantChange(before, after) {
  const pick = c => (c ? [!!c.done, !!c.needsReply, !!c.cancelRequest, c.messageCount || 0] : null);
  return JSON.stringify(pick(before)) !== JSON.stringify(pick(after));
}

module.exports = { computeInboxStats, statsRelevantChange };
