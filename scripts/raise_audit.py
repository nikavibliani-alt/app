"""READ-ONLY audit: why do prices go UP on nights where most units are free? Writes NOTHING (no MiniHotel price, no Firestore document, no channel push).
Prints rooms, dates, prices, counts and rule names only (no guest data, no keys).

  1. every written raise of the last 21 days on nights with at least half the units free, grouped by the rule behind it;
     the same question for the next run (a replay of the engine on today's real data, with counterfactual runs that switch one rule off at a time)
  2. the inputs: availability against reservations, units, status, currency, freshness
  3. every empty night of the next 30 days and the rule holding it up or pushing it up
  4. three price paths of nights that stayed empty
  5. start prices against what guests really paid and what was set by hand
"""
import collections
import copy
import json
import os
import re
import sys
from datetime import date, datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pricing_shadow as ps  # noqa: E402
import pricing_calm_live as live  # noqa: E402
from calm_pricing import run, season_of  # noqa: E402
from calm_pricing.curve import interpolate  # noqa: E402

SYM = {"GEL": "₾", "USD": "$"}
RAISE_KINDS = ("move", "fill", "correction", "reset", "own", "newlisting")


def d_(x):
    return date.fromisoformat(str(x)[:10])


def free_share(e):
    u = e.get("units") or 0
    return (e.get("avail") or 0) / u if u else 0


def overlap(a, b, c, d):
    return max(0.0, min(b, d) - max(a, c))


def classify_event(e, cfg, events):
    """Which rule raised this price? A written raise of kind 'move' is a step toward the engine's target; the target is built as
    start x (1 + weekend) x (1 + event) x (1 + status bonus). The part of the way from the old price to the target that lies in each layer
    names the rule. Returns (primary rule, implied status, layers dict)."""
    kind = e.get("kind")
    if kind != "move":
        return {"fill": "first price for a date that had none (fill)", "correction": "price was outside min/max: corrected",
                "reset": "one-time reset to the plain target", "own": "price typed by you",
                "newlisting": "New listing: nearly sold out"}.get(kind, kind), None, {}
    rt, cur, ds = e["rt"], e["currency"], e["date"]
    cell = (((cfg.get("rules") or {}).get(rt) or {}).get(cur) or {}).get(season_of(ds, cfg)) or {}
    S, T, old = cell.get("start"), e.get("target"), e.get("old")
    if not S or T is None or old is None:
        return "target not stored", None, {}
    wk = cfg["weekend"]["pct"] if d_(ds).weekday() in cfg["weekend"]["nights"] else 0.0
    ev = events.get(ds)
    nxt = events.get((d_(ds) + timedelta(days=1)).isoformat())
    ep = float(ev.get("pct", 0)) if ev else (float(nxt.get("pct", 0)) / 2 if nxt else 0.0)
    L1, L2, L3 = S, S * (1 + wk), S * (1 + wk) * (1 + ep)
    adj = (T / L3 - 1) if L3 else 0
    status = None
    for name, a in cfg["demand"]["target_adj"].items():
        if abs(adj - a) <= 0.01:
            status = name
    seg = {"back up toward the start price (selling as normal / below target)": overlap(old, T, 0, L1),
           "weekend bump (Fri/Sat +%d%%)" % round(wk * 100): overlap(old, T, L1, L2),
           "event bump": overlap(old, T, L2, L3),
           "status bonus (selling ahead of normal)": overlap(old, T, L3, 1e9)}
    if e.get("hol"):
        seg["holiday date rule"] = 0.0
    primary = max(seg.items(), key=lambda kv: kv[1])[0]
    if T < S - 1e-9 and old < T:
        primary = f"up to a LOWERED target ({status or 'status ?'}: target {T:g} is below start {S:g})"
    return primary, status, seg


def decision_key(d):
    return (d["rt"], d["date"], d["currency"])


def is_raise(d):
    return d.get("write") and d["proposed"] > d["current"] + 1e-9


