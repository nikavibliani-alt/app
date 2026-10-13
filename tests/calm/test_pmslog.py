import gzip
import json
import os
import sys
from datetime import date, datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import pmslog  # noqa: E402
from test_shadow_script import FakeDB, Doc, Query, Coll  # noqa: E402

NOW = datetime(2026, 10, 12, 15, 0)


class DDoc(Doc):
    def delete(self):
        self.store.get(self.coll, {}).pop(self.id, None)


class DQuery(Query):
    def where(self, field, op, value):
        return DQuery(self.store, self.coll, self.filters + [(field, op, value)])

    def stream(self):
        for id_, d in list(self.store.get(self.coll, {}).items()):
            if all(d.get(f) == v for f, op, v in self.filters if op == "=="):
                yield Doc.get(DDoc(self.store, self.coll, id_))


class DColl(DQuery):
    def document(self, id_):
        return DDoc(self.store, self.coll, id_)


class Batch:
    def __init__(self):
        self.ops = []

    def set(self, ref, data):
        self.ops.append((ref, data))

    def delete(self, ref):
        self.ops.append((ref, None))

    def commit(self):
        for ref, data in self.ops:
            if data is None:
                ref.delete()
            else:
                ref.set(data)
        self.ops = []


class DB(FakeDB):
    def collection(self, name):
        return DColl(self.store, name)

    def batch(self):
        return Batch()


class Blob:
    def __init__(self, store, path):
        self.store, self.path = store, path

    def exists(self):
        return self.path in self.store

    def upload_from_string(self, data, content_type=None):
        self.store[self.path] = data

    def download_as_bytes(self):
        return self.store[self.path]


class Bucket:
    def __init__(self):
        self.store = {}

    def blob(self, path):
        return Blob(self.store, path)


def result():
    return {"main_run": True, "decisions": [
        {"rt": "X", "date": "2026-11-01", "currency": "GEL", "current": 200, "proposed": 190, "kind": "move", "write": True, "why": ["a", "lowered"]},
        {"rt": "X", "date": "2026-11-02", "currency": "GEL", "current": 200, "proposed": 200, "kind": "hold", "write": False, "why": ["kept"]},
        {"rt": "X", "date": "2026-11-03", "currency": "GEL", "current": 200, "proposed": 210, "kind": "move", "write": False, "blocked": ["limit"], "why": ["blocked"]},
        {"rt": "X", "date": "2026-11-04", "currency": "GEL", "current": 200, "proposed": 150, "rejected": 120, "kind": "stopped", "write": False, "why": ["stop"]},
    ]}


def test_price_events_keep_changes_blocks_and_stops_only():
    ev = pmslog.price_events(result(), NOW, "r1", {"X": ["BOOKING"]}, "abc", "set1", sent=True)
    assert [e["date"] for e in ev] == ["2026-11-01", "2026-11-03", "2026-11-04"]
    assert ev[0]["written"] is True and ev[0]["channels"] == ["BOOKING"] and ev[0]["property_id"] == "maxela"
    assert ev[1]["written"] is False and ev[2]["new"] == 120
    assert len({e["event_id"] for e in ev}) == 3
    assert not pmslog.price_events(result(), NOW, "r1", {}, "a", "s", sent=False)[0]["written"]


def test_booking_events_hold_no_guest_data_and_are_stable():
    stays = [{"roomCode": "R1", "checkin": "2026-11-01", "checkout": "2026-11-03", "status": "CANCELLED", "reservationNumber": "9999",
              "guestName": "Secret Name", "phone": "+995", "debit": 400, "creationDate": "2026-10-01", "source": "Booking"},
             {"roomCode": "R1", "checkin": "2026-12-01", "checkout": "2026-12-02", "status": "OK", "reservationNumber": "8888",
              "debit": 100, "creationDate": "2026-10-11"},
             {"roomCode": "R1", "checkin": "2026-12-01", "checkout": "2026-12-02", "status": "OK", "reservationNumber": "7777",
              "creationDate": "2026-08-01"},
             {"roomCode": "??", "checkin": "2026-12-01", "checkout": "2026-12-02", "status": "OK"}]
    rt_of = lambda c: "X" if c == "R1" else None  # noqa: E731
    ev = pmslog.booking_events(stays, rt_of, date(2026, 10, 12), NOW)
    assert [e["event"] for e in ev] == ["cancellation", "booking"]
    text = json.dumps(ev)
    for bad in ("Secret", "9999", "8888", "+995"):
        assert bad not in text
    assert ev[0]["price_per_night"] == 200 and ev[0]["days_in_advance"] == 31
    assert ev == pmslog.booking_events(stays, rt_of, date(2026, 10, 12), NOW)


