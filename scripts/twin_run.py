"""
"What if" twin. Runs after every real pricing run. For each idea that is still running and has saved dates:
  - an idea you SKIPPED is played as if it had been applied,
  - an idea you APPLIED is played as if it had not been applied,
using the same engine, the same rooms and nights. It keeps its own price memory (pricing_twin_state/<idea>)
and saves its prices next to the real ones, night by night (pricing_twin/<day>_<idea>).

THE TWIN NEVER SENDS ANYTHING: no price write, no channel push. A guard refuses every request to MiniHotel except
reading and logging in. Once the nights have passed, `compare` sets the twin's prices against what really happened.
The twin cannot know whether a guest would have booked at the other price: its numbers are evidence, not proof.
It starts from the real prices the day an idea first appears. Prints counts only.
"""

import argparse
import copy
import json
import os
import sys
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import idea_scorecard as sc  # noqa: E402
import pricing_calm_live as live  # noqa: E402
import pricing_shadow as ps  # noqa: E402
from calm_pricing import run  # noqa: E402

MAX_VARIANTS = 20
STATE_COLL, DAY_COLL, RESULT_COLL = "pricing_twin_state", "pricing_twin", "pricing_twin_results"
FIELD = {"startprice": "start", "floor": "min", "ceiling": "max"}


def variants(ideas: list, today: str) -> list:
    """Ideas still running (all nights not over) with saved dates, decided as applied / skipped. Replaced ideas are not played."""
    out = []
    for p in ideas:
        dec = sc.decision_of(p)
        look = (p.get("evidence") or {}).get("looked_at")
        if dec not in ("applied", "skipped") or not look or look["to"] < today:
            continue
        out.append({**p, "decision": dec, "variant": "as_applied" if dec == "skipped" else "as_not_applied"})
    out.sort(key=lambda v: v.get("ts") or "")
    return out[-MAX_VARIANTS:]


def currency_of(rt: str, ptype: str) -> str:
    if not str(ptype).lower().endswith("eur"):
        return "GEL"
    cur = [c for c in (ps.ROOM_TYPES.get(rt) or {}).get("currencies", []) if c != "GEL"]
    return cur[0] if cur else "USD"


def twin_cfg(cfg: dict, v: dict):
    """A copy of the real settings with the idea played the other way round. None when the idea does not fit the settings."""
    rt, season, field = v["property"], v["season"], FIELD.get(sc.field_of(v.get("type")))
    cur = currency_of(rt, v.get("type"))
    cell = ((cfg.get("rules") or {}).get(rt) or {}).get(cur, {}).get(season)
    if not field or not isinstance(cell, dict):
        return None
    value = v["suggested"] if v["variant"] == "as_applied" else v.get("previous", v.get("current"))
    if not isinstance(value, (int, float)):
        return None
    new = copy.deepcopy(cfg)
    new["rules"][rt][cur][season][field] = value
    return new


def play(cfg: dict, inventory: dict, state: dict, prices: dict, v: dict, now, main_run, reservations: list):
    """One twin run for one idea. Returns (twin prices {iso|CUR: price}, new state, per-night rows {iso: {CUR: price}})."""
    rt, look = v["property"], v["evidence"]["looked_at"]
    nights = {n for n in sc.nights_between(max(look["from"], now.date().isoformat()), look["to"])} if look["to"] >= now.date().isoformat() else set()
    if not nights:
        return prices, state, {}
    inv = {rt: {}}
    for iso, cell in (inventory.get(rt) or {}).items():
        c = {**cell, "prices": dict(cell.get("prices") or {})}
        for cur in list(c["prices"]):
            if f"{iso}|{cur}" in prices:
                c["prices"][cur] = prices[f"{iso}|{cur}"]                    # the twin's own last price, not the real one
        inv[rt][iso] = c
    res = run({"now": now, "inventory": inv, "reservations": reservations, "shadow": False,
               "run_kind": "main" if main_run else "update", "only": {"rooms": [rt], "dates": sorted(nights)}}, cfg, state)
    prices = dict(prices)
    rows = {}
    for d in res["decisions"]:
        if d["rt"] != rt or d["date"] not in nights:
            continue
        price = d["proposed"] if d.get("write") else d.get("current")
        if price is None:
            continue
        prices[f"{d['date']}|{d['currency']}"] = price
        rows.setdefault(d["date"], {})[d["currency"]] = price
    return prices, res["state"], rows


