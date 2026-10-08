"""
Market simulator for testing pricing engines offline.

Fake guests look for a stay, see the posted price, and book if it is within
their budget and the unit is free for all their nights. Engines run 5 times a
day (Tbilisi 04:00, 09:00, 13:00, 16:00, 22:00, like the cron-job.org times
00, 05, 09, 12, 18 UTC). Everything is invented: this tests behaviour and
safety rules, it does not forecast your real revenue.
"""

from __future__ import annotations

import io
import json
import math
import os
import random
import sys
import types
import contextlib
from datetime import date, datetime, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)

from calm_pricing import engine as calm_engine           # noqa: E402
from calm_pricing.config import merged, season_of         # noqa: E402

REPO = os.environ.get("MAXELA_REPO", ROOT if os.path.exists(os.path.join(ROOT, "velocity_engine.py")) else "/root/maxela-app")
RUN_HOURS = [4, 9, 13, 16, 22]

# ---------------------------------------------------------------------------
# Portfolio (your real room types; prices from config.json and the plan doc)
# ---------------------------------------------------------------------------

def load_repo_config():
    with open(os.path.join(REPO, "config.json")) as f:
        return json.load(f)


SEASONS = ["low", "mid", "high", "peak", "xmas_low", "new_year"]


def portfolio(widen_max: float | None = None):
    """Room types and min/start/max rules. widen_max: if set, max = start*(1+widen_max)."""
    c = load_repo_config()
    rts = {
        "ROOMS":   {"units": 5, "group": "shartava", "currencies": ["GEL"]},
        "MAXELA":  {"units": 7, "group": "shartava", "currencies": ["GEL"]},
        "BIG_APT": {"units": 1, "group": "shartava", "currencies": ["GEL", "USD"]},
        "FREEDOM": {"units": 3, "group": "freedom", "currencies": ["GEL", "USD"]},
        "ORBE_1":  {"units": 2, "group": "orbeliani", "currencies": ["GEL", "USD"]},
        "ORBE_2":  {"units": 1, "group": "orbeliani", "currencies": ["USD"]},
        "VGL_ST":  {"units": 2, "group": "vgl", "currencies": ["GEL", "USD"]},
        "VGL_AP":  {"units": 2, "group": "vgl", "currencies": ["GEL", "USD"]},
        "XCV_1":   {"units": 1, "group": "xcv", "currencies": ["GEL", "USD"]},
        "XCV_2":   {"units": 1, "group": "xcv", "currencies": ["GEL", "USD"]},
    }
    for v in rts.values():
        v["status"] = "live"
    rules = {}
    for rt in ["ROOMS", "MAXELA", "BIG_APT", "FREEDOM", "ORBE_1"]:
        rules[rt] = {"GEL": {}}
        for s in SEASONS:
            mn = c["floor_prices_gel"][rt][s]
            st = c["base_prices_gel"][rt][s]
            mx = c["ceiling_prices_gel"][rt][s]
            rules[rt]["GEL"][s] = {"min": mn, "start": st, "max": mx}
    for rt in ["BIG_APT", "FREEDOM", "ORBE_1", "ORBE_2"]:
        rules.setdefault(rt, {})["USD"] = {}
        for s in SEASONS:
            rules[rt]["USD"][s] = {"min": c["floor_prices_eur"][rt][s], "start": c["base_prices_eur"][rt][s],
                                   "max": c["ceiling_prices_eur"][rt][s]}
    # VGL and XCV: posted prices from the plan (guest price / 0.75 on Booking; USD = guest price / 2.65)
    grids = {
        "VGL_ST": {"low": (60, 75, 100), "mid": (75, 95, 125), "xmas_low": (70, 90, 115),
                   "high": (85, 105, 140), "peak": (90, 115, 150), "new_year": (110, 140, 190)},
        "VGL_AP": {"low": (75, 95, 125), "mid": (90, 115, 150), "xmas_low": (85, 110, 140),
                   "high": (105, 130, 170), "peak": (110, 140, 180), "new_year": (130, 170, 220)},
        "XCV_1": {"low": (75, 95, 120), "mid": (85, 110, 140), "xmas_low": (80, 100, 130),
                  "high": (95, 120, 155), "peak": (100, 130, 165), "new_year": (120, 160, 230)},
        "XCV_2": {"low": (80, 105, 130), "mid": (90, 120, 150), "xmas_low": (85, 110, 140),
                  "high": (100, 130, 165), "peak": (110, 140, 175), "new_year": (130, 170, 240)},
    }
    for rt, g in grids.items():
        rules[rt] = {"GEL": {}, "USD": {}}
        for s, (mn, st, mx) in g.items():
            rules[rt]["GEL"][s] = {"min": round(mn / 0.75 / 5) * 5, "start": round(st / 0.75 / 5) * 5,
                                   "max": round(mx / 0.75 / 5) * 5}
            rules[rt]["USD"][s] = {"min": round(mn / 2.65), "start": round(st / 2.65), "max": round(mx / 2.65)}
    if widen_max is not None:
        for rt in rules:
            for cur in rules[rt]:
                for s in rules[rt][cur]:
                    r = rules[rt][cur][s]
                    r["max"] = max(r["max"], round(r["start"] * (1 + widen_max)))
    return rts, rules


