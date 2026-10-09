"""
One-time price reset: pricing_calm_live.py --reset XCV_1,XCV_2
Free dates priced above the plain target (start x weekend x holiday, inside min/max) go straight
down to it. Never raises. Skips today, fully booked, protected and out-of-window dates.
"""

import json
import os
import sys
from datetime import date, datetime, timedelta

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_live import http, settings_file, xcv_db, TODAY, NOW  # noqa: E402,F401

import pricing_shadow as ps  # noqa: E402
import pricing_calm_live as live  # noqa: E402

SETTINGS = {"room_types": {"XCV_1": {"engine": "live", "window_days": 30},
                           "XCV_2": {"engine": "live", "window_days": 30},
                           "VGL_ST": {"engine": "live", "window_days": 30}}}


def db_with_vgl():
    db = xcv_db()
    r = db.store["pricing_config"]["engine_v2"]["rules"]
    r["VGL_ST"] = r["XCV_1"]
    return db


def minihotel(gel=lambda i: 150, eur=lambda i: 60, sold=(), asked=None):
    def get(url, params=None, headers=None, timeout=None):
        if asked is not None:
            asked.append(params["rooms"])
        out = []
        for rt in params["rooms"].split(","):
            dates = []
            for i in range(91):
                ds = (TODAY + timedelta(days=i)).isoformat()
                rates = []
                if gel(i):
                    rates.append({"PriceList": "GEL", "Price": gel(i)})
                if eur(i):
                    rates += [{"PriceList": "EUR", "Price": eur(i)}, {"PriceList": "*ALL", "Price": eur(i)}]
                dates.append({"Date": ds + "T00:00:00", "Availability": "",
                              "DefaultAvailability": 0 if i in sold else 1, "Rates": rates})
            out.append({"RoomTypeCode": rt, "Dates": dates})

        class R:
            def raise_for_status(self):
                pass

            def json(self):
                return out
        return R()
    return get


def target(ds, start, step):
    wk = 0.08 if date.fromisoformat(ds).weekday() in (4, 5) else 0.0
    return round(start * (1 + wk) / step) * step


def posts(http):
    return [b for m, u, b in http if m == "POST" and u.endswith("/api/ScreenA")]


def written(http):
    out = {}
    for payload in posts(http):
        for x in payload:
            for d in x["Dates"]:
                for r in d["Rates"]:
                    out[(x["roomTypeCode"], d["Date"].split("T")[0], r["PriceList"])] = r["Price"]
    return out


def test_goes_straight_to_target_ignoring_daily_limits(http, settings_file):
    settings_file(SETTINGS)
    res = live.main(["--reset", "XCV_1,XCV_2"], db=db_with_vgl(), get=minihotel(), cookie_fn=lambda: "c", now=NOW)
    w = written(http)
    assert w
    for (rt, ds, pl), price in w.items():
        if pl == "GEL":
            assert price == target(ds, 110, 5)            # 150 -> ~110: far more than the daily limit
        elif pl == "EUR":
            assert price == target(ds, 42, 1)
    assert res["report"]["all_ok"]


def test_never_raises_and_leaves_prices_below_target_alone(http, settings_file):
    settings_file(SETTINGS)
    # even days: below target (90 GEL / 36 EUR); odd days: above (150 / 60); day 3: below the minimum
    gel = lambda i: 70 if i == 3 else (90 if i % 2 == 0 else 150)
    eur = lambda i: 20 if i == 3 else (36 if i % 2 == 0 else 60)
    live.main(["--reset", "XCV_1,XCV_2"], db=db_with_vgl(), get=minihotel(gel, eur), cookie_fn=lambda: "c", now=NOW)
    w = written(http)
    for (rt, ds, pl), price in w.items():
        i = (date.fromisoformat(ds) - TODAY).days
        assert i % 2 == 1 and i != 3, f"{ds} must not be written"
        assert price < (150 if pl == "GEL" else 60)
        assert (85 <= price <= 140) if pl == "GEL" else (32 <= price <= 53)


