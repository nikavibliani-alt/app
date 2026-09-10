# whatsapp-functions

WhatsApp (Meta) guest messaging. Firebase Functions codebase id `whatsapp`,
deployed independently from `tuya-functions/` (`default`) and
`pipeline-functions/` (`pipeline`).

Split out of `tuya-functions/` — that codebase is reserved for Tuya
smart-lock integration and these functions have nothing to do with locks.
See `tuya-functions/README.md` for the prior history.

## Current exports

| Export | Type | Notes |
|---|---|---|
| `whatsappWebhook` | `onRequest` (HTTPS) | Meta WhatsApp inbound webhook — GET for Meta's verification handshake. POST: persists the inbound message, handles coexistence owner echoes, and — unless the kill switch is off — batches the message into `whatsapp_pending/{phone}` and enqueues a debounced Cloud Task. Returns 200 immediately; it never calls Claude or waits on a timer itself. |
| `whatsappBotWorker` | `onRequest` (HTTPS, Cloud Tasks target only) | The deferred worker. Runs after the debounce delay, resolves the effective bot mode, calls Claude with the batched messages + mode context, sends the reply, and writes escalation alerts. Not publicly invokable — see "Cloud Tasks setup" below. |
| `roomReadyNotification` | `onDocumentWritten` on `hk_status/{docId}` | Sends a WhatsApp "room ready" template message via the Meta Cloud API when `done` flips to `true`, deduped via `whatsapp_messages`. |
| `summarizeGuestConversation` | `onDocumentWritten` on `reservations/{docId}` | Once checkout has passed and the reservation isn't cancelled, summarizes the guest's WhatsApp thread into `whatsapp_guests/{phone}.summary` and clears the conversation. |

`whatsappWebhook` needs `WEBHOOK_VERIFY_TOKEN`, `META_ACCESS_TOKEN`, `META_PHONE_NUMBER_ID`,
`ANTHROPIC_API_KEY` (the last one currently unused there but kept for parity).
`whatsappBotWorker` needs its own copies of `META_ACCESS_TOKEN`, `META_PHONE_NUMBER_ID`,
`ANTHROPIC_API_KEY`. `roomReadyNotification` needs `META_ACCESS_TOKEN` and
`META_PHONE_NUMBER_ID`. `summarizeGuestConversation` needs `ANTHROPIC_API_KEY`.

## Bot modes / kill switch (`globals/config`)

All fields live on the single Firestore doc `globals/config` (merge writes; the
admin "Bot Settings" panel in `checkin-admin.html` edits this doc):

| Field | Type | Default | Meaning |
|---|---|---|---|
| `aiBotEnabled` | boolean | `true` | Hard kill switch. `false` → the bot never calls Claude and never replies to guests; the inbound message is still saved and a `whatsapp_alerts` doc (`reason: "bot_paused"`) is written. |
| `botMode` | `"available" \| "away" \| "night" \| "auto"` | `"available"` | See resolution below. |
| `botResponseDelay` | number (seconds) | `20` | Debounce delay before the worker runs, in `available` mode (and in `auto` mode when not in the night window). Away/night always debounce at `min(botResponseDelay, 3)`s instead, so bursts still batch without making the guest wait. |
| `ownerPhone` | string | `''` | Digits-only or E.164 WhatsApp number for owner alerts and the night-mode contact line. |
| `nightStart` / `nightEnd` | number (0-23) | `22` / `9` | Tbilisi-local night window for `botMode: "auto"`. Supports wrap-around (`22 → 9` = 10pm-9am). If equal, auto-night is disabled (always resolves to `available`). |

Effective mode resolution (`resolveEffectiveMode` in `index.js`):
1. `aiBotEnabled === false` → bot silent (checked separately, before mode resolution).
2. `botMode === "away"` → `away`.
3. `botMode === "night"` → `night`.
4. `botMode === "auto"` → `night` when the current Tbilisi hour falls in `[nightStart, nightEnd)` (wrap-around aware), else `available`.
5. `botMode === "available"` (or anything else) → `available`.

Each effective mode injects extra context into the system prompt (away/night
tell the guest not to expect an instant human reply; available mode tells the
model to defer to a `Host:`-prefixed message already in the conversation
history, which comes from a coexistence owner echo — see below).

## Message batching / Cloud Tasks worker

The webhook must return fast and must not `await` long delays, so replies are
handled by a **Cloud Tasks deferred worker** instead of a timer inside the
request handler:

1. `whatsappWebhook` saves the inbound message, then upserts
   `whatsapp_pending/{phone}` in a transaction — `arrayUnion`s the new message
   text into `messages`, rotates a random `batchToken`, and bumps
   `lastMessageAt` (`batchStartedAt` is set once, on first create).
