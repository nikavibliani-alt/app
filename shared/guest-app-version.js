'use strict';
/**
 * Guest check-in app version — bump on each release (iOS-style: 1.0, 1.1, 1.2).
 * Shown in UI footer; NOT in the URL.
 *
 * Production URL stays: https://app.maxelaapartments.com/checkin-guest.html
 */

export const GUEST_APP_VERSION = '1.1.4';
export const GUEST_APP_URL = 'https://app.maxelaapartments.com/checkin-guest.html';

/** @param {string} guestToken */
export function buildPersonalGuestLink(guestToken) {
  if (!guestToken) return GUEST_APP_URL;
  return `${GUEST_APP_URL}?g=${encodeURIComponent(guestToken)}`;
}
