"""
The six old rooms (ROOMS, MAXELA, BIG_APT, FREEDOM, ORBE_1, ORBE_2) moved to the new engine:
never on both engines, same channels and price lists as the old engine, the Expedia push, safe housekeeping run.
"""

import json
import os
import sys
from datetime import datetime, timedelta

import pytest
import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_live import http, TODAY, NOW  # noqa: E402,F401
from test_shadow_script import FakeDB, ROOT  # noqa: E402

import pricing_calm_live as live  # noqa: E402
import pricing_engine as old  # noqa: E402
import pricing_shadow as ps  # noqa: E402

SIX = ["ROOMS", "MAXELA", "BIG_APT", "FREEDOM", "ORBE_1", "ORBE_2"]
FILE = json.load(open(os.path.join(ROOT, "calm_settings.json")))
CONFIG = json.load(open(os.path.join(ROOT, "config.json")))


def old_portals(rt):
    m = old.CHANNEL_MATRIX[rt]
    return [p for p, k in (("BOOKING", "booking"), ("EXPEDIA", "expedia"), ("AIRBNB", "airbnb")) if m.get(k)]


def test_no_room_is_on_both_engines():
    assert old.ROOM_TYPES == [] and ps.OLD_ENGINE_RTS == set()
    for rt in SIX:
        assert FILE["room_types"][rt]["engine"] == "live"
    assert not (set(old.ROOM_TYPES) & {rt for rt, v in FILE["room_types"].items() if v.get("engine") == "live"})


def test_settings_file_matches_the_old_engine_channels_and_price_lists():
    for rt in SIX:
        f = FILE["room_types"][rt]
        assert f["style"] == "normal" and f["window_days"] == 90, rt
        assert f["portals"] == old_portals(rt), rt                      # same channels as the old engine
        m = old.CHANNEL_MATRIX[rt]
        want = (["GEL"] if (m["booking"] or m["expedia"]) else []) + (["USD"] if m["airbnb"] else [])
        assert ps.ROOM_TYPES[rt]["currencies"] == want, rt              # same price lists as the old engine
    assert [rt for rt in SIX if "EXPEDIA" in FILE["room_types"][rt]["portals"]] == ["ROOMS", "MAXELA", "BIG_APT", "FREEDOM"]
    for rt in ("XCV_1", "XCV_2", "VGL_ST", "VGL_AP"):                   # the rooms that were already live are unchanged
        assert FILE["room_types"][rt]["portals"] == ["BOOKING", "AIRBNB"] and "EXPEDIA" not in FILE["room_types"][rt]["portals"]


def real_rules(db=None):
    return ps.load_rules(db or FakeDB(), CONFIG)


def test_the_six_are_live_with_their_own_settings():
    rules, settings = real_rules()
    rts = live.live_room_types(rules, settings)
    for rt in SIX:
        assert rt in rts, rt
        assert rts[rt]["status"] == "live" and rts[rt]["style"] == "normal" and rts[rt]["window_days"] == 90
        assert rts[rt]["portals"] == old_portals(rt)


def test_portals_for_and_the_expedia_push_follow_the_rooms_that_changed():
    rules, settings = real_rules()
    rts = live.live_room_types(rules, settings)
    rts["XCV_1"] = {**rts["ROOMS"], "portals": FILE["room_types"]["XCV_1"]["portals"]}      # XCV/VGL prices live in engine_v2 rules
    w = lambda *names: [{"rt": n, "date": "2026-10-20", "currency": "GEL", "price": 100} for n in names]
    assert live.portals_to_push(w("ROOMS"), rts) == ["BOOKING", "EXPEDIA"]
    assert live.portals_to_push(w("ORBE_2"), rts) == ["AIRBNB"]
    assert live.portals_to_push(w("ORBE_1"), rts) == ["BOOKING", "AIRBNB"]
    assert live.portals_to_push(w("XCV_1"), rts) == ["BOOKING", "AIRBNB"]          # VGL/XCV never push Expedia
    assert live.portals_to_push(w("MAXELA", "XCV_1"), rts) == ["BOOKING", "EXPEDIA", "AIRBNB"]
    assert live.portals_to_push([], rts) == []
    assert live.portals_for({"portals": ["expedia", "nonsense"]}, "X") == ["EXPEDIA"]
    assert live.portals_for({"portals": ["nonsense"]}, "X") == ["BOOKING", "AIRBNB"]
    assert live.portals_for({}, "X") == ["BOOKING", "AIRBNB"]


