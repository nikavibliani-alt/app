"""
One-off: copy today's season date ranges from config.json into Firestore (pricing_config/rules.seasonRanges), exactly as they are, so the
pricing page and every engine read the same list. Does nothing if the field is already there. Changes no price.

  python scripts/seasons_migrate.py --dry
  python scripts/seasons_migrate.py
"""

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pricing_shadow as ps  # noqa: E402
from calm_pricing import seasons as sn  # noqa: E402


def run(db, repo_config: dict, dry: bool = False) -> dict:
    ref = db.collection("pricing_config").document("rules")
    snap = ref.get()
    page = (snap.to_dict() or {}) if snap.exists else {}
    if page.get("seasonRanges") is not None:
        print("Season dates are already in Firestore: nothing to do.")
        return {"written": False, "ranges": len(page["seasonRanges"])}
    ranges = sn.ranges_from_table(repo_config.get("seasons") or [])
    problems = sn.check(ranges)
    if problems:
        raise SystemExit("config.json season dates are not complete: " + " ".join(problems))
    # prove the copy changes nothing: every day of the year has the same season in both forms
    table = sn.engine_table(ranges)
    old = {d: next((s["name"] for s in repo_config["seasons"] for a, b in s["ranges"] if a <= d <= b), "mid") for d in sn.ALL_DAYS}
    new = {d: next((s["name"] for s in table for a, b in s["ranges"] if a <= d <= b), "mid") for d in sn.ALL_DAYS}
    if old != new:
        raise SystemExit("The copy would change a season: stopped.")
    print(f"Season dates: {len(ranges)} ranges copied from config.json; all 366 days keep their season" + (" | DRY: not written" if dry else ""))
    if not dry:
        ref.set({"seasonRanges": ranges}, merge=True)
    return {"written": not dry, "ranges": len(ranges)}


def main(argv=None, db=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry", action="store_true")
    args = ap.parse_args(argv)
    repo_config = json.load(open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "config.json")))
    return run(db or ps.init_db(), repo_config, args.dry)


if __name__ == "__main__":
    main()
