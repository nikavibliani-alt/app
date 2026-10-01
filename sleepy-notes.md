# Sleepy PMS — Project Notes

*Last updated: May 2026*

---

## Firebase Project

- **Project ID:** `sleepy-5c962`
- **API Key:** `AIzaSyCbggwwtdw751yQUO6MaHCuYKyNn7AyOTk`
- **Auth Domain:** `sleepy-5c962.firebaseapp.com`
- **SDK version:** `firebase@11.0.1` (modular, imported via CDN)

---

## Files

### Core App

| File | Purpose |
|------|---------|
| `SleepyPMS.html` | Main PMS app (~2750 lines). All-in-one: calendar, reservations, pricing, dashboard, invoices, properties. Single Firebase module script. |
| `HK-Shartava.html` | Housekeeping board for Shartava property. PIN login, 7-day tabs, room status cards, cleaner assignment. |
| `HK-Centre.html` | Housekeeping board for Centre property (Tab/Orb rooms). Same structure as HK-Shartava. |
| `HK.html` | Generic HK entry point (symlink/copy — same logic as HK-Shartava). |
| `checkin-admin.html` | Admin panel. Manages apartment check-in status, guest arrivals, HK PIN management. |
| `checkin-guest.html` | Guest-facing check-in page. Guests enter their details on arrival. |
| `SleepyDashboard.html` | Standalone dashboard prototype (from Anthropic design bundle). Now superseded by the inline Dashboard page inside SleepyPMS.html. |

### Import / Utility

| File | Purpose |
|------|---------|
| `import-reservations.html` | Live import tool. Fetches CSV from Google Sheets, previews, then deletes all existing reservations and imports fresh data. Skips VGL/fake/past entries. |
| `clear-reservations.html` | One-click tool to delete ALL documents from the `reservations` Firestore collection. Has a Verify button to confirm empty. |

### Design System (from Anthropic design bundle)

| File | Purpose |
|------|---------|
| `sleepy-styles.css` | Design system CSS: oklch color tokens, sidebar, KPI, gauge, pace chart, channel donut styles. Used by SleepyDashboard.html. |
| `sleepy-tweaks-panel.jsx` | React/Babel tweaks panel component (accent/density/sidebar toggle). |
| `sleepy-tweaks.jsx` | Tweaks configuration and data. |

### Other

| File | Purpose |
|------|---------|
| `index.html` | Landing/home page for the GitHub Pages site. |
| `README.md` | Generic project readme. |
| `TukaTracker.html` | Separate tracker for Tuka (unrelated to PMS). |
| `VenuTracker Update.html` | Separate tracker (unrelated to PMS). |

---

## Firebase Collections

### `reservations`
One document per booked room (multi-room bookings are split into separate docs).

| Field | Type | Notes |
|-------|------|-------|
| `guest` | string | Full name, e.g. `"Marta Piergianni"` |
| `checkin` | string | ISO date `"2026-05-07"` |
| `checkout` | string | ISO date `"2026-05-10"` |
| `nights` | number | |
| `source` | string | `"booking"` / `"airbnb"` / `"expedia"` / `"direct"` |
| `roomCode` | string | Matched to property shortCode, e.g. `"tab-2"`, `"6-1"` |
| `propertyId` | string | Firebase doc ID of the property (may be absent for imported reservations) |
| `price` | number | Price per night (net) |
| `currency` | string | `"GEL"` / `"EUR"` / `"USD"` |
| `totalPriceStr` | string | Original total with currency, e.g. `"GEL 453.57"` |
| `bookingId` | string | Portal/channel booking ID |
| `reservationNumber` | string | Internal booking number, e.g. `"007003783"` |
| `email` | string | Guest email |
| `adults` | number | |
| `children` | number | |
| `guests` | number | adults + children |
| `status` | string | e.g. `"Channel Manager"` |
| `notes` | string | Optional free-text notes |
| `manualRoom` | boolean | `true` if user manually dragged to a specific room — bypasses auto-allocation |
| `createdAt` | Timestamp | Firestore server timestamp |
| `updatedAt` | Timestamp | Firestore server timestamp |

### `properties`
One document per physical room/unit.

| Field | Type | Notes |
|-------|------|-------|
| `name` | string | Full name, e.g. `"Small Room 0-1"` |
| `shortCode` | string | Calendar identifier, e.g. `"0-1"`, `"tab-2"`, `"orb-1"` |
| `location` | string | `"shartava"` or `"centre"` |
| `rooms` | number | Number of physical rooms (6-3 has 3) |
| `order` | number | 1–18, controls calendar row order |
| `notes` | string | Optional |
| `createdAt` / `updatedAt` | Timestamp | |

