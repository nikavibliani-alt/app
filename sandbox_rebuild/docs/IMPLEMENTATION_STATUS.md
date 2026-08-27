# Implementation status (Cursor)

| Date | What |
|------|------|
| 2026-08-27 | Phase 1: RoomAssignment + AdminAction + MemoryStore + logs + tests + demo |

Next (when approved):
1. ReservationSync → creates/updates `v2_assignments` from MiniHotel (dry-run first)
2. GuestUnlock derived state
3. ElevatorCodeSync
4. Wire admin-sandbox behind a feature flag to call AdminAction (still no live HTML)
