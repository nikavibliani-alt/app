"""Per-night Aim (moves that night's target, inside min/max) and prices typed on the pricing page ("Set my own price")."""

import os
import sys
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_holiday import mkcfg, inv_of, D, go  # noqa: E402
from test_rules import TODAY  # noqa: E402
from test_move_old import http  # noqa: E402,F401

from calm_pricing import run, merged  # noqa: E402

NIGHT = 40


def d_of(res, k=NIGHT):
    return [x for x in res["decisions"] if x["date"] == D(k)][0]


def first(cfg, units=1, price=230, avail=None):
    inv, state = inv_of(units, price, avail=avail), {}
    return inv, state, go(cfg, inv, state, 0, apply=False)


def test_an_aim_moves_the_target_of_that_night_only():
    base = d_of(first(mkcfg(1, holiday=False))[2])["target"]
    for pct in (-10, -5, 5, 10):
        cfg = mkcfg(1, holiday=False)
        cfg["night_aims"] = [{"rt": "X", "date": D(NIGHT), "pct": pct, "avail": 1}]
        res = first(cfg)[2]
        d = d_of(res)
        assert abs(d["target"] - round(base * (1 + pct / 100), 2)) < 0.02, (pct, d["target"], base)
        assert d["aim"] == pct and any("aim" in w for w in d["why"])
        assert d_of(res, NIGHT + 1)["target"] == base and "aim" not in d_of(res, NIGHT + 1)      # the next night is not touched


def test_the_aim_never_goes_outside_min_and_max():
    cfg = mkcfg(1, mn=225, start=230, mx=235, holiday=False)
    cfg["night_aims"] = [{"rt": "X", "date": D(NIGHT), "pct": -10, "avail": 1}, {"rt": "X", "date": D(NIGHT + 1), "pct": 10, "avail": 1}]
    res = first(cfg)[2]
    assert d_of(res)["target"] >= 225 and d_of(res, NIGHT + 1)["target"] <= 235


def test_the_price_follows_the_aim_at_the_normal_daily_pace():
    cfg = mkcfg(1, holiday=False)
    cfg["night_aims"] = [{"rt": "X", "date": D(NIGHT), "pct": -10, "avail": 1}]
    inv, state = inv_of(1, 230), {}
    go(cfg, inv, state, 0)
    prices, target = [], None
    for day in range(1, 5):
        res = go(cfg, inv, state, day, 9)
        target = d_of(res)["target"]
        prices.append(inv[D(NIGHT)]["prices"]["GEL"])
    steps = [(a - b) / a for a, b in zip([230] + prices, prices)]
    assert all(0 <= x <= 0.05 for x in steps) and prices[-1] >= target - 5, (prices, target)      # a few % a day down toward -10%, never a jump


def test_an_aim_ends_when_the_night_gets_a_booking():
    cfg = mkcfg(3, holiday=False)
    cfg["night_aims"] = [{"rt": "X", "date": D(NIGHT), "pct": -10, "avail": 3}]
    inv, state, _ = first(cfg, units=3)
    inv[D(NIGHT)]["avail"] = 2
    d = d_of(go(cfg, inv, state, 1, 9, apply=False))
    assert "aim" not in d


def test_the_cancellation_drop_skips_a_night_with_an_aim():
    cfg = mkcfg(1, holiday=False)
    cfg["night_aims"] = [{"rt": "X", "date": D(0), "pct": 5, "avail": 1}]
    inv, state = inv_of(1, 230), {}
    go(cfg, inv, state, 0)
    inv[D(1)]["prices"]["GEL"] = 230                   # (the morning run already took tomorrow to the minimum: put the engine's own earlier price back)
    state["X"][D(1)]["GEL"]["last_engine"] = 230
    now = datetime.combine(TODAY, datetime.min.time()) + timedelta(hours=14)
    res = run({"now": now, "inventory": {"X": dict(inv)}, "reservations": [], "run_kind": "update", "only": {"rooms": ["X"], "dates": [D(0), D(1)]}, "tonight_drop": True}, cfg, state)
    tonight, tomorrow = d_of(res, 0), d_of(res, 1)
    assert tonight["kind"] != "tonight" and not tonight["write"] and "aim" in " ".join(tonight["why"]).lower()
    assert tomorrow["kind"] == "tonight"                                 # a night without an aim still gets the drop


def test_the_holiday_rule_limits_still_apply_with_an_aim():
    cfg = mkcfg(1, holiday=True)                                         # the holiday dates start 14 days after today
    cfg["night_aims"] = [{"rt": "X", "date": D(40), "pct": -10, "avail": 1}]
    inv, state = inv_of(1, 230), {}
    go(cfg, inv, state, 0)
    for day in (1, 2, 3):
        go(cfg, inv, state, day, 9)
    assert inv[D(40)]["prices"]["GEL"] >= 230 * (1 - 0.05) - 1, inv[D(40)]["prices"]["GEL"]     # far ahead: at most 5% below the anchor


def test_bad_aims_are_ignored_and_listed():
    cfg = merged({"night_aims": [{"rt": "X", "date": "2026-12-20", "pct": -5, "avail": 1}, {"rt": "X", "date": "nope", "pct": 5},
                                 {"rt": "X", "date": "2026-12-21", "pct": 0}, {"rt": "X", "date": "2026-12-22", "pct": 50}, "junk"]})
    assert [a["date"] for a in cfg["night_aims"]] == ["2026-12-20"]
    assert len([w for w in cfg["_settings_warnings"] if "night_aims" in w]) == 4


