# Claude Code — Status & Review Report

**Last updated:** 2026-08-31  
**Branch:** `main` (sandbox work merged)  
**Host sign-off:** Sandbox UI **works fine** — treat as current baseline. Live cutover still pending host approval.

---

## Current state (2026-08-31) — read this first

### Sandbox — ✅ signed off by host

Everything below is on **`main`** and live on GitHub Pages (~1–2 min after push):

| Area | URL | Notes |
|------|-----|-------|
| **Hub** | https://app.maxelaapartments.com/sandbox-index.html | Start here |
| **Admin sandbox** | https://app.maxelaapartments.com/checkin-admin-sandbox.html | Password: same as live admin |
| **Guest sandbox-2** | https://app.maxelaapartments.com/checkin-guest-sandbox-2.html | Canonical guest redesign |

**Recent merges (all on main):**

- Full sandbox UI: no-smoking logo, Lucide icons, drag handles, apartments reorg, WhatsApp templates
- Admin login fix (duplicate `datesOverlap` removed)
- Shuttle/transfer: **one "Shuttle service"** with plane-landing icon (no duplicate Transfer)
- HK settings: **Teams** — create teams, assign apartments, PIN per team; `HK.html` filters by team
- Pipeline/backend docs, room registry, swap UI, HK guest count + bedding, health monitor

**Host (2026-08-31):** *"Everything works fine in sandbox."* — No open UI blockers reported. Elevator tab showing "Manual · 5h ago" is expected when Firebase `source` is `manual`; not a functional issue.

### Live production — unchanged

| File | Still live for guests/staff |
|------|----------------------------|
| `checkin-guest-v2.html` / `checkin-guest.html` | Yes |
| `checkin-admin.html` | Yes |

**Rule:** Do not replace live files until host explicitly approves cutover. All new work → sandbox files only.

### Backend pipeline — built, not deployed to Firebase

| Callable | Status |
|----------|--------|
| `elevatorCodeGuard` / `elevatorCodeSync` | ✅ Deployed |
| `pipeline-adminAction` (move/swap/unlock) | Code on main; **not deployed** |
| `pipeline-guestRegister` | Code on main; **not deployed** |

Sandbox **works without deploy** via Firestore fallbacks (guest registration) and direct writes (admin move/swap in sandbox HTML). Emulator optional for strict pipeline testing — see `SANDBOX_BACKEND_HANDOFF.md`.

---

## What Claude Code should do next

**Do not re-audit Phase 1 sandbox shell** — that work is done.

Pick one of these unless host assigns something else:

1. **Cutover prep** — checklist for copying sandbox → live (`docs/GUEST_LINK_STRATEGY.md`, `docs/SANDBOX_TESTING.md`)
2. **Backend deploy review** — verify `npm test` in `pipeline-functions`, then approve deploy commands when host is ready
3. **Small sandbox fixes only** — bugs in `checkin-admin-sandbox.html` / `checkin-guest-sandbox-2.html`; no live file edits
4. **HK / elevator / WhatsApp** — only if host opens a new task

**Files to edit:** `checkin-admin-sandbox.html`, `checkin-guest-sandbox-2.html`, `pipeline-functions/`, `shared/`  
**Do not edit:** `checkin-admin.html`, `checkin-guest-v2.html` (until cutover)

---

## Architecture (unchanged)

One Firestore (`sleepy-5c962`), no `v2_*` collections. Room moves via RoomAssignment when callables deployed; sandbox admin currently uses direct Firestore + pipeline client where wired.

See `BACKEND_MAP.md`, `MASTER_ARCHITECTURE_CURSOR.md`, `PROJECT_ARCHIVE.md`.

---

## Review fixes applied (2026-08-29, pipeline branch)

| Finding | Fix |
|---------|-----|
| 🔴 `room_moves` audit written outside transaction | Audit + success `system_logs` now inside same Firestore transaction |
| 🟡 `manualUnlock` ignored when `arrivalDate` missing | `computeGuestUnlock` checks `manualUnlock` before `no_arrival` early return |
| 🟡 `correlationId` never populated | AdminAction generates `adm_{hex}` and passes through to logs |
| 🟡 `isLikelyGuestToken` regex too narrow | Uses `isLegacyCompanionDocId()` |

**Tests:** run `cd pipeline-functions && npm test` on current main (expect all pass).

---

## File map

```
checkin-admin-sandbox.html     ← admin (canonical)
checkin-guest-sandbox-2.html   ← guest (canonical)
HK.html                        ← cleaner app (team-filtered rooms)
shared/room-registry.js        ← add apartments here
shared/hk-bedding.js
pipeline-functions/            ← backend controllers + tests

CLAUDE_CODE_REPORT.md          ← this file (status for Claude)
SANDBOX_BACKEND_HANDOFF.md     ← emulator + deploy checklist
docs/SANDBOX_TESTING.md        ← phone test checklist
GUEST_CHECKIN_REDESIGN.md      ← §20 updated Claude prompt
```

---

## Deploy commands (only when host approves backend deploy)

```bash
firebase functions:secrets:set ADMIN_ACTION_PASSWORD --project sleepy-5c962

firebase deploy --only functions:pipeline:adminAction,functions:pipeline:guestRegister --project sleepy-5c962
```

Region: `europe-west1` · Names: `pipeline-adminAction`, `pipeline-guestRegister`

---

## Suggested Claude Code prompt (Aug 2026)

```
Read CLAUDE_CODE_REPORT.md (top section — host signed off sandbox).

Context: Sandbox on main works. Host said everything is fine. Live HTML untouched.

Before any work:
1. Confirm you are editing sandbox files only (checkin-*-sandbox*.html)
2. cd pipeline-functions && npm test — report pass count

If tasked with new work: follow GUEST_CHECKIN_REDESIGN.md §0 sandbox-first rule.
If tasked with review only: confirm no regressions vs docs/SANDBOX_TESTING.md checklist.

Do NOT reopen Phase 1 shell audit or rewrite shuttle/HK teams unless host asks.
```

---

*Updated by Cursor Cloud Agent — sync when sandbox or deploy status changes.*
