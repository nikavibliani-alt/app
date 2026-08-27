# PIPELINE_DESIGN_CURSOR.md — Maxela Backend Rebuild (Cursor proposal)

**Status:** Phase 1 dry-run in `sandbox_rebuild/` uses temporary `v2_*` names in MemoryStore only.  
**Production schema:** See **`MASTER_ARCHITECTURE_CURSOR.md`** — **one Firestore**, no parallel v1/v2 collections. Controllers write to existing `checkin_guests`, `reservations`, etc.  
**Author:** Cursor (parallel to Claude Code’s design track)  
**Date:** 2026-08-27  
**Sources read:** `SYSTEM_CONNECTION_MAP.md`, `CHECKIN_ADMIN_SPEC.md`, `CHECKIN_GUEST_SPEC.md`, `CODEBASE.md`

> Implementation lives in `sandbox_rebuild/pipeline/`. Default = in-memory only. No writes to live Firebase collections.

---

## 0. Plain-language summary (for Nika)

**Today’s core bug:** “Which room is this guest in?” is stored in **three places** that can disagree:
1. the booking (`reservations.roomCode`)
2. the guest form (`checkin_guests.aptId`)
3. the guest form’s **document ID** itself (`6-1_2026-08-20` — room baked into the ID)

When admin moves a guest, or MiniHotel changes a room, those three can get out of sync. Then guests see the wrong WiFi/door photos, admin shows the wrong room, and sometimes a guest “disappears.”

**New system idea:**
- One official answer for “who is in which room” → a new **Assignments** record
- One small program (controller) per job
- Moves are all-or-nothing (never half-finished)
- Every failure is logged; important ones alert you
- Build next to the live system (`v2_…` data) until it is safe to switch

---

## §1 — Single source of truth for room assignment

### 1.1 The decision

| Role | Collection / field | Notes |
|------|-------------------|--------|
| **AUTHORITATIVE (new)** | `v2_assignments/{assignmentId}` → field **`roomCode`** | The only place that answers “which room is this stay in?” |
| Booking mirror | `v2_reservations/{id}.roomCode` | Copied **from** assignment after assignment wins (or written only by ReservationSync when not manually locked) |
| Guest form mirror | `v2_guests/{guestId}.roomCode` | Copied **from** assignment; guest forms use **stable IDs** (never encode room in the ID) |
| Content lookup | `checkin_apartments/{roomCode}` | Unchanged: WiFi, photos, instructions for a room |
| Live legacy (read-only during sandbox) | `reservations`, `checkin_guests` | Bridged into `v2_*` for testing; not written by new controllers until cutover |

**Assumption (flagged):** Creating `v2_assignments` is better than picking one of the three existing fields, because:
- existing `checkin_guests` IDs encode the room (hard to “move” without creating/deleting docs)
- `reservations.roomCode` is also overwritten by MiniHotel sync unless `manualRoom` is set
- a dedicated assignment row can own conflict checks, move history, and locks cleanly

**Assumption (flagged):** One booking with multiple rooms = **one assignment per room slot** (same `reservationNumber`, different `slot` / `assignmentId`). Matches how MiniHotel already splits multi-room docs.

### 1.2 What `v2_assignments` stores

| Field | Meaning |
|-------|---------|
| `assignmentId` | Stable ID (never changes when room changes) |
| `reservationId` | Link to booking doc |
| `reservationNumber` | Human/booking reference |
| `guestId` | Link to guest form, or `null` until registered |
| `roomCode` | **THE room** (single source of truth) |
| `checkin` / `checkout` | Stay dates (YYYY-MM-DD, Tbilisi calendar) |
| `status` | `active` \| `cancelled` \| `checked_out` |
| `lockSource` | `minihotel` \| `admin` |
| `manualRoom` | `true` if admin overrode MiniHotel |
| `updatedAt` / `updatedBy` | Audit |
| `version` | Integer; increments on every room change (optimistic concurrency) |

### 1.3 Who may write `roomCode`?

