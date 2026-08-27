# Maxela sandbox rebuild — START HERE

> **Safe zone.** Nothing here touches live `checkin-admin.html` or `checkin-guest-v2.html`.  
> Default mode is **in-memory dry-run** (no Firebase writes).

Design source: `/workspace/PIPELINE_DESIGN_CURSOR.md`

## What is built (phase 1)

| Piece | Status |
|-------|--------|
| MemoryStore + logging (`v2_system_logs` / `v2_system_alerts`) | done |
| **RoomAssignment** controller (move / swap / conflict / audit) | done |
| **AdminAction** façade (move_guest, swap_guests, release_to_minihotel) | done |
| Unit tests | done |
| ReservationSync / GuestUnlock / Elevator / WhatsApp | not yet |

## Run demo (safe)

```bash
cd /workspace
python3 -m sandbox-rebuild.pipeline.run_demo
```

## Run tests

```bash
cd /workspace/sandbox-rebuild
python3 -m unittest tests.test_room_assignment -v
```

## Rules encoded

1. Conflict → **block** (no silent overwrite). Use **swap** explicitly.
2. Move is **atomic** (transaction rollback on failure).
3. Every move → `v2_room_moves` audit row.
4. Mirrors `roomCode` onto `v2_guests` + `v2_reservations` when linked.
5. **No Displace** in v1.
6. Collections use prefix `v2_` only.

## Hard rules

- Do **not** edit live guest/admin HTML from this workstream
- Do **not** set `PIPELINE_DRY_RUN=0` against production until cutover is approved
- Prefer adding controllers here over patching mega-scripts in place
