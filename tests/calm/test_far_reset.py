"""
Far dates (61+ days away) that are above their target go straight down to it, live room types only.
"""

import json
import os
import sys
from datetime import date, datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_live import http, settings_file, xcv_db, TODAY, NOW  # noqa: E402,F401
from test_reset import minihotel, written, posts, target  # noqa: E402

import pricing_shadow as ps  # noqa: E402
import pricing_calm_live as live  # noqa: E402

SETTINGS = {"room_types": {"XCV_1": {"engine": "live", "window_days": 90},
                           "XCV_2": {"engine": "live", "window_days": 90}}}
NIGHT = datetime(2026, 10, 7, 4, 3)          # not the lowering run


def day(i):
    return (TODAY + timedelta(days=i)).isoformat()


def run(settings_file, get, now=NOW, args=(), db=None, settings=SETTINGS):
    settings_file(settings)
    db = db or xcv_db()
    res = live.main(list(args), db=db, get=get, cookie_fn=lambda: "c", now=now)
    return res, db


def far_decisions(res):
    return [d for d in res["decisions"] if d["kind"] == "far_reset"]


def test_far_dates_jump_to_target_and_near_dates_do_not(http, settings_file):
    res, _ = run(settings_file, minihotel(gel=lambda i: 130, eur=lambda i: 50))
    w = written(http)
    far = {ds for (rt, ds, pl) in w if (date.fromisoformat(ds) - TODAY).days >= 61}
    assert far, "far dates must be written"
    for (rt, ds, pl), price in w.items():
        out = (date.fromisoformat(ds) - TODAY).days
        if pl == "GEL" and out >= 61:
            assert price == target(ds, 110, 5), (ds, price)       # straight to the target
        elif pl == "GEL" and out > 0:
            assert price >= 130 * 0.85 - 0.01, (ds, price)         # near dates stay under the daily limits
    assert not any(d["days_out"] <= 60 for d in far_decisions(res))
    assert not [d for d in far_decisions(res) if d["days_out"] == 60]
    assert any(d["days_out"] == 61 for d in far_decisions(res))
    near = [d for d in res["decisions"] if d["days_out"] == 60 and d["currency"] == "GEL"][0]
    assert near["kind"] != "far_reset"


def test_nothing_is_ever_raised_by_a_far_reset(http, settings_file):
    res, _ = run(settings_file, minihotel(gel=lambda i: 90, eur=lambda i: 35))     # below target
    assert not far_decisions(res)
    for d in res["decisions"]:
        if d["kind"] != "hold":
            assert d["kind"] in ("move", "correction", "fill", "stopped", "manual", "protected")
    res2, _ = run(settings_file, minihotel(gel=lambda i: 130, eur=lambda i: 50))
    assert all(d["proposed"] < d["current"] and d["min"] <= d["proposed"] <= d["max"] for d in far_decisions(res2))
    assert live.far_reset_problems(res2, {"XCV_1", "XCV_2"}) == []


def test_full_and_protected_dates_are_skipped(http, settings_file):
    s = {**SETTINGS, "date_rules": [{"from": day(65), "to": day(66), "rooms": "all", "action": "protect", "note": "keep"}]}
    run(settings_file, minihotel(gel=lambda i: 130, eur=lambda i: 50, sold=(70,)), settings=s)
    dates = {ds for (rt, ds, pl) in written(http)}
    assert day(70) not in dates and day(65) not in dates and day(66) not in dates
    assert day(67) in dates and day(64) in dates


def test_it_does_not_use_up_the_lowering_run_and_works_in_any_run(http, settings_file):
    res, db = run(settings_file, minihotel(gel=lambda i: 130, eur=lambda i: 50), now=NIGHT)
    assert not res["main_run"] and far_decisions(res)                   # a night run: far dates still jump
    st = db.store["pricing_engine_state"]["live__meta"]["data"] if "live__meta" in db.store["pricing_engine_state"] else {}
    assert "last_main_day" not in st                                     # the day's lowering run is untouched
    http.clear()
    res2, db2 = run(settings_file, minihotel(gel=lambda i: 130, eur=lambda i: 50), now=NOW)
    assert res2["main_run"] and far_decisions(res2)
    near_lowered = [d for d in res2["decisions"] if 4 <= d["days_out"] <= 60 and d["kind"] == "move" and d["proposed"] < d["current"]]
    assert near_lowered, "near dates still get their normal lowering in the lowering run"


def test_memory_and_run_record(http, settings_file):
    res, db = run(settings_file, minihotel(gel=lambda i: 130, eur=lambda i: 50))
    ds = day(70)
    cell = db.store["pricing_engine_state"]["live_XCV_1"]["data"][ds]["GEL"]
    assert cell["last_engine"] == target(ds, 110, 5) and cell["last_change_dir"] == -1 and cell["moves"]
    run_doc = next(iter(db.store["pricing_calm_runs"].values()))
    assert run_doc["far_reset"]["XCV_1"] > 0 and run_doc["far_reset"]["XCV_2"] > 0
    assert run_doc["far_reset"]["XCV_1"] == len([d for d in far_decisions(res) if d["rt"] == "XCV_1"])
    daily = next(v for k, v in db.store["pricing_calm_daily"].items() if k.endswith("_XCV_1"))
    assert any(r["kind"] == "far_reset" for r in daily["dates"].values())


def test_paused_and_dry_write_nothing(http, settings_file):
    settings_file(SETTINGS)
    db = xcv_db()
    before = json.dumps(db.store, sort_keys=True, default=str)
    res = live.main(["--dry"], db=db, get=minihotel(gel=lambda i: 130, eur=lambda i: 50), cookie_fn=lambda: "c", now=NOW)
    assert far_decisions(res) and not posts(http)
    assert json.dumps(db.store, sort_keys=True, default=str) == before
    db.collection("pricing_config").document("control").set({"paused": True})
    res = live.main([], db=db, get=minihotel(gel=lambda i: 130, eur=lambda i: 50), cookie_fn=lambda: "c", now=NOW)
    assert not res["sent"] and not posts(http) and "pricing_engine_state" not in db.store


def test_old_rooms_are_never_touched(http, settings_file):
    s = {"room_types": {**SETTINGS["room_types"], "MAXELA": {"engine": "live"}, "ROOMS": {"engine": "live"}}}
    db = xcv_db()
    db.store["pricing_config"]["engine_v2"]["rules"]["MAXELA"] = db.store["pricing_config"]["engine_v2"]["rules"]["XCV_1"]
    res, _ = run(settings_file, minihotel(gel=lambda i: 130, eur=lambda i: 50), db=db, settings=s)
    assert {rt for (rt, ds, pl) in written(http)} == {"XCV_1", "XCV_2"}
    assert not [d for d in far_decisions(res) if d["rt"] in ps.OLD_ENGINE_RTS]
    # the shadow test never writes and never far-resets
    from test_shadow_script import fake_minihotel, seeded_db
    sres = ps.main(["--print"], db=seeded_db(TODAY), get=fake_minihotel(TODAY), cookie_fn=lambda: "c", now=NOW)
    assert not [d for d in sres["decisions"] if d["kind"] == "far_reset"] and sres["writes"] == []
