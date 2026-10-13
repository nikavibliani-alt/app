"""Ideas logic: no idea for nights with nothing left to sell, one waiting idea per room + season + price list, all 10 rooms."""

import importlib.util
import os
import sys
from datetime import timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))

import claude_pricing as cp  # noqa: E402
import idea_evidence as ie  # noqa: E402
import pricing_shadow as ps  # noqa: E402
from test_ideas import FakeDB, NOW, CONFIG, with_daily, new_idea, RULES  # noqa: E402
from datetime import datetime  # noqa: E402

TODAY = NOW.date().isoformat()


def D(k):
    return (NOW.date() + timedelta(days=k)).isoformat()


def maker(db, proposals, monkeypatch):
    class FakeDT(datetime):
        @classmethod
        def now(cls, tz=None):
            return NOW

        @classmethod
        def utcnow(cls):
            return NOW - timedelta(hours=4)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "x")
    monkeypatch.setattr(cp, "datetime", FakeDT)
    import price_tracker
    monkeypatch.setattr(price_tracker, "get_learning_context", lambda db, days_back=30: "some history")
    prompts = []
    monkeypatch.setattr(cp, "call_claude_analyst", lambda prompt, key: (prompts.append(prompt), {"proposals": proposals, "daily_summary": "s"})[1])
    cp.claude_write_daily_proposal({**CONFIG, "startPrices": {}}, db, {})
    return prompts


def made(db):
    return [v for k, v in db.store["pricing_proposals"].items() if not k.startswith("run_")]


def all_rules():
    rules = {"startPrices": {}, "priceRules": {}}
    for rt in ps.ROOM_TYPES:
        rules["startPrices"][rt] = {"mid": 100, "low": 80}
        rules["priceRules"][rt] = {"mid": {"min": 70, "max": 140}, "low": {"min": 50, "max": 110}}
    return rules


def db_with(booked=(), **kw):
    db = FakeDB(rules=all_rules())
    return with_daily(db, NOW, booked=booked, **kw)


def idea(prop="MAXELA", season="mid", typ="startPrice", cur=100, sug=90):
    return new_idea(prop, season, typ, cur, sug)


def test_an_idea_for_a_season_that_is_fully_booked_is_not_made(monkeypatch):
    mid_nights = {D(k) for k in range(400) if ie.season_of(D(k), CONFIG) == "mid"}
    db = db_with(booked=mid_nights)
    maker(db, [idea("MAXELA", "mid"), idea("ROOMS", "low")], monkeypatch)
    got = {(v["property"], v["season"]) for v in made(db)}
    assert got == {("ROOMS", "low")}                                        # mid is full everywhere; low still has free nights


def test_a_room_with_several_units_counts_while_one_unit_is_free():
    db = db_with()
    day = db.store["pricing_calm_daily"][f"{TODAY}_ROOMS"]["dates"]
    for iso in list(day):
        day[iso]["avail"] = 1                                               # 1 of several units free
    assert ie.sellable(db, CONFIG, TODAY, "ROOMS", "mid", "startPrice", set())["count"] > 0
    for iso in list(day):
        day[iso]["avail"] = 0
    assert ie.sellable(db, CONFIG, TODAY, "ROOMS", "mid", "startPrice", set())["count"] == 0


def test_past_hand_set_and_protected_nights_do_not_count():
    db = db_with()
    runs = ie.stretches("mid", CONFIG, TODAY)
    first = max(runs[0]["from"], TODAY)
    days = db.store["pricing_calm_daily"][f"{TODAY}_MAXELA"]["dates"]
    base = ie.sellable(db, CONFIG, TODAY, "MAXELA", "mid", "startPrice", set())
    days[f"{first}|GEL"]["kind"] = "manual"
    nxt = ie._add(first, 1)
    days[f"{nxt}|GEL"]["kind"] = "protected"
    locked = ie._add(first, 2)
    sl = ie.sellable(db, CONFIG, TODAY, "MAXELA", "mid", "startPrice", {f"MAXELA_{locked}"})
    assert sl["count"] == base["count"] - 3 and sl["skipped"]["hand_set"] == 3
    assert all(n >= TODAY for n in sl["nights"])                            # nothing before today is ever listed


