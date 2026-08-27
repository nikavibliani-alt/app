# SYSTEM_CONNECTION_MAP.md — Maxela Operating System, Full Connection Map

**Read-only scan. Nothing in this repo was edited to produce this file.** Written from a direct re-read of the code (HTML apps, Python scripts, Cloud Functions, GitHub Actions workflows, Firebase config) on the current `main` branch — not from memory of prior sessions. Every collection name, function name, and workflow trigger below was verified by grep/read against the actual file at scan time.

This is the map of **what exists today**, organized by flow, so a bug can be traced by following one path instead of searching the whole system. No pipeline/controller redesign is proposed here — that's the next step, after this map.

---

## 0. System inventory — every important file, one line each

### Guest-facing
| File | Role |
|---|---|
| `checkin-guest-v2.html` | **Production** guest check-in page. Registration, passport upload, unlock logic, elevator/door code display, services. |
| `checkin-guest.html` | Old redirect stub (328 bytes) — still linked from several places as "the" check-in URL even though it's not the real page anymore. |
| `checkin-guest-sandbox.html` | Sandbox 1 (Claude's redesign track) — not production. |
| `checkin-guest-sandbox-2.html` | Sandbox 2 (Cursor's redesign track) — currently the host's chosen direction for the guest-side rebuild, still not production. |
| `checkin-guest-sandbox-3.html` | Sandbox 3 ("portal" experiment) — explicitly on the coordination doc's never-touch list; frozen/reference only. |
| `checkin-details.html` | **New, not previously mapped.** A details sub-page reading `maxela_v2_session`/`maxela_apt_id`/`maxela_guest_id` from `localStorage` and `reservations` from Firestore. Uses a **5th, different design system** (Playfair Display + Inter, `--ink`/`--bg` tokens) — matches none of DM Sans/DM Mono (guest v2 & admin), nor the sandboxes' own systems. |

### Admin-facing
| File | Role |
|---|---|
| `checkin-admin.html` | **Production** desktop admin — full audit already exists at [CHECKIN_ADMIN_SPEC.md](CHECKIN_ADMIN_SPEC.md). |
| `checkin-admin-backup.html` | A dated backup copy of the admin (Jul 25), sitting untracked-ignored in repo root. |
| `checkin-admin-sandbox.html` | **Sandbox** mobile-first admin rebuild — full audit given in this session's scan replies (Stay/Elevator/Requests/Apts/HK Pins/Guest page/Failed searches/Tab bar layout, unified `goBack()`). |
| `admin-search-test.html` | Standalone "Search Debugger" tool, linked from both admin UIs, reads `reservations` directly. |
| `hk-manage.html` | "HK Schedule Manager" — separate tool, no direct Firestore collection reads found in a grep pass (likely calls out to something else or is mostly static — **flagged for Cursor to verify**, see §9). |

### Housekeeping apps
| File | Role |
|---|---|
| `HK.html` | Generic HK app. Reads `checkin_guests`, `hk_pins`, `hk_status`, `properties`, `reservations`. |
| `HK-Shartava.html` | Shartava-property HK app. Same collections as `HK.html` plus `service_requests`. |
| `HK-Centre.html` | Centre-property HK app. Reads `checkin_guests`, `hk_status`, `properties`, `reservations` — **but uses `hk_cleaner`, not `hk_pins`**, for a per-room cleaner-assignment doc that the other two HK apps don't have at all. |

### Sleepy / PMS / financial
| File | Role |
|---|---|
| `SleepyPMS.html` | 176KB — the actual PMS/dashboard app. Owns the `properties` collection (its own room/rate master list — separate from `checkin_apartments`), reads/writes `reservations`, `prices`. |
| `SleepyDashboard.html` | "Sleepy PMS — Dashboard" — companion view, no direct Firestore collection reads found in this pass. |
| `index.html` | "Profit Split Tracker" — unrelated financial tool, not part of the check-in/booking system at all. |
| `import-reservations.html` | Manual reservation importer, writes `properties` + `reservations`. |
| `clear-reservations.html` | Danger-zone utility — bulk-deletes `reservations` docs. |
| `TukaTracker.html`, `VenuTracker Update.html` | Unscanned in this pass — not obviously connected to check-in/booking by name; **flagged for Cursor**, see §9. |
| `sleepy-notes.md`, `sleepy-styles.css`, `sleepy-tweaks.jsx`, `sleepy-tweaks-panel.jsx` | Supporting assets/notes for the Sleepy app, not independently scanned. |

### Pricing
| File | Role |
|---|---|
| `pricing.html`, `pricing-old.html` | Pricing dashboard UI(s). `pricing-old.html` has a "Trigger repricing" button that POSTs directly to the GitHub Actions dispatch API using a client-side token (see §6, §8 risk notes). |
| `price-history.html` | Read-only pricing history viewer. |
| `pricing_engine.py` | Main pricing decision engine — `pricing_state`, `pricing_log`, `pricing_changes`, `pricing_events`, `pricing_config/rules` collections. |
| `velocity_engine.py` | Pure computation module (booking-velocity math) — no direct Firestore access found; imported by `pricing_engine.py`/`claude_pricing.py`. |
| `claude_pricing.py` | AI-assisted pricing proposal generator — `pricing_proposals`, `pricing_config/rules`, `pricing_changes`. |
| `ai_pricing.py` | Smaller AI pricing helper — reads `reservations`, `pricing_events`. |
| `event_scanner.py` | Scans for local events (SerpAPI) that affect pricing — writes `pricing_events`. |
| `price_tracker.py` | Outcome/lock tracking — `pricing_snapshots`, `pricing_outcomes`, `pricing_locks`. |
| `config.json` | Shared config for the pricing engine (seasons, unit counts, `dry_run` flag). |
| `PRICING.md` | Design doc for the pricing system (not re-verified line-by-line in this pass). |

### Sync / notifications / backend jobs
| File | Role |
|---|---|
| `minihotel_reservation_sync.py` | **The core sync job.** MiniHotel Calendar API → `reservations`, plus guest-detail/booking-ID enrichment, cancellation detection, stale-room self-healing, and triggers urgent repricing. |
| `minihotel_auth.py` | Shared MiniHotel login-session helper (used by/duplicated across sync scripts). |
| `housekeeper_sync.py` | **Separate, second** MiniHotel scraper — HTML-scrapes the housekeeping report page, name-matches to `reservations`, force-writes `roomCode` + `manualRoom:true`. Wired only to a **`.disabled`** workflow — currently dormant (see §6, §8). |
| `minihotel_monthly_report.py` | Scrapes a MiniHotel Excel export, emails it. Wired only to the same disabled workflow. |
| `backfill_booking_ids.py` | One-off backfill of Booking.com/Expedia confirmation IDs onto existing `reservations` docs; imports directly from `minihotel_reservation_sync.py`. |
| `backfill_service_requests_status.py` | One-off backfill adding a `status` field to old `service_requests` docs. |
| `check_guest.py` | Debug/inspection script — reads `checkin_forms` (note: **not** `checkin_guests` — see §8 risk), `checkin_guests`, `reservations`. |
| `whatsapp_automation.py` | 3 jobs in one script (`checkin_reminder`, `midstay`, `checkout`) — reads `reservations`/`checkin_guests`, writes `whatsapp_messages`, `whatsapp_alerts`. |
| `whatsapp_checkin_ready.py` | Separate "room ready" WhatsApp notifier — reads `reservations`, `hk_status`, `checkin_guests`; writes `whatsapp_messages`. |

### Cloud infra
| File | Role |
|---|---|
| `tuya-functions/index.js` | Two Firebase Cloud Functions: `whatsappWebhook` (Meta WhatsApp inbound webhook → Claude-generated auto-reply) and `roomReadyNotification` (Firestore trigger on `hk_status` writes — **currently disabled/dead code**, see §8). |
| `scripts/elevator-monitor.js` | Hourly cron script — reads RTDB `/elevator_code`, emails an alert via Resend if stale >26h. |
| `tuya-proxy.js`, `start-tuya.sh` | Local-only Tuya API proxy (`localhost:3000`) — required by `checkin-admin.html`'s "Test code" button; not deployed anywhere reachable in production. |
| `.github/workflows/*.yml` | 8 active workflows + 1 `.disabled` — see §6/§7 for exact triggers. |
| `firebase.json`, `.firebaserc` | Deploys `tuya-functions` as the `default` Cloud Functions codebase to project `sleepy-5c962`. |
| `serviceAccountKey.json` | **A live Firebase service-account key sitting in the repo working tree** (untracked but present on disk) — see §8 risk. |

### Docs already produced this session (context, not re-derived here)
`CODEBASE.md`, `CHECKIN_GUEST_SPEC.md`, `CHECKIN_ADMIN_SPEC.md`, `GUEST_CHECKIN_REDESIGN.md` — this map cross-references but does not duplicate their content.

---

## 1. Reservation enters system → appears in admin/guest

**Trigger:** `.github/workflows/minihotel_reservation_sync.yml` — its `on:` block is only `push` to `main` and manual `workflow_dispatch`; it has no GitHub `schedule:` block. **Confirmed working as designed**: an external scheduler, **cron-job.org**, calls the GitHub API's `workflow_dispatch` endpoint for this workflow every 10 minutes. So the actual cadence is a 10-minute poll, driven from outside GitHub Actions rather than from a `schedule:` block — intentional, not a gap. (`minihotel_reservation_sync.py`'s own docstring still says *"Runs as a GitHub Action on schedule (every 30 min)"*, which is now stale/inaccurate now that cron-job.org drives it every 10 min instead — worth a comment update someday, but not a functional bug.)

**Files/functions:** `minihotel_reservation_sync.py::main()` →
1. `login_minihotel()` — scrapes MiniHotel's ASP.NET login form (`login.minihotel.cloud/login.aspx`, `MINIHOTEL_USER`/`PASS`/`HOTEL` secrets).
2. `fetch_reservations(session, from_date, to_date)` — pulls a 7-day-back to 60-day-forward window from MiniHotel's Calendar API.
3. `sync_to_firestore(db, reservations)` — batched `set(merge=True)` into `reservations/{docId}`. Doc ID = `reservationNumber` (or `{reservationNumber}_{memberId}` / `{reservationNumber}_{roomCode}` for multi-room bookings). **Respects `manualRoom:true`** by not overwriting `roomCode`/`allRooms`/`minihotelRoom` on frozen docs, but logs a loud `MANUALROOM DRIFT` warning if MiniHotel's live room has since diverged.
4. `fetch_guest_details()` — enriches phone/email/country for check-ins within 7 days (separate MiniHotel API calls, only for near-term reservations).
5. `fetch_booking_ids()` — separately fetches Booking.com/Expedia confirmation numbers.
6. `detect_cancellations()` — marks docs `CANCELLED` if missing from the live API window; deletes stale room-move "orphan" docs; **self-heals** plain (non-suffixed) docs whose stored `roomCode` no longer matches MiniHotel's live single valid room (unless `manualRoom` is set).
7. `trigger_urgent_pricing()` — if any near-term (≤14 days) cancellation was just detected, POSTs a `workflow_dispatch` to `pricing_engine.yml` via the GitHub API using `GITHUB_TOKEN`.
8. `cleanup_old_duplicates()` — deletes legacy `old_parser`/`reservations_query`-sourced docs once an equivalent `minihotel_api`-sourced doc exists.

**Data store:** Firestore `reservations` collection. Field set per `transform_reservation()`: `reservationNumber`, `firstName`, `lastName`, `guest`, `roomCode`, `allRooms`, `checkin`, `checkout`, `nights`, `source`, `status`, `statusDescription`, `total`/`currency`/`debit`/`credit`, `board`, `creationDate`, `minihotelRoom`, `syncSource:'minihotel_api'`, `syncedAt`. Plus later-added `manualRoom` (bool), `phone`/`email`/`country` (from `fetch_guest_details`), booking-ID fields (from `fetch_booking_ids`), and `tuyaPassword` (read by every guest page — **see §6, never found being written anywhere in this repo**).

**Downstream effects:** `checkin-admin.html` and `checkin-admin-sandbox.html`'s `_loadResCache()` (one-shot, up to 1000 docs, 1-year window) both read this same collection independently, on-demand, not live. `checkin-guest-v2.html` and all 3 sandboxes match a guest to their reservation via `reservationNumber`/name+date. `whatsapp_automation.py` and `whatsapp_checkin_ready.py` both query `reservations` directly by `checkin`/`checkout` date windows. HK apps read `reservations` for room-occupancy display. `SleepyPMS.html` also reads/writes `reservations` from a totally separate data-entry path (`properties` + manual reservation UI) — see §8 duplication note.

**Fragile spots:**
- `housekeeper_sync.py` is a **second, independent writer of `roomCode` + unconditional `manualRoom:true`** on the same collection, via HTML-scraping a different MiniHotel report page with its own name-matching/tiebreaker logic. It's currently only reachable through the `.disabled` workflow, so dormant — but if re-enabled, its blanket `manualRoom:true` would silently freeze every room it touches against all future automatic corrections from the primary sync, using the exact same flag the admin UI uses to mean "a human deliberately overrode this room."
- Two entirely separate "what rooms exist" masters: the Python `ROOM_MAP`/`ROOM_TO_PROPERTY` dicts (duplicated near-identically across `minihotel_reservation_sync.py` and `housekeeper_sync.py`) vs. the JS `APARTMENTS` array (duplicated across `checkin-admin.html`, `checkin-admin-sandbox.html`) vs. the `properties` Firestore collection owned by `SleepyPMS.html`. A room renamed/added in one place does not propagate to the other three.

---

## 2. Guest finds booking → registers → passport → home unlock

**Trigger:** Guest opens `checkin-guest-v2.html?apt={roomCode}` (or a sandbox equivalent), types name/booking-ref to self-match, or the page auto-loads from `localStorage` session keys (`maxela_v2_session`, `maxela_apt_id`, `maxela_guest_id`).

**Files/functions:** `checkin-guest-v2.html`'s registration flow → `setDoc(doc(db,'checkin_guests',docId),{...},{merge:true})` (update) or non-merge `setDoc` (first submit, sets `submittedAt`). Passport photo → `uploadBytes()` to Firebase **Storage** (`sleepy-5c962.firebasestorage.app`) → `getDownloadURL()` → written back as `passportUrl` on the same `checkin_guests` doc, plus a `passportScanResult` object (AI validity/confidence/reason — the scanning call itself wasn't re-traced in this pass, flagged for Cursor). Failed self-match → `addDoc(collection(db,'search_failures'),{...})`.

