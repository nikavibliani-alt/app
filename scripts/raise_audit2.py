"""READ-ONLY follow-up of raise_audit: (A) the MAXELA availability gap, (B) next-run raises over the WHOLE window by rule and days to arrival,
(C) how many of the last 21 days' raises each possible fix would remove, (D) three price paths of nights that stayed empty.
Writes NOTHING. Rooms, dates, prices and counts only."""
import collections
import copy
import json
import os
import sys
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import pricing_shadow as ps  # noqa: E402
import pricing_calm_live as live  # noqa: E402
import raise_audit as ra  # noqa: E402
from calm_pricing import run, season_of  # noqa: E402

SYM = ra.SYM


def describe(e, cfg, events):
    """One plain phrase for what a written change was."""
    up = e["new"] > e["old"]
    if e["kind"] != "move":
        return {"tonight": "cancellation drop (tonight/tomorrow freed)", "arrival": "arrival-day step (12:00/17:00)", "newlisting": "New listing rule",
                "own": "your typed price", "fill": "first price", "correction": "min/max correction", "reset": "reset", "far_reset": "far reset"}.get(e["kind"], e["kind"])
    if up:
        return "RAISE: " + ra.classify_event(e, cfg, events)[0]
    if (e.get("days_out") or 99) <= 3:
        return "drop: last 3 days, stepping to the minimum"
    return "drop: toward a lower target (" + str(ra.classify_event(e, cfg, events)[1]) + ")"


