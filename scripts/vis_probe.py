"""Read-only: is one future stay (Big apartment, check-in 2026-12-30) in our records and visible to the check-in admin and housekeeping pages?
Prints room, status, dates, rank and room settings only (no guest data)."""
import os
import sys
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import pricing_shadow as ps  # noqa: E402


def main():
    db = ps.init_db()
    today = datetime.now(ps.TBILISI).date()
    cands = [dict(d.to_dict() or {}, _id=d.id) for d in db.collection("reservations").where("checkin", "==", "2026-12-30").stream()]
    mine = [d for d in cands if "vorotynt" in (str(d.get("lastName", "")) + str(d.get("guest", ""))).lower()]
    print(f"Records with check-in 2026-12-30: {len(cands)}; matching the name: {len(mine)}")
    for d in mine:
        room = d.get("roomCode")
        cutoff = (today - timedelta(days=365)).isoformat()
        newer = sum(1 for _ in db.collection("reservations").where("checkin", ">", d["checkin"]).stream())
        total = sum(1 for _ in db.collection("reservations").where("checkin", ">=", cutoff).stream())
        print(f"  room {room} | status {d.get('status')} / {d.get('statusDescription')} | {d.get('checkin')}..{d.get('checkout')} | source {d.get('source')} | synced {str(d.get('syncedAt'))[:19]}")
        print(f"  check-in admin loads the newest 1000 of {total} records with check-in in the last 365 days or later: this stay is number {newer + 1} -> {'visible' if newer < 1000 else 'CUT OFF'}")
        rm = db.collection("checkin_rooms").document(str(room)).get()
        rd = rm.to_dict() if rm.exists else None
        print(f"  room record: {({k: rd.get(k) for k in ('displayName', 'active', 'showInHk', 'site')} if rd else 'MISSING')}")
        print(f"  housekeeping loads stays with check-out from a few days ago on, for the rooms of the team: this stay qualifies if the room is shown in housekeeping -> {'yes' if rd and rd.get('showInHk') is not False and rd.get('active') is not False else 'check room settings'}")
        hk = [x.id for x in db.collection("checkin_guests").where("matchedReservationId", "==", d["_id"]).stream()]
        print(f"  check-in forms matched to it: {len(hk)}")
    print("PROBE FINISHED")


if __name__ == "__main__":
    main()
