# pipeline-functions

Small, single-purpose Cloud Functions for the Maxela backend rebuild. **Separate
Firebase Functions codebase from `tuya-functions/`** — that folder is now
Tuya-smart-lock-only (see [`tuya-functions/README.md`](../tuya-functions/README.md)).

**One Firestore, one schema.** No `v2_*` collections. Every controller here reads
and writes the *existing* collections (`globals/elevator_code`, and — in later
phases — `reservations`, `checkin_guests`, `hk_status`, `room_moves`) plus one new,
flat, non-`v2_` collection: `system_logs`. Phase 1 writes **no** `system_alerts`
and sends **no** notifications of any kind (no WhatsApp, no email) — see "No
notifications" below.

---

## Pipe map (Phase 1 status)

```
┌───────────────────────────────────────────────────────────────────────────┐
│  pipeline-functions/  (this codebase — deploy id "pipeline")             │
│                                                                             │
│  ┌────────────────────────┐        ┌───────────────────────────┐         │
│  │ elevatorCodeGuard  ✅  │        │ elevatorCodeSync      ✅  │         │
│  │ Firestore trigger on   │        │ onSchedule, hourly         │         │
│  │ globals/elevator_code  │        │ + elevatorCodeSyncManual   │         │
│  │ MOVED from              │        │ (HTTPS, secret-gated test) │         │
│  │ tuya-functions/         │        └──────────────┬──────────────┘        │
│  └───────────┬─────────────┘                       │ reads/reconciles      │
│              │ guards writes                        ▼                       │
│              ▼                        globals/elevator_code (Firestore)     │
│   globals/elevator_code                     ⇄  /elevator_code (RTDB)        │
│              │                                       │                       │
│              └──────────────────┬────────────────────┘                     │
│                                  ▼ every run, both controllers              │
│                    system_logs/{autoId}  (ok | warn | error)                │
│                                                                             │
│  NO system_alerts. NO WhatsApp. NO email. Log-only in Phase 1.             │
│  (scripts/elevator-monitor.js — UNTOUCHED, separate — is the real email    │
│   alert channel, firing at 26h stale on RTDB. Not duplicated here.)        │
│                                                                             │
│  ┌────────────────────────┐   ┌────────────────────────┐                  │
│  │ roomAssignment.js  🔲  │   │ adminAction.js     🔲  │                  │
│  │ Phase 2 — scaffold      │   │ Phase 2 — scaffold      │                  │
│  │ only, throws if called,│   │ only, throws if called, │                  │
│  │ NOT exported as a       │   │ NOT exported as a       │                  │
│  │ Cloud Function          │   │ Cloud Function          │                  │
│  └────────────────────────┘   └────────────────────────┘                  │
└───────────────────────────────────────────────────────────────────────────┘

┌───────────────────────────────────────────────────────────────────────────┐
│  tuya-functions/  (existing codebase — deploy id "default")               │
│  Tuya smart lock ONLY now. See tuya-functions/README.md.                  │
│    whatsappWebhook        — active, to migrate later (kept, out of scope) │
│    roomReadyNotification  — active, to migrate later (kept, out of scope) │
│    elevatorCodeGuard      — REMOVED. Moved to pipeline-functions/. ────────┼─ see diff below
│  Reserved for future: regenerate/generate/delete Tuya offline door        │
│  passwords (package.json already references these — not implemented yet).│
└───────────────────────────────────────────────────────────────────────────┘

┌───────────────────────────────────────────────────────────────────────────┐
│  scripts/elevator-monitor.js  (UNTOUCHED — separate, pre-existing)        │
│  Hourly GitHub Action. Reads RTDB /elevator_code only. Emails Nika via     │
│  Resend if stale >26h. This is still the ONLY "tell a human" channel for  │
│  elevator staleness. pipeline-functions does not duplicate or replace it. │
└───────────────────────────────────────────────────────────────────────────┘
```

### How `elevatorCodeGuard` and `elevatorCodeSync` differ (both are needed)

| | `elevatorCodeGuard` | `elevatorCodeSync` |
|---|---|---|
| Trigger | Firestore `onDocumentWritten` on `globals/elevator_code` — fires instantly on every write | `onSchedule`, hourly |
| Watches | Firestore only | Firestore **and** RTDB, compared against each other |
| Catches | A stale AUTO retry (same code as before) being written into Firestore | Firestore and RTDB **disagreeing** with each other (e.g. a dual-write from the admin UI or the Samsung app half-succeeded) |
| Action | Reverts the bad write immediately | Copies the fresher/authoritative side onto the lagging side; logs (never alerts) if *neither* side is fresh |

---

## Files

