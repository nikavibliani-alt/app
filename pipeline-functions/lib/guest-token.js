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

function isLikelyGuestToken(id) {
  if (!id || typeof id !== 'string') return false;
  if (/^\d+-\d+_\d{4}-\d{2}-\d{2}$/.test(id)) return false;
  if (id.startsWith('g') && id.length > 8) return true;
  return /^[a-f0-9]{32}$/i.test(id);
}

module.exports = { generateGuestToken, buildGuestLink, isLikelyGuestToken };
