# Health monitor

Automated checks that run **twice daily** (08:00 and 20:00 Tbilisi time) and email you if something is wrong.

## What it checks

| Check | What failure means |
|-------|-------------------|
| Guest unlock sync | Browser and server unlock rules drifted apart |
| Pipeline unit tests | Backend regression (54 tests) |
| MiniHotel sync freshness | No recent `syncedAt` on sampled reservations — **check cron-job.org first** (see `docs/OPERATIONS.md`), not "add GitHub schedule" |
| Room registry | Missing VGL or other rooms in `checkin_rooms` |
| HK PINs | Missing shartava/centre/vgl/admin PIN |
| Guest URL | `checkin-guest.html` not reachable |

Elevator staleness is handled separately by `elevator-monitor.yml` (hourly).

## MiniHotel sync (locked)

Production reservation sync is triggered by **cron-job.org** → GitHub `workflow_dispatch` on `minihotel_reservation_sync.yml` (~every 10 min). See **`docs/OPERATIONS.md`**. Do not treat a stale `syncedAt` warning as "enable GitHub Actions schedule."

## Run manually

```bash
cd scripts && npm install
FIREBASE_SERVICE_ACCOUNT=... RESEND_API_KEY=... node health-monitor.js
```

Or: GitHub → Actions → **Health monitor** → Run workflow

## Secrets (GitHub)

- `FIREBASE_SERVICE_ACCOUNT` — same as MiniHotel sync
- `RESEND_API_KEY` — same as elevator monitor
- `HEALTH_ALERT_EMAIL` — optional override (default nikavibliani@gmail.com)

## State

Last run saved to Firestore `config/health_monitor` for debugging.

Alert emails cooldown: 12 hours (avoid spam).
