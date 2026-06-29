#!/usr/bin/env python3
"""
minihotel_reservation_sync.py

Syncs reservations from MiniHotel Calendar API directly to Firestore.
Replaces the email parsing + XLSX scraping pipeline.

Runs as a GitHub Action on schedule (every 30 min).
Requires: FIREBASE_SERVICE_ACCOUNT, MINIHOTEL_USER, MINIHOTEL_PASS, MINIHOTEL_HOTEL secrets.
"""

import os, sys, json, base64, datetime, time
import requests
from bs4 import BeautifulSoup
import firebase_admin
from firebase_admin import credentials, firestore

# ── Config ──
HOTEL_CODE = os.environ.get('MINIHOTEL_HOTEL', 'freedo45')
USERNAME = os.environ.get('MINIHOTEL_USER', '')
PASSWORD = os.environ.get('MINIHOTEL_PASS', '')

# ── Room name mapping: MiniHotel → Firestore ──
ROOM_MAP = {
    '0-1': '0-1', '0-2': '0-2', '0-3': '0-3', '0-4': '0-4', '0-5': '0-5',
    'M-6-1': '6-1', 'M-6-2': '6-2', 'M-6-3': '6-3', 'M-6-4': '6-4',
    'M-7-1': '7-1', 'M-7-2': '7-2', 'M-7-4': '7-4',
    'T-1': 'tab-1', 'T-2': 'tab-2', 'T-3': 'tab-3',
    'Midamo 1': 'orb-1', 'Midamo 2': 'orb-2', 'Midamo 3': 'orb-3',
    'VGL_ST1': 'vgl-st1', 'VGL_ST2': 'vgl-st2',
    'VGL_AP3': 'vgl-ap3', 'VGL_AP4': 'vgl-ap4',
}

SKIP_ROOMS = {'VGL_ST1', 'VGL_ST2', 'VGL_AP3', 'VGL_AP4'}
VALID_STATUSES = {'OK', 'OK2', 'CL', 'WL'}


def parse_date(d):
    """Convert MiniHotel YYYYMMDD → YYYY-MM-DD"""
    if not d or len(d) != 8:
        return None
    return f"{d[:4]}-{d[4:6]}-{d[6:]}"


def init_firestore():
    sa_base64 = os.environ.get('FIREBASE_SERVICE_ACCOUNT')
    if not sa_base64:
        print("ERROR: FIREBASE_SERVICE_ACCOUNT not set")
        sys.exit(1)
    sa_json = json.loads(base64.b64decode(sa_base64))
    cred = credentials.Certificate(sa_json)
    firebase_admin.initialize_app(cred)
    return firestore.client()


def login_minihotel():
    """Log into MiniHotel using requests session (same as housekeeper_sync.py)."""
    if not USERNAME or not PASSWORD:
        print("ERROR: MINIHOTEL_USER or MINIHOTEL_PASS not set")
        sys.exit(1)

    print("Logging into MiniHotel...")
    session = requests.Session()

    # GET login page to scrape ASP.NET hidden fields
    r = session.get('https://login.minihotel.cloud/login.aspx')
    soup = BeautifulSoup(r.text, 'html.parser')

    # POST login form
    session.post('https://login.minihotel.cloud/login.aspx', data={
        '__EVENTTARGET': 'LoginButton',
        '__EVENTARGUMENT': '',
        '__VIEWSTATE': soup.find('input', {'id': '__VIEWSTATE'})['value'],
        '__VIEWSTATEGENERATOR': soup.find('input', {'id': '__VIEWSTATEGENERATOR'})['value'],
        '__EVENTVALIDATION': soup.find('input', {'id': '__EVENTVALIDATION'})['value'],
        'txt_hotel_code': HOTEL_CODE,
        'txt_username': USERNAME,
        'txt_password': PASSWORD,
        'hdd_language': 'en',
        'txt_agent_username': '',
        'txt_agent_password': '',
    })

    print("Logged in")
    return session


