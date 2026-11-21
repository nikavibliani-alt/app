"""Owner test: Orbe 2 minimum lowered by 10%, marked in the history, and compared before/after in the weekly numbers."""

import importlib
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "scripts"))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import pricing_shadow as ps  # noqa: E402
import weekly_numbers as wn  # noqa: E402

t = importlib.import_module("orbe2_test")


class Snap:
    def __init__(self, id_, data):
        self.id, self._d = id_, data
        self.exists = data is not None

    def to_dict(self):
        return dict(self._d) if self._d is not None else None


def _set(d, dotted, value):
    cur = d
    parts = dotted.split(".")
    for p in parts[:-1]:
        cur = cur.setdefault(p, {})
    cur[parts[-1]] = value


class Doc:
    def __init__(self, store, coll, id_):
        self.store, self.coll, self.id = store, coll, id_

    def get(self):
        return Snap(self.id, self.store.get(self.coll, {}).get(self.id))

    def update(self, fields):
        d = self.store.setdefault(self.coll, {}).setdefault(self.id, {})
        for k, v in fields.items():
            _set(d, k, v)

    def set(self, data, merge=False):
        c = self.store.setdefault(self.coll, {})
        c[self.id] = {**c.get(self.id, {}), **data} if merge else dict(data)


class Coll:
    def __init__(self, store, name):
        self.store, self.name = store, name

    def document(self, id_):
        return Doc(self.store, self.name, id_)

    def add(self, data):
        n = len(self.store.setdefault(self.name, {}))
        self.store[self.name][f"auto{n}"] = data

    def where(self, field, op, value):
        return type("Q", (), {"stream": lambda _s: [Snap(i, d) for i, d in self.store.get(self.name, {}).items() if d.get(field) == value]})()


class DB:
    def __init__(self):
        self.store = {}

    def collection(self, name):
        return Coll(self.store, name)


class Bucket:
    def __init__(self):
        self.files = {}

    def blob(self, path):
        b = self

        class B:
            def exists(_):
                return path in b.files

            def upload_from_string(_, data, content_type=None):
                b.files[path] = data

            def download_as_bytes(_):
                return b.files[path]
        return B()


def seeded():
    db = DB()
    page = {"priceRules": {"ORBE_2": {s: {"min": 170, "max": 300} for s in ps.SEASONS}}, "startPrices": {"ORBE_2": {s: 220 for s in ps.SEASONS}},
            "eurRules": {"ORBE_2": {s: {"min": 35, "max": 70} for s in ps.SEASONS}}, "startPricesEur": {"ORBE_2": {s: 55 for s in ps.SEASONS}},
            "priceRules_other": 1}
    db.collection("pricing_config").document("rules").set(page)
    return db


def test_a_minimum_is_ten_percent_lower_on_the_price_grid_and_always_at_least_one_step_lower():
    assert t.lowered(170, "GEL") == 155 and t.lowered(100, "GEL") == 90 and t.lowered(35, "USD") == 32 and t.lowered(12, "USD") == 11 and t.lowered(8, "USD") == 7


def test_dry_run_changes_nothing_then_the_live_run_backs_up_changes_minimums_and_marks_the_history(monkeypatch):
    monkeypatch.setattr(ps, "ROOM_TYPES", ps.ROOM_TYPES)
    db, bucket = seeded(), Bucket()
    out = t.main(["--dry"], db=db, bucket=bucket)
    assert out["rows"] and db.store["pricing_config"]["rules"]["eurRules"]["ORBE_2"]["mid"]["min"] == 35 and not bucket.files and "pricing_changes" not in db.store
    live = t.main([], db=db, bucket=bucket)
    page = db.store["pricing_config"]["rules"]
    assert page["eurRules"]["ORBE_2"]["mid"]["min"] == 32 and page["priceRules"]["ORBE_2"]["mid"]["min"] == 155                  # dollars and lari
    assert page["eurRules"]["ORBE_2"]["mid"]["max"] == 70 and page["startPricesEur"]["ORBE_2"]["mid"] == 55                      # nothing else touched
    assert len(bucket.files) == 1
    mark = list(db.store["pricing_changes"].values())[0]
    assert mark["type"] == "owner_test" and mark["detail"].startswith("owner test: lower Orbe 2 minimum") and mark["test"]["room"] == "ORBE_2"
    assert mark["test"]["weeks"] == 3 and len(mark["fields"]) == len(live["rows"]) and all(v["new"] < v["old"] for v in mark["fields"].values())
    again = t.main([], db=db, bucket=bucket)                                                                                       # never twice
    assert again == {"already": True} and page["eurRules"]["ORBE_2"]["mid"]["min"] == 32


