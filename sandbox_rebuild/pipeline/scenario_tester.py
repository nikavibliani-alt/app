"""Scenario tester — every important RoomAssignment case with fake reservations.

Usage:
  cd /workspace/sandbox_rebuild
  PYTHONPATH=. python3 -m pipeline.scenario_tester

Safe: in-memory only. Live admin/guest HTML not touched.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable

from .controllers.admin_action import AdminActionController
from .fixtures import seed_world
from .store import MemoryStore


@dataclass
class Check:
    ok: bool
    detail: str


@dataclass
class ScenarioResult:
    name: str
    title: str
    passed: bool
    checks: list[Check] = field(default_factory=list)
    error: str | None = None

    def add(self, ok: bool, detail: str) -> None:
        self.checks.append(Check(ok, detail))
        if not ok:
            self.passed = False


def _fresh():
    return seed_world()


def scenario_seed_all_fake_reservations() -> ScenarioResult:
    s = ScenarioResult("seed", "Load all fake reservations without conflict", True)
    store, cfg, rooms, log, ids = _fresh()
    active = store.query(cfg.assignments, where=[("status", "==", "active")])
    cancelled = store.query(cfg.assignments, where=[("status", "==", "cancelled")])
    s.add(len(active) == 8, f"active assignments={len(active)} (expect 8)")
    s.add(len(cancelled) == 1, f"cancelled assignments={len(cancelled)} (expect 1)")
    s.add("guest_anna" in ids and "9004#1" in ids, "index keys for anna + multi-room present")
    return s


def scenario_move_to_empty_room() -> ScenarioResult:
    s = ScenarioResult("move_empty", "Move guest into an empty room", True)
    store, cfg, rooms, log, ids = _fresh()
    aid = ids["guest_anna"]
    r = rooms.move(assignment_id=aid, to_room="6-4", actor="tester")
    s.add(r.code == "MOVED", f"result={r.code}")
    doc = store.get(cfg.assignments, aid)
    s.add(doc["roomCode"] == "6-4", f"assignment room={doc['roomCode']}")
    s.add(doc["manualRoom"] is True, "manualRoom set")
    mirror = store.get(cfg.guests, "guest_anna")
    s.add(mirror["roomCode"] == "6-4", f"guest mirror={mirror['roomCode']}")
    res = store.get(cfg.reservations, "res_anna")
    s.add(res["roomCode"] == "6-4" and res["manualRoom"] is True, "reservation mirror updated")
    return s


def scenario_move_conflict_blocked() -> ScenarioResult:
    s = ScenarioResult("move_conflict", "Overlapping move is blocked (no silent overwrite)", True)
    store, cfg, rooms, log, ids = _fresh()
    aid = ids["guest_anna"]
    before = store.get(cfg.assignments, aid)
    r = rooms.move(assignment_id=aid, to_room="6-2", actor="tester")  # Ben is there
    s.add(r.code == "CONFLICT", f"result={r.code}")
    after = store.get(cfg.assignments, aid)
    s.add(after["roomCode"] == before["roomCode"] == "6-1", "Anna stayed in 6-1")
    s.add(after["version"] == before["version"], "version unchanged after conflict")
    ben = store.get(cfg.assignments, ids["guest_ben"])
    s.add(ben["roomCode"] == "6-2", "Ben not overwritten")
    alerts = [a[1] for a in store.query(cfg.system_alerts)]
    s.add(any(a.get("action") == "move" and a.get("status") in ("error", "warn") for a in alerts), "conflict alert logged")
    return s


def scenario_partial_overlap_conflict() -> ScenarioResult:
    s = ScenarioResult("partial_overlap", "Partial date overlap still conflicts", True)
    store, cfg, rooms, log, ids = _fresh()
    # Faye is orb-1 09-10→09-20. Move Eli (09-12→09-15) into orb-1 → conflict
    r = rooms.move(assignment_id=ids["guest_eli"], to_room="orb-1", actor="tester")
    s.add(r.code == "CONFLICT", f"result={r.code}")
    return s


def scenario_contained_stay_conflict() -> ScenarioResult:
    s = ScenarioResult("contained_overlap", "Shorter stay inside longer stay conflicts", True)
    store, cfg, rooms, log, ids = _fresh()
    # Move Ben (09-10→09-13) into Faye's orb-1 (09-10→09-20)
    r = rooms.move(assignment_id=ids["guest_ben"], to_room="orb-1", actor="tester")
    s.add(r.code == "CONFLICT", f"result={r.code}")
    return s


def scenario_same_day_turnover_ok() -> ScenarioResult:
    s = ScenarioResult("turnover", "Same-day checkout/checkin does NOT conflict", True)
    store, cfg, rooms, log, ids = _fresh()
    # Anna 09-10→09-14. Cara 09-14→09-18 in 6-3.
    # Move Cara into 6-1: windows [14,18) vs Anna [10,14) → no overlap
    r = rooms.move(assignment_id=ids["guest_cara"], to_room="6-1", actor="tester")
    s.add(r.code == "MOVED", f"result={r.code} {r.message}")
    return s


def scenario_swap_two_guests() -> ScenarioResult:
    s = ScenarioResult("swap", "Explicit swap exchanges rooms atomically", True)
    store, cfg, rooms, log, ids = _fresh()
    a, b = ids["guest_anna"], ids["guest_ben"]
    r = rooms.swap(assignment_id=a, other_assignment_id=b, actor="tester")
    s.add(r.code == "SWAPPED", f"result={r.code}")
    s.add(store.get(cfg.assignments, a)["roomCode"] == "6-2", "Anna → 6-2")
    s.add(store.get(cfg.assignments, b)["roomCode"] == "6-1", "Ben → 6-1")
    s.add(store.get(cfg.guests, "guest_anna")["roomCode"] == "6-2", "Anna guest mirror")
    s.add(store.get(cfg.guests, "guest_ben")["roomCode"] == "6-1", "Ben guest mirror")
    moves = store.query(cfg.room_moves, where=[("mode", "==", "swap")])
    s.add(len(moves) >= 2, f"swap audits={len(moves)}")
    return s


def scenario_move_noop_same_room() -> ScenarioResult:
    s = ScenarioResult("noop", "Move to same room is NOOP", True)
    store, cfg, rooms, log, ids = _fresh()
    r = rooms.move(assignment_id=ids["guest_anna"], to_room="6-1", actor="tester")
    s.add(r.code == "NOOP", f"result={r.code}")
    return s


def scenario_missing_assignment() -> ScenarioResult:
    s = ScenarioResult("not_found", "Missing assignment returns NOT_FOUND", True)
    store, cfg, rooms, log, ids = _fresh()
    r = rooms.move(assignment_id="asg_does_not_exist", to_room="6-4", actor="tester")
    s.add(r.code == "NOT_FOUND", f"result={r.code}")
    return s


def scenario_inactive_blocked() -> ScenarioResult:
    s = ScenarioResult("inactive", "Cancelled assignment cannot be moved", True)
    store, cfg, rooms, log, ids = _fresh()
    r = rooms.move(assignment_id=ids["guest_gone"], to_room="0-2", actor="tester")
    s.add(r.code == "INACTIVE", f"result={r.code}")
    return s


def scenario_version_conflict() -> ScenarioResult:
    s = ScenarioResult("version", "Stale expected_version is rejected", True)
    store, cfg, rooms, log, ids = _fresh()
    aid = ids["guest_anna"]
    rooms.move(assignment_id=aid, to_room="6-4", actor="tester")  # version becomes 2
    r = rooms.move(assignment_id=aid, to_room="7-3", actor="tester", expected_version=1)
    s.add(r.code == "VERSION_CONFLICT", f"result={r.code}")
    s.add(store.get(cfg.assignments, aid)["roomCode"] == "6-4", "room unchanged after stale write")
    return s


def scenario_release_to_minihotel() -> ScenarioResult:
    s = ScenarioResult("release", "Follow MiniHotel again clears manualRoom", True)
    store, cfg, rooms, log, ids = _fresh()
    aid = ids["guest_anna"]
    rooms.move(assignment_id=aid, to_room="6-4", actor="tester")
    s.add(store.get(cfg.assignments, aid)["manualRoom"] is True, "manual after move")
    r = rooms.release_to_minihotel(assignment_id=aid, actor="tester")
    s.add(r.code == "RELEASED", f"result={r.code}")
    s.add(store.get(cfg.assignments, aid)["manualRoom"] is False, "manual cleared")
    s.add(store.get(cfg.assignments, aid)["lockSource"] == "minihotel", "lockSource minihotel")
    return s


def scenario_create_duplicate_overlap() -> ScenarioResult:
    s = ScenarioResult("create_conflict", "Creating overlapping assignment is blocked", True)
    store, cfg, rooms, log, ids = _fresh()
    r = rooms.create_assignment(
        reservation_id="res_dup",
        reservation_number="9999",
        room_code="6-1",
        checkin="2026-09-11",
        checkout="2026-09-12",
        guest_id="guest_dup",
        actor="tester",
    )
    s.add(r.code == "CONFLICT", f"result={r.code}")
    return s


def scenario_multi_room_family_independent() -> ScenarioResult:
    s = ScenarioResult("multi_room", "Multi-room slots move independently", True)
    store, cfg, rooms, log, ids = _fresh()
    a, b = ids["9004#1"], ids["9004#2"]
    r = rooms.move(assignment_id=a, to_room="7-3", actor="tester")
    s.add(r.code == "MOVED", f"slot1 move={r.code}")
    s.add(store.get(cfg.assignments, a)["roomCode"] == "7-3", "slot1 → 7-3")
    s.add(store.get(cfg.assignments, b)["roomCode"] == "7-2", "slot2 still 7-2")
    # Moving slot2 into 7-3 should conflict with slot1
    r2 = rooms.move(assignment_id=b, to_room="7-3", actor="tester")
    s.add(r2.code == "CONFLICT", f"slot2 into slot1 room={r2.code}")
    return s


def scenario_audit_trail() -> ScenarioResult:
    s = ScenarioResult("audit", "Every successful move writes room_moves + logs", True)
    store, cfg, rooms, log, ids = _fresh()
    before_m = len(store.query(cfg.room_moves))
    before_l = len(store.query(cfg.system_logs))
    rooms.move(assignment_id=ids["guest_anna"], to_room="6-4", actor="nika")
    after_m = len(store.query(cfg.room_moves))
    after_l = len(store.query(cfg.system_logs))
    s.add(after_m == before_m + 1, f"room_moves +1 ({before_m}→{after_m})")
    s.add(after_l >= before_l + 1, f"logs grew ({before_l}→{after_l})")
    last = store.query(cfg.room_moves)[-1][1]
    s.add(last["actor"] == "nika" and last["toRoom"] == "6-4", "audit fields correct")
    return s


def scenario_admin_action_facade() -> ScenarioResult:
    s = ScenarioResult("admin_action", "AdminAction routes move/swap/unknown correctly", True)
    store, cfg, rooms, log, ids = _fresh()
    admin = AdminActionController(store, cfg, log, rooms)
    r = admin.handle("move_guest", {"assignmentId": ids["guest_anna"], "toRoom": "6-4"}, actor="nika")
    s.add(r.code == "MOVED", f"move via admin={r.code}")
    r2 = admin.handle("swap_guests", {
        "assignmentId": ids["guest_anna"],
        "otherAssignmentId": ids["guest_ben"],
    }, actor="nika")
    s.add(r2.code == "SWAPPED", f"swap via admin={r2.code}")
    r3 = admin.handle("delete_universe", {}, actor="nika")
    s.add(r3.code == "UNKNOWN_ACTION", f"unknown={r3.code}")
    return s


def scenario_no_half_state_on_conflict() -> ScenarioResult:
    s = ScenarioResult("atomic", "Failed move leaves zero partial mirror changes", True)
    store, cfg, rooms, log, ids = _fresh()
    aid = ids["guest_anna"]
    g_before = store.get(cfg.guests, "guest_anna")
    r_before = store.get(cfg.reservations, "res_anna")
    rooms.move(assignment_id=aid, to_room="6-2", actor="tester")
    g_after = store.get(cfg.guests, "guest_anna")
    r_after = store.get(cfg.reservations, "res_anna")
    s.add(g_before["roomCode"] == g_after["roomCode"] == "6-1", "guest mirror unchanged")
    s.add(r_before["roomCode"] == r_after["roomCode"] == "6-1", "reservation mirror unchanged")
    return s


SCENARIOS: list[Callable[[], ScenarioResult]] = [
    scenario_seed_all_fake_reservations,
    scenario_move_to_empty_room,
    scenario_move_conflict_blocked,
    scenario_partial_overlap_conflict,
    scenario_contained_stay_conflict,
    scenario_same_day_turnover_ok,
    scenario_swap_two_guests,
    scenario_move_noop_same_room,
    scenario_missing_assignment,
    scenario_inactive_blocked,
    scenario_version_conflict,
    scenario_release_to_minihotel,
    scenario_create_duplicate_overlap,
    scenario_multi_room_family_independent,
    scenario_audit_trail,
    scenario_admin_action_facade,
    scenario_no_half_state_on_conflict,
]


def run_all() -> list[ScenarioResult]:
    results: list[ScenarioResult] = []
    for fn in SCENARIOS:
        try:
            results.append(fn())
        except Exception as e:  # noqa: BLE001 — show scenario crash as failure
            sr = ScenarioResult(fn.__name__, getattr(fn, "__doc__", fn.__name__) or fn.__name__, False)
            sr.error = str(e)
            sr.add(False, f"CRASH: {e}")
            results.append(sr)
    return results


def main() -> int:
    print("=== Maxela pipeline scenario tester ===")
    print("Fake reservations · in-memory only · live panels NOT touched\n")
    results = run_all()
    passed = sum(1 for r in results if r.passed)
    failed = len(results) - passed

    for i, r in enumerate(results, 1):
        mark = "PASS" if r.passed else "FAIL"
        print(f"[{mark}] {i:02d}. {r.title}")
        for c in r.checks:
            print(f"       {'✓' if c.ok else '✗'} {c.detail}")
        if r.error:
            print(f"       ! {r.error}")

    print(f"\n———\n{passed}/{len(results)} scenarios passed", end="")
    if failed:
        print(f" · {failed} FAILED")
        return 1
    print(" · all good")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
