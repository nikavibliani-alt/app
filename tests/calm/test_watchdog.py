"""Price watchdog: the seven checks (pure), and the runner that saves the card and sends the WhatsApp."""

import os
import sys
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_shadow_script import FakeDB  # noqa: E402

from calm_pricing import merged  # noqa: E402
from calm_pricing.watchdog import check, short_issues  # noqa: E402

NOW = datetime(2026, 10, 7, 9, 30)
CFG = merged({})
OK_RUN = {"ok": True, "failed_portals": [], "stopped_room_types": []}


def rec(new=200, before=200, mn=150, mx=300, kind="move", avail=1, do=40, **more):
    return {"new": new, "virtual_before": before, "min": mn, "max": mx, "kind": kind, "avail": avail, "do": do, **more}


def codes(res):
    return sorted({i["code"] for i in res["issues"]})


def go(dates, states=None, run=OK_RUN, rts=("X",)):
    return check({"X": dates}, states or {}, run, CFG, NOW, live_rts=rts)


def test_a_quiet_day_is_green():
    r = go({"2026-11-01|GEL": rec(205, 200), "2026-11-02|GEL": rec()})
    assert r["status"] == "green" and r["issues"] == [] and r["checked"] == 2


def test_price_outside_min_max():
    r = go({"2026-11-01|GEL": rec(140, 142), "2026-11-02|GEL": rec(310, 305)})
    assert codes(r) == ["out_of_range"] and len(r["issues"]) == 2


def test_move_bigger_than_the_rules_allow_but_corrections_are_fine():
    r = go({"2026-11-01|GEL": rec(250, 200)})                                    # +25% in one run
    assert codes(r) == ["big_move"]
    assert go({"2026-11-01|GEL": rec(300, 320, kind="correction")})["status"] == "green"
    assert go({"2026-11-01|GEL": rec(205, 200)})["status"] == "green"


def test_up_down_up_within_48_hours():
    def h(*ds):
        return {"2026-11-01": {"GEL": {"dirs": [{"t": (NOW - timedelta(hours=40 - 8 * i)).isoformat(), "d": d, "k": "move", "p": 200}
                                               for i, d in enumerate(ds)]}}}
    assert codes(go({}, states={"X": h(1, -1, 1)})) == ["up_down_up"]
    assert go({}, states={"X": h(1, 1, -1)})["status"] == "green"
    old = {"2026-11-01": {"GEL": {"dirs": [{"t": (NOW - timedelta(hours=60 - 5 * i)).isoformat(), "d": d, "k": "move", "p": 1}
                                         for i, d in enumerate((1, -1, 1))]}}}
    assert go({}, states={"X": old})["status"] == "green"                         # the first step is older than 48 hours


def test_holiday_band_broken_and_far_reset_on_a_holiday_date():
    hol = {"kind": "holiday", "anchor": 200, "window": "far", "lo": 194, "hi": 206}
    assert go({"2026-11-01|GEL": rec(205, 204, hol=hol)})["status"] == "green"
    assert codes(go({"2026-11-01|GEL": rec(190, 192, hol=hol)})) == ["holiday_broken"]
    assert codes(go({"2026-11-01|GEL": rec(215, 212, hol=hol)})) == ["holiday_broken"]
    assert codes(go({"2026-11-01|GEL": rec(200, 260, kind="far_reset", hol=hol)})) == ["holiday_broken"]
    multi = {"kind": "holiday", "anchor": 200, "window": "far", "lo": 190, "hi": None}
    assert go({"2026-11-01|GEL": rec(240, 236, hol=multi)})["status"] == "green"         # several rooms: no upper limit


def test_channel_push_failed_and_room_stopped():
    r = go({}, run={"ok": True, "failed_portals": ["EXPEDIA"], "stopped_room_types": ["X"]})
    assert codes(r) == ["channel_failed", "room_stopped"]
    assert "Expedia" in r["issues"][0]["text"]
    assert codes(go({}, run={"ok": False}))[0] == "room_stopped"
    assert codes(go({}, run=None)) == ["room_stopped"]


def test_dates_without_a_price_and_rooms_with_no_data():
    r = go({"2026-11-01|GEL": rec(None, None), "2026-11-02|GEL": rec(None, None, avail=0)})
    assert [i["date"] for i in r["issues"]] == ["2026-11-01"]
    r = check({}, {}, OK_RUN, CFG, NOW, live_rts=["X", "Y"])
    assert codes(r) == ["no_price"] and len(r["issues"]) == 2
    assert go({"2026-11-01|GEL": rec(None, None, kind="protected")})["status"] == "green"


def test_short_issues_names_each_kind_once():
    r = go({"2026-11-01|GEL": rec(310, 305), "2026-11-02|GEL": rec(320, 305)}, run={"ok": True, "failed_portals": ["AIRBNB"]})
    assert short_issues(r) == "1 channel push failed; 2 prices outside min/max"


# ---------------- the runner ----------------
import scripts.price_watchdog as wd  # noqa: E402
import pricing_calm_live as live  # noqa: E402


