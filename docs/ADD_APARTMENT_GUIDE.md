# How to add apartments / buildings to Maxela SleepyPMS

**Goal:** One place to define rooms, then the system picks them up everywhere (admin, HK, MiniHotel sync).

---

## Quick checklist (new room or building)

1. **Edit `shared/room-registry.js`** — add entry to `DEFAULT_ROOMS_SEED`
2. **Open admin sandbox** — `checkin-admin-sandbox.html` auto-syncs missing rooms to Firestore `checkin_rooms`
3. **Apts tab** — fill WiFi, door code, photos for the new room (`checkin_apartments`)
4. **HK settings** — if new **site** (e.g. new building PIN), add site to `ROOM_SITES` + set PIN in HK Pins
5. **Staff HK app** — use **`HK.html`** (unified) or admin sandbox HK tab — **not** `HK-Shartava.html` alone (no VGL/centre rooms)
6. **MiniHotel** — ensure reservation room names match `minihotelNames` in registry (sync merges from Firestore)

---

## Step 1 — Add to room registry

File: **`shared/room-registry.js`**

```javascript
{
  roomCode: 'vgl-st5',           // Firestore doc id — lowercase, dashes
  displayName: 'VGL Studio 5',
  displayCode: 'vgl-st5',        // Shown in UI
  group: 'VGL',                  // Group label in Apts tab
  sortOrder: 54,                 // List order
  site: 'vgl',                   // shartava | centre | vgl | abashidze | (new site)
  showInHk: true,                // Appears on HK board
  minihotelNames: ['VGL_ST5'],   // MiniHotel calendar names → this roomCode
  beddingRule: 'orb-tab',        // optional hint: 0- | 6-7 | 6-3 | orb-tab
}
```

**New site/building?** Also add to `ROOM_SITES`:

```javascript
{ id: 'newbuilding', label: 'New Building' },
```

And in admin sandbox HK settings (`HK_CLEAN_TYPES` in `checkin-admin-sandbox.html`) add a clean-time type if needed.

---

## Step 2 — Sync to Firestore

Opening **admin sandbox** runs `syncRoomsFromSeed()` once per session:

- Empty `checkin_rooms` → seeds all defaults
- Existing collection → **adds only missing** room codes (fixes VGL added after first seed)

Manual alternative: Apts tab → Add room (same fields).

Creates:

| Collection | Doc id | Purpose |
|------------|--------|---------|
| `checkin_rooms` | `roomCode` | Registry: site, HK, MiniHotel names |
| `checkin_apartments` | `roomCode` | Guest content: WiFi, photos, instructions |

---

## Step 3 — HK setup

### Which HK app to use

| App | Rooms included |
|-----|----------------|
| **`HK.html`** | All sites including VGL, centre, shartava |
| **`HK-Shartava.html`** | Shartava + abashidze only — **no VGL** |
| **`HK-Centre.html`** | orb/tab only |
| **Admin sandbox HK tab** | Reads `checkin_rooms` (all `showInHk`) |

**Why VGL “didn’t work” on live:** Often staff used HK-Shartava, or `checkin_rooms` never got VGL docs (seed ran before VGL was added), or `hk_pins/vgl` PIN was not set.

### HK PIN

Firestore `hk_pins/vgl` (and other site keys) — set in admin sandbox **HK settings → Staff PINs**.

### Bedding alerts

Rules in **`shared/hk-bedding.js`** (also used by admin sandbox HK tab):

| Pattern | Alert |
|---------|-------|
| `0-*` | 4+ guests → sofa bed sheets |
| `6-1,6-2,6-4,7-*, vgl-ap*` | 5+ guests → extra sheets |
| `6-3` | 9+ guests |
| `orb-*, tab-*, vgl-st*` | 3+ guests |

---

## Step 4 — MiniHotel sync

`minihotel_reservation_sync.py`:

- Hardcoded `ROOM_MAP` includes VGL
- **Also merges** `checkin_rooms.minihotelNames` from Firestore at runtime

After adding rooms to registry + sync, GitHub Action sync picks up new names automatically.

**Do not use** `import-reservations.html` for VGL — it skips rows containing "VGL" in the sheet.

---

## Step 5 — Guest check-in

Guest pages read **`checkin_apartments/{roomCode}`** — no code change needed if content doc exists.

Sandboxes and live guest page resolve room from reservation `roomCode` after registration.

---

## Still hardcoded (migrate later)

These still need manual updates until live admin reads `checkin_rooms`:

| File | What |
|------|------|
| `checkin-admin.html` | `APARTMENTS` array (no VGL today) |
| `checkin-guest-v2.html` | `APT_NAMES` display fallback |
| `HK-Shartava.html`, `HK-Centre.html` | Separate `ROOMS` arrays |
| `SleepyPMS.html` | `seedProperties()` |

**Sandbox path is ready.** Production cutover = wire live admin/guest to `checkin_rooms` (planned after pipeline deploy).

---

## Adding a whole new building (example)

1. Add site to `ROOM_SITES` in `shared/room-registry.js`
2. Add 4–10 room entries with `site: 'newsite'`, `showInHk: true`
3. Open admin sandbox → verify Apts tab + HK tab
4. Set `hk_pins/newsite` PIN (extend `hk_pins` schema in sandbox HK settings if needed)
5. Add MiniHotel names to each room’s `minihotelNames`
6. Deploy/sync — reservations get `roomCode`, HK shows checkouts

---

## Reference docs

- **`BACKEND_MAP.md`** — pipeline controllers, data flow
- **`PROJECT_ARCHIVE.md`** — full project history and decisions
- **`MASTER_ARCHITECTURE_CURSOR.md`** — locked architecture rules
