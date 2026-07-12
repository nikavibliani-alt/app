"""
Price Outcome Tracker
======================
Tracks pricing decisions and booking outcomes to build a learning dataset.

Two main functions:
1. snapshot_prices()  — called after every engine run, saves current prices
2. record_outcomes()  — called every engine run, detects new bookings and
                        matches them to price snapshots

Data stored in Firestore:
  pricing_snapshots/{rt}_{date}_{YYYYMMDD} — price set on a given day
  pricing_outcomes/{rt}_{date}             — final outcome for a date
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
