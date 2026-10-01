# Maxela SleepyPMS — Project archive

**Purpose:** Save everything done in the Cursor + Claude Code sessions so you can reuse decisions, architecture, and lessons in future projects.

**Repo:** https://github.com/nikavibliani-alt/app  
**Firebase:** sleepy-5c962  
**Last updated:** 2026-08-31

---

## What this system is

A guest check-in + property management stack for Maxela Apartments (Tbilisi):

- **Guest check-in** — online registration, passport, WiFi/door codes, unlock gate by arrival/HK time
- **Admin** — stay overview, grant access, room moves/swaps, apartment content, elevator code
- **Housekeeping (HK)** — daily checkout board, done toggles, early unlock trigger
- **Backend pipeline** — small Cloud Functions, one writer per fact, full audit logs
- **MiniHotel sync** — reservations from calendar API → Firestore

---

## Architecture decisions (locked)

1. **One Firestore** — no `v2_*` parallel collections
2. **One writer per fact** — room moves only via RoomAssignment; unlock via GuestUnlock
3. **Conflict policy** — block overlapping stays; explicit swap only; no displace
4. **Stable guest tokens** — primary guests use 32-hex `guestToken` doc IDs; companions use `{room}_{date}`
5. **Sandbox first** — all pipeline work wired to sandboxes before live HTML cutover
6. **Room registry moving to Firestore** — `checkin_rooms` + `shared/room-registry.js` as code default
7. **Tbilisi time UTC+4** — no DST; used for unlock and HK dates

Docs: `MASTER_ARCHITECTURE_CURSOR.md`, `PIPELINE_DESIGN_CURSOR.md`, `BACKEND_MAP.md`

---

## Timeline of major work

### Guest check-in frontend (2026-08, owner-approved)

- `checkin-guest-sandbox-2.html` — main redesign (Playfair/Inter, registration flow)
- `checkin-guest-sandbox-3.html` — portal variant
- Tabler icons, shuttle/tours, companion form (name+date only), reg time rules
- Owner quote: guest flow **"perfect from start to bottom"**
- **Not wired** to live `checkin-guest-v2.html` yet

### Admin sandbox (2026-08)

- Typography, HK tab, apartment editor, WhatsApp templates, nav/tab bar settings
- **Room swap UI** — occupied target → Swap button + preview
- **Live reservations** — `onSnapshot` + refresh after move/swap (fixed stale unlock after ~10 swaps)
- **HK guest count + bedding** — from MiniHotel `guestCount`, per-room rules in `shared/hk-bedding.js`
- **Pipeline wiring** — move, swap, unlock, release via AdminAction

### Backend pipeline (2026-08)

| Phase | Status |
|-------|--------|
| Elevator guard + sync | ✅ Deployed |
| RoomAssignment (move/swap/release) | Built, not deployed |
| GuestUnlock | Built, not deployed |
| GuestRegister (stable tokens) | Built, not deployed |
| AdminAction orchestration | Built, not deployed |

**Tests:** 54/54 unit tests (as of system-ready branch)  
**CI:** GitHub Actions on pipeline-functions changes

### Claude Code review (2026-08-30)

- Verified 53/53 tests, unlock sync, live files untouched
- Approved architecture; noted unlock partial-failure surfacing + manualRoom UI gaps
- Manual E2E waived by owner — room switch validated in real use

### System-ready pass (2026-08-30)

- **`shared/room-registry.js`** — single place to add apartments
- **Auto-sync missing rooms** to Firestore (fixes VGL not appearing if seeded early)
- **VGL HK bedding rules** added
- **manualRoom badge** + release to MiniHotel in admin sandbox
- **Unlock warnings** surfaced after move/swap
- **Elevator save** — Firestore before RTDB
- **Docs:** `BACKEND_MAP.md`, `docs/ADD_APARTMENT_GUIDE.md`, this file

### Sandbox complete on main (2026-08-31)

- Host sign-off: **sandbox works fine** on GitHub Pages
- Merged: full UI polish, admin login fix, shuttle service + plane icon, HK teams + apartment allocation
- Live guest/admin HTML **still not cutover**
- Backend callables still **not deployed** (optional; sandbox has fallbacks)

---

## Why VGL HK “didn’t work” (diagnosis)

| Cause | Fix |
|-------|-----|
| Used `HK-Shartava.html` (no VGL rooms) | Use `HK.html` or admin sandbox HK tab |
| `checkin_rooms` seeded before VGL added | Open admin sandbox → auto-sync adds missing rooms |
| No `hk_pins/vgl` PIN | Set in admin sandbox HK settings |
| `import-reservations.html` skips VGL | Use MiniHotel sync, not sheet import |
| Production `checkin-admin.html` has no VGL in hardcoded list | Use sandbox for VGL content until live cutover |

---

## Open PRs (Aug 2026)

| PR | Branch | Topic |
|----|--------|-------|
| — | `main` | Sandbox signed off 2026-08-31; see `CLAUDE_CODE_REPORT.md` |

*(Older PRs #26–#30 may be merged or superseded — check GitHub for current open PRs.)*

---

## Branches naming

Pattern: `cursor/<description>-7e07`

---

## How to run locally

```bash
# Static server
cd ~/app && npx serve -p 8080 .

# Pipeline emulator (optional — for move/swap/unlock without deploy)
cd ~/app/pipeline-functions
npm install && npm test
npm run emulator:setup && npm run emulator:lite

# Admin sandbox
http://127.0.0.1:8080/checkin-admin-sandbox.html?emulator=1
```

---

## Deploy checklist (when ready)

1. Owner satisfied with sandbox (E2E optional per Aug 2026 decision)
2. `firebase functions:secrets:set ADMIN_ACTION_PASSWORD`
3. `firebase deploy --only functions:pipeline:adminAction,functions:pipeline:guestRegister`
4. Wire `checkin-admin.html` + `checkin-guest-v2.html` to pipeline clients
5. Point live admin at `checkin_rooms` instead of hardcoded `APARTMENTS`

---

## Adding apartments (short version)

1. Edit `shared/room-registry.js`
2. Open admin sandbox (syncs to Firestore)
3. Fill Apts tab content
4. Set HK PIN for site
5. MiniHotel names in `minihotelNames`

Full guide: **`docs/ADD_APARTMENT_GUIDE.md`**

---

## Known limitations

- `guest-unlock.js` duplicated in shared + pipeline lib (sync check in CI)
- Password-in-callable auth (v1)
- HK still writes `hk_status` directly (HKStatusSync not built)
- Python reservation sync still separate from pipeline
- Live admin/guest still hardcode room lists
- GuestRegister no App Check

---

## Files to read first on a new project

1. `PROJECT_ARCHIVE.md` (this file)
2. `BACKEND_MAP.md`
3. `docs/ADD_APARTMENT_GUIDE.md`
4. `CLAUDE_CODE_REPORT.md`
5. `SANDBOX_BACKEND_HANDOFF.md`
6. `MASTER_ARCHITECTURE_CURSOR.md`

---

## Local git loose end (from Claude Code session)

Branch `cursor/guest-sandbox-layout-7e07` has local commit `2ae697f` (tab-bar redesign) not pushed to origin. Recover with:

```bash
git checkout cursor/guest-sandbox-layout-7e07
git log --oneline -3
# or cherry-pick onto another branch
```

---

*Maintained by Cursor Cloud Agent. Update when major phases complete.*
