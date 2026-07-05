#!/usr/bin/env python3
"""
whatsapp_automation.py

Send WhatsApp messages via YCloud for automated reminders.

Usage:
  python3 whatsapp_automation.py --job checkin_reminder
  python3 whatsapp_automation.py --job midstay
  python3 whatsapp_automation.py --job checkout

Requires env vars:
  FIREBASE_SERVICE_ACCOUNT  — base64-encoded service account JSON
  YCLOUD_API_KEY            — YCloud API key
  YCLOUD_PHONE_NUMBER       — WhatsApp Business sender number (e.g. +995XXXXXXXXX)
"""

import os, sys, json, base64, datetime, argparse
import requests
import firebase_admin
from firebase_admin import credentials, firestore

YCLOUD_API_KEY    = os.environ.get('YCLOUD_API_KEY', '')
YCLOUD_PHONE      = os.environ.get('YCLOUD_PHONE_NUMBER', '')
YCLOUD_SEND_URL   = 'https://api.ycloud.com/v2/whatsapp/messages'
TZ_OFFSET_HOURS   = 4  # UTC+4 (Tbilisi)


# ── Helpers ───────────────────────────────────────────────────────────────────

def tbilisi_now():
    return datetime.datetime.utcnow() + datetime.timedelta(hours=TZ_OFFSET_HOURS)


def tbilisi_date(delta_days=0):
    return (tbilisi_now() + datetime.timedelta(days=delta_days)).strftime('%Y-%m-%d')


def init_firestore():
    sa_base64 = os.environ.get('FIREBASE_SERVICE_ACCOUNT')
    if not sa_base64:
        print("ERROR: FIREBASE_SERVICE_ACCOUNT not set")
        sys.exit(1)
    sa_json = json.loads(base64.b64decode(sa_base64))
    cred = credentials.Certificate(sa_json)
    firebase_admin.initialize_app(cred)
    return firestore.client()


def get_room_description(room_code):
    """Map roomCode to the WhatsApp template variable description."""
    if not room_code:
        return ''
    if room_code.startswith('0-'):
        return 'Triple Room with Private Bathroom (no kitchen)'
    if room_code == '6-3':
        return '3 Bedroom Apartment'
    if room_code.startswith('6-') or room_code.startswith('7-'):
        return 'Superior Apartment'
    if room_code.startswith('tab-'):
        return 'Tabidze Studio'
    if room_code.startswith('orb-'):
        return 'Orbeliani Suite'
    return room_code


def already_sent(db, reservation_number, job):
    """Return True if a 'sent' record already exists for this reservation+job."""
    # NOTE: requires a Firestore composite index on (reservationNumber, job, status)
    docs = list(
        db.collection('whatsapp_messages')
        .where('reservationNumber', '==', str(reservation_number))
        .where('job', '==', job)
        .where('status', '==', 'sent')
        .limit(1)
        .stream()
    )
    return len(docs) > 0


def send_whatsapp(to_phone, template_name, variables):
    """
    POST to YCloud API. Returns the response JSON on success, None on failure.
    variables is a list of strings mapped to template body parameters in order.
    """
    if not YCLOUD_API_KEY:
        print("ERROR: YCLOUD_API_KEY not set")
        return None
    if not YCLOUD_PHONE:
        print("ERROR: YCLOUD_PHONE_NUMBER not set")
        return None

    payload = {
        "from": YCLOUD_PHONE,
        "to": to_phone,
        "type": "template",
        "template": {
            "name": template_name,
            "language": {"code": "en"},
            "components": [{
                "type": "body",
                "parameters": [{"type": "text", "text": v} for v in variables],
            }],
        },
    }

    try:
        resp = requests.post(
            YCLOUD_SEND_URL,
            json=payload,
            headers={
                "X-API-Key": YCLOUD_API_KEY,
                "Content-Type": "application/json",
            },
            timeout=15,
        )
        resp.raise_for_status()
        return resp.json()
    except requests.RequestException as e:
        print(f"  YCloud API error: {e}")
        return None


