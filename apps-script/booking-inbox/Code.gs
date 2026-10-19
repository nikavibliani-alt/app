/**
 * Maxela Booking.com inbox, steps 1 and 4: collect emails, send replies.
 *
 * Runs inside the Gmail account that receives Booking.com emails. The trigger runs every minute, but an
 * idle minute is cheap: the mailbox history id is compared first and the mail is only read when it changed
 * (at least every 10 minutes anyway), and the backup check for waiting replies runs about every 5th minute.
 *   1. asks the Cloud Function inboxOutbox for replies I wrote in the inbox screen and sends each
 *      one as a plain-text email with an empty subject to the guest's Booking.com address (step 4).
 *      The same thing also runs at once when the web app (doPost) is poked after I tap Send, then
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
// Keeping the daily run time low (a free Gmail account gets about 90 minutes of trigger time a day).
var PULL_EVERY_MS = 4.5 * 60 * 1000;      // backup check for waiting replies about every 5th minute (instant sending goes through doPost)
var FULL_CHECK_EVERY_MS = 10 * 60 * 1000; // read the mail even if the mailbox looks unchanged, at least this often (safety net)
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
  var props = PropertiesService.getScriptProperties();
  var now = Date.now();

  // 1. Replies: only about every 5th minute. Instant sending goes through doPost; this is the backup,
  //    and the server also counts each of these calls as "the script is alive" (see inboxScriptWatch).
  if (now - Number(props.getProperty('LAST_PULL_MS') || 0) >= PULL_EVERY_MS) {
    props.setProperty('LAST_PULL_MS', String(now));
    withLock_(5000, function () {
      try { sendReplies_('trigger'); } catch (e) { Logger.log('Replies step failed: ' + e.message); }
    });
  }

  // 2. New mail: skip the Gmail search when the mailbox has not changed since the last full check.
  var marker = mailboxMarker_();                       // the mailbox "history id", or '' if it cannot be read
  var lastFull = Number(props.getProperty('LAST_FULL_MS') || 0);
  if (marker && marker === props.getProperty('LAST_HISTORY_ID') && now - lastFull < FULL_CHECK_EVERY_MS) return;
  var complete = false;
  var locked = withLock_(5000, function () { complete = run_() === true; });
  if (locked && complete) {
    // Only when the run caught up completely; after a failure or a time-out the next minute tries again.
    // The marker was read BEFORE the run, so a change during the run forces the next one.
    props.setProperties({ LAST_FULL_MS: String(now), LAST_HISTORY_ID: marker });
  }
}

/**
 * A cheap "did anything change in this mailbox?" number: the history id from the Gmail API
 * (Advanced Gmail service, one small call). Returns '' when the service is not on or fails, which
 * means "do the full check every time", exactly like before.
 */
function mailboxMarker_() {
  try {
    if (typeof Gmail === 'undefined') return '';
    return String(Gmail.Users.getProfile('me').historyId || '');
  } catch (e) {
    Logger.log('Mailbox marker unavailable (full check every run): ' + e.message);
    return '';
  }
}

/** Runs fn while holding the script lock. Returns false if the lock could not be had in time. */
function withLock_(waitMs, fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(waitMs)) { Logger.log('Another run is still going.'); return false; }
  try {
    fn();
  } finally {
    lock.releaseLock();
  }
  return true;
}

/**
 * Web app entry (Deploy > New deployment > Web app). The inboxSendReply Cloud Function calls it
 * right after I tap Send, so the reply goes out at once instead of at the next minute. It must
 * send the same key as INGEST_KEY. It only sends what the server hands out as "waiting", so it
 * cannot send anything the inbox did not queue, and the every-minute run stays as a backup.
 */
