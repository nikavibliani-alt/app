"""
Holiday rule: on holiday dates (every range in date_overrides) and on dates under a "hold" date rule, the
price moves only a little around its anchor (the price when the date first entered the rule), until 14 days
before arrival. Single-unit rooms: up and down limits. Rooms with 2+ units: down limits only. No far reset.
"""

import os
import sys
from datetime import datetime, date, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_rules import cfg_for, flat_rules, TODAY, decision  # noqa: E402

from calm_pricing import run, merged  # noqa: E402
from calm_pricing.config import is_holiday, holiday_ranges  # noqa: E402

HOL = [{"from": "10-21", "to": "11-30", "season": "high"}]        # 14 .. 54 days after TODAY (7 Oct)


def D(n):
    return (TODAY + timedelta(days=n)).isoformat()


def room(units, rt="X"):
    return {rt: {"units": units, "group": "g", "currencies": ["GEL"], "status": "live"}}


def mkcfg(units, mn=150, start=230, mx=300, holiday=True, rules=None, **over):
    cfg = cfg_for(room(units), {"X": flat_rules(mn=mn, start=start, mx=mx)}, **over)
    cfg["safety"]["max_share_changed"] = 1.0
    if holiday:
        cfg["date_overrides"] = HOL
    cfg["date_rules"] = rules or []
    return cfg


def inv_of(units, price, days=100, avail=None):
    out = {}
    for i in range(days):
        out[D(i)] = {"avail": units if avail is None else avail(i), "prices": {"GEL": price(i) if callable(price) else price}}
    return out


def go(cfg, inv, state, day, hour=9, apply=True):
    """One run on day offset `day`; the written prices go into the fake MiniHotel."""
    now = datetime.combine(TODAY + timedelta(days=day), datetime.min.time()) + timedelta(hours=hour)
    # MiniHotel keeps showing dates from today on
    shown = {ds: v for ds, v in inv.items() if ds >= (TODAY + timedelta(days=day)).isoformat()}
    res = run({"now": now, "inventory": {"X": shown}, "reservations": []}, cfg, state)
    if apply:
        for w in res["writes"]:
            inv[w["date"]]["prices"][w["currency"]] = w["price"]
    return res


def test_holiday_helpers_accept_a_list_or_an_old_style_map():
    cfg = {"date_overrides": HOL}
    assert holiday_ranges(cfg) == [("10-21", "11-30")] and is_holiday("2026-11-02", cfg) and not is_holiday("2026-12-02", cfg)
    assert is_holiday("2026-11-02", {"date_overrides": {"a": HOL[0]}}) and not is_holiday("2026-11-02", {"date_overrides": {}})
    wrap = {"date_overrides": [{"from": "12-28", "to": "01-06", "season": "new_year"}]}
    assert is_holiday("2026-12-30", wrap) and is_holiday("2027-01-03", wrap) and not is_holiday("2027-01-20", wrap)


def test_anchor_is_stored_once_and_forgotten_when_the_date_leaves_the_rule():
    cfg = mkcfg(1)
    inv = inv_of(1, 200)
    state = {}
    go(cfg, inv, state, 0, apply=False)
    st = state["X"][D(40)]["GEL"]
    assert st["holiday_anchor"] == 200 and st["holiday_anchor_by"] == "holiday"
    inv[D(40)]["prices"]["GEL"] = 215                                  # a hand edit later does not move the anchor
    go(cfg, inv, state, 1, apply=False)
    assert state["X"][D(40)]["GEL"]["holiday_anchor"] == 200
    assert "holiday_anchor" not in state["X"].get(D(80), {}).get("GEL", {})          # not a holiday date
    cfg["date_overrides"] = []                                          # the range is removed on the page
    go(cfg, inv, state, 2, apply=False)
    assert "holiday_anchor" not in state["X"][D(40)]["GEL"]


def test_single_unit_going_up_is_limited_around_the_anchor_by_distance():
    cfg = mkcfg(1)
    inv = inv_of(1, 200)                       # well under the start price 230: the engine wants to go up
    state = {}
    anchors = {}
    for day in range(0, 26):
        res = go(cfg, inv, state, day, hour=13)            # afternoon runs may raise
        for ds in (D(32), D(26), D(20)):
            if ds in inv:
                st = state["X"].get(ds, {}).get("GEL", {})
                anchors.setdefault(ds, st.get("holiday_anchor"))
                out = (date.fromisoformat(ds) - (TODAY + timedelta(days=day))).days
                lim = 0.03 if out > 30 else 0.05 if out > 20 else 0.08 if out > 14 else None
                if lim is not None and anchors[ds]:
                    assert inv[ds]["prices"]["GEL"] <= anchors[ds] * (1 + lim) + 1e-6, (ds, day, out, inv[ds]["prices"]["GEL"])
    # it did move (the limit is not "no moves at all")
    assert inv[D(32)]["prices"]["GEL"] > 200 or inv[D(26)]["prices"]["GEL"] > 200 or inv[D(20)]["prices"]["GEL"] > 200


