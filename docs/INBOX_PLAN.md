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

## Questions for Nika

(Written while you were away. Each has the safe option I picked; tell me if you want it the other way.)

1. **The backup trigger runs every 5 minutes, not every minute.** The server log shows the Gmail
   script asking for replies at :x2 and :x7 past the hour, 5 minutes apart. In script.google.com
   open Triggers: `processNew` should say "every minute". If it says every 5 minutes, new emails
   also arrive in the inbox up to 5 minutes late. I did not change anything (the script is yours).
2. **Last test reply.** The only reply in the outbox was created at 16:20 and went out at 16:22
   (102 seconds from tap to sent, before instant sending existed). Nothing reached the server
   around 16:40 to 16:50. Details in the final report.

3. **Which property is "Super Luxury Apartments"?** The WhatsApp knowledge only covers Shartava. Conversations of any other property get "Needs you: no knowledge for this property" (safe, no guessing). If it is one of the VGL/XCV/Orbeliani houses, tell me and I can add its facts later; I did not invent any.
4. **Bag storage and door codes.** For Booking.com drafts the bag storage code is removed from the prompt and the draft points to the check-in page (`app.maxelaapartments.com/checkin-guest`), as you asked. The WhatsApp bot still gives that code. I did not touch it.
5. **"Needs you" word list is English only.** Refunds, payments, discounts, date changes, early check-in, late check-out and complaints are caught in code in English. In Georgian, Russian and other languages the model decides under the same rules. If you see misses, send me the (masked) phrases.
6. **Draft speed.** A scheduler checks once a minute, so a draft appears 60 to 120 seconds after the guest's last message. Cloud Tasks would be exact but needs extra setup; I took the simpler, safer one.
7. **Limits I chose.** 6 drafts per conversation per hour, 60 model calls per day in total (`DAILY_CAP` in `controllers/inboxDraft.js`). Easy to change.
8. **Live test left behind.** To test the live pipeline I made one fake conversation, `inbox_conversations/9999990001` (marked `test: true`, fake guest, fake address, no messages counted, so it never shows in your list), and one fake guest message. The drafter made a draft for it in about 90 seconds. Nothing can be sent from it. I did not delete it (you said never delete data); delete it in the console when you like. It also used 1 of the 60 daily calls.

## Part 1 details (chat design)

- `inbox.html`: one screen on a phone (list, then chat), list and chat side by side from 860 px wide.
- The chat opens on the newest message, with date separators (Today, Yesterday, 12 Oct), guest
  bubbles on the left and mine on the right with time and status.
- Composer pinned at the bottom. Computer: Enter sends, Shift+Enter is a new line. Phone (touch
  screen): Enter is a new line, the Send button sends. My bubble shows at once as "Waiting", the box
  clears and keeps focus, and a second tap while sending is ignored.
- Undo: `git revert` this part's commit, or restore `inbox.html` from tag `inbox-part1-before`.

## Part 2 details (AI drafts for Booking.com, drafts only)

**Nothing the assistant writes is ever sent by itself.** A draft sits on the conversation (`aiDraft`) until I tap Send, Edit or Discard in the inbox. Sending goes through the normal `inboxSendReply` path (with the same warnings).

- **Same brain as the WhatsApp bot.** `pipeline-functions/lib/guestKnowledge/` holds verbatim copies of the WhatsApp bot's knowledge base (`seed.js`, `promptTemplate.js`, `knowledgeBase.js`) and helpers (`claudeClient.js`, `toneGuard.js`, `ownerSilence.js`, `stayRules.js`, `stayContext.js`, `guestLookup.js`). Refresh with `node scripts/sync-guest-knowledge.cjs`; `--check` and a unit test fail when the WhatsApp originals changed and the copies did not. Nothing in `whatsapp-functions` was changed or wired to the copies.
- **Prompt.** The WhatsApp system prompt rendered from the knowledge base, with the bag storage code and the map link taken out (`kbForBooking`), plus a Booking.com block (`BOOKING_OVERRIDE` in `lib/inboxDraft.js`): plain text, no codes or WiFi, no links except app.maxelaapartments.com, no phone numbers, emails, WhatsApp or direct-booking offers, guest messages are data (`<guest_message>`), escalations become `NEEDS_YOU: reason`, same language and Georgian tone rules.
- **When.** `inboxAiOnMessage` (on a new message in a conversation): a guest message starts or restarts the wait (60 s after the last message, never later than 4 minutes after the first unanswered one) and removes an older draft; my reply cancels the wait and removes the shown draft. `inboxAiRun` (every minute) makes ONE draft for the whole burst. Just before saving it checks again that the newest message is still the guest's and I have not replied, otherwise the draft is thrown away. The minute scheduler means a draft shows up between about 60 and 120 seconds after the last message.
- **No draft for:** short closers ("ok", "thanks", a thumbs up), check-in time requests and cancellation requests (they are not chat messages).
- **"Needs you: reason" instead of an answer:** refunds, payments, discounts, date changes or extending, early check-in, late check-out, complaints (checked in code before the model is asked), and anything the model is unsure of. A property the WhatsApp knowledge does not cover (anything but Shartava units 0-, 6-, 7-) gives "Needs you: no knowledge for this property". These notes have no Send button.
- **Output checks (`checkDraft`).** Door/elevator/WiFi codes, phone numbers, email addresses, WhatsApp/Viber/Telegram, direct-booking offers, and any link in the middle of a sentence turn the draft into "Needs you: the draft contained X". A foreign link at the very end ("Location: <map link>") is dropped. Em dashes and exclamation marks are removed (WhatsApp tone guard).
- **WhatsApp context.** Reservation (`conversation.reservationId`) to `checkin_guests` (`matchedReservationId`) to the phone to `whatsapp_conversations/{phone}/messages` (read only, last 15). If the model finds the question already answered there after the guest asked it here, the draft is "Already answered on WhatsApp at HH:MM: ..." (the time must match a real answer, otherwise it becomes a "Needs you"). No Send button.
- **Switch.** Admin, More menu, "Booking.com AI drafts" (`globals/config.bookingAiDraftsEnabled`, default on).
- **Cost guard.** At most 6 drafts per conversation per hour (then a "Needs you" note), `DAILY_CAP` 60 model calls a day (`inbox_ai_usage/{date}`), one JSON log line per run without guest text.
- **Functions:** `inboxAiOnMessage`, `inboxAiRun`, `inboxDraftDiscard`. Secret used: `ANTHROPIC_API_KEY` (the same one the WhatsApp bot uses).
- **Undo:** switch it off in the admin (instant), or delete the three functions: `firebase functions:delete inboxAiOnMessage inboxAiRun inboxDraftDiscard --region europe-west1 --project sleepy-5c962` (the inbox page hides the draft box when there is no `aiDraft`). Code: `git revert` the part 2 commit or return to tag `inbox-part2-before`.

