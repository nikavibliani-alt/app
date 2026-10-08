"""
Rule tests for the calm pricing engine. Each test checks one promise from the plan.
Run: python3 -m pytest -q tests
"""

import random
import sys
import os
from datetime import datetime, date, timedelta

def _project_root():
    d = os.path.dirname(os.path.abspath(__file__))
    while d != os.path.dirname(d):
        if os.path.isdir(os.path.join(d, "calm_pricing")):
            return d
        d = os.path.dirname(d)
    raise RuntimeError("calm_pricing folder not found")


sys.path.insert(0, _project_root())

from calm_pricing import run, merged, learn_shape  # noqa: E402
from calm_pricing.config import season_of  # noqa: E402

TODAY = date(2026, 10, 7)


def cfg_for(room_types, rules, **over):
    cfg = merged(over)
    cfg["room_types"] = room_types
    cfg["rules"] = rules
    return cfg


def flat_rules(cur="GEL", mn=180, start=255, mx=320):
    return {cur: {s: {"min": mn, "start": start, "max": mx}
                  for s in ["low", "mid", "high", "peak", "xmas_low", "new_year"]}}


def inventory(units, price, days=91, avail_fn=None, cur="GEL"):
    inv = {}
    for i in range(days):
        ds = (TODAY + timedelta(days=i)).isoformat()
        avail = units if avail_fn is None else avail_fn(i)
        inv[ds] = {"avail": avail, "prices": {cur: price(i) if callable(price) else price}}
    return inv


def snap(now_hour, inv_by_rt, reservations=None, day_offset=0):
    now = datetime.combine(TODAY + timedelta(days=day_offset), datetime.min.time()) + timedelta(hours=now_hour)
    return {"now": now, "inventory": inv_by_rt, "reservations": reservations or []}


def decision(res, rt, ds, cur="GEL"):
    for d in res["decisions"]:
        if d["rt"] == rt and d["date"] == ds and d["currency"] == cur:
            return d
    raise KeyError((rt, ds, cur))


# ---------------------------------------------------------------------------

def test_never_outside_min_max_random():
    rng = random.Random(7)
    for trial in range(60):
        units = rng.choice([1, 2, 3, 5, 7])
        mn, start = 150, 230
        mx = start + rng.choice([10, 40, 80])
        rts = {"X": {"units": units, "group": "g", "currencies": ["GEL"], "status": "live"}}
        cfg = cfg_for(rts, {"X": flat_rules(mn=mn, start=start, mx=mx)})
        cfg["safety"]["max_share_changed"] = 1.0
        inv = {"X": inventory(units, lambda i: rng.choice([140, 160, 200, 230, 260, 400]),
                              avail_fn=lambda i: rng.randint(0, units))}
        res = run(snap(rng.choice([4, 9, 13, 22]), inv), cfg, {})
        for d in res["decisions"]:
            if d["proposed"] != d["current"]:
                assert mn <= d["proposed"] <= mx, d


def test_arrival_day_never_lowered():
    rts = {"S": {"units": 1, "group": "g", "currencies": ["GEL"], "status": "live"}}
    cfg = cfg_for(rts, {"S": flat_rules()})
    inv = {"S": inventory(1, 255)}
    res = run(snap(9, inv), cfg, {})
    d0 = decision(res, "S", TODAY.isoformat())
    assert d0["proposed"] >= d0["current"]


def test_only_morning_run_lowers():
    rts = {"P": {"units": 7, "group": "g", "currencies": ["GEL"], "status": "live"}}
    cfg = cfg_for(rts, {"P": flat_rules()})
    cfg["safety"]["max_share_changed"] = 1.0
    inv = {"P": inventory(7, 255)}          # nothing sold: everything is behind
    res = run(snap(4, inv), cfg, {})        # 04:00 is before the morning run
    assert not res["main_run"]
    assert all(d["proposed"] >= d["current"] for d in res["decisions"])
    res2 = run(snap(9, inv), cfg, res["state"])       # 09:00 is
    assert res2["main_run"]
    assert any(d["proposed"] < d["current"] for d in res2["decisions"])
    res3 = run(snap(13, inv), cfg, res2["state"])     # later runs that day: raise only
    assert not res3["main_run"]
    assert all(d["proposed"] >= d["current"] for d in res3["decisions"])


def test_missed_morning_window_later_run_lowers_with_warning():
    rts = {"P": {"units": 7, "group": "g", "currencies": ["GEL"], "status": "live"}}
    cfg = cfg_for(rts, {"P": flat_rules()})
    cfg["safety"]["max_share_changed"] = 1.0
    inv = {"P": inventory(7, 255)}
    r1 = run(snap(5, inv), cfg, {})
    r2 = run(snap(13, inv), cfg, r1["state"])   # no run between 09:00 and 11:59
    assert r2["main_run"] and any("No run between 09:00" in w for w in r2["warnings"])


def test_one_main_run_per_day():
    rts = {"P": {"units": 7, "group": "g", "currencies": ["GEL"], "status": "live"}}
    cfg = cfg_for(rts, {"P": flat_rules()})
    cfg["safety"]["max_share_changed"] = 1.0
    state = {}
    r1 = run(snap(9, {"P": inventory(7, 255)}), cfg, state)
    r2 = run(snap(10, {"P": inventory(7, 255)}), cfg, r1["state"])
    assert r1["main_run"] and not r2["main_run"]