def test_skips_today_full_protected_and_outside_the_window(http, settings_file):
    settings_file({**SETTINGS, "date_rules": [{"from": "2026-10-12", "to": "2026-10-13", "rooms": "all",
                                               "action": "protect", "note": "keep"}]})
    live.main(["--reset", "XCV_1,XCV_2"], db=db_with_vgl(), get=minihotel(sold=(4,)), cookie_fn=lambda: "c", now=NOW)
    dates = {ds for (rt, ds, pl) in written(http)}
    assert TODAY.isoformat() not in dates                        # today
    assert (TODAY + timedelta(days=4)).isoformat() not in dates  # fully booked
    assert "2026-10-12" not in dates and "2026-10-13" not in dates
    assert max(dates) <= (TODAY + timedelta(days=30)).isoformat()
    assert (TODAY + timedelta(days=1)).isoformat() in dates


def test_other_room_types_are_never_read_written_or_saved(http, settings_file):
    settings_file(SETTINGS)
    asked, db = [], db_with_vgl()
    db.collection("pricing_engine_state").document("live_VGL_ST").set({"data": {"x": 1}, "ts": "old"})
    live.main(["--reset", "XCV_1,XCV_2"], db=db, get=minihotel(asked=asked), cookie_fn=lambda: "c", now=NOW)
    assert asked == ["XCV_1,XCV_2"]
    assert {rt for (rt, ds, pl) in written(http)} == {"XCV_1", "XCV_2"}
    assert db.store["pricing_engine_state"]["live_VGL_ST"]["ts"] == "old"
    assert "live_XCV_1" in db.store["pricing_engine_state"]


def test_only_xcv_can_be_named(http, settings_file):
    settings_file(SETTINGS)
    for bad in ("VGL_ST", "MAXELA", "XCV_1,ROOMS", ""):
        with pytest.raises(SystemExit):
            live.main(["--reset", bad], db=db_with_vgl(), get=minihotel(), cookie_fn=lambda: "c", now=NOW)
    assert not posts(http)


def test_dry_and_paused_write_and_save_nothing(http, settings_file):
    settings_file(SETTINGS)
    db = db_with_vgl()
    before = json.dumps(db.store, sort_keys=True, default=str)
    res = live.main(["--reset", "XCV_1,XCV_2", "--dry"], db=db, get=minihotel(), cookie_fn=lambda: "c", now=NOW)
    assert res["payload"] and not posts(http)
    assert json.dumps(db.store, sort_keys=True, default=str) == before
    db.collection("pricing_config").document("control").set({"paused": True})
    res = live.main(["--reset", "XCV_1,XCV_2"], db=db, get=minihotel(), cookie_fn=lambda: "c", now=NOW)
    assert not res["sent"] and not posts(http)
    assert "pricing_engine_state" not in db.store


def test_reset_is_remembered_and_does_not_use_up_the_lowering_run(http, settings_file):
    settings_file(SETTINGS)
    db = db_with_vgl()
    res = live.main(["--reset", "XCV_1,XCV_2"], db=db, get=minihotel(), cookie_fn=lambda: "c", now=NOW)
    assert not res["main_run"]
    st = db.store["pricing_engine_state"]
    assert "last_main_day" not in (st["live_XCV_1"] and st.get("live__meta", {"data": {}})["data"])
    ds = (TODAY + timedelta(days=1)).isoformat()
    cell = st["live_XCV_1"]["data"][ds]["GEL"]
    assert cell["last_engine"] == target(ds, 110, 5) and cell["moves"] and cell["last_change_dir"] == -1


def test_empty_dates_are_not_filled_by_a_reset(http, settings_file):
    settings_file(SETTINGS)
    gel = lambda i: 0 if i in (6, 7) else 150
    live.main(["--reset", "XCV_1,XCV_2"], db=db_with_vgl(), get=minihotel(gel), cookie_fn=lambda: "c", now=NOW)
    dates = {ds for (rt, ds, pl) in written(http) if pl == "GEL"}
    assert (TODAY + timedelta(days=6)).isoformat() not in dates
    assert (TODAY + timedelta(days=7)).isoformat() not in dates


def test_a_normal_run_is_not_changed_by_the_reset_code(http, settings_file):
    settings_file(SETTINGS)
    res = live.main(["--dry"], db=db_with_vgl(), get=minihotel(), cookie_fn=lambda: "c", now=NOW)
    assert not any(d["kind"] == "reset" for d in res["decisions"])
