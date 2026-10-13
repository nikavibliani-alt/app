"""Evidence saved with every new idea: real dates, booked and empty nights, last year's numbers."""

import json
import os
import sys
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import claude_pricing as cp  # noqa: E402
import idea_evidence as ie  # noqa: E402
from test_ideas import FakeDB as BaseDB, Snap, NOW  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CONFIG = json.load(open(os.path.join(ROOT, "config.json")))
TODAY = "2026-10-12"


class Q:
    def __init__(self, store, coll, conds=()):
        self.store, self.coll, self.conds = store, coll, list(conds)

    def where(self, f, op, v):
        return Q(self.store, self.coll, self.conds + [(f, op, v)])

    def stream(self):
        out = []
        for i, d in list(self.store.get(self.coll, {}).items()):
            ok = True
            for f, op, v in self.conds:
                x = d.get(f)
                ok &= (x == v) if op == "==" else (x is not None and x >= v)
            if ok:
                out.append(Snap(i, d))
        return out

    get = stream


class DB(BaseDB):
    """The idea tests' fake database, plus stays and saved prices."""

    def __init__(self, daily=None, stays=None, **k):
        super().__init__(**k)
        self.store["pricing_calm_daily"] = daily or {}
        self.store["reservations"] = stays or {}

    def collection(self, name):
        if name in ("reservations",):
            return Q(self.store, name)
        c = super().collection(name)
        return c


def daily(rt, booked=(), none=(), day=TODAY, cur="GEL", days=100):
    dates = {}
    for k in range(days):
        iso = (datetime.fromisoformat(day) + timedelta(days=k)).date().isoformat()
        if iso in none:
            continue
        dates[f"{iso}|{cur}"] = {"avail": 0 if iso in booked else 1, "new": 150, "target": 150, "min": 100, "max": 200}
    return {f"{day}_{rt}": {"day": day, "rt": rt, "dates": dates}}


def stay(code, ci, co, created, status="OK"):
    return {"roomCode": code, "checkin": ci, "checkout": co, "creationDate": created, "status": status}


def test_season_stretches_have_real_first_and_last_days():
    runs = ie.stretches("mid", CONFIG, TODAY)
    assert runs[0] == {"from": "2026-10-01", "to": "2026-11-30", "nights": 61}          # running now: its real first day
    assert [(r["from"], r["to"]) for r in runs[1:]] == [("2027-03-16", "2027-04-30"), ("2027-10-01", "2027-11-30")]
    cfg = {**CONFIG, "dateOverrides": [{"from": "11-10", "to": "11-20", "season": "high"}]}
    assert ie.stretches("high", cfg, TODAY)[0] == {"from": "2026-11-10", "to": "2026-11-20", "nights": 11}
    assert ie.stretches("mid", cfg, TODAY)[0]["to"] == "2026-11-09"                      # a holiday range cuts the season
    wrap = {**CONFIG, "dateOverrides": {"a": {"from": "12-28", "to": "01-06", "season": "new_year"}}}
    assert ie.stretches("new_year", wrap, TODAY)[0] == {"from": "2026-12-24", "to": "2027-01-14", "nights": 22}     # joins the fixed New Year days


def test_evidence_lists_booked_empty_and_missing_nights_as_real_dates():
    db = DB(daily=daily("MAXELA", booked={"2026-10-20", "2026-10-21", "2026-11-05"}, none={"2026-11-29", "2026-11-30"}))
    ev = ie.collect(db, CONFIG, TODAY, "MAXELA", "mid", "startPrice", "Booking is slow", [])
    assert ev["stretch"] == {"from": "2026-10-01", "to": "2026-11-30", "nights": 61}
    assert ev["looked_at"] == {"from": TODAY, "to": "2026-11-30", "nights": 50}          # nights still ahead
    assert ev["booked"] == ["2026-10-20", "2026-10-21", "2026-11-05"] and ev["booked_count"] == 3
    assert ev["no_price"] == ["2026-11-29", "2026-11-30"] and len(ev["empty"]) == 45 and ev["known_nights"] == 48
    assert not set(ev["booked"]) & set(ev["empty"]) and "2026-10-12" in ev["empty"]
    assert ev["later"] == [{"from": "2027-03-16", "to": "2027-04-30"}, {"from": "2027-10-01", "to": "2027-11-30"}] and ev["uses_last_year"] is False
    assert ev["source"].endswith(TODAY) and ev["made_on"] == TODAY


