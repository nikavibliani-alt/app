"""Cancellation (urgent) runs on the new engine: only the named rooms and nights, no push when nothing changed."""

import json
import os
import sys
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_move_old import http, minihotel, prices_near_start, TODAY, NOW, SIX  # noqa: E402,F401
from test_shadow_script import FakeDB  # noqa: E402
from test_holiday import mkcfg, inv_of, D  # noqa: E402

import pricing_calm_live as live  # noqa: E402
import pricing_shadow as ps  # noqa: E402
import minihotel_reservation_sync as sync  # noqa: E402
from calm_pricing import run  # noqa: E402


def too_high(rt):
    """MAXELA is priced far over its maximum everywhere, so every night needs a correction; other rooms are normal."""
    return (999, None) if rt == "MAXELA" else prices_near_start(rt)


def urgent(rooms, dates, db=None, http_=None, extra=(), prices=too_high):
    return live.main(["--urgent", "--rooms", rooms, "--dates", ",".join(dates), *extra], db=db or FakeDB(),
                     get=minihotel(prices), cookie_fn=lambda: "c", now=NOW)


def price_writes(http_):
    return [b for m, u, b in http_ if m == "POST" and u.endswith("/api/ScreenA")]


def pushes(http_):
    return sorted(u.split("Portal=")[1] for m, u, b in http_ if "SendPrices" in u)


DAYS = [(TODAY + timedelta(days=k)).isoformat() for k in (3, 4, 5)]


def test_only_the_named_room_and_nights_are_repriced_and_only_its_channels_are_pushed(http):
    db = FakeDB()
    res = urgent("MAXELA", DAYS, db)
    w = price_writes(http)
    assert res["ok"]
    assert len(w) == 1 and [x["roomTypeCode"] for x in w[0]] == ["MAXELA"]
    nights = {d["Date"][:10] for x in w[0] for d in x["Dates"]}
    assert nights == set(DAYS), nights                                  # exactly the cancelled nights, not the other 85
    assert pushes(http) == ["BOOKING", "EXPEDIA"]                       # MAXELA's channels only (not Airbnb)
    st = db.store["pricing_engine_state"]
    assert "live_MAXELA" in st and "live_ROOMS" not in st             # other rooms are not saved
    run_doc = list(db.store["pricing_calm_runs"].values())[-1]
    assert run_doc["urgent"] is True and run_doc["urgent_rooms"] == ["MAXELA"] and run_doc["main_run"] is False
    daily = db.store["pricing_calm_daily"][f"{TODAY.isoformat()}_MAXELA"]["dates"]
    assert {k.split("|")[0] for k in daily} <= set(DAYS)


def test_a_cancellation_run_never_uses_up_the_morning_lowering_run(http):
    db = FakeDB()
    late = NOW.replace(hour=10)                                          # after 09:00: a normal run would be the main run
    live.main(["--urgent", "--rooms", "MAXELA", "--dates", DAYS[0]], db=db, get=minihotel(too_high), cookie_fn=lambda: "c", now=late)
    meta = (db.store.get("pricing_engine_state", {}).get("live__meta") or {}).get("data", {})
    assert meta.get("last_main_day") != late.date().isoformat()
    # the next normal run that morning still is the main run
    res = live.main([], db=db, get=minihotel(too_high), cookie_fn=lambda: "c", now=late + timedelta(minutes=30))
    assert res["main_run"] is True


def test_nothing_to_do_means_no_write_and_no_push(http):
    assert urgent("MAXELA", ["2020-01-01"], FakeDB())["writes"] == []              # only past nights
    assert urgent("NOPE", DAYS, FakeDB())["writes"] == []                           # not a live room
    assert urgent("XCV_1", [], FakeDB())["writes"] == []
    assert price_writes(http) == [] and pushes(http) == []


def test_pause_switch_still_wins_in_an_urgent_run(http):
    db = FakeDB()
    db.collection("pricing_config").document("control").set({"paused": True})
    res = urgent("MAXELA", DAYS, db)
    assert res["sent"] is False and price_writes(http) == [] and pushes(http) == []


def test_dry_run_prints_and_sends_nothing(http, capsys):
    res = urgent("MAXELA", DAYS, extra=("--dry",))
    out = capsys.readouterr().out
    assert res["sent"] is False and "Cancellation run: rooms ['MAXELA']" in out and "Dry run" in out
    assert price_writes(http) == [] and pushes(http) == []


# ---------------- the engine itself ----------------

def raw_run(cfg, inv, now, **snap):
    return run({"now": now, "inventory": {"X": inv}, "reservations": [], **snap}, cfg, {})


