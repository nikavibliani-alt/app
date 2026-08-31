# Maxela Apartments — Guest Check-in App

Static guest check-in portal hosted at **https://app.maxelaapartments.com/**

## Which file to work on

| File | Role | Live URL |
|------|------|----------|
| **`checkin-guest-sandbox-2.html`** | **Canonical redesign — continue here** | https://app.maxelaapartments.com/checkin-guest-sandbox-2.html |
| `checkin-guest-v2.html` | Production (do not replace until cutover) | https://app.maxelaapartments.com/checkin-guest-v2.html |
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

1. Read **`docs/AGENT_HANDOFF.md`** first, then `docs/SANDBOX_TESTING.md`.
2. Read `GUEST_CHECKIN_REDESIGN.md` §0, §9, §13 for design rules (§20 points back to AGENT_HANDOFF).
3. Edit **`checkin-guest-sandbox-2.html`** and **`checkin-admin-sandbox.html`** only (unless cutover approved).
4. Test at **https://app.maxelaapartments.com/sandbox-index.html** before touching live files.
5. Do **not** edit `checkin-guest-v2.html` or `checkin-admin.html` until host approves cutover (§7).

## Related docs

- `GUEST_CHECKIN_REDESIGN.md` — coordination + build log
- `docs/AGENT_HANDOFF.md` — agent entry point (replaces deprecated `CLAUDE_CODE_REPORT.md`)
- `CHECKIN_GUEST_SPEC.md` — technical audit of production guest page
- `CODEBASE.md` — system map

## Firebase

Project: `sleepy-5c962` · Guest docs: `checkin_guests/{aptId}_{arrivalDate}`
