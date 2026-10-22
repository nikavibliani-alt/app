"""A channel push can never hang the run (3 minutes per channel in total); a channel that did not get the prices is remembered and
sent again by the next run; the watchdog says so."""

import os
import sys
import threading
import time
from datetime import timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "scripts"))
import requests  # noqa: E402
from test_move_old import minihotel, prices_near_start, NOW as RUN_NOW  # noqa: E402
from test_shadow_script import FakeDB  # noqa: E402

import pricing_calm_live as live  # noqa: E402
import price_watchdog as pw  # noqa: E402


class Resp:
    def __init__(self, code=200):
        self.status_code = code

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.exceptions.HTTPError(f"HTTP {self.status_code}")

    def json(self):
        return {}


def portal_of(url):
    return url.split("Portal=")[1] if "Portal=" in url else None


def test_a_channel_that_never_answers_is_given_up_on_and_the_others_still_go_out():
    gate, seen = threading.Event(), []

    def post(url, json=None, headers=None, timeout=None):
        seen.append(portal_of(url))
        if portal_of(url) == "BOOKING":
            gate.wait(30)                                # never answers (until the test ends)
        return Resp()
    t0 = time.time()
    failed = live.push_channels(["BOOKING", "EXPEDIA", "AIRBNB"], "c", post=post, total=0.6, sleep=lambda s: None)
    took = time.time() - t0
    gate.set()
    assert failed == ["BOOKING"], failed
    assert "EXPEDIA" in seen and "AIRBNB" in seen
    assert took < 3, took                                # about the cap, not minutes


def test_the_cap_is_for_all_tries_of_one_channel_together():
    clock = {"t": 0.0}
    calls = []

    def post(url, json=None, headers=None, timeout=None):
        calls.append(timeout)
        clock["t"] += timeout                            # every try uses up all the time it was given
        raise requests.exceptions.ReadTimeout("slow")
    failed = live.push_channels(["BOOKING"], "c", post=post, total=180, sleep=lambda s: None, clock=lambda: clock["t"])
    assert failed == ["BOOKING"]
    assert sum(calls) <= 180 + 1e-9 and len(calls) == 2, calls        # 120 s, then the 60 s that are left; no third try


def test_a_http_error_or_a_dropped_connection_is_a_failed_channel_not_a_crash():
    def post(url, json=None, headers=None, timeout=None):
        if portal_of(url) == "BOOKING":
            return Resp(502)
        if portal_of(url) == "EXPEDIA":
            raise requests.exceptions.ConnectionError("dropped")
        return Resp()
    assert live.push_channels(["BOOKING", "EXPEDIA", "AIRBNB"], "c", post=post, total=5, sleep=lambda s: None) == ["BOOKING", "EXPEDIA"]


def test_update_pending_keeps_failed_channels_with_their_nights_and_drops_the_ones_that_went_through():
    rts = {"XCV_1": {"portals": ["BOOKING", "AIRBNB"]}, "MAXELA": {"portals": ["BOOKING", "EXPEDIA"]}}
    writes = [{"rt": "XCV_1", "date": "2026-10-25", "currency": "GEL", "price": 1}, {"rt": "MAXELA", "date": "2026-10-26", "currency": "GEL", "price": 1}]
    got = live.update_pending({"AIRBNB": {"since": "x", "rooms": {"XCV_1": ["2026-10-20"]}}}, ["AIRBNB", "BOOKING"], ["BOOKING"], writes, rts, RUN_NOW)
    assert "AIRBNB" not in got and got["BOOKING"]["rooms"] == {"XCV_1": ["2026-10-25"], "MAXELA": ["2026-10-26"]}
    again = live.update_pending(got, ["BOOKING"], ["BOOKING"], [{"rt": "XCV_1", "date": "2026-10-27", "currency": "GEL", "price": 1}], rts, RUN_NOW)
    assert again["BOOKING"]["since"] == got["BOOKING"]["since"] and again["BOOKING"]["rooms"]["XCV_1"] == ["2026-10-25", "2026-10-27"]


