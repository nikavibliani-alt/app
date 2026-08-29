# Sandbox backend handoff — for Claude Code review

**Status:** Work in progress. All changes stay in **sandbox HTML** + `pipeline-functions/` — **no live cutover** (`checkin-admin.html`, `checkin-guest-v2.html` untouched).

**Purpose:** When this pipeline is complete, Claude Code (or any reviewer) should run this checklist before approving production wiring.

---

## Architecture (one Firestore, no v2_*)

| Controller | Owns writes to | Trigger |
|------------|----------------|---------|
| `elevatorCodeGuard` | Rejects stale auto elevator writes | Firestore trigger ✅ deployed |
| `elevatorCodeSync` | FS ↔ RTDB elevator reconcile | Hourly schedule ✅ deployed |
| `RoomAssignment` | `reservations.roomCode`, `checkin_guests.aptId`, `room_moves` | AdminAction only |
| `GuestUnlock` | `checkin_guests.unlockState*`, `manualUnlock` (via force_*) | AdminAction |
| `AdminAction` | Orchestration + `system_logs` | HTTPS callable `pipeline-adminAction` |

Shared unlock rules (browser + server): `shared/guest-unlock.js` ↔ `pipeline-functions/lib/guest-unlock.js` (keep in sync).

---

## Sandbox files wired

| File | What uses pipeline |
|------|-------------------|
| `checkin-admin-sandbox.html` | `force_unlock`, `move_guest` via `shared/pipeline-admin.js` |
| `checkin-guest-sandbox-2.html` | `shared/guest-unlock.js` for `isUnlocked()` |
| `shared/pipeline-admin.js` | Callable client → `pipeline-adminAction` |
| `shared/elevator-sync.js` | Elevator dual-write (existing) |

**Not wired:** `checkin-admin.html`, `checkin-guest-v2.html`, `minihotel_reservation_sync.py`

---

## Review checklist (Claude Code)

### 1. Unit tests

```bash
cd pipeline-functions && npm install && npm test
```

Expected: **all pass** (elevator + room assignment + admin action + guest unlock).

### 2. Deploy pipeline (sandbox E2E requires this)

```bash
firebase functions:secrets:set ADMIN_ACTION_PASSWORD --project sleepy-5c962
# Use same value as admin sandbox _ADMIN_PWD (maxela2026) for testing, or rotate for prod

firebase deploy --only functions:pipeline:adminAction --project sleepy-5c962
```

Callable name: **`pipeline-adminAction`** (region `europe-west1`).

### 3. Admin sandbox manual tests

Open `checkin-admin-sandbox.html`:

- [ ] **Grant Access** on a guest with arrival today → calls `force_unlock`; `checkin_guests.manualUnlock` + `unlockState` updated; log in `system_logs` (`AdminAction`, `GuestUnlock`)
- [ ] **Move room** on guest with `matchedReservationId` → `reservations.roomCode` + `checkin_guests.aptId` updated atomically; `room_moves` audit doc; guest doc **ID unchanged**
- [ ] **Conflict block** — move into occupied overlapping room → UI shows conflict message, no partial writes
- [ ] **HK tab** still works (direct `hk_status` write — not migrated yet)

### 4. Guest sandbox manual tests

Open `checkin-guest-sandbox-2.html`:

- [ ] Unlock gate matches admin status for same guest (before arrival / HK early / after 3pm / mid-stay)
- [ ] Room move from admin sandbox → guest page still loads same `?g=` link; WiFi/photos follow new room

### 5. system_logs queries

Firestore → `system_logs`:

```
controller == "RoomAssignment"
controller == "AdminAction"
controller == "GuestUnlock"
```

Each action should have `ok` | `warn` | `error` with sanitized input/output.

### 6. Still TODO (backend phases)

- [ ] `GuestRegister` — stable guest token, passport link
- [ ] `HKStatusSync` — route HK done through pipeline (optional; HK app still writes `hk_status` today)
- [ ] `ReservationSync` — replace Python sync (later)
- [ ] Wire **live** admin/guest pages only after sandbox sign-off
- [ ] Recover missing Tuya function sources in git before `functions:default` deploy

---

## Known limitations

1. **Admin sandbox room move / unlock require deployed `pipeline-adminAction`.** Without deploy, UI shows a clear toast pointing here.
2. **Password in callable body** is v1 auth (same as HTML gate). Stronger auth is a later phase.
3. **`guest-unlock.js` duplicated** in `shared/` and `pipeline-functions/lib/` — changes must be mirrored manually until a single build step exists.

---

## Quick reference — AdminAction payloads

```javascript
// Move
{ actionType: 'move_guest', payload: { reservationId: '…', toRoom: '6-3' } }

// Grant access
{ actionType: 'force_unlock', payload: { guestId: '…' } }

// Swap
{ actionType: 'swap_guests', payload: { reservationId: 'a', otherReservationId: 'b' } }

// Follow MiniHotel again
{ actionType: 'release_to_minihotel', payload: { reservationId: '…' } }
```

All calls include `password` and optional `actor`.

---

*Update this file when a phase completes or sandbox wiring changes.*
