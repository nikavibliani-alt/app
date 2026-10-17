"""Read-only probe of the new engine on real data. Writes NOTHING (no MiniHotel price, no Firestore document, no channel push).

1. A dry run of the live runner, and the same real data run through the engine as it was before the Aim / own-price change:
   did anything change?
2. One real empty night of XCV_1 (the first one after next week): what an Aim of -5% would do.
3. The same night with an own price of 140 GEL / 38 USD: exactly what would be sent.
Prints counts and the numbers of that one night only (no guest data, no keys).
"""
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

BEFORE = "ed8c83b"             # the commit just before the night aim / own price change
ROOM = os.environ.get("NIGHT_ROOM", "XCV_1")


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


def of(res, ds, cur):
    for d in res["decisions"]:
        if d["rt"] == ROOM and d["date"] == ds and d["currency"] == cur:
            return d
    return None


def show(label, res, ds):
    print(f"  {label}")
    for cur in ("GEL", "USD"):
        d = of(res, ds, cur)
        if not d:
            continue
        sym = "GEL" if cur == "GEL" else "USD"
        print(f"    {sym}: price now {d['current']:g} | target {d.get('target')} | price after this run {d['proposed']:g} "
              f"({'written' if d.get('write') else 'not written'}, {d['kind']}){' | aim ' + format(d['aim'], '+g') + '%' if d.get('aim') else ''}")
        for w in (d.get("blocked") or [])[-2:]:
            print(f"        blocked: {w}")
        for w in d["why"][-3:]:
            print(f"        why: {w}")


def main():
    print("READ-ONLY probe: nothing is written to MiniHotel, Firestore or any channel.\n")
    print("=== 1. Dry run of the live runner (new code) ===")
    live.main(["--dry"])

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
    print(f"\nSaved aims: {len(cfg.get('night_aims') or [])}. Typed prices waiting: {len(own)}. Nights given back: {len(release)}.")
    snap = {"now": now, "inventory": inventory, "reservations": reservations, "shadow": False, "release_manual": sorted(release), "own_prices": own}

    print("\n=== 1b. Same real data: engine before the change vs new engine ===")
    run_before = load_before()
    for label, extra in (("this run (as it is now)", {}), ("as the morning run (09:00 rules)", {"run_kind": "main"})):
        new = run({**snap, **extra}, cfg, copy.deepcopy(state))
        old = run_before({k: v for k, v in {**snap, **extra}.items() if k != "own_prices"}, cfg, copy.deepcopy(state))
        a = {key(d): sig(d) for d in old["decisions"]}
        b = {key(d): sig(d) for d in new["decisions"]}
        diff = sorted(k for k in set(a) | set(b) if a.get(k) != b.get(k))
        wa = sorted((w["rt"], w["date"], w["currency"], w["price"]) for w in old["writes"])
        wb = sorted((w["rt"], w["date"], w["currency"], w["price"]) for w in new["writes"])
        print(f"  {label}: decisions {len(b)} (before {len(a)}), price changes {len(wb)} (before {len(wa)}), "
              f"decisions that differ {len(diff)}, writes identical {wa == wb}, alerts {len(new['alerts'])} (before {len(old['alerts'])}), warnings {len(new['warnings'])} (before {len(old['warnings'])})")
        for k in diff[:8]:
            print("    DIFF", k, a.get(k), "->", b.get(k))
        for al in new["alerts"][:5]:
            print("    ALERT:", al)

    print("\n=== 2. One real night: the first empty night of", ROOM, "after next week ===")
    cell = None
    for ds in sorted(inventory.get(ROOM, {})):
        if ds >= (today + timedelta(days=8)).isoformat() and int(inventory[ROOM][ds]["avail"]) > 0:
            cell, night = inventory[ROOM][ds], ds
            break
    if cell is None:
        print("  No empty night found in the window.")
        return
    print(f"  Night: {ROOM} {night} ({(datetime.fromisoformat(night).date() - today).days} days away), free units {cell['avail']}, "
          f"prices in MiniHotel now {cell.get('prices')}")
    print(f"  Channels of {ROOM}: {live.portals_for(live_rts[ROOM], ROOM)}")
    for label, extra in (("as the run right now", {}), ("as the morning run (the only run that may lower)", {"run_kind": "main"})):
        print(f"\n  --- {label} ---")
        base = run({**snap, **extra}, cfg, copy.deepcopy(state))
        show("without an aim", base, night)
        cfg_a = copy.deepcopy(cfg)
        cfg_a["night_aims"] = [{"rt": ROOM, "date": night, "pct": -5, "avail": int(cell["avail"])}]
        aimed = run({**snap, **extra}, cfg_a, copy.deepcopy(state))
        show("with Aim -5%", aimed, night)

    print("\n=== 3. The same night with an own price of 140 GEL / 38 USD ===")
    snap_own = {**snap, "own_prices": {**own, f"{ROOM}|{night}": {"GEL": 140.0, "USD": 38.0}}}
    res = run(snap_own, cfg, copy.deepcopy(state))
    show("this run", res, night)
    mine = [w for w in res["writes"] if w["rt"] == ROOM and w["date"] == night]
    print(f"  Finished typed prices reported by the engine: {[k for k in res.get('own_done', []) if k == f'{ROOM}|{night}']}")
    payload = live.build_payload(mine)
    portals = live.portals_to_push(mine, live_rts)
    print("  What would be sent to MiniHotel (SendPrices) for this night:")
    print(json.dumps(payload, indent=2))
    print(f"  Channels pushed after the write: {portals}")
    print("  Booking and Expedia take the GEL price list; Airbnb takes the Airbnb list (named EUR here, plus *ALL), as today.")
    print(f"  Expedia is {'pushed' if 'EXPEDIA' in portals else 'NOT pushed: it is not a channel of ' + ROOM}.")
    inv2 = copy.deepcopy(inventory)
    for w in mine:
        inv2[ROOM][night]["prices"][w["currency"]] = w["price"]
    snap2 = {**snap, "inventory": inv2, "own_prices": own}
    res2 = run(snap2, cfg, res["state"])
    d2 = of(res2, night, "GEL")
    print(f"  Next run (typed price already sent, entry gone): kind {d2['kind']}, written {bool(d2.get('write'))}, price {d2['proposed']:g}")


if __name__ == "__main__":
    main()
