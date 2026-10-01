"""
Price Outcome Tracker
======================
Tracks pricing decisions and booking outcomes to build a learning dataset.

Functions:
1. snapshot_prices()         — called after every engine run, saves current prices
2. record_outcomes()         — called every engine run, detects new bookings and
                               matches them to price snapshots
3. get_learning_context()    — builds AI prompt context from past outcomes
4. load_experiment_locks()   — loads manual experiment lock state per date
5. detect_manual_experiments() — compares current prices to last_engine_price
6. update_engine_prices_in_locks() — records engine-set price as new baseline
7. record_experiment_outcome()     — saves experiment result to pricing_outcomes

Data stored in Firestore:
  pricing_snapshots/{rt}_{date}_{YYYYMMDD_HHMM} — timestamped engine price history
  pricing_outcomes/{rt}_{date}                   — final booking outcome per date
  pricing_locks/{rt}_{date}                      — per-date manual experiment lock state
"""

import json
import os
import sys
from datetime import datetime, timedelta

ROOM_TYPES = ["ROOMS", "MAXELA", "BIG_APT", "FREEDOM", "ORBE_1", "ORBE_2"]

# Room code → property type mapping
ROOM_TO_PROPERTY = {}
for i in range(1, 6):
    ROOM_TO_PROPERTY[f"0-{i}"] = "ROOMS"
for i in range(1, 5):
    ROOM_TO_PROPERTY[f"6-{i}"] = "MAXELA"
ROOM_TO_PROPERTY["6-3"] = "BIG_APT"
for i in [1, 2, 3]:
    ROOM_TO_PROPERTY[f"tab-{i}"] = "FREEDOM"
ROOM_TO_PROPERTY["orb-1"] = "ORBE_1"
ROOM_TO_PROPERTY["orb-2"] = "ORBE_1"
ROOM_TO_PROPERTY["orb-3"] = "ORBE_2"
for i in range(1, 5):
    ROOM_TO_PROPERTY[f"7-{i}"] = "MAXELA"


def get_db():
    """Get Firestore client, reusing existing firebase_admin app."""
    import firebase_admin
    from firebase_admin import firestore
    return firestore.client()


# ---------------------------------------------------------------------------
# 1. SNAPSHOT PRICES
# ---------------------------------------------------------------------------

def snapshot_prices(results: dict):
    """
    Save today's prices to Firestore after each engine run.
    One document per property per date per day.
    """
    try:
        db = get_db()
        now = datetime.now()
        today = now.strftime("%Y-%m-%d")
        run_stamp = now.strftime("%Y%m%d_%H%M")
        batch = db.batch()
        count = 0

        for rt, dates in results.items():
            for d in dates:
                if d.get("skip"):
                    continue
                doc_id = f"{rt}_{d['date']}_{run_stamp}"
                ref = db.collection("pricing_snapshots").document(doc_id)
                batch.set(ref, {
                    "property":      rt,
                    "date":          d["date"],
                    "snapshot_date": today,
                    "price_gel":     d["proposed_gel"],
                    "price_eur":     d.get("proposed_eur", 0),
                    "occupancy_pct": d.get("occupancy_pct", 0),
                    "days_ahead":    d.get("days_ahead", 0),
                    "season":        d.get("season", ""),
                    "changed":       d.get("changed", False),
                    "reason":        d.get("reason", ""),
                    "ts":            datetime.now().isoformat(),
                })
                count += 1

                if count % 400 == 0:
                    batch.commit()
                    batch = db.batch()

        batch.commit()
        print(f"  Saved {count} price snapshots to Firestore.")

    except Exception as e:
        print(f"  Warning: could not save price snapshots: {e}", file=sys.stderr)


# ---------------------------------------------------------------------------
# 2. RECORD OUTCOMES
# ---------------------------------------------------------------------------