**Data store:** `checkin_guests/{docId}` (doc ID convention: `{roomCode}_{arrivalDate}` or similar per-room key, confirmed in `CHECKIN_ADMIN_SPEC.md`/`CHECKIN_GUEST_SPEC.md`). `search_failures` (unresolved queue). Firebase Storage under a passport-photos path (not fully re-traced this pass).

**Downstream effects:** `guestStatus()`/`isUnlocked()` (two independently-reimplemented copies — one in `checkin-admin.html`/`checkin-admin-sandbox.html`, one in the guest pages) compute the unlock/lock/waiting state from `arrivalDate`, `manualUnlock`, `aptData[aptId].checkInTime`, and `hk_status`. `checkin-admin.html`'s `onSnapshot` on `checkin_guests` picks up the new doc live and re-renders the Guests tab. `search_failures` triggers a **live** `onSnapshot` badge in both admin UIs (`#sf-badge` / `#sf-more-badge`).

**Fragile spots:**
- `guestStatus()`/`isUnlocked()` duplication (already documented in `CHECKIN_ADMIN_SPEC.md` §4.5) — any unlock-rule change must be hand-applied in at least 2 places (admin + guest), now **3+** counting `checkin-admin-sandbox.html`'s own copy (confirmed identical logic, separately maintained).
- `check_guest.py` (the debug tool) reads a collection called **`checkin_forms`**, not `checkin_guests` — either a stale/legacy collection name from before a rename, or a genuine second collection nobody else in the system reads. Needs verification, flagged for Cursor (§9).