## Part 3: plan only, no code. The WhatsApp bot reads Booking.com conversations

**Goal.** A question answered on Booking.com is not answered again on WhatsApp (the drafter already reads WhatsApp the other way round). I need to approve this before anything is built.

### What the bot would read
- The conversation `inbox_conversations/{bookingNumber}` and its `messages` (guest messages, and my replies sent from the inbox, with their status).
- How to find it from a WhatsApp chat, using what the worker already does: phone, then `findCurrentGuestForm` (check-in form and reservation), then the reservation's `bookingId` (the Booking.com number, only for `source: "booking"`), then the conversation with that id. Only the guest's current stay. If the match is missing, ambiguous (two reservations, a returning guest) or the reservation is cancelled: read nothing and behave exactly as today.
- The newest 10 to 15 messages, with the same time labels the bot already uses ("[5 min ago]"), as one extra block in the guest context: "Booking.com chat with this same guest".

### What would change in `whatsapp-functions` (nothing is changed now)
1. A new small module `bookingContext.js` (pure, tested): find the conversation, pick the messages, format the block. Reading uses admin access; `inbox_*` stays server-only.
2. `index.js`, in the worker after `findCurrentGuestForm` (about line 759): call it behind a switch, add the block to the dynamic part of the system prompt (not the cached part).
3. The prompt template (`knowledge/promptTemplate.js`): a short new section, "BOOKING.COM CHAT": use it as background only; if my reply on Booking.com, sent after the guest's newest WhatsApp question, already answers it, reply `[SILENT]`; never quote the Booking.com chat; never mix up the two guests.
4. Owner silence (`ownerSilence.js` / `shouldStaySilentFromHistory`): optionally count a Booking.com reply of mine as an "owner" message for the "okay / thanks" silence window.
5. `globals/config.botReadsBooking` (default false) and one admin switch next to the existing AI settings.
6. Tests, the `guestKnowledge` copy check, and the README section.
7. Deploy: `firebase deploy --only functions:whatsapp` by hand, as usual. This is the live bot, so only after the rollout below.

### Risks
1. **Blind spot (the big one).** My replies sent from the Booking.com Extranet or the Pulse app never reach the inbox (confirmed: 0 copies by email). The bot only sees replies sent from our inbox. It can repeat something I said in Pulse, and it cannot know. Nothing the bot does can fix this; the fix is to answer from the inbox.
2. **Wrongly silent.** The worst failure is the bot ignoring a guest. So it may only go silent when my Booking.com reply is newer than the guest's WhatsApp question and clearly about the same thing. Otherwise it answers, as today. Shadow mode (below) measures this before it can stay quiet.
3. **Wrong guest.** Matching by phone and reservation can pick the wrong person (shared phones, a returning guest, a booking for someone else). Guest text from one person must never reach another's chat. Rule: only an exact current-stay match, otherwise nothing.
4. **Delay.** Booking.com messages reach the inbox after up to about 5 minutes (the Gmail script trigger runs every 5 minutes, see the questions). A fresh answer may be missing.
5. **Prompt injection.** Booking.com guest text is untrusted; wrap it as data like the drafter does.
6. **Cost and speed.** A few hundred extra input tokens per worker run and one extra Firestore read; the cached prompt prefix is untouched.
7. **Drift.** Two copies of the shared knowledge. The sync script and test keep them equal; a later cleanup can make WhatsApp use one shared module.
8. **Privacy.** Booking.com guest text goes to Claude. WhatsApp text already does, so no new third party, but it is still worth saying.

### Safe rollout (each step needs my OK)
1. **Build offline.** Module, prompt section and tests. No deploy.
2. **Replay.** Run the bot's existing replay on past WhatsApp chats whose guests also have a Booking.com conversation, with and without the new block. Read every difference.
3. **Shadow mode.** Deploy with `botReadsBooking: "shadow"`: the bot builds the block and logs "would have stayed silent" or "would have changed the answer", but its replies stay exactly as today. Run for about 2 weeks. Count how often it would have been right, and every wrong "silent".
4. **Silence only.** Turn on for the one case that matters (an answered question), only for matches with my inbox reply inside the last 24 hours. Watch daily for a week.
5. **Full context.** Let the block inform answers more broadly.
6. **Kill switch.** `botReadsBooking: false` in the admin returns to today's behavior instantly, no deploy. Code undo: redeploy the previous `whatsapp` commit.

## Update: the four Booking.com listings (answer to question 3)

