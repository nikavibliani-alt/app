"""
Live runner (pricing_calm_live.py) with a fake MiniHotel and a fake Firestore.
Every HTTP request goes through the real requests library down to the transport,
which is replaced, so the write guard is exercised for real.
"""

import json
import os
import sys
from datetime import datetime, date, timedelta

import pytest
import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_shadow_script import FakeDB, fake_minihotel, ROOT  # noqa: E402

import pricing_shadow as ps  # noqa: E402
import pricing_calm_live as live  # noqa: E402

TODAY = date(2026, 10, 7)
NOW = datetime(2026, 10, 7, 9, 5)


@pytest.fixture
def http(monkeypatch):
    sent = []

    def send(self, req, **k):
        body = json.loads(req.body) if req.body else None
        sent.append((req.method, req.url, body))
        r = requests.Response()
        r.status_code = 200
        r._content = b"{}"
        r.url = req.url
        return r
    monkeypatch.setattr(requests.adapters.HTTPAdapter, "send", send)
    return sent


@pytest.fixture
def settings_file(tmp_path, monkeypatch):
    def make(data):
        p = tmp_path / "calm_settings.json"
        p.write_text(json.dumps(data))
        monkeypatch.setattr(ps, "SETTINGS_FILE", str(p))
    return make


def xcv_db(price_rules=True):
    db = FakeDB()
    if price_rules:
        db.collection("pricing_config").document("engine_v2").set({"rules": {
            rt: {"GEL": {s: {"min": 85, "start": 110, "max": 140} for s in ps.SEASONS},
                 "USD": {s: {"min": 32, "start": 42, "max": 53} for s in ps.SEASONS}}
            for rt in ("XCV_1", "XCV_2")}})
    return db


LIVE = {"room_types": {"XCV_1": {"engine": "live"}, "XCV_2": {"engine": "live"}}}


def xcv_minihotel(price_gel=200, price_eur=60, sold=()):
    def get(url, params=None, headers=None, timeout=None):
        out = []
        for rt in params["rooms"].split(","):
            dates = []
            for i in range(91):
                ds = (TODAY + timedelta(days=i)).isoformat()
                dates.append({"Date": ds + "T00:00:00", "Availability": "",
                              "DefaultAvailability": 0 if i in sold else 1,
                              "Rates": [{"PriceList": "GEL", "Price": price_gel},
                                        {"PriceList": "EUR", "Price": price_eur},
                                        {"PriceList": "*ALL", "Price": price_eur}]})
            out.append({"RoomTypeCode": rt, "Dates": dates})

        class R:
            def raise_for_status(self):
                pass

            def json(self):
                return out
        return R()
    return get


def test_live_writes_only_xcv_with_the_current_engine_format(http, settings_file):
    settings_file(LIVE)
    db = xcv_db()
    res = live.main([], db=db, get=xcv_minihotel(), cookie_fn=lambda: "c", now=NOW)
    writes = [b for m, u, b in http if m == "POST" and u.endswith("/api/ScreenA")]
    assert len(writes) == 1
    payload = writes[0]
    assert {x["roomTypeCode"] for x in payload} == {"XCV_1", "XCV_2"}
    rates = payload[0]["Dates"][1]["Rates"]
    lists = {r["PriceList"]: r["Price"] for r in rates}
    assert lists["GEL"] == 140 and lists["EUR"] == 53 and lists["*ALL"] == 53   # 200 above max 140: brought to max
    pushes = sorted(u.split("Portal=")[1] for m, u, b in http if "SendPrices" in u)
    assert pushes == ["AIRBNB", "BOOKING"]
    assert "live_XCV_1" in db.store["pricing_engine_state"]
    assert "pricing_calm_runs" in db.store and res["sent"]


