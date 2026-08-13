# pms-platform (Phase 0 — in transit)

Greenfield SaaS PMS. **Not** personal Maxela ops.

This folder lives in the Maxela ops repo only until Claude Code creates the standalone
`pms-platform` GitHub repository. Then this tree should be moved there — do not mix
with root HTML/Python tools.

## Phase 0 ownership

| Area | Owner | Status |
|------|--------|--------|
| `packages/design-system` | Cursor | In progress |
| Auth, org model, schema, CI, Turbo scaffold | Claude Code | Waiting |
| App shells (host / guest / HK) | Cursor | **Blocked** until auth model is live |

## Open this to see the design

Open `packages/design-system/preview/index.html` in a browser (no build step).

## Do not

- Port Maxela family accounting, MiniHotel scrapers, or personal trackers here
- Invent Firestore collections — see `docs/new-pms/FIRESTORE_SCHEMA.md` in the ops repo
- Build guest login/signup (guests use `/g/{orgSlug}/{token}`)
