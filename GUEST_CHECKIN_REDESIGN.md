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
- **First unlock:** full walkthrough + **I'm checked in**; then **daily key** (door, elevator QR/code, floor + door photo, WiFi).
- **Checkout day:** codes until **20:00 Tbilisi** or guest taps **I've checked out** (no noon lock).
- Tabs: Location & parking · Airport shuttle · Tours.
- Host gets fewer “where are my details?” messages.

---

## 2. Target guest flow (system)

```
Loading
  → Register → House rules → Passport
  → HOME
       A Waiting   → countdown (details unlock HERE)
       B Arriving  → full codes + walkthrough + "I'm checked in"
       C Staying   → door + elevator + floor/door photo + WiFi (walkthrough hidden)
       D Leaving   → daily key + "I've checked out" (until 20:00 or tap)
       → Done
```

Tabs always: Location & Parking · Airport Shuttle · Tours.

### Explicitly unchanged unless host asks later

- `searchReservation()` scoring / sibling matching  
- Rules → passport order  
- `finishRegistration_()` writes  
- `isUnlocked()` math (§4)  
- Multi-room `switchApt()`  
- Blocked / post-checkout / preview  

---

## 3. Home information architecture (LOCKED by host 2026-08-20)

### 3.1 Primary job: daily key + first-arrival walkthrough

| Priority | Content | Notes |
|----------|---------|--------|
| **P0 daily** | Smart-lock / door password | Always above the fold after unlock — entire stay |
| **P0 daily** | Elevator QR **and** numeric code | Rooms that need elevator; both methods |
| **P0 daily** | Floor info + apartment door picture | So guest finds the right door every day |
| **P0 daily** | WiFi name + password | Visible on home after unlock (copy buttons) — host 2026-08-23 |
| **P0 first arrival only** | Full check-in walkthrough | Street arrows, elevator photos, video — **hide after guest taps Checked in** |
| **P1 tabs** | Location & parking · Airport shuttle · Tours | Always-visible tab bar |
| **P2 / hide** | Cleaning, laundry, generic services grid, recommendations | Not on main for v1 |

### 3.2 Stay lifecycle (LOCKED — host 2026-08-23)

Home is **not** just locked vs unlocked. Four guest-facing phases:

| Phase | When | What guest sees |
|-------|------|-----------------|
| **A — Waiting** | Before check-in unlock time | Countdown hero + 3 tabs. No codes. |
| **B — Arriving** | Unlocked, guest has **not** tapped Checked in | Full access: door + elevator + WiFi + **full walkthrough** (street → elevator → door) + big **I'm checked in** button |
| **C — Staying** | After **I'm checked in** | Compact daily key only: door code, elevator QR/code, floor + door photo, WiFi. Walkthrough **collapsed/hidden**. Tabs use freed space. |
| **D — Leaving** | Checkout **day** until 20:00 or tap | Same daily key as C + **I've checked out** button. Codes until **20:00 Tbilisi** if guest never taps. |

**After checked out / stay ended:** thank-you / access ended (exact cutover time TBD in §4.1 — **not** 12:00 noon).

```
Waiting (countdown)
  → Arriving (full instructions + "I'm checked in")
  → Staying (daily key only)
  → Leaving (daily key + "I've checked out")  ← still has elevator/door on checkout day
  → Done
```

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
│ Maxela          [lang] [sign out]   │
├─────────────────────────────────────┤
│ Welcome, Latifa · Apt name          │
├─────────────────────────────────────┤
│  HERO (phase A/B/C/D — see below)   │
├─────────────────────────────────────┤
│ [Location] [Airport] [Tours]        │  ← always visible
├─────────────────────────────────────┤
│  (tab panel)                        │
└─────────────────────────────────────┘
```

#### Phase A — Waiting (LOCKED) — countdown hero

**Purpose:** Stop “I filled the form, where are my instructions?” WhatsApps.

| Element | Spec |
|---------|------|
| **Headline** | Large: **Your check-in instructions unlock here** |
| **Countdown** | Big `HH:MM:SS` on check-in day · or **Unlocks [date] at [time]** before that day |
| **Subline** | Come back to **this page** at check-in time. Door code appears automatically — do not message us. |
| **No codes** | Door / elevator / WiFi secrets hidden |

#### Phase B — Arriving (unlocked, not yet Checked in)

Hero becomes the **full arrival kit**:

1. Door / smart-lock password (largest + copy)  
2. Elevator QR + numeric code (if needed)  
3. WiFi name + password (copy)  
4. Floor info + apartment door picture  
5. **Full walkthrough** — street arrows, building entrance, elevator photos/video (from `checkin-details.html`)  
6. Primary CTA: **I'm checked in** (or **Checked in**)

Tapping **I'm checked in**:

- Writes to Firestore `checkin_guests/{guestId}` e.g. `guestConfirmedCheckin: true`, `guestConfirmedCheckinAt: serverTimestamp`  
- Flips UI to Phase C without leaving the page  
- Host/admin can see guest confirmed arrival (admin track later)

#### Phase C — Staying (after Checked in) — daily key only

**Hide** street arrows / outdoor path / elevator walkthrough photos (space freed for tabs + breathing room).

**Keep visible every day:**

| Keep | Why |
|------|-----|
| Door / smart-lock password | Re-enter apartment |
| Elevator QR + code | Building access |
| Floor + apartment door picture | Find the right door |
| WiFi name + password | Connectivity |

Optional: small link “Show arrival instructions again” if guest needs a refresh — default collapsed.

#### Phase D — Leaving (checkout day)

- **Do not** lock codes at 12:00 noon. Late checkouts still need elevator + door.  
- Show checkout date clearly: **Checkout today** / checkout time if we have one.  
- Button: **I've checked out** (or **Checked out**).  
- On tap: write `guestConfirmedCheckout: true` (+ timestamp); show thank-you; stop showing codes (or show short grace — see §4.1).  
- Until they tap (or grace ends): **same daily key as Phase C**.

#### Three tabs (always visible below hero — all phases A–D)

| Tab | Content | When locked (A)? |
|-----|---------|------------------|
| **Location & Parking** | Address, maps, parking — default tab | YES |
| **Airport Shuttle** | `airport_transfer` request flow | YES |
| **Tours** | `city_tour` request flow | YES |

WiFi lives in the **hero daily key**, not as a fourth tab.

#### What we are NOT building on home (v1)

- Tile grid as primary navigation  
- “Check-in Details” as a separate page guests must discover  
- Locking access at noon on checkout day  
- Full walkthrough every day after guest already arrived  

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

## 4. Unlock + stay-end system

### 4.1 Check-in unlock (KEEP existing math)

```
today > arrival                          → UNLOCKED (Phase B or C)
today < arrival                          → LOCKED (Phase A)
today === arrival:
  manualUnlock === true                  → UNLOCKED
  hour >= checkInHour (default 15)       → UNLOCKED
  hour >= 11 AND hk_status.done === true → UNLOCKED
  else                                   → LOCKED
