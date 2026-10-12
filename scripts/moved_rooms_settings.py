"""
Before the six old rooms go live on the new engine: make the settings saved in Firestore
(pricing_config/engine_v2, settings.room_types.<room>) agree with live, normal, 90 days.
Values saved on the pricing page win over calm_settings.json, and some of the six still have an
old "window_days: 180" saved. Only values that are already saved AND differ are changed, one field path
at a time (nothing else in the document is touched). Without --apply it only prints what it would change.

  python scripts/moved_rooms_settings.py            # print only
  python scripts/moved_rooms_settings.py --apply    # write the field paths
"""

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

SIX = ["ROOMS", "MAXELA", "BIG_APT", "FREEDOM", "ORBE_1", "ORBE_2"]
WANT = {"engine": "live", "style": "normal", "window_days": 90}


def run(db, apply=False):
    ref = db.collection("pricing_config").document("engine_v2")
    snap = ref.get()
    saved = ((snap.to_dict() if snap.exists else {}) or {}).get("settings", {}).get("room_types", {}) or {}
    updates = {}
    for rt in SIX:
        for k, v in WANT.items():
            if k in (saved.get(rt) or {}) and saved[rt][k] != v:
                updates[f"settings.room_types.{rt}.{k}"] = v
                print(f"  {rt}.{k}: {saved[rt][k]!r} -> {v!r}")
    if not updates:
        print("Nothing to change: no saved value differs from live, normal, 90 days.")
    elif apply:
        ref.update(updates)
        print(f"Changed {len(updates)} saved value(s). Nothing else in the document was touched.")
    else:
        print(f"{len(updates)} value(s) would change. Run with --apply to write them.")
    return updates


def main(argv=None, db=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args(argv)
    if db is None:
        import pricing_shadow as ps
        db = ps.init_db()
    return run(db, apply=args.apply)


if __name__ == "__main__":
    main()