---

## 3. Admin grants access / edits apartment / updates elevator

**Trigger:** Human action in `checkin-admin.html` or `checkin-admin-sandbox.html`.

**Files/functions:**
- **Grant access:** `window.unlockGuest(guestId)` → `updateDoc(checkin_guests/{id}, {manualUnlock:true, unlockedAt})` — identical in both admin UIs.
- **Move/reassign room:** `window.moveGuest`/`window.moveRoomInGroup` (live admin) and their sandbox equivalents → writes `checkin_guests.aptId` **and** `reservations.{roomCode, manualRoom:true}` — this is the human-initiated counterpart to §1's automated `manualRoom` writes, using the exact same field with the exact same "freeze this room forever" semantics.
- **Edit apartment (WiFi/lock/instructions/photos):** `window.saveAptData(aptId)` → full-document `setDoc(checkin_apartments/{aptId}, {...})` — both admin UIs, independently implemented, same field shape.
- **Elevator code:** `window.gsUpdateElevatorCode()`/`window.updateElevator()` → **dual write**: RTDB `PATCH /elevator_code.json` first, then Firestore `setDoc(globals/elevator_code, {...}, merge:true)` — same order, same two-store pattern, in both admin UIs.

**Data store:** `checkin_guests`, `reservations`, `checkin_apartments`, RTDB `/elevator_code`, Firestore `globals/elevator_code`.

