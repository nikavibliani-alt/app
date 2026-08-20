# New PMS — Data Model (Draft)

> Draft for planning. Collection names may map to Firestore now and/or Postgres later.  
> **Rule:** every tenant-owned document includes `orgId`.

---

## Core

### `organizations/{orgId}`
| Field | Notes |
|-------|--------|
| `name`, `legalName` | |
| `country` | default `GE` |
| `timezone` | default `Asia/Tbilisi` |
| `currencyPrimary` | `GEL` |
| `currencySecondary` | `EUR` optional |
| `plan`, `billingStatus` | subscription |
| `marketplaceEnabled` | bool |
| `createdAt` | |

### `memberships/{membershipId}`
| Field | Notes |
|-------|--------|
| `orgId`, `userId` | |
| `role` | owner / co_host / front_desk / housekeeper / accountant |
| `propertyScope` | optional list of propertyIds |

### `users/{userId}`
Auth profile: name, email, phone, locale.

---

## Inventory & reservations

### `properties/{propertyId}`
Building / listing group: name, address, orgId, photos, checkInTime, checkOutTime.

### `units/{unitId}`
Sellable room/apartment: `propertyId`, `orgId`, `code`, `name`, `maxGuests`, `amenities`, smartLock refs.

### `rate_plans/{ratePlanId}`
orgId, propertyId, name, currency, cancellation policy refs.

### `calendar_days/{unitId_YYYY-MM-DD}` *(or equivalent ARI store)*
| Field | Notes |
|-------|--------|
| `orgId`, `unitId`, `date` | |
| `available` | bool / inventory count |
| `rate` | money |
| `minStay`, `maxStay` | |
| `closedToArrival`, `closedToDeparture` | |
| `manualPriceLock` | bool |

### `reservations/{reservationId}`
| Field | Notes |
|-------|--------|
| `orgId`, `unitId`, `propertyId` | |
| `status` | inquiry / confirmed / cancelled / checked_in / checked_out / no_show |
| `source` | direct / booking / airbnb / expedia / manual / … |
| `channelReservationId` | external id |
| `guestIds[]` | |
| `checkIn`, `checkOut` | YYYY-MM-DD in property TZ |
| `money` | totals, currency, commission fields |
| `doorCode` / lock payload | optional |

### `guests/{guestId}`
orgId, name, email, phone, nationality, documents[], marketing opt-in.

---

## Guest check-in

### `checkin_sessions/{sessionId}`
| Field | Notes |
|-------|--------|
| `orgId`, `reservationId` | |
| `status` | draft / submitted / approved / blocked |
| `passportUrls[]` | |
| `policyVersion` | |
| `signature` | `{ type: 'drawn' \| 'auto', url, signedAt, guestName }` |
| `contact`, `contactType` | wa / tg / phone |
| `manualUnlock`, `blocked` | |

---

## Housekeeping & maintenance

### `hk_tasks/{taskId}`
orgId, unitId, date, status (`dirty` / `clean` / `inspected` / `ooo`), assigneeId, priority, notes, photos[].

### `maintenance_tickets/{ticketId}`
orgId, unitId, createdBy, priority, status, description, photos[], assigneeId.

---

## Messaging

### `message_templates/{templateId}`
orgId, channel (whatsapp/email/sms), trigger, body, variables, locale.

### `message_logs/{logId}`
orgId, reservationId, channel, templateId, status, providerId, timestamps.

---

## Marketplace

### `providers/{providerId}`
Platform-level or org-linked seller: name, contacts, payout details, status.

### `service_listings/{listingId}`
providerId, categories (tour/transfer/food/car), title, price, commissionRule, cities, active.

### `service_orders/{orderId}`
orgId, reservationId, listingId, providerId, status, amounts, splits `{provider, host, platform}`, guest notes.

---

## Direct booking

### `booking_sites/{siteId}`
| Field | Notes |
|-------|--------|
| `orgId` | one primary site per org |
| `subdomain`, `customDomain` | |
| `theme`, `logo`, `content` | |
| `platformFeePercent` | |

### `apartment_pages/{pageId}`
Optional per-unit landing page under a booking site.

---

## Money

### `folios/{folioId}`
orgId, reservationId, lines[], payers[], status.

### `invoices/{invoiceId}`
orgId, number, pdfUrl, status, totals, guest/company bill-to.

### `payments/{paymentId}`
orgId, provider, amount, currency, status, folioId/invoiceId/bookingId.

### `accounting_periods/{orgId_YYYY-MM}`
summary totals, co-host settlement snapshots, `pdfUrl`.

### `ledger_entries/{entryId}`
Double-entry-ish or simple ledger for marketplace + platform fees.

---

## Pricing

### `pricing_rules/{ruleId}`
orgId, property/unit scope, floors/ceilings, seasonality, event boosts.

### `pricing_proposals/{proposalId}`
suggested rates, reasoning, auto_applied, status.

---

## Platform billing

### `subscriptions/{orgId}`
plan, seats/units, status, pspCustomerId.

### `platform_invoices/{invoiceId}`
SaaS invoices to hosts.

---

## Indexes & rules (notes)

- Always query with `orgId` first.  
- Security rules: membership role must match action.  
- Passport and signature paths: write once / limited read.  
- Platform admin bypass via custom claim only.
