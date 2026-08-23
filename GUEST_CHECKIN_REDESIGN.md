# Guest Check-in Redesign — Shared Source of Truth

> **READ THIS FILE before every major step.**  
> Used by Cursor Cloud Agent and Claude / Claude Code.  
> Do not start coding a section until it is claimed below and the system model in §2–§5 is still accurate.

**Status:** Host decisions locked (§7) — sandbox build next; production URL unchanged until cutover  
**Sandbox file (build here):** `checkin-guest-sandbox.html` *(create when Phase 1 opens — do not overwrite live guest page yet)*  
**Production file / final URL:** `checkin-guest-v2.html` → https://app.maxelaapartments.com/checkin-guest-v2.html  
**Admin file (separate track):** `checkin-admin.html`  
**Do not touch without claim:** `minihotel_reservation_sync.py`  
**Related:** `checkin-details.html` (content moves into guest home; production link stays guest v2)  
**Firebase project:** `sleepy-5c962`  
**Spec audit:** `CHECKIN_GUEST_SPEC.md` · **System map:** `CODEBASE.md`

---

## 0. How Cursor and Claude work together

### Rules (non-negotiable)

1. **Read this file first** at the start of every session and before every PR / major edit.
2. **Claim a workstream** in §9 before editing. Put your name/tool, date, and file list.
3. **One owner per file at a time.** Sandbox guest file and admin file can be claimed by different agents in parallel.
4. **Sandbox first.** Until cutover is explicitly approved, all guest redesign code goes into `checkin-guest-sandbox.html` (or agreed sandbox name). Do **not** replace `checkin-guest-v2.html` mid-design.
5. **Do not redesign and rewrite unlock/search logic in the same pass** unless this doc says that phase is open.
6. **Update this doc** when you finish a chunk: mark the workstream done, note what changed, link commit/PR.
7. **Conflicts:** Prefer updating this doc and stopping over force-merging overlapping CSS/HTML.

### Preferred split (default)

| Agent | Owns by default | Does not own |
|-------|-----------------|--------------|
| **Cursor** | This doc, guest sandbox shell (countdown + access codes home), cutover plan | Deep services copy/modals unless claimed; admin until admin track opens |
| **Claude / Claude Code** | Porting check-in tour/instructions into sandbox unlocked region; Airport shuttle + tours UI; copy/i18n | Changing unlock math / search; overwriting production `checkin-guest-v2.html` before cutover |

Admin redesign is a **separate track** (§8). Claim `admin-*` workstreams before touching `checkin-admin.html`.

---

## 1. Product problem

### What happens today

1. Guest enters name + check-in date → system finds reservation.
2. After rules + passport, guest lands on a **tile menu**.
3. Check-in instructions live behind **Check-in Details** (`checkin-details.html`).
4. Guests **do not click** those tiles. They **WhatsApp the host**.

### Root cause

The page is a dashboard. Guests need a **daily key**: door password + elevator QR/code. Those must live on the main screen.

### Success criteria

- Same final link guests already use (`checkin-guest-v2.html` / live URL).
- After registration, **main screen = check-in / access**, not a menu.
- **Locked:** countdown + “details unlock on this page when the timer ends.”
- **Unlocked:** door code + elevator (QR and/or numeric) + arrival steps on that same page.
- Guests return to this page throughout the stay for **door password** and **elevator**.
- Secondary: **location + parking**, plus **Airport shuttle** and **tours** only (not full services catalog on main).
- WiFi is deprioritized (not a main-page priority).
- Host gets fewer “where are my details?” messages.

---

## 2. Target guest flow (system)

```
Loading
  → Register (name + date + contact/guests as today)
  → House rules (required)
  → Passport upload (required before arrival / before home)
  → HOME
       ├─ LOCKED   → countdown + message (details unlock HERE)
       │              + secondary: location/parking, airport shuttle, tours, contact
       └─ UNLOCKED → THIS PAGE IS the key:
                      door/smart-lock password (always prominent)
                      elevator code + QR (when room needs it)
                      check-in walkthrough / photos / video
                      + same secondary links
```

Returning guests with valid session → straight to HOME.

### Explicitly unchanged unless host asks later

- `searchReservation()` scoring / sibling matching  
- Rules → passport order  
- `finishRegistration_()` writes  
- `isUnlocked()` math (§4)  
- Multi-room `switchApt()`  
- Blocked / post-checkout / preview  

---

## 3. Home information architecture (LOCKED by host 2026-08-20)

### 3.1 Primary job: access codes guests reuse

