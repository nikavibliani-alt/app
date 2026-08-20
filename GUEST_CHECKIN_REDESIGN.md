# Guest Check-in Redesign — Shared Source of Truth

> **READ THIS FILE before every major step.**  
> Used by Cursor Cloud Agent and Claude / Claude Code.  
> Do not start coding a section until it is claimed below and the system model in §2–§4 is still accurate.

**Status:** System model agreed in principle — visual design NOT started  
**Primary file:** `checkin-guest-v2.html`  
**Do not touch:** `checkin-admin.html`, `minihotel_reservation_sync.py`  
**Related (may change later):** `checkin-details.html` (content likely moves into home)  
**Firebase project:** `sleepy-5c962`  
**Live URL:** https://app.maxelaapartments.com/checkin-guest-v2.html  
**Spec audit:** `CHECKIN_GUEST_SPEC.md` · **System map:** `CODEBASE.md`

---

## 0. How Cursor and Claude work together

### Rules (non-negotiable)

1. **Read this file first** at the start of every session and before every PR / major edit.
2. **Claim a workstream** in §8 before editing. Put your name/tool, date, and file list.
3. **One owner per file at a time.** If `checkin-guest-v2.html` is claimed, the other agent does not edit it until the claim is released.
4. **Do not redesign and rewrite logic in the same pass** unless this doc says that phase is open.
5. **Preserve unlock / search / registration behavior** unless §4 explicitly lists a change.
6. **Update this doc** when you finish a chunk: mark the workstream done, note what changed, link commit/PR.
7. **Conflicts:** Prefer updating this doc and stopping over “fixing” overlapping CSS/HTML by force.

### Preferred split (default)

| Agent | Owns by default | Does not own |
|-------|-----------------|--------------|
| **Cursor** | Information architecture, home shell (locked countdown + unlocked check-in surface), coordination docs, wiring `isUnlocked` → home content | Deep services modal redesign, admin panel |
| **Claude / Claude Code** | Services section / services page UX, copy & translations polish, merging tour/instructions content from `checkin-details.html` once Cursor shells the home | Changing unlock math, reservation search, Firestore schema |

If either agent needs the other’s file: **update §8 claim**, wait until the other releases, then proceed.

---

## 1. Product problem (why we are redesigning)

### What happens today

1. Guest enters name + check-in date → system finds reservation.
2. After rules + passport, guest lands on a **tile menu** (Check-in Details, WiFi, Services, Location & Parking, etc.).
3. Check-in instructions live behind **Check-in Details** (`checkin-details.html`) — a second page guests must discover.
4. Guests **do not click** those tiles. They **WhatsApp the host** asking for check-in details.

### Root cause

The page is structured like an **app dashboard**. Guests treat it like a **key + instructions**. They need the answer on the first screen after registration — not a menu of options.

### Success criteria

- After booking is found and registration completes, the **main screen answers “how do I get in?”** without requiring another click.
- **Before unlock time:** main screen shows a clear **countdown** and states that check-in details appear here when the countdown ends (so guests stop texting early).
- **After unlock:** main screen **is** the check-in instructions (codes, steps, elevator/QR as applicable).
- **Services** are easy to find on/near that main screen (exact UI TBD — design phase later).
- Host receives fewer “where are my check-in details?” messages for guests who already completed registration.

---

## 2. Target guest flow (system — not visual)

Registration funnel stays. **Home meaning changes.**

```
Loading
  → Register (name + date [+ contact/guests as today])
  → House rules (3 checkboxes)
  → Passport upload
  → HOME (new role — see §3)
       ├─ LOCKED state  → countdown + “details unlock here at …”
       └─ UNLOCKED state → check-in instructions as the page itself
```

Returning guests with valid `localStorage` still go straight to HOME (same as today).

### Explicitly unchanged in v1 of this redesign

- `searchReservation()` scoring and sibling matching  
- Rules → passport order  
- `finishRegistration_()` Firestore / Storage writes  
- `isUnlocked()` rules (see §4)  
- Admin visibility config shape in `checkin_admin/config`  
- Multi-room `switchApt()` behavior (must still work on new home)  
- Blocked / post-checkout / preview modes (must still work)

