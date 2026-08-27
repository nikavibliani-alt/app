"""RoomAssignment — ONLY controller allowed to change authoritative room.

Rules (PIPELINE_DESIGN_CURSOR.md §3):
  - Conflict → block (return CONFLICT). Swap is explicit mode.
  - Move is atomic (transaction).
  - Every move logged to v2_room_moves forever.
  - No Displace in v1.
  - Mirrors roomCode onto v2_guests + v2_reservations when linked.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

from ..dates import dates_overlap
from .base import BaseController, ControllerResult


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class RoomAssignmentController(BaseController):
    name = "RoomAssignment"

    def create_assignment(
        self,
        *,
        reservation_id: str,
        reservation_number: str,
        room_code: str,
        checkin: str,
        checkout: str,
        guest_id: str | None = None,
        actor: str = "sandbox",
        manual_room: bool = False,
    ) -> ControllerResult:
        """Seed helper for tests / ReservationSync handoff. Not a silent move."""
        assignment_id = f"asg_{uuid4().hex[:12]}"
        doc = {
            "assignmentId": assignment_id,
            "reservationId": reservation_id,
            "reservationNumber": reservation_number,
            "guestId": guest_id,
            "roomCode": room_code,
            "checkin": checkin,
            "checkout": checkout,
            "status": "active",
            "lockSource": "admin" if manual_room else "minihotel",
            "manualRoom": manual_room,
            "updatedAt": _now(),
            "updatedBy": actor,
            "version": 1,
        }
        conflict = self._find_conflicts(room_code, checkin, checkout, exclude_id=None)
        if conflict:
            self.log.write(
                controller=self.name,
                action="create_assignment",
                status="error",
                message="Cannot create assignment — room conflict",
                input_data={"roomCode": room_code, "checkin": checkin, "checkout": checkout},
                output_data={"conflict": conflict},
                alert=True,
            )
            return ControllerResult(False, "CONFLICT", "Room already occupied for these dates", {"conflict": conflict})

        self.store.set(self.cfg.assignments, assignment_id, doc)
        self._mirror(doc)
        self.log.write(
            controller=self.name,
            action="create_assignment",
            status="ok",
            message=f"Created assignment {assignment_id} in {room_code}",
            input_data={"reservationId": reservation_id, "roomCode": room_code},
            output_data={"assignmentId": assignment_id},
        )
        return ControllerResult(True, "CREATED", "Assignment created", {"assignment": doc})

    def move(
        self,
        *,
        assignment_id: str,
        to_room: str,
        actor: str = "sandbox",
        expected_version: int | None = None,
    ) -> ControllerResult:
        return self._mutate(
            mode="move",
            assignment_id=assignment_id,
            to_room=to_room,
            actor=actor,
            expected_version=expected_version,
            other_assignment_id=None,
        )

    def swap(
        self,
        *,
        assignment_id: str,
        other_assignment_id: str,
        actor: str = "sandbox",
    ) -> ControllerResult:
        return self._mutate(
            mode="swap",
            assignment_id=assignment_id,
            to_room=None,
            actor=actor,
            expected_version=None,
            other_assignment_id=other_assignment_id,
        )

    def release_to_minihotel(self, *, assignment_id: str, actor: str = "sandbox") -> ControllerResult:
        doc = self.store.get(self.cfg.assignments, assignment_id)
        if not doc:
            return self._fail("release_to_minihotel", "NOT_FOUND", "Assignment not found", {"assignmentId": assignment_id})
        doc["manualRoom"] = False
        doc["lockSource"] = "minihotel"
        doc["updatedAt"] = _now()
        doc["updatedBy"] = actor
        doc["version"] = int(doc.get("version") or 1) + 1
        self.store.set(self.cfg.assignments, assignment_id, doc)
        self._mirror(doc)
        self._write_move_audit(
            mode="release_to_minihotel",
            assignment=doc,
            from_room=doc["roomCode"],
            to_room=doc["roomCode"],
            actor=actor,
            before_version=int(doc["version"]) - 1,
            after_version=int(doc["version"]),
            other=None,
        )
        self.log.write(
            controller=self.name,
            action="release_to_minihotel",
            status="ok",
            message=f"Cleared manualRoom on {assignment_id}",
            input_data={"assignmentId": assignment_id},
            output_data={"manualRoom": False},
        )
        return ControllerResult(True, "RELEASED", "Now follows MiniHotel room updates", {"assignment": doc})

    # ── internals ──────────────────────────────────────────────

    def _mutate(
        self,
        *,
        mode: str,
        assignment_id: str,
        to_room: str | None,
        actor: str,
        expected_version: int | None,
        other_assignment_id: str | None,
    ) -> ControllerResult:
        inp = {
            "mode": mode,
            "assignmentId": assignment_id,
            "toRoom": to_room,
            "otherAssignmentId": other_assignment_id,
            "actor": actor,
        }

        def txn(store):
            a = store.get(self.cfg.assignments, assignment_id)
            if not a:
                raise _Abort("NOT_FOUND", "Assignment not found")
            if a.get("status") != "active":
                raise _Abort("INACTIVE", f"Assignment status is {a.get('status')}")
            if expected_version is not None and int(a.get("version") or 0) != expected_version:
                raise _Abort("VERSION_CONFLICT", "Assignment changed since you loaded it — refresh and retry")

            if mode == "swap":
                if not other_assignment_id:
                    raise _Abort("BAD_REQUEST", "swap requires other_assignment_id")
                b = store.get(self.cfg.assignments, other_assignment_id)
                if not b:
                    raise _Abort("NOT_FOUND", "Other assignment not found")
                if b.get("status") != "active":
                    raise _Abort("INACTIVE", "Other assignment is not active")
                # Swap only if date windows overlap enough that they are competing — always allowed as explicit admin choice
                room_a, room_b = a["roomCode"], b["roomCode"]
                before_a, before_b = int(a.get("version") or 1), int(b.get("version") or 1)
                a["roomCode"], b["roomCode"] = room_b, room_a
                for doc, before in ((a, before_a), (b, before_b)):
                    doc["manualRoom"] = True
                    doc["lockSource"] = "admin"
                    doc["updatedAt"] = _now()
                    doc["updatedBy"] = actor
                    doc["version"] = before + 1
                store.set(self.cfg.assignments, assignment_id, a)
                store.set(self.cfg.assignments, other_assignment_id, b)
                return {
                    "a": a,
                    "b": b,
                    "fromRoom": room_a,
                    "toRoom": room_b,
                    "beforeVersion": before_a,
                    "afterVersion": before_a + 1,
                }

            # move
            assert to_room
            if to_room == a.get("roomCode"):
                raise _Abort("NOOP", "Already in that room")
            conflicts = self._find_conflicts(
                to_room, a["checkin"], a["checkout"], exclude_id=assignment_id, store=store
            )
            if conflicts:
                raise _Abort(
                    "CONFLICT",
                    "Target room already has an overlapping stay — cancel or use swap",
                    {"conflict": conflicts[0], "conflicts": conflicts},
                )
            from_room = a["roomCode"]
            before = int(a.get("version") or 1)
            a["roomCode"] = to_room
            a["manualRoom"] = True
            a["lockSource"] = "admin"
            a["updatedAt"] = _now()
            a["updatedBy"] = actor
            a["version"] = before + 1
            store.set(self.cfg.assignments, assignment_id, a)
            return {
                "a": a,
                "b": None,
                "fromRoom": from_room,
                "toRoom": to_room,
                "beforeVersion": before,
                "afterVersion": before + 1,
            }

        try:
            result = self.store.run_transaction(txn)
        except _Abort as e:
            self.log.write(
                controller=self.name,
                action=mode,
                status="error" if e.code != "NOOP" else "warn",
                message=e.message,
                input_data=inp,
                output_data=e.data,
                alert=e.code in ("CONFLICT", "VERSION_CONFLICT"),
                severity="warn" if e.code == "CONFLICT" else "error",
            )
            return ControllerResult(False, e.code, e.message, e.data)

        # mirrors + audit outside txn copy is fine for memory store (already committed)
        self._mirror(result["a"])
        if result.get("b"):
            self._mirror(result["b"])

        self._write_move_audit(
            mode=mode,
            assignment=result["a"],
            from_room=result["fromRoom"],
            to_room=result["toRoom"],
            actor=actor,
            before_version=result["beforeVersion"],
            after_version=result["afterVersion"],
            other=result.get("b"),
        )
        if result.get("b"):
            self._write_move_audit(
                mode=mode,
                assignment=result["b"],
                from_room=result["toRoom"],
                to_room=result["fromRoom"],
                actor=actor,
                before_version=int(result["b"]["version"]) - 1,
                after_version=int(result["b"]["version"]),
                other=result["a"],
            )

        self.log.write(
            controller=self.name,
            action=mode,
            status="ok",
            message=f"{mode} {assignment_id}: {result['fromRoom']} → {result['toRoom']}",
            input_data=inp,
            output_data={
                "assignmentId": assignment_id,
                "fromRoom": result["fromRoom"],
                "toRoom": result["toRoom"],
                "version": result["afterVersion"],
            },
        )
        return ControllerResult(
            True,
            "MOVED" if mode == "move" else "SWAPPED",
            f"Room {mode} succeeded",
            {"assignment": result["a"], "other": result.get("b")},
        )

    def _find_conflicts(
        self,
        room_code: str,
        checkin: str,
        checkout: str,
        exclude_id: str | None,
        store=None,
    ) -> list[dict[str, Any]]:
        store = store or self.store
        rows = store.query(self.cfg.assignments, where=[("roomCode", "==", room_code), ("status", "==", "active")])
        conflicts = []
        for doc_id, doc in rows:
            if exclude_id and doc_id == exclude_id:
                continue
            if dates_overlap(checkin, checkout, doc.get("checkin", ""), doc.get("checkout", "")):
                conflicts.append(
                    {
                        "assignmentId": doc_id,
                        "reservationNumber": doc.get("reservationNumber"),
                        "guestId": doc.get("guestId"),
                        "roomCode": doc.get("roomCode"),
                        "checkin": doc.get("checkin"),
                        "checkout": doc.get("checkout"),
                    }
                )
        return conflicts

    def _mirror(self, assignment: dict[str, Any]) -> None:
        room = assignment.get("roomCode")
        guest_id = assignment.get("guestId")
        res_id = assignment.get("reservationId")
        if guest_id:
            self.store.set(
                self.cfg.guests,
                guest_id,
                {"roomCode": room, "assignmentId": assignment.get("assignmentId"), "updatedAt": _now()},
                merge=True,
            )
        if res_id:
            self.store.set(
                self.cfg.reservations,
                res_id,
                {
                    "roomCode": room,
                    "manualRoom": bool(assignment.get("manualRoom")),
                    "assignmentId": assignment.get("assignmentId"),
                    "updatedAt": _now(),
                },
                merge=True,
            )

    def _write_move_audit(self, **kw) -> None:
        assignment = kw["assignment"]
        self.store.add(
            self.cfg.room_moves,
            {
                "assignmentId": assignment.get("assignmentId"),
                "guestId": assignment.get("guestId"),
                "reservationId": assignment.get("reservationId"),
                "fromRoom": kw["from_room"],
                "toRoom": kw["to_room"],
                "mode": kw["mode"],
                "actor": kw["actor"],
                "at": _now(),
                "beforeVersion": kw["before_version"],
                "afterVersion": kw["after_version"],
                "otherAssignmentId": (kw["other"] or {}).get("assignmentId") if kw.get("other") else None,
            },
        )

    def _fail(self, action: str, code: str, message: str, data: dict | None = None) -> ControllerResult:
        self.log.write(
            controller=self.name,
            action=action,
            status="error",
            message=message,
            input_data=data or {},
            alert=True,
        )
        return ControllerResult(False, code, message, data)


class _Abort(Exception):
    def __init__(self, code: str, message: str, data: dict | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.data = data or {}
