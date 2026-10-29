# Samsung elevator app → Firestore contract

Your Samsung phone app should write to **both**:

- Firestore: `globals/elevator_code`
- RTDB: `/elevator_code`

## Required fields on auto update

```json
{
  "display_code": "789#",
  "qr_code": "<QR payload>",
  "code": "789#",
  "lastCode": "789#",
  "source": "auto",
  "updatedAt": "<ms timestamp>",
  "expires_at": "<ms + 24h>"
}
```

## Stale-auto rule (Cloud Function `elevatorCodeGuard`)

- If `source` is `auto` and the new `display_code` **equals** the previous code → write is **reverted** (stale retry).
- If the code is **different** → accepted (new day, app working).

## Manual admin override

When you paste in admin sandbox Elevator tab, `source: manual` and `lastCode` are set. Same stale-auto rule applies to phone retries until the building sends a genuinely new code.

Deploy guard: deploy `tuya-functions` (includes `elevatorCodeGuard` export).

## Stale-code alert (scripts/elevator-monitor.js)

Watched 29 Oct 2026 for 30 minutes: the Samsung app writes /elevator_code only when the code changes (no heartbeat or scan field), so the alert uses the code's `expires_at`.
- Problem: now is more than 30 minutes past `expires_at` (no `expires_at`: `updatedAt` older than 26 h).
- One email plus one push per problem; the state is `alert_open` in RTDB `/elevator_monitor`. A new code or a hand save in the admin clears it and sends a "current again" email.
- Push: the script writes `elevator_alerts/{id}`; the Cloud Function `pushOnElevatorAlert` sends it to the admin phones. Deploy it by hand once: `firebase deploy --only functions:pipeline:pushOnElevatorAlert --project sleepy-5c962`.
- Test with fake data, nothing sent: `DRY_RUN=1 ELEVATOR_FIXTURE='{"data":{...},"monitor":{...}}' node scripts/elevator-monitor.js`
