# Maxela Apartments — Guest Check-in App

Static guest check-in portal hosted at **https://app.maxelaapartments.com/**

## Which file to work on

| File | Role | Live URL |
|------|------|----------|
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

1. Read `GUEST_CHECKIN_REDESIGN.md` §0, §9, §16, §18, §20.
2. Edit **`checkin-guest-sandbox-2.html`** and **`checkin-admin-sandbox.html`** only (unless cutover approved).
3. Test at **https://app.maxelaapartments.com/sandbox-index.html** before touching live files.
4. See **`docs/SANDBOX_TESTING.md`** for the full checklist.
5. See **`CLAUDE_CODE_REPORT.md`** for Claude Code status (sandbox signed off 2026-08-31).
6. Do **not** edit `checkin-guest-v2.html` or `checkin-admin.html` until host approves cutover (§7).

## Related docs

- `GUEST_CHECKIN_REDESIGN.md` — coordination + build log + Claude prompt
- `CHECKIN_GUEST_SPEC.md` — technical audit of production guest page
- `CODEBASE.md` — system map

## Firebase

Project: `sleepy-5c962` · Guest docs: `checkin_guests/{aptId}_{arrivalDate}`