def test_daily_limit_across_runs():
    """Many runs on the same day can never move a date more than the daily limit."""
    rts = {"P": {"units": 7, "group": "g", "currencies": ["GEL"], "status": "live"}}
    cfg = cfg_for(rts, {"P": flat_rules(mn=100, start=255, mx=400)})
    cfg["safety"]["max_share_changed"] = 1.0
    prices = {}
    state = {}
    # everything nearly sold out -> wants to raise fast
    for h in [4, 9, 11, 13, 16, 22]:
        inv = {"P": inventory(7, lambda i: prices.get(i, 255), avail_fn=lambda i: 1)}
        res = run(snap(h, inv), cfg, state)
        state = res["state"]
        for w in res["writes"]:
            i = (date.fromisoformat(w["date"]) - TODAY).days
            prices[i] = w["price"]
    for i, p in prices.items():
        limit = 0.15 if i <= 14 else 0.08
        assert p <= 255 * (1 + limit) + 5, (i, p)


def test_far_dates_move_only_a_little():
    rts = {"P": {"units": 7, "group": "g", "currencies": ["GEL"], "status": "live"}}
    cfg = cfg_for(rts, {"P": flat_rules(mn=100, start=255, mx=500)})
    cfg["safety"]["max_share_changed"] = 1.0
    cfg["weekend"]["pct"] = 0.0
    for avail in (0, 3, 7):
        inv = {"P": inventory(7, 255, avail_fn=lambda i: avail if i > 60 else 7)}
        res = run(snap(9, inv), cfg, {})
        for d in res["decisions"]:
            if d["days_out"] > 60 and d["target"] is not None:
                assert 255 * 0.97 - 1 <= d["target"] <= 255 * 1.08 + 1, d


def test_single_unit_follows_band_unless_building_is_selling():
    rts = {"S": {"units": 1, "group": "b", "currencies": ["GEL"], "status": "live"},
           "P": {"units": 7, "group": "b", "currencies": ["GEL"], "status": "live"}}
    cfg = cfg_for(rts, {"S": flat_rules(), "P": flat_rules()})
    cfg["safety"]["max_share_changed"] = 1.0
    cfg["weekend"]["pct"] = 0.0
    # building empty too: the empty apartment may drop within the days-out band
    res = run(snap(9, {"S": inventory(1, 255), "P": inventory(7, 255)}), cfg, {})
    s20 = decision(res, "S", (TODAY + timedelta(days=20)).isoformat())
    assert s20["proposed"] < 255 and s20["target"] >= 255 * 0.92 - 1
    # building full: the empty apartment does not undercut it
    res = run(snap(9, {"S": inventory(1, 255), "P": inventory(7, 255, avail_fn=lambda i: 0)}), cfg, {})
    for d in res["decisions"]:
        if d["rt"] == "S" and d["days_out"] >= 4:
            assert d["proposed"] >= 255, d


def test_minimum_reached_night_before_arrival_in_steps():
    """An empty single apartment walks to the minimum over the last 3 mornings."""
    rts = {"S": {"units": 1, "group": "solo", "currencies": ["GEL"], "status": "live"}}
    cfg = cfg_for(rts, {"S": flat_rules(mn=180, start=255, mx=320)})
    cfg["safety"]["max_share_changed"] = 1.0
    cfg["weekend"]["pct"] = 0.0
    target = TODAY + timedelta(days=3)
    price = 255.0
    state = {}
    seen = []
    for day in range(0, 4):
        inv = {"S": {(target - timedelta(days=k)).isoformat(): {"avail": 1, "prices": {"GEL": 255}} for k in range(0, 0)}}
        inv = {"S": inventory(1, 255)}
        inv["S"][target.isoformat()]["prices"]["GEL"] = price
        # shift "today" forward
        s = snap(9, {"S": {ds: c for ds, c in inv["S"].items()}}, day_offset=day)
        # rebuild inventory relative to the new day
        new_inv = {}
        for i in range(91):
            ds = (TODAY + timedelta(days=day + i)).isoformat()
            new_inv[ds] = {"avail": 1, "prices": {"GEL": price if ds == target.isoformat() else 255}}
        s["inventory"] = {"S": new_inv}
        res = run(s, cfg, state)
        state = res["state"]
        d = decision(res, "S", target.isoformat())
        price = d["proposed"]
        seen.append((d["days_out"], price))
    by_out = dict(seen)
    assert by_out[3] < 255 and by_out[2] < by_out[3]
    assert by_out[1] == 180                 # minimum on the night before arrival day
    assert by_out[0] == 180                 # arrival day: not lower, not higher
    # no single day dropped more than 15%
    prev = 255
    for out, p in sorted(seen, reverse=True):
        assert (prev - p) / prev <= 0.15 + 1e-9, seen
        prev = p


