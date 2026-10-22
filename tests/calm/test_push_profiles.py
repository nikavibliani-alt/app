"""How hard to push: Hold, Calm, Normal, Active, Fill fast (per room and per night). Empty nights only, always inside min/max."""

import copy
import os
import sys
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_holiday import mkcfg, inv_of, D, go  # noqa: E402
from test_rules import TODAY  # noqa: E402

from calm_pricing import run, merged  # noqa: E402
from calm_pricing.config import PUSH_PROFILES, BAND_LIMITS, DEMAND_LIMITS, HARD_LIMITS, STYLES  # noqa: E402

STOPS = ["hold", "calm", "normal", "active", "aggressive"]
MN, START, MX = 150, 230, 300


def walk(style=None, nights=14, units=1, night_style=None, avail=None, price=START, weekend=False):
    """Daily main runs, an empty night `nights` days away. Returns [(days_out, price)] after each run, and the engine memory."""
    cfg = mkcfg(units, mn=MN, start=START, mx=MX, holiday=False)
    if style:
        cfg["room_types"]["X"]["style"] = style
    if night_style:
        cfg["night_push"] = [{"rt": "X", "date": D(nights), "style": night_style, "avail": avail}]
    inv, state = inv_of(units, price), {}
    go(cfg, inv, state, 0)
    out = [(nights, inv[D(nights)]["prices"]["GEL"])]
    for day in range(1, nights):
        go(cfg, inv, state, day, 9)
        out.append((nights - day, inv[D(nights)]["prices"]["GEL"]))
    return out, state


def drops(seq):
    prev, out = seq[0][1], []
    for do, p in seq[1:]:
        out.append((do, (prev - p) / prev))
        prev = p
    return out


def test_normal_and_fill_fast_are_exactly_what_they_were():
    plain = walk()[0]
    assert walk("normal")[0] == plain
    assert walk("aggressive")[0] == walk(night_style="aggressive")[0] == walk("aggressive")[0]
    assert walk("aggressive")[0] != plain                                  # and Fill fast is a different thing from Normal


def test_hold_lowers_at_most_one_percent_a_day_never_below_3_percent_under_start_and_never_in_the_last_3_days():
    for nights in (6, 14, 40):
        seq = walk("hold", nights=nights)[0]
        for (do, d) in drops(seq):
            assert d <= 0.0105, (nights, do, d)                            # at most 1% a day
        assert all(p >= START * 0.97 - 3 for do, p in seq if do > 3), seq   # never more than 3% under start before the last 3 days
        assert all(p >= START * 0.97 - 3 for do, p in seq if do <= 3)
        last = [p for do, p in seq if do <= 4]
        assert all(a >= b for a, b in zip(last, last[1:])) and last[0] == last[-1], last   # nothing is lowered in the last 3 days


def test_hold_raises_at_most_3_percent_over_start():
    seq = walk("hold", nights=20, units=3, price=START)[0]
    cfg = mkcfg(3, mn=MN, start=START, mx=MX, holiday=False)
    cfg["room_types"]["X"]["style"] = "hold"
    inv, state = inv_of(3, START, avail=lambda i: 1), {}                   # 2 of 3 units sold: selling much faster than normal
    go(cfg, inv, state, 0)
    for day in range(1, 14):
        go(cfg, inv, state, day, 9)
    assert inv[D(20)]["prices"]["GEL"] <= START * 1.03 + 5, inv[D(20)]["prices"]["GEL"]


def test_calm_lowest_6_percent_under_start_3_percent_a_day_and_the_last_3_days_stop_halfway():
    for nights in (8, 14, 40):
        seq = walk("calm", nights=nights)[0]
        assert all(d <= 0.0305 for _, d in drops(seq)), drops(seq)                         # at most 3% a day (also in the last 3 days)
        assert all(p >= START * 0.94 - 3 for do, p in seq if do > 3), seq                 # lowest -6% before the last 3 days
        entering = [p for do, p in seq if do == 4][0]                                      # the price when the last 3 days begin
        final = seq[-1][1]
        assert final >= MN + (entering - MN) / 2 - 5, (entering, final)                    # halfway between that price and the minimum
        assert final > MN + 5, final                                                       # and not at the minimum
    normal_final = walk("normal", nights=14)[0][-1][1]
    assert normal_final == MN and walk("calm", nights=14)[0][-1][1] > normal_final         # Normal does go to the minimum on the last night