def fetch_reservations(session, from_date, to_date):
    """Call the MiniHotel Reservations API."""
    from_iso = f"{from_date}T20:00:00.000Z"
    to_iso = f"{to_date}T20:00:00.000Z"

    url = (
        f"https://ssl20.minihotelpms.com/api/Reservations"
        f"?FromDate={from_iso}&ToDate={to_iso}"
    )
    print(f"Fetching reservations: {from_date} → {to_date}")

    r = session.get(url, headers={'Accept': 'application/json', 'Content-Type': 'application/json'})

    if r.status_code != 200:
        print(f"ERROR: API returned {r.status_code}")
        print(r.text[:500])
        sys.exit(1)

    data = r.json()
    reservations = data.get('reservations', [])
    rooms = data.get('rooms', [])
    print(f"Got {len(reservations)} reservations, {len(rooms)} rooms")
    return reservations


def transform_reservation(r):
    """Transform a MiniHotel reservation to Firestore format."""
    room_mh = r.get('roomNumber', '')
    room_code = ROOM_MAP.get(room_mh)
    if not room_code:
        return None

    checkin = parse_date(r.get('checkIn'))
    checkout = parse_date(r.get('checkOut'))
    if not checkin or not checkout:
        return None

    first = (r.get('firstName') or '').strip()
    last = (r.get('lastName') or '').strip()
    guest = f"{first} {last}".strip()

    try:
        ci = datetime.datetime.strptime(checkin, '%Y-%m-%d')
        co = datetime.datetime.strptime(checkout, '%Y-%m-%d')
        nights = (co - ci).days
    except:
        nights = 0

    return {
        'reservationNumber': r.get('reservationNumber', ''),
        'firstName': first,
        'lastName': last,
        'guest': guest,
        'roomCode': room_code,
        'allRooms': room_code,
        'checkin': checkin,
        'checkout': checkout,
        'nights': nights,
        'source': (r.get('source') or '').lower(),
        'status': r.get('status', ''),
        'statusDescription': r.get('statusDescription', ''),
        'total': f"{r.get('balance', {}).get('currency', 'USD')} {r.get('balance', {}).get('debit', 0):.2f}",
        'currency': r.get('balance', {}).get('currency', 'USD'),
        'debit': r.get('balance', {}).get('debit', 0),
        'credit': r.get('balance', {}).get('credit', 0),
        'board': r.get('board', ''),
        'creationDate': parse_date(r.get('creationDate')),
        'minihotelRoom': room_mh,
        'syncSource': 'minihotel_api',
        'syncedAt': firestore.SERVER_TIMESTAMP,
    }


def sync_to_firestore(db, reservations):
    """Write/update reservations in Firestore using reservationNumber as doc ID."""
    coll = db.collection('reservations')
    batch = db.batch()
    count = 0
    skipped = 0

    for r in reservations:
        if r.get('roomNumber', '') in SKIP_ROOMS:
            skipped += 1
            continue

        if r.get('status', '') not in VALID_STATUSES:
            skipped += 1
            continue

        doc = transform_reservation(r)
        if not doc:
            skipped += 1
            continue

        # Doc ID: reservationNumber, append memberId for multi-room bookings
        doc_id = doc['reservationNumber']
        member_id = r.get('memberId', '')
        if member_id:
            doc_id = f"{doc_id}_{member_id}"

        ref = coll.document(doc_id)
        existing = ref.get()
        if existing.exists and existing.to_dict().get('manualRoom'):
            doc.pop('roomCode', None)
            doc.pop('allRooms', None)
            doc.pop('minihotelRoom', None)
        batch.set(ref, doc, merge=True)
        count += 1

        if count % 450 == 0:
            batch.commit()
            batch = db.batch()
            print(f"  Committed {count} docs...")

    if count % 450 != 0:
        batch.commit()

    print(f"Synced {count} reservations, skipped {skipped}")
    return count