def test_manual_price_respected_then_released_after_booking():
    rts = {"P": {"units": 3, "group": "g", "currencies": ["GEL"], "status": "live"}}
    cfg = cfg_for(rts, {"P": flat_rules()})
    cfg["safety"]["max_share_changed"] = 1.0
    ds = (TODAY + timedelta(days=10)).isoformat()
    r1 = run(snap(9, {"P": inventory(3, 255)}), cfg, {})
    state = r1["state"]
    engine_price = decision(r1, "P", ds)["proposed"]
    # you set 300 by hand in MiniHotel
    inv = {"P": inventory(3, lambda i: engine_price)}
    inv["P"][ds]["prices"]["GEL"] = 300
    r2 = run(snap(13, inv), cfg, state)
    d = decision(r2, "P", ds)
    assert d["proposed"] == 300 and "hand-set" in " ".join(d["why"])
    # a booking comes in on that date -> engine takes over again from your price
    inv["P"][ds]["avail"] = 2
    r3 = run(snap(16, inv), cfg, r2["state"])
    d3 = decision(r3, "P", ds)
    assert "released" in " ".join(d3["why"])


def test_stop_when_data_incomplete():
    """Incomplete data for one room type stops that room type only; the others carry on."""
    rts = {"P": {"units": 7, "group": "g", "currencies": ["GEL"], "status": "live"},
           "Q": {"units": 2, "group": "g", "currencies": ["GEL"], "status": "live"}}
    cfg = cfg_for(rts, {"P": flat_rules(), "Q": flat_rules()})
    cfg["safety"]["max_share_changed"] = 1.0
    res = run(snap(9, {"P": inventory(7, 255)}), cfg, {})   # Q missing
    assert res["stopped_room_types"] == ["Q"] and all(w["rt"] == "P" for w in res["writes"])
    short = {"P": inventory(7, 255, days=30), "Q": inventory(2, 255)}
    res = run(snap(9, short), cfg, {})
    assert res["stopped_room_types"] == ["P"] and all(w["rt"] == "Q" for w in res["writes"])
    assert res["writes"]
    for d in res["decisions"]:
        if d["rt"] == "P":
            assert d["proposed"] == d["current"]


def test_stop_when_too_many_changes():
    rts = {"P": {"units": 7, "group": "g", "currencies": ["GEL"], "status": "live"}}
    cfg = cfg_for(rts, {"P": flat_rules(mn=100, start=255, mx=400)})
    cfg["safety"]["max_share_changed"] = 0.10
    old_state = {"_meta": {"first_run_day": "2026-09-01"}}   # switched on long ago
    res = run(snap(9, {"P": inventory(7, 255, avail_fn=lambda i: 0 if i % 2 else 1)}), cfg, old_state)
    assert res["changed"] / max(1, res["considered"]) > 0.10
    assert not res["ok"] and res["writes"] == []
    # first days after switching on: allowed, with a warning
    res2 = run(snap(9, {"P": inventory(7, 255, avail_fn=lambda i: 0 if i % 2 else 1)}), cfg, {})
    assert res2["ok"] and res2["warnings"]


def test_suggest_mode_never_writes():
    rts = {"X": {"units": 1, "group": "x", "currencies": ["GEL"], "status": "suggest"}}
    cfg = cfg_for(rts, {"X": flat_rules()})
    cfg["safety"]["max_share_changed"] = 1.0
    res = run(snap(9, {"X": inventory(1, 300)}), cfg, {})
    assert res["writes"] == []
    assert any(d["proposed"] != d["current"] for d in res["decisions"])


def test_same_inputs_same_answer_no_creep():
    """Running again with nothing new must not keep moving prices (no creep)."""
    rts = {"P": {"units": 7, "group": "g", "currencies": ["GEL"], "status": "live"}}
    cfg = cfg_for(rts, {"P": flat_rules()})
    cfg["safety"]["max_share_changed"] = 1.0
    prices, state = {}, {}
    for h in [4, 9, 13, 16, 22]:
        inv = {"P": inventory(7, lambda i: prices.get(i, 255), avail_fn=lambda i: 3)}
        res = run(snap(h, inv), cfg, state)
        state = res["state"]
        for w in res["writes"]:
            prices[(date.fromisoformat(w["date"]) - TODAY).days] = w["price"]
    moves = {}
    for i, p in prices.items():
        moves[i] = p
    # after the morning run, later runs of the same day with unchanged bookings add nothing new
    inv = {"P": inventory(7, lambda i: prices.get(i, 255), avail_fn=lambda i: 3)}
    res = run(snap(23, inv), cfg, state)
    assert res["writes"] == []


def test_prices_off_the_grid_left_alone():
    rts = {"P": {"units": 7, "group": "g", "currencies": ["GEL"], "status": "live"}}
    cfg = cfg_for(rts, {"P": flat_rules()})
    cfg["safety"]["max_share_changed"] = 1.0
    ds = (TODAY + timedelta(days=40)).isoformat()
    inv = {"P": inventory(7, 255, avail_fn=lambda i: 6)}
    inv["P"][ds]["prices"]["GEL"] = 257     # odd price, close to the target
    res = run(snap(13, inv), cfg, {})
    assert decision(res, "P", ds)["proposed"] == 257


