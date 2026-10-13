"""
One-off (and safe to repeat) clean-up of the WAITING ideas after the ideas-logic change. Changes no price and no rule.
  - an idea with no sellable night left (every unit booked, past, hand-set or protected) -> rejected with the reason
    "Not useful: nothing left to sell"
  - more than one waiting idea for the same room + season + price list -> the newest stays, older ones are marked
    "Replaced by a newer idea"
Nothing is deleted: the ideas stay in the history. Prints counts only.

  python scripts/ideas_logic_cleanup.py --dry   # count only
  python scripts/ideas_logic_cleanup.py         # mark them
"""

import argparse
import copy
import json
import os
import sys
from collections import Counter
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import idea_evidence as ie  # noqa: E402
import pricing_shadow as ps  # noqa: E402

REPLACED_REASON = "Replaced by a newer idea"


def run(db, today: str, repo_config: dict, dry: bool = False) -> dict:
    snap = db.collection("pricing_config").document("rules").get()
    rules = (snap.to_dict() or {}) if snap.exists else {}
    config = copy.deepcopy(repo_config)
    if rules.get("dateOverrides") is not None:
        config["dateOverrides"] = rules["dateOverrides"]
    locks = ie.locked_nights(db)
    ideas = []
    for doc in db.collection("pricing_proposals").where("status", "==", "pending").stream():
        d = doc.to_dict() or {}
        if d.get("type") != "run_marker" and d.get("property") and d.get("season") and d.get("type"):
            ideas.append({**d, "id": doc.id})
    daily, useful, not_useful = {}, [], []
    for p in ideas:
        if p["property"] not in daily:
            daily[p["property"]] = ie.load_daily(db, p["property"], today)
        sl = ie.sellable(db, config, today, p["property"], p["season"], p["type"], locks, daily[p["property"]])
        (useful if sl["count"] > 0 else not_useful).append(p)
    groups = {}
    for p in useful:
        groups.setdefault((p["property"], p["season"], ie.price_list_of(p["type"])), []).append(p)
    repeats, keep = [], []
    for key, items in groups.items():
        items.sort(key=lambda x: x.get("ts") or "")
        keep.append(items[-1])
        repeats += [(x, items[-1]["id"]) for x in items[:-1]]
    now = datetime.now()
    if not dry:
        for p in not_useful:
            db.collection("pricing_proposals").document(p["id"]).update(
                {"status": "rejected", "rejection_reason": ie.NOT_USEFUL, "rejected_at": now, "closed_by": "ideas_logic_cleanup"})
        for p, newest in repeats:
            db.collection("pricing_proposals").document(p["id"]).update(
                {"status": "rejected", "rejection_reason": REPLACED_REASON, "rejected_at": now, "replaced_by": newest, "closed_by": "ideas_logic_cleanup"})
    by_room = dict(sorted(Counter(p["property"] for p in keep).items()))
    out = {"checked": len(ideas), "not_useful": len(not_useful), "repeats": len(repeats), "left": len(keep), "by_room": by_room}
    print(f"Ideas clean-up: {len(ideas)} waiting checked | not useful (nothing left to sell) {len(not_useful)} | repeats {len(repeats)} | "
          f"left {len(keep)} | rooms {by_room or 'none'}" + (" | DRY" if dry else ""))
    return out


def main(argv=None, db=None, now=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry", action="store_true")
    args = ap.parse_args(argv)
    now = now or datetime.now(ps.TBILISI).replace(tzinfo=None)
    repo_config = json.load(open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "config.json")))
    return run(db or ps.init_db(), now.date().isoformat(), repo_config, args.dry)


if __name__ == "__main__":
    main()