# ---------------------------------------------------------------------------
# Guests
# ---------------------------------------------------------------------------

LEAD = [(0, 0.30), (1, 0.20), (2, 0.06), (3, 0.04), (5, 0.06), (7, 0.04), (10, 0.06),
        (14, 0.06), (21, 0.06), (30, 0.05), (45, 0.04), (60, 0.02), (80, 0.01)]
LOS = [(1, 0.22), (2, 0.24), (3, 0.20), (4, 0.12), (5, 0.08), (7, 0.09), (10, 0.03), (14, 0.02)]


def _pick(rng, table):
    x = rng.random()
    acc = 0.0
    for v, p in table:
        acc += p
        if x <= acc:
            return v
    return table[-1][0]


def guest_price(rt, prices, cur_list, fx):
    """Price the guest sees, in lari (Booking GEL if sold there, else Airbnb USD converted)."""
    if "GEL" in cur_list and prices.get("GEL"):
        return prices["GEL"]
    return prices.get("USD", 0) * fx


def make_guests(rng, rts, rules, start_day, days, scenario):
    """Pre-generate every potential guest for the whole simulation."""
    guests = []
    level = scenario.get("level", 1.0)
    events = scenario.get("events", {})
    rate = scenario.get("rate", 0.55)     # potential stays starting per unit per night
    for rt, info in rts.items():
        units = info["units"]
        cur = "GEL" if "GEL" in info["currencies"] else "USD"
        fx = 2.65 if cur == "USD" else 1.0
        for i in range(-2, days + 95):
            d = start_day + timedelta(days=i)
            s = season_of(d.isoformat(), {"seasons": merged()["seasons"], "date_overrides": []})
            start_price = rules[rt][cur][s]["start"] * fx
            wk = 1.08 if d.weekday() in (4, 5) else 1.0
            ev = 1 + events.get(d.isoformat(), 0)
            day_shock = math.exp(rng.gauss(0, 0.10))
            fair = start_price * wk * ev * level * day_shock
            lam = rate * units * (1.6 if ev > 1 else 1.0) * scenario.get("volume", 1.0)
            n = _poisson(rng, lam * 1.6)   # more lookers than bookers; budget filters them
            for _ in range(n):
                lead = _pick(rng, LEAD) + rng.random()
                t = datetime.combine(d, datetime.min.time()) + timedelta(hours=15) - timedelta(days=lead)
                los = _pick(rng, LOS)
                wtp = fair * math.exp(rng.gauss(0.05, 0.22))
                cancel_at = None
                if rng.random() < scenario.get("cancel_rate", 0.08):
                    span = (datetime.combine(d, datetime.min.time()) - t).total_seconds()
                    if span > 3600:
                        cancel_at = t + timedelta(seconds=rng.random() * span)
                guests.append({"rt": rt, "t": t, "checkin": d, "los": los, "wtp": wtp, "cancel_at": cancel_at})
    guests.sort(key=lambda g: g["t"])
    return guests


