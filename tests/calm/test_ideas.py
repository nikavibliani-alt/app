"""Ideas: closing out-of-date pending ideas, the weekly idea maker, and replacing older pending ideas."""

import os
import sys
from datetime import date, datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "scripts"))

import claude_pricing as cp  # noqa: E402
import ideas_cleanup as ic  # noqa: E402

NOW = datetime(2026, 10, 12, 10, 0)
RULES = {
    "startPrices": {"MAXELA": {"low": 100, "mid": 130}, "ROOMS": {"mid": 95}},
    "priceRules": {"MAXELA": {"low": {"min": 80, "max": 140}}, "ROOMS": {"mid": {"min": 70, "max": 130}}},
    "startPricesEur": {"BIG_APT": {"high": 80}},
    "eurRules": {"BIG_APT": {"high": {"min": 60, "max": 110}}},
}


class Snap:
    def __init__(self, id_, data):
        self.id, self._d = id_, data

    @property
    def exists(self):
        return self._d is not None

    def to_dict(self):
        return dict(self._d) if self._d is not None else None


class Query:
    def __init__(self, store, coll, conds):
        self.store, self.coll, self.conds = store, coll, conds

    def where(self, f, op, v):
        assert op == "=="
        return Query(self.store, self.coll, self.conds + [(f, v)])

    def stream(self):
        return [Snap(i, d) for i, d in list(self.store.get(self.coll, {}).items()) if all(d.get(f) == v for f, v in self.conds)]

    get = stream


class Doc:
    def __init__(self, store, coll, id_):
        self.store, self.coll, self.id = store, coll, id_

    def get(self):
        return Snap(self.id, self.store.get(self.coll, {}).get(self.id))

    def set(self, data, merge=False):
        c = self.store.setdefault(self.coll, {})
        c[self.id] = {**c.get(self.id, {}), **data} if merge else dict(data)

    def update(self, data):
        c = self.store.setdefault(self.coll, {})
        assert self.id in c, "update of a missing document"
        c[self.id].update(data)


class Batch:
    def __init__(self):
        self.ops = []

    def set(self, ref, data):
        self.ops.append(("set", ref, data))

    def update(self, ref, data):
        self.ops.append(("update", ref, data))

    def commit(self):
        for op, ref, data in self.ops:
            getattr(ref, op)(data)
        self.ops = []


class Coll(Query):
    def __init__(self, store, coll):
        super().__init__(store, coll, [])
        self._n = 0

    def document(self, id_=None):
        if id_ is None:
            self._n += 1
            id_ = f"new{len(self.store.get(self.coll, {}))}_{self._n}_{id(self)}"
        return Doc(self.store, self.coll, id_)

    def add(self, data):
        self.document().set(data)


class FakeDB:
    def __init__(self, rules=None, ideas=None):
        self.store = {"pricing_config": {"rules": rules if rules is not None else RULES}, "pricing_proposals": ideas or {}}

    def collection(self, name):
        return Coll(self.store, name)

    def batch(self):
        return Batch()


def idea(prop, season, typ, cur, sug, days_old, status="pending"):
    d = (NOW.date() - timedelta(days=days_old)).isoformat()
    return {"property": prop, "season": season, "type": typ, "current": cur, "suggested": sug, "status": status,
            "date": d, "ts": d + "T09:00:00", "reasoning": "x"}


def test_classify_age_and_current_value():
    t = NOW.date()
    ok = ic.classify(idea("MAXELA", "low", "startPrice", 100, 105, 3), RULES, t)
    assert ok["reasons"] == [] and ok["match"] == "yes" and ok["age"] == 3
    exactly7 = ic.classify(idea("MAXELA", "low", "startPrice", 100, 105, 7), RULES, t)
    assert exactly7["reasons"] == []                                     # 7 days is not older than 7 days
    old = ic.classify(idea("MAXELA", "low", "startPrice", 100, 105, 8), RULES, t)
    assert old["reasons"] == ["older than 7 days"]
    moved = ic.classify(idea("MAXELA", "low", "startPrice", 95, 105, 2), RULES, t)
    assert moved["match"] == "differs" and "current value no longer matches" in moved["reasons"]
    missing = ic.classify(idea("FREEDOM", "low", "startPrice", 95, 105, 2), RULES, t)
    assert missing["match"] == "not set" and missing["reasons"]
    for typ, rt, season, cur in [("floor", "ROOMS", "mid", 70), ("ceiling", "ROOMS", "mid", 130), ("startPriceEur", "BIG_APT", "high", 80),
                                 ("floorEur", "BIG_APT", "high", 60), ("ceilingEur", "BIG_APT", "high", 110)]:
        assert ic.classify(idea(rt, season, typ, cur, cur + 5, 1), RULES, t)["match"] == "yes", typ
        assert ic.classify(idea(rt, season, typ, cur + 1, cur + 5, 1), RULES, t)["match"] == "differs", typ


