"""
One-time backfill: fetch Booking.com/Expedia confirmation IDs for all OTA
reservations in Firestore from the last 90 days that are missing bookingId.

Run once: python backfill_booking_ids.py
Requires: FIREBASE_SERVICE_ACCOUNT, MINIHOTEL_USER, MINIHOTEL_PASS, MINIHOTEL_HOTEL
"""
import re, sys, time, datetime, os
sys.path.insert(0, os.path.dirname(__file__))

from minihotel_reservation_sync import login_minihotel, init_firestore, VALID_STATUSES

DAYS_BACK = 90


def main():
    print(f"Backfilling bookingId for OTA reservations (last {DAYS_BACK} days)...")
    db = init_firestore()
    session = login_minihotel()

    coll = db.collection('reservations')
    cutoff = (datetime.datetime.utcnow() - datetime.timedelta(days=DAYS_BACK)).strftime('%Y-%m-%d')

    # Fetch all reservations from the last 90 days and filter client-side
    # (Firestore can't query for missing fields)
    snap = list(coll.where('checkin', '>=', cutoff).stream())
    print(f"Loaded {len(snap)} reservations since {cutoff}")

    # Group docs by reservationNumber, keeping only OTA ones without bookingId
    by_res_num = {}
    for doc in snap:
        d = doc.to_dict()
        if (d.get('source') or '').lower() not in ('booking', 'expedia'):
            continue
        if d.get('bookingId'):
            continue
        rn = d.get('reservationNumber', '')
        if not rn:
            continue
        by_res_num.setdefault(rn, []).append(doc)

    print(f"Found {len(by_res_num)} unique reservations needing bookingId\n")
    updated = skipped = errors = 0

    for res_num, docs in by_res_num.items():
        try:
            import requests
            resp = session.get(
                f'https://ssl20.minihotelpms.com/api/Reservations/{res_num}',
                headers={'Accept': 'application/json'},
                timeout=10,
            )
            if resp.status_code != 200:
                print(f"  {res_num}: API error {resp.status_code}")
                errors += 1
                time.sleep(0.5)
                continue

            remarks = (resp.json().get('remarks') or {}).get('printed') or ''
            m = re.search(r'Booking id[:\s]+(\d+)', remarks, re.IGNORECASE)
            if not m:
                print(f"  {res_num}: no 'Booking id' in remarks")
                skipped += 1
                time.sleep(0.5)
                continue

            booking_id = m.group(1)
            for doc in docs:
                doc.reference.set({'bookingId': booking_id}, merge=True)
            print(f"  {res_num}: bookingId={booking_id}  ({len(docs)} doc(s) updated)")
            updated += 1

        except Exception as e:
            print(f"  {res_num}: error ��� {e}")
            errors += 1

        time.sleep(0.5)

    print(f"\nDone: {updated} updated, {skipped} skipped (no Booking id in remarks), {errors} errors")


if __name__ == '__main__':
    main()