class Posted:
    def __init__(self, ok=True):
        self.calls, self.ok = [], ok

    def __call__(self, url, json=None, headers=None, timeout=None):
        self.calls.append(json)

        class R:
            status_code = 200 if self.ok else 400

            def json(_):
                return {"messages": [{"id": "wamid.ABC/1"}]}
        return R()


def seeded(main_run=True, bad=True):
    db = FakeDB()
    db.collection("globals").document("config").set({"ownerPhone": "+995 555 000 111"})
    dates = {"2026-11-01|GEL": rec(310 if bad else 205, 305 if bad else 200)}
    db.collection("pricing_calm_daily").document("2026-10-07_X").set({"day": "2026-10-07", "dates": dates})
    db.collection("pricing_calm_runs").add({"ts": "2026-10-07T09:05:00", "day": "2026-10-07", "ok": True, "main_run": main_run,
                                            "failed_portals": [], "stopped_room_types": []})
    return db


def run_wd(db, post, monkeypatch, *args):
    monkeypatch.setattr(wd.live, "live_room_types", lambda rules, settings: {"X": {}})
    monkeypatch.setattr(wd.ps, "load_rules", lambda db_, cfg: ({}, {}))
    monkeypatch.setattr(wd, "load_inputs", wd.load_inputs)
    return wd.main(list(args), db=db, post=post, now=NOW, env={"META_ACCESS_TOKEN": "t", "META_PHONE_NUMBER_ID": "1"})


def test_runner_red_after_the_main_run_saves_the_card_and_sends_once(monkeypatch):
    db, post = seeded(), Posted()
    out = run_wd(db, post, monkeypatch)
    doc = db.store["pricing_watchdog"]["latest"]
    assert doc["status"] == "red" and doc["counts"] == {"out_of_range": 1} and doc["alerted"]
    assert len(post.calls) == 1 and post.calls[0]["to"] == "995555000111" and post.calls[0]["template"]["name"] == "owner_alert"
    assert "wamid.ABC_1" in db.store["whatsapp_owner_alerts"]
    run_wd(db, post, monkeypatch)                                              # the same problems again: no second message
    assert len(post.calls) == 1


def test_runner_sends_nothing_before_the_main_run_or_when_green_or_with_no_send(monkeypatch):
    post = Posted()
    run_wd(seeded(main_run=False), post, monkeypatch)
    run_wd(seeded(bad=False), post, monkeypatch)
    run_wd(seeded(), post, monkeypatch, "--no-send")
    assert post.calls == []


def test_runner_green_card(monkeypatch):
    db = seeded(bad=False)
    run_wd(db, Posted(), monkeypatch)
    doc = db.store["pricing_watchdog"]["latest"]
    assert doc["status"] == "green" and doc["issues"] == [] and doc["main_run_done"] is True


def test_runner_falls_back_to_text_when_the_template_is_refused(monkeypatch):
    calls = []

    def post(url, json=None, headers=None, timeout=None):
        calls.append(json["type"])
        code = 200 if json["type"] == "text" else 400

        class R:
            status_code = code

            def json(_):
                return {"messages": [{"id": "x"}]}
        return R()
    run_wd(seeded(), post, monkeypatch)
    assert calls == ["template", "template", "text"]


def test_a_clean_run_after_a_failed_push_turns_the_card_green(monkeypatch):
    db = seeded(bad=False)
    db.collection("pricing_calm_runs").add({"ts": "2026-10-07T09:02:00", "day": "2026-10-07", "ok": True, "main_run": False,
                                            "failed_portals": ["EXPEDIA"], "stopped_room_types": []})
    db.collection("pricing_calm_runs").add({"ts": "2026-10-07T12:05:00", "day": "2026-10-07", "ok": True, "main_run": False,
                                            "failed_portals": [], "stopped_room_types": []})
    run_wd(db, Posted(), monkeypatch)
    assert db.store["pricing_watchdog"]["latest"]["status"] == "green"


def test_no_run_yet_today_is_waiting_not_red(monkeypatch):
    db = FakeDB()
    db.collection("globals").document("config").set({"ownerPhone": "+995 555 000 111"})
    post = Posted()
    run_wd(db, post, monkeypatch)
    doc = db.store["pricing_watchdog"]["latest"]
    assert doc["status"] == "waiting" and doc["issues"] == [] and post.calls == []


def test_the_watchdog_note_mentions_unmarked_season_days_and_never_makes_it_red():
    import importlib.util
    ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    sys.path.insert(0, os.path.join(ROOT, "scripts"))
    import price_watchdog as pw
    from test_pmslog import DB
    db = DB()
    assert pw.season_notes(db) == []                                         # nothing saved yet: config.json covers every day
    db.collection("pricing_config").document("rules").set({"seasonRanges": [{"from": "01-01", "to": "03-02", "season": "low"}, {"from": "03-15", "to": "12-31", "season": "peak"}]})
    assert pw.season_notes(db) == ["12 days unmarked: 3-14 Mar. They use Mid prices until you mark them."]