def detect_cancellations(db, api_reservations, from_date, to_date):
    """Mark Firestore reservations as cancelled if they're not in the API response.
    Also deletes old non-API docs that have no matching API reservation (one-time cleanup)."""
    coll = db.collection('reservations')

    # Build lookup sets from the API response
    active_checkout_keys = set()   # roomCode_checkout — for cancellation detection
    active_checkin_keys = set()    # roomCode_checkin  — for old-doc cleanup
    for r in api_reservations:
        room_code = ROOM_MAP.get(r.get('roomNumber', ''))
        checkin = parse_date(r.get('checkIn'))
        checkout = parse_date(r.get('checkOut'))
        if room_code and checkout:
            active_checkout_keys.add(f"{room_code}_{checkout}")
        if room_code and checkin:
            active_checkin_keys.add(f"{room_code}_{checkin}")

    # ── Cancellation check: API docs no longer in MiniHotel ──────────────────
    snap = coll \
        .where('checkout', '>=', from_date) \
        .where('checkout', '<=', to_date) \
        .where('syncSource', '==', 'minihotel_api') \
        .get()

    batch = db.batch()
    cancelled = 0

    for doc in snap:
        data = doc.to_dict()
        key = f"{data.get('roomCode')}_{data.get('checkout')}"
        if key not in active_checkout_keys and data.get('status') != 'CANCELLED':
            batch.update(doc.reference, {
                'status': 'CANCELLED',
                'statusDescription': 'Cancelled (not in MiniHotel)',
                'syncedAt': firestore.SERVER_TIMESTAMP,
            })
            cancelled += 1
            print(f"  Cancelled: {data.get('guest')} | {data.get('roomCode')} | {data.get('checkout')}")

    if cancelled > 0:
        batch.commit()
    print(f"Detected {cancelled} cancellations")

    # ── Old-doc cleanup: non-API docs with no API equivalent ─────────────────
    # Collect old docs in the date window from known legacy syncSource values
    old_docs = []
    for old_src in ['reservations_query', 'old_parser']:
        old_snap = coll \
            .where('checkout', '>=', from_date) \
            .where('checkout', '<=', to_date) \
            .where('syncSource', '==', old_src) \
            .get()
        old_docs.extend(old_snap)

    # Also pick up docs with no syncSource field (can't query directly, so
    # fetch all in range and filter client-side)
    seen_ids = {d.id for d in old_docs}
    all_range = coll \
        .where('checkout', '>=', from_date) \
        .where('checkout', '<=', to_date) \
        .get()
    for doc in all_range:
        if doc.id not in seen_ids and 'syncSource' not in doc.to_dict():
            old_docs.append(doc)

    batch2 = db.batch()
    deleted = 0
    for doc in old_docs:
        d = doc.to_dict()
        key = f"{d.get('roomCode')}_{d.get('checkin')}"
        if key not in active_checkin_keys:
            batch2.delete(doc.reference)
            deleted += 1
            print(f"  Deleted old doc (no API match): {doc.id} | {d.get('guest')} | {d.get('roomCode')} | {d.get('checkin')}→{d.get('checkout')}")

    if deleted > 0:
        batch2.commit()
    print(f"Cleaned {deleted} old non-API docs with no API equivalent")


def cleanup_old_duplicates(db):
    """Remove old parser/query docs that have a matching minihotel_api doc."""
    coll = db.collection('reservations')

    # Get all API-synced reservations
    api_snap = coll.where('syncSource', '==', 'minihotel_api').get()
    api_keys = {}
    for doc in api_snap:
        d = doc.to_dict()
        key = f"{d.get('roomCode')}_{d.get('checkin')}_{d.get('checkout')}"
        api_keys[key] = True

    # Find old docs that have a matching API doc
    old_sources = ['old_parser', 'reservations_query', None]
    batch = db.batch()
    deleted = 0

    for source in ['old_parser', 'reservations_query']:
        snap = coll.where('syncSource', '==', source).get()
        for doc in snap:
            d = doc.to_dict()
            key = f"{d.get('roomCode')}_{d.get('checkin')}_{d.get('checkout')}"
            if key in api_keys:
                batch.delete(doc.reference)
                deleted += 1

    # Also check docs without syncSource field
    all_snap = coll.get()
    for doc in all_snap:
        d = doc.to_dict()
        if 'syncSource' not in d:
            key = f"{d.get('roomCode')}_{d.get('checkin')}_{d.get('checkout')}"
            if key in api_keys:
                batch.delete(doc.reference)
                deleted += 1

    if deleted > 0:
        batch.commit()
    print(f"Cleaned up {deleted} old duplicate docs")