function doPost(e) {
  var out = function (o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); };
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var key = PropertiesService.getScriptProperties().getProperty('INGEST_KEY');
    if (!key || !body.key || String(body.key) !== key) return out({ ok: false, error: 'unauthorized' });
    if (body.action !== 'sendNow') return out({ ok: false, error: 'bad action' });
    var ran = withLock_(20000, function () { sendReplies_('webapp'); });
    return out({ ok: true, ran: ran });
  } catch (err) {
    return out({ ok: false, error: String(err && err.message || err).slice(0, 200) });
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
  var caughtUp = false;

  while (true) {
    var safeNow = Date.now() - SAFE_LAG_MS;
    if (cursor >= safeNow) { caughtUp = true; break; }
    var winEnd = Math.min(cursor + WINDOW_MS, safeNow);

    var msgs = collect_(cursor - OVERLAP_MS, winEnd, recent, started);
    if (msgs === null) break;                       // out of time while reading Gmail

    for (var i = 0; i < msgs.length; i++) {
      if (Date.now() - started > TIME_BUDGET_MS) { save_(props, cursor, recent); Logger.log('Time is up, sent ' + sent + '. Continuing next run.'); return; }
      var m = msgs[i];
      var result = post_(url, key, safePayload_(m.msg));
      if (!result.ok) { save_(props, cursor, recent); Logger.log('Stopped: ' + result.error + ' (sent ' + sent + ').'); return; }
      sent++;
      recent.push(m.id);
      if (recent.length > MAX_RECENT_IDS) recent.shift();
      if (m.time > cursor) cursor = m.time;
      save_(props, cursor, recent);
    }
    cursor = Math.max(cursor, winEnd);              // this window is finished
    save_(props, cursor, recent);
    // The window reached "now minus 1 minute": nothing newer to look at. Stop here. (Without this the loop
    // kept chasing "now" and searched Gmail hundreds of times per run until the time budget ran out.)
    if (winEnd >= safeNow) { caughtUp = true; break; }
    if (Date.now() - started > TIME_BUDGET_MS) break;
  }
  Logger.log('Done. Sent ' + sent + ' email(s). Up to date until ' + new Date(cursor));
  return caughtUp;
}

function save_(props, cursor, recent) {
  props.setProperties({ CURSOR_MS: String(cursor), RECENT_IDS: JSON.stringify(recent) });
}

// ---------------------------------------------------------------- Gmail

/**
 * Reading mail uses the Gmail API (the Advanced Gmail service), not GmailApp. GmailApp has a daily
 * "Service invoked too many times: gmail" limit that the old looping version used up; the API has its own
 * generous limits, and one call returns the whole message.
 */

/** Booking.com messages dated in [fromMs, toMs) (Gmail arrival time), oldest first. Returns null if time ran out. */
function collect_(fromMs, toMs, recent, started) {
  var q = SENDER_QUERY + ' after:' + Math.floor(fromMs / 1000) + ' before:' + (Math.ceil(toMs / 1000) + 1);
  var refs = [];
  var pageToken;
  do {
    if (Date.now() - started > TIME_BUDGET_MS) return null;
    var res = Gmail.Users.Messages.list('me', { q: q, maxResults: 100, pageToken: pageToken });
    (res.messages || []).forEach(function (m) { refs.push(m.id); });
    pageToken = res.nextPageToken;
  } while (pageToken);

  var seen = {};
  var out = [];
  for (var i = 0; i < refs.length; i++) {
    var id = refs[i];
    if (seen[id] || recent.indexOf(id) !== -1) continue;
    if (Date.now() - started > TIME_BUDGET_MS) return null;
    var msg;
    try {
      msg = Gmail.Users.Messages.get('me', id, { format: 'full' });
    } catch (e) {
      Logger.log('Skipped message ' + id + ' (could not load it): ' + (e && e.message));   // e.g. deleted since the search
      continue;
    }
    var time = Number(msg.internalDate);
    if (!(time >= fromMs && time < toMs)) continue;
    if (!SENDER_RE.test(mimeWords_(apiHeaders_(msg)['from'] || ''))) continue;
    seen[id] = true;
    out.push({ id: id, time: time, msg: msg });
  }
  out.sort(function (a, b) { return a.time - b.time; });
  return out;
}