def _poisson(rng, lam):
    L, k, p = math.exp(-lam), 0, 1.0
    while True:
        p *= rng.random()
        if p <= L:
            return k
        k += 1


# ---------------------------------------------------------------------------
# Engines
# ---------------------------------------------------------------------------

class CalmEngine:
    name = "new calm engine"

    def __init__(self, rts, rules, scenario, overrides=None):
        cfg = merged(overrides or {})
        cfg["room_types"] = rts
        cfg["rules"] = rules
        cfg["events"] = {k: {"label": "Event", "pct": v} for k, v in scenario.get("events", {}).items()}
        cfg["safety"]["max_share_changed"] = scenario.get("max_share_changed", cfg["safety"]["max_share_changed"])
        self.cfg = cfg
        self.state = {}
        self.alerts = []

    learn = True
    _curves = None
    _curve_day = None

    def _learn(self, now, reservations):
        from calm_pricing.curve import learn_shape
        groups = {}
        for rt, info in self.cfg["room_types"].items():
            groups.setdefault(info["group"], {"units": 0, "rts": set()})
            groups[info["group"]]["units"] += info["units"]
            groups[info["group"]]["rts"].add(rt)
        curves = {}
        for g, gi in groups.items():
            rs = [r for r in reservations if r["rt"] in gi["rts"]]
            curves[g] = learn_shape(rs, now.date(), self.cfg["shape_default"])
        return curves

    def step(self, now, inventory, reservations):
        if self.learn and self._curve_day != now.date():
            self._curves = self._learn(now, reservations)
            self._curve_day = now.date()
        snap = {"now": now, "inventory": inventory, "reservations": reservations}
        if self.learn and self._curves:
            snap["curves"] = self._curves
        res = calm_engine.run(snap, self.cfg, self.state)
        self.state = res["state"]
        if res["alerts"]:
            self.alerts.append((now, res["alerts"][:3]))
        return res["writes"], res


