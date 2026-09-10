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
| `whatsappWebhook` | `onRequest` (HTTPS) | Meta WhatsApp inbound webhook — GET for Meta's verification handshake, POST for inbound messages → Claude-generated auto-reply, sent back via the Meta Cloud API. |
| `roomReadyNotification` | `onDocumentWritten` on `hk_status/{docId}` | Sends a WhatsApp "room ready" message via the Meta Cloud API when `done` flips to `true`. |

Both require the secrets `META_ACCESS_TOKEN` and `META_PHONE_NUMBER_ID`;
`whatsappWebhook` additionally needs `WEBHOOK_VERIFY_TOKEN` and
`ANTHROPIC_API_KEY`.

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
