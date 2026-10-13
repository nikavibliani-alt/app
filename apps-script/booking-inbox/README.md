# Booking.com inbox: Gmail script (step 1)

Reads Booking.com emails in Gmail and sends each to the `inboxEmailIngest` Cloud Function.
Read-only Gmail. Setup steps and the plan are in `docs/INBOX_PLAN.md`.
The function URL and key live only in Script Properties (`INGEST_URL`, `INGEST_KEY`), never in this folder.
