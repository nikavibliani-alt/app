# checkin-guest-v2.html — Technical Specification

> Source of truth for redesign. Generated from full audit of the file as of commit `9bfe0d8` (2026-08-20).
> File: `checkin-guest-v2.html` · ~2958 lines · single-page application, no build step.

---

## 1. CURRENT PAGE FLOW

### 1.1 All States / Screens

| State | Element | Description |
|-------|---------|-------------|
| **Loading screen** | `#loading` | Fixed overlay, always shown first; hides after `init()` completes |
| **Register** | `#page-register` | Search form: booking name + check-in date + phone + guests |
| **Rules** | `#page-rules` | 3 checkboxes (noise, smoke, care); continue button disabled until all checked |
| **Passport** | `#page-passport` | Photo upload zone + Gemini AI scan; continue disabled until file selected |
| **Home** | `#page-home` | Dashboard: greeting + "What You Booked" card + tile grid |
| **Home — Locked** | `#page-home` (tiles replaced) | Check-in time not reached yet; countdown visible |
| **Home — Post-checkout** | `#page-home` (tiles replaced) | All reservations past checkout; "Thank you" message |
| **Home — Blocked** | `#page-home` (full replace) | `guestData.blocked === true`; "Access Revoked" message |
| **WiFi subpage** | `#page-content-wifi` | Network name + password, copy buttons |
| **Services subpage** | `#page-content-services` | Cleaning / Laundry / City Tour / Airport Transfer / Other |
| **Recommendations** | `#page-content-recs` | Cards from `aptData.recommendations[loc]` |
| **House Rules** | `#page-content-rules` | `aptData.rules.apartment` or `.small` key |
| **Contact** | `#page-content-contact` | WhatsApp deep-link |
| **Location** | `#page-content-location` | Address, Google Maps link, parking info |
| **Locked WiFi subpage** | `#page-content-wifi` (special body) | Called by `openLocked()` when WiFi tapped before check-in |
| **Service modal** | `#svc-modal` (`.modal-overlay`) | Sheet modal for submitting a service request |
| **Request detail modal** | `#req-detail-modal` | View / cancel / re-edit an existing request |
| **QR fullscreen** | `#qr-fullscreen-overlay` | Black overlay with full-screen QR canvas |
| **Lightbox** | `#lightbox` | Image gallery viewer with prev/next/swipe |
| **Retry / connection error** | `#page-register` (injected `#_init-retry-msg`) | All Firestore retries failed on load |
| **Preview mode** | `#page-home` + banner | `?preview=true` URL param; no guest data, straight to home |

### 1.2 First-Time Guest Flow

```
1. Browser loads → init() runs
2. Loading screen shown
3. No localStorage session → show #page-register
4. Guest fills: booking name, check-in date (DD / MM / YYYY), WhatsApp/Telegram, guest count
5. Taps "Find my booking" → searchReservation()
   a. Queries all reservations (or filtered by aptId if ?apt= present)
   b. Scores each doc: exact bookingId/reservationNumber match = 10, name+date = 3, name only = 2, date+partial = 2
   c. bestScore < 3 → logs to search_failures, shows inline error
   d. bestScore >= 3 → fetches siblings by exact reservationNumber
   e. allMatchedReservations = group (1 or more reservations)
   f. Navigates to #page-rules
6. Guest checks all 3 boxes → rules-continue-btn enables
7. Taps "I agree" → proceedFromRules() → #page-passport
8. Guest taps upload zone → file input → handlePassport()
   a. Shows image preview, enables Continue button
   b. scanPassport() runs async (Gemini Vision)
9. Taps "Continue to your stay" → submitPassport() → finishRegistration_()
   a. Uploads passport to Firebase Storage
   b. Writes checkin_guests/{aptId}_{arrivalDate}
   c. For multi-room: writes checkin_guests for each additional room
   d. Sets localStorage keys
   e. Calls showHome()
   f. Background: updates passportScanResult in Firestore, writes passport_alerts if invalid
10. Home screen shown
```

### 1.3 Returning Guest Flow (with valid localStorage session)

```
1. Browser loads → init() runs
2. Reads maxela_apt_id + maxela_guest_id from localStorage
3. loadGuestDataWithRetry(guestId, 3) — up to 3 attempts with 2s delay
   - found===null → show retry screen
   - found===false → clear localStorage, show register
   - found===true → validate checkout + 1 day expiry
     - expired → clear localStorage, show register
     - valid → room reassignment check (guestData.matchedReservationId → reservations doc)
       → showHome() → restore last hash subpage if saved in maxela_v2_session
```

### 1.4 State Transition Triggers

| From | Trigger | To |
|------|---------|-----|
| Register | `searchReservation()` success | Rules |
| Rules | `proceedFromRules()` (all checked) | Passport |
| Passport | `submitPassport()` success | Home |
| Home | tile click (wifi, locked) | Locked WiFi subpage |
| Home | tile click (services, recs, etc.) | Content subpage |
| Home | Check-in Details tile | `checkin-details.html?apt=...` |
| Home | guestData.blocked = true | Blocked screen |
| Any | `logout()` | Register |
| Content subpage | browser back / `popstate` | Home (calls `_onReturnHome()`) |
| Home | `switchApt(newRoomCode)` (pill tap) | Home re-rendered for new room |

---

## 2. FIREBASE READS & WRITES

### 2.1 Firestore Collections — Reads