def test_calm_raises_at_most_6_percent_over_start():
    cfg = mkcfg(3, mn=MN, start=START, mx=MX, holiday=False)
    cfg["room_types"]["X"]["style"] = "calm"
    inv, state = inv_of(3, START, avail=lambda i: 1), {}
    go(cfg, inv, state, 0)
    for day in range(1, 14):
        go(cfg, inv, state, day, 9)
    assert inv[D(20)]["prices"]["GEL"] <= START * 1.06 + 5


def test_active_goes_lower_and_faster_than_normal_but_less_than_fill_fast_and_not_below_16_percent_before_the_last_3_days():
    seqs = {st: walk(st, nights=14)[0] for st in ("normal", "active", "aggressive")}
    mid = {st: [p for do, p in s if do == 5][0] for st, s in seqs.items()}
    assert mid["aggressive"] <= mid["active"] <= mid["normal"], mid
    assert mid["active"] < mid["normal"], mid
    assert all(p >= START * 0.84 - 5 for do, p in seqs["active"] if do > 3), seqs["active"]
    early = [d for do, d in drops(seqs["active"]) if do > 3]                      # before the last 3 days, which step down to the minimum as in Normal
    assert all(d <= 0.0605 for d in early) and max(early) > 0.03, early


def test_active_raises_up_to_15_percent_and_stays_inside_min_and_max():
    cfg = mkcfg(3, mn=MN, start=START, mx=MX, holiday=False)
    cfg["room_types"]["X"]["style"] = "active"
    inv, state = inv_of(3, START, avail=lambda i: 1), {}
    go(cfg, inv, state, 0)
    for day in range(1, 14):
        go(cfg, inv, state, day, 9)
    assert START <= inv[D(20)]["prices"]["GEL"] <= min(MX, START * 1.15 + 5)


def test_every_stop_stays_inside_min_and_max_and_the_hard_limits():
    for st in STOPS:
        for price in (160, START, 290):
            for nights in (5, 12, 30):
                for _, p in walk(st, nights=nights, price=price)[0]:
                    assert MN <= p <= MX, (st, price, nights, p)
    for name, spec in PUSH_PROFILES.items():
        for b in spec["bands"]:
            for k, (lo, hi) in BAND_LIMITS.items():
                if isinstance(b[k], str):
                    continue
                assert lo <= b[k] <= hi, (name, b)
        for k, (lo, hi) in DEMAND_LIMITS.items():
            for v in spec["target_adj" if k == "target_adj" else k].values():
                assert lo <= v <= hi, (name, k, v)
        for k, v in spec["calm"].items():
            assert HARD_LIMITS[("calm", k)][0] <= v <= HARD_LIMITS[("calm", k)][1], (name, k, v)
    assert set(STYLES) == set(STOPS)


def test_a_nights_own_setting_beats_the_room_default_and_a_date_rule_and_ends_when_it_is_booked():
    default = walk("calm", nights=14)[0]
    night = walk("calm", nights=14, night_style="aggressive", avail=1)[0]
    assert night == walk("aggressive", nights=14)[0] and night != default
    # booked meanwhile (avail went down): the room default applies again
    cfg = mkcfg(3, mn=MN, start=START, mx=MX, holiday=False)
    cfg["room_types"]["X"]["style"] = "calm"
    cfg["night_push"] = [{"rt": "X", "date": D(14), "style": "aggressive", "avail": 3}]
    inv, state = inv_of(3, START), {}
    go(cfg, inv, state, 0)
    inv[D(14)]["avail"] = 2
    d = [x for x in go(cfg, inv, state, 1, 9, apply=False)["decisions"] if x["date"] == D(14)][0]
    assert d["style"] == "calm"
    # a date rule with another style loses against the night's own setting
    cfg2 = mkcfg(1, mn=MN, start=START, mx=MX, holiday=False, rules=[{"from": D(14), "to": D(14), "rooms": ["X"], "action": "normal"}])
    cfg2["night_push"] = [{"rt": "X", "date": D(14), "style": "hold", "avail": 1}]
    inv2, st2 = inv_of(1, START), {}
    d2 = [x for x in go(cfg2, inv2, st2, 0, apply=False)["decisions"] if x["date"] == D(14)][0]
    assert d2["style"] == "hold" and any("How hard to push: Hold" in w for w in d2["why"])