```
pipeline-functions/
  package.json
  index.js                        # exports live Cloud Functions: elevatorCodeGuard, elevatorCodeSync, elevatorCodeSyncManual
  lib/
    logging.js                    # writeSystemLog() — the ONLY output every controller shares
    timestamps.js                 # normalizes Firestore Timestamp vs RTDB ms-string
    elevator.js                   # drift-detection logic; reuses shared/elevator-sync.js
  controllers/
    elevatorCodeGuard.js          # MOVED from tuya-functions/index.js — full implementation
    elevatorCodeSync.js           # NEW — full implementation
    roomAssignment.js             # Phase 2 — scaffold, throws if called, not exported
    adminAction.js                # Phase 2 — scaffold, throws if called, not exported
  tests/
    elevatorCodeGuard.test.js     # 10 unit tests
    elevatorCodeSync.test.js      # 9 unit tests
```

**19/19 tests passing** as of this delivery (`npm test` from inside `pipeline-functions/`).

---

## `elevatorCodeGuard` — moved, not rewritten

Same behavior as the version that was in `tuya-functions/index.js`, verified
line-by-line against the original during the move. Two differences, both additive:

1. It now writes one `system_logs` entry per evaluated write (`warn` on a rejected
   stale retry, `ok` on everything else) — the original only did a bare
   `console.log`.
2. It reuses `shared/elevator-sync.js`'s `normalizeCode`/`pickCode` instead of the
   private `_normElevatorCode`/`_pickElevatorCode` copies that used to live inline
   in `tuya-functions/index.js` — same exact logic (same regex, same fallback
   order `display_code || code || lastCode`), just one fewer duplicate
   implementation of it in the codebase.

The one true no-op case (`if (!after?.exists) return;` — a delete with no "after"
document) is preserved exactly, including **not** writing a log for it, matching
the original's early return.

---

## Testing

### 1. Unit tests (no Firebase, no emulator, no network — run this first)

```bash
cd pipeline-functions
npm install     # only needed once
npm test
```

Expect `19 pass, 0 fail`. These exercise the pure `runElevatorCodeGuard`/
`decideGuardAction`/`runElevatorCodeSync` logic directly with fake in-memory
`ctx` objects — never touching Firestore, RTDB, or any network call, so they're
safe to run any time.

### 2. Manual end-to-end test against the REAL project, without deploying

```bash
firebase emulators:start --only functions --project sleepy-5c962
```

The emulator prints the local URL for `elevatorCodeSyncManual`, something like:

```
http://127.0.0.1:5001/sleepy-5c962/europe-west1/pipeline-elevatorCodeSyncManual
```

```bash
curl -X POST "http://127.0.0.1:5001/sleepy-5c962/europe-west1/pipeline-elevatorCodeSyncManual" \
     -H "Authorization: Bearer local-test"
```

Set `ELEVATOR_SYNC_MANUAL_SECRET=local-test` in the emulator's local secret config
for this to authorize. This reads/reconciles the REAL `globals/elevator_code` +
RTDB `/elevator_code` — the same live elevator-code data the admin apps already
use. This is intentional and safe: the function only *reconciles* (copies
whichever side is fresher onto the laggard) — it never invents a new code, writes
no notifications, and touches no other collection.

`elevatorCodeGuard` can be exercised the same way via the emulator's Firestore
emulator UI (write a test doc to `globals/elevator_code` with `source:'auto'` and
the same code twice in a row, confirm the second write gets reverted and a
`system_logs` entry appears).

### 3. After deploy (once Nika approves)

```bash
curl -X POST "https://europe-west1-sleepy-5c962.cloudfunctions.net/pipeline-elevatorCodeSyncManual" \
     -H "Authorization: Bearer $ELEVATOR_SYNC_MANUAL_SECRET"
```

Then check results directly in Firebase Console → Firestore → `system_logs`,
filter `controller == "ElevatorCodeGuard"` or `"ElevatorCodeSync"`.

---

## Sample `system_logs` documents (one per scenario, exactly as this code produces them)

**1. Guard — rejects a stale auto retry (`warn`)**
```json
{
  "controller": "ElevatorCodeGuard",
  "action": "reject-stale-auto",
  "status": "warn",
  "message": "Rejected stale auto retry: \"123\" is the same code as before.",
  "input": null, "output": null, "correlationId": null,
  "timestamp": "2026-08-28T09:00:03.412Z"
}
```

**2. Guard — accepts a new auto code (`ok`)**
```json
{
  "controller": "ElevatorCodeGuard",
  "action": "accept-new-auto",
  "status": "ok",
  "message": "Accepted new auto code: \"789\".",
  "timestamp": "2026-08-28T09:05:11.002Z"
}
```