def test_push_channels_calls_the_expedia_portal(http):
    assert live.push_channels(["BOOKING", "EXPEDIA", "AIRBNB"], "c") == []
    assert sorted(u.split("Portal=")[1] for m, u, b in http if "SendPrices" in u) == ["AIRBNB", "BOOKING", "EXPEDIA"]


def minihotel(rooms_price):
    """Fake MiniHotel: every requested room, 91 days, prices from rooms_price(rt) = (gel, eur)."""
    def get(url, params=None, headers=None, timeout=None):
        out = []
        for rt in params["rooms"].split(","):
            g, e = rooms_price(rt)
            dates = []
            for i in range(91):
                ds = (TODAY + timedelta(days=i)).isoformat()
                rates = []
                if g:
                    rates.append({"PriceList": "GEL", "Price": g})
                if e:
                    rates += [{"PriceList": "EUR", "Price": e}, {"PriceList": "*ALL", "Price": e}]
                dates.append({"Date": ds + "T00:00:00", "Availability": "", "DefaultAvailability": ps.ROOM_TYPES[rt]["units"], "Rates": rates})
            out.append({"RoomTypeCode": rt, "Dates": dates})

        class R:
            def raise_for_status(self):
                pass

            def json(self):
                return out
        return R()
    return get


def mid(rt, cur):
    rules, _ = real_rules()
    c = (rules.get(rt) or {}).get(cur) or {}
    return (c.get("mid") or {}).get("start")


def prices_near_start(rt):
    g, e = mid(rt, "GEL"), mid(rt, "USD")
    return (round(g * 1.04) if g else None, round(e * 1.04) if e else None)


def test_six_rooms_on_the_new_engine_write_their_own_price_lists_and_push_expedia(http):
    db = FakeDB()
    res = live.main([], db=db, get=minihotel(prices_near_start), cookie_fn=lambda: "c", now=NOW)
    writes = [b for m, u, b in http if m == "POST" and u.endswith("/api/ScreenA")]
    assert res["ok"] and not res["stopped_room_types"], res["alerts"]
    assert len(writes) == 1
    by_rt = {x["roomTypeCode"]: x for x in writes[0]}
    assert set(by_rt) <= set(SIX) | {"XCV_1", "XCV_2", "VGL_ST", "VGL_AP"}
    for rt in SIX:
        assert rt in by_rt, f"{rt} got no price changes in this scenario"
        lists = {r["PriceList"] for d in by_rt[rt]["Dates"] for r in d["Rates"]}
        want = {"ROOMS": {"GEL"}, "MAXELA": {"GEL"}, "BIG_APT": {"GEL", "EUR", "*ALL"}, "FREEDOM": {"GEL", "EUR", "*ALL"},
                "ORBE_1": {"GEL", "EUR", "*ALL"}, "ORBE_2": {"EUR", "*ALL"}}[rt]
        assert lists == want, (rt, lists)                       # same price lists as the old engine
    pushes = sorted(u.split("Portal=")[1] for m, u, b in http if "SendPrices" in u)
    assert pushes == ["AIRBNB", "BOOKING", "EXPEDIA"] and res["portals"] == ["BOOKING", "EXPEDIA", "AIRBNB"]
    assert all(f"live_{rt}" in db.store["pricing_engine_state"] for rt in SIX)


def test_orbe_2_alone_pushes_only_airbnb(http, monkeypatch, tmp_path):
    f = tmp_path / "calm_settings.json"
    f.write_text(json.dumps({"room_types": {"ORBE_2": FILE["room_types"]["ORBE_2"]}, "date_rules": []}))
    monkeypatch.setattr(ps, "SETTINGS_FILE", str(f))
    res = live.main([], db=FakeDB(), get=minihotel(prices_near_start), cookie_fn=lambda: "c", now=NOW)
    assert res["ok"] and res["writes"] and {w["rt"] for w in res["writes"]} == {"ORBE_2"}
    assert {w["currency"] for w in res["writes"]} == {"USD"}
    assert sorted(u.split("Portal=")[1] for m, u, b in http if "SendPrices" in u) == ["AIRBNB"]


