# Guest admin redesign (overnight plan)

**Goal:** make the admin Stay tab and the guest/apartment screens easier to understand (mobile-first), without changing data logic or what is saved.

Restore point: git tag `before-guest-redesign`.

## Steps
1. Confirm before door-access changes (status badge tap)
2. Apartment editor keeps typed text on photo actions + "Discard unsaved changes?"
3. Remove Search debugger
4. Plain status names + "Door code" label
5. Redesign Stay tab
6. One place for Apartments + Guest page

## Progress log
| Step | Commit | Status |
|------|--------|--------|
| 0 | tag before-guest-redesign | done |

## HOW TO UNDO
- Undo everything: `git revert --no-edit before-guest-redesign..HEAD` (only this redesign's commits), then push to main.
- Undo one step: `git revert --no-edit <that step's commit>`, then push to main.
| 1 | 4270a59 | live, checked |
| 2 | 3202b58 | live, checked |
| 3 | 59785d1 | live, checked |
| 4 | 3222d65 | live, checked |
| 5 | fdde605 | live, checked |
| 6 | 33d59a1 | live, checked |

All six steps are live. Final check: `npm run check:unlock` passes.

Notes:
- Step 5: "Waiting for unlock" sits on its own wide line above the four other counts (one grouped block), not literally one row, so the label stays readable on a phone.
- Step 5: the Preview button moved off the card; it is still in the guest Details screen ("Preview guest page"). MULTI / MANUAL badges, phone and booking number are also in Details.
- Step 5: status colors — waiting = amber, has access = green, checked in = blue, access off = red, not registered = grey.
- Step 6: Tab-bar ids 'apts' and 'guestsettings' are unchanged, so saved layouts still work.
- Step 1/2/3/4 test notes: on localhost the app talks to the real database but the admin functions emulator is not running, so writes could not happen; step 2 was tested on a copy with writes stubbed.

# Round 2

Restore point: tag `before-round-2`.

1. Design rules file (CLAUDE.md)
2. Remove blue
3. Replace emojis and symbol buttons with icons
4. Per-apartment "has a smart lock" switch
5. Stay: always-visible day strip

Undo all: `git revert --no-edit before-round-2..HEAD`, then push. Undo one step: `git revert --no-edit <commit>`, then push.

| Step | Commit | Status |
|------|--------|--------|
| 0 | tag before-round-2 | done |
| 1 | bf295a1 | live |
| 2 | c31cec7 | live |
| 3 | 0cffb7c | live |
| 4 | 163a05f | live |
| 5 | 94d29a6 | live |

Round 2 notes:
- Step 2: WebKit on desktop does not reproduce iPhone's system-blue button text; fixed by a global `button{color:inherit}` plus removing blue colors; verified by computed-color scan (no blue left outside HK). Left alone: .hk-cleaner-link, .hk-role-badge (use --blue), damage lightbox link #9cf.
- Step 3 left for HK/WhatsApp/elevator chats: HK PIN pad glyphs, HK/damage toasts and arrows, WhatsApp settings toasts/hint, elevator toast, "Guest page saved ✓" (inside gsSaveAll, untouched).
- Step 5: a day with 0 arrivals was not present in live data, so that look was checked in code only.

# Round 3

Restore point: tag `before-round-3`.

1. Guest settings Save no longer writes hkSettings
2. Door code switch per apartment type (gsVisibility[group].smartLock), not per unit
3. Stay: compact calendar strip (Yesterday, Today, next 7 days)
4. Stay search also finds past guests

Undo all: `git revert --no-edit before-round-3..HEAD`, then push. Undo one step: `git revert --no-edit <commit>`, then push.

| Step | Commit | Status |
|------|--------|--------|
| 0 | tag before-round-3 | done |
| 1 | 92e6b53 | live |
| 2 | e9f4bdc | live (no unit had hasSmartLock set) |
| 3 | 2e2a989 | live |
| 4 | 688ff79 | live |

Round 3 notes:
- Step 2: read-only check of checkin_apartments found no unit with hasSmartLock set (0 of 23), so nothing was ever switched off per unit. Old field left in Firestore untouched; no longer read or written.
- Step 4: past guests come from Guest history's data, which covers the last 3 months of finished stays only.

# Round 4

Restore point: tag `before-round-4`.

1. Investigate/fix: guest not unlocked while admin showed access (tab-2, 2026-10-01)
2. Stay cards: badge is a label, card opens Details, access button (Give/Remove access)
3. Search shows only results + clear (X) button
4. Day strip counts registered forms, not missing ones

Undo all: `git revert --no-edit before-round-4..HEAD`, then push. Undo one step: `git revert --no-edit <commit>`, then push.

| Step | Commit | Status |
|------|--------|--------|
| 0 | tag before-round-4 | done |
| 1 | 6ec1fdd | live — root cause: hero phase not re-derived after HK fetch |
| 2 | 36abd74 | live |
| 3 | 7d12f5d | live |
| 4 | 2e32935 | live |

Round 4 notes:
- Step 1 root cause: on the guest page the "hero" (waiting vs instructions) was decided once when home opened and on guest-document changes, but not again when the HK status arrived a moment later (or when 15:00 passed). Tiles unlocked, hero stayed "waiting" until reload. Fixed in checkin-guest.html (syncHomePhase on HK fetch + 30s tick, HK data kept per room, HK re-fetched whenever home opens). Shared unlock rules untouched. Real data for tab-2 on 2026-10-01: HK done 09:34Z, guest registered 09:42Z, server stored unlockReason hk_early, so rules agreed; only the page display was stale.
- Step 2: toggleGuestAccess now decides from the underlying access state (so "Remove access" works for guests who already checked in) and accepts an optional 'on' argument for "Give access".

# Round 5

Restore point: tag `before-round-5`.

1. "Remove access" asks how long (bottom sheet) and actually works after 15:00

Undo: `git revert --no-edit <commit>` (or `before-round-5..HEAD`), then push.
| 1 | a7c00a6 | live |

# Hotel Collect alerts

Restore point: tag `before-hotel-collect`.

1. Admin page: badge on Stay cards, banner of bookings to check, review buttons (verified / fake / undo), reservation-only details, deep link `?hc=<reservationNumber>`
2. Cloud Function `pushOnHotelCollect` (push + WhatsApp to owner when a new Hotel Collect booking arrives)

Undo admin: `git revert --no-edit <commit>`, then push. Undo cloud function: `firebase functions:delete pushOnHotelCollect --region europe-west1 --project sleepy-5c962`.
| Hotel Collect 1 (admin) | 2724769 | live |
| Hotel Collect 2 (function pushOnHotelCollect) | 53ef99d | deployed (only this function) |

Notes:
- Incident during step 1: a stale git index lock led to a commit that deleted every file; the site was never redeployed from it. Fixed with a restore commit (tree identical to before), then step 1 recommitted. Revert ranges therefore contain that delete/restore pair; harmless.
- Function reads ownerPhone from globals/config and uses secrets META_ACCESS_TOKEN / META_PHONE_NUMBER_ID (granted accessor to the default compute service account by the deploy). New collection hc_alerts/{reservationNumber} (one doc per alerted booking).
- Review writes (hcReview on reservations) were tested with mocked writes only; not exercised against real Firestore rules.

# XCV apartments

Restore point: tag `before-xcv`.

1. XCV as a building (room-registry site + seed, admin HK site lists)
2. Create checkin_rooms/xcv-1, xcv-2 and checkin_apartments/xcv-1, xcv-2
3. Confirm XCV bookings arrive from the MiniHotel sync

Undo: `git revert --no-edit <commit>`, then push. Firestore: delete the 4 docs (checkin_rooms/xcv-1, xcv-2; checkin_apartments/xcv-1, xcv-2).
| 1 | 8119c1b | live |
| 2 | (same run) | checkin_rooms/xcv-1, xcv-2 and checkin_apartments/xcv-1, xcv-2 were created automatically by the admin seed sync on first load (exactly these 4 docs) |
| 3 | - | XCV bookings arrived: xcv-1 x2 docs, xcv-2 x3 docs (4 bookings; 007005372 is a 2-room booking). Names XCV_1 / XCV_2 matched. |

Notes:
- cleaner.html changes (belongs to HK chat): added {id:'xcv',title:'XCV'} to HK_SITES_ALL, an xcv- fallback in hkSiteId, and an XCV Team label in defaultTeams. Nothing else. check-cleaner-page.js passes.
- XCV rooms are not in any HK team yet, so they will not appear on the HK board until added in HK settings.

# Search fix

Restore point: tag `before-search-fix`.

1. Booking number in the Name field = OTA confirmation number (bookingId) only; exact match searches all rooms
2. Help text after a failed search (4 languages) + input_apt saved in search_failures
3. Short names (0 or 1 word of 3+ letters): match by initials/words + exact date + only candidate

Undo: `git revert --no-edit <commit>`, then push.
| 1 | 7d19d30 | live |
| 2 | ee2b088 | live |
| 3 | 7f4ab74 | live |

Notes:
- searchReservation() resets aptId to '' on every search, so the old "apartment link limits the search to that room" branch never ran; searches were always global (last 2 months, 500 rows). input_apt therefore reads the ?apt= URL parameter.
- Of 86 current/upcoming reservations (checkout >= 2026-10-04), 42 have no bookingId: 35 Airbnb, 7 direct. Those can only use the name search.
- 5 bookings (incl. test blocker "Reserved") changed result with step 3; all were previously unfindable by their own name. No same-day collisions among short-name bookings; two identical short names the same day are refused on purpose.
- Guest app version 1.1.4 -> 1.1.7 (one bump per step).

# Room-ready fix (emergency 2026-10-04)

Restore point: tag `before-room-ready-fix`. Undo: `git revert --no-edit 4b55292`, then redeploy the two functions (`firebase deploy --only functions:whatsapp:roomReadyNotification,functions:pipeline:pushOnHkDone --project sleepy-5c962`).
Cause: cleaner staff link (Shartava) tapped Done on 0-1 on the 10 Oct day tab at 07:51Z; the guest arriving 10 Oct got the room_ready WhatsApp 3 s later and a push "0-1 is ready"; toggleHkDone also set manualUnlock:true on that guest's checkin_guests doc.
Fix: roomReadyNotification only sends when hk_status.date == today (Tbilisi); pushOnHkDone skips future-dated docs. Deployed only these two functions. whatsapp-functions is owned by the WhatsApp chat.

# Location fix

Restore point: tag `before-location-fix`.

1. Per-apartment location (propertyName, address, mapsUrl, neighborhood, floorLabel) edited in the Apartments editor; guest page uses apartment value, then property-group setting, then old default
2. VGL and XCV property groups in Guest page settings + guest page room-to-group mapping

Undo: `git revert --no-edit <commit>`, then push.
| 1 | edbd153 | live |
| 2 | c270092 | live |

Notes:
- Location resolution order on the guest page: apartment (checkin_apartments propertyName/address/mapsUrl/neighborhood/floorLabel) > property group (locationInfo) > old default.
- New groups VGL and XCV copy FREEDOM visibility + parking defaults; location and room-category defaults are empty. Entrance-card rule and shuttle pickup text still use the old fixed lists for other groups.

# Brand fix (follow-up to location fix)

Restore point: tag `before-brand-fix`. Commit 43b29b6. Undo: `git revert --no-edit 43b29b6`, then push (the two propertyName values written to checkin_admin/config.locationInfo.XCV/VGL are harmless; remove by hand if wanted).
Guest-facing name order: apartment propertyName > group locationInfo[group].propertyName > "Maxela Apartments"; plain link before a booking is found shows "Online check-in". Defaults written: XCV "Modern Avlabari", VGL "VGL Group".

# Audit S1 (safety fixes)

Restore point: tag `before-s1`. Undo one step: `git revert --no-edit <commit>`, then push (server function steps: redeploy that function after the revert).

1. Preview links never show real codes
2. Share-with-group link uses a random companionToken (?join=)
3. End of stay: cancelled booking / stay ended while open / no fallback to another reservation
4. Use the booking's own check-in/check-out dates once linked
5. Admin "Grant Access" hidden before arrival day
6. Group-member and extra-room guest docs get random token ids; ?g= must look like a token
7. Privacy wording on the passport/search pages (4 languages)
| 1 | fcbb223 | live: preview links show placeholders only |
| 2 | 39dc295 | live: ?join=<companionToken> |
| 3 | e666c68 | live: cancelled / stay ended / own booking only (shared unlock rules + tests; server lib only gained optional inputs, behaviour unchanged, not redeployed) |
| 4 | 6bad26b | live: booking dates |
| 5 | d9910c7 | live: admin Grant Access hidden before arrival day |
| 6 | 4c6d9a3 | live; function guestRegister redeployed (only that one; function list unchanged) |
| 7 | ae082df | live: privacy wording |

Notes (S1):
- Old companion docs with ids like <room>_<date> can no longer be opened with ?g=; saved sessions in a browser still load them.
- A GitHub Actions hosting run for step 6 sat queued; the step 7 run deployed everything.