```

- Pollers auto-flip A → B without refresh.  
- **Never** show door / elevator / WiFi secrets while locked.

### 4.2 Checkout / access end (CHANGE vs “lock at noon”)

**Host rule:** Guests need elevator QR + codes on checkout day; some check out late. **Do not revoke access at 12:00 noon.**

| Rule | Decision |
|------|----------|
| Checkout **day** | Phase D — codes stay until guest checks out **or 20:00 Tbilisi** (whichever first) |
| **I've checked out** button | Appears on checkout day; guest confirms leaving |
| After guest taps Checked out | Thank-you; hide codes; session may clear |
| Guest never taps Checked out | Codes expire at **20:00 Tbilisi on checkout day** → thank-you / access ended |
| **Not** allowed | Locking codes at 12:00 noon on checkout day |

**Implementation note:** Use `tbilisiHour()` + checkout date from reservation (`activeReservation.checkout` / `guestData.checkoutDate`). Replace production `init()` rule of `checkout + 1 day` with this at cutover.

```
function isStayEnded(){
  if(guestConfirmedCheckout) return true;
  const co = checkoutDate; // YYYY-MM-DD
  const today = tbilisiToday();
  if(today > co) return true;
  if(today === co && tbilisiHour() >= 20) return true;
  return false;
}
```

### 4.3 New Firestore fields (guest-driven)

On `checkin_guests/{guestId}` (merge writes only):

| Field | Set when |
|-------|----------|
| `guestConfirmedCheckin` | Guest taps **I'm checked in** |
| `guestConfirmedCheckinAt` | serverTimestamp |
| `guestConfirmedCheckout` | Guest taps **I've checked out** |
| `guestConfirmedCheckoutAt` | serverTimestamp |

Admin can later show these on Guests tab. No new collections.

---

## 5. Services + WiFi scope (LOCKED)

**Hero (after unlock):** WiFi name + password (daily).

**Tabs only:**

1. Airport shuttle / transfer (`airport_transfer`)  
2. Tours / city tour (`city_tour`)  
3. Location & Parking  

**Not on main:** cleaning, laundry, generic “all services” grid.

Existing `submitService()` / WhatsApp handoff / `checkin_requests` stay.

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
| 2 | What secondary while/after? | Tabs: **Location & parking · Airport shuttle · Tours**. WiFi on **hero daily key** (not a tab). |
| 3 | Details unlock where? | **Same page** |
| 4 | Final link vs sandbox? | **Same production link at the end**; build in a **sandbox** until design is ready |
| 5 | Frequent use? | **YES** — elevator QR/code + door password + floor/door photo + WiFi daily; full walkthrough only until Checked in |
| 6 | Admin redesign? | **YES** — tracked in §8 |
| 7 | Checked in button? | **YES** — collapses walkthrough; keeps daily key |
| 8 | Checkout day? | Codes stay all day (no noon lock) + **I've checked out** button |
| 9 | WiFi? | **YES** — visible on home after unlock (hero daily key) |
| 10 | If never taps Checked out? | **20:00 Tbilisi on checkout day** — then codes expire |

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
| 2026-08-23 | Cursor | Stay lifecycle A–D: Checked in / Checked out buttons; WiFi daily; no noon checkout lock; walkthrough collapses after check-in |
| 2026-08-23 | Cursor | Locked checkout expiry: **20:00 Tbilisi** on checkout day if guest never taps Checked out |

---

## Quick checklist before any major step

- [ ] I re-read §1–§5 and §7  
- [ ] Guest work is in **sandbox**, not production, unless this is cutover  
- [ ] My workstream is claimed in §9  
- [ ] I am not editing a file another agent claimed  
- [ ] I will update §9 and §12 when finished  
