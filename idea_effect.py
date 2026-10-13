"""
What an idea would really change. The engine is run twice on the prices it saved at its last run, once as it is and once with the
idea's number changed. The nights whose final price differs, and that can really be sold, are the idea's nights. Nothing is written.

A night counts only if it can be sold: at least 1 unit free, not past, not hand-set, not protected. In a room with 1 unit, a gap of
1-2 free nights next to a booking does not count (nobody can use it). The idea maker uses this to make an idea only when it changes
at least 3 such nights. Reads only; the engine's own memory is copied, never changed.
"""

from __future__ import annotations

import copy
import json
import os
from datetime import date, datetime, timedelta

import idea_evidence as ie

MIN_NIGHTS = 3
FIELD = {"startprice": "start", "floor": "min", "ceiling": "max"}
MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


class Context:
    def __init__(self, db, cfg, live_rts, state, reservations, now, locks):
        self.db, self.cfg, self.live_rts, self.state, self.reservations, self.now, self.locks = db, cfg, live_rts, state, reservations, now, locks


def build_context(db, repo_config: dict, now: datetime | None = None) -> Context:
    import pricing_calm_live as live
    import pricing_shadow as ps
    now = now or datetime.now(ps.TBILISI).replace(tzinfo=None)
    rules, settings = ps.load_rules(db, repo_config)
    live_rts = live.live_room_types(rules, settings)
    cfg = ps.build_config(rules, settings, ps.load_events(db))
    cfg["room_types"] = live_rts
    reservations, _ = ps.load_reservations(db, now.date())
    return Context(db, cfg, live_rts, ps.load_state(db, prefix=live.STATE_PREFIX), reservations, now, ie.locked_nights(db))


def _nights_after(a: str, k: int) -> str:
    return (date.fromisoformat(a) + timedelta(days=k)).isoformat()


def runs_of(nights: list) -> list:
    """Consecutive nights as [{from, to, nights}]."""
    out = []
    for n in sorted(set(nights)):
        if out and (date.fromisoformat(n) - date.fromisoformat(out[-1]["to"])).days == 1:
            out[-1]["to"] = n
            out[-1]["nights"] += 1
        else:
            out.append({"from": n, "to": n, "nights": 1})
    return out


def sellable_set(dates: dict, rt: str, cur: str, today: str, units: int, locks: set) -> tuple:
    """(set of sellable nights, number of gap nights removed) from the saved daily records of one room."""
    other = "GEL" if cur == "USD" else "USD"
    recs = {}
    for key, rc in dates.items():
        iso, _, c = key.partition("|")
        if c in (cur, other) and (iso not in recs or c == cur):
            recs[iso] = rc
    free = {}
    for iso in sorted(recs):
        if iso < today:
            continue
        rc = recs[iso]
        free[iso] = (rc.get("avail") or 0) > 0 and rc.get("kind") not in ie.HAND_SET_KINDS and f"{rt}_{iso}" not in locks
    sellable = {iso for iso, ok in free.items() if ok}
    gaps = 0
    if units == 1:
        order = sorted(recs)
        i = 0
        while i < len(order):
            if order[i] < today or (recs[order[i]].get("avail") or 0) <= 0:
                i += 1
                continue
            j = i
            while j + 1 < len(order) and (recs[order[j + 1]].get("avail") or 0) > 0 and (date.fromisoformat(order[j + 1]) - date.fromisoformat(order[j])).days == 1:
                j += 1
            before = recs.get(_nights_after(order[i], -1))
            after = recs.get(_nights_after(order[j], 1))
            booked_next = (before is not None and (before.get("avail") or 0) <= 0) or (after is not None and (after.get("avail") or 0) <= 0)
            if j - i + 1 <= 2 and booked_next:
                for k in range(i, j + 1):
                    if order[k] in sellable:
                        sellable.discard(order[k])
                        gaps += 1
            i = j + 1
    return sellable, gaps


def _inventory(dates: dict, currencies: list, today: str) -> dict:
    inv = {}
    for key, rc in dates.items():
        iso, _, c = key.partition("|")
        if iso < today or c not in currencies:
            continue
        price = rc.get("new") if rc.get("new") else rc.get("mh")
        cell = inv.setdefault(iso, {"avail": rc.get("avail"), "prices": {}})
        if price:
            cell["prices"][c] = price
        if rc.get("avail") is not None:
            cell["avail"] = rc["avail"]
    return {iso: c for iso, c in inv.items() if c.get("avail") is not None}


