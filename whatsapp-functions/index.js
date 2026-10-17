const { onRequest } = require('firebase-functions/v2/https');
const { isRoomReadyDateToday, isRoomReadyExcluded } = require('./roomReadyDate');
const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const { defineString } = require('firebase-functions/params');
const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const crypto = require('node:crypto');
const {
  isShortAcknowledgement,
  isWaitingFollowUpAfterEscalation,
  shouldStaySilentFromHistory,
  findMostRecentOwnerMessage,
  isNonTextPlaceholderOnly,
  ownerMuteCutoffMs,
  ownerMuteDecision,
  preSendDecision,
  isConversationStale,
} = require('./ownerSilence');
const {
  SUMMARY_SYSTEM_PROMPT,
  runPostCheckoutSummary,
  createFirestoreSummaryStore,
} = require('./summarizer');
const { loadCurrentStayHistory, prepareClaudeHistory, stripTimeLabels } = require('./stayContext');
const { findCurrentGuestForm } = require('./guestLookup');
const { otherPropertyForRoom, stayTiming, stayTimingContextLines } = require('./stayRules');
const { describeInbound } = require('./inboundContent');
const { downloadMetaMedia, photosToAttach, attachPhotos } = require('./metaMedia');
const { sendOwnerAlert, ownerAlertGuest, ownerStatusIds, guestFailedStatusLines, ownerAlertStatusLines, alertDocId, ALERTS_COLLECTION } = require('./ownerAlert');
const { urgentPushPayload, sendOwnerPush } = require('./ownerPush');
const { mediaFor, checkMediaLink, capMediaResend } = require('./videos');
const { SEED: KB_SEED, renderSystemPrompt, loadKnowledgeBase, unitFactLines, loadUnitWifi, propertyIdForRoom } = require('./knowledge/knowledgeBase');
const { lookupBooking, bookingLookupLines, guestTextsFrom } = require('./bookingLookup');
const { loadLiveStay, liveContextLines, checkinOpenWithLiveData } = require('./liveData');
const { CONFIG_DEFAULTS, tbilisiHour, resolveEffectiveMode, buildModeContext, timingSettings, replyDelaySeconds } = require('./botModes');
const { callClaudeWithRetry, describeClaudeError, buildCachedSystem, formatUsage } = require('./claudeClient');
const { parseAiReply, interpretMetaResponse, shouldNotifyNow, deliverReply } = require('./replyDelivery');

if (!getApps().length) initializeApp();

// ---- Cloud Tasks config (see README.md "Cloud Tasks setup" for the one-time GCP steps) ----
const TASKS_LOCATION = 'europe-west1';
const TASKS_QUEUE    = 'whatsapp-bot-debounce';
// Set at deploy time (firebase deploy will prompt for these params, or set via
// `firebase functions:secrets:set` / .env.whatsapp). Both are plain (non-secret)
// deploy-time params — see firebase-functions/params.
const WHATSAPP_BOT_WORKER_URL   = defineString('WHATSAPP_BOT_WORKER_URL', { default: '' });
const WHATSAPP_TASKS_INVOKER_SA = defineString('WHATSAPP_TASKS_INVOKER_SA', { default: '' });

// Do NOT require/construct CloudTasksClient at module load — its ADC/network
// discovery can hang Firebase CLI's "Loading and analyzing source code" step
// past the 10s timeout ("Cannot determine backend specification"). Lazily
// require and construct it only when actually enqueueing a task.
let tasksClient = null;
function getTasksClient() {
  if (!tasksClient) {
    // eslint-disable-next-line global-require
    const { CloudTasksClient } = require('@google-cloud/tasks');
    tasksClient = new CloudTasksClient();
  }
  return tasksClient;
}

// The system prompt is the RULES template (knowledge/promptTemplate.js) with
// every fact filled from the shared knowledge base (knowledge/seed.js, and
// Firestore kb_* docs once they exist). With the seed it is identical to the
// prompt that used to be written out here.
const SYSTEM_PROMPT = renderSystemPrompt(KB_SEED);

/** Strip spaces/dashes/parens/+ so Meta and form phones compare as digits-only. */
function normalizePhone(phone) {
  return String(phone || '').replace(/[\s\-().]/g, '').replace(/^\+/, '').replace(/\D/g, '');
}

/** matchedReservationId may be "007004653_001" — base reservation number is before first _. */
function baseReservationNumber(matchedReservationId) {
  const raw = String(matchedReservationId || '').trim();
  if (!raw) return '';
  return raw.split('_')[0];
}

function guestFirstName(fullName) {
  const name = String(fullName || '').trim();
  if (!name) return 'Guest';
  return name.split(/\s+/)[0];
}

async function alreadySentRoomReady(db, reservationNumber) {
  if (!reservationNumber) return false;
  const docs = await db.collection('whatsapp_messages')
    .where('reservationNumber', '==', String(reservationNumber))
    .where('job', '==', 'room_ready')
    .where('status', '==', 'sent')
    .limit(1)
    .get();
  return !docs.empty;
}

async function writeRoomReadyRecord(db, { reservationNumber, guestName, phone, status, metaMessageId = '' }) {
  await db.collection('whatsapp_messages').add({
    reservationNumber: String(reservationNumber || ''),
    guestName: guestName || '',
    phone: phone || '',
    job: 'room_ready',
    status,
    metaMessageId,
    createdAt: FieldValue.serverTimestamp(),
  });
}

/** Reply text, or '' on failure (used by the summarizer; the worker uses callClaudeWithRetry directly). */
async function callClaude({ system, messages, maxTokens = 500 }) {
  const result = await callClaudeWithRetry({ apiKey: process.env.ANTHROPIC_API_KEY, system, messages, maxTokens });
  return result.ok ? result.text : '';
}

async function sendWhatsAppMessage(payload) {
  const res = await fetch(
    `https://graph.facebook.com/v19.0/${process.env.META_PHONE_NUMBER_ID}/messages`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.META_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    }
  );
  return res.json();
}

/** Sends and checks Meta's response: { ok, id } or { ok: false, code, reason }. Never throws. */
async function sendWhatsAppChecked(payload) {
  try {
    return interpretMetaResponse(await sendWhatsAppMessage(payload));
  } catch (err) {
    return { ok: false, code: 'network', reason: `could not reach Meta: ${err.message || err}` };
  }
}

