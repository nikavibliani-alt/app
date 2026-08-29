# Claude Code — Backend Pipeline Review Report

**Date:** 2026-08-29  
**Branch:** `cursor/pipeline-room-assignment-7e07`  
**PR:** https://github.com/nikavibliani-alt/app/pull/16  
**Scope:** Sandbox + `pipeline-functions/` only — **live HTML not touched**

---

## Review fixes applied (2026-08-29, after Claude Code review)

| Finding | Fix |
|---------|-----|
| 🔴 `room_moves` audit written outside transaction | Audit + success `system_logs` now written **inside** the same Firestore transaction as reservation/guest updates |
| 🟡 `manualUnlock` ignored when `arrivalDate` missing | `computeGuestUnlock` checks `manualUnlock` before `no_arrival` early return (shared + pipeline lib) |
| 🟡 `correlationId` never populated | AdminAction generates `adm_{hex}` and passes through to RoomAssignment / GuestUnlock logs |
| 🟡 `isLikelyGuestToken` regex too narrow | Uses `isLegacyCompanionDocId()` — matches `tab-1_2026-09-01`, `orb-2_…`, etc. |

**Tests:** 49/49 passing (added audit rollback + manualUnlock edge case tests).

---

We rebuilt Maxela’s check-in backend as **small pipeline controllers** (one job each, full `system_logs` logging) using **one Firestore** — no `v2_*` collections. Phase 1 elevator pipes are **already deployed**. Phases 2–4 are **implemented in code**, wired to **sandboxes only**, and **await deploy + your review** before any live cutover.

---

## What was built

### Phase 1 — Elevator (live on Firebase)

| Function | Role |
|----------|------|
| `elevatorCodeGuard` | Rejects stale same-code AUTO writes to `globals/elevator_code` |
| `elevatorCodeSync` | Hourly FS ↔ RTDB reconcile + manual HTTPS trigger |

### Phase 2 — Room moves (code ready)

| Module | Role |
|--------|------|
| **RoomAssignment** | Sole writer of room moves: `reservations.roomCode`, `checkin_guests.aptId`, `room_moves` audit |
| **AdminAction** (`pipeline-adminAction`) | Admin callable: routes `move_guest`, `swap_guests`, `release_to_minihotel` |

**Conflict policy (locked):** block overlapping stays; explicit swap only; no displace.

### Phase 3 — Unlock (code ready)

| Module | Role |
|--------|------|
| **GuestUnlock** | Computes `unlockState` / `unlockReason` on `checkin_guests`; `force_unlock` / `force_lock` via AdminAction |
| **shared/guest-unlock.js** | Same rules in browser (admin + guest sandboxes) |

### Phase 4 — Registration (code ready)

| Module | Role |
|--------|------|
| **GuestRegister** (`pipeline-guestRegister`) | Creates primary guests with **stable `guestToken` doc IDs**; room from reservation only |
| **shared/guest-register.js** | Payload builders + token helpers for guest sandbox |

---

## Sandbox wiring (what to test)

| File | Change |
|------|--------|
| `checkin-admin-sandbox.html` | Grant Access → `force_unlock`; Move room → `move_guest` via `shared/pipeline-admin.js` |
| `checkin-guest-sandbox-2.html` | Registration → `pipeline-guestRegister` (fallback to direct Firestore if not deployed); `isUnlocked()` → `shared/guest-unlock.js` |

**Not touched:** `checkin-admin.html`, `checkin-guest-v2.html`, `minihotel_reservation_sync.py`

---

## File map

```
pipeline-functions/
  controllers/
    elevatorCodeGuard.js    ✅ deployed
    elevatorCodeSync.js     ✅ deployed
    roomAssignment.js       ✅ Phase 2
    adminAction.js          ✅ Phase 2+3
    guestUnlock.js          ✅ Phase 3
    guestRegister.js        ✅ Phase 4
  lib/
    guest-unlock.js         (sync with shared/guest-unlock.js)
    guest-token.js
    dates.js, logging.js, elevator.js
  tests/                    49 tests, all passing

shared/
  guest-unlock.js           browser + docs canonical unlock rules
  guest-register.js         registration payloads
  pipeline-admin.js         AdminAction client
  pipeline-guest.js         GuestRegister client
  elevator-sync.js          (existing)

SANDBOX_BACKEND_HANDOFF.md  step-by-step review checklist
```