def test_summary_changes_nothing_and_apply_closes_only_out_of_date(capsys):
    ideas = {
        "a": idea("MAXELA", "low", "startPrice", 100, 105, 2),      # fresh, matches: stays
        "b": idea("MAXELA", "mid", "startPrice", 130, 140, 20),     # old: closed
        "c": idea("ROOMS", "mid", "floor", 60, 65, 1),              # fresh but number moved: closed
        "d": idea("ROOMS", "mid", "ceiling", 130, 120, 9),          # old: closed
        "e": idea("ROOMS", "mid", "startPrice", 95, 90, 7),         # exactly 7, matches: stays
        "f": idea("MAXELA", "low", "ceiling", 140, 150, 30, status="approved"),   # not pending: untouched
        "run_2026-10-01": {"type": "run_marker", "date": "2026-10-01"},
    }
    db = FakeDB(ideas=ideas)
    before = {k: dict(v) for k, v in db.store["pricing_proposals"].items()}
    rules_before = dict(db.store["pricing_config"]["rules"])
    r = ic.run(db, apply=False, now=NOW)
    out = capsys.readouterr().out
    assert r == {"pending": 5, "closed": 0, "would_close": 3, "keep": 2}
    assert db.store["pricing_proposals"] == before, "summary must not write"
    assert "Pending ideas: 5" in out and "MAXELA" in out and "ROOMS" in out
    r = ic.run(db, apply=True, now=NOW)
    assert r["closed"] == 3
    p = db.store["pricing_proposals"]
    for k in "bcd":
        assert p[k]["status"] == "rejected" and p[k]["rejection_reason"] == "out of date", k
    for k in "ae":
        assert p[k]["status"] == "pending", k
    assert p["f"] == before["f"] and p["run_2026-10-01"] == before["run_2026-10-01"]
    assert db.store["pricing_config"]["rules"] == rules_before, "rules must never change"
    # a second run finds nothing more to close
    assert ic.run(db, apply=True, now=NOW)["closed"] == 0


# ---------------- idea maker ----------------

def run_maker(db, proposals, monkeypatch, now=NOW):
    class FakeDT(datetime):
        @classmethod
        def now(cls, tz=None):
            return now
    monkeypatch.setenv("ANTHROPIC_API_KEY", "x")
    monkeypatch.setattr(cp, "datetime", FakeDT)
    import price_tracker
    monkeypatch.setattr(price_tracker, "get_learning_context", lambda db, days_back=30: "some history")
    calls = []
    monkeypatch.setattr(cp, "call_claude_analyst", lambda prompt, key: (calls.append(1), {"proposals": proposals, "daily_summary": "s"})[1])
    cp.claude_write_daily_proposal({"startPrices": {}}, db, {})
    return calls


def new_idea(prop, season, typ, cur, sug):
    return {"property": prop, "season": season, "type": typ, "current": cur, "suggested": sug, "reasoning": "because"}


def test_idea_maker_runs_once_a_week(monkeypatch):
    db = FakeDB()
    assert len(run_maker(db, [new_idea("MAXELA", "low", "startPrice", 100, 105)], monkeypatch)) == 1
    assert "run_2026-10-12" in db.store["pricing_proposals"]
    for days in (1, 3, 6):                                                    # inside the week: skipped
        assert run_maker(db, [new_idea("ROOMS", "mid", "floor", 70, 75)], monkeypatch, now=NOW + timedelta(days=days)) == [], days
    assert len(run_maker(db, [new_idea("ROOMS", "mid", "floor", 70, 75)], monkeypatch, now=NOW + timedelta(days=7))) == 1


def test_new_idea_replaces_the_older_pending_one_for_the_same_room_season_field(monkeypatch):
    ideas = {
        "old1": idea("MAXELA", "low", "startPrice", 100, 105, 9),             # same key: replaced
        "old2": idea("MAXELA", "low", "startPrice", 100, 110, 20),            # same key again: replaced
        "other_field": idea("MAXELA", "low", "floor", 80, 85, 9),             # other field: stays
        "other_season": idea("MAXELA", "mid", "startPrice", 130, 135, 9),     # other season: stays
        "other_room": idea("ROOMS", "low", "startPrice", 100, 105, 9),        # other room: stays
        "done": idea("MAXELA", "low", "startPrice", 100, 103, 30, status="approved"),   # not pending: untouched
    }
    db = FakeDB(ideas=ideas)
    run_maker(db, [new_idea("MAXELA", "low", "startPrice", 100, 108)], monkeypatch)
    p = db.store["pricing_proposals"]
    new_ids = [k for k, v in p.items() if v.get("suggested") == 108]
    assert len(new_ids) == 1 and p[new_ids[0]]["status"] == "pending"
    for k in ("old1", "old2"):
        assert p[k]["status"] == "rejected" and p[k]["rejection_reason"] == "Replaced by a newer idea" and p[k]["replaced_by"] == new_ids[0]
    for k in ("other_field", "other_season", "other_room"):
        assert p[k]["status"] == "pending", k
    assert p["done"]["status"] == "approved"
    assert p["run_2026-10-12"]["replaced"] == 2
    assert db.store["pricing_config"]["rules"] == RULES, "the idea maker never changes the rules"
