# Backend map — Maxela SleepyPMS

**Firebase:** `sleepy-5c962` · **Region:** `europe-west1`  
**Last updated:** 2026-08-30

Visual overview: `SYSTEM_MAP_CURSOR.html`, `SYSTEM_CONNECTION_MAP.md`

---

## Layer diagram

```
┌─────────────────────────────────────────────────────────────────┐
│  BROWSER APPS (HTML + shared/*.js)                              │
│  checkin-admin-sandbox · checkin-guest-sandbox-* · HK.html      │
└────────────┬───────────────────────────────┬────────────────────┘
             │ HTTPS callable                 │ Firestore read/write
             ▼                                ▼
┌────────────────────────────┐    ┌───────────────────────────────┐
│  pipeline-functions/       │    │  FIRESTORE (one database)      │
│  Cloud Functions codebase  │    │                                │
│  ┌──────────────────────┐  │    │  checkin_rooms      ← registry│
│  │ adminAction          │──┼───►│  checkin_apartments ← content  │
│  │  → RoomAssignment    │  │    │  checkin_guests     ← forms    │
│  │  → GuestUnlock       │  │    │  reservations       ← PMS sync │
│  │ guestRegister        │  │    │  hk_status           ← HK done  │
│  │ elevatorCodeGuard ✅ │  │    │  hk_pins            ← HK auth   │
│  │ elevatorCodeSync  ✅ │  │    │  room_moves         ← audit     │
│  └──────────────────────┘  │    │  system_logs        ← pipeline  │
└────────────────────────────┘    │  globals/elevator_code          │
             ▲                    └───────────────────────────────┘
             │ RTDB reconcile
┌────────────┴────────────┐
│  Realtime Database      │
│  elevator display       │
└─────────────────────────┘

┌────────────────────────────┐
│  EXTERNAL                  │
│  MiniHotel API → Python    │
│  minihotel_reservation_sync│
│  GitHub Actions (schedule) │
└────────────────────────────┘
```

---

## Pipeline controllers

| Export | Deployed? | Trigger | Writes | Reads |
|--------|-----------|---------|--------|-------|
| `elevatorCodeGuard` | ✅ Yes | Firestore `globals/elevator_code` onWrite | Reverts stale auto writes | elevator doc |
| `elevatorCodeSync` | ✅ Yes | Hourly + manual HTTPS | FS ↔ RTDB elevator | both stores |
| `adminAction` | ❌ Sandbox only | HTTPS callable | orchestrates below | — |
| `guestRegister` | ❌ Sandbox only | HTTPS callable | `checkin_guests/{token}` | reservations |
| `RoomAssignment` | via adminAction | — | `reservations.roomCode`, `checkin_guests.aptId`, `room_moves`, `manualRoom` | reservations, guests |
| `GuestUnlock` | via adminAction | — | `unlockState`, `manualUnlock` | guests, hk_status, apartments |

**Callable names:** emulator `adminAction` / `guestRegister` · prod `pipeline-adminAction` / `pipeline-guestRegister`

**Auth v1:** password in request body → secret `ADMIN_ACTION_PASSWORD`

---

## AdminAction routes

| actionType | Handler | Notes |
|------------|---------|-------|
| `move_guest` | RoomAssignment.move | Block if conflict; sets `manualRoom: true` |
| `swap_guests` | RoomAssignment.swap | Exchange two occupied rooms |
| `release_to_minihotel` | RoomAssignment.release | Clears `manualRoom` |
| `force_unlock` | GuestUnlock | Sets `manualUnlock: true` |
| `force_lock` | GuestUnlock | Sets `manualUnlock: false` |

After successful move/swap → **GuestUnlock recompute** for all `affectedGuestIds` (warnings surfaced in response if any fail).

---

## Room registry (adding apartments)

| Source | Role |
|--------|------|
| **`shared/room-registry.js`** | Code default — edit to add rooms |
| **`checkin_rooms/{roomCode}`** | Runtime catalog — auto-synced from registry |
| **`checkin_apartments/{roomCode}`** | WiFi, photos, door — guest-facing |

MiniHotel sync merges `checkin_rooms.minihotelNames` into `ROOM_MAP` at runtime.

See **`docs/ADD_APARTMENT_GUIDE.md`**

---

## Guest unlock rules

Canonical: **`shared/guest-unlock.js`** ↔ **`pipeline-functions/lib/guest-unlock.js`** (must stay in sync — run `npm run check:unlock`)

| State | Condition |
|-------|-----------|
| Locked | Before arrival date |
| Waiting | Arrival day, before check-in hour, HK not done |
| Early unlock | Arrival day, HK done before 11:00 |
| Unlocked | After check-in hour, mid-stay, or `manualUnlock` |
| Timezone | Tbilisi UTC+4 (no DST) |

Arrival date: reservation `checkin` preferred over guest form `arrivalDate` when linked.

---

## HK data flow

```
reservations (checkout today, roomCode)
       +
checkin_rooms (showInHk, site)
       +
checkin_guests (aptId, arrival — for in-house cards)
       ↓
   HK board UI
       ↓ toggle done
hk_status/{roomCode}_{date}
       ↓
GuestUnlock (early unlock on arrival day)
```

**Sites:** shartava, centre, vgl, abashidze — PIN in `hk_pins`

---

## Shared JS modules

| Module | Used by |
|--------|---------|
| `shared/guest-unlock.js` | Guest sandboxes, admin sandbox, pipeline lib |
| `shared/guest-register.js` | Guest sandboxes |
| `shared/pipeline-admin.js` | Admin sandbox |
| `shared/pipeline-guest.js` | Guest sandboxes |
| `shared/pipeline-emulator.js` | Sandboxes (emulator connect) |
| `shared/hk-bedding.js` | Admin sandbox HK, HK.html (partial) |
| `shared/room-registry.js` | Admin sandbox, docs, future live admin |
| `shared/elevator-sync.js` | Admin sandbox elevator tab |

---

## Python / automation

| Script | Schedule | Role |
|--------|----------|------|
| `minihotel_reservation_sync.py` | GitHub Actions ~30min | Reservations → Firestore |
| `housekeeper_sync.py` | Disabled | Legacy HK scrape |
| `import-reservations.html` | Manual | Sheet import — **skips VGL** |

---

## Deploy commands

```bash
# Already live
firebase deploy --only functions:pipeline:elevatorCodeGuard,functions:pipeline:elevatorCodeSync

# After owner approval (sandbox validated)
firebase functions:secrets:set ADMIN_ACTION_PASSWORD --project sleepy-5c962
firebase deploy --only functions:pipeline:adminAction,functions:pipeline:guestRegister --project sleepy-5c962
```

---

## Tests & CI

```bash
cd pipeline-functions && npm test          # 54/54
node scripts/check-guest-unlock-sync.js
```

GitHub Actions: `.github/workflows/pipeline-functions-test.yml`

---

## Not built yet

| Controller | Purpose |
|------------|---------|
| HKStatusSync | Route HK done through pipeline |
| ReservationSync | Replace Python (later) |
| Live admin/guest wiring | Point production HTML at pipeline + registry |

---

## Key files index

```
pipeline-functions/controllers/   ← all backend logic
shared/                           ← browser + sync helpers
checkin-admin-sandbox.html        ← admin + HK (sandbox)
checkin-guest-sandbox-2.html      ← guest flow (sandbox)
docs/ADD_APARTMENT_GUIDE.md       ← add rooms/buildings
PROJECT_ARCHIVE.md                ← full project history
CLAUDE_CODE_REPORT.md             ← handoff for reviewers
```
