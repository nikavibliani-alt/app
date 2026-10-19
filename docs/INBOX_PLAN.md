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

## Step 2 details (done)

- Rules: `pipeline-functions/lib/inboxSort.js` (pure, tested). Firestore side:
  `pipeline-functions/controllers/inboxSort.js`. Function `inboxSort` runs when a document is
  created in `inbox_raw_emails` (europe-west1). Deploy it alone:
  `firebase deploy --only functions:pipeline:inboxSort --project sleepy-5c962`.
- Every raw email gets `sortedAs`: `chat`, `checkin_request`, `auto_confirmed`, `cancel_request`,
  `hidden` or `review`. An email with `sortedAs` is never processed again.
- `inbox_conversations/{bookingNumber}`: one per reservation (channel `booking`, account `maxela`).
  Holds the reservation link, guest, property, dates, `replyTo`, `needsReply`, `done`,
  `checkinRequest {time, autoConfirmed, at}` and `cancelRequest {at, deadline}`.
  `messages/{gmailMessageId}`: guest chat messages (direction `guest`, clean text, `sentAt`).
- `inbox_review/{gmailMessageId}`: the "check this" pile, with a reason.
- Hidden: reminder digests, finance, payments, marketing, policy, security notices.
- Cancelled reservations still show their conversation.
- Recovery and one-time run: `node scripts/inbox-sort-backfill.js` (`--dry` prints counts only).
  Needs `gcloud auth application-default login`. Safe to run twice.
- Own replies from the Extranet or Pulse never arrive by email, so the inbox cannot see them.

## Step 3 details (inbox screen, read + Done)

- Page: `inbox.html` (live at /inbox). Owner Google sign-in via `shared/owner-auth.js`, same as
  the pricing pages. Linked from the admin More menu ("Guest inbox"). Live updates (onSnapshot).
- Lists: Needs reply / All / Done, plus "Check this (N)". Conversations with no chat messages are
  hidden unless they carry a cancel request. The Done button only writes `done` and `doneAt`.
- New fields on conversations (set by `inboxSort`): `hotelId` (for the Open in Booking.com
  button), `lastMessagePreview`, and `doneAt` is cleared when a new guest message arrives.
- Launch (one time, safe to repeat): `node scripts/inbox-step3-launch.js` marks the existing
  conversations done, using the launch time saved in `inbox_meta/step3_launch`.
- The Firestore rules are not in this repo; they live in the Firebase console. Current text,
  including `inbox_*` being server-only except for the owner reads and the done update:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function isOwner() {
      return request.auth != null
        && request.auth.token.email_verified == true
        && request.auth.token.email == 'nikavibliani@gmail.com';
    }
    function ownerOnly(c) { return c.matches('pricing_.*'); }
    function serverOnly(c) { return c.matches('whatsapp_.*') || c.matches('inbox_.*'); }

    // Guest inbox: the owner may read, and may change only done / doneAt on a conversation.
    // Everything else in inbox_* (raw emails, creating or deleting) stays server-only.
    match /inbox_conversations/{conv} {
      allow read: if isOwner();
      allow update: if isOwner()
        && request.resource.data.diff(resource.data).affectedKeys().hasOnly(['done', 'doneAt']);
      match /messages/{msg} {
        allow read: if isOwner();
      }
    }
    match /inbox_review/{item} {
      allow read: if isOwner();
    }

    match /{col}/{doc=**} {
      allow read, write: if !serverOnly(col) && (!ownerOnly(col) || isOwner());
    }
  }
}
```

## Step 4 details (reply from the inbox)

- `inboxSendReply` (callable, owner only: Firebase Auth nikavibliani@gmail.com, email verified):
  saves the reply as a host message in the conversation (status `waiting`) and as an item in
  `inbox_outbox` (server-only). Sets `needsReply=false`, `done=true`. Plain text, max 2000 chars.
  A client id per click makes a double tap create one item.
- `inboxOutbox` (HTTPS, `Authorization: Bearer <INBOX_INGEST_KEY>`): the Gmail script calls
  `{action:'pull'}` for waiting replies (each is marked `sending` first, so it is never handed out
  twice) and `{action:'report', id, result:'sent'|'failed', reason}`.
  `sending` for more than 10 minutes with no report becomes `unknown`, and is never resent.
  `failed` and `unknown` put the conversation back on Needs reply.
- `inboxCheckinLink` (callable, owner only): the Extranet page of a check-in time request, built
  from the saved raw email. No Accept/Reject option in the link.
- Statuses: waiting, sending, sent, failed, unknown. "Try again" in the screen makes a new item.
- The screen warns (never blocks) about links other than app.maxelaapartments.com, email
  addresses, phone numbers, and anything that looks like a door code or WiFi password
  (`shared/inbox-reply-warnings.js`).
- Deploy: `firebase deploy --only functions:pipeline:inboxSendReply,functions:pipeline:inboxOutbox,functions:pipeline:inboxCheckinLink --project sleepy-5c962`.
- Gmail script: see `apps-script/booking-inbox/README.md`. Firestore rules are unchanged.

### Step 4b (empty subject, instant send)

- Booking.com shows the email subject inside the guest chat, so replies are sent with an empty
  subject (a single space if Gmail refuses an empty one) as a new plain email to the guest's
  `@guest.booking.com` address. The script still checks that the saved guest email has the expected
  reply address first.
- The Gmail script is also a web app (`doPost`, execute as the account, access Anyone, key in the
  body). `inboxSendReply` pokes it right after saving a reply, waiting at most 6 seconds. If that
  fails, the every-minute run sends it. The web app URL is the Firebase secret `INBOX_SCRIPT_URL`
  (`firebase functions:secrets:set INBOX_SCRIPT_URL`, then redeploy `inboxSendReply`).
