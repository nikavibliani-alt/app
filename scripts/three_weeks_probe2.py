"""Read-only follow-up: the XCV rows of the saved weekly reports before the owner test, and whether stays still turn 'cancelled' after they end.
Writes NOTHING. Prints rooms, dates and counts only."""
import collections
import os
import sys
from datetime import date, datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pricing_shadow as ps  # noqa: E402


def main():
    db = ps.init_db()
    now = datetime.now(ps.TBILISI).replace(tzinfo=None)
    today = now.date()
    print("=== Saved weekly numbers: bookings made / nights sold per room, XCV and all ===")
    for d in sorted(db.collection("pricing_weekly").stream(), key=lambda x: x.id):
        if d.id[:2] != "20":
            continue
        n = (d.to_dict() or {}).get("numbers") or {}
        rooms = n.get("rooms") or {}
        wk = n.get("week") or {}
        tb = sum((v.get("bookings_made") or 0) for v in rooms.values())
        tn = sum((v.get("nights_sold") or 0) for v in rooms.values())
        x1, x2 = rooms.get("XCV_1") or {}, rooms.get("XCV_2") or {}
        print(f"  {d.id} {wk.get('from')}..{wk.get('to')}: all rooms {tb} bookings / {tn} nights | XCV_1 {x1.get('bookings_made')} / {x1.get('nights_sold')} | XCV_2 {x2.get('bookings_made')} / {x2.get('nights_sold')}"
              f" | XCV max-nights {x1.get('nights_hit_max')}/{x2.get('nights_hit_max')} min-nights {x1.get('nights_hit_min')}/{x2.get('nights_hit_min')}")
    print("\n=== Do finished stays still turn 'cancelled'? (reservations collection, counts only) ===")
    rows = [d.to_dict() or {} for d in db.collection("reservations").where("checkin", ">=", (today - timedelta(days=60)).isoformat()).stream()]
    print(f"  stays with check-in in the last 60 days and later: {len(rows)}; by status {dict(collections.Counter(r.get('status') for r in rows))}")
    nm = [r for r in rows if r.get("statusDescription") == "Cancelled (not in MiniHotel)"]
    print(f"  marked 'Cancelled (not in MiniHotel)': {len(nm)}")
    past = [r for r in nm if str(r.get("checkout") or "") < today.isoformat()]
    fut = [r for r in nm if str(r.get("checkin") or "") >= today.isoformat()]
    print(f"    of which the stay was already over: {len(past)}; still to come: {len(fut)}")
    by_gap = collections.Counter()
    for r in past:
        ts = r.get("syncedAt")
        try:
            gap = (date.fromisoformat(str(ts)[:10]) - date.fromisoformat(r["checkout"])).days
        except Exception:
            continue
        by_gap[min(max(gap, -1), 12)] += 1
    print("    days between check-out and the day it was marked (marked-on-day minus check-out):", dict(sorted(by_gap.items())))
    xcv = [r for r in rows if r.get("roomCode") in ("xcv-1", "xcv-2")]
    print(f"  XCV stays in that span: {len(xcv)}; by status {dict(collections.Counter(r.get('status') for r in xcv))}")
    print("PROBE FINISHED")


if __name__ == "__main__":
    main()
