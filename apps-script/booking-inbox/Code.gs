/**
 * Maxela Booking.com inbox, steps 1 and 4: collect emails, send replies.
 *
 * Runs inside the Gmail account that receives Booking.com emails. Every minute it
 *   1. asks the Cloud Function inboxOutbox for replies I wrote in the inbox screen and sends each
 *      one as a plain-text reply to the guest's Booking.com email (step 4), then
 *   2. sends new Booking.com emails to the Cloud Function inboxEmailIngest, which saves them in
 *      Firestore (step 1). Nothing is labelled, moved or deleted.
 *
 * Script Properties (Project Settings > Script Properties), never written in this file:
 *   INGEST_URL  the inboxEmailIngest function URL
 *   INGEST_KEY  the same value as the Firebase secret INBOX_INGEST_KEY (also used for inboxOutbox)
 *   OUTBOX_URL  optional: the inboxOutbox function URL, if it ever changes (default below)
 *
 * Run once: setup() (creates the 1-minute trigger), then backfill() (starts the last 30 days).
 *
 * Progress is remembered per message, not per Gmail label (labels belong to whole threads):
 *   CURSOR_MS   everything older than this has been sent
 *   RECENT_IDS  the last message IDs sent, so the overlap below is not sent twice
 * The server saves each email under its Gmail message ID, so a repeat is harmless anyway.
 */

var BACKFILL_DAYS = 30;
var WINDOW_MS = 6 * 60 * 60 * 1000;       // look at 6 hours of mail at a time, oldest first
var OVERLAP_MS = 2 * 60 * 1000;           // re-look 2 minutes back so late-arriving mail is not missed
var SAFE_LAG_MS = 60 * 1000;              // do not move the cursor past "now minus 1 minute"
var TIME_BUDGET_MS = 4.5 * 60 * 1000;     // Apps Script stops at 6 minutes; stop early and continue next run
var MAX_RECENT_IDS = 100;
var MAX_HTML = 150000;
var MAX_TEXT = 150000;

// Step 4: sending replies.
var OUTBOX_URL_DEFAULT = 'https://europe-west1-sleepy-5c962.cloudfunctions.net/inboxOutbox';
var GUEST_ADDRESS_RE = /^[^\s<>@]+@guest\.booking\.com$/i;
var MAX_REPLY_CHARS = 2000;
var MAX_ATTEMPTED_IDS = 200;

var SENDER_QUERY = '(from:booking.com OR from:mchat.booking.com OR from:guest.booking.com)';
var SENDER_RE = /@([a-z0-9-]+\.)*booking\.com>?\s*$/i;

var KEEP_HEADERS = [
  'message-id', 'in-reply-to', 'references', 'return-path', 'sender', 'cc',
  'delivered-to', 'auto-submitted', 'precedence', 'list-id', 'reply-to',
  'mime-version', 'content-type', 'x-mailer'
];

// ---------------------------------------------------------------- run by hand

/** Run once. Creates the 1-minute trigger (and removes older copies of it). */
function setup() {
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('INGEST_URL') || !props.getProperty('INGEST_KEY')) {
    throw new Error('Add the Script Properties INGEST_URL and INGEST_KEY first (Project Settings).');
  }
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'processNew') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('processNew').timeBased().everyMinutes(1).create();
  Logger.log('Trigger created: processNew runs every minute. Now run backfill().');
}

/** Run once after setup(). Starts the last 30 days; the 1-minute trigger finishes the rest. */
function backfill() {
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('CURSOR_MS')) {
    props.setProperty('CURSOR_MS', String(Date.now() - BACKFILL_DAYS * 24 * 60 * 60 * 1000));
    Logger.log('Starting from ' + BACKFILL_DAYS + ' days ago.');
  } else {
    Logger.log('Already started. Continuing from ' + new Date(Number(props.getProperty('CURSOR_MS'))));
  }
  processNew();
}

/** Optional: shows progress without sending anything. */
function status() {
  var c = PropertiesService.getScriptProperties().getProperty('CURSOR_MS');
  Logger.log(c ? 'Sent everything up to ' + new Date(Number(c)) : 'Not started. Run backfill().');
}

// ---------------------------------------------------------------- trigger

function processNew() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) { Logger.log('Another run is still going.'); return; }
  try {
    try { sendReplies_(); } catch (e) { Logger.log('Replies step failed: ' + e.message); }   // replies first: they are time sensitive
    run_();
  } finally {
    lock.releaseLock();
  }
}

