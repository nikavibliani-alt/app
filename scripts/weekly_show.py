"""Read-only: summary of the saved weekly report (counts only)."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import pricing_shadow as ps  # noqa: E402


def main(argv=None, db=None):
    db = db or ps.init_db()
    for d in db.collection("pricing_weekly").stream():
        w = d.to_dict() or {}
        n, r = w.get("numbers") or {}, w.get("report") or {}
        rooms = n.get("rooms") or {}
        print(f"Weekly {d.id} | {w.get('from')} to {w.get('to')} | cancellations (sum of rooms) {sum(v.get('cancellations') or 0 for v in rooms.values())} | "
              f"bookings made {sum(v.get('bookings_made') or 0 for v in rooms.values())} | checked {r.get('checked')} | "
              f"kept worked {len(r.get('worked') or [])} didnt {len(r.get('didnt') or [])} upgrades {len(r.get('upgrades') or [])} | "
              f"removed {len(r.get('removed') or [])} edited {r.get('edited')} | draft items {r.get('draft_items')} | notes {len(n.get('data_notes') or [])}")
        for x in (r.get("removed") or [])[:10]:
            print(f"   removed {x.get('id')}: {x.get('why')}")
        print("   headline:", (r.get("headline") or "")[:200])


if __name__ == "__main__":
    main()
