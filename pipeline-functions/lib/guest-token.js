'use strict';
/**
 * Guest token helpers — keep in sync with shared/guest-register.js
 */

const crypto = require('crypto');

function generateGuestToken() {
  return crypto.randomBytes(16).toString('hex');
}

function buildGuestLink(baseUrl, guestToken) {
  if (!baseUrl || !guestToken) return null;
  const trimmed = String(baseUrl).replace(/\/$/, '');
  const sep = trimmed.includes('?') ? '&' : '?';
  return `${trimmed}${sep}g=${encodeURIComponent(guestToken)}`;
}

function isLegacyCompanionDocId(id) {
  // Legacy/companion shape: {roomCode}_{YYYY-MM-DD} e.g. 6-1_2026-09-01, tab-1_2026-09-01
  return /^.+\_\d{4}-\d{2}-\d{2}$/.test(id);
}

function isLikelyGuestToken(id) {
  if (!id || typeof id !== 'string') return false;
  if (isLegacyCompanionDocId(id)) return false;
  if (/^[a-f0-9]{32}$/i.test(id)) return true;
  if (id.startsWith('g') && id.length > 8) return true;
  return false;
}

module.exports = { generateGuestToken, buildGuestLink, isLikelyGuestToken, isLegacyCompanionDocId };
