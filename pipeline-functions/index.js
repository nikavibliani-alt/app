'use strict';
/**
 * pipeline-functions — Maxela backend pipeline codebase.
 *
 * Separate Firebase Functions codebase from `tuya-functions/` (reserved for Tuya
 * smart-lock integration — see tuya-functions/README.md). Deployed via
 * firebase.json's second `functions[]` entry, codebase id "pipeline".
 *
 * See README.md for the pipe map, testing instructions, and deploy commands.
 *
 * Phase 1 (live): elevatorCodeGuard, elevatorCodeSync.
 * Phase 2 (this branch): adminAction callable → RoomAssignment (move/swap/release).
 * Phase 3: guestRegister callable, GuestUnlock via AdminAction, sandbox wiring.
 */

const { initializeApp, getApps } = require('firebase-admin/app');
if (!getApps().length) initializeApp();

const { registerCloudFunction: registerElevatorCodeGuard } = require('./controllers/elevatorCodeGuard');
const { registerCloudFunctions: registerElevatorCodeSync } = require('./controllers/elevatorCodeSync');
const { registerCloudFunction: registerAdminAction } = require('./controllers/adminAction');
const { registerCloudFunction: registerGuestRegister } = require('./controllers/guestRegister');
const { registerCloudFunctions: registerPushNotifications } = require('./controllers/pushNotifications');
const { registerCloudFunctions: registerGuestApi } = require('./controllers/guestApi');

exports.elevatorCodeGuard = registerElevatorCodeGuard();

const { elevatorCodeSync, elevatorCodeSyncManual } = registerElevatorCodeSync();
exports.elevatorCodeSync = elevatorCodeSync;
exports.elevatorCodeSyncManual = elevatorCodeSyncManual;

exports.adminAction = registerAdminAction();
exports.guestRegister = registerGuestRegister();

const { guestFind, guestStay } = registerGuestApi();
exports.guestFind = guestFind;
exports.guestStay = guestStay;

const { pushOnFailedSearch, pushOnGuestCheckout, pushOnServiceRequest, pushOnHkDone, pushOnDamageReport, pushTestRequest } = registerPushNotifications();
exports.pushTestRequest = pushTestRequest;
exports.pushOnFailedSearch = pushOnFailedSearch;
exports.pushOnGuestCheckout = pushOnGuestCheckout;
exports.pushOnServiceRequest = pushOnServiceRequest;
exports.pushOnHkDone = pushOnHkDone;
exports.pushOnDamageReport = pushOnDamageReport;

const { registerCloudFunction: registerHotelCollectAlert } = require('./controllers/hotelCollectAlert');
exports.pushOnHotelCollect = registerHotelCollectAlert();

const { registerCloudFunction: registerInboxEmailIngest } = require('./controllers/inboxEmailIngest');
exports.inboxEmailIngest = registerInboxEmailIngest();
const { registerCloudFunction: registerInboxSort } = require('./controllers/inboxSort');
exports.inboxSort = registerInboxSort();
const { registerCloudFunctions: registerInboxReply } = require('./controllers/inboxReply');
Object.assign(exports, registerInboxReply());   // inboxSendReply, inboxCheckinLink, inboxOutbox
const { registerCloudFunctions: registerInboxDraft } = require('./controllers/inboxDraft');
Object.assign(exports, registerInboxDraft());   // inboxAiOnMessage, inboxAiRun, inboxDraftDiscard
const { registerCloudFunctions: registerInboxStats } = require('./controllers/inboxStats');
Object.assign(exports, registerInboxStats());   // inboxStatsOnWrite
const { registerCloudFunctions: registerInboxPush } = require('./controllers/inboxPush');
Object.assign(exports, registerInboxPush());   // inboxPushOnMessage, inboxPushOnConversation, inboxAlerts
const { registerCloudFunctions: registerInboxScriptWatch } = require('./controllers/inboxScriptWatch');
Object.assign(exports, registerInboxScriptWatch());   // inboxScriptWatch
const { registerCloudFunctions: registerInboxCheckin } = require('./controllers/inboxCheckin');
Object.assign(exports, registerInboxCheckin());   // inboxCheckinTrigger
const { registerCloudFunctions: registerInboxReview } = require('./controllers/inboxReview');
Object.assign(exports, registerInboxReview());   // inboxReviewHandled
const { registerCloudFunctions: registerInboxAiAdmin } = require('./controllers/inboxAiAdmin');
Object.assign(exports, registerInboxAiAdmin());   // inboxAiAction, inboxAiKnowledge
const { registerCloudFunctions: registerInboxBooking } = require('./controllers/inboxBooking');
Object.assign(exports, registerInboxBooking());   // inboxBookingPanel, inboxRequestCreate