| Priority | Content | Notes |
|----------|---------|--------|
| **P0** | Smart-lock / door password | Guests need this constantly — always above the fold when unlocked |
| **P0** | Elevator QR **or** numeric code | Rooms that need elevator (`needsElevatorCode()`); both entry methods matter |
| **P0** | Arrival instructions / tour | From today’s `checkin-details.html` content, inlined on home when unlocked |
| **P1** | Location & parking | Keep; apartment address + parking |
| **P1** | Airport shuttle | Keep as a service entry on/near main |
| **P1** | Tours (city tour) | Keep as a service entry on/near main |
| **P2 / hide from main** | WiFi | Not important for this redesign — do not feature on main; may remain deep/hidden via admin visibility |
| **P2 / hide from main** | Cleaning, laundry, other services | Not on main catalog for v1 |
| **P2** | Recommendations, full house-rules page | Not primary; optional later |

### 3.2 Locked vs unlocked

| State | Main screen |
|-------|-------------|
| **Locked** | Countdown + clear copy that **check-in details unlock on this same page**. No door/elevator codes yet. Secondary: location/parking + shuttle/tours + contact OK. |
| **Unlocked** | Same page reveals door password, elevator QR/code, instructions. No navigation to another HTML file required. |

### 3.3 Production link + sandbox

| Stage | File | URL |
|-------|------|-----|
| **Design / build** | `checkin-guest-sandbox.html` | e.g. `/checkin-guest-sandbox.html` (sandbox only) |
| **Cutover (end)** | Contents promoted into `checkin-guest-v2.html` | **Same live link** guests already have |
| **After cutover** | `checkin-details.html` | Redirect or shim to guest home — do not leave a second “real” check-in UI |

Until cutover is host-approved: **never** replace production guest page with unfinished redesign.

### 3.4 Tile menu — RETIRED

The current home (see host screenshot 2026-08-23) is **wrong**:

- Greeting + “What You Booked” + long list of equal tiles (WiFi, location, services, maps…)
- No countdown, no “instructions unlock here” message
- Guest thinks registration is done → texts host immediately
- Arabic/Georgian mix in tile labels adds confusion

**Replace entirely** with the layout in §3.5.

### 3.5 Home screen layout (LOCKED — host 2026-08-23)

One page, two states. **No tile grid.** No separate `checkin-details.html` click required.

#### Structure (top → bottom)

```
┌─────────────────────────────────────┐
│ Maxela          [lang] [sign out]   │  ← slim top bar (keep)
├─────────────────────────────────────┤
│ Welcome back, Latifa                │  ← short greeting + apt name (1 line)
├─────────────────────────────────────┤
│                                     │
│   ╔═══════════════════════════╗     │
│   ║  LOCKED: COUNTDOWN HERO   ║     │  ← dominates viewport
│   ║  or                       ║     │
│   ║  UNLOCKED: ACCESS CODES   ║     │
│   ╚═══════════════════════════╝     │
│                                     │
├─────────────────────────────────────┤
│ [Location] [Airport] [Tours]        │  ← 3 tabs, always visible
├─────────────────────────────────────┤
│  (tab panel content)                │
└─────────────────────────────────────┘
```

#### LOCKED state — countdown hero (must be impossible to miss)

**Purpose:** Stop “I filled the form, where are my instructions?” WhatsApps.

| Element | Spec |
|---------|------|
| **Headline** | Large, plain language — not small muted text |
| **Countdown** | Big numeric timer `HH:MM:SS` (on check-in day) OR “Unlocks 15 Aug at 15:00” (before check-in day) |
| **Subline** | Explicit: instructions appear **on this page** — no other app, no message to host |
| **Visual** | Gold accent border/background on hero card; countdown in large mono numerals |
| **Remove** | “What You Booked” collapsible above the fold (move below tabs or drop from locked view) |
| **Remove** | WiFi tile, generic Services tile, Recommendations, duplicate map tiles |

**Draft copy (EN — translate all 4 langs before ship):**

- Headline: **Your check-in instructions unlock here**
- Subline (check-in day): **Come back to this page at check-in time. Your door code and arrival steps will appear automatically — you do not need to message us.**
- Above countdown: **Available in**
- Before check-in day: **Your instructions unlock on [date] at [time] on this page.**

#### UNLOCKED state — same page, hero swaps

Countdown hero **replaced in place** by access stack (no navigation):

1. **Door / smart-lock password** — largest, copy button, always on top  
2. **Elevator** — QR fullscreen + numeric code (rooms that need it)  
3. **How to check in** — photo/video walkthrough (from today’s `checkin-details.html`)