class OldEngine:
    """Today's velocity engine, called exactly as pricing_engine.py calls it."""
    name = "current engine"

    def __init__(self, rts, rules, scenario, velocity_mode="as_today"):
        for name in ["minihotel_auth", "event_scanner", "ai_pricing", "claude_pricing", "price_tracker"]:
            m = types.ModuleType(name)
            m.get_session_cookie = lambda: ""
            m.scan_and_update = lambda *a, **k: None
            m.get_booking_velocity = lambda *a, **k: {}
            m.claude_write_daily_proposal = lambda c, *a, **k: c
            for fn in ["snapshot_prices", "record_outcomes", "load_experiment_locks", "detect_manual_experiments",
                       "update_engine_prices_in_locks", "record_experiment_outcome"]:
                setattr(m, fn, lambda *a, **k: None)
            sys.modules.setdefault(name, m)
        sys.path.insert(0, REPO)
        import pricing_engine as pe
        import velocity_engine as ve
        self.pe, self.ve = pe, ve
        c = load_repo_config()
        c["startPrices"] = {rt: {s: rules[rt]["GEL"][s]["start"] for s in SEASONS} for rt in rules if "GEL" in rules[rt] and rt in pe.ROOM_TYPES}
        c["startPricesEur"] = {rt: {s: rules[rt]["USD"][s]["start"] for s in SEASONS} for rt in rules if "USD" in rules[rt] and rt in pe.ROOM_TYPES}
        c["floor_prices_gel"] = {rt: {s: rules[rt]["GEL"][s]["min"] for s in SEASONS} for rt in rules if "GEL" in rules[rt]}
        c["ceiling_prices_gel"] = {rt: {s: rules[rt]["GEL"][s]["max"] for s in SEASONS} for rt in rules if "GEL" in rules[rt]}
        c["floor_prices_eur"] = {rt: {s: rules[rt]["USD"][s]["min"] for s in SEASONS} for rt in rules if "USD" in rules[rt]}
        c["ceiling_prices_eur"] = {rt: {s: rules[rt]["USD"][s]["max"] for s in SEASONS} for rt in rules if "USD" in rules[rt]}
        c["event_premiums"] = {k: {"label": "Event", "multiplier": 1 + v} for k, v in scenario.get("events", {}).items()}
        self.cfg = c
        self.rts = {rt: v for rt, v in rts.items() if rt in pe.ROOM_TYPES}
        self.velocity_mode = velocity_mode
        self.alerts = []

    def step(self, now, inventory, reservations):
        today = now.date()
        self.pe.days_until = lambda ds: (date.fromisoformat(ds) - today).days
        raw = []
        for rt in self.rts:
            dates = []
            for ds, cell in inventory.get(rt, {}).items():
                rates = []
                if cell["prices"].get("GEL"):
                    rates.append({"PriceList": "GEL", "Price": cell["prices"]["GEL"]})
                if cell["prices"].get("USD"):
                    rates.append({"PriceList": "EUR", "Price": cell["prices"]["USD"]})
                dates.append({"Date": ds, "Availability": cell["avail"], "Rates": rates})
            raw.append({"RoomTypeCode": rt, "Dates": dates})
        velocity = {}
        for rt in self.rts:
            if self.velocity_mode == "as_today":
                # the sync rewrites syncedAt on every stay from 7 days back to 60 ahead every 10 minutes
                n = sum(1 for r in reservations if r["rt"] == rt and
                        today - timedelta(days=7) <= date.fromisoformat(r["checkin"]) <= today + timedelta(days=60))
                velocity[rt] = {"bookings_last_7d": n, "bookings_last_14d": n}
            else:
                n7 = sum(1 for r in reservations if r["rt"] == rt and date.fromisoformat(r["created"]) >= today - timedelta(days=7))
                n14 = sum(1 for r in reservations if r["rt"] == rt and date.fromisoformat(r["created"]) >= today - timedelta(days=14))
                velocity[rt] = {"bookings_last_7d": n7, "bookings_last_14d": n14}
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            results = self.ve.compute_prices_velocity(raw, self.cfg, velocity, experiment_locks={})
        writes = []
        for rt, dates in results.items():
            for d in dates:
                if d.get("skip") or not d.get("changed"):
                    continue
                if "GEL" in self.rts[rt]["currencies"] and abs(d["proposed_gel"] - d["current_gel"]) >= 1:
                    writes.append({"rt": rt, "date": d["date"], "currency": "GEL", "price": d["proposed_gel"]})
                if "USD" in self.rts[rt]["currencies"] and abs(d["proposed_eur"] - d["current_eur"]) >= 1:
                    writes.append({"rt": rt, "date": d["date"], "currency": "USD", "price": d["proposed_eur"]})
        return writes, None


# ---------------------------------------------------------------------------
# Simulation loop
# ---------------------------------------------------------------------------

