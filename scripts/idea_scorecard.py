"""
Idea scorecard runner (part of the nightly job). Reads the ideas and the stored stays, judges every decided idea
whose nights have all passed, saves pricing_scorecard/<idea id> and pricing_scorecard/_summary.
Prints counts only. Never changes a price, a rule or an idea.

  python scripts/idea_scorecard.py        # judge and save
  python scripts/idea_scorecard.py --dry  # judge and print counts; save nothing
"""

import argparse
import os
import sys
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import idea_scorecard as sc  # noqa: E402
import pricing_shadow as ps  # noqa: E402


def run(db, today: str, dry: bool = False) -> dict:
    ideas = []
    for status in ("approved", "auto_applied", "rejected"):
        for doc in db.collection("pricing_proposals").where("status", "==", status).stream():
            d = doc.to_dict() or {}
            if d.get("type") == "run_marker":
                continue
            ideas.append({**d, "id": doc.id})
    stays = sc.priced_stays(db, today)
    name_of = lambda rt: (ps.ROOM_TYPES.get(rt) or {}).get("name") or str(rt).replace("_", " ")  # noqa: E731
    existing = {d.id: (d.to_dict() or {}) for d in db.collection("pricing_scorecard").stream()}
    cards, saved = [], 0
    for p in ideas:
        old = existing.get(p["id"])
        if old and old.get("status") == "final":
            cards.append(old)                                    # a finished verdict is never changed
            continue
        c = sc.judge(p, stays, today, name_of)
        c["updated"] = today
        cards.append(c)
        if not dry:
            db.collection("pricing_scorecard").document(p["id"]).set(c)
            saved += 1
    summ = {**sc.summary(cards), "updated": today}
    if not dry:
        db.collection("pricing_scorecard").document("_summary").set(summ)
    print(f"Scorecard: {len(ideas)} decided ideas | finished {summ['finished']} (right {summ['right']}, wrong {summ['wrong']}, unclear {summ['unclear']}) | "
          f"still running {summ['tracking']} | no dates {sum(1 for c in cards if c.get('status') == 'no_dates')} | saved {saved}" + (" | DRY" if dry else ""))
    return summ


def main(argv=None, db=None, now=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry", action="store_true")
    args = ap.parse_args(argv)
    now = now or datetime.now(ps.TBILISI).replace(tzinfo=None)
    return run(db or ps.init_db(), now.date().isoformat(), args.dry)


if __name__ == "__main__":
    main()
