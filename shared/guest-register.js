'use strict';
/**
 * Guest token helpers — keep in sync with pipeline-functions/lib/guest-token.js
 */

export function generateGuestToken() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID().replace(/-/g, '');
  }
  return 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 14);
}

export function buildGuestLink(baseUrl, guestToken) {
  if (!baseUrl || !guestToken) return null;
  const base = String(baseUrl).split('?')[0];
  return base + '?g=' + encodeURIComponent(guestToken);
}

export function isLikelyGuestToken(id) {
  if (!id || typeof id !== 'string') return false;
  if (/^\d+-\d+_\d{4}-\d{2}-\d{2}$/.test(id)) return false;
  if (id.startsWith('g') && id.length > 8) return true;
  return /^[a-f0-9]{32}$/i.test(id);
}

/**
 * Build payload for pipeline guestRegister callable (primary guest).
 */
export function buildRegisterPrimaryPayload({
  reservationId,
  profile,
  guestToken,
  guestLinkBase,
}) {
  return {
    mode: 'register_primary',
    reservationId,
    guestToken: guestToken || null,
    guestLinkBase: guestLinkBase || window.location.origin + window.location.pathname,
    profile,
    actor: 'guest-sandbox',
  };
}

export function buildRegisterCompanionPayload({ reservationId, reservationNumber, profile, primaryGuestId }) {
  return {
    mode: 'register_companion',
    reservationId: reservationId || null,
    reservationNumber: reservationNumber || null,
    primaryGuestId: primaryGuestId || null,
    profile,
    actor: 'guest-sandbox',
  };
}

export function buildUpdateProfilePayload({ guestToken, profile, passportScanResult }) {
  return {
    mode: 'update_profile',
    guestToken,
    profile,
    passportScanResult: passportScanResult || null,
    actor: 'guest-sandbox',
  };
}
