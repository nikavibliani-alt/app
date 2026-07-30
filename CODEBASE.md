# SleepyPMS — Codebase Reference

> For Cursor IDE. Complete system map: files, Firebase schema, room codes, workflows, logic flows, design system.

---

## 1. FILE MAP

| File | Description |
|------|-------------|
| `checkin-guest-v2.html` | Main guest check-in web app — registration, passport upload, door codes, services, home dashboard |
| `checkin-guest.html` | Redirect to v2 |
| `checkin-admin.html` | Admin panel — guests, apartments, requests, housekeeping pins, guest page settings |
| `checkin-details.html` | Check-in instructions separate page — door code, photos, elevator code |
| `admin-search-test.html` | Search scoring debugger — runs real scoring logic against all reservations, password-protected |
| `HK-Shartava.html` | Housekeeping app for Shartava building |
| `HK-Centre.html` | Housekeeping app for Freedom/Orbeliani buildings |
| `HK.html` | Legacy housekeeping page |
| `pricing.html` | Pricing admin dashboard — manual overrides, proposal review, price history |
| `price-history.html` | Price history viewer |
| `clear-reservations.html` | Admin utility — clear test reservations |
| `import-reservations.html` | Admin utility — bulk reservation import |
| `SleepyDashboard.html` | Ops dashboard |
| `hk-manage.html` | Housekeeping management UI |
| `tuya-test.html` | Tuya door lock testing tool |
| `index.html` | Landing / root redirect |
| `pricing_engine.py` | Main pricing orchestrator — fetches availability, runs velocity + Claude layers, writes to MiniHotel |
| `velocity_engine.py` | Gravity/compass pricing model — demand scoring, step limits, pull toward start price |
| `claude_pricing.py` | Claude AI pricing layer — once-daily strategy proposals, auto-applies small changes |
| `price_tracker.py` | Snapshot recording and outcome tracking |
| `event_scanner.py` | SerpAPI event detection — concerts, holidays, sports events |
| `minihotel_auth.py` | MiniHotel session login |
| `minihotel_reservation_sync.py` | Reservation sync from MiniHotel → Firestore |
| `housekeeper_sync.py` | Housekeeping schedule sync |
| `minihotel_monthly_report.py` | Monthly revenue report generation |
| `backfill_booking_ids.py` | One-time backfill of bookingId from MiniHotel remarks |
| `backfill_service_requests_status.py` | One-time backfill of service request status field |
| `ai_pricing.py` | AI pricing utilities |
| `minihotel_auth.py` | MiniHotel session auth |
| `whatsapp_automation.py` | WhatsApp pre-fill message generation |
| `PRICING.md` | Pricing engine documentation |
| `CODEBASE.md` | This file |
| `sleepy-styles.css` | Shared CSS |
| `config.json` | Local config |
| `scripts/elevator-monitor.js` | Hourly elevator code staleness monitor — sends Resend alert/recovery email |
| `scripts/package.json` | Node dependencies for scripts (`resend ^4`) |
| `tuya-proxy.js` | Tuya door lock proxy server |
| `tuya-functions/` | Tuya cloud function helpers |

---

## 2. FIREBASE PROJECT

**Project ID:** `sleepy-5c962`  
**API Key:** `AIzaSyCbggwwtdw751yQUO6MaHCuYKyNn7AyOTk`  
**Auth Domain:** `sleepy-5c962.firebaseapp.com`

---

## 3. FIRESTORE COLLECTIONS

### `reservations/{reservationNumber}`
MiniHotel reservation data, synced every 10 minutes.

| Field | Type | Notes |
|-------|------|-------|
| `reservationNumber` | string | MiniHotel reservation ID |
| `bookingId` | string | OTA confirmation number (Booking.com, Expedia) — parsed from remarks.printed |
| `guest` / `guestName` | string | Guest full name as entered in MiniHotel |
| `roomCode` | string | Room code e.g. `6-1`, `tab-1`, `orb-2` |
| `checkin` / `checkIn` | string | YYYY-MM-DD |
| `checkout` / `checkOut` | string | YYYY-MM-DD |
| `status` | string | `CONFIRMED`, `CANCELLED`, etc. |
| `tuyaPassword` | string | Door lock code |
| `guests` | number | Guest count |
| `nationality` | string | |
| `source` | string | Booking channel |

---

### `checkin_guests/{guestId}`
Guest self-registration records. Created when guest completes check-in form.

