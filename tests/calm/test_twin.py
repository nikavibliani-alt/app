import importlib.util
import json
import os
import sys
from datetime import datetime, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
spec = importlib.util.spec_from_file_location("twin_run", os.path.join(ROOT, "scripts", "twin_run.py"))
sys.path.insert(0, os.path.join(ROOT, "scripts"))
twin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(twin)

from test_move_old import http, minihotel, prices_near_start, TODAY, NOW  # noqa: E402,F401
from test_pmslog import DB  # noqa: E402
import idea_scorecard as sc  # noqa: E402
import pricing_shadow as ps  # noqa: E402


def D(k):
    return (TODAY + timedelta(days=k)).isoformat()


def idea(i="i1", status="rejected", season="mid", ptype="startPrice", cur=100, sug=150, k0=2, k1=12, prop="MAXELA", **extra):
    return {"property": prop, "season": season, "type": ptype, "current": cur, "suggested": sug, "status": status, "ts": f"2026-10-0{i[-1]}T10:00:00",
            "date": D(0), "evidence": {"made_on": D(0), "looked_at": {"from": D(k0), "to": D(k1), "nights": k1 - k0 + 1}, "empty": [D(k) for k in range(k0, k1 + 1)]}, **extra}


def test_which_ideas_are_played_and_how():
    ideas = [{**idea("i1"), "id": "i1"}, {**idea("i2", status="approved", previous=100), "id": "i2"},
             {**idea("i3", status="rejected"), "rejection_reason": sc.REPLACED, "id": "i3"},
             {**idea("i4", status="pending"), "id": "i4"}, {**idea("i5", k0=-10, k1=-3), "id": "i5"}, {k: v for k, v in {**idea("i6"), "id": "i6"}.items() if k != "evidence"}]
    v = {x["id"]: x for x in twin.variants(ideas, D(0))}
    assert sorted(v) == ["i1", "i2"]                                               # replaced, waiting, over and undated are not played
    assert v["i1"]["variant"] == "as_applied" and v["i2"]["variant"] == "as_not_applied"


def test_twin_settings_are_a_copy_with_the_idea_played_the_other_way_round():
    rules, settings = ps.load_rules(DB(), json.load(open(os.path.join(ROOT, "config.json"))))
    cfg = ps.build_config(rules, settings, {})
    v = {**idea(), "variant": "as_applied", "decision": "skipped"}
    t = twin.twin_cfg(cfg, v)
    assert t["rules"]["MAXELA"]["GEL"]["mid"]["start"] == 150 and cfg["rules"]["MAXELA"]["GEL"]["mid"]["start"] != 150
    w = twin.twin_cfg(cfg, {**idea(status="approved", previous=111), "variant": "as_not_applied", "decision": "applied"})
    assert w["rules"]["MAXELA"]["GEL"]["mid"]["start"] == 111
    assert twin.twin_cfg(cfg, {**idea(season="nope"), "variant": "as_applied"}) is None


def run_twin(db, requests_log, now=NOW, ideas=None):
    for iid, doc in (ideas or {"i1": idea()}).items():
        db.collection("pricing_proposals").document(iid).set(doc)
    return twin.main([], db=db, now=now, get=minihotel(prices_near_start), cookie_fn=lambda: "c")


def test_twin_saves_prices_next_to_real_ones_and_sends_nothing(http):
    db = DB()
    r = run_twin(db, http)
    assert r["played"] == 1 and r["saved"] == 1
    assert [x for x in http if x[0] == "POST" and "login" not in x[1].lower()] == [], "the twin sent something"
    doc = db.store["pricing_twin"][f"{TODAY.isoformat()}_i1"]
    assert doc["property_id"] == "maxela" and doc["variant"] == "as_applied" and doc["stream"] == "twin" and doc["day"] == TODAY.isoformat()
    assert sorted(doc["nights"]) == [D(k) for k in range(2, 13)]
    n = doc["nights"][D(2)]
    assert "GEL" in n["twin"] and "GEL" in n["real"] and n["free"] is not None
    assert db.store["pricing_twin_state"]["i1"]["prices"]


def test_twin_dry_saves_nothing_and_a_twin_keeps_its_own_prices_between_runs(http):
    db = DB()
    twin.main(["--dry"], db=db, now=NOW, get=minihotel(prices_near_start), cookie_fn=lambda: "c")
    assert "pricing_twin" not in db.store
    run_twin(db, http)
    first = dict(db.store["pricing_twin_state"]["i1"]["prices"])
    twin.main([], db=db, now=NOW + timedelta(hours=6), get=minihotel(prices_near_start), cookie_fn=lambda: "c")
    assert set(db.store["pricing_twin_state"]["i1"]["prices"]) == set(first)


def test_comparison_after_the_nights_have_passed_is_honest_and_final_results_stay():
    db = DB()
    db.collection("pricing_proposals").document("i1").set(idea(k0=2, k1=4))
    nights = {D(k): {"twin": {"GEL": 120}, "real": {"GEL": 100}, "free": 1} for k in (2, 3, 4)}
    db.collection("pricing_twin").document(f"{D(0)}_i1").set({"idea_id": "i1", "day": D(0), "nights": nights})
    stays = [{"rt": "MAXELA", "checkin": D(2), "checkout": D(4), "created": D(1), "per_night": 105.0, "currency": "GEL"}]
    orig = sc.priced_stays
    sc.priced_stays = lambda db, today, back_days=460: stays
    try:
        assert twin.compare(db, now=datetime.combine(TODAY, datetime.min.time()) + timedelta(days=3))["final"] == 0      # nights not over yet
        r = twin.compare(db, now=datetime.combine(TODAY, datetime.min.time()) + timedelta(days=6))
    finally:
        sc.priced_stays = orig
    assert r["final"] == 1
    res = db.store["pricing_twin_results"]["i1"]
    assert res["status"] == "final" and res["nights"] == 3 and res["real_avg"] == 100 and res["twin_avg"] == 120 and res["diff_pct"] == 20 and res["sold"] == 2
    assert "20% higher than your real 100" in res["text"] and "2 of 3 sold" in res["text"] and "evidence, not proof" in res["text"]
    twin.compare(db, now=datetime.combine(TODAY, datetime.min.time()) + timedelta(days=7))
    assert db.store["pricing_twin_results"]["i1"]["updated"] == D(6)                   # a final result is not redone
