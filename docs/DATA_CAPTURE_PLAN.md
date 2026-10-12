# Data capture: plan (nothing built yet)

Status: PLAN ONLY. Waiting for the owner's OK. Nothing in this file exists in code.

Goal: keep everything the pricing engine and the bookings do, forever, so a future multi-property PMS has its own history. Every record has a `property_id` (today: `maxela`), is append-only (never edited, never deleted), and carries the engine and settings version that produced it.

## 1. The four streams

| # | Stream | One record is | Written by |
|---|---|---|---|
| 1 | `price_events` | one price decision that changed something, was blocked, or was stopped; plus every write sent to MiniHotel | the engine run (`pricing_calm_live.py`) |
| 2 | `price_snapshots` | one night, one currency: price, free units, min, max, target, status. Taken once a day for the next 365 days | a daily job at 06:00 Tbilisi |
| 3 | `booking_events` | one booking or one cancellation: room, dates, price per night, channel, days in advance | the reservation sync |
| 4 | `settings_events` | one changed field: who, when, field, old, new | the pricing page and the engine |

### Common fields (every record)
`property_id`, `event_id` (unique, from time + counter), `ts` (UTC, ISO), `day` (Tbilisi date), `schema` (a number, so old rows stay readable), `source` (`engine`, `page`, `sync`, `snapshot`).

### 1. price_events
`rt`, `date` (the night), `currency` (GEL/USD), `channel` (Booking, Expedia, Airbnb; the list it went to), `old`, `new`, `kind` (move, correction, fill, reset, far_reset, blocked, stopped, manual_seen), `reason` (the engine's plain sentence), `target`, `min`, `max`, `days_out`, `units`, `avail`, `holiday` (kind, anchor, window, lowest, highest), `engine_version` (git commit of the repo), `settings_version` (hash of the settings document used), `run_id`, `main_run` (true/false), `sent` (true when the write reached MiniHotel).

What is NOT stored per run: a decision that changed nothing and was not blocked (about 95% of all decisions). The daily snapshot already shows the price every night, and each run stores one summary row (`run_events`: counts per room, stopped, failed channels). If you want every "no change" decision too, see option B in section 4.

### 2. price_snapshots
`snapshot_day`, `rt`, `date`, `currency`, `price`, `avail`, `units`, `min`, `max`, `target`, `status`, `kind_last` (the last decision kind). One row per room, night, currency: 10 rooms x 365 nights x 2 currencies = 7,300 rows a day.

### 3. booking_events
`event` (booking, cancellation, change), `reservation_ref` (an internal hash, NOT the guest's name, phone or number), `rt`, `checkin`, `checkout`, `nights`, `price_per_night`, `currency`, `channel`, `booked_on`, `days_in_advance`, `status`. No guest names, no phones, no documents: this is a revenue history, not guest data.

### 4. settings_events
`actor` (the signed-in email, or `engine`), `field` (full path, for example `settings.holiday.limits.far.down_single`), `old`, `new`, `where` (page, file, engine), `note`. The existing `pricing_changes` records are copied in as the first rows.

## 2. Where it lives

- Recent (about 90 days) in Firestore, so the page can show it: collections `pmslog_price_events`, `pmslog_booking_events`, `pmslog_settings_events`; snapshots as one document per day and room (`pmslog_snapshots/{day}_{rt}` holding the 730 nights x currencies in one map, about 60 KB) to keep write counts low.
- Long-term: a daily export job at 03:00 Tbilisi writes the previous day as compressed files (newline JSON, gzip) into one Cloud Storage bucket `maxela-pms-history`, path `property_id=maxela/stream=price_events/day=2026-10-12/part-0.jsonl.gz`. Nothing is overwritten (bucket versioning on, retention lock 7 years).
- BigQuery reads those files through external tables, so nothing is loaded or paid for twice. A native BigQuery table can be added later for speed.
- Firestore rows older than 90 days are removed only after the export for that day is confirmed (file exists, row count matches). Cloud Storage is the record that stays forever.

## 3. Size per month (estimates)

Assumptions: 10 rooms, 2 currencies (Booking GEL, Airbnb USD), 365 nights ahead, up to 24 runs a day, about 600 changed prices a day in steady state (the first run after the move changes about 240 once, then far fewer), 400 booking events a month.

| Stream | Rows / month | Raw JSON | Compressed (gzip) |
|---|---|---|---|
| price_events (changes and blocks only) | about 20,000 | about 8 MB | about 1 MB |
| price_events if EVERY decision were kept (option B) | about 5,000,000 | about 1.3 GB | about 130 MB |
| price_snapshots | about 220,000 | about 27 MB | about 3 MB |
| booking_events | about 400 | under 1 MB | under 0.2 MB |
| settings_events | under 500 | under 1 MB | under 0.1 MB |
| Total, recommended | about 240,000 | about 37 MB | about 5 MB |

Per year: about 450 MB raw, about 60 MB compressed. Ten properties: about 600 MB compressed a year.

## 4. Cost per month (estimates; check Google's price page before relying on them)

Prices used: Firestore about 0.18 USD per 100,000 writes and 0.06 USD per 100,000 reads (Europe prices are about 20% higher), storage 0.18 USD per GB; Cloud Storage 0.02 USD per GB-month standard, 0.004 coldline; BigQuery storage 0.02 USD per GB-month, queries 6.25 USD per TB scanned with the first TB free each month.

| Item | Recommended (changes only) | Option B (every decision) |
|---|---|---|
| Firestore writes (events 20,000 + snapshots 300 + settings) | about 0.05 USD | about 9 USD (5 million writes) |
| Firestore storage, 90 days | under 0.01 USD | about 0.15 USD |
| Cloud Storage, grows 5 MB / month | under 0.01 USD for years | about 0.01 USD |
| BigQuery queries | 0 (inside the free TB) | 0 |
| Export job (GitHub Actions, 2 minutes a day) | 0 (inside the free minutes) | 0 |
| Total | about 0.1 USD a month | about 10 USD a month |

Option B writes decisions straight to files (not Firestore), which brings it to about 0.1 USD too; the Firestore page then shows only changes. That is what I would do if you want every decision kept.

## 5. What it does not do

- It does not change prices, the engine rules, or any page the guests see.
- It never stores guest names, phones, passports or reservation numbers.
- It does not replace MiniHotel or the existing `reservations` collection.
- The page shows only the last 90 days; older data is read from BigQuery.

## 6. Build order (about 4 steps, each tested before the next)

1. Settings log + `pmslog_*` collection writer and its tests (page and engine write one row per changed field).
2. Price events from the engine run, with engine and settings versions.
3. Daily snapshot job and booking events from the reservation sync.
4. Daily export to Cloud Storage, BigQuery external tables, a restore test (read a day back and compare to Firestore), then deleting Firestore rows older than 90 days.

## 7. Decisions needed from the owner

1. Recommended (changes and blocks only) or option B (every decision)?
2. Keep Firestore for 90 days, or 30 or 180?
3. A new Google Cloud bucket and a BigQuery dataset under project `sleepy-5c962`: OK to create, and in which region (`europe-west1` suggested)?
4. Retention lock on the bucket (nothing can be deleted for 7 years, even by you): yes or no?
5. Booking events: from the existing `reservations` sync, history starting from today (older reservations can be back-filled once, without guest data).

Property id for everything today: `maxela`. A future second property uses its own id and the same tables.