| Field | Type | Notes |
|-------|------|-------|
| `aptId` | string | Room code |
| `name` | string | As typed by guest |
| `nameRoman` | string | From matched reservation |
| `guests` | number | |
| `nationality` | string | |
| `contact` | string | Phone / Telegram username |
| `contactType` | string | `wa` or `tg` |
| `passportUrl` | string | Firebase Storage URL |
| `passportScanResult` | object | `{valid, reason, confidence, overrideByAdmin}` |
| `arrivalDate` | string | YYYY-MM-DD |
| `matchedReservationId` | string | Firestore doc ID of matched reservation |
| `manualUnlock` | boolean | Admin can force-unlock |
| `blocked` | boolean | Admin can block guest |
| `submittedAt` / `updatedAt` | timestamp | |

---

### `checkin_apartments/{roomCode}`
Per-room configuration and content shown to guests.

| Field | Type | Notes |
|-------|------|-------|
| `name` | string | Display name |
| `photos` | array | Room photo URLs |
| `wifiName` | string | |
| `wifiPass` | string | |
| `doorCode` | string | Static door code (fallback if no Tuya) |
| `checkInInstructions` | string | |
| `houseRules` | string | |
| `address` | string | |
| `mapUrl` | string | |
| `parkingInfo` | string | |

---

### `checkin_admin/config`
Single shared admin config document. Controls guest page settings for all properties.

| Field | Type | Notes |
|-------|------|-------|
| `visibility` | object | Per-section show/hide toggles (elevator_code, qr_code, door_code, wifi, services, recs, rules, contact, location) |
| `sectionLabels` | object | Display name overrides per section |
| `services` | array | Service tiles shown to guests `{id, name, price, note, visible}` |
| `whatsappNumber` | string | Host WhatsApp for guest contact |
| `propertyVisibility` | object | Per-property (by aptId prefix) visibility overrides |

> **Multi-tenancy note:** This is currently a single shared document. Migration plan: move to `checkin_admin/{operatorId}/config` before onboarding operator #2.

---

### `globals/elevator_code`
Elevator code for Shartava building (updated by Tuya integration).

| Field | Type | Notes |
|-------|------|-------|
| `code` | string | Raw code (internal) |
| `display_code` | string | Formatted for display |
| `updatedAt` | number | Millisecond timestamp — used by elevator monitor |

> **Multi-tenancy note:** Currently a single document. Migration needed before operator #2.

---

### `globals/config`
Shared global config.

| Field | Type | Notes |
|-------|------|-------|
| `geminiKey` | string | Gemini API key for passport scanning |

---

### `hk_status/{roomCode_YYYY-MM-DD}`
Housekeeping status per room per day.

| Field | Type | Notes |
|-------|------|-------|
| `done` | boolean | Cleaning complete — triggers early check-in unlock at 11:00 |
| `assignedTo` | string | Housekeeper name |
| `notes` | string | |
| `updatedAt` | timestamp | |

---

### `hk_pins/{role}`
Housekeeping PIN codes for app login.

| Field | Type | Notes |
|-------|------|-------|
| `pin` | string | 4-digit PIN |
| `name` | string | Housekeeper name |

---

### `service_requests`
Guest service requests (cleaning, laundry, tours, etc.).

| Field | Type | Notes |
|-------|------|-------|
| `aptId` | string | |
| `guestId` | string | |
| `service` | string | Service type |
| `notes` | string | |
| `status` | string | `PENDING`, `DONE` |
| `timestamp` | timestamp | |

---

### `checkin_requests`
Real-time check-in change requests (room switch, early check-in).

| Field | Type | Notes |
|-------|------|-------|
| `aptId` | string | |
| `guestId` | string | |
| `type` | string | Request type |
| `status` | string | `PENDING`, `APPROVED`, `CANCELLED` |
| `timestamp` | timestamp | |

---

### `search_failures`
Logged when guest search returns no match — used for debugging mismatches.

| Field | Type | Notes |
|-------|------|-------|
| `input_name` | string | Exactly as guest typed |
| `input_date` | string | YYYY-MM-DD |
| `input_booking_ref` | string | |
| `input_contact` | string | |
| `input_contact_type` | string | `wa` or `tg` |
| `search_mode` | string | Always `name` |
| `best_match_name` | string | Closest reservation name found |
| `best_match_score` | number | 0–10 |
| `best_match_room` | string | |
| `resolved` | boolean | |
| `timestamp` | timestamp | |