def simulate(engine_factory, scenario, seed=1, days=100, start_day=date(2026, 10, 7),
             room_filter=None, widen_max=None, keep_trace=False, measure_from=20):
    rng = random.Random(seed)
    rts, rules = portfolio(widen_max)
    if room_filter:
        rts = {k: v for k, v in rts.items() if k in room_filter}
        rules = {k: v for k, v in rules.items() if k in room_filter}
    engine = engine_factory(rts, rules, scenario)
    guests = make_guests(random.Random(seed * 7919), rts, rules, start_day, days, scenario)
    window = 90

    # MiniHotel state: units booked per night, and current posted prices
    booked = {rt: {} for rt in rts}
    prices = {rt: {} for rt in rts}
    reservations = []      # active (not cancelled)
    history = {}           # (rt, ds, cur) -> list of (datetime, days_out, price)
    stays = []             # realised stays for revenue
    cancels = sorted([g for g in guests if g["cancel_at"]], key=lambda g: g["cancel_at"])

    def season(ds):
        return season_of(ds, {"seasons": merged()["seasons"], "date_overrides": []})

    def ensure_prices(today):
        for rt, info in rts.items():
            for i in range(0, window + 1):
                ds = (today + timedelta(days=i)).isoformat()
                if ds not in prices[rt]:
                    s = season(ds)
                    prices[rt][ds] = {cur: float(rules[rt][cur][s]["start"]) for cur in info["currencies"]}
                    for cur in info["currencies"]:
                        history.setdefault((rt, ds, cur), []).append((None, i, prices[rt][ds][cur]))

    def inventory(today):
        inv = {}
        for rt, info in rts.items():
            inv[rt] = {}
            for i in range(0, window + 1):
                ds = (today + timedelta(days=i)).isoformat()
                inv[rt][ds] = {"avail": info["units"] - booked[rt].get(ds, 0), "prices": dict(prices[rt][ds])}
        return inv

    gi, ci = 0, 0
    now = datetime.combine(start_day, datetime.min.time())
    end = now + timedelta(days=days)
    run_times = []
    d = start_day
    while datetime.combine(d, datetime.min.time()) < end:
        for h in RUN_HOURS:
            run_times.append(datetime.combine(d, datetime.min.time()) + timedelta(hours=h))
        d += timedelta(days=1)

    # warm-up: bookings made before the simulation started at start prices
    ensure_prices(start_day)

    for rt_time in run_times:
        today = rt_time.date()
        ensure_prices(today)
        # guests and cancellations between the last run and this one
        while gi < len(guests) and guests[gi]["t"] < rt_time:
            g = guests[gi]
            gi += 1
            rt = g["rt"]
            ci_d = g["checkin"]
            if ci_d < g["t"].date():
                continue
            nights = [(ci_d + timedelta(days=k)).isoformat() for k in range(g["los"])]
            if any(booked[rt].get(n, 0) >= rts[rt]["units"] for n in nights):
                continue
            # price for nights beyond the window: use start price
            first = nights[0]
            pr = prices[rt].get(first)
            if pr is None:
                continue
            gp = guest_price(rt, pr, rts[rt]["currencies"], 2.65)
            # multi-night: guest compares the average of the nights they can see
            seen = [guest_price(rt, prices[rt][n], rts[rt]["currencies"], 2.65) for n in nights if n in prices[rt]]
            avg = sum(seen) / len(seen) if seen else gp
            if avg > g["wtp"]:
                continue
            for n in nights:
                booked[rt][n] = booked[rt].get(n, 0) + 1
            res = {"rt": rt, "checkin": first, "checkout": (ci_d + timedelta(days=g["los"])).isoformat(),
                   "created": g["t"].date().isoformat(), "nights": nights, "guest": id(g),
                   "paid": [guest_price(rt, prices[rt].get(n, pr), rts[rt]["currencies"], 2.65) for n in nights]}
            g["res"] = res
            reservations.append(res)
        while ci < len(cancels) and cancels[ci]["cancel_at"] < rt_time:
            g = cancels[ci]
            ci += 1
            res = g.get("res")
            if res and res in reservations and date.fromisoformat(res["checkin"]) > g["cancel_at"].date():
                reservations.remove(res)
                for n in res["nights"]:
                    booked[res["rt"]][n] -= 1
        # engine run
        inv = inventory(today)
        writes, _ = engine.step(rt_time, inv, [r for r in reservations])
        for w in writes:
            prices[w["rt"]][w["date"]][w["currency"]] = float(w["price"])
            days_out = (date.fromisoformat(w["date"]) - today).days
            history.setdefault((w["rt"], w["date"], w["currency"]), []).append((rt_time, days_out, float(w["price"])))

    return measure(rts, rules, reservations, history, prices, start_day, days, engine, keep_trace,
                   measure_from, set(scenario.get("events", {})))


# ---------------------------------------------------------------------------
# Measurements
# ---------------------------------------------------------------------------

