"""An idea counts only for the sellable nights whose final price really changes (the engine run with and without the idea)."""

import copy
import os
import sys
from datetime import datetime, timedelta
from types import SimpleNamespace

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import claude_pricing as cp  # noqa: E402
import idea_effect as fx  # noqa: E402
from test_holiday import mkcfg, room  # noqa: E402
from test_pmslog import DB  # noqa: E402
from test_rules import TODAY  # noqa: E402

pytestmark = pytest.mark.real_effect
NOW = datetime.combine(TODAY, datetime.min.time()) + timedelta(hours=10)


def iso(k):
    return (TODAY + timedelta(days=k)).isoformat()


def daily_doc(units, price=230, days=60, booked=(), kinds=None):
    dates = {}
    for k in range(days):
        dates[f"{iso(k)}|GEL"] = {"avail": 0 if k in booked else units, "new": price, "mh": price, "kind": (kinds or {}).get(k, "move")}
    return {"dates": dates}


def ctx_for(units, daily, state=None, **kw):
    cfg = mkcfg(units, mn=150, start=230, mx=300, holiday=False, **kw)
    db = DB()
    db.store["pricing_calm_daily"] = {f"{TODAY.isoformat()}_X": daily}
    return fx.Context(db, cfg, room(units), state if state is not None else {}, [], NOW, set())


def idea(ptype="startPrice", cur=230, sug=300, season="mid"):
    return {"property": "X", "season": season, "type": ptype, "current": cur, "suggested": sug}


def test_a_start_price_raise_changes_the_nights_the_engine_would_really_move():
    state = {"X": {}, "_meta": {}}
    before = copy.deepcopy(state)
    ctx = ctx_for(3, daily_doc(3), state)
    m = fx.measure(ctx, idea())
    assert "error" not in m and len(m["changed"]) >= 3, m
    assert all(iso(0) <= n for n in m["changed"]) and m["groups"][0]["nights"] >= 1
    assert sum(g["nights"] for g in m["groups"]) == len(m["changed"])
    ex = m["examples"][0]
    assert ex["with"] > ex["without"] and ex["date"] == m["changed"][0]
    assert state == before and ctx.cfg["rules"]["X"]["GEL"]["mid"]["start"] == 230            # nothing was changed, only copies were run


def test_an_idea_that_moves_no_price_counts_zero_nights():
    m = fx.measure(ctx_for(3, daily_doc(3)), idea("ceiling", 300, 400))                 # nobody is near the maximum
    assert m["changed"] == []


def test_booked_hand_set_and_past_nights_never_count():
    ctx = ctx_for(3, daily_doc(3, booked={2, 3, 4}, kinds={5: "manual", 6: "protected"}))
    m = fx.measure(ctx, idea())
    assert not ({iso(2), iso(3), iso(4), iso(5), iso(6)} & set(m["changed"]))
    ctx2 = ctx_for(3, daily_doc(3))
    ctx2.locks = {f"X_{iso(7)}"}
    assert iso(7) not in fx.measure(ctx2, idea())["changed"]


def test_one_unit_rooms_ignore_one_and_two_night_gaps_next_to_a_booking():
    booked = {0, 1, 2, 4, 6, 7, 10}                                    # free: 3 (1 night between bookings), 5 (1), 8-9 (2 nights before a booking), 11+ (open end)
    sellable, gaps = fx.sellable_set(daily_doc(1, booked=booked)["dates"], "X", "GEL", iso(0), 1, set())
    assert not ({iso(3), iso(5), iso(8), iso(9)} & sellable) and gaps == 4
    assert iso(11) in sellable and iso(40) in sellable
    multi, g2 = fx.sellable_set(daily_doc(3, booked=booked)["dates"], "X", "GEL", iso(0), 3, set())
    assert iso(3) in multi and g2 == 0                                  # rooms with several units keep their short gaps


def fake_ctx(units=None):
    return SimpleNamespace(db=None, live_rts={"X": {"units": 1}, "Y": {"units": 3}})


def run_checked(monkeypatch, proposals, counts):
    monkeypatch.setattr(fx, "build_context", lambda db, repo_config, now=None: fake_ctx())
    monkeypatch.setattr(fx, "measure", lambda ctx, p: {"changed": [iso(k) for k in range(counts[(p["property"], p["season"], p["type"])])], "groups": [], "examples": [],
                                                       "sellable": 9, "gaps": 0, "price_list": "GEL"})
    return cp._checked_proposals(None, proposals, lambda v: isinstance(v, (int, float)) and not isinstance(v, bool))


def test_checked_ideas_need_three_nights_never_raise_one_unit_rooms_and_keep_the_best_per_key(monkeypatch):
    mk = lambda prop, season, typ, cur, sug: {"property": prop, "season": season, "type": typ, "current": cur, "suggested": sug}  # noqa: E731
    props = [mk("X", "mid", "startPrice", 100, 90), mk("X", "mid", "floor", 100, 120),             # X has 1 unit: the raise is dropped
             mk("Y", "mid", "startPrice", 100, 90), mk("Y", "mid", "floor", 70, 60), mk("Y", "low", "startPrice", 100, 90), mk("Y", "high", "ceiling", 100, 90)]
    counts = {("X", "mid", "startPrice"): 4, ("X", "mid", "floor"): 9, ("Y", "mid", "startPrice"): 3, ("Y", "mid", "floor"): 8,
              ("Y", "low", "startPrice"): 2, ("Y", "high", "ceiling"): 5}
    kept, dropped, repeats = run_checked(monkeypatch, props, counts)
    got = {(p["property"], p["season"], p["type"]): len(p["_effect"]["changed"]) for p in kept}
    assert got == {("X", "mid", "startPrice"): 4, ("Y", "mid", "floor"): 8, ("Y", "high", "ceiling"): 5}
    assert dropped == 2 and repeats == 1                                 # a raise for 1 unit, only 2 nights; Y mid had two ideas, the better stays


def test_when_the_engine_test_cannot_be_built_no_idea_is_made(monkeypatch):
    def boom(db, repo_config, now=None):
        raise RuntimeError("no data")
    monkeypatch.setattr(fx, "build_context", boom)
    kept, dropped, _ = cp._checked_proposals(None, [{"property": "X", "season": "mid", "type": "floor", "current": 1, "suggested": 2}], lambda v: True)
    assert kept == [] and dropped == 1


def test_dates_text_for_the_log():
    assert fx.dates_text(fx.runs_of([iso(0), iso(1), iso(2), iso(9)])) == "7-9 Oct 2026 (3 nights), 16 Oct 2026 (1 night)"