| Writer | Allowed? | When |
|--------|----------|------|
| **RoomAssignment controller** | **YES — only writer of authoritative room moves** | Admin move, conflict resolution, explicit repair |
| **ReservationSync controller** | YES, but **only if `manualRoom !== true`** | MiniHotel says room changed |
| Guest page | **NO** | May create guest form + link `guestId`; must not set room except via initial registration matching (see below) |
| Admin HTML directly | **NO** (after cutover) | Must call AdminAction → RoomAssignment |
| HK apps / WhatsApp / Elevator | **NO** | |

**Initial registration rule:** When a guest first matches a booking, GuestRegister controller sets `guestId` on the existing assignment for that reservation/slot. It does **not** invent a new room. Room comes from the assignment already created by ReservationSync.

### 1.4 Who may read room?

| Reader | Reads |
|--------|--------|
| Guest page (home, WiFi, photos, door) | `assignment.roomCode` → then `checkin_apartments/{roomCode}` |
| Admin Stay list | `assignment.roomCode` (display); never prefer a stale `aptId` over assignment |
| Unlock rules | assignment + guest + hk_status for that `roomCode` |
| Notifications | assignment.roomCode + guest contact |

### 1.5 Occupancy conflict (bug #5)

Before any move to room `B` for dates `[checkin, checkout)`:

1. Query assignments where `roomCode == B` AND dates overlap AND `status == active`
2. Exclude the assignment being moved
3. If another guest/booking found → **do not write anything yet**

**Default behavior (LOCKED):** **BLOCK + WARN**, with optional **SWAP**  
Show: other guest name, reservation number, dates.  
Admin must choose:

| Choice | Meaning |
|--------|---------|
| **Cancel** | Do nothing |
| **Swap** | Atomic: A↔B for the two assignments |

**Displace is not allowed in v1** (avoids lost-guest class bugs).

### 1.6 Preventing “lost guest”

| Old failure | New rule |
|-------------|----------|
| Guest doc ID was `oldRoom_date`; move updated `aptId` but ID still old / duplicate created | Guest IDs are stable UUIDs (or `g_{reservationNumber}_{slot}`); room is only a field |
| Move updated guest but not reservation (or vice versa) | Only RoomAssignment writes room; one transaction updates assignment + mirrors |
| Target room’s previous guest overwritten | Conflict check + no silent overwrite |
| Orphan in old room | Old room has no “ghost” guest: occupancy is computed from assignments, not leftover docs |

---

## §2 — Pipeline controllers

All new code lives under something like `pipeline/` (name TBD). Each controller is one module, one job, one log stream.

### Shared conventions

| Rule | Detail |
|------|--------|
| Log every run | `v2_system_logs/{autoId}` |
| Alert on error | Also write `v2_system_alerts/{autoId}` with `acked:false` |
| Own only listed writes | Writes outside “Owns” = bug |
| Idempotent where possible | Re-running same input should not duplicate side effects |
| Timezone | Tbilisi (`UTC+4`) for all date/hour rules |

---

### Controller 1 — `ReservationSync`

| | |
|--|--|
| **Name** | ReservationSync |
| **Trigger** | Cron (~10 min via cron-job.org → GitHub Action), same as today |
| **Input** | MiniHotel Calendar API (existing endpoints/credentials) |
| **Output** | Upsert `v2_reservations/*`; upsert/update `v2_assignments/*` when unlocked |
| **Owns** | `v2_reservations` (all booking fields except authoritative room when `manualRoom`); assignment fields `reservation*`, dates, `status` from MiniHotel; `roomCode` **only if** `manualRoom !== true` |
| **Never touches** | `v2_guests`, elevator, hk_status, WhatsApp, `checkin_apartments`, live `reservations` (until cutover) |
| **Error behavior** | Log error; do not partially apply a batch if transaction fails; alert if 2 consecutive runs fail |
| **Test** | Dry-run mode writes only to `v2_*` + log; compare counts vs MiniHotel sample |

**Maps to bugs:** #3 (MiniHotel room changes), #4 (admin wrong room — keeps booking fresh)

---

### Controller 2 — `RoomAssignment`  ★ most important

