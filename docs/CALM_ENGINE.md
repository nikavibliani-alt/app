# Calm pricing engine (new engine, shadow test)

Plain-language guide. Written 2026-10-07. Status: **shadow test only**. Nothing in
this package changes prices in MiniHotel or on Booking / Expedia / Airbnb.

## What it is

A new way to calculate nightly prices, built to replace `velocity_engine.py`
after a 2-week shadow test. The full plan is in the Claude doc
"Safe pricing engine plan and Tbilisi area scan".

| File | What it does |
| --- | --- |
| `calm_pricing/engine.py` | The price logic. Pure: no internet, no database. One call = one run. |
| `calm_pricing/config.py` | Default settings (limits, bands, speeds). Every number can be changed later from Firestore `pricing_config/engine_v2.settings`. |
| `calm_pricing/curve.py` | Learns *how early* guests book from your own reservations. |
| `pricing_shadow.py` | Reads MiniHotel + Firestore, runs the engine in shadow mode, saves only its own results. Refuses any POST/PUT/DELETE. |
| `pricing_shadow_report.py` | After the test: compares the new engine with the current one. Reads only. |
| `tests/calm/` | 61 tests: every promise of the plan, the findings of three Cursor reviews and the step 1 data check, and end-to-end tests of the shadow script with a fake MiniHotel and a fake Firestore. |
| `sim/simulate.py` | Market simulator used to compare the engines offline (fake guests). |

## The rules it follows

1. The target price is calculated fresh from your start price every run, so prices cannot creep.
2. How far a price may move depends on days before arrival: 61+ days -3%/+8%, 31-60 -5%/+12%, 15-30 -8%/+15%, 8-14 -12%/+20%, 4-7 -15%/+20%.
3. The minimum is reached at the earliest on the night before arrival day, in 3 morning steps, and only if still empty. Each step is at most -15%, so a minimum below about 60% of the start price is not fully reached. Arrival day is never lowered by demand (only brought down to your maximum if above it).
4. Only one run per day may lower prices: the first run from 09:00 Tbilisi. If that run is after 12:00, a warning is recorded. Other runs may only raise.
5. Limits over any 24 hours: -5% (-15% in the last 3 days), +8% (+15% when selling much faster than normal within 14 days).
6. No back-and-forth: no raise within 36 h of a drop (unless a booking came in), no drop within 48 h of a raise, no reversal within 72 h while "selling as normal".
7. Your minimum and maximum always win, at any hour, even over a hand-set price. An approved event lifts the maximum on the event date only; the night before gets half the lift, within your maximum. If minimum > start or start > maximum, those dates are left alone with a warning.
8. A price you set by hand is kept 48 hours, or until a booking on that date (also one that fills it). When it is released, the 24-hour limits still count from the price 24 hours ago.
9. Single apartments are either empty or full. Empty ones follow the same days-out limits; from 4 days out, if the rest of the building is selling as normal, they do not go below the normal price. In the last 3 days they walk to the minimum like any other unit. Groups (buildings): shartava, freedom, orbeliani, vgl, xcv. A booking blocks drops only for its own room type.
10. Safety stops. A room type is left alone for that run (the others carry on) if MiniHotel data for it is incomplete, its availability is missing, more than 10% of its dates have no price (a single missing price only skips that date), or a new price would fall outside 0.5-2x start. The whole run writes nothing if more than 40% of prices would move (allowed, with a warning, in the first 3 days after switching on). A stopped room type or run keeps today's prices, and the alert is recorded.
11. Prices are rounded to 5 lari / 1 dollar, and rounding never breaks a limit.
12. Settings changed in Firestore (`pricing_config/engine_v2.settings`) have hard limits (`HARD_LIMITS` in `config.py`): a value outside its range, or not a number, falls back to the default and is reported as a warning. The daily limits, the 40% stop, the bands and the minimum-on-day-1 cascade cannot be loosened beyond those limits.

## Currencies

MiniHotel's Airbnb price list is called "EUR", but the Airbnb listings are in US dollars.
Inside the engine it is called `USD`; `pricing_shadow.py` reads MiniHotel's "EUR" list for it.

## Running the tests

```
python3 -m pip install pytest
python3 -m pytest -q tests/calm
```

## Shadow mode

The shadow runs as a separate job after the live pricing job (see `github_workflow_step.yml`).
It reads only the room types that have a minimum, start and maximum. Only confirmed stays
(status OK / OK2) with a real booking date are used. During the shadow test it uses the
default booking-timing curve and records the learned one next to it (`learn_timing: false`).
The read-only guard refuses any write toward MiniHotel through any `requests` call.

`pricing_shadow.py` runs after the current engine in the same GitHub workflow (see
`github_workflow_step.yml`). It keeps a *virtual* price for every date in
`pricing_engine_state/shadow_*`, moves that virtual price by the rules above, and
records per date the MiniHotel price (`mh`), the new engine's price (`new`), target, min and max
in `pricing_shadow_daily`. Run
`python pricing_shadow_report.py` after 14 days.

Local check without saving anything: `python pricing_shadow.py --print`.

## Things to fill in / check

- `ROOM_CODE_TO_RT` in `pricing_shadow.py`: add the XCV room codes used in `reservations.roomCode`.
- VGL and XCV are left alone ("No minimum/start/maximum set") until min, start and max exist for them: on the pricing page under VGL_ST, VGL_AP, XCV_1, XCV_2, or in Firestore `pricing_config/engine_v2.rules`. The owner sets these numbers himself.
- The engine does not count Booking discounts (Genius, mobile rate, country rates). It works with the prices set in MiniHotel and on the pricing page. Later the system will learn from MiniHotel what each booked night actually sold for.
- MiniHotel leaves `Availability` empty and sends the free units in `DefaultAvailability` (checked on real data, 8 Oct 2026). The shadow reads `DefaultAvailability` when `Availability` is empty; a real 0 is never replaced.
- Room 7-3 is not in `ROOM_MAP` in `minihotel_reservation_sync.py`; check whether its bookings reach Firestore.
