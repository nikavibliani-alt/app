# tuya-functions

**Tuya smart lock only.** This codebase (Firebase Functions codebase id `default`)
is reserved for Tuya door-lock Cloud Functions. It must not gain elevator,
WhatsApp, or general pipeline code going forward — that all lives in
[`pipeline-functions/`](../pipeline-functions/README.md) and
[`whatsapp-functions/`](../whatsapp-functions/README.md) now.

## Current exports

None. This codebase is empty pending Tuya smart-lock functionality being
restored (see "Reserved for later" below).

| Export | Status |
|---|---|
| ~~`whatsappWebhook`~~ | **Moved.** Now `whatsapp-functions/index.js`, exported from the `whatsapp` codebase. Removed from this file — do not re-add WhatsApp code here. |
| ~~`roomReadyNotification`~~ | **Moved.** Now `whatsapp-functions/index.js`, exported from the `whatsapp` codebase. Removed from this file — do not re-add WhatsApp code here. |
| ~~`elevatorCodeGuard`~~ | **Moved.** Now `pipeline-functions/controllers/elevatorCodeGuard.js`, exported from the `pipeline` codebase. Removed from this file — do not re-add elevator code here. |

## Reserved for later (not implemented yet, this codebase, when restored)

- `regenerateTuyaPassword`
- `generateOfflinePasswordOnReservation`
- `deleteTuyaPassword`

These are the functions `tuya-functions/package.json`'s `deploy:generate` /
`deploy:regenerate` / `deploy:delete` scripts already reference — they do not
currently exist in `index.js` (removed or never finished in an earlier pass; not
investigated as part of this task per Nika's decision to treat the
`reservations.tuyaPassword` writer question as out of scope for now — see
`PIPELINE_DESIGN_CURSOR.md` §6 / `MASTER_ARCHITECTURE_CURSOR.md`). When Tuya
smart-lock functionality is restored, it belongs here, in this codebase, not in
`pipeline-functions/`.

## Deploy

Unaffected by anything in `pipeline-functions/` — separate codebase id (`default`),
deployed independently:

```bash
firebase deploy --only functions:default --project sleepy-5c962
# or, from inside this folder:
npm run deploy
```
