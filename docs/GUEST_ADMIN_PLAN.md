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
