# Maxela Pricing Engine — Documentation

## Architecture Overview

The pricing engine runs via GitHub Actions (`pricing_engine.yml`) on a schedule.
Each run: fetches availability + current prices from MiniHotel → computes new prices
→ writes back to MiniHotel → syncs to OTA channels (Booking.com, Expedia, Airbnb).

**Key files:**
- `pricing_engine.py` — orchestrator, MiniHotel API calls, write logic
- `velocity_engine.py` — core pricing algorithm (occupancy curves, velocity scoring)
- `claude_pricing.py` — daily Claude analyst (proposes config changes to `pricing_proposals`)
- `price_tracker.py` — Firestore persistence: snapshots, outcomes, experiment locks
- `config.json` — static config (seasons, base prices, floors, ceilings, cascade)
- `pricing_config/rules` (Firestore) — overrides set from `pricing.html`

---

## Manual Experiment Mode

Manual Experiment Mode lets you test a price change (discount or premium) on a specific
date without the engine immediately overriding it. The engine detects the manual change,
holds off, and resumes automatically once a booking happens or the experiment times out.

### How experiments are detected

After every engine run, `last_engine_price` (the price the engine last wrote) is stored
in `pricing_locks/{rt}_{date}` in Firestore. On the next run, the engine compares:

```
current_minihotel_price  ≠  last_engine_price
```

If they differ **by any amount** (exact mismatch, no threshold), a manual experiment is
detected. Detection only works once a baseline exists — the first run on a new date
establishes `last_engine_price`; experiments can be detected from the second run onward.

**Direction is irrelevant** — discounts and premiums are detected the same way.

### What gets stored (`pricing_locks/{rt}_{date}`)

When a manual experiment is detected, the lock document is created/updated:

| Field | Description |
|---|---|
| `manual_lock` | `true` while experiment is active |
| `manual_price` | Price you manually set in MiniHotel |
| `manual_price_eur` | EUR price if also changed on Airbnb |
| `manual_avail_at_set` | Availability at the time of detection |
| `manual_set_at` | ISO timestamp when experiment was detected |
| `baseline_price` | Same as `manual_price` — engine starts FROM here after unlock |
| `baseline_price_eur` | EUR equivalent |
| `manual_reason` | `"unknown"` by default; future UI can set `"discount"`, `"premium"`, `"event"`, `"testing"` |
| `last_engine_price` | What the engine had set before your manual change |
| `last_engine_ts` | When the engine last wrote a price for this date |

### Lock behavior — no booking yet

While `manual_lock: true` and availability has not changed since the experiment started:

- Engine **skips** this date entirely — no repricing
- Log output: `Manual experiment active for {rt} {date} — locked at {price} GEL, avail unchanged at {avail}`
- The price you set stays in MiniHotel untouched

### Unlock on booking

When `manual_lock: true` and **availability drops** (a unit is booked):

1. Lock is released: `manual_lock` set to `false`
2. Engine resumes pricing **FROM `baseline_price`** (= your manual price), not from `last_engine_price`
   - This avoids sudden jumps — if you set 120 GEL and it booked, engine starts at 120 and moves gradually
   - Gravity pull and 5%/run cap ensure smooth recovery: 120 → 125 → 131 etc.
3. Experiment result saved to `pricing_outcomes/{rt}_{date}`:
   ```
   manual_experiment: true
   manual_price: 120
   last_engine_price: 150
   manual_discount_pct: 20.0   (positive = discount, negative = premium)
   booked_within_experiment: true
   manual_reason: "unknown"
   ```
4. Log output: `Manual experiment concluded for {rt} {date} — {prev_avail}→{new_avail} booked at {price} GEL, resuming from baseline`

### Timeout — unlock without booking

Experiments automatically time out at the **next 12:00 UTC run after `manual_set_at`**:

- Set at 02:00 UTC → times out at 12:00 UTC same day
- Set at 14:00 UTC → times out at 12:00 UTC next day

On timeout:

1. Lock released, engine resumes from `baseline_price`
2. Experiment result saved to `pricing_outcomes` with `booked_within_experiment: false`
3. Log output: `Manual experiment timed out for {rt} {date} — no booking, resuming from {price} GEL`

Timeout ensures a forgotten experiment doesn't lock a date permanently.

### Works for both discounts and premiums

| Scenario | Detection | Lock | Unlock |
|---|---|---|---|
| You set 120 GEL (engine had 150) | `120 ≠ 150` → discount detected | Locked at 120 | Booking at 120 → resumes from 120 |
| You set 250 GEL (engine had 200) | `250 ≠ 200` → premium detected | Locked at 250 | Booking at 250 → resumes from 250 |
| Booking at 250 → next avail drops | Unlock triggered | Released | Engine resumes from 250 |

### Experiment outcomes feed the learning loop

`pricing_outcomes` records with `manual_experiment: true` are included in the historical
booking data that Claude's daily analyst reads. This lets the AI learn:
- Which manual discounts converted to bookings
- Whether premium tests succeeded or timed out
- What `manual_discount_pct` values are effective by season

---

## Velocity Engine

Pricing uses a velocity-adjusted dynamic algorithm:

1. **Target occupancy curve** — expected occupancy% at each lead time
2. **Occupancy deficit** — how far behind/ahead of target we are (40% weight)
3. **Booking velocity** — actual booking pace vs expected (60% weight)
4. **Combined score** → hybrid step drops/raises (max 5%/run, 12%/day)
5. **Start-price gravity** — pulls price toward `startPrice` from `pricing_config/rules`
6. **Last-minute cascade** — gradual drop toward floor in final 3 days
7. **Floor snap** — price is snapped to floor before any % calculation

### Faster recovery (occ ≥ 70%, days ≤ 14)

When occupancy is high and checkin is within 14 days, the max-change cap is raised
from 5% to 15% per run, allowing quicker moves toward ceiling.

---

## Claude Strategy Analyst

Claude (`claude-sonnet-4-6`) runs once per day on the first engine run of the day.

**Input:** last 30 days of `pricing_outcomes` + current `pricing_config/rules`

**Output:** proposals to change `startPrice`, `floor`, or `ceiling` per property/season,
written to `pricing_proposals/{auto_id}` in Firestore.

**Auto-apply:** proposals with ≤5% change from current value are applied immediately
to `pricing_config/rules`. Larger changes appear in `pricing.html` for manager approval.

**Dedup:** runs at most once per day via `pricing_proposals/run_{YYYY-MM-DD}` marker.

---

## Cancellation Fast-Path

When `minihotel_reservation_sync.py` detects a cancellation with checkin within 14 days,
it triggers the pricing engine workflow immediately via GitHub API (`workflow_dispatch`)
with `urgent=true` and the affected property types and dates.

The urgent run:
- Narrows window to 14 days (or to cover the cancellation dates)
- Skips Claude analyst (speed priority)
- Reprices only the affected property types
- Logs with `trigger: "cancellation"` in `pricing_log`