def test_single_unit_going_down_is_limited_below_the_anchor():
    cfg = mkcfg(1, mn=150, start=230, mx=300)
    inv = inv_of(1, 280)                        # far above the target: the engine wants to go down
    state = {}
    for day in range(0, 26):
        go(cfg, inv, state, day, hour=9)
        for ds in (D(40), D(33)):
            if ds in inv and state["X"].get(ds, {}).get("GEL", {}).get("holiday_anchor"):
                out = (date.fromisoformat(ds) - (TODAY + timedelta(days=day))).days
                lim = 0.03 if out > 30 else 0.05 if out > 20 else 0.08 if out > 14 else None
                if lim is not None:
                    assert inv[ds]["prices"]["GEL"] >= 280 * (1 - lim) - 1e-6, (ds, day, out, inv[ds]["prices"]["GEL"])
    assert inv[D(40)]["prices"]["GEL"] < 280        # it still moved down a little


def test_several_rooms_have_no_upper_limit_and_a_wider_lower_limit():
    cfg = mkcfg(5, mn=150, start=230, mx=300)
    cfg2 = mkcfg(5, mn=150, start=230, mx=300, holiday=False)
    # selling fast far ahead (4 of 5 booked): the normal rules raise; the holiday rule must not add a limit
    inv = inv_of(5, 200, avail=lambda i: 1)
    inv2 = inv_of(5, 200, avail=lambda i: 1)
    s1, s2 = {}, {}
    for day in range(0, 6):
        go(cfg, inv, s1, day, hour=13)
        go(cfg2, inv2, s2, day, hour=13)
    for i in (36, 40, 44):
        assert inv[D(i)]["prices"]["GEL"] == inv2[D(i)]["prices"]["GEL"], i      # same as without the holiday rule
        assert inv[D(i)]["prices"]["GEL"] > 200 * 1.03                          # clearly above +3%
    # going down: never more than 5% below the anchor while far away
    invd = inv_of(5, 290, avail=lambda i: 5)
    sd = {}
    for day in range(0, 8):
        go(cfg, invd, sd, day, hour=9)
        assert invd[D(40)]["prices"]["GEL"] >= 290 * 0.95 - 1e-6, day


def test_up_to_14_days_before_arrival_the_normal_rules_apply():
    cfg = mkcfg(1)
    cfg2 = mkcfg(1, holiday=False)
    inv, inv2 = inv_of(1, 200), inv_of(1, 200)
    s1, s2 = {}, {}
    for day in range(0, 8):                    # D(21) is 21 days out now, 14 days out on day 7
        r1, r2 = go(cfg, inv, s1, day, hour=13), go(cfg2, inv2, s2, day, hour=13)
    d1, d2 = decision(r1, "X", D(21)), decision(r2, "X", D(21))
    assert d1["days_out"] == 14 and d1["holiday"]["window"] is None
    assert d1["proposed"] == d2["proposed"]                 # identical to a date without the rule
    assert "the normal rules apply again" in " ".join(d1["why"])


def test_no_far_reset_on_holiday_dates():
    cfg = mkcfg(1, mn=150, start=230, mx=300)
    cfg["date_overrides"] = [{"from": "12-10", "to": "12-20", "season": "high"}]          # 64..74 days out
    inv = inv_of(1, 290)
    res = go(cfg, inv, {}, 0, hour=13)
    assert not [d for d in res["decisions"] if d["kind"] == "far_reset" and "2026-12-10" <= d["date"] <= "2026-12-20"]
    assert [d for d in res["decisions"] if d["kind"] == "far_reset" and d["date"] == "2026-12-25"]       # an ordinary far date still does
    h = decision(res, "X", "2026-12-12")
    assert h["kind"] != "far_reset" and h["holiday"]["anchor"] == 290
    assert 290 * 0.97 - 1e-6 <= h["proposed"] <= 290                  # at most 3% below the anchor, not the plain target