def fetch_guest_details(session, db, reservations):
    """Fetch phone/email/country for reservations checking in within 7 days."""
    now = datetime.datetime.utcnow()
    cutoff = (now + datetime.timedelta(days=7)).strftime('%Y-%m-%d')
    today = now.strftime('%Y-%m-%d')

    # Only reservations checking in today or within 7 days, in a known room
    targets = [
        r for r in reservations
        if ROOM_MAP.get(r.get('roomNumber', ''))
        and r.get('status', '') in VALID_STATUSES
        and r.get('roomNumber', '') not in SKIP_ROOMS
        and today <= (parse_date(r.get('checkIn')) or '') <= cutoff
    ]
    print(f"Fetching guest details for {len(targets)} reservations (checkin within 7 days)")

    coll = db.collection('reservations')
    updated = skipped = errors = 0

    for r in targets:
        res_num = str(r.get('reservationNumber', '')).strip()
        member_id = r.get('memberId', '')
        doc_id = f"{res_num}_{member_id}" if member_id else res_num
        if not doc_id:
            continue

        # Skip if phone already stored
        doc_ref = coll.document(doc_id)
        try:
            snap = doc_ref.get()
            if snap.exists and snap.to_dict().get('phone'):
                skipped += 1
                continue
        except Exception as e:
            print(f"  Firestore read error for {doc_id}: {e}")
            errors += 1
            continue

        # Call MiniHotel detail endpoint
        try:
            resp = session.post(
                'https://ssl20.minihotelpms.com/ajax/request_reservation_info.aspx/get_reservation_info',
                json={'reservation_id': res_num},
                headers={'Content-Type': 'application/json', 'Accept': 'application/json'},
            )
            if resp.status_code != 200:
                print(f"  Detail API error {resp.status_code} for {doc_id}")
                errors += 1
                time.sleep(1)
                continue

            outer = resp.json()
            inner_raw = outer.get('d', '{}')
            inner = json.loads(inner_raw) if isinstance(inner_raw, str) else inner_raw
            guest_info = inner.get('reservation', {}).get('PrimaryGuest', {})

            phone   = (guest_info.get('phone') or '').strip()
            email   = (guest_info.get('email') or '').strip()
            country = (guest_info.get('Country_iso2') or '').strip()
            guest_count = inner.get('reservation', {}).get('guestsCounts')

            update = {}
            if phone:   update['phone'] = phone
            if email:   update['email'] = email
            if country: update['country'] = country
            if guest_count is not None: update['guestCount'] = guest_count

            if update:
                doc_ref.set(update, merge=True)
                print(f"  {doc_id}: phone={phone or '—'} email={email or '—'} country={country or '—'}")
                updated += 1
            else:
                print(f"  {doc_id}: no contact details returned")
                skipped += 1

        except Exception as e:
            print(f"  Error fetching details for {doc_id}: {e}")
            errors += 1

        time.sleep(1)

    print(f"Guest details: {updated} updated, {skipped} skipped, {errors} errors")


def main():
    now = datetime.datetime.utcnow()
    print(f"Starting MiniHotel reservation sync at {now.isoformat()}")

    from_dt = now - datetime.timedelta(days=7)
    to_dt = now + datetime.timedelta(days=60)
    from_date = from_dt.strftime('%Y-%m-%d')
    to_date = to_dt.strftime('%Y-%m-%d')
    print(f"Date range: {from_date} → {to_date}")

    db = init_firestore()
    session = login_minihotel()
    reservations = fetch_reservations(session, from_date, to_date)
    synced = sync_to_firestore(db, reservations)

    # Fetch phone/email/country for upcoming check-ins
    fetch_guest_details(session, db, reservations)

    # Detect cancellations
    detect_cancellations(db, reservations, from_date, to_date)

    # Clean up old duplicates (run once, then can be removed)
    cleanup_old_duplicates(db)

    print(f"Done. {synced} reservations synced.")


if __name__ == '__main__':
    main()
