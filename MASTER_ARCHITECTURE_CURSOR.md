# MASTER_ARCHITECTURE_CURSOR.md — Maxela / SleepyPMS foundation

**Status:** Architecture lock — implementation follows sandbox → shadow → live cutover  
**Date:** 2026-08-27  
**Audience:** Nika + any builder (Cursor, Claude, future SleepyPMS team)

> **Main goal:** Structure the system so bugs are **easy to find and fix** — not patched on top of a fragile stack. Every fix goes through a **named controller** with one job, one write set, and audit logs. Live pages stay live until an explicit cutover.

**Related docs:**
- `PIPELINE_DESIGN_CURSOR.md` — controller pipeline + `v2_*` collections
- `GUEST_CHECKIN_REDESIGN.md` — guest/admin UX (§22 elevator, admin sandbox)
- `SYSTEM_MAP_BEGINNER_VISUAL.html` — beginner flow diagram
- `sandbox_rebuild/` — dry-run implementation

---

## 0. Principles (non-negotiable)

| # | Rule |
|---|------|
| 1 | **One writer per fact** — only one controller may write each field (room, unlock, elevator code, HK done). HTML pages call APIs; they do not `setDoc` business logic directly after cutover. |
| 2 | **Build beside live** — new logic writes `v2_*` first; live `reservations` / `checkin_guests` bridged read-only until shadow mode passes. |
| 3 | **No silent dual-write** — if Firestore succeeds and RTDB fails (or reverse), show error and retry; never toast “success”. |
| 4 | **Everything editable** — alpha PMS: labels, times, passwords, visibility, room lists live in config/docs, not hardcoded in 4 files. |
| 5 | **Document every decision** — this file + pipeline design are the “best version”; SleepyPMS will inherit this schema. |
| 6 | **Passport = maximum security** — no public Storage rules; guest session required to read own upload; admin role required for staff view. |

---

## 1. Firestore — best setup for Maxela

### 1.1 What is wrong today

| Problem | Impact |
|---------|--------|
| Room truth in 3 places (`reservations.roomCode`, `checkin_guests.aptId`, doc ID `{room}_{date}`) | Admin “NO FORM”, wrong WiFi/door after move |
| Guest identity = browser `localStorage` only | Guest “logged out” after browser clear; re-register creates duplicate docs |
| Admin password in HTML plaintext + `localStorage` | Not real security |
| `passport_uploads` Storage: `allow read, write: if true` | Anyone with URL can read passports |
| Elevator: FS + RTDB, timestamp-only merge, no manual/auto priority | Manual fix reverted by stale auto; guest pages read different stores |
| Business logic copy-pasted across 3 guest HTML + 2 admin HTML + 3 HK HTML | Fix one place → break another |

### 1.2 Target collection layout

```
# --- AUTHORITATIVE (v2 — new pipeline) ---
v2_assignments/{assignmentId}     ← SINGLE source: which room is this stay in?
v2_reservations/{reservationId}  ← mirror from MiniHotel / future SleepyPMS
v2_guests/{guestId}              ← stable UUID; NEVER encode room in ID
v2_elevator/current              ← SINGLE elevator doc (FS); RTDB mirror for speed
v2_hk_status/{roomCode}_{date}    ← clean/done + optional time overrides
v2_config/admin                    ← hashed passwords, feature flags (not in HTML)
v2_config/properties               ← room catalog (replaces 4 hardcoded lists)
v2_system_logs/{autoId}            ← every controller action
v2_system_alerts/{autoId}          ← failures needing human attention
v2_room_moves/{autoId}             ← audit forever

# --- LEGACY (read during migration; write frozen at cutover) ---
reservations/
checkin_guests/
checkin_apartments/
globals/elevator_code
hk_status/
hk_pins/
checkin_admin/config
```

### 1.3 Firestore rules strategy (production target)

| Actor | Access |
|-------|--------|
| **Guest** | Firebase Auth anonymous or custom token tied to `v2_guests/{guestId}`. Read own guest doc + own assignment + apartments for assigned room + elevator (if eligible). Write own guest fields only via Cloud Function `guestRegister`. |
| **Admin** | Firebase Auth email/password (or custom claim `admin`). All ops via callable functions (`adminAction/*`). |
| **HK staff** | Auth with `hk` claim OR short-lived PIN → custom token. Read/write `v2_hk_status` for today only via `hkAction`. |
| **Phone elevator app** | Service account or device credential with **only** `v2_elevator` auto-write permission. |
| **Public** | Deny all by default. |

