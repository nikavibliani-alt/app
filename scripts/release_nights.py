"""Give hand-set nights back to the engine: adds "ROOM|YYYY-MM-DD" to pricing_config/control.release (the same list the pricing page writes).
Usage (through run_task): NIGHTS="XCV_1|2026-10-31,XCV_1|2026-11-01". With --dry only prints. Prints room and dates only."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pricing_shadow as ps  # noqa: E402


def main(argv=None):
    argv = argv or []
    dry = "--dry" in argv
    items = [x.strip() for x in os.environ.get("NIGHTS", "").split(",") if "|" in x]
    nights = [x for x in items if not x.startswith("-")]
    take_off = [x[1:] for x in items if x.startswith("-")]            # "-ROOM|DATE" takes a night off the give-back list again
    if not items:
        print("No nights given (NIGHTS=ROOM|DATE,...).")
        return
    db = ps.init_db()
    ref = db.collection("pricing_config").document("control")
    snap = ref.get()
    cur = [x for x in ((snap.to_dict() or {}).get("release") or [])] if snap.exists else []
    new = [n for n in nights if n not in cur]
    gone = [n for n in take_off if n in cur]
    print(f"Give back to the engine: {nights}. Already on the list: {[n for n in nights if n in cur]}. Adding: {new}. "
          f"Taking off the list: {gone} (asked {take_off}). {'(dry: nothing written)' if dry else ''}")
    if (new or gone) and not dry:
        ref.set({"release": [x for x in cur if x not in gone] + new}, merge=True)
        print("Written. The next run takes given-back nights off the list once it has handled them.")