2. It enqueues a Cloud Task targeting `whatsappBotWorker` with
   `{ phone, batchToken }`, scheduled `botResponseDelay` (or the away/night
   3s cap) seconds out, then returns 200.
3. If another message arrives before the task fires, step 1 rotates the
   token again — the earlier task still fires, sees a stale `batchToken`
   against the (now newer) `whatsapp_pending` doc, and exits as a no-op.
   Only the task scheduled by the *last* message in a burst does real work.
4. `whatsappBotWorker` combines `pending.messages` into one guest turn,
   builds the last ~15 messages of history (owner echoes become an
   `assistant` turn prefixed `"Host: "`), calls Claude with the mode context
   appended to `SYSTEM_PROMPT`, strips `[VIDEO:id]` / `[ESCALATE]`, sends the
   reply, saves it, writes escalation alerts if needed, and deletes
   `whatsapp_pending/{phone}` (only if the token still matches).
5. In `available` mode, before replying the worker also checks whether an
   owner echo (`role: "owner"`) landed in `whatsapp_conversations/{phone}/messages`
   since the batch started — if so, it deletes the pending doc and stays
   silent instead of double-answering.

### Cloud Tasks setup (one-time, manual — not run by this repo)

This repo only implements the enqueue client (`enqueueBotWorker` in
`index.js`) and the worker function. The queue and IAM binding are
infrastructure and need to be created once per GCP project:

```bash
# 1. Create the queue (europe-west1, matching the functions' region)
gcloud tasks queues create whatsapp-bot-debounce \
  --location=europe-west1 \
  --project=sleepy-5c962

# 2. Create (or reuse) a service account Cloud Tasks will use to sign the
#    OIDC token it sends with each task request
gcloud iam service-accounts create whatsapp-tasks-invoker \
  --project=sleepy-5c962 \
  --display-name="Cloud Tasks invoker for whatsappBotWorker"

# 3. After the first `firebase deploy`, grant that service account
#    Cloud Run Invoker on the whatsappBotWorker service (only it should be
#    able to call the worker — the function is deployed with invoker:'private')
gcloud run services add-iam-policy-binding whatsappbotworker \
  --region=europe-west1 \
  --project=sleepy-5c962 \
  --member="serviceAccount:whatsapp-tasks-invoker@sleepy-5c962.iam.gserviceaccount.com" \
  --role="roles/run.invoker"
```

`whatsappWebhook` needs two deploy-time params so it knows the worker's URL
and which service account to sign task tokens with — `firebase deploy` will
prompt for these interactively if left unset.

Then set the params either by answering the `firebase deploy` prompts, or by
creating `whatsapp-functions/.env.whatsapp` with:

```
WHATSAPP_BOT_WORKER_URL=https://<the deployed whatsappBotWorker Cloud Run URL>
WHATSAPP_TASKS_INVOKER_SA=whatsapp-tasks-invoker@sleepy-5c962.iam.gserviceaccount.com
```

The worker URL is only known after the first deploy (2nd-gen functions get a
generated Cloud Run URL), so the intended order is: deploy once with the
params left blank (the webhook will log and no-op on enqueue until this is
set), copy the printed `whatsappBotWorker` URL, fill in `.env.whatsapp`, then
redeploy.

Also watch for a **missing Firestore composite index** error in the worker's
logs the first time it runs in `available` mode — the owner-echo freshness
check (`where('role','==','owner').where('timestamp','>=',...)` on
`whatsapp_conversations/{phone}/messages`) needs a composite index that
Firestore will offer to auto-create via a link in that error.

## Coexistence owner echoes

When WhatsApp Business Coexistence is enabled, messages the owner sends from
the official WhatsApp Business app arrive on the webhook as echoes (this repo
checks `value.smb_message_echoes`, falling back to `value.message_echoes` —
the exact field name wasn't independently verifiable from this environment,
so confirm against a live payload before relying on it). Echoes are saved as
`role: "owner"` messages and never enqueue a bot reply. Without this, the
`available` mode's "let a human answer first" behavior can't detect that the
owner already replied.

## Deploy

```bash
firebase deploy --only functions:whatsapp --project sleepy-5c962
# or, from inside this folder:
npm run deploy
```

## After deploying for the first time

2nd-gen HTTPS functions get a new URL when they move to a new codebase
(the underlying Cloud Run service is recreated). **Update the webhook URL
in the Meta Business dashboard (WhatsApp > Configuration > Webhook) to
the new `whatsappWebhook` URL before removing it from `tuya-functions/`**,
or inbound WhatsApp messages will stop reaching the assistant.
