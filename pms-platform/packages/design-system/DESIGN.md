# Design system — visual language

Phase 0 tokens and primitives for the new PMS. Brand name TBD.

## Intent

Ops software, not a lifestyle hotel brochure and not a generic AI dashboard.

Reference bar: **Mews / Cloudbeds** — cool neutrals, one restrained accent, dense but readable, hairline structure. Guests and housekeepers get the same tokens with simpler layouts (mobile-first), not a second palette.

## What we avoid

- Purple gradients, neon glass, “AI startup” glow
- Cream + terracotta hospitality cliché
- Inter-on-white with a random blue button
- Emoji as UI
- Decorative serif headlines on staff tools

## Palette

| Token | Hex | Use |
|-------|-----|-----|
| `--pms-bg` | `#F3F4F6` | App canvas (cool gray) |
| `--pms-surface` | `#FFFFFF` | Cards, nav, sheets |
| `--pms-ink` | `#12161C` | Primary text |
| `--pms-muted` | `#5B6570` | Secondary text |
| `--pms-line` | `#E3E6EB` | Borders |
| `--pms-accent` | `#0F6E62` | Primary actions, focus, key status |
| `--pms-danger` | `#B42318` | Destructive / overdue |
| `--pms-warning` | `#B54708` | Needs attention |
| `--pms-ok` | `#176C45` | Confirmed / clean |

Accent is **deep teal** — calm, operational, distinct from Booking blue / Airbnb coral.

## Type

- UI: **IBM Plex Sans**
- Codes, money, dates: **IBM Plex Mono** (tabular numbers)
- Scale: 12 / 13 / 14 / 16 / 20 / 24 / 32

GEL is primary; EUR secondary. Do not invent currency formatters here — import from `@pms/domain` when Claude Code publishes it. Until then, preview copy may show `₾` / `€` as static text.

## Spacing

4px base: 4, 8, 12, 16, 20, 24, 32, 48.

## Components (Phase 0)

`Button`, `Input`, `Card`, `Nav` — nothing else yet. No calendar, check-in form, or HK board.

## Apps that will consume this

- `host-dashboard` — full nav, data density
- `guest-portal` — no staff login; token URL only
- `housekeeping` — large tap targets, status color
- `provider-portal` — empty shell later
- `booking-sites` — host brochure later (Phase 1 stub)
