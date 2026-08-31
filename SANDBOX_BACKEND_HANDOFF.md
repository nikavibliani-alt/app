# Sandbox backend handoff — for Claude Code review

**Status (2026-08-31):** Sandbox UI is on **production hosting** (GitHub Pages) but **not live for guests**. All changes stay in **sandbox HTML** + `pipeline-functions/` — **no live cutover** (`checkin-admin.html`, `checkin-guest-v2.html` untouched).

**Agent entry point:** `docs/AGENT_HANDOFF.md` (not `CLAUDE_CODE_REPORT.md`, deprecated).

**Host note (informal, Cursor chat):** *"Everything works fine in sandbox."* That is **not** the same as completing the phone checklist in `docs/SANDBOX_TESTING.md` or approving cutover. Backend callables still optional (not deployed); sandbox uses Firestore fallbacks / direct writes where needed.

**Deploy policy:** Do **not** deploy `pipeline-adminAction` or `pipeline-guestRegister` until host explicitly asks. Use the **Functions emulator** only if you need strict callable E2E before deploy.

**Purpose:** Reference for Claude Code when reviewing pipeline code or preparing backend deploy — not an open "sandbox broken" ticket.

---

## Architecture (one Firestore, no v2_*)

| Controller | Owns writes to | Trigger |
|------------|----------------|---------|
| `elevatorCodeGuard` | Rejects stale auto elevator writes | Firestore trigger ✅ deployed |
| `elevatorCodeSync` | FS ↔ RTDB elevator reconcile | Hourly schedule ✅ deployed |
| `RoomAssignment` | `reservations.roomCode`, `checkin_guests.aptId`, `room_moves` | AdminAction only |
| `GuestUnlock` | `checkin_guests.unlockState*`, `manualUnlock` (via force_*) | AdminAction |
| `GuestRegister` | `checkin_guests/{guestToken}` create/update | HTTPS callable `pipeline-guestRegister` |
| `AdminAction` | Orchestration + `system_logs` | HTTPS callable `pipeline-adminAction` |

Shared unlock rules (browser + server): `shared/guest-unlock.js` ↔ `pipeline-functions/lib/guest-unlock.js` (keep in sync).

---

## Sandbox files wired

| File | What uses pipeline |
|------|-------------------|
| `checkin-admin-sandbox.html` | `force_unlock`, `move_guest` via `shared/pipeline-admin.js` |
| `checkin-guest-sandbox-2.html` | `shared/guest-unlock.js`; registration via `pipeline-guestRegister` (Firestore fallback when **not** in emulator mode) |
| `shared/pipeline-admin.js` | Callable client → `pipeline-adminAction` |
| `shared/pipeline-guest.js` | Callable client → `pipeline-guestRegister` |
| `shared/pipeline-emulator.js` | Auto-connects to Functions emulator on localhost or `?emulator=1` |

**Not wired:** `checkin-admin.html`, `checkin-guest-v2.html`, `minihotel_reservation_sync.py`

---

## Testing layers (sandbox-first)

| Layer | Command / action | Needs deploy? |
|-------|------------------|---------------|
| Unit tests | `cd pipeline-functions && npm test` | No |
| Callable E2E (recommended) | Functions emulator + sandbox HTML | **No** |
| Callable E2E (optional) | Deploy callables to Firebase | Yes — only after sandbox sign-off |

Expected unit tests: **54/54 pass** (elevator + room assignment + admin action + guest unlock + guest register).

**CI:** GitHub Actions runs `npm test` + guest-unlock sync check on every PR that touches `pipeline-functions/` or `shared/guest-unlock.js`.

---

## 1. Unit tests

```bash
cd ~/app/pipeline-functions
npm install
npm test
npm run check:unlock
```

If unlock sync fails: `node scripts/sync-guest-unlock.js` from repo root.

**Note:** `check:unlock` exists on branch `cursor/pipeline-stability-7e07` (or after that PR merges to main).

---

## 2. Sandbox E2E — Functions emulator (no deploy)

Callables run locally; Firestore reads/writes still hit **production** `sleepy-5c962` (same data as today). Only the Cloud Function code runs on your machine.

### Get the repo on your Mac first

`pipeline-functions` lives **inside the git repo**, not in your home folder. If you see `cd: no such file or directory: pipeline-functions`, you are in the wrong directory.

**First time — clone:**

```bash
cd ~
git clone https://github.com/nikavibliani-alt/app.git
cd app
git checkout cursor/pipeline-room-assignment-7e07
```

**Already cloned — update:**

```bash
cd ~/app
git fetch origin
git checkout cursor/pipeline-stability-7e07
git pull origin cursor/pipeline-stability-7e07
```

Run **one command per line**. Do not paste `# comment` text on the same line as `git checkout` — the shell will treat it as extra branch names and fail.

Replace `~/app` with wherever you keep the project (e.g. `~/Projects/app`).

