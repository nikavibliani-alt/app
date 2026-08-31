# Agent handoff — start here (Claude Code, Cursor, etc.)

**Last updated:** 2026-08-31  
**Repo:** `nikavibliani-alt/app` · **Firebase:** `sleepy-5c962`

---

## Read these files in order

| # | File | Use for |
|---|------|---------|
| 1 | **`docs/SANDBOX_TESTING.md`** | URLs, hub, **phone checklist**, go-live steps — **ground truth for sandbox status** |
| 2 | **`SANDBOX_BACKEND_HANDOFF.md`** | Pipeline architecture, emulator, deploy commands, backend review |
| 3 | **`BACKEND_MAP.md`** | Firestore paths, which function owns what |
| 4 | **`GUEST_CHECKIN_REDESIGN.md`** | Guest UI design rules (§13), workstreams (§9) — not current task list |

**Do not start from `CLAUDE_CODE_REPORT.md`** — it is deprecated (stale PR refs, old test counts). This file replaces it.

---

## Current status (accurate)

### Sandbox UI

| Fact | Detail |
|------|--------|
| **Deployed on GitHub Pages** | Yes — sandbox HTML on `main` is live at the URLs in `docs/SANDBOX_TESTING.md` |
| **Live for guests** | **No** — hub banner: *SANDBOX — NOT LIVE FOR GUESTS* |
| **Formal phone checklist complete** | **Unknown / not recorded** — see unchecked boxes in `docs/SANDBOX_TESTING.md` |
| **Informal host feedback (Cursor, Aug 2026)** | Host said sandbox *"works fine"* and *"everything works fine in sandbox"* — **not** the same as go-live approval or cutover authorization |
| **Cutover** | Still requires explicit host approval + completing the checklist in `docs/SANDBOX_TESTING.md` |

### Backend pipeline

| Item | Status |
|------|--------|
| `elevatorCodeGuard` / `elevatorCodeSync` | Deployed |
| `pipeline-adminAction` / `pipeline-guestRegister` | Code on `main`; **not deployed** |
| Unit tests | **`cd pipeline-functions && npm test`** → **54/54** (verify on current `main`) |
| Deploy before go-live? | **Optional first night** — registration has Firestore fallback (`docs/SANDBOX_TESTING.md` step 4) |

### Files to edit vs leave alone

| Edit | Do not edit until cutover |
|------|---------------------------|
| `checkin-admin-sandbox.html` | `checkin-admin.html` |
| `checkin-guest-sandbox-2.html` | `checkin-guest-v2.html`, `checkin-guest.html` |
| `pipeline-functions/`, `shared/` | — |

---

## What agents should do next (default)

1. **If go-live is being discussed:** treat `docs/SANDBOX_TESTING.md` phone checklist as **still to do** unless the host reports pass/fail for each item.
2. **If fixing bugs:** sandbox files only; confirm on hosted sandbox URLs.
3. **If reviewing backend:** `SANDBOX_BACKEND_HANDOFF.md` + `npm test` (54 tests).
4. **Never** copy sandbox → live or deploy callables without **explicit** host instruction.

---

## Quick URLs

- Hub: https://app.maxelaapartments.com/sandbox-index.html
- Admin sandbox: https://app.maxelaapartments.com/checkin-admin-sandbox.html
- Guest sandbox-2: https://app.maxelaapartments.com/checkin-guest-sandbox-2.html

---

## Copy-paste prompt for Claude Code

```
Read docs/AGENT_HANDOFF.md, then docs/SANDBOX_TESTING.md.

Do NOT use CLAUDE_CODE_REPORT.md (deprecated).

Sandbox is on main but NOT live for guests. No formal sign-off recorded —
phone checklist may still be open. Host informal feedback: sandbox "works fine";
that is NOT authorization for cutover or live file swaps.

Backend: 54 tests in pipeline-functions; callables not deployed (optional).
Edit sandbox files only unless host explicitly approves cutover.
```
