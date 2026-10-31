"""Give hand-set nights back to the engine: adds "ROOM|YYYY-MM-DD" to pricing_config/control.release (the same list the pricing page writes).
Usage (through run_task): NIGHTS="XCV_1|2026-10-31,XCV_1|2026-11-01". With --dry only prints. Prints room and dates only."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pricing_shadow as ps  # noqa: E402


def main(argv=None):
    argv = argv or []
    dry = "--dry" in argv
    nights = [x.strip() for x in os.environ.get("NIGHTS", "").split(",") if "|" in x]
    if not nights:
        print("No nights given (NIGHTS=ROOM|DATE,...).")
        return
    db = ps.init_db()
    ref = db.collection("pricing_config").document("control")
    snap = ref.get()
    cur = [x for x in ((snap.to_dict() or {}).get("release") or [])] if snap.exists else []
    new = [n for n in nights if n not in cur]
    print(f"Give back to the engine: {nights}. Already on the list: {[n for n in nights if n in cur]}. Adding: {new}. {'(dry: nothing written)' if dry else ''}")
    if new and not dry:
        ref.set({"release": cur + new}, merge=True)
        print("Written. The next run takes them off the list once it has handled them.")