### 1.4 Passport storage (security)

| Today | Target |
|-------|--------|
| `passport_uploads/{uuid}/{uuid}` public read/write | `passports/{guestId}/{uploadId}` — **no public access** |
| `passportUrl` on guest doc | `passportStoragePath` + signed URL generated server-side for admin view |
| Gemini scan in browser | Move scan to Cloud Function; store result on guest doc; alert on invalid |

**Guest comfort + security together:**
- Stable `guestId` (UUID) — login = prove you own this reservation (name + check-in date + optional SMS/email later)
- `localStorage` keeps session for same phone/browser
- Different browser → same login flow finds existing `v2_guests/{guestId}`, no new doc
- Passport upload once → stored permanently unless guest explicitly replaces

---

## 2. Elevator QR + code — full functional spec

### 2.1 Actors

1. **Phone app (yours)** — reads new QR + numeric code from building system → writes Firestore/RTDB automatically (`source: auto`)
2. **Admin manual** — you paste/type when phone app fails (`source: manual`)
3. **Guest pages** — read one canonical path, show code + QR for 6-x / 7-x rooms
4. **Elevator monitor** — hourly stale check + email alert

### 2.2 Single document shape (`v2_elevator/current`)

```json
{
  "display_code": "4521#",
  "qr_code": "<payload for QR>",
  "expires_at": "<ISO or ms — next expected rotation>",
  "updatedAt": "<server timestamp>",
  "updatedBy": "phone-app | admin:{uid} | monitor",
  "source": "auto | manual",
  "manualLockUntil": "<ISO|null>",
  "codeVersion": 3
}
```

RTDB `/elevator_code` mirrors the same fields (written in same transaction or verified immediately after).

### 2.3 Priority rules (your requirement — locked)

```
WHEN admin saves manually:
  1. Write FS + RTDB atomically (ElevatorCodeSync controller)
  2. Set source = 'manual'
  3. Set manualLockUntil = end of today (Tbilisi) + 6 hours buffer
     (or until host taps "Allow phone app to update" — optional UI)
  4. Guest pages immediately show manual value

WHEN phone app writes (source = auto):
  IF manualLockUntil exists AND now < manualLockUntil:
    IF new code equals current code → no-op
    ELSE → REJECT auto write; log v2_system_alerts "auto blocked by manual lock"
  ELSE:
    Accept auto write (new day / lock expired / app working again)
    Set source = 'auto'; clear manualLockUntil
    Guest pages show new code

WHEN admin saves manually:
  Always updates BOTH stores (your requirement: manual must sync to Firestore too)
  Always clears any stale RTDB-only drift
```

**Plain language:** Your manual fix **wins for the rest of that day**. Tomorrow when the building rotates the code and your phone app works, the app **may overwrite** with the new code.

### 2.4 Guest read path (one path only)

All guest pages (live + sandbox) → `onSnapshot(v2_elevator/current)` OR bridged `globals/elevator_code` during migration.

- Use `qr_code` for QR image, `display_code` for numeric display
- Stale: hide code after 36h without update; show “contact host”
- Monitor alerts ops at 26h

### 2.5 Implementation status

| Piece | Status |
|-------|--------|
| Admin sandbox dual-write + `source:manual` + error card | ✅ Done in `checkin-admin-sandbox.html` |
| Manual lock / auto reject | ❌ Not built — **ElevatorCodeSync controller** |
| Phone app writer documented | ❌ External — needs service account + `source:auto` |
| Production admin parity | ❌ `checkin-admin.html` missing `source` + error handling |
| Guest single read path | ❌ v2 uses FS only; `checkin-details.html` still RTDB seed |

---

## 3. Guest form persistence — fix “NO FORM” and data loss

### 3.1 Root causes (confirmed in codebase)

1. **Guest doc ID = `{room}_{date}`** — room move creates orphan doc; admin join fails
2. **`matchedReservationId` drift** — MiniHotel sync changes reservation doc ID
3. **`arrivalDate` ≠ reservation.checkin`** — guest typed wrong date
4. **Admin cleanup** — `deleteOldGuests`, `cleanDuplicateGuests` removes docs admin was matching
5. **localStorage-only session** — different browser = looks like new guest; re-register can create second doc if date/room differ
6. **Upload timeout** — registration never writes Firestore if passport upload fails

### 3.2 Target model

```
v2_assignments/{id}  ← room truth
v2_guests/{guestId}  ← stable UUID, created on first successful registration
  reservationId / assignmentId  ← link to stay (not room in ID)
  passportStoragePath
  expectedCheckInWindow   ← from sandbox guest page
  guestConfirmedCheckin
  manualUnlock
  sessionVersion          ← bump on logout-everywhere (future)
