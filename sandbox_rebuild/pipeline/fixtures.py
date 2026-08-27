"""Load fake reservations into MemoryStore as v2_assignments (+ guest/res mirrors)."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .config import PipelineConfig
from .controllers.room_assignment import RoomAssignmentController
from .logging_kit import Logger
from .store import MemoryStore

DATA_PATH = Path(__file__).resolve().parents[1] / "data" / "fake_reservations.json"


def load_fake_json() -> dict[str, Any]:
    return json.loads(DATA_PATH.read_text(encoding="utf-8"))


def seed_world(
    store: MemoryStore | None = None,
    cfg: PipelineConfig | None = None,
) -> tuple[MemoryStore, PipelineConfig, RoomAssignmentController, Logger, dict[str, str]]:
    """Create assignments from fake_reservations.json.

    Returns store, cfg, controller, logger, and map of reservationNumber/slot → assignmentId
    (keys like '9001', '9004#1', '9004#2').
    """
    cfg = cfg or PipelineConfig(dry_run=True)
    store = store or MemoryStore()
    log = Logger(store, cfg)
    rooms = RoomAssignmentController(store, cfg, log)
    raw = load_fake_json()
    ids: dict[str, str] = {}

    for row in raw["reservations"]:
        status = row.get("assignmentStatus") or (
            "cancelled" if row.get("status") == "CANCELLED" else "active"
        )
        # Use controller create for active rows (conflict-safe). Cancelled seeded manually.
        if status == "active":
            result = rooms.create_assignment(
                reservation_id=row["id"],
                reservation_number=str(row["reservationNumber"]),
                room_code=row["roomCode"],
                checkin=row["checkin"],
                checkout=row["checkout"],
                guest_id=row.get("guestId"),
                actor="fixture",
                manual_room=False,
            )
            if not result.ok:
                raise RuntimeError(f"Fixture seed failed for {row['id']}: {result.code} {result.message}")
            aid = result.data["assignment"]["assignmentId"]
        else:
            aid = f"asg_fix_{row['id']}"
            doc = {
                "assignmentId": aid,
                "reservationId": row["id"],
                "reservationNumber": str(row["reservationNumber"]),
                "guestId": row.get("guestId"),
                "roomCode": row["roomCode"],
                "checkin": row["checkin"],
                "checkout": row["checkout"],
                "status": status,
                "lockSource": "minihotel",
                "manualRoom": False,
                "updatedAt": "fixture",
                "updatedBy": "fixture",
                "version": 1,
            }
            store.set(cfg.assignments, aid, doc)
            store.set(
                cfg.reservations,
                row["id"],
                {"roomCode": row["roomCode"], "status": row.get("status"), "guest": row.get("guest")},
                merge=True,
            )

        key = str(row["reservationNumber"])
        if row.get("slot"):
            key = f"{key}#{row['slot']}"
        ids[key] = aid
        # also index by guest name slug for readability in scenarios
        ids[row["guestId"]] = aid

    return store, cfg, rooms, log, ids
