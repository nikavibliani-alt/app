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
| `guest-sandbox-shell` | done (Phase 1) | Claude Code | `checkin-guest-sandbox.html` | Do not overwrite while comparing |
| `guest-sandbox-2-design` | **active** | Cursor | `checkin-guest-sandbox-2.html` | 2026-08-24 — layout fixes: elev under QR (6-digit), photo walkthrough, apt sheet, tabs under greeting |
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
| 2026-08-23 | Claude Code | Phase 1 `guest-sandbox-shell` done: `checkin-guest-sandbox.html` created (copy of `checkin-guest-v2.html`, `#page-home` rebuilt per §3.5 — countdown hero + shared daily-key hero (door/elevator/WiFi/floor) + walkthrough placeholder + Checked in/out CTAs + 3 tabs). `applyHomePhase()`, `window.guestCheckedIn/guestCheckedOut/isStayEnded` added; JS module otherwise unchanged (pure additions, verified by diff). Register/rules/passport untouched. |
| 2026-08-24 | Claude Code | Added sandbox dev toolbar (`#sb-toolbar`) to `checkin-guest-sandbox.html` — jump to any screen/phase/state with full mock guest/reservation/apartment/elevator data, zero Firebase dependency (`_sbBuildMocks()`, `_sbRenderHomeForPhase()`, `_sbShowScreen()`, `_sbGoPhase()`, `_sbToggle()`). Added §14 Sandbox & Current Build State and §15 Prompts & Build Log (renumbered from §13/§14 on 2026-08-24 to make room for §13 Design Tokens & Rules). |
| 2026-08-24 | Claude Code | **Color fix:** home-screen hero card was shipped dark/inverted (black background, white text, gold `#C4A882` CTA) — reverted to the correct system: white cards (`#FFFFFF`), dark text (`#2C2C2A`/`#8C8C8A`), dark-filled primary CTA (`#2C2C2A`/`#fff`), no gold anywhere as a background. Split "I've checked out" into its own lighter-bordered "destructive/confirm" style, distinct from the bold primary "I'm checked in". Fixed the same gold-background violation on the dev toolbar's active-state buttons. Added §13 Design Tokens & Rules to lock this down for future work. |
| 2026-08-24 | Cursor | Sandbox 2 design proposal: `checkin-guest-sandbox-2.html` — compact greeting, date-or-countdown waiting, door-first stacked cards, large elevator QR, WiFi compact, door-photo empty state. Does not replace Claude sandbox 1. |
| 2026-08-24 | Cursor | Sandbox 2 layout fixes: elevator QR stacked above 6-digit code; photo step walkthrough from `photos`/`photoCaptions`; multi-room full-width switcher + bottom sheet; tabs moved under greeting (above hero). |

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

## 16. Sandbox 2 — Cursor design proposal (2026-08-24)

**File:** `checkin-guest-sandbox-2.html`  
**URL (after push to main):** https://app.maxelaapartments.com/checkin-guest-sandbox-2.html  
**Does not replace** `checkin-guest-sandbox.html` (Claude / Sandbox 1). Same phases, IDs, and toolbar. Compare side by side.

| Difference vs Sandbox 1 | Why |
|-------------------------|-----|
| Compact greeting (24px name, less padding) | Codes + arrival path own the first viewport |
| Waiting shows a **live countdown** to check-in (including days before) | Guests want time remaining, not a static date card |
| Waiting copy: short “Available in” + one plain line | Dropped italic “They unlock…” and the messaging hint |
| **Elevator first** (QR + 6-digit under, **no Copy**) | Building pad is typed; entrance is the arrival bottleneck |
| Door + WiFi in **one slim card** (door not 52px hero) | Guests won’t scroll if door fills the fold; WiFi was too tall |
| **“Don’t stop here ↓”** scroll cue into photo steps | Guests must notice walkthrough below the fold |
| Floor/door photo **after** walkthrough | Secondary once path photos exist |
| Walkthrough as **photo step cards** from `photos` + `photoCaptions` | Real check-in instructions are detailed photo guides |
| Multi-room: **full-width switcher** + bottom sheet | Guests could not find tiny room pills |
| Tabs **under greeting**, larger 14px labels | Visible while Waiting |

Same tokens as §13 (white cards, ink CTA). This is a **layout proposal**, not a token fight.

---

## Quick checklist before any major step

- [ ] I re-read §1–§5 and §7  
- [ ] Guest work is in **sandbox**, not production, unless this is cutover  
- [ ] My workstream is claimed in §9  
- [ ] I am not editing a file another agent claimed  
- [ ] I will update §9 and §12 when finished  
