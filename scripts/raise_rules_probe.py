"""READ-ONLY dry run of the new raise rules on real data. Writes NOTHING (no MiniHotel price, no Firestore document, no channel push).
A. MAXELA: which unit is never available and what MiniHotel shows for it.
B. Three days of runs (04, 09, 13, 16, 22) of the OLD and the NEW engine on today's real inventory and memory, nothing selling: raises and drops per room.
C. Five example nights. D. MAXELA status with 7 and with 6 units.  E. The holiday date ranges: nights in the next 30 days held, per room.
"""
import collections
import copy
import json
import os
import subprocess
import sys
from datetime import datetime, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import pricing_shadow as ps  # noqa: E402
import pricing_calm_live as live  # noqa: E402
from calm_pricing import run  # noqa: E402

BEFORE = os.environ.get("ENGINE_BEFORE", "b44862d")
SYM = {"GEL": "₾", "USD": "$"}
HOURS = [4, 9, 13, 16, 22]


def load_before():
    src = subprocess.run(["git", "show", f"{BEFORE}:calm_pricing/engine.py"], capture_output=True, text=True, check=True, cwd=ROOT).stdout
    with open(os.path.join(ROOT, "calm_pricing", "_engine_before.py"), "w") as f:
        f.write(src)
    from calm_pricing import _engine_before
    return _engine_before.run


def key(d):
    return (d["rt"], d["date"], d["currency"])