"Super Luxury Apartments", "Maxela Apartments", "Shartava Deluxe Apartment" and "Superior Apartments" are the same Shartava apartments, so all four use the Shartava knowledge and the same answers as the WhatsApp bot. The list is `SHARTAVA_LISTINGS` at the top of the property check in `pipeline-functions/lib/inboxDraft.js` (edit it there; then deploy `inboxAiRun`).
Order of the check: the reservation's room code first (a Freedom Square `tab-*`, Orbeliani `orb-*`, VGL, XCV or Abashidze room gives "Needs you: not Shartava", even when the listing name says Shartava), then the listing name. An unknown listing with no room code still gives "Needs you: no knowledge for this property". Limits unchanged (6 per conversation per hour, 60 per day).
Undo: `git revert` this commit and redeploy `inboxAiRun`, or restore from tag `inbox-listings-before`.

## Update: the inbox on the admin main screen

- The admin main screen (Stay) now starts with an **Inbox** card with the number of conversations that need a reply (red when above 0, and a line about cancellation requests when there are any). It is a plain link to `/inbox`, the same inbox page. The More menu entry "Guest inbox" shows the same number.
- **Why a separate number.** The admin page is protected by its password, not by Google sign-in, so it cannot read `inbox_*` (server-only). `inboxStatsOnWrite` keeps `globals/inboxStats` = `{needsReply, cancelRequests, updatedAt}` up to date (two numbers, no guest text; the `globals` collection is readable by the admin page like the other admin settings). `inboxAiRun` also refreshes it every minute so a missed trigger heals itself. Same rule as the inbox list: not done, the guest wrote last (or a cancellation request), and the conversation has chat messages or a cancellation request.
- **Sign-in.** Opening the inbox still uses the owner Google sign-in. The page now asks the browser to keep that sign-in (`browserLocalPersistence`), so you are not asked again on the same phone or computer unless you sign out or clear the browser data. On an iPhone, Safari can forget sites that are not opened for about a week; opening the inbox from the admin (and adding the admin to the Home Screen) avoids that.
- **Undo:** `git revert` the commit, delete `inboxStatsOnWrite` (`firebase functions:delete inboxStatsOnWrite --region europe-west1 --project sleepy-5c962`), or restore from tag `inbox-admin-entry-before`. The `globals/inboxStats` document can stay.

## Update: alerts (push) for the Booking.com inbox

**Who the old push list belongs to.** `push_subscriptions` (used by `pushNotifications.js`) is a list of every phone that ever unlocked the admin page with the shared admin password and tapped Notifications. It has no owner or name on its entries (3 phones today, all iPhones). `sendPushToAll` sends to every one of them. So guest messages must **not** use it: any member of staff who knows the admin password could have a phone on it.

**The safe way (used).** Guest alerts go to a separate server-only list, `inbox_push_devices`. A phone is added only by the owner-only callable `inboxAlerts`, which checks the verified Google sign-in of nikavibliani@gmail.com. The button is on the inbox page ("Turn on alerts"), which is itself behind that sign-in. Same Web Push system and VAPID keys as before; nothing in `pushNotifications.js` or `push_subscriptions` was changed. No Firestore rules change is needed (`inbox_*` is already server-only).

- `inboxPushOnMessage`: a guest chat message sends **one push per burst**. The first message pushes; every following guest message restarts the quiet time, and the next push only comes after 3 minutes without a guest message (`pushLastGuestAt` on the conversation). Word-by-word messages give one push.
- Text: title = guest name, body = listing and the first line of the message (about 90 characters). Tapping opens that conversation (`/inbox#c/<booking number>`); `sw.js` now opens or navigates the inbox for these.
- `inboxPushOnConversation`: a new or changed cancellation request sends a push "Cancellation request" with the deadline (Tbilisi time). Nothing older than 6 hours.
- No push for: hidden emails, check-in time requests (not chat messages), my own replies, messages older than an hour.
- Switch: Admin, More, "Booking.com message alerts" (`globals/config.bookingAlertsEnabled`, default on). Turning it off stops all inbox alerts; phones stay registered.
- Turning alerts off on one phone: the same inbox button ("Alerts on"). A phone that stops answering is removed automatically.
- Needs the Maxela app opened from the iPhone Home Screen icon (iOS only allows Web Push there).
- Functions: `inboxPushOnMessage`, `inboxPushOnConversation`, `inboxAlerts`. Secrets: the existing `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`.
- **Undo:** switch off in the admin (instant), or `firebase functions:delete inboxPushOnMessage inboxPushOnConversation inboxAlerts --region europe-west1 --project sleepy-5c962`, `git revert` the commit, or restore from tag `inbox-push-before`. The `inbox_push_devices` documents can stay.

### Change: alerts also go to the admin phones

You confirmed that the 3 iPhones in `push_subscriptions` are yours and your team's. Booking.com guest-message alerts and cancellation alerts now go to **every device in `push_subscriptions` and every device in `inbox_push_devices`**, once per phone: devices are de-duplicated by their push address, so a phone on both lists gets one alert. A phone that answers 404/410 is removed from the list(s) it is on (as `pushNotifications.js` already does). The burst rule, the alert text and the admin switch ("Booking.com message alerts") are unchanged. Registering a phone from the inbox page is now optional (it is only needed for a phone that is not on the admin list).
Note: anyone who unlocks the admin with the shared password and turns on notifications now also gets Booking.com guest text. Remove a phone from `push_subscriptions` to stop that.
Undo: `git revert` the commit and redeploy `inboxPushOnMessage` and `inboxPushOnConversation` (this goes back to `inbox_push_devices` only), or restore from tag `inbox-push-all-before`.

## Update: inbox access for Nutsa

