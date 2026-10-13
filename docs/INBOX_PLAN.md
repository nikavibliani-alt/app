# Booking.com guest inbox: plan

Booking.com and Airbnb only give messaging APIs to approved partners, so we use email.
Booking.com emails us each guest message. Replying to that email, from an approved sender
address, posts the reply into the guest chat. Booking.com first, Airbnb later.

## Steps

1. **Collect emails (this step).** A Gmail script sends every Booking.com email to the Cloud
   Function `inboxEmailIngest`, which saves it as-is in Firestore `inbox_raw_emails`.
   Nothing else happens to it.
2. **Sort them.** Tell apart: guest message, check-in or arrival time notice, other Booking.com
   system email. Match each to its reservation by the Booking.com reservation number.
3. **Read-only inbox in admin.** A screen that looks like the Booking.com chat.
4. **Reply from the inbox.** Sent as a reply in the same Gmail thread.
5. **AI drafts.** Reuse the WhatsApp bot's rules. I approve each draft with one tap.

## Rules

- Ignore Booking.com check-in and arrival time notices.
- If a guest sends several messages, or writes word by word, wait until they stop (the timer
  starts again on every new message) and answer once.
- My own reply always cancels a pending AI reply.
- Never send door codes, elevator codes or WiFi passwords.
- Booking.com replies are plain text only.
- Raw emails hold guest messages, so browsers can never read or write `inbox_raw_emails`.
  Only Cloud Functions (admin access) touch it.

## Maxela now, platform later

- **Now:** one free Google Apps Script in the Gmail that receives Booking.com emails. It reads
  Gmail and posts each email to our Cloud Function.
- **Later (platform):** each PMS customer gets their own address on a separate PMS domain,
  added in their Booking.com Extranet as a Reservations contact.
- Only "emails in" and "replies out" change. Sorting, the inbox and the AI are built once
  and reused.

## Step 1 details

- Function: `inboxEmailIngest` (pipeline-functions, europe-west1). POST only. The key is sent as
  `Authorization: Bearer <key>` and checked against the Firebase secret `INBOX_INGEST_KEY`.
- Document id is the Gmail message ID, so the same email is never saved twice.
  Fields: gmailMessageId, gmailThreadId, date, from, to, replyTo, subject, bodyText, bodyHtml
  (cut to 200 KB), a few headers, receivedAt, source `gmail-script`.
- Script: `apps-script/booking-inbox/`. First run sends the last 30 days, then a 1-minute
  trigger sends new mail. Progress is kept per message (not Gmail labels) in Script Properties.
- Script Properties (`INGEST_URL`, `INGEST_KEY`) are never in the repo.