```

**Guest login flow (target):**
1. Search reservation (name + date) — unchanged UX
2. If `v2_guests` already linked to this assignment → **restore session**, show home (passport already on file)
3. If new → register once → create `v2_guests/{uuid}`, link to assignment
4. Re-open same browser → `localStorage.guestId` → load existing doc
5. New browser → same search → finds same guest by assignment link → no duplicate

**Admin join (target):**
- Match reservation → assignment → guest by `assignmentId` / `guestId`
- **Never** match by `aptId + arrivalDate + name fuzzy` alone

### 3.3 Interim fixes (before v2 cutover)

| Fix | Where |
|-----|-------|
| Stop auto-deleting guest docs without archive | `checkin-admin.html` `deleteOldGuests` |
| Write `checkoutDate` on v2 guest doc | Port from sandbox-2 to live guest |
| Show `expectedCheckInWindow` in admin + HK | Join `checkin_guests` on Stay card |
| Harden join: prefer `matchedReservationId` + assignment bridge | Admin sandbox first |

---

## 4. HK app inside admin panel

### 4.1 Current state

- HK: separate HTML files (`HK.html`, `HK-Shartava.html`, `HK-Centre.html`, `hk-manage.html`)
- Admin sandbox: **HK Pins** under More; **no task board**
- HK marks done → writes `hk_status` + sets `checkin_guests.manualUnlock`
- Guest approximate arrival: saved as `expectedCheckInWindow` in sandbox guest — **HK still shows 14:00**

### 4.2 Target (admin sandbox → live)

**More → Housekeeping** (or bottom-nav slot when configured):

| Feature | Source |
|---------|--------|
| Today’s checkout rooms + incoming guests | `reservations` + `v2_hk_status` |
| Mark room done | `hkAction.markDone` → `v2_hk_status` + optional guest unlock |
| Guest arrival time on card | `v2_guests.expectedCheckInWindow` → display mapped label; fallback `reservations.checkinTime` → `'14:00'` |
| Admin override time | Write `checkInTime` on `v2_hk_status` (existing HK-Shartava pattern) |
| Schedule manager | Port `hk-manage.html` CRUD |
| Cleaner assignment | Unify on `v2_hk_status.cleaner` (drop separate `hk_cleaner` over time) |

**Arrival time display mapping:**

| `expectedCheckInWindow` | HK card shows |
|-------------------------|---------------|
| `before-15` | Before 15:00 |
| `15:00` … `23:00` | That hour |
| `00:00+` | After midnight |
| `next-morning` | Next morning |
| `asap` | ASAP |
| (missing) | `reservations.checkinTime` or 14:00 |

---

## 5. Room ready notification (WhatsApp deferred)

**Now (Meta not verified):**
- HK **Done** button → mark clean + set guest unlock eligible
- Admin **Grant Access** → same unlock path
- Optional: show guest a “Your room is ready” message **on the guest page** when `hk_status.done` flips (no WhatsApp)

**Later (Meta verified):**
- `GuestNotification` controller sends WhatsApp from same event (HK done + rules pass)
- Disable duplicate `roomReadyNotification` Cloud Function permanently
- One notifier only — logged in `v2_system_logs`

---

## 6. Admin settings page

**Target location:** More → Settings (sandbox first)

| Setting | Storage |
|---------|---------|
| Admin password(s) | `v2_config/admin` — bcrypt hash, never plaintext in HTML |
| HK PINs | Already `hk_pins/{role}` — move UI here, keep collection |
| Feature flags | `v2_config/features` — e.g. `use_v2_assignments`, `whatsapp_enabled` |
| Tab bar layout | Already `localStorage` in sandbox — migrate to `v2_config/admin_ui` |

**Auth target:** Firebase Auth for admin; replace `_ADMIN_PWD = 'maxela2026'` + 90-day localStorage.

---

## 7. SleepyPMS migration (replace MiniHotel)

```
TODAY                          FUTURE
MiniHotel ──sync──► reservations    SleepyPMS ──API──► v2_reservations
                         │                    │
                         └──── bridge ──────────┘
ReservationSync controller:
  - Phase 1: MiniHotel → v2_*
  - Phase 2: SleepyPMS → v2_* (same controller interface, new adapter)
  - MiniHotel adapter kept until cutover complete
