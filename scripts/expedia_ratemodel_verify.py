#!/usr/bin/env python3
"""READ-ONLY: confirm rateModel/hotelCollect saved in Firestore for Expedia bookings.
Prints reservation 007004955's two fields plus counts only. No names, no remarks text."""
import os, sys, importlib.util, collections
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
s = importlib.util.spec_from_file_location('mh_sync', os.path.join(ROOT, 'minihotel_reservation_sync.py'))
mh = importlib.util.module_from_spec(s); s.loader.exec_module(mh)

db = mh.init_firestore()
counts = collections.Counter()
for snap in db.collection('reservations').where('source', '==', 'expedia').stream():
    d = snap.to_dict() or {}
    counts[(d.get('rateModel') or 'not set', d.get('hotelCollect', 'not set'))] += 1
    if str(d.get('reservationNumber', '')) == '007004955':
        print(f"007004955: rateModel={d.get('rateModel', 'not set')} hotelCollect={d.get('hotelCollect', 'not set')}")
print('Expedia docs by (rateModel, hotelCollect):', {f'{k[0]}/{k[1]}': v for k, v in counts.items()})
