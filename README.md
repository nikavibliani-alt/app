# Maxela Apartments — Guest Check-in App

Static guest check-in portal hosted at **https://app.maxelaapartments.com/**

## Which file to work on

| File | Role | Live URL |
|------|------|----------|
| **`checkin-admin.html`** | **Production admin (live)** | https://app.maxelaapartments.com/checkin-admin.html |
| **`checkin-admin-sandbox.html`** | Dev admin sandbox | https://app.maxelaapartments.com/checkin-admin-sandbox.html |
| **`checkin-guest.html`** | **Production guest app (live)** | https://app.maxelaapartments.com/checkin-guest.html |
| **`checkin-guest-sandbox-2.html`** | Dev sandbox (+ toolbar) | https://app.maxelaapartments.com/checkin-guest-sandbox-2.html |
| `checkin-guest-v2.html` | Redirect → checkin-guest.html | https://app.maxelaapartments.com/checkin-guest-v2.html |
| `checkin-guest-sandbox.html` | Sandbox 1 (Claude Phase 1 shell) | https://app.maxelaapartments.com/checkin-guest-sandbox.html |
| `checkin-guest-sandbox-3.html` | Sandbox 3 — functional portal experiment (parked; host will revisit later) | https://app.maxelaapartments.com/checkin-guest-sandbox-3.html |

**Source of truth for all redesign work:** [`GUEST_CHECKIN_REDESIGN.md`](GUEST_CHECKIN_REDESIGN.md)

Read that file before any major edit. It contains:
- Product decisions and phase logic (§2–§7)
- Workstream claims (§9)
- Design tokens (§13)
- Sandbox 1 / 2 / 3 build state (§14–§19)
- **Copy-paste prompt for Claude** to continue Sandbox 2 (§20)

## Quick start for agents

1. Edit **`checkin-admin-sandbox.html`** or **`checkin-guest-sandbox-2.html`**, test on sandbox URLs.
2. Promote: `node scripts/build-admin-production.js` and/or `node scripts/build-guest-production.js`.
3. See **`docs/SANDBOX_TESTING.md`** for URLs and backend notes.

## Related docs

- **`docs/AGENT_HANDOFF.md`** — start here for Claude Code / Cursor
- **`docs/OPERATIONS.md`** — MiniHotel cron-job.org, deploy, monitors
- `GUEST_CHECKIN_REDESIGN.md` — design history + coordination
- `docs/SANDBOX_TESTING.md` — live URLs, promote scripts

## Firebase

Project: `sleepy-5c962` · Guest docs: `checkin_guests/{aptId}_{arrivalDate}`