Guest returns to this same URL throughout stay for door + elevator.

#### Three tabs (always visible below hero)

Host requirement: **Airport Shuttle · Tours · Location & Parking** — very visible, not buried.

| Tab | Content | Available when locked? |
|-----|---------|------------------------|
| **Location & Parking** | Address, Google Maps, parking — default/ first tab | **YES** — guests need this before arrival |
| **Airport Shuttle** | Transfer request (existing `airport_transfer` service flow) | **YES** |
| **Tours** | City tour request (existing `city_tour` service flow) | **YES** |

- Tab bar: full-width, 3 equal segments, sticky below hero on scroll  
- Default tab on first visit after registration: **Location & Parking** (most useful while waiting)  
- WiFi, cleaning, laundry, full services grid: **not in tabs** for v1  

#### What we are NOT building on home (v1)

- Tile grid as primary navigation  
- WiFi as a main tile  
- “Check-in Details” as separate page/link  
- Equal-weight menu of 6+ options  

### 3.6 Screens we are NOT redesigning (host 2026-08-23)

| Screen | Status |
|--------|--------|
| **Register** (name + date) | Keep layout — **one copy fix only** (§3.7) |
| **House rules** | Keep |
| **Passport upload** | Keep |
| **Home** | **Full redesign** (§3.5) |

### 3.7 Registration copy fix (small — do with sandbox or quick patch)

**Problem:** Guests enter first name only; search needs full name.

| Element | Today (EN) | Change to |
|---------|------------|-----------|
| Field label `#t-full-name` | “Booking Name” | **“Full name”** |
| Instructions `#t-search-instructions` | “Enter your name as it appears…” | **“Enter your full name (first and last) as it appears on your booking confirmation, along with your check-in date”** |
| Placeholder | “Name on your booking” | **“First and last name on your booking”** |

Update `T.en/ka/ru/ar` keys: `fullName`, `searchInstructions`, `namePlaceholder`.  
Safe to ship as a tiny production patch independent of home redesign.

---

## 4. Unlock system (behavior kept; presentation changes)

```
today > arrival                          → UNLOCKED
today < arrival                          → LOCKED
today === arrival:
  manualUnlock === true                  → UNLOCKED
  hour >= checkInHour (default 15)       → UNLOCKED
  hour >= 11 AND hk_status.done === true → UNLOCKED
  else                                   → LOCKED
```

### Presentation

- On arrival day before unlock: **live countdown** + “details appear on this page when the timer ends.”
- Before arrival day: show unlock date/time (“Available on 15 Aug at 15:00”).
- Pollers must auto-flip locked → unlocked without refresh.
- **Never** show door/elevator secrets while locked.

---

## 5. Services scope on guest main (LOCKED)

**On / near main page only:**

1. Airport shuttle / transfer (`airport_transfer`)  
2. Tours / city tour (`city_tour` or equivalent admin service id)

**Not featured on main for this redesign:** WiFi, cleaning, laundry, generic “all services” grid.

Existing `submitService()` / WhatsApp handoff / `checkin_requests` stay. Design of shuttle + tours UI is a later claimed workstream.

Admin “Guest Page Settings” visibility should eventually align with this IA (admin track).

---

## 6. Phased delivery

| Phase | Goal | Where | Code? |
|-------|------|-------|-------|
| **0 — System agreement** | This doc + host decisions | Docs | Docs only — **DONE enough to proceed** |
| **1 — Sandbox shell** | Copy/adapt guest app into sandbox; home = locked countdown / unlocked access host region | `checkin-guest-sandbox.html` | Yes |
| **2 — Inline check-in** | Port `checkin-details` content into unlocked home; door + elevator QR/code prominent | sandbox | Yes |
| **3 — Secondary** | Location/parking + Airport shuttle + Tours on/near main | sandbox | Yes |
| **4 — Visual design** | Brand, motion, typography polish | sandbox | Yes — after shell works |
| **5 — Cutover** | Promote sandbox → `checkin-guest-v2.html` (same URL); shim `checkin-details.html` | production files | Yes — **host approve first** |
| **A — Admin redesign** | Parallel track (§8) | `checkin-admin.html` (prefer admin sandbox if risky) | Separate claims |

---

## 7. Host decisions (answered 2026-08-20)