function toJsDate(value) {
  if (!value) return null;
  if (typeof value.toDate === 'function') return value.toDate();
  if (value instanceof Date) return value;
  const parsed = new Date(value);
  return isNaN(parsed.getTime()) ? null : parsed;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---- Bot config / mode resolution ------------------------------------------

async function getGlobalsConfig(db) {
  try {
    const snap = await db.collection('globals').doc('config').get();
    return snap.exists ? { ...CONFIG_DEFAULTS, ...snap.data() } : { ...CONFIG_DEFAULTS };
  } catch (err) {
    console.error('getGlobalsConfig failed:', err);
    return { ...CONFIG_DEFAULTS };
  }
}

async function writeAlert(db, { reason, phone, guestName = '', room = '', message = '', mode = '', urgency = false, errorType, errorMessage }) {
  try {
    await db.collection('whatsapp_alerts').add({
      reason,
      phone: phone || '',
      guestName,
      room,
      message,
      mode,
      urgency: !!urgency,
      // bot_error alerts only: what failed (e.g. credit, overloaded, meta_send_failed)
      ...(errorType ? { errorType, errorMessage: String(errorMessage || '').slice(0, 300) } : {}),
      resolved: false,
      createdAt: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.error('writeAlert failed:', err);
  }
}

/**
 * Owner alert via the approved "owner_alert" template ({{1}} guest, {{2}}
 * issue), delivered even outside the 24-hour window; falls back to the same
 * content as free-form text if the template send fails (see ownerAlert.js).
 * Each sent alert's message id is recorded in whatsapp_owner_alerts so Meta's
 * later delivery reports for it are logged as "owner alert" by the webhook.
 * Best-effort: never throws.
 */
async function notifyOwner(ownerPhone, { guest, issue }) {
  const to = normalizePhone(ownerPhone);
  if (!to) return;
  const r = await sendOwnerAlert({ to, guest, issue, send: sendWhatsAppChecked });
  if (!r.ok || !r.id) return;
  try {
    await getFirestore().collection(ALERTS_COLLECTION).doc(alertDocId(r.id)).set({
      via: r.via,
      language: r.language || null,
      sentAt: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.warn('notifyOwner: could not record the alert id:', err.message || err);
  }
}

/**
 * Web Push to the admin app's devices (push_subscriptions, VAPID keys), the
 * same system as the Hotel Collect alert. Urgent alerts and bot errors only
 * (ownerPush.js). Never throws; failures are logged as "owner push FAILED".
 */
let vapidSet = false;
async function pushToAdminDevices(payload) {
  try {
    return await sendOwnerPush({
      payload,
      loadSubscriptions: async () => (await getFirestore().collection('push_subscriptions').get())
        .docs.map((d) => ({ id: d.id, subscription: d.data().subscription })),
      send: (subscription, p) => {
        // eslint-disable-next-line global-require
        const webpush = require('web-push');
        if (!vapidSet) {
          webpush.setVapidDetails('mailto:nikavibliani@gmail.com', process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
          vapidSet = true;
        }
        return webpush.sendNotification(subscription, JSON.stringify(p));
      },
    });
  } catch (err) {
    console.error('owner push FAILED:', err.message || err);
    return { ok: false };
  }
}

const OWNER_NOTIFY_WINDOW_MS = 30 * 60 * 1000;

/**
 * Error notifications to the owner: at most one per `key` (error type) per
 * 30 minutes, tracked in whatsapp_alert_throttle/{key} so it holds across
 * worker instances. Callers always write the whatsapp_alerts doc themselves.
 */
async function notifyOwnerThrottled(db, ownerPhone, key, alert, push = null) {
  if (!ownerPhone && !push) return;
  const ref = db.collection('whatsapp_alert_throttle').doc(String(key).replace(/[^\w-]/g, '_'));
  let send = true;
  try {
    send = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const now = Date.now();
      if (!shouldNotifyNow(snap.exists ? Number(snap.data().lastNotifiedMs) : NaN, now, OWNER_NOTIFY_WINDOW_MS)) return false;
      tx.set(ref, { lastNotifiedMs: now, lastText: `${alert.guest}: ${alert.issue}`.slice(0, 300) });
      return true;
    });
  } catch (err) {
    console.warn('notifyOwnerThrottled: throttle check failed, notifying anyway:', err.message || err);
  }
  if (!send) {
    console.log(`notifyOwnerThrottled: owner already notified about "${key}" in the last 30 min — alert doc written, WhatsApp notification and push skipped`);
    return;
  }
  // WhatsApp and push side by side; neither can stop the other (both never throw).
  await Promise.all([notifyOwner(ownerPhone, alert), push ? push() : null]);
}

/**
 * True the first time `key` is claimed, false afterwards (atomic create() in
 * whatsapp_alert_throttle). Used for "alert the owner once per stay". A
 * Firestore error counts as a first claim, so an alert is never lost.
 */
async function claimOncePerStay(db, key) {
  const ref = db.collection('whatsapp_alert_throttle').doc(String(key).replace(/[^\w-]/g, '_'));
  try {
    await ref.create({ key, claimedAt: FieldValue.serverTimestamp() });
    return true;
  } catch (err) {
    if (err.code === 6 || /already exists/i.test(err.message || '')) return false;
    console.warn('claimOncePerStay: claim failed, alerting anyway:', err.message || err);
    return true;
  }
}

// ---- Inbound content classification ----------------------------------------

/** Returns the text to store for a message, or a bracketed placeholder for non-text types (see inboundContent.js). */
function classifyIncomingContent(msg) {
  return describeInbound(msg).content;
}

/**
 * Meta can redeliver the same webhook payload (slow/ambiguous response,
 * network retries), which would otherwise rotate whatsapp_pending's
 * batchToken a second time and double-log the conversation. Claims
 * `messageId` exactly once via an atomic create() — no get-then-set race
 * window. Returns true if this is a genuine duplicate (already claimed).
 */
async function isDuplicateMessage(db, messageId) {
  if (!messageId) return false; // no id to dedupe on — process normally
  const seenRef = db.collection('whatsapp_messages_seen').doc(messageId);
  try {
    await seenRef.create({
      messageId,
      // TTL-friendly: point a Firestore TTL policy (console/gcloud, not
      // application code) at this field to auto-expire old dedup records —
      // see README "Duplicate webhook delivery" section.
      processedAt: FieldValue.serverTimestamp(),
    });
    return false; // we just claimed it — first delivery
  } catch (err) {
    if (err.code === 6 || /already exists/i.test(err.message || '')) {
      return true; // ALREADY_EXISTS — a prior delivery already claimed this id
    }
    // Unexpected Firestore error — log and treat as not-a-duplicate so we
    // never silently drop a legitimate message over a transient hiccup.
    console.error(`isDuplicateMessage: create() failed for ${messageId}, proceeding anyway:`, err);
    return false;
  }
}

/** Drops any in-flight debounced batch for a phone. Best-effort. */
async function clearPendingForPhone(db, phone) {
  try {
    await db.collection('whatsapp_pending').doc(phone).delete();
  } catch (err) {
    console.warn('clearPendingForPhone failed:', err.message || err);
  }
}

// ---- Message batching (whatsapp_pending) ------------------------------------

/** Adds `text` to the guest's pending batch, rotating batchToken so any in-flight worker for the old token no-ops. */
async function upsertPendingMessage(db, phone, text, graceSeconds = 0) {
  const batchToken = crypto.randomUUID();
  const pendingRef = db.collection('whatsapp_pending').doc(phone);
  // Stale-conversation grace deadline (ms epoch), set once when the batch starts
  // so later messages in the same burst can't shorten the wait.
  let graceUntilMs = 0;
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(pendingRef);
    if (snap.exists) {
      graceUntilMs = Number(snap.data().graceUntilMs) || 0;
      tx.update(pendingRef, {
        messages: FieldValue.arrayUnion(text),
        lastMessageAt: FieldValue.serverTimestamp(),
        batchToken,
        phone,
      });
    } else {
      graceUntilMs = graceSeconds > 0 ? Date.now() + graceSeconds * 1000 : 0;
      tx.set(pendingRef, {
        messages: [text],
        batchStartedAt: FieldValue.serverTimestamp(),
        lastMessageAt: FieldValue.serverTimestamp(),
        batchToken,
        phone,
        ...(graceUntilMs ? { graceUntilMs } : {}),
      });
    }
  });
  return { batchToken, graceUntilMs };
}

/** Deletes whatsapp_pending/{phone} only if its batchToken still matches — avoids racing a newer burst. */
async function deletePendingIfTokenMatches(db, phone, batchToken) {
  const pendingRef = db.collection('whatsapp_pending').doc(phone);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(pendingRef);
    if (snap.exists && snap.data().batchToken === batchToken) {
      tx.delete(pendingRef);
    }
  });
}