| | |
|--|--|
| **Name** | RoomAssignment |
| **Trigger** | AdminAction (`move`, `swap`, `displace`, `repair`); never called directly from raw HTML after cutover |
| **Input** | `assignmentId`, `toRoomCode`, `mode`, `actor` |
| **Output** | Updated `v2_assignments.roomCode` (+ mirrors); `v2_room_moves` audit doc |
| **Owns** | `v2_assignments.roomCode`, `manualRoom`, `lockSource`, `version`; mirrors `v2_guests.roomCode`, `v2_reservations.roomCode`+`manualRoom`; **only writer** of `v2_room_moves` |
| **Never touches** | MiniHotel API, WhatsApp, elevator, hk_status, apartment content |
| **Error behavior** | Transaction abort → no change; log + alert; return clear error to admin UI |
| **Test** | Unit tests with emulator: empty move, conflict block, swap, rollback on forced failure mid-transaction |

**Maps to bugs:** #1, #4, #5, #6 (isolates room logic)

*(Detailed rules in §3.)*

---

### Controller 3 — `GuestRegister`

| | |
|--|--|
| **Name** | GuestRegister |
| **Trigger** | Guest completes registration on sandbox/v2 guest page |
| **Input** | Matched `reservationId` / assignment, passport upload result, contact |
| **Output** | Create `v2_guests/{stableId}`; set `v2_assignments.guestId`; optional `search_failures` on failed match |
| **Owns** | `v2_guests` profile fields; `assignment.guestId` link; `v2_search_failures` |
| **Never touches** | `assignment.roomCode`, reservations room, elevator |
| **Error behavior** | If assignment missing → fail loudly (do not invent room); log |
| **Test** | Register against fixture assignment; assert guest ID stable across room moves |

**Maps to bugs:** #1 (wrong instructions — room always from assignment), #6

---

### Controller 4 — `GuestUnlock`

| | |
|--|--|
| **Name** | GuestUnlock |
| **Trigger** | Scheduled tick (e.g. every 1–5 min) **and/or** callable read model refreshed on guest/admin open; AdminAction `force_unlock` / `force_lock` |
| **Input** | assignment (room, dates), guest (`manualUnlock`, `blocked`), `v2_hk_status` or bridged `hk_status`, apartment `checkInTime` |
| **Output** | Writes **derived** unlock state: `v2_guests.unlockState` = `locked` \| `unlocked` \| `blocked` + `unlockReason` + `computedAt` |
| **Owns** | `v2_guests.unlockState*` and admin force flags (`manualUnlock`) via AdminAction only |
| **Never touches** | roomCode, reservations, elevator content |
| **Error behavior** | On compute failure leave previous state + log warn; never silently unlock |
| **Test** | Table-driven tests: before date / on date before hour / HK early / manual / blocked |

**Assumption:** Unlock becomes a **stored derived field** written by one controller, so admin + guest stop re-implementing `isUnlocked()` / `guestStatus()` in three HTML files.  
**Maps to bugs:** #6 (logic duplication), early-access consistency

---

### Controller 5 — `ElevatorCodeSync`

| | |
|--|--|
| **Name** | ElevatorCodeSync |
| **Trigger** | AdminAction `set_elevator`; hourly monitor cron |
| **Input** | New code/QR from admin; or read current RTDB+Firestore timestamps |
| **Output** | Dual-write RTDB `/elevator_code` + `globals/elevator_code` **in one controller** with verification read-back; alert if stale > threshold |
| **Owns** | Elevator dual-write + `v2_system_alerts` for stale |
| **Never touches** | guests, rooms, reservations |
| **Error behavior** | If RTDB write ok but Firestore fails (or reverse) → alert `elevator_partial_write`; do not claim success |
| **Test** | Staging dual-write with mock; monitor alert dry-run |

**Maps to bugs:** #2  
**LOCKED:** Keep dual-write for v1 (guest + monitor depend on both). Firestore-only is a later cleanup.

---

### Controller 6 — `GuestNotification`

| | |
|--|--|
| **Name** | GuestNotification |
| **Trigger** | Cron (room-ready daily); future: event from HKStatusSync; optional AdminAction resend |
| **Input** | Today’s assignments + hk done + guest contact + prior `v2_whatsapp_messages` |
| **Output** | Send WhatsApp; log `v2_whatsapp_messages` |
| **Owns** | outbound notification logs; send calls |
| **Never touches** | room assignment, unlock state (reads only) |
| **Error behavior** | Log fail; write alert; **no second sender** in parallel (retire/disable `roomReadyNotification` CF as part of rollout) |
| **Test** | Fixture guests with/without phone; assert idempotent “already sent” |

