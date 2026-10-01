'use strict';
/**
 * Shared logging for every pipeline controller.
 *
 *   system_logs/{autoId} — EVERY controller run, status: ok | warn | error
 *
 * Flat collection, not `system_logs/{controllerName}/{timestamp}` subcollections —
 * a flat collection with a `controller` field is directly queryable
 * (`where('controller','==','ElevatorCodeSync')`) with no odd/even Firestore
 * path-segment ceremony.
 *
 * Phase 1 does NOT write `system_alerts` — Nika's rule for this task is log-only,
 * no outbound notifications of any kind from pipeline-functions (the existing
 * scripts/elevator-monitor.js already emails her when the elevator code is stale
 * >26h on RTDB; this codebase does not duplicate that).
 *
 * This is an EXISTING collection name (`system_logs`) in the live Firestore
 * project (`sleepy-5c962`) — not a new schema, not `v2_*`.
 */

function sanitize(value) {
  // Logs must never carry guest PII. Strip anything that looks like it, and cap
  // plain strings so a stray huge payload can't blow up a log document.
  if (value == null) return value;
  if (typeof value === 'string') {
    if (value.length > 500) return `[truncated ${value.length} chars]`;
    return value;
  }
  if (Array.isArray(value)) return value.map(sanitize);
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (/passport|photo|image|base64/i.test(k)) {
        out[k] = '[redacted]';
        continue;
      }
      out[k] = sanitize(v);
    }
    return out;
  }
  return value;
}

/**
 * @param {FirebaseFirestore.Firestore} db
 * @param {{controller:string, action:string, status:'ok'|'warn'|'error',
 *          message?:string, input?:object, output?:object, correlationId?:string}} entry
 */
function buildSystemLogDoc(entry) {
  const { FieldValue } = require('firebase-admin/firestore');
  return {
    controller: entry.controller,
    action: entry.action,
    status: entry.status,
    message: entry.message || '',
    input: sanitize(entry.input || null),
    output: sanitize(entry.output || null),
    correlationId: entry.correlationId || null,
    timestamp: FieldValue.serverTimestamp(),
  };
}

async function writeSystemLog(db, entry) {
  const doc = buildSystemLogDoc(entry);
  await db.collection('system_logs').add(doc);
  return doc;
}

module.exports = { writeSystemLog, buildSystemLogDoc, sanitize };
