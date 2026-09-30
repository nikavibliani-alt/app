# Housekeeping (HK) upgrade plan

Owner: Nika. Live site: app.maxelaapartments.com. Firebase project: sleepy-5c962.
Hosting auto-deploys from main (.github/workflows/firebase-hosting-deploy.yml). Cloud Functions deploy manually only.
All dates are Tbilisi dates (UTC+4), format YYYY-MM-DD.

## Ground rules for every step
- Do ONLY the step you are asked to do. Then stop and report: what changed, where, and how Nika can test it on his phone.
- Never break what works today:
  - Done triggers the WhatsApp "room ready" message.
  - Done unlocks the guest check-in page.
  - The admin HK tab works.
  - Cleaners on the current /hk-app keep working until Step 4.
- Do NOT touch any of these:
  - whatsapp-functions/, whatsapp_*.py, the WhatsApp workflows
  - checkin-guest.html, checkin-guest-v2.html
  - pipeline-functions/, minihotel_* scripts
  - tuya files
- checkin-admin.html is Nika's control panel. Only its HK parts may change: the HK tab, "Housekeeping setup" (renderHkSettings) and the new Damage reports section.
- Edit live files directly. The sandbox files (checkin-admin-sandbox.html, checkin-guest-sandbox*.html) are dead, and the build scripts are disabled. Never regenerate a page from a sandbox.
- Pages are vanilla HTML/JS with the Firebase 11.0.1 modular SDK from gstatic, same as the existing pages. No new build step. No npm packages in pages.
- There is no Firebase Auth, and Firestore is open. Do not add auth or security rules in this project.
- Cleaners are mostly older staff. Their page needs big buttons, very few words, and nothing extra. Phone first.
- macOS is case-insensitive: HK.html and hk.html would collide. The new cleaner page is named cleaner.html (served at /cleaner).

## Current state (main @ 2ac276e, 30 Sep 2026)
**Cleaners**
- They open /hk-app, which is hk-app.html: a full copy of the admin panel running in "HK mode". It was generated from the sandbox and later edited by hand.
- Login is a PIN checked in the browser against the hk_pins collection. Every PIN is downloaded to the phone, and the login is remembered in localStorage.hk_role.
- It also downloads every checkin_guests doc (including passport URLs) and 365 days of reservations, and it contains the admin password.
- None of that is shown on screen, but it is all on the phone.

**Other HK pages**
- HK.html just redirects to hk-app.html.
- HK-Shartava.html and HK-Centre.html are old apps that are still deployed. They overwrite hk_status using setDoc without merge.
- HK-legacy.html and hk-manage.html are not deployed.

**checkin-admin.html**
- The HK tab has the board plus admin buttons: Edit times, Move day, Remove, Add room.
- "Housekeeping setup" (renderHkSettings) has, in order: Cleaner apps links, teams, standard times, clean minutes, bedding capacity, Staff PINs.
- The board logic lives here and can be reused: hkTaskRooms, hkGetCheckout, hkGetNextCheckin, hkBuildCard, hkSortScore, hkGetPriority, formatGuestArrival, hkGuestCount, hkGuestCountHtml, hkBeddingAlertHtml (shared/hk-bedding.js), hkSiteId, hkRoomsForTeam, hkGetTeams.
- The day range is HK_DAY_START=-1 to HK_DAY_END=6: yesterday plus 7 days.

**Sites** (shared/room-registry.js)
- shartava
- centre: orb-* and tab-*
- vgl
- abashidze

**Data**
- reservations: roomCode, checkin, checkout, status, checkoutTime, checkinTime, guest, guests, guestCount, adults, children, source, reservationNumber
- hk_status/{roomCode}_{date}: done, roomCode, date, updatedAt, manuallyAdded, checkOutTime, checkInTime, guestCount
- checkin_admin/config:
  - hkSettings { defaultCheckOut, defaultCheckIn, cleanMinutesByType, cleanMinutesByRoom, teams:[{id,label,roomCodes[]}] }
  - categoryCapacity
- checkin_rooms/{code}: site, displayName, showInHk, active, ...
- checkin_apartments/{code}: normalCapacity
- checkin_guests/{token}: aptId, arrivalDate, checkoutDate, expectedCheckInWindow, expectedCheckInTime, guests, guestConfirmedCheckout, name, nameRoman, matchedReservationId, manualUnlock, contactType
- hk_pins/{teamId|admin}: pin, updatedAt