def test_urgent_only_touches_its_nights_and_a_single_big_move_does_not_stop_the_run():
    cfg = mkcfg(1, mn=150, start=230, mx=300, holiday=False)
    cfg["safety"]["max_share_changed"] = 0.4
    inv = inv_of(1, 100)                                                  # far below the minimum everywhere: corrections
    now = datetime.combine(TODAY, datetime.min.time()) + timedelta(hours=13)
    full = raw_run(cfg, inv, now)
    assert any(d["kind"] == "correction" for d in full["decisions"])
    res = raw_run(cfg, inv, now, run_kind="update", only={"rooms": ["X"], "dates": [D(5)]})
    assert res["ok"] and [d["date"] for d in res["decisions"]] == [D(5)]
    assert [w["date"] for w in res["writes"]] == [D(5)] and res["writes"][0]["price"] >= 150      # min/max still win
    assert set(res["state"]["X"]) == {D(5)}                                # no memory is created for the other nights


def test_urgent_keeps_protect_and_hold_and_the_holiday_rule():
    cfg = mkcfg(1, mn=150, start=230, mx=300, rules=[{"from": D(5), "to": D(5), "rooms": "all", "action": "protect"}])
    cfg["date_overrides"] = [{"from": "10-23", "to": "10-30", "season": "high"}]            # holiday nights 16..23 days out
    inv = inv_of(1, 200)
    now = datetime.combine(TODAY, datetime.min.time()) + timedelta(hours=13)
    res = raw_run(cfg, inv, now, run_kind="update", only={"rooms": ["X"], "dates": [D(5), D(18)]})
    by = {d["date"]: d for d in res["decisions"]}
    assert by[D(5)]["kind"] == "protected" and by[D(5)]["proposed"] == by[D(5)]["current"]
    assert by[D(18)].get("holiday") and by[D(18)]["proposed"] <= 200 * 1.03 + 1e-6      # holiday night: small moves only


def test_an_urgent_run_cannot_lower_but_can_raise():
    cfg = mkcfg(1, mn=150, start=230, mx=300, holiday=False)
    now = datetime.combine(TODAY, datetime.min.time()) + timedelta(hours=13)
    high = raw_run(cfg, inv_of(1, 290), now, run_kind="update", only={"rooms": ["X"], "dates": [D(5)]})
    assert high["decisions"][0]["proposed"] >= 290                                   # above target: not lowered in a non-main run
    low = raw_run(cfg, inv_of(1, 160), now, run_kind="update", only={"rooms": ["X"], "dates": [D(5)]})
    assert low["decisions"][0]["proposed"] >= 160


# ---------------- the trigger in the reservation sync ----------------

def test_the_sync_names_every_room_type_and_every_freed_night():
    p = sync.ROOM_TO_PROPERTY
    assert p["xcv-1"] == "XCV_1" and p["xcv-2"] == "XCV_2" and p["vgl-st1"] == "VGL_ST" and p["vgl-ap3"] == "VGL_AP"
    assert p["6-1"] == "MAXELA" and p["orb-3"] == "ORBE_2"
    today = TODAY
    c = [{"checkin": (today + timedelta(days=2)).isoformat(), "checkout": (today + timedelta(days=5)).isoformat(), "property_type": "MAXELA"},
         {"checkin": (today - timedelta(days=1)).isoformat(), "checkout": (today + timedelta(days=1)).isoformat(), "property_type": "XCV_1"},
         {"checkin": (today + timedelta(days=9)).isoformat(), "property_type": "ROOMS"}]
    props, nights = sync.urgent_inputs(c, today)
    assert props == ["MAXELA", "ROOMS", "XCV_1"]
    want = [(today + timedelta(days=k)).isoformat() for k in (0, 2, 3, 4, 9)]
    assert nights == sorted(want)                                          # nights from today on; check-out night is not freed


# ---------------- a night freed TONIGHT goes straight to the minimum ----------------

def tonight_run(cfg, inv, today_offset=0, only_dates=None, state=None, urgent=True):
    now = datetime.combine(TODAY, datetime.min.time()) + timedelta(hours=15)
    only = {"rooms": ["X"], "dates": only_dates or [D(0)]}
    snap = {"run_kind": "update", "only": only, "tonight_drop": True} if urgent else {}
    return run({"now": now, "inventory": {"X": inv}, "reservations": [], **snap}, cfg, state if state is not None else {})


