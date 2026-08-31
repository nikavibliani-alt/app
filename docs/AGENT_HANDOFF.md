# Agent handoff — start here (Claude Code, Cursor)

**Last updated:** 2026-08-31  
**Repo:** `nikavibliani-alt/app` · **Firebase:** `sleepy-5c962`

---

## 🔒 Locked fact — MiniHotel reservation sync

**Do not tell the host to "enable GitHub Actions schedule" for reservations.**

| Item | Truth |
|------|--------|
| **What syncs reservations** | `minihotel_reservation_sync.py` |
| **How it runs (production)** | **[cron-job.org](https://cron-job.org)** triggers GitHub Actions **`workflow_dispatch`** on `.github/workflows/minihotel_reservation_sync.yml` every **~10 minutes** |
| **Not the primary trigger** | GitHub `schedule:` block (if present) is backup only — host uses **cron-job.org** |
| **Pricing engine** | Also triggered by cron-job.org (see `CODEBASE.md`) |

If health monitor reports stale `syncedAt`, **check cron-job.org first** — do not assume sync is broken because GitHub has no `schedule:` block. See `docs/OPERATIONS.md`.

---

## Read order

| # | File | Use for |
|---|------|---------|
| 1 | **`docs/AGENT_HANDOFF.md`** | This file — status + locked ops facts |
| 2 | **`docs/OPERATIONS.md`** | cron-job.org, monitors, deploy commands |
| 3 | **`docs/SANDBOX_TESTING.md`** | Live URLs, promote scripts |
| 4 | **`SANDBOX_BACKEND_HANDOFF.md`** | Pipeline, emulator, Firebase deploy |
| 5 | **`BACKEND_MAP.md`** | Firestore paths, function ownership |

**Do not use `CLAUDE_CODE_REPORT.md` as entry point** — deprecated stub.

---

## Current status (2026-08-31 — full go-live)

### Live apps (GitHub Pages)

| App | URL | Notes |
|-----|-----|-------|
| **Guest** | https://app.maxelaapartments.com/checkin-guest.html | New design v1.1.0 |
| **Admin** | https://app.maxelaapartments.com/checkin-admin.html | New mobile admin + pipeline |
| **HK** | https://app.maxelaapartments.com/HK.html | All sites incl. VGL |
| **Hub** | https://app.maxelaapartments.com/sandbox-index.html | Live + dev sandbox links |

Admin/guest **dev sandboxes** (edit here, then promote):

- `checkin-admin-sandbox.html` → `node scripts/build-admin-production.js`
- `checkin-guest-sandbox-2.html` → `node scripts/build-guest-production.js`

### Backend (Firebase, europe-west1)

| Function | Status |
|----------|--------|
| `elevatorCodeGuard`, `elevatorCodeSync` | Deployed |
| `adminAction`, `guestRegister` | Deployed (callable names — **no** `pipeline-` prefix in URL) |
| Secret `ADMIN_ACTION_PASSWORD` | Set (= admin HTML gate password) |

Client callable names: `adminAction`, `guestRegister` (see `shared/pipeline-emulator.js`).

### Tests

```bash
cd pipeline-functions && npm ci && npm test          # expect 54/54
node scripts/check-guest-unlock-sync.js              # browser ↔ server unlock rules
node scripts/build-guest-production.js               # smoke: promote guest
node scripts/build-admin-production.js               # smoke: promote admin
```

---

## Copy-paste prompt for Claude Code — run tests

```
Read docs/AGENT_HANDOFF.md and docs/OPERATIONS.md first.

MiniHotel sync runs from cron-job.org (every ~10 min) — NOT "enable GitHub schedule".
Do not suggest fixing reservation sync by adding GitHub Actions schedule.

System is fully live (2026-08-31):
- checkin-guest.html + checkin-admin.html (new design)
- Firebase adminAction + guestRegister deployed
- Callable names: adminAction, guestRegister (not pipeline-*)

Run pre-flight + main tests:
1. git checkout main && git pull
2. cd pipeline-functions && npm ci && npm test  (54/54)
3. node scripts/check-guest-unlock-sync.js
4. firebase functions:list --project sleepy-5c962 | grep -E 'adminAction|guestRegister|elevator'
5. Optional: curl POST adminAction (expect 403 wrong password) and guestRegister (expect BAD_REQUEST)

Report pass/fail. Do NOT redeploy unless I ask. Do NOT "fix" MiniHotel by enabling GitHub schedule.
```

---

## Rules for agents

1. **MiniHotel** → cron-job.org. See `docs/OPERATIONS.md`.
2. Edit **sandbox files**; promote with build scripts.
3. **Do not** revert live cutover without explicit host approval.
4. Admin password gate: `_ADMIN_PWD` in HTML (same as `ADMIN_ACTION_PASSWORD` secret).