**Maps to bugs:** duplicate notify fragile spot; supports #3/#5 indirectly by reading assignment room

---

### Controller 7 — `HKStatusSync`

| | |
|--|--|
| **Name** | HKStatusSync |
| **Trigger** | HK app “done” (via thin API / AdminAction wrapper); bridge from live `hk_status` during sandbox |
| **Input** | `roomCode`, `date`, `done`, cleaner optional |
| **Output** | `v2_hk_status/{roomCode}_{date}` |
| **Owns** | `v2_hk_status` (+ optional `v2_hk_cleaner`) |
| **Never touches** | assignments.roomCode, guests profile (may notify GuestUnlock to recompute) |
| **Error behavior** | Reject invalid room codes; log |
| **Test** | Mark done → unlock compute flips under early-unlock rules |

---

### Controller 8 — `AdminAction`

| | |
|--|--|
| **Name** | AdminAction |
| **Trigger** | Every admin button that changes state (move, unlock, elevator, apt save, resolve failure, request status) |
| **Input** | `actionType`, payload, `actor` (admin session id) |
| **Output** | Calls the owning controller; wraps in validation; returns `{ok, errorCode, message}` |
| **Owns** | Orchestration only + `v2_system_logs` for the admin intent; does not bypass RoomAssignment for moves |
| **Never touches** | Direct Firestore room fields without RoomAssignment |
| **Error behavior** | On failure return error to UI; if multi-step and partial → trigger compensating rollback where defined |
| **Test** | Integration: each action type against emulator |

**Extra (recommended) Controller 9 — `ApartmentContent`**  
Owns `checkin_apartments` / `v2_apartments` writes (WiFi, photos). Separates “room **content**” from “room **assignment**” so editing WiFi cannot corrupt who is in the room.  
**Maps to bug #1** (wrong instructions often = wrong room pointer, but content bugs stay isolated).

**Extra (recommended) Controller 10 — `ServiceRequest`**  
As in the brief: guest creates, admin confirms/cancels; owns `v2_service_requests` only.

---

## §3 — Room assignment rules (fix for bug #5)

These are **hard rules** for `RoomAssignment`.

### RULE 1 — Conflict check before write
- Always query overlapping active assignments for target room.
- If conflict: return `CONFLICT` with other guest/booking summary.
- **Never silently overwrite.**

### RULE 2 — Move is atomic
In one Firestore transaction:
1. Read assignment + version; abort if version mismatch (someone else moved it)
2. Conflict check again inside transaction
3. Set `roomCode` on assignment; set `manualRoom=true`, `lockSource=admin`, bump `version`
4. Mirror to `v2_guests.roomCode` if `guestId` set
5. Mirror to `v2_reservations.roomCode` + `manualRoom=true`
6. Write `v2_room_moves/{id}` audit  
If any step fails → **abort entire transaction** (no half-move).

### RULE 3 — Old room is cleared by definition
- Occupancy of room A is “all active assignments with roomCode=A”.
- After move to B, A no longer lists this assignment.
- No orphan guest docs keyed by old room ID (stable guest IDs).
- Do not delete history; cancelled/old links remain in `v2_room_moves`.

### RULE 4 — Every move is logged forever
`v2_room_moves/{id}`:

| Field | Example |
|-------|---------|
| `assignmentId` | … |
| `guestId` | … |
| `fromRoom` / `toRoom` | `6-1` → `6-2` |
| `mode` | `move` \| `swap` \| `displace` |
| `actor` | `admin:nika` |
| `at` | server timestamp |
| `beforeVersion` / `afterVersion` | 3 → 4 |
| `conflictWith` | optional |

**Never deleted** (retention: keep indefinitely unless Nika later sets a policy).

### RULE 5 — MiniHotel vs admin lock
- If `manualRoom=true`, ReservationSync **must not** change `roomCode`.
- Admin **“Follow MiniHotel again”** (`release_to_minihotel`) clears `manualRoom` so sync can take over again. Always logged.

### RULE 6 — Swap path
Swap(A,B): one transaction exchanges `roomCode` on two assignments; two `v2_room_moves` rows; both mirrors updated.