/** Enqueues a Cloud Task that calls whatsappBotWorker after `delaySeconds`. Logs and no-ops on failure. */
async function enqueueBotWorker({ phone, batchToken, delaySeconds }) {
  console.log(`enqueueBotWorker called for phone: ${phone}`);

  const workerUrl = WHATSAPP_BOT_WORKER_URL.value();
  if (!workerUrl) {
    console.error('enqueueBotWorker: WHATSAPP_BOT_WORKER_URL is not configured — see README "Cloud Tasks setup"');
    return;
  }

  try {
    const project  = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || 'sleepy-5c962';
    const client = getTasksClient();
    const queuePath = client.queuePath(project, TASKS_LOCATION, TASKS_QUEUE);
    const invokerSa = WHATSAPP_TASKS_INVOKER_SA.value();

    const task = {
      httpRequest: {
        httpMethod: 'POST',
        url: workerUrl,
        headers: { 'Content-Type': 'application/json' },
        body: Buffer.from(JSON.stringify({ phone, batchToken })).toString('base64'),
        ...(invokerSa ? { oidcToken: { serviceAccountEmail: invokerSa } } : {}),
      },
      scheduleTime: { seconds: Math.floor(Date.now() / 1000) + Math.max(0, Math.round(delaySeconds)) },
    };

    await client.createTask({ parent: queuePath, task });
  } catch (err) {
    // Widened to cover getTasksClient()/queuePath() too, not just createTask —
    // a client-construction failure used to bypass this log entirely and only
    // surface as a generic "whatsappWebhook error:" from the outer handler.
    console.error('enqueueBotWorker: failed to enqueue task:', err);
  }
}

// -----------------------------------------------------------------------------