function run_() {
  var started = Date.now();
  var props = PropertiesService.getScriptProperties();
  var url = props.getProperty('INGEST_URL');
  var key = props.getProperty('INGEST_KEY');
  if (!url || !key) { Logger.log('Missing INGEST_URL or INGEST_KEY.'); return; }
  if (!props.getProperty('CURSOR_MS')) { Logger.log('Not started. Run backfill() once.'); return; }

  var cursor = Number(props.getProperty('CURSOR_MS'));
  var recent = JSON.parse(props.getProperty('RECENT_IDS') || '[]');
  var sent = 0;

  while (true) {
    var safeNow = Date.now() - SAFE_LAG_MS;
    if (cursor >= safeNow) break;
    var winEnd = Math.min(cursor + WINDOW_MS, safeNow);

    var msgs = collect_(cursor - OVERLAP_MS, winEnd, recent, started);
    if (msgs === null) break;                       // out of time while reading Gmail

    for (var i = 0; i < msgs.length; i++) {
      if (Date.now() - started > TIME_BUDGET_MS) { save_(props, cursor, recent); Logger.log('Time is up, sent ' + sent + '. Continuing next run.'); return; }
      var m = msgs[i];
      var result = post_(url, key, toPayload_(m.msg));
      if (!result.ok) { save_(props, cursor, recent); Logger.log('Stopped: ' + result.error + ' (sent ' + sent + ').'); return; }
      sent++;
      recent.push(m.id);
      if (recent.length > MAX_RECENT_IDS) recent.shift();
      if (m.time > cursor) cursor = m.time;
      save_(props, cursor, recent);
    }
    cursor = Math.max(cursor, winEnd);              // this window is finished
    save_(props, cursor, recent);
    if (Date.now() - started > TIME_BUDGET_MS) break;
  }
  Logger.log('Done. Sent ' + sent + ' email(s). Up to date until ' + new Date(cursor));
}

function save_(props, cursor, recent) {
  props.setProperties({ CURSOR_MS: String(cursor), RECENT_IDS: JSON.stringify(recent) });
}

// ---------------------------------------------------------------- Gmail

/** Booking.com messages dated in [fromMs, toMs), oldest first. Returns null if time ran out. */
function collect_(fromMs, toMs, recent, started) {
  var q = SENDER_QUERY + ' after:' + Math.floor(fromMs / 1000) + ' before:' + (Math.ceil(toMs / 1000) + 1);
  var seen = {};
  var out = [];
  var start = 0;
  while (true) {
    if (Date.now() - started > TIME_BUDGET_MS) return null;
    var threads = GmailApp.search(q, start, 100);
    if (!threads.length) break;
    for (var t = 0; t < threads.length; t++) {
      var messages = threads[t].getMessages();
      for (var k = 0; k < messages.length; k++) {
        var msg = messages[k];
        var id = msg.getId();
        var time = msg.getDate().getTime();
        if (seen[id] || time < fromMs || time >= toMs) continue;
        if (recent.indexOf(id) !== -1) continue;
        if (!SENDER_RE.test(msg.getFrom())) continue;
        seen[id] = true;
        out.push({ id: id, time: time, msg: msg });
      }
    }
    if (threads.length < 100) break;
    start += 100;
  }
  out.sort(function (a, b) { return a.time - b.time; });
  return out;
}

function toPayload_(msg) {
  return {
    gmailMessageId: msg.getId(),
    gmailThreadId: msg.getThread().getId(),
    date: msg.getDate().toISOString(),
    from: msg.getFrom(),
    to: msg.getTo(),
    replyTo: msg.getReplyTo(),
    subject: msg.getSubject(),
    bodyText: msg.getPlainBody().slice(0, MAX_TEXT),
    bodyHtml: msg.getBody().slice(0, MAX_HTML),
    headers: headers_(msg)
  };
}

/** The few headers we care about, read from the top of the raw message. */
function headers_(msg) {
  var out = {};
  try {
    var raw = msg.getRawContent();
    var end = raw.search(/\r?\n\r?\n/);
    var head = (end === -1 ? raw : raw.slice(0, end)).replace(/\r?\n[ \t]+/g, ' ');
    head.split(/\r?\n/).forEach(function (line) {
      var i = line.indexOf(':');
      if (i < 1) return;
      var name = line.slice(0, i).trim().toLowerCase();
      if (KEEP_HEADERS.indexOf(name) !== -1 || name.indexOf('x-booking') === 0) {
        out[name] = line.slice(i + 1).trim().slice(0, 1000);
      }
    });
  } catch (e) {
    Logger.log('Could not read headers for one message: ' + e.message);
  }
  return out;
}

// ---------------------------------------------------------------- send