def record_outcomes(raw_data: list):
    """
    Detect newly booked dates by comparing current availability to snapshots.
    When a date goes from available → booked, record the outcome with
    what price was set and what the conditions were.
    """
    try:
        db = get_db()
        today = datetime.now().date()
        today_str = today.strftime("%Y-%m-%d")
        outcomes_recorded = 0

        for entry in raw_data:
            rt = entry.get("RoomTypeCode")
            if rt not in ROOM_TYPES:
                continue

            for d in entry.get("Dates", []):
                date_str = d["Date"].split("T")[0] if "T" in d["Date"] else d["Date"]
                avail = d.get("Availability") or d.get("DefaultAvailability") or 0

                # Only care about dates that are now fully booked (avail=0)
                if int(avail) != 0:
                    continue

                # Check if we have an outcome already recorded
                outcome_id = f"{rt}_{date_str}"
                existing = db.collection("pricing_outcomes").document(outcome_id).get()
                if existing.exists:
                    continue  # Already recorded

                # Find the most recent price snapshot for this date
                snapshots = db.collection("pricing_snapshots")\
                    .where("property", "==", rt)\
                    .where("date", "==", date_str)\
                    .order_by("snapshot_date", direction="DESCENDING")\
                    .limit(5)\
                    .stream()

                snap_list = [s.to_dict() for s in snapshots]
                if not snap_list:
                    continue

                # Use the snapshot from just before it was booked
                # (most recent snapshot where it was still available)
                best_snap = None
                for snap in snap_list:
                    if snap.get("occupancy_pct", 100) < 100:
                        best_snap = snap
                        break
                if not best_snap:
                    best_snap = snap_list[0]

                # Calculate how many days before checkin it was booked
                try:
                    checkin_date = datetime.strptime(date_str, "%Y-%m-%d").date()
                    days_before_checkin = (checkin_date - today).days
                except Exception:
                    days_before_checkin = best_snap.get("days_ahead", 0)

                # Check if booking happened within 24h of the snapshot
                booked_within_24h = False
                snap_ts = best_snap.get("ts")
                if snap_ts:
                    try:
                        snap_time = datetime.fromisoformat(snap_ts)
                        booked_within_24h = (datetime.now() - snap_time).total_seconds() < 86400
                    except Exception:
                        pass

                # Record the outcome
                db.collection("pricing_outcomes").document(outcome_id).set({
                    "property":             rt,
                    "date":                 date_str,
                    "booked":               True,
                    "price_gel_at_booking": best_snap.get("price_gel", 0),
                    "price_eur_at_booking": best_snap.get("price_eur", 0),
                    "occupancy_at_booking": best_snap.get("occupancy_pct", 0),
                    "days_ahead_at_booking":best_snap.get("days_ahead", days_before_checkin),
                    "season":               best_snap.get("season", ""),
                    "booked_on":            today_str,
                    "days_before_checkin":  days_before_checkin,
                    "booked_within_24h":    booked_within_24h,
                    "ts":                   datetime.now().isoformat(),
                })
                outcomes_recorded += 1

        if outcomes_recorded:
            print(f"  Recorded {outcomes_recorded} new booking outcomes.")

    except Exception as e:
        print(f"  Warning: could not record outcomes: {e}", file=sys.stderr)


# ---------------------------------------------------------------------------
# 3. GET LEARNING CONTEXT FOR AI
# ---------------------------------------------------------------------------

def get_learning_context(db, days_back: int = 60) -> str:
    """
    Build a learning context string from past outcomes for the AI prompt.
    Returns a summary of what prices worked and didn't work.
    """
    try:
        cutoff = (datetime.now() - timedelta(days=days_back)).strftime("%Y-%m-%d")

        outcomes = db.collection("pricing_outcomes")\
            .where("booked_on", ">=", cutoff)\
            .stream()

        # Group by property
        from collections import defaultdict
        by_prop = defaultdict(list)
        for doc in outcomes:
            data = doc.to_dict()
            by_prop[data["property"]].append(data)

        if not by_prop:
            return ""

        lines = [f"\n## HISTORICAL BOOKING DATA (last {days_back} days — use this to learn pricing patterns)\n"]

        for rt, records in by_prop.items():
            if not records:
                continue
            lines.append(f"\n### {rt} — {len(records)} bookings recorded")

            # Group by season
            by_season = defaultdict(list)
            for r in records:
                by_season[r.get("season", "unknown")].append(r)

            for season, recs in by_season.items():
                prices = [r["price_gel_at_booking"] for r in recs if r.get("price_gel_at_booking")]
                days_before = [r["days_before_checkin"] for r in recs if r.get("days_before_checkin") is not None]
                if prices:
                    avg_price = sum(prices) / len(prices)
                    avg_days = sum(days_before) / len(days_before) if days_before else 0
                    min_p = min(prices)
                    max_p = max(prices)
                    lines.append(
                        f"  {season}: {len(recs)} bookings — "
                        f"price range {min_p:.0f}–{max_p:.0f} GEL (avg {avg_price:.0f}), "
                        f"avg booked {avg_days:.0f} days before checkin"
                    )

        return "\n".join(lines)

    except Exception as e:
        print(f"  Warning: could not load learning context: {e}", file=sys.stderr)
        return ""