def test_one_waiting_idea_per_room_season_and_price_list_no_repeats(monkeypatch):
    db = db_with()
    maker(db, [idea("MAXELA", "mid", "startPrice", 100, 90), idea("MAXELA", "mid", "floor", 70, 60), idea("MAXELA", "mid", "ceiling", 140, 150),
               idea("MAXELA", "mid", "startPriceEur", 100, 90)], monkeypatch)
    got = sorted((v["property"], v["season"], ie.price_list_of(v["type"])) for v in made(db))
    assert got == [("MAXELA", "mid", "GEL"), ("MAXELA", "mid", "USD")]


def test_the_prompt_lists_all_rooms_and_only_what_can_still_be_sold(monkeypatch):
    mid_nights = {D(k) for k in range(400) if ie.season_of(D(k), CONFIG) == "mid"}
    db = db_with(booked=mid_nights, skip_rooms=("XCV_2",))
    prompt = maker(db, [], monkeypatch)[0]
    block = prompt[prompt.index("SELLABLE NIGHTS"):]
    for rt in ps.ROOM_TYPES:
        if rt != "XCV_2":
            assert f"\n{rt} (booked" in block, rt                           # every room with something to sell is there
    assert "  low:" in block and "  mid:" not in block                      # fully booked seasons are not offered
    assert "XCV_2" in block.split("Rooms with nothing left")[-1]


def cleanup_module():
    spec = importlib.util.spec_from_file_location("ideas_logic_cleanup", os.path.join(ROOT, "scripts", "ideas_logic_cleanup.py"))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def pending(prop, season, typ="startPrice", ts="2026-10-10T09:00:00", **extra):
    return {"property": prop, "season": season, "type": typ, "current": 100, "suggested": 90, "status": "pending", "ts": ts, "reasoning": "x", "date": "2026-10-10", **extra}


def test_cleanup_marks_ideas_with_nothing_left_to_sell_and_repeats_and_keeps_the_history(monkeypatch):
    mid_nights = {D(k) for k in range(400) if ie.season_of(D(k), CONFIG) == "mid"}
    db = db_with(booked=mid_nights)
    ideas = {"full": pending("MAXELA", "mid"), "ok1": pending("ROOMS", "low", ts="2026-10-09T09:00:00"), "ok2": pending("ROOMS", "low", "floor", ts="2026-10-11T09:00:00"),
             "ok3": pending("ROOMS", "low", "startPriceEur"), "done": {**pending("MAXELA", "mid"), "status": "approved"}}
    db.store["pricing_proposals"] = ideas
    m = cleanup_module()
    dry = m.run(db, TODAY, CONFIG, dry=True)
    assert dry["not_useful"] == 1 and dry["repeats"] == 1 and ideas["full"]["status"] == "pending"
    out = m.run(db, TODAY, CONFIG)
    assert out["left"] == 2 and out["by_room"] == {"ROOMS": 2}
    p = db.store["pricing_proposals"]
    assert p["full"]["status"] == "rejected" and p["full"]["rejection_reason"] == "Not useful: nothing left to sell"
    assert p["ok1"]["status"] == "rejected" and p["ok1"]["rejection_reason"] == "Replaced by a newer idea" and p["ok1"]["replaced_by"] == "ok2"
    assert p["ok2"]["status"] == "pending" and p["ok3"]["status"] == "pending" and p["done"]["status"] == "approved"
    assert len(p) == 5                                                       # nothing deleted


def test_a_not_useful_idea_is_not_followed_by_the_scorecard_or_the_twin():
    import idea_scorecard as sc
    assert sc.decision_of({"status": "rejected", "rejection_reason": "Not useful: nothing left to sell"}) is None
    assert sc.decision_of({"status": "rejected", "rejection_reason": "Replaced by a newer idea"}) == "replaced"
    assert sc.decision_of({"status": "rejected"}) == "skipped"
