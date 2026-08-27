"""Unit tests for RoomAssignment — pure memory store, no Firebase."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

# Allow `from pipeline...` when running from repo or this folder
ROOT = Path(__file__).resolve().parents[1]  # sandbox-rebuild/
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from pipeline.config import PipelineConfig  # noqa: E402
from pipeline.controllers.room_assignment import RoomAssignmentController  # noqa: E402
from pipeline.logging_kit import Logger  # noqa: E402
from pipeline.store import MemoryStore  # noqa: E402


class RoomAssignmentTests(unittest.TestCase):
    def setUp(self):
        self.cfg = PipelineConfig(dry_run=True)
        self.store = MemoryStore()
        self.log = Logger(self.store, self.cfg)
        self.rooms = RoomAssignmentController(self.store, self.cfg, self.log)

    def _mk(self, res, room, gin, gout, guest=None):
        r = self.rooms.create_assignment(
            reservation_id=f"res_{res}",
            reservation_number=str(res),
            room_code=room,
            checkin=gin,
            checkout=gout,
            guest_id=guest,
            actor="test",
        )
        self.assertTrue(r.ok, r.message)
        return r.data["assignment"]["assignmentId"]

    def test_move_into_empty_room(self):
        aid = self._mk("1", "6-1", "2026-09-01", "2026-09-05", "g1")
        r = self.rooms.move(assignment_id=aid, to_room="6-3", actor="test")
        self.assertEqual(r.code, "MOVED")
        doc = self.store.get(self.cfg.assignments, aid)
        self.assertEqual(doc["roomCode"], "6-3")
        self.assertTrue(doc["manualRoom"])
        mirror = self.store.get(self.cfg.guests, "g1")
        self.assertEqual(mirror["roomCode"], "6-3")

    def test_conflict_blocks_silent_overwrite(self):
        a = self._mk("1", "6-1", "2026-09-01", "2026-09-05", "anna")
        self._mk("2", "6-2", "2026-09-02", "2026-09-04", "ben")
        r = self.rooms.move(assignment_id=a, to_room="6-2", actor="test")
        self.assertEqual(r.code, "CONFLICT")
        doc = self.store.get(self.cfg.assignments, a)
        self.assertEqual(doc["roomCode"], "6-1")

    def test_same_day_turnover_not_conflict(self):
        a = self._mk("1", "6-1", "2026-09-01", "2026-09-03", "a")
        self._mk("2", "6-2", "2026-09-03", "2026-09-06", "b")
        r = self.rooms.move(assignment_id=a, to_room="6-2", actor="test")
        self.assertEqual(r.code, "MOVED", r.message)

    def test_swap_exchanges_rooms(self):
        a = self._mk("1", "6-1", "2026-09-01", "2026-09-05", "anna")
        b = self._mk("2", "6-2", "2026-09-01", "2026-09-05", "ben")
        r = self.rooms.swap(assignment_id=a, other_assignment_id=b, actor="test")
        self.assertEqual(r.code, "SWAPPED")
        self.assertEqual(self.store.get(self.cfg.assignments, a)["roomCode"], "6-2")
        self.assertEqual(self.store.get(self.cfg.assignments, b)["roomCode"], "6-1")

    def test_conflict_preserves_version(self):
        a = self._mk("1", "6-1", "2026-09-01", "2026-09-05")
        self._mk("2", "6-2", "2026-09-01", "2026-09-05")
        before = self.store.get(self.cfg.assignments, a)
        self.rooms.move(assignment_id=a, to_room="6-2", actor="test")
        after = self.store.get(self.cfg.assignments, a)
        self.assertEqual(before["roomCode"], after["roomCode"])
        self.assertEqual(before["version"], after["version"])

    def test_move_writes_audit_log(self):
        a = self._mk("1", "6-1", "2026-09-01", "2026-09-05")
        self.rooms.move(assignment_id=a, to_room="7-1", actor="nika")
        moves = self.store.query(self.cfg.room_moves)
        self.assertTrue(any(m[1]["toRoom"] == "7-1" and m[1]["actor"] == "nika" for m in moves))

    def test_release_to_minihotel(self):
        a = self._mk("1", "6-1", "2026-09-01", "2026-09-05")
        self.rooms.move(assignment_id=a, to_room="6-3", actor="test")
        r = self.rooms.release_to_minihotel(assignment_id=a, actor="test")
        self.assertEqual(r.code, "RELEASED")
        self.assertFalse(self.store.get(self.cfg.assignments, a)["manualRoom"])

    def test_create_conflict(self):
        self._mk("1", "6-1", "2026-09-01", "2026-09-05")
        r = self.rooms.create_assignment(
            reservation_id="res_x",
            reservation_number="x",
            room_code="6-1",
            checkin="2026-09-02",
            checkout="2026-09-04",
            actor="test",
        )
        self.assertEqual(r.code, "CONFLICT")


if __name__ == "__main__":
    unittest.main()
