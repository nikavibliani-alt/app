# DEPRECATED — do not use as entry point

**This file is no longer the agent handoff source.** It accumulated stale references (old PR numbers, wrong test counts, misleading “signed off” wording).

## Start here instead

1. **[docs/AGENT_HANDOFF.md](docs/AGENT_HANDOFF.md)** — current status, read order, Claude prompt  
2. **[docs/SANDBOX_TESTING.md](docs/SANDBOX_TESTING.md)** — URLs, phone checklist, go-live steps (**ground truth**)  
3. **[SANDBOX_BACKEND_HANDOFF.md](SANDBOX_BACKEND_HANDOFF.md)** — pipeline + emulator + deploy  
4. **[BACKEND_MAP.md](BACKEND_MAP.md)** — Firestore / function ownership  

---

## Historical note only

Pipeline review fixes from **2026-08-29** (transaction audit, manualUnlock, correlationId, guest token regex) are on `main`. Verify with:

```bash
cd pipeline-functions && npm test   # expect 54/54 on current main
```

Elevator guard/sync deployed. `pipeline-adminAction` and `pipeline-guestRegister` remain **not deployed** unless host requests.

---

*Kept so old links do not 404. Do not update this file for new work — update `docs/AGENT_HANDOFF.md` instead.*