#### `reservations` (collection)
- **When:** `searchReservation()` — queries all docs (or filtered by `roomCode` if `?apt=` set)
- **Fields read:** `id`, `status`, `checkin`, `checkIn`, `checkout`, `checkOut`, `roomCode`, `guest`, `guestName`, `reservationNumber`, `bookingId`, `tuyaPassword`
- **Sibling lookup:** `query(collection, where('reservationNumber','==', primaryRn))` — exact match only
- **onSnapshot (in showHome):** `query(collection, where('roomCode','==', aptId))` — live updates to `activeReservation`
- **onSnapshot (matchedReservationId watch):** `doc(db,'reservations', matchedReservationId)` — detects room reassignments in real time
- **getDoc (in switchApt onSnapshot):** same roomCode query
- **getDoc (init room fix):** `doc(db,'reservations', guestData.matchedReservationId)`

#### `checkin_guests` (collection)
- **When:** `init()` → `loadGuestDataWithRetry(savedGuest)` — `getDoc` by saved ID
- **Fields read:** `aptId`, `name`, `nameRoman`, `contact`, `contactType`, `guests`, `arrivalDate`, `matchedReservationId`, `passportUrl`, `passportScanResult`, `blocked`, `manualUnlock`, `checkoutDate`, `checkout`, `checkOut`
- **onSnapshot (in showHome):** `doc(db,'checkin_guests', guestId)` — live updates including `blocked` flag

#### `checkin_apartments` (collection)
- **When:** `finishRegistration_()`, `switchApt()`, `init()` — `getDoc(doc(db,'checkin_apartments', aptId))`
- **Fields read:** `wifiName`, `wifiPass`, `checkInTime`, `rules` (object: `apartment`, `small`), `recommendations` (object: `shartava`, `centre`), all fields stored in `aptData`

#### `checkin_admin/config` (single doc)
- **When:** `getGuestCfg()`, `getFullCfg()`, `openPage('services')`, `openSvc('laundry')` — `getDoc`
- **Fields read:**
  - `visibility` → per-property object: `{ROOMS:{checkin,access_code,elevator_code,wifi,services,laundry,cleaning,city_tour,airport_transfer,recs,rules,contact}, MAXELA:{...}, BIG_APT:{...}, FREEDOM:{...}, ORBELIANI:{...}}`
  - `services` → array: `[{id, name, desc, price, note, whatsappNumber, smallCarPrice, largeCarPrice, maxGuestsPerCar}]`
  - `laundryItems` → array: `[{name, price}]`
  - `sectionLabels` → object: `{wifi, recs, rules, contact}` — custom tile subtitles
  - `roomCategories` → object per property: `{name, maxGuests, description, amenities, photos, photoUrl}` — "What You Booked" card content
  - `locationInfo` → object per property: `{address, mapsUrl, neighborhood, parkingEnabled, parkingDesc, parkingMapsUrl, parkingMediaUrl}`

#### `globals/config` (single doc)
- **When:** IIFE on module load (async, silent), `scanPassport()` if `_geminiKey` not cached
- **Fields read:** `geminiKey`

#### `globals/elevator_code` (single doc)
- **When:** `onSnapshot` in `showHome()` and `switchApt()` (only if `needsElevatorCode()`)
- **Fields read:** `code`, `updatedAt` (Firestore Timestamp — `.seconds` used for 36-hour stale check)

#### `hk_status/{aptId}_{today}` (single doc per apt per day)
- **When:** `refreshHkToday()` — called once on load, then every 60s via `_hkPollTimer`, and on `visibilitychange`
- **Fields read:** `done` (boolean) — if `true` and hour >= 11, unlocks guest early

### 2.2 Firestore Collections — Writes

#### `checkin_guests/{aptId}_{arrivalDate}` (primary doc)
- **When:** `finishRegistration_()` — `setDoc` with merge
- **Fields written:** `aptId`, `name`, `nameRoman` (from `bestRes.guest`), `guests`, `nationality`, `contact`, `contactType`, `passportUrl`, `passportScanResult: {}`, `arrivalDate`, `matchedReservationId`, `manualUnlock: false`, `submittedAt` or `updatedAt` (serverTimestamp)
- **Background update:** `passportScanResult` written after Gemini scan completes
- **Room fix (init):** `setDoc({aptId: newRoom}, {merge:true})`
- **Room fix (live):** same merge write when `matchedReservationId` onSnapshot detects `roomCode` change
- **Reupload:** `setDoc({passportUrl, passportScanResult:{}, passportUpdatedAt}, {merge:true})`

#### `checkin_guests/{xApt}_{xArr}` (sibling docs for multi-room)
- **When:** `finishRegistration_()` — for each room in `allMatchedReservations` beyond the first
- **Extra fields:** `primaryGuestId` (ID of the main doc)

#### `passport_alerts/{aptId}_{timestamp}` (doc)
- **When:** background scan completes with `valid === false`
- **Fields:** `aptId`, `guestName`, `passportUrl`, `scanResult`, `reason`, `createdAt`

#### `search_failures` (collection)
- **When:** `searchReservation()` — `addDoc` on failed lookup (bestScore < 3)
- **Fields:** `input_name`, `input_date`, `input_booking_ref`, `input_contact`, `input_contact_type`, `search_mode`, `best_match_name`, `best_match_score`, `best_match_room`, `timestamp`, `resolved: false`

#### `checkin_requests` (collection)
- **When:** `submitService()` — `addDoc` (new) or `setDoc` with merge (edit)
- **Fields:** `guestId`, `aptId`, `serviceId`, `serviceName`, `note`, `preferredTime`, `preferredDate` (cleaning only), `status: 'PENDING'`, `done: false`, `createdAt`
- **Laundry extra:** `laundryItems` (array), `totalPrice`
- **Transfer extra:** `pickupDate`, `arrivalTime`, `guests`, `pickupLocation`, `dropoffLocation`, `cars`, `carConfig`, `price`, `priceLabel`
- **Cancel:** `setDoc({status:'CANCELLED'}, {merge:true})`

#### `service_requests` (collection)
- **When:** every `submitService()` — `addDoc` (parallel log, not shown to guest)
- **Fields:** `aptId`, `roomCode`, `guestName`, `service`, `serviceId`, `status`, `details`, `whatsappNumber`, `timestamp`