def test_event_lifts_max_and_night_before():
    rts = {"P": {"units": 7, "group": "g", "currencies": ["GEL"], "status": "live"}}
    cfg = cfg_for(rts, {"P": flat_rules(mn=180, start=255, mx=270)})
    cfg["safety"]["max_share_changed"] = 1.0
    ev = (TODAY + timedelta(days=20)).isoformat()
    cfg["events"] = {ev: {"label": "Concert", "pct": 0.30}}
    prices, state = {}, {}
    for day in range(0, 8):
        new_inv = {}
        for i in range(91):
            ds = (TODAY + timedelta(days=day + i)).isoformat()
            new_inv[ds] = {"avail": 5, "prices": {"GEL": prices.get(ds, 255)}}
        res = run(snap(9, {"P": new_inv}, day_offset=day), cfg, state)
        state = res["state"]
        for w in res["writes"]:
            prices[w["date"]] = w["price"]
    assert prices.get(ev, 255) > 270            # above the normal maximum
    before = (TODAY + timedelta(days=19)).isoformat()
    assert 255 < prices.get(before, 255) <= 270  # night before also up, but within your maximum


def test_learn_shape_is_sane():
    res = []
    rng = random.Random(3)
    for i in range(400):
        ci = TODAY - timedelta(days=rng.randint(1, 170))
        lead = rng.choice([0, 0, 1, 2, 5, 10, 20, 40])
        res.append({"checkin": ci.isoformat(), "checkout": (ci + timedelta(days=rng.randint(1, 5))).isoformat(),
                    "created": (ci - timedelta(days=lead)).isoformat()})
    shape = learn_shape(res, TODAY, {0: 1.0, 7: 0.7, 30: 0.3, 90: 0.05})
    vals = [shape[d] for d in sorted(shape)]
    assert vals[0] == 1.0
    assert all(a >= b for a, b in zip(vals, vals[1:]))
    # every guest books on arrival day for one night -> nothing is booked 1 day ahead
    same_day = [{"checkin": (TODAY - timedelta(days=i)).isoformat(),
                 "checkout": (TODAY - timedelta(days=i - 1)).isoformat(),
                 "created": (TODAY - timedelta(days=i)).isoformat()} for i in range(1, 170)]
    s2 = learn_shape(same_day, TODAY, {0: 1.0, 7: 0.7, 30: 0.3, 90: 0.05})
    assert s2[0] == 1.0 and s2[1] < 0.01
    # everyone books 20 days ahead -> fully booked already 14 days before
    early = [{"checkin": (TODAY - timedelta(days=i)).isoformat(),
              "checkout": (TODAY - timedelta(days=i - 1)).isoformat(),
              "created": (TODAY - timedelta(days=i + 20)).isoformat()} for i in range(1, 170)]
    s3 = learn_shape(early, TODAY, {0: 1.0, 7: 0.7, 30: 0.3, 90: 0.05})
    assert s3[14] > 0.99 and s3[30] < 0.01


def test_two_currencies_follow_their_own_limits():
    rts = {"B": {"units": 1, "group": "g", "currencies": ["GEL", "USD"], "status": "live"}}
    rules = {**flat_rules("GEL", 400, 630, 800), **flat_rules("USD", 100, 155, 200)}
    cfg = cfg_for(rts, {"B": rules})
    cfg["safety"]["max_share_changed"] = 1.0
    inv = {"B": {}}
    for i in range(91):
        ds = (TODAY + timedelta(days=i)).isoformat()
        inv["B"][ds] = {"avail": 1, "prices": {"GEL": 630, "USD": 155}}
    res = run(snap(9, inv), cfg, {})
    for d in res["decisions"]:
        if d["currency"] == "USD" and d["proposed"] != d["current"]:
            assert 100 <= d["proposed"] <= 200 and float(d["proposed"]).is_integer()
        if d["currency"] == "GEL" and d["proposed"] != d["current"]:
            assert d["proposed"] % 5 == 0


# ---------------------------------------------------------------------------
# Regression tests for the independent review findings
# ---------------------------------------------------------------------------

def _one(rt_units=1, cur="GEL", mn=180, start=255, mx=320, status="live"):
    rts = {"S": {"units": rt_units, "group": "solo", "currencies": [cur], "status": status}}
    cfg = cfg_for(rts, {"S": flat_rules(cur, mn, start, mx)})
    cfg["safety"]["max_share_changed"] = 1.0
    cfg["weekend"]["pct"] = 0.0
    return cfg


def test_above_max_comes_down_to_max_only():
    cfg = _one(mn=180, start=255, mx=320)
    inv = {"S": inventory(1, 255)}
    ds = (TODAY + timedelta(days=2)).isoformat()
    inv["S"][ds]["prices"]["GEL"] = 340
    res = run(snap(4, inv), cfg, {})                 # not the morning run
    assert decision(res, "S", ds)["proposed"] == 320