def write_message_record(db, reservation_number, guest_name, phone, job, status, ycloud_id=''):
    db.collection('whatsapp_messages').add({
        'reservationNumber': str(reservation_number),
        'guestName': guest_name,
        'phone': phone,
        'job': job,
        'status': status,
        'ycloudMessageId': ycloud_id,
        'createdAt': firestore.SERVER_TIMESTAMP,
    })


def write_alert(db, reservation_number, guest_name, room_code, checkin, reason):
    db.collection('whatsapp_alerts').add({
        'reservationNumber': str(reservation_number),
        'guestName': guest_name,
        'roomCode': room_code,
        'checkin': checkin,
        'reason': reason,
        'resolved': False,
        'createdAt': firestore.SERVER_TIMESTAMP,
    })


# ── Jobs ──────────────────────────────────────────────────────────────────────

def job_checkin_reminder(db):
    """
    Send check-in reminder to guests whose checkin date falls within the next
    47–49 hours (Tbilisi time).  Skips: cancelled, Expedia, no-phone, already
    checked in via the app, already messaged.
    """
    now_tbs = tbilisi_now()
    window_start = (now_tbs + datetime.timedelta(hours=47)).strftime('%Y-%m-%d')
    window_end   = (now_tbs + datetime.timedelta(hours=49)).strftime('%Y-%m-%d')

    print(f"Checkin reminder window: {window_start} → {window_end}")

    reservations = list(
        db.collection('reservations')
        .where('checkin', '>=', window_start)
        .where('checkin', '<=', window_end)
        .stream()
    )
    print(f"Found {len(reservations)} reservation(s) in window")

    sent = skipped = failed = 0

    for doc in reservations:
        r = doc.to_dict()
        rn       = str(r.get('reservationNumber', ''))
        guest    = r.get('guest', '')
        first    = (r.get('firstName') or (guest.split()[0] if guest else '') or 'Guest').strip()
        room     = r.get('roomCode', '')
        checkin  = r.get('checkin', '')
        phone    = (r.get('phone') or '').strip()
        status   = (r.get('status') or '').upper()
        source   = (r.get('source') or '').lower()
        label    = f"{rn} / {guest} / {room} / {checkin}"

        if status in ('CL', 'CANCELLED'):
            print(f"  SKIP (cancelled): {label}")
            skipped += 1
            continue

        if source == 'expedia':
            print(f"  SKIP (expedia): {label}")
            skipped += 1
            continue

        if not phone:
            print(f"  SKIP (no phone): {label}")
            skipped += 1
            continue

        # Skip if guest already submitted check-in form
        forms = list(
            db.collection('checkin_guests')
            .where('matchedReservationId', '==', rn)
            .limit(1)
            .stream()
        )
        if forms:
            print(f"  SKIP (already checked in): {label}")
            skipped += 1
            continue

        if rn and already_sent(db, rn, 'checkin_reminder'):
            print(f"  SKIP (already sent): {label}")
            skipped += 1
            continue

        room_desc = get_room_description(room)
        print(f"  Sending checkin_reminder → {phone}  [{label}]")

        result = send_whatsapp(phone, 'checkin_reminder', [first, room_desc])

        if result:
            write_message_record(db, rn, guest, phone, 'checkin_reminder', 'sent', result.get('id', ''))
            print(f"  ✓ sent  id={result.get('id', '')}")
            sent += 1
        else:
            write_message_record(db, rn, guest, phone, 'checkin_reminder', 'failed')
            write_alert(db, rn, guest, room, checkin, 'WhatsApp delivery failed — checkin_reminder')
            print(f"  ✗ failed: {label}")
            failed += 1

    print(f"\nCheckin reminder: {sent} sent, {skipped} skipped, {failed} failed")


