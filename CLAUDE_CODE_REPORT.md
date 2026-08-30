# Claude Code — Full Project Handoff (Frontend + Backend)

**Date:** 2026-08-30  
**Firebase project:** `sleepy-5c962`  
**Recommended review branch:** `cursor/hk-guest-count-7e07` (most complete — stacks all backend + HK work)  
**Alternate branches:** `cursor/room-swap-ui-7e07` (swap/unlock only), `cursor/pipeline-stability-7e07` (CI/emulator only)  
**Previous report:** 2026-08-29 — **outdated** (49 tests, no swap UI, no unlock recompute, no HK bedding)

---

## Executive summary

Since the last Claude Code report (2026-08-29), we completed **sandbox E2E hardening** for room moves/swaps, **unlock recompute after admin mutations**, **emulator/CI stability**, and **HK guest count + per-room bedding alerts**. Guest check-in sandboxes are **design-complete** per owner; backend pipeline controllers are **implemented and unit-tested** but **not deployed** to production.

**Automated status (verified 2026-08-30):**

| Check | Result |
|-------|--------|
| `cd pipeline-functions && npm test` | **53/53 pass** |
| `node scripts/check-guest-unlock-sync.js` | **in sync** |
| Emulator starts (`npm run emulator:lite`) | **yes** — `adminAction`, `guestRegister` on `127.0.0.1:5001` |
| Callable auth (wrong password) | **rejects** with `PERMISSION_DENIED` |
| Firestore E2E in cloud VM | **needs `firebase login` on Mac** — Admin SDK hits production Firestore |

**Deploy policy (unchanged):** Do **not** deploy `adminAction` / `guestRegister` until Mac sandbox E2E passes and owner approves.

---

## What changed since 2026-08-29

### Backend pipeline (`pipeline-functions/`)

| Change | Branch / PR | Detail |
|--------|-------------|--------|
| **Unlock recompute after move/swap** | `cursor/room-swap-ui-7e07` PR #28 | `AdminAction` calls `GuestUnlock` for every `affectedGuestIds` returned by `RoomAssignment` |
| **`affectedGuestIds` in RoomAssignment response** | PR #28 | Move and swap return guest IDs whose unlock state must refresh |
| **Tbilisi timezone + midnight mid-stay** | PR #28 | `shared/guest-unlock.js` ↔ `pipeline-functions/lib/guest-unlock.js`: UTC+4 clock, `normalizeStayDate()` for Firestore timestamps |
| **Reservation `checkin` preferred for unlock** | PR #28 | GuestUnlock controller + admin sandbox use reservation check-in over form `arrivalDate` when linked |
| **`manualUnlock` without `arrivalDate`** | (prior fix, retained) | Still honored before `no_arrival` early return |
| **Emulator callable name fix** | PR #26 | Local emulator uses `adminAction` / `guestRegister`; prod uses `pipeline-adminAction` / `pipeline-guestRegister` via `shared/pipeline-emulator.js` |
| **`emulator:lite`** | PR #26 | No UI port 4000 — `firebase.emulator-lite.json` |
| **CI + unlock sync check** | PR #26 | `.github/workflows/pipeline-functions-test.yml` |
| **New tests** | PR #28 | Swap unlock recompute, mid-stay after midnight Tbilisi (+4 tests → **53 total**) |

### Admin sandbox (`checkin-admin-sandbox.html`)

| Change | Detail |
|--------|--------|
| **Swap UI** | When target room has overlapping guest → **Swap** button + preview ("Swap with X — they move to Y") |
| **`swap_guests` via AdminAction** | `window.swapGuestPipeline()` — no silent overwrite |
| **Client-side overlap detection** | Mirrors backend `datesOverlap` before showing swap |
| **Live reservations subscription** | `_resCache` was one-shot; caused stale room/form linking after ~10 swaps — fixed with `onSnapshot` + `refreshReservationsNow()` after move/swap |
| **Safer `findFormForReservation()`** | Linked guests no longer attach via `aptId` alone |
| **HK guest count** | Reads `reservations.guestCount` (MiniHotel) with fallback to `checkin_guests.guests` |
| **HK bedding alerts** | `shared/hk-bedding.js` — per-room thresholds, SVG icons, no emojis |
| **HK contrast fix** | Dark ink guest counts; white bedding alert with orange border on yellow cards |

### Guest sandboxes (frontend — owner-approved)