def test_room_types_of_the_current_engine_can_never_go_live(http, settings_file):
    settings_file({"room_types": {"MAXELA": {"engine": "live"}, "ROOMS": {"engine": "live"}}})
    db = xcv_db()
    db.store["pricing_config"]["engine_v2"]["rules"]["MAXELA"] = db.store["pricing_config"]["engine_v2"]["rules"]["XCV_1"]
    res = live.main([], db=db, get=xcv_minihotel(), cookie_fn=lambda: "c", now=NOW)
    assert res["writes"] == [] and not [h for h in http if h[0] == "POST"]


def test_paused_writes_nothing(http, settings_file):
    settings_file(LIVE)
    db = xcv_db()
    db.collection("pricing_config").document("control").set({"paused": True})
    res = live.main([], db=db, get=xcv_minihotel(), cookie_fn=lambda: "c", now=NOW)
    assert res["writes"] and not res["sent"]
    assert not [h for h in http if h[0] == "POST"]
    assert "pricing_engine_state" not in db.store            # memory not saved
    run_doc = next(iter(db.store["pricing_calm_runs"].values()))
    assert run_doc["paused"] is True


def test_dry_run_writes_and_saves_nothing(http, settings_file):
    settings_file(LIVE)
    db = xcv_db()
    before = json.dumps(db.store, sort_keys=True, default=str)
    res = live.main(["--dry"], db=db, get=xcv_minihotel(), cookie_fn=lambda: "c", now=NOW)
    assert res["payload"] and not [h for h in http if h[0] == "POST"]
    assert json.dumps(db.store, sort_keys=True, default=str) == before


def test_guard_refuses_other_room_types_and_other_writes(http):
    with live.LiveWriteGuard({"XCV_1", "MAXELA"}):        # MAXELA is dropped from the allowed set
        for body in ([{"roomTypeCode": "MAXELA", "Dates": []}], [{"roomTypeCode": "XCV_1"}, {"roomTypeCode": "ROOMS"}]):
            with pytest.raises(RuntimeError):
                requests.post("https://ssl20.minihotelpms.com/api/ScreenA", json=body)
        with pytest.raises(RuntimeError):
            requests.Session().put("https://ssl20.minihotelpms.com/api/ScreenA", json=[])
        with pytest.raises(RuntimeError):
            requests.post("https://ssl20.minihotelpms.com/api/Reservations", json={})
        requests.post("https://ssl20.minihotelpms.com/api/ScreenA", json=[{"roomTypeCode": "XCV_1", "Dates": []}])
        requests.post("https://ssl20.minihotelpms.com/api/ScreenA/Portals/SendPrices?Portal=BOOKING", json={})
        requests.post("https://login.minihotel.cloud/login.aspx", data={})
    assert len(http) == 3


def test_failed_write_saves_no_memory(settings_file, monkeypatch):
    settings_file(LIVE)
    db = xcv_db()

    def send(self, req, **k):
        r = requests.Response()
        r.status_code = 500
        r.url = req.url
        r._content = b"error"
        return r
    monkeypatch.setattr(requests.adapters.HTTPAdapter, "send", send)
    with pytest.raises(requests.HTTPError):
        live.main([], db=db, get=xcv_minihotel(), cookie_fn=lambda: "c", now=NOW)
    assert "pricing_engine_state" not in db.store


def test_protected_new_year_is_not_written(http, settings_file):
    settings_file({**LIVE, "date_rules": [{"from": "2026-10-20", "to": "2026-10-25", "rooms": "all",
                                           "action": "protect", "note": "New Year"}]})
    db = xcv_db()
    live.main([], db=db, get=xcv_minihotel(), cookie_fn=lambda: "c", now=NOW)
    payload = [b for m, u, b in http if m == "POST" and u.endswith("/api/ScreenA")][0]
    dates = {d["Date"] for x in payload for d in x["Dates"]}
    assert dates and not any("2026-10-20" <= d <= "2026-10-25" for d in dates)


def test_no_prices_set_means_nothing_happens(http, settings_file):
    settings_file(LIVE)
    res = live.main([], db=xcv_db(price_rules=False), get=xcv_minihotel(), cookie_fn=lambda: "c", now=NOW)
    assert res["writes"] == [] and not http