def last_run_is_main(db, today: str) -> bool:
    runs = [d.to_dict() for d in db.collection("pricing_calm_runs").where("day", "==", today).stream()]
    runs = [r for r in runs if r.get("day") == today and not r.get("urgent")]
    runs.sort(key=lambda r: r.get("ts", ""))
    return bool(runs and runs[-1].get("main_run"))


def real_rows(inventory: dict, rt: str, nights) -> dict:
    return {iso: {"avail": (inventory.get(rt) or {}).get(iso, {}).get("avail"), **((inventory.get(rt) or {}).get(iso, {}).get("prices") or {})}
            for iso in nights if iso in (inventory.get(rt) or {})}


def main(argv=None, db=None, now=None, get=None, cookie_fn=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry", action="store_true")
    args = ap.parse_args(argv)
    now = now or datetime.now(ps.TBILISI).replace(tzinfo=None)
    today = now.date().isoformat()
    db = db or ps.init_db()
    ideas = []
    for status in ("approved", "auto_applied", "rejected"):
        for doc in db.collection("pricing_proposals").where("status", "==", status).stream():
            d = doc.to_dict() or {}
            if d.get("type") != "run_marker":
                ideas.append({**d, "id": doc.id})
    plays = variants(ideas, today)
    if not plays:
        print("Twin: no running idea with saved dates. Nothing to play.")
        return {"played": 0}
    repo_config = json.load(open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "config.json")))
    rules, settings = ps.load_rules(db, repo_config)
    live_rts = live.live_room_types(rules, settings)
    cfg = ps.build_config(rules, settings, ps.load_events(db))
    cfg["room_types"] = live_rts
    plays = [v for v in plays if v["property"] in live_rts]
    if not plays:
        print("Twin: the running ideas are not for live rooms. Nothing to play.")
        return {"played": 0}
    rooms = sorted({v["property"] for v in plays})
    if cookie_fn is None:
        from minihotel_auth import get_session_cookie
        cookie_fn = get_session_cookie
    kw = {"get": get} if get else {}
    main_run = last_run_is_main(db, today)
    reservations, _ = ps.load_reservations(db, now.date())
    real_state = ps.load_state(db, prefix=live.STATE_PREFIX)
    played, saved, skipped = 0, 0, 0
    with live.LiveWriteGuard(set()):                       # reading and logging in only: nothing can be written or pushed
        days = max(int(live_rts[r].get("window_days") or cfg["window_days"]) for r in rooms)
        inventory = ps.fetch_inventory(cookie_fn(), now.date(), days, room_types=rooms, **kw)
    for v in plays:
        tcfg = twin_cfg(cfg, v)
        if tcfg is None:
            skipped += 1
            continue
        sref = db.collection(STATE_COLL).document(v["id"])
        snap = sref.get()
        saved_state = (snap.to_dict() or {}) if snap.exists else {}
        state = saved_state.get("data") or {k: copy.deepcopy(val) for k, val in real_state.items() if k in (v["property"], "_meta")}
        prices = saved_state.get("prices") or {}
        prices, state, rows = play(tcfg, inventory, state, prices, v, now, main_run, reservations)
        played += 1
        if args.dry or not rows:
            continue
        real = real_rows(inventory, v["property"], rows)
        nights = {iso: {"twin": cur, "real": {k: x for k, x in real.get(iso, {}).items() if k != "avail"}, "free": real.get(iso, {}).get("avail")}
                  for iso, cur in rows.items()}
        db.collection(DAY_COLL).document(f"{today}_{v['id']}").set(
            {"property_id": sc.PROPERTY_ID, "stream": "twin", "day": today, "idea_id": v["id"], "variant": v["variant"], "room": v["property"],
             "decision": v["decision"], "field": sc.field_of(v.get("type")), "value": tcfg["rules"][v["property"]][currency_of(v["property"], v.get("type"))][v["season"]][FIELD[sc.field_of(v.get("type"))]],
             "ts": now.isoformat(), "nights": nights, "night_count": len(nights)})
        sref.set({"property_id": sc.PROPERTY_ID, "data": state, "prices": prices, "ts": now.isoformat()})
        saved += 1
    print(f"Twin: {played} idea(s) played, {saved} saved, {skipped} not matching the settings | rooms {rooms} | nothing sent" + (" | DRY" if args.dry else ""))
    return {"played": played, "saved": saved}


# ---------------------------------------------------------------- comparing, when the nights have passed

def _avg(xs):
    xs = [x for x in xs if x is not None]
    return round(sum(xs) / len(xs)) if xs else None


