"""Dry-run demo — proves RoomAssignment without touching Firebase or live HTML.

Usage:
  cd /workspace
  python3 -m sandbox-rebuild.pipeline.run_demo
"""
from __future__ import annotations

from .config import load_config
from .controllers.room_assignment import RoomAssignmentController
from .logging_kit import Logger
from .store import MemoryStore


def main() -> int:
    cfg = load_config()
    store = MemoryStore()
    log = Logger(store, cfg)
    rooms = RoomAssignmentController(store, cfg, log)

    print("=== Maxela sandbox pipeline demo ===")
    print(f"dry_run={cfg.dry_run}  prefix={cfg.collection_prefix}")
    print("Live admin/guest HTML: NOT touched\n")

    a = rooms.create_assignment(
        reservation_id="res_1001",
        reservation_number="1001",
        room_code="6-1",
        checkin="2026-09-01",
        checkout="2026-09-05",
        guest_id="guest_anna",
        actor="demo",
    )
    print("1) create Anna in 6-1:", a.code, "-", a.message)

    b = rooms.create_assignment(
        reservation_id="res_1002",
        reservation_number="1002",
        room_code="6-2",
        checkin="2026-09-01",
        checkout="2026-09-04",
        guest_id="guest_ben",
        actor="demo",
    )
    print("2) create Ben in 6-2:", b.code, "-", b.message)

    # Conflict: try move Anna into Ben's room
    conflict = rooms.move(
        assignment_id=a.data["assignment"]["assignmentId"],
        to_room="6-2",
        actor="demo",
    )
    print("3) move Anna → 6-2 (expect CONFLICT):", conflict.code, "-", conflict.message)

    # Empty room works
    ok = rooms.move(
        assignment_id=a.data["assignment"]["assignmentId"],
        to_room="6-3",
        actor="demo",
    )
    print("4) move Anna → 6-3 (expect MOVED):", ok.code, "-", ok.message)

    # Swap Anna(6-3) with Ben(6-2)
    swapped = rooms.swap(
        assignment_id=a.data["assignment"]["assignmentId"],
        other_assignment_id=b.data["assignment"]["assignmentId"],
        actor="demo",
    )
    print("5) swap Anna ↔ Ben (expect SWAPPED):", swapped.code, "-", swapped.message)

    anna = store.get(cfg.assignments, a.data["assignment"]["assignmentId"])
    ben = store.get(cfg.assignments, b.data["assignment"]["assignmentId"])
    print(f"6) final rooms: Anna={anna['roomCode']}  Ben={ben['roomCode']}")

    guest_mirror = store.get(cfg.guests, "guest_anna")
    print(f"7) guest mirror roomCode={guest_mirror.get('roomCode') if guest_mirror else None}")

    moves = store.query(cfg.room_moves)
    logs = store.query(cfg.system_logs)
    alerts = store.query(cfg.system_alerts)
    print(f"8) audit: room_moves={len(moves)}  logs={len(logs)}  alerts={len(alerts)}")
    print("\nOK — sandbox controllers ran in memory only.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