## The "Done" contract (MUST stay equivalent)
This is copied from window.toggleHkDone in checkin-admin.html.
1. setDoc hk_status/{room}_{date} with { done, roomCode, date, updatedAt: serverTimestamp() }, merge:true.
2. Find nextRes: the first non-cancelled reservation for the room with checkin >= date. If there is one, write the same fields to hk_status/{room}_{nextRes.checkin}, merge:true.
   - WHY: whatsapp-functions roomReadyNotification fires when THIS doc's done flips to true. It sends the arriving guest the WhatsApp message.
   - whatsapp_checkin_ready.py also reads hk_status/{room}_{today}.
   - Removing this write breaks the room-ready message. Side effect: an already-Done card shows on the arrival day. That is known. Do not "fix" it by removing the write.
3. If marking done and nextRes.checkin === date: updateDoc every checkin_guests doc with aptId==room and arrivalDate==date (plus the matched form) to { manualUnlock:true, unlockedAt: serverTimestamp() }.

New fields are allowed only as additions: doneBy (staff name), doneByLinkId, doneAt.

## Nika's decisions (1 Oct 2026)
- Everything is controlled from checkin-admin.html. Admin does NOT need a cleaner link or PIN; admin uses the HK tab.
- There will be a new small cleaner page, rolled out smoothly. The old /hk-app keeps working until Step 4.
- Cleaners get unique links with no PIN or password. Each link belongs to a team, and admin can revoke it.
- Cleaners get only what they need: no passport data, no admin password, no PIN list.
- "Ready photos" when pressing Done are OPTIONAL and never required.
- Damage reporting is top priority. It is evidence for Airbnb claims: you have 14 days from the guest's checkout to file, and Airbnb wants original, timestamped photos. It needs trustworthy timestamps plus full room and guest info.
- Old HK pages and cleaner PINs are removed at the end, so everything is fresh and clean.

## Steps

### Step 0: Prep (done)
- Synced to main, disabled the build scripts, added this plan.

### Step 1: Fix "Move day"
Files: checkin-admin.html HK tab, plus a minimal matching change in hk-app.html, because cleaners use it until Step 4.
- **Bug:** hkMoveRoom copies the room to the new date. If the room has a real checkout on the old date, the old doc is kept. hkTaskRooms always lists rooms that have a checkout that day, so the room shows on BOTH days.
- **Fix:**
  - On move, merge { movedTo: toDate, movedAt } onto the old-day doc. Keep the existing delete when there is no real checkout.
  - Put { movedFrom: fromDate } on the new doc.
  - hkTaskRooms skips a room whose doc for that day has movedTo set.
  - Moving back to the original day clears movedTo there.
  - Tab counts must match.
- Do NOT change toggleHkDone or anything done/WhatsApp related.
- In hk-app.html, change only hkTaskRooms (the same skip rule).

### Step 1b (done)
- The admin HK card now has ONE "Edit" button (was Edit times / Move day / Remove). It opens the bottom sheet `#hk-admin-modal`, titled "<room> · <day>".
- Sheet contents: Next guest (guests − / +, check-in time; only if the card has a next reservation), Checkout time, "Reset to automatic", Save, "Move to another day" chips (calls `hkMoveRoom` unchanged), and "Remove from schedule".
- Remove: a manually added room (no real checkout) has its hk_status doc deleted. A room with a real checkout gets `removed:true, removedAt` merged onto its doc.
- "+ Add room to this day" clears `removed` / `movedTo` (deleteField) so a removed room can be brought back.
- New hk_status fields: `removed` (bool), `removedAt` (timestamp), `arrivingGuestCount` (number, overrides the arriving-guest count only; the leaving count still uses `guestCount`). Existing Step 1 fields: `movedTo`, `movedAt`, `movedFrom`.
- Reset to automatic removes `checkInTime`, `checkOutTime` and `arrivingGuestCount`.
- Board rules: `hkTaskRooms` skips a room whose doc for that day has `movedTo` or `removed === true`. Arriving guests = `hkGuestCount(nextRes, form, st.arrivingGuestCount)`.
- hk-app.html got only the same two changes (the skip rule and the arriving count).

