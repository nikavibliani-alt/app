"""READ-ONLY, third pass: classify each written raise of the last 21 days with the engine's OWN record of that day (status and reasons of the last run
of the day, pricing_calm_daily), not with today's settings (rules changed in the period). Also the ratchet (raises in every run, drops only in the morning run),
how many raises were reversed, and what each possible fix would remove. Writes NOTHING."""
import collections
import json
import os
import sys
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import pricing_shadow as ps  # noqa: E402
import pricing_calm_live as live  # noqa: E402
import raise_audit as ra  # noqa: E402


def main():
    print("READ-ONLY third pass: nothing is written.\n")
    db = ps.init_db()
    repo_config = json.load(open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "config.json")))
    rules, settings = ps.load_rules(db, repo_config)
    live_rts = live.live_room_types(rules, settings)
    today = datetime.now(ps.TBILISI).replace(tzinfo=None).date()
    since = today - timedelta(days=21)
    evs, recs = [], {}
    for k in range(0, 22):
        day = (since + timedelta(days=k)).isoformat()
        evs += [x.to_dict() for x in db.collection("pmslog_price_events").where("day", "==", day).where("written", "==", True).stream()]
        for rt in live_rts:
            dd = ((db.collection("pricing_calm_daily").document(f"{day}_{rt}").get().to_dict() or {}).get("dates") or {})
            for key, r in dd.items():
                recs[(day, rt, key)] = r
    raises = [e for e in evs if e.get("old") is not None and e["new"] > e["old"] + 1e-9 and e.get("kind") in ra.RAISE_KINDS]
    mostly = [e for e in raises if ra.free_share(e) >= 0.5]
    print(f"Written changes {len(evs)}; raises {len(raises)}; raises on nights with >= half the units free {len(mostly)} ({len(mostly) / max(1, len(raises)):.0%})\n")

    def rule_of(e):
        r = recs.get((e["day"], e["rt"], f"{e['date']}|{e['currency']}"))
        if e["kind"] != "move":
            return {"fill": "first price (fill)", "correction": "min/max correction", "reset": "reset", "own": "typed price", "newlisting": "New listing"}.get(e["kind"], e["kind"]), None
        if not r:
            return "no record of that day", None
        why = " | ".join(r.get("why") or [])
        st = r.get("status")
        if "rest of the building is selling as normal" in why:
            return "BUILDING RULE: the rest of the building sells as normal, so this room's status is forced to 'on track' and it is pulled up to the normal price", st
        if st in ("ahead", "far_ahead"):
            return f"STATUS BONUS: booked more than the normal curve ({st})", st
        wd = ra.d_(e["date"]).weekday()
        if st == "on_track":
            return ("toward the normal price, Fri/Sat night (start +8%), status on track" if wd in (4, 5) else "toward the normal price (start), status on track"), st
        return f"up to a LOWERED target (status {st})", st
    cl = [(e, *rule_of(e)) for e in mostly]
    print("A. RAISES ON NIGHTS WITH >= HALF THE UNITS FREE, by the engine's own reason that day:")
    cnt = collections.Counter(r for _, r, _ in cl)
    for r, n in cnt.most_common():
        print(f"  {n:5d}  {r}")
    for e, r, st in sorted(cl, key=lambda x: (x[0]["rt"], x[0]["date"], str(x[0]["ts"]))):
        print(f"ROW|{e['rt']}|{e['date']}|{e['currency']}|{e['avail']}|{e['units']}|{e['old']:g}|{e['new']:g}|{str(e['ts'])[:16]}|{'morning' if e.get('main_run') else 'other'}|{e.get('days_out')}|{st}|{r.split(':')[0]}")
    print("\n   by room:")
    byroom = collections.defaultdict(collections.Counter)
    for e, r, _ in cl:
        byroom[e["rt"]][r.split(":")[0]] += 1
    for rt, c in sorted(byroom.items(), key=lambda kv: -sum(kv[1].values())):
        print(f"   {rt} ({live_rts[rt]['units']} units): {sum(c.values())} | " + "; ".join(f"{n} {k}" for k, n in c.most_common(4)))
    print("\n   in the morning run or in another run:", dict(collections.Counter("morning run (09:00)" if e.get("main_run") else "other run" for e, _, _ in cl)))
    print("   by hour of the run:", dict(sorted(collections.Counter(str(e["ts"])[11:13] for e, _, _ in cl).items())))
    print("   by days to arrival:", dict(sorted(collections.Counter(("0-14" if (e.get("days_out") or 0) <= 14 else "15-30" if e["days_out"] <= 30 else "31-60" if e["days_out"] <= 60 else "61-90" if e["days_out"] <= 90 else "91+") for e, _, _ in cl).items())))
    print("   by booked units of units:", dict(collections.Counter(f"{e['units'] - e['avail']} of {e['units']}" for e, _, _ in cl).most_common(9)))

    # B ratchet and reversal
    print("\nB. THE RATCHET: raises may happen in every run, drops only in the morning run")
    allw = collections.defaultdict(list)
    for e in evs:
        allw[(e["rt"], e["date"], e["currency"])].append(e)
    up_runs = collections.Counter(e["day"] for e in raises)
    per_day_night = collections.Counter((e["rt"], e["date"], e["currency"], e["day"]) for e in mostly)
    multi = sum(1 for v in per_day_night.values() if v >= 2)
    print(f"  raises per run kind (all raises): morning {sum(1 for e in raises if e.get('main_run'))}, other runs {sum(1 for e in raises if not e.get('main_run'))}")
    drops = [e for e in evs if e.get('old') is not None and e['new'] < e['old'] - 1e-9 and e.get('kind') == 'move']
    print(f"  drops (kind move): morning {sum(1 for e in drops if e.get('main_run'))}, other runs {sum(1 for e in drops if not e.get('main_run'))}")
    print(f"  the same night raised 2 or more times on the SAME day (mostly-free nights): {multi} nights-days of {len(per_day_night)}")
    rev = tot = 0
    for e in mostly:
        tot += 1
        later = [x for x in allw[(e["rt"], e["date"], e["currency"])] if str(x["ts"]) > str(e["ts"]) and x["new"] < x["old"] and (ra.d_(x["day"]) - ra.d_(e["day"])).days <= 3]
        if later:
            rev += 1
    print(f"  raises on mostly-free nights that were followed by a drop of the same night within 3 days: {rev} of {tot} ({rev / max(1, tot):.0%})")
    # net: nights raised and then lowered back; money view
    net_up = sum(e["new"] - e["old"] for e in mostly if e["currency"] == "GEL")
    print(f"  total of all lari raises on those nights: +{net_up:g} lari (sum of steps); average step {sum((e['new'] - e['old']) / e['old'] for e in mostly) / max(1, tot):+.1%}")

    # C options
    n = len(raises)
    print("\nC. WHAT EACH FIX WOULD REMOVE (out of all %d raises in 21 days; %d are on nights with >= half free)" % (n, len(mostly)))
    nm = len(mostly)
    def c(f):
        return sum(1 for e, r, s in cl if f(e, r, s))
    print(f"  1. no raise at all while at least half the units are free: removes {nm} ({nm / n:.0%} of all raises)")
    print(f"  2. no raise from the building rule or the status bonus while at least half are free: removes {c(lambda e, r, s: r.startswith('BUILDING') or r.startswith('STATUS'))}")
    print(f"     of which building rule {c(lambda e, r, s: r.startswith('BUILDING'))}, status bonus {c(lambda e, r, s: r.startswith('STATUS'))}; left: {c(lambda e, r, s: not (r.startswith('BUILDING') or r.startswith('STATUS')))} (toward normal price / weekend / lowered target)")
    print(f"  3. raises only in the morning run (one raise a day at most, like drops): removes {c(lambda e, r, s: not e.get('main_run'))} of the {nm}")
    print(f"  4. status 'ahead' needs at least 2 booked units AND at least half booked inside 30 days: removes {c(lambda e, r, s: r.startswith('STATUS') and ((e['units'] - e['avail']) < 2 or (e.get('days_out') or 0) > 30))}")
    print(f"  5. no raise more than 45 days before arrival while at least half free: removes {c(lambda e, r, s: (e.get('days_out') or 0) > 45)}")
    print("PROBE FINISHED")


if __name__ == "__main__":
    main()