```

**Save for SleepyPMS:**
- This architecture doc + `PIPELINE_DESIGN_CURSOR.md` + `SYSTEM_MAP_BEGINNER_VISUAL.html`
- `sandbox_rebuild/data/room_catalog.json` — room master seed
- `v2_*` schema — SleepyPMS writes same shapes

---

## 8. Everything editable (alpha → professional PMS)

All of these should become **config documents**, not scattered constants:

| Config area | Current pain | Target |
|-------------|--------------|--------|
| Room list | 4 hardcoded copies | `v2_config/properties` |
| Elevator-eligible rooms | Hardcoded in guest JS | `v2_config/elevator_rooms` |
| Unlock time rules (11:00 / 15:00) | Copy-pasted in HTML | `v2_config/unlock_rules` |
| Guest page tiles / visibility | `checkin_admin/config` full-doc overwrite | Per-section merge writes |
| Check-in time slots | Sandbox JS only | `v2_config/checkin_slots` |
| Stale thresholds (26h / 36h) | Magic numbers in 3 files | `v2_config/elevator` |

Admin Settings + Guest Page editor read/write these docs through controllers.

---

## 9. Controller map (who owns what)

| Controller | Owns writes | Reads |
|------------|-------------|-------|
| **ReservationSync** | `v2_reservations`, creates/updates `v2_assignments` | MiniHotel / SleepyPMS API |
| **RoomAssignment** | `v2_assignments.roomCode`, `v2_room_moves` | conflicts, locks |
| **GuestRegister** | `v2_guests` create/update, link to assignment | assignment, reservation |
| **GuestUnlock** | `v2_guests.manualUnlock`, derived unlock state | hk_status, time rules, assignment |
| **ElevatorCodeSync** | `v2_elevator/current` + RTDB mirror | manual lock rules |
| **HKStatusSync** | `v2_hk_status` | reservations |
| **GuestNotification** | WhatsApp queue (later) | hk done, guest contact |
| **AdminAction** | façade — routes admin UI clicks to above | — |

HTML pages (after cutover): **call AdminAction / guestRegister — no direct Firestore business writes.**

---

## 10. Implementation order (safe path)

### Phase 1 — Document + sandbox (now)
- [x] Pipeline design + sandbox_rebuild dry-run
- [x] Beginner visual map
- [ ] **This doc reviewed by Nika** ← you are here
- [ ] ElevatorCodeSync in sandbox (manual lock + auto reject)
- [ ] GuestRegister with stable UUID in guest sandbox-2
- [ ] HK board + arrival time in admin sandbox
- [ ] Admin Settings page (password hash in config — sandbox)

### Phase 2 — Shadow (`v2_*` beside live)
- Bridge live → v2 nightly
- ReservationSync → v2_assignments
- Admin sandbox reads v2 for Stay list
- Compare shadow vs live for 2 weeks

### Phase 3 — Cutover (maintenance window optional)
- Guest live reads assignment for room
- Admin moves only via RoomAssignment
- ElevatorCodeSync replaces dual-write in HTML
- Firebase Auth + Storage rules for passports
- Freeze legacy direct writes

### Phase 4 — SleepyPMS
- Swap ReservationSync adapter
- Retire MiniHotel sync

---

## 11. Decisions needed from Nika

| # | Question | Recommendation |
|---|----------|----------------|
| 1 | Manual elevator lock duration | Until end of day (Tbilisi) + 6h, then auto may overwrite |
| 2 | Guest login on new phone | Name + check-in date search finds existing guest (no password for now) |
| 3 | HK in bottom nav vs More | Start under **More → Housekeeping**; promote to nav slot if used daily |
| 4 | First controller to build | **ElevatorCodeSync** (your daily pain) + **GuestRegister** stable ID (guest data loss) |
| 5 | Firebase Auth timeline | Phase 2 for admin; Phase 3 for guest passport rules |

---

## 12. What we are NOT doing

- Patching live `checkin-admin.html` / `checkin-guest-v2.html` without shadow period
- Building WhatsApp sends before Meta verification (Done button + guest page banner instead)
- Merging SleepyPMS codebase into this repo (separate project; same `v2_*` contract)
- Removing HK HTML until admin sandbox HK board is proven on your phone

---

*This document is the canonical “best version” for structuring Maxela toward a professional PMS. Update it when decisions change — do not scatter architecture across chat only.*