### Step 2: Staff links + new cleaner page (cleaner.html → /cleaner)
- **Admin side** (checkin-admin.html, Housekeeping setup):
  - Replace the "Cleaner apps" section with a "Staff links" section.
  - The list shows: name, team, created, last opened, and Active/Revoked.
  - "+ New link" asks for a name and a team. It creates hk_staff_links/{token} with { name, teamId, active:true, createdAt, lastSeenAt:null, revokedAt:null }.
    - The token is 32 hex characters from crypto.getRandomValues.
    - The link is https://app.maxelaapartments.com/cleaner?s=TOKEN
  - Buttons: Copy, Send on WhatsApp (wa.me/?text=...), Revoke (sets active:false and revokedAt). Keep revoked records.
- **Cleaner page:**
  - It takes the token from ?s= and saves it to localStorage.hk_staff_token, so the home-screen icon keeps working.
  - Validate with getDoc(hk_staff_links/{token}) on every open and on visibilitychange. If the doc is missing or inactive, show a full-screen "This link is no longer active. Ask your manager for a new link." and clear the saved token.
  - Update lastSeenAt at most once every 10 minutes.
  - Show the same board as the admin HK tab, limited to the link's team rooms: day tabs, card colours, times, guest counts, bedding alert, sort order and the movedTo rule.
  - The board must honour `movedTo`, `removed` and `arrivingGuestCount` (see Step 1 and Step 1b).
  - No admin buttons and no source badges.
- **Loads only what the board needs:**
  - checkin_admin/config (hkSettings, categoryCapacity)
  - checkin_rooms
  - normalCapacity for team rooms (per-room getDoc)
  - reservations with checkout >= yesterday
  - checkin_guests in a narrow date window (arrivalDate from yesterday to +30 days, checkoutDate from yesterday to +7 days)
  - hk_status with date >= yesterday (live)
  - Keep only the needed fields in memory.
- **Never loaded or run:**
  - hk_pins, the admin password, full-collection guest listeners
  - syncRoomsFromSeed writes
  - the elevator and search_failures listeners
- The Done button follows the Done contract exactly, plus doneBy, doneByLinkId and doneAt. Undo works the same as today.
- /hk-app, PINs and the old pages stay untouched in this step.
- **Before building UI text:** ask Nika which language to use for the cleaner page (English, Georgian, or both with a toggle).
- **Test with Nika:**
  - Make a link for a test team with one room.
  - Open it on a phone and mark Done.
  - Check both hk_status docs, manualUnlock, and that the WhatsApp message arrives.
  - Revoke the link and check it shows the "no longer active" screen.

### Step 2 (done)
- Admin: Housekeeping setup → "Staff links" (checkin-admin.html) replaces "Cleaner apps". Collection `hk_staff_links/{token}` = { name, teamId, active, createdAt, lastSeenAt, revokedAt }. Token = 32 hex chars. Link format: `https://app.maxelaapartments.com/cleaner?s=TOKEN`. Revoked links stay in the list.
- Cleaner page: `cleaner.html`, served at `/cleaner` by `cleanUrls` (no rewrite needed). Georgian by default with an EN / ქარ switch (saved in `localStorage.hk_lang`). All text lives in the `STR` object at the top of the script. The token is kept in the URL and also saved to `localStorage.hk_staff_token` as a fallback. The link is re-checked on open and on every visibilitychange; `lastSeenAt` is updated at most once per 10 minutes.
- The board logic is a labelled copy of the admin code (`BOARD-LOGIC-START/END` in cleaner.html, copied from checkin-admin.html @ ab270e9). If the board logic changes in admin, update the copy too.
- Done button follows the Done contract exactly, plus `doneBy`, `doneByLinkId`, `doneAt` on the checkout-day doc. Undo sets those three to null.
- Safety check: `node scripts/check-cleaner-page.js` fails if cleaner.html contains admin-only code or writes outside `hk_status`, `checkin_guests`, `hk_staff_links`. **Step 3 must extend `ALLOWED_WRITE_COLLECTIONS` in that script for damage reports (`hk_damage_reports`, and Storage uploads).** Run it before every cleaner.html commit.