### `prices`
One document per property (keyed by property doc ID or pricing group ID).

Structure: `{ "2026-05-10": { usd: 80, gel: 220, eur: 75, minNights: 2, locked: false, restricted: false }, ... }`

### `hk_status`
Housekeeping room statuses. One doc per room code, e.g. `{ status: "dirty" }`.
Statuses: `"clean"` / `"dirty"` / `"inspect"` / `"occupied"` / `"ooo"`

### `hk_pins`
PIN codes for HK team login.
```
hk_pins/shartava → { pin: "1234" }
hk_pins/centre   → { pin: "5678" }
hk_pins/admin    → { pin: "0000" }
```

### `settings`
App-level settings.
```
settings/invoice → {
  companyName, address, phone, email, footerText,
  emailjsKey, emailjsService, emailjsTemplate, defaultEmailBody,
  lastInvoiceNumber
}
```

### `checkin_apartments` / `checkin_guests`
Used by `checkin-admin.html` for the check-in management system.

---

## Room Groups

### Location: Shartava

| Group | Short Codes | Count | Notes |
|-------|-------------|-------|-------|
| Small Rooms | `0-1`, `0-2`, `0-3`, `0-4`, `0-5` | 5 | Ground floor small rooms |
| Apartments | `6-1`, `6-2`, `6-4`, `7-1`, `7-2`, `7-4` | 6 | Floors 6 and 7 |
| 6-3 Suite | `6-3` | 1 | 3-bedroom apartment, standalone (no auto-shuffle) |

### Location: Centre

| Group | Short Codes | Count | Notes |
|-------|-------------|-------|-------|
| Tab Rooms | `tab-1`, `tab-2`, `tab-3` | 3 | |
| Orb Rooms | `orb-1`, `orb-2` | 2 | Auto-allocation group |
| Standalone | `orb-3` | 1 | No auto-shuffle |

**Total: 17 rooms** (used for occupancy calculations — `orb-3` and `6-3` are standalones, `tab-4` / `5-1` / `5-2` are unmapped extras from some import data).

### Auto-Allocation Groups (in `SleepyPMS.html`)
```js
ROOM_GROUPS = {
  'Small Rooms': ['0-1','0-2','0-3','0-4','0-5'],
  'Apartments':  ['6-1','6-2','6-4','7-1','7-2','7-4'],
  'Tab Rooms':   ['tab-1','tab-2','tab-3'],
  'Orb Rooms':   ['orb-1','orb-2'],
  'Standalone':  ['6-3','orb-3']   // ← never reshuffled
}
```

---

## SleepyPMS.html — Pages & Features

### Dashboard (`/dashboard`)
- KPI strip: Occupancy %, ADR, RevPAR, Arrivals, Departures — all live from Firebase
- Revenue chart: 30-day polyline (SVG), switcher for 7D / 30D / 90D / YTD
  - Revenue = sum(price × nights) for reservations with checkin in the period
- Occupancy gauge: semicircle SVG, 17-key capacity, breakdown by room type
- Pickup pace: 14-day bar chart (how many rooms on books per night)
- Channel mix donut: last-90-day reservation counts by source
- All charts re-render on every Firebase snapshot

### Calendar (`/calendar`) — default page
- Week/2-week/4-week view (1w / 2w / 4w buttons)
- Navigation: −14, −7, −1, Today, +1, +7, +14, 📅 date picker
- Each property is a row (sorted by `order` field)
- Reservation bars: single-element absolutely-positioned spans
  - Colors: Airbnb `#FF385C`, Booking `#499FDD`, Expedia `#0e214b`, Direct `#22c55e`
  - Bar width: `calc(nights * 42px + 11px)` — extends 30% into checkout column
  - Check-in marker: white 3px pill on left edge
  - Guest count badge for parties > 1
- **Drag to move:** drag a bar horizontally to new date, vertically to new room
  - `_dragOriginDate = res.checkin` — checkin always lands at drop column
  - Column snap: nearest center (50% threshold), instant jump
  - Highlight: intersection cell of current row + snapped column
  - 8px threshold: drop within 8px of mousedown = treated as click (opens modal)
  - Confirm dialog when moving across room categories
  - `manualRoom: true` written to Firebase on cross-room drag
- **Drag to resize:** grab right/left 8px handle to extend/shrink
  - Live preview updates as mouse moves
  - Snaps to column centers using `_snapDateFromX`
