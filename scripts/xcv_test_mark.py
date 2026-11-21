"""
Mark the owner's XCV test in the history (pricing_changes, type owner_test), the same way as the Orbe 2 test, so the weekly report compares
before and after. The owner lowered the XCV prices by hand in MiniHotel from 3 Nov 2026, so no engine setting changes here: this only writes the mark.

  python scripts/xcv_test_mark.py --dry   # show what would be written
  python scripts/xcv_test_mark.py         # write one mark per XCV room (never twice)
"""
import argparse
import os
import sys
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pricing_shadow as ps  # noqa: E402

ROOMS = ["XCV_1", "XCV_2"]
START = "2026-11-03"
NAME = "owner test: lower XCV prices"
CHANGE = "prices lowered by hand in MiniHotel (about 120 lari / 30 dollars on the first nights), kept as the owner set them"


def main(argv=None, db=None, now=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry", action="store_true")
    args = ap.parse_args(argv)
    db = db or ps.init_db()
    marks = [d.to_dict() or {} for d in db.collection("pricing_changes").where("type", "==", "owner_test").stream()]
    have = {(m.get("test") or {}).get("room") for m in marks if (m.get("test") or {}).get("name") == NAME}
    todo = [r for r in ROOMS if r not in have]
    print(f"{NAME}: marks to write {todo or 'none (already marked)'} | start {START} | no planned end (it runs until the owner changes it)" + (" | DRY: nothing written" if args.dry else ""))
    if args.dry or not todo:
        return {"todo": todo}
    from firebase_admin import firestore
    for room in todo:
        db.collection("pricing_changes").add({
            "ts": firestore.SERVER_TIMESTAMP, "type": "owner_test", "detail": f"{NAME} from {START} ({room})", "by": "owner (asked in chat)",
            "fields": {f"owner_test/{room}/prices": {"old": "engine prices", "new": f"owner prices from {START}"}},
            "test": {"room": room, "name": NAME, "from": START, "to": None, "change": CHANGE}})
    print(f"Marked {len(todo)} rooms in the history.")
    return {"todo": todo, "written": len(todo)}


if __name__ == "__main__":
    main(sys.argv[1:])
