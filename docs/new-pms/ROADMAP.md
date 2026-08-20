# New PMS — Roadmap & Gap Analysis

> Combines our product decisions with the Gemini “ultimate modern PMS” blueprint.  
> Phases are ordered for **profit differentiation first**, full channel PMS depth next. No calendar-day estimates.

---

## 1. Gap analysis (Gemini blueprint vs our plan)

### Already in our plan (aligned)

| Gemini item | Our module |
|-------------|------------|
| Native 2-way channel manager | Channex adapter |
| Direct booking engine | Per-host websites + optional apartment pages + platform % |
| Dynamic pricing / RMS | Smart pricing engine (build + later external sync) |
| Multi-property CRS | Host dashboard portfolio calendar |
| Contactless digital check-in | Guest portal + ID upload |
| Registration e-sign | Hand-drawn or auto-from-name signature |
| Smart key / IoT locks | Lock integrations (Tuya/TTLock-class) |
| Automated guest messaging | WhatsApp/Email/SMS after Meta + provider |
| Automated upselling | Guest portal upsells + marketplace |
| Mobile housekeeping | HK app (inspired by Maxela HK UX) |
| Embedded payments | Georgian PSP adapter |
| Local tax rules | Configurable; PDF-first for Georgia |
| Open API + webhooks | Architecture principle |
| RBAC | Roles from day one |
| Offline-tolerant ops | Progressive HK + check-in queue |

### Was missing / weak — **now added**

| Item | Decision |
|------|----------|
| Maintenance & issue tracking | Module in Ops — tickets with photos/priority |
| Night audit / daily close automation | Background business-date close (Phase 2–3) |
| Split folios / multi-payer billing | Phase 3+ (after simple folio/invoice) |
| F&B / POS integration | Phase 5+ (low priority for apartment-first market) |
| Card-on-file / pre-auth / chargebacks | Depends on Georgian PSP capabilities — design PSP interface for it |
| Offline-first explicitly | Called out in architecture; implement progressively |
| CRS cross-property transfers + unified guest DB | Explicit in Calendar/CRS module |
| WebSocket/webhook real-time channel sync | Prefer Channex webhooks + push ARI; document SLAs |

### Intentionally different from Gemini

| Gemini assumption | Our choice |
|-------------------|------------|
| Stripe / Adyen default | **Georgian payment providers** first |
| Heavy hotel F&B POS | Apartments/co-hosts first; POS later |
| RS.ge-style tax filing | **PDF reports only**; hosts often informal |
| Build every OTA connector | **Channex** until/while direct OTA verification |
| Generic global PMS only | **Marketplace + Georgia co-host accounting** as moat |

### Our extras beyond typical PMS (keep)

- Service marketplace (tours, transfers, food, car rental) with 3-way split  
- Provider self-serve portal  
- Supplies ordering (later)  
- Dogfood path via founder’s new apartments without forcing MiniHotel migration  

---

## 2. Phased delivery

### Phase 0 — Foundation (docs + skeleton)
**Outcome:** empty product that can host tenants safely.

- [x] Product / architecture / schema / roadmap docs (this folder)
- [ ] New GitHub repository (separate from Maxela ops)
- [ ] Cursor `AGENTS.md` + rules in new repo
- [ ] Firebase (or chosen backend) project + Auth claims
- [ ] Design system tokens (professional, not default AI aesthetic)
- [ ] App shells: host dashboard, guest portal, HK app
- [ ] CI basic pipeline

### Phase 1 — Core ops MVP (dogfood on 1–2 new apartments)
**Outcome:** real guest can stay using our stack (channels via Channex sandbox→live).

- Properties / units CRUD  
- Calendar + manual reservations  
- Channex connect (ARI out, bookings in)  
- Guest portal: find booking, ID upload, **e-signature**, WiFi/door basics  
- Housekeeping mobile statuses + arrival priority  
- Basic RBAC (owner, co_host, housekeeper)  
- Host website stub (subdomain)

### Phase 2 — Money & direct booking
**Outcome:** we can charge hosts and earn on direct bookings.

- Georgian PSP for deposits + SaaS subscription  
- Direct booking checkout on host website  
- Optional per-apartment pages  
- Invoices PDF  
- Simple folio (single payer)  
- Monthly accounting PDF (income/expense/co-host settlement templates)  
- Daily close / night-audit-lite (business date roll)

### Phase 3 — Marketplace & messaging
**Outcome:** extra income for hosts + providers; WhatsApp automation live.

- Provider portal + listings  
- Guest order flow + commission ledger  
- Platform-seeded Tbilisi providers  
- Message templates + orchestrator  
- WhatsApp Business API provider integration (post–Meta verification)  
- Email fallback  
- Maintenance tickets v1  

### Phase 4 — Pricing & locks
**Outcome:** less manual rate work; smoother access.

- Pricing rules engine (floors, ceilings, events)  
- Competitor comps (later in phase)  
- Smart lock integrations  
- Upsell packs (early/late, upgrades)  

### Phase 5 — Scale & enterprise depth
**Outcome:** closer to “ultimate PMS” depth.

- Split folios / multi-payer  
- Open public API + signed webhooks for customers  
- Offline-tolerant HK/check-in hardening  
- Supplies ordering  
- POS / F&B bridges (only if demand)  
- Custom domains for all host sites  
- Deeper tax rule packs per country  

---

## 3. Explicit non-goals (near term)

- Migrating all existing Maxela MiniHotel inventory on day one  
- Porting family Shartava profit-split app into SaaS  
- RS.ge automated filing  
- Building OTA connectors without Channex  
- Pixel-perfect clone of Mews/Cloudbeds before marketplace value exists  

---

## 4. Definition of “ready to ask friends to pay”

Checklist:

1. Channex live for at least one property  
2. HK app usable for a full cleaning day  
3. Guest self check-in + e-sign completed by a real guest  
4. Host booking website accepted one paid test booking  
5. One monthly PDF settlement a co-host understands  
6. Subscription charge succeeds on Georgian PSP (or clear invoice + transfer process)

---

## 5. Working style

- Plan in `docs/new-pms/*` before large builds  
- One vertical slice at a time (schema → API → UI → dogfood)  
- Founder tests UX on real guests (personal tools or new apartments)  
- Cursor / Claude Code both read the same docs — schema changes update this folder first  