- **Hover tooltip:** shows guest name, phone, email, dates, nights, source
- **Click bar:** opens Edit Reservation modal
- **Click empty cell:** opens New Reservation modal pre-filled with date + room
- **Auto-allocation:** display-only (never written). Resolves room conflicts within groups. Runs on every snapshot. Reservations with `manualRoom: true` are pinned to their assigned room.
- **Truncated bars:** reservations whose checkin is before the visible range render as a bar starting from the first visible column
- **Sticky header:** date row sticks at top (top = navbar height, set dynamically). Room column sticks at left (z-index: 9). Corner cell sticky in both (z-index: 11).

### Reservations (`/reservations`)
- Full list sorted by checkin date (descending)
- Duplicate detection: flags entries with same `bookingId` + `roomCode` + `checkin` (all three must match — avoids false positives on multi-room bookings)
- **Clean Duplicates** button: keeps most-recently-updated copy, deletes the rest
- Click row to open Edit modal

### Pricing (`/pricing`)
- Grid: rows = pricing groups, columns = dates
- Pricing groups combine multiple properties (e.g., all Small Rooms share one pricing control)
- Fields per day: USD, GEL, EUR price, min nights, availability, closed/locked flags
- Inline editing with 800ms debounce before Firebase write
- Fan-out: saving a group doc also writes to all member property docs (`flushPrices`)
- Bulk update modal: set prices across a date range for a group

### Properties (`/properties`)
- CRUD for properties
- Seed button to create all 18 rooms in one click (only shows when collection is empty)
- Search filter

### Invoices (`/invoices`)
- Select reservation from dropdown → auto-fills guest, dates, room, price
- Company details (saved to `settings/invoice` in Firebase): name, address, phone, email, footer text
- Invoice fields: number (auto-generated `INV-YEAR-NNN`), date, guest name/email, checkin/checkout, room, price/night, currency, tax toggle (%), payment status, notes
- Live preview panel — updates on every keystroke
- **Download PDF:** opens print window with inline invoice HTML, triggers browser print-to-PDF
- **Send to Guest:** uses EmailJS SDK to send email with invoice HTML in body
- EmailJS config stored in `settings/invoice`: public key, service ID, template ID
- Email body template variables: `{{guest}}`, `{{hotel}}`, `{{checkin}}`, `{{checkout}}`, `{{inv_number}}`

---

## HK-Shartava.html / HK.html

- **PIN login** — stored in Firebase `hk_pins`, checked against `hk_pins/shartava`, `hk_pins/centre`, `hk_pins/admin`. Role stored in `localStorage('hk_role')`.
- **7-day tabs** starting from Today
- **Room cards** show checkouts and check-ins for the day with guest count
- Done card animation: card slides to "Completed" section at bottom (320ms)
- Auto-assigns cleaner based on login role (Shartava Team / Centre Team)
- No guest names shown (only counts) for privacy

---

## checkin-admin.html

- Manages `checkin_apartments` and `checkin_guests` collections
- HK PIN management section (add/edit/remove PINs in `hk_pins`)

---

## import-reservations.html

**Two-step flow:**
1. Click **Fetch & Preview** → fetches live CSV from Google Sheets, parses, filters, shows preview
2. Click **Delete All + Import** → clears `reservations` collection, writes all records

**Google Sheets URL:**
```
https://docs.google.com/spreadsheets/d/14dRKZrCqAmCfLYAI4G4cW7EJuMKzkuxOpIllabsSwbk/export?format=csv
```

**Filters applied:**
- Skip rows where Rooms contains: `VGL`, `FAKE`, `ANTS`, `LAUNDRY`, `INDOELI`, `IGIVE`, `TARAKANA`, `KARI` (case-insensitive)
- Skip rows where checkout < `2026-05-09` (configurable cutoff)
- Skip rows where dates can't be parsed

**CSV column mapping:**
| CSV column | Firebase field |
|-----------|---------------|
| First Name + Last Name | `guest` |
| Arrival (DD/MM/YYYY) | `checkin` (→ YYYY-MM-DD) |
| Check out (DD/MM/YYYY) | `checkout` (→ YYYY-MM-DD) |
| Nights | `nights` |
| Portal Id | `bookingId` |
| Source | `source` (BOOKING→booking, AIRBNB→airbnb, EXPEDIA→expedia) |
| Email | `email` |
| Adults | `adults` |
| Child | `children` |
| Status | `status` |
| Net Price | `price` (per night; if zero, uses Total÷Nights) |
| Total | `totalPriceStr` |
| Rooms | `roomCode` (mapped via RM table below) |