---

## 3. New home information architecture

### 3.1 Main screen = Check-in (not a menu)

| State | What the guest sees first | What they must NOT need to do |
|-------|---------------------------|-------------------------------|
| **Locked** | Countdown to unlock + short message: check-in details will appear **on this page** at that time | Click “Check-in Details”, open another HTML file, or guess a tile |
| **Unlocked** | Check-in instructions content (door/access code, elevator if needed, step photos/video as today in `checkin-details.html`) | Navigate away to get codes |

### 3.2 Secondary content (still available, not primary)

Order of priority on/near home (system priority — layout TBD in design phase):

1. **Check-in / access** (primary — always above the fold when unlocked)  
2. **Services** (elevated — host wants a better services presence on main; design later)  
3. WiFi, Location & Parking, Recommendations, House Rules, Contact  

WiFi / location may remain as secondary links or compact sections. They must not compete with check-in for the first viewport.

### 3.3 Fate of `checkin-details.html`

**Decision (proposed — confirm before coding):**

- Phase A: Home renders the same content `checkin-details.html` already shows (locked card / tour / codes), so guests never need that URL.
- Phase B: `checkin-details.html` either redirects to `checkin-guest-v2.html` home or stays as a deep-link compatibility shim for old messages/bookmarks.

Do **not** delete `checkin-details.html` until Phase A works and old links are handled.

### 3.4 Tile menu

The current 2-column tile dashboard is **not** the primary IA after redesign.  
Tiles may remain as a compact “more” area below check-in + services, or be replaced — **design decision later**. System rule: nothing critical for arrival lives only behind a tile.

---

## 4. Unlock system (keep behavior; change presentation)

Source of truth today: `isUnlocked()` in `checkin-guest-v2.html` (mirrored in `checkin-details.html`).

```
today > arrival                          → UNLOCKED
today < arrival                          → LOCKED
today === arrival:
  manualUnlock === true                  → UNLOCKED
  hour >= checkInHour (default 15)       → UNLOCKED
  hour >= 11 AND hk_status.done === true → UNLOCKED
  else                                   → LOCKED
```

Times use Tbilisi (`tbilisiToday` / `tbilisiHour`).  
`aptData.checkInTime` drives the hour when set.

### Presentation rules for redesign

| Condition | Main screen |
|-----------|-------------|
| Locked, before arrival day | Show unlock date/time (“Available on 15 Aug at 15:00”) — countdown optional if multi-day away |
| Locked, on arrival day before hour | **Live countdown** + “Check-in details will appear on this page when the timer ends” |
| Unlocked (time or HK early or manual) | Show full check-in instructions immediately; no fake lock |
| Blocked | Keep existing “Access Revoked” behavior |
| Post-checkout | Keep existing thank-you / expired behavior |

### Polling (keep)

- Unlock poller (~30s) and HK poll (~60s) already exist — home must **auto-flip** from countdown → instructions without refresh when `isUnlocked()` becomes true.

### What NOT to change in unlock math (unless product asks)

- Do not move unlock earlier by default.  
- Do not show door codes while locked.  
- Do not remove `manualUnlock` or HK early unlock.

---

## 5. Services (system notes — design later)

Host requirement: **better services presence on the main page**, not buried as an equal tile.

**System constraints to preserve while redesigning UI later:**

- Reads: `checkin_admin/config.services`, `laundryItems`, visibility flags  
- Writes: `checkin_requests` + `service_requests` via existing `submitService()`  
- Modals: `#svc-modal`, `#req-detail-modal`  
- WhatsApp handoff must remain a user-gesture open  

**Design phase deferred.** When opened, claim workstream `services-ui` in §8. Do not invent new Firestore collections for v1.

---

## 6. Phased delivery (code only after phase opens)

