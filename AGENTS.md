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

## Cursor Cloud specific instructions

Durable, non-obvious notes for running things in the Cloud Agent VM. The startup update script already installs deps (Node deps in `scripts/` and `tuya-functions/`, and Python deps `requests firebase-admin beautifulsoup4 cryptography anthropic`), so this section is about how to actually run/verify, not installation.

- **What is runnable:** Only Product A (the personal Maxela tools) has runnable code. Product B (`docs/new-pms/`) is planning docs only — there is nothing to build or run there.
- **Frontend apps = static HTML, no build step.** Serve the repo root and open a page, e.g. `python3 -m http.server 8000` then `http://localhost:8000/checkin-guest-v2.html` (guest app; `checkin-guest.html` is just a redirect). Other entry points: `checkin-admin.html`, `HK-Shartava.html`, `HK-Centre.html`, `pricing.html`, `index.html`. See `CODEBASE.md` for the full file map and Firebase schema.
- **The HTML apps talk to LIVE production Firebase** (project `sleepy-5c962`; client config is embedded and public by design). They need outbound network to `*.googleapis.com` / `gstatic.com`, which works in this environment. There is no local/emulated backend — data you see and write is real.
  - Because it is production, avoid polluting/breaking it. In the guest app, a *matched* search or a completed check-in writes real guest data; a *no-match* search only writes a harmless `search_failures` debug doc. For demos, use an obviously fake booking name so nothing real is created.
- **Python scripts are batch jobs, not services** (no port, run once and exit), driven by GitHub Actions in production. They need external secrets that are NOT present in this VM by default (`FIREBASE_SERVICE_ACCOUNT`, `MINIHOTEL_USER/PASS/HOTEL`, `ANTHROPIC_API_KEY`, `SERPAPI_KEY`, `YCLOUD_API_KEY/PHONE_NUMBER`, `RESEND_API_KEY`), so they can't run fully end-to-end here without those secrets.
  - The core pricing math is testable offline with no creds: `velocity_engine.compute_prices_velocity(raw_data, config, velocity)` is pure and works against `config.json` with synthetic MiniHotel-shaped `raw_data`. Importing `pricing_engine` has no network/Firebase side effects at import time.
- **`tuya-proxy.js` actuates REAL door locks** via the Tuya cloud (hard-coded creds, listens on port 3000). Do not run it casually.
- **Lint / tests:** there is no configured linter or automated test suite. For basic verification use `python3 -m py_compile *.py` (Python) and `node --check <file>` (JS, e.g. `tuya-proxy.js`, `scripts/elevator-monitor.js`, `tuya-functions/index.js`).
