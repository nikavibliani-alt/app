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
