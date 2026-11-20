"""Read-only: which written price moves were bigger than the daily limits (what turns the watchdog red), per day since 1 Nov. Counts and prices only."""
import collections
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import pricing_shadow as ps  # noqa: E402


def main():
    db = ps.init_db()
    evs = [e.to_dict() for e in db.collection("pmslog_price_events").where("day", ">=", "2026-10-31").stream()]
    ok = ("correction", "reset", "far_reset", "tonight", "own", "arrival")
    by = collections.defaultdict(list)
    for e in evs:
        if not e.get("written") or e.get("old") in (None, 0) or e.get("new") is None or e.get("kind") in ok:
            continue
        pct = (e["new"] - e["old"]) / e["old"]
        lim = 0.15 if (e.get("days_out") is not None and e["days_out"] <= 3) else 0.05
        if abs(pct) > lim + 0.01:
            by[e["day"]].append((e["rt"], e["date"], e.get("days_out"), e["currency"], e["old"], e["new"], round(pct * 100), e.get("kind"), str(e.get("ts"))[11:16]))
    print("Moves written bigger than the daily limit (15% in the last 3 days, 5% otherwise), kinds not on the allowed list:")
    for day in sorted(by):
        rows = by[day]
        print(f"  {day}: {len(rows)} moves; by days out {dict(collections.Counter(r[2] for r in rows))}; by room {dict(collections.Counter(r[0] for r in rows))}")
        for r in rows[:4]:
            print("      ", r)
    print("Days with none:", [d for d in ["2026-11-%02d" % i for i in range(1, 21)] if d not in by])
    print("PROBE FINISHED")


if __name__ == "__main__":
    main()