**Prerequisites:** [Node.js](https://nodejs.org/) (v18+) and [Firebase CLI](https://firebase.google.com/docs/cli) (`npm install -g firebase-tools`), then `firebase login`.

### One-time setup

Run **one command per line** (do not paste inline `# comments` — zsh can mis-parse them):

```bash
cd ~/app/pipeline-functions
npm install
npm test
npm run emulator:setup
```

Expected: `npm test` reports **49 pass**. `emulator:setup` creates `.secret.local` with `ADMIN_ACTION_PASSWORD=maxela2026` (same as admin sandbox password).

### Start emulator

**Terminal 1** — keep this running:

```bash
cd ~/app/pipeline-functions
npm run emulator
```

Or from repo root:

```bash
cd ~/app
firebase emulators:start --only functions:pipeline --project sleepy-5c962
```

Emulator listens on **`127.0.0.1:5001`**. Emulator UI (optional): **`http://127.0.0.1:4000`**.

**Port already in use?** An old emulator or dev server is still running. Free the ports, then retry:

```bash
lsof -i :4000 -i :5001 -i :8080
kill $(lsof -t -i :4000) 2>/dev/null
kill $(lsof -t -i :5001) 2>/dev/null
```

Or skip the UI entirely (callables still work on 5001):

```bash
npm run emulator:lite
```

Uses `firebase.emulator-lite.json` at repo root (UI disabled — no port 4000 needed).

You must be logged in to Firebase CLI with access to `sleepy-5c962` so Admin SDK in the emulator can reach Firestore:

```bash
firebase login
```

### Serve sandbox HTML locally

**Terminal 2** — ES modules require HTTP (not `file://`):

```bash
cd ~/app
npx serve -p 8080 .
```

Or: `python3 -m http.server 8080` (same `cd ~/app` first).

Open:

- Admin: `http://127.0.0.1:8080/checkin-admin-sandbox.html?emulator=1`
- Guest: `http://127.0.0.1:8080/checkin-guest-sandbox-2.html?emulator=1&apt=6-1` (adjust `apt` / `g` as needed)

On **localhost**, `?emulator=1` is optional — emulator mode auto-enables. Use `?emulator=1` when serving from another host (e.g. LAN IP).

A blue banner at the top confirms emulator mode. Callable errors point here instead of asking for deploy.

### Guest registration in emulator mode

When emulator mode is active, registration **does not** fall back to direct Firestore writes — failures surface immediately so you know the pipeline path is what ran.

---

## 3. Admin sandbox manual tests

With emulator running, open admin sandbox (see URLs above):

- [ ] **Grant Access** on a guest with arrival today → `force_unlock`; `checkin_guests.manualUnlock` + `unlockState` updated; log in `system_logs` (`AdminAction`, `GuestUnlock`)
- [ ] **Move room** on guest with `matchedReservationId` → `reservations.roomCode` + `checkin_guests.aptId` updated atomically; `room_moves` audit doc; guest doc **ID unchanged**
- [ ] **Conflict block** — move into occupied overlapping room → UI shows conflict message, no partial writes
- [ ] **HK tab** still works (direct `hk_status` write — not migrated yet)

---

## 4. Guest sandbox manual tests

- [ ] Unlock gate matches admin status for same guest (before arrival / HK early / after 3pm / mid-stay)
- [ ] Registration via `pipeline-guestRegister` creates stable `guestToken` doc ID and `?g=` link
- [ ] Room move from admin sandbox → guest page still loads same `?g=` link; WiFi/photos follow new room

---

## 5. system_logs queries

Firestore → `system_logs`:

```
controller == "RoomAssignment"
controller == "AdminAction"
controller == "GuestUnlock"
controller == "GuestRegister"
```

Each action should have `ok` | `warn` | `error` with sanitized input/output.

---

## 6. Deploy (only after sandbox sign-off)

**Do not run this until manual sandbox tests pass and you approve.**

```bash
firebase functions:secrets:set ADMIN_ACTION_PASSWORD --project sleepy-5c962
# Use same value as admin sandbox _ADMIN_PWD for testing, or rotate for prod

firebase deploy --only functions:pipeline:adminAction,functions:pipeline:guestRegister --project sleepy-5c962
```

Callable names (region `europe-west1`): **`pipeline-adminAction`**, **`pipeline-guestRegister`**.

After deploy, sandbox pages work **without** emulator (remove `?emulator=1` or use production hosting URL).

---

## Review checklist (Claude Code)

**Sandbox UI:** Deployed on GitHub Pages; formal phone checklist status unknown — see `docs/SANDBOX_TESTING.md`. See `docs/AGENT_HANDOFF.md` for current URLs and agent read order.

**Backend (when deploy is requested):**

- [ ] `npm test` — all pass
- [ ] Emulator E2E — admin move + unlock + guest register (optional if host skips)
- [ ] `system_logs` + `room_moves` audit rows present
- [ ] No changes to live HTML or Python sync

---

## Still TODO (backend phases)

- [ ] `HKStatusSync` — route HK done through pipeline (optional; HK app still writes `hk_status` today)
- [ ] `ReservationSync` — replace Python sync (later)
- [ ] Wire **live** admin/guest pages only after sandbox sign-off on phone
- [ ] Recover missing Tuya function sources in git before `functions:default` deploy

---

## Known limitations

1. **Admin sandbox move/unlock need callable** — emulator locally, or deploy after sign-off. No direct Firestore fallback for admin mutations.
2. **Guest sandbox** falls back to direct Firestore only when **not** in emulator mode (for pages hosted without emulator during transition).
3. **Password in callable body** is v1 auth (same as HTML gate). Stronger auth is a later phase.
4. **`guest-unlock.js` duplicated** in `shared/` and `pipeline-functions/lib/` — changes must be mirrored manually until a single build step exists.

---

## Quick reference — AdminAction payloads

```javascript
// Move
{ actionType: 'move_guest', payload: { reservationId: '…', toRoom: '6-3' } }

// Grant access
{ actionType: 'force_unlock', payload: { guestId: '…' } }

// Swap
{ actionType: 'swap_guests', payload: { reservationId: 'a', otherReservationId: 'b' } }

// Follow MiniHotel again
{ actionType: 'release_to_minihotel', payload: { reservationId: '…' } }
```

All calls include `password` and optional `actor`.

---

**Full report for Claude Code:** see **`docs/AGENT_HANDOFF.md`** (`CLAUDE_CODE_REPORT.md` is deprecated)