def test_limits_never_reverse_a_move():
    """Fuzz: a raise is never written when the target is below, and vice versa."""
    rng = random.Random(11)
    for trial in range(40):
        units = rng.choice([1, 2, 5, 7])
        rts = {"P": {"units": units, "group": "g", "currencies": ["GEL"], "status": "live"}}
        cfg = cfg_for(rts, {"P": flat_rules(mn=120, start=200, mx=280)})
        cfg["safety"]["max_share_changed"] = 1.0
        prices, avail, state = {}, {}, {}
        for day in range(6):
            for h in sorted(rng.sample([4, 6, 9, 13, 16, 22], 4)):
                inv = {}
                for i in range(91):
                    ds = (TODAY + timedelta(days=day + i)).isoformat()
                    avail.setdefault(ds, units)
                    if rng.random() < 0.05:
                        avail[ds] = max(0, min(units, avail[ds] + rng.choice([-1, 1])))
                    inv[ds] = {"avail": avail[ds], "prices": {"GEL": prices.get(ds, 200)}}
                res = run(snap(h, {"P": inv}, day_offset=day), cfg, state)
                state = res["state"]
                for d in res["decisions"]:
                    if d["kind"] == "move":
                        if d["proposed"] > d["current"]:
                            assert d["target"] > d["current"], d
                        if d["proposed"] < d["current"]:
                            assert d["target"] < d["current"], d
                            assert res["main_run"], d
                for w in res["writes"]:
                    prices[w["date"]] = w["price"]


def test_rounding_never_turns_raise_into_drop():
    cfg = _one(rt_units=7, mn=150, start=230, mx=300)
    ds = (TODAY + timedelta(days=20)).isoformat()
    inv = {"S": inventory(7, 230, avail_fn=lambda i: 7)}
    inv["S"][ds]["prices"]["GEL"] = 196
    res = run(snap(22, inv), cfg, {})
    d = decision(res, "S", ds)
    assert d["proposed"] >= 196


def test_small_prices_do_not_get_stuck():
    """At 140 GEL a 2% step is under one 5-GEL step: the engine must still move."""
    cfg = _one(rt_units=5, mn=100, start=150, mx=190)
    cfg["calm"]["dead_zone_abs"]["GEL"] = 5
    ds = (TODAY + timedelta(days=40)).isoformat()
    inv = {"S": inventory(5, 150, avail_fn=lambda i: 4)}
    inv["S"][ds]["prices"]["GEL"] = 130        # below the band, selling as normal
    res = run(snap(9, inv), cfg, {})
    assert decision(res, "S", ds)["proposed"] > 130


def test_prices_above_band_come_back_even_when_selling_well():
    cfg = _one(rt_units=7, mn=180, start=255, mx=330)
    ds = (TODAY + timedelta(days=40)).isoformat()
    inv = {"S": inventory(7, 255, avail_fn=lambda i: 5)}
    inv["S"][ds]["prices"]["GEL"] = 320
    res = run(snap(9, inv), cfg, {})
    assert decision(res, "S", ds)["proposed"] < 320


def test_suggest_rooms_do_not_trigger_the_stop():
    rts = {"L": {"units": 7, "group": "g", "currencies": ["GEL"], "status": "live"},
           "X": {"units": 1, "group": "x", "currencies": ["GEL"], "status": "suggest"}}
    cfg = cfg_for(rts, {"L": flat_rules(), "X": flat_rules()})
    cfg["safety"]["max_share_changed"] = 0.40
    # live room: nothing to do in a 13:00 run (empty -> would only drop, drops wait for the morning)
    inv = {"L": inventory(7, 255), "X": inventory(1, 350)}   # X above its max
    res = run(snap(13, inv), cfg, {"_meta": {"first_run_day": "2026-09-01", "last_main_day": TODAY.isoformat()}})
    x_moves = [d for d in res["decisions"] if d["rt"] == "X" and d["kind"] in ("move", "correction")]
    assert x_moves                      # the suggest room has plenty to suggest
    assert res["considered"] == 91      # only the live room is counted
    assert res["ok"]


def test_missing_availability_is_missing_data():
    cfg = _one(rt_units=3)
    inv = {"S": inventory(3, 255)}
    del inv["S"][(TODAY + timedelta(days=5)).isoformat()]["avail"]
    res = run(snap(9, inv), cfg, {})
    assert res["stopped_room_types"] == ["S"] and res["writes"] == []


def test_settings_from_json_with_text_keys():
    cfg = merged({"cascade": {"3": 0.5, "2": 0.5, "1": 1.0}})
    assert cfg["cascade"] == {3: 0.5, 2: 0.5, 1: 1.0}


def test_time_zone_aware_time_is_converted():
    from datetime import timezone
    cfg = _one(rt_units=7)
    inv = {"S": inventory(7, 255)}
    utc_1 = datetime(2026, 10, 7, 1, 0, tzinfo=timezone.utc)      # 05:00 in Tbilisi
    assert not run({"now": utc_1, "inventory": inv}, cfg, {})["main_run"]
    utc_530 = datetime(2026, 10, 7, 5, 30, tzinfo=timezone.utc)   # 09:30 in Tbilisi
    assert run({"now": utc_530, "inventory": inv}, cfg, {})["main_run"]
    utc_21 = datetime(2026, 10, 6, 21, 0, tzinfo=timezone.utc)    # 01:00 on 7 Oct in Tbilisi
    res = run({"now": utc_21, "inventory": inv}, cfg, {})
    assert min(d["date"] for d in res["decisions"]) == "2026-10-07"


