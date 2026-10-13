"""A price you set by hand is never changed by the engine, not even to fix min/max. It stays until the night is booked or you give it back."""

import os
import sys
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_holiday import mkcfg, inv_of, D, go, room  # noqa: E402
from test_rules import TODAY  # noqa: E402
from test_move_old import http  # noqa: E402,F401  (the fake MiniHotel requests fixture)

from calm_pricing import run  # noqa: E402
from calm_pricing.watchdog import check  # noqa: E402

NIGHT = 10


def start(price_by_hand, units=1, holiday=False, **kw):
    """The engine prices every night, then you set NIGHT by hand in MiniHotel. Returns cfg, inventory, state."""
    cfg = mkcfg(units, mn=150, start=230, mx=300, holiday=holiday, **kw)
    inv, state = inv_of(units, 230), {}
    go(cfg, inv, state, 0)
    go(cfg, inv, state, 0)
    inv[D(NIGHT)]["prices"]["GEL"] = price_by_hand
    return cfg, inv, state


def d_of(res, k=NIGHT):
    return [x for x in res["decisions"] if x["date"] == D(k)][0]


def test_a_hand_price_below_the_minimum_stays_for_days_with_no_write():
    cfg, inv, state = start(100)                                       # below the minimum 150
    for day, hour in ((1, 9), (1, 18), (2, 9), (5, 9), (9, 9)):
        res = go(cfg, inv, state, day, hour)
        d = d_of(res)
        assert d["kind"] == "manual" and not d["write"] and d["proposed"] == 100, (day, d["why"])
        assert "Set by you" in d["why"][-1]
        assert not [w for w in res["writes"] if w["date"] == D(NIGHT)]
        assert inv[D(NIGHT)]["prices"]["GEL"] == 100


def test_a_hand_price_above_the_maximum_stays_too():
    cfg, inv, state = start(500)
    res = go(cfg, inv, state, 3, 9)
    assert d_of(res)["kind"] == "manual" and inv[D(NIGHT)]["prices"]["GEL"] == 500


def test_it_is_released_when_the_night_is_booked_and_then_min_max_apply_again():
    cfg, inv, state = start(100)
    go(cfg, inv, state, 2, 9)
    inv[D(NIGHT)]["avail"] = 0                                         # booked
    res = go(cfg, inv, state, 3, 9)
    assert "released" in " ".join(d_of(res)["why"]) or "Fully booked" in " ".join(d_of(res)["why"])
    cfg2, inv2, state2 = start(100, units=3)
    go(cfg2, inv2, state2, 2, 9)
    inv2[D(NIGHT)]["avail"] = 2                                        # one of three units booked
    res2 = go(cfg2, inv2, state2, 3, 9)
    d = d_of(res2)
    assert "released after a booking" in " ".join(d["why"]) and d["kind"] != "manual"
    assert d["kind"] == "correction" and d["proposed"] == 150          # now the minimum applies


def test_giving_the_night_back_in_the_page_hands_it_to_the_engine():
    cfg, inv, state = start(100)
    go(cfg, inv, state, 2, 9)
    now = datetime.combine(TODAY + timedelta(days=3), datetime.min.time()) + timedelta(hours=9)
    shown = {ds: v for ds, v in inv.items() if ds >= (TODAY + timedelta(days=3)).isoformat()}
    res = run({"now": now, "inventory": {"X": shown}, "reservations": [], "release_manual": [f"X|{D(NIGHT)}"]}, cfg, state)
    d = d_of(res)
    assert "gave this night back" in " ".join(d["why"]) and d["kind"] == "correction" and d["proposed"] == 150
    for w in res["writes"]:
        shown[w["date"]]["prices"][w["currency"]] = w["price"]            # MiniHotel now shows what the engine wrote
    res2 = run({"now": now + timedelta(hours=3), "inventory": {"X": shown}, "reservations": []}, cfg, res["state"])
    assert d_of(res2)["kind"] != "manual"                              # not flagged again