**Downstream effects:** Guest pages read `globals/elevator_code`/RTDB for the QR/code display; `checkin-details.html` also reads it independently. `checkin_apartments` changes propagate live to any open guest page via its own listener (guest-side re-verify recommended, not re-traced this pass). The elevator RTDB write is independently monitored by `scripts/elevator-monitor.js` (hourly cron, alerts by email via Resend if >26h stale) — **this is the one flow in the whole system with an actual automated health check**, worth noting as a pattern to replicate elsewhere.

**Fragile spots:**
- Elevator code has **3 independent read/write implementations** now: `checkin-admin.html`, `checkin-admin-sandbox.html`, and `checkin-guest-v2.html`'s own RTDB-vs-Firestore freshness race (each with subtly different tie-breaking on which source "wins").
- `checkin-admin.html`'s and `checkin-admin-sandbox.html`'s `checkin_admin/config` (Guest Page Settings) writes are both full-document `setDoc` with no merge — two admins open in different tabs, saving from both, is last-write-wins data loss (documented in the sandbox re-scan reply, repeated here because it's a real cross-app risk, not sandbox-only: any second write source to this doc has the same exposure).

---

## 4. HK marks room ready → guest notified / unlock rules react

**Trigger:** Housekeeper taps "Done" in `HK.html` / `HK-Shartava.html` / `HK-Centre.html`.

**Files/functions:** Each HK app's own "mark done" handler → `setDoc(doc(db,'hk_status',key),{...})` where `key = "{roomCode}_{date}"`. `HK-Centre.html` additionally writes a **separate** `hk_cleaner/{key}` doc (`{roomCode, date, cleaner, updatedAt}`) that the other two HK apps don't have any equivalent of.

**Data store:** `hk_status/{roomCode}_{date}` (`done: bool`, plus whatever else each app writes — not fully diffed field-by-field across the 3 HK apps in this pass, flagged for Cursor). `hk_cleaner/{roomCode}_{date}` (Centre only).

**Downstream effects (fan-out from one write):**
1. `checkin-admin.html`/`checkin-admin-sandbox.html`'s `hk_status` `onSnapshot` (filtered to today) → re-renders the Guests tab, which feeds `guestStatus()`'s "cleaned + past 11am → early unlock" rule.
2. `whatsapp_checkin_ready.py` (cron `0 11 * * *`, i.e. daily 11:00 UTC) reads `hk_status/{room}_{today}` and, if `done===true` and a matching WA-contact `checkin_guests` form exists for today's arrival, sends a "room ready" WhatsApp message and logs to `whatsapp_messages`.
3. `tuya-functions/index.js::roomReadyNotification` — a **Firestore-triggered Cloud Function on `hk_status/{docId}` writes**, intended to send the same kind of notification instantly rather than waiting for the 11am cron — **is fully commented out / hardcoded `return;` at the top**, i.e. deployed-but-inert. If it were ever re-enabled without also disabling the cron job, guests could get the same "room ready" message twice from two different code paths.

**Fragile spots:**
- Point 3 above is the clearest concrete duplication risk in the whole system: an already-deployed, wired, commented-out Cloud Function sitting right next to a working cron script that does the same job via a different trigger mechanism.
- 3 HK apps, only 2 of which agree on which collections represent "cleaner assignment" — `HK-Centre.html`'s `hk_cleaner` has no Shartava equivalent, so a Shartava-side "who cleaned this room" query has nowhere to look.

---

## 5. Service request created → admin handles it

**Trigger:** Guest taps a service tile (Laundry/Cleaning/City Tour/Airport Transfer/Other) on any guest page.

**Files/functions:** Guest page → `addDoc(collection(db,'service_requests'),{...})` with `serviceId`, `details{}`, `status` implicitly `PENDING`, `timestamp`. Admin side: `checkin-admin.html`'s `renderRequests()` and `checkin-admin-sandbox.html`'s `loadAndRenderRequests()` both do a **one-shot** `getDocs(orderBy('timestamp','desc'), limit(100))` — re-fetched only when that tab is opened, not live in either admin UI. `window.setReqStatus`/`window.deleteReq`/`window.deleteCompleted` write `status`/`deleteDoc` back to the same collection, again independently implemented in both admin apps with identical field-handling per service type (`airport_transfer`'s small/large-car pricing, `laundry`'s itemized list, etc.).

**Data store:** `service_requests`.

**Downstream effects:** Sidebar/nav pending-count badge (`#sf-badge`-style, separately computed in each admin UI from the same one-shot fetch). No automated notification path was found for new service requests — they surface only when an admin opens the Requests tab.

**Fragile spots:**
- Neither admin app makes `service_requests` a live listener, so a request created while an admin has the tab open won't appear until they leave and re-enter it (or, in the sandbox, until `force:true` is passed on the next `loadRequests()` call).
- `HK-Shartava.html` also reads `service_requests` (per §0 inventory) — its actual usage of that collection wasn't traced in this pass; flagged for Cursor.

---

## 6. Door code generation / refresh / failure

This is the flow with the most unresolved gaps found in this scan.

**What's confirmed:**
- **Apartment-level static/manual code:** `checkin_apartments/{aptId}.doorCode` (or `.tuyaDeviceId` for auto-generation) — set via `window.saveAptData()` in either admin UI, read by guest pages as the fallback door display.
- **Per-reservation "Tuya password" field:** `reservations.{docId}.tuyaPassword` — read by **every** guest-facing page (`checkin-guest-v2.html`, all 3 sandboxes, `checkin-details.html`) as the *preferred* door code (falls back to the apartment-level static code if absent), and also read by `checkin-admin-sandbox.html`'s guest detail view. **A repo-wide grep found this field written nowhere in this codebase** — not in `minihotel_reservation_sync.py`, not in either admin app, not in any Cloud Function. Either it's populated by a system entirely outside this repo (a live Tuya integration not checked into git), or the "auto-generated per-guest door code" feature that every guest page's UI is built to display has no working writer at all today, and guests are actually always seeing the static apartment-level code as a silent fallback.
- **Live "test code" generation:** `checkin-admin.html`'s `window.testTuyaDevice(aptId)` calls a **local-only proxy** (`http://localhost:3000`, from `tuya-proxy.js`/`start-tuya.sh`) to generate a Tuya offline temp password on demand — only works on the machine running that proxy, not from a deployed admin session. `checkin-admin-sandbox.html` has no equivalent of this feature at all.
- **Elevator code** (a separate, building-level code, not the same as an apartment door code) is generated/updated manually by an admin (§3) and monitored hourly by `scripts/elevator-monitor.js`.

**Fragile spots:**
- The `tuyaPassword` write-gap above is the single highest-priority item to verify before any rebuild — it's either a dead feature every guest page carries dead code for, or an external system this map can't see. **Do not assume either answer; verify with the host or by checking Tuya's own webhook/integration settings outside this repo.**
- No automated monitor exists for apartment-level door codes or the Tuya proxy's health — only the elevator code has `elevator-monitor.js`'s alerting.

---

## 7. Notifications / cron triggers — full trigger table

Verified directly from `.github/workflows/*.yml` (not from script docstrings, several of which are now wrong — see fragile notes):

| Workflow | Trigger | Script | Cadence |
|---|---|---|---|
| `minihotel_reservation_sync.yml` | `push` to `main`, `workflow_dispatch` | `minihotel_reservation_sync.py` | **Every 10 min**, via an external scheduler (cron-job.org) calling the GitHub API `workflow_dispatch` endpoint — not a GitHub `schedule:` block, but confirmed working as designed. See §1. |
| `elevator-monitor.yml` | `schedule: '0 * * * *'`, `workflow_dispatch` | `scripts/elevator-monitor.js` | Hourly |
| `whatsapp_checkin_ready.yml` | `schedule: '0 11 * * *'`, `workflow_dispatch` | `whatsapp_checkin_ready.py` | Daily 11:00 UTC |
| `whatsapp_checkin_reminder.yml` | `repository_dispatch: [whatsapp_checkin_reminder]`, `workflow_dispatch` | `whatsapp_automation.py --job checkin_reminder` | **Intentionally disabled** — nothing in this repo fires the dispatch event, by design. Manual-only for now. |
| `whatsapp_checkout.yml` | `repository_dispatch: [whatsapp_checkout]`, `workflow_dispatch` | `whatsapp_automation.py --job checkout` | Same — intentionally disabled |
| `whatsapp_midstay.yml` | `repository_dispatch: [whatsapp_midstay]`, `workflow_dispatch` | `whatsapp_automation.py --job midstay` | Same — intentionally disabled |
| `pricing_engine.yml` | `workflow_dispatch` (with `urgent`/`property_types`/`dates` inputs) | `pricing_engine.py --apply` | Manual, or auto-dispatched by `minihotel_reservation_sync.py::trigger_urgent_pricing()` on near-term cancellations, or by a button in `pricing-old.html` |
| `backfill_booking_ids.yml` | `workflow_dispatch` | `backfill_booking_ids.py` | Manual only (by design — it's a backfill) |
| `minihotel_sync.yml.disabled` | *(inert — `.disabled` suffix)* | `minihotel_monthly_report.py`, `housekeeper_sync.py` | Not running |
| `whatsappWebhook` (Cloud Function, not a workflow) | Meta WhatsApp inbound webhook POST | `tuya-functions/index.js` | Real-time, external trigger |
| `roomReadyNotification` (Cloud Function, not a workflow) | Firestore `onDocumentWritten` on `hk_status/{docId}` | `tuya-functions/index.js` | **Deployed but hardcoded to `return;` immediately — inert** |

---

## 8. Cross-cutting fragile spots / duplication (ranked, most important first)

> Status note (2026-08-27, per host correction): items 1–4 below are flagged as-found and their current real-world status is **unknown** — not resolved, not fixed, not dismissed. They need investigation later, not action now. Two items originally on this list have been removed/reclassified per confirmed host facts: the reservation-sync schedule turned out to be intentional (see §1/§7 — cron-job.org drives it every 10 min), and the 3 WhatsApp automations are intentionally disabled by design, not broken (see §7).

1. **`reservations.tuyaPassword` is read everywhere and written nowhere found in this repo** — verify before assuming the per-guest auto-door-code feature works at all (§6). Status unknown.
2. **Two independent MiniHotel scrapers can both claim room-assignment authority** via the same `manualRoom:true` flag: the primary API sync (`minihotel_reservation_sync.py`, careful about respecting existing overrides) and the dormant HTML-scraping `housekeeper_sync.py` (blanket-sets `manualRoom:true` on every match, currently reachable only via a `.disabled` workflow — but one accidental rename away from active). Status unknown.
3. **4 independent "what rooms/properties exist" data sources**: JS `APARTMENTS` array (both admin UIs), Python `ROOM_MAP`/`ROOM_TO_PROPERTY` dicts (both MiniHotel scrapers, near-duplicated), Firestore `properties` collection (SleepyPMS + HK apps + import tool), and per-room `checkin_apartments` docs (guest-facing content). None of the four are generated from any of the others. Status unknown.
4. **A live Cloud Function (`roomReadyNotification`) sits deployed and inert next to a working cron script (`whatsapp_checkin_ready.py`) that does the same job.** Reactivating the function without disabling the cron would double-send. Status unknown.
5. **Unlock-status logic (`guestStatus()`/`isUnlocked()`) is now independently implemented at least 3 times**: `checkin-admin.html`, `checkin-admin-sandbox.html`, and the guest pages.
6. **`check_guest.py` reads a `checkin_forms` collection** that no other file in this repo references (everywhere else uses `checkin_guests`) — likely a stale debug script referencing a renamed-away collection, but not confirmed either way in this pass.
7. **`HK-Centre.html`'s `hk_cleaner` collection has no equivalent in `HK.html`/`HK-Shartava.html`** — a Centre-only concept with no cross-property consistency.
8. **A live Firebase service-account key (`serviceAccountKey.json`) sits in the repo working tree** (untracked, but present on disk, `git status` shows it every session) — worth confirming it's genuinely excluded from any commit and isn't the credential actually used by the GitHub Actions secrets (those use `FIREBASE_SERVICE_ACCOUNT` as a base64'd GitHub Secret, which is the correct pattern — this local file looks like a leftover from local testing, but should be verified as never having been committed historically).
9. **`pricing-old.html` dispatches a GitHub Actions workflow directly from client-side JS using a token** (`fetch('https://api.github.com/repos/.../pricing_engine.yml/dispatches', {headers:{Authorization:`Bearer ${token}`}})`) — where that token comes from (typed in by the operator each session, or stored somewhere) wasn't traced in this pass; if it's a long-lived PAT stored in browser localStorage or hardcoded, that's a credential-exposure risk parallel to the admin panels' plaintext password gate.
10. **Every admin/guest surface still uses the same hardcoded plaintext password `maxela2026`** (`_ADMIN_PWD`) — already flagged per-file in `CHECKIN_ADMIN_SPEC.md`, repeated here because it is a genuinely system-wide (not per-file) property: there is currently no real authentication anywhere in the operator-facing surfaces of this system.

---

## 9. For Cursor to verify / deep-scan next

Be exact — these are the specific gaps this scan could not close from a read-only pass, or things Cursor's own context (if it has been touching the sandbox files more recently/more deeply) might resolve faster.

**Files to open and re-trace fully (not just grepped in this pass):**
- `hk-manage.html` and `SleepyDashboard.html` — no direct Firestore collection reads were found by grep; confirm whether they call a Cloud Function, another script, or are genuinely static/read-nothing. Exact question: *what does "HK Schedule Manager" actually manage, and where does it read/write?*
- `TukaTracker.html` and `VenuTracker Update.html` — not scanned at all in this pass; confirm whether either touches any collection in the check-in/booking/HK system or is fully unrelated (financial/other).
- `checkin-details.html` — new file, only lightly scanned here. Confirm: (a) is it linked from `checkin-guest-v2.html` or the sandboxes as a sub-page, or standalone? (b) full list of its Firestore reads/writes beyond `reservations` and the elevator RTDB path. (c) why it uses a 5th distinct design system (Playfair Display/Inter) instead of DM Sans/DM Mono.
- `check_guest.py` — confirm whether `checkin_forms` (line ~66) is a real, currently-populated collection, or a stale reference that should say `checkin_guests`. Run `grep -rn "checkin_forms"` repo-wide again after any admin/guest edits to make sure nothing else ever writes to it.
- `HK-Shartava.html`'s exact use of `service_requests` — confirmed as read in this pass, not traced for what it does with it.
- `minihotel_auth.py` vs. the inline login logic duplicated in `minihotel_reservation_sync.py`, `housekeeper_sync.py`, and `minihotel_monthly_report.py` — confirm whether `minihotel_auth.py` is actually imported/used by any of them, or is dead/aspirational shared code that never got wired in (this pass found 3 separate inline copies of the MiniHotel ASP.NET login-scrape, not calls into the shared module).

**Collections / RTDB paths to confirm live and populated (query directly in the Firebase console, not just via grep):**
- `checkin_forms` (see above — possible ghost collection).
- `reservations.tuyaPassword` — confirm whether any document in production actually has this field set, and if so, by what (a system outside this repo).
- `hk_cleaner` — confirm whether this collection has real documents, or was written once and abandoned.
- `whatsapp_alerts` — written by `whatsapp_automation.py::write_alert()` on delivery failure; confirm nothing currently reads/surfaces these anywhere (this pass found no reader).
- `pricing_state`, `pricing_locks` — confirm these are still actively read by the live pricing dashboard (`pricing.html`) and not orphaned from an earlier pricing-engine iteration (`pricing-old.html` exists alongside `pricing.html`, suggesting a past migration that may have left some collections behind).

**Flows to re-trace end-to-end:**
- The passport AI-scan call itself (`passportScanResult` — populated by *something* after `uploadBytes`, but the actual scanning API call wasn't located/re-traced in this pass — confirm whether it's a direct client-side call to an AI vision API, or routed through a Cloud Function not in `tuya-functions/`).
- Whatever currently generates `reservations.tuyaPassword`, if anything — check Tuya's own dashboard/webhook config, and check for any Cloud Function or script outside this repo (a second, unconnected repo, or a manually-run local script never committed).
- `pricing-old.html`'s dispatch-token flow — where the GitHub token used for its "Trigger repricing" button actually comes from, and whether it's exposed client-side.

**Anything that may be deployed outside this repo entirely:**
- Any real Tuya cloud integration/webhook that writes `tuyaPassword` (see above — top unknown in the whole map).
- The actual Meta WhatsApp Business API app config (message templates referenced by name in `whatsapp_automation.py`/`whatsapp_checkin_ready.py` — e.g. `checkin_reminder`, `midstay_checkin` — live in Meta's Business Manager, not in this repo, and weren't independently verified to exist/be approved).
- Firebase Security Rules (Firestore/Storage/RTDB) — not a file in this repo at all in this pass (no `firestore.rules`/`storage.rules`/`database.rules.json` found at top level); if they exist, they're either unmanaged-by-code (edited by hand in console) or live somewhere not scanned here — worth Cursor confirming their existence and content, since they're the actual enforcement layer behind everything this map describes as "admin-only" writes.

---

*Scan performed by re-reading source directly: all `.github/workflows/*.yml`, `tuya-functions/index.js`, `scripts/elevator-monitor.js`, `firebase.json`/`.firebaserc`, all `.py` files in repo root, and targeted greps across every `.html` app for Firestore collection references, RTDB URLs, and cross-file trigger calls. No file was edited. No commit was made — this file is currently untracked in the working tree, exactly like the other scan/spec docs from this session.*