---

### `pricing_config/rules`
Per-room-type pricing rules loaded by pricing engine.

| Field | Type | Notes |
|-------|------|-------|
| `property_type` | string | `ROOMS`, `MAXELA`, etc. |
| `start_price` | number | Gravity anchor |
| `floor_price` | number | Hard minimum |
| `ceiling_price` | number | Hard maximum |
| `step_limit` | number | Max change per engine run |

---

### `pricing_snapshots`
Price snapshot per property per date per run.

| Field | Type | Notes |
|-------|------|-------|
| `property_type` | string | |
| `date` | string | YYYY-MM-DD |
| `price` | number | |
| `availability` | number | Units available |
| `manual_lock` | boolean | True when manual price detected |
| `run_id` | string | |
| `timestamp` | timestamp | |

---

### `pricing_outcomes`
Booking outcome recording for feedback loop.

| Field | Type | Notes |
|-------|------|-------|
| `property_type` | string | |
| `date` | string | |
| `price_at_booking` | number | |
| `days_before_checkin` | number | |
| `timestamp` | timestamp | |

---

### `pricing_proposals`
Claude AI pricing proposals awaiting review or auto-application.

| Field | Type | Notes |
|-------|------|-------|
| `property_type` | string | |
| `date` | string | |
| `current_price` | number | |
| `proposed_price` | number | |
| `reasoning` | string | Claude's explanation |
| `change_pct` | number | |
| `auto_applied` | boolean | True if within ±5% threshold |
| `status` | string | `PENDING`, `APPLIED`, `REJECTED` |
| `timestamp` | timestamp | |

---

### `pricing_events`
External events detected by SerpAPI scanner.

| Field | Type | Notes |
|-------|------|-------|
| `date` | string | |
| `event_name` | string | |
| `event_type` | string | Concert, sports, holiday, etc. |
| `impact` | string | `HIGH`, `MEDIUM`, `LOW` |
| `source_url` | string | |
| `timestamp` | timestamp | |

---

### `pricing_log`
Audit log of every pricing engine run.

| Field | Type | Notes |
|-------|------|-------|
| `run_id` | string | |
| `property_type` | string | |
| `prices_written` | number | |
| `errors` | array | |
| `duration_s` | number | |
| `timestamp` | timestamp | |

---

### `direct_bookings` *(planned)*
Future direct booking engine — not yet implemented.

---

## 4. REALTIME DATABASE

**URL:** `https://sleepy-5c962-default-rtdb.europe-west1.firebasedatabase.app`

### `/elevator_code`
```json
{
  "code": "(internal)",
  "display_code": "1234#",
  "qr_code": "data:image/...",
  "expires_at": 1234567890000,
  "updatedAt": 1234567890000
}
```
Updated by Tuya integration. `updatedAt` is a millisecond timestamp monitored by the GitHub Actions elevator monitor workflow.

### `/elevator_monitor`
```json
{
  "last_alert_sent": 1234567890000,
  "was_stale": false
}
```
Written by `scripts/elevator-monitor.js` to track alert cooldown and recovery state.

---

## 5. FIREBASE STORAGE

| Path | Contents |
|------|----------|
| `passport_uploads/{UUID}/{UUID}` | Guest passport / ID photos uploaded during check-in |
| `checkin_admin/photos/...` | Room category photos managed via admin panel |

---

## 6. ROOM CODE → PROPERTY MAPPING

| Room Code(s) | Property Type | Display Name | Address |
|-------------|---------------|--------------|---------|
| `0-1` `0-2` `0-3` `0-4` `0-5` | `ROOMS` | Triple Room | Shartava St. 37 |
| `6-1` `6-2` `6-4` `7-1` `7-2` `7-4` | `MAXELA` | Superior Apartment | Shartava St. 37 |
| `6-3` | `BIG_APT` | 3-Bedroom Apartment | Shartava St. 37 |
| `tab-1` `tab-2` `tab-3` | `FREEDOM` | Tabidze Studio | Tabidze St. 3/5 |
| `orb-1` `orb-2` `orb-3` | `ORBELIANI` | Orbeliani Suite | Atoneli St. 9 |

---

## 7. ELEVATOR CODE ROOMS

Only these rooms show the elevator/entrance QR code and display code to guests:

```
6-1, 6-2, 6-3, 6-4, 7-1, 7-2, 7-4
```