### 2.3 Realtime Database
- **Not used directly.** Elevator code is in Firestore `globals/elevator_code`, not RTDB. (RTDB was the old source; migration complete.)

### 2.4 Firebase Storage
- **When:** `uploadToFirebaseStorage(file)` — called in `finishRegistration_()` and `handlePassportReupload()`
- **Path:** `passport_uploads/{uuid}/{uuid}` (two nested random UUIDs)
- **Why:** Unguessable path replaces Cloudinary; storage rules are `allow write/read: if true` (path obscurity model)

### 2.5 onSnapshot Listeners

All registered in `_homeSnaps[]` array and torn down at the top of each `showHome()` call and in `switchApt()`.

| # | Collection/Doc | Query | Updates | Condition |
|---|----------------|-------|---------|-----------|
| 1 | `checkin_guests/{guestId}` | single doc | `guestData`, triggers `renderTiles()` + `renderPassportBanner()`; if `blocked=true` calls `showBlockedScreen()` | always (if guestId exists) |
| 2 | `checkin_requests` (full collection) | none (client-side filter by `guestId`) | `myRequests[]` | always |
| 3 | `reservations/{matchedReservationId}` | single doc | detects `roomCode` change → triggers room fix flow + `showHome()` restart | only if `guestData.matchedReservationId` is set |
| 4 | `globals/elevator_code` | single doc | `elevatorData` | only if `needsElevatorCode()` |
| 5 | `query(reservations, where('roomCode','==',aptId))` | roomCode filter | `activeReservation` (via `pickBest()`) | always (if aptId set) |

### 2.6 localStorage Keys

| Key | Type | Written by | Read by | Purpose |
|-----|------|-----------|---------|---------|
| `maxela_apt_id` | string | `finishRegistration_()`, `switchApt()`, room fix | `init()` | Current apartment ID |
| `maxela_guest_id` | string | `finishRegistration_()` | `init()` | Primary checkin_guests doc ID |
| `maxela_v2_session` | JSON `{guestId, aptId, hash, savedAt}` | `_saveSession()` (on nav/switchApt) | `init()` | Last-visited hash restoration |
| `maxela_all_res` | JSON array (allMatchedReservations) | `finishRegistration_()`, `switchApt()` | `init()` | Restore multi-room state |
| `maxela_g_{aptId}` | string (guestId) | `finishRegistration_()` | `init()` (fallback) | Per-apt guestId lookup |

---

## 3. KEY FUNCTIONS

### Registration Flow

| Function | Does | Reads | Writes | Notes |
|----------|------|-------|--------|-------|
| `init()` | Entry point; checks preview mode, restores session or shows register | localStorage, Firestore (`checkin_guests`, `checkin_apartments`, `reservations`) | localStorage (via room fix), Firestore (aptId update) | Calls `showHome()` or `_showPage('page-register')` |
| `searchReservation()` | Queries reservations, scores matches, finds siblings | All `reservations` docs | `search_failures` addDoc | **Recently fixed**: used to do fuzzy multi-match allowing cross-guest collision (b68d0ca) |
| `proceedFromRules()` | Gate: all 3 rules checked → show passport page | `_rules` object | — | Simple guard; no Firestore |
| `submitPassport()` | Validates file, calls `finishRegistration_()` | `passportFile`, `_pendingMatches[0]`, `_pendingReg` | — | 15s timer resets button if stuck |
| `finishRegistration_(bestRes, formData)` | Uploads passport, writes Firestore docs, calls `showHome()` | `checkin_guests` (existing check), `checkin_apartments` | `checkin_guests`, `passport_alerts`, localStorage | Creates sibling docs for multi-room; scan result written in background |
| `handlePassport(input)` | File input handler | file | — | Enables continue button, triggers `scanPassport()` |
| `scanPassport(file)` | Sends to Gemini Vision API | `globals/config` (geminiKey) | — | Sets `passportScanResult`; **external API call** |
| `handlePassportReupload(input)` | Re-upload from home page | — | `checkin_guests` (passportUrl, passportScanResult) | Uses `handlePassportReupload`, not `handleReupload` (dead code) |
| `window.handleReupload(input)` | **Dead code** — duplicate of above, not wired to any UI element | — | `checkin_guests` | Should be removed |

### Home & Navigation

| Function | Does | Reads | Writes | Notes |
|----------|------|-------|--------|-------|
| `showHome()` | Renders home, subscribes to all live listeners | `checkin_guests`, `checkin_requests`, `reservations`, `globals/elevator_code` | — | `_homeLoading` guard prevents concurrency; tears down old `_homeSnaps` first |
| `renderTiles()` | Debounced (50ms) wrapper for `_renderTilesNow()` | — | DOM | Use this, not `_renderTilesNow()` directly |
| `_renderTilesNow()` | Builds tiles HTML based on visibility config + lock state | `isUnlocked()`, `sectionVisible()`, `aptData` | DOM (`tiles-grid`) | Triggers `refreshHkToday()` on first call |
| `renderGreetingApt()` | Greeting name + apt text or pill switcher | `allMatchedReservations`, `aptId`, `APT_NAMES` | DOM (`apt-area`) | Multi-room: pills with `switchApt()` click handler |
| `renderWhatYouBooked()` | "What You Booked" collapsible card | `checkin_admin/config` (roomCategories) | DOM (`what-you-booked`) | Falls back to hardcoded defaults per property type |
| `openPage(type)` | Renders content subpage | `aptData`, `checkin_admin/config`, `checkin_requests` | DOM, `checkin_admin/config` (lazy load) | Calls `_navToContent()` which pushes history state |
| `switchApt(newRoomCode)` | Switches active room for multi-room guest | `checkin_apartments`, `allMatchedReservations` | localStorage, `_homeSnaps` (teardown+rebuild) | **Recently fixed twice** (03aadaf, 25e249d) — fragile area |
| `_navToContent(type, title, body)` | Sets content page HTML + pushes hash | — | DOM, `history.pushState` | Also calls `_saveSession()` |
| `_onReturnHome()` | Shows home + re-renders tiles | — | — | Called from `popstate` |
| `logout()` | Clears all state + localStorage + shows register | — | localStorage (removes all keys) | Resets all form fields, rules, scan state |
| `showBlockedScreen()` | Replaces tiles with "Access Revoked" message | — | DOM | Called when `guestData.blocked === true` |
| `openLocked(res)` | Shows locked WiFi subpage | `activeReservation`, `getCheckInHour()` | — | Navigates to wifi content page with lock UI |
| `_showPage(pageId)` | Switches `.active` class between `.page` elements | — | DOM | Low-level; all callers should use higher-level functions |

