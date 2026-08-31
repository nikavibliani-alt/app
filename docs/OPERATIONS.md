# Operations — locked facts for agents

**Host confirmed — do not re-litigate in every session.**

---

## MiniHotel reservation sync

```
cron-job.org  ──workflow_dispatch──►  GitHub Actions: minihotel_reservation_sync.yml
                                              │
                                              ▼
                              minihotel_reservation_sync.py  ──►  Firestore reservations
```

| Question | Answer |
|----------|--------|
| Where does it run? | **cron-job.org** (external scheduler) |
| How often? | **~every 10 minutes** (host setup) |
| What does it call? | GitHub API → `workflow_dispatch` on `MiniHotel Reservation Sync` workflow |
| Script | `minihotel_reservation_sync.py` |
| Secrets | `FIREBASE_SERVICE_ACCOUNT`, `MINIHOTEL_USER`, `MINIHOTEL_PASS`, `MINIHOTEL_HOTEL` in GitHub |

**Wrong advice (never say this):** "Enable scheduled sync in GitHub Actions" as if sync doesn't exist.

**If reservations look stale:** check cron-job.org job history → GitHub Actions run log → script output. Not "add a schedule block" as first step.

Note: `.github/workflows/minihotel_reservation_sync.yml` may also define a GitHub `schedule:` cron as backup; **production cadence is cron-job.org per host.**

---

## Other scheduled jobs

| Job | Trigger |
|-----|---------|
| Pricing engine | cron-job.org → `pricing_engine.yml` |
| Health monitor | GitHub schedule 2× daily (`health-monitor.yml`) |
| Elevator monitor | GitHub hourly (`elevator-monitor.yml`) |
| Pipeline unit tests | GitHub on PR / push to `pipeline-functions/` |

---

## Health monitor — MiniHotel check caveat

`scripts/health-monitor.js` samples `reservations.syncedAt`. A failure like "Last syncedAt ~298h ago" may be:

- cron-job.org paused/failed (check external scheduler), **or**
- `syncedAt` not updated on all reservation writes (field sampling issue)

**First step:** cron-job.org + recent GitHub Actions sync run — not "enable GitHub schedule."

---

## Firebase deploy (pipeline)

```bash
firebase functions:secrets:set ADMIN_ACTION_PASSWORD --project sleepy-5c962
firebase deploy --only functions:pipeline:adminAction,functions:pipeline:guestRegister --project sleepy-5c962
firebase functions:list --project sleepy-5c962 | grep -E 'adminAction|guestRegister|elevator'
```

Callable names in production: **`adminAction`**, **`guestRegister`**.

---

## Live URLs

- Guest: https://app.maxelaapartments.com/checkin-guest.html
- Admin: https://app.maxelaapartments.com/checkin-admin.html
