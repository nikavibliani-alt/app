# New PMS — Architecture

> Planning document. Stack choices are recommendations until scaffolding starts.

---

## 1. Principles

1. **API-first** — every dashboard action backed by a real API (REST first; GraphQL later only if needed).  
2. **Multi-tenant from day one** — every record has `orgId`; no shared singletons.  
3. **Event-driven** — internal events + outbound webhooks (`booking.created`, `room.status_changed`, `folio.paid`, `service_order.created`).  
4. **Channel adapter pattern** — Channex is the first adapter; never hardcode OTA logic into the core calendar.  
5. **Dogfood ≠ codebase** — personal Maxela tools inspire UX; product code is clean and separate.  
6. **Georgia-ready payments** — PSP abstraction so providers can be swapped.  
7. **Tbilisi timezone default** with per-property timezone override.  
8. **Money** — GEL primary display; EUR (and others) supported with explicit FX rules per org.

---

## 2. Recommended stack

| Layer | Choice | Why |
|-------|--------|-----|
| Host dashboard + provider portal | Next.js (React) + TypeScript | Professional SaaS UX, auth, forms, calendar |
| Guest portal + HK app | Next.js mobile routes or lightweight PWA | Fast mobile; can share design tokens |
| Auth | Firebase Auth + custom claims (`orgId`, `role`) | Familiar, solid RBAC base |
| Database | Cloud Firestore (or Postgres later if needed) | Fast multi-tenant start; evaluate Postgres for heavy folio/accounting |
| Files | Firebase Storage / S3-compatible | Passports, signatures, HK photos, invoices |
| Backend jobs | Cloud Functions + Python workers | Messaging, pricing, Channex sync, PDF |
| Channel manager | **Channex** API (sandbox → production) | White-label OTA connectivity |
| Payments | Georgian PSP adapter interface | Subscriptions, deposits, (later) marketplace |
| PDF | Server-side generator | Invoices + accounting reports |
| Hosting | Vercel/Cloud Run + Firebase Hosting as needed | Host sites on subdomains / custom domains |
| Observability | Sentry + structured logs | Production readiness |

Vanilla HTML is fine for personal tools; **not** the foundation for the sold product.

---

## 3. Monorepo layout (target)

```
/pms-platform/   (new repository — not this Maxela ops repo)
  apps/
    host-dashboard/       # calendar, ops, accounting, settings
    guest-portal/         # check-in, e-sign, upsells, services
    housekeeping/         # staff mobile app
    provider-portal/      # marketplace sellers
    booking-sites/        # generated per-host websites
  packages/
    api-client/
    domain/               # shared types, money, dates (Tbilisi helpers)
    design-system/
    auth/
  services/
    channex-sync/
    pricing-engine/
    messaging/            # WhatsApp/Email/SMS provider adapters
    pdf/
    billing/
  docs/
    PRODUCT.md
    ARCHITECTURE.md
    FIRESTORE_SCHEMA.md
    ROADMAP.md
  AGENTS.md
```

Until the new repo exists, planning docs live in **this** repo under `docs/new-pms/` as the source of truth.

---

## 4. Multi-tenancy & RBAC

### Tenant model

```
Platform
 └── Organization (host company)
      ├── Users (membership + role)
      ├── Properties / Units
      ├── Channels (Channex mapping)
      ├── BookingSite (custom domain / subdomain)
      ├── Marketplace settings
      └── Billing subscription
```

### Roles

| Role | Typical access |
|------|----------------|
| `owner` | Full org, money, billing |
| `co_host` | Ops, calendar, guests; limited banking |
| `front_desk` | Arrivals, folios, messaging |
| `housekeeper` | HK app only |
| `accountant` | Reports, invoices, exports |
| `provider` | Provider portal only |
| `platform_admin` | All orgs (us) |

Enforce in Firestore security rules / API middleware via custom claims. Never trust client-only checks.

---

## 5. Channel & inventory architecture

```
[Host Calendar / CRS]
        │
        ▼
[Inventory Service]  ← source of truth for availability & rates
        │
        ├──► Channex adapter ──► OTAs
        ├──► Direct booking engine ──► host websites
        └──► Pricing engine (suggestions / auto-apply rules)
```

- Webhooks from Channex update reservations in near real-time.  
- Outbound ARI (availability, rates, inventory) push on every local change.  
- Manual / experimental price locks supported (learn from Maxela pricing ideas).

---

## 6. Guest portal flow

```
Find reservation → verify → ID/passport upload → accept policies (e-sign)
  → payment if required → unlock rules (time + HK status + manual override)
  → show WiFi / door / elevator / services / upsells
```

**E-signature:** store PNG/SVG of hand-drawn signature **or** auto-rendered signature from legal name, plus timestamp, document version hash, and org policy version.

---

## 7. Messaging architecture

```
Trigger (booking created, T-24h, mid-stay, checkout, service order)
   → Message orchestrator
   → Channel adapters: WhatsApp | Email | SMS
   → Delivery log per guest
```

- Templates per org with variables (`{{wifi}}`, `{{door_code}}`, …).  
- WhatsApp goes live after Meta Business verification + chosen API provider.  
- Until then: host dashboard can still offer **manual** deep links / copy message (not presented as automation).

---

## 8. Marketplace architecture

```
Provider registers → listings approved/listed
Host enables marketplace categories
Guest orders from portal
Commission engine splits: Provider / Host / Platform
Ledger entries → payout batch (manual bank transfer v1 OK)
```

---

## 9. Direct booking sites

- One **primary website per host org** (required).  
- Optional **per-apartment** landing pages.  
- Subdomain on platform domain for beta; custom domain later.  
- Checkout uses Georgian PSP; platform fee recorded on confirmation.

---

## 10. Offline & reliability

Priority for offline-tolerant behavior:

1. Housekeeping status toggles  
2. Guest check-in queue (front desk)  
3. Maintenance ticket create  

Use local cache + sync queue; conflict policy: server timestamp wins unless explicit merge rules.

---

## 11. Security & compliance

- Passports / IDs encrypted at rest; strict retention policy per org settings.  
- Signatures immutable after submit.  
- Audit log for money, channel pushes, role changes.  
- Secrets only in server env / secret manager — never in client bundles.

---

## 12. Relationship to this GitHub repo

| This repo (Maxela personal) | New PMS product |
|-----------------------------|-----------------|
| Live ops for founder properties | SaaS for many hosts |
| MiniHotel unofficial automation | Channex official API |
| Inspiration / dogfood UX | Clean implementation |

Do **not** turn `SleepyPMS.html` into the product. Extract ideas only.
