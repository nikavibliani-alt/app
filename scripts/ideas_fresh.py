"""
One manual fresh set of ideas: the idea maker runs now (ignoring its once-a-week gate), every new idea saves its
evidence, and the ideas that were waiting before are marked "Replaced by a newer idea" (status rejected, never
deleted, so they stay in the history). If the idea maker makes nothing, nothing is replaced.
Nothing in pricing_config/rules is changed, and no price is calculated or written.

  python scripts/ideas_fresh.py
"""

from __future__ import annotations

import os
import sys
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import claude_pricing as cp  # noqa: E402


def pending_ids(db) -> set:
    out = set()
    for snap in db.collection("pricing_proposals").where("status", "==", "pending").stream():
        d = snap.to_dict() or {}
        if d.get("type") != "run_marker":
            out.add(snap.id)
    return out


def run(db, config: dict) -> dict:
    before = pending_ids(db)
    cp.claude_write_daily_proposal(config, db, {}, force=True)
    after = pending_ids(db)
    new = after - before
    old = before & after                      # still waiting: not replaced by the maker's own same-key rule
    closed = 0
    if new:
        for pid in sorted(old):
            db.collection("pricing_proposals").document(pid).update({
                "status": "rejected", "rejection_reason": cp.REPLACED_REASON, "rejected_at": datetime.now(),
                "replaced_by": "fresh_set"})
            closed += 1
    withev = sum(1 for pid in new if (db.collection("pricing_proposals").document(pid).get().to_dict() or {}).get("evidence"))
    print(f"Ideas waiting before: {len(before)} | new ideas: {len(new)} (with saved evidence: {withev}) | "
          f"older ideas marked replaced: {len(before - after) + closed}"
          + ("" if new else " | the idea maker made nothing, so nothing was replaced"))
    if new and os.environ.get("SHOW_ONE_IDEA"):                       # prices, dates and counts only: no guest data
        import json
        d = db.collection("pricing_proposals").document(sorted(new)[0]).get().to_dict() or {}
        print("ONE_IDEA " + json.dumps({k: d.get(k) for k in ("property", "season", "type", "current", "suggested", "change_pct", "reasoning", "status", "ts", "evidence")}, default=str))
    return {"before": len(before), "new": len(new), "with_evidence": withev, "replaced": len(before - after) + closed}


def main():
    import pricing_engine as pe
    db = pe._firestore_client()
    if db is None:
        raise SystemExit("FIREBASE_SERVICE_ACCOUNT is not set")
    if not os.environ.get("ANTHROPIC_API_KEY"):
        raise SystemExit("ANTHROPIC_API_KEY is not set")
    config = pe.load_config(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "config.json"))
    err = pe.load_firestore_rules(db, config)
    if err:
        raise SystemExit(f"rules could not be read: {err}")
    r = run(db, config)
    if not r["new"]:
        sys.exit(1)


if __name__ == "__main__":
    main()
