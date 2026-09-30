# Guest admin redesign (overnight plan)

**Goal:** make the admin Stay tab and the guest/apartment screens easier to understand (mobile-first), without changing data logic or what is saved.

Restore point: git tag `before-guest-redesign`.

## Steps
1. Confirm before door-access changes (status badge tap)
2. Apartment editor keeps typed text on photo actions + "Discard unsaved changes?"
3. Remove Search debugger
4. Plain status names + "Door code" label
5. Redesign Stay tab
6. One place for Apartments + Guest page

## Progress log
| Step | Commit | Status |
|------|--------|--------|
| 0 | tag before-guest-redesign | done |

## HOW TO UNDO
- Undo everything: `git revert --no-edit before-guest-redesign..HEAD` (only this redesign's commits), then push to main.
- Undo one step: `git revert --no-edit <that step's commit>`, then push to main.
