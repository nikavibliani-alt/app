"""
End-to-end test of pricing_shadow.py with a fake MiniHotel and a fake Firestore.
Proves: it reads, calculates, saves only its own results, and never sends anything.
"""

import os
import sys
import shutil
from datetime import datetime, date, timedelta

def _project_root():
    d = os.path.dirname(os.path.abspath(__file__))
    while d != os.path.dirname(d):
        if os.path.isdir(os.path.join(d, "calm_pricing")):
            return d
        d = os.path.dirname(d)
    raise RuntimeError("calm_pricing folder not found")


ROOT = _project_root()
sys.path.insert(0, ROOT)

# pricing_shadow reads config.json next to itself (it is in the repo root)
if not os.path.exists(os.path.join(ROOT, "config.json")) and os.path.exists("/root/maxela-app/config.json"):
    shutil.copy("/root/maxela-app/config.json", os.path.join(ROOT, "config.json"))

import pytest  # noqa: E402
import requests  # noqa: E402
import pricing_shadow as ps  # noqa: E402


@pytest.fixture(autouse=True)
def _no_repo_settings_file(monkeypatch, tmp_path):
    """Tests decide their own settings; the repo's calm_settings.json is not read."""
    monkeypatch.setattr(ps, "SETTINGS_FILE", str(tmp_path / "no_settings.json"))


# ---------------- fake Firestore ----------------
class Snap:
    def __init__(self, id_, data):
        self.id, self._d = id_, data
        self.exists = data is not None
        self.reference = None

    def to_dict(self):
        return dict(self._d) if self._d is not None else None


class Doc:
    def __init__(self, store, coll, id_):
        self.store, self.coll, self.id = store, coll, id_

    def get(self):
        return Snap(self.id, self.store.get(self.coll, {}).get(self.id))

    def set(self, data, merge=False):
        c = self.store.setdefault(self.coll, {})
        if merge and self.id in c:
            cur = c[self.id]
            for k, v in data.items():
                if isinstance(v, dict) and isinstance(cur.get(k), dict):
                    cur[k] = {**cur[k], **v}
                else:
                    cur[k] = v
        else:
            c[self.id] = dict(data)


class Query:
    def __init__(self, store, coll, filters=()):
        self.store, self.coll, self.filters = store, coll, list(filters)

    def where(self, field, op, value):
        return Query(self.store, self.coll, self.filters + [(field, op, value)])

    def stream(self):
        for id_, d in list(self.store.get(self.coll, {}).items()):
            ok = True
            for f, op, v in self.filters:
                x = d.get(f)
                if op == ">=" and not (x is not None and x >= v):
                    ok = False
                if op == "in" and x not in v:
                    ok = False
            if ok:
                yield Snap(id_, d)


class Coll(Query):
    def document(self, id_):
        return Doc(self.store, self.coll, id_)

    def add(self, data):
        c = self.store.setdefault(self.coll, {})
        c[f"auto{len(c)}"] = dict(data)


class FakeDB:
    def __init__(self):
        self.store = {}

    def collection(self, name):
        return Coll(self.store, name)


# ---------------- fake MiniHotel ----------------
class Resp:
    def __init__(self, data):
        self._d = data

    def raise_for_status(self):
        pass

    def json(self):
        return self._d


def fake_minihotel(today, sold_out_day=5, asked=None, real_shape=False):
    def get(url, params=None, headers=None, timeout=None):
        assert "ScreenA/Data" in url
        if asked is not None:
            asked.append(params["rooms"])
        out = []
        for rt, info in ps.ROOM_TYPES.items():
            dates = []
            for i in range(0, 91):
                ds = (today + timedelta(days=i)).isoformat()
                avail = 0 if i == sold_out_day else info["units"]
                rates = [{"PriceList": "GEL", "Price": 270.0}, {"PriceList": "EUR", "Price": 65.0}]
                if real_shape:   # as MiniHotel really sends it: Availability empty, free units in DefaultAvailability
                    dates.append({"Date": ds + "T00:00:00", "Availability": "",
                                  "DefaultAvailability": avail, "Rates": rates})
                else:
                    dates.append({"Date": ds + "T00:00:00", "Availability": avail,
                                  "DefaultAvailability": info["units"], "Rates": rates})
            out.append({"RoomTypeCode": rt, "Dates": dates})
        return Resp(out)
    return get


