# Code.gs — Email Parser Fix: bookingId → reservationNumber as doc ID

The email parser (Maxela Reservations Apps Script) currently creates Firestore
reservation documents using `bookingId` as the document ID, causing duplicates
when `import-reservations.html` (and `housekeeper_sync.py`) use `reservationNumber`.

## What to change in your Google Apps Script project

### Find the Firestore write function

Look for the function that writes a new reservation to Firestore. It will look
roughly like one of these patterns:

**Pattern A — using `addDoc` via Firestore REST (POST):**
```javascript
// OLD — creates a new doc with a random Firestore ID
const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/reservations`;
UrlFetchApp.fetch(url, {
  method: 'post',
  headers: { Authorization: `Bearer ${token}` },
  contentType: 'application/json',
  payload: JSON.stringify({ fields: { bookingId: { stringValue: bookingId }, ... } }),
});
```

**Pattern B — using `bookingId` as the doc ID (PATCH to wrong path):**
```javascript
// OLD — uses bookingId as the document path
const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/reservations/${bookingId}`;
UrlFetchApp.fetch(url, { method: 'patch', ... });
```

---

### Replace with this pattern

Use `reservationNumber` as the document ID, and use PATCH (not POST) so that
re-runs update the existing doc instead of creating a duplicate.

```javascript
/**
 * Write (or update) a reservation in Firestore using reservationNumber as doc ID.
 * Uses PATCH with updateMask so only listed fields are touched — safe to re-run.
 *
 * @param {string} token  - OAuth2 access token
 * @param {Object} data   - parsed reservation fields
 */
function upsertReservation_(token, data) {
  const resNum = (data.reservationNumber || '').trim();
  if (!resNum) {
    Logger.log('SKIP — no reservationNumber, cannot set doc ID: ' + JSON.stringify(data));
    return null;
  }

  const PROJECT_ID = 'sleepy-5c962';
  const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
  const url = `${BASE}/reservations/${resNum}`;

  // Fields to write — add/remove as needed to match what your parser extracts
  const fields = {
    reservationNumber: { stringValue: resNum },
    bookingId:         { stringValue: data.bookingId || '' },
    guest:             { stringValue: data.guest || '' },
    checkin:           { stringValue: data.checkin || '' },
    checkout:          { stringValue: data.checkout || '' },
    roomCode:          { stringValue: data.roomCode || '' },
    propertyId:        { stringValue: data.propertyId || '' },
    source:            { stringValue: data.source || '' },
    price:             { doubleValue: data.price || 0 },
    currency:          { stringValue: data.currency || 'GEL' },
    guests:            { integerValue: data.guests || 1 },
    notes:             { stringValue: data.notes || '' },
    updatedAt:         { timestampValue: new Date().toISOString() },
  };

  // updateMask ensures we only touch these fields (preserves roomCode set by HK sync)
  const fieldPaths = Object.keys(fields).concat(['updatedAt']);
  const mask = fieldPaths.map(f => `updateMask.fieldPaths=${encodeURIComponent(f)}`).join('&');

  // First check if the doc already exists so we can preserve createdAt
  const existing = UrlFetchApp.fetch(`${url}`, {
    method: 'get',
    headers: { Authorization: `Bearer ${token}` },
    muteHttpExceptions: true,
  });

  if (existing.getResponseCode() === 404) {
    // New doc — also set createdAt
    fields.createdAt = { timestampValue: new Date().toISOString() };
    fieldPaths.push('createdAt');
  }

  const resp = UrlFetchApp.fetch(`${url}?${mask}`, {
    method: 'patch',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    payload: JSON.stringify({ fields }),
    muteHttpExceptions: true,
  });

  const code = resp.getResponseCode();
  if (code < 300) {
    Logger.log(`Upserted reservation ${resNum} (${data.guest})`);
  } else {
    Logger.log(`Failed to upsert ${resNum}: HTTP ${code} — ${resp.getContentText()}`);
  }
  return code;
}
```

### How to wire it in

Replace every call that currently does:
```javascript
// OLD
createReservation(token, { bookingId: bid, guest: name, ... });
// or
addReservationDoc(token, bookingId, fields);
```

With:
```javascript
// NEW
upsertReservation_(token, {
  reservationNumber: resNum,   // <-- the PMS reservation number, NOT bookingId
  bookingId: bid,              // keep bookingId as a stored field, not the doc ID
  guest: name,
  checkin: checkin,
  checkout: checkout,
  // ... rest of fields
});
```

### If your parser doesn't extract reservationNumber

Check the email body/subject for the reservation number (usually labelled
"Reservation No.", "Res #", "Booking Reference", etc.). Add a regex to extract it:

```javascript
const resNumMatch = emailBody.match(/[Rr]es(?:ervation)?\s*[#No.]*\s*[:\-]?\s*(\d+)/);
const reservationNumber = resNumMatch ? resNumMatch[1] : '';
```

If the email truly has no reservation number, you can fall back to using
`bookingId` — but prefix it to avoid collisions:
```javascript
const docId = reservationNumber || ('bid_' + bookingId);
```

---

## Summary of all Firestore `reservations` writers after this fix

| Script | Doc ID | Method |
|--------|--------|--------|
| Code.gs (email parser) | `reservationNumber` | PATCH (upsert) |
| import-reservations.html | `reservationNumber` | setDoc merge ✅ |
| SleepyPMS.html (manual form) | `reservationNumber` if provided, else random | setDoc / addDoc |
| SleepyPMS.html (iCal sync) | `ical_<icalUid>` | setDoc merge ✅ |
| housekeeper_sync.py | patches only — no new docs | PATCH existing |
| minihotel-xlsx-sync.gs | patches only — no new docs | PATCH existing |