exports.whatsappWebhook = onRequest(
  { region: 'europe-west1', cors: true, secrets: ['WEBHOOK_VERIFY_TOKEN', 'META_ACCESS_TOKEN', 'META_PHONE_NUMBER_ID', 'ANTHROPIC_API_KEY'] },
  async (req, res) => {
    // GET — Meta webhook verification
    if (req.method === 'GET') {
      const mode  = req.query['hub.mode'];
      const token = req.query['hub.verify_token'];
      const challenge = req.query['hub.challenge'];

      if (mode === 'subscribe' && token === process.env.WEBHOOK_VERIFY_TOKEN) {
        return res.status(200).send(challenge);
      }
      return res.status(403).send('Forbidden');
    }

    // POST — incoming message / echo. Architecture rule: no long waits here — accept
    // work, hand off delayed replies to the Cloud Tasks worker, return 200 fast.
    if (req.method === 'POST') {
      try {
        const body  = req.body;
        const change = body?.entry?.[0]?.changes?.[0];
        const field = change?.field;
        const value = change?.value;
        const db    = getFirestore();

        // Diagnostic visibility only (no behavior change) — logs the webhook `field`
        // whenever it's anything other than the normal inbound-message type, so we
        // can tell from Cloud Run logs alone whether smb_message_echoes (or any
        // other field) is actually being delivered, without needing dashboard access.
        if (field && field !== 'messages') {
          console.log('whatsappWebhook: received non-messages field:', field, 'value:', JSON.stringify(value)?.slice(0, 1000));
        }

        // CHANGE 3 — coexistence owner echoes (owner/app replied from the WhatsApp Business app).
        // Field name per Meta's Business Coexistence webhook; some accounts may expose it as
        // `message_echoes` instead — check both defensively.
        const echoes = value?.smb_message_echoes || value?.message_echoes;
        if ((value?.smb_message_echoes !== undefined || value?.message_echoes !== undefined) && !(Array.isArray(echoes) && echoes.length > 0)) {
          // Echo field present on the payload but empty or not the array shape we expect —
          // log the raw value so a mismatch in Meta's actual schema is visible, not silent.
          console.log('whatsappWebhook: echo field present but empty/unmatched, raw value:', JSON.stringify(value)?.slice(0, 1000));
        }
        if (Array.isArray(echoes) && echoes.length > 0) {
          console.log('whatsappWebhook: smb_message_echoes matched, count:', echoes.length);
          for (const echo of echoes) {
            // An echo is a message the business (owner) sent TO the guest, so the guest's
            // number is `to`, not `from` (which is the business number).
            const guestPhone = normalizePhone(echo.to || echo.recipient_id || echo.from);
            if (!guestPhone) continue;
            const echoText = echo.text?.body || classifyIncomingContent(echo);
            await db.collection('whatsapp_conversations').doc(guestPhone)
              .collection('messages').add({
                role: 'owner',
                content: echoText,
                timestamp: FieldValue.serverTimestamp(),
                metaMessageId: echo.id || null,
              });
            // Owner took over (any mode) — drop any debounced bot batch so the bot
            // cannot talk over the host after they return and reply on iPhone.
            await clearPendingForPhone(db, guestPhone);
          }
          // Owner echoes never enqueue a bot reply.
          return res.sendStatus(200);
        }

        // Meta delivery reports (sent / delivered / read / failed) for messages to
        // the owner's number are logged, so a failed owner alert shows up in the
        // logs; only ids recorded in whatsapp_owner_alerts are called "owner alert".
        if (Array.isArray(value?.statuses) && value.statuses.length) {
          const statusConfig = await getGlobalsConfig(db);
          const ids = ownerStatusIds(value.statuses, statusConfig.ownerPhone);
          if (ids.length) {
            let alertIds = new Set();
            try {
              const snaps = await db.getAll(...ids.map((id) => db.collection(ALERTS_COLLECTION).doc(alertDocId(id))));
              alertIds = new Set(ids.filter((id, i) => snaps[i].exists));
            } catch (err) {
              console.warn('whatsappWebhook: owner alert id lookup failed:', err.message || err);
            }
            for (const line of ownerAlertStatusLines(value.statuses, statusConfig.ownerPhone, alertIds)) {
              console[line.level](`whatsappWebhook: ${line.text}`);
            }
          }
          // A message to a guest that Meta accepted but then failed (e.g. it could
          // not download a video from its link) is only reported here, later.
          for (const line of guestFailedStatusLines(value.statuses, statusConfig.ownerPhone)) {
            console.error(`whatsappWebhook: ${line}`);
          }
        }

        const messages = value?.messages;

        // Status updates / other non-message payloads — acknowledge and exit
        if (!messages || messages.length === 0) {
          return res.sendStatus(200);
        }

        const msg   = messages[0];

        // Dedupe Meta's redelivered webhooks before any other processing —
        // must run before whatsapp_pending's batchToken can rotate a second
        // time for the same physical message.
        if (await isDuplicateMessage(db, msg.id)) {
          console.log(`whatsappWebhook: duplicate message ${msg.id} — already processed, skipping`);
          return res.sendStatus(200);
        }

        const phone = normalizePhone(msg.from);
        if (!phone) return res.sendStatus(200);

        const inbound = describeInbound(msg);
        const text = inbound.content;

        // Reactions (👍 on one of our messages): nothing to answer, no alert —
        // not stored and no bot run.
        if (inbound.action === 'ignore') {
          console.log(`whatsappWebhook: ${text} from`, phone, '— ignored (no reply, not stored)');
          return res.sendStatus(200);
        }

        const convoRef    = db.collection('whatsapp_conversations').doc(phone);
        const messagesRef = convoRef.collection('messages');

        // Last message in the conversation (either side) BEFORE this one, for the
        // stale-conversation grace delay below. Must be read before the add.
        const prevSnap = await messagesRef.orderBy('timestamp', 'desc').limit(1).get();
        const prevAt = prevSnap.empty ? null : toJsDate(prevSnap.docs[0].data().timestamp);

        // Always persist the inbound message first, regardless of bot state
        await messagesRef.add({
          role: 'user',
          content: text,
          timestamp: FieldValue.serverTimestamp(),
          metaMessageId: msg.id || null,
          // Photos: Meta's media id only (never the image); the worker downloads
          // it while the photo is part of the guest's unanswered batch.
          ...(inbound.media ? { media: inbound.media } : {}),
        });

        // Stickers: kept in the history, but no bot run of their own. If the
        // guest also writes text, that text's run sees the sticker.
        if (inbound.action === 'store_only') {
          console.log(`whatsappWebhook: ${text} from`, phone, '— stored, no reply');
          return res.sendStatus(200);
        }

        const config = await getGlobalsConfig(db);

        // CHANGE 1 — hard kill switch. The inbound message is already saved (above,
        // unconditionally); no alert and no Cloud Task while paused — alerts are
        // reserved for when the bot is ON but can't handle something itself.
        if (config.aiBotEnabled === false) {
          return res.sendStatus(200);
        }

        // CHANGE 2 — batch into whatsapp_pending and hand off to the Cloud Tasks worker
        const effectiveMode = resolveEffectiveMode(config);
        const timing = timingSettings(config);

        // Stale-conversation grace: after a long silence, give the owner a chance to
        // answer first. Available mode only (in Away/night the owner isn't expected).
        const stale = effectiveMode === 'available'
          && isConversationStale(prevAt ? prevAt.getTime() : NaN, Date.now(), timing.staleConversationMinutes);

        const { batchToken, graceUntilMs } = await upsertPendingMessage(db, phone, text, stale ? timing.staleGraceSeconds : 0);

        // Away/night still debounce rapid bursts, but don't make the guest wait the full
        // human-first delay — cap at 3s.
        let delaySeconds = replyDelaySeconds(config, effectiveMode);
        if (graceUntilMs) {
          delaySeconds = Math.max(delaySeconds, Math.ceil((graceUntilMs - Date.now()) / 1000));
        }

        await enqueueBotWorker({ phone, batchToken, delaySeconds });

        return res.sendStatus(200);
      } catch (err) {
        console.error('whatsappWebhook error:', err);
        return res.sendStatus(200);
      }
    }

    return res.sendStatus(405);
  }
);

// ---- Deferred worker: builds the reply for one debounced batch --------------