/** Header name (lower case) -> first value, from a Gmail API message. */
function apiHeaders_(msg) {
  var h = {};
  ((msg.payload && msg.payload.headers) || []).forEach(function (x) {
    var n = String(x.name).toLowerCase();
    if (!(n in h)) h[n] = x.value;
  });
  return h;
}

/** RFC 2047 encoded words in a header ("=?UTF-8?B?...?=") as plain text. */
function mimeWords_(s) {
  s = String(s || '');
  if (s.indexOf('=?') === -1) return s;
  s = s.replace(/(\?=)\s+(=\?)/g, '$1$2');
  return s.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, function (m, cs, enc, txt) {
    try {
      var bytes;
      if (enc.toUpperCase() === 'B') {
        bytes = Utilities.base64Decode(txt);
      } else {
        var t = txt.replace(/_/g, ' ');
        bytes = [];
        for (var i = 0; i < t.length; i++) {
          var c = t.charAt(i);
          if (c === '=' && /^[0-9a-fA-F]{2}$/.test(t.substr(i + 1, 2))) { bytes.push(parseInt(t.substr(i + 1, 2), 16)); i += 2; }
          else bytes.push(t.charCodeAt(i));
        }
        bytes = bytes.map(function (b) { return b > 127 ? b - 256 : b; });
      }
      return Utilities.newBlob(bytes).getDataAsString(cs);
    } catch (e) {
      return m;
    }
  });
}

/**
 * Message data from the Advanced Gmail service as bytes. It can arrive as a web-safe base64 string
 * (with or without "=" padding) or already as a byte array, so both are handled. Returns null if it
 * cannot be read (the caller skips that part).
 */
function dataBytes_(data) {
  if (data === null || data === undefined || data === '') return null;
  if (typeof data === 'string') {
    var s = data.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    try { return Utilities.base64Decode(s); } catch (e1) { /* try the other decoder */ }
    try { return Utilities.base64DecodeWebSafe(s); } catch (e2) { return null; }
  }
  if (typeof data.length === 'number') return Array.prototype.slice.call(data);   // a byte array
  return null;
}

function charsetOf_(part) {
  var ct = '';
  (part.headers || []).forEach(function (x) { if (String(x.name).toLowerCase() === 'content-type') ct = x.value; });
  var m = String(ct).match(/charset\s*=\s*"?([^";\s]+)/i);
  return m ? m[1] : 'UTF-8';
}

/**
 * The text of one body part (inline data, or fetched when Gmail stores a big part as an attachment).
 * Never throws: a part that cannot be read is skipped (undefined) and logged.
 */
function partText_(msgId, part) {
  try {
    var data = part.body && part.body.data;
    if (!dataBytes_(data) && part.body && part.body.attachmentId) {
      data = Gmail.Users.Messages.Attachments.get('me', msgId, part.body.attachmentId).data;
    }
    var bytes = dataBytes_(data);
    if (!bytes) return undefined;
    try { return Utilities.newBlob(bytes).getDataAsString(charsetOf_(part)); }
    catch (e) { return Utilities.newBlob(bytes).getDataAsString('UTF-8'); }
  } catch (err) {
    Logger.log('Skipped a message part that could not be read (message ' + msgId + ', ' + (part && part.mimeType) + '): ' + (err && err.message));
    return undefined;
  }
}

/** First text/plain and first text/html part (not attachments), looking through nested multiparts. */
function bodies_(msgId, part, out) {
  if (!part) return out;
  if (part.parts && part.parts.length) { part.parts.forEach(function (p) { bodies_(msgId, p, out); }); return out; }
  if (part.filename) return out;
  var mime = String(part.mimeType || '').toLowerCase();
  if (mime === 'text/plain' && out.text === undefined) out.text = partText_(msgId, part);
  else if (mime === 'text/html' && out.html === undefined) out.html = partText_(msgId, part);
  return out;
}

