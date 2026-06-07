#!/usr/bin/env python3
"""
minihotel_reservation_sync.py

Syncs reservations from MiniHotel Calendar API directly to Firestore.
Replaces the email parsing + XLSX scraping pipeline.

Runs as a GitHub Action on schedule (every 30 min).
Requires: FIREBASE_SERVICE_ACCOUNT, MINIHOTEL_USER, MINIHOTEL_PASS, MINIHOTEL_HOTEL secrets.
"""

import os, sys, json, base64, datetime
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

    r = session.get(url, headers={'Content-Type': 'application/json'})

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
    """Mark Firestore reservations as cancelled if they're not in the API response."""
    coll = db.collection('reservations')

    # Build set of active reservation keys from API
    active_keys = set()
    for r in api_reservations:
        room_mh = r.get('roomNumber', '')
        room_code = ROOM_MAP.get(room_mh)
        checkout = parse_date(r.get('checkOut'))
        if room_code and checkout:
            active_keys.add(f"{room_code}_{checkout}")

    # Query Firestore for reservations in the same date range
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
        if key not in active_keys and data.get('status') != 'CANCELLED':
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

    # Detect cancellations
    detect_cancellations(db, reservations, from_date, to_date)

    # Clean up old duplicates (run once, then can be removed)
    cleanup_old_duplicates(db)

    print(f"Done. {synced} reservations synced.")


if __name__ == '__main__':
    main()