# ---------- prices typed on the page ----------

def run_own(cfg, inv, state, day, own, hour=9):
    now = datetime.combine(TODAY + timedelta(days=day), datetime.min.time()) + timedelta(hours=hour)
    shown = {ds: v for ds, v in inv.items() if ds >= (TODAY + timedelta(days=day)).isoformat()}
    res = run({"now": now, "inventory": {"X": shown}, "reservations": [], "own_prices": own}, cfg, state)
    for w in res["writes"]:
        inv[w["date"]]["prices"][w["currency"]] = w["price"]
    return res


def test_a_typed_price_is_written_once_and_then_stays_as_a_hand_set_price():
    cfg = mkcfg(1, mn=150, start=230, mx=300, holiday=False)
    inv, state = inv_of(1, 230), {}
    go(cfg, inv, state, 0)
    key = f"X|{D(NIGHT)}"
    res = run_own(cfg, inv, state, 1, {key: {"GEL": 100}})                # below the minimum: still written
    d = d_of(res)
    assert d["kind"] == "own" and d["write"] and d["proposed"] == 100 and key in res["own_done"]
    assert [w for w in res["writes"] if w["date"] == D(NIGHT)] == [{"rt": "X", "date": D(NIGHT), "currency": "GEL", "price": 100}]
    assert inv[D(NIGHT)]["prices"]["GEL"] == 100
    for day in (2, 3, 9):
        r = run_own(cfg, inv, state, day, {})                              # the page entry is gone; the engine leaves it alone
        assert d_of(r)["kind"] == "manual" and not d_of(r)["write"] and inv[D(NIGHT)]["prices"]["GEL"] == 100


def test_a_typed_price_equal_to_the_current_price_just_marks_the_night():
    cfg = mkcfg(1, holiday=False)
    inv, state = inv_of(1, 230), {}
    go(cfg, inv, state, 0)
    key = f"X|{D(NIGHT)}"
    res = run_own(cfg, inv, state, 1, {key: {"GEL": inv[D(NIGHT)]["prices"]["GEL"]}})
    assert key in res["own_done"] and d_of(res)["kind"] == "manual" and not d_of(res)["write"]


def test_a_typed_price_for_a_night_that_got_booked_is_dropped_and_a_protected_night_is_not_touched():
    cfg = mkcfg(1, holiday=False, rules=[{"from": D(41), "to": D(41), "rooms": ["X"], "action": "protect"}])
    inv, state = inv_of(1, 230), {}
    go(cfg, inv, state, 0)
    inv[D(NIGHT)]["avail"] = 0
    k1, k2 = f"X|{D(NIGHT)}", f"X|{D(41)}"
    res = run_own(cfg, inv, state, 1, {k1: {"GEL": 120}, k2: {"GEL": 120}})
    assert {k1, k2} <= set(res["own_done"]) and not [w for w in res["writes"] if w["date"] in (D(NIGHT), D(41))]


def test_a_typed_price_that_is_not_sane_is_ignored():
    cfg = mkcfg(1, holiday=False)
    inv, state = inv_of(1, 230), {}
    go(cfg, inv, state, 0)
    key = f"X|{D(NIGHT)}"
    res = run_own(cfg, inv, state, 1, {key: {"GEL": 99999}})
    assert key in res["own_done"] and not [w for w in res["writes"] if w["date"] == D(NIGHT)] and any("not usable" in w for w in res["warnings"])


def test_the_runner_writes_the_typed_price_and_takes_it_off_the_list(http):
    from test_move_old import minihotel, prices_near_start, NOW as RUN_NOW
    from test_shadow_script import FakeDB
    import pricing_calm_live as live
    night = (RUN_NOW.date() + timedelta(days=5)).isoformat()
    old_night = (RUN_NOW.date() - timedelta(days=2)).isoformat()
    db = FakeDB()
    db.collection("pricing_config").document("control").set({"paused": False, "setprice": [
        {"rt": "MAXELA", "date": night, "GEL": 111}, {"rt": "MAXELA", "date": old_night, "GEL": 90}, {"rt": "NOPE", "date": night, "GEL": 5}]})
    live.main([], db=db, get=minihotel(prices_near_start), cookie_fn=lambda: "c", now=RUN_NOW)
    sent = [b for m, u, b in http if m == "POST" and u.endswith("/api/ScreenA")]
    rates = [(d["Date"][:10], r["Price"]) for x in sent[0] if x["roomTypeCode"] == "MAXELA" for d in x["Dates"] for r in d["Rates"] if r["PriceList"] == "GEL"]
    assert (night, 111) in rates or (night, 111.0) in rates, rates
    left = db.store["pricing_config"]["control"]["setprice"]
    assert left == [{"rt": "NOPE", "date": night, "GEL": 5}]               # done and past ones are gone; an unknown room stays


def test_the_page_entry_can_be_read_back():
    from test_shadow_script import FakeDB
    import pricing_calm_live as live
    db = FakeDB()
    db.collection("pricing_config").document("control").set({"setprice": [{"rt": "A", "date": "2999-01-01", "GEL": 10, "USD": 4}, {"rt": "A", "date": "2000-01-01", "GEL": 1}, {"rt": "A"}]})
    assert live.read_own_prices(db, "2026-10-17") == {"A|2999-01-01": {"GEL": 10.0, "USD": 4.0}}
