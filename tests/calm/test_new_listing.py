"""New listing: aim for minimum. On the chosen dates an empty night goes straight to the room's minimum; everything else is untouched."""

import copy
import os
import sys
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_holiday import mkcfg, inv_of, D  # noqa: E402
from test_rules import TODAY, flat_rules  # noqa: E402

import weekly_numbers as wn  # noqa: E402
from calm_pricing import run, merged  # noqa: E402

MN, START, MX = 100, 200, 300


def rule(a, b, rooms=("X",), action="aim_min"):
    return {"from": D(a), "to": D(b), "rooms": list(rooms), "action": action}


def setup(units=1, rules=None, usd=False):
    cfg = mkcfg(units, mn=MN, start=START, mx=MX, holiday=False)
    cfg["date_rules"] = rules or []
    if usd:
        cfg["room_types"]["X"]["currencies"] = ["GEL", "USD"]
        cfg["rules"]["X"]["USD"] = flat_rules("USD", mn=30, start=60, mx=90)["USD"]
    return cfg


def inv_both(units, gel, usd_price):
    inv = inv_of(units, gel)
    for v in inv.values():
        v["prices"]["USD"] = usd_price
    return inv


def day(cfg, inv, state=None, hour=9, extra=None, offset=0):
    now = datetime.combine(TODAY + timedelta(days=offset), datetime.min.time()) + timedelta(hours=hour)
    return run({"now": now, "inventory": {"X": copy.deepcopy(inv)}, "reservations": [], **(extra or {})}, cfg, state if state is not None else {})


def dec(res, k, cur="GEL"):
    return [x for x in res["decisions"] if x["date"] == D(k) and x["currency"] == cur][0]


def test_the_rule_is_a_valid_date_rule_and_a_bad_one_is_dropped():
    cfg = merged({"date_rules": [rule(3, 9), {"from": D(9), "to": D(3), "rooms": ["X"], "action": "aim_min"}, {"from": D(1), "to": D(2), "action": "nonsense"}]})
    assert len(cfg["date_rules"]) == 1 and cfg["date_rules"][0]["action"] == "aim_min"


def test_empty_nights_in_the_range_go_straight_to_the_minimum_in_both_price_lists_in_the_morning_run():
    cfg = setup(rules=[rule(3, 9)], usd=True)
    res = day(cfg, inv_both(1, 250, 70))
    for k in (3, 6, 9):
        g, u = dec(res, k), dec(res, k, "USD")
        assert g["kind"] == "newlisting" and g["write"] and g["proposed"] == MN, g           # 250 -> 100 in one step, no daily limit
        assert u["kind"] == "newlisting" and u["write"] and u["proposed"] == 30, u
        assert g["newlisting"] and any("New listing" in w for w in g["why"])
    assert not dec(res, 2)["kind"] == "newlisting" and not dec(res, 10)["kind"] == "newlisting"   # outside the dates: normal pricing


def test_outside_the_dates_pricing_is_exactly_what_it_was():
    plain, boosted = setup(), setup(rules=[rule(3, 9)])
    a, b = day(plain, inv_of(1, 250)), day(boosted, inv_of(1, 250))
    key = lambda r: {(d["date"], d["currency"]): (d["proposed"], d["kind"], d["write"]) for d in r["decisions"] if not (3 <= (datetime.fromisoformat(d["date"]).date() - TODAY).days <= 9)}  # noqa: E731
    assert key(a) == key(b)


def test_only_the_morning_run_lowers_and_there_is_no_weekend_bump():
    cfg = setup(rules=[rule(3, 9)])
    inv = inv_of(1, 250)
    later = day(cfg, inv, hour=13, extra={"run_kind": "update"})
    assert not dec(later, 5)["write"] and any("morning" in b for b in dec(later, 5)["blocked"])
    res = day(cfg, inv)
    for k in range(3, 10):
        assert dec(res, k)["proposed"] == MN                                                  # also on a Friday or Saturday night


def test_a_price_already_at_the_minimum_is_left_and_never_raised_for_one_unit_rooms():
    cfg = setup(rules=[rule(3, 9)])
    res = day(cfg, inv_of(1, MN))
    assert not dec(res, 5)["write"] and dec(res, 5)["proposed"] == MN
    cfg2 = setup(rules=[rule(3, 9)])
    res2 = day(cfg2, inv_of(1, MN), offset=0, hour=9)
    assert all(not dec(res2, k)["write"] for k in range(3, 10))


def test_a_room_with_several_units_may_go_up_only_when_the_night_is_nearly_sold_out():
    cfg = setup(units=5, rules=[rule(3, 9)])
    inv = inv_of(5, MN)
    inv[D(5)]["avail"] = 1                                        # one of five left: nearly sold out
    res = day(cfg, inv)
    assert dec(res, 5)["write"] and dec(res, 5)["proposed"] > MN and dec(res, 5)["proposed"] <= MX
    assert not dec(res, 6)["write"]                                # a quiet night: no raise
    inv2 = inv_of(5, 250)
    res2 = day(cfg, inv2)
    assert dec(res2, 6)["proposed"] == MN and dec(res2, 6)["write"]