### Access Control

| Function | Does | Reads | Writes | Notes |
|----------|------|-------|--------|-------|
| `isUnlocked()` | Central access gate | `guestData.arrivalDate`, `activeReservation.checkin`, `guestData.manualUnlock`, `tbilisiToday()`, `tbilisiHour()`, `_hkTodayData.done`, `getCheckInHour()` | — | Returns `false` before check-in date, time-gated on check-in day |
| `needsElevatorCode()` | Whether elevator code section should show | `aptId`, `sectionVisible('elevator_code')` | — | Only `['6-1','6-2','6-3','6-4','7-1','7-2','7-4']` — note **7-3 absent** |
| `sectionVisible(key)` | Checks admin visibility toggle | `guestCfgVisibility` (cached from `checkin_admin/config`) | — | Fail-open: returns `true` if config not loaded |
| `getCheckInHour()` | Reads check-in hour (default 15) | `aptData.checkInTime` | — | Parsed from `"15:00"` string |
| `refreshHkToday()` | Fetches HK done status for today | `hk_status/{aptId}_{today}` | `_hkTodayData` | Runs every 60s + on visibility restore |
| `startUnlockPoller()` | Starts 30s time-check + 60s Firestore poll | — | `_unlockPollTimer`, `_hkPollTimer` | Called from `showHome()` |
| `stopUnlockPoller()` | Clears both poll timers | — | — | Called from `logout()` |
| `_unlockTick()` | Time-only re-check; auto-dismisses locked subpage | `isUnlocked()` | — | No Firestore — pure time |

### Name Matching

| Function | Does | Notes |
|----------|------|-------|
| `nameMatch(input, resGuest)` | 2+ word fuzzy match (Levenshtein ≤2); also tries reversed token order; Arabic transliteration path | Requires 2 token matches — **fixed b68d0ca** to prevent single-name collision |
| `partialNameMatch(input, resGuest)` | Single word match — used for Arabic date+partial scoring | Lower bar than `nameMatch` |
| `levenshtein(a, b)` | Standard edit-distance implementation | |
| `_translit(s)` | Arabic → Latin consonant map | Maps from `_AR` constant |
| `_csk(s)` | Consonant skeleton (strips vowels) | Aids Arabic matching without short vowels |
| `isArabic(s)` | Regex `/[؀-ۿ]/` | |

### Services

| Function | Does | Notes |
|----------|------|-------|
| `openSvc(id, name, hasTime)` | Opens service modal with right form fields | Reads `checkin_admin/config` if not cached |
| `submitService()` | Writes `checkin_requests` + `service_requests`, opens WhatsApp | Builds WhatsApp URL before async to count as user-initiated popup |
| `updateLaundryQty(i, delta)` | Updates laundry item counter in modal | Prices: first item full price, subsequent items × 0.4 |
| `cancelRequest()` | Sets `checkin_requests/{id}.status = 'CANCELLED'` | |
| `editRequest()` | Re-opens transfer modal pre-filled with existing data | Only for `serviceId === 'transfer'` |
| `refreshMyRequestsSection()` | Re-renders `#my-requests-section` in services subpage | Falls back to `openPage('services')` if section not in DOM |
| `getTransferConfig()` | Reads small/large car prices from `guestSvcs` | Defaults: small=70 GEL, large=100 GEL, max=7 pax |
| `calcTransferBreakdown(guests)` | Calculates # of cars needed | |
| `buildTransferSummary()` | Price label string | |

### Utilities

| Function | Does | Notes |
|----------|------|-------|
| `toast(msg, dur=2500)` | Animated bottom toast | Fixed position, z-index 9999 |
| `esc(s)` | HTML-escape string | Used throughout template literals |
| `tbilisiToday()` | `YYYY-MM-DD` in UTC+4 | `Date.now() + 4*3600*1000` |
| `tbilisiHour()` | Current hour in UTC+4 | |
| `formatTbilisiTime(unixSec)` | Formats Firestore timestamp for display | Locale-aware months per language |
| `fmtStay(s)` | `YYYY-MM-DD` → `"Jan 15"` | |
| `fmtCheckinAvailable(res)` | Returns `"15 Aug at 15:00"` or empty if past | |
| `resolveElevatorCode(text)` | Replaces `#elevatorcode` token in instruction text | 36-hour stale check; falls back to "contact host" |
| `setupDateInput()` | Auto-formats date field (DD / MM / YYYY), wires calendar picker | Hidden `<input type="date">` drives validation |
| `syncDisplayToHidden()` | Syncs formatted display → ISO hidden value | |
| `loadGuestDataWithRetry(guestId, retries=3)` | Firestore getDoc with retry + 2s delay | Returns `{data, found}` where `found` is `true/false/null` |
| `_saveSession()` | Writes `maxela_v2_session` to localStorage | Called on nav events |
| `normGuestId(n)` | Lowercases + underscores name, strips non-alphanumeric, max 40 chars | Not used for doc IDs (those are `{aptId}_{arrivalDate}`) |
| `applyTranslations()` | Sets `textContent` of translated elements from `T[lang]` map | |
| `setLang(l)` | Updates `lang`, dir, active buttons, re-renders tiles | Exported as `window.setLang` |
| `cycleLang()` | Cycles through en/ka/ru/ar | Called from top-bar language pill |
| `openLightbox(photos, index)` | Opens fullscreen image gallery | Reads `window._lbCaps` for captions (set by checkin-details.html) |
| `_openQrFullscreen(qrText)` | Renders QR on `#qr-fullscreen-canvas` via `QRCode.toCanvas()` | |