### RULE 7 — No Displace in v1
There is no “kick other guest to UNASSIGNED” path in phase 1.
---

## §4 — Error handling & logging

### Collections

| Collection | Purpose |
|------------|---------|
| `v2_system_logs` | Every controller action (ok/warn/error) |
| `v2_system_alerts` | Errors (and critical warns) for admin badge |
| `v2_room_moves` | Room change audit (see §3) |

### Log schema (`v2_system_logs`)

| Field | Type | Notes |
|-------|------|-------|
| `controller` | string | e.g. `RoomAssignment` |
| `action` | string | e.g. `move` |
| `input` | map | sanitized (no passport images) |
| `output` | map | ids / room codes |
| `status` | `ok` \| `warn` \| `error` |
| `message` | string | human readable |
| `timestamp` | serverTimestamp | |
| `correlationId` | string | ties multi-step admin actions |

### Alert schema (`v2_system_alerts`)

Same core fields + `acked` (bool), `ackedAt`, `severity` (`warn`\|`error`\|`critical`).

### No silent failures
- Controllers throw/return errors; AdminAction surfaces toast + alert.
- Guest-facing: show “something went wrong, contact host” rather than empty door section with no log.
- Elevator partial dual-write → always alert.

### Admin visibility (sandbox first)
- New “System health” row under More: unread alerts count.
- Later: same in live admin after cutover.

---

## §5 — Sandbox approach (build without breaking live)

```
Live (untouched)                  Parallel v2 (new)
─────────────────                 ─────────────────
reservations        ──bridge──►   v2_reservations
checkin_guests      ──bridge──►   v2_guests (+ stable ids mapping table)
hk_status           ──bridge──►   v2_hk_status
…                                 v2_assignments  ← built by controllers
                                  v2_system_logs / alerts / room_moves
```

| Piece | Behavior |
|-------|----------|
| Live admin / live guest | **No edits** during build |
| `checkin-admin-sandbox.html` | Phase 2: optional switch to read `v2_*` behind a flag |
| Controllers | Write **only** `v2_*` until cutover |
| Bridge job | Read-only copy live → v2 for realistic tests (scheduled) |
| Mapping table | `v2_id_map` oldGuestDocId → new stable guestId |

**Assumption:** Do not rename live collections until cutover day; `v2_` prefix is safer than writing new fields into live docs.

---

## §6 — What stays the same

| Keep | Why |
|------|-----|
| MiniHotel API + credentials | Working source of bookings |
| Guest page URLs guests already have | No broken links |
| Firebase project `sleepy-5c962` | Same backend project |
| Tuya (as-is) | Writer still unknown; do not invent a fake writer in v1 pipeline |
| WhatsApp message copy | Same guest-facing text |
| Live collection names until cutover | Avoid big-bang rename risk |
| Pricing engine | Out of scope for this room/check-in pipeline |
| SleepyPMS `properties` | Out of scope for phase 1 (note drift risk remains until later) |

**Explicit non-goals for phase 1:** rewriting guest UI redesign, replacing HK apps’ UI, fixing all four room-list masters.

---

## §7 — Migration plan (no guest outage)

### Phase A — Design freeze
- Compare Cursor vs Claude design docs
- Nika answers decision list below
- No production writes

### Phase B — Emulator / `v2_` controllers
1. Implement RoomAssignment + logging first (highest bug value)
2. Implement ReservationSync → `v2_reservations` + `v2_assignments`
3. Bridge live data nightly/hourly into `v2_*`
4. Add GuestUnlock, ElevatorCodeSync, HKStatusSync, GuestNotification
5. AdminAction API (Cloud Functions or callable) used by a **dev-only** admin page or feature flag in admin sandbox

### Phase C — Shadow mode
- Controllers run on `v2_*`
- For each live admin move (still old code), optionally **also** log what RoomAssignment *would* have done (shadow compare)
- Fix mismatches until shadow agrees for 1–2 weeks of real ops

### Phase D — Sandbox cutover
- Admin sandbox + guest sandbox-2 read assignments from `v2_*`
- Live URLs still on old system