def main():
    print("READ-ONLY follow-up: nothing is written.\n")
    db = ps.init_db()
    repo_config = json.load(open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "config.json")))
    rules, settings = ps.load_rules(db, repo_config)
    live_rts = live.live_room_types(rules, settings)
    events = ps.load_events(db)
    cfg = ps.build_config(rules, settings, events)
    cfg["room_types"] = live_rts
    now = datetime.now(ps.TBILISI).replace(tzinfo=None)
    today = now.date()
    from minihotel_auth import get_session_cookie
    cookie = get_session_cookie()
    days = max([cfg["window_days"]] + [int(v.get("window_days") or 0) for v in live_rts.values()])
    inventory = ps.fetch_inventory(cookie, today, days, room_types=list(live_rts))
    reservations, _ = ps.load_reservations(db, today)
    state = ps.load_state(db, prefix=live.STATE_PREFIX)
    own = live.read_own_prices(db, today.isoformat())
    release = live.read_release(db)

    # ---------------------------------------------------------------- A. MAXELA
    print("=" * 100 + "\nA. MAXELA: MiniHotel shows more booked units than our reservation records\n" + "=" * 100)
    resv = [r.to_dict() or {} for r in db.collection("reservations").where("checkout", ">=", today.isoformat()).stream()]
    by_status = collections.defaultdict(lambda: collections.defaultdict(int))
    rooms_on = collections.defaultdict(lambda: collections.defaultdict(set))
    for x in resv:
        rt = ps.ROOM_CODE_TO_RT.get(x.get("roomCode"))
        if rt != "MAXELA" or not x.get("checkin"):
            continue
        n = ra.d_(x["checkin"])
        while n < ra.d_(x["checkout"]):
            by_status[n.isoformat()][str(x.get("status"))] += 1
            if str(x.get("status")) in ("OK", "OK2"):
                rooms_on[n.isoformat()]["rooms"].add(x.get("roomCode"))
            n += timedelta(days=1)
    u = live_rts["MAXELA"]["units"]
    diffs = collections.Counter()
    for k in range(0, 61):
        ds = (today + timedelta(days=k)).isoformat()
        c = inventory.get("MAXELA", {}).get(ds)
        if not c:
            continue
        inv_b = u - int(c["avail"])
        res_b = by_status[ds].get("OK", 0) + by_status[ds].get("OK2", 0)
        diffs[inv_b - res_b] += 1
    print(f"Difference per night, next 61 nights (units booked in MiniHotel minus our OK/OK2 records): {dict(sorted(diffs.items()))}")
    print("Sample nights (free/7 | our OK+OK2 | our WL | our CL | rooms booked per our records):")
    for k in (0, 1, 2, 5, 10, 20, 30, 45, 60):
        ds = (today + timedelta(days=k)).isoformat()
        c = inventory.get("MAXELA", {}).get(ds)
        if c:
            print(f"  {ds} +{k:>2}d free {c['avail']}/{u} | ok {by_status[ds].get('OK', 0) + by_status[ds].get('OK2', 0)} | WL {by_status[ds].get('WL', 0)} | CL {by_status[ds].get('CL', 0)} | rooms {sorted(rooms_on[ds]['rooms'])}")
    # what the reservations API itself says for those rooms: rows by status and room, including statuses we do not store
    try:
        import minihotel_reservation_sync as m
        m.ROOM_MAP = m.build_room_map(db)
        session = m.login_minihotel()
        api = m.fetch_reservations(session, today.isoformat(), (today + timedelta(days=60)).isoformat())
        cnt = collections.Counter((r.get("roomNumber"), r.get("status")) for r in api if str(r.get("roomNumber", "")).startswith("M-"))
        print("\nMiniHotel reservations API for the next 60 days, Maxela rooms (M-...), by room and status:")
        for (room, st), n in sorted(cnt.items(), key=lambda kv: str(kv[0])):
            print(f"   {room} {st}: {n}")
        known = set(m.ROOM_MAP)
        unknown = collections.Counter((r.get("roomNumber"), r.get("status")) for r in api if r.get("roomNumber") not in known)
        print("   rows whose room is NOT in our room map:", dict(unknown) or "none")
        print("   statuses we do not store (not OK/OK2/CL/WL), all rooms:", dict(collections.Counter(r.get("status") for r in api if r.get("status") not in m.VALID_STATUSES)) or "none")
        print("   room-type fields seen on Maxela rows:", dict(collections.Counter((r.get("roomType"), r.get("roomsQty")) for r in api if str(r.get("roomNumber", "")).startswith("M-"))))
    except SystemExit:
        print("   (the reservations API could not be read)")

    # ---------------------------------------------------------------- B. whole window, next run
    print("\n" + "=" * 100 + "\nB. THE NEXT RUN over the WHOLE window: raises on nights with at least half the units free, by days to arrival and rule\n" + "=" * 100)
    snap = {"now": now, "inventory": inventory, "reservations": reservations, "shadow": False, "release_manual": sorted(release), "own_prices": own}
    st0 = copy.deepcopy(state)
    st0.setdefault("_meta", {})["last_main_day"] = None

    def variant(**over):
        c = copy.deepcopy(cfg)
        if over.get("noevents"):
            c["events"] = {}
        if over.get("noholiday"):
            c["holiday"]["enabled"] = False
        if over.get("noweekend"):
            c["weekend"]["pct"] = 0
        if over.get("nolastunits"):
            c["last_units"]["one_left"] = c["last_units"]["two_left"] = 0
        if over.get("nobonus"):
            c["demand"]["target_adj"] = {k: min(v, 0) for k, v in c["demand"]["target_adj"].items()}
        return c
    order = [("noevents", "event bump"), ("noholiday", "holiday rule"), ("noweekend", "weekend bump"), ("nolastunits", "'only N left' bump"), ("nobonus", "status bonus (booked more than the normal curve)")]
    out = {}
    for kind in ("main", "update"):
        base = run({**snap, "run_kind": kind}, cfg, copy.deepcopy(st0))
        rs = {ra.decision_key(d): d for d in base["decisions"] if ra.is_raise(d)}
        v = {k: {ra.decision_key(d) for d in run({**snap, "run_kind": kind}, variant(**{k: True}), copy.deepcopy(st0))["decisions"] if ra.is_raise(d)} for k, _ in order}
        alloff = {ra.decision_key(d) for d in run({**snap, "run_kind": kind}, variant(noevents=True, noholiday=True, noweekend=True, nolastunits=True, nobonus=True), copy.deepcopy(st0))["decisions"] if ra.is_raise(d)}
        for key, d in rs.items():
            cat = next((name for k, name in order if key not in v[k]), None)
            if cat is None:
                cat = "a mix of the bumps" if key not in alloff else f"back toward the normal price (start x weekend), status {d['status']}"
            out.setdefault(key, (d, cat))
    allr = list(out.values())
    mostly = [(d, c) for d, c in allr if d["avail"] / d["units"] >= 0.5]
    print(f"Raises the next runs would make, whole window: {len(allr)}; on nights with >= half the units free: {len(mostly)}")
    print("By rule (>= half free):")
    for c, n in collections.Counter(c for _, c in mostly).most_common():
        print(f"  {n:5d}  {c}")
    def bucket(do):
        return "0-14 d" if do <= 14 else "15-30 d" if do <= 30 else "31-60 d" if do <= 60 else "61-90 d" if do <= 90 else "91+ d"
    print("By days to arrival:", dict(sorted(collections.Counter(bucket(d["days_out"]) for d, _ in mostly).items())))
    print("By room:", dict(collections.Counter(d["rt"] for d, _ in mostly).most_common()))
    print("By booked units / units:", dict(collections.Counter(f"{d['units'] - d['avail']} of {d['units']} booked" for d, _ in mostly).most_common(10)))
    ex = collections.Counter()
    print("Examples:")
    for d, c in sorted(mostly, key=lambda x: (x[0]["rt"], x[0]["date"])):
        if ex[d["rt"]] >= 2:
            continue
        ex[d["rt"]] += 1
        start_ = (((cfg["rules"].get(d["rt"]) or {}).get(d["currency"]) or {}).get(d["season"]) or {}).get("start")
        print(f"  {d['rt']} {d['date']} {SYM[d['currency']]} {d['units'] - d['avail']} of {d['units']} booked, {d['days_out']}d out, status {d['status']}: {d['current']:g} -> {d['proposed']:g} (start {start_}, target {d['target']}) | {c}")

    # ---------------------------------------------------------------- C. what each fix would remove
    print("\n" + "=" * 100 + "\nC. LAST 21 DAYS: how many written raises each possible rule would have removed\n" + "=" * 100)
    since = today - timedelta(days=21)
    evs = []
    for k in range(0, 22):
        day = (since + timedelta(days=k)).isoformat()
        evs += [x.to_dict() for x in db.collection("pmslog_price_events").where("day", "==", day).where("written", "==", True).stream()]
    raises = [e for e in evs if e.get("old") is not None and e["new"] > e["old"] + 1e-9 and e.get("kind") in ra.RAISE_KINDS]
    rows = [(e, ra.classify_event(e, cfg, events)[0]) for e in raises]
    n = len(rows)
    def share(f):
        return sum(1 for e, r in rows if f(e, r))
    mostly_free = lambda e: ra.free_share(e) >= 0.5   # noqa: E731
    print(f"All written raises in 21 days: {n} (the nights are mostly far ahead: {share(lambda e, r: (e.get('days_out') or 0) > 60)} are more than 60 days away)")
    print(f"  A. no raise at all while at least half the units are free: removes {share(lambda e, r: mostly_free(e))} ({share(lambda e, r: mostly_free(e)) / n:.0%}); keeps {n - share(lambda e, r: mostly_free(e))}")
    print(f"  B. no 'status bonus' raise while at least half the units are free (weekend and back-to-start raises stay): removes {share(lambda e, r: mostly_free(e) and r.startswith('status bonus'))}")
    print(f"  C. status bonus only when at least 2 units are booked (one booking is not 'ahead'): removes {share(lambda e, r: r.startswith('status bonus') and (e['units'] - e['avail']) < 2)}")
    print(f"  D. no raise of any kind more than 60 days before arrival, unless the night has bookings above half: removes {share(lambda e, r: (e.get('days_out') or 0) > 60 and mostly_free(e))}")
    print(f"  E. B + no weekend/back-to-start raise above half free except within 30 days of arrival: removes {share(lambda e, r: mostly_free(e) and (r.startswith('status bonus') or (e.get('days_out') or 0) > 30))}")
    print("  average size of the raises:", f"{sum((e['new'] - e['old']) / e['old'] for e, _ in rows) / max(1, n):+.1%}", "| status-bonus raises:",
          f"{sum((e['new'] - e['old']) / e['old'] for e, r in rows if r.startswith('status bonus')) / max(1, share(lambda e, r: r.startswith('status bonus'))):+.1%}")
    print("  raises by booked units / units for status bonus:", dict(collections.Counter(f"{e['units'] - e['avail']} of {e['units']}" for e, r in rows if r.startswith("status bonus") and mostly_free(e)).most_common(8)))
    # status bonus: how many nights got one booking and how far ahead the price went
    tot_up = collections.defaultdict(float)
    for e, r in rows:
        if mostly_free(e):
            tot_up[(e["rt"], e["date"], e["currency"])] += (e["new"] - e["old"])
    top = sorted(tot_up.items(), key=lambda kv: -kv[1])[:5]
    print("  biggest total rise on one mostly-free night in 21 days:", [(k, round(v, 1)) for k, v in top])

    # ---------------------------------------------------------------- D. paths
    print("\n" + "=" * 100 + "\nD. THREE PRICE PATHS of nights in the past 21 days that stayed empty\n" + "=" * 100)
    booked = set()
    for s_ in reservations:
        nn = ra.d_(s_["checkin"])
        while nn < ra.d_(s_["checkout"]):
            booked.add((s_["rt"], nn.isoformat()))
            nn += timedelta(days=1)
    primary = {rt: ("GEL" if "GEL" in info.get("currencies", []) else "USD") for rt, info in live_rts.items()}
    cands = []
    for rt in live_rts:
        for k in range(1, 22):
            ds = (today - timedelta(days=k)).isoformat()
            if (rt, ds) not in booked:
                cands.append((rt, ds))
    # prefer: a multi-unit night, a single-unit night, a night you set by hand
    handset = set()
    for k in range(0, 22):
        day = (since + timedelta(days=k)).isoformat()
        for rt in live_rts:
            dd = ((db.collection("pricing_calm_daily").document(f"{day}_{rt}").get().to_dict() or {}).get("dates") or {})
            for key, r in dd.items():
                ds_, _, cur = key.partition("|")
                if r.get("kind") in ("manual", "own") and (rt, ds_) in cands:
                    handset.add((rt, ds_))
    picks = []
    def path_of(rt, ds):
        cur = primary[rt]
        evl = [x.to_dict() for x in db.collection("pmslog_price_events").where("rt", "==", rt).where("date", "==", ds).stream()]
        evl = [e for e in evl if e.get("currency") == cur and e.get("written")]
        return sorted(evl, key=lambda e: str(e["ts"]))
    scored = []
    for rt, ds in cands:
        pth = path_of(rt, ds) if (rt, ds) in handset or live_rts[rt]["units"] >= 1 else []
        ups = sum(1 for e in pth if e["new"] > e["old"])
        scored.append((rt, ds, pth, ups))
    multi = [x for x in scored if live_rts[x[0]]["units"] >= 2 and x[3] >= 1 and len(x[2]) >= 3]
    single = [x for x in scored if live_rts[x[0]]["units"] == 1 and x[3] >= 1 and len(x[2]) >= 3]
    hs = [x for x in scored if (x[0], x[1]) in handset]
    for grp, label in ((multi, "multi-unit room, raised while mostly free"), (single, "single-unit room, raised while empty"), (hs, "a night you set by hand")):
        if grp:
            picks.append((max(grp, key=lambda x: (x[3], len(x[2]))), label))
    for (rt, ds, pth, ups), label in picks[:3]:
        cur = primary[rt]
        print(f"\nEXAMPLE: {rt} {ds} ({SYM[cur]} list, {live_rts[rt]['units']} units) - {label}; never booked")
        for e in pth[:60]:
            print(f"   {str(e['ts'])[5:16]}{' MORNING' if e.get('main_run') else '        '} {e['avail']}/{e['units']} free {e.get('days_out'):>3}d out  {e['old']:g} -> {e['new']:g} ({(e['new'] - e['old']) / e['old']:+.1%})  {describe(e, cfg, events)}  | target {e.get('target')} min {e.get('min')}")
        snaps = []
        for k in range(0, 22):
            day = (since + timedelta(days=k)).isoformat()
            sd = db.collection("pmslog_snapshots").document(f"{day}_{rt}").get()
            n_ = ((sd.to_dict() or {}).get("nights") or {}).get(ds) if sd.exists else None
            if n_:
                snaps.append(f"{day[5:]}:{n_.get(cur)}")
        print("   daily snapshot (date:price, last 21 days):", " ".join(snaps))
        for ch in db.collection("pricing_changes").where("type", "in", ["own_price", "manual_released"]).stream():
            x = ch.to_dict() or {}
            for fk, v in (x.get("fields") or {}).items():
                if f"{rt}|{ds}" in fk:
                    print(f"   YOU: {x.get('type')} {v.get('old')} -> {v.get('new')} at {str(x.get('ts'))[5:16]}")
    print("PROBE FINISHED")


if __name__ == "__main__":
    main()