### Recently Fixed Functions (Fragile)

| Function | Fix | Commit | Risk |
|----------|-----|--------|------|
| `searchReservation()` | Siblings now by exact `reservationNumber` only, never fuzzy multi-match | b68d0ca | HIGH — re-introducing name-date group matching would merge strangers |
| `showHome()` onSnapshot #5 (`reservations`) | Added `_knownIds` from `allMatchedReservations` to pin multi-room `activeReservation` | 03aadaf | HIGH — reverting breaks room switching for multi-room guests |
| `switchApt()` onSnapshot | Added `_targetResId` capture before subscription | 03aadaf / 25e249d | HIGH — onSnapshot fires ~100ms after switch; without pin it overwrites with any matching reservation |
| `logout()` | Now clears `maxela_all_res` + resets `allMatchedReservations=[]` | 03aadaf | Medium — missing any clear leaves stale multi-room data after sign-out |
| `init()` session restore | Now clears `maxela_all_res` when `found===false` or when checkout expired | 03aadaf | Medium |
| `showHome()` guard | `_homeLoading` prevents concurrent invocations; `_homeSnaps` tear-down moved to top | 8bb27a9 | Medium — removing the guard causes listener accumulation |

---

## 4. ROOM-SPECIFIC LOGIC

### 4.1 Elevator Code

```js
function needsElevatorCode(){
  if(!['6-1','6-2','6-3','6-4','7-1','7-2','7-4'].includes(aptId)) return false;
  return sectionVisible('elevator_code');
}
```

- **Shows for:** Shartava floors 6 & 7 only (not ground floor `0-x`, not Freedom Square `tab-x`, not Orbeliani `orb-x`)
- **Missing:** `7-3` is in `APT_NAMES` but NOT in this list — likely an oversight or decommissioned apt
- **Staleness:** `resolveElevatorCode()` checks `elevatorData.updatedAt.seconds`; if >36 hours old, shows "contact host"
- **Source:** `globals/elevator_code` in Firestore (migrated from RTDB)

### 4.2 Property Type Mapping

```js
const ROOM_TO_PROP = {
  '0-1':'ROOMS', '0-2':'ROOMS', '0-3':'ROOMS', '0-4':'ROOMS', '0-5':'ROOMS',
  '6-1':'MAXELA', '6-2':'MAXELA', '6-4':'MAXELA',
  '6-3':'BIG_APT',
  '7-1':'MAXELA', '7-2':'MAXELA', '7-3':'MAXELA', '7-4':'MAXELA',
  'tab-1':'FREEDOM', 'tab-2':'FREEDOM', 'tab-3':'FREEDOM',
  'orb-1':'ORBE_1', 'orb-2':'ORBE_1',
  'orb-3':'ORBE_2',
};
```

`aptPropTypeForConfig()` overrides `ORBE_1/ORBE_2` → `'ORBELIANI'` for admin config key lookups.

### 4.3 Per-Room Behavior

| Room(s) | Property Type | Elevator Code | Recommendations | House Rules Key | Notes |
|---------|--------------|---------------|-----------------|-----------------|-------|
| `0-1` to `0-5` | ROOMS | No | shartava | small | Ground floor |
| `6-1`, `6-2`, `6-4` | MAXELA | Yes | shartava | apartment | Shartava 6th floor |
| `6-3` | BIG_APT | Yes | shartava | apartment | 3-bedroom |
| `7-1` to `7-4` | MAXELA | Yes (except `7-3`) | shartava | apartment | Shartava 7th floor |
| `tab-1` to `tab-3` | FREEDOM | No | centre | apartment | Tabidze St |
| `orb-1`, `orb-2` | ORBELIANI | No | centre | apartment | Orbeliani Suite |
| `orb-3` | ORBELIANI | No | centre | apartment | Orbeliani Studio |

### 4.4 Pickup Location (`getPickupLocation()`)

```js
'0-x' / '6-x' / '7-x' → 'Zhiuli Shartava St. 37'
'orb-x'               → 'Atoneli St. 9'
'tab-x'               → 'Galaktion Tabidze St. 3/5'
```

### 4.5 Multi-Room Booking Flow

**Registration:**
1. `searchReservation()` finds best single match
2. Fetches siblings: `query(reservations, where('reservationNumber','==', primaryRn))`
3. `allMatchedReservations = group` (all non-cancelled siblings)
4. `_pendingReg` stores form data; `_pendingMatches[0]` stores best match

**Home rendering:**
- `renderGreetingApt()`: if `allMatchedReservations.length > 1`, renders `.apt-pills` div with one pill per room
- Each pill has `data-room` attribute; click calls `window.switchApt(roomCode)`
- Active pill gets `.active` class (dark background)

**Apartment switching (`switchApt(newRoomCode)`):**
1. Sets `aptId = newRoomCode`
2. Finds `activeReservation` from `allMatchedReservations` (current/upcoming non-expired)
3. Captures `_targetResId = activeReservation?.id`
4. Updates `maxela_apt_id` + `maxela_v2_session` in localStorage
5. Fetches `checkin_apartments/{newRoomCode}`
6. Tears down all `_homeSnaps` listeners
7. Re-renders greeting + tiles
8. Restarts elevator subscription if needed
9. Subscribes to `reservations` where `roomCode == newRoomCode` with `_targetResId` pin