def test_hand_set_price_below_minimum_is_corrected():
    cfg = _one(rt_units=3, mn=180, start=255, mx=320)
    ds = (TODAY + timedelta(days=10)).isoformat()
    r1 = run(snap(9, {"S": inventory(3, 255)}), cfg, {})
    inv = {"S": inventory(3, 255)}
    inv["S"][ds]["prices"]["GEL"] = 150
    r2 = run(snap(13, inv), cfg, r1["state"])
    assert decision(r2, "S", ds)["proposed"] == 180


def test_shadow_mode_never_writes_and_tracks_its_own_prices():
    cfg = _one(rt_units=7)
    state = {}
    for day in range(3):
        inv = {}
        for i in range(91):
            ds = (TODAY + timedelta(days=day + i)).isoformat()
            inv[ds] = {"avail": 7, "prices": {"GEL": 270}}      # old engine keeps 270
        s = snap(9, {"S": inv}, day_offset=day)
        s["shadow"] = True
        res = run(s, cfg, state)
        state = res["state"]
        assert res["writes"] == []
    ds = (TODAY + timedelta(days=40)).isoformat()
    assert state["S"][ds]["GEL"]["shadow_price"] < 270            # its own path moved down


def test_rolling_24h_limit():
    """22:00 and 04:00 next day cannot both add the full daily raise."""
    cfg = _one(rt_units=7, mn=100, start=200, mx=400)
    prices, state = {}, {}
    for day, h in [(0, 22), (1, 4)]:
        inv = {}
        for i in range(91):
            ds = (TODAY + timedelta(days=i)).isoformat()
            inv[ds] = {"avail": 1, "prices": {"GEL": prices.get(ds, 200)}}
        res = run(snap(h, {"S": inv}, day_offset=day), cfg, state)
        state = res["state"]
        for w in res["writes"]:
            prices[w["date"]] = w["price"]
    ds = (TODAY + timedelta(days=30)).isoformat()
    assert prices.get(ds, 200) <= 200 * 1.08 + 5


def test_minimum_not_reached_early_when_min_is_close_to_start():
    cfg = _one(rt_units=5, cur="USD", mn=137, start=155, mx=184)
    res = run(snap(9, {"S": inventory(5, 155, cur="USD")}), cfg, {})
    for d in res["decisions"]:
        if d["days_out"] >= 2 and d["proposed"] != d["current"]:
            assert d["proposed"] > 137, d


def test_engine_moves_respect_24h_limits_fuzz():
    """Only engine moves (no hand edits): every write stays within the 24-hour limit."""
    rng = random.Random(5)
    for trial in range(25):
        units = rng.choice([1, 3, 5, 7])
        cfg = _one(rt_units=units, mn=120, start=200, mx=300)
        prices, avail, state, log = {}, {}, {}, {}
        for day in range(8):
            for h in sorted(rng.sample([4, 6, 9, 13, 16, 22], 5)):
                now = datetime.combine(TODAY + timedelta(days=day), datetime.min.time()) + timedelta(hours=h)
                inv = {}
                for i in range(91):
                    ds = (TODAY + timedelta(days=day + i)).isoformat()
                    avail.setdefault(ds, units)
                    if rng.random() < 0.06:
                        avail[ds] = max(0, min(units, avail[ds] + rng.choice([-1, 1])))
                    inv[ds] = {"avail": avail[ds], "prices": {"GEL": prices.get(ds, 200)}}
                res = run({"now": now, "inventory": {"S": inv}}, cfg, state)
                state = res["state"]
                for w in res["writes"]:
                    ds = w["date"]
                    hist = log.setdefault(ds, [])
                    before = prices.get(ds, 200)
                    hist.append((now, before, w["price"]))
                    window = [x for x in hist if now - x[0] < timedelta(hours=24)]
                    start_p = window[0][1]
                    days_out = (date.fromisoformat(ds) - now.date()).days
                    down = 0.15 if days_out <= 3 else 0.05
                    assert w["price"] >= start_p * (1 - down) - 5.01, (ds, window)
                    assert w["price"] <= start_p * 1.15 + 5.01, (ds, window)
                    prices[ds] = w["price"]


# ---------------------------------------------------------------------------
# Regression tests for the Cursor review (8 Oct 2026)
# ---------------------------------------------------------------------------

def test_band_without_grid_price_stays_inside_min_max():
    """min 102 / max 104: no multiple of 5 fits, the engine must still stay inside."""
    cfg = _one(rt_units=3, mn=102, start=103, mx=104)
    for p in (95, 100, 103, 110, 120):
        inv = {"S": inventory(3, p)}
        for h in (4, 9, 13):
            res = run(snap(h, inv), cfg, {})
            for d in res["decisions"]:
                if d["proposed"] != d["current"]:
                    assert 102 <= d["proposed"] <= 104, d


