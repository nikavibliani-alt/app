"""Thin AdminAction façade — all admin mutations go through here later.

v1: only room actions delegated to RoomAssignment.
Never writes Firestore collections it does not own (orchestration only).
"""
from __future__ import annotations

from typing import Any

from .base import BaseController, ControllerResult
from .room_assignment import RoomAssignmentController


class AdminActionController(BaseController):
    name = "AdminAction"

    def __init__(self, store, cfg, logger, room_assignment: RoomAssignmentController | None = None):
        super().__init__(store, cfg, logger)
        self.rooms = room_assignment or RoomAssignmentController(store, cfg, logger)

    def handle(self, action: str, payload: dict[str, Any], actor: str = "sandbox") -> ControllerResult:
        action = (action or "").strip().lower()
        try:
            if action == "move_guest":
                return self.rooms.move(
                    assignment_id=payload["assignmentId"],
                    to_room=payload["toRoom"],
                    actor=actor,
                    expected_version=payload.get("expectedVersion"),
                )
            if action == "swap_guests":
                return self.rooms.swap(
                    assignment_id=payload["assignmentId"],
                    other_assignment_id=payload["otherAssignmentId"],
                    actor=actor,
                )
            if action == "release_to_minihotel":
                return self.rooms.release_to_minihotel(
                    assignment_id=payload["assignmentId"],
                    actor=actor,
                )
            if action == "create_assignment":
                return self.rooms.create_assignment(actor=actor, **payload)
            self.log.write(
                controller=self.name,
                action=action or "unknown",
                status="error",
                message=f"Unknown admin action: {action}",
                input_data=payload,
                alert=True,
            )
            return ControllerResult(False, "UNKNOWN_ACTION", f"Unknown action: {action}")
        except KeyError as e:
            return ControllerResult(False, "BAD_REQUEST", f"Missing field: {e}")
