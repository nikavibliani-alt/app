const { initializeApp, getApps } = require('firebase-admin/app');

if (!getApps().length) initializeApp();

// Reserved for Tuya smart lock integration. No functions live here
// currently — whatsappWebhook and roomReadyNotification were moved to
// whatsapp-functions/ (WhatsApp/Meta messaging has nothing to do with
// Tuya locks). elevatorCodeGuard moved to pipeline-functions/ earlier
// — see tuya-functions/README.md. Do not re-add either here.
