"""
Read-only: find hand-set prices that the engine changed. Looks in the history log (pmslog_price_events) and the saved daily prices
for USD (Airbnb) prices that were brought up to the minimum, and prints room, date, old and new price and the engine's own reason.
Prints no guest data. Writes nothing.
"""
import os
import sys
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pricing_shadow as ps  # noqa: E402


def main(argv=None, db=None, now=None):
    now = now or datetime.now(ps.TBILISI).replace(tzinfo=None)
    db = db or ps.init_db()
    rows = []
    for d in db.collection("pmslog_price_events").stream():
        e = d.to_dict() or {}
        if e.get("kind") == "correction":
            rows.append(("log", e.get("day"), e.get("rt"), e.get("date"), e.get("currency"), e.get("old"), e.get("new"), e.get("min"), e.get("reason")))
    for back in range(0, 4):
        day = (now.date() - timedelta(days=back)).isoformat()
        for rt in ps.ROOM_TYPES:
            snap = db.collection("pricing_calm_daily").document(f"{day}_{rt}").get()
            if not snap.exists:
                continue
            for key, r in ((snap.to_dict() or {}).get("dates") or {}).items():
                if key.endswith("|USD") and r.get("kind") == "correction":
                    rows.append(("daily", day, rt, key.split("|")[0], "USD", r.get("virtual_before"), r.get("new"), r.get("min"), " / ".join(r.get("why") or [])[-160:]))
    rows.sort(key=lambda x: (str(x[1]), str(x[2]), str(x[3])))
    print(f"Corrections found: {len(rows)}")
    for src, day, rt, date, cur, old, new, mn, why in rows[:60]:
        if cur == "USD" or src == "log":
            print(f"  [{src}] seen {day} | {rt} | night {date} | {cur} | {old} -> {new} (min {mn}) | {why}")
    return rows


if __name__ == "__main__":
    main()