def seeded_db(today):
    db = FakeDB()
    db.collection("reservations").document("r1").set(
        {"roomCode": "6-1", "checkin": (today - timedelta(days=20)).isoformat(),
         "checkout": (today - timedelta(days=17)).isoformat(),
         "creationDate": (today - timedelta(days=25)).isoformat(), "status": "OK"})
    # cancelled (CL), waiting list (WL) and a stay without a booking date: never counted
    db.collection("reservations").document("r3").set(
        {"roomCode": "6-2", "checkin": (today - timedelta(days=10)).isoformat(),
         "checkout": (today - timedelta(days=8)).isoformat(),
         "creationDate": (today - timedelta(days=30)).isoformat(), "status": "CL"})
    db.collection("reservations").document("r4").set(
        {"roomCode": "6-2", "checkin": (today - timedelta(days=10)).isoformat(),
         "checkout": (today - timedelta(days=8)).isoformat(),
         "creationDate": (today - timedelta(days=30)).isoformat(), "status": "WL"})
    db.collection("reservations").document("r5").set(
        {"roomCode": "6-4", "checkin": (today - timedelta(days=10)).isoformat(),
         "checkout": (today - timedelta(days=8)).isoformat(), "creationDate": None, "status": "OK"})
    db.collection("reservations").document("r2").set(
        {"roomCode": "vgl-st1", "checkin": (today + timedelta(days=3)).isoformat(),
         "checkout": (today + timedelta(days=6)).isoformat(),
         "creationDate": (today - timedelta(days=1)).isoformat(), "status": "OK2"})
    db.collection("pricing_config").document("engine_v2").set({"rules": {
        rt: {cur: {s: {"min": 100 if cur == "GEL" else 30, "start": 200 if cur == "GEL" else 60,
                       "max": 300 if cur == "GEL" else 90}
                   for s in ps.SEASONS} for cur in ("GEL", "USD")}
        for rt in ("VGL_ST", "VGL_AP", "XCV_1", "XCV_2")}})
    return db


def test_shadow_run_reads_only_and_saves_its_own_results(monkeypatch):
    sent = []
    monkeypatch.setattr(requests, "post", lambda *a, **k: sent.append(a))
    today = date(2026, 10, 7)
    now = datetime(2026, 10, 7, 9, 5)
    db = seeded_db(today)
    res = ps.main([], db=db, get=fake_minihotel(today), cookie_fn=lambda: "cookie", now=now)
    assert sent == [] and res["writes"] == []
    assert res["ok"], res["alerts"]
    assert "pricing_shadow_daily" in db.store and "pricing_engine_state" in db.store
    # a fully booked date (0 free) must stay fully booked, not fall back to the default availability
    sold = [d for d in res["decisions"] if d["date"] == (today + timedelta(days=5)).isoformat()]
    assert sold and all(d["avail"] == 0 for d in sold)
    # all ten room types were read; VGL/XCV use engine_v2 rules
    assert {d["rt"] for d in res["decisions"]} == set(ps.ROOM_TYPES)


def test_print_mode_saves_nothing():
    today = date(2026, 10, 7)
    db = seeded_db(today)
    before = {k: dict(v) for k, v in db.store.items()}
    ps.main(["--print"], db=db, get=fake_minihotel(today), cookie_fn=lambda: "cookie",
            now=datetime(2026, 10, 7, 13, 0))
    assert db.store.keys() == before.keys()
    assert "pricing_shadow_runs" not in db.store


def test_guard_blocks_any_post():
    with ps.ReadOnlyGuard():
        try:
            requests.post("https://ssl20.minihotelpms.com/api/ScreenA", json=[])
            assert False, "post should have been refused"
        except RuntimeError:
            pass


def test_shadow_prices_move_over_days_without_touching_minihotel():
    today = date(2026, 10, 7)
    db = seeded_db(today)
    for day in range(4):
        now = datetime(2026, 10, 7, 9, 5) + timedelta(days=day)
        ps.main([], db=db, get=fake_minihotel(now.date()), cookie_fn=lambda: "c", now=now)
    state = db.store["pricing_engine_state"]["shadow_MAXELA"]["data"]
    ds = (today + timedelta(days=40)).isoformat()
    # old engine keeps 270 in MiniHotel (above MAXELA's max 270? start 255): shadow keeps its own path
    assert state[ds]["GEL"]["shadow_price"] <= 270


def test_report_after_a_few_shadow_days():
    import pricing_shadow_report as rep
    today = date(2026, 10, 7)
    db = seeded_db(today)
    for day in range(3):
        for h in (4, 9, 13):
            now = datetime(2026, 10, 7, h, 5) + timedelta(days=day)
            ps.main([], db=db, get=fake_minihotel(now.date()), cookie_fn=lambda: "c", now=now)
    text = rep.main(["--days", "5"], db=db, today=date(2026, 10, 9))
    assert "Shadow runs: 9 on 3 of 3 days | whole runs stopped by safety checks: 0" in text
    assert "Days without a successful run allowed to lower prices: 0" in text
    assert "MAXELA" in text and "->" in text
    assert "New-engine prices outside your minimum/maximum: 0" in text
    assert "biggest one-day move 0% |" in text      # MiniHotel price never changed in the fake


