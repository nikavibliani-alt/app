"""Event scanner: search words follow the year by themselves, errors are never hidden, the key is never printed."""

import os
import sys
from datetime import date, datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import event_scanner as es  # noqa: E402
from test_shadow_script import FakeDB  # noqa: E402


def test_search_words_follow_the_year_and_have_no_artists():
    q = es.search_queries(date(2026, 3, 1))
    assert q == [t.format(year=2026) for t in es.QUERY_TEMPLATES] and len(q) == 5
    assert not any("2027" in x for x in q)
    q = es.search_queries(date(2026, 10, 12))                       # 90 days ahead reaches January 2027
    assert any("2026" in x for x in q) and any("2027" in x for x in q) and len(q) == 10
    assert es.search_queries(date(2026, 10, 3))[-1].endswith("2027")        # 3 Oct + 90 days is 1 Jan 2027
    assert not any("2027" in x for x in es.search_queries(date(2026, 10, 2)))   # 2 Oct + 90 days is 31 Dec 2026
    q = es.search_queries(date(2027, 1, 5))
    assert any("2027" in x for x in q) and not any("2026" in x for x in q)
    assert not any(n in " ".join(es.search_queries(date(2026, 10, 12))) for n in ("Ricky", "Lindemann"))


class Resp:
    def __init__(self, status=200, text="{}", data=None):
        self.status_code, self.text, self._d = status, text, data if data is not None else {}

    def json(self):
        return self._d


def test_an_error_shows_its_reason_without_the_key(monkeypatch, capsys):
    monkeypatch.setattr(es, "SERP_API_KEY", "SECRETKEY123")
    monkeypatch.setattr(es.requests, "get", lambda url, params=None, timeout=None: Resp(400, '{"error": "bad thing for api_key=SECRETKEY123"}'))
    es.LAST_ERRORS.clear()
    assert es.fetch_events("concerts") == []
    err = capsys.readouterr().err
    assert "HTTP 400" in err and "bad thing" in err and "SECRETKEY123" not in err
    assert es.LAST_ERRORS and "SECRETKEY123" not in es.LAST_ERRORS[0]


def run_scan(monkeypatch, db, get, now=datetime(2026, 10, 12, 0, 1)):
    class FakeDT(datetime):
        @classmethod
        def now(cls, tz=None):
            return now
    monkeypatch.setattr(es, "datetime", FakeDT)
    monkeypatch.setattr(es, "get_firestore_client", lambda: db)
    monkeypatch.setattr(es.requests, "get", get)
    monkeypatch.setattr(es, "SERP_API_KEY", "k")
    return es.scan_and_update()


def test_when_every_search_fails_it_is_not_called_no_events_and_the_scan_is_not_marked_done(monkeypatch, capsys):
    db = FakeDB()
    out = run_scan(monkeypatch, db, lambda url, params=None, timeout=None: Resp(400, "nope"))
    ev = db.store.get("pricing_events", {})
    assert out == {} and "last_scan" not in ev
    assert ev["last_scan_error"]["failed_runs"] == 1 and "HTTP 400" in ev["last_scan_error"]["error"]
    assert "SCANNER PROBLEM: 10 of 10 searches failed" in capsys.readouterr().err
    run_scan(monkeypatch, db, lambda url, params=None, timeout=None: Resp(400, "nope"))
    assert db.store["pricing_events"]["last_scan_error"]["failed_runs"] == 2


def test_a_good_scan_saves_events_marks_itself_done_and_clears_the_error(monkeypatch):
    db = FakeDB()
    db.store["pricing_events"] = {"last_scan_error": {"failed_runs": 3, "error": "old", "at": "x"}}
    ev = {"title": "Big Concert", "venue": {"name": "Rustavi International Motorpark"}, "ticket_info": [1, 2, 3],
          "date": {"start_date": "Nov 20", "when": "Fri, Nov 20, 8 PM"}}
    out = run_scan(monkeypatch, db, lambda url, params=None, timeout=None: Resp(200, "{}", {"events_results": [ev]}))
    store = db.store["pricing_events"]
    assert list(out) == ["2026-11-20"] and store["event_2026-11-20"]["status"] == "pending"
    assert store["last_scan"]["scanned_at"] == "2026-10-12" and store["last_scan_error"]["failed_runs"] == 0


def test_the_scan_runs_every_two_days_not_every_day(monkeypatch):
    db = FakeDB()
    db.store["pricing_events"] = {"last_scan": {"scanned_at": "2026-10-11"}}
    calls = []

    def get(url, params=None, timeout=None):
        calls.append(1)
        return Resp(200, "{}", {"events_results": []})
    assert run_scan(monkeypatch, db, get) == {} and calls == []              # scanned yesterday: skipped
    db.store["pricing_events"]["last_scan"]["scanned_at"] = "2026-10-10"
    run_scan(monkeypatch, db, get)
    assert len(calls) == 10                                                   # two days ago: scans, 10 searches
