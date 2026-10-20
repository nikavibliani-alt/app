# Guest inbox improvement plan

Written 20 Oct 2026 for the Booking.com guest inbox (inbox.html, the inbox Cloud Functions, the Gmail script).
Based on research into Hostaway, Guesty, Hospitable, Front, Intercom and Help Scout, and a hands-on test of the
inbox code at commit 59ce3dd with made-up data.

## How to use this plan (for Claude Code)

- Do ONLY the step Nika names ("do Step 1"). Never start the next step on your own.
- Before each step: create and push the restore tag named in that step. One commit per part, push to main.
- Deploy only the Cloud Functions you changed or added, by name, and confirm nothing else changed.
- Never deploy Firestore rules. If a step needs a rules change, give Nika the full rules text to paste himself.
- Never put real guest data (names, messages, emails, booking numbers) in the repo. It is public.
  Test with fake data, at 390 px and 1366 px wide.
- At the end of each step, report in plain words: what changed, what to test on the phone, how to undo.
- Applies to every step (do not touch): whatsapp-functions, minihotel_reservation_sync.py, pricing pages and
  logic, cleaner.html and housekeeping code, guest unlock logic (shared/guest-unlock.js,
  pipeline-functions/lib/guest-unlock.js), the guest check-in page (checkin-guest.html), Firestore rules.

## Decisions (made by Nika)

1. **The inbox becomes a tab inside the admin** that shows the inbox in place, with the tab bar and badge
   on screen. Include a switch back to the old separate page in case the iPhone keyboard misbehaves (Step 3).
2. **AI answer alerts:** keep an alert for every AI answer for now. Add a setting so Nika can later switch to
   "only when it needs you + evening summary" (Step 5).
3. **Admin sign-in:** the admin's shared password will be replaced by Google sign-in for Nika and Nutsa.
   That is a separate project in its own chat, NOT part of these steps.
4. **No AI sign-off** on replies to guests for now. Add the optional setting, default OFF (Step 5).

## What a normal user trips over today (findings behind the steps)

1. "Needs reply" doesn't say why. All rows look the same, but they mean different jobs: answer, check an AI
   draft, accept a check-in time in Booking.com, answer a cancellation, retry a failed reply, or ignore a
   "thanks". A row can read "AI: Yes, check-in at 16:00 is fine" while the Booking.com acceptance is still open.
2. The check-in request's real action ("Accept in Booking.com") is a small grey link at the bottom of the chat,
   while the big black button on the same screen is "Done".
3. What the AI did is hard to see: AI replies look like ours apart from a small grey "AI", and an automatic
   reply quietly moves the chat to Done (controllers/inboxReply.js ~80-82).
4. Delivery is unclear: "Waiting", "Sending", "Unknown"; a failed reply doesn't show in the list.
5. "Check this" is a dead end: no buttons, unclear reasons, and nothing ever sets resolved:true
   (only inboxSort.js ~111 writes resolved:false), so its count only grows.
6. Annoyances: two black Send buttons when an AI draft shows; "Done" is the most prominent button and has no
   undo; the header fills the phone screen while typing; no sign-out or "signed in as"; the admin's alert
   setting text is out of date (checkin-admin.html ~2915; inboxPush sends to push_subscriptions too).
7. It feels like another app: different font, colours and button sizes from the admin, no tab bar, and the
   way back is a small "Admin" link that reloads the whole admin.
8. Why it opens "as a full window" on iPhone: every Inbox entry in the admin is a plain link to another page
   (DESTINATIONS entry href:'/inbox' ~1462, Stay card <a href="/inbox"> ~787), and Google sign-in goes
   through sleepy-5c962.firebaseapp.com (inbox.html ~149), which iPhone shows in a Safari sheet.

## Step 1: a clear inbox

Restore tag: `inbox-clear-before`.

**Part 1: each row says what to do**
- Replace the always-on "Booking.com" tag on list rows with ONE action tag: "Answer this" / "AI draft: check
  it" / "AI answered" / "Accept check-in time in Booking.com" / "Cancellation: answer in Booking.com by
  <day time>" / "Not sent: try again" / "Guest said thanks" / "Answered on WhatsApp" / "Needs you: <reason>".
- Server: save the last reply's outcome on the conversation (e.g. lastSendStatus + lastSendAt, set by the
  outbox) so the list can show failures.
- Sort Needs reply by how long the guest has waited (first unanswered guest message), oldest first, and show
  "waiting 2 h" on the row. AI drafts and notes must not reset it; a sent reply does.

