# Agent instructions (this repository)

This repository currently contains **personal Maxela / Sleepy ops tools** plus planning docs for a **new greenfield SaaS PMS**.

## Two products — do not mix

1. **Personal Maxela tools** (HTML/Python in repo root)  
   - Live ops for the founder’s apartments (MiniHotel-based).  
   - Do not break production guest check-in / HK pages without explicit request.  
   - Never treat family profit-split trackers (e.g. Shartava split) as SaaS product requirements.  
   - `checkin-guest.html` is a redirect only — do not reinvent it; guest app is `checkin-guest-v2.html`.

2. **New SaaS PMS** (planned under `docs/new-pms/`)  
   - Greenfield product for other hosts.  
   - Source of truth: `docs/new-pms/PRODUCT.md`, `ARCHITECTURE.md`, `FIRESTORE_SCHEMA.md`, `ROADMAP.md`.  
   - Implementation will move to a **new monorepo**; until then, prefer updating planning docs over bolting SaaS code onto personal HTML pages.

## Locked product decisions (SaaS)

- Multi-tenant from day one (`orgId` everywhere).  
- Channels via **Channex** (not building OTA connectors first).  
- Every host gets their **own booking website**; optional per-apartment pages.  
- Guest policy acceptance via **e-signature** (hand-drawn or auto from guest name).  
- Payments: **Georgian providers** (Stripe not primary).  
- Accounting v1: **PDF reports**, no RS.ge automation.  
- Revenue: subscription + marketplace % + direct booking %.  
- WhatsApp automation after **Meta verification** + a WA Business API provider (do not hardcode a dead/non-working provider).  
- Currency: GEL primary, EUR secondary; timezone default Asia/Tbilisi.

## Engineering preferences

- Prefer updating `docs/new-pms/*` before large new features.  
- No secrets in client code.  
- Do not invent product scope that contradicts `PRODUCT.md` / `ROADMAP.md` without asking.  
- When dogfooding ideas on personal check-in/HK pages, keep changes minimal and reversible unless asked to productize.

## Communication with the founder

- Founder may work from phone via Cloud Agents — prefer clear PR summaries and doc updates.  
- Avoid jargon-only replies; state what changed and where.
