# Health monitor

Automated checks that run **twice daily** (08:00 and 20:00 Tbilisi time) and email you if something is wrong.

## What it checks

| Check | What failure means |
|-------|-------------------|
| Guest unlock sync | Browser and server unlock rules drifted apart |
| Pipeline unit tests | Backend regression (54 tests) |
| MiniHotel sync freshness | No reservation updated in ~36h |
| Room registry | Missing VGL or other rooms in `checkin_rooms` |
| HK PINs | Missing shartava/centre/vgl/admin PIN |
| Guest URL | `checkin-guest.html` not reachable |

Elevator staleness is handled separately by `elevator-monitor.yml` (hourly).

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