**finishRegistration_ for multi-room:**
- Primary doc: `{aptId}_{arrivalDate}` with `matchedReservationId = bestRes.id`
- Sibling docs: `{r.roomCode}_{arrivalDate}` for each additional room with `primaryGuestId = guestId`

### 4.6 aptId vs roomCode

| Concept | Where | Set by | Notes |
|---------|-------|--------|-------|
| `aptId` | JS variable | URL `?apt=`, localStorage, search result, `switchApt()`, room fix | Currently displayed/active room |
| `roomCode` | `reservations` docs field | MiniHotel sync script | Canonical room from PMS |
| `checkin_guests.aptId` | Firestore field | `finishRegistration_()`, room fix flow, `propagate_room_change()` (sync script) | Can diverge from `roomCode` if propagation hasn't run |
| `checkin_guests.matchedReservationId` | Firestore field | `finishRegistration_()` | Links to `reservations` doc; used by room-fix onSnapshot |

**Divergence scenario:** If MiniHotel changes a guest's room after check-in, the sync updates `reservations.roomCode` but not `checkin_guests.aptId`. The `propagate_room_change()` function in `minihotel_reservation_sync.py` was added (2026-08-20) to bridge this gap. Real-time detection also exists via the `matchedReservationId` onSnapshot (#3 above).

---

## 5. CURRENT DESIGN SYSTEM

### 5.1 CSS Custom Properties

```css
/* Backgrounds */
--bg:           #FAFAF9   /* page background */
--surface:      #FFFFFF   /* card/tile background */
--surface-2:    #F5F5F5   /* secondary surface (alias: --surface2) */

/* Text */
--ink:          #2C2C2A   /* primary text */
--ink-2:        #4A4A48   /* secondary text */
--muted:        #8C8C8A   /* hint / placeholder text */

/* Borders & Lines */
--line:         #E0D8D0   /* primary border */
--line-2:       #E8E4E0   /* secondary border */

/* Accent (gold/warm) */
--accent:       #C4A882
--accent-soft:  #FAF8F5
--accent-deep:  #5C4A3A
--accent-line:  #E8DDD0
--gold:         var(--accent)       /* alias */
--gold-light:   var(--accent-soft)  /* alias */
--gold-border:  #E8DDD0

/* Dark */
--dark:         #2C2C2A
--dark-2:       #3A3A38

/* Semantic aliases */
--text:         var(--ink)
--border:       var(--line)
--hint:         var(--muted)

/* Status colors */
--green:        #2d6b50
--green-bg:     #edf5f0
--green-border: #8ecdb0
--red:          #8b2020
--red-bg:       #fdf0f0
--red-border:   #f8c4c4
--blue:         #1a4a7a
--blue-bg:      #eef3fa
--blue-border:  #c8d8f0

/* Border radii */
--r:   4px
--rs:  4px   /* same as --r */
--rsm: 2px
```

### 5.2 Font Stack

```css
--serif: 'Playfair Display', 'Times New Roman', serif
--sans:  'Inter', -apple-system, system-ui, sans-serif
--mono:  'Courier New', ui-monospace, monospace
```

**Usage pattern:**
- `--serif` (italic): brand name, H1 headings, page titles, greeting name, modal titles
- `--sans`: body copy, buttons, inputs, tile titles
- `--mono`: labels, codes, badges, metadata, tab bars, timestamps

**Note:** Service modal has `font-family:'DM Sans',sans-serif` hardcoded in inline styles — this font is not loaded; falls back to system sans-serif. Should use `var(--sans)`.

### 5.3 Layout

- Page width: `max-width: 390px`, centered with `justify-content: center` on body
- Mobile-first; single breakpoint at `@media(max-width:480px)` (tour images shorter) and `@media(max-width:360px)` (tiles single column)
- Subpages: `position:fixed`, `left:50%`, `transform:translateX(-50%)`, `width:min(100vw,390px)` — slides in from right

### 5.4 Animations

| Name | Description | Used on |
|------|-------------|---------|
| `fadeIn` | opacity 0→1 | `.page.active` |
| `fadeUp` | opacity 0→1 + translateY 16px→0 | `.modal-sheet` |
| `slideIn` | translateX 100%→0 (legacy) | overridden by `slideInSubpage` |
| `slideInSubpage` | translateX from viewport right edge → center | `.subpage` |
| `spin` | rotate 360° | `.spinner` (loading screen) |
| `ping` | scale + fade out | `.pulse::after` (live status dot) |
| `scanSpin` | rotate 360° | `.scan-spinner` (passport scan) |

### 5.5 UI Components

#### Cards & Containers
| Component | Class | Description |
|-----------|-------|-------------|
| Hero code card | `.hero` | Door code display with animated pulse dot; `.hero.locked` variant |
| WYB card | `.wyb-card` | Collapsible "What You Booked" with gallery + amenity pills |
| Info card | `.info-card` / `.info-row` | Key-value rows with copy buttons |
| Rules box | `.rules-box` | Gold-tinted house rules display |
| Service card | `.service-card` | Row with icon + name/desc + price |
| Rec card | `.rec-card` | Recommendation with type badge + map link |
| Locked card | `.locked-card` | Centered lock icon + countdown |
| Contact bar | `.contact-bar` | Dark full-width WhatsApp link bar |
| Auth form | `.auth-form` / `.auth-row` | Registration form fields (underline style in v2) |
| Form card | `.form-card` / `.form-group` | Settings-style form (used in older flows) |
| Tour item | `.tour-item` | Image + numbered step (used in checkin-details) |