def run_main(db, broken=None, minutes=0):
    sent = []

    def post(url, json=None, headers=None, timeout=None):
        if "SyncPortal" in url or "Portal=" in url:
            sent.append(portal_of(url))
            if portal_of(url) == broken:
                raise requests.exceptions.ReadTimeout("never answers")
        return Resp()
    orig = live.push_channels
    live.push_channels = lambda *a, **k: orig(*a, sleep=lambda s: None, **k)             # no real waiting between tries
    try:
        res = live.main([], db=db, get=minihotel(prices_near_start), post=post, cookie_fn=lambda: "c", now=RUN_NOW + timedelta(minutes=minutes))
    finally:
        live.push_channels = orig
    return res, sent


def last_run(db):
    docs = sorted(db.store["pricing_calm_runs"].values(), key=lambda d: d.get("ts", ""))
    return docs[-1]


def test_a_failed_channel_is_remembered_and_sent_again_next_run_then_forgotten():
    db = FakeDB()
    res, sent = run_main(db, broken="BOOKING")
    assert res["failed_portals"] == ["BOOKING"] and "EXPEDIA" in sent and "AIRBNB" in sent       # the others went on
    pend = db.store["pricing_config"]["channel_pending"]["portals"]
    assert list(pend) == ["BOOKING"] and pend["BOOKING"]["rooms"], pend
    run1 = last_run(db)
    assert run1["failed_portals"] == ["BOOKING"] and run1["pending_portals"] == ["BOOKING"] and run1["resent_portals"] == []

    res2, sent2 = run_main(db, broken=None, minutes=40)                                          # the next run: Booking answers
    assert "BOOKING" in sent2 and res2["failed_portals"] == []
    run2 = last_run(db)
    assert run2["resent_portals"] == ["BOOKING"] and run2["pending_portals"] == [] and run2["failed_portals"] == []
    assert db.store["pricing_config"]["channel_pending"]["portals"] == {}
    res3, sent3 = run_main(db, minutes=80)
    assert last_run(db)["resent_portals"] == []                                                  # nothing left to send again


def test_a_still_failing_channel_stays_on_the_list_and_keeps_its_nights():
    db = FakeDB()
    run_main(db, broken="BOOKING")
    first = db.store["pricing_config"]["channel_pending"]["portals"]["BOOKING"]
    run_main(db, broken="BOOKING", minutes=40)
    again = db.store["pricing_config"]["channel_pending"]["portals"]["BOOKING"]
    assert again["since"] == first["since"] and set(first["rooms"]) <= set(again["rooms"])


def test_a_channel_is_sent_again_even_when_the_next_run_changes_no_price():
    db = FakeDB()
    db.collection("pricing_config").document("channel_pending").set({"portals": {"BOOKING": {"since": "x", "rooms": {"MAXELA": ["2026-10-30"]}}}})
    import pricing_calm_live as lv
    orig = lv.run
    lv.run = lambda snap, cfg, state: {**orig(snap, cfg, state), "writes": []}              # a run with no price change
    try:
        res, sent = run_main(db)
    finally:
        lv.run = orig
    assert sent == ["BOOKING"] and last_run(db)["resent_portals"] == ["BOOKING"]
    assert db.store["pricing_config"]["channel_pending"]["portals"] == {}


def test_the_dry_run_sends_nothing_and_saves_nothing():
    db = FakeDB()
    db.collection("pricing_config").document("channel_pending").set({"portals": {"BOOKING": {"since": "x", "rooms": {}}}})
    sent = []
    live.main(["--dry"], db=db, get=minihotel(prices_near_start), post=lambda *a, **k: sent.append(a) or Resp(), cookie_fn=lambda: "c", now=RUN_NOW)
    assert not sent and "pricing_calm_runs" not in db.store
    assert "BOOKING" in db.store["pricing_config"]["channel_pending"]["portals"]


def test_the_watchdog_says_a_failed_push_was_re_sent_ok_and_the_card_is_not_red_for_it():
    runs = [{"ts": "2026-10-22T16:01:14", "failed_portals": ["BOOKING"], "resent_portals": []},
            {"ts": "2026-10-22T16:41:40", "failed_portals": [], "resent_portals": ["BOOKING"]}]
    notes = pw.channel_notes(runs, {})
    assert notes == ["Booking.com: the push failed earlier and was re-sent in the next run (16:41): OK."]
    assert pw.channel_notes(runs, {"BOOKING": {}}) == []                                         # still waiting: no "OK"
    assert pw.channel_notes([runs[0], {**runs[1], "failed_portals": ["BOOKING"]}], {}) == []     # failed again: no "OK"
