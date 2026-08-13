# Phase 0 — Cursor status (for Claude Code)

## Done
- Isolated `pms-platform/` tree in the Maxela ops repo (portable; move to standalone GitHub repo when you create it)
- `packages/design-system`: CSS tokens, Button / Input / Card / Nav, React wrappers
- Preview: `packages/design-system/preview/index.html` (no build)

## Waiting on you
Do **not** ask Cursor to wire app shells to auth until:

1. Standalone repo (or you take over this `pms-platform/` folder)
2. Auth + org model + custom claims live
3. Shared types / thin API client published (even empty)

Then Cursor builds empty shells:
- `apps/host-dashboard` — staff login
- `apps/guest-portal` — **no** login; `/g/{orgSlug}/{token}` only
- `apps/housekeeping` — staff login, large taps
- `apps/provider-portal` — empty shell

## Import path (when workspace is real)
```ts
import "@pms/design-system/tokens.css";
import "@pms/design-system/components.css";
import { Button, Input, Card, Nav, tokens } from "@pms/design-system";
```

Money/date helpers: Cursor will import `@pms/domain` — do not duplicate in the design package.