def test_undo_puts_the_old_minimums_back_and_closes_the_test():
    db, bucket = seeded(), Bucket()
    t.main([], db=db, bucket=bucket)
    assert t.main(["--undo"], db=db)["undone"] >= 1
    page = db.store["pricing_config"]["rules"]
    assert page["eurRules"]["ORBE_2"]["mid"]["min"] == 35 and page["priceRules"]["ORBE_2"]["mid"]["min"] == 170
    assert t.main(["--undo"], db=db) == {"undone": 0}


def stay(created, ci, co, price=100.0, cur="GEL", rt="O2"):
    return {"rt": rt, "checkin": ci, "checkout": co, "created": created, "per_night": price, "currency": cur}


def test_the_weekly_numbers_compare_the_three_weeks_before_with_the_days_since_the_start():
    stays = [stay("2026-11-02", "2026-11-10", "2026-11-12"), stay("2026-11-10", "2026-11-20", "2026-11-21"),                 # before the start (21 days: 31 Oct .. 20 Nov)
             stay("2026-11-22", "2026-11-25", "2026-11-28", 40.0, "USD"), stay("2026-11-23", "2026-11-30", "2026-12-01", 90.0),     # since the start
             stay("2026-11-23", "2026-11-30", "2026-12-01", 90.0, rt="OTHER")]                                                      # another room: not counted
    d = {"price_events": [], "booking_events": [], "runs": [], "watchdog_days": {}, "stays": stays, "limits": None, "room_ids": ["O2"], "since": "2026-10-09",
         "fx": {"USD": 2.5}, "owner_tests": [{"name": "owner test: lower Orbe 2 minimum", "room": "O2", "from": "2026-11-21", "to": "2026-12-12", "change": "minimum -10%"}]}
    n = wn.build(d, "2026-11-17", "2026-11-23")
    tests = n["all"]["owner_tests"]
    assert len(tests) == 1
    x = tests[0]
    assert x["room"] == "O2" and x["started"] == "2026-11-21" and x["days_run"] == 3
    assert x["before"]["bookings"] == 2 and x["before"]["nights"] == 3 and x["before"]["days"] == 21 and x["before"]["bookings_per_week"] == 0.7
    assert x["since_start"]["bookings"] == 2 and x["since_start"]["nights"] == 4 and x["since_start"]["days"] == 3
    assert x["since_start"]["avg_price_gel"] == 95                                                                                # 40 dollars = 100 lari, and 90 lari
    assert "owner_tests" in wn.GUIDE
    d["owner_tests"][0]["from"] = "2026-12-01"                                                                                    # not started yet this week: not shown
    assert wn.build(d, "2026-11-17", "2026-11-23")["all"]["owner_tests"] == []


def test_the_xcv_owner_test_is_marked_once_per_room_and_has_no_end_date():
    x = importlib.import_module("xcv_test_mark")
    db = DB()
    assert x.main(["--dry"], db=db) == {"todo": ["XCV_1", "XCV_2"]} and "pricing_changes" not in db.store
    assert x.main([], db=db)["written"] == 2
    marks = list(db.store["pricing_changes"].values())
    assert {m["test"]["room"] for m in marks} == {"XCV_1", "XCV_2"} and all(m["type"] == "owner_test" and m["test"]["from"] == "2026-11-03" and m["test"]["to"] is None for m in marks)
    assert x.main([], db=db) == {"todo": []} and len(db.store["pricing_changes"]) == 2
    # the weekly numbers accept a test without an end date and compare the 3 weeks before 3 Nov with the days since
    stays = [stay("2026-10-20", "2026-10-25", "2026-10-26", rt="XCV_1"), stay("2026-11-05", "2026-11-06", "2026-11-08", rt="XCV_1"), stay("2026-11-07", "2026-11-09", "2026-11-10", rt="XCV_1")]
    d = {"price_events": [], "booking_events": [], "runs": [], "watchdog_days": {}, "stays": stays, "limits": None, "room_ids": ["XCV_1"], "since": "2026-10-09",
         "owner_tests": [{"name": m["test"]["name"], "room": m["test"]["room"], "from": m["test"]["from"], "to": m["test"]["to"], "change": m["test"]["change"]} for m in marks]}
    t = wn.build(d, "2026-11-09", "2026-11-15")["all"]["owner_tests"]
    one = [x_ for x_ in t if x_["room"] == "XCV_1"][0]
    assert one["before"]["bookings"] == 1 and one["since_start"]["bookings"] == 2 and one["since_start"]["days"] == 13 and one["days_run"] == 13 and one["planned_end"] is None