Guest check-in flow (`checkin-guest-sandbox-2.html`, `checkin-guest-sandbox-3.html`) is **design-complete** across prior PRs (#4 coordination, #18 layout, companion form, reg time rules, icons, etc.). **Not wired to live** `checkin-guest-v2.html`.

### HK standalone apps

`HK.html`, `HK-Shartava.html` synced with `shared/hk-bedding.js` rules (removed emojis).

---

## Architecture (locked)

One Firestore, one writer per fact, full `system_logs` audit. **No `v2_*` collections.**

**Conflict policy:** block overlapping stays; explicit **swap only**; no displace.

See also: `MASTER_ARCHITECTURE_CURSOR.md`, `PIPELINE_DESIGN_CURSOR.md`, `SANDBOX_BACKEND_HANDOFF.md`.

### Pipeline controllers

| Controller | Status | Writes |
|------------|--------|--------|
| `elevatorCodeGuard` | ✅ **Deployed** | Rejects stale elevator AUTO writes |
| `elevatorCodeSync` | ✅ **Deployed** | FS ↔ RTDB reconcile |
| `adminAction` | Built, **not deployed** | Orchestration → RoomAssignment, GuestUnlock |
| `guestRegister` | Built, **not deployed** | Stable `guestToken` guest docs |
| `RoomAssignment` | Via AdminAction | `reservations.roomCode`, `checkin_guests.aptId`, `room_moves` |
| `GuestUnlock` | Via AdminAction | `unlockState`, `manualUnlock` |

**Callable names (region `europe-west1`):**

| Environment | AdminAction | GuestRegister |
|-------------|-------------|---------------|
| Emulator / localhost | `adminAction` | `guestRegister` |
| Production (after deploy) | `pipeline-adminAction` | `pipeline-guestRegister` |

---

## Open PRs (relevant to backend review)

| PR | Branch | Focus |
|----|--------|-------|
| [#26](https://github.com/nikavibliani-alt/app/pull/26) | `cursor/pipeline-stability-7e07` | CI, emulator:lite, unlock sync scripts |
| [#28](https://github.com/nikavibliani-alt/app/pull/28) | `cursor/room-swap-ui-7e07` | Swap UI + unlock recompute + reservation cache fix |
| [#29](https://github.com/nikavibliani-alt/app/pull/29) | `cursor/hk-guest-count-7e07` | HK guest count, bedding rules, contrast (**superset** of #26+#28 backend commits) |

**Suggested merge order:** #26 → #28 → #29 (or squash #29 alone if it already contains the stack).

Earlier frontend PRs (#24 icons, #25 Tabler, guest sandboxes, etc.) are independent.

---

## File map

```
pipeline-functions/
  controllers/
    elevatorCodeGuard.js    ✅ deployed
    elevatorCodeSync.js     ✅ deployed
    roomAssignment.js       move / swap / release — returns affectedGuestIds
    adminAction.js          routes + unlock recompute after room actions
    guestUnlock.js          unlockState derivation + force_unlock/lock
    guestRegister.js        stable guestToken registration
  lib/
    guest-unlock.js         (must stay in sync with shared/guest-unlock.js)
    dates.js, logging.js, guest-token.js, elevator.js
  tests/                    53 tests, all passing

shared/
  guest-unlock.js           browser + server canonical unlock rules
  guest-register.js         registration payloads
  pipeline-admin.js         AdminAction client
  pipeline-guest.js         GuestRegister client
  pipeline-emulator.js      emulator connect + pipelineCallableName()
  hk-bedding.js             per-room bedding thresholds + SVG icons

checkin-admin-sandbox.html  swap UI, live reservations, HK tab, pipeline moves/unlock
checkin-guest-sandbox-2.html registration + unlock gate (emulator-aware)
SANDBOX_BACKEND_HANDOFF.md  step-by-step E2E playbook
```

**Not touched (live cutover deferred):** `checkin-admin.html`, `checkin-guest-v2.html`, `minihotel_reservation_sync.py`

---

## Issues found & fixed during Mac testing

| Issue | Root cause | Fix |
|-------|------------|-----|
| Emulator callable 404 | Client called `pipeline-adminAction`; emulator registers `adminAction` | `pipelineCallableName()` in `shared/pipeline-emulator.js` |
| Port 4000 conflict | Emulator UI | `npm run emulator:lite` |
| Room conflict on move | Working as designed | Swap UI added |
| "Awaiting unlock" after swap | Unlock not recomputed; wrong arrival date source | AdminAction recompute + reservation `checkin` + live `_resCache` |
| Stale unlock after ~10 swaps | Reservations cache never refreshed | `onSnapshot` + `refreshReservationsNow()` |
| HK missing guest count | Field is `guestCount` from MiniHotel | Read `reservations.guestCount` |
| Yellow-on-yellow HK text | CSS contrast | Dark counts + white alert box |

---

## Sandbox E2E — test together on Mac

### Prerequisites

```bash
cd ~/app
git fetch origin
git checkout cursor/hk-guest-count-7e07
git pull origin cursor/hk-guest-count-7e07
```

Node 18+, Firebase CLI (`npm install -g firebase-tools`), `firebase login` with access to `sleepy-5c962`.

### Terminal 1 — emulator

```bash
cd ~/app/pipeline-functions
npm install
npm test                    # expect 53/53
npm run emulator:setup      # creates .secret.local (password maxela2026)
npm run emulator:lite       # 127.0.0.1:5001, no UI port
```

### Terminal 2 — static server

```bash
cd ~/app
npx serve -p 8080 .
```

### URLs

- **Admin:** `http://127.0.0.1:8080/checkin-admin-sandbox.html?emulator=1`
- **Guest:** `http://127.0.0.1:8080/checkin-guest-sandbox-2.html?emulator=1&apt=6-1`

Blue banner at top = emulator mode active.

### Manual checklist

**Admin sandbox**

- [ ] **Grant Access** → `force_unlock`; `manualUnlock` + `unlockState` on guest; `system_logs` entries (`AdminAction`, `GuestUnlock`)
- [ ] **Move** to empty room → `reservations.roomCode` + `checkin_guests.aptId` updated; `room_moves` audit; guest doc ID unchanged
- [ ] **Swap** two occupied overlapping rooms → both guests exchange rooms; unlock stays correct (not "Awaiting unlock" if mid-stay or past check-in)
- [ ] **Conflict block** — move into occupied room without swap → UI error, no partial writes
- [ ] **HK tab** — guest count visible; bedding alert on threshold rooms; readable on yellow cards
- [ ] **Repeated swaps** (~10+) — room/form linking stays correct (reservation cache live)

**Guest sandbox**

- [ ] Unlock gate matches admin for same guest (before arrival / HK early / after 3pm / mid-stay / after midnight Tbilisi)
- [ ] Registration via emulator → stable 32-hex `guestToken` doc ID and `?g=` link
- [ ] After admin move/swap → same `?g=` link works; WiFi/photos follow new room

**Firestore verification**

```
system_logs where controller == "AdminAction"
system_logs where controller == "RoomAssignment"
system_logs where controller == "GuestUnlock"
room_moves (latest docs after move/swap)
```

---

## Deploy (only after sandbox sign-off)

```bash
firebase functions:secrets:set ADMIN_ACTION_PASSWORD --project sleepy-5c962
# Match admin sandbox password or rotate for prod

firebase deploy --only functions:pipeline:adminAction,functions:pipeline:guestRegister --project sleepy-5c962
```

After deploy, sandboxes work without emulator (remove `?emulator=1`).

---

## Claude Code review checklist

### Automated

- [ ] `cd pipeline-functions && npm test` → **53/53**
- [ ] `node scripts/check-guest-unlock-sync.js` → in sync
- [ ] No `v2_*` writes in `pipeline-functions/`
- [ ] Live HTML unchanged (`checkin-admin.html`, `checkin-guest-v2.html`)

### Code review focus

- [ ] `RoomAssignment` — atomic txn including `room_moves` audit; conflict policy; `affectedGuestIds`
- [ ] `AdminAction` — unlock recompute loop after successful move/swap
- [ ] `guest-unlock.js` — Tbilisi offset, reservation checkin precedence, midnight mid-stay
- [ ] Admin sandbox — swap UI calls `swap_guests` only; reservations live subscription
- [ ] Emulator naming — `pipelineCallableName()` correct for local vs prod

### Manual (Mac + emulator)

- [ ] Full checklist in **Sandbox E2E** section above
- [ ] Phone test after deploy (later phase)

---

## Still TODO (not in current stack)

1. **HKStatusSync** — route HK done through pipeline (HK tab still writes `hk_status` directly)
2. **ReservationSync** — replace `minihotel_reservation_sync.py` (planned later; do not touch yet)
3. **Wire live admin + guest** — `checkin-admin.html`, `checkin-guest-v2.html` after sandbox sign-off
4. **Recover Tuya function sources** in git before `functions:default` deploy
5. **Stronger auth** than password-in-callable (later phase)
6. **Single build step** for `guest-unlock.js` duplication (shared ↔ pipeline lib)

---

## Known limitations

1. Admin move/unlock/swap **require callable** (emulator locally or deploy) — no direct Firestore fallback.
2. Guest registration falls back to direct Firestore only when **not** in emulator mode.
3. `guest-unlock.js` duplicated in `shared/` and `pipeline-functions/lib/` — run `check:unlock` after edits.
4. GuestRegister has no App Check yet (same exposure as open Firestore rules today).
5. Companion docs still use `{room}_{date}` IDs (by design).

---

## Suggested Claude Code prompt

```
Review Maxela SleepyPMS sandbox backend + admin HK updates.

Read CLAUDE_CODE_REPORT.md (2026-08-30) and SANDBOX_BACKEND_HANDOFF.md first.
Branch: cursor/hk-guest-count-7e07 (or PRs #26, #28, #29).

Verify:
1. npm test in pipeline-functions (53 tests) + guest-unlock sync
2. RoomAssignment conflict policy, atomic writes, affectedGuestIds
3. AdminAction unlock recompute after move/swap
4. Admin sandbox swap UI + live reservation cache
5. HK bedding rules in shared/hk-bedding.js
6. Emulator callable naming (local vs prod)
7. system_logs coverage

Run Mac emulator E2E per handoff doc. Report bugs or cutover blockers before we deploy callables or wire live HTML.
```

---

*Updated by Cursor Cloud Agent — 2026-08-30. Re-run automated checks and update manual checklist boxes after Mac E2E.*