#### Buttons
| Component | Class | Description |
|-----------|-------|-------------|
| Primary CTA | `.auth-cta` | Full-width black button (square corners in v2) |
| Submit | `.submit-btn` | Full-width dark button |
| Modal submit | `.modal-submit` | Full-width dark button in modals |
| Modal cancel | `.modal-cancel` | Full-width bordered button |
| Copy button | `.hero__copy` | Pill button with copy icon; `.copied` state in green |
| Back button | `.back-btn` | 36px circle/square, subpage header |
| Language pill | `.lang-pill` | 30px pill, topbar language + sign-out |
| Language button | `.lang-btn` | Inline language switcher; `.active` = dark fill |
| Code copy | `.code-copy` | Translucent copy button inside dark code box |
| Icon-copy | `.ir-copy` | Small bordered copy button in info rows |
| Apt pill | `.apt-pill` | Room switcher pill; `.active` = dark fill |
| Contact button | `.contact-btn` | Row with icon, used on contact page |
| Laundry +/- | inline | Circular ± counter buttons in service modal |

#### Inputs
| Component | Class | Description |
|-----------|-------|-------------|
| Text input | `.form-input` | Base; `--rs` border-radius; `--accent` focus border |
| Auth row input | `.auth-row .form-input` | No border, transparent — underline row style |
| Date display | `#r-arrival-display` | Formatted DD / MM / YYYY; hidden partner `#r-arrival` |
| Date hidden | `#r-arrival` | `type="date"`, opacity:0, used for native picker |
| Contact type | `.ct-btn` | WA/TG toggle buttons; `.wa-active` (green), `.tg-active` (blue) |
| Select | `.form-input` (select) | Guests count dropdown |
| Textarea | `textarea.form-input` | 90px height, no resize |

#### Overlays & Modals
| Component | Class | Description |
|-----------|-------|-------------|
| Modal overlay | `.modal-overlay` | Backdrop + sheet; `.hidden` hides it |
| Modal sheet | `.modal-sheet` | Bottom sheet, max 90vh, scrollable content |
| Lightbox | `.lightbox` | Fixed black overlay with image + nav |
| QR fullscreen | `.qr-fullscreen` | Fixed black overlay with white QR canvas |
| Subpage | `.subpage` | Full-screen slide-in page (dynamic `#cur-sp`) |

#### Badges & Status
| Component | Class | Description |
|-----------|-------|-------------|
| Scan status | `.scan-status.scanning` / `.scan-status.scan-ok` | Passport scan progress/success |
| Request badge | `.req-badge.req-pending` / `.req-done` / `.req-cancelled` | Service request status |
| Passport banner | `.passport-banner.warn` / `.passport-banner.info` | Failed/reupload passport notice |
| Lock chip | `.hero__lockchip` | "Not yet available" chip on locked hero |
| Amenity pill | `.wyb-pill` | Small rounded pill for amenity tags |

#### Other
| Component | Description |
|-----------|-------------|
| `.toast` | Fixed bottom, dark background, opacity transition |
| `.menu-label` | Section divider with horizontal rules and center label |
| `.apt-pills` | Flex-wrap pill row for room switcher |
| `.wyb-gallery` | Horizontal scroll snap gallery |
| `.wyb-dots` | Scroll position indicators below gallery |
| `.pulse` | Animated green/gold dot for "live" indicator |
| `.spinner` | 20px spin animation (loading screen only) |
| `.scan-spinner` | 14px scan spinner in passport status |

### 5.6 Mobile vs Desktop

- **Mobile:** Full-width card; `viewport` meta blocks user zoom (`maximum-scale=1.0, user-scalable=no`)
- **Desktop:** 390px centered card with subtle `box-shadow`
- **Subpages:** `width:min(100vw,390px)` — full-width on mobile, constrained on desktop
- Only breakpoints: `max-width:480px` (tour image height 220px) and `max-width:360px` (tiles single column)
- No separate desktop layout — both use the same centered card

---

## 6. KNOWN ISSUES & TECH DEBT

### 6.1 TODO/FIXME in Code

- `L2873–2875`: `window.syncArrivalDate` is a no-op (`// legacy no-op — date sync now handled by setupDateInput`)
- `L800–806`: Firebase Storage rules comment left inline in JS — should be in docs, not source
- `L804–807`: Comment documents that storage rules are effectively open (`allow write/read: if true`) — a security note, not a TODO, but notable

### 6.2 Dead Code

| Item | Location | Problem |
|------|----------|---------|
| `window.handleReupload` | L1588–1599 | Duplicate of `handlePassportReupload`; not referenced anywhere in HTML; should be removed |
| `window.syncArrivalDate` | L2873 | Documented no-op; remove |

### 6.3 Recent Bug Fixes → Fragile Areas

| Area | Fix commits | Risk if regressed |
|------|-------------|-------------------|
| Cross-guest name matching | b68d0ca, e5f251c | **CRITICAL** — strangers' rooms merged into session |
| Multi-room `activeReservation` pinning in `showHome()` onSnapshot | 03aadaf | HIGH — wrong room shows on home after apartment switch |
| `switchApt()` onSnapshot `_targetResId` pin | 03aadaf, 25e249d | HIGH — random reservation replaces selected one ~100ms after switch |
| `_homeLoading` guard + `_homeSnaps` teardown | 8bb27a9 | Medium — concurrent `showHome()` accumulates listeners, tiles become unclickable |
| Session clear on `found===false` and checkout expiry | 03aadaf, d71bb3c | Medium — stale session shows wrong home screen |
| Firestore read retry on load | eab93ac | Medium — transient Firestore error signs out guest permanently |
| State reset on search retry | e5f251c | Medium — stale passport file/scan leaks into next attempt |

### 6.4 Hardcoded Values That Should Be Config