| Phase | Goal | Code? | Owner (default) |
|-------|------|-------|-----------------|
| **0 — System agreement** | This doc; confirm IA + unlock presentation | Docs only | Cursor + host |
| **1 — Home shell** | Replace tile-first home with locked countdown / unlocked check-in host region; wire `isUnlocked` + poller | Yes — careful, minimal visual | Cursor |
| **2 — Inline check-in content** | Port `checkin-details.html` render logic into home unlocked region | Yes | Claude (or Cursor if free) |
| **3 — Services elevation** | Services block on/near main; improve services UX | Yes | Claude |
| **4 — Secondary IA + polish** | WiFi/location/recs placement, copy, motion, brand | Yes | Shared — claim first |
| **5 — Compatibility** | Redirect/shim `checkin-details.html`; verify multi-room, preview, blocked | Yes | Whoever finishes Phase 2 |

**Do not start Phase 1 coding until host confirms §7.**

---

## 7. Decisions needed from host (before code)

Answer these so agents do not guess:

1. **Registration still required before home?** (Assume YES — rules + passport stay.)  
2. **Before unlock, can guests still open WiFi / location / services / contact?**  
   - A) Yes, secondary links below countdown  
   - B) Only contact host until unlock  
   - C) Something else  
3. **Confirm unlock message intent:** “Details appear on this same page when countdown ends” — correct?  
4. **`checkin-details.html`:** keep as redirect later, or keep full duplicate for a while?  
5. **Services on main:** compact list on home vs. large section vs. single CTA into services — pick after Phase 1, or state preference now.

---

## 8. Workstream claims (edit this table)

| Workstream | Status | Owner | Files | Notes / PR |
|------------|--------|-------|-------|------------|
| `docs-coord` | **active** | Cursor | `GUEST_CHECKIN_REDESIGN.md` | Creating shared protocol |
| `home-shell` | blocked on §7 | — | `checkin-guest-v2.html` | Phase 1 |
| `inline-checkin` | blocked on Phase 1 | — | `checkin-guest-v2.html`, maybe `checkin-details.html` | Phase 2 |
| `services-ui` | blocked on design | — | `checkin-guest-v2.html` | Phase 3 |
| `visual-design` | not started | — | CSS in guest v2 | After system phases |
| `compat-redirect` | blocked on Phase 2 | — | `checkin-details.html` | Phase 5 |

**Claim format when you take work:**

```
| `home-shell` | active | Claude Code | checkin-guest-v2.html | Started 2026-08-20 — only #page-home locked region |
```

**Release format when done:**

```
| `home-shell` | done | Claude Code | checkin-guest-v2.html | PR #… — countdown wired to isUnlocked |
```

---

## 9. Fragile areas (do not regress)

From `CHECKIN_GUEST_SPEC.md` — treat as landmines:

- `searchReservation()` sibling match = exact `reservationNumber` only  
- Multi-room `activeReservation` pinning in `showHome()` / `switchApt()` (`_targetResId`, `_knownIds`)  
- `_homeLoading` + `_homeSnaps` teardown  
- Session clear on missing guest / checkout expiry  
- `needsElevatorCode()` room list (note: `7-3` missing today)

Any home rewrite must re-test: single room, multi-room switch, locked→unlocked flip, logout, preview `?preview=true`.

---

## 10. Out of scope for this redesign

- Admin panel UI (`checkin-admin.html`)  
- Reservation sync (`minihotel_reservation_sync.py`)  
- New Firebase collections / schema migrations  
- Multi-tenancy path changes  
- Changing Georgian passport requirement  

---

## 11. Changelog (agents append)

| Date | Who | Change |
|------|-----|--------|
| 2026-08-20 | Cursor | Created doc: problem, IA, unlock presentation, phases, claim protocol |

---

## Quick checklist before any major step

- [ ] I re-read §1–§4 of this file  
- [ ] My workstream is claimed in §8  
- [ ] I am not editing a file another agent claimed  
- [ ] I am not changing unlock/search/registration unless listed in an open phase  
- [ ] I will update §8 and §11 when finished  