**Part 2: check-in and cancellation cards**
- Check-in request: a card at the TOP of the chat (like the cancellation warning): "Guest asks to check in
  16:00 to 18:00. Our message was sent. Still to do: accept it in Booking.com", with a full-size button
  "Accept in Booking.com" (or Decline / Answer, per the existing rule). Remove the small grey link at the
  bottom. If Booking.com auto-confirmed: "Booking.com already confirmed this, nothing to do", no button, and
  don't call inboxCheckinLink (today it is called for every request, inbox.html ~416-419).
- Cancellation warning: add a full-size button that opens that reservation's request page in Booking.com
  (the link from the email if there is one, otherwise the reservation page). When the reservation is
  CANCELLED, say "Booking was cancelled" and stop counting it as needing a reply.
- "Done" becomes a secondary (outlined) button so it is never the most obvious action.

**Part 3: clear delivery status**
- Our bubbles: "Sending..." (one word for waiting and sending), "Sent to Booking.com", "Not sent" with a
  44 px "Try again" button, and "Not sure it arrived" with an "Open in Booking.com" button.

**Part 4: small things that confuse**
- Guest only said thanks / ok (the AI already skips these): move the conversation to Done automatically and
  show a grey line "Guest said thanks, nothing to answer". A new guest message reopens it.