def test_minimum_reached_on_night_before_from_start_145_min_100():
    """ROOMS low season: start 145, minimum 100, five empty units, last 3 mornings."""
    cfg = _one(rt_units=5, mn=100, start=145, mx=170)
    target = TODAY + timedelta(days=3)
    price, state, seen = 145.0, {}, {}
    for day in range(4):
        inv = {}
        for i in range(91):
            ds = (TODAY + timedelta(days=day + i)).isoformat()
            inv[ds] = {"avail": 5, "prices": {"GEL": price if ds == target.isoformat() else 145}}
        res = run(snap(9, {"S": inv}, day_offset=day), cfg, state)
        state = res["state"]
        d = decision(res, "S", target.isoformat())
        price = d["proposed"]
        seen[d["days_out"]] = price
    assert seen[1] == 100 and seen[0] == 100, seen


def test_arrival_day_above_maximum_is_brought_down_to_maximum():
    """Your maximum wins even on arrival day (the only way arrival day goes down)."""
    cfg = _one(rt_units=1, mn=180, start=255, mx=300)
    inv = {"S": inventory(1, 255)}
    inv["S"][TODAY.isoformat()]["prices"]["GEL"] = 340
    res = run(snap(13, inv), cfg, {})
    d = decision(res, "S", TODAY.isoformat())
    assert d["proposed"] == 300 and d["kind"] == "correction"


def test_booking_in_another_room_type_does_not_block_drops():
    rts = {"A": {"units": 2, "group": "g", "currencies": ["GEL"], "status": "live"},
           "B": {"units": 1, "group": "g", "currencies": ["GEL"], "status": "live"}}
    cfg = cfg_for(rts, {"A": flat_rules(), "B": flat_rules()})
    cfg["safety"]["max_share_changed"] = 1.0
    cfg["weekend"]["pct"] = 0.0
    ds = (TODAY + timedelta(days=10)).isoformat()
    resv = [{"rt": "B", "checkin": ds, "checkout": (TODAY + timedelta(days=11)).isoformat(),
             "created": TODAY.isoformat()}]
    inv = {"A": inventory(2, 255), "B": inventory(1, 255, avail_fn=lambda i: 0 if i == 10 else 1)}
    res = run(snap(9, inv, reservations=resv), cfg, {})
    d = decision(res, "A", ds)
    assert not any("booking" in w for w in d["why"]) and d["proposed"] < 255


def test_rules_out_of_order_left_alone_with_warning():
    cfg = _one(rt_units=3, mn=300, start=255, mx=320)
    res = run(snap(9, {"S": inventory(3, 255)}), cfg, {})
    assert res["ok"] and res["writes"] == []
    assert any("not in order" in w for w in res["warnings"])


def test_decisions_carry_minihotel_price_and_bounds():
    cfg = _one(rt_units=7)
    s = snap(9, {"S": inventory(7, 270)})
    s["shadow"] = True
    state = {"S": {(TODAY + timedelta(days=40)).isoformat(): {"GEL": {"shadow_price": 250}}}}
    res = run(s, cfg, state)
    d = decision(res, "S", (TODAY + timedelta(days=40)).isoformat())
    assert d["mh_price"] == 270 and d["current"] == 250 and d["min"] == 180 and d["max"] == 320



# ---------------------------------------------------------------------------
# Regression tests for the Cursor review, round 2 (8 Oct 2026)
# ---------------------------------------------------------------------------

def test_stopped_run_reports_the_price_really_kept():
    cfg = _one(rt_units=7, mn=100, start=200, mx=300)
    s = snap(9, {"S": inventory(7, 200, avail_fn=lambda i: 0 if i % 2 else 1)})
    s["shadow"] = True
    ds = (TODAY + timedelta(days=10)).isoformat()
    state = {"_meta": {"first_run_day": "2026-01-01"},
             "S": {ds: {"GEL": {"shadow_price": 50}}}}
    cfg["safety"]["max_share_changed"] = 0.05
    res = run(s, cfg, state)
    assert not res["ok"]
    d = decision(res, "S", ds)
    assert d["kind"] == "stopped" and d["proposed"] == 50 and d["rejected"] == 100
    assert res["state"]["S"][ds]["GEL"]["shadow_price"] == 50


def test_one_missing_price_skips_that_date_many_stop_the_run():
    cfg = _one(rt_units=3)
    inv = {"S": inventory(3, 255)}
    del inv["S"][(TODAY + timedelta(days=12)).isoformat()]["prices"]["GEL"]
    res = run(snap(9, inv), cfg, {})
    assert res["ok"] and any("no price for 1 of" in w for w in res["warnings"])
    inv = {"S": inventory(3, lambda i: 0 if i % 3 == 0 else 255)}
    res = run(snap(9, inv), cfg, {})
    assert res["stopped_room_types"] == ["S"] and res["writes"] == []


