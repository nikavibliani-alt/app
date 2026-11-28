"""Raise rules by room size: no raise on a mostly-free night; one unit cannot show demand; raises only in the morning run; holidays untouched."""

import copy
import os
import sys
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_holiday import mkcfg, inv_of, D  # noqa: E402
from test_rules import TODAY, flat_rules, cfg_for  # noqa: E402

from calm_pricing import run  # noqa: E402

MN, START, MX = 100, 200, 300


def one(cfg, inv, hour=9, extra=None, state=None):
    now = datetime.combine(TODAY, datetime.min.time()) + timedelta(hours=hour)
    return run({"now": now, "inventory": {"X": copy.deepcopy(inv)}, "reservations": [], **(extra or {})}, cfg, state if state is not None else {})


def dec(res, k):
    return [x for x in res["decisions"] if x["date"] == D(k) and x["currency"] == "GEL"][0]


def setup(units, price=150, avail=None, night=None, holiday=False):
    cfg = mkcfg(units, mn=MN, start=START, mx=MX, holiday=holiday)
    cfg["weekend"]["pct"] = 0.0
    inv = inv_of(units, price)
    if avail is not None:
        for k, a in avail.items():
            inv[D(k)]["avail"] = a
    return cfg, inv


def test_an_empty_one_unit_night_is_not_pulled_up_within_60_days_but_is_further_out():
    cfg, inv = setup(1, 150)
    res = one(cfg, inv)
    assert not dec(res, 20)["write"] and dec(res, 20)["proposed"] == 150 and any("cannot show demand" in b for b in dec(res, 20)["blocked"] + dec(res, 20)["why"]) or not dec(res, 20)["write"]
    assert not dec(res, 60)["write"]                                                   # 60 days: still inside
    assert dec(res, 61)["write"] and dec(res, 61)["proposed"] > 150                    # 61 days out: the season's start price pulls it up
    assert dec(res, 61)["proposed"] <= START


def test_the_far_weekend_bump_still_works_for_a_one_unit_room_but_not_within_60_days():
    cfg, inv = setup(1, START)
    cfg["weekend"]["pct"] = 0.08
    fri_far = next(k for k in range(61, 80) if (TODAY + timedelta(days=k)).weekday() == 4)
    fri_near = next(k for k in range(10, 30) if (TODAY + timedelta(days=k)).weekday() == 4)
    res = one(cfg, inv)
    assert dec(res, fri_far)["write"] and dec(res, fri_far)["proposed"] > START
    assert not dec(res, fri_near)["write"]


def test_an_event_can_lift_an_empty_one_unit_night_within_60_days_in_the_morning_run():
    cfg, inv = setup(1, START)
    cfg["events"] = {D(20): {"pct": 0.3, "label": "concert"}}
    res = one(cfg, inv)
    assert dec(res, 20)["write"] and dec(res, 20)["proposed"] > START
    later = one(cfg, inv, hour=13, extra={"run_kind": "update"})
    assert not dec(later, 20)["write"]                                              # raises only in the morning run


def test_raises_only_in_the_first_run_after_nine():
    cfg, inv = setup(1, 150)
    assert dec(one(cfg, inv, hour=9), 70)["write"]
    for hour, kind in ((4, "update"), (13, "update"), (16, "update"), (22, "update")):
        res = one(cfg, inv, hour=hour, extra={"run_kind": kind})
        assert not dec(res, 70)["write"] and any("morning run may raise" in b for b in dec(res, 70)["blocked"]), (hour, dec(res, 70))


def test_rooms_with_two_to_four_units_are_not_raised_while_at_least_half_are_free():
    for units, free, raised in ((2, 1, False), (3, 2, False), (3, 1, True), (4, 2, False), (4, 1, True)):
        cfg, inv = setup(units, 150, avail={60: free})
        res = one(cfg, inv)
        d = dec(res, 60)
        assert d["status"] in ("ahead", "far_ahead"), (units, free, d["status"])             # the demand rule WOULD raise it
        assert bool(d["write"] and d["proposed"] > 150) is raised, (units, free, d["proposed"], d["blocked"])


