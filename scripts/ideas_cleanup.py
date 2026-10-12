"""
Pending ideas (pricing_proposals): summary, and closing the ones that are out of date.

An idea is out of date when it is older than 7 days, or when the "current" number it was written
for is no longer the number in pricing_config/rules (what the pricing page shows and what Apply checks).
Closing an idea only sets its own status to "rejected" with the reason "out of date" (the pricing page
shows it as Skipped, and "Show again" puts it back). NOTHING in pricing_config/rules is ever changed.

Usage:
  python scripts/ideas_cleanup.py            # summary only, writes nothing
  python scripts/ideas_cleanup.py --apply    # also close the out-of-date ideas
"""

from __future__ import annotations

import argparse
import os
import sys
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

TBILISI = timezone(timedelta(hours=4))
MAX_AGE_DAYS = 7
REASON = "out of date"

# idea type -> (rules table, has min/max leaf)
PATHS = {
    "startprice": ("startPrices", None),
    "floor": ("priceRules", "min"),
    "ceiling": ("priceRules", "max"),
    "startpriceeur": ("startPricesEur", None),
    "flooreur": ("eurRules", "min"),
    "ceilingeur": ("eurRules", "max"),
}


def num(v):
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def rules_value(rules: dict, p: dict):
    """The number in pricing_config/rules for this idea's room, season and field (None when not set)."""
    t = str(p.get("type") or p.get("field") or "").lower()
    table, leaf = PATHS.get(t, (None, None))
    if not table:
        return None
    cell = ((rules.get(table) or {}).get(p.get("property")) or {}).get(p.get("season"))
    if leaf:
        cell = cell.get(leaf) if isinstance(cell, dict) else None
    return num(cell)


def idea_date(p: dict) -> date | None:
    s = str(p.get("date") or str(p.get("ts") or "")[:10])
    try:
        return date.fromisoformat(s[:10])
    except ValueError:
        return None


def classify(p: dict, rules: dict, today: date) -> dict:
    """{"age": days|None, "match": "yes"|"differs"|"not set", "reasons": [...]} (reasons empty = keep)."""
    d = idea_date(p)
    age = (today - d).days if d else None
    cur = num(p.get("current", p.get("current_value")))
    now = rules_value(rules, p)
    if now is None:
        match = "not set"
    elif cur is not None and abs(now - cur) <= 0.0001:
        match = "yes"
    else:
        match = "differs"
    reasons = []
    if age is not None and age > MAX_AGE_DAYS:
        reasons.append(f"older than {MAX_AGE_DAYS} days")
    if match != "yes":
        reasons.append("current value no longer matches" if match == "differs" else "current value is not in the rules")
    return {"age": age, "match": match, "reasons": reasons}


def bucket(age):
    if age is None:
        return "unknown"
    return "0-7 days" if age <= 7 else "8-14 days" if age <= 14 else "15-30 days" if age <= 30 else "over 30 days"


def run(db, apply: bool = False, now: datetime | None = None) -> dict:
    now = now or datetime.now(TBILISI).replace(tzinfo=None)
    today = now.date()
    snap = db.collection("pricing_config").document("rules").get()
    rules = snap.to_dict() if snap.exists else {}
    pending = []
    for d in db.collection("pricing_proposals").where("status", "==", "pending").stream():
        p = d.to_dict() or {}
        if p.get("type") == "run_marker":
            continue
        pending.append((d.id, p))
    rows = [(i, p, classify(p, rules, today)) for i, p in pending]

    print(f"Pending ideas: {len(rows)} (today {today}, Tbilisi)")
    print("\nHow old:   " + ", ".join(f"{k}: {v}" for k, v in sorted(Counter(bucket(c['age']) for _, _, c in rows).items())))
    by_room = defaultdict(list)
    for _, p, c in rows:
        by_room[p.get("property", "?")].append(c)
    print("\nPer room:")
    for rt in sorted(by_room):
        cs = by_room[rt]
        ages = [c["age"] for c in cs if c["age"] is not None]
        print(f"  {rt:8} {len(cs):>3} ideas | oldest {max(ages) if ages else '?'} days | "
              f"current value matches: {sum(c['match'] == 'yes' for c in cs)}, differs: {sum(c['match'] == 'differs' for c in cs)}, "
              f"not in rules: {sum(c['match'] == 'not set' for c in cs)}")
    seasons = Counter(f"{p.get('property')}/{p.get('season')}/{p.get('type')}" for _, p, _ in rows)
    dup = {k: v for k, v in seasons.items() if v > 1}
    print(f"\nSame room, season and field more than once: {len(dup)} combinations" + (f" (most: {max(dup.values())}x)" if dup else ""))
    stale = [(i, p, c) for i, p, c in rows if c["reasons"]]
    keep = [(i, p, c) for i, p, c in rows if not c["reasons"]]
    print(f"\nOlder than {MAX_AGE_DAYS} days: {sum(1 for _, _, c in rows if c['age'] is not None and c['age'] > MAX_AGE_DAYS)}"
          f" | current value differs or missing: {sum(1 for _, _, c in rows if c['match'] != 'yes')}"
          f" | to close (either): {len(stale)} | stay waiting: {len(keep)}")
    for i, p, c in keep:
        print(f"  stays: {p.get('property')} {p.get('season')} {p.get('type')} {p.get('current')} -> {p.get('suggested')} ({c['age']} days old)")
    if apply:
        for i, p, c in stale:
            db.collection("pricing_proposals").document(i).update({
                "status": "rejected", "rejection_reason": REASON, "rejected_at": now, "closed_by": "ideas_cleanup",
                "closed_because": "; ".join(c["reasons"]),
            })
        print(f"\nClosed {len(stale)} ideas as skipped (reason: {REASON}). pricing_config/rules was not touched.")
    else:
        print("\nSummary only: nothing was changed. Run with --apply to close the out-of-date ideas.")
    return {"pending": len(rows), "closed": len(stale) if apply else 0, "would_close": len(stale), "keep": len(keep)}


def main(argv=None, db=None, now=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args(argv)
    if db is None:
        import pricing_shadow as ps
        db = ps.init_db()
    return run(db, apply=args.apply, now=now)


if __name__ == "__main__":
    main()