### Step 3c (done): evidence document fixes after the real test
- Finding: iPhone gallery photos reach the browser as `image.jpg` with no EXIF date, so the camera time is often missing. The trustworthy times are Google's server times. They are public: `GET https://firebasestorage.googleapis.com/v0/b/sleepy-5c962.firebasestorage.app/o/<URL-encoded path>` returns Google's JSON (timeCreated, md5Hash, generation, size) with no login (works because the Storage rule allows read).
- Evidence document now: asks for Property name / Signatory name / Signatory title (property name remembered per group from `hkPropertyGroupForRoom` in `checkin_admin/config.docPropertyNames {GROUP: name}`; signatory in `docSignatory {name, title}`; all required). Header, statements and the "Issued by <name>, <title>, <property>" block use them.
- "Reported by" is "Housekeeping staff" (cleaner name stays in the admin detail sheet only). fileLastModified and the phone time are never shown in the document.
- Per photo (report photos and ready photos): Google server upload time (Tbilisi + UTC), MD5 fingerprint computed by Google, size, a "Verify on Google" link and a QR code of that same URL (local `shared/qrcode.min.js`). "Photo taken (camera time)" only when EXIF exists. If `getMetadata()` fails the stored `storageTimeCreated` is shown marked "(stored at upload)"; nothing is invented.
- A "How to verify" box sits near the top. "Before this stay" appears only when ready photos exist.
- Admin detail sheet: under each photo "Uploaded (server): …" and "Verify on Google"; "Taken" only with EXIF; no "unknown" text.

### Step 3b (done): requests after Nika's testing
- Cleaner page: no photo limit (uploads still one at a time with per-photo progress); "გალერეიდან" renamed "ატვირთე" / "Upload" (still the untouched original file); new first chip "სიგარეტის სუნი" / "Cigarette smell"; tags stay optional (photos-only reports allowed); send button black with white text.
- Per-link switch: `hk_staff_links/{token}.canReportDamage` (missing = allowed; set in admin Staff links, default ON for new links). The cleaner page hides the damage button when it is `false` and re-reads it on every visibilitychange. The ready-photos link is unchanged.
- Admin: "Damage reports" is a top-level item in More (Operations) and in the tab-bar settings pool; the HK toolbar "Damage (N)" button stays. `/checkin-admin?tab=damage` opens the damage tab (used by the notification tap; `sw.js` also navigates an already-open admin window when the notification URL has `?tab=`).
- Admin can correct a report ("Edit": chips incl. Cigarette smell + description). First edit copies the cleaner's text into `original {categories, description}` (never overwritten), every save is logged in `adminEdits[] {at, categories, description}`, a "Cleaner's original" line shows only if different, and the evidence document uses the current (corrected) values. Each photo has "Open original" (new tab) so it can be saved and uploaded to Airbnb.
- Notification: `pushOnDamageReport` (pipeline-functions/controllers/pushNotifications.js, exported in index.js), trigger `hk_damage_reports/{id}` created, europe-west1, same VAPID secrets. Title "⚠ Damage: <room>" ("URGENT · " prefix when urgent), body "<cleaner> · <n> photos · <tags or 'no tags'>", url `/checkin-admin?tab=damage`, tag `damage-<id>`. Deploy only this function: `firebase deploy --only functions:pipeline:pushOnDamageReport --project sleepy-5c962`.
- Storage rule photo limit is 50 MB (as published).

### Step 4 (done, ran BEFORE Step 3)
- Order changed: Step 4 was done before Step 3 because every cleaner already had a staff link and old access had to be cut.
- firebase.json: 301 redirects to `/cleaner` for /hk-app, /HK, /HK-Shartava, /HK-Centre, /HK-legacy, /hk-manage (with and without `.html`). The /hk-app rewrite was removed.
- Deleted: hk-app.html, HK.html, HK-Shartava.html, HK-Centre.html, HK-legacy.html, hk-manage.html.
- checkin-admin.html: `?app=hk` or an HK*.html path now redirects to `/cleaner` (first inline script). The rest of the old HK-mode/PIN code is dead and unreachable; remove it in a later cleanup. "Staff PINs" section and renderHkPins / saveHkPin removed. `hk_pins` docs remain in Firestore, unused.
- scripts/health-monitor.js no longer checks hk_pins.
- CODEBASE.md and docs/AGENT_HANDOFF.md HK entries updated.