All other rooms (`0-x`, `tab-x`, `orb-x`) never show elevator code UI regardless of admin settings.  
Logic lives in `needsElevatorCode()` in `checkin-guest-v2.html`.

---

## 8. GITHUB ACTIONS WORKFLOWS

| File | Trigger | Description |
|------|---------|-------------|
| `.github/workflows/minihotel_reservation_sync.yml` | Every 30 min | Syncs reservations from MiniHotel → Firestore |
| `.github/workflows/pricing_engine.yml` | Manual / webhook | Pricing engine run (triggered by cron-job.org at 00:00, 05:00, 09:00, 12:00, 18:00 Tbilisi UTC+4) |
| `.github/workflows/elevator-monitor.yml` | Every hour (`0 * * * *`) | Checks elevator code staleness, sends Resend alert/recovery email |
| `.github/workflows/whatsapp_checkin_reminder.yml` | Scheduled | WhatsApp pre-check-in reminders |
| `.github/workflows/whatsapp_checkout.yml` | Scheduled | WhatsApp checkout messages |
| `.github/workflows/whatsapp_midstay.yml` | Scheduled | WhatsApp mid-stay messages |
| `.github/workflows/backfill_booking_ids.yml` | Manual only | One-time bookingId backfill |

---

## 9. GITHUB SECRETS

| Secret | Used by |
|--------|---------|
| `FIREBASE_SERVICE_ACCOUNT` | All Python scripts (firebase-admin) |
| `ANTHROPIC_API_KEY` | `claude_pricing.py` |
| `SENDGRID_KEY` | Email notifications from Python workflows |
| `RESEND_API_KEY` | `scripts/elevator-monitor.js` |
| `SERPAPI_KEY` | `event_scanner.py` |
| `MINIHOTEL_USER` | `minihotel_auth.py` |
| `MINIHOTEL_PASS` | `minihotel_auth.py` |
| `MINIHOTEL_HOTEL` | MiniHotel hotel ID |
| `GITHUB_TOKEN` | Auto-provided by Actions |

---

## 10. KEY FUNCTIONS

### `checkin-guest-v2.html`

| Function | Description |
|----------|-------------|
| `searchReservation()` | Name + date search against all reservations; full state reset at start to prevent retry pollution |
| `nameMatch(input, resGuest)` | Word-order-independent fuzzy match (Levenshtein ≤2), substring match, Arabic transliteration, reversed token fallback for last-name-first input |
| `partialNameMatch(input, resGuest)` | Single-token match version of nameMatch; used for Arabic partial match path |
| `isUnlocked()` | Unlock logic based on Tbilisi time + checkin date + hk_status |
| `showHome()` | Renders home dashboard, manages onSnapshot listeners via `_homeSnaps[]` array |
| `switchApt(newAptId)` | Switches active apartment for multi-room bookings; updates session + URL |
| `uploadToFirebaseStorage(file)` | Passport upload to Firebase Storage with 30s timeout |
| `needsElevatorCode()` | Returns true only for 6-x and 7-x rooms AND elevator_code section is visible |
| `finishRegistration_(bestRes, formData)` | Uploads passport, writes checkin_guests doc, transitions to home |
| `_saveSession()` | Saves guestId + aptId + hash to localStorage with 30-day expiry |
| `tbilisiToday()` | Returns YYYY-MM-DD in UTC+4 |
| `tbilisiHour()` | Returns current hour in UTC+4 |

### `velocity_engine.py`

| Function | Description |
|----------|-------------|
| `compute_prices_velocity()` | Main entry point — gravity/compass model for all 90 days |
| `calculate_gravity_adjustment()` | Pulls price toward start price based on days out and availability |
| `apply_step()` | Demand scoring + enforces max change per run |

### `claude_pricing.py`

| Function | Description |
|----------|-------------|
| `get_claude_proposals()` | Calls Claude once daily as strategy analyst — returns per-date proposals |
| `auto_apply_proposals()` | Auto-applies proposals within ±5% threshold; queues larger ones for manual review |

### `minihotel_reservation_sync.py`

| Function | Description |
|----------|-------------|
| `sync_reservations()` | Fetches from MiniHotel, writes to Firestore `reservations/` |
| `detect_cancellations()` | Detects status changes → triggers urgent repricing run |
| `fetch_booking_id()` | Parses bookingId from `remarks.printed` field |

---

## 11. UNLOCK LOGIC

Location: `isUnlocked()` in `checkin-guest-v2.html`