| # | Question | Answer |
|---|----------|--------|
| 1 | Rules + passport before home? | **YES** — required before arrival / before home |
| 2 | What secondary while/after? | **Location & parking** yes. Services on main: **Airport shuttle + tours only**. WiFi not important. |
| 3 | Details unlock where? | **Same page** |
| 4 | Final link vs sandbox? | **Same production link at the end**; build in a **sandbox** until design is ready |
| 5 | Frequent use? | **YES** — elevator QR or code + smart-lock door password; page is a daily key |
| 6 | Admin redesign? | **YES** — wanted; tracked in §8 (needs problem list from host) |

---

## 8. Admin side (known today + redesign track)

Yes — admin exists and is mapped. File: **`checkin-admin.html`** (~3.4k lines). Password lock screen, then sidebar:

| Tab | Role |
|-----|------|
| **Apartments** | Per-room editor: WiFi, instructions, photos, rules, recommendations, check-in time, etc. (`checkin_apartments`) |
| **Guests** | Today’s reservations + check-in forms, passport review, unlock/block, WhatsApp links, failed searches |
| **Requests** | Guest service requests (`checkin_requests`) |
| **HK Pins** | Housekeeping PIN management |
| **Guest Page Settings** | Visibility toggles, services catalog, laundry items, section labels, room categories, location info (`checkin_admin/config`) |

Shared design language: DM Sans / DM Mono, green accent admin chrome (different from guest Playfair/Inter).

### Admin redesign status

**Wanted by host — problem statement not yet written.**

Do **not** start admin visual redesign until host lists pain points (same process as guest). Suggested next step: short callout from host — what is slow, confusing, or missing in admin daily use.

### Admin ↔ guest coupling (important)

Guest main IA change means **Guest Page Settings** should eventually:

- Default/hide WiFi on guest main  
- Feature Airport shuttle + Tours  
- Treat check-in / access as the home surface (not a tile toggle only)

That config work belongs in the admin track after guest sandbox IA is stable — or a small config pass claimed explicitly.

### Admin coordination

| Rule | |
|------|--|
| Prefer `checkin-admin-sandbox.html` if redesign is large | Same pattern as guest |
| Do not break live ops admin without cutover plan | Host uses this daily |
| Claim `admin-*` in §9 | Parallel OK with guest sandbox if different files |

---

## 9. Workstream claims

| Workstream | Status | Owner | Files | Notes |
|------------|--------|-------|-------|-------|
| `docs-coord` | **active** | Cursor | `GUEST_CHECKIN_REDESIGN.md` | Decisions locked; sandbox plan |
| `guest-sandbox-shell` | ready to open | — | `checkin-guest-sandbox.html` | Phase 1 — claim before coding |
| `inline-checkin-access` | blocked on Phase 1 | — | sandbox | Door + elevator + tour |
| `secondary-location-services` | blocked on Phase 1 | — | sandbox | Parking/location + shuttle + tours |
| `guest-visual-design` | blocked on shell | — | sandbox CSS | Phase 4 |
| `guest-cutover` | blocked | — | `checkin-guest-v2.html`, `checkin-details.html` | Host approve |
| `admin-problem-brief` | waiting on host | — | docs | List admin pains first |
| `admin-redesign` | blocked on brief | — | `checkin-admin.html` or sandbox | Separate track |

**Claim example:**

```
| `guest-sandbox-shell` | active | Cursor | checkin-guest-sandbox.html | 2026-08-20 — Phase 1 only |
```

---

## 10. Fragile areas (do not regress)

- `searchReservation()` siblings = exact `reservationNumber` only  
- Multi-room pinning (`_targetResId`, `_knownIds`) in `showHome` / `switchApt`  
- `_homeLoading` + `_homeSnaps` teardown  
- Session clear on missing guest / checkout expiry  
- `needsElevatorCode()` list (note: `7-3` missing today — flag, don’t silent-fix in redesign)  
- Elevator stale check (~36h) → “contact host”  

Retest: single room, multi-room switch, locked→unlocked flip, logout, preview, elevator rooms vs non-elevator rooms.

---

## 11. Out of scope (for now)

- Changing unlock hour policy  
- New Firestore collections  
- Multi-tenancy paths  
- Removing passport requirement  
- Full services marketplace  

---

## 12. Changelog

| Date | Who | Change |
|------|-----|--------|
| 2026-08-20 | Cursor | Initial coordination doc |
| 2026-08-23 | Cursor | Home screen wireframe §3.5: countdown hero + 3 tabs; registration copy fix §3.7 |

---

## Quick checklist before any major step

- [ ] I re-read §1–§5 and §7  
- [ ] Guest work is in **sandbox**, not production, unless this is cutover  
- [ ] My workstream is claimed in §9  
- [ ] I am not editing a file another agent claimed  
- [ ] I will update §9 and §12 when finished  