def main():
    print("READ-ONLY audit: nothing is written to MiniHotel, Firestore or any channel.\n")
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
    days = max([cfg["window_days"]] + [int(v.get("window_days") or 0) for v in live_rts.values()])
    inventory = ps.fetch_inventory(get_session_cookie(), today, days, room_types=list(live_rts))
    reservations, _ = ps.load_reservations(db, today)
    state = ps.load_state(db, prefix=live.STATE_PREFIX)
    own = live.read_own_prices(db, today.isoformat())
    release = live.read_release(db)
    print(f"Now {now:%Y-%m-%d %H:%M} Tbilisi. Rooms live: {sorted(live_rts)}. Weekend nights {cfg['weekend']}. Events known: {len(events)}. Holiday ranges: {len(cfg.get('date_overrides') or [])}.")
    print(f"Status thresholds {cfg['demand']['far_ahead']}/{cfg['demand']['ahead']}/{cfg['demand']['behind']}/{cfg['demand']['far_behind']}, target adjustments {cfg['demand']['target_adj']}, speed up {cfg['demand']['speed_up']}\n")

    # ------------------------------------------------------------------ 1a. history
    print("=" * 100 + "\n1a. WRITTEN RAISES, LAST 21 DAYS, on nights with at least half the units free\n" + "=" * 100)
    since = today - timedelta(days=21)
    evs = []
    for k in range(0, 22):
        day = (since + timedelta(days=k)).isoformat()
        evs += [x.to_dict() for x in db.collection("pmslog_price_events").where("day", "==", day).where("written", "==", True).stream()]
    raises = [e for e in evs if e.get("old") is not None and e.get("new") is not None and e["new"] > e["old"] + 1e-9 and e.get("kind") in RAISE_KINDS]
    half = [e for e in raises if free_share(e) >= 0.5]
    print(f"Written price changes: {len(evs)}; raises: {len(raises)}; raises on nights with >= half the units free: {len(half)} ({len(half) / max(1, len(raises)):.0%} of all raises)")
    in_range = [e for e in half if today - timedelta(days=21) <= d_(e["date"]) <= today + timedelta(days=30)]
    print(f"  of those, for nights from 21 days ago to 30 days ahead: {len(in_range)}")
    cls = collections.Counter()
    by_room_rule = collections.defaultdict(collections.Counter)
    implied = collections.Counter()
    rows = []
    for e in half:
        rule, status, seg = classify_event(e, cfg, events)
        cls[rule] += 1
        by_room_rule[e["rt"]][rule] += 1
        implied[(status or "?", e.get("kind"))] += 1
        rows.append((e, rule, status))
    print("\nBy rule (all rooms):")
    for r, n in cls.most_common():
        print(f"  {n:5d}  {r}")
    print("\nImplied demand status of the target (from target / normal price) for those raises:", dict(implied))
    print("\nBy room (units) and rule:")
    for rt in sorted(by_room_rule, key=lambda x: -sum(by_room_rule[x].values())):
        print(f"  {rt} ({live_rts.get(rt, {}).get('units')} units): {sum(by_room_rule[rt].values())} raises | " + "; ".join(f"{n} {r}" for r, n in by_room_rule[rt].most_common(4)))
    by_free = collections.Counter(f"{e['avail']}/{e['units']} free" for e in half)
    print("\nBy units free/total at that moment:", dict(by_free.most_common(12)))
    by_do = collections.Counter(("0-3 days" if (e.get("days_out") or 0) <= 3 else "4-14 days" if e["days_out"] <= 14 else "15-30 days" if e["days_out"] <= 30 else "31-60 days" if e["days_out"] <= 60 else "61+ days") for e in half)
    print("By days before arrival:", dict(by_do))
    by_wd = collections.Counter(d_(e["date"]).strftime("%a") for e in half)
    print("By weekday of the night:", dict(by_wd))
    print("Main run vs other runs:", dict(collections.Counter("morning run" if e.get("main_run") else "other run" for e in half)))
    print("\nExamples (largest first, one per rule and room):")
    seen = set()
    for e, rule, status in sorted(rows, key=lambda r: -(r[0]["new"] - r[0]["old"]) / max(1, r[0]["old"])):
        k = (e["rt"], rule)
        if k in seen:
            continue
        seen.add(k)
        print(f"  {e['rt']} {e['date']} {SYM.get(e['currency'], e['currency'])} {e['avail']}/{e['units']} free, {e.get('days_out')}d out, run {str(e.get('ts'))[5:16]}{' (morning)' if e.get('main_run') else ''}: "
              f"{e['old']:g} -> {e['new']:g} ({(e['new'] - e['old']) / e['old']:+.1%}) target {e.get('target')} min {e.get('min')} max {e.get('max')} style {e.get('style')} | {rule} | status {status} | last why: {str(e.get('reason'))[:70]}")
        if len(seen) >= 28:
            break

    # ------------------------------------------------------------------ 1b. next run, counterfactual
    print("\n" + "=" * 100 + "\n1b. THE NEXT RUN (replay of the engine on today's real data): raises on nights with at least half the units free, next 30 days\n" + "=" * 100)
    snap = {"now": now, "inventory": inventory, "reservations": reservations, "shadow": False, "release_manual": sorted(release), "own_prices": own}
    st0 = copy.deepcopy(state)
    st0.setdefault("_meta", {})["last_main_day"] = None
    horizon = (today + timedelta(days=30)).isoformat()

    def replay(c, kind):
        return run({**snap, "run_kind": kind}, c, copy.deepcopy(st0))

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

    order = [("noevents", "event bump"), ("noholiday", "holiday rule"), ("noweekend", "weekend bump"), ("nolastunits", "'only N left' bump"), ("nobonus", "status bonus (selling ahead of normal)")]
    base_raises, res_main, res_upd = {}, None, None
    for kind in ("main", "update"):
        res = replay(cfg, kind)
        if kind == "main":
            res_main = res
        else:
            res_upd = res
        for d in res["decisions"]:
            if is_raise(d) and d["avail"] / max(1, d["units"]) >= 0.5 and d["date"] <= horizon:
                base_raises.setdefault(decision_key(d), (d, kind))
    print(f"Replay: morning-run raises + other-run raises on nights >= half free (next 30 days): {len(base_raises)}  [replay alerts {len(res_main['alerts'])}, warnings {len(res_main['warnings'])}]")
    var_res = {}
    for key, _ in order:
        var_res[key] = {k: run({**snap, "run_kind": k}, variant(**{key: True}), copy.deepcopy(st0)) for k in ("main", "update")}
    all_off = {k: run({**snap, "run_kind": k}, variant(noevents=True, noholiday=True, noweekend=True, nolastunits=True, nobonus=True), copy.deepcopy(st0)) for k in ("main", "update")}

    def raise_in(res, key):
        for d in res["decisions"]:
            if decision_key(d) == key:
                return is_raise(d)
        return False
    attr = collections.Counter()
    attr_of = {}
    attr_room = collections.defaultdict(collections.Counter)
    resid = []
    for key, (d, kind) in base_raises.items():
        cat = None
        for vk, name in order:
            if not raise_in(var_res[vk][kind], key):
                cat = name
                break
        if cat is None and not raise_in(all_off[kind], key):
            cat = "a mix of the bumps (weekend + event + status ...)"
        if cat is None:
            why = " | ".join(d["why"])
            if d["kind"] == "fill":
                cat = "first price for a date that had none (fill)"
            elif d["kind"] == "correction":
                cat = "price was outside min/max: corrected"
            elif d["kind"] in ("own", "newlisting"):
                cat = d["kind"]
            elif "rest of the building is selling as normal" in why:
                cat = "RESIDUAL: back toward start price - status forced to 'on track' because the rest of the building sells as normal"
            else:
                cat = f"RESIDUAL: back toward the normal price (start x weekend), status {d['status']}"
            resid.append((d, cat))
        attr[cat] += 1
        attr_of[key] = cat
        attr_room[d["rt"]][cat] += 1
    print("\nBy rule (replay, exact: each rule switched off in turn):")
    for r, n in attr.most_common():
        print(f"  {n:5d}  {r}")
    print("\nBy room:")
    for rt in sorted(attr_room, key=lambda x: -sum(attr_room[x].values())):
        print(f"  {rt} ({live_rts[rt]['units']} units): {sum(attr_room[rt].values())} | " + "; ".join(f"{n} {r[:60]}" for r, n in attr_room[rt].most_common(3)))
    print("\nRESIDUAL examples (the price is below start x weekend and moves up toward it):")
    shown = collections.Counter()
    for d, cat in sorted(resid, key=lambda x: (x[0]["rt"], x[0]["date"])):
        if shown[d["rt"]] >= 3:
            continue
        shown[d["rt"]] += 1
        start_ = (((cfg["rules"].get(d["rt"]) or {}).get(d["currency"]) or {}).get(d["season"]) or {}).get("start")
        print(f"  {d['rt']} {d['date']} {SYM.get(d['currency'])} {d['avail']}/{d['units']} free, {d['days_out']}d out, status {d['status']}: {d['current']:g} -> {d['proposed']:g} | target {d['target']} start {start_} min {d['min']} | " + " / ".join(d["why"][-4:])[:260])

    # ------------------------------------------------------------------ 2. inputs
    print("\n" + "=" * 100 + "\n2. INPUTS\n" + "=" * 100)
    codes = collections.Counter(ps.ROOM_CODE_TO_RT.values())
    print("Units: engine units vs room codes mapped to the room type:")
    for rt in sorted(live_rts):
        print(f"  {rt}: engine units {live_rts[rt]['units']} | room codes in the reservation map {codes.get(rt)} | currencies {live_rts[rt].get('currencies')}")
    rm = {}
    try:
        rooms_snap = db.collection("checkin_rooms").stream()
        rm = {s.id: (s.to_dict() or {}) for s in rooms_snap}
    except Exception:
        pass
    ph = {}
    for rt in live_rts:
        ph[rt] = sorted(c for c, r in ps.ROOM_CODE_TO_RT.items() if r == rt)
    print("  rooms with a record in checkin_rooms per type (active / shown):", {rt: f"{sum(1 for c in ph[rt] if (rm.get(c) or {}).get('active') is not False)}/{len(ph[rt])}" for rt in sorted(ph)})
    resv_all = []
    for r_ in db.collection("reservations").where("checkout", ">=", today.isoformat()).stream():
        x = r_.to_dict() or {}
        resv_all.append(x)
    cover = collections.defaultdict(lambda: collections.defaultdict(int))
    wl = collections.defaultdict(lambda: collections.defaultdict(int))
    for x in resv_all:
        rt = ps.ROOM_CODE_TO_RT.get(x.get("roomCode"))
        st = str(x.get("status", "")).upper()
        if not rt or not x.get("checkin") or not x.get("checkout"):
            continue
        n = d_(x["checkin"])
        while n < d_(x["checkout"]):
            if n >= today and n <= today + timedelta(days=30):
                if st in ("OK", "OK2"):
                    cover[rt][n.isoformat()] += 1
                elif st in ("WL", "CL"):
                    wl[rt][n.isoformat()] += 1
            n += timedelta(days=1)
    print("\nAvailability from MiniHotel against our reservation records, next 30 nights (booked units = units - free):")
    for rt in sorted(live_rts):
        u = live_rts[rt]["units"]
        eq = more = less = swapped = noinv = 0
        ex = []
        for k in range(0, 31):
            ds = (today + timedelta(days=k)).isoformat()
            cell = inventory.get(rt, {}).get(ds)
            if not cell or cell.get("avail") is None:
                noinv += 1
                continue
            av = int(cell["avail"])
            booked_inv = u - av
            booked_res = cover[rt].get(ds, 0)
            if booked_inv == booked_res:
                eq += 1
            else:
                if av == booked_res and u != 2 * booked_res:
                    swapped += 1
                if booked_inv > booked_res:
                    more += 1
                else:
                    less += 1
                if len(ex) < 3:
                    ex.append(f"{ds}: free {av}/{u}, our records book {booked_res} (waiting/cancelled-code {wl[rt].get(ds, 0)})")
        print(f"  {rt}: same {eq}, MiniHotel shows MORE booked than our records {more}, FEWER {less}, looks swapped {swapped}, no data {noinv}" + (" | e.g. " + "; ".join(ex) if ex else ""))
    over = [(rt, ds, c["avail"]) for rt, dd in inventory.items() for ds, c in dd.items() if rt in live_rts and c.get("avail") is not None and (int(c["avail"]) > live_rts[rt]["units"] or int(c["avail"]) < 0)]
    print(f"  nights where free > units or negative: {len(over)} {over[:4]}")
    # status recomputation for every decision of the replay (single-unit and pool rooms: exact; small pools blend the group, so only checked when no blend)
    dm = cfg["demand"]
    shape = {int(k): v for k, v in cfg["shape_default"].items()}
    goal = cfg["occupancy_goal"].get("default", 0.85)
    bad = collections.Counter()
    checked = collections.Counter()
    for d in res_main["decisions"]:
        info = live_rts[d["rt"]]
        if d.get("status") is None or d["avail"] == 0:
            continue
        mode = info.get("mode") or ("pool" if info["units"] >= 5 else "small_pool" if info["units"] >= 2 else "single")
        if mode == "small_pool":
            continue
        occ = (d["units"] - d["avail"]) / d["units"]
        gap = occ - goal * interpolate(shape, d["days_out"])
        st = "far_ahead" if gap >= dm["far_ahead"] else "ahead" if gap >= dm["ahead"] else "far_behind" if gap <= dm["far_behind"] else "behind" if gap <= dm["behind"] else "on_track"
        checked[d["rt"]] += 1
        if st != d["status"] and not any("rest of the building" in w for w in d["why"]):
            bad[d["rt"]] += 1
    print(f"\nStatus recomputed independently from free/units and days to arrival ('building selling as normal' excepted): checked {sum(checked.values())} decisions, disagree {sum(bad.values())} {dict(bad)}")
    stat_all = collections.Counter(d["status"] for d in res_main["decisions"] if d["avail"] > 0 and d["days_out"] <= 30)
    print("  statuses of empty nights in the next 30 days:", dict(stat_all))
    print("  expected normal share booked (the booking curve the engine uses): " + ", ".join(f"{k}d {goal * interpolate(shape, k):.0%}" for k in (0, 1, 3, 7, 14, 30, 60, 90)))
    # currency / season / fx
    print("\nCurrency and season checks (price lists present for every room; GEL vs USD ratio, expected about 2.65):")
    for rt in sorted(live_rts):
        ratios = []
        for ds, c in (inventory.get(rt) or {}).items():
            pr = c.get("prices") or {}
            if pr.get("GEL") and pr.get("USD") and ds <= horizon:
                ratios.append(pr["GEL"] / pr["USD"])
        miss = [cur for cur in live_rts[rt].get("currencies", []) if not any(((c.get("prices") or {}).get(cur)) for c in (inventory.get(rt) or {}).values())]
        print(f"  {rt}: lists {live_rts[rt].get('currencies')} | missing in MiniHotel {miss or 'none'} | GEL/USD median {sorted(ratios)[len(ratios) // 2]:.2f} range {min(ratios):.2f}-{max(ratios):.2f}" if ratios else f"  {rt}: lists {live_rts[rt].get('currencies')} | missing in MiniHotel {miss or 'none'} | no GEL+USD pair")
    sc = collections.Counter(season_of((today + timedelta(days=k)).isoformat(), cfg) for k in range(0, 31))
    print(f"  seasons of the next 30 nights: {dict(sc)} | holiday ranges {cfg.get('date_overrides')}")
    runs = [r.to_dict() for r in db.collection("pricing_calm_runs").order_by("ts", direction="DESCENDING").limit(4).stream()]
    print("  last runs:", [(str(r.get("ts"))[5:16], r.get("ok"), "main" if r.get("main_run") else "-", r.get("writes")) for r in runs])
    print("  engine memory written:", {rt: str((db.collection("pricing_engine_state").document(f"{live.STATE_PREFIX}{rt}").get().to_dict() or {}).get("ts"))[5:16] for rt in sorted(live_rts)})
    last_sync = max((str(x.get("syncedAt")) for x in resv_all), default=None)
    print("  newest reservation sync stamp:", str(last_sync)[:19])

    # ------------------------------------------------------------------ 3. empty nights next 30 days
    print("\n" + "=" * 100 + "\n3. EVERY EMPTY NIGHT, NEXT 30 DAYS: the rule holding it up or pushing it up (replay of the next morning run)\n" + "=" * 100)
    def bucket(d, kind_attr):
        why = " | ".join(d["why"])
        blk = " | ".join(d.get("blocked") or [])
        if d["kind"] in ("manual", "own"):
            return "set by you (the engine does not touch it)"
        if d["kind"] == "protected":
            return "Don't change rule"
        if d["kind"] == "newlisting":
            return "New listing rule (aiming for minimum)"
        if d.get("holiday"):
            return "holiday / small-moves date rule: price held near its anchor"
        if is_raise(d):
            return "RAISING now: " + kind_attr.get(decision_key(d), "?")
        if d.get("write") and d["proposed"] < d["current"]:
            return "dropping now (" + ("last days" if d["days_out"] <= 3 else "toward target") + ")"
        if d["current"] <= (d.get("min") or 0) + 1e-9:
            return "already at the minimum"
        if "rest of the building" in why:
            return "held up: rest of the building selling as normal (status forced to on track)"
        if "nearby in the last 3 days" in why:
            return "held up: a booking nearby in the last 3 days (pickup)"
        if "Limit: at most" in blk:
            return "limited by the daily limit"
        if "Raised less than" in blk or "Selling as normal and just moved" in blk:
            return "held: just moved, waiting (anti-wobble rule)"
        if "Already close to the target" in why:
            tgt = d.get("target")
            return "inside the dead zone (within 3% or 10 lari / 3 dollars of the target)" + (", target above price" if tgt and tgt > d["current"] else "")
        if d.get("target") is not None and d["current"] <= d["target"] + 1e-9:
            return f"at or below its target (status {d['status']})"
        return "other: " + (blk or why)[:70]
    kind_attr = dict(attr_of)
    for d in res_main["decisions"] + res_upd["decisions"]:
        if is_raise(d) and decision_key(d) not in kind_attr:
            kind_attr[decision_key(d)] = "back toward the normal price (less than half the units free, or later than 30 days)"
    primary_cur = {rt: ("GEL" if "GEL" in info.get("currencies", []) else "USD") for rt, info in live_rts.items()}
    # a night is raised if either replay (morning or other run) raises it
    raised_keys = {decision_key(d) for d in res_upd["decisions"] if is_raise(d)} | {decision_key(d) for d in res_main["decisions"] if is_raise(d)}
    upd_by = {decision_key(d): d for d in res_upd["decisions"]}
    counts = collections.Counter()
    per_room = collections.defaultdict(collections.Counter)
    lines = []
    for d in sorted(res_main["decisions"], key=lambda x: (x["rt"], x["date"])):
        if d["currency"] != primary_cur[d["rt"]] or d["avail"] == 0 or d["days_out"] > 30:
            continue
        dd = d
        if decision_key(d) in raised_keys and not is_raise(d):
            dd = upd_by[decision_key(d)]
        b = bucket(dd, kind_attr)
        counts[b] += 1
        per_room[d["rt"]][b] += 1
        cell = ((cfg["rules"].get(d["rt"]) or {}).get(d["currency"]) or {}).get(d["season"]) or {}
        lines.append(f"  {d['rt']:8} {d['date']} +{d['days_out']:>2}d {d['avail']}/{d['units']} free {SYM[d['currency']]}{d['current']:g} min/start/max {cell.get('min')}/{cell.get('start')}/{cell.get('max')} target {d.get('target')} {d['status']} | {b}")
    print("Nights per rule (price list GEL where the room has one, else USD):")
    for b, n in counts.most_common():
        print(f"  {n:5d}  {b}")
    print("\nBy room:")
    for rt in sorted(per_room):
        print(f"  {rt}: {sum(per_room[rt].values())} nights | " + "; ".join(f"{n} {b[:55]}" for b, n in per_room[rt].most_common(4)))
    print("\nEvery night:")
    print("\n".join(lines))

    # ------------------------------------------------------------------ 4. price paths
    print("\n" + "=" * 100 + "\n4. PRICE PATHS of nights that stayed empty (past 21 days)\n" + "=" * 100)
    booked_nights = set()
    for s_ in reservations:
        n = d_(s_["checkin"])
        while n < d_(s_["checkout"]):
            booked_nights.add((s_["rt"], n.isoformat()))
            n += timedelta(days=1)
    allev = collections.defaultdict(list)
    for e in evs:
        allev[(e["rt"], e["date"], e["currency"])].append(e)
    changes = []
    for c in db.collection("pricing_changes").where("type", "in", ["own_price", "manual_released"]).stream():
        x = c.to_dict() or {}
        ts = x.get("ts")
        ts = ts.isoformat() if hasattr(ts, "isoformat") else str(ts)
        if ts[:10] >= since.isoformat():
            for fk, v in (x.get("fields") or {}).items():
                changes.append((ts, x.get("type"), fk, v))
    past = [(k, v) for k, v in allev.items() if today - timedelta(days=21) <= d_(k[1]) < today and (k[0], k[1]) not in booked_nights]
    def nr(k):
        return sum(1 for e in allev[k] if e["new"] > e["old"])
    pick = []
    multi = [kv for kv in past if live_rts[kv[0][0]]["units"] >= 2 and kv[0][2] == primary_cur[kv[0][0]] and nr(kv[0]) >= 1]
    single = [kv for kv in past if live_rts[kv[0][0]]["units"] == 1 and kv[0][2] == primary_cur[kv[0][0]] and nr(kv[0]) >= 1]
    for grp, label in ((multi, "multi-unit room, raised while mostly free"), (single, "single-unit room, raised while empty")):
        if grp:
            pick.append((max(grp, key=lambda kv: (nr(kv[0]), len(kv[1])))[0], label))
    own_nights = {}
    for ts, typ, fk, v in changes:
        m = re.search(r"([A-Z_0-9]+)\|(\d{4}-\d{2}-\d{2})", fk)
        if m and typ == "own_price":
            own_nights[(m.group(1), m.group(2))] = (ts, v)
    manual_pick = [k for k in own_nights if k not in booked_nights and today - timedelta(days=21) <= d_(k[1]) < today]
    if manual_pick:
        rt_, ds_ = sorted(manual_pick, key=lambda k: own_nights[k][0])[0]
        pick.append(((rt_, ds_, primary_cur[rt_]), "a night where you set the price by hand"))
    else:
        # nights that became hand-set (kind manual in the daily records) in the last 21 days
        cand = []
        for k in range(0, 22):
            day = (since + timedelta(days=k)).isoformat()
            for rt in live_rts:
                snap_d = db.collection("pricing_calm_daily").document(f"{day}_{rt}").get()
                for key, r in ((snap_d.to_dict() or {}).get("dates") or {}).items():
                    ds_, _, cur = key.partition("|")
                    if r.get("kind") == "manual" and cur == primary_cur[rt] and today - timedelta(days=21) <= d_(ds_) < today and (rt, ds_) not in booked_nights:
                        cand.append((day, rt, ds_, cur))
        if cand:
            cand.sort()
            pick.append(((cand[0][1], cand[0][2], cand[0][3]), f"a night you set by hand (seen as hand-set from {cand[0][0]})"))
    for (rt, ds, cur), label in pick[:3]:
        print(f"\nEXAMPLE: {rt} {ds} ({SYM.get(cur)} list) - {label}; never booked; {live_rts[rt]['units']} units")
        path = []
        for e in allev.get((rt, ds, cur), []):
            path.append((str(e["ts"]), f"engine {e['kind']} {e['old']:g} -> {e['new']:g} ({(e['new'] - e['old']) / e['old']:+.1%}) {e['avail']}/{e['units']} free, {e.get('days_out')}d out, target {e.get('target')}, min {e.get('min')}{' MORNING' if e.get('main_run') else ''} | {str(e.get('reason'))[:60]}"))
        for ts, typ, fk, v in changes:
            if f"{rt}|{ds}" in fk:
                path.append((ts, f"YOU: {typ} {v.get('old')} -> {v.get('new')}"))
        for ts, line in sorted(path)[:40]:
            print(f"   {ts[5:16]}  {line}")
        # daily snapshot prices
        snaps = []
        for k in range(0, 22):
            day = (since + timedelta(days=k)).isoformat()
            sd = db.collection("pmslog_snapshots").document(f"{day}_{rt}").get()
            n_ = ((sd.to_dict() or {}).get("nights") or {}).get(ds) if sd.exists else None
            if n_:
                snaps.append(f"{day[5:]}:{n_.get(cur)}")
        print("   daily snapshot price (date: price):", " ".join(snaps))
        # last-run-of-day decision records (status and why)
        for k in range(0, 22, 3):
            day = (since + timedelta(days=k)).isoformat()
            r = (((db.collection("pricing_calm_daily").document(f"{day}_{rt}").get().to_dict() or {}).get("dates") or {}).get(f"{ds}|{cur}"))
            if r:
                print(f"   {day[5:]} last run: status {r.get('status')} target {r.get('target')} kind {r.get('kind')} | {' / '.join(r.get('why') or [])[:150]}")

    # ------------------------------------------------------------------ 5. start prices vs reality
    print("\n" + "=" * 100 + "\n5. START PRICES vs WHAT GUESTS PAID (stays checking in during the last 60 days) vs what was set by hand\n" + "=" * 100)
    import idea_scorecard as isc
    fx = cfg.get("fx", {}).get("USD", 2.65)
    stays = isc.priced_stays(db, today.isoformat(), back_days=70)
    paid = collections.defaultdict(list)
    for s_ in stays:
        if s_["rt"] not in live_rts or not (today - timedelta(days=60) <= d_(s_["checkin"]) <= today):
            continue
        p = s_.get("per_night")
        if not p:
            continue
        gel = p if s_.get("currency") == "GEL" else p * fx if s_.get("currency") == "USD" else None
        if gel is None:
            continue
        paid[(s_["rt"], season_of(s_["checkin"], cfg))].append(gel)
    hand = collections.defaultdict(list)
    for rt, dd in state.items():
        if rt == "_meta" or rt not in live_rts:
            continue
        for ds, curs in dd.items():
            if ds < today.isoformat():
                continue
            for cur, st in (curs or {}).items():
                if st.get("manual_until") and st.get("manual_price"):
                    gel = st["manual_price"] if cur == "GEL" else st["manual_price"] * fx if cur == "USD" else None
                    if gel:
                        hand[(rt, season_of(ds, cfg))].append(gel)
    print("room / season | start | min | max | guests paid (avg, n stays) | paid vs start | hand-set now (avg, n nights) | hand vs start")
    for rt in sorted(live_rts):
        cur = "GEL" if "GEL" in live_rts[rt].get("currencies", []) else "USD"
        seasons = sorted({s for (r, s) in list(paid) + list(hand) if r == rt})
        for se in seasons:
            c = (((cfg["rules"].get(rt) or {}).get(cur) or {}).get(se)) or {}
            st_, mn_, mx_ = c.get("start"), c.get("min"), c.get("max")
            mult = fx if cur == "USD" else 1
            p = paid.get((rt, se), [])
            h = hand.get((rt, se), [])
            pa = sum(p) / len(p) if p else None
            ha = sum(h) / len(h) if h else None
            sg = st_ * mult if st_ else None
            print(f"  {rt} {se} | {st_}{SYM[cur]} (={sg:.0f} lari) | {mn_} | {mx_} | " + (f"{pa:.0f} lari (n={len(p)}) | {pa / sg - 1:+.0%}" if pa and sg else "no stays | -") + " | " + (f"{ha:.0f} lari (n={len(h)}) | {ha / sg - 1:+.0%}" if ha and sg else "none | -"))
    own_week = [(ts, fk, v) for ts, typ, fk, v in changes if typ == "own_price" and ts[:10] >= (today - timedelta(days=7)).isoformat()]
    print(f"\nPrices typed on the page in the last 7 days: {len(own_week)} nights; typed prices waiting now: {len(own)}")
    for ts, fk, v in own_week[:10]:
        print(f"   {ts[5:16]} {fk} {v.get('new')}")
    print("PROBE FINISHED")


if __name__ == "__main__":
    main()