---

## Sandbox E2E (emulator — no deploy until sign-off)

**Policy:** Test everything in sandbox first. Use the Functions emulator; do not deploy callables until manual tests pass.

```bash
cd pipeline-functions && npm install && npm test   # expect 49 pass
npm run emulator:setup && npm run emulator         # 127.0.0.1:5001

# separate terminal — serve sandbox HTML
npx serve -p 8080 .
# Admin:  http://127.0.0.1:8080/checkin-admin-sandbox.html?emulator=1
# Guest:  http://127.0.0.1:8080/checkin-guest-sandbox-2.html?emulator=1&apt=6-1
```

See **`SANDBOX_BACKEND_HANDOFF.md`** for full checklist.

## Deploy commands (only after sandbox sign-off)

```bash
firebase functions:secrets:set ADMIN_ACTION_PASSWORD --project sleepy-5c962
# Use same value as admin sandbox gate (maxela2026) for testing, or rotate for prod

firebase deploy --only functions:pipeline:adminAction,functions:pipeline:guestRegister --project sleepy-5c962
```

Callable names (region `europe-west1`):
- `pipeline-adminAction`
- `pipeline-guestRegister`

---

## Claude Code review checklist

### Automated

- [ ] `cd pipeline-functions && npm test` → **49/49 pass**
- [ ] No `v2_*` collection writes in `pipeline-functions/`
- [ ] Live HTML files unchanged (`checkin-admin.html`, `checkin-guest-v2.html`)

### Manual (emulator or after deploy)

- [ ] Start emulator + serve sandbox HTML (see SANDBOX_BACKEND_HANDOFF.md) **or** deploy callables after sign-off

- [ ] Admin sandbox: move guest → `room_moves` + both `reservations` and `checkin_guests` updated; guest `?g=` link unchanged
- [ ] Admin sandbox: conflict move blocked with message
- [ ] Admin sandbox: Grant Access → `manualUnlock` + `unlockState`
- [ ] Guest sandbox-2: new registration → `guestToken` doc ID (32 hex), `guestLink` with `?g=`
- [ ] Guest sandbox-2: open link on second browser → skip passport if already registered
- [ ] After admin move: guest link still works, apt content follows new room
- [ ] Firestore `system_logs`: entries for `AdminAction`, `RoomAssignment`, `GuestRegister`, `GuestUnlock`

### Architecture compliance

- [ ] Room moves only through RoomAssignment (admin sandbox no longer writes `roomCode` directly)
- [ ] Primary guest IDs are stable tokens, not `{room}_{date}`
- [ ] `manualRoom: true` set on admin moves
- [ ] No WhatsApp/email from pipeline controllers

---

## Still TODO (not in this PR)

1. **HKStatusSync** — route HK done through pipeline (HK tab still writes `hk_status` directly)
2. **ReservationSync** — replace `minihotel_reservation_sync.py` (do not touch until planned)
3. **Recover Tuya function sources** in git before `functions:default` deploy
4. **Wire live admin + guest** after sandbox sign-off on phone
5. **Stronger auth** than password-in-callable (later phase)

---

## Known limitations

1. Sandboxes **fall back** to direct Firestore if callables not deployed (guest registration only); admin move/unlock show deploy hint toast.
2. `guest-unlock.js` duplicated in `shared/` and `pipeline-functions/lib/` — must stay in sync manually.
3. GuestRegister callable has **no App Check** yet (same exposure model as open Firestore rules today).
4. Multi-room companion docs still use `{room}_{date}` IDs (by design for companions).

---

## Suggested Claude Code prompt

```
Review branch cursor/pipeline-room-assignment-7e07 / PR #16.

Read CLAUDE_CODE_REPORT.md and SANDBOX_BACKEND_HANDOFF.md first.

Verify:
1. npm test in pipeline-functions (49 tests)
2. RoomAssignment conflict policy and atomic writes
3. Sandbox wiring does not touch live HTML
4. Guest token stability across room moves
5. system_logs coverage

Report any bugs or cutover blockers before we wire checkin-admin.html / checkin-guest-v2.html.
```

---

*Generated by Cursor Cloud Agent — update when phases complete.*