- Tapping Done: show "Moved to Done. Undo" for 5 seconds; on a phone go back to the list.
- "Check this": rename to "Other Booking.com emails"; plain reasons (e.g. "A guest asked a question before
  booking. Answer it in Booking.com"); an "Open in Booking.com" button where a link exists; a "Handled" button
  (small callable that sets resolved:true); the count shows only unhandled items; show an error if loading
  fails instead of "Loading..." forever (inbox.html ~641 swallows errors).
- Admin: fix the alerts setting text in checkin-admin.html (~2915). Alerts now go to all admin phones AND
  phones turned on in the inbox. Only this text line in the admin.

**Part 5: bugs**
- inbox.html ~343/350: reset the list scroll to the top when the tab changes (keep it only for live updates).
- inbox.html ~359: an already_answered draft must show "Answered on WhatsApp", not "Needs you".
- inbox.html ~218/355: use checkinRequest.at for the time and sorting of check-in-only conversations.
- inbox.html ~525-529: the draft Send must not try to send when there is no guest reply address; show why.
- pipeline-functions/lib/inboxStats.js ~25: count changes to checkinRequest too.

Also for this step: don't change the AI's rules or wording, or the Gmail script.

Test on the phone after: every Needs reply row says what to do; open a check-in request and a cancellation;
switch tabs after scrolling.

## Step 2: look and feel

Restore tag: `inbox-look-before`. Change only inbox.html and shared/inbox-*.js.

**Part 1: same look as the admin**
- Use the admin's font (Inter), colour tokens (:root in checkin-admin.html: background, ink, red, lines) and
  button sizes. Follow CLAUDE.md (no emojis, no blue, plain words).
- Tap targets at least 44 px (top links, tabs, header buttons, Try again); text at least 12 px; inputs 16 px so
  iPhone doesn't zoom.
- Laptop: cap the chat reading width at about 760 px.

**Part 2: AI clearly marked**
- AI replies get their own bubble style (e.g. outlined, with a small "AI assistant" label above), different
  from replies by Nika or Nutsa.
- Use one name everywhere: "AI assistant" (bubbles, drafts, notes, alert text in the inbox).
- One clear title per AI box: "AI draft, not sent yet" (reason it was held in small text under it), "AI needs
  you: <reason>" (no repeated "Needs you"), "Already answered on WhatsApp at <time>".
- Draft box button says "Send this reply" so it can't be confused with the composer's Send; the composer's
  Send is disabled while the box is empty.
- Show the current AI mode at the top of the inbox: "AI: Automatic / Drafts / Off" (read globals/config).
  Tapping it explains what it means and where to change it in the admin.

**Part 3: phone comfort**
- While typing on a phone, shrink the conversation header to one line (guest name, buttons in a "..." menu).
- Back from a chat uses history.back() when the previous page was the list.
- Rows: show the room the way the admin names it (e.g. "6-2") first, then the Booking.com listing name in
  smaller text; keep the listing filter.

**Part 4: search and account**
- A search box above the list: guest name, booking number and message text, on top of the current tab and
  listing filter.
- At the bottom of the list: "Signed in as Nika . Sign out". On the sign-in and "not allowed" screens, add
  "Back to admin".

Test on the phone after: the inbox looks like the admin; AI replies stand out; search a name and a booking number.

## Step 3: inside the admin

Restore tag: `inbox-in-admin-before`. Needs a test on Nika's real iPhone (Home Screen app) with the keyboard open.

**Part 1: inbox as an admin tab**
- In DESTINATIONS (checkin-admin.html), change the inbox entry from href:'/inbox' to a real tab ('inbox'):
  add a pane (#pane-inbox) that shows /inbox?embed=1 in a full-height frame. Create the frame on the first
  visit and keep it loaded. Add it to VALID_TABS / TAB_META; allow it as the landing tab.
- The Stay screen's Inbox card and More > Guest inbox call switchTab('inbox') instead of loading another page.
- inbox.html in embed mode: hide its own title row, the "Admin" link and the alerts button (the admin owns
  notifications), fill the frame, and tell the admin (postMessage) the current title ("Inbox" or the guest
  name) and when the composer is focused.
- iPhone keyboard: frame height = visible screen minus the tab bar; hide the admin tab bar while the composer
  has focus; the composer stays above the keyboard and the outer page doesn't scroll.
- A setting in Admin > More: "Inbox opens: inside the admin / as its own page" (default inside).
- Keep /inbox working on its own (alerts and bookmarks).
- Re-test the tab bar layout picker and the More menu.

**Part 2: sign-in that stays in the app**
- If the frame reports "not signed in", show a "Sign in to the inbox" button in the pane that opens /inbox
  full-page for sign-in and then returns to /checkin-admin?tab=inbox.
- Change the Firebase authDomain to app.maxelaapartments.com in inbox.html's own config ONLY (Firebase
  Hosting serves /__/auth/ on our own domain). Don't edit firebase.json, and leave the configs of the pricing
  pages, the guest check-in page and cleaner.html as they are. Use redirect sign-in on iPhone Home Screen apps.
  Give Nika the exact console steps (authorized domains, the OAuth redirect URI in Google Cloud).

**Part 3: alerts and badge**
- Tapping a guest alert opens /checkin-admin?tab=inbox&c=<booking number>; sw.js focuses an open admin window
  if there is one, otherwise opens one. The admin passes the conversation to the frame.
- App icon badge (iOS 16.4+, notification permission given): set it to the Needs reply count
  (navigator.setAppBadge) when the admin or inbox is open, and when an alert arrives; clear it at 0.

Test on the iPhone after: open the Inbox tab, open a chat, type a reply with the keyboard up, tap an alert.

## Step 4: two people, no double replies

Restore tag: `inbox-team-before`.

**Part 1: check before sending**
- When either of us taps Send, the server checks whether, since the composer was opened, a new guest message
  arrived or someone else (the other person or the AI) replied. If so, don't send. Show: "Nutsa replied 1 min
  ago: <first line>" (or "The guest wrote again") with "Send mine anyway", "Edit" and "Discard".
- Same check for "Send this reply" on AI drafts.

**Part 2: who is here**
- Show "Nutsa is viewing" / "Nutsa is typing" in the conversation and a small initial on the list row, from a
  presence record with a heartbeat that expires after about 60 seconds of no activity.
- On each row, show the initial of whoever replied last (N, Nu, AI).
- If presence needs a rule, give Nika the exact rules text (inbox users may write only their own presence).

**Part 3: fewer duplicate alerts**
- Guest-message alerts: wait about 20 seconds; skip the alert if either of us already opened that
  conversation in that time. Keep the existing burst rule.
- If one of us replies, don't alert the other person for that same guest message.

Test with two phones after: both open the same chat and type.

## Step 5: keep an eye on the AI and teach it

Restore tag: `inbox-ai-oversight-before`. Everything in the inbox (Google sign-in), not the password admin.

**Part 1: see what the AI did**
- An "AI" view in the inbox: today's AI replies, held drafts and "Needs you" notes, with a "To review (N)"
  count. Each AI reply has "Looks good" (marks it reviewed) and "Wrong".
- While the AI is waiting to answer (the existing 60-second wait), show it in the chat: "AI will reply in 0:45"
  with "Stop" (cancel for this burst) and "Write it myself".
- Under each AI reply, a small "why" line: which knowledge parts it used (e.g. "Used: Parking, Check-in time").
  Ask the model to return the section names it used; store them with the reply.
- "Pause AI for this guest" in the chat menu (24 hours / until check-out).

**Part 2: teach it (approval first)**
- "Wrong" asks: "What should it have said?" Save it as a correction suggestion (question, wrong reply, right
  answer, date, who). Nothing changes until approved.
- An "AI knowledge" page in the inbox: suggestions with Approve / Edit / Reject, and approved entries (each
  with on/off and last updated).
- Approved entries are added to the Booking.com AI's knowledge as an extra section after the WhatsApp copy
  (Booking.com only; don't change whatsapp-functions or the copied knowledge files).
- "Questions the AI couldn't answer": group recent "Needs you" notes and "no knowledge" cases by topic with
  counts, each with "Add an answer" (creates a suggestion).
- A test box: type a guest question, pick a listing, see the AI's reply and which parts it used. Nothing is sent.

**Part 3: safety nets and alerts**
- After every automatic AI send, scan it for things it must never say (money amounts, refund or discount
  promises, door/elevator/Wi-Fi codes, phone numbers, links other than app.maxelaapartments.com). If found:
  alert all phones "Check this AI reply" and mark it in the AI view.
- Alert setting in Admin > More: "AI answer alerts: every answer / only when it needs you + evening summary".
  Default: every answer. The evening summary (21:00 Tbilisi) says e.g. "AI answered 7 guests today, 2 need
  you" and opens the AI view.
- Optional setting, default OFF: "Sign AI replies" (a short line on the AI's first reply in a conversation).

Test on the phone after: open the AI view, mark one reply "Looks good" and one "Wrong", try the test box.

## Step 6: connect the chat to the rest of the admin

Restore tag: `inbox-connected-before`. Read-only use of existing data, except creating a request.

**Part 1: booking panel**
- In a conversation, a booking panel (side panel on a laptop; full screen on a phone when tapping the header):
  dates and nights, room, number of guests, reservation status, check-in form filled or not (checkin_guests
  matched to this reservation), door access unlocked or not (read the existing flags only), today's cleaning
  status of the room from the housekeeping data, previous stays of the same guest.
- Read only. Find where each fact lives and tell Nika; don't change how any of it is written. If reading any
  of it gives "permission denied", STOP and report: never edit or deploy Firestore rules to get around it.

**Part 2: links both ways**
- From the admin's Stay screen / booking details: a "Booking.com chat" link for Booking.com reservations that
  opens the inbox at that conversation (by booking number; "No messages yet" if none). The admin must not
  read inbox data to do this.
- In the chat header: "Open booking" that goes to that booking in the admin.

**Part 3: message to request**
- On a guest message, "+ Request" creates an item in the existing Requests list (service_requests), prefilled
  with room, guest and the message, and shows "Request created" with its status back in the chat. Use exactly
  the fields the guest page already writes (don't change checkin-guest.html or that format). A new request
  already triggers the admin's "New Request" alert; that's fine.

**Part 4: arrivals**
- On the Stay screen's Inbox card, one line when guests arriving today have unanswered messages: "2 arriving
  today are waiting for a reply" (numbers only, via the server-kept stats document; no guest names on the
  password admin).

Test on the phone after: open a chat for a guest arriving today and check the panel matches the admin.

## Later (separate projects, not steps here)

- One brain for WhatsApp and Booking.com (one timeline per guest; WhatsApp bot reads Booking.com chats).
  The plan is in docs/INBOX_PLAN.md, Part 3. Match guests by the phone from the check-in page: Booking.com
  stopped sharing guest phone numbers with channel managers on 28 Sep 2026.
- Airbnb in the same inbox.

## Sources

- Hostaway: https://support.hostaway.com/hc/en-us/articles/53703926823579-Hostaway-Inbox-Guest-Communication
- Hospitable: https://changelog.hospitable.com/78830-improved-inbox-experience ,
  https://help.hospitable.com/en/articles/12300032-guest-details-in-the-conversation-thread ,
  https://help.hospitable.com/en/articles/10977601-auto-reply-to-guest-messages-with-ai
- Guesty: https://help.guesty.com/hc/en-gb/articles/9369731011357-Viewing-your-Inbox-messages ,
  https://help.guesty.com/hc/en-gb/articles/34480030999581-Creating-tasks-from-guest-messages ,
  https://help.guesty.com/hc/en-gb/articles/34189330099229-Automating-responses-with-AutoReply
- Help Scout: https://docs.helpscout.com/article/99-traffic-cop ,
  https://docs.helpscout.com/article/11-understand-conversation-icons-and-colors
- Intercom: https://www.intercom.com/help/en/articles/6989006-prioritize-responding-to-customers-who-ve-been-waiting-longest
- Front: https://help.front.com/en/articles/2403 , https://help.front.com/en/articles/2174
- AirHost: https://intercom.help/airhost-one/en/articles/8660030-message-management-overview-of-message-management
- iGMS: https://help.igms.com/en/articles/12700312-ai-agent-automate-guest-communication
- Gorgias: https://docs.gorgias.com/en-US/coach-ai-agent-and-give-feedback-500892
- Conduit: https://docs.conduit.ai/agent-hub/road-to-autopilot/teach
- Enso: https://help.ensoconnect.com/en/articles/12478172-how-can-i-train-the-ensoai-from-the-sandbox
- WebKit (app icon badge): https://webkit.org/blog/14112/badging-for-home-screen-web-apps/
- Mews (Booking.com phone numbers): https://www.mews.com/en/blog/4-things-hoteliers-need-to-do-now-bookingcom-doesnt-share-guest-phone-numbers
