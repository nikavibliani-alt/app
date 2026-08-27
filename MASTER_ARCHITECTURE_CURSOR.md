# MASTER_ARCHITECTURE_CURSOR.md — Maxela / SleepyPMS foundation

**Status:** Architecture lock (Nika decisions 2026-08-27)  
**Audience:** Nika + any builder

> **Main goal:** Structure the system so bugs are **easy to find and fix** — not patched on top of a fragile stack.  
> **One Firestore.** No parallel v1/v2 collections. Fix and extend what we already have (`checkin_guests`, `reservations`, `globals/elevator_code`, `hk_status`).

**Related docs:** `GUEST_CHECKIN_REDESIGN.md`, `SYSTEM_MAP_BEGINNER_VISUAL.html`, `PIPELINE_DESIGN_CURSOR.md` (controller *ideas* — collections stay the same)

---

## 0. Principles (locked)

| # | Rule |
|---|------|
| 1 | **One database, one truth** — no `v2_*` shadow collections. Improve existing docs + add fields. |
| 2 | **One writer per fact** — small controllers/functions own room moves, elevator, unlock, HK done (can live in Cloud Functions or a shared JS module first). |
| 3 | **No silent dual-write** — elevator FS + RTDB: both succeed or show error. |
| 4 | **Everything editable** — config in Firestore, not hardcoded in 4 files. |
| 5 | **HK lives in admin** — not a separate app long-term. |
| 6 | **Passport security + guest comfort** — unique link after first upload; auto cleanup after stay. |

---

## 1. Firestore — one setup (no v1/v2 split)

### Collections we keep and fix

```
reservations/{id}           ← bookings from MiniHotel → later SleepyPMS
checkin_guests/{guestToken} ← guest form; doc ID = permanent unique token (NOT room_date)
checkin_apartments/{roomCode}
globals/elevator_code       ← single elevator doc (keep path; add fields)
hk_status/{roomCode}_{date}
hk_pins/{role}
checkin_admin/config
system_logs/{autoId}        ← new: audit trail (optional but useful)
config/admin                ← new: hashed passwords, flags (move out of HTML)
config/properties           ← new: room catalog (one list, not 4 copies)
```

### What changes on `checkin_guests`

| Field | Purpose |
|-------|---------|
| **Doc ID = `guestToken`** | Random URL-safe token created on **first passport upload** |
| `guestLink` | Full URL guests can bookmark/share: `…/checkin-guest-v2.html?g={guestToken}` |
| `matchedReservationId` | Link to reservation (stable join for admin) |
| `aptId` | Current room — **updated on admin move**; token/doc never changes |
| `arrivalDate`, `checkoutDate` | Stay window |
| `expectedCheckInWindow` | Guest approximate arrival (sandbox → live) |
| `isPrimaryGuest` | true for passport holder |
| `linkedReservationNumber` | For companion / invite members (same booking group) |
| `passportUrl`, `passportExpiresAt` | Passport kept ~1 month max |
| `registeredAt`, `checkoutAt` | For retention job |

**Admin move room:** update `aptId` + `reservations.roomCode` together — **guest doc and link unchanged**.

**Companion / invite members:** separate lightweight docs OR same reservation group with `companionGuest:true` — no passport; share codes via primary’s link + `?companion=1&res=…` (already in sandbox).

### Retention (privacy)

| When | Action |
|------|--------|
| Checkout + ~3 days | Delete companion docs; strip sensitive fields from primary |
| Passport age > ~30 days | Delete Storage file + clear `passportUrl` on doc |
| Guest new reservation later | New search + new registration → **new `guestToken`** (old stay data gone) |

Scheduled job (Cloud Function or GitHub Action): `cleanup_guest_data.py`

---

## 2. Elevator code — simple rules (Nika locked)

**Facts:**
- Code rotates ~every 24 hours
- Samsung phone + your app = auto writer (`source: auto`)
- When app fails, you paste manually in admin (`source: manual`)
- Both must update **Firestore + RTDB**

### Logic (no complicated locks)

```
ON MANUAL SAVE (admin):
  → Write display_code + qr_code to FS + RTDB
  → source = 'manual'
  → lastCode = what you saved

ON AUTO SAVE (Samsung app):
  IF incoming display_code == lastCode (same as already stored):
    → IGNORE (stale retry — do not overwrite a good manual fix)
  ELSE IF incoming display_code != lastCode:
    → ACCEPT (new day, new code — app is working)
    → source = 'auto'
    → Update FS + RTDB

That's it.
```

**Example:**
- Today code `123` — app or you set it
- Tomorrow app broken — you manually set `456` → guests see `456`
- Day after app sends `789` (different from `456`) → accept `789`
- Day after app retries old `456` while current is `789` → ignore (same code, stale)