def compare_one(v: dict, days: dict, stays: list, today: str) -> dict:
    """days {day: nights-map} are the twin's saved days for this idea, newest wins per night."""
    look = v["evidence"]["looked_at"]
    head = {"property_id": sc.PROPERTY_ID, "idea_id": v["id"], "room": v["property"], "variant": v["variant"], "decision": v["decision"],
            "from": look["from"], "to": look["to"]}
    if look["to"] >= today:
        return {**head, "status": "tracking"}
    empty = (v.get("evidence") or {}).get("empty") or sc.nights_between(look["from"], look["to"])
    made = (v.get("evidence") or {}).get("made_on") or look["from"]
    cur = currency_of(v["property"], v.get("type"))
    per_night = {}
    for day in sorted(days):
        for iso, row in days[day].items():
            if iso < day:
                continue
            per_night[iso] = row                                         # the last day that saw the night before it began
    rows = []
    for iso in empty:
        row = per_night.get(iso)
        if not row or (row.get("twin") or {}).get(cur) is None or (row.get("real") or {}).get(cur) is None:
            continue
        hit = [s for s in stays if s["rt"] == v["property"] and s.get("created") and s["created"] >= made and s["checkin"] <= iso < s["checkout"]]
        rows.append({"night": iso, "real": row["real"][cur], "twin": row["twin"][cur], "sold": bool(hit),
                     "sold_price": next((s["per_night"] for s in hit if s.get("per_night") and s.get("currency") == cur), None)})
    if not rows:
        return {**head, "status": "final", "text": "The twin has no saved prices for these nights, so there is nothing to compare."}
    sold = [r for r in rows if r["sold"]]
    real_avg, twin_avg = _avg([r["real"] for r in rows]), _avg([r["twin"] for r in rows])
    diff = round((twin_avg - real_avg) / real_avg * 100) if real_avg else None
    word = "applied" if v["variant"] == "as_applied" else "not applied"
    sym = "₾" if cur == "GEL" else "$"
    cmp_ = "about the same as" if diff is None or abs(diff) < 1 else f"{abs(diff)}% {'lower' if diff < 0 else 'higher'} than"
    text = (f"With the idea {word}, the twin priced these {len(rows)} nights at {twin_avg} {sym} on average, {cmp_} your real {real_avg} {sym}. "
            f"In real life {len(sold)} of {len(rows)} sold" + (f", at about {_avg([r['sold_price'] for r in sold])} {sym} a night" if _avg([r['sold_price'] for r in sold]) else "") +
            ". The twin cannot know if a guest would have booked at its price: this is evidence, not proof.")
    return {**head, "status": "final", "nights": len(rows), "real_avg": real_avg, "twin_avg": twin_avg, "diff_pct": diff,
            "sold": len(sold), "text": text}


def compare(db=None, now=None, dry=False):
    now = now or datetime.now(ps.TBILISI).replace(tzinfo=None)
    today = now.date().isoformat()
    db = db or ps.init_db()
    ideas = {}
    for status in ("approved", "auto_applied", "rejected"):
        for doc in db.collection("pricing_proposals").where("status", "==", status).stream():
            d = doc.to_dict() or {}
            if d.get("type") != "run_marker" and (d.get("evidence") or {}).get("looked_at"):
                ideas[doc.id] = {**d, "id": doc.id}
    by_idea = {}
    for doc in db.collection(DAY_COLL).stream():
        d = doc.to_dict() or {}
        if d.get("idea_id") in ideas:
            by_idea.setdefault(d["idea_id"], {})[d["day"]] = d.get("nights") or {}
    done = {d.id for d in db.collection(RESULT_COLL).stream() if (d.to_dict() or {}).get("status") == "final"}
    todo = [i for i in by_idea if i not in done]
    stays = sc.priced_stays(db, today) if todo else []
    final = tracking = 0
    for iid in todo:
        v = {**ideas[iid], "decision": sc.decision_of(ideas[iid]), "variant": "as_applied" if sc.decision_of(ideas[iid]) == "skipped" else "as_not_applied"}
        if v["decision"] not in ("applied", "skipped"):
            continue
        r = compare_one(v, by_idea[iid], stays, today)
        r["updated"] = today
        if r["status"] == "final":
            final += 1
        else:
            tracking += 1
        if not dry:
            db.collection(RESULT_COLL).document(iid).set(r)
    print(f"Twin comparison: {final} finished, {tracking} still running, {len(done)} already done" + (" | DRY" if dry else ""))
    return {"final": final, "tracking": tracking}


if __name__ == "__main__":
    main()