### Step 3: Damage reports (+ optional ready photos)
**Cleaner page**
- Put a large "Report damage" button on every card, including done and yesterday cards.
- The form has:
  - the room, filled in automatically
  - "What is damaged" (text, required)
  - an "Urgent" switch
  - 1–10 photos: <input type=file accept="image/*" capture="environment" multiple>
- Upload ORIGINAL files. Do not compress or resize them; that keeps the photo's time data.
- Before upload, read for each photo: EXIF DateTimeOriginal (with a tiny parser, no library), file.lastModified, size, type and name.
- Storage path: hk_damage/{reportId}/{n}.{ext}
- Show upload progress. Retry on bad connection, and never lose the draft.
- Once sent, the cleaner cannot edit or delete it, only add more photos (each with its own timestamps).

**Firestore doc** hk_damage_reports/{reportId}
- roomCode, roomName, site, reportDate
- createdAt: serverTimestamp()
- clientCreatedAt
- reportedBy { name, linkId }
- description, urgent
- photos[{ url, path, contentType, size, exifTakenAt, fileLastModified, uploadedAt }]
- guest snapshot: the departing reservation (checkout === reportDate, or else the most recent checkout <= reportDate): { reservationId, reservationNumber, guestName, source, checkin, checkout, guestCount }
- roomDoneAt
- status: 'open'
- claim { platform, filedAt, deadline = guest checkout + 14 days }
- adminNotes[]

**Ready photos** (optional)
- After Done, show a small "Add ready photos" button.
- Upload to Storage hk_ready/{room}_{date}/...
- Add them to the hk_status doc with arrayUnion on readyPhotos, never touching done. The WhatsApp trigger only fires when done flips false → true.

**Admin side** (checkin-admin.html)
- A "Damage reports" screen, opened from an HK tab button that shows the open count, and also from the More menu.
- Newest first, with an Open/All filter.
- Each report shows: room, date, cleaner, guest, platform, and "days left to claim" (red at 3 or fewer).
- Photos show in a grid; tapping one opens it full size with its taken time.
- Actions: "Claim filed" (platform and date), "Resolved", add a note.
- "Evidence document" produces a printable, save-as-PDF record, following the existing generateGuestDoc / record modal pattern. It includes:
  - report ID, property and room
  - guest and reservation, stay dates
  - cleaner and server report time
  - each photo large, with its taken time and upload time
  - the time the room was marked done
  - ready photos from before that guest's stay, if any