# ---------------- Cursor review (8 Oct 2026) ----------------

def test_guard_blocks_session_post_and_requests_request_to_minihotel(monkeypatch):
    sent = []
    monkeypatch.setattr(requests.adapters.HTTPAdapter, "send",
                        lambda self, req, **k: sent.append((req.method, req.url)) or _ok())
    with ps.ReadOnlyGuard():
        for call in (lambda: requests.Session().post("https://ssl20.minihotelpms.com/api/ScreenA", json=[]),
                     lambda: requests.request("POST", "https://ssl20.minihotelpms.com/api/ScreenA/Portals/SendPrices"),
                     lambda: requests.Session().put("https://emea5.hotelpms.cloud/x"),
                     lambda: requests.Session().delete("https://ssl20.minihotelpms.com/api/x")):
            try:
                call()
                assert False, "write to MiniHotel should have been refused"
            except RuntimeError:
                pass
        # reading MiniHotel, logging in, and Google sign-in for Firestore are allowed
        requests.Session().get("https://ssl20.minihotelpms.com/api/ScreenA/Data")
        requests.Session().post("https://login.minihotel.cloud/login.aspx", data={})
        requests.Session().post("https://oauth2.googleapis.com/token", data={})
    assert [m for m, _ in sent] == ["GET", "POST", "POST"]
    assert requests.Session.request.__name__ == "request"          # restored afterwards


def _ok():
    r = requests.Response()
    r.status_code = 200
    r._content = b"{}"
    return r


def test_only_confirmed_stays_with_a_booking_date_are_used():
    today = date(2026, 10, 7)
    db = seeded_db(today)
    stays, skipped = ps.load_reservations(db, today)
    assert {(s["rt"], s["checkin"]) for s in stays} == {
        ("MAXELA", (today - timedelta(days=20)).isoformat()),
        ("VGL_ST", (today + timedelta(days=3)).isoformat())}
    assert skipped["status"] == 2 and skipped["no_booking_date"] == 1


def test_daily_record_keeps_minihotel_and_new_engine_price_apart():
    today = date(2026, 10, 7)
    db = seeded_db(today)
    for day in range(3):
        now = datetime(2026, 10, 7, 9, 5) + timedelta(days=day)
        ps.main([], db=db, get=fake_minihotel(now.date()), cookie_fn=lambda: "c", now=now)
    doc = db.store["pricing_shadow_daily"]["2026-10-09_MAXELA"]
    rec = doc["dates"][f"{(today + timedelta(days=40)).isoformat()}|GEL"]
    assert rec["mh"] == 270.0 and rec["mh_list"] == "GEL"
    assert rec["new"] < 270 and rec["virtual_before"] < 270
    assert rec["min"] is not None and rec["max"] is not None
    run_doc = next(iter(db.store["pricing_shadow_runs"].values()))
    assert "learned_timing" in run_doc and run_doc["skipped_reservations"]["status"] == 2


def test_room_types_without_prices_are_not_read():
    today = date(2026, 10, 7)
    db = FakeDB()        # no engine_v2 rules: VGL and XCV have no minimum/start/maximum
    asked = []
    res = ps.main(["--print"], db=db, get=fake_minihotel(today, asked=asked), cookie_fn=lambda: "c",
                  now=datetime(2026, 10, 7, 9, 5))
    assert asked == ["ROOMS,MAXELA,BIG_APT,FREEDOM,ORBE_1,ORBE_2"]
    assert res["ok"], res["alerts"]
    assert {d["rt"] for d in res["decisions"]} == {"ROOMS", "MAXELA", "BIG_APT", "FREEDOM", "ORBE_1", "ORBE_2"}


# ---------------- Cursor review round 2 (8 Oct 2026) ----------------

def _no_list_in_list(x):
    if isinstance(x, dict):
        return all(_no_list_in_list(v) for v in x.values())
    if isinstance(x, list):
        return all(not isinstance(v, list) and _no_list_in_list(v) for v in x)
    return True


def test_saved_state_is_accepted_by_firestore():
    """Firestore refuses a list directly inside a list."""
    today = date(2026, 10, 7)
    db = seeded_db(today)
    for day in range(2):
        for h in (9, 13):
            now = datetime(2026, 10, 7, h, 5) + timedelta(days=day)
            ps.main([], db=db, get=fake_minihotel(now.date()), cookie_fn=lambda: "c", now=now)
    for coll in ("pricing_engine_state", "pricing_shadow_daily", "pricing_shadow_runs"):
        for doc in db.store[coll].values():
            assert _no_list_in_list(doc), coll
    moves = [st["GEL"].get("moves") for st in db.store["pricing_engine_state"]["shadow_MAXELA"]["data"].values()
             if "GEL" in st and st["GEL"].get("moves")]
    assert moves and isinstance(moves[0][0], dict)