def test_write_events_is_append_only():
    db = DB()
    ev = pmslog.price_events(result(), NOW, "r1", {}, "a", "s", True)
    assert pmslog.write_events(db, "price_events", ev) == 3
    assert pmslog.write_events(db, "price_events", ev) == 0
    first = list(db.store["pmslog_price_events"].values())[0]
    changed = [dict(ev[0], new=1)]
    assert pmslog.write_events(db, "price_events", changed) == 0
    assert list(db.store["pmslog_price_events"].values())[0] == first


def test_snapshot_one_doc_per_room_and_day_and_skips_the_past():
    inv = {"X": {"2026-10-11": {"prices": {"GEL": 1}, "avail": 1}, "2026-10-12": {"prices": {"GEL": 100, "USD": 40}, "avail": 2}}}
    docs = pmslog.snapshot_docs(inv, NOW, {"X": 3}, "abc")
    assert list(docs) == ["2026-10-12_X"] and docs["2026-10-12_X"]["nights"] == {"2026-10-12": {"GEL": 100, "USD": 40, "free": 2}}


def test_settings_events_one_per_field():
    ch = [{"id": "c1", "ts": "2026-10-12T10:00:00", "by": "a@b", "type": "save", "fields": {"X.min": {"old": 1, "new": 2}, "X.max": {"old": 5, "new": 6}}},
          {"id": "c2", "ts": "2026-10-12T10:00:00"}]
    ev = pmslog.settings_events(ch, NOW)
    assert [e["field"] for e in ev] == ["X.max", "X.min"] and ev[0]["actor"] == "a@b"


def test_export_verifies_never_overwrites_and_prune_waits_for_the_export():
    db, bucket = DB(), Bucket()
    pmslog.write_events(db, "price_events", pmslog.price_events(result(), NOW, "r1", {}, "a", "s", True))
    dry = pmslog.export_day(db, bucket, "2026-10-12", dry=True)
    assert dry["streams"]["price_events"]["rows"] == 3 and not bucket.store and "pmslog_exports" not in db.store
    assert pmslog.prune(db, "2026-12-01") == {s: 0 for s in pmslog.STREAMS}            # no export yet: nothing removed
    m = pmslog.export_day(db, bucket, "2026-10-12")
    assert m["ok"] and len(bucket.store) == 1
    path = pmslog.object_path("price_events", "2026-10-12")
    assert len(gzip.decompress(bucket.store[path]).decode().strip().splitlines()) == 3
    before = bucket.store[path]
    pmslog.export_day(db, bucket, "2026-10-12")
    assert bucket.store[path] == before
    assert pmslog.prune(db, "2026-10-12")["price_events"] == 0                          # not older than the cut
    assert pmslog.prune(db, "2026-10-13", dry=True)["price_events"] == 3 and len(db.store["pmslog_price_events"]) == 3
    assert pmslog.prune(db, "2026-10-13")["price_events"] == 3 and not db.store["pmslog_price_events"]


def test_daily_job_dry_writes_nothing_and_live_exports_then_prunes():
    from datetime import timedelta
    from test_shadow_script import fake_minihotel
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "scripts"))
    import pmslog_daily as daily
    db, bucket = DB(), Bucket()
    day = NOW.date()
    old = (day - timedelta(days=95)).isoformat()
    db.collection("pmslog_price_events").document("old1").set({"day": old, "event_id": "old1"})
    db.collection("reservations").document("a").set({"roomCode": "6-1", "checkin": "2026-11-01", "checkout": "2026-11-03", "status": "CANCELLED",
                                                     "creationDate": "2026-10-01", "debit": 300, "guestName": "Secret"})
    kw = dict(db=db, now=NOW, cookie_fn=lambda: "c", get=fake_minihotel(day), bucket=bucket)
    rep = daily.main(["--dry"], **kw)
    assert rep["snapshot_rooms"] >= 1 and rep["booking_events"] == 1 and "pmslog_snapshots" not in db.store and not bucket.store
    pmslog.export_day(db, bucket, old)                                              # the old day was exported earlier
    rep = daily.main([], **kw)
    assert rep["export_ok"] and db.store["pmslog_snapshots"] and db.store["pmslog_booking_events"]
    assert rep["pruned"]["price_events"] == 1 and not db.store["pmslog_price_events"]
    assert "Secret" not in json.dumps(db.store["pmslog_booking_events"])