def test_rooms_with_five_or_more_units_are_not_raised_while_at_least_half_are_free():
    for units, free, raised in ((5, 3, False), (5, 2, True), (6, 3, False), (6, 2, True), (7, 4, False), (7, 3, True)):
        cfg, inv = setup(units, 150, avail={60: free})
        d = dec(one(cfg, inv), 60)
        assert bool(d["write"] and d["proposed"] > 150) is raised, (units, free, d["proposed"], d["status"])
        if not raised:
            assert any("no raise while at least half" in b for b in d["blocked"]), d["blocked"]


def test_corrections_below_the_minimum_own_prices_and_the_new_listing_rule_still_raise_in_any_run():
    cfg, inv = setup(3, 150, avail={})
    inv[D(30)]["prices"]["GEL"] = 80                                                         # below the minimum of 100
    res = one(cfg, inv, hour=13, extra={"run_kind": "update"})
    assert dec(res, 30)["kind"] == "correction" and dec(res, 30)["write"] and dec(res, 30)["proposed"] >= MN
    res = one(cfg, inv, hour=22, extra={"run_kind": "update", "own_prices": {f"X|{D(40)}": {"GEL": 250.0}}})
    assert dec(res, 40)["kind"] == "own" and dec(res, 40)["write"] and dec(res, 40)["proposed"] == 250
    cfg5, inv5 = setup(5, MN, avail={12: 1})
    cfg5["date_rules"] = [{"from": D(10), "to": D(14), "rooms": ["X"], "action": "aim_min"}]
    res = one(cfg5, inv5, hour=13, extra={"run_kind": "update"})
    assert dec(res, 12)["kind"] == "newlisting" and dec(res, 12)["write"] and dec(res, 12)["proposed"] > MN       # nearly sold out: may go up


def test_holiday_nights_keep_their_rules_exactly_as_they_were():
    cfg, inv = setup(3, 150, avail={40: 2, 8: 2}, holiday=True)                                # D(14)..D(54) are holiday dates in the test setup
    res = one(cfg, inv, hour=13, extra={"run_kind": "update"})
    hol = dec(res, 40)
    assert hol.get("holiday") and hol["status"] in ("ahead", "far_ahead") and hol["write"] and hol["proposed"] > 150, hol    # raised in a non-morning run with 2 of 3 free: as before
    cfg2, inv2 = setup(3, 150, avail={40: 2}, holiday=False)
    plain = dec(one(cfg2, inv2, hour=13, extra={"run_kind": "update"}), 40)
    assert not plain["write"]                                                                  # the same night without the holiday rule: no raise


def test_a_hold_date_rule_also_keeps_the_old_rules():
    cfg, inv = setup(3, 150, avail={40: 2})
    cfg["date_rules"] = [{"from": D(38), "to": D(42), "rooms": ["X"], "action": "hold"}]
    d = dec(one(cfg, inv, hour=13, extra={"run_kind": "update"}), 40)
    assert d.get("holiday") and d["write"] is not None and not any("no raise while at least half" in b or "morning run may raise" in b for b in d["blocked"])


def test_the_building_rule_no_longer_holds_up_or_pulls_up_an_empty_night_but_holiday_nights_keep_it():
    rts = {"S": {"units": 1, "group": "b", "currencies": ["GEL"], "status": "live"}, "P": {"units": 7, "group": "b", "currencies": ["GEL"], "status": "live"}}
    cfg = cfg_for(rts, {"S": flat_rules(), "P": flat_rules()})
    cfg["safety"]["max_share_changed"] = 1.0
    cfg["weekend"]["pct"] = 0.0
    from test_rules import inventory, snap
    res = run(snap(9, {"S": inventory(1, 200), "P": inventory(7, 255, avail_fn=lambda i: 0)}), cfg, {})
    s = [d for d in res["decisions"] if d["rt"] == "S" and 4 <= d["days_out"] <= 30]
    assert s and all(not any("rest of the building is selling as normal" in w for w in d["why"]) for d in s)
    assert all(not (d["write"] and d["proposed"] > d["current"]) for d in s)                 # nothing is raised
    cfg["date_overrides"] = [{"from": D(10)[5:], "to": D(20)[5:], "season": "high"}]
    cfg["holiday"]["enabled"] = True
    res = run(snap(9, {"S": inventory(1, 200), "P": inventory(7, 255, avail_fn=lambda i: 0)}), cfg, {})
    hol = [d for d in res["decisions"] if d["rt"] == "S" and d.get("holiday")]
    assert hol and any(any("rest of the building is selling as normal" in w for w in d["why"]) for d in hol)