def test_min_and_max_always_win_over_the_anchor():
    cfg = mkcfg(1, mn=150, start=230, mx=300)
    inv = inv_of(1, 320)                       # over the maximum on a holiday date
    res = go(cfg, inv, {}, 0, hour=13)
    d = decision(res, "X", D(40))
    assert d["kind"] == "correction" and d["proposed"] == 300


def test_hold_date_rule_gives_any_dates_and_rooms_the_same_steps():
    rules = [{"from": D(60), "to": D(62), "rooms": ["X"], "action": "hold"}]
    cfg = mkcfg(1, holiday=False, rules=rules)
    inv = inv_of(1, 200)
    state = {}
    res = go(cfg, inv, state, 0, hour=13)
    d = decision(res, "X", D(61))
    assert d["holiday"]["kind"] == "hold" and d["holiday"]["window"] == "far"
    assert state["X"][D(61)]["GEL"]["holiday_anchor_by"] == "hold" and "holiday_anchor" not in state["X"][D(70)]["GEL"]
    assert d["proposed"] <= 200 * 1.03 + 1e-6 and d["kind"] != "far_reset"
    # another room is not covered
    cfg_other = mkcfg(1, holiday=False, rules=[{"from": D(60), "to": D(62), "rooms": ["Y"], "action": "hold"}])
    res2 = go(cfg_other, inv_of(1, 200), {}, 0, hour=13)
    assert "holiday" not in decision(res2, "X", D(61))
    # "Don't change the price" still wins
    cfg_p = mkcfg(1, holiday=False, rules=[{"from": D(60), "to": D(62), "rooms": "all", "action": "hold"},
                                           {"from": D(61), "to": D(61), "rooms": "all", "action": "protect"}])
    assert decision(go(cfg_p, inv_of(1, 200), {}, 0), "X", D(61))["kind"] == "protected"


def test_hold_keeps_the_room_style():
    rules = [{"from": D(60), "to": D(62), "rooms": "all", "action": "hold"}]
    cfg = mkcfg(1, holiday=False, rules=rules)
    cfg["room_types"]["X"]["style"] = "aggressive"
    d = decision(go(cfg, inv_of(1, 200), {}, 0), "X", D(61))
    assert d["style"] == "aggressive"


def test_booked_dates_have_no_decision_but_keep_their_anchor_when_free_again():
    cfg = mkcfg(1)
    inv = inv_of(1, 210, avail=lambda i: 0 if i == 40 else 1)
    state = {}
    res = go(cfg, inv, state, 0, apply=False)
    assert decision(res, "X", D(40))["kind"] == "hold"
    assert state["X"][D(40)]["GEL"]["holiday_anchor"] == 210           # stored even while booked


def test_holiday_numbers_have_hard_limits_and_sane_order():
    c = merged({"holiday": {"limits": {"far": {"down_single": 0.5}}}})
    assert c["holiday"]["limits"]["far"]["down_single"] == 0.03 and any("down_single" in w for w in c["_settings_warnings"])
    c = merged({"holiday": {"limits": {"far": {"down_multi": 0.09}}}})            # 9% far but 8% mid: closer must allow at least as much
    assert c["holiday"]["limits"]["far"]["down_multi"] == 0.05 and any("closer to the date" in w for w in c["_settings_warnings"])
    c = merged({"holiday": {"limits": {"far": {"up_single": 0.02}, "mid": {"up_single": 0.04}, "near": {"up_single": 0.09}}}})
    assert c["holiday"]["limits"]["near"]["up_single"] == 0.09 and not c["_settings_warnings"]
    c = merged({"holiday": {"days": {"normal_upto": 25}}})
    assert c["holiday"]["days"] == {"far_above": 30, "mid_above": 20, "normal_upto": 14} or c["holiday"]["days"]["normal_upto"] == 14
    c = merged({"holiday": "oops"})
    assert c["holiday"]["limits"]["far"]["down_multi"] == 0.05
    assert merged({"date_rules": [{"from": "2026-11-01", "to": "2026-11-02", "action": "hold"}]})["date_rules"]
    assert not merged({"date_rules": [{"from": "2026-11-01", "to": "2026-11-02", "action": "stay"}]})["date_rules"]


def test_settings_from_the_page_change_the_steps():
    cfg = mkcfg(1)
    cfg["holiday"]["limits"]["far"].update({"up_single": 0.0, "down_single": 0.0})
    inv = inv_of(1, 200)
    res = go(cfg, inv, {}, 0, hour=13)
    d = decision(res, "X", D(40))
    assert d["proposed"] == 200 and any("Holiday rule" in b for b in d["blocked"])           # 0% = the price may not move
