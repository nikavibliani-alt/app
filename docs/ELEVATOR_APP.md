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
