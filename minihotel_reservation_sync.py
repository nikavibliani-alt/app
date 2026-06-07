#!/usr/bin/env python3
"""
minihotel_reservation_sync.py

Syncs reservations from MiniHotel Calendar API directly to Firestore.
Replaces the email parsing + XLSX scraping pipeline.

Runs as a GitHub Action on schedule (every 30 min).
Requires: FIREBASE_SERVICE_ACCOUNT, MINIHOTEL_USER, MINIHOTEL_PASS secrets.
"""

import os, sys, json, base64, datetime
from playwright.sync_api import sync_playwright
import firebase_admin
from firebase_admin import credentials, firestore

# ── Room name mapping: MiniHotel → Firestore ──
ROOM_MAP = {
    '0-1': '0-1', '0-2': '0-2', '0-3': '0-3', '0-4': '0-4', '0-5': '0-5',
    'M-6-1': '6-1', 'M-6-2': '6-2', 'M-6-3': '6-3', 'M-6-4': '6-4',
    'M-7-1': '7-1', 'M-7-2': '7-2', 'M-7-4': '7-4',
    'T-1': 'tab-1', 'T-2': 'tab-2', 'T-3': 'tab-3',
    'Midamo 1': 'orb-1', 'Midamo 2': 'orb-2', 'Midamo 3': 'orb-3',
    # Venu properties
    'VGL_ST1': 'vgl-st1', 'VGL_ST2': 'vgl-st2',
    'VGL_AP3': 'vgl-ap3', 'VGL_AP4': 'vgl-ap4',
}

# Properties to exclude from sync (Venu = separate business)
SKIP_ROOMS = {'VGL_ST1', 'VGL_ST2', 'VGL_AP3', 'VGL_AP4'}

# Statuses to skip (cancelled, no-show, etc.)
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


def login_minihotel(page):
    """Log into MiniHotel via Playwright, matching housekeeper_sync.py login flow."""
    hotel_code = os.environ.get('MINIHOTEL_HOTEL')
    username   = os.environ.get('MINIHOTEL_USER')
    password   = os.environ.get('MINIHOTEL_PASS')

    if not hotel_code or not username or not password:
        print("ERROR: MINIHOTEL_HOTEL, MINIHOTEL_USER, or MINIHOTEL_PASS not set")
        sys.exit(1)

    print("Logging into MiniHotel...")
    page.goto('https://login.minihotel.cloud/login.aspx')
    page.wait_for_load_state('networkidle')

    page.fill('[name="txt_hotel_code"]', hotel_code)
    page.fill('[name="txt_username"]', username)
    page.fill('[name="txt_password"]', password)
    page.click('[name="LoginButton"]')
    page.wait_for_load_state('networkidle')

    if 'login' in page.url.lower():
        print("ERROR: Login failed — check credentials or selectors")
        sys.exit(1)

    print("Logged in successfully")


def fetch_reservations(page, from_date, to_date):
    """Call the MiniHotel Reservations API using the authenticated browser session."""
    # MiniHotel uses T20:00:00.000Z (midnight Tbilisi = UTC+4)
    from_iso = f"{from_date}T20:00:00.000Z"
    to_iso = f"{to_date}T20:00:00.000Z"

    api_url = (
        f"https://ssl20.minihotelpms.com/api/Reservations"
        f"?FromDate={from_iso}&ToDate={to_iso}"
    )
    print(f"Fetching: {api_url}")

    result = page.evaluate('''
        async (url) => {
            const res = await fetch(url, {
                method: "GET",
                headers: { "Content-Type": "application/json" }
            });
            if (!res.ok) return { error: res.status };
            return await res.json();
        }
    ''', api_url)

    if isinstance(result, dict) and 'error' in result:
        print(f"ERROR: API returned status {result['error']}")
        sys.exit(1)

    reservations = result.get('reservations', [])
    print(f"Got {len(reservations)} reservations from API")
    return reservations


def transform_reservation(r):
    """Transform a MiniHotel reservation to Firestore format."""
    room_mh = r.get('roomNumber', '')
    room_code = ROOM_MAP.get(room_mh)
    if not room_code:
        return None  # Unknown room

    checkin = parse_date(r.get('checkIn'))
    checkout = parse_date(r.get('checkOut'))
    if not checkin or not checkout:
        return None

    first = (r.get('firstName') or '').strip()
    last = (r.get('lastName') or '').strip()
    guest = f"{first} {last}".strip()

    # Calculate nights
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
        # Skip excluded rooms
        if r.get('roomNumber', '') in SKIP_ROOMS:
            skipped += 1
            continue

        # Skip invalid statuses (cancelled, no-show)
        if r.get('status', '') not in VALID_STATUSES:
            skipped += 1
            continue

        doc = transform_reservation(r)
        if not doc:
            skipped += 1
            continue

        # Use reservationNumber as doc ID
        # For multi-room bookings (same reservationNumber), append memberId
        doc_id = doc['reservationNumber']
        member_id = r.get('memberId', '')
        if member_id:
            doc_id = f"{doc_id}_{member_id}"

        ref = coll.document(doc_id)
        batch.set(ref, doc, merge=True)  # merge=True preserves manual fields
        count += 1

        # Firestore batch limit is 500
        if count % 450 == 0:
            batch.commit()
            batch = db.batch()
            print(f"  Committed {count} docs...")

    if count % 450 != 0:
        batch.commit()

    print(f"Synced {count} reservations, skipped {skipped}")
    return count


def main():
    now = datetime.datetime.utcnow()
    print(f"Starting MiniHotel reservation sync at {now.isoformat()}")

    # Date range: 7 days back → 60 days forward
    from_dt = now - datetime.timedelta(days=7)
    to_dt = now + datetime.timedelta(days=60)
    from_date = from_dt.strftime('%Y-%m-%d')
    to_date = to_dt.strftime('%Y-%m-%d')
    print(f"Date range: {from_date} → {to_date}")

    # Init Firestore
    db = init_firestore()

    # Login and fetch via Playwright
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context()
        page = context.new_page()

        login_minihotel(page)
        reservations = fetch_reservations(page, from_date, to_date)

        browser.close()

    # Sync to Firestore
    synced = sync_to_firestore(db, reservations)
    print(f"Done. {synced} reservations synced.")


if __name__ == '__main__':
    main()