def test_shadow_leaves_live_room_types_to_the_live_engine(settings_file):
    settings_file(LIVE)
    db = xcv_db()
    asked = []
    ps.main(["--print"], db=db, get=fake_minihotel(TODAY, asked=asked), cookie_fn=lambda: "c", now=NOW)
    assert "XCV_1" not in asked[0] and "MAXELA" in asked[0]


def test_second_day_moves_within_daily_limit(http, settings_file):
    settings_file(LIVE)
    db = xcv_db()
    live.main([], db=db, get=xcv_minihotel(), cookie_fn=lambda: "c", now=NOW)        # 200 -> 140 (max)
    http.clear()
    live.main([], db=db, get=xcv_minihotel(140, 53), cookie_fn=lambda: "c", now=NOW + timedelta(days=1))
    payload = [b for m, u, b in http if m == "POST" and u.endswith("/api/ScreenA")]
    day2 = TODAY + timedelta(days=1)
    for x in (payload[0] if payload else []):
        for d in x["Dates"]:
            out = (date.fromisoformat(d["Date"]) - day2).days
            lim = 0.15 if out <= 3 else 0.05          # last 3 days walk to the minimum faster
            for r in d["Rates"]:
                if r["PriceList"] == "GEL" and out >= 61:
                    assert 85 <= r["Price"] <= 120, d    # far dates go straight to the target (110 / weekend 120)
                elif r["PriceList"] == "GEL":
                    assert 140 * (1 - lim) - 0.01 <= r["Price"] <= 140, d



def xcv_minihotel_days():
    """Like xcv_minihotel, but returns as many days as asked for (dateFrom..dateTo)."""
    asked = []

    def get(url, params=None, headers=None, timeout=None):
        f, t = params["dateFrom"], params["dateTo"]
        d0 = date(int(f[:4]), int(f[4:6]), int(f[6:]))
        d1 = date(int(t[:4]), int(t[4:6]), int(t[6:]))
        asked.append((d1 - d0).days)
        out = []
        for rt in params["rooms"].split(","):
            dates = []
            d = d0
            while d <= d1:
                dates.append({"Date": d.isoformat() + "T00:00:00", "Availability": "", "DefaultAvailability": 1,
                              "Rates": [{"PriceList": "GEL", "Price": 200}, {"PriceList": "EUR", "Price": 60}]})
                d += timedelta(days=1)
            out.append({"RoomTypeCode": rt, "Dates": dates})

        class R:
            def raise_for_status(self):
                pass

            def json(self):
                return out
        return R()
    return get, asked


def test_how_far_ahead_is_set_per_room_type(http, settings_file):
    settings_file({"room_types": {"XCV_1": {"engine": "live", "window_days": 365},
                                  "XCV_2": {"engine": "live", "window_days": 5000}}})
    get, asked = xcv_minihotel_days()
    res = live.main(["--dry"], db=xcv_db(), get=get, cookie_fn=lambda: "c", now=NOW)
    assert asked == [365]
    last = {rt: max(d["days_out"] for d in res["decisions"] if d["rt"] == rt) for rt in ("XCV_1", "XCV_2")}
    assert last["XCV_1"] == 365 and last["XCV_2"] == 90          # 5000 is not allowed: 90 used
    assert res["ok"], res["alerts"]


def test_whole_year_far_dates_move_only_a_little(http, settings_file):
    settings_file({"room_types": {"XCV_1": {"engine": "live", "window_days": 365}}})
    db = xcv_db()
    for rt in ("XCV_1",):
        for c, (mn, st, mx) in (("GEL", (85, 110, 250)), ("USD", (32, 42, 90))):
            for s_ in ps.SEASONS:
                db.store["pricing_config"]["engine_v2"]["rules"][rt][c][s_] = {"min": mn, "start": st, "max": mx}
    get, _ = xcv_minihotel_days()
    res = live.main(["--dry"], db=db, get=get, cookie_fn=lambda: "c", now=NOW)
    for d in res["decisions"]:
        if d["rt"] == "XCV_1" and d["days_out"] > 61 and d["target"] is not None and d["currency"] == "GEL":
            assert 110 * 0.97 - 1 <= d["target"] <= 110 * 1.08 * 1.08 + 1, d



