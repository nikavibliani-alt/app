# Data Retention Policy — Passport / ID Documents

## Policy

Guest passport/ID photos and their verification results are retained for a
**minimum of 1 month (30 days) after checkout** before any deletion.

## Why

- **Chargeback protection.** If a guest disputes a charge, the passport/ID
  photo captured at check-in is the primary evidence tying the booking to a
  specific, verified individual. Deleting it too early removes that evidence
  before a chargeback window can reasonably close.
- **Legal requirement in Georgia.** Accommodation providers are required to
  retain guest identification records for a minimum retention period under
  Georgian regulations governing hotel/short-term-rental guest registration.
  (Confirm the exact statutory period with legal counsel if this policy is
  ever revisited — 30 days is treated here as a floor, not a ceiling.)

## What is covered

| Location | Contents | Minimum retention |
|---|---|---|
| Firebase Storage: `passport_uploads/` | The uploaded passport/ID photo (JPEG/PNG) | Checkout date + 30 days |
| Firestore: `checkin_guests/{id}.passportUrl` | Download URL pointing to the Storage object above | Checkout date + 30 days |
| Firestore: `checkin_guests/{id}.passportScanResult` | AI document-verification result (valid/confidence/reason) tied to the photo | Checkout date + 30 days |

Deleting the Firestore fields without deleting the Storage object (or vice
versa) still breaks the chargeback record — treat these as one unit.

## Guests who skip upload

`checkin_guests/{id}.passportSkipped: true` means no photo was ever
collected for that guest — there is nothing to retain, and the field itself
should be kept for the same 30-day floor as a record that upload was
offered and declined/failed.

## Current enforcement status

As of 2026-09-05, there is **no automated deletion job** for passport data
in this codebase (no scheduled Cloud Function, cron, or pipeline script
targets `checkin_guests` or `passport_uploads/` on a schedule) — nothing is
currently at risk of running for you. The one **manual, admin-triggered**
bulk-delete found (`window.deleteOldGuests()` in `checkin-admin-backup.html`,
a file excluded from Hosting deploy but still present in the repo and
runnable locally against production Firestore) previously purged
`checkin_guests` docs older than 7 days by `submittedAt` — well inside the
30-day floor. It has been disabled and left in place only as reference; do
not re-enable it without rechecking this policy first.

Separately, guest-facing copy in `checkin-guest.html` (and its sandbox
variants) tells guests their document is "Used once to verify, then
auto-deleted after check-out." No such auto-deletion exists today, and even
if it did, it would need to happen no sooner than checkout + 30 days to
satisfy this policy — so that copy currently promises guests something the
system does not do, and should not do as literally worded. Flagged here,
not changed, since it's guest-facing/legal language outside the scope of
this doc.

## If a deletion mechanism is added later

Any future scheduled cleanup (Cloud Function, cron, admin tooling, etc.)
that touches `checkin_guests` or `passport_uploads/` must filter out any
record where `checkoutDate` (or `checkout`) is less than 30 days in the
past, and must delete the Storage object and the Firestore fields together.