def main():
    print("READ-ONLY dry run: nothing is written to MiniHotel, Firestore or any channel.\n")
    db = ps.init_db()
    repo_config = json.load(open(os.path.join(ROOT, "config.json")))
    rules, settings = ps.load_rules(db, repo_config)
    live_rts = live.live_room_types(rules, settings)
    events = ps.load_events(db)
    cfg_new = ps.build_config(rules, settings, events)
    cfg_new["room_types"] = live_rts
    cfg_old = copy.deepcopy(cfg_new)
    cfg_old["room_types"] = copy.deepcopy(live_rts)
    cfg_old["room_types"]["MAXELA"]["units"] = 7              # what the engine counted before
    now = datetime.now(ps.TBILISI).replace(tzinfo=None)
    today = now.date()
    from minihotel_auth import get_session_cookie
    cookie = get_session_cookie()
    days = max([cfg_new["window_days"]] + [int(v.get("window_days") or 0) for v in live_rts.values()])
    inventory = ps.fetch_inventory(cookie, today, days, room_types=list(live_rts))
    reservations, _ = ps.load_reservations(db, today)
    state = ps.load_state(db, prefix=live.STATE_PREFIX)
    print(f"Now {now:%Y-%m-%d %H:%M}. New engine counts MAXELA as {live_rts['MAXELA']['units']} units, the old one counted 7. Old engine = commit {BEFORE}.\n")

    # ---------------------------------------------------------------- A. phantom
    try:
        print("=" * 100 + "\nA. MAXELA: the unit that is never available\n" + "=" * 100)
        import minihotel_reservation_sync as m
        m.ROOM_MAP = m.build_room_map(db)
        session = m.login_minihotel()
        import requests
        url = f"https://emea5.hotelpms.cloud/api/Reservations?FromDate={today.isoformat()}T20:00:00.000Z&ToDate={(today + timedelta(days=60)).isoformat()}T20:00:00.000Z"
        r = session.get(url, headers={"Accept": "application/json"})
        data = r.json() if r.status_code == 200 else {}
        rooms = data.get("rooms") or []
        print(f"MiniHotel's own list of rooms (reservations API): {len(rooms)} rooms; fields of one entry: {sorted(rooms[0].keys()) if rooms else '-'}")
        for rm in rooms:
            name = str(rm.get("roomNumber") or rm.get("name") or rm.get("code") or "")
            if name.startswith("M-") or str(rm.get("roomType") or rm.get("type") or "").upper() == "MAXELA":
                print("   ", {k: v for k, v in rm.items()})
        print("Our room records (checkin_rooms) for the Maxela rooms:")
        for code in ("6-1", "6-2", "6-4", "7-1", "7-2", "7-3", "7-4"):
            d = db.collection("checkin_rooms").document(code).get()
            x = d.to_dict() or {}
            print(f"   {code}: {({k: x.get(k) for k in ('displayName', 'active', 'showInHk', 'site', 'minihotelNames', 'sortOrder')} if d.exists else 'NO RECORD')}")
        allr = [x.to_dict() or {} for x in db.collection("reservations").where("roomCode", "==", "7-3").stream()]
        print(f"Reservations ever stored for room 7-3: {len(allr)}; by status {dict(collections.Counter(str(x.get('status')) for x in allr))}; first/last check-in {min([str(x.get('checkin')) for x in allr] or ['-'])} / {max([str(x.get('checkin')) for x in allr] or ['-'])}")
        per = {c: sum(1 for x in db.collection("reservations").where("roomCode", "==", c).stream()) for c in ("6-1", "6-2", "6-4", "7-1", "7-2", "7-4")}
        print("For comparison, reservations stored per other Maxela room:", per)
        mx = inventory.get("MAXELA", {})
        freev = [int(c["avail"]) for ds, c in mx.items() if c.get("avail") is not None]
        print(f"MiniHotel free units of the MAXELA room type over {len(freev)} nights ahead: most ever free {max(freev)}, nights with 7 free {sum(1 for v in freev if v == 7)}, nights with 6 free {sum(1 for v in freev if v == 6)}")
        names_in_api = sorted({str(x.get('roomNumber')) for x in data.get('reservations', []) if str(x.get('roomNumber', '')).startswith('M-')})
        print("Maxela room names in the next 60 days of reservations:", names_in_api)
    except Exception as e:  # the other parts must still run
        print(f"   (part A stopped: {type(e).__name__}: {str(e)[:200]})")

    # ---------------------------------------------------------------- B. simulation
    print("\n" + "=" * 100 + "\nB. THREE DAYS OF RUNS (04, 09, 13, 16, 22 each day), OLD vs NEW engine, nothing selling, nights up to 60 days ahead\n" + "=" * 100)
    run_old = load_before()

    def simulate(run_fn, cfg_):
        inv = copy.deepcopy(inventory)
        st = copy.deepcopy(state)
        log, decs = [], []
        for d in range(1, 4):
            for h in HOURS:
                at = datetime.combine(today + timedelta(days=d), datetime.min.time()) + timedelta(hours=h, minutes=1)
                res = run_fn({"now": at, "inventory": inv, "reservations": reservations, "shadow": False, "release_manual": [], "own_prices": {}}, cfg_, st)
                st = res["state"]
                decs.append({key(x): x for x in res["decisions"]})
                for w in res["writes"]:
                    c = inv.get(w["rt"], {}).get(w["date"])
                    if c is not None:
                        c.setdefault("prices", {})[w["currency"]] = w["price"]
                for x in res["decisions"]:
                    if x.get("write"):
                        log.append((d, h, x))
        return inv, log, decs

    inv_o, log_o, dec_o = simulate(run_old, cfg_old)
    inv_n, log_n, dec_n = simulate(run, cfg_new)

    def stats(log):
        out = collections.defaultdict(lambda: collections.Counter())
        for d, h, x in log:
            if x["days_out"] > 60:
                continue
            kind = "raise" if x["proposed"] > x["current"] + 1e-9 else "drop"
            out[x["rt"]][kind] += 1
            if kind == "raise" and x["avail"] / x["units"] >= 0.5:
                out[x["rt"]]["raise on mostly-free night"] += 1
            if kind == "raise" and not (d == 1 and h == 9) and h != 9:
                out[x["rt"]]["raise outside the morning run"] += 1
        return out
    so, sn = stats(log_o), stats(log_n)
    print("room (units) | raises old -> new | of which on nights >= half free old -> new | raises outside the morning run old -> new | drops old -> new")
    tot = collections.Counter()
    for rt in sorted(live_rts):
        a, b = so[rt], sn[rt]
        print(f"  {rt} ({live_rts[rt]['units']}) | {a['raise']} -> {b['raise']} | {a['raise on mostly-free night']} -> {b['raise on mostly-free night']} | {a['raise outside the morning run']} -> {b['raise outside the morning run']} | {a['drop']} -> {b['drop']}")
        for k in ("raise", "raise on mostly-free night", "raise outside the morning run", "drop"):
            tot[(k, "old")] += a[k]
            tot[(k, "new")] += b[k]
    print("  TOTAL | " + " | ".join(f"{tot[(k, 'old')]} -> {tot[(k, 'new')]}" for k in ("raise", "raise on mostly-free night", "raise outside the morning run", "drop")))
    # price drift of empty nights up to 60 days (not holiday), start of sim to end of sim
    print("\nAverage price change of the empty nights within 60 days over the 3 days (non-holiday nights; lari price lists):")
    first_o, first_n = dec_o[0], dec_n[0]
    for rt in sorted(live_rts):
        cur = "GEL" if "GEL" in live_rts[rt].get("currencies", []) else "USD"
        ch = {"old": [], "new": []}
        for k, d0 in first_n.items():
            if k[0] != rt or k[2] != cur or d0["days_out"] > 57 or d0["avail"] == 0 or d0.get("holiday"):
                continue
            base = d0["current"]
            for tag, inv in (("old", inv_o), ("new", inv_n)):
                end = (inv.get(rt, {}).get(k[1], {}).get("prices") or {}).get(cur)
                if base and end:
                    ch[tag].append(end / base - 1)
        f = lambda xs: f"{sum(xs) / len(xs):+.1%}" if xs else "-"   # noqa: E731
        print(f"  {rt}: old {f(ch['old'])} | new {f(ch['new'])} ({len(ch['new'])} nights)")

    # ---------------------------------------------------------------- C. examples
    print("\n" + "=" * 100 + "\nC. FIVE EXAMPLE NIGHTS\n" + "=" * 100)
    def final(inv, k):
        return (inv[k[0]][k[1]].get("prices") or {}).get(k[2])
    allk = [k for k in dec_n[1] if dec_n[1][k]["avail"] > 0 and dec_n[1][k]["days_out"] <= 60 and not dec_n[1][k].get("holiday")]
    def best(rts, pred=lambda k: True):
        out = None
        for k in allk:
            if k[0] in rts and pred(k) and final(inv_o, k) and final(inv_n, k) and k in dec_o[1]:
                gap = abs(final(inv_o, k) - final(inv_n, k)) / final(inv_o, k)
                raised_old = any(key(x) == k and x["proposed"] > x["current"] + 1e-9 for _, _, x in log_o)
                score = (raised_old, gap)
                if out is None or score > out[0]:
                    out = (score, k)
        return out[1] if out else None
    picks = []
    for rts in (("ORBE_2", "XCV_1", "XCV_2", "BIG_APT"), ("ORBE_1", "VGL_AP", "VGL_ST", "FREEDOM"), ("MAXELA",), ("MAXELA",), ("ROOMS", "BIG_APT", "XCV_2", "FREEDOM")):
        k = best(rts, lambda k: k not in picks)
        if k:
            picks.append(k)
    for k in picks[:5]:
        rt, ds, cur = k
        u = live_rts[rt]["units"]
        d1 = dec_n[1].get(k) or dec_n[0].get(k)
        print(f"\n{rt} {ds} ({SYM[cur]} list, {u} units, {d1['avail']} free, {d1['days_out']} days out at the start)")
        po = [(d, h, x) for d, h, x in log_o if key(x) == k]
        pn = [(d, h, x) for d, h, x in log_n if key(x) == k]
        print("   OLD engine changes:", "; ".join(f"day{d} {h:02d}:01 {x['current']:g}->{x['proposed']:g}" for d, h, x in po[:10]) or "none")
        print("   NEW engine changes:", "; ".join(f"day{d} {h:02d}:01 {x['current']:g}->{x['proposed']:g}" for d, h, x in pn[:10]) or "none")
        o0, n0 = dec_o[1].get(k), dec_n[1].get(k)
        if o0:
            print(f"   old, 09:01 run: status {o0['status']} target {o0.get('target')} | " + " / ".join(o0['why'][-3:])[:260])
        if n0:
            print(f"   new, 09:01 run: status {n0['status']} target {n0.get('target')} | blocked: {n0.get('blocked')} | " + " / ".join(n0['why'][-3:])[:260])
        print(f"   price after 3 days: old {final(inv_o, k)} | new {final(inv_n, k)}")

    print("\n" + "=" * 100 + "\nF. EVERY RAISE THE NEW ENGINE STILL MAKES (nights up to 60 days out)\n" + "=" * 100)
    for d, h, x in log_n:
        if x["days_out"] <= 60 and x["proposed"] > x["current"] + 1e-9:
            print(f"  {x['rt']} {x['date']} {x['currency']} day{d} {h:02d}:01 {x['current']:g}->{x['proposed']:g} kind={x['kind']} units={x['units']} free={x['avail']} status={x['status']} holiday={bool(x.get('holiday'))} days_out={x['days_out']} | " + " / ".join(x['why'][-2:])[:200])

    # ---------------------------------------------------------------- D. Maxela
    print("\n" + "=" * 100 + "\nD. MAXELA with 7 units (old) and 6 units (new): status of the empty nights in the next 30 days at the first morning run\n" + "=" * 100)
    so_, sn_ = collections.Counter(), collections.Counter()
    moved = 0
    for k, d0 in dec_o[1].items():
        if k[0] == "MAXELA" and d0["avail"] > 0 and d0["days_out"] <= 30 and k in dec_n[1]:
            so_[d0["status"]] += 1
            sn_[dec_n[1][k]["status"]] += 1
            moved += d0["status"] != dec_n[1][k]["status"]
    print(f"  old: {dict(so_)} | new: {dict(sn_)} | nights whose status changed: {moved}")

    # ---------------------------------------------------------------- E. holidays
    print("\n" + "=" * 100 + "\nE. HOLIDAY DATE RANGES (they keep their rules; none of the new rules apply to them)\n" + "=" * 100)
    print("Ranges (every year):", [(o["from"], o["to"], o.get("season")) for o in (cfg_new.get("date_overrides") or [])])
    print("Date rules of kind hold:", [r for r in (cfg_new.get("date_rules") or []) if r.get("action") == "hold"] or "none")
    print("Holiday rule limits:", cfg_new["holiday"].get("days"), "- it holds a night until", cfg_new["holiday"]["days"]["normal_upto"], "days before arrival, then the normal rules apply again")
    now_res = run({"now": now, "inventory": inventory, "reservations": reservations, "shadow": False, "release_manual": [], "own_prices": {}, "run_kind": "update"}, cfg_new, copy.deepcopy(state))
    from calm_pricing.config import holiday_ranges
    rngs = holiday_ranges(cfg_new)
    def in_range(ds, a, b):
        md = ds[5:]
        return (a <= md <= b) if a <= b else (md >= a or md <= b)
    for (a, b) in rngs:
        print(f"\nRange {a} to {b}:")
        for rt in sorted(live_rts):
            cur = "GEL" if "GEL" in live_rts[rt].get("currencies", []) else "USD"
            ds_all = [d for d in (today + timedelta(days=k) for k in range(0, 31)) if in_range(d.isoformat(), a, b)]
            decs = {x["date"]: x for x in now_res["decisions"] if x["rt"] == rt and x["currency"] == cur}
            empty = [d for d in ds_all if decs.get(d.isoformat()) and decs[d.isoformat()]["avail"] > 0]
            holding = [d for d in empty if decs[d.isoformat()].get("holiday") and decs[d.isoformat()]["holiday"].get("window")]
            print(f"   {rt}: nights in the next 30 days {len(ds_all)} ({ds_all[0].isoformat() if ds_all else '-'} to {ds_all[-1].isoformat() if ds_all else '-'}), empty {len(empty)}, with the holiday window holding the price now {len(holding)}")
    print("PROBE FINISHED")


if __name__ == "__main__":
    main()