# ---------------------------------------------------------------------------
# 4. MANUAL EXPERIMENT LOCKS
# ---------------------------------------------------------------------------

def load_experiment_locks(db, date_from: str, date_to: str) -> dict:
    """
    Load current manual experiment lock state for all dates in the pricing window.
    Returns {rt: {date_str: lock_doc_data}}.

    Stored in pricing_locks/{rt}_{date} — one stable doc per property/date.
    """
    result = {}
    try:
        docs = db.collection("pricing_locks") \
            .where("date", ">=", date_from) \
            .where("date", "<=", date_to) \
            .stream()
        for doc in docs:
            data = doc.to_dict()
            rt = data.get("property")
            date_str = data.get("date")
            if rt and date_str:
                result.setdefault(rt, {})[date_str] = data
    except Exception as e:
        print(f"  Warning: could not load experiment locks: {e}", file=sys.stderr)
    return result


def detect_manual_experiments(db, raw_data: list, locks: dict) -> dict:
    """
    Detect manual price experiments by comparing current MiniHotel prices against
    last_engine_price stored in pricing_locks.

    Detection uses EXACT mismatch — no percentage threshold.
    Only detects when a baseline (last_engine_price) exists for the date.

    Updates Firestore pricing_locks for newly detected experiments.
    Returns the updated locks dict.
    """
    try:
        now_str = datetime.now().isoformat()
        batch = db.batch()
        batch_count = 0

        for entry in raw_data:
            rt = entry.get("RoomTypeCode")
            if rt not in ROOM_TYPES:
                continue

            for d in entry.get("Dates", []):
                date_str = d["Date"].split("T")[0] if "T" in d["Date"] else d["Date"]
                avail = int(d.get("Availability") or d.get("DefaultAvailability") or 0)

                # Parse current GEL and EUR prices from MiniHotel
                current_gel = 0.0
                current_eur = 0.0
                for r in d.get("Rates", []) or []:
                    pl = r.get("PriceList")
                    price = float(r.get("Price") or 0)
                    if pl == "GEL":
                        current_gel = price
                    elif pl == "EUR":
                        current_eur = price

                lock = locks.get(rt, {}).get(date_str)
                last_engine_price = lock.get("last_engine_price", 0.0) if lock else 0.0

                # No baseline yet — can't detect manual change
                if last_engine_price <= 0 or current_gel <= 0:
                    continue

                doc_ref = db.collection("pricing_locks").document(f"{rt}_{date_str}")
                already_locked = bool(lock and lock.get("manual_lock", False))

                if current_gel != last_engine_price:
                    if not already_locked:
                        # New manual experiment — record it
                        direction = "discount" if current_gel < last_engine_price else "premium"
                        diff_pct = abs(current_gel - last_engine_price) / last_engine_price * 100
                        update = {
                            "property":              rt,
                            "date":                  date_str,
                            "last_engine_price":     last_engine_price,
                            "last_engine_price_eur": lock.get("last_engine_price_eur", 0.0) if lock else 0.0,
                            "last_engine_ts":        lock.get("last_engine_ts", "") if lock else "",
                            "manual_lock":           True,
                            "manual_price":          current_gel,
                            "manual_price_eur":      current_eur,
                            "manual_avail_at_set":   avail,
                            "manual_set_at":         now_str,
                            "baseline_price":        current_gel,
                            "baseline_price_eur":    current_eur,
                            "manual_reason":         "unknown",
                        }
                        batch.set(doc_ref, update, merge=True)
                        batch_count += 1
                        locks.setdefault(rt, {})[date_str] = {**(lock or {}), **update}
                        print(
                            f"  Manual experiment detected: {rt} {date_str} — "
                            f"engine={last_engine_price:.0f} GEL → manual={current_gel:.0f} GEL "
                            f"({direction} {diff_pct:.1f}%), avail={avail}"
                        )
                    # else: already locked — booking/timeout handled by velocity engine

                else:
                    # Price matches engine price — clear any stale lock
                    if already_locked:
                        batch.set(doc_ref, {"manual_lock": False}, merge=True)
                        batch_count += 1
                        locks.setdefault(rt, {})[date_str] = {**lock, "manual_lock": False}

                if batch_count >= 450:
                    batch.commit()
                    batch = db.batch()
                    batch_count = 0

        if batch_count > 0:
            batch.commit()

    except Exception as e:
        print(f"  Warning: manual experiment detection failed: {e}", file=sys.stderr)

    return locks


