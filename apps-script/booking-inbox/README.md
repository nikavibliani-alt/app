# Booking.com inbox: Gmail script (steps 1 and 4)

Runs in ltd.premiumapartments@gmail.com. Every minute it:

1. asks the `inboxOutbox` Cloud Function for replies written in the inbox screen and sends each
   one as a plain-text reply to the guest's Booking.com email (step 4), then
2. sends new Booking.com emails to the `inboxEmailIngest` Cloud Function (step 1).

Plan and details: `docs/INBOX_PLAN.md`. The function URL and key live only in Script Properties
(`INGEST_URL`, `INGEST_KEY`), never in this folder. `inboxOutbox` uses the same key as the ingest
function. `OUTBOX_URL` is an optional Script Property; without it the URL in `Code.gs` is used.

## Updating the script (step 4)

1. Open script.google.com signed in as ltd.premiumapartments@gmail.com, open the Booking inbox project.
2. Project Settings (gear): tick "Show appsscript.json manifest file in editor".
3. Editor: open `appsscript.json`, replace everything with the file from this folder, save.
4. Open `Code.gs`, replace everything with the file from this folder, save.
5. Run any function once (for example `status`). Google asks for permission again because the
   script can now send mail: Review permissions, choose the account, Advanced, Go to the project,
   Allow.
6. Check Triggers (clock icon): one trigger, `processNew`, every minute. Do not add another.
7. Script Properties stay as they are.

Permission note: `https://mail.google.com/` is Gmail's full-access scope. Apps Script needs it
for replying to a message with `GmailMessage.reply`. The script only sends replies that the
inbox queued, to Booking.com guest addresses (`@guest.booking.com`), and still only reads
Booking.com mail for ingest.
