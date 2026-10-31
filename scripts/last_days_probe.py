"""Read-only probe: empty nights in the last days. Writes NOTHING (no MiniHotel price, no Firestore document, no channel push).

1. XCV_1 and XCV_2: the next 7 nights with prices, min/start/max, status and every "why" and "blocked" line.
2. The first empty night of XCV_1 today and tomorrow: what happened to it in the last days (stored price events and daily snapshots).
3. Every other room: empty nights in the next 3 days, and the rule that stopped each one from stepping to its minimum.
Prints room, date, prices and rules only (no guest data, no keys).
"""
import copy
import os
import sys
from collections import Counter
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import json  # noqa: E402
import pricing_shadow as ps  # noqa: E402
import pricing_calm_live as live  # noqa: E402
from calm_pricing import run  # noqa: E402
from calm_pricing import engine  # noqa: E402

ROOMS = ["XCV_1", "XCV_2"]
SYM = {"GEL": "₾", "USD": "$"}


def line(d, cfg):
    r = (cfg["rules"].get(d["rt"], {}).get(d["currency"], {}) or {}).get(d["season"]) or {}
    return (f"{SYM.get(d['currency'], d['currency'])} now {d['current']:g} | min {d.get('min')} / start {r.get('start')} / max {d.get('max')} "
            f"| target {d.get('target')} | status {d.get('status')} | result {d['kind']} -> {d['proposed']:g}{' (written)' if d.get('write') else ''}")