def test_setting_it_again_keeps_it_yours():
    cfg, inv, state = start(100)
    go(cfg, inv, state, 1, 9)
    inv[D(NIGHT)]["prices"]["GEL"] = 90
    res = go(cfg, inv, state, 2, 9)
    assert d_of(res)["kind"] == "manual" and inv[D(NIGHT)]["prices"]["GEL"] == 90


def test_other_nights_still_follow_the_rules():
    cfg, inv, state = start(100)
    inv[D(NIGHT + 1)]["prices"]["GEL"] = 400                           # another night is above the maximum
    inv[D(NIGHT + 1)]["prices"]["GEL"] = 400
    go(cfg, inv, state, 1, 9)
    res = go(cfg, inv, state, 2, 9)
    assert d_of(res, NIGHT)["kind"] == "manual"


def test_cancellation_drops_and_the_holiday_rule_skip_a_hand_set_night():
    cfg, inv, state = start(100)
    cfg["date_overrides"] = [{"from": "01-01", "to": "12-31", "season": "high"}]    # every night is a holiday date
    res = go(cfg, inv, state, 3, 9)
    assert d_of(res)["kind"] == "manual" and not [w for w in res["writes"] if w["date"] == D(NIGHT)]
    cfg2 = mkcfg(1, mn=150, start=230, mx=300, holiday=False)
    inv2, st2 = inv_of(1, 230), {}
    go(cfg2, inv2, st2, 0); go(cfg2, inv2, st2, 0)
    inv2[D(0)]["prices"]["GEL"] = 100                                   # tonight, by hand, below the minimum
    inv2[D(1)]["prices"]["GEL"] = 100                                   # tomorrow too
    now = datetime.combine(TODAY, datetime.min.time()) + timedelta(hours=15)
    r = run({"now": now, "inventory": {"X": inv2}, "reservations": [], "run_kind": "update", "only": {"rooms": ["X"], "dates": [D(0), D(1)]}, "tonight_drop": True}, cfg2, st2)
    assert r["writes"] == [] and all(x["kind"] == "manual" for x in r["decisions"])


def test_the_watchdog_does_not_call_a_hand_set_price_below_the_minimum_a_problem():
    rec = {"new": 100, "virtual_before": 100, "kind": "manual", "min": 150, "max": 300, "avail": 1}
    ok = check({"X": {"2026-10-20|GEL": rec}}, {}, {"ok": True, "failed_portals": [], "stopped_room_types": []}, {}, datetime(2026, 10, 13, 12, 0), live_rts=["X"])
    assert ok["status"] == "green", ok["issues"]
    bad = check({"X": {"2026-10-20|GEL": {**rec, "kind": "move"}}}, {}, {"ok": True}, {}, datetime(2026, 10, 13, 12, 0), live_rts=["X"])
    assert bad["counts"].get("out_of_range") == 1


def test_a_price_the_engine_wrote_itself_is_never_taken_for_a_hand_price():
    cfg = mkcfg(1, holiday=False)
    inv, state = inv_of(1, 230), {}
    for day in (0, 0, 1, 2):
        res = go(cfg, inv, state, day, 9)
        assert not [x for x in res["decisions"] if x["kind"] == "manual"]


def test_the_runner_hands_given_back_nights_to_the_engine_and_clears_the_list(http):
    import json
    from test_move_old import minihotel, prices_near_start, NOW as RUN_NOW
    from test_shadow_script import FakeDB
    import pricing_calm_live as live
    night = (RUN_NOW.date() + timedelta(days=5)).isoformat()
    db = FakeDB()
    db.collection("pricing_config").document("control").set({"paused": False, "release": [f"MAXELA|{night}", f"MAXELA|{night}", "NOPE|2026-01-01"]})
    live.main([], db=db, get=minihotel(prices_near_start), cookie_fn=lambda: "c", now=RUN_NOW)
    left = db.store["pricing_config"]["control"]["release"]
    assert f"MAXELA|{night}" not in left and left == ["NOPE|2026-01-01"]                  # handled ones are gone, an unknown room stays
    assert live.read_release(FakeDB()) == set()