**Room code mapping:**
```
M-6-1 → 6-1    M-6-2 → 6-2    M-6-3 → 6-3    M-6-4 → 6-4
M-7-1 → 7-1    M-7-2 → 7-2    M-7-4 → 7-4
M-5-1 → 5-1    M-5-2 → 5-2
T-1 → tab-1    T-2 → tab-2    T-3 → tab-3    T-4 → tab-4
Midamo 1 → orb-1    Midamo 2 → orb-2    Midamo 3 → orb-3
0-1…0-5 → as-is
```

**Multi-room bookings:** comma-separated rooms in the Rooms field are split into separate docs. Price is divided equally per room. All splits get `manualRoom: true`.

---

## EmailJS Setup

Used for sending invoices from the browser without a backend.

1. Create account at **emailjs.com**
2. Add an **Email Service** (Gmail, Outlook, etc.) → note the **Service ID**
3. Create an **Email Template** with these variables:
   - `{{to_email}}` — recipient
   - `{{to_name}}` — guest name
   - `{{from_name}}` — hotel name
   - `{{subject}}` — email subject
   - `{{message}}` — body text
   - `{{invoice_html}}` — full invoice HTML (embed in template body)
4. Go to Account → **Public Key**
5. In SleepyPMS → Invoices page → EmailJS Config section → paste all three
6. Click **Save settings** (stored in `settings/invoice` Firebase doc)

**Default email subject:** `Your Invoice - [Hotel Name] - [INV number]`

---

## Technical Decisions

### Date handling
- All dates stored as `"YYYY-MM-DD"` strings in Firebase (never Timestamps)
- `parseDate(s)` handles: string `"YYYY-MM-DD"`, Firestore Timestamp (`.toDate()`), strips any time component
- `formatDate(d)` uses `getFullYear/getMonth/getDate` (local time) — avoids UTC off-by-one for UTC+ users

### Auto-allocation
- **Display-only** — never written to Firebase. Computed from `reservations` array on every snapshot.
- Algorithm: direct placement → reshuffle within group → overflow (keep original room)
- `manualRoom: true` on a reservation bypasses allocation and pins it to its `roomCode`
- `buildDisplayAllocation()` returns a `{reservationId: assignedRoomCode}` map
- Calendar uses `displayAllocation[r.id]` first, then falls back to `r.roomCode`, then `r.propertyId`

### Bar width formula
`calc(${nights} * 42px + 11px)` — cell width is 42px, bar extends 30% into checkout column (≈13px), minus 2px left padding = 11px extra beyond `nights` cells.

### Duplicate detection
Key = `bookingId + "|" + roomCode + "|" + checkin`. All three must match for a pair to be flagged as duplicate. Same bookingId with different rooms = multi-room booking, NOT a duplicate.

### Sticky calendar header
- `.cal-wrap` has NO overflow (passes scroll responsibility up)
- `#main[data-calscroll]` gets `overflow-x: auto; padding-top: 0` when calendar is shown
- Sticky `top` value is set dynamically from `topbar.getBoundingClientRect().height`
- z-index stack: date headers = 10, room column = 9, corner cell = 11, bars = 5

### Drag behavior
- `_dragOriginDate = res.checkin` always (ignores grab position)
- Drop: `newCheckin = dropDateStr` (cursor column), duration preserved
- Ghost image anchored to column 0 of the block (cursor at day-1 center)
- Column snap: nearest center (50% threshold), instant, no hysteresis
- Row snap: `dropPropId` from `ondrop` event = always the room row cursor is over

---

## Known Issues / Work In Progress

- **Sticky date header gap** — still being tuned: `top` value should match exact navbar height measured at runtime with `getBoundingClientRect().height`
- **Drag ghost image** — HTML5 DnD ghost image can't be updated mid-drag; visual during drag may not match final position exactly
- **ADR / RevPAR** on dashboard filter for USD only (`!r.currency || r.currency === 'USD'`) — since most reservations are in GEL/EUR, these show $0. Needs currency conversion or filter removal.
- **`tab-4`, `5-1`, `5-2`** room codes appear in some import data but have no matching property in the 18-room seed list — those reservations are imported but never show on calendar
- **`orb-3`** is standalone (not in Orb Rooms auto-allocation group) — may appear in the wrong calendar row if allocated differently than expected

---

## GitHub Pages

Hosted at: `https://app.maxelaapartments.com/`

Main entry: `SleepyPMS.html` (direct link used in production)
