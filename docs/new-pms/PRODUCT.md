# New PMS — Product Vision

> Working name: TBD (not “Sleepy”). Brand/domain deferred — beta on current domain, migrate later.  
> Status: Planning only. This is a **greenfield SaaS product**, not an evolution of the personal Maxela tooling in this repo.

---

## 1. One-sentence pitch

A modern property management platform for short-term rental hosts and co-hosts that makes hosting more profitable — through operations, guest experience, local service marketplace, direct bookings, and clear accounting — starting with Georgia and expanding.

---

## 2. Who it is for

| Role | Needs |
|------|--------|
| Host / owner | Calendar, channels, pricing, money reports, invoices |
| Co-host / property manager | Multi-property ops, staff, guest check-in, settlements |
| Housekeeper | Mobile room lists, status updates, issues/photos |
| Guest | Self check-in, door/WiFi info, services, upsells |
| Service provider | List tours/transfers/food/car rental; receive orders |
| Platform admin (us) | Tenants, billing, marketplace curation, support |

**First customers:** Founder’s network of Tbilisi hosts (after MVP is visible).  
**Dogfood:** New apartments the founder co-hosts can go on this PMS first. Existing Maxela stock stays on MiniHotel until a deliberate migration.

---

## 3. What this product is NOT

- Not a rewrite of the personal Maxela repo (check-in HTML, family profit split, MiniHotel scrapers).
- Not copying personal Shartava / Venu / Tuka accounting logic (family-specific).
- Not requiring RS.ge tax filing automation (PDF reports only for v1).
- Not Stripe-first (Georgia needs local payment providers).

Personal Maxela tools remain a **separate dogfood lab**: test UX on real guests, then re-implement cleanly in this product.

---

## 4. Revenue model

| Stream | Who pays | Notes |
|--------|----------|--------|
| Subscription | Host (per property or tier) | Core SaaS fee |
| Marketplace commission | Cut of service orders | Tours, transfers, food, car rental |
| Direct booking commission | Cut of bookings on host’s generated site | Every host gets their own booking website |

---

## 5. Product modules (full target)

### A. Distribution & revenue

1. **Calendar + CRS** — multi-property portfolio, drag timeline, cross-property moves, unified guests  
2. **Channel manager (Channex)** — 2-way rates/availability/restrictions; Booking.com, Airbnb, Expedia, etc.  
3. **Direct booking sites** — **every host gets a separate website**; optional per-apartment landing pages; payments + upsells; platform %  
4. **Smart pricing (RMS)** — rules engine (occupancy, season, events, competitor comps later); optional external RMS sync later  

### B. Guest journey

5. **Guest portal / digital check-in** — passport/ID upload, registration, **policy e-signature** (hand-drawn or auto-rendered from guest name), payments  
6. **Smart locks** — IoT keys (TTLock / Tuya / Salto-class) delivered in portal / SMS / WhatsApp after unlock rules  
7. **Automated messaging** — pre-arrival, in-stay, post-checkout (WhatsApp + email + SMS when providers ready). Meta WhatsApp Business verification required; choose a WA Business API provider that supports GEL/EUR/USD billing  
8. **Upsells** — early check-in, late checkout, upgrades, breakfast, transfers, marketplace services inside guest portal  

### C. Operations

9. **Housekeeping app** — mobile-first; Clean / Dirty / Inspected / OOO; priority lists (arrivals first); photo uploads for damage / lost items  
10. **Maintenance tickets** — report issues from HK or host; priorities; status tracking  
11. **Night audit / daily close** — background business-date roll, balances (no frozen “legacy night audit”)  

### D. Money

12. **Folios & billing** — room charges, split folios / multi-payer (later), invoices PDF  
13. **Payments** — Georgian PSP(s); card-on-file / pre-auth where available; deposits for direct bookings  
14. **Accounting reports** — monthly P&L, co-host settlements as **generic templates**, PDF export (no RS.ge push)  
15. **Local tax rules** — configurable VAT / city fees where hosts need them (opt-in, not Georgia-forced)  

### E. Marketplace (differentiator)

16. **Service marketplace** — platform-seeded + self-registered providers (tours, airport transfer, food, car rental)  
17. **Provider portal** — listings, availability, orders, payouts ledger  
18. **Commission engine** — provider / host / platform split (flat GEL or %)  

### F. Platform

19. **Supplies ordering** — linens, towels, toiletries (later)  
20. **Open API + webhooks** — API-first; events like `booking.created`, `room.status_changed`  
21. **RBAC** — Owner, Co-host, Reception/Front desk, Housekeeper, Accountant, Provider, Platform admin  
22. **Offline-tolerant guest/HK flows** — cache critical queues; sync when online (progressive)  

---

## 6. Competitive stance (Gemini blueprint + our edge)

| Area | Basic PMS | Our target |
|------|-----------|------------|
| UX | Clunky grids | Sleek web app, drag calendar, mobile-first HK + guest |
| Guest intake | Paper / desk | Web check-in, e-sign, ID upload, IoT keys |
| Extra income | Rare | Marketplace + direct booking sites |
| Accounting | Generic Western tax | Georgia-friendly PDF settlements without forcing RS.ge |
| Messaging | Email-first | WhatsApp-first when Meta-approved |
| Channels | Built-in or none | Channex white-label until/while OTA partnerships mature |

---

## 7. Decisions already locked

| Topic | Decision |
|-------|----------|
| Codebase | Path B — **new monorepo from scratch** |
| Personal Maxela | Keep MiniHotel; do not merge family split tools into product |
| Channels | **Channex** for distribution before/during OTA direct verification |
| Direct booking | Model **C**: host website required + optional per-apartment pages |
| E-signature | Hand-drawn **or** auto signature from guest name |
| WhatsApp | Wait for Meta verification; pick WA API provider later (must support sensible currency billing) |
| Payments | Georgian providers (not Stripe as primary) |
| Accounting | PDF reports only for v1 |
| Domain | Beta on current domain; new brand domain later |
| Monetization | Subscription + marketplace % + direct booking % |
| Marketplace supply | Founder seeds providers + providers self-register |

---

## 8. Success criteria (MVP → sellable)

MVP is “sellable” when a co-host can:

1. Add properties and see a working calendar  
2. Sync inventory via Channex (sandbox → live)  
3. Run housekeeping for a day without WhatsApp chaos  
4. Let a guest self check-in with e-signature  
5. Take a direct booking on their generated site  
6. Download a monthly PDF settlement  

Marketplace and smart pricing deepen moat after that.
