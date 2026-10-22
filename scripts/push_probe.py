"""Read-only probe of the "How hard to push" profiles on real data. Writes NOTHING.
1. Real data, no setting changed: the engine before the slider and the new engine must give the same decisions.
2. XCV_1 set to Calm for the next 7 nights: before and after, per night (this run, and tomorrow's morning run).
Prints the numbers of those nights only."""
import copy
import json
import os
import subprocess
import sys
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pricing_shadow as ps  # noqa: E402
import pricing_calm_live as live  # noqa: E402
from calm_pricing import run  # noqa: E402

BEFORE = "c0ae08d"             # the commit just before the slider
ROOM = os.environ.get("PUSH_ROOM", "XCV_1")
STYLE = os.environ.get("PUSH_STYLE", "calm")


def load_before():
    src = subprocess.run(["git", "show", f"{BEFORE}:calm_pricing/engine.py"], capture_output=True, text=True, check=True).stdout
    path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "calm_pricing", "_engine_before.py")
    with open(path, "w") as f:
        f.write(src)
    from calm_pricing import _engine_before
    return _engine_before.run


def key(d):
    return (d["rt"], d["date"], d["currency"])


def sig(d):
    return (d["kind"], round(float(d["proposed"]), 2), bool(d.get("write")), round(float(d.get("target") or 0), 2))


def line(res, ds):
    out = []
    for cur in ("GEL", "USD"):
        d = next((x for x in res["decisions"] if x["rt"] == ROOM and x["date"] == ds and x["currency"] == cur), None)
        if d:
            out.append(f"{cur} {d['current']:g} -> {d['proposed']:g} (target {d.get('target')}, {d['kind']}{', written' if d.get('write') else ''})")
    return " | ".join(out) or "no price"


def main():
    print("READ-ONLY probe: nothing is written to MiniHotel, Firestore or any channel.\n")
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
    snap = {"now": now, "inventory": inventory, "reservations": reservations, "shadow": False, "release_manual": sorted(live.read_release(db)), "own_prices": own}
    styles = {rt: v.get("style") for rt, v in live_rts.items()}
    print(f"Room styles now: {styles}; night aims {len(cfg.get('night_aims') or [])}; night push settings {len(cfg.get('night_push') or [])}\n")

    print("=== 1. Real data, no setting changed: engine before the slider vs the new engine ===")
    run_before = load_before()
    tomorrow = datetime.combine(today + timedelta(days=1), datetime.min.time()) + timedelta(hours=9, minutes=5)
    for label, extra in (("this run", {}), ("tomorrow's morning run", {"now": tomorrow})):
        new = run({**snap, **extra}, cfg, copy.deepcopy(state))
        old = run_before({**snap, **extra}, cfg, copy.deepcopy(state))
        a, b = {key(d): sig(d) for d in old["decisions"]}, {key(d): sig(d) for d in new["decisions"]}
        diff = sorted(k for k in set(a) | set(b) if a.get(k) != b.get(k))
        wa = sorted((w["rt"], w["date"], w["currency"], w["price"]) for w in old["writes"])
        wb = sorted((w["rt"], w["date"], w["currency"], w["price"]) for w in new["writes"])
        print(f"  {label}: decisions {len(b)} (before {len(a)}), price changes {len(wb)} (before {len(wa)}), decisions that differ {len(diff)}, "
              f"writes identical {wa == wb}, alerts {len(new['alerts'])} (before {len(old['alerts'])})")
        for k in diff[:6]:
            print("    DIFF", k, a.get(k), "->", b.get(k))

    nights = [d for d in sorted(inventory.get(ROOM, {})) if today < datetime.fromisoformat(d).date() <= today + timedelta(days=7)]
    print(f"\n=== 2. {ROOM} on '{STYLE}' for the next 7 nights ({nights[0] if nights else '-'} .. {nights[-1] if nights else '-'}) ===")
    cfg2 = copy.deepcopy(cfg)
    cfg2["night_push"] = [{"rt": ROOM, "date": d, "style": STYLE, "avail": int(inventory[ROOM][d]["avail"])} for d in nights if int(inventory[ROOM][d]["avail"]) > 0]
    print(f"  Setting added for {len(cfg2['night_push'])} empty nights (booked nights are left out).")
    for label, extra in (("this run", {}), ("tomorrow's morning run (the next run that may lower)", {"now": tomorrow})):
        base = run({**snap, **extra}, cfg, copy.deepcopy(state))
        calm = run({**snap, **extra}, cfg2, copy.deepcopy(state))
        print(f"\n  --- {label} ---")
        for d in nights:
            free = int(inventory[ROOM][d]["avail"])
            if free == 0:
                print(f"  {d}: booked")
                continue
            print(f"  {d} ({free} free)\n      Normal : {line(base, d)}\n      {STYLE.capitalize():7}: {line(calm, d)}")
        others = [k for k in {key(x) for x in calm['decisions']} if k[0] != ROOM]
        b_o = {key(x): sig(x) for x in base["decisions"] if x["rt"] != ROOM}
        c_o = {key(x): sig(x) for x in calm["decisions"] if x["rt"] != ROOM}
        print(f"  Other rooms and other nights changed by this setting: {sum(1 for k in b_o if b_o[k] != c_o.get(k))}")


if __name__ == "__main__":
    main()