- **Storage rules:** give Nika an exact snippet to paste in the Firebase Console:
  - allow create on hk_damage/** and hk_ready/** for image/* under 50 MB
  - allow read
  - no update or delete
  - keep the existing passport_uploads rule unchanged

### Housekeeping setup menu (done)
- checkin-admin.html → More → HK settings is now a short menu with 4 rows and live one-line summaries: Staff links ("N active"), Teams & apartments ("N teams"), Times & cleaning ("Checkout hh:mm · Check-in hh:mm"), Bedding capacity ("N groups set"). Each row opens its own sub-screen with "‹ Back".
- Times & cleaning = standard times + cleaning duration + per-room overrides, with the existing "Save HK settings" button (`saveHkSettings`). Teams keep their own Create/Save team. Bedding capacity still saves automatically as you type (no Save button, noted on screen). Staff links act immediately.
- The open sub-screen is remembered (`localStorage.maxela_hk_settings_section`); the phone Back gesture/button and the header back arrow return to the menu first. Coming from another tab always starts at the menu.
- Layout only: no data or behaviour changed. Stale wording about PINs removed from the Teams screen.

### STATUS: Damage reporting hidden (HK_DAMAGE_ENABLED=false in cleaner.html and checkin-admin.html). Cleaners send photos via WhatsApp for now.
- Hidden when false: cleaner damage button, "damage reported" badges, the ready-photos link and the `hk_damage_reports` listener (cleaner page); the HK toolbar "Damage (N)" button, the More menu item, the tab-bar pool entry, the Staff links "Damage reports" switches, the `?tab=damage` deep link (falls back to the HK tab) and the listener (admin).
- Kept untouched: all the code, `hk_damage_reports` documents, Storage files and rules, and the `pushOnDamageReport` function (it only fires on new reports). To bring it back, set the constant to `true` in both files.
- **Future ideas:** damage reports in the app, evidence document, independent (Google) timestamps, before/after timeline, share link, ready photos.

### Step 3 (done; ran AFTER Step 4)
- **Cleaner page (cleaner.html):** "Report damage" button on every card, full-screen sheet (photo / gallery, type chips, optional text, Urgent). After Done, an optional "Add photos of ready room" link. Photos are uploaded as the ORIGINAL file (no canvas, no resize). Cleaners can only create a report and add photos; they cannot edit text or delete anything.
- **Admin (checkin-admin.html):** "Damage (N)" button in the HK tab toolbar + More → Housekeeping setup → Damage reports. List with Open / Claim filed / All, detail sheet, actions (Claim filed, Resolved, Closed – no claim, Add note, Add photos, Reopen) and an "Evidence document" (printable, save as PDF).
- **Shared code:** `shared/hk-damage.js` (EXIF reader, upload helper, report id, guest pick, deadline math).
- **Firestore `hk_damage_reports/{reportId}`** (id = `DMG-YYYYMMDD-room-XXXX`): roomCode, roomName, site, reportDate, createdAt (server), clientCreatedAt (ISO +04:00), reportedBy {name, linkId}, categories[], description, urgent, photos[], photoCount, guest {reservationDocId, reservationNumber, guestName, source, checkin, checkout, guestCount, guestFormId} or null, roomDoneAt, doneBeforeReport, status ('open' | 'claim_filed' | 'resolved' | 'closed'), plus admin-written claim {platform, filedAt, caseNumber, deadline}, resolution {amount, resolvedAt}, closedAt, adminNotes[] {text, at, by}, updatedAt.
- **Photo record:** {url, path, contentType, size, name, exifTakenAt, fileLastModified, storageTimeCreated, addedBy ('cleaner' | 'admin'), addedAtClient, addedByName?}. `exifTakenAt` is the camera's clock (has a +04:00 style offset only if the phone recorded one).
- **Storage paths:** `hk_damage/{reportId}/{n}.{ext}` (initial photos; later additions `{n}-{rand}.{ext}`), `hk_ready/{room}_{date}/{n}-{rand}.{ext}`. Ready photos are also listed in `hk_status/{room}_{date}.readyPhotos` via arrayUnion (the `done` field is never touched).
- **Airbnb deadline:** guest checkout + 14 days, shown only for Airbnb bookings.
- **`scripts/check-cleaner-page.js`** now also allows `hk_damage_reports` (setDoc + updateDoc only) and forbids `passport_uploads`, `deleteObject`, `uploadBytes(`.
- **Storage rules: add this block INSIDE the existing `match /b/{bucket}/o { ... }`, next to the passport_uploads rule (paste in the Firebase Console; do NOT run `firebase deploy --only storage`):**

```
    match /hk_damage/{reportId}/{file} {
      allow read: if true;
      allow create: if request.resource.size < 50 * 1024 * 1024
                    && request.resource.contentType.matches('image/.*');
      allow update, delete: if false;
    }
    match /hk_ready/{folder}/{file} {
      allow read: if true;
      allow create: if request.resource.size < 50 * 1024 * 1024
                    && request.resource.contentType.matches('image/.*');
      allow update, delete: if false;
    }
```
- Console steps: Firebase Console → project sleepy-5c962 → Build → Storage → **Rules** tab → paste the block inside `match /b/{bucket}/o { ... }` (leave the passport_uploads rule as is) → **Publish**.

### Step 4: Switch-over and cleanup (only after all cleaners use links)
- /hk-app, /HK and HK.html redirect to /cleaner. With no token it shows "ask your manager for your link".
- Delete hk-app.html, HK-Shartava.html, HK-Centre.html, HK-legacy.html and hk-manage.html.
- Remove the Staff PINs section and the Cleaner apps links from Housekeeping setup.
- Update scripts/health-monitor.js so it stops checking hk_pins.
- Update the HK sections of CODEBASE.md and docs/AGENT_HANDOFF.md.

### Later (NOT in this project unless Nika asks)
- A slim "board copy" built by a Cloud Function, so cleaner phones never receive guest records at all.
- Real sign-in and Firestore/Storage rules.
- Rotate the exposed secrets: tuya-proxy.js, housekeeper_sync.py, and the admin password in the HTML.
- Push notification to admin when a damage report comes in.
