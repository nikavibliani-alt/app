"""Reservation sync: a finished stay is never marked cancelled for dropping out of MiniHotel's answer; a stay that has not ended still is."""

import os
import sys
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

import minihotel_reservation_sync as sync  # noqa: E402


class Snap:
    def __init__(self, id_, data, store):
        self.id, self._d, self.reference = id_, data, (store, id_)

    def to_dict(self):
        return dict(self._d)


class Query:
    def __init__(self, store):
        self.store = store

    def where(self, *a):
        return self

    def get(self):
        return [Snap(i, d, self.store) for i, d in self.store.items()]


class Batch:
    def __init__(self):
        self.ops = []

    def update(self, ref, data):
        store, i = ref
        store[i].update(data)

    def delete(self, ref):
        store, i = ref
        store.pop(i, None)

    def commit(self):
        pass


class Db:
    def __init__(self, store):
        self.store = store

    def collection(self, name):
        return Query(self.store)

    def batch(self):
        return Batch()


def doc(room, ci, co, rn):
    return {"reservationNumber": rn, "roomCode": room, "checkin": ci, "checkout": co, "status": "OK2", "syncSource": "minihotel_api", "guest": "x"}


def test_finished_stays_are_not_cancelled_but_future_ones_that_vanish_are():
    today = datetime.utcnow().date()
    iso = lambda n: (today + timedelta(days=n)).isoformat()      # noqa: E731
    store = {
        "over7": doc("6-1", iso(-12), iso(-7), "A1"),             # ended exactly at the edge of the look-back window: the old bug
        "over30": doc("6-2", iso(-40), iso(-30), "A2"),
        "yesterday": doc("0-1", iso(-3), iso(-1), "A3"),
        "inhouse": doc("0-2", iso(-1), iso(2), "A4"),             # still here: if it vanishes from MiniHotel it is a cancellation
        "future": doc("0-3", iso(5), iso(8), "A5"),
        "present": doc("0-4", iso(5), iso(8), "A6"),
    }
    api = [{"reservationNumber": "A6", "status": "OK2", "roomNumber": "0-4", "checkIn": iso(5).replace("-", ""), "checkOut": iso(8).replace("-", "")}]
    sync.ROOM_MAP = dict(sync.ROOM_MAP)
    sync.detect_cancellations(Db(store), api, iso(-7), iso(60))
    status = {k: v["status"] for k, v in store.items()}
    assert status["over7"] == status["over30"] == status["yesterday"] == "OK2", status          # finished stays stay as they were
    assert status["inhouse"] == "CANCELLED" and status["future"] == "CANCELLED", status
    assert status["present"] == "OK2"


def test_repair_plan_restores_only_stays_minihotel_still_shows_with_the_same_room_and_dates():
    import importlib
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "scripts"))
    rep = importlib.import_module("reservations_repair")
    rm = {"M-6-1": "6-1", "M-6-2": "6-2"}
    docs = [
        {"id": "a", "reservationNumber": "1", "roomCode": "6-1", "checkin": "2026-06-01", "checkout": "2026-06-05"},      # valid, same room and dates
        {"id": "b", "reservationNumber": "2", "roomCode": "6-1", "checkin": "2026-06-01", "checkout": "2026-06-05"},      # not in the answer
        {"id": "c", "reservationNumber": "3", "roomCode": "6-1", "checkin": "2026-06-01", "checkout": "2026-06-05"},      # MiniHotel says cancelled
        {"id": "d", "reservationNumber": "4", "roomCode": "6-1", "checkin": "2026-06-01", "checkout": "2026-06-05"},      # other room
        {"id": "e", "reservationNumber": "5", "roomCode": "6-1", "checkin": "2026-06-01", "checkout": "2026-06-05"},      # other dates
    ]
    row = lambda rn, st, room, ci, co: {"reservationNumber": rn, "status": st, "roomNumber": room, "checkIn": ci, "checkOut": co}   # noqa: E731
    api = [row("1", "OK2", "M-6-1", "20260601", "20260605"), row("3", "ALC", "M-6-1", "20260601", "20260605"),
           row("4", "OK", "M-6-2", "20260601", "20260605"), row("5", "OK", "M-6-1", "20260601", "20260607")]
    p = rep.plan(docs, api, rm)
    assert [i for i, _ in p["restore"]] == ["a"]
    assert sum(p["left"].values()) == 4
