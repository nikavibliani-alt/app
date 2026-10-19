# Booking.com inbox: Gmail script (steps 1 and 4)

Runs in ltd.premiumapartments@gmail.com. Every minute it:

1. asks the `inboxOutbox` Cloud Function for replies written in the inbox screen and sends each
   one as a plain-text email with an empty subject to the guest's Booking.com address (step 4).
   The same step also runs at once through the web app (`doPost`) when I tap Send. Then
2. sends new Booking.com emails to the `inboxEmailIngest` Cloud Function (step 1).

Plan and details: `docs/INBOX_PLAN.md`. The function URL and key live only in Script Properties
(`INGEST_URL`, `INGEST_KEY`), never in this folder. `inboxOutbox` uses the same key as the ingest
function. `OUTBOX_URL` is an optional Script Property; without it the URL in `Code.gs` is used.

## Web app for instant sending (step 4b)

The web app is called by the `inboxSendReply` Cloud Function right after Send, with
`{"key": INGEST_KEY, "action": "sendNow"}`. Wrong key: nothing happens. The every-minute trigger
stays as a backup. Both only send what the server hands out as `waiting`; the server marks an item
`sending` before handing it out, so a reply is never sent twice.

The URL goes to the server as the Firebase secret `INBOX_SCRIPT_URL`
(`firebase functions:secrets:set INBOX_SCRIPT_URL`, then redeploy `inboxSendReply`). Use the URL
that ends in `/exec`.

## Updating the script

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

## Light runs and the "script stopped" alert (step 4c)

- **Idle minutes are cheap.** Every minute the script reads the mailbox "history id" from the Advanced Gmail service (one small call). If it is the same as at the last complete check, it does nothing else. It still reads the mail at least every 10 minutes. If the Gmail service is off or fails, it checks the mail every run, like before.
- **Fixed: a run no longer loops until the time budget.** The old loop kept chasing "now" and searched Gmail about 500 times in every run (about 4.5 minutes per run, which also explains why the server saw the script only every 5 minutes). It now stops as soon as it has looked at everything up to one minute ago.
- **Backup check for waiting replies** about every 5th minute (instant sending goes through the web app).
- **The server watches the script.** Each backup check also tells the server "I am alive" (`inbox_meta/script_heartbeat`, calls from the web app do not count). `inboxScriptWatch` sends a push to all phones if there is no call for 15 minutes ("Booking.com Gmail script has stopped"), repeats it every 3 hours, and says when the script is back.

### Updating the script (paste again)
1. script.google.com, signed in as ltd.premiumapartments@gmail.com, open the Booking inbox project.
2. Project Settings (gear): "Show appsscript.json manifest file in editor" is already on. Open `appsscript.json`, replace everything with the file from this folder, save. It adds the Advanced Gmail service.
3. Open `Code.gs`, replace everything with the file from this folder, save. Script Properties stay as they are.
4. Check Services (the + next to Services in the left menu): **Gmail API** should be listed (identifier `Gmail`, version v1). If it is not, click +, choose Gmail API, Add.
5. Run `status` once. If Google asks for permission again, Review permissions, choose the account, Advanced, Go to project, Allow.
6. Triggers (clock icon): exactly one trigger, `processNew`, every minute. Open it (three dots, Edit trigger) and set **Failure notification settings** to **Notify me immediately**. Save. (Google then emails the Gmail account when a run fails.)
7. **Do not** create a new web app deployment. The existing one keeps working with the new code because it runs the latest saved version only if you update the deployment: Deploy, Manage deployments, pencil icon, Version: **New version**, Deploy. The URL stays the same.
8. Check: Executions should now show `processNew` runs of about 1 second or less, with most minutes finishing almost at once.
