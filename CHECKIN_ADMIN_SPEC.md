# CHECKIN_ADMIN_SPEC.md — Full Technical Audit of `checkin-admin.html`

Source-of-truth technical map for a full rebuild of the Maxela Apartments admin panel. Every function name, CSS variable, and Firestore field below is copied verbatim from `checkin-admin.html` (3429 lines) as of this audit. No paraphrasing of field names.

---

## 1. PAGE STRUCTURE

### 1.1 Sidebar tabs (`.sidebar-item[data-tab]`, `switchTab(tab)`)

| `data-tab` | Label | Render function | What it shows | Data it reads |
|---|---|---|---|---|
| `apartments` | Apartments | `renderApartments()` → `window.openAptDrawer(aptId)` | Pill-grid of all 18 rooms grouped by property, inline editor panel (`#aptEditor`) for whichever pill is selected | `APARTMENTS` (hardcoded array), `aptData` (from `checkin_apartments` listener) |
| `guests` | Guests (badge `#sf-badge` = unresolved search-failure count) | `renderGuests()` | "Guest Operations" screen: search box, 4 inner tabs (Today's Schedule / Current Guests / Upcoming 7 Days / Failed Searches) | `_resCache` (from `reservations`), `guestData` (from `checkin_guests` listener), `hkStatusData`, `searchFailures` |
| `requests` | Requests | `renderRequests()` → `buildRequestsUI()` | Date-grouped list of service requests with a filter bar (All/Airport Transfer/Transfer/City Tour/Cleaning/Laundry/Other) and a "Delete Completed" button | `service_requests` (one-shot `getDocs`, not a listener) |
| `hkpins` | HK Pins | `renderHkPins()` | 4 PIN input cards: Shartava, Centre, VGL, Admin | `hkPinsData` (from `hk_pins` listener) |
| `guestsettings` | Guest Page Settings | `renderGuestSettings()` | Elevator code card, property tab bar (Rooms/Maxela/Big Apt/Freedom/Orbeliani), then 5 `.gs-card` sections: Essential Stay Info, Paid Services & Add-ons, Additional Content, Room Categories, Location & Parking | `checkin_admin/config` doc (via `loadGuestSettings()`), `globals/elevator_code` + RTDB `/elevator_code` (via `loadElevatorCode()`) |
| *(external link, no tab)* | Search Debugger | `window.open('admin-search-test.html','_blank')` | Opens a separate file in a new tab — not part of this SPA | n/a |
| *(sidebar-bottom)* | Sign out | `adminSignOut()` | Clears `localStorage` auth token, reloads | n/a |

Tab switch persists to `localStorage.setItem('adminActiveTab', tab)` in `switchTab()` (line 757) and is read back on load via `let currentTab=localStorage.getItem('adminActiveTab')||'apartments'` (line 673).

### 1.2 Modals / drawers / overlays (exact DOM IDs)

| ID | Purpose | Opened by | Closed by |
|---|---|---|---|
| `#drawer-overlay` / `#drawer` (`.drawer`) | **Shared right-side drawer** — used for both the Guest detail view and (historically) apartment edit. Body target `#drawer-body`, title `#drawer-title`, footer `#drawer-footer`. | `openDrawer()` (called from `window.viewGuest`) | `closeDrawer()` |
| `#guestImgLightbox` / `#guestImgLightboxImg` | Full-screen passport photo viewer | `window.openImgLightbox(url)` | `window.closeImgLightbox()` |
| `#gsDrawerOverlay` / `#gsDrawer` (`.gs-drawer`) | **Second, independent drawer system** — used by Guest Page Settings ("Configure…" buttons) AND reused by the Requests tab detail view (`window.openReqDrawer`). Body `#gsDrawerBody`, title `#gsDrawerTitle`, footer is dynamically rewritten per-context (`.gs-drawer-footer`). | `window.gsOpenDrawer(sectionId)` / `window.openReqDrawer(id)` | `window.gsCloseDrawer()` |
| `#gsSaveBar` (`.gs-save-bar`) | Sticky "unsaved changes" bar with Discard/Save Settings buttons | `gsMarkDirty()` (adds `.visible`) | `window.gsSaveAll()` or `window.gsDiscard()` |
| `#lock-error` / lock screen (no explicit wrapper ID given in read range, gated by `_ADMIN_KEY` check) | Admin password gate | shown when no valid `localStorage` auth token | `window.adminUnlock()` |

**Naming trap:** `window.openAptDrawer(aptId)` does **not** use the shared `.drawer` overlay component despite its name — it renders directly into the always-visible `#aptEditor` panel inside the Apartments tab layout. There is no overlay/backdrop and no separate open/close state; selecting a different pill just re-runs the function against a new `aptId`.

There are therefore **three parallel "drawer" implementations** in this file: the shared `.drawer` (guest detail), `.gs-drawer` (settings + requests), and the misleadingly-named inline `openAptDrawer` panel (apartments).

---

## 2. FIREBASE READS & WRITES

### 2.1 Firestore reads

| Collection | How read | Fields used | When | Tab |
|---|---|---|---|---|
| `checkin_apartments` | `onSnapshot(collection(db,'checkin_apartments'))` | all fields → `aptData[docId]` | Always running from page load | Apartments |
| `checkin_guests` | `onSnapshot(collection(db,'checkin_guests'))` | all fields → `guestData[]` (id + spread) | Always running from page load | Guests, Requests (indirectly via forms), Apartments (guest URL preview) |
| `hk_pins` | `onSnapshot(collection(db,'hk_pins'))` | `pin` → `hkPinsData[docId]` | Always running from page load | HK Pins |
| `hk_status` | `onSnapshot(query(collection(db,'hk_status'), where('date','==',_hkToday)))` | `done` → `hkStatusData[docId]` (`docId` = `{roomCode}_{date}`) | Always running, filtered to today (Tbilisi) | Guests (unlock-time "cleaned early" rule) |
| `search_failures` | `onSnapshot(query(collection(db,'search_failures'), where('resolved','==',false)))` | all fields → `searchFailures[]`, sorted by `timestamp.seconds` desc | Always running from page load | Guests → "Failed Searches" inner tab, sidebar badge `#sf-badge` |
| `reservations` | `getDocs(query(collection(db,'reservations'), where('checkin','>=',cutoffStr), orderBy('checkin','desc'), limit(1000)))` via `_loadResCache()` | all fields → `_resCache[]` | Once, lazily, first time `renderGuests()` or search runs; `cutoffStr` = 1 year ago | Guests, Search |
| `checkin_admin/config` (single doc) | `getDoc(doc(db,'checkin_admin','config'))` via `loadGuestSettings()` | `visibility`, `laundryItems`, `services`, `sectionLabels`, `roomCategories`, `locationInfo` | Once per Guest Page Settings tab visit (guarded by `gsLoaded` flag) | Guest Page Settings |
| `globals/elevator_code` (single doc, Firestore) | `getDoc(doc(db,'globals','elevator_code'))` via `loadElevatorCode()` | `code`, `qr_code`, `updatedAt` | Every time Guest Page Settings tab renders | Guest Page Settings |
| RTDB `/elevator_code.json` | plain `fetch()` (REST, not the RTDB SDK) via `loadElevatorCode()` | `display_code`, `code`, `qr_code`, `updatedAt` | Same call as above — compared timestamp-vs-timestamp against Firestore, whichever is newer wins | Guest Page Settings |
| `service_requests` | `getDocs(query(collection(db,'service_requests'), orderBy('timestamp','desc'), limit(100)))` | all fields → `reqData[]` | Once per Requests tab visit (**one-shot, not a listener** — stale until tab is re-entered) | Requests |

### 2.2 Firestore writes

| Collection | Function | Fields written | Trigger |
|---|---|---|---|
| `checkin_apartments/{aptId}` | `window.saveAptData(aptId)` | `tuyaDeviceId`, `doorCode`, `checkInTime`, `checkOutTime`, `wifiName`, `wifiPass`, `rules`, `instructions`, `videoUrl`, `photos`, `photoCaptions`, `updatedAt:serverTimestamp()` — **full `setDoc` overwrite, not merge** | "Save changes" button in Apartments tab |
| `checkin_apartments/{aptId}` | `window.deletePhoto` / `window.movePhoto` / `window.doReplacePhoto` / `window.uploadPhotos` | `photos`, `photoCaptions` — `{merge:true}` | Photo step buttons |
| `checkin_apartments/'0-4'` | inline in the `checkin_apartments` `onSnapshot` handler | `tuyaDeviceId:'bf9f9b096af5eb1043fik2'` — `{merge:true}` | Auto-fires once whenever apt `0-4`'s Tuya ID is unset — a **hardcoded self-healing write baked into the read listener** |
| `checkin_guests/{guestId}` | `window.unlockGuest` | `manualUnlock:true`, `unlockedAt:serverTimestamp()` | "Unlock check-in now" button |
| `checkin_guests/{guestId}` | `window.lockGuest` / `window.lockRoomDrawer` / `window.unlockRoomDrawer` | `manualUnlock:false/true` | Lock/Unlock buttons in multi-room drawer rows |
| `checkin_guests/{guestId}` | `window.approvePassport` / `window.rejectPassport` / `window.passportActionInDrawer` | `passportScanResult.overrideByAdmin`, `passportScanResult.valid` (dot-path `updateDoc`) | Approve/Reject ID buttons |
| `checkin_guests/{guestId}` | `window.blockGuest` / `window.unblockGuest` | `blocked:true/false`, `blockedAt:serverTimestamp()` | Block/Unblock buttons |
| `checkin_guests/{guestId}` | `window.moveGuest` | `aptId:newRoom` — `{merge:true}` | "Move Guest" button (single-room drawer) |
| `checkin_guests/{formId}` | `window.moveRoomInGroup` | `aptId:newRoom` — `{merge:true}` | "Fix" button per row (multi-room drawer) |
| `checkin_guests/{id}` | `window.deleteGuest` / `window.deleteGuestGroup` / `window.cleanDuplicateGuests` / `window.deleteOldGuests` | `deleteDoc` | Delete buttons |
| `reservations/{matchedReservationId}` | `window.moveGuest` | `roomCode:newRoom`, `manualRoom:true` | Same "Move Guest" action — writes both `checkin_guests` and `reservations` |
| `reservations/{resDocId}` | `window.moveRoomInGroup` | `roomCode:newRoom`, `allRooms:newRoom`, `manualRoom:true` | "Fix" button (multi-room drawer, when a `resDocId` is present) |
| `reservations/{resDocId}` | `window.deleteOrphanRes` | `deleteDoc` | "Delete doc" button (multi-room drawer, stale reservation cleanup) |
| `hk_pins/{roleId}` | `window.saveHkPin` | `pin`, `updatedAt:serverTimestamp()` | Save button per PIN card |
| `checkin_admin/config` | `window.gsSave` / `window.gsSaveAll` (`gsSaveGuestPageSettings→gsSave`) | `visibility`, `laundryItems`, `services`, `sectionLabels`, `roomCategories`, `locationInfo`, `updatedAt:serverTimestamp()` — **full-document `setDoc`, no merge** | "Save Settings" in sticky `#gsSaveBar` |
| `globals/elevator_code` | `window.gsUpdateElevatorCode` | `display_code`, `qr_code`, `expires_at`, `updatedAt:serverTimestamp()`, `code` — `{merge:true}` | "Update Code" button |
| RTDB `/elevator_code.json` | `window.gsUpdateElevatorCode` | `display_code`, `qr_code`, `expires_at`, `updatedAt` (string, plain `PATCH` fetch) | Same button — **RTDB is written first, then Firestore**, so a failure between the two calls leaves them out of sync |
| `search_failures/{failureId}` | `window.resolveSearchFailure` | `resolved:true`, `resolvedAt:serverTimestamp()` | "Mark Resolved" button |
| `service_requests/{id}` | `window.setReqStatus` | `status` | Confirm/Cancel buttons in request drawer |
| `service_requests/{id}` | `window.deleteReq` / `window.deleteCompleted` | `deleteDoc` | Delete buttons |
| `checkin_guests/{newId}` (one-time utility) | `window.fixNasirMultiRoom` | full guest-form copy with `aptId:'6-4'`, `matchedReservationId`, `primaryGuestId` | Manual browser-console call only, not wired to any UI button |

### 2.3 `onSnapshot` listeners (all registered once at module load, lines 2577–2610)

1. `onSnapshot(collection(db,'checkin_apartments'), …)` → rebuilds `aptData`, includes the `0-4` self-heal write, calls `render()`
2. `onSnapshot(collection(db,'checkin_guests'), …)` → rebuilds `guestData`, calls `render()`
3. `onSnapshot(collection(db,'hk_pins'), …)` → patches `hkPinsData`, re-renders only if `currentTab==='hkpins'`
4. `onSnapshot(query(collection(db,'hk_status'), where('date','==',_hkToday)), …)` → rebuilds `hkStatusData`, re-renders `renderGuests()` unless on apartments/hkpins/guestsettings/requests
5. `onSnapshot(query(collection(db,'search_failures'), where('resolved','==',false)), …)` → rebuilds `searchFailures`, updates `#sf-badge`, re-renders if on Guests tab

`checkLoaded()` (line 2575) requires 2 of the 5 listeners (`checkin_apartments`, `checkin_guests`) to have fired at least once before hiding `#loading` and calling the first `render()`; a 5-second `setTimeout` fallback (line 2613) force-hides the loader regardless.

**Note:** `Requests` (`service_requests`) and `reservations` are deliberately **not** live listeners — both are one-shot `getDocs` fetches, re-run only when their tab is entered / a manual refresh is triggered. This means the Requests tab and the Guests tab's reservation data can silently go stale while the admin has another tab open.

### 2.4 Realtime Database

- **Read**: plain `fetch('https://sleepy-5c962-default-rtdb.europe-west1.firebasedatabase.app/elevator_code.json')` inside `loadElevatorCode()` — no RTDB SDK import, no `onValue` listener, so it is only re-fetched when Guest Page Settings re-renders.
- **Write**: plain `fetch(..., {method:'PATCH'})` to the same URL inside `window.gsUpdateElevatorCode()`.

---

## 3. KEY FUNCTIONS

### Auth / Shell

| Function | Does | Reads | Writes | Notes |
|---|---|---|---|---|
| `window.adminUnlock()` | Checks entered password against `_ADMIN_PWD='maxela2026'` (hardcoded plaintext), sets a localStorage token | — | `localStorage['maxela_admin_authed']` | **⚠ Security: not real auth** — client-side-only password check, password visible in page source, no server-side rule enforcement implied by this code path |
| `window.adminSignOut()` | Clears the auth token, reloads | — | `localStorage` | |
| `window.toggleSidebar()` / `window.toggleMobileSidebar()` | Collapse/expand sidebar (desktop) or open/close as overlay (mobile) | — | `localStorage['adminSidebarCollapsed']` (desktop only) | |
| `render()` | Dispatches to the correct tab renderer based on `currentTab` | `currentTab` | — | |
| `esc(s)` | HTML-escapes `& < > "` | — | — | **Escapes double-quotes**, unlike the guest-side `esc()` in `checkin-guest-v2.html`, which does not — a known source of onclick/JSON.stringify quoting bugs when code is copy-pasted between the two files |
| `uploadToCloudinary(file, folder)` | Uploads to Cloudinary unsigned preset `maxela_uploads`, cloud `dlkjizhya` | — | external (Cloudinary) | Shared by apartment photos, videos, room-category photos, parking media |

### Apartments Tab

| Function | Does | Reads | Writes | Notes |
|---|---|---|---|---|
| `renderApartments()` | Renders the pill grid + empty editor panel; re-opens the last-selected apt (`window._currentAptId`) | `APARTMENTS`, `aptData` | — | |
| `window.openAptDrawer(aptId)` | Builds the full editor form (Smart Lock, Timing, WiFi, Check-In Steps/photos, Guest Check-In Link) into `#aptEditor` | `aptData[aptId]` | — | See §1.2 naming trap |
| `window.setLockMode(mode)` | Toggles visibility between auto (Tuya) / manual (static code) sub-panels | — | — | Pure DOM toggle, no Firestore |
| `window.testTuyaDevice(aptId)` | Calls a **local-only** proxy at `http://localhost:3000` to generate a Tuya offline temp password | — | — | Only works when a local Tuya proxy is running on the admin's machine; will always fail in production/deployed use |
| `window.uploadPhotos` / `window.doReplacePhoto` / `window.movePhoto` / `window.deletePhoto` | Photo-step CRUD | `aptData[aptId].photos/.photoCaptions` | `checkin_apartments/{aptId}` (merge) | All 4 re-open the drawer after writing to reflect the new state |
| `window.uploadVideo(aptId, input)` | Uploads a walkthrough video to Cloudinary (100MB client-side size cap) | — | (updates the `#apt-videoUrl` input only — actual Firestore write happens on next Save) | |
| `window.saveAptData(aptId)` | Reads every form field by DOM ID, full-overwrite `setDoc` | DOM form fields | `checkin_apartments/{aptId}` (full overwrite) | **HIGH RISK if edited** — touches `checkin_apartments`, the room-config source of truth |

### Guests Tab — HIGH RISK (touches `reservations` / `checkin_guests`)

| Function | Does | Reads | Writes | Notes |
|---|---|---|---|---|
| `guestStatus(g)` | Computes unlock label/class for a `checkin_guests` doc: arrives-later / checked-in / manual-unlock / hour-reached / HK-early-unlock / waiting | `g.arrivalDate`, `g.manualUnlock`, `aptData[g.aptId].checkInTime`, `hkStatusData` | — | **Independent reimplementation of `isUnlocked()` from the guest-side pages** — the two must be kept in sync manually; no shared module |
| `_loadResCache()` | One-shot fetch of up to 1000 `reservations` from the last year | `reservations` | `_resCache` (module var) | **Unpaginated 1000-doc query on every fresh page load** — scale/cost concern flagged for rebuild |
| `renderGuests()` | Builds the entire Guest Operations screen: cross-room form matching (`_formById`, `_byGuestCheckin`), arrivals/departures/in-house/upcoming grouping, WhatsApp pre-fill link building | `_resCache`, `guestData`, `hkStatusData`, `searchFailures` | — | See §6.1 for the join logic in detail — **this is the function that was buggy before** |
| `window.goSearch()` | Debounced (300ms) client-side filter over `_resCache` by name/room/reservationNumber/bookingId | `_resCache`, `guestData` | — | Uses its own `getSearchForm()` — **missing the cross-room-group-sharing step** that `renderGuests()`'s `_formById` construction has, so a multi-room guest can show "NO FORM" in search when the main list correctly shows a form |
| `window.resLookupSearch()` | Separate lightweight reservation lookup (used elsewhere in the UI, not the main search box) | `_resCache` | — | Its "View check-in page" links point to the **old redirect file `checkin-guest.html`**, not `checkin-guest-v2.html` or either sandbox — stale reference |
| `window.viewGuest(guestId)` | Opens the shared `.drawer`; branches into single-room vs. merged multi-room layout via `_guestGroup()`/`_siblingRes()` | `guestData`, `_resCache`, `APARTMENTS` | — | **The actual "multi-room drawer"** — see §6.3 |
| `window.moveGuest` / `window.moveRoomInGroup` | Room reassignment (single vs. multi-room drawer variants) | — | `checkin_guests`, `reservations` (sets `manualRoom:true`) | **HIGH RISK** — see §6.4 |
| `window.deleteOrphanRes` | Deletes a stray `reservations` doc | — | `reservations` (`deleteDoc`) | **HIGH RISK** — irreversible, used to clean up duplicate/stale reservation docs surfaced in the multi-room drawer |
| `window.fixNasirMultiRoom()` | One-time hardcoded utility to backfill a missing 6-4 form for a specific named guest ("Nasir Mammadov") | `checkin_guests`, `_resCache` | `checkin_guests` (new doc) | **Dead/fragile code** — hardcoded guest name string match, console-only entry point, should be deleted before a rebuild |
| `window.unlockGuest` / `window.lockGuest` / `window.lockRoomDrawer` / `window.unlockRoomDrawer` | Toggle `manualUnlock` | — | `checkin_guests` | |
| `window.approvePassport` / `window.rejectPassport` / `window.passportActionInDrawer` | Admin override of AI passport-scan result | — | `checkin_guests.passportScanResult.*` | |
| `window.blockGuest` / `window.unblockGuest` | Revoke/restore guest access | — | `checkin_guests.blocked` | |
| `window.alertPassport(guestId)` | Opens a `mailto:` to `nikavibliani@gmail.com` pre-filled with suspicious-passport details | `guestData`, `APARTMENTS` | — | Hardcoded recipient address in client code |
| `_baseResId` / `_baseResNum` / `_guestGroup` / `_siblingRes` | Multi-room grouping helpers (base reservation-number stripping of `_NNN` suffix, name+checkin matching) | `guestData`, `_resCache` | — | See §6.1/§6.3 |

### Guest Page Settings Tab

| Function | Does | Reads | Writes | Notes |
|---|---|---|---|---|
| `loadGuestSettings()` | Loads and normalizes `checkin_admin/config` into 6 module-level state vars (`gsVisibility`, `gsLaundry`, `gsServices`, `gsSectionLabels`, `gsRoomCategories`, `gsLocationInfo`) | `checkin_admin/config` | — | Runs once per tab visit, gated by `gsLoaded` |
| `loadElevatorCode()` | RTDB-vs-Firestore timestamp race, normalizes into `gsElevatorData` | RTDB + `globals/elevator_code` | — | |
| `renderGuestSettings()` | Builds the full tab layout, calls `gsRenderAll()` and `gsPopulateElevatorCard()` | all `gs*` state | — | |
| `window.gsToggle(id, val)` / `gsRenderRows` / `gsRenderAll` | Per-property, per-section visibility toggles | `gsVisibility[gsProp]` | (marks dirty only — actual write happens on Save) | |
| `window.gsOpenDrawer(sectionId)` / `gsDrawerService` / `gsDrawerLabel` / `gsDrawerWifi` / `gsDrawerLaundry` / `gsDrawerTextBlock` / `gsDrawerNewService` | Build the right-hand `.gs-drawer` body per section type (service/label/wifi/laundry/text/new-custom-service) | `gsServices`, `gsSectionLabels`, `gsLaundry` | — | |
| `window.gsDrawerSave()` | Commits in-drawer edits back into the in-memory `gs*` state objects | DOM fields | (marks dirty; actual Firestore write on Save) | |
| `window.gsRenderRoomCategory` / `gsSetCategoryField` / `gsAddAmenity` / `gsRemoveAmenity` / `gsUploadCategoryPhoto` / `gsSetMainPhoto` | Per-property room-category editor (name, description, max guests, amenities, multi-photo with "MAIN" flag) | `gsRoomCategories[gsProp]`, `ROOM_CATEGORY_DEFAULTS[gsProp]` | Cloudinary (photo upload) | |
| `window.gsRenderLocationInfo` / `gsSetLocationField` / `gsUploadParkingMedia` | Per-property address/maps-URL/neighborhood/parking editor | `gsLocationInfo[gsProp]`, `LOCATION_INFO_DEFAULTS[gsProp]` | Cloudinary (parking media upload) | |
| `window.gsSave()` / `window.gsSaveAll()` | Full-document `setDoc` of all `gs*` state to `checkin_admin/config` | — | `checkin_admin/config` (full overwrite) | **HIGH RISK if broken** — a single shared config doc for the entire property portfolio; a bad write here breaks the guest page for every property at once |
| `window.gsUpdateElevatorCode()` | Dual-writes RTDB then Firestore | — | RTDB `/elevator_code`, `globals/elevator_code` | Order matters — see §2.2 |

### Requests Tab

| Function | Does | Reads | Writes | Notes |
|---|---|---|---|---|
| `renderRequests()` | One-shot fetch of last 100 `service_requests`, ordered by timestamp desc | `service_requests` | — | **Not live** — see §2.3 |
| `buildRequestsUI()` / `reqRow(r)` | Date-grouped ("Today"/"Yesterday"/dated), filterable list | `reqData` | — | |
| `window.openReqDrawer(id)` | Reuses the `.gs-drawer` component (not a dedicated requests drawer) to show full request detail + a WhatsApp deep link | `reqData` | — | Rewrites the shared drawer's footer buttons dynamically (Confirm/Cancel) |
| `window.setReqStatus(id, status)` | Confirm/Cancel a request | — | `service_requests.status` | |
| `window.deleteReq` / `window.deleteCompleted` | Delete one / all CONFIRMED+CANCELLED requests | — | `service_requests` (`deleteDoc`) | `deleteCompleted` is a bulk irreversible action gated only by a `confirm()` |
| `updateRequestsBadge()` | Updates the sidebar `.req-badge` pending-count pill | `reqData` | — | |

### HK Pins Tab

| Function | Does | Reads | Writes | Notes |
|---|---|---|---|---|
| `renderHkPins()` | Renders 4 PIN cards (Shartava/Centre/VGL/Admin) | `hkPinsData` | — | |
| `window.saveHkPin(roleId)` | Validates exactly-4-digit PIN, saves | — | `hk_pins/{roleId}` | |

---

## 4. KNOWN BUGS & FRAGILE AREAS

### 4.1 TODO/FIXME
None found — `grep -n "TODO\|FIXME\|HACK\|XXX" checkin-admin.html` returns zero matches. The file has no explicit debt markers; fragility instead shows up as one-off named-guest utility functions and comment-documented "one-time" fixes (see below).

### 4.2 Recent fix history (`git log --oneline -20 -- checkin-admin.html`)

```
6779671 Add room-fix controls to multi-room guest drawer (fixes Amnah Ateen / Moris Torunyan case)
ce5e671 Use form aptId (not reservation roomCode) for guest card room display
b39e3f3 Fix relocated-guest 'No Form' false negative (3 fixes)
7c17733 Fix elevator QR pre-fill: fall back to RTDB qr_code when Firestore wins
48db48e Fix elevator code admin: write full field set to both RTDB and Firestore
98c9b68 Enable VGL sync + add VGL housekeeper role to HK app
4842d2f Add manual QR code control to Elevator Code admin card
80b6bf1 Add Search Debugger link to admin sidebar
46ae2ba WhatsApp pre-fill: property-specific messages for Freedom and Orbeliani
a12c18c WhatsApp button: pre-fill check-in message when guest has NO FORM
58e9627 Merge multi-room reservations into single row in Guests tab
c363f5c Fix multi-room drawer merging and activeReservation past-date selection
15739ee Merge multi-room guests by name stripping and reservationNumber matching
f36071d Admin Guests tab: restore Delete button, add merged multi-room drawer view
80971e2 Multi-room booking: save all rooms on registration, cross-match in admin, Nasir fix utility
8406930 Room reassignment: aggressive correction on load, real-time listener, admin Move Guest
320bcc8 Fix View Page button to open in preview mode
9b9908c Fix Arabic name matching, store nameRoman, use it in admin display
d70c1da Fix Arabic name display, add Refresh button to Guest Operations
66283ba Fix phone number display: fall back to reservation phone when no form
```

**Pattern**: 11 of the last 20 commits touching this file are directly about multi-room guest matching, room reassignment, or the guest-list join logic. This is the single most-patched area of the admin — any rebuild of the Guests tab must treat `_guestGroup`/`_siblingRes`/`_formById`/`groupByBaseNum` as the highest-risk region to reproduce correctly.

### 4.3 Hardcoded values that should be config

| Value | Location | Should be |
|---|---|---|
| `_ADMIN_PWD='maxela2026'` | line 561 | Server-side auth (Firebase Auth / Cloud Function) — plaintext client-side password is a real security hole |
| `nikavibliani@gmail.com` | `window.alertPassport` | Configurable notification recipient |
| `http://localhost:3000` (Tuya proxy) | `window.testTuyaDevice` | Environment-configurable proxy URL; currently dead in any deployed (non-localhost) admin session |
| `checkin_apartments/'0-4'` Tuya ID `'bf9f9b096af5eb1043fik2'` | `checkin_apartments` `onSnapshot` handler | Should not be a hardcoded self-healing write inside a read listener at all |
| Room list `['0-1','0-2','0-3','0-4','0-5','6-1','6-2','6-3','6-4','7-1','7-2','7-4','tab-1','tab-2','tab-3','orb-1','orb-2','orb-3']` | duplicated inline in `viewGuest`'s two room-select dropdowns AND `drawer-room-select` | Should derive from the single `APARTMENTS` array instead of being retyped |
| `_roomLabel(code)` room→display-name mapping | line 1300 | **Third** independent hardcoded room→name mapping in the codebase (alongside `APARTMENTS[].name` in this file and `APT_NAMES` in `checkin-guest-v2.html`) — drift risk |
| Elevator-eligible logic embedded in `SECTION_DEFAULTS` (`elevator_code:true` only for `MAXELA`/`BIG_APT`) | line 694-700 | Matches `CODEBASE.md`'s room list but is a third place this fact is encoded |

### 4.4 Dead / one-off code

- `window.fixNasirMultiRoom()` (lines 2157-2188) — explicitly commented `// ── ONE-TIME UTILITY: fix Nasir Mammadov missing 6-4 form ─────────────────` — hardcoded guest-name string match, console-only, should be deleted.
- `window.testTuyaDevice` — non-functional outside localhost, effectively dead in production use.

### 4.5 Duplicate component implementations within this single file

- Two toggle-switch components: `.switch`/`.slider` (base admin, used in Apartments/HK Pins/legacy settings) vs `.gs-toggle`/`.gs-toggle-track` (Guest Page Settings rows).
- Two drawer systems: shared `.drawer` vs `.gs-drawer` (see §1.2).
- Two independent unlock-status implementations: `guestStatus()` (this file) vs `isUnlocked()` (guest-facing pages) — must be hand-kept in sync.
- `esc()` in this file escapes `"`; the guest pages' `esc()` does not — the same inconsistency class that previously caused a real onclick/JSON.stringify quoting bug on a sandbox page.

### 4.6 Functions touching `reservations` or `checkin_guests` — flagged high-risk per the room-assignment bug history

`window.moveGuest`, `window.moveRoomInGroup`, `window.deleteOrphanRes`, `window.fixNasirMultiRoom`, `renderGuests()` (via `_formById`/`_byGuestCheckin` construction), `window.viewGuest` (via `_guestGroup`/`_siblingRes`), the `checkin_guests` and `reservations`-adjacent `onSnapshot` handler. **Any rebuild must re-run the exact matching logic in §6.1/§6.3/§6.4 before touching these.**

---

## 5. CURRENT DESIGN SYSTEM

### 5.1 Font stack
`'DM Sans', sans-serif` (body default) with `'DM Mono', monospace` used for room codes, reservation numbers, and PIN inputs. Loaded via Google Fonts: `DM+Sans:wght@300;400;500;600&family=DM+Mono:wght@400;500&family=Playfair+Display:wght@400;500` (Playfair is loaded but not visibly used in the read source — likely vestigial).

**Guest Page Settings section overrides this** — several `.gs-*` inline styles fall back to `ui-monospace,monospace` for numeric inputs rather than DM Mono, and comments in the code (`GEMINI UI` marker at line 2615) indicate this section was generated by a different tool/pass than the rest of the file, which explains its visual divergence.

### 5.2 CSS custom properties — base admin (`:root`)
```
--bg:#f7f6f4; --surface:#fff; --surface2:#f0eeeb;
--border:#e2dfd9; --border2:#c8c3bb;
--text:#1e1c1a; --muted:#6e6b66; --hint:#aea9a2;
--accent:#3d6b5a; --accent-bg:#f0f6f3; --accent-border:#9ec9b8;
--green:#2d6a4f; --green-bg:#f0f7f4; --green-border:#95d5b2;
--red:#922b21; --red-bg:#fdf2f2; --red-border:#f5a9a0;
--amber:#7a5a0a; --amber-bg:#fdf8ee; --amber-border:#e8c97a;
--blue:#1d4ed8; --blue-bg:#eff4ff; --blue-border:#bfcffa;
--r:10px; --rs:7px; --rsm:4px;
```

### 5.3 CSS custom properties — Apartments-tab-specific (`--apt-*`)
`--apt-accent`, `--apt-accent-bg`, `--apt-amber`, `--apt-amber-bg`, `--apt-bg`, `--apt-border`, `--apt-green`, `--apt-green-bg`, `--apt-muted`, `--apt-radius`, `--apt-red`, `--apt-red-bg`, `--apt-shadow`, `--apt-text`, `--apt-white`

### 5.4 CSS custom properties — Guest Page Settings-specific (`--gs-*`)
`--gs-accent`, `--gs-accent-light`, `--gs-bg`, `--gs-border`, `--gs-border-hover`, `--gs-drawer-w`, `--gs-green`, `--gs-radius-lg`, `--gs-radius-md`, `--gs-radius-sm`, `--gs-red`, `--gs-shadow-md`, `--gs-shadow-sm`, `--gs-text-main`, `--gs-text-muted`, `--gs-white`

This is a **third, visually distinct token system** layered on top of the base admin tokens — none of the `--gs-*` or `--apt-*` variables are derived from the base `--accent`/`--border`/etc. tokens, so a rebrand requires editing 3 separate token blocks.

### 5.5 Component types

| Type | Classes | Where used |
|---|---|---|
| Cards | `.card`, `.card-header`, `.card-title`, `.card-body`, `.card-sub` (base); `.apt-card`, `.apt-card-header`, `.apt-card-title`, `.apt-card-badge`, `.apt-card-body` (Apartments); `.gs-card`, `.gs-card-header`, `.gs-card-icon`, `.gs-card-title` (Guest Settings + Requests) | 3 separate card systems |
| Rows | `.guest-row` (legacy, appears unused by current `renderGuests` which uses `.go-row` instead); `.go-row`, `.go-room`, `.go-guest-name`, `.go-guest-sub`, `.go-guest-dates`, `.go-contact`, `.go-actions`, `.go-action` (Guest Operations); `.gs-row`, `.gs-row-icon`, `.gs-row-info`, `.gs-row-title`, `.gs-row-sub`, `.gs-row-actions` (Guest Settings + Requests) | |
| Badges/status | `.status-pill` + `.pill-ok`/`.pill-warn`/`.pill-err` (Apartments); `.unlock-badge` + `.unlocked`/`.locked`/`.waiting` (legacy guest drawer); `.go-pill` + `.go-pill-confirmed`/`.go-pill-pending`/`.go-pill-info`/`.go-pill-red` (Guest Operations) | 3 independent badge-class vocabularies for what is conceptually the same "status" concept |
| Buttons | `.btn`/`.btn-primary`/`.btn-green`/`.btn-red`/`.btn-amber`/`.btn-sm` (base); `.apt-test-btn`, `.apt-save-btn`, `.apt-mode-btn`, `.apt-add-step`, `.apt-copy-btn`, `.apt-step-btn` (Apartments); `.go-btn`, `.go-btn-danger`, `.go-action`, `.go-action-primary` (Guest Ops); `.gs-add-btn`, `.gs-edit-btn`, `.gs-drawer-save`, `.gs-drawer-cancel`, `.gs-discard-btn`, `.gs-save-settings-btn` (Guest Settings) | |
| Inputs | `.form-input`/`.form-group`/`.form-label`/`.form-row` (base); `.apt-input`, `.apt-textarea`, `.apt-label`, `.apt-field` (Apartments); `.gs-drawer-input`, `.gs-drawer-label`, `.gs-drawer-section` (Guest Settings drawer) | |
| Toggles | `.switch`/`.slider` (base — checkbox toggle); `.gs-toggle`/`.gs-toggle-track` (Guest Settings — independent reimplementation) | |
| Overlays/modals | `.drawer-overlay`/`.drawer` (shared, guest detail); `.gs-drawer-overlay`/`.gs-drawer` (settings + requests) | |

### 5.6 Mobile vs desktop
Sidebar collapses to icon-only (`.admin-sidebar.collapsed`, 56px) on desktop via `toggleSidebar()`, or becomes a slide-over with `.mob-overlay` backdrop on mobile via `toggleMobileSidebar()` (hamburger button `#hamburger-btn`, shown only below the mobile breakpoint per the `.hamburger-btn{display:none}` default + a media query elsewhere in the stylesheet). `.main:has(.go-root){max-width:none;padding:0;}` — the Guests tab explicitly opts out of the shared `.main{max-width:1200px}` container, giving it a full-bleed table layout distinct from every other tab. Overall the admin is **desktop-first**: dense multi-column grids (`.form-row{grid-template-columns:1fr 1fr}`, `.go-row{grid-template-columns:60px 1fr 150px 130px 210px}`) with no evidence of a mobile-optimized breakpoint for the data-table-heavy tabs (Guests, Requests) beyond the sidebar collapsing.

---

## 6. DATA FLOWS

### 6.1 How the Guests tab builds its list (reservations + checkin_guests join)

This is the historically buggy area (see §4.2 git log) and works as follows, inside `renderGuests()`:

1. `_loadResCache()` populates `_resCache` from `reservations` (≤1000 docs, last-year cutoff).
2. **Direct match pass** builds `_formById: Map<reservationId, checkin_guests doc>` by trying, in order, for each reservation `r`:
   - `guestData.find(g => g.matchedReservationId === r.id)`
   - `guestData.find(g => g.matchedReservationId === r.reservationNumber)`
   - `guestData.find(g => g.aptId === r.roomCode && g.arrivalDate === r.checkin)`
   - `guestData.find(g => name-stripped-match(g) === name-stripped-match(r.guest) && g.arrivalDate === r.checkin)`
3. **Cross-room sharing pass** builds `_byGuestCheckin: Map<"strippedName|checkin", reservation[]>`. For any group with 2+ reservations sharing the same stripped guest name and checkin date, if **any** reservation in the group already has a form via step 2, that same form is propagated to every other reservation in the group that lacks one (`_formById.set(r.id, shared)`). This is the mechanism that lets one submitted form cover a guest's whole multi-room booking.
4. Reservations are bucketed into `arrivals` / `departures` / `inHouse` / `upcoming` by comparing `checkin`/`checkout` to today (Tbilisi, UTC+4).
5. Each bucket is grouped by **base reservation number** via `groupByBaseNum()`, which strips a trailing `_\d+` suffix off `reservationNumber||id` — this collapses `RES123_001`/`RES123_002` (separate per-room reservation docs from the same booking) into one visual row.
6. Groups of size 1 render via `tableRow(r, sub)`; groups of size 2+ render via `mergedRow(grp, sub)`, which joins room codes with `' · '` and computes a combined status via `groupStatusInfo()` (NO FORM if any room lacks a form; UNLOCKED only if **every** room's form is unlocked; otherwise AWAITING UNLOCK).

`goSearch()` (the search box) does **not** reuse `_formById` — it has its own `getSearchForm()` with only the first 3 of the 4 matching strategies above and no cross-room-sharing pass, so a multi-room guest whose form was found only via propagation in step 3 can show "NO FORM" in search results while showing correctly in the main list.

### 6.2 How room assignment displays per guest row

- `tableRow()`: `displayRoom = form?.aptId || r.roomCode || r.room || '—'` — **prefers the `checkin_guests` doc's `aptId` field over the raw `reservations.roomCode`**. This is deliberate (commit `ce5e671 "Use form aptId (not reservation roomCode) for guest card room display"`) and is exactly the mechanism by which a manual room move (which updates `checkin_guests.aptId`) is reflected in the list without needing to also update every downstream reservation doc.
- `mergedRow()`: same logic per sorted room in the group — `sorted.map(r => getForm(r)?.aptId || r.roomCode || r.room || '—').join(' · ')`.

### 6.3 How the multi-room drawer works

Opened by `window.viewGuest(guestId)`. It computes:
- `group = _guestGroup(g)` — reservations/forms linked by base Firestore-doc-ID suffix (`_baseResId`, stripping trailing `_\d{3,4}`) OR base `reservationNumber` (`_baseResNum`, same stripping, resolved via `_resCache`) OR stripped-name+checkin match.
- `sibRes = _siblingRes(g)` — the raw sibling `reservations` docs for the same booking.
- `isMulti = group.length>1 || sibRes.length>1`.

If `isMulti`, the drawer renders one row per room. It prefers `sibRes` (the raw reservation docs) over `group` (the `checkin_guests` docs) whenever `sibRes.length>1`, via `useResRooms=sibRes.length>1` — meaning the *reservation* list, not the *form* list, drives which rooms are shown, with the matching form (if any) looked up per-room for its unlock status and access buttons. Each row includes an inline room-reassignment `<select>` + "Fix" button (`window.moveRoomInGroup`) and, for the `sibRes` path only, a "Delete doc" button (`window.deleteOrphanRes`) for cleaning up stale reservation docs.

### 6.4 How manual room override (`manualRoom:true`) surfaces

`manualRoom` is a field on the **`reservations`** collection, not on `checkin_guests`. It is set to `true` by exactly two write paths:
- `window.moveGuest` (single-room drawer "Move Guest" button) — updates `reservations/{matchedReservationId}` with `{roomCode:newRoom, manualRoom:true}`.
- `window.moveRoomInGroup` (multi-room drawer "Fix" button) — updates `reservations/{resDocId}` with `{roomCode:newRoom, allRooms:newRoom, manualRoom:true}`.

It is **only ever displayed** in the multi-room drawer's `sibRes`-driven row rendering (`useResRooms===true` branch), as a `MANUAL` badge: `${r.manualRoom?'<span …>MANUAL</span>':''}` (line 1985). It is **not read or displayed anywhere else in this file** — not in `tableRow`/`mergedRow` on the main Guests list, not in the single-room drawer view, and not in the Apartments tab. A guest whose room was manually overridden shows no visible indicator anywhere except inside that one specific multi-room drawer branch.

---

## 7. EXTERNAL DEPENDENCIES

| Dependency | Details |
|---|---|
| Firebase SDK | v11.0.1, ESM imports from `https://www.gstatic.com/firebasejs/11.0.1/firebase-app.js` / `firebase-firestore.js` (module names inferred from usage: `getFirestore`, `collection`, `doc`, `getDoc`, `getDocs`, `setDoc`, `updateDoc`, `deleteDoc`, `onSnapshot`, `query`, `where`, `orderBy`, `limit`, `serverTimestamp`) |
| Firebase Realtime Database | Accessed via plain `fetch()`/`PATCH` REST calls to `https://sleepy-5c962-default-rtdb.europe-west1.firebasedatabase.app` — **no RTDB SDK import**, unlike the Firestore usage |
| Cloudinary | `uploadToCloudinary(file, folder)` → `https://api.cloudinary.com/v1_1/dlkjizhya/auto/upload`, unsigned preset `maxela_uploads`, cloud name `dlkjizhya` |
| Google Fonts | `DM+Sans:wght@300;400;500;600`, `DM+Mono:wght@400;500`, `Playfair+Display:wght@400;500` (Playfair appears unused in read markup) |
| QRCode.js | `https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js` — lazy-loaded on demand inside `gsRenderElevatorQrPreview()` only when `typeof QRCode==='undefined'` |
| Local Tuya proxy | `http://localhost:3000` — required for `window.testTuyaDevice` to function; not reachable from any deployed/hosted instance of this admin panel |
| `admin-search-test.html` | Separate file opened in a new tab from the sidebar's "Search Debugger" link — not part of this SPA's own code |

No third-party analytics, error-tracking, or A/B-testing scripts were found in the read source.

---

## 8. WHAT WORKS WELL

- **The multi-room reservation matching cascade** (`_formById`/`_byGuestCheckin`/`_guestGroup`/`_siblingRes`/`groupByBaseNum`), while fragile and much-patched, is genuinely sophisticated — it correctly reconciles three different data shapes (per-room `reservations` docs, per-room-or-per-booking `checkin_guests` docs, and reservation-number suffix conventions) using four fallback strategies. This logic should be **preserved and extracted into a shared, testable module**, not rewritten from scratch.
- **Live `onSnapshot` reactivity** on the 5 core collections keeps Apartments/Guests/HK Pins in sync across admin sessions without manual refresh — good foundation to keep.
- **The elevator-code dual-write-with-timestamp-race** (`loadElevatorCode`) is a reasonable, already-debugged pattern for keeping RTDB (fast path for guest QR scans) and Firestore (source of truth) consistent.
- **Guest Page Settings' per-property visibility system** (`SECTION_DEFAULTS` × `gsVisibility[gsProp]`) is a clean, extensible toggle model — cleanly separates "what a property type shows by default" from "what's been explicitly overridden."
- **The room-fix inline controls in the multi-room drawer** (per-row `<select>` + "Fix" button, added most recently per git log) directly address a real support-workflow need — should be preserved and, ideally, generalized.
- **`esc()` consistently escaping `"`** within this file avoids the onclick-attribute quoting bugs seen elsewhere in the codebase — worth propagating this fixed version to the guest-facing files rather than the reverse.

## 9. WHAT WORKS BADLY — REBUILD TARGETS

- **Hardcoded plaintext admin password in client JS** (`_ADMIN_PWD='maxela2026'`) — no real authentication; must move to Firebase Auth or a server-checked token before any public exposure of this admin.
- **Three independent visual design systems in one file** (base `--*`, `--apt-*`, `--gs-*`) plus a fourth unstyled component set (`.go-*`, raw hex, no CSS custom properties at all) — a rebuild should unify onto one token system.
- **Three parallel drawer/modal implementations** (`.drawer`, `.gs-drawer`, inline `openAptDrawer`) and **two toggle-switch component classes** (`.switch`/`.slider` vs `.gs-toggle`) — pure duplication with no shared component.
- **`renderRequests()` and `_loadResCache()` are one-shot fetches, not listeners** — Requests and reservation data can go stale for an admin who leaves the tab open, unlike every other tab which is fully live.
- **`_loadResCache()` pulls up to 1000 unpaginated `reservations` docs on every fresh load** — a real scale ceiling as booking volume grows; needs pagination or a narrower date window per view.
- **`manualRoom:true` is nearly invisible** — set on `reservations` by two different functions but rendered in exactly one narrow drawer branch; an admin has no reliable way to see "this room was manually overridden" from the main Guests list.
- **`goSearch()`'s matching logic silently diverges from `renderGuests()`'s** (missing the cross-room-sharing pass) — produces incorrect "NO FORM" results specifically for multi-room bookings in search.
- **Stale WhatsApp/preview links point at the retired `checkin-guest.html` redirect page** (`resLookupSearch()`) instead of `checkin-guest-v2.html` or the sandbox in development — should be swept and repointed.
- **`window.testTuyaDevice` is dead code outside a developer's own machine** (hardcoded `localhost:3000` dependency) — either ship a real deployed proxy or remove the button from the production build.
- **One-off, hardcoded-name debug utilities left in shipped code** (`window.fixNasirMultiRoom`) — a rebuild should have no guest-specific logic in the general codebase; use a generic "relink reservation to form" admin action instead.
- **Three separate hardcoded room-code lists/mappings** (`APARTMENTS` here, `_roomLabel()` here, `APT_NAMES` in the guest-facing file, plus the retyped room-select `<option>` lists inside `viewGuest`) — should collapse to one shared source of truth, ideally driven by Firestore config rather than being baked into JS.
- **No pagination or virtualization anywhere** — Requests (100-doc cap), reservations (1000-doc cap) and Guests are all rendered as full in-memory arrays; will not scale gracefully as the property portfolio grows.
- **Desktop-only dense grid layouts** (`.go-row{grid-template-columns:60px 1fr 150px 130px 210px}`) with no evident mobile-specific breakpoint for the Guests/Requests tables — an admin trying to work from a phone will have a poor experience, unlike the guest-facing pages which are mobile-first.

---

*Generated from a full line-by-line read of `checkin-admin.html` (3429 lines), `git log --oneline -20 -- checkin-admin.html`, and a repo-wide grep for `TODO`/`FIXME`/`manualRoom`. No section is a paraphrase — every function, CSS variable, and Firestore field name above appears verbatim in the source at the time of this audit.*