### Phase E — Production cutover (maintenance window optional but not required if dual-read)
1. Enable dual-read on live guest: prefer assignment if present else legacy
2. Switch live admin moves to AdminAction → RoomAssignment
3. Stop legacy `moveGuest` writes
4. Keep bridge reverse or one-way sync as safety for 7 days
5. Disable duplicate `roomReadyNotification` CF permanently if GuestNotification owns sends
6. Only later: drop legacy aptId-in-doc-id creates

### Phase F — Cleanup
- Remove duplicate unlock functions from HTML (call unlockState)
- Document runbooks: “guest wrong room” → check `v2_assignments` + last `v2_room_moves`

---

## How this fixes the 6 problems

| # | Problem | Fix |
|---|---------|-----|
| 1 | Guest sees wrong apartment instructions | Guest always loads content via `assignment.roomCode` → apartments; stable guest id so moves don’t orphan forms |
| 2 | Elevator stale / not updating | Single ElevatorCodeSync owns dual-write + verify + alert |
| 3 | MiniHotel room changes not reflected | ReservationSync updates assignment when not manually locked |
| 4 | Admin shows wrong room | Admin list reads assignment SoT, not competing aptId/docId |
| 5 | Move corrupts rooms | Conflict check + atomic transaction + audit + no silent overwrite |
| 6 | Fixing one bug breaks another | Controllers own isolated write sets; shared unlock/room logic not copy-pasted in 3 HTML files |

---

## Design assumptions (explicit)

1. **`v2_assignments` is new SoT** rather than anointing `reservations.roomCode` alone — because guest doc IDs encode room today.
2. **Unlock state is written by GuestUnlock** rather than computed independently in every UI.
3. **Displace is disabled in v1**; only block + swap.
4. **Tuya password writer** remains unknown; phase 1 reads `tuyaPassword` if present else apartment `doorCode`, and logs when missing — no fake generator.
5. **Pricing / Sleepy room master lists** not unified in phase 1.
6. **Sandbox prefix `v2_`** for all new writes until cutover.
7. **Shadow period = 2 weeks** before live move cutover.
8. **“Follow MiniHotel again”** is included to clear `manualRoom`.

---

## LOCKED DECISIONS (Nika deferred to Cursor — 2026-08-27)

| # | Topic | Decision |
|---|--------|----------|
| 1 | Conflict policy | **Block + Swap only.** No silent overwrite. No Displace-to-UNASSIGNED in v1 (too easy to “lose” a guest). If conflict and admin does not want swap → Cancel. |
| 2 | Follow MiniHotel again | **Yes.** AdminAction `release_to_minihotel` clears `manualRoom` so ReservationSync may update room again. Logged in `v2_room_moves`. |
| 3 | Elevator storage | **Keep dual-write RTDB + Firestore in v1** (ElevatorCodeSync owns both + verify). Firestore-only is a later cleanup after monitor is updated. |
| 4 | Stable guest IDs | **Yes.** New `v2_guests` use stable IDs; `v2_id_map` bridges old `{room}_{date}` ids during migration. |
| 5 | Shadow period | **2 weeks** of shadow compare before live admin moves switch to RoomAssignment. |
| 6 | Displaced guests | **N/A in v1** (Displace disabled). Future “Needs room” bucket only if we add Displace later. |
| 7 | Multi-room | **One assignment per room slot** (confirmed design). |
| 8 | AdminAction auth (v1) | **Same password gate as today** for sandbox/admin calls. Stronger auth is a later phase — not a blocker for pipeline correctness. |

---

## NEED NIKA DECISIONS (before build)

~~All items above are now locked.~~ No open product decisions remain for phase-1 pipeline design.

If Claude’s `PIPELINE_DESIGN.md` conflicts on SoT or move rules, prefer:
1. This doc’s **assignments SoT + atomic RoomAssignment**
2. **Block+Swap only** (safer than Displace)
3. Then merge any stronger logging/test detail from Claude’s version

---

## Suggested build order (after approval)

1. Logging + alerts schema  
2. RoomAssignment + room_moves (with emulator tests)  
3. ReservationSync → assignments  
4. GuestRegister + stable ids  
5. GuestUnlock  
6. ElevatorCodeSync  
7. HKStatusSync + GuestNotification  
8. AdminAction façade + sandbox UI wiring  

---

*End of Cursor design. No implementation performed. No commit made. Waiting for comparison with Claude’s design + Nika’s decisions.*
