"""Last 3 days of an empty night: rooms with 1-2 units are judged by their own empty units; only the nights a booking covers pause drops."""

import copy
import os
import sys
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_holiday import mkcfg, inv_of, D  # noqa: E402
from test_rules import TODAY  # noqa: E402

from calm_pricing import run  # noqa: E402
from calm_pricing.engine import _pickup_dates  # noqa: E402

MN, START, MX = 100, 200, 300


def day_run(cfg, inv, state, reservations=None, hour=9, extra=None):
    now = datetime.combine(TODAY, datetime.min.time()) + timedelta(hours=hour)
    return run({"now": now, "inventory": {"X": copy.deepcopy(inv)}, "reservations": reservations or [], **(extra or {})}, cfg, state)


def dec(res, k):
    return [x for x in res["decisions"] if x["date"] == D(k)][0]


def setup(units, style=None, **over):
    cfg = mkcfg(units, mn=MN, start=START, mx=MX, holiday=False, **over)
    if style:
        cfg["room_types"]["X"]["style"] = style
    inv = inv_of(units, START)
    return cfg, inv, {}


def stay(ci, co, created):
    return {"rt": "X", "checkin": D(ci), "checkout": D(co), "created": D(created)}


def test_only_the_nights_a_booking_covers_count_as_nearby():
    pick, _ = _pickup_dates([stay(1, 4, 0)], TODAY, 3, {"X": {}})
    assert pick["X"] == {D(1), D(2), D(3)}                        # not the day before check-in, not the check-out day


def test_the_check_out_day_of_a_recent_booking_no_longer_pauses_drops_in_a_pool_room():
    cfg, inv, state = setup(5)
    inv[D(2)]["avail"] = 3                                         # empty units on a night that is the check-out day of a booking made yesterday
    res = day_run(cfg, inv, state, [stay(-3, 2, -1)])
    d = dec(res, 2)
    assert d["kind"] == "move" and d["write"] and d["proposed"] < d["current"], d
    assert not any("nearby" in w for w in d["why"])


def test_a_booking_that_covers_the_night_still_pauses_drops_in_a_pool_room():
    cfg, inv, state = setup(5)
    inv[D(2)]["avail"] = 3
    res = day_run(cfg, inv, state, [stay(1, 3, -1)])
    d = dec(res, 2)
    assert d["kind"] == "hold" and any("nearby" in w for w in d["why"]), d


def test_a_small_room_ignores_the_booking_nearby_pause_in_the_last_3_days():
    cfg, inv, state = setup(2)
    inv[D(2)]["avail"] = 1                                         # one of two units sold by a booking made yesterday that covers the night
    res = day_run(cfg, inv, state, [stay(1, 3, -1)])
    d = dec(res, 2)
    assert d["kind"] == "move" and d["write"] and d["proposed"] < d["current"], d
    cfg5, inv5, st5 = setup(5)
    inv5[D(2)]["avail"] = 3
    assert dec(day_run(cfg5, inv5, st5, [stay(1, 3, -1)]), 2)["kind"] == "hold"        # a pool room keeps today's behaviour


def test_a_small_room_is_judged_by_its_own_empty_units_not_the_building():
    cfg, inv, state = setup(2)
    cfg["room_types"]["Y"] = {"units": 6, "group": "g", "currencies": ["GEL"], "status": "live"}
    cfg["rules"]["Y"] = cfg["rules"]["X"]
    inv_y = inv_of(6, START, avail=lambda i: 0)                    # the rest of the building is full
    inv[D(2)]["avail"] = 1
    now = datetime.combine(TODAY, datetime.min.time()) + timedelta(hours=9)
    res = run({"now": now, "inventory": {"X": copy.deepcopy(inv), "Y": inv_y}, "reservations": []}, cfg, state)
    d = [x for x in res["decisions"] if x["rt"] == "X" and x["date"] == D(2)][0]
    assert d["status"] in ("behind", "far_behind") and d["write"] and d["proposed"] < d["current"], d
    assert d["status"] == "behind" or d["status"] == "far_behind"


def test_no_dead_zone_in_the_last_3_days_of_a_small_room_but_a_pool_room_keeps_it():
    for units, moves in ((1, True), (5, False)):
        cfg, inv, state = setup(units)
        inv[D(3)]["prices"]["GEL"] = MN + 5                        # 5 over the minimum: inside the dead zone (10)
        if units == 5:
            inv[D(3)]["avail"] = 4
        d = dec(day_run(cfg, inv, state), 3)
        assert d["write"] is moves, (units, d)
        if moves:
            assert d["proposed"] == MN, d


def test_the_night_before_arrival_of_a_small_room_reaches_the_minimum_in_one_step_but_two_days_out_keeps_the_15_percent_cap():
    cfg, inv, state = setup(1)
    one = dec(day_run(cfg, inv, state), 1)
    assert one["proposed"] == MN and one["write"], one
    cfg, inv, state = setup(1)
    two = dec(day_run(cfg, inv, state), 2)
    assert two["write"] and two["proposed"] >= START * 0.85 - 1, two
    cfg, inv, state = setup(3)                                      # a 3-unit room keeps the cap, also the night before
    inv[D(1)]["avail"] = 2
    three = dec(day_run(cfg, inv, state), 1)
    assert three["proposed"] >= START * 0.85 - 1, three


def test_arrival_day_is_never_lowered_for_a_small_room():
    cfg, inv, state = setup(1)
    d = dec(day_run(cfg, inv, state), 0)
    assert not d["write"] and d["proposed"] == d["current"], d


def test_hold_calm_and_a_hand_set_price_still_win_for_a_small_room():
    for style in ("hold", "calm"):
        cfg, inv, state = setup(1, style)
        d = dec(day_run(cfg, inv, state), 1)
        if style == "hold":
            assert not d["write"] and d["proposed"] == d["current"], d          # Hold: nothing is lowered in the last 3 days
        else:
            assert d["proposed"] >= START * 0.85 - 1, d                         # Calm keeps its own gentle steps
    cfg, inv, state = setup(1)
    first = day_run(cfg, inv, state)                                # the engine writes its own price
    inv[D(1)]["prices"]["GEL"] = 187                                # then someone types a price by hand
    second = day_run(cfg, inv, first["state"], hour=13)
    third = day_run(cfg, inv, second["state"], hour=15)
    d = dec(third, 1)
    assert d["kind"] == "manual" and not d["write"], d


def test_protect_and_aim_still_win_for_a_small_room():
    cfg, inv, state = setup(1)
    cfg["date_rules"] = [{"rt": "X", "from": D(2), "to": D(2), "action": "protect"}]
    d = dec(day_run(cfg, inv, state), 2)
    assert d["kind"] == "protected" and not d["write"], d
    cfg, inv, state = setup(1)
    cfg["night_aims"] = [{"rt": "X", "date": D(1), "pct": 10, "avail": 1}]
    d = dec(day_run(cfg, inv, state), 1)
    assert d.get("aim") == 10 and d["proposed"] >= MN, d


def test_giving_a_hand_set_night_back_lets_the_small_room_rules_run():
    cfg, inv, state = setup(1)
    first = day_run(cfg, inv, state)
    inv[D(2)]["prices"]["GEL"] = 187                                # hand-set
    held = day_run(cfg, inv, first["state"], hour=13)
    assert dec(held, 2)["kind"] == "manual"
    back = day_run(cfg, inv, held["state"], hour=13, extra={"release_manual": [f"X|{D(2)}"]})
    assert dec(back, 2)["kind"] != "manual"
