# How We Work (Phone, Laptop, Agents, Storage)

---

## Where is everything saved?

| What | Where |
|------|--------|
| Chat ideas (before docs) | Only in the Cursor conversation — **not durable** |
| Product plan (this folder) | **GitHub repo** under `docs/new-pms/` — durable, shared |
| Code changes | Git branches + Pull Requests |
| Live Maxela ops tools | Same repo root HTML/Python — **personal system**, separate from SaaS plan |
| Future SaaS app code | Will live in a **new repository** (Path B); planning docs move/copy there |

**Rule:** If it matters, it must be in a committed file. Chat is for discussion; GitHub is memory.

---

## Phone vs laptop

### You can work from phone

Especially with **Cursor Cloud Agents** ([cursor.com/agents](https://cursor.com/agents)):

- Send prompts in plain language  
- Agent edits code, commits, opens PRs  
- You review PR summaries and comment  

Good for: planning, “add this to the docs”, small fixes, kicking off tasks while away.

### Laptop is better for

- Reviewing UI/design visually  
- Approving complex PRs with big diffs  
- Local testing of guest/HK flows in a browser  
- Design polish and drag-and-drop calendar feel  

**Practical mix:** plan and direct agents from phone; do visual QA on laptop when you can.

---

## Agent mode vs Ask mode

| Mode | Edits files? | Use when |
|------|--------------|----------|
| Ask | No | Questions, planning talk |
| Agent | Yes | “Update the docs”, “scaffold”, “fix the bug” |
| Plan | After approval | Large features |

On Cloud Agents you are usually already in a write-capable agent. In the desktop app, pick **Agent** from the mode dropdown (or `Shift+Tab`).

---

## “Installing agents” — what we actually set up

You do **not** install a bunch of separate robot apps.

At project start we add:

1. These docs (`docs/new-pms/*`)  
2. Root `AGENTS.md` — standing rules for every AI assistant  
3. Optional Cursor rules / MCP (GitHub, etc.)  
4. Later: Cloud Agent environment for the **new** SaaS repo  

That makes Cursor + Claude Code consistent without you needing to be a programmer.

---

## Recommended prompt style (works on phone)

Short and concrete:

> Update `docs/new-pms/PRODUCT.md`: every host must have a separate booking website; e-sign can be drawn or auto from name. Then commit and open/update the PR.

Avoid vague “make the PMS better” — point at the doc or feature slice.
