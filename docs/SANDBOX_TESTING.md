# Sandbox testing — check everything here before go-live

**Rule:** **Full cutover complete (2026-08-31)** — `checkin-guest.html` and `checkin-admin.html` are live. Edit sandbox files, then promote with build scripts.

**Hosting:** GitHub Pages → `https://app.maxelaapartments.com/`  
**Database:** Firebase `sleepy-5c962` (same as production — sandbox uses real data)

---

## Start here

Open the **sandbox hub** (bookmark this):

**https://app.maxelaapartments.com/sandbox-index.html**

Or use the links below directly.

---

## Sandbox URLs (production hosting, sandbox files)

| App | URL | Password |
|-----|-----|----------|
| **Hub** | https://app.maxelaapartments.com/sandbox-index.html | — |
| **Admin (live)** | https://app.maxelaapartments.com/checkin-admin.html |
| **Admin (dev sandbox)** | https://app.maxelaapartments.com/checkin-admin-sandbox.html |
| **Guest (new design)** | https://app.maxelaapartments.com/checkin-guest-sandbox-2.html | — |
| **Guest + emulator** | …/checkin-guest-sandbox-2.html?emulator=1 | local functions only |
| **Map (beginner)** | https://app.maxelaapartments.com/SYSTEM_MAP_BEGINNER_2026.html | — |

### Live URLs (do not change until cutover)

| App | URL |
|-----|-----|
| Guest (live — new design) | https://app.maxelaapartments.com/checkin-guest.html |
| Guest (old bookmark) | https://app.maxelaapartments.com/checkin-guest-v2.html → redirects |
| Admin (you use today) | https://app.maxelaapartments.com/checkin-admin.html (new design) |

---

## What “everything in sandbox” means

```
┌─────────────────────────────────────────┐
│  SANDBOX (test here first)              │
│  • checkin-admin-sandbox.html           │
│  • checkin-guest-sandbox-2.html         │
│  • pipeline via emulator OR fallback    │
└─────────────────┬───────────────────────┘
                  │ same Firebase data
┌─────────────────▼───────────────────────┐
│  LIVE GUEST (new design)                │
│  • checkin-guest.html                   │
│  • checkin-guest-v2.html → redirect     │
└─────────────────────────────────────────┘
```

You test on **sandbox URLs**. When happy → copy sandbox files → live files → merge to `main` on GitHub.

---

## Quick test checklist (on phone)

### Admin sandbox

- [ ] Stay tab — today’s arrivals / in-house show
- [ ] Grant Access on a guest
- [ ] Move guest to empty room
- [ ] Swap two occupied rooms
- [ ] HK tab — guest count, bedding alert, mark done
- [ ] Apts tab — VGL rooms visible
- [ ] HK settings — VGL PIN set
- [ ] Elevator tab — code + QR show

### Guest sandbox-2

- [ ] Search and register (test booking)
- [ ] Unlock gate — waiting vs unlocked matches admin
- [ ] Elevator QR + door code + WiFi when unlocked
- [ ] “Copy my link” after registration (`?g=`)
- [ ] Open personal link on second browser — no re-upload passport
- [ ] Companion flow if needed

### With emulator (Mac, optional)

Terminal 1: `cd pipeline-functions && npm run emulator:lite`  
Terminal 2: `npx serve -p 8080 .`  
Admin: `http://127.0.0.1:8080/checkin-admin-sandbox.html?emulator=1`

---

## Automated checks (already running)

| Check | When |
|-------|------|
| Pipeline tests (54) | Every PR |
| Health monitor | Twice daily email if broken |
| Elevator monitor | Hourly email if stale |
| MiniHotel sync | Your cron-job.org every 10 min |

---

## Full cutover (done 2026-08-31)

1. ~~Guest: sandbox-2 → `checkin-guest.html`~~ ✅
2. ~~Admin: sandbox → `checkin-admin.html`~~ ✅ (`node scripts/build-admin-production.js`)
3. Backend: `adminAction` + `guestRegister` on Firebase ✅

See `docs/GUEST_LINK_STRATEGY.md`.

---

## WhatsApp links

- **Guests (production messages):** `https://app.maxelaapartments.com/checkin-guest.html` (new design live)
- **Dev testing:** `checkin-guest-sandbox-2.html` (includes dev toolbar)
