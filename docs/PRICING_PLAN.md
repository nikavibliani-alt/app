# Pricing plan

Steps (work one at a time, in order):

- Step 0
- Step 1
- Step 2a
- Step 2b
- Step 3
- Step 4
- Step 5
- Step 6
- Step 7

## Progress log

- 2026-10-08, step 2a: plain `pricing_engine.py` run (no --apply) now writes nothing anywhere (write guard, no event scan, no Claude call, no email); `--report` prints a row per room type and date; `pricing_config/control` paused switch added (engine and pricing.html). Proof: read-only check `dryrun`.
- 2026-10-08, step 2b: Claude analyst auto-apply off (all proposals pending, never writes rules; null or non-numeric values skip that proposal); engine writes no prices when Firestore or booking velocity cannot be read (logs the error, exits 1); null or missing min/max/start in pricing_config/rules is ignored instead of becoming 0; pricing_engine.yml gets a concurrency group (no schedule).
- 2026-10-09, step 3 (v8 to v10): calm engine wired into pricing_engine.yml as two extra jobs after the pricing job: `shadow` (reads only, old six rooms) and `calm_live` (writes XCV_1, XCV_2, VGL_ST, VGL_AP, 180 days ahead, respects the pause switch). First run (00:00 UTC, commit 22b0b5e): pricing job OK (79 updates, channels synced); shadow OK (0 virtual moves, nothing sent to MiniHotel; old rooms left alone because 90 dates from 8 Jan have no price); calm_live OK (707 prices written, 440 of them first prices for empty dates, 242 min/max corrections, no stopped room types).
- 2026-10-12, move of the six old rooms to the new engine (prepared on a branch, NOT live): ROOMS, MAXELA, BIG_APT, FREEDOM, ORBE_1, ORBE_2 are set to live in `calm_settings.json` (style normal, 90 days, channels as before: Booking+Expedia for ROOMS/MAXELA, Booking+Expedia+Airbnb for BIG_APT/FREEDOM, Booking+Airbnb for ORBE_1, Airbnb for ORBE_2). In the same change the old engine's room list (`pricing_engine.ROOM_TYPES`) and `pricing_shadow.OLD_ENGINE_RTS` are empty, so a room is never on both engines. The old `pricing_engine.py` run now only scans events and runs the weekly idea maker. The new engine pushes `EXPEDIA` for the rooms that use it. Dry run: `pricing_check` with `--check moveold`. Going live = merging the branch to main (the next scheduled run does it). Rollback: `restore/before-old-rooms-move` (put the six back in the old list, set them to test in `calm_settings.json`).
- 2026-10-12, ideas: `scripts/ideas_cleanup.py` (manual workflow `ideas_cleanup`) closes pending ideas older than 7 days or whose "current" number no longer matches the rules (status rejected, reason "out of date"; rules untouched). The idea maker runs once a week and a new idea closes the older pending idea for the same room, season and field.
- 2026-10-12, holiday rule + watchdog (on the branch, NOT live): holiday dates (every range in `pricing_config/rules.dateOverrides`) and dates under the new "hold" date rule keep an anchor (their price when first seen) and move only a little until 14 days before arrival (single units up and down, 2+ units down only; numbers in `settings.holiday`, hard limits 0 to 20%); no far reset on them. `calm_pricing/watchdog.py` + `scripts/price_watchdog.py` (job `watchdog` in `pricing_engine.yml`) check seven things after each run, save `pricing_watchdog/latest` (card on pricing-v2) and send one WhatsApp per day only when red and after the 09:00 run. pricing-v2 Dates tab has the "Holiday rule: small moves far ahead" card. Data-capture design: `docs/DATA_CAPTURE_PLAN.md` (plan only). Rollback: `restore/before-holiday-rule`.
- 2026-10-12, cancellations and events (live): a cancellation (urgent) run now goes straight to the new engine for the named rooms and nights only (the old engine job and the shadow job are skipped); it never uses up the 09:00 lowering run. A night freed TONIGHT (Tbilisi) goes straight to the room's minimum on all of its channels (protect, hold, holiday dates and hand-set prices still win); freed future nights are not lowered by the urgent run. The reservation sync now names every room type (XCV, VGL included), sends every freed night and has `actions: write` for the dispatch. Event scanner: search words follow the year (current, and next from 3 Oct), no fixed artists, errors shown with the key hidden, scan every 2 days, searches side by side. Rollbacks: `restore/before-urgent-and-events`, `restore/before-urgent-tonight`.

- 2026-10-12 cancellation runs, second change: a night freed tonight goes straight to the room's minimum; a night freed tomorrow goes halfway between its price and the minimum; later nights are not touched (a 14-night cancellation lowers at most 2 nights). Protect, hold, holiday rule and hand-set prices win; this step never raises. Restore: `restore/before-urgent-tomorrow`.