- **One list.** `pipeline-functions/lib/inboxAccess.js` (`INBOX_USERS`: email and the name shown as "sent by") is the only list in the functions. The callables `inboxSendReply`, `inboxCheckinLink`, `inboxDraftDiscard` and `inboxAlerts` all use it. To add or remove a person: edit that list, edit `shared/inbox-auth.js` (the sign-in screen; a unit test fails if the two differ), paste the rules below with the email added, and redeploy those four functions.
- **Same access as the owner:** read conversations and the "Check this" list, reply, use AI drafts (Send, Edit, Discard), mark Done, turn on alerts. Pricing and every other owner-only page stay Nika only: `isOwner()` and `shared/owner-auth.js` were not changed.
- **Who sent a reply.** Every reply now stores `sentBy` (email) and `sentByName` on the outbox item and on the message; our reply bubbles show the name ("10:15 · Nutsa · Sent"). Older replies have no name.
- **Alerts.** A phone registered from the inbox page records whose it is. The 3 admin phones in `push_subscriptions` still get every alert.
- **Firestore rules to paste** (Firebase console, Firestore, Rules, Publish). Changes against the live rules: a new `isInboxUser()` function and the inbox rules use it instead of `isOwner()`. Tested without deploying (63 allow/deny cases: both people, a stranger, an unverified email, anonymous; pricing, WhatsApp, raw emails, outbox and push devices stay closed):

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function isOwner() {
      return request.auth != null
        && request.auth.token.email_verified == true
        && request.auth.token.email == 'nikavibliani@gmail.com';
    }
    // People who run the Booking.com guest inbox (verified Google email). Pricing stays isOwner() only.
    function isInboxUser() {
      return request.auth != null
        && request.auth.token.email_verified == true
        && request.auth.token.email in ['nikavibliani@gmail.com', 'nutsamargiani@gmail.com'];
    }
    function ownerOnly(c) { return c.matches('pricing_.*'); }
    function serverOnly(c) { return c.matches('whatsapp_.*') || c.matches('inbox_.*'); }

    // Guest inbox: inbox users may read, and may change only done / doneAt on a conversation.
    // Everything else in inbox_* (raw emails, creating or deleting) stays server-only.
    match /inbox_conversations/{conv} {
      allow read: if isInboxUser();
      allow update: if isInboxUser()
        && request.resource.data.diff(resource.data).affectedKeys().hasOnly(['done', 'doneAt']);
      match /messages/{msg} {
        allow read: if isInboxUser();
      }
    }
    match /inbox_review/{item} {
      allow read: if isInboxUser();
    }

    match /{col}/{doc=**} {
      allow read, write: if !serverOnly(col) && (!ownerOnly(col) || isOwner());
    }
  }
}
```

- **Until the rules are published, Nutsa gets "permission-denied" in the inbox** (the functions already accept her). Nika is not affected either way.
- **Undo:** put the old rules back (the owner-only version is in the section "Step 3" above), `git revert` the commit, redeploy the four callables, or restore from tag `inbox-access-before`.

## Update: a lighter Gmail script and the "script stopped" alert

- **Found while checking the run time:** the script's loop never ended by itself. It kept searching Gmail until its 4.5 minute time budget ran out (about 500 searches per run in a simulation). That is what made the server see the script only every 5 minutes, and it would have used far more than the 90 minutes of trigger time a free Gmail account gets per day. Fixed: the loop stops once it has looked at everything up to one minute ago.
- **Idle gate:** each minute the script compares the mailbox history id (Advanced Gmail service) with the last complete check; unchanged means do nothing, with a full read at least every 10 minutes. No Gmail service or an error means a full check every run (as before). An incomplete run never records the id, so the next minute tries again.
- **Backup reply pull** about every 5th minute (time based, so it also works if the trigger interval changes).
- **Heartbeat:** `inboxOutbox` saves `inbox_meta/script_heartbeat` on each pull that does not come from the web app. `inboxScriptWatch` (every minute, new function) pushes "Booking.com Gmail script has stopped" to all phones (both lists, once per phone) after 15 minutes without a call, repeats every 3 hours, and sends "Booking.com Gmail script is back". It is a health alert and is not stopped by the "Booking.com message alerts" switch. Not built, as you asked: the 24 hour no-email alert.
- **Expected daily trigger time after the fix:** idle minutes about 0.3 to 0.5 s, a full read every 10 minutes, a reply pull every 5 minutes: roughly 15 to 20 minutes a day (mock numbers, check Executions).
- **Undo:** put the previous `Code.gs` and `appsscript.json` back from tag `inbox-gmail-light-before` (`git show inbox-gmail-light-before:apps-script/booking-inbox/Code.gs`), delete `inboxScriptWatch`, redeploy `inboxOutbox`, or `git revert` the commit.

## Update: the Gmail daily limit (19 Oct) and the Gmail API

Every `processNew` run failed with "Service invoked too many times for one day: gmail" (at the GmailApp search). Cause: the old loop (fixed in step 4c) searched Gmail about 500 times per run all day and used up the daily GmailApp limit; the new script was only the first one to be stopped by it. A rollback to the previous files would fail the same way until the limit resets. Last saved Booking.com email: 16:12 Tbilisi time.
Fix: `Code.gs` reads and sends mail through the Gmail API (Advanced Gmail service) instead of GmailApp (details in `apps-script/booking-inbox/README.md`). Nothing is lost: the script's cursor did not advance while it failed.
Note: the "script stopped" alert only notices when the script stops calling the server; it does not notice a script that runs but fails to read Gmail (this case). A check "no new email saved for N hours" would. Not built.
Undo: `git revert` the commit and paste the previous `Code.gs` (tag `inbox-gmail-api-before`) once the daily limit has reset.

## Update: "Could not decode string" (19 Oct)

The first Gmail API version of `Code.gs` failed in `partText_`: the Advanced Gmail service returned the body data as a byte array, not text, so the base64 decode failed. Fixed: `dataBytes_` accepts a byte array or web-safe base64 (with or without padding); an unreadable part is skipped and logged, an unreadable message is saved with an empty body (it lands in the "check this" pile), an unloadable message is skipped, and a broken encoded header word no longer matters for the reply-address check. Mock-tested (byte arrays, unpadded web-safe text, garbage, attachment data, unreadable messages).
Undo: previous `Code.gs` from tag `inbox-gmail-decode-before`.

## Update: alert when no Booking.com email has been saved for 12 hours

`inboxScriptWatch` (the function that already watches the script every minute) also looks at the time the newest email was saved in `inbox_raw_emails`. No new email for **12 hours**: one push to all phones (both lists, once per phone): "No Booking.com email saved for 12 hours", with the time of the last one. While it stays quiet it repeats every 6 hours ("Still no Booking.com email saved"), and it sends "Booking.com emails are being saved again" when one arrives. State: `inbox_meta/email_watch`. Like the script alert it is a health alert and is not stopped by the "Booking.com message alerts" switch.
This catches a script that runs but cannot read Gmail (the 19 Oct case), which the heartbeat alone does not. Possible false alarm: a genuinely quiet night. At about 4 Booking.com emails a day, 12 hours without any is uncommon but can happen; the threshold is `EMAIL_STALE_MS` in `pipeline-functions/lib/inboxScriptWatch.js`.
Undo: restore from tag `inbox-email-watch-before` and redeploy `inboxScriptWatch`, or `git revert` the commit.

## Update: automatic sending (Off / Drafts / Automatic)

- **Mode.** Admin, More, "Booking.com AI": **Off** (no drafts, no replies), **Drafts** (you tap Send) or **Automatic**. Stored in `globals/config.bookingAiMode`; the old on/off field `bookingAiDraftsEnabled` is kept in step (Off = false). If `bookingAiMode` is missing, the old field decides.
- **Automatic.** After the usual wait (60 seconds, at most 4 minutes), a normal draft that passed EVERY existing check (no codes, links only app.maxelaapartments.com, no phone, email, WhatsApp or direct-booking offer, Shartava knowledge only) is queued through the same reply path as a person's Send (`queueReplyWrites`), with `sentBy: "ai"`, `sentByName: "AI"`. Bubbles show "AI · Sent". The Gmail script web app is poked so it goes out within seconds.
- **Never sent automatically (it stays a draft or a note):** "Needs you" notes, "Already answered on WhatsApp", anything the checks rejected, owner topics (refund, payment, discount, date change, early check-in, late check-out, complaints), a cancelled reservation, and anything within 30 minutes after a person (you or Nutsa, not the assistant) replied in that conversation. A draft held back for the last two reasons shows "Not sent automatically: <reason>".
- **Final check.** The last check (the newest message is still the guest's burst message, and nobody replied) and the queueing of the reply happen in the same database transaction, and the reply id is `ai-<message id>`, so a burst can never be sent twice.
- **Limits unchanged:** 6 per conversation per hour, 60 a day (counted before the model is asked).
- **Alerts to all phones:** after an automatic send "AI answered <guest>" with the first line of the reply; for a "Needs you" note "<guest> needs you" with the reason. The guest-message alert keeps its burst rule, so a burst gives one alert for the guest and one for the AI answer. The "Booking.com message alerts" switch controls all of them.
- **Undo / back to Drafts:** Admin, More, Booking.com AI, **Drafts** (instant). Code: `git revert`, or tag `inbox-auto-before` (redeploy `inboxSendReply`, `inboxAiRun`, `inboxPushOnMessage`, `inboxPushOnConversation`).

## Update: check-in time requests, handled by rule

- **What happens.** When a "I want to request check-in at ..." email is saved, the conversation gets `checkinRequest`. `inboxCheckinTrigger` waits 2 minutes (Booking.com's own automatic answer may arrive in that time; then we stay quiet), then `inboxAiRun` handles it by the **start** of the requested range:
  - 15:00 to 23:59: "Yes, check-in at <time> is fine. You'll get the instructions after you fill in the check-in form." Button: **Accept in Booking.com** (`option=confirm`).
  - 06:00 to 14:59: "Check-in starts at 15:00. If your apartment is ready earlier, we'll message you after you fill in the check-in form." Button: **Answer in Booking.com** (`option=availability`).
  - 00:00 to 05:59: "Check-in starts at 15:00. If you mean <time> during the night after your arrival day, that's no problem: it's self check-in, so you can arrive any time." Button: **Decline in Booking.com** (`option=reject`).
  - A time that cannot be read (or a missing request email) sends nothing and gives a "Needs you" note.
- **Modes.** Off: nothing. Drafts: shown as a draft with the one-tap link. Automatic: sent through the normal reply path with `sentBy "AI"`, unless the reservation is cancelled or one of us replied in the last 30 minutes (then a draft with the reason). Never twice (`ci-<request time>` outbox id, and a repeat of the same time within 6 hours is ignored).
- **Language.** The English text is fixed. If the guest's earlier chat messages are in another language, a model call translates the same words, and the translation is only used if it keeps every time and adds no number, link, phone, email or exclamation mark; otherwise English only is sent. No earlier messages, no translation call. A translation call counts toward the daily 60.
- **One-tap link.** The Extranet request page with the right `option` (from the saved request email) is saved on the conversation (`checkinAction`) and shown in the chat next to the grey request line and in the draft box. The Extranet may still ask you to sign in and confirm; the link is the same one as the button in the Booking.com email.
- **Alert.** "<guest> asked check-in <time>" / "Message sent. Tap to accept (decline, answer) in Booking.com"; tapping opens the Extranet link (`sw.js` now opens full web addresses as they are). In Drafts mode: "Draft ready in the inbox". Off or auto-confirmed by Booking.com: no alert.
- **Visible now.** A conversation with a check-in request is listed (before, it was hidden), with the grey request line, our message and, until you tap Done, in "Needs reply" (the official answer in Booking.com is still open). The admin count includes it.
- **Known limits.** A second request after Booking.com auto-confirmed an earlier one is not handled (the saved flag stays "auto-confirmed"). Booking.com's own answer can only be given in the Extranet; the message we send is only an email to the chat.
- **Undo:** Admin, More, Booking.com AI: Drafts or Off. Code: `git revert`, or tag `inbox-checkin-before` (redeploy `inboxAiRun`, `inboxPushOnConversation`, delete `inboxCheckinTrigger`).

## Update: fewer "Needs you" cases (Part D)

How a guest burst is decided (`lib/inboxTopics.js`, used in `controllers/inboxDraft.js`):
1. **Topics from two sources, combined.** The model names the topics in ANY language: its answer starts with a line `TOPICS: ...` from a fixed list (early_checkin, payment_how, payment_other, cancellation, date_change, refund, discount, complaint, late_checkout, other). An English keyword list is the safety net. The union decides; no TOPICS line means the answer is not trusted ("Needs you: could not tell what the guest is asking about").
2. **Still "Needs you", nothing sent:** refunds, discounts or prices, complaints, late check-out, payment questions beyond how or where to pay (amounts, cards, deposits, taxes, invoices, paying on arrival), non-Shartava (Freedom Square, Orbeliani, ...), a model that is unsure. English hard keywords stop it before any model call; other languages are caught by the model's topics. A hard topic wins over everything else in the same burst.
3. **Early check-in** (in chat messages): answered automatically with the meaning of "Check-in starts at 15:00. If your apartment is ready earlier, we'll message you after you fill in the check-in form." The model may adapt the words and language; the answer is only sent if it says 15:00 and names no other time (no promise of an earlier time).
4. **Payment, only how or where to pay:** answered automatically: payment for the reservation is handled by Booking.com. No amounts, currencies, cards, deposits or fees allowed in the answer.
5. **Cancellation and date change:** a holding reply is sent automatically: "Thank you, we'll forward this to our team and get back to you soon." (English, plus the same words translated when the guest writes another language; a translation that adds or changes anything is dropped). It promises nothing. The conversation goes back to "Needs reply" with a note, and all phones get "<guest> needs you" with "cancellation request" or "date change request" (the usual "AI answered" alert is not sent for these). A second holding reply is not sent within 2 hours (only the note). In Drafts mode the holding reply is a draft with "Needs you: ..."; a cancelled reservation or a reply by one of us in the last 30 minutes also keeps it a draft. The separate Booking.com "cancel for free" request (with deadline) is unchanged.
6. **Fixed along the way:** the plain name "Booking.com" (or "Expedia.com") in a reply was treated as a link and removed or refused; it is now allowed as a name (a real link is still refused).
- **Live check with the real model** (fake conversations, Drafts mode, alerts off): early check-in (English, Russian) got the 15:00 answer, "how do I pay" (Spanish) got the Booking.com answer, a deposit question (German) and a refund (Russian) gave "Needs you", a cancellation (Turkish) and a date change (French) got the translated holding reply with the needs-you note. A question the knowledge does not cover (hair dryer, French) stays "Needs you". The fake conversations `99999900xx` are left (hidden, done).
- **Undo:** Admin, More, Booking.com AI: Drafts or Off. Code: `git revert`, or tag `inbox-topics-before` (redeploy `inboxAiRun`, `inboxPushOnMessage`, `inboxPushOnConversation`).

## Update: Step 1 of the improvement plan, "a clear inbox" (see docs/INBOX_IMPROVEMENT_PLAN.md)

- **Rows say what to do.** One action tag per row instead of the always-on "Booking.com" tag: Answer this, AI draft: check it, AI answered, Accept/Decline/Answer check-in time in Booking.com, Cancellation: answer in Booking.com by <time>, Not sent: try again, Not sure it arrived, Guest said thanks, Answered on WhatsApp (was shown as "Needs you"), Needs you: <reason>, Booking was cancelled. "Needs reply" is sorted by how long the guest has waited (oldest first) with "waiting 2 h" on the row. Server fields: `waitingSince` (first unanswered guest message; set by `inboxSort`, cleared by a sent reply, restored if the reply fails, never touched by drafts or notes), `lastSendStatus` / `lastSendAt` / `lastSendFailReason` / `lastSendOutboxId` (set when a reply is queued, updated by the Gmail script's report) and `lastReplyBy`.
- **Cards at the top of the chat.** Check-in request: what was asked, what we did, what is still to do, with a full-size Accept / Decline / Answer in Booking.com button; "Booking.com already confirmed this, nothing to do" (no button, no `inboxCheckinLink` call) when it auto-confirmed. Cancellation request: full-size "Answer in Booking.com" button (the reservation page of the Extranet); for a cancelled booking: "Booking was cancelled", and it no longer counts as needing a reply (page and admin count). "Done" is now an outlined button, with "Moved to Done. Undo" for 5 seconds and back to the list on a phone.
- **Delivery.** Sending... / Sent to Booking.com / Not sent + a 44 px Try again / Not sure it arrived + Open in Booking.com.
- **Thanks.** A guest who only says thanks or ok: the conversation moves to Done by itself with "Guest said thanks, nothing to answer" (`closedAsThanksAt`), unless a cancellation or check-in request is open or the last reply did not go out. A new guest message reopens it.
- **"Other Booking.com emails"** (was "Check this"): plain reasons, a "Handled" button (new callable `inboxReviewHandled`, sets `resolved`), the count only counts unhandled ones, an error shows instead of "Loading...".
- **Fixes:** list scroll resets when the tab changes; check-in-only conversations use the request time for the time and sorting; the draft Send is disabled (with the reason) when the conversation has no guest reply address; the admin count also reacts to check-in request changes; the admin alerts text is up to date.
- **Undo:** `git revert` the commit and redeploy `inboxSort`, `inboxSendReply`, `inboxOutbox`, `inboxAiRun`, `inboxStatsOnWrite` (delete `inboxReviewHandled`), or restore from tag `inbox-clear-before`.

## Morning report: Steps 3 to 6 of the improvement plan (done overnight, 21 Oct 2026)

All four steps are pushed to main (the website deploys by itself) and the new or changed Cloud Functions are deployed by name.
Tested with fake data at 390 px and 1366 px: the admin (More menu, Inbox tab, Stay card) and the inbox. NOT tested on a real iPhone,
and not against the real Firebase data. Nothing was sent to a real guest. The AI's way of deciding what to say and when to send is unchanged
(the only new things that can stop or add to it are things you switch on: Pause AI, Stop, approved answers, the sign line).

### What is live, what is switched off

| Step | Live now | Switched off, waiting for you |
|---|---|---|
| 3 Inside the admin | The Inbox tab in the admin, the "Inbox opens" setting, embed mode of the inbox, "Sign in to the inbox" button, alert taps and the app icon badge. Everything works the old way because the setting is "As its own page". | The Inbox tab itself (setting "Inside the admin"), and the sign-in on our own domain (flag `USE_OWN_AUTH_DOMAIN = false` in inbox.html). |
| 4 Two people | The check before sending ("Nutsa replied 1 min ago", Send mine anyway / Edit / Discard), the initial of who replied last on each row, and 20-second alerts that skip when one of us already replied or opened the chat. | "Nutsa is viewing / typing" and the viewing tag on rows: they need the Firestore rule below, and stay hidden (no errors) until you paste it. |
| 5 Watching the AI | AI view (today's AI replies, held drafts, Needs you, questions it could not answer, test box), Looks good / Wrong, "AI will reply in 0:45" with Stop and Write it myself, Pause AI (24 hours / until check-out), the AI knowledge page, the safety scan with the "Check this AI reply" alert, the evening summary function, two new settings in More. | Nothing the AI knows changes until you approve a suggestion. "AI answer alerts" is on "Every answer", "Sign AI replies" is Off, the evening summary only sends if you choose "Only when it needs you". |
| 6 Connected | Booking details panel in the chat, "+ Request" on guest messages, "Open booking" in the chat, "Booking.com chat" button on Booking.com bookings in the admin, the arriving-today line on the Stay screen's Inbox card. | Nothing. (All of it uses Cloud Functions, so no Firestore rules were needed.) |

### Console steps and rules for you

1. **Firestore rules for "who is viewing / typing" (Step 4).** Paste this inside `match /databases/{database}/documents { ... }` in the Firebase console, Firestore, Rules, then Publish.
   Until you do, the inbox quietly hides that feature (the code turns it off the first time Firestore says no).

```
match /inbox_presence/{conv} {
  function isInboxUser() {
    return request.auth != null && request.auth.token.email_verified == true
      && request.auth.token.email in ['nikavibliani@gmail.com', 'nutsamargiani@gmail.com'];
  }
  function myKey() {
    return request.auth.token.email == 'nikavibliani@gmail.com' ? 'nika' : 'nutsa';
  }
  allow read: if isInboxUser();
  allow create: if isInboxUser() && request.resource.data.keys().hasOnly([myKey()]);
  allow update: if isInboxUser() && request.resource.data.diff(resource.data).affectedKeys().hasOnly([myKey()]);
  allow delete: if false;
}
```
   (Each of you can only write your own entry. If your rules already have an `isInboxUser` helper, delete the first function above.)
   The 20-second alert check also looks at this record, so it only fully works after you paste the rules; the "already replied" half works now.

2. **Sign-in on our own domain (Step 3, part 2). Do these BEFORE changing the flag to `true`:**
   - Firebase console, Authentication, Settings, Authorized domains: make sure `app.maxelaapartments.com` is on the list.
   - Google Cloud console, APIs and Services, Credentials, the Web client used by Firebase sign-in: add `https://app.maxelaapartments.com/__/auth/handler` under Authorized redirect URIs, and `https://app.maxelaapartments.com` under Authorized JavaScript origins.
   - Then set `USE_OWN_AUTH_DOMAIN = true` in inbox.html (one line, near the top of the script), push, and test the sign-in on the iPhone Home Screen app. If it fails, set it back to false.
   - firebase.json was not touched (Hosting serves /__/auth/ on our own domain by itself).