def test_hand_set_release_keeps_the_24h_limit():
    """Cursor's probe: 09:00 engine raises from 150, 11:00 you set 160 by hand,
    15:00 a booking releases it. The engine may not take a fresh daily allowance from 160."""
    rts = {"P": {"units": 6, "group": "g", "currencies": ["GEL"], "status": "live"}}
    cfg = cfg_for(rts, {"P": flat_rules(mn=100, start=150, mx=300)})
    cfg["safety"]["max_share_changed"] = 1.0
    cfg["weekend"]["pct"] = 0.0
    ds = (TODAY + timedelta(days=10)).isoformat()
    prices = {}

    def inv(avail_on_ds):
        out = inventory(6, 150, avail_fn=lambda i: 2)
        for k, v in prices.items():
            out[k]["prices"]["GEL"] = v
        out[ds]["avail"] = avail_on_ds
        return {"P": out}

    r1 = run(snap(9, inv(2)), cfg, {})
    for w in r1["writes"]:
        prices[w["date"]] = w["price"]
    assert prices[ds] > 150                        # the morning raise
    prices[ds] = 160                               # you set 160 by hand
    r2 = run(snap(11, inv(2)), cfg, r1["state"])
    assert decision(r2, "P", ds)["kind"] == "manual"
    r3 = run(snap(15, inv(1)), cfg, r2["state"])   # a booking releases it
    d = decision(r3, "P", ds)
    assert "released" in " ".join(d["why"])
    assert d["proposed"] <= 150 * 1.15 + 1e-9, d   # never past the 24-hour limit from 150


def test_booking_that_fills_the_date_releases_hand_set_lock():
    cfg = _one(rt_units=1)
    ds = (TODAY + timedelta(days=10)).isoformat()
    r1 = run(snap(9, {"S": inventory(1, 255)}), cfg, {})
    inv = {"S": inventory(1, 255)}
    inv["S"][ds]["prices"]["GEL"] = 300
    r2 = run(snap(11, inv), cfg, r1["state"])
    assert r2["state"]["S"][ds]["GEL"].get("manual_until")
    inv["S"][ds]["avail"] = 0
    r3 = run(snap(13, inv), cfg, r2["state"])
    assert not r3["state"]["S"][ds]["GEL"].get("manual_until")
    assert "released" in " ".join(decision(r3, "S", ds)["why"])


def test_single_in_a_full_building_still_reaches_minimum_night_before():
    rts = {"S": {"units": 1, "group": "b", "currencies": ["GEL"], "status": "live"},
           "P": {"units": 7, "group": "b", "currencies": ["GEL"], "status": "live"}}
    cfg = cfg_for(rts, {"S": flat_rules(mn=180, start=255, mx=320), "P": flat_rules()})
    cfg["safety"]["max_share_changed"] = 1.0
    cfg["weekend"]["pct"] = 0.0
    target = TODAY + timedelta(days=3)
    price, state, seen = 255.0, {}, {}
    for day in range(4):
        s_inv, p_inv = {}, {}
        for i in range(91):
            ds = (TODAY + timedelta(days=day + i)).isoformat()
            s_inv[ds] = {"avail": 1, "prices": {"GEL": price if ds == target.isoformat() else 255}}
            p_inv[ds] = {"avail": 0, "prices": {"GEL": 255}}
        res = run(snap(9, {"S": s_inv, "P": p_inv}, day_offset=day), cfg, state)
        state = res["state"]
        d = decision(res, "S", target.isoformat())
        price = d["proposed"]
        seen[d["days_out"]] = price
    assert seen[1] == 180, seen



# ---------------------------------------------------------------------------
# Regression tests for the Cursor review, round 3 (8 Oct 2026)
# ---------------------------------------------------------------------------

def test_unsafe_settings_fall_back_to_defaults():
    cfg = merged({"calm": {"daily_down": 0.9, "daily_up": 0.9, "daily_down_last3": "a lot"},
                  "safety": {"max_share_changed": 1.0, "warmup_days": 365},
                  "bands": [{"from": 0, "to": 10000, "down": 0.9, "up": 0.9}],
                  "cascade": {"3": 0.5, "1": 0.4},
                  "demand": {"speed_down": {"far_behind": 0.5}},
                  "occupancy_goal": {"vgl": 1.5}})
    assert cfg["calm"]["daily_down"] == 0.05 and cfg["calm"]["daily_up"] == 0.08
    assert cfg["calm"]["daily_down_last3"] == 0.15
    assert cfg["safety"]["max_share_changed"] == 0.40 and cfg["safety"]["warmup_days"] == 3
    assert cfg["bands"][0]["down"] == 0.03 and cfg["bands"][-1]["down"] == "hold"
    assert cfg["cascade"][1] == 1.0
    assert cfg["demand"]["speed_down"]["far_behind"] == 0.04
    assert cfg["occupancy_goal"]["vgl"] == 0.85
    assert len(cfg["_settings_warnings"]) >= 8
    # the warnings reach the run result
    cfg["room_types"] = {"S": {"units": 1, "group": "g", "currencies": ["GEL"], "status": "live"}}
    cfg["rules"] = {"S": flat_rules()}
    res = run(snap(9, {"S": inventory(1, 255)}), cfg, {})
    assert any("daily_down" in w for w in res["warnings"])


def test_safe_settings_are_kept():
    cfg = merged({"calm": {"daily_down": 0.04}, "weekend": {"pct": 0.10},
                  "occupancy_goal": {"vgl": 0.9}})
    assert cfg["calm"]["daily_down"] == 0.04 and cfg["weekend"]["pct"] == 0.10
    assert cfg["occupancy_goal"]["vgl"] == 0.9 and cfg["_settings_warnings"] == []