def measure(rts, rules, reservations, history, prices, start_day, days, engine, keep_trace=False,
            measure_from=20, event_days=frozenset()):
    # judge stay nights whose whole booking window ran inside the simulation
    first = start_day + timedelta(days=measure_from)
    last = start_day + timedelta(days=days - 1)
    nights_total, nights_sold, revenue = 0, 0, 0.0
    per_rt = {}
    for rt, info in rts.items():
        n_tot = 0
        d = first
        while d <= last:
            n_tot += info["units"]
            d += timedelta(days=1)
        per_rt[rt] = {"nights": n_tot, "sold": 0, "revenue": 0.0}
        nights_total += n_tot
    for r in reservations:
        for n, p in zip(r["nights"], r["paid"]):
            nd = date.fromisoformat(n)
            if first <= nd <= last:
                per_rt[r["rt"]]["sold"] += 1
                per_rt[r["rt"]]["revenue"] += p
                nights_sold += 1
                revenue += p

    changes, max_day_move, flips, violations, arrival_min, far_moves = [], 0.0, 0, 0, 0, 0
    worst = None
    for (rt, ds, cur), h in history.items():
        nd = date.fromisoformat(ds)
        if not (first <= nd <= last):
            continue
        s = season_of(ds, {"seasons": merged()["seasons"], "date_overrides": []})
        rule = rules[rt][cur][s]
        writes = [x for x in h if x[0] is not None]
        changes.append(len(writes))
        # biggest move within one calendar day, across all runs
        by_day = {}
        prev = h[0][2]
        for t, d_out, p in h:
            if t is None:
                prev = p
                continue
            key = t.date()
            by_day.setdefault(key, [prev, p])
            by_day[key][1] = p
            prev = p
        for k, (p0, p1) in by_day.items():
            mv = abs(p1 - p0) / p0 if p0 else 0
            if mv > max_day_move:
                max_day_move, worst = mv, (rt, ds, cur, k.isoformat(), p0, p1)
        # direction changes within 48 hours
        dirs = []
        prev = h[0][2]
        for t, d_out, p in h:
            if t is not None and p != prev:
                dirs.append((t, 1 if p > prev else -1))
            prev = p
        for (t1, d1), (t2, d2) in zip(dirs, dirs[1:]):
            if d1 != d2 and (t2 - t1) <= timedelta(hours=48):
                flips += 1
        for t, d_out, p in h:
            if p < rule["min"] - 0.01 or p > rule["max"] * 1.5 + 0.01:
                violations += 1
            if t is not None and d_out == 0 and p <= rule["min"] + 0.01 and len(writes) and h[-1][2] < h[0][2]:
                pass
            near_event = ds in event_days or (nd + timedelta(days=1)).isoformat() in event_days
            if t is not None and d_out > 60 and not near_event and abs(p - rule["start"]) / rule["start"] > 0.031 + 0.08:
                far_moves += 1
        # arrival day: price written on arrival day lower than the night before?
        arr = [x for x in writes if x[1] == 0]
        before = [x for x in h if x[0] is None or x[1] >= 1]
        if arr and before and arr[-1][2] < before[-1][2] - 0.01:
            arrival_min += 1

    out = {
        "engine": engine.name,
        "occupancy": nights_sold / nights_total if nights_total else 0,
        "revenue": revenue,
        "adr": revenue / nights_sold if nights_sold else 0,
        "changes_per_date": sum(changes) / len(changes) if changes else 0,
        "max_one_day_move": max_day_move,
        "worst_move": worst,
        "flip_flops": flips,
        "below_min_or_wild": violations,
        "lowered_on_arrival_day": arrival_min,
        "far_date_moves_over_band": far_moves,
        "alerts": len(engine.alerts),
        "per_rt": {rt: {"occ": v["sold"] / v["nights"] if v["nights"] else 0, "rev": round(v["revenue"])}
                   for rt, v in per_rt.items()},
    }
    if keep_trace:
        out["history"] = history
    return out