function htmlToText_(html) {
  return String(html || '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n\s+/g, '\n').trim();
}

/**
 * toPayload_, but a message that cannot be read at all is still saved (with the headers and an empty
 * body) so the server puts it in the "check this" pile. It never stops the run.
 */
function safePayload_(msg) {
  try {
    return toPayload_(msg);
  } catch (e) {
    Logger.log('Could not read message ' + (msg && msg.id) + ', saving it without a body: ' + (e && e.message));
    var h = {};
    try { h = apiHeaders_(msg); } catch (e2) { /* headers unreadable too */ }
    var d = new Date(Number(msg && msg.internalDate));
    return {
      gmailMessageId: String(msg && msg.id),
      gmailThreadId: String((msg && msg.threadId) || ''),
      date: (isNaN(d.getTime()) ? new Date() : d).toISOString(),
      from: mimeWords_(h['from'] || ''), to: mimeWords_(h['to'] || ''),
      replyTo: mimeWords_(h['reply-to'] || h['from'] || ''), subject: mimeWords_(h['subject'] || ''),
      bodyText: '', bodyHtml: '', headers: {}
    };
  }
}

function toPayload_(msg) {
  var h = apiHeaders_(msg);
  var b = bodies_(msg.id, msg.payload, {});
  var date = new Date(h['date'] || '');
  if (isNaN(date.getTime())) date = new Date(Number(msg.internalDate));
  var from = mimeWords_(h['from'] || '');
  return {
    gmailMessageId: msg.id,
    gmailThreadId: msg.threadId,
    date: date.toISOString(),
    from: from,
    to: mimeWords_(h['to'] || ''),
    replyTo: mimeWords_(h['reply-to'] || h['from'] || ''),
    subject: mimeWords_(h['subject'] || ''),
    bodyText: String(b.text !== undefined ? b.text : htmlToText_(b.html)).slice(0, MAX_TEXT),
    bodyHtml: String(b.html || '').slice(0, MAX_HTML),
    headers: keptHeaders_(msg)
  };
}

/** The few headers we care about (raw, as in the message). */
function keptHeaders_(msg) {
  var out = {};
  ((msg.payload && msg.payload.headers) || []).forEach(function (x) {
    var name = String(x.name).toLowerCase();
    if ((KEEP_HEADERS.indexOf(name) !== -1 || name.indexOf('x-booking') === 0) && !(name in out)) {
      out[name] = String(x.value).slice(0, 1000);
    }
  });
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
function sendReplies_(source) {
  var props = PropertiesService.getScriptProperties();
  var key = props.getProperty('INGEST_KEY');
  var url = props.getProperty('OUTBOX_URL') || OUTBOX_URL_DEFAULT;
  if (!key) return;

  var pulled = outbox_(url, key, { action: 'pull', source: source || 'trigger' });
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

    var meta = Gmail.Users.Messages.get('me', item.gmailMessageId, { format: 'metadata', metadataHeaders: ['Reply-To', 'From'] });
    var mh = apiHeaders_(meta);
    if (addr_(mimeWords_(mh['reply-to'] || mh['from'] || '')) !== expected) return { ok: false, error: 'The guest email has a different reply address.' };

    // Booking.com shows the subject inside the guest chat, so the reply has an empty subject.
    // GmailMessage.reply always adds "Re: <subject>", so this is a new plain email to the guest address.
    var how = sendPlain_(expected, text);
    Logger.log('Sent with ' + how + ' subject.');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: 'Gmail error: ' + String(e && e.message || e).slice(0, 200) };
  }
}

/** Plain text, empty subject, no signature, no quoted text. Sent through the Gmail API (not GmailApp). */
function sendPlain_(to, text) {
  var body = Utilities.base64Encode(text, Utilities.Charset.UTF_8).replace(/(.{76})/g, '$1\r\n');
  var mime = ['To: ' + to, 'Subject: ', 'MIME-Version: 1.0', 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', body].join('\r\n');
  Gmail.Users.Messages.send({ raw: Utilities.base64EncodeWebSafe(mime, Utilities.Charset.UTF_8) }, 'me');
  return 'an empty';
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
