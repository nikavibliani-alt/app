#!/usr/bin/env python3
"""
minihotel_reservation_sync.py

Syncs reservations from MiniHotel Calendar API directly to Firestore.
Replaces the email parsing + XLSX scraping pipeline.

Runs as a GitHub Action on schedule (every 30 min).
Requires: FIREBASE_SERVICE_ACCOUNT, MINIHOTEL_USER, MINIHOTEL_PASS, MINIHOTEL_HOTEL secrets.
"""

import os, sys, json, base64, datetime, time, re
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

# Room code (post-ROOM_MAP) → pricing property type
ROOM_TO_PROPERTY = {}
for _i in range(1, 6):
    ROOM_TO_PROPERTY[f"0-{_i}"] = "ROOMS"
for _i in range(1, 5):
    ROOM_TO_PROPERTY[f"6-{_i}"] = "MAXELA"
ROOM_TO_PROPERTY["6-3"] = "BIG_APT"
for _i in [1, 2, 3]:
    ROOM_TO_PROPERTY[f"tab-{_i}"] = "FREEDOM"
ROOM_TO_PROPERTY["orb-1"] = "ORBE_1"
ROOM_TO_PROPERTY["orb-2"] = "ORBE_1"
ROOM_TO_PROPERTY["orb-3"] = "ORBE_2"
for _i in [1, 2, 4]:
    ROOM_TO_PROPERTY[f"7-{_i}"] = "MAXELA"


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

    # Detect which reservation numbers appear more than once with different valid rooms
    res_num_counts = {}
    for r in reservations:
        if r.get('roomNumber', '') in SKIP_ROOMS:
            continue
        if r.get('status', '') not in VALID_STATUSES:
            continue
        if r.get('roomNumber', '') not in ROOM_MAP:
            continue
        rn = r.get('reservationNumber', '')
        if rn:
            res_num_counts[rn] = res_num_counts.get(rn, 0) + 1

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

        res_num = doc['reservationNumber']
        member_id = r.get('memberId', '')
        is_multi_room = res_num_counts.get(res_num, 1) > 1

        if member_id:
            doc_id = f"{res_num}_{member_id}"
        elif is_multi_room:
            doc_id = f"{res_num}_{doc['roomCode']}"
        else:
            doc_id = res_num

        ref = coll.document(doc_id)
        existing = ref.get()
        payload = dict(doc)
        if existing.exists and existing.to_dict().get('manualRoom'):
            payload.pop('roomCode', None)
            payload.pop('allRooms', None)
            payload.pop('minihotelRoom', None)
        batch.set(ref, payload, merge=True)
        count += 1

        if is_multi_room:
            print(f"  Multi-room: {doc_id} → {doc.get('roomCode')} ({doc.get('guest')})")

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
    Also deletes stale room-move orphan docs and old non-API docs with no API match.

    Returns list of {checkin, property_type} for newly cancelled near-term reservations
    (checkin within 14 days) so the caller can trigger urgent repricing.
    """
    coll = db.collection('reservations')

    # Build lookup sets from the API response
    active_res_nums = set()     # all reservation numbers — no room/status filtering
    active_room_pairs = set()   # "{rn}_{roomCode}" for known-room entries
    active_checkin_keys = set() # "{roomCode}_{checkin}" for old-doc cleanup (unchanged)
    room_code_values = set(ROOM_MAP.values())

    for r in api_reservations:
        rn = str(r.get('reservationNumber', '') or '').strip()
        if rn:
            active_res_nums.add(rn)
        room_code = ROOM_MAP.get(r.get('roomNumber', ''))
        checkin = parse_date(r.get('checkIn'))
        if room_code and rn:
            active_room_pairs.add(f"{rn}_{room_code}")
        if room_code and checkin:
            active_checkin_keys.add(f"{room_code}_{checkin}")

    # ── Cancellation + stale room-move cleanup ────────────────────────────────
    snap = coll \
        .where('checkout', '>=', from_date) \
        .where('checkout', '<=', to_date) \
        .where('syncSource', '==', 'minihotel_api') \
        .get()

    batch = db.batch()
    op_count = 0
    cancelled = 0
    stale_deleted = 0
    near_term_cancellations = []  # {checkin, property_type} for urgent reprice trigger

    today = datetime.datetime.utcnow().date()
    cutoff_14d = (today + datetime.timedelta(days=14)).strftime('%Y-%m-%d')

    for doc in snap:
        data = doc.to_dict()
        rn = str(data.get('reservationNumber') or '').strip()

        if not rn:
            continue  # can't key without a reservation number — skip safely

        if rn not in active_res_nums:
            # Reservation is entirely gone from MiniHotel — true cancellation
            if data.get('status') != 'CANCELLED':
                batch.update(doc.reference, {
                    'status': 'CANCELLED',
                    'statusDescription': 'Cancelled (not in MiniHotel)',
                    'syncedAt': firestore.SERVER_TIMESTAMP,
                })
                cancelled += 1
                op_count += 1
                checkin = data.get('checkin', '')
                room_code = data.get('roomCode', '')
                print(f"  Cancelled: {data.get('guest')} | {room_code} | {data.get('checkout')}")

                # Track near-term cancellations for urgent repricing
                prop_type = ROOM_TO_PROPERTY.get(room_code)
                if prop_type and checkin and checkin <= cutoff_14d:
                    near_term_cancellations.append({
                        'checkin': checkin,
                        'property_type': prop_type,
                    })
        else:
            # Reservation is active — check for stale room-move orphan
            doc_id = doc.id
            if doc_id != rn and doc_id.startswith(rn + '_'):
                suffix = doc_id[len(rn) + 1:]
                if (suffix in room_code_values
                        and f"{rn}_{suffix}" not in active_room_pairs
                        and not data.get('manualRoom')):
                    batch.delete(doc.reference)
                    stale_deleted += 1
                    op_count += 1
                    print(f"  Stale orphan deleted: {doc_id} | {data.get('guest')} | {data.get('roomCode')}")

        if op_count > 0 and op_count % 450 == 0:
            batch.commit()
            batch = db.batch()
            print(f"  Committed {op_count} ops...")

    if op_count % 450 != 0:
        batch.commit()
    print(f"Detected {cancelled} cancellations, deleted {stale_deleted} stale room-move orphans")
    return near_term_cancellations

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


def trigger_urgent_pricing(cancellations: list):
    """Trigger pricing_engine workflow for near-term cancellations via GitHub API."""
    if not cancellations:
        return

    gh_token = os.environ.get('GITHUB_TOKEN', '')
    if not gh_token:
        print('  No GITHUB_TOKEN — skipping urgent pricing trigger')
        return

    affected_props = sorted(set(c['property_type'] for c in cancellations if c.get('property_type')))
    affected_dates = sorted(set(c['checkin'] for c in cancellations if c.get('checkin')))

    if not affected_props:
        return

    gh_repo = os.environ.get('GITHUB_REPOSITORY', 'nikavibliani-alt/app')
    url = f'https://api.github.com/repos/{gh_repo}/actions/workflows/pricing_engine.yml/dispatches'

    try:
        resp = requests.post(url, json={
            'ref': 'main',
            'inputs': {
                'urgent':         'true',
                'property_types': ','.join(affected_props),
                'dates':          ','.join(affected_dates),
            },
        }, headers={
            'Authorization':        f'Bearer {gh_token}',
            'Accept':               'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
        }, timeout=15)

        if resp.status_code == 204:
            print(f'  Urgent pricing triggered: properties={affected_props} dates={affected_dates}')
        else:
            print(f'  Warning: GitHub dispatch returned {resp.status_code}: {resp.text[:200]}', file=sys.stderr)
    except Exception as e:
        print(f'  Warning: could not trigger urgent pricing: {e}', file=sys.stderr)


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


def fetch_booking_ids(session, db, reservations):
    """
    For OTA reservations (source=booking/expedia) in the current sync window that
    are missing bookingId, fetch the detail endpoint and parse remarks.printed.
    Handles multi-room bookings by querying all Firestore docs per reservationNumber.
    """
    ota_sources = {'booking', 'expedia'}
    coll = db.collection('reservations')

    # Deduplicate by reservationNumber — multi-room bookings share one res number
    seen = set()
    targets = []
    for r in reservations:
        if (r.get('source') or '').lower() not in ota_sources:
            continue
        if r.get('status', '') not in VALID_STATUSES:
            continue
        if r.get('roomNumber', '') in SKIP_ROOMS:
            continue
        rn = str(r.get('reservationNumber', '')).strip()
        if rn and rn not in seen:
            seen.add(rn)
            targets.append(rn)

    print(f"Checking bookingId for {len(targets)} OTA reservations...")
    updated = skipped = errors = 0

    for res_num in targets:
        try:
            # Check if ANY Firestore doc for this reservation already has bookingId
            docs = list(coll.where('reservationNumber', '==', res_num).stream())
            if any(d.to_dict().get('bookingId') for d in docs):
                skipped += 1
                continue

            resp = session.get(
                f'https://ssl20.minihotelpms.com/api/Reservations/{res_num}',
                headers={'Accept': 'application/json'},
                timeout=10,
            )
            if resp.status_code != 200:
                print(f"  {res_num}: detail API error {resp.status_code}")
                errors += 1
                time.sleep(0.5)
                continue

            remarks = (resp.json().get('remarks') or {}).get('printed') or ''
            m = re.search(r'Booking id[:\s]+(\d+)', remarks, re.IGNORECASE)
            if not m:
                skipped += 1
                time.sleep(0.5)
                continue

            booking_id = m.group(1)
            for doc in docs:
                doc.reference.set({'bookingId': booking_id}, merge=True)
            print(f"  {res_num}: bookingId={booking_id} ({len(docs)} doc(s))")
            updated += 1

        except Exception as e:
            print(f"  {res_num}: error: {e}")
            errors += 1

        time.sleep(0.5)

    print(f"Booking IDs: {updated} fetched/updated, {skipped} skipped, {errors} errors")


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

    # Fetch Booking.com/Expedia confirmation IDs for OTA reservations
    fetch_booking_ids(session, db, reservations)

    # Detect cancellations and trigger urgent repricing for near-term ones
    near_term = detect_cancellations(db, reservations, from_date, to_date)
    trigger_urgent_pricing(near_term)

    # Clean up old duplicates (run once, then can be removed)
    cleanup_old_duplicates(db)

    print(f"Done. {synced} reservations synced.")


if __name__ == '__main__':
    main()
