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


# ---------------- arrival day of a small room: halfway after 12:00, the minimum after 17:00 ----------------

def arrival_run(cfg, inv, state, hour, extra=None, units_rt="X"):
    return day_run(cfg, inv, state, hour=hour, extra=extra)


def test_arrival_day_two_steps_half_after_noon_then_minimum_after_five():
    cfg, inv, state = setup(1)
    inv[D(0)]["prices"]["GEL"] = 180
    for hour in (4, 9, 11):
        r = arrival_run(cfg, inv, state, hour)
        assert dec(r, 0)["kind"] != "arrival" and not dec(r, 0)["write"], hour           # nothing before 12:00
        state = r["state"]
    r = arrival_run(cfg, inv, state, 13)
    d = dec(r, 0)
    assert d["kind"] == "arrival" and d["write"] and d["proposed"] == 140, d             # halfway between 180 and 100
    assert [w for w in r["writes"] if w["date"] == D(0)] == [{"rt": "X", "date": D(0), "currency": "GEL", "price": 140}]
    inv[D(0)]["prices"]["GEL"] = 140
    state = r["state"]
    r = arrival_run(cfg, inv, state, 16)
    assert not dec(r, 0)["write"], "the 13:00 step is used up; nothing else before 17:00"
    state = r["state"]
    r = arrival_run(cfg, inv, state, 18)
    d = dec(r, 0)
    assert d["kind"] == "arrival" and d["proposed"] == MN, d
    inv[D(0)]["prices"]["GEL"] = MN
    r2 = arrival_run(cfg, inv, r["state"], 22)
    assert not dec(r2, 0)["write"]


def test_arrival_day_first_run_after_five_goes_straight_to_the_minimum():
    cfg, inv, state = setup(1)
    inv[D(0)]["prices"]["GEL"] = 180
    d = dec(arrival_run(cfg, inv, state, 18), 0)
    assert d["kind"] == "arrival" and d["proposed"] == MN, d


def test_arrival_day_adds_only_its_own_night_to_the_prices_to_push():
    def writes_at(price0):
        cfg, inv, state = setup(1)
        inv[D(0)]["prices"]["GEL"] = price0
        first = arrival_run(cfg, inv, state, 9)
        for w in first["writes"]:
            inv[w["date"]]["prices"][w["currency"]] = w["price"]
        inv[D(0)]["prices"]["GEL"] = price0
        return arrival_run(cfg, inv, first["state"], 13)["writes"]
    with_arrival, without = writes_at(180), writes_at(MN)               # at the minimum nothing is left to lower on the arrival day
    extra = [w for w in with_arrival if w not in without]
    assert extra == [{"rt": "X", "date": D(0), "currency": "GEL", "price": 140.0}], extra
    assert [w for w in without if w not in with_arrival] == []


def test_arrival_day_is_not_lowered_for_big_rooms_or_other_styles_or_booked_nights():
    for units, style, avail in ((3, None, 1), (5, None, 2), (1, "hold", None), (1, "calm", None), (1, "active", None), (1, None, 0)):
        cfg, inv, state = setup(units, style)
        inv[D(0)]["prices"]["GEL"] = 180
        if avail is not None:
            inv[D(0)]["avail"] = avail
        d = dec(arrival_run(cfg, inv, state, 18), 0)
        assert d["kind"] != "arrival" and not d["write"], (units, style, avail, d)


def test_arrival_day_leaves_protect_hand_set_holiday_aim_and_push_nights_alone():
    # protect
    cfg, inv, state = setup(1)
    inv[D(0)]["prices"]["GEL"] = 180
    cfg["date_rules"] = [{"rt": "X", "from": D(0), "to": D(0), "action": "protect"}]
    assert not dec(arrival_run(cfg, inv, state, 18), 0)["write"]
    # Aim and "how hard to push" set for that night
    for key, val in (("night_aims", {"rt": "X", "date": D(0), "pct": -5, "avail": 1}), ("night_push", {"rt": "X", "date": D(0), "style": "normal", "avail": 1})):
        cfg, inv, state = setup(1)
        inv[D(0)]["prices"]["GEL"] = 180
        cfg[key] = [val]
        d = dec(arrival_run(cfg, inv, state, 18), 0)
        assert d["kind"] != "arrival" and not d["write"], (key, d)
    # holiday date
    cfg = mkcfg(1, mn=MN, start=START, mx=MX, holiday=True)
    inv = inv_of(1, START)
    cfg["date_overrides"] = [{"from": (TODAY - timedelta(days=1)).strftime("%m-%d"), "to": (TODAY + timedelta(days=1)).strftime("%m-%d"), "season": "high"}]
    inv[D(0)]["prices"]["GEL"] = 180
    held = dec(arrival_run(cfg, inv, {}, 18), 0)
    assert held["kind"] != "arrival" and not held["write"], held
    cfg.pop("date_overrides")                            # the same night without the holiday rule is lowered
    assert dec(arrival_run(cfg, inv, {}, 18), 0)["kind"] == "arrival"
    # hand-set: the engine wrote 200, someone typed 180
    cfg, inv, state = setup(1)
    first = arrival_run(cfg, inv, state, 9)
    inv[D(0)]["prices"]["GEL"] = 180
    d = dec(arrival_run(cfg, inv, first["state"], 18), 0)
    assert d["kind"] == "manual" and not d["write"], d


def test_arrival_day_is_never_raised():
    cfg, inv, state = setup(1)
    inv[D(0)]["prices"]["GEL"] = MN                     # already at the minimum
    for hour in (9, 13, 18):
        r = arrival_run(cfg, inv, state, hour)
        assert not dec(r, 0)["write"], (hour, dec(r, 0))
        state = r["state"]
    cfg, inv, state = setup(1)
    inv[D(0)]["prices"]["GEL"] = 120
    d = dec(arrival_run(cfg, inv, state, 18), 0)
    assert d["proposed"] <= 120, d


def test_a_cancellation_drop_still_works_on_arrival_day():
    cfg, inv, state = setup(1)
    inv[D(0)]["prices"]["GEL"] = 180
    now = datetime.combine(TODAY, datetime.min.time()) + timedelta(hours=10)
    res = run({"now": now, "inventory": {"X": copy.deepcopy(inv)}, "reservations": [], "run_kind": "update",
               "only": {"rooms": ["X"], "dates": [D(0), D(1)]}, "tonight_drop": True}, cfg, state)
    assert dec(res, 0)["kind"] == "tonight" and dec(res, 0)["proposed"] == MN


def test_the_arrival_step_does_not_disturb_the_other_nights_of_the_room():
    """The arrival block must not change any variable the next nights rely on (the room's occupancy goal once did)."""
    import re
    cfg, inv, state = setup(1)
    inv[D(0)]["prices"]["GEL"] = 180
    r = arrival_run(cfg, inv, state, 18)
    assert dec(r, 0)["kind"] == "arrival"
    for k in (5, 10, 18, 30):
        text = " ".join(dec(r, k)["why"])
        m = re.search(r"normal at \d+ days is (\d+)%", text)
        assert m and int(m.group(1)) <= 100, (k, text)
    cfg2, inv2, state2 = setup(1)
    inv2[D(0)]["prices"]["GEL"] = MN                         # nothing to lower on night 0: the arrival block does not fire
    r2 = arrival_run(cfg2, inv2, state2, 18)
    for k in (5, 10, 18, 30):
        a, b = dec(r, k), dec(r2, k)
        assert (a["proposed"], a["status"], a["target"], a["kind"]) == (b["proposed"], b["status"], b["target"], b["kind"]), (k, a, b)
