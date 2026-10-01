/**
 * Elevator code sync rules (Maxela).
 * Manual admin save always wins until phone app posts a NEW code (different from stored).
 * Stale auto retries (same code) are rejected.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.ElevatorSync = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function normalizeCode(v) {
    return String(v == null ? '' : v).replace(/[#\s]/g, '').trim();
  }

  function pickCode(data) {
    if (!data) return '';
    return data.display_code || data.code || data.lastCode || '';
  }

  /** Should an incoming auto write be applied? */
  function shouldAcceptAutoWrite(incoming, currentDoc) {
    const inc = normalizeCode(pickCode(incoming));
    if (!inc) return false;
    const cur = normalizeCode(pickCode(currentDoc));
    if (!cur) return true;
    return inc !== cur;
  }

  /** Payload for manual admin save */
  function buildManualUpdate(displayCode, qrCode, nowMs) {
    const ts = nowMs == null ? Date.now() : nowMs;
    const code = String(displayCode || '').trim();
    return {
      display_code: code,
      qr_code: String(qrCode || '').trim(),
      code,
      lastCode: code,
      expires_at: String(ts + 24 * 3600 * 1000),
      updatedAt: String(ts),
      source: 'manual',
    };
  }

  /** Payload for Samsung auto app */
  function buildAutoUpdate(displayCode, qrCode, nowMs) {
    const ts = nowMs == null ? Date.now() : nowMs;
    const code = String(displayCode || '').trim();
    return {
      display_code: code,
      qr_code: String(qrCode || '').trim(),
      code,
      lastCode: code,
      expires_at: String(ts + 24 * 3600 * 1000),
      updatedAt: String(ts),
      source: 'auto',
    };
  }

  return {
    normalizeCode,
    pickCode,
    shouldAcceptAutoWrite,
    buildManualUpdate,
    buildAutoUpdate,
  };
});