| Value | Location | What it is |
|-------|----------|-----------|
| `WA = '995593000724'` | L835 | Global fallback WhatsApp number |
| `['6-1','6-2','6-3','6-4','7-1','7-2','7-4']` | `needsElevatorCode()` | Elevator-eligible rooms |
| `APT_NAMES` | L840–850 | Room → display name mapping |
| `ROOM_TO_PROP` | L1922–1929 | Room → property type mapping |
| Default check-in hour `15` | `getCheckInHour()` fallback | Should always come from `aptData.checkInTime` |
| `10:00–19:00` service time range | `openSvc()` | Time picker options hardcoded |
| Default laundry price `'25 GEL'` | `_laundryTilePrice` fallback | Shown when no items configured |
| Default transfer prices `small=70, large=100, max=7` | `getTransferConfig()` | Per-service fallbacks |
| Location defaults per property | `locDefaults` in `openPage('location')` | Hardcoded address strings |

### 6.5 Potential Edge Cases

- `_homeLoading` is set to `false` at the end of `showHome()` but also inside the `roomFix` `.finally()` callback. If the room fix fires and calls `showHome()` recursively, and the outer `showHome()` hasn't reset `_homeLoading` yet, the recursive call is blocked by the guard. This is intentional but means room-fix corrections take two `showHome()` cycles to fully resolve.
- `myRequests` loads from `collection(checkin_requests)` (full collection, no server-side filter by `guestId`) — fine for current scale, won't scale to thousands of requests.
- `window._lbCaps` for lightbox captions is set by `checkin-details.html` globally — tight coupling between pages via the window object.
- `checkin_guests` doc ID is `{aptId}_{arrivalDate}`. If `arrivalDate` is missing (number-based reservation), falls back to `Date.now()` — creates a non-reproducible doc ID.
- `7-3` is in `APT_NAMES` but absent from `needsElevatorCode()` room list. If any guest is in 7-3, they won't see the elevator code even though the building requires it.

---

## 7. EXTERNAL DEPENDENCIES

### 7.1 CDN Scripts

| Library | Version | URL | Used for |
|---------|---------|-----|---------|
| qrcode.js | 1.5.3 | `https://cdn.jsdelivr.net/npm/qrcode@1.5.3/build/qrcode.min.js` | `QRCode.toCanvas()` for QR fullscreen overlay |

Loaded via `<script src>` (not a module), so `QRCode` is a global. Used in `_openQrFullscreen()`.

### 7.2 Google Fonts

```
https://fonts.googleapis.com/css2?
  family=Playfair+Display:ital,wght@0,400;0,500;0,600;1,400
  &family=Inter:wght@400;500;600;700
  &display=swap
```

Two `<link rel="preconnect">` tags for `fonts.googleapis.com` and `fonts.gstatic.com`.

### 7.3 Firebase SDK

**Version:** 11.0.1 (ESM from `https://www.gstatic.com/firebasejs/11.0.1/`)

**Modules imported:**

```js
// firebase-app.js
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-app.js";

// firebase-firestore.js
import { getFirestore, doc, setDoc, getDoc, collection, addDoc,
         onSnapshot, serverTimestamp, query, where } from "...firebase-firestore.js";
// Dynamic import:
const { getDocs } = await import("...firebase-firestore.js");  // in searchReservation()

// firebase-storage.js
import { getStorage, ref, uploadBytes, getDownloadURL } from "...firebase-storage.js";
```

**Firebase project:** `sleepy-5c962` (project ID hardcoded in `initializeApp()` config block at L822–829)

### 7.4 External APIs

| API | URL | Used for | Key source |
|-----|-----|---------|-----------|
| Gemini Vision | `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent` | Passport/ID document validation | `globals/config.geminiKey` in Firestore |
| WhatsApp | `https://wa.me/{number}?text={encoded}` | Guest contact + service request notifications | `WA` constant (L835) or per-service `whatsappNumber` from `checkin_admin/config.services` |

### 7.5 Firebase Project Config (Hardcoded)

```js
{
  apiKey: "AIzaSyCbggwwtdw751yQUO6MaHCuYKyNn7AyOTk",
  authDomain: "sleepy-5c962.firebaseapp.com",
  projectId: "sleepy-5c962",
  storageBucket: "sleepy-5c962.firebasestorage.app",
  messagingSenderId: "152940098906",
  appId: "1:152940098906:web:bf245230d705c0a62c2f63"
}
```

---

## Appendix: Firestore Collections Summary

| Collection | Purpose | Key fields |
|------------|---------|-----------|
| `reservations` | PMS-synced booking data | `reservationNumber`, `roomCode`, `status`, `checkin`, `checkout`, `guest`, `tuyaPassword`, `manualRoom` |
| `checkin_guests` | Guest registration forms | `aptId`, `name`, `nameRoman`, `matchedReservationId`, `passportUrl`, `passportScanResult`, `blocked`, `manualUnlock`, `arrivalDate`, `primaryGuestId` |
| `checkin_apartments` | Per-apt config | `wifiName`, `wifiPass`, `checkInTime`, `rules`, `recommendations` |
| `checkin_admin` | Admin config (single doc: `config`) | `visibility`, `services`, `laundryItems`, `sectionLabels`, `roomCategories`, `locationInfo` |
| `globals` | Global config | `elevator_code` doc: `{code, updatedAt}`; `config` doc: `{geminiKey}` |
| `hk_status` | Housekeeping done status | `{aptId}_{date}` doc, `done: boolean` |
| `checkin_requests` | Service requests (shown to guest) | `guestId`, `aptId`, `serviceId`, `status`, `done` |
| `service_requests` | Service log (admin only) | Mirror of request with `whatsappNumber` |
| `search_failures` | Failed booking lookups | `input_name`, `input_date`, `resolved` |
| `passport_alerts` | Invalid passport notifications | `aptId`, `guestName`, `passportUrl`, `scanResult` |
