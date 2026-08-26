# Guest Check-in Redesign — Shared Source of Truth

> **READ THIS FILE before every major step.**  
> Used by Cursor Cloud Agent and Claude / Claude Code.  
> Do not start coding a section until it is claimed below and the system model in §2–§5 is still accurate.

**Status:** Host decisions locked (§7) — **Sandbox 2 is the canonical redesign**; production URL unchanged until cutover  
**Sandbox file (build here):** `checkin-guest-sandbox-2.html` → https://app.maxelaapartments.com/checkin-guest-sandbox-2.html  
**Other sandboxes:** `checkin-guest-sandbox.html` (Sandbox 1, Claude) · `checkin-guest-sandbox-3.html` (portal experiment, parked — §19)  
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
4. **Sandbox first.** Until cutover is explicitly approved, all guest redesign code goes into **`checkin-guest-sandbox-2.html`** (canonical). Do **not** replace `checkin-guest-v2.html` mid-design.
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

**Host problem brief locked 2026-08-26 — see §22.** Build in `checkin-admin-sandbox.html` only; do not replace live `checkin-admin.html` until cutover.

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
| `guest-sandbox-shell` | done (Phase 1) | Claude Code | `checkin-guest-sandbox.html` | Do not overwrite while comparing |
| `guest-sandbox-2-design` | **active — canonical** | Claude (continuing) | `checkin-guest-sandbox-2.html` | Host chose Sandbox 2 over Sandbox 3 — see §18 + §20 |
| `guest-sandbox-3-portal` | parked | Cursor | `checkin-guest-sandbox-3.html` | Functional bottom-nav portal experiment — §19; do not overwrite Sandbox 2 |
| `inline-checkin-access` | done (2026-08-25) | Claude | `checkin-guest-sandbox-2.html` | Walkthrough was already built + wired — verified working, fixed a real click bug (§18.3). Added real Waiting-tab content (Location/Shuttle/Tours). |
| `secondary-location-services` | blocked on Phase 1 | — | sandbox | Parking/location + shuttle + tours |
| `guest-visual-design` | blocked on shell | — | sandbox CSS | Phase 4 |
| `guest-cutover` | blocked | — | `checkin-guest-v2.html`, `checkin-details.html` | Host approve |
| `admin-problem-brief` | **done** | Cursor + host | docs §22 | Mobile ops: Today / Elevator / passport privacy / checked-in status / bottom nav |
| `admin-redesign` | **active** | Cursor | `checkin-admin-sandbox.html` | §22 mobile ops — Stay (overview/in-house/upcoming) · Elevator · Apts editor · More |

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
| 2026-08-23 | Claude Code | Phase 1 `guest-sandbox-shell` done: `checkin-guest-sandbox.html` created (copy of `checkin-guest-v2.html`, `#page-home` rebuilt per §3.5 — countdown hero + shared daily-key hero (door/elevator/WiFi/floor) + walkthrough placeholder + Checked in/out CTAs + 3 tabs). `applyHomePhase()`, `window.guestCheckedIn/guestCheckedOut/isStayEnded` added; JS module otherwise unchanged (pure additions, verified by diff). Register/rules/passport untouched. |
| 2026-08-24 | Claude Code | Added sandbox dev toolbar (`#sb-toolbar`) to `checkin-guest-sandbox.html` — jump to any screen/phase/state with full mock guest/reservation/apartment/elevator data, zero Firebase dependency (`_sbBuildMocks()`, `_sbRenderHomeForPhase()`, `_sbShowScreen()`, `_sbGoPhase()`, `_sbToggle()`). Added §14 Sandbox & Current Build State and §15 Prompts & Build Log (renumbered from §13/§14 on 2026-08-24 to make room for §13 Design Tokens & Rules). |
| 2026-08-24 | Claude Code | **Color fix:** home-screen hero card was shipped dark/inverted (black background, white text, gold `#C4A882` CTA) — reverted to the correct system: white cards (`#FFFFFF`), dark text (`#2C2C2A`/`#8C8C8A`), dark-filled primary CTA (`#2C2C2A`/`#fff`), no gold anywhere as a background. Split "I've checked out" into its own lighter-bordered "destructive/confirm" style, distinct from the bold primary "I'm checked in". Fixed the same gold-background violation on the dev toolbar's active-state buttons. Added §13 Design Tokens & Rules to lock this down for future work. |
| 2026-08-24 | Cursor | Sandbox 2 design proposal: `checkin-guest-sandbox-2.html` — compact greeting, date-or-countdown waiting, door-first stacked cards, large elevator QR, WiFi compact, door-photo empty state. Does not replace Claude sandbox 1. |
| 2026-08-24 | Cursor | Sandbox 2 layout fixes: elevator QR stacked above 6-digit code; photo step walkthrough from `photos`/`photoCaptions`; multi-room full-width switcher + bottom sheet; tabs moved under greeting (above hero). |
| 2026-08-24 | Cursor | Sandbox 2: square multi-room tiles; WiFi strip + Location/Parking split; removed photo peek & floor card; companion guest link §17; checked-in hint. |
| 2026-08-25 | Cursor | Sandbox 2 polish merged to `main`: phone divider under contact; Tbilisi arrival-time chip picker; rules SVG icons + entrance-card copy; passport header fix; staying-phase horizontal service chips; group invite under door code; waiting tabs under countdown + stronger WYB heading; one-time QR scroll on first home open. |
| 2026-08-25 | Cursor | Sandbox 3: first attempt = color reskin (rejected). Second attempt = functional guest portal with wizard + bottom nav (§19). Host prefers Sandbox 2 — parked for later. |
| 2026-08-25 | Claude Code | `inline-checkin-access` on Sandbox 2: verified the arrival walkthrough (already fully built — photos/captions render, lightbox works, Staying-phase collapse works, toggle works). Built real Waiting-tab content: `#panel-location` (address/maps/parking via new shared `_getLocationData()`), `#panel-shuttle`/`#panel-tours` (real service info + working "Request pickup"/"Ask about tours" buttons reusing `openSvc()`). Fixed a real bug: `JSON.stringify(name)` inside a double-quoted `onclick` attribute broke every service-chip button (Staying chips too, not just new code) — fixed by escaping `"`→`&quot;`. §18.3 updated to reflect actual build state (was stale). |
| 2026-08-25 | Claude Code | **5 UX fixes on Sandbox 2:** (1) Waiting phase — moved Location/Shuttle/Tours tabs above the countdown; tabs now open a real subpage via `openPage()` (extended with new `shuttle`/`tours` content types + `#page-content-shuttle`/`#page-content-tours`) instead of toggling an inline panel — replaced the retired `_renderWaitingTabsContent()` with a shared `_svcSubpageCard()` builder. (2) Leaving phase — `#home-quick` (Location/Parking row) now hidden; only door code, elevator, WiFi, and "I've checked out" remain. (3) Fixed Staying-phase service-chip scroll snapping back to start — removed `scroll-snap-type`/`scroll-snap-align`. (4) Restructured daily-key layout: Smart lock code card now first (with a new copy button — it had none before), Elevator card compacted to one row (QR left, code+label stacked right, code now 14px not 28px) — saves ~60-80px. (5) Removed the "Sandbox 2 · Cursor design proposal · not live" banner and its CSS entirely. |
| 2026-08-25 | Claude Code | **4 more fixes on Sandbox 2:** (1) Elevator code moved back below the QR (was beside it since the previous session's compact-row fix) — now QR on top, small muted "Elevator code" label, code capped at 16px, no copy button, matching "supplementary info" framing. (2) Removed the smart-lock/door-code copy button entirely (`#hero-door-copy` + its onclick) — guest types it manually; WiFi copy buttons untouched. (3) Rebuilt the WiFi section as a `.wifi-card` (white bg, `1.5px solid #E0D8D0`, `12px` radius) with two label/value/copy rows (Network + Password, each own copy button now — Network didn't have one before) and moved it below `#btn-checked-in` in Arriving and below the daily-key area in Staying/Leaving (was above the CTA; also un-hid it for Leaving, where it had been force-hidden). (4) Added `scroll-snap-type:none!important`, `scroll-behavior:auto`, `overscroll-behavior-x:contain` to `.home-svc-scroll` per exact spec (chip `scroll-snap-align` was already removed last session — confirmed still absent). **Could not fix:** "City Tours" → "Tours" rename — searched the full file, no such string exists in source; the label is pulled live from `checkin_admin/config.services[].name` (admin-configured Firestore data), and the code's own built-in default is already "Tours". Renaming requires an admin-panel/Firestore change, not a sandbox HTML edit. |
| 2026-08-26 | Cursor + host | Admin redesign brief locked — §22 (bottom nav like Sandbox 3, Today's Arrivals, Check passport, checked-in status, elevator manual-sticky). |
| 2026-08-26 | Cursor | Started `checkin-admin-sandbox.html` (§22.8) — mobile bottom-nav ops shell with Today / Elevator / Guests / More. |
| 2026-08-26 | Cursor | Admin sandbox v2: **Stay** overview (arrivals + leaving + in-house + upcoming 7d), **Apts** full editor (lock/WiFi/instructions/photos → `checkin_apartments`), apt list shows who is staying / next arrival. |

---

## 13. Design Tokens & Rules (2026-08-24 — Claude Code)

> **Read this before touching any CSS in `checkin-guest-sandbox.html`.** This section is the
> single source of truth for typography, color, and component styling on the redesigned home
> screen. It exists because the first Phase 1 build shipped a dark/inverted hero card with a
> gold CTA button — both wrong. This section locks the correction so it never regresses.

### 13.1 Typography

| Use | Font | Notes |
|-----|------|-------|
| Headings, guest name (`#home-guest-name`), property name, brand wordmark, modal titles | **Playfair Display**, italic | `font-family:var(--serif)` — already loaded via Google Fonts link in `<head>` |
| All body copy, labels, buttons, inputs, tabs, nav | **Inter** | `font-family:var(--sans)` |
| Monospace — door code, elevator code, WiFi password, countdown, all mono labels (`DOOR CODE`, `WIFI`, etc.) | **Courier New** / system monospace stack | `font-family:var(--mono)` — the file does **not** load DM Mono; do not reference it. If a true monospace upgrade is wanted later, swap the `--mono` token, don't hardcode a new font-family per element. |

**Size + weight scale actually used on the redesigned home screen** (updated 2026-08-24 — see §14.6 for the fix that made these darker/bolder):

| Element | Size | Weight |
|---------|------|--------|
| Guest name (`.greeting__name`, `#home-guest-name`) | 38px | **700** |
| Card titles (`.subpage-title`, `.modal-title`, `.ci-title h2`, `.lc-title`, `.auth-greet h1`) | varies | **600** |
| Hero waiting headline | 24px | 400 italic |
| Countdown digits | 44px | 500 |
| Door/elevator code digits (`.dk-code`) | 36px | **700**, `letter-spacing:0.12em` |
| WiFi value (`.dk-wifi-val`) | 14px | **700**, `letter-spacing:0.12em` |
| Section mono labels (`DOOR CODE`, `WIFI`, `FLOOR & DOOR`) — `.dk-label` | 10.5px | **500**, `letter-spacing:0.06em` |
| Sub-labels (`NETWORK`, `PASSWORD`) — `.dk-wifi-sublabel` | 9.5px | **500**, `letter-spacing:0.06em` |
| Field labels — `.auth-row__label`, `.form-label` | 9.5–12px | **500** |
| Primary CTA button text (`.hero-cta__btn`, `.auth-cta`) | 15.5–16px | 600 |
| Copy buttons (`.dk-copy`) | 11px | **600** |
| Tab bar labels | 12.5px | 500 (600 when active) |
| Tab panel body copy | 13.5px | 400 |
| Subline / muted body (`.hero-waiting__sub`, `.hero-cta__checkout-label`) | 11–13px | 400 (label variants 500) |
| Body text baseline (`body`) | 15px | **400 minimum — never lighter** |

**Letter-spacing rule:** monospace codes (door/elevator/WiFi values) use `0.12em`. Uppercase mono labels on the redesigned home screen (`.dk-label`, `.dk-wifi-sublabel`, `.hero-cta__checkout-label`, `#multi-room-label`) use `0.06em` — `#multi-room-label` is the one exception at `0.08em` per its own spec. This 0.06em rule applies to the **redesigned home screen only** — pre-existing v2 uppercase labels elsewhere in the file (register/rules/passport/services/topbar) keep their original hand-tuned values (0.10–0.24em) and were intentionally left untouched.

### 13.2 Color rules (explicit — no ambiguity)

| Token | Hex | Where it IS used | Where it is NEVER used |
|-------|-----|-------------------|-------------------------|
| `--bg` (page background) | `#FAFAF9` | `<body>` background | Never on a card |
| Card background | `#FFFFFF` | Every card on the home screen: `.hero-card` (all 4 phase states — waiting, daily-key, thank-you), tab panels | Never `--ink` or any dark color as a card background |
| `--ink` | `#2C2C2A` | All primary text; primary CTA button **background**; toolbar active-state background | Never a card background |
| `--ink-2` | `#4A4A48` | Secondary text (e.g. `.hero-cta__link` "Show arrival instructions") | — |
| `--muted` | `#4A4A48` (changed from `#8C8C8A` on 2026-08-24 — the lighter gray read as too faint) | Muted labels, subline copy, mono section labels (`DOOR CODE`, `WIFI`, etc.) — applies **globally**, this is a single `:root` variable used everywhere in the file, not just the home screen | — |
| `--line` | `#E0D8D0` | Borders — row dividers (`.dk-wifi-row`), dashed walkthrough placeholder border, the "I've checked out" button's border | — |
| `--accent` / gold | `#C4A882` | **Thin decorative borders and small dots only** (pre-existing v2 elements outside the home screen: `.pulse` dot, `.auth-greet .kicker .pip` dot, focus-border on inputs). **Never used anywhere in the redesigned home screen (`#page-home`).** | **NEVER a background on any button or card. NEVER a CTA color. This is the rule that was violated and is now fixed — do not reintroduce it.** |
| Success green | `--green` `#2d6b50` / `--green-bg` `#edf5f0` / `--green-border` `#8ecdb0` | Copy-button `.copied` success state only | — |

**Explicit statement:** every background on the redesigned home screen (`#page-home`) is either `#FAFAF9` (page) or `#FFFFFF` (card). Every piece of text is `#2C2C2A` (ink) or `#4A4A48` (muted / ink-2 — both tokens now share this hex; `--muted` is for labels/subline copy, `--ink-2` is for secondary interactive text like links). There is no dark/inverted surface anywhere in the current build.

### 13.3 Button styles (exact CSS — three categories, do not merge them)

**Primary CTA** — "I'm checked in", "Continue", "Find my booking", "I agree — Continue":
```css
background: #2C2C2A;
color: #fff;
border-radius: 24px;   /* var(--rxl) */
padding: 16px;
width: 100%;
font-size: 16px;
font-weight: 600;
border: none;
```
Class in sandbox: `.hero-cta__btn` (used by `#btn-checked-in`).

**Secondary** — "Show arrival instructions" link, all copy buttons (door/elevator/WiFi×2):
```css
background: #fff;
color: #2C2C2A;
border: 1.5px solid #2C2C2A;
border-radius: 24px;   /* pill */
padding: 12px 20px;    /* copy buttons use a fixed 44px height instead — see .dk-copy */
```
Class in sandbox: `.dk-copy` (copy buttons — 44px height for touch-target compliance, not the 12px/20px padding literally, but same white/ink-border/ink-text look, `font-weight:600`). `.hero-cta__link` (the "Show arrival instructions" text link) uses `--ink-2` text with no border/background — it's a link, not a button, so it doesn't carry the full bordered-pill treatment. `.hero-cta__btn--secondary` (added 2026-08-24 for "Contact host" on the post-checkout screen) is the same Secondary style at a smaller `padding:12px 24px`, sized to its content instead of `width:100%`.

**Destructive/confirm** — "I've checked out" only:
```css
background: #fff;
color: #2C2C2A;
border: 1.5px solid #E0D8D0;   /* var(--line) — lighter than the ink-bordered secondary style */
border-radius: 24px;
padding: 16px;
width: 100%;
```
Class in sandbox: `.hero-cta__btn.hero-cta__btn--confirm` (used by `#btn-checked-out`). This is visually calmer than the Secondary style (light-gray border, not ink border) because confirming checkout is a lower-urgency, less-frequent action than the daily copy/CTA interactions.

**Never merge Primary and Destructive/confirm into the same visual weight.** "I'm checked in" is the dominant action of Phase B and must read as the boldest thing on screen; "I've checked out" is a quieter confirmation on checkout day.

### 13.4 Card styles

**Standard card** (`.hero-card`, used for all 4 hero states — waiting, daily-key with arriving/staying/leaving content, and thank-you):
```css
background: #fff;
border-radius: 12px;   /* var(--r) */
box-shadow: 0 2px 12px rgba(0,0,0,0.06);   /* var(--shadow-card) */
padding: 24px;
```

**No dark/inverted cards anywhere on the home screen.** If a future design pass wants a dark accent surface, it must be proposed and locked here first — do not add one directly in CSS.

### 13.5 What Cursor (or any future agent) should NEVER do

- **Never** use gold (`var(--accent)` / `#C4A882`) as a button or card background. Gold is thin-border/small-dot/wordmark-accent only, and only on pages outside the redesigned home screen.
- **Never** build a dark/inverted hero card. Every card on `#page-home` is white with dark text.
- **Never** add a drop shadow heavier than `0 2px 12px rgba(0,0,0,0.06)` (`--shadow-card`). No `box-shadow` values with larger blur, spread, or opacity on home-screen cards.
- **Never** introduce a color not in the §13.2 token table. If a new color is genuinely needed, add it here first with a name, hex, and explicit usage rule — don't drop a raw hex or a new `rgba(255,255,255,…)` value into a rule.
- **Never** change a JS-referenced element ID (`hero-door-code`, `hero-elevator`, `hero-wifi-name`, `hero-wifi-pass`, `hero-door-photo`, `hero-walkthrough`, `btn-checked-in`, `btn-checked-out`, `hero-checkout-label`, `hero-thankyou`, `hero-thankyou-whatsapp`, `countdown-display`, `multi-room-label`, `tab-location`/`tab-shuttle`/`tab-tours`, `panel-location`/`panel-shuttle`/`panel-tours`, any `sb-*` toolbar ID) or a dynamic class the JS toggles (`phase-waiting`/`phase-arriving`/`phase-staying`/`phase-leaving`, `.active`, `.copied`, `.show`). Colors and spacing are safe to restyle; renaming IDs or classes breaks the JS.

---

## 14. Sandbox & Current Build State (2026-08-24 — Claude Code)

### 14.1 Sandbox file

- **File:** `checkin-guest-sandbox.html` (repo root, same host as production)
- **Open locally:** `open checkin-guest-sandbox.html` — no server needed for the static HTML/CSS, but the app is an ES module (`<script type="module">`) that talks to real Firestore, so `file://` works for browsing UI only; use any static server (`python3 -m http.server`) if you need `init()`'s real Firebase calls to run without CORS/module-script quirks.
- **Pushed URL:** once pushed to `main`, same static hosting pattern as `checkin-guest-v2.html` → `https://app.maxelaapartments.com/checkin-guest-sandbox.html`
- **Dev toolbar:** a fixed black bar pinned to the bottom of the viewport, visible always in this file (no `?sandbox=true` gate — sandbox-only, never ports to v2). Three rows:
  - **Screens** — jumps straight to Loading / Register / Rules / Passport / Home, bypassing all Firebase/session checks (`_showPage()` directly).
  - **Phase (Home only)** — Waiting / Arriving / Staying / Leaving / Checkout Done. Clicking a phase button also switches to Home. Injects full mock guest/reservation/apartment/elevator data (§14.3) so every code, WiFi field, and CTA renders with real-looking content — no login, no real reservation needed.
  - **State** — Multi-room, Elevator code, Manual unlock toggles. Re-renders whatever phase is currently on screen immediately so the effect is visible without re-clicking a phase button.
  - "hide" button collapses the bar to just its header if it's blocking a screenshot.

### 14.2 What is built (Phase 1 current state)

**Screens** — all 5 exist and are reachable via the toolbar:

| Screen | Status |
|--------|--------|
| Loading (`#loading`) | Unchanged from v2 |
| Register (`#page-register`) | Unchanged from v2 (copy fix §3.7 **not yet applied** — still says "Booking Name") |
| Rules (`#page-rules`) | Unchanged from v2 |
| Passport (`#page-passport`) | Unchanged from v2 |
| Home (`#page-home`) | **Fully redesigned** per §3.5 |

**Phases (Home):**

| Phase | Status |
|-------|--------|
| A — Waiting | Built — headline, live `HH:MM:SS` countdown, subline. Countdown only counts down on the actual check-in day (see §14.4 known issue). |
| B — Arriving | Built — door code, elevator code + QR (if applicable), WiFi, floor label, walkthrough **placeholder**, "I'm checked in" CTA |
| C — Staying | Built — same daily key as B minus walkthrough; "Show arrival instructions" link (placeholder toggle) |
| D — Leaving | Built — same daily key as C + checkout date label + "I've checked out" CTA |
| Checkout Done (terminal, not one of the official 4 phases) | Built — thank-you card, driven by `isStayEnded()`/`guestConfirmedCheckout` |

**Real vs mocked in the daily-key hero:**

| Element | Source when live | Source in toolbar mock |
|---------|-------------------|--------------------------|
| Door code | `activeReservation.tuyaPassword` (real Firestore) | `'1234#'` |
| Elevator code + QR | `globals/elevator_code` (real, 36h stale check) | `'4521'`, fake `updatedAt` = now |
| WiFi name/pass | `checkin_apartments/{aptId}` (real) | `'Maxela_Guest'` / `'welcome2024'` |
| Floor label | Derived from `aptId` prefix (real logic either way) | Derived from mocked `aptId` |
| Door photo | `aptData.doorPhotoUrl` — **field doesn't exist yet anywhere**, always hidden | Always hidden (no mock value set) |
| Walkthrough | Static placeholder text | Same placeholder text |
| Location/Shuttle/Tours tab panels | Static placeholder text ("— Phase 3") | Same placeholder text |

**Not yet built (later phases):**
- Phase 2 — real walkthrough content ported from `checkin-details.html` (street arrows, elevator photos/video) into `#hero-walkthrough`
- Phase 3 — real Location & Parking / Airport Shuttle / Tours content in the 3 tab panels (currently placeholder text only)
- Phase 4 — visual/brand polish pass on the whole hero + toolbar-verified phases
- Registration copy fix (§3.7) — not applied in sandbox yet, still pending

### 14.3 Mock data reference

Toolbar mock values (see `_sbBuildMocks()` in the script, right above `init()`):

```js
guestId = 'SANDBOX_DEV_GUEST';
aptId   = elevatorToggle ? '6-2' : '0-4';   // toggled by State → Elevator

activeReservation = {
  id: 'MOCK001', roomCode: aptId,
  checkin, checkIn: checkin, checkout, checkOut: checkout,  // dates shift per phase — see below
  tuyaPassword: '1234#',
  guest: 'Latifa Al Mansoori',
  status: 'CONFIRMED'
};

guestData = {
  name: 'Latifa Al Mansoori',
  nameRoman: 'Latifa Al Mansoori',
  aptId,
  arrivalDate: checkin,
  checkoutDate: checkout,
  matchedReservationId: 'MOCK001',
  manualUnlock: manualUnlockToggle,           // State → Manual unlock
  blocked: false,
  guestConfirmedCheckin: (phase is staying/leaving/checkoutDone),
  guestConfirmedCheckout: (phase is checkoutDone)
};

aptData = {
  wifiName: 'Maxela_Guest',
  wifiPass: 'welcome2024',
  checkInTime: '15:00',
  rules: { apartment: 'Please keep noise low after 22:00.' },
  recommendations: { shartava: [] }
};

elevatorData = { code: '4521', display_code: '4521#', updatedAt: { seconds: Date.now()/1000 } };

allMatchedReservations = [activeReservation];
// + a second { ...activeReservation, id:'MOCK002', roomCode:'6-1' } when State → Multi-room is ON
```

**Dates per phase** (`checkin`/`checkout` relative to `tbilisiToday()`):

| Phase requested | `checkin` | `checkout` |
|------------------|-----------|------------|
| waiting | today + 1 | today + 4 |
| arriving / staying | today | today + 2 |
| leaving / checkoutdone | today − 1 | today |

### 14.4 Known issues in sandbox

- **Countdown shows `00:00:00` in Phase A.** `timeUntilCheckin()` (unchanged from v2, per §2 "explicitly unchanged") only returns a real countdown on the actual check-in day — it returns `0` on any other day. The toolbar mocks `checkin = today + 1` for the Waiting phase, so the countdown is always `0` when jumped to via the toolbar. This is not a sandbox bug — it reproduces v2's real behavior; the "Unlocks [date] at [time]" fallback copy from §3.5 Phase A spec is **not yet implemented** for the multi-day-out case (real gap, needs a follow-up prompt).
- **Door photo never renders.** No apartment record anywhere (Firestore or mock) has a `doorPhotoUrl` field yet — `#hero-door-photo` is always `display:none`. Needs an admin-side field before this can show real content.
- **`#tiles-grid` and `#what-you-booked` are still in the DOM, just hidden (`display:none`).** `renderTiles()` / `_renderTilesNow()` / `showBlockedScreen()` / `renderWhatYouBooked()` write to them unconditionally (unchanged JS) — removing the elements would throw. Not visible to users, safe to ignore.
- **Pre-existing duplicate `id="home-apt-name"`** (3 occurrences: one static + two inside `renderGreetingApt()` template-literal strings) — same as `checkin-guest-v2.html`, only one copy is ever in the live DOM at once, not a regression from this work.

**New IDs added vs `checkin-guest-v2.html`** (all in `#page-home` or the toolbar, nothing renamed or removed):
`countdown-display`, `hero-door-code`, `hero-door-copy`, `hero-elevator`, `hero-elevator-code`, `hero-elevator-qr`, `hero-elevator-qr-canvas`, `hero-wifi-name`, `hero-wifi-pass`, `hero-floor-info`, `hero-door-photo`, `hero-walkthrough`, `btn-checked-in`, `btn-show-walkthrough`, `hero-checkout-label`, `btn-checked-out`, `hero-thankyou`, `tab-location`/`tab-shuttle`/`tab-tours`, `panel-location`/`panel-shuttle`/`panel-tours`, `sb-toolbar` and its children (`sb-phase-row`, `sb-toggle-multiroom`, `sb-toggle-elevator`, `sb-toggle-manualunlock`).

### 14.5 Next steps for Cursor

Focus visually, in this order:

1. **Phase B (Arriving) daily-key card** — currently plain rows (label → big mono code → copy pill). Needs icons per code type (door/elevator/WiFi/floor), and clearer visual priority between the P0-daily door code and the rest.
2. **Phase A (Waiting) subline/countdown** — design the "Unlocks [date] at [time]" state for guests more than a day out (see known issue above); right now there's no visual treatment for it, only the live `HH:MM:SS` on check-in day itself.
3. **Tab bar (Phase 3 content)** — panels are plain placeholder text; once Location/Shuttle/Tours content is ported, they need real card/list layouts matching the hero's visual language.
4. **Door photo empty state** — currently just invisible; needs a "photo coming soon" placeholder treatment for apartments without one yet.
5. ~~**Multi-room apt-pills under the new hero**~~ — **done 2026-08-24**, see §14.6 below.

Use the dev toolbar to flip through all of the above live — no login or real reservation required.

### 14.6 Design fixes applied — 2026-08-24

Five specific fixes landed on top of the Phase 1 shell + color revert (§13). All verified live via the dev toolbar (screenshots + computed-style checks), no console errors, `node --check` clean.

1. **Phase A (Waiting) copy rewritten.** Headline is now "Your door code and instructions will appear here automatically."; subline cut to one sentence, "Return to this page at check-in time." The old "do not message us" line and the longer explanation are gone. `.hero-waiting__headline` / `.hero-waiting__sub` in `checkin-guest-sandbox.html`.
2. **Multi-room apt-pills resized to real touch targets** — 44px min-height, 15px/600-weight text, 22px radius, active = solid `#2C2C2A` no border, inactive = white with `2px solid #2C2C2A`. Added `#multi-room-label` ("Your apartments — tap to switch", 11px uppercase muted) above the pill row — only ever rendered when `allMatchedReservations.length > 1` (built directly into `renderGreetingApt()`'s multi-room branch, so it never appears in the single-room case — functionally identical to a hidden/shown element without an extra DOM node needing separate visibility JS).
3. **Typography darkened and given real weight.**
   - `--muted` token: `#8C8C8A` → `#4A4A48` (global — every screen, not just home).
   - `body` gets an explicit `font-weight:400` floor.
   - Guest name → 700 (Playfair Display 700 roman added to the Google Fonts `<link>` so it's real bold, not browser-synthesized).
   - Card titles (`.subpage-title`, `.modal-title`, `.ci-title h2`, `.lc-title`, `.auth-greet h1`, and the shared serif-title rule) → 600.
   - Section/field labels (`.dk-label`, `.dk-wifi-sublabel`, `.auth-row__label`, `.form-label`) → 500.
   - Door/elevator/WiFi mono values (`.dk-code`, `.dk-wifi-val`) → 700, `letter-spacing:0.12em`.
   - Buttons (`.auth-cta`, `.dk-copy`) → 600.
   - Uppercase mono labels on the redesigned home screen → `letter-spacing:0.06em` (see §13.1 note on scope — pre-existing v2 labels elsewhere were left at their original values).
4. **Post-checkout screen rewritten.** No emoji, no "thank you for staying with us." Headline "Until next time." (Playfair italic, 26px); body "Your access has ended. We hope your stay was comfortable. If you left anything behind or need assistance, contact us on WhatsApp." (`#4A4A48`, 15px, line-height 1.6); a real "Contact host" button (new `.hero-cta__btn--secondary` class — white bg, `1.5px solid #2C2C2A` border) linking to `https://wa.me/`+the existing `WA` constant, set via `setAttribute('href', …)` at render time in both `applyHomePhase()` and the toolbar's `_sbRenderHomeForPhase()`.
5. **Registration name-field copy rewritten** in all 4 languages (EN/KA/RU/AR) — field label, input placeholder, and instruction line. Also fixed a **pre-existing bug**: `#t-search-instructions` was never wired into `applyTranslations()`'s id→key map, so the instruction text never actually changed on language switch (it silently stayed English) — added `'t-search-instructions':'searchInstructions'` to that map so all 4 languages now genuinely apply. Verified via `setLang()` in-browser for all 4 languages.

---

## 15. Prompts & Build Log

### Phase 1 — Sandbox Shell

The exact Claude Code prompt that produced the first version of `checkin-guest-sandbox.html` (§14, `guest-sandbox-shell` workstream):

```
Read these files in this order before doing anything else:
1. GUEST_CHECKIN_REDESIGN.md — source of truth for this redesign
2. CHECKIN_GUEST_SPEC.md — full technical audit of the current page
3. checkin-guest-v2.html — the live production file (DO NOT EDIT THIS)

---

TASK: Phase 1 — guest-sandbox-shell

Claim workstream `guest-sandbox-shell` in GUEST_CHECKIN_REDESIGN.md §9
(update the table: owner = Claude Code, date = today, status = active).

Create a new file: `checkin-guest-sandbox.html`

This file is a COPY of checkin-guest-v2.html with the home screen
(#page-home) rebuilt to match the new IA from §3.5 of GUEST_CHECKIN_REDESIGN.md.
Everything else (registration, rules, passport, all JS logic) stays identical.

---

WHAT TO BUILD — HOME SCREEN ONLY:

Replace the current #page-home contents with the new layout. The JS
module script stays 100% unchanged. You are only changing HTML structure
and CSS inside the home page div.

NEW HOME STRUCTURE (top to bottom):

1. TOP BAR
   - Left: "Maxela" wordmark (Playfair Display italic)
   - Right: language pill + sign out (keep existing elements, same IDs)

2. GREETING
   - "Welcome, [name]" — Playfair Display italic, large
   - Apartment name below — Inter, muted
   - Multi-room apt pills if applicable (keep #apt-area, .apt-pill, .apt-pills,
     .active — JS controls these)

3. HERO SECTION — 4 phases (controlled by JS via CSS classes on #page-home)
   Add class `phase-waiting`, `phase-arriving`, `phase-staying`, `phase-leaving`
   to #page-home. CSS shows/hides the right hero panel per phase.
   JS will set the class — for now just build the HTML for all 4 panels
   and show phase-arriving by default for visual testing.

   PHASE A — .hero-waiting
   - Large headline: "Your check-in instructions unlock here"
   - Big countdown display: HH:MM:SS (id="countdown-display")
   - Subline: "Come back to this page at check-in time.
     Door code appears automatically — do not message us."
   - No codes shown

   PHASE B — .hero-arriving
   - Door/smart-lock password (id="hero-door-code") — large, monospace, copy button
   - Elevator QR + numeric code section (id="hero-elevator") — only if needsElevatorCode()
     [keep same visibility logic, just restructure HTML]
   - WiFi: network name (id="hero-wifi-name") + password (id="hero-wifi-pass") — copy buttons
   - Floor info + apartment door photo (img, id="hero-door-photo")
   - Full walkthrough section (id="hero-walkthrough") — placeholder for Phase 2
   - Primary CTA button: "I'm checked in" (id="btn-checked-in")
     onclick: window.guestCheckedIn() — we will implement the function

   PHASE C — .hero-staying
   - Same as B but WITHOUT #hero-walkthrough
   - Small link: "Show arrival instructions" (id="btn-show-walkthrough",
     onclick toggles #hero-walkthrough visibility)
   - No "I'm checked in" button

   PHASE D — .hero-leaving
   - Same daily key as C (door + elevator + WiFi + floor photo)
   - "Checkout today" label
   - CTA button: "I've checked out" (id="btn-checked-out")
     onclick: window.guestCheckedOut()

4. THREE TABS (always visible, all phases)
   Tab bar: Location & Parking | Airport Shuttle | Tours
   (ids: tab-location, tab-shuttle, tab-tours)
   Tab panels below (ids: panel-location, panel-shuttle, panel-tours)
   - Location panel: placeholder text "Address and parking info — Phase 3"
   - Shuttle panel: placeholder text "Airport shuttle booking — Phase 3"
   - Tours panel: placeholder text "Tours and city guide — Phase 3"
   Default active: tab-location

---

NEW JS FUNCTIONS TO ADD (add at bottom of script module, before closing):

window.guestCheckedIn = async function() {
  // Write guestConfirmedCheckin: true + guestConfirmedCheckinAt: serverTimestamp
  // to checkin_guests/{guestId} (merge)
  // Then flip #page-home class from phase-arriving to phase-staying
  // Toast: "Welcome! Enjoy your stay."
}

window.guestCheckedOut = async function() {
  // Write guestConfirmedCheckout: true + guestConfirmedCheckoutAt: serverTimestamp
  // to checkin_guests/{guestId} (merge)
  // Toast: "Safe travels! Hope to see you again."
  // Then show a simple thank-you message (replace hero with thank-you text)
}

window.isStayEnded = function() {
  // Per §4.2 of GUEST_CHECKIN_REDESIGN.md:
  // if guestData.guestConfirmedCheckout === true → return true
  // if today > checkoutDate → return true
  // if today === checkoutDate AND tbilisiHour() >= 20 → return true
  // return false
}

---

PHASE LOGIC — add after showHome() renders, before first renderTiles():

function applyHomePhase() {
  // Reads: guestData.guestConfirmedCheckin, guestData.guestConfirmedCheckout,
  //        isUnlocked(), isStayEnded(), tbilisiToday(), activeReservation.checkout
  // Sets class on #page-home: phase-waiting / phase-arriving / phase-staying / phase-leaving
  // Call this whenever guestData updates (checkin_guests onSnapshot already fires on change)
}

---

CSS DIRECTION (add in <style> block, do not remove existing styles):

Keep all existing CSS variables. Add:

:root {
  --r:   12px;
  --rs:  12px;
  --rsm: 6px;
  --rl:  20px;
  --rxl: 24px;
  --shadow-card: 0 2px 12px rgba(0,0,0,0.06);
}

Hero card (.hero-card):
  background: var(--ink); color: #fff; border-radius: var(--r);
  padding: 24px; margin-bottom: 16px;

Door code display:
  font-family: var(--mono); font-size: 36px; letter-spacing: 0.15em;

CTA buttons (phase-arriving, phase-leaving primary):
  border-radius: var(--rxl); width: 100%; background: var(--accent);
  color: var(--ink); font-weight: 600; padding: 16px; font-size: 16px;

Tab bar:
  display: flex; border-bottom: 1.5px solid var(--line);
  Active tab: border-bottom: 2px solid var(--ink); font-weight: 600;

---

VERIFY BEFORE COMMITTING:
1. python3 -m py_compile — N/A (HTML file), but run node --check on the
   extracted <script type="module"> block
2. Confirm all existing JS-referenced IDs from CHECKIN_GUEST_SPEC.md §2
   still exist in the DOM (grep for: #loading, #page-register, #page-rules,
   #page-passport, #page-home, #r-name, #r-arrival, #r-contact, #tiles-grid,
   #apt-area, #svc-modal, #req-detail-modal, #qr-fullscreen-overlay,
   #lightbox, #toast)
3. Confirm .active, .hidden, .locked, .copied classes are not renamed
4. Open the sandbox URL and manually test: register flow still works,
   home shows phase-arriving by default, tabs switch, I'm checked in button
   shows toast

THEN:
- git add checkin-guest-sandbox.html
- Update GUEST_CHECKIN_REDESIGN.md §9 workstream table + §12 changelog
- git commit -m "Phase 1: guest sandbox shell — new home IA (countdown + access hero + 3 tabs)"
- git pull --rebase origin main
- git push
- Report: sandbox URL + what works + what is placeholder for Phase 2
```

---

## 16. Sandbox 2 — Cursor design proposal (2026-08-24) — **canonical since 2026-08-25**

**File:** `checkin-guest-sandbox-2.html`  
**URL:** https://app.maxelaapartments.com/checkin-guest-sandbox-2.html  
**Status:** Host chose this over Sandbox 3. **Continue all redesign work here.** Does not replace production until cutover.

| Difference vs Sandbox 1 | Why |
|-------------------------|-----|
| Compact greeting (24px name, less padding) | Codes + arrival path own the first viewport |
| Waiting shows a **live countdown** to check-in (including days before) | Guests want time remaining, not a static date card |
| Waiting copy: short “Available in” + one plain line | Dropped italic “They unlock…” and the messaging hint |
| **Elevator first** (QR + 6-digit under, **no Copy**) | Building pad is typed; entrance is the arrival bottleneck |
| Door slim; **WiFi strip** + **Location | Parking** side-by-side | Unlocked: no Airport/Tours; parking opens new window (video) |
| Multi-room **square tiles** (2–4 apartments) | Clear tap targets; no bottom sheet |
| **Companion guest link** on home (`?res=&companion=1`, skip passport) | Every guest needs building QR; only lead uploads passport once |
| **I'm checked in** with hint + subtle pulse | Guests should know to tap when inside |
| Floor & door card **removed** from Sandbox 2 IA | Not needed on arriving screen |
| Photo peek / scroll carousel **removed** | Walkthrough stays as scrollable step cards only |
| Airport/Tours **only while Waiting** | After unlock, Location + Parking only |

Same tokens as §13 (white cards, ink CTA). This is a **layout proposal**, not a token fight.

---

## 17. Companion guests + parking (locked product rule — 2026-08-24)

**Problem:** Multi-guest bookings (families, groups) all need the **building elevator QR/code**. Only **one** guest should upload a passport (lead booker).

**Rule:**
- Lead guest: normal flow — register → house rules → **passport** → home.
- **Companion guests:** share a link that opens the **same reservation** with **`companion=1`** — register → house rules → **skip passport** → home (QR + codes only).

**Link format (Sandbox 2 prototype):**

```
https://app.maxelaapartments.com/checkin-guest-sandbox-2.html?res=BOOKING_REF&companion=1
```

`BOOKING_REF` = MiniHotel `reservationNumber` on the matched reservation (same value used for multi-room sibling lookup).

**UI:** Unlocked home shows **“Copy link for other guests”** card (`#guest-invite-card`). Host/admin messaging should include this link when sending check-in instructions to groups.

**Parking:** Location and Parking are **separate** buttons on unlocked home. **Parking** opens a **new browser tab** (`window.open`) — either `locationInfo[prop].parkingPageUrl` (external page) or `?view=parking&apt=ROOM` (built-in parking video page from `parkingMediaUrl`).

**Admin config fields (existing / to add):**
- `locationInfo[prop].parkingMediaUrl` — video/image (already in admin)
- `locationInfo[prop].parkingPageUrl` — optional dedicated parking page URL (new, optional)

**Cutover:** Port companion link + parking split to `checkin-guest-v2.html` with same URL params and Firestore flag `companionGuest: true`.

---

## 18. Sandbox 2 — current build state (2026-08-25, canonical)

**File:** `checkin-guest-sandbox-2.html`  
**URL:** https://app.maxelaapartments.com/checkin-guest-sandbox-2.html  
**Decision:** Host confirmed Sandbox 2 is **much better** than Sandbox 3 and all ongoing redesign work continues here. **Do not modify Sandbox 2's IA unless the host asks.** Sandbox 3 is a separate experiment (§19).

### 18.1 What Sandbox 2 is

Same Firebase/JS module as production `checkin-guest-v2.html` (registration, unlock, multi-room, services, companion flow). Only `#page-home` + registration/rules/passport **CSS/HTML polish** differ from v2. Dev toolbar at bottom (`#sb-toolbar`, label "Sandbox 2 · Cursor design") — jump Loading / Register / Rules / Passport / Home + phases without Firebase.

### 18.2 Built and live on Sandbox 2 (Cursor, Aug 2025)

**Registration (`#page-register`)**
- Divider line under phone / contact row
- **Approximate arrival time** — chip grid `#checkin-time-grid`, hidden `#r-checkin-time`; Tbilisi-aware slots: `Before 15:00` first, then hourly 15:00–23:00, After midnight, Next morning; red warning if same-day before 15:00; saves `expectedCheckInTime` / `expectedCheckInWindow`
- Copy: "Use the name on your booking — not your passport"

**Rules (`#page-rules`)**
- Emojis replaced with inline SVG icons (noise, smoking, care)
- Entrance-card rule subcopy: "Don't damage property or lose entrance cards **(if provided)**"

**Passport (`#page-passport`)**
- Header: "Passport photo" + lowercase "required" (not cramped "Passport photoREQUIRED")

**Home — Waiting phase**
- Live countdown `#countdown-display` in hero
- **Location | Shuttle | Tours** tabs **under countdown**, above "What you booked"
- Stronger `.wyb-kicker` heading (not tiny pale mono)

**Home — Unlocked (arriving / staying / leaving)**
- Top row: **Location | Parking** buttons (not Airport/Tours after unlock)
- Elevator QR + 6-digit code (QR stacked above code; no copy on elevator)
- Door code + compact WiFi strip
- **Share access with your group** (`#guest-invite-card`) **under apartment door code** (not after WiFi)
- **Staying phase:** Location/Parking row hidden; horizontal scroll **service chips** (Tours first, then admin-visible services + "Services" pill) via `_renderHomeQuick()`
- **QR scroll:** `_nudgeHomeScrollOnce()` — auto-scroll to elevator QR **once** on first home open only (fixed bug where `renderTiles()` re-scrolled every ~30s)

**Design tokens:** §13 still applies (white cards, ink text, `#2C2C2A` primary CTA, no gold backgrounds on home).

### 18.3 Build status (updated 2026-08-25 — Claude, `inline-checkin-access`)

**Done:**

| Task | Notes |
|------|-------|
| **Real arrival walkthrough** in `#hero-walkthrough` | Was already fully built (HTML/CSS/`_renderWalkthrough()`/lightbox/toggle) as of this session's start — this table was stale. Verified live: 5 mock photo cards with captions render in Arriving, tap opens `#lightbox` with prev/next, Staying phase collapses to the single door-photo card, "Show arrival instructions" expands/collapses correctly (`.wt-expanded`), Leaving phase hides it. No changes needed beyond verification. |
| **Waiting tab panels** — real Location / Shuttle / Tours | Built 2026-08-25. `#panel-location` shows real address + "Open in Google Maps" + parking blurb via a new shared `_getLocationData()` helper (extracted from `openPage('location')`'s inline logic — same data, one source of truth now). `#panel-shuttle`/`#panel-tours` show the same service catalog the Staying-phase chips use (`_getGuestServicesCatalog()` — respects admin `sectionVisible()` toggles) with a "Request pickup"/"Ask about tours" button that opens the real `openSvc()` request modal — works pre-arrival since it only needs `guestId` (set at registration), not unlock. |
| **Bug fix:** service-chip buttons silently did nothing on click | `onclick="...openSvc('id',${JSON.stringify(nm)},...)"` embeds a JSON string's literal `"` characters inside a double-quoted HTML attribute, truncating it and corrupting the rest of the tag — every service chip with this pattern was unclickable (not just new code; this also affected the existing Staying-phase `_renderHomeQuick()` chips). Fixed by escaping `"` → `&quot;` before interpolating. **If you copy this `onclick`-with-`JSON.stringify` pattern anywhere else, escape it the same way or use `addEventListener` instead.** |

**Still open:**

| Priority | Task | Notes |
|----------|------|-------|
| P1 | **"Unlocks [date] at [time]"** when check-in is days away | Countdown shows `00:00:00` in toolbar Waiting phase — see §14.4 |
| P2 | Phase 4 visual polish pass | Icons on daily-key rows, door-photo empty state |
| Cutover | Promote Sandbox 2 → `checkin-guest-v2.html` | Host approval only |

### 18.4 Do not regress

- All element IDs listed in §13.5 + §14.4
- `searchReservation()`, multi-room pinning, unlock math, elevator stale check
- `#tiles-grid` hidden but must exist (`renderTiles()` writes to it)
- Companion link: `?res=BOOKING_REF&companion=1` (§17)
- New: `_getLocationData()` (shared by `openPage('location')` and `_renderWaitingTabsContent()`) and `_renderWaitingTabsContent()` (guarded by `_waitingTabsRendered` — fetches admin config once, not on every render)

---

## 19. Sandbox 3 — functional portal experiment (parked, 2026-08-25)

**File:** `checkin-guest-sandbox-3.html`  
**URL:** https://app.maxelaapartments.com/checkin-guest-sandbox-3.html  
**Status:** Built and merged to `main`, but **not** the chosen direction. Host will revisit later.

**What it is (different UX, not a reskin):**
- **Check-in wizard** — 3-step progress (Booking → Rules → Verify ID)
- **Bottom nav guest portal** — Access | Guide | Services | Help
- **Access tab** — digital key card (door code), elevator QR, WiFi, group invite, "I'm checked in"
- **Guide tab** — location/parking, waiting tabs, walkthrough, what you booked
- **Phase defaults** — Waiting → Guide; Arriving/Staying → Access; Leaving → Help

**Implementation:** Same `<script type="module">` as Sandbox 2 with thin adapters (`switchPortalTab`, `_portalDefaultTab`, service chip mirror). **Do not merge into Sandbox 2 without host approval.**

**History:** First Sandbox 3 was a Harbor/teal color reskin (rejected). Second rebuild = functional portal inspired by Staykey / Guesty / ChargeAutomation one-link guest portals.

---

## 20. Prompt for Claude — continue Sandbox 2

Copy everything inside the block below into Claude / Claude Code:

```
Read these files in this order before doing anything:
1. GUEST_CHECKIN_REDESIGN.md — especially §0, §9, §13, §16, §17, §18, §20
2. CHECKIN_GUEST_SPEC.md — technical audit (IDs, fragile areas)
3. checkin-guest-sandbox-2.html — THE file to edit (canonical redesign)
4. checkin-details.html — source for arrival walkthrough content to port

DO NOT EDIT:
- checkin-guest-v2.html (production — cutover only with host approval)
- checkin-guest-sandbox-3.html (parked portal experiment — §19)
- checkin-guest-sandbox-2.html registration/unlock/search JS logic unless fixing a bug

CONTEXT FROM CURSOR (2026-08-25):
The host chose Sandbox 2 over Sandbox 3. Sandbox 2 is live at:
https://app.maxelaapartments.com/checkin-guest-sandbox-2.html

Sandbox 2 already has (Cursor, merged to main):
- Registration: arrival time chip picker (Tbilisi), phone divider, booking-name copy
- Rules: SVG icons, entrance-card "(if provided)" copy
- Passport: clean "Passport photo" + "required" header
- Waiting: countdown + Location/Shuttle/Tours tabs under countdown + What You Booked
- Unlocked: elevator QR first, door code, WiFi strip, Location|Parking, group invite under door code
- Staying: horizontal service chips (admin visibility from checkin_admin/config)
- One-time scroll to QR on first home open (not on every renderTiles refresh)
- Dev toolbar at bottom for phase testing without Firebase

YOUR TASK — claim workstream `inline-checkin-access` in §9:

Focus on Sandbox 2 Phase 2: real check-in walkthrough in #hero-walkthrough.

1. Open checkin-guest-sandbox-2.html, use dev toolbar → Home → Arriving (mock has 5 photos in aptData.photos + photoCaptions).

2. Port the arrival instruction experience from checkin-details.html into #hero-walkthrough-list:
   - Step cards with photo + caption (use existing .wt-card / .wt-list structure)
   - Lightbox for photo tap (existing #lightbox)
   - "Show arrival instructions" toggle on staying phase (#btn-show-walkthrough, .wt-expanded)

3. Optionally improve waiting-phase tab panels (#panel-location, #panel-shuttle, #panel-tours) with real content stubs — Location already works via openPage('location') when unlocked; waiting guests need useful pre-arrival info.

4. Keep §13 design tokens: white cards, ink text, #2C2C2A CTAs, no gold button backgrounds.

5. Do not rename JS-referenced IDs (§13.5). Do not change unlock math, searchReservation(), or applyHomePhase() phase rules.

VERIFY:
- Dev toolbar: Waiting, Arriving, Staying, Leaving, Checkout Done — no console errors
- Walkthrough renders with mock photos in Arriving
- Register → rules → passport flow still works on real Firebase if tested

WHEN DONE:
- Update GUEST_CHECKIN_REDESIGN.md §9 (mark workstream progress) and §12 changelog
- git commit on a descriptive branch, push, open PR or merge per team workflow
- Report: sandbox URL + screenshots of walkthrough + what's still placeholder
```

---

## 21. Coordination Protocol — Claude Code + Cursor (2026-08-25)

> Both tools edit `checkin-guest-sandbox-2.html` in the same repo, often in the same
> day, with no lock. This section is the traffic protocol. Follow it exactly — it
> exists to prevent silently overwriting each other's work.

### WHO OWNS WHAT IN `checkin-guest-sandbox-2.html`

| Area | Owner | Notes |
|------|-------|-------|
| `#hero-walkthrough`, walkthrough JS | Claude Code | Phase 2 inline check-in |
| `#panel-location`, `#panel-shuttle`, `#panel-tours` tab content | Claude Code | Phase 3 |
| `.apt-pill`, `#multi-room-label` | Claude Code | Multi-room UI |
| Registration form copy (`T={}` translations) | Claude Code | Copy fixes |
| All CSS in `<style>` block | Cursor | Design tokens, typography, spacing |
| Phase A/B/C/D hero layout | Cursor | Visual design of each phase |
| Dev toolbar | Claude Code | Do not restyle unless broken |
| `checkin_apartments` data rendering | Cursor | Photos, captions, amenities |

Ownership is by area, not by exclusivity of edit rights — the other tool may still
need to touch an area it doesn't own (e.g. Claude Code fixing a CSS-caused JS bug).
When that happens, keep the edit minimal and say so in the commit message; don't
redesign or restructure the owner's area.

### BEFORE STARTING ANY SESSION

1. `git pull origin main` — always, before touching anything.
2. Check `git log --oneline -5 -- checkin-guest-sandbox-2.html` to see what changed
   since your last session.
3. If the file was touched in the last 2 hours by the other tool, read those commits
   before editing: `git show <commit> -- checkin-guest-sandbox-2.html`.

### BEFORE COMMITTING

1. `git pull --rebase origin main`.
2. Resolve any conflicts — never force push.
3. Commit message format:
   - Claude Code: `feat/fix/style(scope): description`
   - Cursor: `style(design): description` (already following this)

### IF THERE IS A CONFLICT

- CSS conflicts: Cursor's version wins.
- JS/logic conflicts: Claude Code's version wins.
- HTML structure conflicts: stop and report to Nika before resolving.

### NEVER touch in the same session

- `checkin-guest-v2.html` (production)
- `checkin-guest-sandbox-3.html` (parked)
- `minihotel_reservation_sync.py`
- `checkin-admin.html` (separate track — rebuild goes in `checkin-admin-sandbox.html` per §22)

---

## 22. Admin mobile redesign — host decisions locked (2026-08-26)

**File to build:** `checkin-admin-sandbox.html` (copy/adapt from `checkin-admin.html`)  
**Spec audit:** `CHECKIN_ADMIN_SPEC.md`  
**Do not edit live** `checkin-admin.html` until cutover.

Host uses admin on phone daily for three jobs: **today's arrivals**, **grant access**, **elevator QR/code**. Desktop can stay dense later; **mobile is the product**.

### 22.1 Shell — bottom nav (like Sandbox 3 guest portal)

Host liked Sandbox 3's **bottom horizontal app menu**. Admin mobile uses the same pattern:

| Tab | Purpose |
|-----|---------|
| **Today** | Today's arrivals list (default home on phone) |
| **Elevator** | Elevator / entrance code + QR — first-class, not buried in Settings |
| **Guests** | Search, current guests, upcoming, failed searches |
| **More** | Apartments, Requests, HK Pins, Guest Page Settings, Sign out |

Desktop may keep a sidebar; on ≤640px the sidebar is replaced by this bottom nav.

### 22.2 Screen — Today's Arrivals

Vertical **cards** (not a 5-column grid). Today's arrivals first.

Each card:
- Room (mono) + **status pill**
- Guest name
- Check-in → check-out dates
- Actions: WhatsApp · Grant Access (always visible on card)

**Status pills (locked):**

| Status | Source |
|--------|--------|
| `NO FORM` | Reservation today, no matching `checkin_guests` form |
| `AWAITING UNLOCK` | Form exists, not unlocked |
| `UNLOCKED` | `manualUnlock` / unlock rules |
| **`CHECKED IN`** | `guestData.guestConfirmedCheckin === true` (guest tapped "I'm checked in" on guest portal) |

Filter chips optional: All · Need unlock · Checked in · Unlocked · No form.

### 22.3 Screen — Guest detail (full-screen on mobile)

- Full-screen overlay/page (not side drawer).
- **Do not show passport photo by default.** Privacy + clutter.
- Show a button: **“Check passport”** → expands or opens lightbox only when host taps.
- Approve / Reject ID only after passport is opened (or adjacent to that section).
- Room block(s): door code, unlock status, **Grant Access** primary CTA, WhatsApp.
- Multi-room = stacked blocks.

### 22.4 Screen — Elevator (dedicated bottom-nav tab)

Host workflow:
1. External app often uploads codes to Firestore/RTDB automatically.
2. If that fails, host **pastes** the QR payload (decoded numbers) and/or **types/pastes** the display code, then taps Update.
3. **Manual update must stick** — after a successful manual save, that value must remain what guests see until the next intentional update (auto or manual). Silent fail / dual-write half-success is not acceptable.

**UI required:**
- Large current **display code** + QR preview from `qr_code`
- Relative timestamp: “Updated X min ago” + source badge: `Auto` vs `Manual`
- Freshness: green &lt;2h · amber 2–8h · red &gt;8h
- Two inputs: Display code · QR value (paste-friendly, `font-size:16px+`)
- Update button with loading / success / **error on card** (never silent)
- Live listener preferred so auto-app updates appear without refresh

**Data rule (implement in sandbox):**
- Write **both** RTDB and Firestore; if either fails → show error, do not claim success.
- On manual save, set `source: 'manual'` (or equivalent) + `updatedAt`.
- Auto-uploader may overwrite later with newer `updatedAt` (normal daily rotation). Manual save must not appear to “revert” or vanish immediately due to load race / one store lagging.
- Show which store is displayed if they diverge.

### 22.5 Design tokens (admin ≠ guest)

Keep admin operational (not guest Sandbox 2 warm serif look). Single token set — no parallel `--gs-*` / `--apt-*` / raw `.go-*` hex forks.

Suggested start (tunable): DM Sans + DM Mono; bg `#f7f6f4` or cooler `#F4F5F7`; surface white; ink `#1e1c1a`; green `#2d6a4f`; red `#922b21`; amber `#7a5a0a`; radius 10 / 6 / 20.

Host does **not** want guest Sandbox 1/Claude decorative UI carried into admin.

### 22.6 Out of scope for first admin sandbox slice

- Full Apartments editor polish
- Redesigning every Guest Page Settings card (elevator moves to its own tab; rest can stay under More)
- Production cutover

### 22.7 Prompt for Claude (admin sandbox)

```
Read: CHECKIN_ADMIN_SPEC.md, GUEST_CHECKIN_REDESIGN.md §8 + §22, CODEBASE.md.
Do NOT edit checkin-admin.html. Create checkin-admin-sandbox.html.

Build mobile-first shell with bottom nav: Today | Elevator | Guests | More.
Implement §22.2–§22.4 exactly:
- Today = arrival cards + statuses including CHECKED IN (guestConfirmedCheckin)
- Detail = full screen; passport behind "Check passport" button
- Elevator = first-class tab; dual-write reliable; manual sticky; freshness + Auto/Manual source
Claim admin-redesign in §9. No visual guest-page cloning.
```

---

### 22.8 Build started (Cursor — 2026-08-26)

**File:** `checkin-admin-sandbox.html`  
**URL (after push):** https://app.maxelaapartments.com/checkin-admin-sandbox.html  
**Owner:** Cursor (`admin-redesign` workstream)

Shipped:
- Password gate (same as live admin)
- Bottom nav: **Stay | Elevator | Apts | More**
- **Stay** — Overview stacks arrivals today, leaving today, in-house, upcoming (7 days). Filters + search + tappable stats. Statuses: NO FORM · AWAITING UNLOCK · UNLOCKED · CHECKED IN
- Guest detail full-screen; passport behind **Check passport**; jump to apt instructions editor
- **Elevator** — dual-write RTDB+Firestore, freshness dots, Auto/Manual source
- **Apts** — room list with occupancy (who’s in / leaving / next arrival); full editor for Tuya/manual lock, check-in/out times, WiFi, written instructions, video URL, photo steps (Cloudinary upload/reorder/replace/delete). Saves to `checkin_apartments` (preserves `rules`)
- More → full `checkin-admin.html` for guest page settings / debugger

Still via full admin / later slices: Requests, HK Pins, Guest Page Settings editor, search-failure queue.

---

## Quick checklist before any major step

- [ ] I re-read §1–§5 and §7  
- [ ] Guest work is in **`checkin-guest-sandbox-2.html`**, not production, unless this is cutover  
- [ ] Admin work is in **`checkin-admin-sandbox.html`** per §22, not live admin, unless cutover  
- [ ] My workstream is claimed in §9  
- [ ] I am not editing a file another agent claimed  
- [ ] I will update §9 and §12 when finished  