def test_dry_run_prints_the_channels_and_sends_nothing(http, capsys):
    res = live.main(["--dry"], db=FakeDB(), get=minihotel(prices_near_start), cookie_fn=lambda: "c", now=NOW)
    out = capsys.readouterr().out
    assert not [h for h in http if h[0] == "POST"] and not res["sent"]
    assert "Channels it pushes after the write: BOOKING, EXPEDIA, AIRBNB  (not sent)" in out


def test_shadow_run_does_nothing_when_every_room_is_live(http):
    def boom(*a, **k):
        raise AssertionError("the shadow run must not read MiniHotel when nothing is left to test")
    res = ps.main(["--print"], db=FakeDB(), get=boom, cookie_fn=lambda: "c", now=NOW)
    assert res["decisions"] == [] and res["writes"] == []


# ---------------- the old engine script, now without rooms ----------------

def run_old_engine(monkeypatch, argv, urgent=False):
    calls = {"scan": 0, "analyst": 0, "login": 0, "http": 0}
    monkeypatch.setattr(old, "scan_events", lambda: calls.__setitem__("scan", calls["scan"] + 1))
    monkeypatch.setattr(old, "get_session_cookie", lambda: calls.__setitem__("login", calls["login"] + 1) or "c")
    monkeypatch.setattr(old, "claude_write_daily_proposal", lambda c, db, v=None: calls.__setitem__("analyst", calls["analyst"] + 1) or c)
    db = FakeDB()
    monkeypatch.setattr(old, "_firestore_client", lambda: db)
    monkeypatch.setattr(old, "read_paused", lambda: False)
    monkeypatch.setattr(old, "install_write_guard", lambda: None)       # the real one patches requests for the whole process
    monkeypatch.setattr(old, "load_config", lambda path="config.json": dict(CONFIG))
    monkeypatch.setattr(old, "fetch_data", lambda *a, **k: calls.__setitem__("http", calls["http"] + 1))
    monkeypatch.setenv("PRICING_URGENT", "true" if urgent else "false")
    monkeypatch.setattr(sys, "argv", ["pricing_engine.py"] + argv)
    old.main()
    return calls


def test_old_engine_has_no_rooms_to_price_but_still_runs_the_weekly_idea_maker(monkeypatch):
    c = run_old_engine(monkeypatch, ["--apply"])
    assert c == {"scan": 1, "analyst": 1, "login": 0, "http": 0}        # events scanned, ideas made, MiniHotel not touched


def test_old_engine_dry_run_and_urgent_run_do_nothing(monkeypatch):
    assert run_old_engine(monkeypatch, [])["analyst"] == 0
    assert run_old_engine(monkeypatch, ["--apply"], urgent=True) == {"scan": 1, "analyst": 0, "login": 0, "http": 0}


def test_dry_run_report_for_the_six_rooms(http, capsys):
    """The report the owner reads: per room counts, 10 biggest changes, stops, channels, and the checks."""
    sys.path.insert(0, os.path.join(ROOT, "scripts"))
    orig = requests.Session.request
    try:
        import pricing_check as pc                      # installs a request guard when imported: undone below
    finally:
        requests.Session.request = orig
    db = FakeDB()
    res = live.main(["--dry"], db=db, get=minihotel(prices_near_start), cookie_fn=lambda: "c", now=NOW)
    rules, settings = real_rules(db)
    capsys.readouterr()
    checks = pc.moveold_report(res, rules, settings, CONFIG, {})
    out = capsys.readouterr().out
    assert all(checks.values()), [k for k, v in checks.items() if not v]
    for rt in SIX:
        assert f"=== {rt} ===" in out
    assert "10 biggest changes" in out and "Would push if no room were stopped: BOOKING, EXPEDIA, AIRBNB" in out
    assert "EXPEDIA is pushed for: ROOMS, MAXELA, BIG_APT, FREEDOM" in out
    assert "from calm_settings.json" in out
    # a Firestore value saved on the pricing page is shown, because it wins over the file
    capsys.readouterr()
    pc.moveold_report(res, rules, settings, CONFIG, {"MAXELA": {"style": "aggressive"}})
    assert 'saved on the pricing page (wins over the file): {"style": "aggressive"}' in capsys.readouterr().out