function post_(url, key, payload) {
  var last = 'no answer';
  for (var attempt = 0; attempt < 2; attempt++) {
    try {
      var res = UrlFetchApp.fetch(url, {
        method: 'post',
        contentType: 'application/json',
        headers: { Authorization: 'Bearer ' + key },
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      });
      var code = res.getResponseCode();
      if (code === 200) return { ok: true };
      last = 'server answered ' + code;
      if (code === 401 || code === 400) break;      // retrying will not help
    } catch (e) {
      last = e.message;
    }
    Utilities.sleep(1500);
  }
  return { ok: false, error: last };
}


// ---------------------------------------------------------------- replies (step 4)

/**
 * Asks the server for waiting replies and sends each one. The server marks a reply "sending"
 * before handing it out, so it is never handed out twice. If a report never reaches the server
 * the reply shows as "unknown, check in Booking.com" after 10 minutes. It is never resent.
 */
function sendReplies_() {
  var props = PropertiesService.getScriptProperties();
  var key = props.getProperty('INGEST_KEY');
  var url = props.getProperty('OUTBOX_URL') || OUTBOX_URL_DEFAULT;
  if (!key) return;

  var pulled = outbox_(url, key, { action: 'pull' });
  if (!pulled.ok) { Logger.log('Could not ask for replies: ' + pulled.error); return; }
  var items = (pulled.body && pulled.body.items) || [];
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    var attempted = JSON.parse(props.getProperty('ATTEMPTED_IDS') || '[]');
    if (attempted.indexOf(item.id) !== -1) {
      Logger.log('Skipped a reply that was already tried once (it will show as unknown): ' + item.id);
      continue;                                       // never try the same reply twice
    }
    attempted.push(item.id);
    if (attempted.length > MAX_ATTEMPTED_IDS) attempted.shift();
    props.setProperty('ATTEMPTED_IDS', JSON.stringify(attempted));   // saved before sending

    var result = sendOne_(item);
    var rep = { action: 'report', id: item.id, result: result.ok ? 'sent' : 'failed', reason: result.ok ? '' : result.error };
    var reported = outbox_(url, key, rep, 3);
    Logger.log((result.ok ? 'Sent' : 'Failed (' + result.error + ')') + ': ' + item.id + (reported.ok ? '' : ' (report not delivered: ' + reported.error + ')'));
  }
}

function addr_(s) {
  var m = String(s || '').match(/<([^>]+)>/);
  return (m ? m[1] : String(s || '')).trim().toLowerCase();
}

/** Sends one reply as plain text. Returns { ok: true } or { ok: false, error }. */
function sendOne_(item) {
  try {
    var text = String(item.text || '');
    if (!text.trim()) return { ok: false, error: 'Empty message.' };
    if (text.length > MAX_REPLY_CHARS) return { ok: false, error: 'Message too long.' };
    var expected = addr_(item.expectedTo);
    if (!GUEST_ADDRESS_RE.test(expected)) return { ok: false, error: 'Not a Booking.com guest address.' };

    var msg = GmailApp.getMessageById(item.gmailMessageId);
    if (!msg) return { ok: false, error: 'The guest email was not found in Gmail.' };
    if (addr_(msg.getReplyTo() || msg.getFrom()) !== expected) return { ok: false, error: 'The guest email has a different reply address.' };

    // Reply to the newest email of the guest in that Gmail thread.
    var target = msg;
    var all = msg.getThread().getMessages();
    for (var i = all.length - 1; i >= 0; i--) {
      if (addr_(all[i].getReplyTo() || all[i].getFrom()) === expected) { target = all[i]; break; }
    }
    target.reply(text);                               // plain text only: no HTML, no signature
    return { ok: true };
  } catch (e) {
    return { ok: false, error: 'Gmail error: ' + String(e && e.message || e).slice(0, 200) };
  }
}

function outbox_(url, key, payload, attempts) {
  var last = 'no answer';
  for (var attempt = 0; attempt < (attempts || 1); attempt++) {
    try {
      var res = UrlFetchApp.fetch(url, {
        method: 'post',
        contentType: 'application/json',
        headers: { Authorization: 'Bearer ' + key },
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      });
      var code = res.getResponseCode();
      if (code === 200) return { ok: true, body: JSON.parse(res.getContentText() || '{}') };
      last = 'server answered ' + code;
      if (code === 401 || code === 400 || code === 404) break;
    } catch (e) {
      last = e.message;
    }
    if (attempt + 1 < (attempts || 1)) Utilities.sleep(1500);
  }
  return { ok: false, error: last };
}
