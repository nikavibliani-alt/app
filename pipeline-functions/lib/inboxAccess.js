'use strict';
/**
 * Who may use the Booking.com inbox. ONE list, used by every inbox callable function
 * (send a reply, discard a draft, check-in link, alerts). The name is shown as "sent by" on replies.
 * The Firestore rules and shared/inbox-auth.js (the sign-in screen) repeat these emails; a unit test
 * checks the sign-in screen against this list. Pricing and everything else stay owner-only.
 */

const INBOX_USERS = [
  { email: 'nikavibliani@gmail.com', name: 'Nika' },
  { email: 'nutsamargiani@gmail.com', name: 'Nutsa' },
];
const INBOX_EMAILS = INBOX_USERS.map(u => u.email);

/** The inbox user behind a callable's request.auth (verified Google email on the list), or null. */
function inboxUser(auth) {
  const t = auth && auth.token;
  if (!t || t.email_verified !== true) return null;
  const email = String(t.email || '').toLowerCase();
  return INBOX_USERS.find(u => u.email === email) || null;
}

const isInboxUser = auth => !!inboxUser(auth);

module.exports = { INBOX_USERS, INBOX_EMAILS, inboxUser, isInboxUser };