**3. Sync — both fresh and agree (`ok`)**
```json
{
  "controller": "ElevatorCodeSync",
  "action": "check",
  "status": "ok",
  "message": "Firestore and RTDB agree and are both fresh.",
  "output": {
    "firestoreCode": "789", "rtdbCode": "789",
    "firestoreAgeHours": 0.4, "rtdbAgeHours": 0.5,
    "synced": true, "syncDirection": null
  },
  "timestamp": "2026-08-28T10:00:00.501Z"
}
```

**4. Sync — drift detected, reconciled (`warn`)**
```json
{
  "controller": "ElevatorCodeSync",
  "action": "reconcile",
  "status": "warn",
  "message": "Drift detected — synced fs_to_rtdb (winner=fs).",
  "output": {
    "firestoreCode": "456", "rtdbCode": "999",
    "firestoreAgeHours": 1.02, "rtdbAgeHours": 20.4,
    "synced": false, "syncDirection": "fs_to_rtdb"
  },
  "timestamp": "2026-08-28T11:00:02.118Z"
}
```

**5. Sync — read/write error (`error`)**
```json
{
  "controller": "ElevatorCodeSync",
  "action": "check",
  "status": "error",
  "message": "read failed: 7 PERMISSION_DENIED: Missing or insufficient permissions.",
  "timestamp": "2026-08-28T12:00:01.775Z"
}
```

---

## Firebase secrets this codebase needs

| Secret | Used by | Already exists? |
|---|---|---|
| `ELEVATOR_SYNC_MANUAL_SECRET` | `elevatorCodeSyncManual` (Authorization-header gate) | **New — needs to be set**, any random string |

No other secrets. `elevatorCodeGuard` and the scheduled `elevatorCodeSync` need
none at all (log-only, no outbound calls).

## IAM

No new IAM roles needed — this codebase uses the same default service account,
same project (`sleepy-5c962`), same Firestore + RTDB the rest of the backend
already reads/writes.

## `firebase.json` diff

```diff
   "functions": [
     { "source": "tuya-functions", "codebase": "default", "ignore": [...] },
+    {
+      "source": "pipeline-functions",
+      "codebase": "pipeline",
+      "ignore": ["node_modules", ".git", "firebase-debug.log", "firebase-debug.*.log", "*.local", "tests"]
+    }
   ]
```

## Deploy commands (documented — NOT run; waiting for approval)

```bash
cd pipeline-functions && npm install   # once
firebase deploy --only functions:pipeline:elevatorCodeGuard,functions:pipeline:elevatorCodeSync --project sleepy-5c962
# elevatorCodeSyncManual deploys automatically with elevatorCodeSync's group; to target it alone:
firebase deploy --only functions:pipeline:elevatorCodeSyncManual --project sleepy-5c962
```

### ⚠️ Cutover step required after first deploy: delete the OLD `elevatorCodeGuard`

`elevatorCodeGuard` used to be exported from the `default` codebase
(`tuya-functions/`). Removing the export from source code does **not** delete the
already-deployed Cloud Function — Firebase Functions v2 requires an explicit
delete of any function no longer present in a codebase's exports, or the CLI will
prompt to delete it interactively at deploy time. Since the function keeps the
**same name** (`elevatorCodeGuard`) in the **new** codebase (`pipeline`), and
Cloud Functions v2 function IDs must be unique per region within a project
regardless of codebase, you must delete the old one explicitly — deploying the
new one will likely fail or the CLI will ask to confirm the delete inline:

```bash
# Option A: let the tuya-functions deploy prompt you (it will detect
# elevatorCodeGuard is gone from that codebase's source and offer to delete it)
firebase deploy --only functions:default --project sleepy-5c962

# Option B: delete it explicitly first, then deploy pipeline-functions
firebase functions:delete elevatorCodeGuard --region europe-west1 --project sleepy-5c962
firebase deploy --only functions:pipeline --project sleepy-5c962
```

**Do Option B before deploying `pipeline-functions`** — deleting the old one
first avoids any window where two different `elevatorCodeGuard` functions (one
from each codebase) might both try to claim the same deployed function ID.

`tuya-functions`'s other two exports (`whatsappWebhook`, `roomReadyNotification`)
are completely unaffected — they stay deployed under `functions:default` exactly
as before.

---

## Confirmed for this delivery

- ✅ `elevatorCodeGuard` is **NOT** in `tuya-functions/index.js` anymore (moved here).
- ✅ Zero WhatsApp, zero email, zero `system_alerts` anywhere in `pipeline-functions/` — log-only.
- ✅ `scripts/elevator-monitor.js` and `.github/workflows/elevator-monitor.yml` — untouched.
- ✅ No `v2_*` collections anywhere.
- ✅ No HTML file touched (live or sandbox).
- ✅ No Python script touched.
- ✅ Nothing deployed. `firebase deploy` has not been run.
