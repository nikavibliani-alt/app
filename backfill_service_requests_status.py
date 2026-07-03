"""
One-time backfill: set status='PENDING' on service_requests docs where status is missing.
Run once: python backfill_service_requests_status.py
"""
import firebase_admin
from firebase_admin import credentials, firestore

SA_FILE = '/tmp/service_account.json'

if not firebase_admin._apps:
    cred = credentials.Certificate(SA_FILE)
    firebase_admin.initialize_app(cred)

db = firestore.client()

docs = db.collection('service_requests').stream()
updated = 0
skipped = 0

for doc in docs:
    data = doc.to_dict()
    if 'status' not in data or data['status'] is None:
        doc.reference.update({'status': 'PENDING'})
        print(f"  Updated {doc.id} (serviceId={data.get('serviceId')}, aptId={data.get('aptId')})")
        updated += 1
    else:
        skipped += 1

print(f"\nDone: {updated} updated, {skipped} already had status.")