def vgl_like_minihotel(priced_days=70):
    """Prices only for the first `priced_days` days (like VGL today); free units everywhere."""
    def get(url, params=None, headers=None, timeout=None):
        f, t = params["dateFrom"], params["dateTo"]
        d0 = date(int(f[:4]), int(f[4:6]), int(f[6:]))
        d1 = date(int(t[:4]), int(t[4:6]), int(t[6:]))
        out = []
        for rt in params["rooms"].split(","):
            dates, d = [], d0
            while d <= d1:
                priced = (d - d0).days < priced_days
                rates = [{"PriceList": "GEL", "Price": 160}, {"PriceList": "EUR", "Price": 40}] if priced else []
                dates.append({"Date": d.isoformat() + "T00:00:00", "Availability": "", "DefaultAvailability": 1,
                              "Rates": rates})
                d += timedelta(days=1)
            out.append({"RoomTypeCode": rt, "Dates": dates})

        class R:
            def raise_for_status(self):
                pass

            def json(self):
                return out
        return R()
    return get


def test_empty_dates_get_a_first_price_from_start(http, settings_file):
    settings_file({"room_types": {"XCV_1": {"engine": "live", "window_days": 180}}})
    res = live.main([], db=xcv_db(), get=vgl_like_minihotel(70), cookie_fn=lambda: "c", now=NOW)
    assert res["ok"] and not res["stopped_room_types"], res["alerts"]
    payload = [b for m, u, b in http if m == "POST" and u.endswith("/api/ScreenA")][0]
    by_date = {d["Date"]: {r["PriceList"]: r["Price"] for r in d["Rates"]} for x in payload for d in x["Dates"]}
    far = (TODAY + timedelta(days=120)).isoformat()
    assert far in by_date
    assert 85 <= by_date[far]["GEL"] <= 140 and 32 <= by_date[far]["EUR"] <= 53     # inside min and max
    assert abs(by_date[far]["GEL"] - 110) <= 110 * 0.10                              # near your start price
    fills = [d for d in res["decisions"] if d.get("fill")]
    assert fills and all(d["mh_price"] == 0 for d in fills)


def test_no_fill_when_minihotel_prices_look_broken(http, settings_file):
    settings_file({"room_types": {"XCV_1": {"engine": "live", "window_days": 180}}})
    res = live.main([], db=xcv_db(), get=vgl_like_minihotel(0), cookie_fn=lambda: "c", now=NOW)
    assert res["stopped_room_types"] == ["XCV_1"] and res["writes"] == []
    assert not [h for h in http if h[0] == "POST" and h[1].endswith("/api/ScreenA")]


def test_fill_can_be_switched_off(http, settings_file):
    settings_file({"room_types": {"XCV_1": {"engine": "live", "window_days": 180, "fill_missing": False}}})
    res = live.main([], db=xcv_db(), get=vgl_like_minihotel(70), cookie_fn=lambda: "c", now=NOW)
    assert res["stopped_room_types"] == ["XCV_1"]          # 110 of 181 dates without a price: left alone


def test_protected_dates_are_not_filled(http, settings_file):
    settings_file({"room_types": {"XCV_1": {"engine": "live", "window_days": 180}},
                   "date_rules": [{"from": (TODAY + timedelta(days=100)).isoformat(),
                                   "to": (TODAY + timedelta(days=110)).isoformat(),
                                   "rooms": "all", "action": "protect", "note": "New Year"}]})
    live.main([], db=xcv_db(), get=vgl_like_minihotel(70), cookie_fn=lambda: "c", now=NOW)
    payload = [b for m, u, b in http if m == "POST" and u.endswith("/api/ScreenA")][0]
    dates = {d["Date"] for x in payload for d in x["Dates"]}
    for k in range(100, 111):
        assert (TODAY + timedelta(days=k)).isoformat() not in dates