def test_tonight_goes_straight_to_the_minimum_on_every_currency():
    cfg = mkcfg(1, mn=150, start=230, mx=300, holiday=False)
    res = tonight_run(cfg, inv_of(1, 230))
    d = [x for x in res["decisions"] if x["date"] == D(0)][0]
    assert d["kind"] == "tonight" and d["proposed"] == 150 and d["write"] is True
    assert [(w["date"], w["price"]) for w in res["writes"]] == [(D(0), 150)]
    assert "cancelled" in d["why"][-1] and res["ok"]
    cfg2 = mkcfg(1, mn=150, start=230, mx=300, holiday=False)
    cfg2["room_types"]["X"]["currencies"] = ["GEL", "USD"]
    cfg2["rules"]["X"]["USD"] = cfg2["rules"]["X"]["GEL"]
    inv = {ds: {"avail": 1, "prices": {"GEL": 230, "USD": 230}} for ds in inv_of(1, 230)}
    res2 = tonight_run(cfg2, inv)
    assert sorted((w["currency"], w["price"]) for w in res2["writes"] if w["date"] == D(0)) == [("GEL", 150), ("USD", 150)]


def test_a_freed_future_night_is_not_lowered_by_the_urgent_run():
    cfg = mkcfg(1, mn=150, start=230, mx=300, holiday=False)
    res = tonight_run(cfg, inv_of(1, 290), only_dates=[D(5), D(6)])
    assert all(w["price"] >= 290 for w in res["writes"]) and all(d["kind"] != "tonight" for d in res["decisions"])
    assert not any(d["date"] == D(0) for d in res["decisions"])                      # tonight was not named: not looked at


def test_protect_hold_and_holiday_win_over_the_tonight_drop():
    inv = inv_of(1, 230)
    protect = mkcfg(1, mn=150, start=230, mx=300, holiday=False, rules=[{"from": D(0), "to": D(0), "rooms": "all", "action": "protect"}])
    assert tonight_run(protect, inv)["writes"] == []
    hold = mkcfg(1, mn=150, start=230, mx=300, holiday=False, rules=[{"from": D(0), "to": D(0), "rooms": "all", "action": "hold"}])
    r = tonight_run(hold, inv)
    assert all(d["kind"] != "tonight" for d in r["decisions"]) and not [w for w in r["writes"] if w["price"] == 150]
    hol = mkcfg(1, mn=150, start=230, mx=300)
    hol["date_overrides"] = [{"from": "10-01", "to": "10-20", "season": "high"}]          # tonight is a holiday date
    r = tonight_run(hol, inv)
    assert all(d["kind"] != "tonight" for d in r["decisions"]) and not [w for w in r["writes"] if w["price"] == 150]


def test_a_hand_set_price_and_a_price_at_the_minimum_are_left_alone_tonight():
    cfg = mkcfg(1, mn=150, start=230, mx=300, holiday=False)
    state = {"X": {D(0): {"GEL": {"last_engine": 200.0}}}}                          # MiniHotel shows 230: set by hand
    r = tonight_run(cfg, inv_of(1, 230), state=state)
    d = [x for x in r["decisions"] if x["date"] == D(0)][0]
    assert d["kind"] == "manual" and r["writes"] == []
    r2 = tonight_run(cfg, inv_of(1, 150))
    assert r2["writes"] == [] and "already at your minimum" in [x for x in r2["decisions"] if x["date"] == D(0)][0]["why"][-1]


def test_a_normal_run_never_does_the_tonight_drop():
    cfg = mkcfg(1, mn=150, start=230, mx=300, holiday=False)
    res = tonight_run(cfg, inv_of(1, 230), urgent=False)
    assert all(d["kind"] != "tonight" for d in res["decisions"]) and not [w for w in res["writes"] if w["date"] == D(0) and w["price"] == 150]


def test_runner_tonight_cancellation_writes_the_minimum_and_pushes_the_rooms_channels(http):
    rules, _ = ps.load_rules(FakeDB(), json.load(open(os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "config.json"))))
    mn = rules["MAXELA"]["GEL"]["mid"]["min"]
    db = FakeDB()
    res = live.main(["--urgent", "--rooms", "MAXELA", "--dates", f"{TODAY.isoformat()},{DAYS[0]}"], db=db, get=minihotel(prices_near_start),
                    cookie_fn=lambda: "c", now=NOW)
    w = price_writes(http)
    assert w and [x["roomTypeCode"] for x in w[0]] == ["MAXELA"]
    tonight = [d for x in w[0] for d in x["Dates"] if d["Date"][:10] == TODAY.isoformat()]
    assert tonight and {r["Price"] for r in tonight[0]["Rates"]} == {mn}                     # tonight at the minimum
    assert pushes(http) == ["BOOKING", "EXPEDIA"]