def test_airbnb_ideas_look_at_the_dollar_prices_and_yesterdays_prices_are_used_when_today_has_none():
    db = DB(daily=daily("BIG_APT", booked={"2026-10-15"}, day="2026-10-11", cur="USD"))
    ev = ie.collect(db, CONFIG, TODAY, "BIG_APT", "mid", "ceilingEur", "x", [])
    assert ev["booked"] == ["2026-10-15"] and ev["source"].endswith("2026-10-11")
    none = ie.collect(DB(), CONFIG, TODAY, "BIG_APT", "mid", "ceilingEur", "x", [])
    assert none["booked_count"] == 0 and len(none["no_price"]) == 50 and "no saved prices" in none["source"]


def test_last_year_numbers_come_from_stored_stays_only():
    stays = [
        {"rt": "XCV_2", "checkin": "2025-10-05", "checkout": "2025-10-09", "created": "2025-09-20"},      # 4 nights, booked early
        {"rt": "XCV_2", "checkin": "2025-11-20", "checkout": "2025-11-25", "created": "2025-11-01"},      # 5 nights, booked late
        {"rt": "XCV_2", "checkin": "2025-11-28", "checkout": "2025-12-03", "created": "2025-10-01"},      # 3 nights inside the stretch
        {"rt": "XCV_1", "checkin": "2025-10-05", "checkout": "2025-10-09", "created": "2025-09-20"},      # another room
    ]
    ly = ie.last_year(stays, "XCV_2", {"from": "2026-10-01", "to": "2026-11-30"}, TODAY)
    assert ly["available"] and (ly["from"], ly["to"], ly["as_of"]) == ("2025-10-01", "2025-11-30", "2025-10-12")
    assert ly["nights"] == 61 and ly["booked_nights"] == 4 + 5 + 3 and ly["booked_by_that_day"] == 4 + 3
    none = ie.last_year(stays, "FREEDOM", {"from": "2026-10-01", "to": "2026-11-30"}, TODAY)
    assert none["available"] is False and "No stays" in none["why"]


def test_prompt_gets_last_year_lines_only_when_there_are_stays():
    stays = [{"rt": "MAXELA", "checkin": "2025-10-05", "checkout": "2025-10-09", "created": "2025-09-20"}]
    text = ie.last_year_lines(DB(), CONFIG, TODAY, ["MAXELA", "ROOMS"], stays)
    assert "LAST YEAR" in text and "MAXELA mid" in text and "ROOMS" not in text and "4 of" in text
    assert ie.last_year_lines(DB(), CONFIG, TODAY, ["ROOMS"], stays) == ""


def run_maker(db, proposals, monkeypatch, force=False):
    class FakeDT(datetime):
        @classmethod
        def now(cls, tz=None):
            return NOW

        @classmethod
        def utcnow(cls):
            return datetime(2026, 10, 12, 6, 0)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "x")
    monkeypatch.setattr(cp, "datetime", FakeDT)
    import price_tracker
    monkeypatch.setattr(price_tracker, "get_learning_context", lambda db, days_back=30: "some history")
    prompts = []
    monkeypatch.setattr(cp, "call_claude_analyst", lambda prompt, key: (prompts.append(prompt), {"proposals": proposals, "daily_summary": "s"})[1])
    cp.claude_write_daily_proposal({**CONFIG, "startPrices": {}}, db, {}, force=force)
    return prompts


def test_new_ideas_save_their_evidence_and_the_prompt_carries_last_year(monkeypatch):
    stays = {"s1": stay("6-1", "2025-10-05", "2025-10-09", "2025-09-20"), "s2": stay("6-1", "2025-10-20", "2025-10-23", "2025-10-30", "CL")}
    db = DB(daily=daily("MAXELA", booked={"2026-10-20"}), stays=stays)
    props = [{"property": "MAXELA", "season": "mid", "type": "startPrice", "current": 130, "suggested": 125,
              "reasoning": "Last year by today 4 nights were booked."}]
    prompts = run_maker(db, props, monkeypatch)
    assert "LAST YEAR" in prompts[0] and "MAXELA mid" in prompts[0] and "ONLY last-year numbers" in prompts[0]
    doc = [d for k, d in db.store["pricing_proposals"].items() if not k.startswith("run_")][0]
    ev = doc["evidence"]
    assert doc["status"] == "pending" and ev["version"] == 1 and ev["uses_last_year"] is True
    assert ev["booked"] == ["2026-10-20"] and ev["stretch"]["nights"] == 61
    assert ev["last_year"]["available"] and ev["last_year"]["booked_nights"] == 4 and ev["last_year"]["booked_by_that_day"] == 4   # the cancelled stay is not counted