3. **To make the Inbox tab the default** (after the iPhone test): in checkin-admin.html change `INBOX_OPEN_DEFAULT='page'` to `'tab'`. Until then each phone chooses in More, "Inbox opens".

### What to test on your phone (in this order)

1. Open the admin. Everything should look and work exactly as before (More menu has new items: "Inbox opens", "AI answer alerts", "Sign AI replies").
2. More, Inbox opens, tap "Inside the admin". The page reloads. Open the Inbox from the Stay card or More. Check the tab bar is there, open a chat, tap the reply box: the tab bar hides and the box sits above the keyboard, and the page behind does not scroll. Tap the Inbox tab or Back to leave. If the keyboard misbehaves, set "As its own page" again (instant undo, per phone).
3. In the tab: if you are not signed in you see "Sign in to the inbox". Tap it, sign in, you land back in the Inbox tab.
4. Tap a guest alert (have a test guest message arrive or use the admin's alert test): with the tab setting on it should open the Inbox tab on that chat. Check the app icon shows a number (needs notifications allowed for the Home Screen app).
5. Two phones (you and Nutsa) in the same chat: one types and sends; the other should get "Nika replied 1 min ago ..." when sending with the old screen, with Send mine anyway / Edit / Discard. Rows show "Nu" or "N" for who replied last.
6. AI view (link under the list, "AI view"): mark one AI reply "Looks good" and one "Wrong" (type what it should have said). Open "AI knowledge", approve or reject the suggestion. Try the test box. Pause AI in a chat (the "Pause AI" button, in the "..." menu while typing).
7. A chat: tap "Booking details" (dates, form, door access, cleaning, earlier stays), tap "+ Request" on a guest message (it should appear in the admin Requests list), tap "Open booking".
8. Admin Stay: open a Booking.com booking, tap "Booking.com chat". The Inbox card on Stay shows "N arriving today are waiting for a reply" when it applies.

### Things I decided or could not do (read these)

- **"Why" line under AI replies (Step 5, part 1): done differently.** Asking the model to name the knowledge sections it used would change what the AI is asked to output. I did not touch that. The line shows the topic the model already names ("Topic: parking, check in"). If you want the real section names, that is a separate, careful change.
- **Setting "Inbox opens" is per phone** (saved in that browser), not for everyone. That is why it is safe to test on your iPhone only.
- **App icon badge:** set when the admin or inbox page is open. It is not updated while the app is closed (the alert itself does not know the count). Opening the app sets it right.
- **Alerts for the AI go to everyone** (all admin phones) as before. "Don't alert the other person" is done by not alerting at all when one of you replied or opened the chat during the 20 seconds.
- **The 20-second wait** means a guest-message alert now arrives about 20 seconds later than before.
- **Presence** (viewing/typing) is written by the inbox page straight to Firestore, so it needs the rule above. Everything else in these steps goes through Cloud Functions and needs no rules.
- **Wrong replies and corrections** contain guest text; they are stored in Firestore (`inbox_ai_knowledge`), private, server-only. Nothing from them is in the repo.
- **AI knowledge changes:** an approved answer is added as an extra section to the Booking.com prompt only. WhatsApp and the copied knowledge files are not touched. Switch an entry off, or reject it, and the AI stops using it.
- **Booking panel details:** door access uses the flags the guest unlock function already stores (read only); "earlier stays" matches the guest's name, so two different people with the same name could show up together. The "Booking.com chat" button only shows for reservations whose source says Booking and that have a booking id.
- **Evening summary** is deployed (`inboxAiEveningSummary`, 21:00 Tbilisi) and does nothing unless "AI answer alerts" is on "Only when it needs you".
- **GitNexus index** is stale; I did not rebuild it.

### How to undo each step

- **Step 3:** More, Inbox opens, "As its own page" (instant, per phone). Code: `git revert` the Step 3 commits, or restore tag `inbox-in-admin-before` (files: checkin-admin.html, inbox.html, shared/inbox-auth.js, sw.js). No functions were changed.
- **Step 4:** `git revert` the Step 4 commits or use tag `inbox-team-before`, then redeploy `inboxSendReply` and `inboxPushOnMessage` from that state: `firebase deploy --only functions:pipeline:inboxSendReply,functions:pipeline:inboxPushOnMessage --project sleepy-5c962`. The rule above can stay or be removed.
- **Step 5:** tag `inbox-ai-oversight-before`. Redeploy `inboxAiRun` and `inboxPushOnMessage` from that state and delete the new functions: `firebase functions:delete inboxAiAction inboxAiKnowledge inboxAiEveningSummary --region europe-west1 --project sleepy-5c962` (use the exact names Firebase shows). To stop the AI using an approved answer without any code change: AI knowledge, Switch off. Pause AI per chat: Resume AI.
- **Step 6:** tag `inbox-connected-before`. Redeploy `inboxStatsOnWrite` and `inboxAiRun`, delete `inboxBookingPanel` and `inboxRequestCreate`. A request made by "+ Request" is a normal item in the Requests list: decline or clear it there.

### Commits and tags (all pushed)

Tags: `inbox-in-admin-before`, `inbox-team-before`, `inbox-ai-oversight-before`, `inbox-connected-before`.
Functions deployed by name: Step 4: `inboxSendReply`, `inboxPushOnMessage`. Step 5: `inboxAiRun`, `inboxPushOnMessage`, new `inboxAiAction`, `inboxAiKnowledge`, `inboxAiEveningSummary`. Step 6: `inboxBookingPanel`, `inboxRequestCreate` (new), `inboxStatsOnWrite`, `inboxAiRun`.
Server tests: 160 inbox tests pass.

## Update: fixes (21 Oct 2026)

- **Part 0, "No Booking.com email saved":** not our code. The Gmail script runs and the save function answers 200; the script found no newer Booking.com mail after 21 Oct 02:35 (Tbilisi). Three hotels (1738886, 3156470, 8189626; Maxela, Superior, Freedom Square, probably) had their contact email changed to ltd.premiumapartments@gmail.com on 19 Oct and have produced no email since. Check Gmail for `from:booking.com newer_than:2d`; if it is empty, check Extranet, Contact persons, that the address is verified and reservations/guest messages are ticked for each of those hotels.
- **Part 1, one settings page:** the inbox page `#settings` ("Booking.com inbox": AI mode, AI answer alerts, Sign AI replies, message alerts, alerts on this phone, Inbox opens, AI tools). The admin More menu has one entry, "Booking.com inbox", that opens it (inside the Inbox tab or on its own page). Settings are saved by the callable `inboxSettingsSave`.
- **Part 2, all listings:** a test proves all five listing names (and a new one) are saved as chats under their own name; the listing filter has a "Listing not named" choice so nothing is hidden. Freedom Square still gets "AI needs you".
- **Part 3:** the AI view is gone from the main screen. Settings, AI tools has AI review, AI knowledge and the test box. The "AI answered" row tag stays.
- **Undo:** tag `inbox-fixes-before` (redeploy nothing; delete `inboxSettingsSave` if wanted).