```
today > checkin                          → UNLOCKED (mid-stay)
today === checkin AND hour >= 15         → UNLOCKED (standard check-in time)
today === checkin AND hour >= 11
  AND hk_status.done === true            → UNLOCKED (early check-in, HK confirmed)
today < checkin                          → LOCKED
manualUnlock === true                    → UNLOCKED (admin override, any time)
```

All time checks use `tbilisiToday()` and `tbilisiHour()` (UTC+4). The `hk_status` doc is `hk_status/{roomCode_YYYY-MM-DD}`.

---

## 12. GUEST SEARCH SCORING

Location: `searchReservation()` in `checkin-guest-v2.html`

| Score | Condition |
|-------|-----------|
| 10 | Exact bookingId or reservationNumber match (hidden fallback when input looks like a ref number) |
| 3 | `nameMatch` = true AND date matches |
| 3 | Arabic guest: `partialNameMatch` = true AND date matches |
| 2 | `nameMatch` = true, no date |
| 2 | `partialNameMatch` = true AND date matches (non-Arabic) |
| 0 | No match |

**Threshold for success:** score ≥ 3. Failures logged to `search_failures` collection.

**`nameMatch` algorithm:**
1. Tokenize both strings (`_nameWords` — lowercase, split on space/comma/dot/dash, drop tokens < 3 chars)
2. For each input token: check Levenshtein distance ≤ 2 OR substring containment against all reservation tokens
3. Also try reversed token order (handles last-name-first input, common for Arab guests)
4. Require ≥ 2 tokens to match
5. Arabic fallback: transliterate → compare consonant skeletons

---

## 13. PRICING ENGINE FLOW

Per run (triggered by `pricing_engine.py`):

```
1. Login MiniHotel (minihotel_auth.py)
2. Fetch availability + current prices (90 days)
3. Load Firestore pricing_config/rules (floors, ceilings, start prices per property type)
4. Velocity engine — baseline prices for all 90 days (velocity_engine.py)
5. Claude AI layer — once daily at 09:00 UTC, proposals for 60 days (claude_pricing.py)
6. Write prices to MiniHotel
7. Sync channels (Booking.com / Expedia / Airbnb)
8. Save snapshots → pricing_snapshots
9. Record outcomes → pricing_outcomes
```

---

## 14. MANUAL EXPERIMENT MODE

When pricing engine detects a price was changed manually in MiniHotel:

- Sets `manual_lock: true` in `pricing_snapshots` for that date
- Skips repricing that date while availability is unchanged (experiment in progress)
- Unlocks automatically when a booking is detected (availability drops)
- Timeout: next 12:00 UTC run if no booking detected

---

## 15. DESIGN SYSTEM

### Guest check-in pages (`checkin-guest-v2.html`, `checkin-details.html`)

```
Fonts:    Playfair Display (headings) + Inter (body)
Palette:
  --bg:      #FAFAF9   (warm off-white)
  --ink:     #2C2C2A   (near-black)
  --muted:   #8C8C8A
  --border:  #E0D8D0
  --accent:  #E8DDD0
```

### Admin pages (`checkin-admin.html`, `admin-search-test.html`)

```
CSS vars:
  --gs-bg:          #fafafa
  --gs-white:       #ffffff
  --gs-border:      #e5e7eb
  --gs-text-main:   #1f2937
  --gs-text-muted:  #6b7280
  --gs-accent:      #111827
  --gs-green:       #10b981
  --gs-red:         #ef4444
  --gs-amber:       #f59e0b

Components: .gs-card, .gs-card-header, .gs-row, .gs-row-info, .gs-row-actions
```

---

## 16. MULTI-TENANCY STATUS

**Current state:** Single Firebase project, single Firestore namespace, single admin config.  
**Blocker before operator #2:** Two shared singletons must be namespaced:

1. `checkin_admin/config` → `checkin_admin/{operatorId}/config`
2. `globals/elevator_code` → property-specific path

**Estimated effort:** ~7–10 hours. No rearchitecture needed; just path parameterization in `checkin-guest-v2.html`, `checkin-admin.html`, `checkin-details.html`.

---

## 17. FUTURE PLANS

- Replace MiniHotel entirely with own PMS calendar
- Channex channel manager integration (pricing TBD)
- Multi-tenancy: `checkin_admin/{operatorId}/config` (see §16)
- Service provider marketplace
- Direct booking engine (`direct_bookings` collection, planned)
- Host onboarding + billing
