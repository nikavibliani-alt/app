/**
 * VENDORED COPY of ../../shared/elevator-sync.js — kept byte-identical on purpose.
 *
 * Cloud Functions deploy only uploads a function's own source directory
 * (`pipeline-functions/`), not sibling folders from the monorepo. The original
 * `require('../../shared/elevator-sync.js')` worked locally but crashed every
 * container on boot once deployed ("Cannot find module ../../shared/elevator-sync.js").
 * This local copy exists so the deploy package is self-contained.
 *
 * If shared/elevator-sync.js ever changes (e.g. the Samsung app contract in
 * docs/ELEVATOR_APP.md changes), this file must be updated to match by hand —
 * there is no build step that syncs them automatically. Grep the repo for
 * "elevator-sync.js" before editing either copy.
 *
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