def test_protect_hand_set_and_the_holiday_rule_still_win_over_the_slider():
    cfg = mkcfg(1, mn=MN, start=START, mx=MX, holiday=False, rules=[{"from": D(14), "to": D(14), "rooms": ["X"], "action": "protect"}])
    cfg["night_push"] = [{"rt": "X", "date": D(14), "style": "aggressive", "avail": 1}]
    inv, st = inv_of(1, START), {}
    d = [x for x in go(cfg, inv, st, 0, apply=False)["decisions"] if x["date"] == D(14)][0]
    assert d["kind"] == "protected" and d["proposed"] == START
    # a holiday date: the holiday rule keeps the price within its band around the anchor, whatever the stop
    for style in STOPS:
        cfg = mkcfg(1, mn=MN, start=START, mx=MX, holiday=True)           # holiday dates 14..54 days after today
        cfg["room_types"]["X"]["style"] = style
        inv, state = inv_of(1, START), {}
        go(cfg, inv, state, 0)
        for day in range(1, 6):
            go(cfg, inv, state, day, 9)
        assert inv[D(40)]["prices"]["GEL"] >= START * 0.95 - 3, (style, inv[D(40)]["prices"]["GEL"])      # far ahead: at most 5%/3% down
    # a hand-set price stays untouched
    cfg = mkcfg(1, mn=MN, start=START, mx=MX, holiday=False)
    cfg["room_types"]["X"]["style"] = "aggressive"
    inv, state = inv_of(1, START), {}
    go(cfg, inv, state, 0)
    go(cfg, inv, state, 0)
    inv[D(14)]["prices"]["GEL"] = 100
    res = go(cfg, inv, state, 1, 9)
    d = [x for x in res["decisions"] if x["date"] == D(14)][0]
    assert d["kind"] == "manual" and inv[D(14)]["prices"]["GEL"] == 100


def test_the_weekend_factor_still_applies_to_every_stop():
    for st in STOPS:
        cfg = mkcfg(1, mn=MN, start=START, mx=MX, holiday=False)
        cfg["room_types"]["X"]["style"] = st
        inv, state = inv_of(1, START), {}
        res = go(cfg, inv, state, 0, apply=False)
        by = {}
        for d in res["decisions"]:
            if d["currency"] == "GEL" and d["days_out"] > 60 and d["target"]:
                wd = (TODAY + timedelta(days=d["days_out"])).weekday()
                by.setdefault(wd in (4, 5), set()).add(d["target"])
        assert by and min(by[True]) > max(by[False]) * 1.0 or max(by[True]) > max(by[False]), (st, by)   # weekend nights aim higher


def test_bad_night_push_entries_are_ignored_and_listed():
    cfg = merged({"night_push": [{"rt": "X", "date": "2026-12-20", "style": "calm", "avail": 1}, {"rt": "X", "date": "nope", "style": "calm"},
                                 {"rt": "X", "date": "2026-12-21", "style": "turbo"}, "junk"]})
    assert [a["date"] for a in cfg["night_push"]] == ["2026-12-20"]
    assert len([w for w in cfg["_settings_warnings"] if "night_push" in w]) == 3


def test_a_room_style_of_each_stop_is_accepted_by_the_runner():
    import pricing_calm_live as live
    from test_shadow_script import FakeDB
    import pricing_shadow as ps
    for st in STOPS:
        rules = {"MAXELA": {"GEL": {"mid": {"min": 1, "start": 2, "max": 3}}}}
        settings = {"room_types": {"MAXELA": {"engine": "live", "style": st}}}
        got = live.live_room_types(rules, settings)
        assert got.get("MAXELA", {}).get("style") == st, (st, got)