Document shape on `globals/elevator_code` (+ RTDB mirror):

```json
{
  "display_code": "456#",
  "qr_code": "<QR payload>",
  "updatedAt": "<timestamp>",
  "source": "manual | auto",
  "lastCode": "456#"
}
```

Implement in **admin sandbox Elevator tab first**, then live admin. Samsung app sets `source:'auto'`.

---

## 3. Guest unique link (passport once, use anywhere)

### Flow

1. Guest searches booking → starts registration
2. **First passport upload succeeds** → generate `guestToken`, create `checkin_guests/{guestToken}`, save `guestLink`
3. Show guest their link: “Save this link — open on any device without uploading passport again”
4. **Invite other members** (existing sandbox button) → companion URL with `?companion=1&res=…` — no passport, same codes
5. **Different browser** → open `guestLink` OR search finds existing doc by `matchedReservationId` → skip passport step, go to home
6. **Admin moves apartment** → only `aptId` changes; link + passport + registration stay

### What we stop doing

- Doc ID `{room}_{date}` for primary guests → migrate new registrations to `guestToken` IDs
- Asking passport again when doc already exists for that reservation
- Losing registration when room changes

### Security

- `guestToken` is unguessable (128-bit random)
- Storage rules: read passport only with valid token (later: Firebase Auth custom token)
- Admin sees passport via authenticated admin session only
- Link invalid after retention cleanup

---

## 4. HK built into admin (not separate)

**Target:** `checkin-admin-sandbox.html` → then live admin

| Where | What |
|-------|------|
| **More → Housekeeping** (or bottom-nav slot) | Full HK task board from `HK-Shartava.html` |
| Stay tab | Guest arrival time from `expectedCheckInWindow` |
| Done button | Writes `hk_status` + guest unlock (same as today) |
| HK Pins | Stay under Settings / More |

Retire separate HK HTML files **after** admin HK board works on your phone.

**Arrival time on HK card:**
```
guest.expectedCheckInWindow  →  mapped label
  ?? hk_status.checkInTime
  ?? reservation.checkinTime
  ?? '14:00'
```

---

## 5. Admin settings

**More → Settings**
- Change admin password → `config/admin` (hashed, not in HTML)
- HK PINs
- Feature flags (WhatsApp when Meta ready)

Replace `maxela2026` in source code.

---

## 6. WhatsApp (later)

Meta not verified yet. **Now:** HK Done → guest page shows room ready / unlock. **Later:** same event triggers WhatsApp — one code path.

---

## 7. SleepyPMS (replace MiniHotel)

Same collections. Only sync script changes: `minihotel_reservation_sync.py` → `sleepypms_reservation_sync.py`. Schema in this doc is what SleepyPMS writes.

---

## 8. Controllers (logic owners — same Firestore)

Small modules, not a second database:

| Module | Owns writes to |
|--------|----------------|
| `roomAssignment` | `reservations.roomCode`, `checkin_guests.aptId`, `system_logs` |
| `guestRegister` | `checkin_guests/{guestToken}` create, link, passport |
| `elevatorSync` | `globals/elevator_code` + RTDB (stale-auto reject) |
| `hkStatus` | `hk_status`, optional `manualUnlock` |
| `guestCleanup` | retention deletes |

Start as **shared JS in sandbox**, move to Cloud Functions when ready.

---

## 9. Build order (simple)

1. **Elevator stale-auto reject** in admin sandbox (+ document Samsung app contract)
2. **Guest unique link** in guest sandbox-2 → test cross-browser + room move
3. **HK board in admin sandbox** + arrival time
4. **Admin Settings** password
5. Port to live guest + live admin when sandbox proven on your phone
6. Guest data retention job
7. Storage security rules

**Not doing:** parallel v2 collections, shadow mode between two schemas, overcomplicated migration.

---

## 10. Decisions — confirmed by Nika

| Topic | Decision |
|-------|----------|
| Elevator | Manual when app fails; auto accepted only when code is **new/different** |
| Guest identity | Unique link on first passport; no re-upload on new browser; move room ≠ lose registration |
| Data retention | Delete guest data days after checkout; passport ~1 month; new booking = new registration |
| HK | Built into admin panel |
| Database | **One Firestore** — no v1/v2 split |

---

## 11. Note on `sandbox_rebuild/`

The Python sandbox used `v2_*` names for dry-run testing only. Production architecture uses **existing collection names** above. Future sandbox tests should mock `checkin_guests`, `reservations`, etc. — not parallel schemas.

---

*Update this file when decisions change. This is the canonical “best version” for Maxela and SleepyPMS.*