def update_engine_prices_in_locks(db, results: dict, experiment_locks: dict = None):
    """
    After the engine writes new prices to MiniHotel, record last_engine_price
    in pricing_locks so future runs can detect manual changes against this baseline.

    Only updates dates where:
    - price changed (changed=True), OR
    - a manual experiment was just released (_experiment_released=True), OR
    - no lock doc exists yet for this date (initial bootstrapping)

    Also clears manual_lock for dates where the engine took over.
    """
    try:
        batch = db.batch()
        batch_count = 0
        updated = 0
        now_str = datetime.now().isoformat()

        for rt, dates in results.items():
            for d in dates:
                # Skip truly locked/booked dates (no engine write happened)
                if d.get("skip") and not d.get("_experiment_released"):
                    continue

                date_str = d["date"]
                existing_lock = (experiment_locks or {}).get(rt, {}).get(date_str)

                # Skip unchanged dates that already have a baseline (reduces Firestore writes)
                if not d.get("changed") and not d.get("_experiment_released") and existing_lock:
                    continue

                doc_ref = db.collection("pricing_locks").document(f"{rt}_{date_str}")
                update = {
                    "property":              rt,
                    "date":                  date_str,
                    "last_engine_price":     d["proposed_gel"],
                    "last_engine_price_eur": d.get("proposed_eur", 0.0),
                    "last_engine_ts":        now_str,
                }
                # Engine wrote a price — any active lock is cleared
                if d.get("changed") or d.get("_experiment_released"):
                    update["manual_lock"] = False

                batch.set(doc_ref, update, merge=True)
                batch_count += 1
                updated += 1

                if batch_count >= 450:
                    batch.commit()
                    batch = db.batch()
                    batch_count = 0

        if batch_count > 0:
            batch.commit()

        if updated:
            print(f"  Updated engine price baseline for {updated} dates in pricing_locks.")

    except Exception as e:
        print(f"  Warning: could not update engine prices in locks: {e}", file=sys.stderr)


def record_experiment_outcome(db, rt: str, date_str: str, lock: dict, booked: bool):
    """
    Save the result of a manual experiment to pricing_outcomes.
    Called when an experiment ends — either by a booking or by timeout.
    Uses merge=True so it doesn't clobber a real booking outcome if one exists.
    """
    try:
        last_engine_price = lock.get("last_engine_price", 0)
        manual_price = lock.get("manual_price", 0)
        discount_pct = 0.0
        if last_engine_price > 0 and manual_price > 0:
            discount_pct = (last_engine_price - manual_price) / last_engine_price * 100

        outcome_id = f"{rt}_{date_str}"
        db.collection("pricing_outcomes").document(outcome_id).set({
            "property":                rt,
            "date":                    date_str,
            "booked":                  booked,
            "manual_experiment":       True,
            "manual_price":            manual_price,
            "last_engine_price":       last_engine_price,
            "manual_discount_pct":     round(discount_pct, 1),
            "booked_within_experiment":booked,
            "manual_reason":           lock.get("manual_reason", "unknown"),
            "ts":                      datetime.now().isoformat(),
        }, merge=True)
    except Exception as e:
        print(f"  Warning: could not record experiment outcome: {e}", file=sys.stderr)