exports.whatsappBotWorker = onRequest(
  {
    region: 'europe-west1',
    // Room for two ~25 s Claude attempts (timeout + one retry) plus Firestore
    // reads and the sends; at 60 s a slow retry could be cut off mid-send.
    timeoutSeconds: 120,
    // Cold start loads firebase-admin/firestore's full dependency graph
    // (google-gax + @opentelemetry/api + large proto JSON descriptors) —
    // measured locally as needing well over the platform's default (small)
    // memory tier under load, sometimes contending for close to 2GB of V8
    // heap. Underprovisioned memory here is a leading suspect for a cold
    // start that OOM-kills the instance before the handler ever runs.
    memory: '512MiB',
    // Pin the invoker to the Cloud Tasks service account by name, rather than
    // 'private' + a manual `gcloud run services add-iam-policy-binding`. With
    // 'private', Firebase doesn't manage any invoker binding at all, so the
    // manual grant was invisible to deploy's own IAM reconciliation and got
    // wiped on the next deploy. Declaring the principal here makes Firebase
    // (re-)apply this exact Cloud Run Invoker binding on every deploy.
    invoker: 'whatsapp-tasks-invoker@sleepy-5c962.iam.gserviceaccount.com',
    secrets: ['META_ACCESS_TOKEN', 'META_PHONE_NUMBER_ID', 'ANTHROPIC_API_KEY', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY'],
  },
  async (req, res) => {
    console.log('whatsappBotWorker: raw request received');
    try {
      console.log('whatsappBotWorker: request received', JSON.stringify(req.body).substring(0, 200));

      const { phone, batchToken } = req.body || {};
      if (!phone || !batchToken) {
        console.error('whatsappBotWorker: STOPPED — missing phone or batchToken in payload');
        return res.sendStatus(200); // malformed task — don't retry
      }

      const db = getFirestore();
      const config = await getGlobalsConfig(db);
      console.log('whatsappBotWorker: config loaded, aiBotEnabled:', config.aiBotEnabled, 'botMode:', config.botMode);

      // Kill switch may have flipped after the task was enqueued
      if (config.aiBotEnabled === false) {
        console.log('whatsappBotWorker: STOPPED — aiBotEnabled is false for', phone);
        return res.sendStatus(200);
      }

      const pendingRef = db.collection('whatsapp_pending').doc(phone);
      const pendingSnap = await pendingRef.get();
      // Note: Admin SDK — `exists` is a boolean property here, not a method (unlike the
      // client/Web SDK's `exists()`). Using () would throw "not a function" at runtime.
      console.log('whatsappBotWorker: looking for pending doc at path:', `whatsapp_pending/${phone}`, 'exists:', pendingSnap.exists);
      console.log('whatsappBotWorker: task batchToken:', batchToken, 'firestore batchToken:', pendingSnap.exists ? pendingSnap.data().batchToken : 'DOC_NOT_FOUND');
      if (!pendingSnap.exists) {
        console.log('whatsappBotWorker: STOPPED — no whatsapp_pending doc for', phone);
        return res.sendStatus(200);
      }

      const pending = pendingSnap.data();
      console.log('whatsappBotWorker: processing phone:', phone, 'messages count:', (pending.messages || []).length);
      // A newer message arrived and rescheduled work under a fresh token — this run is stale
      if (pending.batchToken !== batchToken) {
        console.log('whatsappBotWorker: STOPPED — stale batchToken for', phone, '(pending has a newer batch)');
        return res.sendStatus(200);
      }

      const effectiveMode = resolveEffectiveMode(config);
      const convoRef        = db.collection('whatsapp_conversations').doc(phone);
      const convoMessagesRef = convoRef.collection('messages');
      const combinedGuestText = (pending.messages || []).join('\n');

      // CHANGE 5 — owner mute, in ALL modes. The bot stays silent for
      // ownerMuteMinutes after any manual owner message (flat timer from that
      // message, independent of guest activity). A guest message that arrives
      // DURING the mute is deferred and answered when it expires (see
      // ownerMuteDecision); an owner reply at or after this batch started means
      // the owner addressed it, so it is dropped. Available-only used to miss the
      // Away incident: the host returned, answered, and the bot still talked over them.
      const { ownerMuteMinutes, ownerSilenceWindowMinutes } = timingSettings(config);
      const batchStartDate = toJsDate(pending.batchStartedAt || pending.lastMessageAt);
      const ownerMuteCutoff = () => new Date(ownerMuteCutoffMs(
        Date.now(),
        batchStartDate ? batchStartDate.getTime() : NaN,
        ownerMuteMinutes
      ));
      // Newest owner message inside the mute/batch window (NaN if none). Fetched
      // without orderBy/limit (same query shape as before) and reduced in JS.
      const latestOwnerMs = async () => {
        const snap = await convoMessagesRef
          .where('role', '==', 'owner')
          .where('timestamp', '>=', ownerMuteCutoff())
          .get();
        const times = snap.docs
          .map((d) => toJsDate(d.data().timestamp))
          .filter(Boolean)
          .map((d) => d.getTime());
        return times.length ? Math.max(...times) : NaN;
      };
      const muteDecision = async () => ownerMuteDecision({
        nowMs: Date.now(),
        batchStartMs: batchStartDate ? batchStartDate.getTime() : NaN,
        latestOwnerMs: await latestOwnerMs(),
        muteMinutes: ownerMuteMinutes,
      });
      const decision = await muteDecision();
      if (decision.action === 'drop') {
        console.log('whatsappBotWorker: STOPPED — owner replied since this batch started for', phone);
        await deletePendingIfTokenMatches(db, phone, batchToken);
        return res.sendStatus(200);
      }
      if (decision.action === 'defer') {
        // Guest wrote during the owner's mute: keep the batch and answer when the
        // mute expires, unless the owner replies again first (their echo clears
        // whatsapp_pending, so the deferred run then finds nothing and stays silent).
        const deferSeconds = Math.ceil((decision.deferUntilMs - Date.now()) / 1000) + 2;
        console.log('whatsappBotWorker: DEFERRED — owner mute active, re-enqueueing in', deferSeconds, 's for', phone);
        await enqueueBotWorker({ phone, batchToken, delaySeconds: deferSeconds });
        return res.sendStatus(200);
      }

      // Last 15 messages of the CURRENT stay (after the phone's most recent
      // completed checkout, see stayContext.js), fetched once and reused for
      // every history-based check below: owner continuation silence (CHANGE F),
      // short-ack / escalation-nudge silence (CHANGE 6), and Claude's history,
      // which carries the Host: lines and [VIDEO_SENT:id] markers the prompt's
      // already-answered and video-already-sent rules read. A previous stay's
      // messages must never count as the current conversation.
      const { recentNewestFirst, stayStartMs } = await loadCurrentStayHistory(db, phone, Date.now());
      if (Number.isFinite(stayStartMs)) {
        console.log('whatsappBotWorker: history scoped to current stay, after', new Date(stayStartMs).toISOString(), 'for', phone);
      }

      // CHANGE F — owner continuation silence: the most recent owner message (not
      // necessarily the directly preceding one) is still fresh (within
      // ownerSilenceWindowMinutes) and the guest's follow-up isn't a clear new
      // topic (approximated here the same way CHANGE 6 does: a short ack).
      const lastOwnerMsg = findMostRecentOwnerMessage(recentNewestFirst);
      if (lastOwnerMsg) {
        const ownerAt = toJsDate(lastOwnerMsg.timestamp);
        const withinWindow = ownerAt && (Date.now() - ownerAt.getTime()) < ownerSilenceWindowMinutes * 60 * 1000;
        if (withinWindow && (
          isShortAcknowledgement(combinedGuestText)
          || isWaitingFollowUpAfterEscalation(combinedGuestText, lastOwnerMsg.content)
          || isNonTextPlaceholderOnly(combinedGuestText)
        )) {
          console.log('whatsappBotWorker: STOPPED — owner continuation silence (within window + short ack/waiting nudge/non-text) for', phone);
          await deletePendingIfTokenMatches(db, phone, batchToken);
          return res.sendStatus(200);
        }
      }

      // CHANGE 6 — guest only said "okay"/"thanks" after the host (or the bot)
      // already closed the topic in the immediately preceding turn.
      if (shouldStaySilentFromHistory(recentNewestFirst, combinedGuestText)) {
        console.log('whatsappBotWorker: STOPPED — short-ack-after-owner/assistant silence for', phone);
        await deletePendingIfTokenMatches(db, phone, batchToken);
        return res.sendStatus(200);
      }

      // Guest lookup: the WhatsApp check-in form for the current or upcoming
      // stay, phones compared by digits (see guestLookup.js). Only past or
      // cancelled forms -> returning guest with no current form.
      const guestMatch = await findCurrentGuestForm(db, phone, Date.now());

      let guestName    = 'Guest';
      let roomCode     = '';
      let checkinDate  = '';
      let checkoutDate = '';
      let hasFilledForm = false;

      if (guestMatch) {
        hasFilledForm = true;
        guestName = guestMatch.form.name || 'Guest';
        if (guestMatch.reservation) {
          roomCode     = guestMatch.reservation.roomCode || '';
          checkinDate  = guestMatch.reservation.checkin || '';
          checkoutDate = guestMatch.reservation.checkout || '';
        }
      }

      // No check-in form for this phone: is the booking in our system? Searched
      // by a confirmation number or the full name the guest wrote (read-only,
      // bookingLookup.js). A found booking gives the room and dates, so the guest
      // gets that property's facts (or the other-property silence below); the
      // form stays "no". Not found -> the "new bookings take up to 10 minutes" rule.
      const lookup = guestMatch ? null : await lookupBooking(db, { guestTexts: guestTextsFrom(recentNewestFirst, combinedGuestText) });
      if (lookup?.status === 'found') {
        roomCode     = lookup.roomCode;
        checkinDate  = lookup.checkin;
        checkoutDate = lookup.checkout;
        console.log(`whatsappBotWorker: booking found by ${lookup.via} (${lookup.roomCode}), no form, for`, phone);
      }

      // Freedom Square (tab-*) / Orbeliani (orb-*) bookings: every scenario in
      // the prompt is Shartava-specific, so the bot sends nothing and the owner
      // is alerted, once per conversation per stay. Decided by the booking's room
      // code in code, before Claude is called (replaces the old keyword-based
      // sticky silence, which also silenced Shartava guests who only mentioned
      // Freedom Square as a landmark).
      const bookingRoom = roomCode || guestMatch?.form?.aptId || '';
      const otherProperty = otherPropertyForRoom(bookingRoom);
      if (otherProperty) {
        const stayKey = guestMatch?.reservation?.reservationNumber
          || String(guestMatch?.form?.matchedReservationId || '').split('_')[0]
          || guestMatch?.form?.arrivalDate || lookup?.reservationNumber || bookingRoom;
        if (await claimOncePerStay(db, `other_property_${phone}_${stayKey}`)) {
          await writeAlert(db, {
            reason: 'other_property',
            phone,
            guestName,
            room: bookingRoom,
            message: combinedGuestText,
            mode: effectiveMode,
          });
          if (config.ownerPhone) {
            await notifyOwner(config.ownerPhone, { guest: ownerAlertGuest(guestName, bookingRoom), issue: `${otherProperty} guest wrote: ${combinedGuestText}` });
          }
          console.log(`whatsappBotWorker: STOPPED — ${otherProperty} booking (${bookingRoom}); nothing sent, owner alerted (first message this stay), for`, phone);
        } else {
          console.log(`whatsappBotWorker: STOPPED — ${otherProperty} booking (${bookingRoom}); nothing sent, owner already alerted this stay, for`, phone);
        }
        await deletePendingIfTokenMatches(db, phone, batchToken);
        return res.sendStatus(200);
      }

      let memoryContext = '';
      const guestDoc = await db.collection('whatsapp_guests').doc(phone).get();
      if (guestDoc.exists) {
        const summary = guestDoc.data().summary;
        if (Array.isArray(summary) && summary.length > 0) {
          memoryContext = `\nPrevious stay notes for this guest: ${summary.map((s) => `- ${s}`).join(' ')}`;
        }
      }

      // Owner echoes map to an assistant turn prefixed "Host: " so the model knows
      // a human already responded (current stay only — see above).
      // Each line is labelled with how long ago it was sent (e.g. "[2 days ago]")
      // so the model can tell old messages from new ones — see MESSAGE TIMES.
      // The history always ends with the guest's unanswered message(s): the API
      // rejects one that ends with a bot reply or Host line (400 -> generic
      // fallback reply). Nothing unanswered -> nothing to reply to.
      const prepared = prepareClaudeHistory(recentNewestFirst, Date.now());
      if (prepared.silent) {
        console.log('whatsappBotWorker: STOPPED — no unanswered guest message (history ends with a bot/Host reply), Claude not called, for', phone);
        await deletePendingIfTokenMatches(db, phone, batchToken);
        return res.sendStatus(200);
      }
      // Photos in the guest's unanswered batch go to Claude as images (newest 4;
      // older photos stay "[image]" text in the history). Downloaded from Meta
      // now, passed through, never stored. A failed download keeps "[image]".
      const photos = photosToAttach(prepared.unanswered);
      const downloads = new Map();
      for (const p of photos) {
        const d = await downloadMetaMedia({ mediaId: p.mediaId, accessToken: process.env.META_ACCESS_TOKEN });
        downloads.set(p.index, d);
        if (d.ok) console.log(`whatsappBotWorker: photo ${p.mediaId} attached (${d.mimeType}, ${d.bytes} bytes) for`, phone);
        else console.warn(`whatsappBotWorker: photo ${p.mediaId} not attached, using "[image]" text — ${d.reason} — for`, phone);
      }
      const history = attachPhotos(prepared.messages, prepared.unansweredCount, downloads);

      // CHANGE G — inject the current Tbilisi hour so the model can apply
      // hour-dependent scenarios (e.g. cleaning staff availability).
      // Facts come from the shared knowledge base (read-only; the seed if Firestore has none),
      // live data (check-in page state, next arrival, service prices) from Firestore, read-only.
      const kb = await loadKnowledgeBase(db);
      // WiFi only from the check-in page data (several units share a network).
      const wifi = await loadUnitWifi(db, bookingRoom);
      const live = await loadLiveStay(db, { roomCode: bookingRoom, form: guestMatch?.form, reservation: guestMatch?.reservation });
      const timing = stayTiming({ checkin: checkinDate || guestMatch?.form?.arrivalDate, checkout: checkoutDate }, Date.now());
      timing.checkinOpen = checkinOpenWithLiveData(timing.checkinOpen, live.page);
      const guestContext = [
        `Guest name: ${guestName}`,
        `Room/apartment type: ${roomCode || 'unknown'}`,
        `Check-in: ${checkinDate || 'unknown'}`,
        `Checkout: ${checkoutDate || 'unknown'}`,
        `Filled check-in form: ${hasFilledForm ? 'yes' : 'no'}`,
        `CURRENT_TBILISI_HOUR: ${tbilisiHour()}`,
        // Check-in timing computed here in Tbilisi time, so the entrance and
        // door-code scenarios never have to work it out from the hour.
        ...stayTimingContextLines(timing),
        ...unitFactLines(kb, bookingRoom, wifi),
        ...bookingLookupLines(lookup, kb.properties?.[propertyIdForRoom(kb, lookup?.roomCode)]?.name),
        ...liveContextLines(live),
      ].join('\n') + memoryContext;

      const modeContext = buildModeContext(effectiveMode, config.ownerPhone);
      // Prompt caching: the long fixed SYSTEM_PROMPT is the cached prefix; the
      // per-guest part (guest context, mode, times) comes after the breakpoint.
      const system = buildCachedSystem(renderSystemPrompt(kb), `${guestContext}\n\n${modeContext}`);

      console.log('whatsappBotWorker: calling Claude for phone:', phone);
      const claude = await callClaudeWithRetry({
        apiKey: process.env.ANTHROPIC_API_KEY,
        system,
        messages: history,
      });
      console.log(`whatsappBotWorker: Claude usage (${claude.model}, ${claude.attempts} attempt(s)): ${formatUsage(claude.usage)}`);

      // Owner alerts' {{1}}: "<name> / <property> <room>" (or "unknown property").
      const label = ownerAlertGuest(guestName, bookingRoom);
      // Push notification for urgent alerts and bot errors (opts.push = kind).
      const pushUrgent = (opts) => pushToAdminDevices(urgentPushPayload({
        kind: opts.push, guestName, roomCode: bookingRoom, guestText: combinedGuestText, reason: opts.reason, phone,
      }));
      if (!claude.ok) {
        // Nothing is sent to the guest (no generic fallback). The pending batch is
        // kept, so the guest's message is answered together with their next one.
        // The alert doc is always written; the owner's WhatsApp notification is
        // limited to one per error type per 30 minutes.
        console.error(`whatsappBotWorker: STOPPED — Claude failed after ${claude.attempts} attempt(s): ${claude.errorType}${claude.status ? ` (HTTP ${claude.status})` : ''}: ${claude.message} — nothing sent to the guest, pending batch kept, for`, phone);
        await writeAlert(db, {
          reason: 'bot_error',
          phone,
          guestName,
          room: roomCode,
          message: combinedGuestText,
          mode: effectiveMode,
          errorType: claude.errorType,
          errorMessage: claude.message,
        });
        await notifyOwnerThrottled(db, config.ownerPhone, `claude_${claude.errorType}`, { guest: label, issue: `Bot could not reply: ${describeClaudeError(claude)}` }, () => pushUrgent({ push: 'bot_error', reason: `Bot could not reply: ${describeClaudeError(claude)}` }));
        return res.sendStatus(200);
      }

      // Strip any history time label the model copied into its reply, before any
      // tag parsing.
      const aiReply = stripTimeLabels(claude.text);
      console.log('whatsappBotWorker: Claude responded, length:', aiReply.length, 'attempts:', claude.attempts);
      // Never send the same video a third time in a conversation (videos.js).
      const plan = capMediaResend(parseAiReply(aiReply), recentNewestFirst.filter((m) => m.role === 'assistant').map((m) => m.content));
      if (plan.videoCapped) console.log('whatsappBotWorker: video/photos already sent twice in this conversation, not sending them again; escalating, for', phone);

      // CHANGE 7 — [SILENT]: the model asked to send nothing (host already
      // handled it, or the topic is explicitly out of scope). An angry-guest tag
      // still wins: it sends nothing either, but alerts the owner.
      if (plan.silent && !plan.angry) {
        console.log(`whatsappBotWorker: STOPPED — [SILENT] tag for ${phone}`);
        await deletePendingIfTokenMatches(db, phone, batchToken);
        return res.sendStatus(200);
      }

      // Send phase (replyDelivery.js). The final pre-send check runs before any
      // send AND before any owner alert, so a run replaced by a newer guest
      // message (or overtaken by the owner) never sends and never alerts twice.
      const { outcome } = await deliverReply(plan, {
        name: guestName,
        room: roomCode,
        guestText: combinedGuestText,
        mode: effectiveMode,
        ownerNote: live.ownerNote,
      }, {
        log: console,
        // Small humanizer — short, after Claude, before send. Not the batching delay.
        humanize: () => sleep(1000 + Math.random() * 1000),
        // Final re-check, immediately before anything is sent. An owner echo that
        // landed during Claude would otherwise be missed (the echo handler also
        // deletes whatsapp_pending, a second signal). A changed batchToken means
        // the guest wrote again: the newer run answers everything in one reply.
        preSendCheck: async () => {
          const pendingNow = await pendingRef.get();
          return preSendDecision({
            pendingExists: pendingNow.exists,
            pendingToken: pendingNow.exists ? pendingNow.data().batchToken : undefined,
            batchToken,
            muteAction: pendingNow.exists ? (await muteDecision()).action : undefined,
          });
        },
        // A [VIDEO:id] tag's media (a video, or the bag storage photos) goes by
        // permanent link (videos.js), never by Meta media id (those expire).
        // Every link is checked first; all items must go out, else deliverReply
        // sends the text-only version instead.
        sendVideo: async (id) => {
          const media = mediaFor(id);
          if (!media) return { ok: false, code: 'unknown_media', reason: `no media with id ${id}` };
          if (!media.items.length) return { ok: false, code: 'not_configured', reason: `no permanent file is set for the ${media.label}` };
          for (const item of media.items) {
            const check = await checkMediaLink(item.link, item.type);
            if (!check.ok) return { ok: false, code: 'media_link', reason: check.reason };
          }
          for (const item of media.items) {
            const r = await sendWhatsAppChecked({ messaging_product: 'whatsapp', to: phone, type: item.type, [item.type]: { link: item.link } });
            if (!r.ok) return r;
          }
          return { ok: true };
        },
        sendText: (body) => sendWhatsAppChecked({ messaging_product: 'whatsapp', to: phone, type: 'text', text: { body } }),
        // Stored only after a successful send. [VIDEO_SENT:id] (added by
        // deliverReply only if the video went out) lets a later call avoid
        // resending it. repliesToMs: newest guest message this reply answered —
        // see prepareClaudeHistory.
        storeAssistant: (content) => convoMessagesRef.add({
          role: 'assistant',
          content,
          timestamp: FieldValue.serverTimestamp(),
          repliesToMs: prepared.newestUnansweredMs,
        }),
        writeAlert: (fields) => writeAlert(db, {
          phone,
          guestName,
          room: roomCode,
          message: combinedGuestText,
          mode: effectiveMode,
          ...fields,
        }),
        // opts.push: also a push notification (urgent alerts only), side by side with WhatsApp.
        notifyOwner: async (issue, opts) => {
          await Promise.all([
            config.ownerPhone ? notifyOwner(config.ownerPhone, { guest: label, issue }) : null,
            opts?.push ? pushUrgent(opts) : null,
          ]);
        },
        notifyOwnerThrottled: (key, issue, opts) => notifyOwnerThrottled(db, config.ownerPhone, key, { guest: label, issue }, opts?.push ? () => pushUrgent(opts) : null),
        finishPending: () => deletePendingIfTokenMatches(db, phone, batchToken),
      });

      const OUTCOME_LOG = {
        stopped_newer: 'STOPPED — newer guest message arrived while the reply was being generated; not sending, no alerts, the newer run will answer everything',
        stopped_owner: 'STOPPED — owner replied while reply was being generated (pre-send check)',
        angry_alerted: 'STOPPED — angry/complaint guest, urgent silent alert',
        escalated_only: 'STOPPED — reply had only internal tags; nothing sent, escalated to the owner',
        empty_reply: 'STOPPED — reply was empty after removing tags; nothing sent, owner alerted, pending batch kept',
        send_failed: 'STOPPED — Meta did not accept the reply; not stored, owner alerted, pending batch kept',
        sent: 'completed normally',
      };
      console.log(`whatsappBotWorker: ${OUTCOME_LOG[outcome] || outcome} for`, phone);
      return res.sendStatus(200);
    } catch (err) {
      console.error('whatsappBotWorker error:', err);
      return res.sendStatus(200); // clean completion so Cloud Tasks does not retry indefinitely
    }
  }
);

exports.roomReadyNotification = onDocumentWritten(
  {
    document: 'hk_status/{docId}',
    region: 'europe-west1',
    secrets: ['META_ACCESS_TOKEN', 'META_PHONE_NUMBER_ID'],
  },
  async (event) => {
    const before = event.data.before;
    const after  = event.data.after;

    // Only fire when done flips TO true
    if (!after.exists) return;
    if (after.data().done !== true) return;
    if (before.exists && before.data().done === true) return;

    const { roomCode, date } = after.data();
    if (!roomCode || !date) return;

    // No room-ready message for Orbeliani, VGL and XCV rooms (roomReadyDate.js).
    if (isRoomReadyExcluded(roomCode)) {
      console.log(`roomReadyNotification: skipped: no room-ready message for this property (${roomCode} / ${date})`);
      return;
    }

    // Emergency fix 2026-10-04: only for a Done on TODAY (Tbilisi). toggleHkDone also marks the next-arrival
    // day done, which messaged a guest arriving 6 days later.
    if (!isRoomReadyDateToday(date)) {
      console.log(`roomReadyNotification: skipped: future date (${roomCode} / ${date}, not today)`);
      return;
    }

    const db = getFirestore();

    const snap = await db.collection('checkin_guests')
      .where('aptId', '==', roomCode)
      .where('arrivalDate', '==', date)
      .where('contactType', '==', 'wa')
      .limit(1)
      .get();

    if (snap.empty) {
      console.log(`roomReadyNotification: no WA guest for ${roomCode} / ${date}`);
      return;
    }

    const guest = snap.docs[0].data();
    const phone = normalizePhone(guest.contact);
    const name  = guest.name || 'Guest';
    const firstName = guestFirstName(name);
    const reservationNumber = baseReservationNumber(guest.matchedReservationId);

    if (!phone) {
      console.log(`roomReadyNotification: guest found but no phone for ${roomCode} / ${date}`);
      return;
    }

    if (reservationNumber && await alreadySentRoomReady(db, reservationNumber)) {
      console.log(`roomReadyNotification: already sent for reservation ${reservationNumber}`);
      return;
    }

    try {
      const data = await sendWhatsAppMessage({
        messaging_product: 'whatsapp',
        to: phone,
        type: 'template',
        template: {
          name: 'room_ready',
          language: { code: 'en' },
          components: [{
            type: 'body',
            parameters: [{ type: 'text', text: firstName }],
          }],
        },
      });

      if (data.messages) {
        const metaMessageId = data.messages[0]?.id || '';
        await writeRoomReadyRecord(db, {
          reservationNumber,
          guestName: name,
          phone,
          status: 'sent',
          metaMessageId,
        });
        console.log(`roomReadyNotification: sent to ${name} (${phone}) — id=${metaMessageId}`);
      } else {
        await writeRoomReadyRecord(db, {
          reservationNumber,
          guestName: name,
          phone,
          status: 'failed',
        });
        console.error(`roomReadyNotification: Meta error for ${phone} —`, JSON.stringify(data));
      }
    } catch (err) {
      await writeRoomReadyRecord(db, {
        reservationNumber,
        guestName: name,
        phone,
        status: 'failed',
      }).catch(() => {});
      console.error(`roomReadyNotification: fetch failed for ${phone}`, err);
    }
  }
);

// PART 3 — auto-summarize a guest's WhatsApp conversation after checkout.
// Fires on every reservations/{docId} write, including the MiniHotel sync's
// routine ~10-minute rewrites; runPostCheckoutSummary (summarizer.js) summarizes
// each checkout exactly once and never deletes any message.
exports.summarizeGuestConversation = onDocumentWritten(
  {
    document: 'reservations/{docId}',
    region: 'europe-west1',
    secrets: ['ANTHROPIC_API_KEY'],
  },
  async (event) => {
    const after = event.data?.after;
    if (!after || !after.exists) return;

    const reservation = after.data();
    const db = getFirestore();

    try {
      const result = await runPostCheckoutSummary({
        reservation,
        nowMs: Date.now(),
        store: createFirestoreSummaryStore(db, FieldValue),
        summarize: (conversationText) => callClaude({
          system: SUMMARY_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: conversationText }],
        }),
      });
      // Routine outcomes fire on every sync pass — only log the ones that did,
      // or tried to do, real work.
      if (!['not_checked_out', 'already_processed', 'no_wa_form', 'cancelled', 'no_reservation_number'].includes(result.outcome)) {
        console.log(`summarizeGuestConversation: reservation ${reservation.reservationNumber} ->`, JSON.stringify(result));
      }
    } catch (err) {
      console.error(`summarizeGuestConversation: failed for reservation ${reservation.reservationNumber}`, err);
    }
  }
);