def test_hand_set_dont_change_holiday_events_and_a_nights_own_aim_all_win():
    base = lambda **kw: dec(day(setup(rules=[rule(3, 9)] + kw.get("extra_rules", []), **{}) if not kw.get("cfg") else kw["cfg"], kw.get("inv") or inv_of(1, 250)), 5)  # noqa: E731
    # Don't change (protect) wins even if it was added after the new-listing rule
    d = base(extra_rules=[rule(4, 6, action="protect")])
    assert d["kind"] == "protected" and not d["write"]
    # a small-moves-only (holiday-style) date rule wins
    d = base(extra_rules=[rule(4, 6, action="hold")])
    assert d["kind"] != "newlisting"
    # a night's own Aim wins
    cfg = setup(rules=[rule(3, 9)])
    cfg["night_aims"] = [{"rt": "X", "date": D(5), "pct": 5, "avail": 1}]
    assert dec(day(cfg, inv_of(1, 250)), 5)["kind"] != "newlisting"
    # an event wins
    cfg = setup(rules=[rule(3, 9)])
    cfg["events"] = {D(5): {"pct": 0.1, "label": "concert"}}
    assert dec(day(cfg, inv_of(1, 250)), 5)["kind"] != "newlisting"
    # a holiday date wins
    cfg = setup(rules=[rule(3, 9)])
    cfg["holiday"]["enabled"] = True
    cfg["date_overrides"] = [{"from": D(5)[5:], "to": D(5)[5:], "season": "high"}]
    assert dec(day(cfg, inv_of(1, 250)), 5)["kind"] != "newlisting"


def test_a_hand_set_night_in_the_range_is_left_alone_and_a_booked_night_is_not_touched():
    cfg = setup(rules=[rule(3, 9)])
    inv = inv_of(1, 250)
    first = day(cfg, inv, hour=4, extra={"run_kind": "update"})                      # the engine learns its own price on night 5 ...
    inv[D(5)]["prices"]["GEL"] = 187                                                  # ... then you type another one in MiniHotel
    inv[D(7)]["avail"] = 0
    res = day(cfg, inv, state=first["state"])
    assert dec(res, 5)["kind"] == "manual" and not dec(res, 5)["write"]
    assert not dec(res, 7)["write"] and dec(res, 7)["kind"] != "newlisting"
    assert dec(res, 6)["kind"] == "newlisting"


def test_the_rule_ends_by_itself_after_the_to_date_and_arrival_day_is_not_part_of_it():
    cfg = setup(rules=[rule(0, 1)])
    res = day(cfg, inv_of(1, 250), offset=0)
    assert dec(res, 1)["kind"] == "newlisting" and dec(res, 0)["kind"] != "newlisting"           # arrival day keeps its own rules
    later = day(cfg, inv_of(1, 250), offset=2)                                                    # two days later the rule is over
    assert all(x["kind"] != "newlisting" for x in later["decisions"])


def test_the_watchdog_accepts_the_big_drop_of_a_new_listing_night():
    from calm_pricing.watchdog import check
    rec = {"new": 100, "virtual_before": 250, "min": 100, "max": 300, "kind": "newlisting", "avail": 1, "do": 20}
    assert check({"X": {D(20) + "|GEL": rec}}, {}, {"ok": True, "failed_portals": [], "stopped_room_types": []}, merged({}), datetime(2026, 10, 7, 9, 30), live_rts=("X",))["status"] == "green"


def test_the_weekly_numbers_count_bookings_on_the_boosted_dates_against_the_three_weeks_before():
    stays = [{"rt": "X", "checkin": "2026-11-12", "checkout": "2026-11-14", "created": "2026-11-02", "per_night": 100.0, "currency": "GEL"},           # before the rule
             {"rt": "X", "checkin": "2026-11-26", "checkout": "2026-11-29", "created": "2026-11-23", "per_night": 80.0, "currency": "GEL"},          # on boosted dates
             {"rt": "X", "checkin": "2026-12-20", "checkout": "2026-12-22", "created": "2026-11-24", "per_night": 80.0, "currency": "GEL"},          # booked after the start but not on boosted dates
             {"rt": "Y", "checkin": "2026-11-26", "checkout": "2026-11-27", "created": "2026-11-23", "per_night": 80.0, "currency": "GEL"}]
    d = {"price_events": [], "booking_events": [], "runs": [], "watchdog_days": {}, "stays": stays, "limits": None, "room_ids": ["X", "Y"], "since": "2026-10-09",
         "new_listing_rules": [{"action": "aim_min", "from": "2026-11-25", "to": "2026-12-05", "rooms": ["X"], "since": "2026-11-22"}]}
    n = wn.build(d, "2026-11-23", "2026-11-29")["all"]["new_listing"]
    assert len(n) == 1 and n[0]["room"] == "X" and n[0]["started"] == "2026-11-22" and n[0]["days_run"] == 8
    assert n[0]["this_week_on_boosted_dates"]["bookings"] == 1 and n[0]["this_week_on_boosted_dates"]["nights"] == 3
    assert n[0]["since_start_on_boosted_dates"]["bookings"] == 1
    assert n[0]["before_3_weeks"]["bookings"] == 1 and n[0]["before_3_weeks"]["bookings_per_week"] == 0.3
    assert "new_listing" in wn.GUIDE
    d["new_listing_rules"][0]["since"] = "2026-12-20"
    assert wn.build(d, "2026-11-23", "2026-11-29")["all"]["new_listing"] == []
