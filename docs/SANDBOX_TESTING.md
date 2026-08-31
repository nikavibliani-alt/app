# Sandbox testing — check everything here before go-live

**Rule:** Guest **cutover complete (2026-08-31)** — `checkin-guest.html` is the live app. Admin sandbox still for testing; live admin unchanged until cutover.

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
| **Admin (new)** | https://app.maxelaapartments.com/checkin-admin-sandbox.html | same as live admin |
| **Guest (new design)** | https://app.maxelaapartments.com/checkin-guest-sandbox-2.html | — |
| **Guest + emulator** | …/checkin-guest-sandbox-2.html?emulator=1 | local functions only |
| **Map (beginner)** | https://app.maxelaapartments.com/SYSTEM_MAP_BEGINNER_2026.html | — |

### Live URLs (do not change until cutover)

| App | URL |
|-----|-----|
| Guest (live — new design) | https://app.maxelaapartments.com/checkin-guest.html |
| Guest (old bookmark) | https://app.maxelaapartments.com/checkin-guest-v2.html → redirects |
| Admin (you use today) | https://app.maxelaapartments.com/checkin-admin.html |

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

## Guest cutover (done 2026-08-31)

1. ~~Copy `checkin-guest-sandbox-2.html` → `checkin-guest.html`~~ ✅
2. (Later) copy admin sandbox → `checkin-admin.html`
3. Merge to **`main`** on GitHub → site updates ✅
4. Deploy backend functions in daylight (optional — registration has Firestore fallback)

See `docs/GUEST_LINK_STRATEGY.md`.

---

## WhatsApp links

- **Guests (production messages):** `https://app.maxelaapartments.com/checkin-guest.html` (new design live)
- **Dev testing:** `checkin-guest-sandbox-2.html` (includes dev toolbar)