def test_an_idea_still_saves_when_the_evidence_cannot_be_worked_out(monkeypatch):
    db = DB(daily=daily("ROOMS"))
    monkeypatch.setattr(ie, "collect", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom")))
    run_maker(db, [{"property": "ROOMS", "season": "mid", "type": "floor", "current": 70, "suggested": 75, "reasoning": "x"}], monkeypatch)
    docs = [d for k, d in db.store["pricing_proposals"].items() if not k.startswith("run_")]
    assert len(docs) == 1 and "evidence" not in docs[0] and docs[0]["status"] == "pending"


def test_force_makes_a_fresh_set_inside_the_week(monkeypatch):
    db = DB()
    db.store["pricing_proposals"]["run_2026-10-10"] = {"type": "run_marker", "date": "2026-10-10"}
    p = [{"property": "ROOMS", "season": "mid", "type": "floor", "current": 70, "suggested": 75, "reasoning": "x"}]
    assert run_maker(db, p, monkeypatch) == []                      # inside the week: skipped
    assert len(run_maker(db, p, monkeypatch, force=True)) == 1      # forced: runs


def test_fresh_set_replaces_the_waiting_ideas_only_when_new_ones_were_made(monkeypatch):
    sys.path.insert(0, os.path.join(ROOT, "scripts"))
    import ideas_fresh as fresh
    old = lambda prop, season, typ: {"property": prop, "season": season, "type": typ, "current": 1, "suggested": 2, "status": "pending", "reasoning": "old", "ts": "2026-10-01T09:00:00"}
    ideas = {"a": old("MAXELA", "low", "startPrice"), "b": old("ROOMS", "mid", "floor"), "c": {**old("ROOMS", "mid", "ceiling"), "status": "approved"}}
    db = DB(daily=daily("MAXELA"), ideas=dict(ideas))
    p = [{"property": "MAXELA", "season": "mid", "type": "floor", "current": 80, "suggested": 85, "reasoning": "x"}]
    monkeypatch.setenv("ANTHROPIC_API_KEY", "x")
    import price_tracker
    monkeypatch.setattr(price_tracker, "get_learning_context", lambda db, days_back=30: "some history")
    monkeypatch.setattr(cp, "call_claude_analyst", lambda prompt, key: {"proposals": p, "daily_summary": "s"})
    r = fresh.run(db, {**CONFIG, "startPrices": {}})
    docs = db.store["pricing_proposals"]
    assert r == {"before": 2, "new": 1, "with_evidence": 1, "replaced": 2}
    assert docs["a"]["status"] == "rejected" and docs["a"]["rejection_reason"] == "Replaced by a newer idea" and docs["a"]["replaced_by"] == "fresh_set"
    assert docs["b"]["status"] == "rejected" and docs["c"]["status"] == "approved"           # not deleted; others untouched
    assert len([k for k, d in docs.items() if d.get("status") == "pending" and d.get("type") != "run_marker"]) == 1
    # nothing made: nothing is replaced
    db2 = DB(ideas={"a": old("MAXELA", "low", "startPrice")})
    monkeypatch.setattr(cp, "call_claude_analyst", lambda prompt, key: {"proposals": [], "daily_summary": ""})
    r2 = fresh.run(db2, {**CONFIG, "startPrices": {}})
    assert r2["new"] == 0 and r2["replaced"] == 0 and db2.store["pricing_proposals"]["a"]["status"] == "pending"


def test_the_reply_is_read_even_with_text_around_the_json():
    j = '{"proposals": [], "daily_summary": "s"}'
    assert cp.parse_analyst_reply(j)["daily_summary"] == "s"
    assert cp.parse_analyst_reply("```json\n" + j + "\n```")["proposals"] == []
    assert cp.parse_analyst_reply("Here is my analysis.\n" + j + "\nHope it helps.")["proposals"] == []
    try:
        cp.parse_analyst_reply("")
        assert False
    except ValueError as e:
        assert "no JSON" in str(e)