def measure(ctx: Context, idea: dict) -> dict:
    """{"changed": [nights], "groups": [...], "examples": [...], "sellable": n, "gaps": n} or {"error": text}."""
    from calm_pricing import run
    rt, season, ptype = idea["property"], idea["season"], idea["type"]
    base_kind = str(ptype)[:-3] if str(ptype).lower().endswith("eur") else str(ptype)
    field = FIELD.get(base_kind.lower())
    cur = ie.price_list_of(ptype)
    info = ctx.live_rts.get(rt)
    if not info:
        return {"error": f"{rt} is not a live room of the new engine"}
    if not field:
        return {"error": f"unknown kind of idea {ptype}"}
    cell = (((ctx.cfg.get("rules") or {}).get(rt) or {}).get(cur) or {}).get(season)
    if not isinstance(cell, dict) or field not in cell:
        return {"error": f"no {field} for {rt} {season} {cur} in the settings"}
    today = ctx.now.date().isoformat()
    day, dates = ie.load_daily(ctx.db, rt, today)
    if not dates:
        return {"error": "no saved prices for this room"}
    units = int(info.get("units") or 1)
    sellable, gaps = sellable_set(dates, rt, cur, today, units, ctx.locks)
    inv = _inventory(dates, list(info.get("currencies") or ["GEL"]), today)

    def play(cfg):
        state = {k: copy.deepcopy(v) for k, v in ctx.state.items() if k in (rt, "_meta")}
        res = run({"now": ctx.now, "inventory": {rt: copy.deepcopy(inv)}, "reservations": ctx.reservations, "shadow": False,
                   "run_kind": "main", "only": {"rooms": [rt], "dates": sorted(inv)}}, cfg, state)
        out = {}
        for d in res["decisions"]:
            if d["rt"] == rt and d["currency"] == cur:
                # the price the engine wants for the night after this run (a move held back by a safety stop still shows what it wanted)
                out[d["date"]] = d["proposed"] if d.get("write") else (d["rejected"] if d.get("rejected") is not None else d.get("current"))
        return res, out
    base_cfg = ctx.cfg
    idea_cfg = copy.deepcopy(ctx.cfg)
    idea_cfg["rules"][rt][cur][season][field] = idea["suggested"]
    res_a, without = play(base_cfg)
    res_b, with_ = play(idea_cfg)
    if not res_a.get("ok") or not res_b.get("ok"):
        return {"error": "the engine stopped while testing this idea"}
    changed = sorted(n for n in with_ if n in sellable and without.get(n) is not None and abs(with_[n] - without[n]) > 1e-9)
    examples = [{"date": n, "without": without[n], "with": with_[n]} for n in changed[:3]]
    return {"changed": changed, "groups": runs_of(changed), "examples": examples, "sellable": len(sellable), "gaps": gaps, "price_list": cur}


def effect_record(m: dict) -> dict:
    return {"version": 2, "changed_count": len(m["changed"]), "groups": m["groups"][:12], "groups_total": len(m["groups"]),
            "examples": m["examples"], "sellable": m["sellable"], "gap_nights_ignored": m["gaps"], "price_list": m["price_list"]}


def dates_text(groups: list) -> str:
    """'4-6 Jan 2027 (3 nights), 7-14 Jan 2027 (8 nights)': for logs and tests."""
    def one(g):
        a, b = date.fromisoformat(g["from"]), date.fromisoformat(g["to"])
        if a == b:
            return f"{a.day} {MONTHS[a.month - 1]} {a.year}"
        if (a.year, a.month) == (b.year, b.month):
            return f"{a.day}-{b.day} {MONTHS[b.month - 1]} {b.year}"
        return f"{a.day} {MONTHS[a.month - 1]} {a.year} - {b.day} {MONTHS[b.month - 1]} {b.year}"
    return ", ".join(f"{one(g)} ({g['nights']} night{'s' if g['nights'] != 1 else ''})" for g in groups)
