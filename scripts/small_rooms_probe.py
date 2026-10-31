"""Read-only probe: the last-days and arrival-day rules for small rooms, before and after, on today's real data. Writes NOTHING (no MiniHotel price, no Firestore document, no channel push).
Shows the empty nights 0-3 days out of the rooms with 1-2 units, and counts every other difference between the old and the new engine.
"""
import copy
import json
import os
import subprocess
import sys
from collections import Counter
from datetime import datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import pricing_shadow as ps  # noqa: E402
import pricing_calm_live as live  # noqa: E402
from calm_pricing import run  # noqa: E402

BEFORE = os.environ.get("ENGINE_BEFORE", "606220d")        # the commit just before this change
SYM = {"GEL": "₾", "USD": "$"}


def load_before():
    src = subprocess.run(["git", "show", f"{BEFORE}:calm_pricing/engine.py"], capture_output=True, text=True, check=True, cwd=ROOT).stdout
    with open(os.path.join(ROOT, "calm_pricing", "_engine_before.py"), "w") as f:
        f.write(src)
    from calm_pricing import _engine_before
    return _engine_before.run


def main():
    print("READ-ONLY probe: nothing is written to MiniHotel, Firestore or any channel.\n")
    db = ps.init_db()
    repo_config = json.load(open(os.path.join(ROOT, "config.json")))
    rules, settings = ps.load_rules(db, repo_config)
    live_rts = live.live_room_types(rules, settings)
    cfg = ps.build_config(rules, settings, ps.load_events(db))
    cfg["room_types"] = live_rts
    now = datetime.now(ps.TBILISI).replace(tzinfo=None)
    today = now.date()
    from minihotel_auth import get_session_cookie
    days = max([cfg["window_days"]] + [int(v.get("window_days") or 0) for v in live_rts.values()])
    inventory = ps.fetch_inventory(get_session_cookie(), today, days, room_types=list(live_rts))
    reservations, _ = ps.load_reservations(db, today)
    state = ps.load_state(db, prefix=live.STATE_PREFIX)
    own = live.read_own_prices(db, today.isoformat())
    release = live.read_release(db)
    extra_release = [x for x in os.environ.get("EXTRA_RELEASE", "").split(",") if x]
    snap = {"now": now, "inventory": inventory, "reservations": reservations, "shadow": False,
            "release_manual": sorted(release) + extra_release, "own_prices": own}
    st_main = copy.deepcopy(state)
    st_main.setdefault("_meta", {})["last_main_day"] = None          # a morning-run replay on this data
    run_before = load_before()
    new = run(snap, cfg, copy.deepcopy(state))          # the next ordinary run, exactly as it would act now
    old = run_before(snap, cfg, copy.deepcopy(state))
    print(f"Now {now.isoformat(timespec='minutes')}. Extra nights given back for this replay (none by default): {extra_release or 'none'}. Old engine = commit {BEFORE}.\n")

    def key(d):
        return (d["rt"], d["date"], d["currency"])

    def res_of(d):
        return f"{d['proposed']:g}{' (written)' if d.get('write') else ''} [{d['kind']}]"

    A = {key(d): d for d in old["decisions"]}
    B = {key(d): d for d in new["decisions"]}
    small = [rt for rt, v in live_rts.items() if int(v.get("units") or 0) <= 2 and v.get("status", "live") != "off"]
    print("Rooms with 1-2 units:", ", ".join(small))
    print("\n=== Empty nights 0-3 days out of the small rooms: price now | OLD engine | NEW engine ===")
    for k in sorted(B):
        rt, ds, cur = k
        d = B[k]
        if rt not in small or not (0 <= d["days_out"] <= 3) or d["avail"] <= 0:
            continue
        o = A.get(k)
        print(f"  {rt} {ds} (+{d['days_out']}d) {SYM.get(cur, cur)} free {d['avail']}/{d['units']} now {d['current']:g} min {d.get('min')} | "
              f"old: {res_of(o) if o else '-'} | new: {res_of(d)}")
        if o and (res_of(o) != res_of(d)):
            print(f"        new why: {d['why'][-1] if d['why'] else ''} | blocked: {d.get('blocked')}")
    print("\n=== Every other difference between old and new ===")
    diff = [k for k in B if k in A and (res_of(A[k]) != res_of(B[k]))]
    by = Counter()
    outside = []
    for k in diff:
        rt, ds, cur = k
        d = B[k]
        in_small_window = rt in small and 1 <= d["days_out"] <= 3
        by[(rt, "small room, 1-3 days" if in_small_window else "other")] += 1
        if not in_small_window:
            outside.append(k)
    for (rt, why), n in sorted(by.items()):
        print(f"  {rt}: {n} decisions differ ({why})")
    for k in sorted(outside)[:12]:
        print(f"  OUTSIDE small-room window: {k} old {res_of(A[k])} new {res_of(B[k])} | {B[k]['why'][-1] if B[k]['why'] else ''}")
    print(f"\n  Decisions old {len(A)}, new {len(B)}; differ {len(diff)}; price writes old {len(old['writes'])}, new {len(new['writes'])}; "
          f"alerts old {len(old['alerts'])} new {len(new['alerts'])}; warnings old {len(old['warnings'])} new {len(new['warnings'])}")
    print("\nPROBE FINISHED")


if __name__ == "__main__":
    main()