def rule_of(d, pickup):
    """The one rule that stopped (or did not stop) this empty night, in plain words."""
    w = " | ".join(d.get("why") or [])
    b = " | ".join(d.get("blocked") or [])
    if d.get("min") is not None and abs(d["current"] - d["min"]) < 0.5:
        return "already at the minimum"
    if d["kind"] in ("move", "tonight") and d.get("write"):
        return f"moving now ({d['kind']})"
    if "Fully booked" in w:
        return "fully booked"
    if "You set this price" in w or "hand-set" in w.lower():
        return "hand-set price"
    if "Protected date" in w:
        return "protected date rule"
    if "aim" in w and "no automatic drop" in w:
        return "own aim on the night"
    if "Only the morning run" in b:
        return "blocked: only the morning run may lower"
    if "Arrival day" in b:
        return "blocked: arrival day is never lowered"
    if "Limit: at most" in b:
        return "blocked: 24-hour limit"
    if "Holiday rule" in b or "Holiday date" in w or "Date rule" in w:
        return "holiday / date rule"
    if pickup:
        return "booking nearby in the last 3 days (pickup): no drops"
    if "How hard to push: Hold" in w or d.get("style") == "hold":
        return "room style Hold"
    if "Already close to the target" in w:
        return "already close to its target (target is above the minimum)"
    if "The rest of the building is selling as normal" in w:
        return "rest of the building selling as normal"
    if "Raised less than" in b:
        return "blocked: raised recently"
    if "Selling as normal and just moved" in b:
        return "blocked: just moved the other way"
    if d.get("status") not in ("behind", "far_behind"):
        return f"status is {d.get('status')}, not behind"
    return "other: " + (b or w)[-120:]


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
    release = live.read_release(db)
    snap = {"now": now, "inventory": inventory, "reservations": reservations, "shadow": False,
            "release_manual": sorted(release), "own_prices": own}
    calm = cfg.get("calm") or {}
    pick_rt, _ = engine._pickup_dates(reservations, today, int(calm.get("pickup_days", 3)), live_rts)
    print(f"Now {now.isoformat(timespec='minutes')} (Tbilisi). Pickup window {calm.get('pickup_days', 3)} days. Typed prices waiting: {len(own)}.")
    print("Styles per room:", {rt: v.get("style") for rt, v in live_rts.items() if isinstance(v, dict) and v.get("style")})

    st_main = copy.deepcopy(state)
    st_main.setdefault("_meta", {})["last_main_day"] = None      # replay the morning run as if today's had not happened yet
    runs = {"this run (as now)": run(snap, cfg, copy.deepcopy(state)),
            "morning run (09:00 rules, the only run that may lower)": run({**snap, "run_kind": "main"}, cfg, st_main)}

    print("\n=== 1. XCV_1 and XCV_2, next 7 nights ===")
    for rt in ROOMS:
        units = (live_rts.get(rt) or {}).get("units")
        print(f"\n{rt} (units {units}) channels {live.portals_for(live_rts[rt], rt) if rt in live_rts else '-'}")
        for k in range(0, 7):
            ds = (today + timedelta(days=k)).isoformat()
            cell = inventory.get(rt, {}).get(ds)
            if not cell:
                print(f"  {ds}: no data")
                continue
            booked = "EMPTY" if int(cell["avail"]) > 0 else "BOOKED"
            print(f"  {ds} (+{k}d) {booked}, free {cell['avail']}, pickup(booking nearby, last 3 days): {ds in pick_rt.get(rt, set())}, prices in MiniHotel {cell.get('prices')}")
            if booked == "BOOKED":
                continue
            for label, res in runs.items():
                for cur in ("GEL", "USD"):
                    d = next((x for x in res["decisions"] if x["rt"] == rt and x["date"] == ds and x["currency"] == cur), None)
                    if not d:
                        continue
                    print(f"     [{label}] {line(d, cfg)}")
                    if label.startswith("morning"):
                        for w in d["why"]:
                            print(f"         why: {w}")
                        for w in d["blocked"]:
                            print(f"         blocked: {w}")
            st = (state.get(rt) or {}).get(ds, {}) if isinstance(state.get(rt) if isinstance(state, dict) else None, dict) else {}
            if st:
                print(f"     memory: {json.dumps({c: {k2: v for k2, v in (m or {}).items() if k2 in ('last_change_dir','last_change_ts','l3_anchor','avail_at_change','manual_until')} for c, m in st.items()}, default=str)}")

    print("\n=== 2. What happened to the first empty XCV night in the last 4 days ===")
    for rt in ROOMS:
        night = next((ds for ds in sorted(inventory.get(rt, {})) if ds >= today.isoformat() and int(inventory[rt][ds]["avail"]) > 0), None)
        if not night:
            print(f"{rt}: no empty night")
            continue
        print(f"\n{rt} {night}")
        for k in range(5, -1, -1):
            day = (today - timedelta(days=k)).isoformat()
            s = db.collection("pmslog_snapshots").document(f"{day}_{rt}").get()
            n = ((s.to_dict() or {}).get("nights") or {}).get(night) if s.exists else None
            print(f"  snapshot {day}: {n}")
        evs = [e.to_dict() for e in db.collection("pmslog_price_events").where("rt", "==", rt).where("date", "==", night).stream()]
        for e in sorted(evs, key=lambda e: e.get("ts", ""))[-14:]:
            print(f"  event {e.get('ts', '')[:16]} {e.get('currency')} main={e.get('main_run')} days_out={e.get('days_out')} kind={e.get('kind')} "
                  f"{e.get('old')} -> {e.get('new')} written={e.get('written')} min={e.get('min')} target={e.get('target')} | reason: {e.get('reason')} | blocked: {e.get('blocked')}")
        near = [r for r in reservations if r["rt"] == rt and r["checkin"] <= (datetime.fromisoformat(night) + timedelta(days=2)).date().isoformat()
                and r["checkout"] >= (datetime.fromisoformat(night) - timedelta(days=2)).date().isoformat()]
        for r in sorted(near, key=lambda r: r["checkin"]):
            print(f"  stay near this night: check-in {r['checkin']} check-out {r['checkout']} booked on {r['created']}")

    print("\n=== 3. Every room: empty nights in the next 3 days ===")
    res = runs["morning run (09:00 rules, the only run that may lower)"]
    tally = Counter()
    rows = []
    for d in res["decisions"]:
        if not (0 <= d["days_out"] <= 3) or d["avail"] <= 0:
            continue
        pick = d["date"] in pick_rt.get(d["rt"], set())
        why = rule_of(d, pick)
        rows.append((d["rt"], d["date"], d["currency"], d, pick, why))
        if d["currency"] == "GEL" or d["rt"] not in [r[0] for r in rows[:-1]]:
            pass
    for rt, ds, cur, d, pick, why in sorted(rows):
        tally[why] += 1
        gap = None if d.get("min") is None else round(d["current"] - d["min"], 2)
        print(f"  {rt} {ds} +{d['days_out']}d {SYM.get(cur, cur)} free {d['avail']}/{d['units']} now {d['current']:g} min {d.get('min')} "
              f"(above min by {gap}) target {d.get('target')} status {d.get('status')} pickup {pick} -> {why}")
    print("\n=== 3b. What today's real morning run said about each empty night in the next 3 days (stored events) ===")
    today_s = today.isoformat()
    evs = [e.to_dict() for e in db.collection("pmslog_price_events").where("day", "==", today_s).stream()]
    evs = [e for e in evs if e.get("main_run") and e.get("days_out") is not None and 0 <= e["days_out"] <= 3 and (e.get("avail") or 0) > 0]
    for e in sorted(evs, key=lambda e: (e["rt"], e["date"], e["currency"])):
        print(f"  {e['rt']} {e['date']} +{e['days_out']}d {e['currency']} {e['old']} -> {e['new']} written={e['written']} kind={e['kind']} min={e.get('min')} "
              f"target={e.get('target')} | {e.get('reason')} | blocked: {e.get('blocked')}")
    print("\nTally of rules (each room-night counted once per currency):")
    for k, v in tally.most_common():
        print(f"  {v:3d}  {k}")
    print("\nPROBE FINISHED")


if __name__ == "__main__":
    main()