def test_null_and_partial_rules_do_not_crash_the_loader():
    today = date(2026, 10, 7)
    db = seeded_db(today)
    db.collection("pricing_config").document("rules").set({
        "priceRules": {"ROOMS": {"low": None, "mid": {"min": None, "max": 160}}, "MAXELA": None},
        "startPrices": {"ROOMS": {"mid": None}}})
    v2 = db.store["pricing_config"]["engine_v2"]
    v2["rules"]["VGL_ST"]["GEL"]["mid"] = {"min": 100, "start": None, "max": 300}
    v2["settings"] = {"learn_timing": True}
    rules, settings = ps.load_rules(db, ps.json.load(open(os.path.join(ROOT, "config.json"))))
    assert rules["ROOMS"]["GEL"]["mid"]["min"] == 100.0      # null on the page -> config.json value
    assert "mid" not in rules["VGL_ST"]["GEL"]               # incomplete -> ignored, not a crash
    assert any("incomplete" in w for w in ps.LOADER_WARNINGS)
    cfg = ps.build_config(rules, settings, {})
    assert cfg["learn_timing"] is False                      # a settings document cannot switch it on


def test_report_counts_a_day_with_no_run():
    import pricing_shadow_report as rep
    runs = [{"ts": "2026-10-08T09:05", "day": "2026-10-08", "ok": True, "main_run": True, "warnings": []},
            {"ts": "2026-10-10T04:05", "day": "2026-10-10", "ok": True, "main_run": False, "warnings": []}]
    text = rep.summarise(date(2026, 10, 10), [], runs)
    assert "on 2 of 3 days" in text
    assert "Days without a successful run allowed to lower prices: 2 (no run at all: 1)" in text



def test_unsafe_settings_document_cannot_loosen_the_shadow():
    today = date(2026, 10, 7)
    db = seeded_db(today)
    db.store["pricing_config"]["engine_v2"]["settings"] = {
        "calm": {"daily_down": 0.9, "daily_up": 0.9}, "safety": {"max_share_changed": 1.0},
        "learn_timing": True}
    res = ps.main(["--print"], db=db, get=fake_minihotel(today), cookie_fn=lambda: "c",
                  now=datetime(2026, 10, 7, 9, 5))
    assert any(w.startswith("setting calm.daily_down") for w in res["warnings"])
    assert any(w.startswith("setting safety.max_share_changed") for w in res["warnings"])
    for d in res["decisions"]:
        if d["kind"] == "move":
            assert abs(d["proposed"] - d["current"]) / d["current"] <= 0.15 + 0.02, d


def test_report_lists_room_type_stops():
    import pricing_shadow_report as rep
    runs = [{"ts": "2026-10-08T09:05", "day": "2026-10-08", "ok": True, "main_run": True, "warnings": [],
             "stopped_room_types": ["ORBE_2"], "alerts": ["ORBE_2 USD: MiniHotel shows no price for 30 of 91 date(s)."]}]
    text = rep.summarise(date(2026, 10, 8), [], runs)
    assert "ORBE_2 in 1 run(s)" in text



def test_real_minihotel_shape_availability_empty_default_has_free_units():
    """Step 1 (8 Oct 2026): Availability is always empty; DefaultAvailability holds the free units."""
    today = date(2026, 10, 7)
    db = seeded_db(today)
    res = ps.main(["--print"], db=db, get=fake_minihotel(today, real_shape=True), cookie_fn=lambda: "c",
                  now=datetime(2026, 10, 7, 9, 5))
    assert res["ok"] and not res["stopped_room_types"], res["alerts"]
    sold = [d for d in res["decisions"] if d["date"] == (today + timedelta(days=5)).isoformat()]
    assert sold and all(d["avail"] == 0 and d["kind"] == "hold" for d in sold)
    free = [d for d in res["decisions"] if d["date"] == (today + timedelta(days=6)).isoformat()]
    assert free and all(d["avail"] == d["units"] for d in free)


def test_units_parser():
    assert ps._units("") is None and ps._units(None) is None and ps._units("x") is None
    assert ps._units(0) == 0 and ps._units("3") == 3 and ps._units(2.0) == 2


def test_old_engine_rooms_always_use_90_days_whatever_the_settings_say():
    today = date(2026, 10, 7)
    db = seeded_db(today)
    settings = {"window_days": 180, "room_types": {rt: {"window_days": 180} for rt in ps.OLD_ENGINE_RTS}}
    rules, _ = ps.load_rules(db, ps.json.load(open(os.path.join(ROOT, "config.json"))))
    cfg = ps.build_config(rules, settings, {})
    for rt in ps.OLD_ENGINE_RTS:
        assert cfg["room_types"][rt]["window_days"] == 90