def job_midstay(db):
    """
    Send mid-stay message to guests whose arrivalDate was yesterday (Tbilisi),
    who used WhatsApp as their contact type.
    """
    yesterday = tbilisi_date(-1)
    print(f"Mid-stay: arrivalDate == {yesterday}")

    forms = list(
        db.collection('checkin_guests')
        .where('arrivalDate', '==', yesterday)
        .stream()
    )
    print(f"Found {len(forms)} check-in form(s) for {yesterday}")

    sent = skipped = failed = 0

    for doc in forms:
        g    = doc.to_dict()
        ct   = (g.get('contactType') or '').lower()

        if ct != 'wa':
            skipped += 1
            continue

        name  = (g.get('name') or 'Guest').strip()
        phone = (g.get('contact') or '').strip()
        rn    = str(g.get('matchedReservationId') or '')
        label = f"{rn} / {name}"

        if not phone:
            print(f"  SKIP (no phone): {label}")
            skipped += 1
            continue

        if rn and already_sent(db, rn, 'midstay'):
            print(f"  SKIP (already sent): {label}")
            skipped += 1
            continue

        print(f"  Sending midstay_checkin → {phone}  [{label}]")
        result = send_whatsapp(phone, 'midstay_checkin', [name])

        if result:
            write_message_record(db, rn, name, phone, 'midstay', 'sent', result.get('id', ''))
            print(f"  ✓ sent  id={result.get('id', '')}")
            sent += 1
        else:
            write_message_record(db, rn, name, phone, 'midstay', 'failed')
            print(f"  ✗ failed: {label}")
            failed += 1

    print(f"\nMid-stay: {sent} sent, {skipped} skipped, {failed} failed")


def job_checkout(db):
    """
    Send checkout reminder to guests whose checkout is tomorrow (Tbilisi),
    who have a WhatsApp check-in form.
    """
    tomorrow = tbilisi_date(1)
    print(f"Checkout reminder: checkout == {tomorrow}")

    reservations = list(
        db.collection('reservations')
        .where('checkout', '==', tomorrow)
        .stream()
    )
    print(f"Found {len(reservations)} reservation(s) checking out {tomorrow}")

    sent = skipped = failed = 0

    for doc in reservations:
        r      = doc.to_dict()
        rn     = str(r.get('reservationNumber', ''))
        guest  = r.get('guest', '')
        room   = r.get('roomCode', '')
        status = (r.get('status') or '').upper()
        label  = f"{rn} / {guest} / {room}"

        if status in ('CL', 'CANCELLED'):
            print(f"  SKIP (cancelled): {label}")
            skipped += 1
            continue

        # Find check-in form with contactType == 'wa'
        forms = list(
            db.collection('checkin_guests')
            .where('matchedReservationId', '==', rn)
            .where('contactType', '==', 'wa')
            .limit(1)
            .stream()
        )
        if not forms:
            print(f"  SKIP (no WA form): {label}")
            skipped += 1
            continue

        form  = forms[0].to_dict()
        name  = (form.get('name') or 'Guest').strip()
        phone = (form.get('contact') or '').strip()

        if not phone:
            print(f"  SKIP (no phone): {label}")
            skipped += 1
            continue

        if already_sent(db, rn, 'checkout'):
            print(f"  SKIP (already sent): {label}")
            skipped += 1
            continue

        print(f"  Sending checkout_reminder → {phone}  [{label}]")
        result = send_whatsapp(phone, 'checkout_reminder', [name])

        if result:
            write_message_record(db, rn, name, phone, 'checkout', 'sent', result.get('id', ''))
            print(f"  ✓ sent  id={result.get('id', '')}")
            sent += 1
        else:
            write_message_record(db, rn, name, phone, 'checkout', 'failed')
            print(f"  ✗ failed: {label}")
            failed += 1

    print(f"\nCheckout: {sent} sent, {skipped} skipped, {failed} failed")


# ── Entry point ───────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description='WhatsApp automation via YCloud')
    parser.add_argument('--job', required=True,
                        choices=['checkin_reminder', 'midstay', 'checkout'],
                        help='Which message job to run')
    args = parser.parse_args()

    print(f"Starting whatsapp_automation --job {args.job}  "
          f"utc={datetime.datetime.utcnow().isoformat()}  "
          f"tbilisi={tbilisi_now().strftime('%Y-%m-%d %H:%M')}")

    db = init_firestore()

    if args.job == 'checkin_reminder':
        job_checkin_reminder(db)
    elif args.job == 'midstay':
        job_midstay(db)
    elif args.job == 'checkout':
        job_checkout(db)

    print("Done.")


if __name__ == '__main__':
    main()
