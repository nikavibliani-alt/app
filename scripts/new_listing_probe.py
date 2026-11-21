"""Read-only dry run of "New listing: aim for minimum" on real data for XCV_1 and XCV_2, the next 14 days. Writes NOTHING (no MiniHotel price,
no Firestore document, no channel push). Shows, per night and price list, today's price, what the next morning run does WITHOUT the rule and WITH it."""
import copy
import json
import os
import sys
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pricing_shadow as ps  # noqa: E402
import pricing_calm_live as live  # noqa: E402
from calm_pricing import run  # noqa: E402

ROOMS = ["XCV_1", "XCV_2"]
SYM = {"GEL": "₾", "USD": "$"}


def main():
    print("READ-ONLY dry run: nothing is written to MiniHotel, Firestore or any channel. No rule is switched on.\n")
    db = ps.init_db()
    repo_config = json.load(open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "config.json")))
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
    snap = {"now": now, "inventory": inventory, "reservations": reservations, "shadow": False, "release_manual": sorted(release), "own_prices": own, "run_kind": "main"}
    st = copy.deepcopy(state)
    st.setdefault("_meta", {})["last_main_day"] = None                         # replay the next morning run
    first, last = today.isoformat(), (today + timedelta(days=13)).isoformat()
    cfg_on = copy.deepcopy(cfg)
    cfg_on["date_rules"] = list(cfg_on.get("date_rules") or []) + [{"from": first, "to": last, "rooms": ROOMS, "action": "aim_min", "note": "New listing (dry run)"}]
    before = run(snap, cfg, copy.deepcopy(st))
    after = run(snap, cfg_on, copy.deepcopy(st))
    A = {(d["rt"], d["date"], d["currency"]): d for d in before["decisions"]}
    B = {(d["rt"], d["date"], d["currency"]): d for d in after["decisions"]}
    print(f"Today {today}. Rule tried: {ROOMS} from {first} to {last}. The 'next morning run' is the run that may lower prices.\n")
    mine = []
    for rt in ROOMS:
        print(f"{rt}  (minimum per price list is shown after 'min')")
        for k in range(0, 14):
            ds = (today + timedelta(days=k)).isoformat()
            parts, tags = [], []
            for cur in ("GEL", "USD"):
                a, b = A.get((rt, ds, cur)), B.get((rt, ds, cur))
                if not a:
                    continue
                if a["avail"] == 0:
                    tags.append("booked")
                    break
                if b["kind"] in ("manual", "own"):
                    mine.append((rt, ds))
                    tags.append("set by you")
                parts.append(f"{SYM[cur]} now {a['current']:g} | without rule {a['proposed']:g}{' (w)' if a.get('write') else ''} | WITH rule {b['proposed']:g}{' (w)' if b.get('write') else ''} [{b['kind']}] min {b.get('min')}")
            print(f"  {ds} (+{k}d) {', '.join(sorted(set(tags))) or 'empty'}" + ("".join(f"\n      {p}" for p in parts)))
    print("\nNights set by hand in the range (the rule leaves them alone; you can give them back):", sorted(set(mine)) or "none")
    diff_out = [k for k in B if k in A and not (k[0] in ROOMS and first <= k[1] <= last) and (A[k]["proposed"], A[k]["kind"], A[k]["write"]) != (B[k]["proposed"], B[k]["kind"], B[k]["write"])]
    print(f"\nEverything outside the rule's room and dates: {len(diff_out)} decisions differ (must be 0). Price writes without the rule {len(before['writes'])}, with it {len(after['writes'])}; "
          f"alerts {len(after['alerts'])}; warnings without/with {len(before['warnings'])}/{len(after['warnings'])}.")
    print("PROBE FINISHED")


if __name__ == "__main__":
    main()
