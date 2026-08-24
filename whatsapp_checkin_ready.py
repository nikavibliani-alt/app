#!/usr/bin/env python3
"""
whatsapp_checkin_ready.py

Daily fallback job (11:00 UTC) for room-ready WhatsApp notifications.

For every reservation checking in today (Tbilisi time):
  - Check if hk_status/{roomCode}_{today} has done=True
  - If yes and not already notified, send "room ready" message to the guest's WhatsApp

Requires env vars:
  FIREBASE_SERVICE_ACCOUNT  — base64-encoded service account JSON
  META_ACCESS_TOKEN         — Meta Graph API access token
  META_PHONE_NUMBER_ID      — WhatsApp Business phone number ID
"""

import os, sys, json, base64, datetime
import requests
import firebase_admin
from firebase_admin import credentials, firestore

META_ACCESS_TOKEN    = os.environ.get('META_ACCESS_TOKEN', '')
META_PHONE_NUMBER_ID = os.environ.get('META_PHONE_NUMBER_ID', '')
META_SEND_URL        = 'https://graph.facebook.com/v19.0/{phone_number_id}/messages'
TZ_OFFSET_HOURS      = 4  # UTC+4 (Tbilisi)

ROOM_READY_MESSAGE   = (
    'Your unit is ready and you can check in early. '
    'All check-in instructions are available on your check-in page. 🙌'
)


def tbilisi_now():
    return datetime.datetime.utcnow() + datetime.timedelta(hours=TZ_OFFSET_HOURS)


def tbilisi_date(delta_days=0):
    return (tbilisi_now() + datetime.timedelta(days=delta_days)).strftime('%Y-%m-%d')


def init_firestore():
    sa_base64 = os.environ.get('FIREBASE_SERVICE_ACCOUNT')
    if not sa_base64:
        print('ERROR: FIREBASE_SERVICE_ACCOUNT not set')
        sys.exit(1)
    sa_json = json.loads(base64.b64decode(sa_base64))
    cred = credentials.Certificate(sa_json)
    firebase_admin.initialize_app(cred, {'projectId': sa_json['project_id']})
    return firestore.client()


def already_sent(db, reservation_number):
    docs = list(
        db.collection('whatsapp_messages')
        .where('reservationNumber', '==', str(reservation_number))
        .where('job', '==', 'room_ready')
        .where('status', '==', 'sent')
        .limit(1)
        .stream()
    )
    return len(docs) > 0


def send_whatsapp_text(phone, message):
    """Send a plain-text WhatsApp message. Returns response JSON or None."""
    if not META_ACCESS_TOKEN:
        print('ERROR: META_ACCESS_TOKEN not set')
        return None
    if not META_PHONE_NUMBER_ID:
        print('ERROR: META_PHONE_NUMBER_ID not set')
        return None

    try:
        resp = requests.post(
            META_SEND_URL.format(phone_number_id=META_PHONE_NUMBER_ID),
            json={
                'messaging_product': 'whatsapp',
                'to': phone,
                'type': 'text',
                'text': {'body': message},
            },
            headers={
                'Authorization': f'Bearer {META_ACCESS_TOKEN}',
                'Content-Type': 'application/json',
            },
            timeout=15,
        )
        resp.raise_for_status()
        return resp.json()
    except requests.RequestException as e:
        print(f'  Meta Cloud API error: {e}')
        return None


def write_message_record(db, reservation_number, guest_name, phone, status, meta_message_id=''):
    db.collection('whatsapp_messages').add({
        'reservationNumber': str(reservation_number),
        'guestName': guest_name,
        'phone': phone,
        'job': 'room_ready',
        'status': status,
        'metaMessageId': meta_message_id,
        'createdAt': firestore.SERVER_TIMESTAMP,
    })


def main():
    today = tbilisi_date()
    print(
        f'whatsapp_checkin_ready  '
        f'utc={datetime.datetime.utcnow().isoformat()}  '
        f'tbilisi_date={today}'
    )

    db = init_firestore()

    reservations = list(
        db.collection('reservations')
        .where('checkin', '==', today)
        .stream()
    )
    print(f'Found {len(reservations)} reservation(s) checking in today')

    sent = skipped = failed = 0

    for doc in reservations:
        r      = doc.to_dict()
        rn     = str(r.get('reservationNumber', ''))
        guest  = r.get('guest', '')
        room   = r.get('roomCode', '')
        status = (r.get('status') or '').upper()
        label  = f'{rn} / {guest} / {room}'

        if status in ('CL', 'CANCELLED'):
            print(f'  SKIP (cancelled): {label}')
            skipped += 1
            continue

        if not room:
            print(f'  SKIP (no roomCode): {label}')
            skipped += 1
            continue

        # Check if room is marked ready
        hk_key  = f'{room}_{today}'
        hk_snap = db.collection('hk_status').document(hk_key).get()
        if not hk_snap.exists or not hk_snap.to_dict().get('done'):
            print(f'  SKIP (room not ready): {label}')
            skipped += 1
            continue

        if rn and already_sent(db, rn):
            print(f'  SKIP (already sent): {label}')
            skipped += 1
            continue

        # Find guest's WA contact from checkin_guests
        forms = list(
            db.collection('checkin_guests')
            .where('aptId', '==', room)
            .where('arrivalDate', '==', today)
            .where('contactType', '==', 'wa')
            .limit(1)
            .stream()
        )
        if not forms:
            print(f'  SKIP (no WA form): {label}')
            skipped += 1
            continue

        form  = forms[0].to_dict()
        name  = (form.get('name') or 'Guest').strip()
        phone = (form.get('contact') or '').strip()

        if not phone:
            print(f'  SKIP (no phone): {label}')
            skipped += 1
            continue

        print(f'  Sending room_ready → {phone}  [{label}]')
        result = send_whatsapp_text(phone, ROOM_READY_MESSAGE)

        if result and result.get('messages'):
            msg_id = result['messages'][0].get('id', '')
            write_message_record(db, rn, name, phone, 'sent', msg_id)
            print(f'  ✓ sent  id={msg_id}')
            sent += 1
        else:
            write_message_record(db, rn, name, phone, 'failed')
            print(f'  ✗ failed: {label}')
            failed += 1

    print(f'\nRoom ready: {sent} sent, {skipped} skipped, {failed} failed')


if __name__ == '__main__':
    main()
