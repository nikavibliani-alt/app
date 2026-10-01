#!/usr/bin/env python3
"""
expedia_ratemodel_dryrun.py -- READ-ONLY dry run of the rate-model check.
Uses the real classify_rate_model() from minihotel_reservation_sync.py on active
Expedia bookings. No Firestore access, no writes. Prints only reservation number +
verdict (output guard drops '@' / 7+ digit lines; reservation numbers are allowed).
"""
import os, re, time, datetime, importlib.util, collections

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _load(name, fname):
    s = importlib.util.spec_from_file_location(name, os.path.join(ROOT, fname))
    m = importlib.util.module_from_spec(s)
    s.loader.exec_module(m)
    return m


mh = _load('mh_sync', 'minihotel_reservation_sync.py')
fc = _load('fraud_check', 'scripts/expedia_fraud_check.py')


def main():
    now = datetime.datetime.utcnow()
    lo = (now - datetime.timedelta(days=30)).strftime('%Y-%m-%d')
    hi = (now + datetime.timedelta(days=365)).strftime('%Y-%m-%d')
    session = fc.login_quiet()
    r = session.get('https://emea5.hotelpms.cloud/api/Reservations'
                    f'?FromDate={lo}T20:00:00.000Z&ToDate={hi}T20:00:00.000Z',
                    headers={'Accept': 'application/json'}, timeout=60)
    if r.status_code != 200:
        fc.sp(f'list API error {r.status_code}')
        return
    nums = []
    for x in r.json().get('reservations', []):
        if (x.get('source') or '').lower() == 'expedia' and x.get('status', '') in mh.VALID_STATUSES:
            rn = str(x.get('reservationNumber', '')).strip()
            if rn and rn not in nums:
                nums.append(rn)
    fc.sp(f'active Expedia bookings: {len(nums)}')
    counts = collections.Counter()
    for rn in nums:
        try:
            d = session.get(f'https://emea5.hotelpms.cloud/api/Reservations/{rn}',
                            headers={'Accept': 'application/json'}, timeout=15)
            if d.status_code != 200:
                counts['error'] += 1
                fc.sp(f'{rn}: detail error {d.status_code}', allowed=[rn])
            else:
                ro = d.json().get('remarks') or {}
                verdict = mh.classify_rate_model(ro.get('ota') or ro.get('printed') or '')
                counts[verdict] += 1
                fc.sp(f'{rn}: rateModel={verdict}', allowed=[rn])
        except Exception as e:
            counts['error'] += 1
            fc.sp(f'{rn}: {type(e).__name__}', allowed=[rn])
        time.sleep(0.5)
    fc.sp('TOTALS:', dict(counts))


if __name__ == '__main__':
    main()
    print(f'Guard: {fc.DROPPED} output line(s) dropped')
